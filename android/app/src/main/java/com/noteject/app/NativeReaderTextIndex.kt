package com.noteject.app

import android.content.Context
import android.util.AtomicFile
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.security.MessageDigest

/** Resumable, bounded native text extraction. One page runs per idle Reader turn. */
internal class NativeReaderTextIndex(context: Context, private val options: JSONObject, private val pages: Int, private val publish: (JSONObject) -> Unit) {
    private val root = File(context.filesDir, "reader-text-index").apply { mkdirs() }
    val key = MessageDigest.getInstance("SHA-256").digest("revision-v2\u0000${options.optString("workspaceGeneration", "original")}\u0000${options.optString("documentId")}\u0000${options.optString("sourceRevision")}\u0000${options.optString("sampleHash")}\u0000${options.optLong("size")}\u0000${options.optString("documentType")}".toByteArray()).joinToString("") { "%02x".format(it) }
    private val textFile = File(root, "$key.txt")
    private val stateFile = AtomicFile(File(root, "$key.json"))
    private var state = JSONObject()
    private var announced = false
    @Volatile private var indexed = state.optInt("next")
    @Volatile private var finished = state.optBoolean("complete")
    @Volatile var partial = false
        private set
    init { synchronized(ioLock) {
        state = runCatching { JSONObject(stateFile.openRead().bufferedReader().use { it.readText() }) }.getOrElse { JSONObject() }
        if (state.optInt("pages") != pages || state.optInt("next") !in 0..pages || state.optInt("chars") !in 0..MAX_CHARS || state.optLong("bytes") !in 0..12_000_000L || !textFile.exists() || textFile.length() < state.optLong("bytes")) state = JSONObject()
        state.put("pages", pages).put("documentId", options.optString("documentId"))
        RandomAccessFile(textFile, "rw").use { it.setLength(state.optLong("bytes")) }
        indexed = state.optInt("next"); finished = state.optBoolean("complete"); partial = state.optBoolean("truncated") || state.optInt("chars") >= MAX_CHARS
        textFile.setLastModified(System.currentTimeMillis())
        // Bound the native index cache independently of documents and notes.
        var bytes = root.listFiles()?.sumOf { it.length() } ?: 0L
        for (old in root.listFiles()?.filter { it.extension == "txt" && it.nameWithoutExtension != key }?.sortedBy { it.lastModified() }.orEmpty()) {
            if (bytes <= 32L * 1024 * 1024) break
            val count = old.length(); if (old.delete()) { bytes -= count; File(root, "${old.nameWithoutExtension}.json").delete() }
        }
    } }
    val progress get() = indexed.coerceAtMost(pages)
    val complete get() = finished
    fun advance(document: NativePagedDocument): Boolean = synchronized(ioLock) {
        if (complete) { if (!announced) announce(); return@synchronized false }
        val page = progress
        if (page >= pages) return@synchronized false
        val available = (MAX_CHARS - state.optInt("chars")).coerceAtLeast(0)
        val original = runCatching { document.text(page) }.getOrElse { state.put("skippedPages", state.optInt("skippedPages") + 1); "" }
        val text = original.take(minOf(16_384, available))
        if (original.length > text.length) state.put("truncated", true)
        val bytes = "[Page ${page + 1}]\n$text\n\n".toByteArray(Charsets.UTF_8)
        FileOutputStream(textFile, true).use { it.write(bytes); it.fd.sync() }
        state.put("next", page + 1).put("chars", state.optInt("chars") + text.length).put("bytes", textFile.length())
            .put("complete", page + 1 >= pages || state.optInt("chars") >= MAX_CHARS)
        val stream = stateFile.startWrite()
        try { stream.write(state.toString().toByteArray()); stateFile.finishWrite(stream) } catch (error: Throwable) { stateFile.failWrite(stream); throw error }
        indexed = state.optInt("next"); finished = state.optBoolean("complete"); partial = state.optBoolean("truncated") || state.optInt("chars") >= MAX_CHARS
        if (complete || page == 0 || (page + 1) % 16 == 0) announce()
        !complete
    }
    private fun announce() { announced = true; publish(JSONObject().put("type", "indexReady").put("indexKey", key).put("indexedPages", progress).put("pages", pages).put("complete", complete).put("truncated", partial)) }
    companion object {
        private val ioLock = Any()
        private const val MAX_CHARS = 2_000_000
        fun read(context: Context, key: String, offset: Long): JSONObject = synchronized(ioLock) {
            require(key.matches(Regex("[a-f0-9]{64}")) && offset >= 0) { "Invalid text index request." }
            val root = File(context.filesDir, "reader-text-index")
            val state = JSONObject(AtomicFile(File(root, "$key.json")).openRead().bufferedReader().use { it.readText() })
            val length = state.optLong("bytes"); require(offset <= length) { "Invalid text index offset." }
            val count = minOf(65_536L, length - offset).toInt(); val bytes = ByteArray(count)
            RandomAccessFile(File(root, "$key.txt"), "r").use { it.seek(offset); it.readFully(bytes) }
            JSONObject().put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP)).put("next", offset + count).put("size", length).put("done", offset + count >= length)
                .put("documentId", state.optString("documentId")).put("indexedPages", state.optInt("next")).put("complete", state.optBoolean("complete"))
        }
    }
}
