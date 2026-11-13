package com.noteject.app

import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Locale
import java.util.UUID

/** Uploads only a user-selected saved recording after the cloud action is pressed. */
object OpenAiAudio {
    private const val SAMPLE_RATE = 16_000
    private const val BYTES_PER_SECOND = SAMPLE_RATE * 2
    internal const val MAX_DATA_BYTES = BYTES_PER_SECOND * 120L * 60
    internal const val SEGMENT_DATA_BYTES = BYTES_PER_SECOND * 10 * 60
    private const val MAX_TRANSCRIPT_CHARACTERS = 500_000

    internal data class WavSegment(val offset: Long, val dataBytes: Int)

    /**
     * Files remain on disk. Only a 64 KB transfer buffer and bounded response text are
     * held in memory. Return a transcript only when every segment has succeeded, so the
     * host can preserve the previous transcript on any upload failure or cancellation.
     */
    fun transcribe(
        file: File,
        key: String,
        language: String,
        progress: (completedSegments: Int, totalSegments: Int) -> Unit = { _, _ -> },
        isCancelled: () -> Boolean = { false },
        onConnection: (HttpURLConnection?) -> Unit = {}
    ): String {
        require(file.isFile && file.length() in 46..MAX_DATA_BYTES + 44) {
            "Choose a saved recording of up to 120 minutes."
        }
        val apiKey = key.trim()
        require(apiKey.isNotEmpty()) { "Add an OpenAI API key in Settings to use OpenAI transcription, or choose On this device." }
        require(apiKey.length <= 1024 && apiKey.none { it == '\r' || it == '\n' }) { "The OpenAI API key is invalid. Add it again in Settings." }
        requireNotCancelled(isCancelled)
        RandomAccessFile(file, "r").use { input ->
            val totalLength = input.length()
            val dataBytes = validateWav(input, totalLength)
            val segments = segmentPlan(dataBytes)
            val transcript = StringBuilder()
            progress(0, segments.size)
            for ((index, segment) in segments.withIndex()) {
                requireNotCancelled(isCancelled)
                check(input.length() == totalLength) { "The recording changed while transcribing. Try again." }
                val text = try {
                    uploadSegment(input, segment, apiKey, language, transcriptContext(transcript), isCancelled, onConnection)
                } catch (error: Exception) {
                    requireNotCancelled(isCancelled)
                    throw IllegalStateException(
                        "Part ${index + 1} of ${segments.size} could not be transcribed: ${error.message ?: "Connection failed."} Your recording and previous transcript are still saved.",
                        error
                    )
                }
                if (text.isNotEmpty()) {
                    check(transcript.length + text.length + 1 <= MAX_TRANSCRIPT_CHARACTERS) { "The transcript is too long to save. Your previous transcript is still saved." }
                    if (transcript.isNotEmpty()) transcript.append('\n')
                    transcript.append(text)
                }
                progress(index + 1, segments.size)
            }
            requireNotCancelled(isCancelled)
            return transcript.toString().ifBlank { error("No speech was recognized. Your recording and previous transcript are still saved.") }
        }
    }

    /** Raw PCM offsets are relative to the first byte after the WAV header. */
    internal fun segmentPlan(dataBytes: Long): List<WavSegment> {
        require(dataBytes in 2..MAX_DATA_BYTES && dataBytes % 2 == 0L) { "The recording contains invalid audio data." }
        val result = mutableListOf<WavSegment>()
        var offset = 0L
        while (offset < dataBytes) {
            val size = minOf(SEGMENT_DATA_BYTES.toLong(), dataBytes - offset).toInt()
            result.add(WavSegment(offset, size))
            offset += size
        }
        return result
    }

