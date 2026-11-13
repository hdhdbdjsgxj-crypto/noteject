package com.noteject.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Durable hand-off of Reader changes to the workspace, including process recreation. */
internal object NativeReaderEvents {
    private val lock = Any()
    private fun preferences(context: Context) = context.getSharedPreferences("noteject_native_reader_state", Context.MODE_PRIVATE)

    fun enqueue(context: Context, event: JSONObject) = synchronized(lock) {
        val prefs = preferences(context)
        val previous = prefs.getString("events", "[]") ?: "[]"
        val before = runCatching { JSONArray(previous) }.getOrElse { JSONArray() }
        val events = JSONArray()
        for (index in 0 until before.length()) {
            val item = before.optJSONObject(index) ?: continue
            if (event.optString("type") in listOf("progress", "indexReady") && item.optString("type") == event.optString("type") &&
                item.optString("documentId") == event.optString("documentId")) continue
            events.put(item)
        }
        event.put("eventId", UUID.randomUUID().toString()).put("updated", System.currentTimeMillis())
        events.put(event)
        if (!prefs.edit().putString("events", events.toString()).commit()) {
            // SharedPreferences updates memory even when its disk commit fails.
            // Restore the previous queue so a failed save is not drained later.
            prefs.edit().putString("events", previous).commit()
            error("Could not save Reader changes on this device. Keep this draft open and try again.")
        }
    }

    fun pending(context: Context): String = synchronized(lock) { preferences(context).getString("events", "[]") ?: "[]" }

    fun acknowledge(context: Context, idsJson: String) = synchronized(lock) {
        require(idsJson.length <= 200_000) { "Invalid Reader acknowledgement." }
        val ids = JSONArray(idsJson)
        val accepted = (0 until ids.length()).map { ids.optString(it) }.toSet()
        val prefs = preferences(context)
        val before = runCatching { JSONArray(prefs.getString("events", "[]")) }.getOrElse { JSONArray() }
        val after = JSONArray()
        for (index in 0 until before.length()) {
            val event = before.optJSONObject(index) ?: continue
            if (event.optString("eventId") !in accepted) after.put(event)
        }
        check(prefs.edit().putString("events", after.toString()).commit()) { "Reader acknowledgement could not be saved." }
        for (index in 0 until before.length()) {
            val event = before.optJSONObject(index) ?: continue
            if (event.optString("eventId") in accepted && event.optString("type") == "capture") {
                NativeReaderCaptures.remove(context, event.optString("captureId"))
            }
        }
    }

    fun progress(context: Context, documentId: String): JSONObject? = synchronized(lock) {
        runCatching { JSONObject(preferences(context).getString("position:$documentId", null) ?: return@synchronized null) }.getOrNull()
    }

    fun saveProgress(context: Context, event: JSONObject, publish: Boolean = false) = synchronized(lock) {
        val stored = JSONObject(event.toString()).put("updated", System.currentTimeMillis())
        preferences(context).edit().putString("position:${event.getString("documentId")}", stored.toString()).apply()
        if (publish) enqueue(context, stored)
    }
}
