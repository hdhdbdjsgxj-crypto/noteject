package com.noteject.app

import android.app.Activity
import android.graphics.Rect
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.webkit.WebView
import org.json.JSONTokener
import org.json.JSONObject

/** Keep Chromium's copy/selection handles, adding Reader actions to book text only. */
internal class ReaderSelectionWebView(private val activity: Activity) : WebView(activity) {
    override fun startActionMode(callback: ActionMode.Callback, type: Int): ActionMode? =
        super.startActionMode(readerCallback(callback), type)

    override fun startActionMode(callback: ActionMode.Callback): ActionMode? =
        startActionMode(callback, ActionMode.TYPE_FLOATING)

    private fun readerCallback(delegate: ActionMode.Callback) = object : ActionMode.Callback2() {
        private var alive = true
        private var readerSelection = false
        private var readerCanExtend = false
        private var revision = 0

        private fun readSelection(mode: ActionMode, action: ((String) -> Unit)? = null) {
            val token = if (action == null) ++revision else revision
            evaluateJavascript(SELECTION) { encoded ->
                if (!alive || (action == null && token != revision)) return@evaluateJavascript
                val payload=runCatching { JSONObject(JSONTokener(encoded).nextValue() as? String ?: "{}") }.getOrNull()
                val text=payload?.optString("text").orEmpty();val extend=payload?.optString("kind")=="epub"
                if (action != null) {
                    if (text.isNotBlank()) action(text)
                } else if (readerSelection != text.isNotBlank() || readerCanExtend != extend) {
                    readerSelection = text.isNotBlank();readerCanExtend=extend
                    mode.invalidate()
                }
            }
        }

        override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
            val created = delegate.onCreateActionMode(mode, menu)
            if (created) readSelection(mode)
            return created
        }

        override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean {
            val changed = delegate.onPrepareActionMode(mode, menu)
            if(readerSelection)ReaderTextActions.populate(menu,paged=false,extend=readerCanExtend)
            else if(menu.findItem(ReaderExternalActions.SAVE_PASSAGE)!=null)for(id in listOf(ReaderExternalActions.TRANSLATE,ReaderExternalActions.SAVE_PASSAGE,ReaderExternalActions.SHARE,ReaderTextActions.CLEAR,ReaderTextActions.EXTEND))menu.removeItem(id)
            readSelection(mode)
            return changed || readerSelection
        }

        override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean = when (item.itemId) {
            ReaderExternalActions.TRANSLATE -> { readSelection(mode) { ReaderExternalActions.translate(activity, it) }; true }
            ReaderExternalActions.SHARE -> { readSelection(mode) { ReaderExternalActions.share(activity, it) }; true }
            ReaderExternalActions.SAVE_PASSAGE -> {
                // Capture the range before Chromium clears it on ActionMode destruction.
                readSelection(mode) {
                    evaluateJavascript("window.NotejectReaderSelectionActions?.save()") {
                        if (alive) mode.finish()
                    }
                }
                true
            }
            ReaderTextActions.EXTEND -> { readSelection(mode) {
                evaluateJavascript("window.NotejectReaderSelectionActions?.extend()") { if(alive)mode.finish() }
            };true }
            ReaderTextActions.CLEAR -> { evaluateJavascript("window.NotejectReaderSelectionActions?.clear()",null);mode.finish();true }
            else -> delegate.onActionItemClicked(mode, item)
        }

        override fun onDestroyActionMode(mode: ActionMode) { alive = false; revision++; delegate.onDestroyActionMode(mode) }

        override fun onGetContentRect(mode: ActionMode, view: View, outRect: Rect) {
            if (delegate is ActionMode.Callback2) delegate.onGetContentRect(mode, view, outRect)
            else super.onGetContentRect(mode, view, outRect)
        }
    }

    companion object {
        // Never offer document actions for Notes, form fields, menus, or cross-panel ranges.
        private val SELECTION = """(() => {
            const selection = window.getSelection();
            if (!selection?.rangeCount || selection.isCollapsed) return '';
            const range = selection.getRangeAt(0);
            const element = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
            const content = element?.closest('#epub-text,#txt-content,.pdf-text-layer');
            if (!content?.closest('.reader-shell .reader-content') || !content.contains(range.endContainer)) return '';
            if (element.closest('input,textarea,[contenteditable=true]')) return '';
            return JSON.stringify({text:selection.toString(),kind:content.id==='epub-text'?'epub':'text'});
        })()""".trimIndent()
    }
}
