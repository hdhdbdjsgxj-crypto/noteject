package com.noteject.app

import android.graphics.Bitmap
import android.graphics.PointF
import android.graphics.Rect
import java.io.Closeable

/** Engine contract for the shared native Reader, coordinates and page numbers are zero-based. */
interface NativePagedDocument : Closeable {
    data class OutlineEntry(val title: String, val pageIndex: Int, val depth: Int)
    val pageCount: Int
    val format: String
    fun getPageSize(pageIndex: Int): PointF
    fun render(pageIndex: Int, width: Int, height: Int, patch: Rect? = null): Bitmap
    fun text(pageIndex: Int): String
    fun pageText(pageIndex: Int): ReaderPageText
    fun outline(): List<OutlineEntry>
    fun cancelRender()
    fun trimMemory()
    fun destroy() = close()
}
