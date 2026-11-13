package com.noteject.app

import android.app.Activity
import android.app.AlertDialog
import android.content.res.ColorStateList
import android.text.InputType
import android.view.ContextThemeWrapper
import android.widget.*
import org.json.JSONArray
import org.json.JSONObject

/** One passage form for every Reader engine. Storage remains owned by its document. */
internal class ReaderPassageComposerUI(private val activity: Activity, private val theme: NativeReaderTheme) {
    private val context=ContextThemeWrapper(activity,if(theme.dark)android.R.style.Theme_Material_Dialog_Alert else android.R.style.Theme_Material_Light_Dialog_Alert)
    private fun dp(n:Int)=(n*activity.resources.displayMetrics.density+.5f).toInt()
    fun open(options:JSONObject,onSave:(JSONObject)->Boolean,onCancel:()->Unit,onDraft:(JSONObject)->Unit = {}):AlertDialog {
        val quote=options.optString("quote");val colors=listOf("violet","blue","teal","amber","rose","gray")
        val form=LinearLayout(context).apply { orientation=LinearLayout.VERTICAL;setPadding(dp(20),dp(8),dp(20),dp(12)) }
        fun label(text:String)=TextView(context).apply { this.text=text;setTextColor(theme.muted);textSize=12f;setPadding(0,dp(10),0,dp(4));form.addView(this) }
        fun field(name:String,value:String,multiline:Boolean=false):EditText {
            val localizedName=ReaderLanguage.text(name)
            label(localizedName)
            return EditText(context).apply { setText(value);setTextColor(theme.ink);setHintTextColor(theme.muted);contentDescription=localizedName;minimumHeight=dp(48);isSingleLine=!multiline;if(multiline){minLines=2;maxLines=6;inputType=InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE};form.addView(this) }
        }
        label(ReaderLanguage.text(options.optString("sourceLabel","Save a source-linked Note")))
        val automatic=quote.replace(Regex("\\s+")," ").trim().let { if(it.length>76)it.take(76)+"…" else it }.ifBlank { ReaderLanguage.text("Reader comment") }
        val title=field("Title",options.optString("title").ifBlank { automatic }).apply { filters=arrayOf(android.text.InputFilter.LengthFilter(160)) }
        if(quote.isNotBlank())form.addView(TextView(context).apply { text=quote.take(2000);setTextColor(theme.muted);textSize=14f;maxLines=6;setPadding(dp(12),dp(12),dp(12),dp(12));background=theme.surface(activity,theme.raised,12,true) })
        val comment=field(if(quote.isBlank())"Comment" else "Your thoughts",options.optString("comment"),true)
        val tags=field("Tags, separated by commas",options.optString("tags"))
        val folders=mutableListOf<String>();val names=options.optJSONArray("folders") ?: JSONArray()
        for(i in 0 until names.length())names.optString(i).takeIf { it.isNotBlank() && it !in folders }?.let(folders::add)
        val selectedFolder=options.optString("folder").ifBlank { "Inbox" };if(selectedFolder !in folders)folders.add(selectedFolder)
        fun picker(name:String,values:List<String>,selected:Int):Spinner {
            val localizedName=ReaderLanguage.text(name)
            label(localizedName);return Spinner(context).apply { contentDescription=localizedName;minimumHeight=dp(48);adapter=ArrayAdapter(context,android.R.layout.simple_spinner_dropdown_item,values);if(values.isNotEmpty())setSelection(selected.coerceIn(values.indices));form.addView(this) }
        }
        val folder=picker(ReaderLanguage.text("Save in Notes folder"),folders,folders.indexOf(selectedFolder))
        val color=picker(ReaderLanguage.text("Passage color"),colors.map { ReaderLanguage.text(it.replaceFirstChar(Char::uppercase)) },colors.indexOf(options.optString("color","violet")))
        val boards=mutableListOf<JSONObject>();val values=options.optJSONArray("boards") ?: JSONArray()
        for(i in 0 until values.length())values.optJSONObject(i)?.let(boards::add)
        val add=CheckBox(context).apply { text=ReaderLanguage.text("Also add passages to a Board");setTextColor(theme.ink);buttonTintList=ColorStateList.valueOf(theme.accent);minimumHeight=dp(48);isEnabled=boards.isNotEmpty();isChecked=isEnabled && options.optBoolean("addToBoard");form.addView(this) }
        val board=picker("Board",boards.map { it.optString("name","Board") },boards.indexOfFirst { it.optString("id")==options.optString("boardId") }).apply { isEnabled=add.isChecked }
        add.setOnCheckedChangeListener { _,checked->board.isEnabled=checked }
        label(ReaderLanguage.text("Saved in Notes with a link to its source. Open Notes & Passages, then Edit in Notes, to keep writing."))
        options.optString("error").takeIf { it.isNotBlank() }?.let { label(it).setTextColor(theme.destructiveInk) }
        val scroll=ScrollView(context).apply { addView(form) }
        val dialog=AlertDialog.Builder(context).setTitle(ReaderLanguage.text(if(options.optBoolean("editing"))"Edit passage" else if(quote.isBlank())"Add reader comment" else "Save passage"))
            .setView(scroll).setPositiveButton(ReaderLanguage.text("Save"),null).setNegativeButton(ReaderLanguage.text("Cancel")) { _,_->onCancel() }.create()
        dialog.setOnCancelListener { onCancel() };dialog.show();dialog.window?.setBackgroundDrawable(theme.surface(activity,theme.panel,20,true))
        dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setTextColor(theme.accent)
        fun snapshot()=JSONObject().put("title",title.text.toString()).put("quote",quote).put("comment",comment.text.toString()).put("tags",tags.text.toString())
            .put("folder",folders[folder.selectedItemPosition]).put("color",colors[color.selectedItemPosition]).put("addToBoard",add.isChecked)
            .put("boardId",if(add.isChecked)boards.getOrNull(board.selectedItemPosition)?.optString("id") ?: "" else "")
        val watcher=object:android.text.TextWatcher {
            override fun beforeTextChanged(s:CharSequence?,start:Int,count:Int,after:Int){}
            override fun onTextChanged(s:CharSequence?,start:Int,before:Int,count:Int){onDraft(snapshot())}
            override fun afterTextChanged(s:android.text.Editable?){}
        }
        for(field in listOf(title,comment,tags))field.addTextChangedListener(watcher)
        val pickerListener=object:android.widget.AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent:android.widget.AdapterView<*>?,view:android.view.View?,position:Int,id:Long){onDraft(snapshot())}
            override fun onNothingSelected(parent:android.widget.AdapterView<*>?){}
        }
        for(picker in listOf(folder,color,board))picker.onItemSelectedListener=pickerListener
        add.setOnCheckedChangeListener { _,checked->board.isEnabled=checked;onDraft(snapshot()) }
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).apply { setTextColor(theme.accent);setOnClickListener {
            if(quote.isBlank() && comment.text.isBlank()){comment.error=ReaderLanguage.text("Add a passage or comment first");return@setOnClickListener}
            if(onSave(snapshot()))dialog.dismiss()
        } }
        dialog.window?.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
        return dialog
    }
}
