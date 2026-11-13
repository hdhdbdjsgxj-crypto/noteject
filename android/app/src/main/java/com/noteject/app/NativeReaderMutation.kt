package com.noteject.app

/** A Reader edit becomes visible only after its handoff is durably queued. */
internal object NativeReaderMutation {
    fun commit(persist: () -> Unit, apply: () -> Unit, failed: (Exception) -> Unit): Boolean {
        try { persist() } catch (error: Exception) { failed(error); return false }
        apply()
        return true
    }
}
