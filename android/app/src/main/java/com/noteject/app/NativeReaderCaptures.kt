package com.noteject.app

import android.content.Context
import android.graphics.Bitmap
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.util.UUID

/** Durable, private hand-off files. Deleted only after the workspace acknowledges saving. */
internal object NativeReaderCaptures {
    private fun directory(context: Context) = File(context.filesDir, "reader-note-captures").apply { mkdirs() }
    private fun file(context: Context, id: String): File {
        require(Regex("[a-f0-9-]{36}").matches(id)) { "Invalid Reader capture." }
        return File(directory(context), "$id.png")
    }
    fun save(context: Context, bitmap: Bitmap): String {
        val id = UUID.randomUUID().toString()
        val target = file(context, id)
        try {
            target.outputStream().use { stream ->
                check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)) { "Could not encode this capture." }
                stream.fd.sync()
            }
            require(target.length() in 1..25L * 1024 * 1024) { "The capture is too large. Select a smaller area." }
            return id
        } catch (error: Throwable) { target.delete(); throw error }
    }
    fun read(context: Context, id: String, offset: Long): JSONObject {
        val target = file(context, id)
        require(target.isFile && target.length() <= 25L * 1024 * 1024 && offset in 0..target.length()) { "Reader capture unavailable." }
        RandomAccessFile(target, "r").use { input ->
            input.seek(offset)
            val bytes = ByteArray(minOf(256L * 1024, input.length() - offset).toInt())
            input.readFully(bytes)
            val next = offset + bytes.size
            return JSONObject().put("data", Base64.encodeToString(bytes, Base64.NO_WRAP)).put("next", next)
                .put("total", input.length()).put("done", next == input.length()).put("mime", "image/png")
        }
    }
    fun remove(context: Context, id: String) { runCatching { file(context, id).delete() } }
}
