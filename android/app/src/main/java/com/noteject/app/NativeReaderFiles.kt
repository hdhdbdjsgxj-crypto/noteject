package com.noteject.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.UUID

/** Bridges saved WebView attachments to complete, immutable native Reader files. */
internal class NativeReaderFiles(context: Context) {
    private val app = context.applicationContext
    private val resolver = app.contentResolver
    private val prefs = app.getSharedPreferences("noteject_native_reader_files", Context.MODE_PRIVATE)
    private val legacyPrefs = app.getSharedPreferences("noteject_pdf_sources", Context.MODE_PRIVATE)
    private val directory = File(app.filesDir, "native-reader").canonicalFile
    private val cache = NativeReaderCache(directory)
    private val lock = Any()
    private val uploads = mutableMapOf<String, Upload>()
    private val approvedSources = mutableSetOf<String>()

    private data class Identity(val documentId: String, val name: String, val size: Long, val sampleHash: String, val type: String, val revision: String, val generation: String) {
        val fileKey: String get() = sha256("revision-v2\u0000$generation\u0000$documentId\u0000$revision\u0000$type\u0000$size\u0000$sampleHash".toByteArray(Charsets.UTF_8))
    }

    private data class Upload(
        val id: String,
        val identity: Identity,
        val file: File,
        val output: FileOutputStream,
        var written: Long = 0,
        val digest: MessageDigest = MessageDigest.getInstance("SHA-256"),
    )

    init {
        check(directory.parentFile == app.filesDir.canonicalFile) { "Invalid native Reader storage path." }
        check(directory.mkdirs() || directory.isDirectory) { "Could not create native Reader storage." }
        // Only abandoned app-created partial files are removed. Completed books survive updates.
        directory.listFiles()?.filter { it.name.matches(PARTIAL_NAME) && it.isFile }?.forEach { it.delete() }
        cleanupRetired()
        cache.trim()
    }

