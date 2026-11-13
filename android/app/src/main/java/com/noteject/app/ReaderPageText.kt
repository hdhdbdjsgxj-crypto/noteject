package com.noteject.app

import android.graphics.RectF
import java.text.BreakIterator
import java.util.Locale
import kotlin.math.max
import kotlin.math.min

/** Text offsets are UTF-16; rectangles use normalized, top-left page coordinates. */
data class ReaderTextSpan(val start: Int, val end: Int, val bounds: RectF, val line: Int, val rtl: Boolean = false)
data class ReaderPageText(val text: String, val spans: List<ReaderTextSpan>) {
    private val wordBoundaries by lazy {
        BreakIterator.getWordInstance(Locale.getDefault()).apply {
            // BreakIterator also has a `text` property. An unqualified reference here
            // selects its initially empty buffer instead of this page's string.
            setText(this@ReaderPageText.text)
        }
    }
    fun nearest(x: Float, y: Float, aspect: Float): ReaderTextSpan? = spans.minByOrNull {
        val dx = max(max(it.bounds.left - x, 0f), x - it.bounds.right)
        val dy = max(max(it.bounds.top - y, 0f), y - it.bounds.bottom)
        dx * dx + dy * dy * aspect * aspect
    }

    fun word(span: ReaderTextSpan): IntRange {
        if (span.start !in text.indices || span.end <= span.start || span.end > text.length) return IntRange.EMPTY
        var from = span.start
        var to = span.end
        // Native text offsets use UTF-16; never split a supplementary character.
        if (from > 0 && Character.isLowSurrogate(text[from]) && Character.isHighSurrogate(text[from - 1])) from--
        if (to < text.length && Character.isLowSurrogate(text[to]) && Character.isHighSurrogate(text[to - 1])) to++
        // OCR word zones already identify complete units. MuPDF supplies glyphs.
        if (to - from > Character.charCount(text.codePointAt(from))) return from until to
        val boundaries = wordBoundaries
        return synchronized(boundaries) {
            val start = boundaries.preceding(from + 1).takeIf { it != BreakIterator.DONE } ?: from
            val end = boundaries.following(from).takeIf { it != BreakIterator.DONE } ?: to
            min(start, from).coerceIn(0, from) until max(end, to).coerceIn(to, text.length)
        }
    }

    fun rectangles(start: Int, end: Int): List<RectF> {
        val result = ArrayList<RectF>()
        var line = Int.MIN_VALUE
        for (span in spans) {
            if (span.end <= start || span.start >= end) continue
            if (line == span.line && result.isNotEmpty()) result.last().union(span.bounds)
            else { result.add(RectF(span.bounds)); line = span.line }
        }
        return result
    }

    fun find(quote: String, preferredOffset: Int = -1): IntRange? {
        if (quote.isBlank()) return null
        if (preferredOffset >= 0 && preferredOffset <= text.length - quote.length && text.regionMatches(preferredOffset, quote, 0, quote.length, true)) return preferredOffset until preferredOffset + quote.length
        return ReaderTextSearch.nearest(ReaderTextSearch.index(text), quote, preferredOffset)
    }

    class Builder {
        private val text = StringBuilder()
        private val spans = ArrayList<ReaderTextSpan>()
        fun separator(value: String) { require(text.length + value.length <= 2_000_000) { "This page has too much text to select at once." }; text.append(value) }
        fun append(value: String, rect: RectF, line: Int, rtl: Boolean = false) {
            require(text.length + value.length <= 2_000_000 && spans.size < 200_000) { "This page has too much text to select at once." }
            val start = text.length; text.append(value)
            if (value.isBlank() || !listOf(rect.left, rect.top, rect.right, rect.bottom).all(Float::isFinite)) return
            val bounds = RectF(rect)
            if (bounds.intersect(0f, 0f, 1f, 1f) && !bounds.isEmpty) spans.add(ReaderTextSpan(start, text.length, bounds, line, rtl))
        }
        fun build() = ReaderPageText(text.toString(), spans.toList())
    }
}

data class ReaderSelectionPart(val page: Int, val layout: ReaderPageText, val start: Int, val end: Int) {
    val text get() = layout.text.substring(start, end)
}

data class ReaderTextSelection(val page: Int, val layout: ReaderPageText, val start: Int, val end: Int,
    val continuation: List<ReaderSelectionPart> = emptyList()) {
    val parts get() = listOf(ReaderSelectionPart(page, layout, start, end)) + continuation
    val text get() = parts.joinToString("\n\n") { it.text }
    val endPage get() = continuation.lastOrNull()?.page ?: page
    val endOffset get() = continuation.lastOrNull()?.end ?: end
    val pageOffset get() = layout.spans.firstOrNull { it.end > start }?.bounds?.top ?: 0f
}
