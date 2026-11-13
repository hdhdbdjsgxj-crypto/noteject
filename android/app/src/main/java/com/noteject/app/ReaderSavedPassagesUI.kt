package com.noteject.app

import android.app.Activity
import android.app.AlertDialog
import android.text.Editable
import android.text.TextWatcher
import android.view.ContextThemeWrapper
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject

/** The same saved-items interface is used above native pages and WebView book text. */
internal class ReaderSavedPassagesUI(
    private val activity: Activity,
    private val theme: NativeReaderTheme,
    private val onAction: (String, Boolean, JSONObject) -> Boolean
) {
    private val context = ContextThemeWrapper(activity, if(theme.dark) android.R.style.Theme_Material_Dialog_Alert else android.R.style.Theme_Material_Light_Dialog_Alert)
    private val dialogs = LinkedHashSet<AlertDialog>()
    private var finished = false
    private data class Item(val bookmark: Boolean, val value: JSONObject)
    fun dismiss() { if(!finished) onAction("close",false,JSONObject()); finished=true; dialogs.toList().forEach { it.dismiss() }; dialogs.clear() }
    private fun complete(action: String, item: Item): Boolean {
        if(finished) return true
        if(!onAction(action,item.bookmark,item.value)) return false
        finished=true; dialogs.toList().forEach { it.dismiss() }; dialogs.clear(); return true
    }
    private fun show(dialog: AlertDialog, destructive: Int? = null): AlertDialog {
        dialogs.add(dialog); dialog.setOnDismissListener { dialogs.remove(dialog) }
        dialog.setOnCancelListener { dismiss() }; dialog.show()
        dialog.window?.setBackgroundDrawable(theme.surface(activity,theme.panel,20,true))
        for(id in listOf(-1,-2,-3)) dialog.getButton(id)?.let { button ->
            button.setTextColor(if(id==destructive) theme.destructiveInk else theme.accent)
            if(id==destructive) button.background=theme.destructiveTouch(activity)
        }
        return dialog
    }
    private fun location(value: JSONObject): String {
        value.optString("locationLabel").takeIf { it.isNotBlank() }?.let { return it }
        val where=value.optJSONObject("location") ?: JSONObject()
        val page=where.optInt("page",value.optInt("page"))
        if(page>0) return if(where.optInt("endPage",page)>page) ReaderLanguage.formatted("Pages {start}–{end}", mapOf("start" to page.toString(), "end" to where.optInt("endPage").toString())) else ReaderLanguage.formatted("Page {page}", mapOf("page" to page.toString()))
        return where.optString("chapter").ifBlank { if(where.has("chapterIndex")) ReaderLanguage.formatted("Chapter {chapter}", mapOf("chapter" to (where.optInt("chapterIndex")+1).toString())) else ReaderLanguage.text("Reading position") }
    }
    fun open(bookmarks: JSONArray, passages: JSONArray) {
        val items=ArrayList<Item>()
        for(index in 0 until bookmarks.length()) bookmarks.optJSONObject(index)?.let { items.add(Item(true,it)) }
        for(index in 0 until passages.length()) passages.optJSONObject(index)?.let { items.add(Item(false,it)) }
        if(items.isEmpty()) {
            val dialog=AlertDialog.Builder(context).setTitle(ReaderLanguage.text("Notes & Passages")).setMessage(ReaderLanguage.text("No saved items yet. Select text and choose Save passage, or bookmark your reading position.")).setPositiveButton(ReaderLanguage.text("Close")) { _,_->dismiss() }.create()
            show(dialog); return
        }
        val density=activity.resources.displayMetrics.density
        val search=EditText(context).apply { hint=ReaderLanguage.text("Find passages or bookmarks"); setSingleLine(); setTextColor(theme.ink); setHintTextColor(theme.muted); contentDescription=ReaderLanguage.text("Find saved Reader items") }
        val form=LinearLayout(context).apply { orientation=LinearLayout.VERTICAL;setPadding((20*density).toInt(),0,(20*density).toInt(),0);addView(search) }
        val visible=ArrayList(items); val labels=ArrayList<String>()
        fun label(item: Item)=(if(item.bookmark) "★ " else "✎ ")+item.value.optString("title").ifBlank { ReaderLanguage.text(if(item.bookmark) "Bookmark" else "Passage") }+"\n"+location(item.value)
        labels.addAll(visible.map(::label)); val adapter=ArrayAdapter(context,android.R.layout.simple_list_item_1,labels)
        val dialog=AlertDialog.Builder(context).setTitle(ReaderLanguage.text("Notes & Passages")).setView(form).setAdapter(adapter) { _, index->visible.getOrNull(index)?.let(::details) }.setNegativeButton(ReaderLanguage.text("Close")) { _,_->dismiss() }.create()
        search.addTextChangedListener(object: TextWatcher {
            override fun beforeTextChanged(s: CharSequence?,start:Int,count:Int,after:Int) {}
            override fun onTextChanged(s:CharSequence?,start:Int,before:Int,count:Int) {
                val query=s.toString().trim();visible.clear();visible.addAll(items.filter { query.isEmpty() || listOf(it.value.optString("title"),it.value.optString("quote"),it.value.optString("comment"),location(it.value)).any { value->value.contains(query,true) } });labels.clear();labels.addAll(visible.map(::label));adapter.notifyDataSetChanged()
            }
            override fun afterTextChanged(s:Editable?) {}
        }); show(dialog)
        dialog.window?.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
    }
    private fun details(item: Item) {
        val value=item.value
        val body=if(item.bookmark) location(value) else listOf(value.optString("quote",value.optString("selectionQuote")),value.optString("comment",value.optString("selectionComment"))).filter { it.isNotBlank() }.joinToString("\n\n")
        val dialog=AlertDialog.Builder(context).setTitle(value.optString("title").ifBlank { ReaderLanguage.text(if(item.bookmark) "Bookmark" else "Passage") })
            .setMessage(location(value)+"\n\n"+body.take(16000)+(if(body.length>16000) "\n\n"+ReaderLanguage.text("Open in Notes to read the full passage.") else ""))
            .setPositiveButton(ReaderLanguage.text("Read"),null).setNegativeButton(ReaderLanguage.text(if(item.bookmark) "Close" else "Edit in Notes"),null)
            .setNeutralButton(ReaderLanguage.text("Delete"),null).create()
        show(dialog,AlertDialog.BUTTON_NEUTRAL)
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener { complete("read",item) }
        dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setOnClickListener { if(item.bookmark) dismiss() else complete("edit",item) }
        dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener {
            val confirm=AlertDialog.Builder(context).setTitle(ReaderLanguage.text(if(item.bookmark) "Delete bookmark?" else "Move passage to Trash?"))
                .setMessage(ReaderLanguage.text(if(item.bookmark) "This saved reading position will be removed." else "The passage can be restored from Trash. The original document stays in your library."))
                .setPositiveButton(ReaderLanguage.text("Delete"),null).setNegativeButton(ReaderLanguage.text("Cancel"),null).create()
            show(confirm,AlertDialog.BUTTON_POSITIVE)
            confirm.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener { if(!complete("delete",item)) Toast.makeText(activity,ReaderLanguage.text("Could not save this change. Try again."),Toast.LENGTH_LONG).show() }
        }
    }
}
