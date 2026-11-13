package com.noteject.app

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PointF
import android.graphics.Rect
import android.graphics.RectF
import android.view.MotionEvent
import android.view.View
import kotlin.math.max
import kotlin.math.min

/** Document ranges own text geometry; highlights remain in normalized page coordinates. */
internal class NativeReaderSelection(
    private val host: View,
    private val pageBounds: (Int) -> RectF,
    private val pageAt: (Float) -> Int,
    private val pageCount: () -> Int,
    private val load: (Int, (Result<ReaderPageText>) -> Unit) -> Unit,
    private val scroll: (Int, Float) -> Unit,
    private val reveal: (Int, RectF) -> Unit,
    private val changed: (ReaderTextSelection?) -> Unit,
    private val positioned: () -> Unit,
    private val feedback: (String) -> Unit
) {
    private data class Position(val page: Int, val offset: Int) : Comparable<Position> {
        override fun compareTo(other: Position) = if (page == other.page) offset.compareTo(other.offset) else page.compareTo(other.page)
    }
    private data class Hit(val page: Int, val x: Float, val y: Float)
    private val density = host.resources.displayMetrics.density
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val cache = LinkedHashMap<Int, ReaderPageText>(4, .75f, true)
    private val building = LinkedHashMap<Int, ReaderPageText>()
    private var request = 0
    private var loading = false
    private var drag = 0
    private var touchSelecting = false
    private var touchDown = false
    private var fingerX = 0f
    private var fingerY = 0f
    private var offsetX = 0f
    private var offsetY = 0f
    private var dragAnchor: Position? = null
    private var pendingHit: Hit? = null
    private var pendingRange: Pair<Position, Position>? = null
    private var revealEnd = false
    private var highlights = emptyMap<Int, List<RectF>>()
    var current: ReaderTextSelection? = null
        private set
    val active get() = current != null || loading
    val ready get() = current != null && !loading && pendingHit == null && pendingRange == null
    var color: Int = Color.rgb(158, 138, 255)

    private val autoScroll = object : Runnable {
        override fun run() {
            val selected = current ?: return
            if (drag == 0 || !touchDown) return
            val edge = min(56f * density, host.height / 4f)
            val dy = when {
                fingerY < edge -> -((edge - fingerY) / edge).coerceIn(0f, 1f) * 12f * density
                fingerY > host.height - edge -> ((fingerY - host.height + edge) / edge).coerceIn(0f, 1f) * 12f * density
                else -> 0f
            }
            if (dy != 0f) { scroll(selected.page, dy); updateDrag(); host.postOnAnimation(this) }
        }
    }
    fun reset() { clear(); cache.clear() }
    fun trim() { cache.clear() }
    fun clear() {
        request++; loading = false; touchSelecting = false; touchDown = false; drag = 0
        dragAnchor = null; pendingHit = null; pendingRange = null; revealEnd = false; building.clear()
        host.removeCallbacks(autoScroll); host.parent?.requestDisallowInterceptTouchEvent(false)
        val had = current != null; current = null; highlights = emptyMap(); host.invalidate()
        if (had) changed(null)
    }
    private fun layout(page: Int) = current?.parts?.firstOrNull { it.page == page }?.layout ?: building[page] ?: cache[page]
    private fun weight(text: ReaderPageText) = text.text.length * 2L + text.spans.size * 96L
    private fun requestPage(page: Int, ready: (ReaderPageText) -> Unit) {
        layout(page)?.let { ready(it); return }
        val token = ++request; loading = true
        load(page) { result ->
            if (token != request) return@load
            loading = false
            result.onSuccess { text ->
                cache[page] = text
                while (cache.size > 1 && (cache.size > 3 || cache.values.sumOf { weight(it) } > 8L * 1024 * 1024)) cache.remove(cache.keys.first())
                ready(text)
            }.onFailure {
                pendingHit = null; pendingRange = null; building.clear(); touchSelecting = false; drag = 0
                host.removeCallbacks(autoScroll)
                if (it !is java.util.concurrent.CancellationException) feedback(it.message ?: "Text selection could not load. Try again.")
            }
        }
    }
    fun begin(page: Int, x: Float, y: Float, held: Boolean = false, empty: (() -> Unit)? = null) {
        clear(); fingerX = x; fingerY = y; offsetX = 0f; offsetY = 0f; touchSelecting = held; touchDown = held
        val initial = pageBounds(page)
        if (initial.width() <= 0 || initial.height() <= 0) return
        val point = PointF(((x - initial.left) / initial.width()).coerceIn(0f, 1f), ((y - initial.top) / initial.height()).coerceIn(0f, 1f))
        requestPage(page) { text ->
            if (text.spans.isEmpty()) {
                touchSelecting = false; feedback("This page has no selectable text layer. You can still add a note."); empty?.invoke(); return@requestPage
            }
            val box = pageBounds(page)
            val span = text.nearest(point.x, point.y, box.height() / box.width()) ?: return@requestPage
            if (held) {
                val dx = max(max(span.bounds.left - point.x, 0f), point.x - span.bounds.right) * box.width()
                val dy = max(max(span.bounds.top - point.y, 0f), point.y - span.bounds.bottom) * box.height()
                if (dx * dx + dy * dy > 32f * density * 32f * density) { touchSelecting = false; feedback("Hold a word to select it."); return@requestPage }
            }
            val word = text.word(span)
            if (word.isEmpty()) { touchSelecting = false; feedback("This text could not be selected. Try another word."); return@requestPage }
            activate(listOf(ReaderSelectionPart(page, text, word.first, word.last + 1)))
            if (held && touchDown) { drag = 2; dragAnchor = Position(page, word.first); touchSelecting = true; updateDrag() }
        }
    }
    fun quote(page: Int, quote: String, textOffset: Int = -1) {
        clear()
        requestPage(page) { text ->
            val match = text.find(quote, textOffset)
            if (match == null) { feedback("That passage was not found in this page's text layer."); return@requestPage }
            activate(listOf(ReaderSelectionPart(page, text, match.first, match.last + 1)))
            text.spans.firstOrNull { it.end > match.first && it.start <= match.last }?.let { reveal(page, it.bounds) }
        }
    }
    fun restoreRange(firstPage: Int, start: Int, lastPage: Int, end: Int) {
        clear(); pendingRange = Position(firstPage, start) to Position(lastPage, end); drain()
    }
    fun extendThroughPage(page: Int, seed: ReaderTextSelection? = current) {
        val selected = seed ?: return
        if (loading || page !in selected.endPage until pageCount()) return
        if(current == null) activate(selected.parts)
        if (page - selected.page >= 128) { feedback("Select up to 128 pages at a time."); return }
        requestPage(page) { text ->
            pendingRange = Position(selected.page, selected.start) to Position(page, text.text.length)
            revealEnd = true; drain()
        }
    }
    fun selectAll() {
        val selected = current ?: return
        pendingRange = Position(selected.page, 0) to Position(selected.endPage, selected.parts.last().layout.text.length); drain()
    }
    fun extendToNextPage() {
        val selected = current ?: return
        val next = selected.endPage + 1
        if (next >= pageCount()) { feedback("This is the last page."); return }
        if (loading) return
        fun advance(page: Int) {
            if (page - selected.page >= 128) { feedback("Select a shorter passage, up to 128 pages at a time."); return }
            requestPage(page) { text ->
                if (text.spans.isEmpty()) {
                    if (page + 1 < pageCount()) advance(page + 1) else feedback("There is no more selectable text after this page.")
                } else {
                    pendingRange = Position(selected.page, selected.start) to Position(page, text.text.length); revealEnd = true; drain()
                }
            }
        }
        advance(next)
    }
    fun copy() {
        val selected = current ?: return
        runCatching {
            val text = selected.text; require(text.length <= 200_000) { "Select a smaller passage to copy." }
            (host.context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Selected passage", text))
        }.onSuccess { feedback("Passage copied") }.onFailure { feedback(it.message ?: "The passage could not be copied.") }
    }
    private fun activate(parts: List<ReaderSelectionPart>) {
        val nonempty = parts.filter { it.end > it.start }; val first = nonempty.firstOrNull() ?: return
        current = ReaderTextSelection(first.page, first.layout, first.start, first.end, nonempty.drop(1))
        highlights = nonempty.associate { it.page to it.layout.rectangles(it.start, it.end) }
        building.clear(); host.invalidate(); changed(current)
    }
    /** Loads are serialized; moving a handle only replaces the desired endpoint. */
    private fun drain() {
        if (loading) return
        pendingHit?.let { hit ->
            val text = layout(hit.page)
            if (text == null) { requestPage(hit.page) { drain() }; return }
            pendingHit = null
            val box = pageBounds(hit.page)
            val span = text.nearest(hit.x, hit.y, box.height() / max(1f, box.width()))
            val word = span?.let { text.word(it) }; val anchor = dragAnchor
            if (word != null && !word.isEmpty() && anchor != null) {
                val before = Position(hit.page, word.first) < anchor
                val endpoint = Position(hit.page, if (before) word.first else word.last + 1)
                pendingRange = if (before) endpoint to anchor else anchor to endpoint
                if (touchDown) drag = if (before) 1 else 2
            }
        }
        val (from, to) = pendingRange ?: return
        if (from > to || from.page !in 0 until pageCount() || to.page !in 0 until pageCount()) { pendingRange = null; building.clear(); return }
        if (to.page - from.page >= 128) { pendingRange = null; building.clear(); feedback("Select a shorter passage, up to 128 pages at a time."); return }
        building.keys.retainAll((from.page..to.page).toSet())
        val parts = ArrayList<ReaderSelectionPart>(); var characters = 0L; var memory = 0L
        for (page in from.page..to.page) {
            val text = layout(page)
            if (text == null) { requestPage(page) { loaded -> building[page] = loaded; drain() }; return }
            val start = if (page == from.page) from.offset.coerceIn(0, text.text.length) else 0
            val end = if (page == to.page) to.offset.coerceIn(start, text.text.length) else text.text.length
            characters += end - start + 2; memory += weight(text)
            if (characters > 200_000 || memory > 24L * 1024 * 1024) {
                pendingRange = null; building.clear(); feedback("This selection is too large. Select a shorter passage."); return
            }
            building[page] = text
            parts.add(ReaderSelectionPart(page, text, start, end))
        }
        pendingRange = null
        val old = current
        if (old == null || old.page != from.page || old.start != from.offset || old.endPage != to.page || old.endOffset != to.offset) activate(parts) else building.clear()
        if (revealEnd) { revealEnd = false; parts.lastOrNull { it.layout.spans.isNotEmpty() }?.let { reveal(it.page, it.layout.spans.last().bounds) } }
        positioned()
    }
    private fun anchors(): Pair<PointF, PointF>? {
        val parts = current?.parts ?: return null
        fun point(part: ReaderSelectionPart, start: Boolean): PointF? {
            val spans = part.layout.spans.filter { it.end > part.start && it.start < part.end }
            val span = (if (start) spans.firstOrNull() else spans.lastOrNull()) ?: return null; val page = pageBounds(part.page)
            return PointF(page.left + (if (start != span.rtl) span.bounds.left else span.bounds.right) * page.width(), page.top + span.bounds.bottom * page.height())
        }
        return (point(parts.first(), true) ?: return null) to (point(parts.last(), false) ?: return null)
    }
    fun draw(canvas: Canvas) {
        if (current == null) return
        paint.color = (color and 0xffffff) or 0x55000000; paint.style = Paint.Style.FILL
        val viewport = RectF(0f, 0f, host.width.toFloat(), host.height.toFloat()); val rect = RectF()
        for ((index, boxes) in highlights) {
            val page = pageBounds(index); if (!RectF.intersects(page, viewport)) continue
            val checkpoint = canvas.save(); canvas.clipRect(page)
            for (box in boxes) { rect.set(page.left + box.left * page.width(), page.top + box.top * page.height(), page.left + box.right * page.width(), page.top + box.bottom * page.height()); canvas.drawRect(rect, paint) }
            canvas.restoreToCount(checkpoint)
        }
        val ends = anchors() ?: return
        for (anchor in listOf(ends.first, ends.second)) {
            if (anchor.y < -24f * density || anchor.y > host.height + 24f * density) continue
            paint.color = color; paint.strokeWidth = 2f * density
            canvas.drawLine(anchor.x, anchor.y, anchor.x, anchor.y + 10f * density, paint); canvas.drawCircle(anchor.x, anchor.y + 10f * density, 9f * density, paint)
        }
    }
    fun contentRect(out: Rect) {
        val visible = RectF(); var found = false
        for ((index, boxes) in highlights) {
            val page = pageBounds(index)
            for (box in boxes) {
                val rect = RectF(page.left + box.left * page.width(), page.top + box.top * page.height(), page.left + box.right * page.width(), page.top + box.bottom * page.height())
                if (!rect.intersect(0f, 0f, host.width.toFloat(), host.height.toFloat())) continue
                if (found) visible.union(rect) else { visible.set(rect); found = true }
            }
        }
        if (found) visible.roundOut(out) else out.set(host.width / 2, host.height / 2, host.width / 2 + 1, host.height / 2 + 1)
    }
    fun viewportChanged() { if (current != null) positioned() }
    fun onTouch(event: MotionEvent): Boolean {
        fingerX = event.x; fingerY = event.y
        if (event.pointerCount > 1) { drag = 0; touchSelecting = false; touchDown = false; host.removeCallbacks(autoScroll); return false }
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            touchDown = true; val selected = current ?: return false; val ends = anchors() ?: return false
            val radius = 28f * density
            fun distance(point: PointF): Float { val dx = event.x - point.x; val dy = event.y - point.y - 10f * density; return dx * dx + dy * dy }
            val startDistance = distance(ends.first); val endDistance = distance(ends.second)
            drag = if (min(startDistance, endDistance) > radius * radius) 0 else if (startDistance <= endDistance) 1 else 2
            if (drag == 0) return false
            dragAnchor = if (drag == 1) Position(selected.endPage, selected.endOffset) else Position(selected.page, selected.start)
            val anchor = if (drag == 1) ends.first else ends.second
            offsetX = event.x - anchor.x; offsetY = event.y - anchor.y + density; host.parent?.requestDisallowInterceptTouchEvent(true); return true
        }
        if (drag == 0 && !touchSelecting) { if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) touchDown = false; return false }
        when (event.actionMasked) {
            MotionEvent.ACTION_MOVE -> { if (drag != 0) updateDrag(); host.removeCallbacks(autoScroll); host.postOnAnimation(autoScroll) }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> { touchDown = false; touchSelecting = false; drag = 0; host.removeCallbacks(autoScroll); host.parent?.requestDisallowInterceptTouchEvent(false); positioned() }
        }
        return true
    }
    private fun updateDrag() {
        if (current == null) return
        val y = fingerY - offsetY; val index = pageAt(y.coerceIn(0f, host.height.toFloat())); val page = pageBounds(index)
        if (page.width() <= 0 || page.height() <= 0) return
        pendingHit = Hit(index, ((fingerX - offsetX - page.left) / page.width()).coerceIn(0f, 1f), ((y - page.top) / page.height()).coerceIn(0f, 1f)); drain()
    }
}

