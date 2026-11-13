package com.noteject.app

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.PointF
import android.graphics.Rect
import android.graphics.RectF
import com.artifex.mupdf.fitz.Context
import com.artifex.mupdf.fitz.Cookie
import com.artifex.mupdf.fitz.DisplayList
import com.artifex.mupdf.fitz.DisplayListDevice
import com.artifex.mupdf.fitz.Document
import com.artifex.mupdf.fitz.Matrix
import com.artifex.mupdf.fitz.Outline
import com.artifex.mupdf.fitz.Page
import com.artifex.mupdf.fitz.android.AndroidDrawDevice
import java.io.File
import java.io.IOException
import java.util.LinkedHashMap
import java.util.concurrent.CancellationException
import java.util.concurrent.atomic.AtomicLong

class MuPdfPasswordException(val incorrectPassword: Boolean) : IOException(
    if (incorrectPassword) "That PDF password is incorrect." else "This PDF needs a password."
)

/**
 * Owns the native MuPDF document. Native document operations are serialized; only
 * cancelRender may run concurrently. Pixels remain native Android bitmaps, never
 * encoded images or messages sent through the WebView.
 */
class MuPdfDocument(file: File, password: String = "") : NativePagedDocument {
    override val format = "pdf"

    private class CachedPage(val page: Page, val bounds: com.artifex.mupdf.fitz.Rect) {
        var displayList: DisplayList? = null

        fun destroy() {
            try {
                displayList?.destroy()
            } finally {
                displayList = null
                page.destroy()
            }
        }
    }

    private val documentLock = Any()
    private val cookieLock = Any()
    private val cancellationGeneration = AtomicLong()
    private var activeCookie: Cookie? = null
    private var document: Document? = null
    @Volatile private var count = 0
    private val pageSizes = HashMap<Int, PointF>()
    private val pages = LinkedHashMap<Int, CachedPage>(4, 0.75f, true)

    init {
        // A seekable content-provider descriptor may be opened through /proc/self/fd
        // and report an unknown length. Let MuPDF validate the source itself.
        require(file.exists() && file.canRead()) { "The document file is missing or cannot be read." }
        val opened = Document.openDocument(file.absolutePath)
        try {
            if (opened.needsPassword() && !opened.authenticatePassword(password)) {
                throw MuPdfPasswordException(password.isNotEmpty())
            }
            // The bundled fitz AAR exposes setPageTreeCache in Java but its
            // Android native libraries do not implement it. Use the supported
            // document API so opening never depends on that optional binding.
            count = opened.countPages()
            require(count > 0) { "The document has no readable pages." }
            document = opened
        } catch (error: Throwable) {
            opened.destroy()
            throw error
        }
    }

    override val pageCount: Int
        get() = count

    override fun getPageSize(pageIndex: Int): PointF = synchronized(documentLock) {
        requirePage(pageIndex)
        val cached = pageSizes[pageIndex]
        if (cached != null) return@synchronized PointF(cached.x, cached.y)
        val bounds = loadPage(pageIndex).bounds
        val size = PointF(bounds.x1 - bounds.x0, bounds.y1 - bounds.y0)
        pageSizes[pageIndex] = size
        PointF(size.x, size.y)
    }

    /**
     * width and height describe the entire scaled page. A patch uses those same
     * pixel coordinates, but allocates and renders only the intersecting region.
     * The returned bitmap has patch.width x patch.height pixels.
     */
    override fun render(pageIndex: Int, width: Int, height: Int, patch: Rect?): Bitmap = synchronized(documentLock) {
        requirePage(pageIndex)
        require(width in 1..MAX_PAGE_DIMENSION && height in 1..MAX_PAGE_DIMENSION) { "Invalid page render dimensions." }
        val region = patch?.let { Rect(it) } ?: Rect(0, 0, width, height)
        require(region.intersect(0, 0, width, height) && !region.isEmpty) { "The requested page region is empty." }
        require(region.width() <= MAX_BITMAP_DIMENSION && region.height() <= MAX_BITMAP_DIMENSION &&
            region.width().toLong() * region.height() <= MAX_BITMAP_PIXELS) {
            "The requested page image is too large. Render a smaller visible region."
        }

        val generation = cancellationGeneration.get()
        val cookie = Cookie()
        synchronized(cookieLock) { activeCookie = cookie }
        var bitmap: Bitmap? = null
        try {
            checkCancelled(generation)
            val cached = loadPage(pageIndex)
            val list = displayList(cached, cookie, generation)
            val bounds = cached.bounds
            val scaleX = width / (bounds.x1 - bounds.x0)
            val scaleY = height / (bounds.y1 - bounds.y0)
            val transform = Matrix(scaleX, 0f, 0f, scaleY, -bounds.x0 * scaleX, -bounds.y0 * scaleY)
            val result = Bitmap.createBitmap(region.width(), region.height(), Bitmap.Config.ARGB_8888)
            bitmap = result
            result.eraseColor(Color.WHITE)
            val device = AndroidDrawDevice(result, region.left, region.top, false)
            try {
                val clip = com.artifex.mupdf.fitz.Rect(region.left.toFloat(), region.top.toFloat(), region.right.toFloat(), region.bottom.toFloat())
                list.run(device, transform, clip, cookie)
                device.close()
            } finally {
                device.destroy()
            }
            checkCancelled(generation)
            result
        } catch (error: Throwable) {
            bitmap?.recycle()
            if (cancellationGeneration.get() != generation) throw CancellationException("Page rendering was cancelled.")
            throw error
        } finally {
            synchronized(cookieLock) {
                activeCookie = null
                cookie.destroy()
            }
            // This is a retention target for MuPDF's shared decoded-resource
            // cache, not a cap on all native allocations or a rendering peak.
            if (!Context.shrinkStore(25)) Context.emptyStore()
        }
    }

