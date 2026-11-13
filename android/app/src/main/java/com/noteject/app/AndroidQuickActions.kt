package com.noteject.app

import android.content.Context
import android.content.Intent
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Keeps launcher requests until the loaded workspace explicitly acknowledges them. */
class AndroidQuickActions(context: Context, private val dispatch: (JSONObject) -> Unit) {
    private val prefs = context.getSharedPreferences("noteject_launcher_actions", Context.MODE_PRIVATE)
    private val lock = Any()
    private val pending = mutableListOf<JSONObject>()
    private var ready = false
    private var deliveredId: String? = null

    init {
        runCatching {
            val values = JSONArray(prefs.getString("pending", "[]"))
            for (index in 0 until minOf(values.length(), 16)) {
                val item = values.optJSONObject(index) ?: continue
                if (item.optString("action") !in setOf("new-note", "new-recording")) continue
                if (!item.optString("id").matches(Regex("^[a-zA-Z0-9-]{1,64}$"))) continue
                pending.add(item)
            }
        }
    }

    fun accept(intent: Intent?): Boolean {
        val action = when (intent?.action) {
            NEW_NOTE -> "new-note"
            NEW_RECORDING -> "new-recording"
            else -> return false
        }
        synchronized(lock) {
            if (pending.size >= 16) return false
            pending.add(JSONObject().put("id", UUID.randomUUID().toString()).put("action", action))
            persist()
        }
        deliver()
        return true
    }

    fun pending(): String = synchronized(lock) { pending.firstOrNull()?.toString().orEmpty() }

    fun setReady(value: Boolean) {
        synchronized(lock) {
            ready = value
            if (!value) deliveredId = null
        }
        if (value) deliver()
    }

    fun acknowledge(id: String): Boolean {
        synchronized(lock) {
            if (pending.firstOrNull()?.optString("id") != id) return false
            pending.removeAt(0)
            deliveredId = null
            persist()
        }
        deliver()
        return true
    }

    private fun persist() {
        prefs.edit().putString("pending", JSONArray(pending).toString()).commit()
    }

    private fun deliver() {
        val next = synchronized(lock) {
            if (!ready) return
            val item = pending.firstOrNull() ?: return
            val id = item.optString("id")
            if (deliveredId == id) return
            deliveredId = id
            JSONObject(item.toString())
        }
        dispatch(next)
    }

    companion object {
        const val NEW_NOTE = "com.noteject.app.action.NEW_NOTE"
        const val NEW_RECORDING = "com.noteject.app.action.NEW_RECORDING"
    }
}