    /** Accept exactly the PCM layout written by noteject's native recorder. */
    private fun validateWav(input: RandomAccessFile, fileLength: Long): Long {
        val header = ByteArray(44)
        input.seek(0)
        input.readFully(header)
        val bytes = ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN)
        fun marker(offset: Int, value: String) = header.copyOfRange(offset, offset + value.length).contentEquals(value.toByteArray(Charsets.US_ASCII))
        val dataBytes = bytes.getInt(40).toLong() and 0xffff_ffffL
        require(marker(0, "RIFF") && marker(8, "WAVE") && marker(12, "fmt ") && marker(36, "data") &&
            bytes.getInt(16) == 16 && bytes.getShort(20).toInt() == 1 && bytes.getShort(22).toInt() == 1 &&
            bytes.getInt(24) == SAMPLE_RATE && bytes.getInt(28) == BYTES_PER_SECOND &&
            bytes.getShort(32).toInt() == 2 && bytes.getShort(34).toInt() == 16 &&
            (bytes.getInt(4).toLong() and 0xffff_ffffL) == fileLength - 8 &&
            dataBytes == fileLength - 44 && dataBytes in 2..MAX_DATA_BYTES && dataBytes % 2 == 0L) {
            "This recording is not a valid noteject WAV file. Record it again before transcribing."
        }
        return dataBytes
    }

    internal fun wavHeader(dataBytes: Int): ByteArray {
        require(dataBytes in 2..SEGMENT_DATA_BYTES && dataBytes % 2 == 0)
        return ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
            .put("RIFF".toByteArray(Charsets.US_ASCII)).putInt(dataBytes + 36)
            .put("WAVEfmt ".toByteArray(Charsets.US_ASCII)).putInt(16).putShort(1).putShort(1)
            .putInt(SAMPLE_RATE).putInt(BYTES_PER_SECOND).putShort(2).putShort(16)
            .put("data".toByteArray(Charsets.US_ASCII)).putInt(dataBytes).array()
    }

    /** Give the next part a small amount of context without resending the transcript. */
    internal fun transcriptContext(transcript: CharSequence): String {
        var start = (transcript.length - 1000).coerceAtLeast(0)
        // Do not begin a UTF-8 request with half of a supplementary Unicode character.
        if (start > 0 && Character.isLowSurrogate(transcript[start]) && Character.isHighSurrogate(transcript[start - 1])) start++
        return transcript.subSequence(start, transcript.length).toString().trim()
    }

    private fun uploadSegment(
        input: RandomAccessFile,
        segment: WavSegment,
        key: String,
        language: String,
        previousText: String,
        isCancelled: () -> Boolean,
        onConnection: (HttpURLConnection?) -> Unit
    ): String {
        val boundary = "noteject-audio-${UUID.randomUUID()}"
        val fields = linkedMapOf("model" to "gpt-4o-mini-transcribe", "response_format" to "json")
        if (previousText.isNotBlank()) fields["prompt"] = previousText
        val code = language.lowercase(Locale.ROOT).substringBefore('-').trim()
        if (code.matches(Regex("^[a-z]{2}$"))) fields["language"] = code
        val prefix = buildString {
            for ((name, value) in fields) append("--$boundary\r\nContent-Disposition: form-data; name=\"$name\"\r\n\r\n$value\r\n")
            append("--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"recording.wav\"\r\nContent-Type: audio/wav\r\n\r\n")
        }.toByteArray(Charsets.UTF_8)
        val suffix = "\r\n--$boundary--\r\n".toByteArray(Charsets.UTF_8)
        val connection = URL("https://api.openai.com/v1/audio/transcriptions").openConnection() as HttpURLConnection
        try {
            onConnection(connection)
            requireNotCancelled(isCancelled)
            connection.requestMethod = "POST"
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 20000; connection.readTimeout = 180000
            connection.setRequestProperty("Authorization", "Bearer $key")
            connection.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
            connection.doOutput = true
            val header = wavHeader(segment.dataBytes)
            connection.setFixedLengthStreamingMode(prefix.size.toLong() + header.size + segment.dataBytes + suffix.size)
            connection.outputStream.use { output ->
                output.write(prefix)
                output.write(header)
                input.seek(44 + segment.offset)
                val buffer = ByteArray(65_536)
                var remaining = segment.dataBytes
                while (remaining > 0) {
                    requireNotCancelled(isCancelled)
                    val size = minOf(remaining, buffer.size)
                    input.readFully(buffer, 0, size)
                    output.write(buffer, 0, size)
                    remaining -= size
                }
                output.write(suffix)
            }
            requireNotCancelled(isCancelled)
            val status = connection.responseCode
            val source = if (status in 200..299) connection.inputStream else connection.errorStream
            val response = source?.bufferedReader(Charsets.UTF_8)?.use { reader ->
                val result = StringBuilder(); val buffer = CharArray(8192)
                while (true) {
                    requireNotCancelled(isCancelled)
                    val count = reader.read(buffer); if (count < 0) break
                    check(result.length + count <= 2000000) { "The transcription response was too large." }
                    result.append(buffer, 0, count)
                }
                result.toString()
            }.orEmpty()
            if (status !in 200..299) {
                val detail = runCatching { JSONObject(response).optJSONObject("error")?.optString("message") }.getOrNull()
                error(detail?.takeIf { it.isNotBlank() } ?: "OpenAI transcription failed ($status). Your recording is still saved.")
            }
            val result = JSONObject(response)
            check(result.opt("text") is String) { "OpenAI returned an invalid transcription response." }
            // A silent part is valid; later parts may contain speech.
            return result.getString("text").trim()
        } finally {
            try { onConnection(null) } finally { connection.disconnect() }
        }
    }

    private fun requireNotCancelled(isCancelled: () -> Boolean) {
        check(!isCancelled() && !Thread.currentThread().isInterrupted) { "Transcription cancelled. Your recording and previous transcript are still saved." }
    }
}