    override fun text(pageIndex: Int): String = synchronized(documentLock) {
        requirePage(pageIndex)
        val structuredText = loadPage(pageIndex).page.toStructuredText("preserve-whitespace")
        try {
            structuredText.asText()
        } finally {
            structuredText.destroy()
        }
    }

    override fun pageText(pageIndex: Int): ReaderPageText = synchronized(documentLock) {
        requirePage(pageIndex)
        val page = loadPage(pageIndex)
        val bounds = page.bounds
        val width = bounds.x1 - bounds.x0; val height = bounds.y1 - bounds.y0
        val structured = page.page.toStructuredText("preserve-whitespace")
        try {
            val result = ReaderPageText.Builder(); var lineNumber = 0
            for (block in structured.blocks) for (line in block.lines) {
                for (char in line.chars) {
                    if (!Character.isValidCodePoint(char.c) || char.c == 10 || char.c == 13) continue
                    val rect = char.quad.toRect()
                    result.append(String(Character.toChars(char.c)), RectF((rect.x0 - bounds.x0) / width, (rect.y0 - bounds.y0) / height,
                        (rect.x1 - bounds.x0) / width, (rect.y1 - bounds.y0) / height), lineNumber, char.bidi and 1 != 0)
                }
                result.separator("\n"); lineNumber++
            }
            result.build()
        } finally { structured.destroy() }
    }

    override fun outline(): List<NativePagedDocument.OutlineEntry> = synchronized(documentLock) {
        val opened = requireOpen()
        val result = ArrayList<NativePagedDocument.OutlineEntry>()
        // Use a stack so malformed, deeply nested outlines cannot overflow the JVM stack.
        val pending = java.util.ArrayDeque<Pair<Outline, Int>>()
        opened.loadOutline()?.reversed()?.forEach { pending.addLast(it to 0) }
        var visited = 0
        while (pending.isNotEmpty() && visited++ < MAX_OUTLINE_ENTRIES) {
            val (item, depth) = pending.removeLast()
            val pageIndex = try {
                if (item.uri.isNullOrBlank()) -1 else opened.pageNumberFromLocation(opened.resolveLink(item.uri))
            } catch (_: RuntimeException) {
                -1
            }
            if (pageIndex in 0 until count) result.add(NativePagedDocument.OutlineEntry(item.title.orEmpty().ifBlank { "Page ${pageIndex + 1}" }, pageIndex, depth))
            if (depth < MAX_OUTLINE_DEPTH) item.down?.reversed()?.forEach { pending.addLast(it to depth + 1) }
        }
        result
    }

    /** Can be called from the UI while the render worker owns documentLock. */
    override fun cancelRender() {
        cancellationGeneration.incrementAndGet()
        synchronized(cookieLock) { activeCookie?.abort() }
    }

    override fun trimMemory() {
        synchronized(documentLock) {
            pages.values.forEach { it.destroy() }
            pages.clear()
            Context.shrinkStore(25)
        }
    }

    override fun close() {
        cancelRender()
        synchronized(documentLock) {
            try {
                pages.values.forEach { it.destroy() }
            } finally {
                pages.clear()
                pageSizes.clear()
                document?.destroy()
                document = null
                count = 0
                Context.emptyStore()
            }
        }
    }

    override fun destroy() = close()

    private fun requireOpen(): Document = checkNotNull(document) { "The document is closed." }

    private fun requirePage(pageIndex: Int) {
        requireOpen()
        require(pageIndex in 0 until count) { "Page ${pageIndex + 1} is outside this document." }
    }

    private fun loadPage(pageIndex: Int): CachedPage {
        pages[pageIndex]?.let { return it }
        val page = requireOpen().loadPage(pageIndex)
        val bounds = try {
            page.bounds.also {
                require(it.x0.isFinite() && it.y0.isFinite() && it.x1.isFinite() && it.y1.isFinite() &&
                    it.x1 > it.x0 && it.y1 > it.y0) { "Page ${pageIndex + 1} has invalid dimensions." }
            }
        } catch (error: Throwable) {
            page.destroy()
            throw error
        }
        val entry = CachedPage(page, bounds)
        pages[pageIndex] = entry
        if (pages.size > MAX_CACHED_PAGES) {
            val eldest = pages.entries.iterator()
            val expired = eldest.next().value
            eldest.remove()
            expired.destroy()
        }
        return entry
    }

    private fun displayList(cached: CachedPage, cookie: Cookie, generation: Long): DisplayList {
        cached.displayList?.let { return it }
        val list = DisplayList(cached.bounds)
        try {
            val device = DisplayListDevice(list)
            try {
                cached.page.run(device, Matrix.Identity(), cookie)
                device.close()
            } finally {
                device.destroy()
            }
            checkCancelled(generation)
            cached.displayList = list
            return list
        } catch (error: Throwable) {
            list.destroy()
            throw error
        }
    }

    private fun checkCancelled(generation: Long) {
        if (Thread.currentThread().isInterrupted || cancellationGeneration.get() != generation) {
            throw CancellationException("Page rendering was cancelled.")
        }
    }

    companion object {
        private const val MAX_CACHED_PAGES = 3
        private const val MAX_PAGE_DIMENSION = 131_072
        private const val MAX_BITMAP_DIMENSION = 8192
        private const val MAX_BITMAP_PIXELS = 6_000_000L
        private const val MAX_OUTLINE_ENTRIES = 10_000
        private const val MAX_OUTLINE_DEPTH = 64
    }
}
