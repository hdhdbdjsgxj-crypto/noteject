package com.noteject.app

import org.json.JSONObject
import java.util.Locale

/** Localized labels delivered by the shared workspace language setting. */
internal object ReaderLanguage {
    @Volatile private var translations: Map<String, String> = emptyMap()
    private data class Template(val pattern: Regex, val names: List<String>, val value: String)
    @Volatile private var templates: List<Template> = emptyList()
    @Volatile var language: String = "en"
        private set

    fun update(language: String, serialized: String) {
        if (serialized.length > 1_000_000) return
        val code = language.trim().lowercase(Locale.ROOT).replace('_', '-').substringBefore('-')
        if (code !in setOf("en", "es", "fr", "de", "it", "pt", "ru", "uk", "zh", "ja", "ko", "ar", "hi", "tr")) return
        val json = runCatching { JSONObject(serialized) }.getOrNull() ?: return
        val next = LinkedHashMap<String, String>()
        val keys = json.keys()
        while (keys.hasNext() && next.size < 8_000) {
            val key = keys.next()
            val value = json.optString(key)
            if (key.length <= 2_000 && value.isNotBlank() && value.length <= 2_000) next[key] = value
        }
        translations = next
        this.language = code
        val placeholder = Regex("\\{(\\w+)\\}")
        templates = next.mapNotNull { (key, value) ->
            val matches = placeholder.findAll(key).toList()
            if (matches.isEmpty() || key.replace(placeholder, "").length < 5) null else {
                var cursor = 0
                val pattern = StringBuilder("^")
                matches.forEach { match -> pattern.append(Regex.escape(key.substring(cursor, match.range.first))).append("(.+?)"); cursor = match.range.last + 1 }
                pattern.append(Regex.escape(key.substring(cursor))).append("$")
                Template(Regex(pattern.toString(), RegexOption.DOT_MATCHES_ALL), matches.map { it.groupValues[1] }, value)
            }
        }
    }

    fun text(source: String): String {
        translations[source]?.let { return it }
        for (template in templates) {
            val match = template.pattern.matchEntire(source) ?: continue
            if (template.names.withIndex().any { (index, name) ->
                val value = match.groupValues[index + 1]
                when (name) {
                    "count", "selected", "total", "start", "end", "relationships" -> !value.matches(Regex("[\\d\\s,._]+"))
                    "color" -> value.lowercase(Locale.ROOT) !in setOf("violet", "blue", "teal", "amber", "rose", "gray")
                    else -> false
                }
            }) continue
            return Regex("\\{(\\w+)\\}").replace(template.value) { token ->
                val index = template.names.indexOf(token.groupValues[1])
                if (index < 0) token.value else {
                    val value = match.groupValues[index + 1]
                    if (token.groupValues[1] == "color") translations[value] ?: value else value
                }
            }
        }
        return source
    }

    fun formatted(source: String, values: Map<String, String>): String {
        var result = text(source)
        values.forEach { (key, value) -> result = result.replace("{$key}", value) }
        return result
    }
}
