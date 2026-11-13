package com.noteject.app

import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.FilterInputStream
import java.io.InputStream

/** Private, range-aware playback. No WAV-sized JavaScript allocation is needed. */
object AndroidAudioFiles {
    fun response(request: WebResourceRequest, audio: AndroidAudio?): WebResourceResponse? {
        val uri = request.url
        if (uri.scheme != "https" || uri.host != "appassets.androidplatform.net" || !uri.path.orEmpty().startsWith("/recordings/")) return null
        val id = uri.path.orEmpty().removePrefix("/recordings/").removeSuffix(".wav")
        if (uri.path != "/recordings/$id.wav") return empty(404, "Not Found")
        if (request.method !in setOf("GET", "HEAD")) return empty(405, "Method Not Allowed")
        val manager = audio ?: return empty(404, "Not Found")
        val file = runCatching { manager.recordingFile(id) }.getOrNull() ?: return empty(404, "Not Found")
        val length = file.length()
        val range = request.requestHeaders.entries.firstOrNull { it.key.equals("Range", true) }?.value
        val limits = range?.let { parseRange(it, length) }
        if (range != null && limits == null) return empty(416, "Range Not Satisfiable", mapOf("Content-Range" to "bytes */$length"))
        val start = limits?.first ?: 0L
        val end = limits?.last ?: (length - 1)
        val count = end - start + 1
        val headers = linkedMapOf("Accept-Ranges" to "bytes", "Content-Length" to count.toString(), "Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff")
        if (limits != null) headers["Content-Range"] = "bytes $start-$end/$length"
        val source: InputStream = if (request.method == "HEAD") ByteArrayInputStream(byteArrayOf()) else {
            val input = runCatching { manager.openRecordingStream(id) }.getOrNull() ?: return empty(404, "Not Found")
            try { input.channel.position(start); LimitedInput(input, count) } catch (_: Exception) { input.close(); return empty(404, "Not Found") }
        }
        return WebResourceResponse("audio/wav", null, if (limits == null) 200 else 206, if (limits == null) "OK" else "Partial Content", headers, source)
    }

    internal fun parseRange(value: String, length: Long): LongRange? {
        if (length <= 0) return null
        val match = Regex("^bytes=(\\d*)-(\\d*)$", RegexOption.IGNORE_CASE).matchEntire(value.trim()) ?: return null
        val first = match.groupValues[1]; val last = match.groupValues[2]
        if (first.isEmpty()) {
            val count = last.toLongOrNull()?.takeIf { it > 0 } ?: return null
            return maxOf(0, length - count)..(length - 1)
        }
        val start = first.toLongOrNull()?.takeIf { it in 0 until length } ?: return null
        val end = if (last.isEmpty()) length - 1 else last.toLongOrNull()?.coerceAtMost(length - 1) ?: return null
        return (start..end).takeIf { end >= start }
    }

    private fun empty(status: Int, reason: String, headers: Map<String, String> = emptyMap()) = WebResourceResponse("audio/wav", null, status, reason,
        headers + mapOf("Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff"), ByteArrayInputStream(byteArrayOf()))

    private class LimitedInput(source: InputStream, private var remaining: Long) : FilterInputStream(source) {
        override fun read(): Int {
            if (remaining <= 0) return -1
            val value = super.read(); if (value >= 0) remaining-- else remaining = 0
            return value
        }
        override fun read(bytes: ByteArray, offset: Int, length: Int): Int {
            if (length == 0) return 0
            if (remaining <= 0) return -1
            val count = `in`.read(bytes, offset, minOf(length.toLong(), remaining).toInt())
            if (count > 0) remaining -= count else if (count < 0) remaining = 0
            return count
        }
        override fun skip(count: Long): Long {
            val skipped = `in`.skip(minOf(maxOf(0, count), remaining)); remaining -= skipped
            return skipped
        }
        override fun available(): Int = minOf(`in`.available().toLong(), remaining, Int.MAX_VALUE.toLong()).toInt()
    }
}
