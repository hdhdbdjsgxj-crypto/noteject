package com.noteject.app

import android.app.ActivityManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PointF
import android.graphics.Rect
import android.graphics.RectF
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.AttributeSet
import android.view.GestureDetector
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.widget.OverScroller
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * A native, continuous document surface. Only visible pages and their neighbours are
 * scheduled. Native document calls are confined to one worker; drawing and cache
 * ownership stay on the UI thread.
 */
class NativeReaderView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null
) : View(context, attrs) {
    var onPageChange: ((Int, Int) -> Unit)? = null
    var onError: ((String) -> Unit)? = null
    var onLoadingChanged: ((Boolean) -> Unit)? = null
    var onTextSelectionChanged: ((ReaderTextSelection?) -> Unit)? = null
    var onTextSelectionPositionChanged: (() -> Unit)? = null
    var onTextSelectionFeedback: ((String) -> Unit)? = null
    var onSingleTap: (() -> Unit)? = null
    var onDoubleTap: (() -> Unit)? = null
    var onZoomChange: ((Float) -> Unit)? = null
    var onIdleIndex: ((NativePagedDocument) -> Boolean)? = null
    var backgroundWorkEnabled = true
        set(value) { field = value; if (value) requestRefresh() else ui.removeCallbacks(auxiliary) }
    private data class SavedPassage(val page: Int, val quote: String, val offset: Int, val color: Int)
    private data class SavedOverlay(val color: Int, val rectangles: List<RectF>)
    private var savedPassages = emptyList<SavedPassage>()
    private var savedRevision = 0
    private val savedOverlays = HashMap<Int, List<SavedOverlay>>()
    private val highlightPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private var auxiliaryBusy = false
    private var indexPending = true
    private var metricsStarted = 0L
    private var firstPaintMs: Long? = null
    private var lastActiveFrame = 0L
    private var peakBitmapBytes = 0L
    private val activeFrameIntervals = ArrayList<Long>()

    fun performanceSnapshot(): JSONObject {
        val sorted = activeFrameIntervals.sorted()
        return JSONObject().put("firstPagePaintMs", firstPaintMs ?: JSONObject.NULL).put("sampledInteractionFrames", sorted.size)
            .put("interactionFrameP95Ms", if (sorted.isEmpty()) JSONObject.NULL else sorted[((sorted.size - 1) * .95).toInt()])
            .put("peakCachedBitmapBytes", peakBitmapBytes).put("bitmapCacheBudgetBytes", cacheLimit)
            .put("pageCount", pageCount).put("page", currentPageIndex + 1).put("zoom", zoomFactor)
    }

    fun capturePage(page: Int, region: RectF?, ready: (Bitmap?, String?) -> Unit) {
        val doc = document ?: return ready(null, "Open a document first.")
        val expected = generation
        val crop = region?.let { RectF(it) }
        worker.execute {
            var output: Bitmap? = null
            var error: String? = null
            try {
                val size = doc.getPageSize(page)
                val area = crop ?: RectF(0f,0f,1f,1f)
                require(area.width() > 0 && area.height() > 0) { "Select an area first." }
                val longest = if (crop == null) 1600f else 2400f
                val factor = minOf(if (crop == null) 3f else 4f, longest/(size.x*area.width()), longest/(size.y*area.height()),
                    kotlin.math.sqrt(4_000_000f/(size.x*size.y*area.width()*area.height())), 32000f/max(size.x,size.y))
                val fullWidth = max(1,(size.x*factor).roundToInt()); val fullHeight = max(1,(size.y*factor).roundToInt())
                val patch = if (crop == null) null else Rect((area.left*fullWidth).toInt().coerceIn(0,fullWidth-1), (area.top*fullHeight).toInt().coerceIn(0,fullHeight-1),
                    ceil(area.right*fullWidth).toInt().coerceIn(1,fullWidth),ceil(area.bottom*fullHeight).toInt().coerceIn(1,fullHeight))
                output = doc.render(page,fullWidth,fullHeight,patch)
            } catch (failure: Throwable) { error = failure.message ?: "Could not render this page area." }
            val result = output; val message = error
            ui.post {
                if (closed || generation != expected) result?.recycle()
                else ready(result,message)
            }
        }
    }


    private var passageSourceRevision = ""
    fun setSavedPassages(passages: List<JSONObject>, sourceRevision: String? = null) {
        if (sourceRevision != null) passageSourceRevision = sourceRevision
        val palette = mapOf("violet" to 0xffa995ee.toInt(), "blue" to 0xff84b8ff.toInt(), "teal" to 0xff6fd3bc.toInt(), "amber" to 0xffefc071.toInt(), "rose" to 0xfff097b6.toInt(), "gray" to 0xffaab4c5.toInt())
        savedPassages = passages.flatMap { item ->
            val location = item.optJSONObject("location") ?: item.optJSONObject("selectionLocation") ?: JSONObject()
            if (location.optString("sourceRevision").let { it.isNotBlank() && it != passageSourceRevision }) return@flatMap emptyList()
            val color = palette[item.optString("color")] ?: palette.getValue("violet")
            val pages = location.optJSONArray("pages")
            if (pages != null && pages.length() > 0) (0 until min(128, pages.length())).mapNotNull { index ->
                val part = pages.optJSONObject(index) ?: return@mapNotNull null
                val page = part.optInt("page", 0) - 1; val quote = part.optString("quote")
                if (page < 0 || quote.isBlank()) null else SavedPassage(page, quote, part.optInt("textOffset", -1), color)
            } else {
                val page = location.optInt("page", 1) - 1; val quote = item.optString("quote", item.optString("selectionQuote"))
                listOfNotNull(if (page < 0 || quote.isBlank()) null else SavedPassage(page, quote, location.optInt("textOffset", -1), color))
            }
        }
        savedRevision++; savedOverlays.clear(); requestRefresh(); invalidate()
    }

    private val auxiliary = Runnable {
        val doc = document
        if (!closed && doc != null && backgroundWorkEnabled && !auxiliaryBusy && activeWork == null && !scaling && scroller.isFinished && !selection.active && SystemClock.uptimeMillis() >= reduceWorkUntil && SystemClock.uptimeMillis() - lastMotion >= 450 && requested.all { cache.get(it) != null }) {
            val first = pageAt(panY / zoomFactor); val last = pageAt((panY + height) / zoomFactor)
            savedOverlays.keys.retainAll((first..last).toSet())
            val page = (first..last).firstOrNull { candidate -> savedPassages.any { it.page == candidate } && !savedOverlays.containsKey(candidate) }
            if (page != null || indexPending) {
                auxiliaryBusy = true
                val expected = generation; val revision = savedRevision; val marks = savedPassages.filter { it.page == page }
                worker.execute {
                    var overlays: List<SavedOverlay>? = null; var more = indexPending
                    try {
                        if (page != null) {
                            val layout = doc.pageText(page)
                            var rectanglesLeft = 8000
                            overlays = marks.take(256).mapNotNull { mark ->
                                if (rectanglesLeft <= 0) return@mapNotNull null
                                val at = mark.offset
                                val range = if (at >= 0 && at + mark.quote.length <= layout.text.length && layout.text.regionMatches(at, mark.quote, 0, mark.quote.length, true)) at until at + mark.quote.length else layout.find(mark.quote)
                                range?.let { val rectangles = layout.rectangles(it.first, it.last + 1).take(rectanglesLeft); rectanglesLeft -= rectangles.size; SavedOverlay(mark.color, rectangles) }
                            }
                        } else more = onIdleIndex?.invoke(doc) ?: false
                    } catch (_: Exception) { if (page != null) overlays = emptyList() else more = false }
                    ui.post {
                        auxiliaryBusy = false
                        if (!closed && expected == generation) {
                            if (page != null && revision == savedRevision) savedOverlays[page] = overlays.orEmpty()
                            indexPending = more; invalidate(); requestRefresh()
                        }
                    }
                }
            }
        } else if (!closed && backgroundWorkEnabled && (indexPending || savedPassages.isNotEmpty())) ui.postDelayed({ requestRefresh() }, 600)
    }

    var currentPageIndex: Int = 0
        private set
    var zoomFactor: Float = 1f
        private set

    private val density = resources.displayMetrics.density
    private val gutter = 12f * density
    private val gap = 12f * density
    private val ui = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor { task ->
        Thread(task, "Noteject-reader-pages").apply { priority = Thread.NORM_PRIORITY - 1 }
    }
    private val scroller = OverScroller(context)
    private val bitmapPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private val paperPaint = Paint().apply { color = Color.WHITE }
    private val borderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(193, 199, 207)
        style = Paint.Style.STROKE
        strokeWidth = density
    }
    private val labelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(87, 98, 116)
        textAlign = Paint.Align.CENTER
        textSize = 14f * resources.displayMetrics.scaledDensity
    }
    private val pageRect = RectF()
    private val drawRect = RectF()
    private var document: NativePagedDocument? = null
    private var generation = 0L
    private var closed = false
    private var pageCount = 0
    private var pageWidths = FloatArray(0)
    private var pageHeights = FloatArray(0)
    private var pageTops = FloatArray(0)
    private var knownSize = BooleanArray(0)
    private var estimatedRatio = 1.4142135f
    private var haveReferenceSize = false
    private var basePageWidth = 1f
    private var layoutWidth = 1f
    private var documentHeight = 0f
    private var layoutRevision = 0L
    private var panX = 0f
    private var panY = 0f
    private var scaling = false
    private var multiTouchSequence = false
    private var lastScaleFocusX = 0f
    private var lastScaleFocusY = 0f
    private var lastMotion = 0L
    private var detailLevel = 1f
    private var reduceWorkUntil = 0L
    private var lastLoading: Boolean? = null
    private var lastReportedPage = -1
    private var frameQueued = false
    private var activeWork: Work? = null
    private var requested = emptyList<RenderKey>()
    private var pendingSelectionLoad: Pair<Int, (Result<ReaderPageText>) -> Unit>? = null
    private val selectionTextRequest = AtomicLong()
    private val pageErrors = HashMap<Int, String>()
    private val failedTiles = HashSet<RenderKey>()
    private val previewKeys = HashMap<Int, RenderKey>()
    // A page exposes one complete detail layer at a time. A new resolution is
    // assembled off screen while the previous layer remains readable.
    private val displayedTiles = HashMap<Int, List<RenderKey>>()
    private val pendingTiles = HashMap<Int, List<RenderKey>>()
    private var detailViewport: DetailViewport? = null

    private data class RenderKey(
        val page: Int,
        val width: Int,
        val height: Int,
        val left: Int = 0,
        val top: Int = 0,
        val right: Int = width,
        val bottom: Int = height,
        val preview: Boolean = true
    )

    private class Work(
        val generation: Long,
        val document: NativePagedDocument,
        val key: RenderKey,
        val previewWidth: Int,
        val cancelled: AtomicBoolean = AtomicBoolean(false)
    )

    private data class Anchor(val page: Int, val fraction: Float, val horizontal: Float)
    private data class DetailViewport(val zoom: Float, val x: Float, val y: Float, val width: Int, val height: Int, val layout: Long)

    private val cacheLimit: Int = run {
        val memoryClass = (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).memoryClass
        min(48, max(12, memoryClass / 6)) * 1024 * 1024
    }
    private val cache = BitmapCache()
    private val selection = NativeReaderSelection(this, ::selectionPageBounds, { y -> pageAt((panY + y) / zoomFactor) }, { pageCount }, ::loadSelectionText, ::scrollSelection, ::revealSelection,
        { onTextSelectionChanged?.invoke(it) }, { onTextSelectionPositionChanged?.invoke() }, { onTextSelectionFeedback?.invoke(it) })
    var textSelectionColor: Int
        get() = selection.color
        set(value) { selection.color = value; invalidate() }

    fun getTextSelection(): ReaderTextSelection? = selection.current
    fun hasTextSelection(): Boolean = selection.active
    fun isTextSelectionReady(): Boolean = selection.ready
    fun clearTextSelection() { selectionTextRequest.incrementAndGet(); pendingSelectionLoad = null; selection.clear() }
    fun selectAllText() = selection.selectAll()
    fun extendTextSelection() = selection.extendToNextPage()
    fun extendTextSelectionThrough(page: Int, seed: ReaderTextSelection? = selection.current) = selection.extendThroughPage(page, seed)
    fun copySelectedText() = selection.copy()
    fun getTextSelectionBounds(out: Rect) = selection.contentRect(out)

    fun beginTextSelection(page: Int = currentPageIndex, empty: (() -> Unit)? = null) {
        if (closed || document == null || page !in 0 until pageCount) return
        clearTextSelection()
        val box = selectionPageBounds(page)
        val x = (width / 2f).coerceIn(box.left, max(box.left, box.right))
        val y = (height * .4f).coerceIn(max(0f, box.top), max(max(0f, box.top), min(height.toFloat(), box.bottom)))
        selection.begin(page, x, y, empty = empty)
    }

    fun selectQuote(page: Int, quote: String, textOffset: Int = -1) {
        if (closed || document == null || page !in 0 until pageCount) return
        clearTextSelection()
        val box = selectionPageBounds(page)
        if (box.bottom < 0 || box.top > height) goToPage(page)
        selection.quote(page, quote, textOffset)
    }

    fun selectPassage(location: org.json.JSONObject, quote: String) {
        val revision = location.optString("sourceRevision")
        if (revision.isNotBlank() && revision != passageSourceRevision) {
            onTextSelectionFeedback?.invoke("The source file was replaced. This passage is still kept in Notes."); return
        }
        val page = location.optInt("page", 1) - 1
        val endPage = location.optInt("endPage", page + 1) - 1
        if (closed || document == null || page !in 0 until pageCount || endPage !in page until pageCount) return
        if (endPage == page) { selectQuote(page, quote, location.optInt("textOffset", -1)); return }
        clearTextSelection(); goToPage(page)
        selection.restoreRange(page, location.optInt("textOffset", 0), endPage, location.optInt("endTextOffset", 0))
    }

    /** An LRU whose visible fallback and displayed frame cannot evict each other. */
    private inner class BitmapCache {
        private val images = java.util.LinkedHashMap<RenderKey, Bitmap>(32, .75f, true)
        private var bytes = 0L

        fun get(key: RenderKey): Bitmap? = images[key]

        fun put(key: RenderKey, bitmap: Bitmap) {
            val previous = images.put(key, bitmap)
            bytes += bitmap.allocationByteCount.toLong() - (previous?.allocationByteCount ?: 0)
            peakBitmapBytes = max(peakBitmapBytes, bytes)
            trimToSize(cacheLimit)
        }

        fun trimToSize(limit: Int) {
            val protected = protectedKeys()
            val iterator = images.entries.iterator()
            while (bytes > limit && iterator.hasNext()) {
                val entry = iterator.next()
                if (entry.key in protected) continue
                bytes -= entry.value.allocationByteCount
                iterator.remove()
                forget(entry.key)
            }
        }

        fun evictAll() {
            images.clear()
            bytes = 0L
            previewKeys.clear()
            displayedTiles.clear()
            pendingTiles.clear()
            detailViewport = null
        }

        private fun forget(key: RenderKey) {
            if (key.preview && previewKeys[key.page] == key) previewKeys.remove(key.page)
            // Do not recycle a displayed bitmap: hardware Canvas can retain it
            // after onDraw returns. Android frees it once that frame expires.
        }
    }

    private val refresh = Runnable {
        frameQueued = false
        if (!closed && document != null && width > 0 && height > 0) {
            updateCurrentPage()
            requested = buildRequests()
            cache.trimToSize(cacheLimit)
            cancelObsoleteWork()
            updateLoading()
            pump()
        }
    }
    private val settle = Runnable { requestRefresh() }

    private val gestureDetector = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(event: MotionEvent): Boolean {
            scroller.abortAnimation()
            parent?.requestDisallowInterceptTouchEvent(true)
            return true
        }

        override fun onScroll(first: MotionEvent?, current: MotionEvent, dx: Float, dy: Float): Boolean {
            if (!scaling && !multiTouchSequence) {
                panX += dx
                panY += dy
                clampPosition()
                moved()
            }
            return true
        }

        override fun onFling(first: MotionEvent?, current: MotionEvent, vx: Float, vy: Float): Boolean {
            if (scaling || multiTouchSequence || pageCount == 0) return false
            scroller.fling(
                panX.roundToInt(), panY.roundToInt(), (-vx).roundToInt(), (-vy).roundToInt(),
                0, maxPanX().roundToInt(), 0, maxPanY().roundToInt()
            )
            postInvalidateOnAnimation()
            return true
        }

        override fun onDoubleTap(event: MotionEvent): Boolean {
            val fullscreen = onDoubleTap
            if (fullscreen != null) fullscreen() else setZoomAt(if (zoomFactor > 1.3f) 1f else 2.5f, event.x, event.y)
            return true
        }

        override fun onSingleTapConfirmed(event: MotionEvent): Boolean {
            performClick()
            if (selection.active) { clearTextSelection(); return true }
            if (event.x >= width * .15f && event.x <= width * .85f) onSingleTap?.invoke()
            return true
        }

        override fun onLongPress(event: MotionEvent) {
            if (pageCount > 0 && !scaling && !multiTouchSequence) {
                val page = pageAt((panY + event.y) / zoomFactor)
                if (selectionPageBounds(page).contains(event.x, event.y)) {
                    clearTextSelection(); selection.begin(page, event.x, event.y, held = true)
                }
            }
        }
    })

    private val scaleDetector = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScaleBegin(detector: ScaleGestureDetector): Boolean {
            scaling = true
            lastScaleFocusX = detector.focusX
            lastScaleFocusY = detector.focusY
            scroller.abortAnimation()
            activeWork?.takeUnless { it.key.preview }?.let { cancel(it) }
            return true
        }

        override fun onScale(detector: ScaleGestureDetector): Boolean {
            val next = (zoomFactor * detector.scaleFactor).coerceIn(1f, 8f)
            val ratio = next / zoomFactor
            panX = (panX + lastScaleFocusX) * ratio - detector.focusX
            panY = (panY + lastScaleFocusY) * ratio - detector.focusY
            zoomFactor = next
            onZoomChange?.invoke(zoomFactor)
            lastScaleFocusX = detector.focusX
            lastScaleFocusY = detector.focusY
            clampPosition()
            moved()
            return true
        }

        override fun onScaleEnd(detector: ScaleGestureDetector) {
            scaling = false
            lastMotion = SystemClock.uptimeMillis()
            ui.removeCallbacks(settle)
            ui.postDelayed(settle, DETAIL_SETTLE_MS)
        }
    })

    init {
        setBackgroundColor(Color.rgb(226, 231, 237))
        isFocusable = true
        isClickable = true
        isLongClickable = true
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    }

    /** The view owns [document] and destroys it when replaced or closed. Pages are zero-based. */
    fun attachDocument(document: NativePagedDocument, initialPage: Int = 0, initialZoom: Float = 1f) {
        check(Looper.myLooper() == Looper.getMainLooper()) { "Attach the document on the UI thread" }
        check(!closed) { "Reader is closed" }
        selection.reset()
        pendingSelectionLoad = null
        selectionTextRequest.incrementAndGet()
        val previous = this.document
        activeWork?.let { cancel(it) }
        generation++
        this.document = document
        indexPending = true; savedOverlays.clear()
        metricsStarted = SystemClock.uptimeMillis(); firstPaintMs = null; peakBitmapBytes = 0; activeFrameIntervals.clear(); lastActiveFrame = 0
        if (previous != null && previous !== document) worker.execute { previous.destroy() }
        cache.evictAll()
        previewKeys.clear()
        displayedTiles.clear()
        pendingTiles.clear()
        detailViewport = null
        pageErrors.clear()
        failedTiles.clear()
        requested = emptyList()
        pageCount = document.pageCount
        pageWidths = FloatArray(pageCount)
        pageHeights = FloatArray(pageCount)
        pageTops = FloatArray(pageCount)
        knownSize = BooleanArray(pageCount)
        estimatedRatio = 1.4142135f
        haveReferenceSize = false
        zoomFactor = validZoom(initialZoom)
        detailLevel = zoomLevel(zoomFactor)
        onZoomChange?.invoke(zoomFactor)
        currentPageIndex = initialPage.coerceIn(0, max(0, pageCount - 1))
        lastReportedPage = -1
        lastLoading = null
        rebuildLayout()
        panX = maxPanX() / 2f
        panY = pageTops.getOrElse(currentPageIndex) { 0f } * zoomFactor
        clampPosition()
        requestRefresh()
        invalidate()
    }

    fun getCurrentPage(): Int = currentPageIndex
    fun getZoom(): Float = zoomFactor

    /** Offset into the current page, from 0 to 1, suitable for a saved reading position. */
    fun getPageOffset(): Float {
        if (pageCount == 0) return 0f
        return ((panY / zoomFactor - pageTops[currentPageIndex]) / pageHeight(currentPageIndex)).coerceIn(0f, 1f)
    }

    fun restorePosition(page: Int, fraction: Float = 0f, zoom: Float = 1f) {
        if (pageCount == 0) return
        clearTextSelection()
        scroller.abortAnimation()
        currentPageIndex = page.coerceIn(0, pageCount - 1)
        zoomFactor = validZoom(zoom)
        onZoomChange?.invoke(zoomFactor)
        panX = maxPanX() / 2f
        val offset = if (fraction.isFinite()) fraction.coerceIn(0f, 1f) else 0f
        panY = (pageTops[currentPageIndex] + pageHeight(currentPageIndex) * offset) * zoomFactor
        clampPosition()
        moved()
    }

    fun goToPage(pageIndex: Int) {
        if (pageCount == 0) return
        clearTextSelection()
        scroller.abortAnimation()
        currentPageIndex = pageIndex.coerceIn(0, pageCount - 1)
        panY = pageTops[currentPageIndex] * zoomFactor
        clampPosition()
        moved()
    }

    fun setZoom(factor: Float) = setZoomAt(factor, width / 2f, height / 2f)
    fun zoomBy(factor: Float) = setZoom(zoomFactor * factor)

    fun retryCurrentPage() {
        pageErrors.remove(currentPageIndex)
        failedTiles.removeAll { it.page == currentPageIndex }
        requestRefresh()
        invalidate()
    }

    /** Release speculative images/native display lists when Android reports pressure. */
    fun trimMemory() {
        if (closed) return
        selection.trim(); savedOverlays.clear()
        reduceWorkUntil = SystemClock.uptimeMillis() + 10_000L
        displayedTiles.clear()
        pendingTiles.clear()
        detailViewport = null
        requested = emptyList()
        cache.trimToSize(cacheLimit / 3)
        val doc = document ?: return
        worker.execute { if (!closed) doc.trimMemory() }
        requestRefresh()
    }

    /** Cancels native work and queues destruction behind the active native call. */
    fun close(onClosed: () -> Unit = {}) {
        if (closed) return
        selection.reset()
        pendingSelectionLoad = null
        selectionTextRequest.incrementAndGet()
        closed = true
        generation++
        scroller.abortAnimation()
        ui.removeCallbacks(refresh)
        ui.removeCallbacks(settle)
        ui.removeCallbacks(auxiliary)
        savedOverlays.clear()
        activeWork?.let { cancel(it) }
        val previous = document
        document = null
        requested = emptyList()
        cache.evictAll()
        worker.execute { try { previous?.destroy() } finally { onClosed() } }
        worker.shutdown()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        val anchor = captureAnchor()
        super.onSizeChanged(w, h, oldw, oldh)
        rebuildLayout()
        applyAnchor(anchor)
        requestRefresh()
        selection.viewportChanged()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val now = SystemClock.uptimeMillis()
        if (scaling || !scroller.isFinished || now - lastMotion < 350) {
            if (lastActiveFrame > 0 && activeFrameIntervals.size < 2000) activeFrameIntervals.add(now - lastActiveFrame)
            lastActiveFrame = now
        } else lastActiveFrame = 0
        if (pageCount == 0) {
            canvas.drawText("Open a document to read", width / 2f, height / 2f, labelPaint)
            return
        }
        canvas.save()
        canvas.translate(-panX, -panY)
        canvas.scale(zoomFactor, zoomFactor)
        val first = pageAt(panY / zoomFactor)
        val bottom = (panY + height) / zoomFactor
        var page = first
        while (page < pageCount && pageTops[page] <= bottom) {
            pageRect.set(gutter, pageTops[page], gutter + basePageWidth, pageTops[page] + pageHeight(page))
            canvas.drawRect(pageRect, paperPaint)
            val preview = previewKeys[page]?.let { cache.get(it) }
            if (preview != null && firstPaintMs == null) firstPaintMs = now - metricsStarted
            if (preview != null && !preview.isRecycled) canvas.drawBitmap(preview, null, pageRect, bitmapPaint)
            displayedTiles[page]?.forEach { key ->
                val bitmap = cache.get(key) ?: return@forEach
                drawRect.set(
                    pageRect.left + key.left.toFloat() / key.width * pageRect.width(),
                    pageRect.top + key.top.toFloat() / key.height * pageRect.height(),
                    pageRect.left + key.right.toFloat() / key.width * pageRect.width(),
                    pageRect.top + key.bottom.toFloat() / key.height * pageRect.height()
                )
                if (!bitmap.isRecycled && !canvas.quickReject(drawRect, Canvas.EdgeType.AA)) {
                    canvas.drawBitmap(bitmap, null, drawRect, bitmapPaint)
                }
            }
            if (preview == null) drawPageStatus(canvas, page, pageRect)
            if (preview != null) savedOverlays[page]?.forEach { overlay ->
                highlightPaint.color = (overlay.color and 0x00ffffff) or 0x55000000
                for (rect in overlay.rectangles) canvas.drawRect(pageRect.left + rect.left * pageRect.width(), pageRect.top + rect.top * pageRect.height(), pageRect.left + rect.right * pageRect.width(), pageRect.top + rect.bottom * pageRect.height(), highlightPaint)
            }
            canvas.drawRect(pageRect, borderPaint)
            page++
        }
        canvas.restore()
        selection.draw(canvas)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (closed || pageCount == 0) return super.onTouchEvent(event)
        if (selection.onTouch(event)) {
            val cancel = MotionEvent.obtain(event).apply { action = MotionEvent.ACTION_CANCEL }
            gestureDetector.onTouchEvent(cancel); cancel.recycle()
            return true
        }
        if (event.actionMasked == MotionEvent.ACTION_DOWN) multiTouchSequence = false
        if (event.pointerCount > 1) multiTouchSequence = true
        scaleDetector.onTouchEvent(event)
        gestureDetector.onTouchEvent(event)
        if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
            multiTouchSequence = false
            parent?.requestDisallowInterceptTouchEvent(false)
            ui.removeCallbacks(settle)
            ui.postDelayed(settle, DETAIL_SETTLE_MS)
        }
        return true
    }

    override fun performClick(): Boolean {
        super.performClick()
        if (pageErrors.containsKey(currentPageIndex)) retryCurrentPage()
        return true
    }

    override fun performLongClick(): Boolean {
        if (document == null || pageCount == 0) return super.performLongClick()
        beginTextSelection(); return true
    }

    override fun computeScroll() {
        if (scroller.computeScrollOffset()) {
            panX = scroller.currX.toFloat()
            panY = scroller.currY.toFloat()
            clampPosition()
            moved()
            postInvalidateOnAnimation()
            if (scroller.isFinished) ui.postDelayed(settle, DETAIL_SETTLE_MS)
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (selection.current != null) {
            if (keyCode == KeyEvent.KEYCODE_ESCAPE) { selection.clear(); return true }
            if (event.isCtrlPressed && keyCode == KeyEvent.KEYCODE_C) { selection.copy(); return true }
            if (event.isCtrlPressed && keyCode == KeyEvent.KEYCODE_A) { selection.selectAll(); return true }
        }
        when (keyCode) {
            KeyEvent.KEYCODE_PAGE_DOWN, KeyEvent.KEYCODE_SPACE -> { panY += height * .85f; clampPosition(); moved(); return true }
            KeyEvent.KEYCODE_PAGE_UP -> { panY -= height * .85f; clampPosition(); moved(); return true }
            KeyEvent.KEYCODE_DPAD_DOWN -> { panY += 64f * density; clampPosition(); moved(); return true }
            KeyEvent.KEYCODE_DPAD_UP -> { panY -= 64f * density; clampPosition(); moved(); return true }
            KeyEvent.KEYCODE_MOVE_HOME -> { goToPage(0); return true }
            KeyEvent.KEYCODE_MOVE_END -> { goToPage(pageCount - 1); return true }
        }
        return super.onKeyDown(keyCode, event)
    }

    private fun drawPageStatus(canvas: Canvas, page: Int, rect: RectF) {
        canvas.save()
        canvas.clipRect(rect)
        val x = ((panX + width / 2f) / zoomFactor).coerceIn(rect.left + rect.width() * .15f, rect.right - rect.width() * .15f)
        val y = ((panY + height / 2f) / zoomFactor).coerceIn(rect.top + 30f / zoomFactor, max(rect.top + 30f / zoomFactor, rect.bottom - 30f / zoomFactor))
        labelPaint.textSize = 14f * resources.displayMetrics.scaledDensity / zoomFactor
        val failed = pageErrors.containsKey(page)
        canvas.drawText(if (failed) "Page ${page + 1} could not load" else "Loading page ${page + 1}…", x, y, labelPaint)
        if (failed) canvas.drawText("Tap to retry", x, y + 24f * density / zoomFactor, labelPaint)
        canvas.restore()
    }

    private fun setZoomAt(factor: Float, focusX: Float, focusY: Float) {
        if (!factor.isFinite() || !focusX.isFinite() || !focusY.isFinite()) return
        val next = validZoom(factor)
        if (abs(next - zoomFactor) < .0001f) return
        val ratio = next / zoomFactor
        panX = (panX + focusX) * ratio - focusX
        panY = (panY + focusY) * ratio - focusY
        zoomFactor = next
        onZoomChange?.invoke(zoomFactor)
        clampPosition()
        moved()
        ui.removeCallbacks(settle)
        ui.postDelayed(settle, DETAIL_SETTLE_MS)
    }

    private fun moved() {
        lastMotion = SystemClock.uptimeMillis()
        updateCurrentPage()
        requestRefresh()
        invalidate()
        selection.viewportChanged()
    }

    private fun selectionPageBounds(page: Int): RectF {
        if (page !in 0 until pageCount) return RectF()
        return RectF(gutter * zoomFactor - panX, pageTops[page] * zoomFactor - panY,
            (gutter + basePageWidth) * zoomFactor - panX, (pageTops[page] + pageHeight(page)) * zoomFactor - panY)
    }

    private fun loadSelectionText(page: Int, ready: (Result<ReaderPageText>) -> Unit) {
        val doc = document ?: return
        // First paint stays ahead of geometry extraction when opening a saved
        // passage or selecting immediately after a page jump.
        val box = selectionPageBounds(page)
        if (box.bottom >= 0 && box.top <= height && previewKeys[page]?.let { cache.get(it) } == null && !pageErrors.containsKey(page)) {
            pendingSelectionLoad = page to ready; requestRefresh(); return
        }
        val expected = generation
        val request = selectionTextRequest.get()
        scroller.abortAnimation()
        activeWork?.takeUnless { it.key.preview }?.let { cancel(it) }
        worker.execute {
            if (request != selectionTextRequest.get()) return@execute
            var size: PointF? = null
            val result = runCatching { size = doc.getPageSize(page); doc.pageText(page) }
            ui.post {
                if (closed || document !== doc || generation != expected || request != selectionTextRequest.get()) return@post
                size?.let { receiveSize(page, it) }
                ready(result); requestRefresh(); invalidate()
            }
        }
    }

    private fun scrollSelection(page: Int, dy: Float) {
        panY = (panY + dy).coerceIn(0f, maxPanY())
        clampPosition(); moved()
    }

    private fun revealSelection(page: Int, bounds: RectF) {
        val box = selectionPageBounds(page)
        val left = box.left + bounds.left * box.width(); val right = box.left + bounds.right * box.width()
        val top = box.top + bounds.top * box.height(); val bottom = box.top + bounds.bottom * box.height()
        if (top < 24f * density || bottom > height - 48f * density) panY += top - height * .3f
        if (left < 16f * density || right > width - 16f * density) panX += left - width * .2f
        clampPosition(); moved()
    }

    private fun requestRefresh() {
        if (closed || frameQueued) return
        frameQueued = true
        postOnAnimation(refresh)
    }

    private fun rebuildLayout() {
        layoutRevision++
        layoutWidth = max(1f, width.toFloat())
        basePageWidth = max(1f, width.toFloat() - gutter * 2f)
        var top = gap
        for (page in 0 until pageCount) {
            pageTops[page] = top
            top += pageHeight(page) + gap
        }
        documentHeight = top
        clampPosition()
    }

    private fun pageHeight(page: Int): Float {
        val ratio = if (knownSize[page] && pageWidths[page] > 0f) pageHeights[page] / pageWidths[page] else estimatedRatio
        return max(1f, basePageWidth * ratio)
    }

    private fun captureAnchor(): Anchor {
        if (pageCount == 0) return Anchor(0, 0f, .5f)
        val y = panY / zoomFactor
        val page = pageAt(y)
        return Anchor(page, (y - pageTops[page]) / pageHeight(page), (panX + layoutWidth / 2f) / (layoutWidth * zoomFactor))
    }

    private fun applyAnchor(anchor: Anchor) {
        if (pageCount == 0) return
        val page = anchor.page.coerceIn(0, pageCount - 1)
        panY = (pageTops[page] + anchor.fraction * pageHeight(page)) * zoomFactor
        panX = anchor.horizontal * width * zoomFactor - width / 2f
        clampPosition()
    }

    private fun receiveSize(page: Int, size: PointF) {
        if (size.x <= 0f || size.y <= 0f || !size.x.isFinite() || !size.y.isFinite()) return
        if (knownSize[page] && abs(pageWidths[page] - size.x) < .01f && abs(pageHeights[page] - size.y) < .01f) return
        val anchor = captureAnchor()
        pageWidths[page] = size.x
        pageHeights[page] = size.y
        knownSize[page] = true
        if (!haveReferenceSize) {
            estimatedRatio = size.y / size.x
            haveReferenceSize = true
        }
        rebuildLayout()
        applyAnchor(anchor)
    }

    private fun pageAt(y: Float): Int {
        if (pageCount == 0) return 0
        var low = 0
        var high = pageCount - 1
        while (low < high) {
            val middle = (low + high + 1) ushr 1
            if (pageTops[middle] <= y) low = middle else high = middle - 1
        }
        return low
    }

    private fun updateCurrentPage() {
        if (pageCount == 0) return
        currentPageIndex = if (maxPanY() > 0f && panY >= maxPanY() - density) pageCount - 1
        else pageAt((panY + min(height * .35f, 180f * density)) / zoomFactor)
        if (currentPageIndex != lastReportedPage) {
            lastReportedPage = currentPageIndex
            contentDescription = "${document?.format?.uppercase() ?: "Reader"} document, page ${currentPageIndex + 1} of $pageCount"
            onPageChange?.invoke(currentPageIndex, pageCount)
        }
    }

    private fun maxPanX(): Float = max(0f, width * zoomFactor - width)
    private fun maxPanY(): Float = max(0f, documentHeight * zoomFactor - height)
    private fun clampPosition() {
        panX = panX.coerceIn(0f, maxPanX())
        panY = panY.coerceIn(0f, maxPanY())
    }

    private fun previewKey(page: Int): RenderKey {
        val ratio = if (knownSize[page]) pageHeights[page] / pageWidths[page] else estimatedRatio
        return previewKeyFor(page, min(1024, max(1, basePageWidth.roundToInt())), ratio)
    }

    private fun previewKeyFor(page: Int, width: Int, ratio: Float): RenderKey {
        var targetWidth = width
        var targetHeight = max(1, (targetWidth * ratio).roundToInt())
        // Very tall engineering sheets must also obey the bitmap allocation limit.
        val shrink = min(1f, min(4096f / max(targetWidth, targetHeight), kotlin.math.sqrt(maxPreviewPixels() / (targetWidth.toFloat() * targetHeight))))
        targetWidth = max(1, (targetWidth * shrink).roundToInt())
        targetHeight = max(1, (targetHeight * shrink).roundToInt())
        return RenderKey(page, targetWidth, targetHeight)
    }

    private fun buildRequests(): List<RenderKey> {
        if (pageCount == 0) return emptyList()
        val jobs = LinkedHashSet<RenderKey>()
        val top = panY / zoomFactor
        val bottom = (panY + height) / zoomFactor
        val visible = (pageAt(top)..pageAt(bottom)).toList().sortedBy { abs(pageTops[it] + pageHeight(it) / 2f - (top + bottom) / 2f) }
        var layersChanged = displayedTiles.keys.retainAll(visible.toSet())
        for (page in visible) {
            val previous = displayedTiles[page] ?: continue
            val preview = previewKeys[page]?.takeIf { cache.get(it) != null }
            val previewCoversZoom = preview != null && preview.width >= basePageWidth * zoomFactor &&
                preview.height >= pageHeight(page) * zoomFactor
            val retainedTiles = if (previewCoversZoom) emptyList() else previous.filter { tileIntersectsViewport(it) && cache.get(it) != null }
            if (retainedTiles.size != previous.size) {
                if (retainedTiles.isEmpty()) displayedTiles.remove(page) else displayedTiles[page] = retainedTiles
                layersChanged = true
            }
        }

        // Account for pixels that are already on screen as well as their
        // replacement. Otherwise replacement tiles evict the preview or the
        // previous resolution before the new layer has finished rendering.
        val retained = LinkedHashSet<RenderKey>()
        for (page in visible) {
            previewKeys[page]?.let { if (cache.get(it) != null) retained.add(it) }
            displayedTiles[page]?.let(retained::addAll)
        }
        var bytes = retained.sumOf(::allocationBytes)
        val budget = cacheLimit * 90L / 100L
        val visiblePreviews = visible.filterNot { pageErrors.containsKey(it) }.map(::previewKey)
        val missingPreviewBytes = visiblePreviews.filterNot { it in retained }.sumOf(::allocationBytes)
        // New visible paper takes precedence over retained zoom detail. Release
        // the detail furthest from the viewport centre first; its complete-page
        // preview stays pinned, so freeing room never blanks an already read page.
        for (page in visible.asReversed()) {
            if (bytes + missingPreviewBytes <= budget) break
            val previous = displayedTiles.remove(page) ?: continue
            for (key in previous) if (retained.remove(key)) bytes -= allocationBytes(key)
            layersChanged = true
        }
        if (layersChanged) {
            pendingTiles.clear()
            detailViewport = null
        }
        fun addJob(key: RenderKey): Boolean {
            if (failedTiles.contains(key)) return false
            val extra = if (key in retained) 0L else allocationBytes(key)
            if (bytes + extra > budget) return false
            jobs.add(key)
            if (retained.add(key)) bytes += extra
            return true
        }

        // First paint at normal reading resolution before spending work on zoom detail.
        visiblePreviews.forEach { addJob(it) }
        val now = SystemClock.uptimeMillis()
        val settled = !scaling && scroller.isFinished && now - lastMotion >= DETAIL_SETTLE_MS && now >= reduceWorkUntil
        if (settled) {
            updateDetailLevel()
            val viewport = DetailViewport(zoomFactor, panX, panY, width, height, layoutRevision)
            val reusePlan = detailViewport == viewport
            if (!reusePlan) {
                pendingTiles.clear()
                detailViewport = viewport
            }
            // At most two detail layers coexist (displayed and pending). Their
            // separate allowance leaves room for complete-page fallback pixels
            // on low-memory phones, even at the maximum zoom.
            var detailBytes = 0L
            val detailBudget = cacheLimit * 30L / 100L
            for (page in visible) {
                if (!knownSize[page] || !previewKeys.containsKey(page) || pageErrors.containsKey(page)) continue
                if (reusePlan) {
                    pendingTiles[page]?.let { tiles ->
                        tiles.forEach { addJob(it) }
                        if (tiles.all { cache.get(it) != null }) displayedTiles[page] = tiles
                    }
                    continue
                }
                var level = detailLevel
                var tiles = visibleTiles(page, level)
                var attempts = 0
                while (tiles.isNotEmpty() && attempts++ < 16) {
                    val layerBytes = tiles.sumOf(::allocationBytes)
                    val extra = tiles.filterNot { it in retained }.sumOf(::allocationBytes)
                    if (detailBytes + layerBytes <= detailBudget && bytes + extra <= budget && tiles.none { it in failedTiles }) break
                    // Raster resolution is capped by the visible working set,
                    // not by the full dimensions of a magnified scanned page.
                    level *= .8f
                    tiles = visibleTiles(page, level)
                }
                if (tiles.isEmpty()) continue
                val layerBytes = tiles.sumOf(::allocationBytes)
                val extra = tiles.filterNot { it in retained }.sumOf(::allocationBytes)
                if (detailBytes + layerBytes > detailBudget || bytes + extra > budget || tiles.any { it in failedTiles }) continue
                detailBytes += layerBytes
                pendingTiles[page] = tiles
                tiles.forEach { addJob(it) }
                if (tiles.all { cache.get(it) != null }) {
                    // A single UI-thread assignment publishes a coherent layer;
                    // partial raster results never flash over the old layer.
                    displayedTiles[page] = tiles
                }
            }
        } else {
            pendingTiles.clear()
            detailViewport = null
        }
        val near = linkedSetOf(currentPageIndex + 1, currentPageIndex - 1, pageAt(bottom) + 1, pageAt(top) - 1)
        if (now >= reduceWorkUntil && !scaling) {
            for (page in near) if (page in 0 until pageCount && !pageErrors.containsKey(page)) addJob(previewKey(page))
        }
        return jobs.toList()
    }

    private fun visibleTiles(page: Int, level: Float): List<RenderKey> {
        val targetWidth = max(1, (basePageWidth * level).roundToInt())
        val targetHeight = max(1, (targetWidth * pageHeights[page] / pageWidths[page]).roundToInt())
        val preview = previewKeys[page]
        if (preview != null && preview.width >= basePageWidth * zoomFactor && preview.height >= pageHeight(page) * zoomFactor) return emptyList()
        if (preview != null && preview.width >= targetWidth && preview.height >= targetHeight) return emptyList()
        val left = max(0f, panX / zoomFactor - gutter) / basePageWidth * targetWidth
        val right = min(basePageWidth, (panX + width) / zoomFactor - gutter) / basePageWidth * targetWidth
        val top = max(0f, panY / zoomFactor - pageTops[page]) / pageHeight(page) * targetHeight
        val bottom = min(pageHeight(page), (panY + height) / zoomFactor - pageTops[page]) / pageHeight(page) * targetHeight
        if (right <= left || bottom <= top) return emptyList()
        val tileSize = 512
        val tiles = ArrayList<RenderKey>()
        for (row in floor(top / tileSize).toInt() until ceil(bottom / tileSize).toInt()) {
            for (column in floor(left / tileSize).toInt() until ceil(right / tileSize).toInt()) {
                tiles.add(RenderKey(page, targetWidth, targetHeight, column * tileSize, row * tileSize, min((column + 1) * tileSize, targetWidth), min((row + 1) * tileSize, targetHeight), false))
            }
        }
        return tiles.sortedBy { key -> abs((key.left + key.right) / 2f - (left + right) / 2f) + abs((key.top + key.bottom) / 2f - (top + bottom) / 2f) }
    }

    private fun zoomLevel(zoom: Float): Float = DETAIL_LEVELS.firstOrNull { it >= zoom } ?: 8f

    private fun updateDetailLevel() {
        // A little hysteresis prevents two nearby pinch endpoints from asking
        // for different raster grids repeatedly around a bucket boundary.
        if (zoomFactor > detailLevel * 1.08f) detailLevel = zoomLevel(zoomFactor)
        else {
            val lower = DETAIL_LEVELS.lastOrNull { it < detailLevel } ?: 1f
            if (zoomFactor < lower * .9f) detailLevel = zoomLevel(zoomFactor)
        }
    }

    private fun allocationBytes(key: RenderKey): Long =
        (key.right - key.left).toLong() * (key.bottom - key.top) * 4L

    private fun tileIntersectsViewport(key: RenderKey): Boolean {
        val left = gutter + key.left.toFloat() / key.width * basePageWidth
        val right = gutter + key.right.toFloat() / key.width * basePageWidth
        val top = pageTops[key.page] + key.top.toFloat() / key.height * pageHeight(key.page)
        val bottom = pageTops[key.page] + key.bottom.toFloat() / key.height * pageHeight(key.page)
        return right > panX / zoomFactor && left < (panX + width) / zoomFactor &&
            bottom > panY / zoomFactor && top < (panY + height) / zoomFactor
    }

    private fun protectedKeys(): Set<RenderKey> {
        if (closed || pageCount == 0) return emptySet()
        val first = pageAt(panY / zoomFactor)
        val last = pageAt((panY + height) / zoomFactor)
        return LinkedHashSet<RenderKey>().apply {
            for (page in first..last) {
                previewKeys[page]?.let(::add)
                displayedTiles[page]?.let(::addAll)
            }
            addAll(requested)
        }
    }

    private fun cancelObsoleteWork() {
        val work = activeWork ?: return
        val firstVisible = pageAt(panY / zoomFactor)
        val lastVisible = pageAt((panY + height) / zoomFactor)
        val needsVisiblePreview = (firstVisible..lastVisible).any { page ->
            previewKeys[page]?.let { cache.get(it) } == null && !pageErrors.containsKey(page)
        }
        // New visible paper takes priority over speculative neighbour work and
        // detail refinements, even when the old page is still close by.
        val blocksFirstPaint = needsVisiblePreview && (!work.key.preview || work.key.page !in firstVisible..lastVisible)
        if (work.generation != generation || (!work.key.preview && (scaling || !requested.contains(work.key))) ||
            (work.key.preview && abs(work.key.page - currentPageIndex) > 3 && !requested.contains(work.key)) || blocksFirstPaint) cancel(work)
    }

    private fun cancel(work: Work) {
        if (work.cancelled.compareAndSet(false, true)) work.document.cancelRender()
    }

    private fun pump() {
        if (closed || activeWork != null) return
        val doc = document ?: return
        val key = requested.firstOrNull { cache.get(it) == null }
        if (key == null) {
            ui.removeCallbacks(auxiliary)
            if (backgroundWorkEnabled && (indexPending || savedPassages.isNotEmpty())) ui.postDelayed(auxiliary, 600)
            return
        }
        val work = Work(generation, doc, key, min(1024, max(1, basePageWidth.roundToInt())))
        activeWork = work
        worker.execute {
            var bitmap: Bitmap? = null
            var size: PointF? = null
            var actualKey = key
            var failure: Throwable? = null
            try {
                if (!work.cancelled.get()) {
                    size = doc.getPageSize(key.page)
                    if (key.preview) {
                        actualKey = previewKeyFor(key.page, work.previewWidth, size!!.y / size!!.x)
                    }
                    if (!work.cancelled.get()) {
                        val patch = if (actualKey.preview) null else Rect(actualKey.left, actualKey.top, actualKey.right, actualKey.bottom)
                        bitmap = doc.render(actualKey.page, actualKey.width, actualKey.height, patch)
                    }
                }
            } catch (error: Throwable) {
                failure = error
            }
            val output = bitmap
            val outputSize = size
            val outputKey = actualKey
            val error = failure
            ui.post {
                if (activeWork === work) activeWork = null
                if (closed || work.generation != generation || work.cancelled.get()) {
                    output?.takeUnless { it.isRecycled }?.recycle()
                } else {
                    outputSize?.let { receiveSize(key.page, it) }
                    if (output != null) {
                        // First decoding can replace an estimated aspect ratio,
                        // so the actual preview key can differ from its request.
                        // Keep that result for visible mixed-size/short pages.
                        if (abs(key.page - currentPageIndex) <= 3 || requested.contains(key) || requested.contains(outputKey)) {
                            if (outputKey.preview) previewKeys[outputKey.page] = outputKey
                            cache.put(outputKey, output)
                            pageErrors.remove(key.page)
                        } else output.recycle()
                    } else if (error != null) {
                        // A failed detail tile must not hide a readable preview.
                        if (key.preview) pageErrors[key.page] = error.message ?: "Unable to render page"
                        else failedTiles.add(key)
                        if (key.preview && key.page == currentPageIndex) onError?.invoke("Page ${key.page + 1}: ${error.message ?: "Unable to render"}")
                    }
                    invalidate()
                }
                if (!closed) {
                    pendingSelectionLoad?.let { (page, ready) ->
                        if (previewKeys[page]?.let { cache.get(it) } != null || pageErrors.containsKey(page)) {
                            pendingSelectionLoad = null; loadSelectionText(page, ready)
                        }
                    }
                    requested = buildRequests()
                    cache.trimToSize(cacheLimit)
                    updateLoading()
                    pump()
                }
            }
        }
    }

    private fun updateLoading() {
        val loading = pageCount > 0 && previewKeys[currentPageIndex]?.let { cache.get(it) } == null && !pageErrors.containsKey(currentPageIndex)
        if (lastLoading != loading) {
            lastLoading = loading
            onLoadingChanged?.invoke(loading)
        }
    }

    private fun maxPreviewPixels(): Float = min(1_500_000f, cacheLimit / 24f)
    private fun validZoom(value: Float): Float = if (value.isFinite()) value.coerceIn(1f, 8f) else 1f

    private companion object {
        const val DETAIL_SETTLE_MS = 180L
        val DETAIL_LEVELS = floatArrayOf(1f, 1.5f, 2f, 3f, 4f, 6f, 8f)
    }
}