    /** Remember picker grants for a zero-copy opening of a matching original file. */
    fun rememberSelection(uri: Uri, resultFlags: Int) {
        if (uri.scheme != "content") return
        val source = runCatching {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (!cursor.moveToFirst()) return@use null
                val nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE)
                val name = if (nameColumn >= 0) cursor.getString(nameColumn).orEmpty() else ""
                val size = if (sizeColumn >= 0 && !cursor.isNull(sizeColumn)) cursor.getLong(sizeColumn) else -1L
                if (!name.lowercase().let { it.endsWith(".pdf") || it.endsWith(".djvu") || it.endsWith(".djv") } || size !in 1..MAX_DOCUMENT_BYTES) null
                else JSONObject().put("name", name).put("size", size).put("uri", uri.toString())
            }
        }.getOrNull() ?: return
        if (resultFlags and Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION != 0 &&
            resultFlags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0) {
            runCatching { resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
        }
        synchronized(lock) {
            val previous = sources(prefs.getString(SOURCES_KEY, "[]"))
            val next = JSONArray().put(source)
            for (item in previous) {
                if (item.optString("uri") == uri.toString()) continue
                next.put(item)
                if (next.length() >= MAX_SOURCES) break
            }
            prefs.edit().putString(SOURCES_KEY, next.toString()).apply()
        }
    }

    fun prepare(optionsJson: String): String = synchronized(lock) {
        cache.releaseAll(false)
        cleanupRetired()
        val identity = identity(JSONObject(optionsJson))
        val destination = fileForKey(identity.fileKey, identity.type)
        // Protect the destination before inspection/publication; an old Reader
        // may finish and trim its cache concurrently on another worker.
        cache.reserve(destination)
        if (destination.isFile && matches(destination, identity)) {
            rememberPrepared(destination, identity.documentId)
            cache.trim()
            return@synchronized JSONObject().put("ready", true).put("fileKey", identity.fileKey).put("contentHash", prefs.getString("digest:${destination.name}", "")).toString()
        }
        // A picker URI is mutable and a head/tail sample cannot prove that it
        // matches the saved attachment. Prepare one immutable copy per revision.
        check(uploads.size < MAX_UPLOADS) { "Another document is still being prepared. Try again when it finishes." }
        cache.trim(identity.size + STORAGE_RESERVE_BYTES)
        check(directory.usableSpace > identity.size + STORAGE_RESERVE_BYTES) { "There is not enough free storage to prepare this document." }
        val uploadId = UUID.randomUUID().toString()
        val file = File(directory, "$uploadId.part")
        val output = FileOutputStream(file)
        uploads[uploadId] = Upload(uploadId, identity, file, output)
        JSONObject().put("uploadId", uploadId).toString()
    }

    fun writeChunk(uploadId: String, encoded: String): Boolean = synchronized(lock) {
        val upload = uploads[uploadId] ?: error("The document transfer has expired.")
        require(encoded.isNotEmpty() && encoded.length <= MAX_ENCODED_CHUNK) { "Invalid document transfer chunk." }
        val bytes = Base64.decode(encoded, Base64.NO_WRAP)
        require(bytes.isNotEmpty() && bytes.size <= MAX_CHUNK_BYTES) { "Invalid document transfer chunk." }
        require(upload.written + bytes.size <= upload.identity.size) { "The document transfer exceeds its expected size." }
        try {
            upload.output.write(bytes)
            upload.digest.update(bytes)
            upload.written += bytes.size
            true
        } catch (error: Exception) {
            cancelUploadLocked(uploadId)
            throw error
        }
    }

    fun finishUpload(uploadId: String): String = synchronized(lock) {
        val upload = uploads[uploadId] ?: error("The document transfer has expired.")
        try {
            check(upload.written == upload.identity.size) { "The document transfer is incomplete. Try opening the book again." }
            upload.output.fd.sync()
            upload.output.close()
            check(matches(upload.file, upload.identity)) { "The document changed while it was being prepared. Try opening it again." }
            val destination = fileForKey(upload.identity.fileKey, upload.identity.type)
            if (destination.isFile && matches(destination, upload.identity)) {
                upload.file.delete()
            } else {
                // Same-directory atomic publication keeps interrupted transfers invisible to MuPDF.
                Files.move(upload.file.toPath(), destination.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            }
            uploads.remove(uploadId)
            val contentHash = upload.digest.digest().joinToString("") { "%02x".format(it) }
            prefs.edit().putString("digest:${destination.name}", contentHash).apply()
            rememberPrepared(destination, upload.identity.documentId)
            cache.trim()
            JSONObject().put("ready", true).put("fileKey", upload.identity.fileKey).put("contentHash", contentHash).toString()
        } catch (error: Exception) {
            cancelUploadLocked(uploadId)
            throw error
        }
    }

    fun cancelUpload(uploadId: String) = synchronized(lock) { cancelUploadLocked(uploadId) }

    /** Only native-issued opaque file keys can resolve to a book path. */
    fun localFile(fileKey: String, type: String = "pdf"): File = synchronized(lock) {
        val file = fileForKey(fileKey, type)
        check(file.isFile && file.length() in 1..MAX_DOCUMENT_BYTES) { "The prepared document is unavailable. Open it from Documents again." }
        cache.pin(file)
        file
    }

    /** Arbitrary URIs supplied by JavaScript are never accepted as Reader sources. */
    fun approvedSourceUri(raw: String): Uri? = synchronized(lock) {
        if (raw !in approvedSources) null else Uri.parse(raw).takeIf { it.scheme == "content" }
    }

    fun closeAll() = synchronized(lock) {
        uploads.keys.toList().forEach(::cancelUploadLocked)
        approvedSources.clear()
        releasePreparedFiles()
    }

    fun releasePreparedFiles() = synchronized(lock) { cache.releaseAll(); cleanupRetired() }

    fun forgetDocument(documentId: String) = synchronized(lock) {
        require(documentId.length in 1..200) { "Invalid document identity." }
        val entries = prefs.all.filter { (key, value) -> key.startsWith("book:") && value == documentId }
        val edit = prefs.edit()
        for ((key, _) in entries) {
            val name = key.removePrefix("book:")
            if (name.matches(Regex("[a-f0-9]{64}\\.(pdf|djvu)"))) edit.putBoolean("retired:$name", true)
        }
        check(edit.commit()) { "Could not schedule Reader cache cleanup." }
        cache.releaseAll(false)
        cleanupRetired()
    }

    private fun rememberPrepared(file: File, documentId: String) {
        cache.pin(file)
        val edit = prefs.edit().putString("book:${file.name}", documentId)
        for ((key, value) in prefs.all) if (key.startsWith("book:") && key != "book:${file.name}" && value == documentId) {
            edit.putBoolean("retired:${key.removePrefix("book:")}", true)
        }
        edit.apply()
        cleanupRetired()
    }

    private fun cleanupRetired() {
        val edit = prefs.edit()
        for (key in prefs.all.keys.filter { it.startsWith("retired:") }) {
            val name = key.removePrefix("retired:")
            if (!name.matches(Regex("[a-f0-9]{64}\\.(pdf|djvu)"))) { edit.remove(key); continue }
            val file = File(directory, name)
            cache.retire(file)
            if (!file.exists()) { edit.remove(key); edit.remove("book:$name"); edit.remove("digest:$name") }
        }
        for (key in prefs.all.keys.filter { it.startsWith("book:") }) {
            val name = key.removePrefix("book:")
            if (name.matches(Regex("[a-f0-9]{64}\\.(pdf|djvu)")) && !File(directory, name).exists()) edit.remove(key)
        }
        edit.apply()
    }

    private fun cancelUploadLocked(uploadId: String) {
        val upload = uploads.remove(uploadId) ?: return
        runCatching { upload.output.close() }
        upload.file.delete()
    }

    private fun fileForKey(key: String, type: String): File {
        require(key.matches(FILE_KEY)) { "Invalid native Reader file key." }
        require(type in setOf("pdf", "djvu")) { "Unsupported native Reader format." }
        val file = File(directory, "$key.$type").canonicalFile
        require(file.parentFile == directory) { "Invalid native Reader file path." }
        return file
    }

    private fun identity(options: JSONObject): Identity {
        val documentId = options.optString("documentId").ifBlank { options.optString("id") }
        val name = options.optString("name")
        val size = options.optLong("size", -1)
        val hash = options.optString("sampleHash").lowercase()
        val revision = options.optString("sourceRevision")
        val generation = options.optString("workspaceGeneration", "original")
        val type = options.optString("documentType").ifBlank { if (name.endsWith(".djvu", true) || name.endsWith(".djv", true)) "djvu" else "pdf" }
        require(documentId.length in 1..200 && !documentId.any { it.code < 32 }) { "Invalid document identity." }
        require(type in setOf("pdf", "djvu") && name.length in 1..240 &&
            (if (type == "pdf") name.endsWith(".pdf", true) else name.endsWith(".djvu", true) || name.endsWith(".djv", true))) { "Choose a PDF or DjVu document." }
        require(size in 1..MAX_DOCUMENT_BYTES) { "The document is outside the supported file range." }
        require(hash.matches(FILE_KEY)) { "Invalid document fingerprint." }
        require(revision.length in 1..200 && generation.length in 1..200 && !revision.any { it.code < 32 } && !generation.any { it.code < 32 }) { "Invalid document revision." }
        return Identity(documentId, name, size, hash, type, revision, generation)
    }

    private fun matches(file: File, identity: Identity): Boolean = runCatching {
        file.length() == identity.size && RandomAccessFile(file, "r").use { input ->
            sampleHash(input.channel, identity.size) == identity.sampleHash
        }
    }.getOrDefault(false)

    private fun matches(uri: Uri, identity: Identity): Boolean = runCatching {
        val descriptor = resolver.openFileDescriptor(uri, "r") ?: return@runCatching false
        ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { input ->
            // A pipe is not seekable and falls back to the complete attachment transfer.
            input.channel.size() == identity.size && sampleHash(input.channel, identity.size) == identity.sampleHash
        }
    }.getOrDefault(false)

    private fun sampleHash(channel: FileChannel, size: Long): String {
        val span = minOf(SAMPLE_BYTES.toLong(), size).toInt()
        val head = ByteArray(span)
        val tail = ByteArray(span)
        readFully(channel, head, 0)
        readFully(channel, tail, size - span)
        return MessageDigest.getInstance("SHA-256").run {
            update(head)
            update(tail)
            digest().joinToString("") { "%02x".format(it) }
        }
    }

    private fun readFully(channel: FileChannel, bytes: ByteArray, offset: Long) {
        val buffer = ByteBuffer.wrap(bytes)
        var position = offset
        while (buffer.hasRemaining()) {
            val read = channel.read(buffer, position)
            check(read > 0) { "The document is incomplete or changed while opening." }
            position += read
        }
    }

    private fun sources(raw: String?): List<JSONObject> = runCatching {
        val list = JSONArray(raw ?: "[]")
        (0 until list.length()).mapNotNull { list.optJSONObject(it) }
    }.getOrDefault(emptyList())

    companion object {
        private const val SOURCES_KEY = "selected_pdf_sources_v1"
        private const val SAMPLE_BYTES = 65536
        private const val MAX_CHUNK_BYTES = 256 * 1024
        private const val MAX_ENCODED_CHUNK = ((MAX_CHUNK_BYTES + 2) / 3) * 4
        private const val MAX_DOCUMENT_BYTES = 2L * 1024 * 1024 * 1024
        private const val STORAGE_RESERVE_BYTES = 32L * 1024 * 1024
        private const val MAX_SOURCES = 100
        private const val MAX_UPLOADS = 2
        private val FILE_KEY = Regex("^[a-f0-9]{64}$")
        private val PARTIAL_NAME = Regex("^[a-fA-F0-9-]{36}\\.part$")
        private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }
}
