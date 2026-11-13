package com.noteject.app

import android.graphics.Bitmap
import android.graphics.PointF
import android.graphics.Rect
import android.graphics.RectF
import org.json.JSONArray
import java.io.File

/** DjVuLibre writes scaled regions directly into Android pixels, with no PNG bridge. */
class DjVuDocument(file: File) : NativePagedDocument {
    private val lock = Any()
    @Volatile private var handle = 0L
    override val format = "djvu"
    override val pageCount: Int

    init {
        require(file.exists() && file.canRead()) { "The DjVu file is unavailable." }
        val opened = DjVuNative.open(file.absolutePath)
        try {
            pageCount = DjVuNative.pageCount(opened)
            require(pageCount > 0) { "This DjVu file contains no readable pages." }
            handle = opened
        } catch (error: Throwable) {
            DjVuNative.close(opened)
            throw error
        }
    }

    private fun requireOpen(): Long = checkNotNull(handle.takeIf { it != 0L }) { "The document is closed." }
    private fun requirePage(page: Int) { require(page in 0 until pageCount) { "Page ${page + 1} is outside this document." } }

    override fun getPageSize(pageIndex: Int): PointF = synchronized(lock) {
        requirePage(pageIndex)
        val size = DjVuNative.size(requireOpen(), pageIndex)
        PointF(size[0].toFloat(), size[1].toFloat())
    }

    override fun render(pageIndex: Int, width: Int, height: Int, patch: Rect?): Bitmap = synchronized(lock) {
        requirePage(pageIndex)
        require(width in 1..131_072 && height in 1..131_072) { "Invalid page render dimensions." }
        val region = patch?.let(::Rect) ?: Rect(0, 0, width, height)
        require(region.intersect(0, 0, width, height) && !region.isEmpty &&
            region.width() <= 8192 && region.height() <= 8192 &&
            region.width().toLong() * region.height() <= 6_000_000L) { "Invalid DjVu page region." }
        val bitmap = Bitmap.createBitmap(region.width(), region.height(), Bitmap.Config.ARGB_8888)
        try {
            DjVuNative.render(requireOpen(), pageIndex, width, height, region.left, region.top, bitmap)
            bitmap
        } catch (error: Throwable) {
            bitmap.recycle()
            throw error
        }
    }

    override fun text(pageIndex: Int): String = synchronized(lock) {
        requirePage(pageIndex)
        DjVuNative.text(requireOpen(), pageIndex).toString(Charsets.UTF_8)
    }

    override fun pageText(pageIndex: Int): ReaderPageText = synchronized(lock) {
        requirePage(pageIndex)
        val words = JSONArray(DjVuNative.textLayout(requireOpen(), pageIndex).toString(Charsets.UTF_8))
        val result = ReaderPageText.Builder(); var lastLine = -1
        for (index in 0 until words.length()) {
            val word = words.getJSONObject(index)
            val line = word.getInt("line")
            if (index > 0) result.separator(if (line == lastLine) " " else "\n")
            val value = word.getString("text")
            val direction = value.firstOrNull { it.isLetter() }?.let { Character.getDirectionality(it) }
            result.append(value, RectF(word.getDouble("left").toFloat(), word.getDouble("top").toFloat(),
                word.getDouble("right").toFloat(), word.getDouble("bottom").toFloat()), line,
                direction == Character.DIRECTIONALITY_RIGHT_TO_LEFT || direction == Character.DIRECTIONALITY_RIGHT_TO_LEFT_ARABIC)
            lastLine = line
        }
        result.build()
    }

    override fun outline(): List<NativePagedDocument.OutlineEntry> = synchronized(lock) {
        val entries = JSONArray(DjVuNative.outline(requireOpen()).toString(Charsets.UTF_8))
        buildList {
            for (index in 0 until entries.length()) {
                val item = entries.getJSONObject(index)
                val page = item.optInt("page", -1)
                if (page in 0 until pageCount) add(NativePagedDocument.OutlineEntry(item.optString("title", "Page ${page + 1}"), page, item.optInt("depth")))
            }
        }
    }

    override fun cancelRender() { val current = handle; if (current != 0L) DjVuNative.cancel(current) }
    override fun trimMemory() = synchronized(lock) { if (handle != 0L) DjVuNative.trim(handle) }
    override fun close() {
        cancelRender()
        synchronized(lock) {
            val current = handle; handle = 0L
            if (current != 0L) DjVuNative.close(current)
        }
    }
}

internal object DjVuNative {
    init { System.loadLibrary("noteject_djvu") }
    external fun open(path: String): Long
    external fun pageCount(handle: Long): Int
    external fun size(handle: Long, page: Int): IntArray
    external fun render(handle: Long, page: Int, width: Int, height: Int, left: Int, top: Int, bitmap: Bitmap)
    external fun text(handle: Long, page: Int): ByteArray
    external fun textLayout(handle: Long, page: Int): ByteArray
    external fun outline(handle: Long): ByteArray
    external fun cancel(handle: Long)
    external fun trim(handle: Long)
    external fun close(handle: Long)
}
