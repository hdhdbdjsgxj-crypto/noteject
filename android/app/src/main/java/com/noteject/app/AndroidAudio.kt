package com.noteject.app

import android.Manifest
import android.app.ActivityManager
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import org.vosk.Model
import org.vosk.Recognizer
import java.util.zip.ZipInputStream
import java.io.File
import java.io.FileInputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Locale
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import kotlin.math.abs

/**
 * Foreground-only voice recordings. Call [onStop] when the activity leaves the foreground,
 * and [close] when it is destroyed. The host owns the runtime permission launcher.
 *
 * All request replies use {requestId, action, ok, ...}. Unsolicited events have
 * {event:"recording", state, recording, durationMs, level, ...}. JSON contains no file paths.
 */
class AndroidAudio(
    context: Context,
    private val emit: (JSONObject) -> Unit,
    private val requestMicrophone: ((Boolean) -> Unit) -> Unit
) {
    companion object {
        const val SAMPLE_RATE = 16_000
        const val MAX_DURATION_MS = 7_200_000L
        const val MAX_DATA_BYTES = SAMPLE_RATE * 2L * MAX_DURATION_MS / 1000
        const val READ_CHUNK_BYTES = 192 * 1024
        private const val WAV_HEADER_BYTES = 44L
        private const val STORAGE_RESERVE_BYTES = 20L * 1024 * 1024
        private const val REQUIRED_START_SPACE_BYTES = MAX_DATA_BYTES + WAV_HEADER_BYTES + STORAGE_RESERVE_BYTES
        private val ID_PATTERN = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
    }

    private val app = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val capture = Executors.newSingleThreadExecutor()
    private val transcriptionWorker = Executors.newSingleThreadExecutor()
    private val directory = File(app.filesDir, "audio-recordings")
    private val lock = Any()
    @Volatile private var closed = false
    @Volatile private var foreground = true
    @Volatile private var current: Recording? = null
    @Volatile private var starting = false
    @Volatile private var speech: Transcription? = null
    private var voskModel: Model? = null // transcriptionWorker only.

    private class Recording(
        val id: String,
        val name: String,
        val createdAt: Long,
        val folder: String,
        val projectId: String,
        val device: AudioRecord,
        val output: RandomAccessFile
    ) {
        @Volatile var bytes = 0L
        @Volatile var paused = false
        @Volatile var stopping = false
        @Volatile var cancelled = false
        @Volatile var stopReason = "saved"
        @Volatile var stopRequestId = ""
        @Volatile var stopAction = "stop"
        @Volatile var failure: String? = null
    }

    private data class SpeechProfile(val quality: String, val archive: String, val storage: String, val model: String, val maximumBytes: Long)

    private fun speechProfile(quality: String): SpeechProfile = when (quality) {
        "accurate" -> SpeechProfile("accurate", "audio-model-en-accurate.zip", "audio-model-en-0.22-lgraph", "vosk-model-en-us-0.22-lgraph", 350_000_000L)
        "fast" -> SpeechProfile("fast", "audio-model-en.zip", "audio-model-en-0.15", "vosk-model-small-en-us-0.15", 150_000_000L)
        else -> throw IllegalArgumentException("Choose Better accuracy or Fast for on-device transcription.")
    }

    private class Transcription(val requestId: String, val id: String, val language: String, val profile: SpeechProfile) {
        @Volatile var cancelled = false
        @Volatile var cancelReason = "Transcription cancelled."
    }

    init { work { ensureDirectory(); recoverRecordings() } }

    /** The JavaScript bridge may call this from its own background thread. */
    fun request(requestId: String, action: String, optionsJson: String = "{}") {
        if (requestId.length > 160 || action.length > 40 || optionsJson.length > 1_000_000) {
            reply(requestId.take(160), action.take(40), false, "Invalid audio request.", "invalid_request")
            return
        }
        if (closed) { reply(requestId, action, false, "Audio tools are closed.", "closed"); return }
        val options = try { JSONObject(optionsJson) } catch (_: Exception) {
            reply(requestId, action, false, "Invalid audio options.", "invalid_request"); return
        }
        when (action) {
            "capabilities" -> {
                val result = JSONObject().put("recording", true).put("onDeviceTranscription", true)
                    .put("onDeviceFileSupport", "bundled").put("onDeviceLanguages", JSONArray().put("en-US"))
                    .put("onDeviceQualityModes", JSONArray().put("accurate").put("fast")).put("defaultTranscriptionQuality", "accurate")
                    .put("sampleRate", SAMPLE_RATE).put("maxDurationMs", MAX_DURATION_MS)
                    .put("maxBytes", MAX_DATA_BYTES + 44).put("microphoneGranted", microphoneGranted())
                    .put("onDeviceMessage", "English transcription works offline using the included speech model. No key or download is needed.")
                reply(requestId, action, true, data = result)
            }
            "start" -> start(requestId, options)
            "pause" -> work { pause(requestId) }
            "resume" -> work { resume(requestId) }
            "stop", "cancel", "discard" -> work { stop(requestId, action != "stop", action) }
            "list", "get-state" -> work {
                try {
                    ensureDirectory()
                    val items = JSONArray()
                    directory.listFiles()?.filter { it.extension == "wav" && ID_PATTERN.matches(it.nameWithoutExtension) }
                        ?.sortedByDescending { it.lastModified() }?.forEach { items.put(metadata(it.nameWithoutExtension)) }
                    val data = JSONObject().put("recordings", items).put("status", status())
                    current?.let { data.put("active", activeMetadata(it)).put("recording", activeMetadata(it)) }
                    reply(requestId, action, true, data = data)
                } catch (_: Exception) { reply(requestId, action, false, "Could not read recordings.", "storage_error") }
            }
            "read" -> work { read(requestId, options) }
            "delete" -> work { delete(requestId, options.optString("id")) }
            "rename" -> work {
                try {
                    val data = synchronized(lock) {
                        val id = options.getString("id"); requireSaved(id)
                        val value = metadata(id).put("name", cleanName(options.optString("name")))
                        if (options.has("folder")) value.put("folder", cleanFolder(options.optString("folder")))
                        if (options.has("projectId")) value.put("projectId", options.optString("projectId").take(160))
                        writeMetadata(id, value)
                        value
                    }
                    reply(requestId, action, true, data = JSONObject().put("recording", data))
                } catch (_: Exception) { reply(requestId, action, false, "Could not rename this recording.", "storage_error") }
            }
            "transcribe" -> transcribe(requestId, options)
            "save-transcript" -> work {
                try {
                    val record = updateTranscript(options.getString("id"), options.optString("text", options.optString("transcript")), options.optString("engine", "edited"))
                    reply(requestId, action, true, data = JSONObject().put("recording", record))
                } catch (_: Exception) { reply(requestId, action, false, "Could not save the transcript.", "storage_error") }
            }
            "cancelTranscription", "cancel-transcription" -> {
                speech?.let { it.cancelled = true }
                reply(requestId, action, true)
            }
            else -> reply(requestId, action, false, "Unknown audio action.", "invalid_request")
        }
    }

    /** Validated local file for an explicitly chosen online adapter; call off the UI thread. */
    fun recordingFile(id: String): File = requireSaved(id)

    /** Stream a validated saved recording without loading a long recording into memory. */
    fun openRecordingStream(id: String): FileInputStream = FileInputStream(requireSaved(id))

    /** Call off the UI thread, after an explicitly chosen online transcription succeeds. */
    fun updateTranscript(id: String, text: String, engine: String = "openai", language: String = "", quality: String = ""): JSONObject {
        val data = synchronized(lock) {
            requireSaved(id)
            val value = metadata(id).put("transcript", text.take(500_000)).put("transcriptionEngine", engine.take(80))
                .put("transcriptionLanguage", language.take(40)).put("transcriptionQuality", quality.take(40)).put("transcribedAt", System.currentTimeMillis())
            writeMetadata(id, value)
            value
        }
        event("transcribed", data)
        return data
    }

    fun onStart() { foreground = true }

    /** Save what was recorded before a home press, lock, or app switch. No background mic. */
    fun onStop() {
        foreground = false
        synchronized(lock) {
            current?.let { item ->
                item.stopReason = "interrupted"; item.stopping = true
                runCatching { item.device.stop() }
            }
        }
        speech?.let { it.cancelReason = "Transcription stopped when noteject left the screen. Your recording is safe."; it.cancelled = true }
    }

    fun close() {
        if (closed) return
        onStop()
        closed = true
        io.shutdown()
        capture.shutdown()
        transcriptionWorker.execute { voskModel?.close(); voskModel = null }
        transcriptionWorker.shutdown()
    }

    private fun start(requestId: String, options: JSONObject) {
        synchronized(lock) {
            if (current != null || starting) { reply(requestId, "start", false, "A recording is already open.", "busy"); return }
            if (!foreground) { reply(requestId, "start", false, "Open noteject to record audio.", "background"); return }
            starting = true
        }
        main.post {
            if (speech != null) {
                synchronized(lock) { starting = false }
                reply(requestId, "start", false, "Finish transcription before starting a recording.", "busy")
                return@post
            }
            val begin: (Boolean) -> Unit = { granted ->
                if (!granted) {
                    synchronized(lock) { starting = false }
                    reply(requestId, "start", false, "Microphone permission is needed to record. You can enable it in Android app permissions.", "permission_denied")
                } else work { startGranted(requestId, options) }
            }
            if (microphoneGranted()) begin(true) else requestMicrophone(begin)
        }
    }

    @Suppress("MissingPermission")
    private fun startGranted(requestId: String, options: JSONObject) {
        var recorder: AudioRecord? = null
        var file: RandomAccessFile? = null
        var id: String? = null
        try {
            check(!closed && foreground) { "Open noteject to record audio." }
            ensureDirectory()
            val requiredMb = (REQUIRED_START_SPACE_BYTES + 999_999) / 1_000_000
            check(directory.usableSpace >= REQUIRED_START_SPACE_BYTES) {
                "Free at least $requiredMb MB of device storage before recording for up to 120 minutes."
            }
            val bufferSize = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            check(bufferSize > 0) { "This microphone does not support speech recording." }
            recorder = createSpeechRecorder(maxOf(bufferSize * 2, 16_384))
            id = UUID.randomUUID().toString()
            file = RandomAccessFile(confined(id, ".wav.part"), "rw")
            writeWavHeader(file, 0)
            val item = Recording(id, cleanName(options.optString("name")), System.currentTimeMillis(),
                cleanFolder(options.optString("folder")), options.optString("projectId").take(160), recorder, file)
            writeMetadata(id, activeMetadata(item))
            synchronized(lock) {
                check(foreground && !closed) { "Open noteject to record audio." }
                current = item; starting = false
                recorder.startRecording()
                check(recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "The microphone is busy. Close another recording app and try again." }
            }
            capture.execute { captureAudio(item) }
            reply(requestId, "start", true, data = JSONObject().put("recording", activeMetadata(item)))
            event("recording", activeMetadata(item))
        } catch (error: Exception) {
            synchronized(lock) { current = null; starting = false }
            runCatching { recorder?.release() }; runCatching { file?.close() }
            id?.let { runCatching { confined(it, ".wav.part").delete(); confined(it, ".json").delete() } }
            reply(requestId, "start", false, error.message ?: "Could not start audio recording.", "recording_error")
        }
    }

    @Suppress("MissingPermission")
    private fun createSpeechRecorder(bufferSize: Int): AudioRecord {
        // Ask Android for input tuned for speech, with a generic mic fallback for
        // devices whose audio driver does not implement the recognition source.
        for (source in intArrayOf(MediaRecorder.AudioSource.VOICE_RECOGNITION, MediaRecorder.AudioSource.MIC)) {
            val device = runCatching {
                AudioRecord.Builder().setAudioSource(source)
                    .setAudioFormat(AudioFormat.Builder().setSampleRate(SAMPLE_RATE).setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                    .setBufferSizeInBytes(bufferSize).build()
            }.getOrNull() ?: continue
            if (device.state == AudioRecord.STATE_INITIALIZED) return device
            runCatching { device.release() }
        }
        error("The microphone could not be initialized.")
    }

    private fun captureAudio(item: Recording) {
        val buffer = ByteArray(8192)
        var lastUpdate = 0L
        var lastSync = 0L
        var lastStorageCheck = 0L
        try {
            while (!item.stopping && !closed) {
                if (item.paused) { Thread.sleep(35); continue }
                val now = SystemClock.elapsedRealtime()
                if (now - lastStorageCheck >= 1000) {
                    lastStorageCheck = now
                    if (directory.usableSpace <= STORAGE_RESERVE_BYTES) {
                        item.stopReason = "storage_low"; item.stopping = true
                        break
                    }
                }
                val read = item.device.read(buffer, 0, buffer.size, AudioRecord.READ_NON_BLOCKING)
                if (read < 0) {
                    if (item.paused || item.stopping) continue
                    error("Microphone recording was interrupted. Your recorded audio has been saved.")
                }
                // A stop/pause may arrive while read() is finishing. These samples
                // were already captured and must be saved, including the last word.
                if (read == 0) { Thread.sleep(15); continue }
                val size = minOf((read / 2) * 2L, MAX_DATA_BYTES - item.bytes).toInt()
                if (size > 0) { item.output.write(buffer, 0, size); item.bytes += size }
                if (now - lastUpdate >= 250) {
                    var peak = 0
                    for (index in 0 until size - 1 step 2) {
                        val sample = ((buffer[index].toInt() and 255) or (buffer[index + 1].toInt() shl 8)).toShort().toInt()
                        peak = maxOf(peak, abs(sample))
                    }
                    event("recording", activeMetadata(item), JSONObject().put("level", peak / 32768.0))
                    lastUpdate = now
                }
                if (now - lastSync >= 2000) { item.output.fd.sync(); lastSync = now }
                if (item.bytes >= MAX_DATA_BYTES) { item.stopReason = "limit"; item.stopping = true }
            }
        } catch (error: Exception) {
            if (directory.usableSpace <= STORAGE_RESERVE_BYTES) {
                // Save every complete sample even if another app consumed the free space
                // between our periodic check and this write.
                item.stopReason = "storage_low"
            } else item.failure = error.message ?: "Recording interrupted."
        }
        finally {
            // A normal Stop is finalized here, after the remaining microphone
            // buffer is read. Background/permission stops still stop the mic at once.
            if (foreground && !closed && item.stopping && !item.paused && !item.cancelled && item.stopReason == "saved" && item.failure == null) {
                runCatching {
                    repeat(4) {
                        val read = item.device.read(buffer, 0, buffer.size, AudioRecord.READ_NON_BLOCKING)
                        if (read <= 0) return@runCatching
                        val size = minOf((read / 2) * 2L, MAX_DATA_BYTES - item.bytes).toInt()
                        if (size > 0) { item.output.write(buffer, 0, size); item.bytes += size }
                        if (item.bytes >= MAX_DATA_BYTES) return@runCatching
                    }
                }.onFailure { item.failure = "The last audio samples could not be fully saved." }
            }
            runCatching { item.device.stop() }; runCatching { item.device.release() }
            runCatching {
                // A failed disk write may have appended only part of its buffer. The
                // actual length preserves those samples while dropping an odd last byte.
                item.bytes = ((item.output.length() - WAV_HEADER_BYTES).coerceIn(0, MAX_DATA_BYTES) / 2) * 2
                item.output.setLength(item.bytes + WAV_HEADER_BYTES)
                writeWavHeader(item.output, item.bytes)
                item.output.fd.sync()
            }
                .onFailure { item.failure = "The recording could not be fully saved. Try freeing device storage." }
            runCatching { item.output.close() }
            // Finalize on this background worker even when activity destruction has closed
            // the command worker. A force-killed process leaves a recoverable .wav.part.
            finishRecording(item)
        }
    }

    private fun pause(requestId: String) {
        val item = current
        if (item == null || item.stopping) { reply(requestId, "pause", false, "No recording is running.", "not_recording"); return }
        if (!item.paused) {
            item.paused = true
            runCatching { item.device.stop() }
        }
        reply(requestId, "pause", true, data = JSONObject().put("recording", activeMetadata(item)))
        event("paused", activeMetadata(item))
    }

    private fun resume(requestId: String) {
        val item = current
        if (item == null || item.stopping) { reply(requestId, "resume", false, "No recording is paused.", "not_recording"); return }
        if (!foreground || closed) { reply(requestId, "resume", false, "Open noteject to resume recording.", "background"); return }
        try {
            if (item.paused) { item.device.startRecording(); item.paused = false }
            reply(requestId, "resume", true, data = JSONObject().put("recording", activeMetadata(item)))
            event("recording", activeMetadata(item))
        } catch (_: Exception) { reply(requestId, "resume", false, "The microphone could not resume. Save the recording and try again.", "recording_error") }
    }

    private fun stop(requestId: String, cancel: Boolean, action: String) {
        val item = current
        if (item == null || item.stopping) { reply(requestId, action, false, "No recording is running.", "not_recording"); return }
        item.stopRequestId = requestId; item.stopAction = action
        item.cancelled = cancel; item.stopping = true
        // Nonblocking capture notices this flag promptly, drains the tail, and
        // then stops the microphone in its finally block.
    }

    private fun finishRecording(item: Recording) {
        var saved: JSONObject? = null
        var error = item.failure
        try {
            if (item.cancelled || item.bytes == 0L) {
                confined(item.id, ".wav.part").delete(); confined(item.id, ".json").delete()
                if (!item.cancelled) error = "No audio was recorded. Record for a moment before saving."
            } else {
                val target = confined(item.id, ".wav")
                check(confined(item.id, ".wav.part").renameTo(target)) { "Could not finalize the recording. It will be recovered when noteject opens again." }
                saved = activeMetadata(item).put("state", "saved").put("reason", item.stopReason)
                    .put("size", target.length()).put("recovered", false)
                writeMetadata(item.id, saved)
            }
        } catch (failure: Exception) { error = failure.message ?: "Could not save the recording." }
        finally { synchronized(lock) { if (current === item) current = null } }
        if (item.stopRequestId.isNotEmpty()) {
            val data = JSONObject(); saved?.let { data.put("recording", it) }
            reply(item.stopRequestId, item.stopAction, error == null, error, if (error == null) null else "storage_error", data)
        }
        when {
            error != null -> event("error", saved, JSONObject().put("message", error).put("recoverable", true))
            item.cancelled -> event("cancelled", null)
            saved != null -> event("saved", saved, if (item.stopReason == "storage_low") {
                JSONObject().put("message", "Recording saved automatically because device storage is running low.")
            } else JSONObject())
            else -> event("empty", null, JSONObject().put("message", "No audio was recorded."))
        }
    }

    private fun read(requestId: String, options: JSONObject) {
        try {
            val id = options.getString("id"); val file = requireSaved(id)
            val offset = options.optLong("offset", 0)
            require(offset in 0..file.length())
            val size = options.optInt("length", READ_CHUNK_BYTES).coerceIn(1, READ_CHUNK_BYTES)
            val buffer = ByteArray(minOf(size.toLong(), file.length() - offset).toInt())
            RandomAccessFile(file, "r").use { source -> source.seek(offset); source.readFully(buffer) }
            reply(requestId, "read", true, data = JSONObject().put("id", id).put("mime", "audio/wav")
                .put("name", metadata(id).optString("name", "Recording") + ".wav")
                .put("data", Base64.encodeToString(buffer, Base64.NO_WRAP)).put("offset", offset)
                .put("nextOffset", offset + buffer.size).put("size", file.length()).put("eof", offset + buffer.size >= file.length()))
        } catch (_: Exception) { reply(requestId, "read", false, "This recording is unavailable.", "not_found") }
    }

    private fun delete(requestId: String, id: String) {
        try {
            check(current?.id != id) { "Save the recording before deleting it." }
            val file = requireSaved(id)
            speech?.takeIf { it.id == id }?.let { it.cancelled = true }
            check(file.delete()) { "Could not delete this recording." }
            confined(id, ".json").delete()
            reply(requestId, "delete", true, data = JSONObject().put("id", id))
        } catch (error: Exception) { reply(requestId, "delete", false, error.message ?: "Could not delete this recording.", "storage_error") }
    }

    private fun punctuateEnglishTranscript(phrases: List<String>): String = phrases
        .map { it.trim() }
        .filter { it.isNotEmpty() }
        .joinToString(" ") { phrase ->
            val normalized = phrase.replaceFirstChar { if (it.isLowerCase()) it.titlecase(Locale.ROOT) else it.toString() }
            if (normalized.last() in ".!?…") normalized else {
                val question = normalized.substringBefore(' ').lowercase(Locale.ROOT) in setOf("who", "what", "when", "where", "why", "how", "which", "whose")
                normalized + if (question) "?" else "."
            }
        }

    private fun transcribe(requestId: String, options: JSONObject) {
        val id = options.optString("id")
        val language = options.optString("language", "en-US")
        if (!language.lowercase(Locale.ROOT).startsWith("en")) {
            reply(requestId, "transcribe", false, "The included offline model supports English. Choose online transcription for other languages.", "language_unsupported")
            return
        }
        val profile = try { speechProfile(options.optString("quality", "accurate")) } catch (error: IllegalArgumentException) {
            reply(requestId, "transcribe", false, error.message, "invalid_quality"); return
        }
        val job: Transcription
        synchronized(lock) {
            if (speech != null || current != null || starting) {
                reply(requestId, "transcribe", false, "Finish the current recording or transcription first.", "busy"); return
            }
            if (!foreground || closed) {
                reply(requestId, "transcribe", false, "Keep noteject open while transcribing.", "background"); return
            }
            job = Transcription(requestId, id, language, profile)
            speech = job
        }
        try {
            transcriptionWorker.execute {
                try {
                    val source = requireSaved(id)
                    if (profile.quality == "accurate") {
                        val manager = app.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
                        val memory = ActivityManager.MemoryInfo().also { manager?.getMemoryInfo(it) }
                        val requiredMemory = maxOf(800_000_000L, memory.threshold + 500_000_000L)
                        check(manager == null || (!manager.isLowRamDevice && !memory.lowMemory && memory.availMem >= requiredMemory)) {
                            "Better accuracy needs more free memory. Close other apps or select Fast on-device transcription, then try again. Your audio is saved."
                        }
                    }
                    event("transcribing", null, JSONObject().put("id", id).put("engine", "on-device")
                        .put("quality", profile.quality).put("phase", "preparing").put("progress", 0))
                    val model = voskModel ?: Model(unpackModel(job).absolutePath).also { voskModel = it }
                    checkNotCancelled(job)
                    val phrases = mutableListOf<String>()
                    var consumed = 0L
                    var lastProgress = 0L
                    Recognizer(model, SAMPLE_RATE.toFloat()).use { recognizer ->
                        FileInputStream(source).use { input ->
                            input.channel.position(44)
                            val buffer = ByteArray(8192)
                            while (true) {
                                checkNotCancelled(job)
                                val size = input.read(buffer)
                                if (size < 0) break
                                if (recognizer.acceptWaveForm(buffer, size)) {
                                    JSONObject(recognizer.result).optString("text").trim().takeIf { it.isNotEmpty() }?.let(phrases::add)
                                }
                                consumed += size
                                val now = SystemClock.elapsedRealtime()
                                if (now - lastProgress >= 500) {
                                    val partial = JSONObject(recognizer.partialResult).optString("partial")
                                    event("transcribing", null, JSONObject().put("id", id).put("engine", "on-device")
                                        .put("quality", profile.quality)
                                        .put("progress", (consumed * 100 / (source.length() - 44)).coerceIn(0, 99))
                                        .put("phase", "transcribing").put("text", (phrases + partial).joinToString(" ").trim()).put("partial", true))
                                    lastProgress = now
                                }
                            }
                        }
                        JSONObject(recognizer.finalResult).optString("text").trim().takeIf { it.isNotEmpty() }?.let(phrases::add)
                    }
                    checkNotCancelled(job)
                    val text = punctuateEnglishTranscript(phrases).take(500_000)
                    if (text.isEmpty()) {
                        reply(requestId, "transcribe", false, "No English speech was found. Check the recording or try online transcription for other languages.", "no_speech")
                        event("transcription-error", null, JSONObject().put("id", id).put("message", "No English speech was recognized."))
                    } else {
                        val record = updateTranscript(id, text, "on-device", "en-US", profile.quality)
                        reply(requestId, "transcribe", true, data = JSONObject().put("id", id).put("text", text).put("recording", record))
                    }
                } catch (error: Throwable) {
                    val message = if (job.cancelled || closed) job.cancelReason else error.message ?: "Offline transcription could not finish. Your recording is safe."
                    reply(requestId, "transcribe", false, message, if (job.cancelled || closed) "cancelled" else "transcription_error")
                    event("transcription-error", null, JSONObject().put("id", id).put("message", message))
                } finally {
                    // The acoustic model can occupy hundreds of megabytes. Release it
                    // after every job so reading and board navigation retain their memory.
                    runCatching { voskModel?.close() }; voskModel = null
                    synchronized(lock) { if (speech === job) speech = null }
                    stateEvent()
                }
            }
        } catch (_: RejectedExecutionException) {
            synchronized(lock) { if (speech === job) speech = null }
            reply(requestId, "transcribe", false, "Audio tools are closed.", "closed")
        }
    }

    private fun checkNotCancelled(job: Transcription) {
        check(!job.cancelled && !closed && foreground) { job.cancelReason }
    }

    /** Extract only the known bundled archive into this version's private model directory. */
    private fun unpackModel(job: Transcription): File {
        val profile = job.profile
        val versionRoot = File(app.filesDir, profile.storage).canonicalFile
        check(versionRoot.parentFile == app.filesDir.canonicalFile && versionRoot.name == profile.storage) {
            "Invalid offline speech storage path."
        }
        val modelDirectory = File(versionRoot, profile.model)
        val complete = File(versionRoot, ".complete")
        if (complete.isFile && File(modelDirectory, "am/final.mdl").isFile && File(modelDirectory, "conf/model.conf").isFile) return modelDirectory
        check(app.filesDir.usableSpace > profile.maximumBytes + STORAGE_RESERVE_BYTES) {
            "Free at least ${(profile.maximumBytes + STORAGE_RESERVE_BYTES) / 1_000_000} MB of storage to prepare this offline speech model."
        }
        if (versionRoot.exists()) check(versionRoot.deleteRecursively()) { "Could not prepare offline speech storage." }
        check(versionRoot.mkdirs()) { "Could not prepare offline speech storage." }
        var totalBytes = 0L
        var entries = 0
        try {
            ZipInputStream(app.assets.open(profile.archive)).use { zip ->
                val buffer = ByteArray(32_768)
                while (true) {
                    checkNotCancelled(job)
                    val entry = zip.nextEntry ?: break
                    check(++entries <= 200) { "Invalid bundled speech archive." }
                    val target = File(versionRoot, entry.name).canonicalFile
                    check(target.toPath().startsWith(versionRoot.toPath()) && target != versionRoot) { "Invalid bundled speech path." }
                    check(entry.name.startsWith(profile.model + "/")) { "Invalid bundled speech model." }
                    if (entry.isDirectory) {
                        check(target.isDirectory || target.mkdirs())
                    } else {
                        check(target.parentFile?.isDirectory == true || target.parentFile?.mkdirs() == true)
                        target.outputStream().use { output ->
                            while (true) {
                                checkNotCancelled(job)
                                val size = zip.read(buffer)
                                if (size < 0) break
                                totalBytes += size
                                check(totalBytes <= profile.maximumBytes) { "Bundled speech archive exceeds its size limit." }
                                output.write(buffer, 0, size)
                            }
                        }
                    }
                    zip.closeEntry()
                }
            }
            check(File(modelDirectory, "am/final.mdl").isFile && File(modelDirectory, "conf/model.conf").isFile) { "The included speech model is incomplete." }
            complete.writeText(profile.model)
            return modelDirectory
        } catch (failure: Throwable) {
            versionRoot.deleteRecursively()
            throw failure
        }
    }

    private fun recoverRecordings() {
        directory.listFiles()?.filter { it.name.endsWith(".wav.part") }?.forEach { part ->
            val id = part.name.removeSuffix(".wav.part")
            if (!ID_PATTERN.matches(id)) return@forEach
            runCatching {
                val size = ((part.length() - 44).coerceIn(0, MAX_DATA_BYTES) / 2) * 2
                if (size == 0L) { part.delete(); confined(id, ".json").delete(); return@runCatching }
                RandomAccessFile(part, "rw").use { file -> file.setLength(size + 44); writeWavHeader(file, size); file.fd.sync() }
                val saved = confined(id, ".wav")
                check(part.renameTo(saved))
                val data = metadata(id).put("state", "saved").put("size", saved.length())
                    .put("durationMs", size * 1000 / (SAMPLE_RATE * 2)).put("recovered", true).put("reason", "interrupted")
                writeMetadata(id, data)
            }
        }
    }

    private fun activeMetadata(item: Recording) = JSONObject().put("id", item.id).put("name", item.name)
        .put("mime", "audio/wav").put("mimeType", "audio/wav").put("folder", item.folder).put("projectId", item.projectId)
        .put("createdAt", item.createdAt).put("created", item.createdAt).put("durationMs", item.bytes * 1000 / (SAMPLE_RATE * 2))
        .put("elapsedMs", item.bytes * 1000 / (SAMPLE_RATE * 2))
        .put("size", item.bytes + 44).put("state", if (item.paused) "paused" else "recording")
        .put("maxDurationMs", MAX_DURATION_MS)

    private fun metadata(id: String): JSONObject {
        val file = confined(id, ".wav")
        val data = runCatching { JSONObject(confined(id, ".json").readText()) }.getOrElse { JSONObject() }
        return data.put("id", id).put("name", cleanName(data.optString("name")))
            .put("mime", "audio/wav").put("mimeType", "audio/wav").put("folder", cleanFolder(data.optString("folder"))).put("state", "saved")
            .put("size", file.length()).put("durationMs", ((file.length() - 44).coerceAtLeast(0) * 1000 / (SAMPLE_RATE * 2)))
            .put("createdAt", data.optLong("createdAt", file.lastModified())).put("created", data.optLong("createdAt", file.lastModified()))
            .put("maxDurationMs", MAX_DURATION_MS)
    }

    private fun writeMetadata(id: String, data: JSONObject) {
        val temporary = confined(id, ".json.tmp")
        temporary.writeText(data.toString())
        check(temporary.renameTo(confined(id, ".json"))) { "Could not save recording details." }
    }

    private fun requireSaved(id: String): File {
        val file = confined(id, ".wav")
        require(file.isFile && file.length() in 46..MAX_DATA_BYTES + 44) { "This recording is unavailable." }
        return file
    }

    private fun confined(id: String, suffix: String): File {
        require(ID_PATTERN.matches(id)) { "Invalid recording ID." }
        val root = directory.canonicalFile
        val file = File(root, id + suffix).canonicalFile
        require(file.parentFile == root) { "Invalid recording path." }
        return file
    }

    private fun cleanName(value: String): String = value.replace(Regex("[\\p{Cntrl}\\p{Cf}]"), " ").trim().take(120)
        .ifEmpty { "Recording" }

    private fun cleanFolder(value: String): String {
        val clean = value.replace(Regex("[\\p{Cntrl}\\p{Cf}]"), " ").trim().take(140)
        return if (clean.isEmpty() || clean.equals("inbox", true)) "Inbox" else clean
    }

    private fun ensureDirectory() { check(directory.isDirectory || directory.mkdirs()) { "Could not open audio storage." } }

    private fun microphoneGranted() = app.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun writeWavHeader(file: RandomAccessFile, dataBytes: Long) {
        val position = file.filePointer
        val bytes = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
            .put("RIFF".toByteArray(Charsets.US_ASCII)).putInt((dataBytes + 36).toInt())
            .put("WAVEfmt ".toByteArray(Charsets.US_ASCII)).putInt(16).putShort(1).putShort(1)
            .putInt(SAMPLE_RATE).putInt(SAMPLE_RATE * 2).putShort(2).putShort(16)
            .put("data".toByteArray(Charsets.US_ASCII)).putInt(dataBytes.toInt()).array()
        file.seek(0); file.write(bytes); file.seek(maxOf(44, position))
    }

    private fun reply(requestId: String, action: String, ok: Boolean, message: String? = null,
                      code: String? = null, data: JSONObject = JSONObject()) {
        data.put("requestId", requestId).put("action", action).put("ok", ok)
        if (!data.has("status")) data.put("status", status())
        if (message != null) data.put("error", message)
        if (code != null) data.put("code", code)
        dispatch(data)
    }

    private fun event(state: String, recording: JSONObject?, extra: JSONObject = JSONObject()) {
        extra.put("event", "recording").put("state", state)
        recording?.let { extra.put("recording", it).put("durationMs", it.optLong("durationMs")).put("elapsedMs", it.optLong("durationMs")) }
        dispatch(extra)
        stateEvent(recording)
    }

    private fun status() = current?.let { if (it.stopping) "saving" else if (it.paused) "paused" else "recording" } ?: if (speech != null) "transcribing" else if (starting) "starting" else "idle"

    private fun stateEvent(recording: JSONObject? = null) {
        val value = JSONObject().put("type", "state").put("status", status())
        (current?.let(::activeMetadata) ?: recording)?.let { value.put("recording", it).put("elapsedMs", it.optLong("durationMs")) }
        dispatch(value)
    }

    private fun dispatch(value: JSONObject) { main.post { if (!closed) emit(value) } }

    private fun work(block: () -> Unit) {
        try { io.execute(block) } catch (_: RejectedExecutionException) { /* Host has closed. */ }
    }
}
