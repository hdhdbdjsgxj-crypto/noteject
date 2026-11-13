package com.noteject.app

import java.text.Normalizer
import java.util.Locale

/** Keep source UTF-16 offsets while matching line breaks, soft hyphens and ligatures. */
internal object ReaderTextSearch {
    data class Index(val text: String, val starts: IntArray, val ends: IntArray)
    private val lineHyphen = Regex("^[ \\t]*\\r?\\n\\s*\\p{L}")
    private val lineGap = Regex("^[ \\t]*\\r?\\n\\s*")
    fun index(source: String): Index {
        val text = StringBuilder(); val starts = ArrayList<Int>(); val ends = ArrayList<Int>()
        var at = 0
        while (at < source.length) {
            val start = at; val point = source.codePointAt(at); at += Character.charCount(point)
            if (point == 0x00ad) continue
            if ((point == 45 || point == 0x2010) && start > 0 && source[start - 1].isLetter()) {
                val tail = source.substring(at, minOf(source.length, at + 80))
                if (lineHyphen.containsMatchIn(tail)) { at += lineGap.find(tail)!!.value.length; continue }
            }
            val normalized = Normalizer.normalize(String(Character.toChars(point)), Normalizer.Form.NFKC).lowercase(Locale.ROOT)
            for (char in normalized) {
                val value = if (char.isWhitespace() || char == '\u00a0') ' ' else char
                if (value == ' ' && text.lastOrNull() == ' ') { ends[ends.lastIndex] = at; continue }
                text.append(value); starts.add(start); ends.add(at)
            }
        }
        return Index(text.toString(), starts.toIntArray(), ends.toIntArray())
    }
    fun find(index: Index, query: String, limit: Int = 1000): List<IntRange> {
        val needle = ReaderTextSearch.index(query).text.trim(); if (needle.isEmpty() || limit <= 0) return emptyList()
        val result = ArrayList<IntRange>(); var at = index.text.indexOf(needle)
        while (at >= 0 && result.size < limit) {
            result.add(index.starts[at] until index.ends[at + needle.length - 1])
            at = index.text.indexOf(needle, at + needle.length)
        }
        return result
    }
    fun nearest(index: Index, query: String, preferred: Int): IntRange? {
        val needle = ReaderTextSearch.index(query).text.trim(); if (needle.isEmpty()) return null
        var at = index.text.indexOf(needle); var best: IntRange? = null; var distance = Long.MAX_VALUE
        while (at >= 0) {
            val start = index.starts[at]; val delta = if(preferred < 0) 0L else kotlin.math.abs(start.toLong() - preferred)
            if(delta < distance) { distance = delta; best = start until index.ends[at + needle.length - 1] }
            if(delta == 0L) break
            at = index.text.indexOf(needle, at + needle.length)
        }
        return best
    }
}
