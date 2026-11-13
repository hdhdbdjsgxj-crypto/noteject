package com.noteject.app

import android.app.AlertDialog
import android.app.Dialog
import android.content.Intent
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.Rect
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.text.InputType
import android.text.Editable
import android.text.TextWatcher
import android.view.ContextThemeWrapper
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.*
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/** Shared native MuPDF/DjVuLibre Reader. Pixels never pass through the workspace WebView. */
class NativeReaderActivity : ComponentActivity() {
    private lateinit var options: JSONObject
    private lateinit var reader: NativeReaderView
    private lateinit var root: LinearLayout
    private lateinit var header: LinearLayout
    private lateinit var footer: LinearLayout
    private lateinit var navigation: LinearLayout
    private lateinit var actionDock: LinearLayout
    private lateinit var landscapeActions: LinearLayout
    private lateinit var identityKicker: TextView
    private lateinit var documentTitle: TextView
    private lateinit var bookmarkButton: ImageButton
    private lateinit var bookmarkControl: LinearLayout
    private lateinit var previousButton: ImageButton
    private lateinit var nextButton: ImageButton
    private lateinit var readingProgress: ProgressBar
    private lateinit var pageLabel: Button
    private lateinit var zoomLabel: Button
    private lateinit var status: TextView
    private lateinit var busy: ProgressBar
    private var document: NativePagedDocument? = null
    private var textIndex: NativeReaderTextIndex? = null
    private val documentFormat get() = if (options.optString("documentType") == "djvu") "djvu" else "pdf"
    private var totalPages = 0
    private var launchFile: File? = null
    private var descriptor: ParcelFileDescriptor? = null
    private var openingFile: File? = null
    @Volatile private var closed = false
    private var finishSent = false
    private var chrome = true
    private var textActionMode: ActionMode? = null
    private var readerSheet: Dialog? = null
    private var savedItemsUI: ReaderSavedPassagesUI? = null
    private var passageComposerUI: AlertDialog? = null
    private var positionWritten = ""
    private val worker = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    private val searchGeneration = AtomicInteger()
    private var lastFindQuery = ""
    private data class FindPage(val source: String, val index: ReaderTextSearch.Index)
    private data class FindHit(val page: Int, val start: Int, val quote: String, val excerpt: String)
    private val findCache = LinkedHashMap<Int, FindPage>()
    private var findCacheChars = 0
    private lateinit var uiTheme: NativeReaderTheme
    private lateinit var dialogContext: ContextThemeWrapper
    private val ink get() = uiTheme.ink
    private val panel get() = uiTheme.panel
    private val documentControls = mutableListOf<View>()
    private val revealBusy = Runnable { if (!closed && ::busy.isInitialized) busy.visibility = View.VISIBLE }
    private val colors = arrayOf("violet", "blue", "teal", "amber", "rose", "gray")
    private val bookmarks = mutableListOf<JSONObject>()
    private val passages = mutableListOf<JSONObject>()
    private val preparedCache by lazy { NativeReaderCache(File(filesDir, "native-reader")) }
    private val savePosition = object : Runnable {
        override fun run() { persistPosition(); if (!closed) handler.postDelayed(this, 2000) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.decorView.layoutDirection = if (ReaderLanguage.language == "ar") View.LAYOUT_DIRECTION_RTL else View.LAYOUT_DIRECTION_LTR
        options = runCatching {
            val rawPath = savedInstanceState?.getString("readerOptionsPath") ?: intent.getStringExtra("optionsPath")
            if (rawPath != null) {
                val file = File(rawPath).canonicalFile
                require(file.parentFile == File(cacheDir, "native-reader-launch").canonicalFile && file.length() <= 8_000_000) { "Invalid Reader launch." }
                launchFile = file; JSONObject(file.readText(Charsets.UTF_8))
            } else JSONObject(intent.getStringExtra("options") ?: "{}")
        }.getOrElse { JSONObject() }
        if (options.optString("documentId").isBlank()) { finish(); return }
        uiTheme = NativeReaderTheme.read(options.optJSONObject("uiTheme"))
        options.optString("localPath").takeIf { it.isNotBlank() }?.let { runCatching { preparedCache.pin(File(it)) } }
        setTheme(if (uiTheme.dark) android.R.style.Theme_Material_NoActionBar else android.R.style.Theme_Material_Light_NoActionBar)
        dialogContext = ContextThemeWrapper(this, if (uiTheme.dark) android.R.style.Theme_Material_Dialog_Alert else android.R.style.Theme_Material_Light_Dialog_Alert)
        readArray(options.optJSONArray("bookmarks"), bookmarks)
        readArray(options.optJSONArray("passages"), passages)
        if (savedInstanceState == null && !options.optBoolean("forceLocation")) {
            NativeReaderEvents.progress(this, options.getString("documentId"))?.let { previous ->
                if (previous.optString("workspaceGeneration", "original") == options.optString("workspaceGeneration", "original") && previous.optString("sourceRevision") == options.optString("sourceRevision") && previous.optLong("updated") > options.optLong("progressUpdatedAt")) {
                    options.put("page", previous.optInt("page", 1)).put("offset", previous.optDouble("offset", 0.0)).put("zoom", previous.optDouble("zoom", 1.0))
                }
            }
        }
        window.statusBarColor = panel; window.navigationBarColor = panel
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !uiTheme.dark
            isAppearanceLightNavigationBars = !uiTheme.dark
        }
        root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(panel) }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom); insets
        }
        header = row().apply { setPadding(dp(4), dp(4), dp(4), dp(4)) }
        header.addView(iconButton("back", ReaderLanguage.text("Return to workspace"), false) { finish() }, LinearLayout.LayoutParams(dp(48), dp(48)))
        val identity = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_VERTICAL; setPadding(dp(6), 0, dp(4), 0) }
        identityKicker = TextView(this).apply {
            text = "NOTEJECT  /  " + ReaderLanguage.text("Reader"); setTextColor(uiTheme.accent); textSize = 9f; letterSpacing = .12f
            setTypeface(null, Typeface.BOLD); maxLines = 1
        }
        documentTitle = TextView(this).apply {
            text = options.optString("name", "Document"); setTextColor(ink); textSize = 15f; setTypeface(null, Typeface.BOLD)
            maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END; contentDescription = text
        }
        identity.addView(identityKicker); identity.addView(documentTitle)
        header.addView(identity, LinearLayout.LayoutParams(0, -1, 1f))
        header.addView(iconButton("find", ReaderLanguage.text("Find in document")) { findDialog() }, LinearLayout.LayoutParams(dp(44), dp(48)))
        bookmarkControl = row().apply {
            setPadding(dp(2), 0, dp(2), 0)
            background = uiTheme.touch(this@NativeReaderActivity)
            isClickable = true; isFocusable = true
            contentDescription = ReaderLanguage.text("Save bookmark")
            tooltipText = contentDescription
            setOnClickListener { toggleBookmark() }
        }
        bookmarkButton = ImageButton(this).apply {
            background = android.graphics.drawable.ColorDrawable(Color.TRANSPARENT)
            setPadding(dp(5), dp(10), dp(5), dp(10))
            setImageDrawable(NativeReaderIcon("bookmark", ink, resources.displayMetrics.density))
            isClickable = false; isFocusable = false
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        bookmarkControl.addView(bookmarkButton, LinearLayout.LayoutParams(dp(44), -1))
        header.addView(bookmarkControl, LinearLayout.LayoutParams(dp(44), dp(48)))
        header.addView(iconButton("menu", ReaderLanguage.text("Reader menu"), false) { showMenu() }, LinearLayout.LayoutParams(dp(44), dp(48)))
        root.addView(header)
        root.addView(divider())
        val surface = FrameLayout(this)
        reader = NativeReaderView(this).apply {
            setBackgroundColor(uiTheme.background)
            onPageChange = { page, total -> updateLocation(page, total); handler.removeCallbacks(savePosition); handler.postDelayed(savePosition, 350) }
            onZoomChange = { updateZoom() }
            onError = { message -> handler.removeCallbacks(revealBusy); status.text = ReaderLanguage.text(message); busy.visibility = View.GONE }
            onLoadingChanged = { loading ->
                handler.removeCallbacks(revealBusy)
                if (loading) handler.postDelayed(revealBusy, 300)
                else { busy.visibility = View.GONE; status.text = "" }
            }
            textSelectionColor = uiTheme.accent
            onTextSelectionChanged = { selected -> updateTextActions(selected) }
            onTextSelectionPositionChanged = { textActionMode?.invalidateContentRect() }
            onTextSelectionFeedback = { toast(it) }
            onSingleTap = { setChrome(!chrome) }
            onDoubleTap = { if (!reader.hasTextSelection()) setChrome(!chrome) }
        }
        surface.addView(reader, FrameLayout.LayoutParams(-1, -1))
        busy = ProgressBar(this).apply { contentDescription = ReaderLanguage.text("Loading document page"); indeterminateTintList = ColorStateList.valueOf(uiTheme.accent) }
        surface.addView(busy, FrameLayout.LayoutParams(dp(40), dp(40), Gravity.CENTER))
        status = TextView(this).apply {
            setTextColor(ink); textSize = 13f; gravity = Gravity.CENTER; setPadding(dp(18), dp(12), dp(18), dp(12)); text = ReaderLanguage.text("Opening document…")
            background = uiTheme.surface(this@NativeReaderActivity, panel, 12, true)
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { visibility = if (s.isNullOrBlank()) View.GONE else View.VISIBLE }
                override fun afterTextChanged(s: Editable?) {}
            })
        }
        surface.addView(status, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM).apply { setMargins(dp(16), 0, dp(16), dp(12)) })
        root.addView(surface, LinearLayout.LayoutParams(-1, 0, 1f))
        footer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(panel) }
        readingProgress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 1000; progressTintList = ColorStateList.valueOf(uiTheme.accent); progressBackgroundTintList = ColorStateList.valueOf(uiTheme.line)
        }
        footer.addView(readingProgress, LinearLayout.LayoutParams(-1, dp(2)))
        val navigationStrip = row().apply { setPadding(dp(4), dp(2), dp(4), dp(2)) }
        navigation = row()
        previousButton = iconButton("previous", "Previous page") { reader.goToPage(reader.currentPageIndex - 1) }
        navigation.addView(previousButton, LinearLayout.LayoutParams(dp(44), dp(48)))
        pageLabel = button("— / —", "Go to page") { goToPageDialog() }.apply { textSize = 12f; setTypeface(null, Typeface.BOLD) }
        navigation.addView(pageLabel, LinearLayout.LayoutParams(0, dp(48), 1f))
        nextButton = iconButton("next", "Next page or extend selected passage") { if(reader.hasTextSelection()) reader.extendTextSelection() else reader.goToPage(reader.currentPageIndex + 1) }
        navigation.addView(nextButton, LinearLayout.LayoutParams(dp(44), dp(48)))
        navigation.addView(iconButton("minus", ReaderLanguage.text("Zoom out")) { reader.zoomBy(1f / 1.25f); updateZoom() }, LinearLayout.LayoutParams(dp(44), dp(48)))
        zoomLabel = button(ReaderLanguage.text("Fit"), ReaderLanguage.text("Fit page width")) { reader.setZoom(1f); updateZoom() }.apply { textSize = 12f; setTextColor(uiTheme.accent); setTypeface(null, Typeface.BOLD) }
        navigation.addView(zoomLabel, LinearLayout.LayoutParams(dp(62), dp(48)))
        navigation.addView(iconButton("plus", ReaderLanguage.text("Zoom in")) { reader.zoomBy(1.25f); updateZoom() }, LinearLayout.LayoutParams(dp(44), dp(48)))
        navigationStrip.addView(navigation, LinearLayout.LayoutParams(0, -2, 1f))
        landscapeActions = row().apply {
            addView(iconButton("contents", "Contents") { showOutline() }, LinearLayout.LayoutParams(dp(44), dp(48)))
            addView(iconButton("notes", "Bookmarks and passages") { showSaved() }, LinearLayout.LayoutParams(dp(44), dp(48)))
            addView(iconButton("view", "Reader view and zoom") { showViewOptions() }, LinearLayout.LayoutParams(dp(44), dp(48)))
        }
        navigationStrip.addView(landscapeActions)
        footer.addView(navigationStrip)
        actionDock = row().apply { setPadding(dp(6), dp(3), dp(6), dp(5)) }
        actionDock.addView(dockButton("contents", "Contents") { showOutline() }, LinearLayout.LayoutParams(0, dp(58), 1f))
        actionDock.addView(dockButton("find", "Find") { findDialog() }, LinearLayout.LayoutParams(0, dp(58), 1f))
        actionDock.addView(dockButton("passage", "Save", true) { saveSelectedPassage() }, LinearLayout.LayoutParams(0, dp(58), 1f))
        actionDock.addView(dockButton("notes", "Notes") { showSaved() }, LinearLayout.LayoutParams(0, dp(58), 1f))
        actionDock.addView(dockButton("view", "View") { showViewOptions() }, LinearLayout.LayoutParams(0, dp(58), 1f))
        footer.addView(actionDock)
        root.addView(footer)
        updateChromeLayout()
        setDocumentControlsEnabled(false)
        setContentView(root)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { if (reader.hasTextSelection()) reader.clearTextSelection() else if (!chrome) setChrome(true) else finish() }
        })
        openDocument("")
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density + .5f).toInt()
    private fun row() = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setBackgroundColor(panel) }
    private fun divider() = View(this).apply { setBackgroundColor(uiTheme.line); layoutParams = LinearLayout.LayoutParams(-1, dp(1)) }
    private fun button(label: String, description: String, action: (View) -> Unit) = Button(this).apply {
        text = ReaderLanguage.text(label); contentDescription = ReaderLanguage.text(description); setTextColor(ink); background = uiTheme.touch(this@NativeReaderActivity); textSize = 15f
        isAllCaps = false; minWidth = 0; minimumWidth = 0; minimumHeight = 0; setPadding(dp(4), 0, dp(4), 0); setOnClickListener(action)
        documentControls.add(this)
    }
    private fun iconButton(icon: String, description: String, needsDocument: Boolean = true, action: (View) -> Unit) = ImageButton(this).apply {
        contentDescription = ReaderLanguage.text(description); tooltipText = ReaderLanguage.text(description); background = uiTheme.touch(this@NativeReaderActivity)
        setPadding(dp(11), dp(11), dp(11), dp(11)); setImageDrawable(NativeReaderIcon(icon, ink, resources.displayMetrics.density))
        scaleType = ImageView.ScaleType.CENTER_INSIDE; setOnClickListener(action)
        if (needsDocument) documentControls.add(this)
    }
    private fun dockButton(icon: String, label: String, primary: Boolean = false, action: (View) -> Unit) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; contentDescription = ReaderLanguage.text(if (icon == "passage") "Save selected text as a note" else label)
        background = uiTheme.touch(this@NativeReaderActivity, if (primary) uiTheme.raised else Color.TRANSPARENT)
        isClickable = true; isFocusable = true; setOnClickListener(action)
        addView(ImageView(this@NativeReaderActivity).apply { setImageDrawable(NativeReaderIcon(icon, if (primary) uiTheme.accent else uiTheme.muted, resources.displayMetrics.density)) }, LinearLayout.LayoutParams(dp(23), dp(23)))
        addView(TextView(this@NativeReaderActivity).apply {
            text = ReaderLanguage.text(label); setTextColor(if (primary) uiTheme.accent else uiTheme.muted); textSize = 10f; setTypeface(null, Typeface.BOLD)
            gravity = Gravity.CENTER; setPadding(0, dp(4), 0, 0); maxLines = 1
        }, LinearLayout.LayoutParams(-1, -2))
        documentControls.add(this)
    }
    private fun setDocumentControlsEnabled(enabled: Boolean) { documentControls.forEach { it.isEnabled = enabled; it.alpha = if (enabled) 1f else .4f } }
    private fun updateChromeLayout() {
        val compact = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE && resources.configuration.screenHeightDp < 600
        identityKicker.visibility = if (compact) View.GONE else View.VISIBLE
        header.layoutParams = (header.layoutParams ?: LinearLayout.LayoutParams(-1, -2)).apply { height = dp(if (compact) 56 else 64) }
        documentTitle.textSize = if (compact) 14f else 15f
        actionDock.visibility = if (compact) View.GONE else View.VISIBLE
        landscapeActions.visibility = if (compact && resources.configuration.screenWidthDp >= 560) View.VISIBLE else View.GONE
    }
    private fun dialogBuilder() = AlertDialog.Builder(dialogContext)
    private fun showDialog(dialog: AlertDialog, destructiveButton: Int? = null): AlertDialog {
        dialog.show()
        dialog.window?.setBackgroundDrawable(uiTheme.surface(this, panel, 20, true))
        listOf(AlertDialog.BUTTON_POSITIVE, AlertDialog.BUTTON_NEGATIVE, AlertDialog.BUTTON_NEUTRAL).forEach { id ->
            dialog.getButton(id)?.let { button ->
                button.setTextColor(if (id == destructiveButton) uiTheme.destructiveInk else uiTheme.accent)
                if (id == destructiveButton) button.background = uiTheme.destructiveTouch(this)
            }
        }
        return dialog
    }
    private fun readArray(array: JSONArray?, target: MutableList<JSONObject>) { if (array != null) for (i in 0 until array.length()) array.optJSONObject(i)?.let(target::add) }

    private fun openDocument(password: String) {
        busy.visibility = View.VISIBLE
        worker.execute {
            var opened: NativePagedDocument? = null
            try {
                val file = openingFile ?: sourceFile().also { openingFile = it }
                try { opened = openEngine(file, password) }
                catch (error: MuPdfPasswordException) { throw error }
                catch (error: Exception) {
                    if (options.optString("sourceUri").isBlank() || !file.path.startsWith("/proc/self/fd/")) throw error
                    descriptor?.close(); descriptor = null
                    val copy = copySource(); openingFile = copy; opened = openEngine(copy, password)
                }
                val ready = requireNotNull(opened)
                if (closed) { ready.destroy(); return@execute }
                val index = runCatching { NativeReaderTextIndex(this, options, ready.pageCount) { update ->
                    runOnUiThread { if (!closed) sendEvent(event("indexReady").put("indexKey", update.optString("indexKey")).put("indexedPages", update.optInt("indexedPages")).put("pages", update.optInt("pages")).put("complete", update.optBoolean("complete")).put("truncated", update.optBoolean("truncated"))) }
                } }.getOrNull()
                runOnUiThread {
                    if (closed) { Thread { ready.destroy() }.start(); return@runOnUiThread }
                    document = ready
                    textIndex = index
                    reader.onIdleIndex = { doc -> index?.advance(doc) ?: false }
                    reader.setSavedPassages(passages, options.optString("sourceRevision"))
                    totalPages = ready.pageCount
                    val page = (options.optInt("page", 1) - 1).coerceIn(0, totalPages - 1)
                    reader.attachDocument(ready, page, options.optDouble("zoom", 1.0).toFloat())
                    reader.restorePosition(page, options.optDouble("offset", 0.0).toFloat(), options.optDouble("zoom", 1.0).toFloat())
                    setDocumentControlsEnabled(true)
                    updateLocation(page, totalPages)
                    handler.post(savePosition)
                    val quote = options.optString("quote")
                    if (quote.isNotBlank()) {
                        val revision = options.optString("passageSourceRevision")
                        if (revision.isBlank() || revision == options.optString("sourceRevision")) {
                            val location = options.optJSONObject("selectionLocation")
                            if (location != null) reader.selectPassage(location, quote) else reader.selectQuote(page, quote, options.optInt("textOffset", -1))
                        }
                        else toast("The source file was replaced. This passage is still kept in Notes.")
                    }
                }
            } catch (error: MuPdfPasswordException) {
                runOnUiThread { if (!closed) askPassword(error.incorrectPassword) }
            } catch (error: Throwable) {
                opened?.destroy()
                runOnUiThread {
                    if (!closed) { busy.visibility = View.GONE; status.text = ReaderLanguage.text(error.message ?: "This document could not be opened."); showError(error.message ?: "This document could not be opened.") }
                }
            }
        }
    }

    private fun openEngine(file: File, password: String): NativePagedDocument =
        if (documentFormat == "djvu") DjVuDocument(file) else MuPdfDocument(file, password)

    private fun sourceFile(): File {
        val local = options.optString("localPath")
        if (local.isNotBlank()) {
            val file = File(local).canonicalFile
            val allowed = listOf(filesDir.canonicalFile, cacheDir.canonicalFile)
            require(allowed.any { file.path.startsWith(it.path + File.separator) } && file.isFile) { "The saved document is unavailable." }
            return file
        }
        val uri = Uri.parse(options.getString("sourceUri"))
        require(uri.scheme == "content") { "The document source is unavailable." }
        descriptor = contentResolver.openFileDescriptor(uri, "r") ?: error("Android could not open this document.")
        return File("/proc/self/fd/${descriptor!!.fd}")
    }

    private fun copySource(): File {
        val source = options.getString("sourceUri")
        val directory = File(cacheDir, "native-reader-sources").apply { mkdirs() }
        val digest = MessageDigest.getInstance("SHA-256").digest((source + "\u0000" + options.optString("workspaceGeneration", "original") + "\u0000" + options.optString("sourceRevision") + "\u0000" + options.optLong("size") + "\u0000" + options.optString("sampleHash")).toByteArray()).joinToString("") { "%02x".format(it) }
        val destination = File(directory, "$digest.$documentFormat")
        val expected = options.optLong("size", -1)
        if (destination.isFile && expected > 0 && destination.length() == expected) return destination
        require(expected < 0 || directory.usableSpace > expected + 32L * 1024 * 1024) { "There is not enough device storage to prepare this document." }
        val temporary = File(directory, "$digest.part")
        try {
            contentResolver.openInputStream(Uri.parse(source))!!.use { input ->
                temporary.outputStream().use { output ->
                    val buffer = ByteArray(256 * 1024); var total = 0L; var last = 0L
                    while (true) {
                        check(!closed) { "Document opening cancelled." }
                        val count = input.read(buffer); if (count < 0) break
                        output.write(buffer, 0, count); total += count
                        require(expected <= 0 || total <= expected) { "The document changed while it was opening." }
                        if (total - last >= 4 * 1024 * 1024) {
                            last = total; val percent = if (expected > 0) (total * 100 / expected).toInt() else -1
                            runOnUiThread { if (!closed) status.text = if (percent >= 0) ReaderLanguage.formatted("Preparing document… {percent}%", mapOf("percent" to percent.toString())) else ReaderLanguage.text("Preparing document…") }
                        }
                    }
                    output.fd.sync()
                    require(expected <= 0 || total == expected) { "The document source is incomplete." }
                }
            }
            check(temporary.renameTo(destination)) { "The prepared document could not be saved." }
            return destination
        } finally { temporary.delete() }
    }

    private fun askPassword(incorrect: Boolean) {
        busy.visibility = View.GONE
        val input = editField("Password").apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD; setSingleLine() }
        showDialog(dialogBuilder().setTitle(ReaderLanguage.text(if (incorrect) "Incorrect password" else "Password protected PDF")).setView(input)
            .setPositiveButton(ReaderLanguage.text("Open")) { _, _ -> openDocument(input.text.toString()) }.setNegativeButton(ReaderLanguage.text("Cancel")) { _, _ -> finish() }.setOnCancelListener { finish() }.create())
    }

    private fun showError(message: String) { showDialog(dialogBuilder().setTitle(ReaderLanguage.text("Could not open document")).setMessage(ReaderLanguage.text(message)).setPositiveButton(ReaderLanguage.text("Return")) { _, _ -> finish() }.setOnCancelListener { finish() }.create()) }
    private fun updateLocation(page: Int, count: Int) {
        pageLabel.text = "${page + 1} / $count"
        val pageValues = mapOf("page" to (page + 1).toString(), "count" to count.toString())
        pageLabel.contentDescription = ReaderLanguage.formatted("Page {page} of {count}. Go to page", pageValues)
        previousButton.isEnabled = page > 0; previousButton.alpha = if (page > 0) 1f else .35f
        nextButton.isEnabled = page < count - 1; nextButton.alpha = if (page < count - 1) 1f else .35f
        readingProgress.progress = if (count > 0) ((page + reader.getPageOffset()) * 1000 / count).toInt().coerceIn(0, 1000) else 0
        readingProgress.contentDescription = ReaderLanguage.formatted("Page {page} of {count}", pageValues)
        updateBookmarkState(); updateZoom()
    }
    private fun zoomText() = if (reader.zoomFactor <= 1.01f) ReaderLanguage.text("Fit") else "${(reader.zoomFactor * 100).toInt()}%"
    private fun updateZoom() { zoomLabel.text = zoomText(); zoomLabel.contentDescription = ReaderLanguage.formatted("Zoom {zoom}. Reset to fit width", mapOf("zoom" to zoomText())) }
    private fun setChrome(visible: Boolean) {
        chrome = visible
        header.visibility = if (visible) View.VISIBLE else View.GONE
        footer.visibility = if (visible) View.VISIBLE else View.GONE
        WindowCompat.getInsetsController(window, window.decorView).apply {
            if (visible) show(WindowInsetsCompat.Type.systemBars())
            else {
                systemBarsBehavior = androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                hide(WindowInsetsCompat.Type.systemBars())
            }
        }
    }

    private fun editField(placeholder: String) = EditText(dialogContext).apply {
        hint = ReaderLanguage.text(placeholder); setTextColor(ink); setHintTextColor(uiTheme.muted); textSize = 16f
        backgroundTintList = ColorStateList.valueOf(uiTheme.accent)
        setPadding(dp(16), dp(12), dp(16), dp(12))
    }

    private fun showViewOptions() {
        if (document == null) return
        val form = LinearLayout(dialogContext).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(8), dp(20), dp(12)) }
        form.addView(TextView(dialogContext).apply { text = ReaderLanguage.text("Zoom"); textSize = 12f; setTextColor(uiTheme.muted); setPadding(0, dp(8), 0, dp(8)) })
        val controls = row().apply { background = uiTheme.surface(this@NativeReaderActivity, uiTheme.raised, 12, true) }
        val output = TextView(dialogContext).apply { text = zoomText(); textSize = 16f; setTypeface(null, Typeface.BOLD); setTextColor(ink); gravity = Gravity.CENTER }
        controls.addView(iconButton("minus", ReaderLanguage.text("Zoom out"), false) { reader.zoomBy(1f / 1.25f); updateZoom(); output.text = zoomText() }, LinearLayout.LayoutParams(dp(52), dp(52)))
        controls.addView(output, LinearLayout.LayoutParams(0, dp(52), 1f))
        controls.addView(iconButton("plus", ReaderLanguage.text("Zoom in"), false) { reader.zoomBy(1.25f); updateZoom(); output.text = zoomText() }, LinearLayout.LayoutParams(dp(52), dp(52)))
        form.addView(controls)
        val fit = button(ReaderLanguage.text("Fit page width"), ReaderLanguage.text("Fit page width")) { reader.setZoom(1f); updateZoom(); output.text = zoomText() }.apply { setTextColor(uiTheme.accent) }
        form.addView(fit, LinearLayout.LayoutParams(-1, dp(52)))
        form.addView(TextView(dialogContext).apply { text = ReaderLanguage.text("Pinch to zoom · double-tap for full screen · tap to show or hide controls"); setTextColor(uiTheme.muted); textSize = 12f; setPadding(0, dp(8), 0, dp(8)) })
        val dialog = showReaderSheet(ReaderLanguage.text("View & reading")) { content, _ -> content.addView(form) }
        dialog.setOnDismissListener { documentControls.remove(fit) }
    }

    private fun goToPageDialog() {
        val count = totalPages.takeIf { it > 0 } ?: return
        val input = editField("Page number").apply { inputType = InputType.TYPE_CLASS_NUMBER; setText((reader.currentPageIndex + 1).toString()); selectAll() }
        val dialog = dialogBuilder().setTitle(ReaderLanguage.formatted("Go to page · {count} pages", mapOf("count" to count.toString()))).setView(input).setPositiveButton(ReaderLanguage.text("Go"), null).setNegativeButton(ReaderLanguage.text("Cancel"), null).create()
        dialog.setOnShowListener { dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            val page = input.text.toString().toIntOrNull(); if (page == null || page !in 1..count) input.error = "Enter 1–$count" else { reader.goToPage(page - 1); dialog.dismiss() }
        } }; showDialog(dialog)
    }

    /** The same rounded, reachable menu sheet used by the Noteject workspace. */
    private fun showReaderSheet(title: String, populate: (LinearLayout, Dialog) -> Unit): Dialog {
        readerSheet?.dismiss()
        val dialog = Dialog(dialogContext).apply { requestWindowFeature(android.view.Window.FEATURE_NO_TITLE) }
        val backdrop = FrameLayout(dialogContext).apply { setPadding(dp(12), dp(12), dp(12), dp(12)); setOnClickListener { dialog.dismiss() } }
        val scroll = object : ScrollView(dialogContext) {
            override fun onMeasure(widthSpec: Int, heightSpec: Int) {
                super.onMeasure(widthSpec, View.MeasureSpec.makeMeasureSpec((View.MeasureSpec.getSize(heightSpec) * .86f).toInt(), View.MeasureSpec.AT_MOST))
            }
        }.apply { isFillViewport = false; isClickable = true; background = uiTheme.surface(this@NativeReaderActivity, panel, 23, true); clipToOutline = true }
        val content = LinearLayout(dialogContext).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(12), dp(16), dp(20)); isClickable = true }
        val heading = row()
        val identity = LinearLayout(dialogContext).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_VERTICAL }
        identity.addView(TextView(dialogContext).apply { text = "NOTEJECT  /  " + ReaderLanguage.text("Reader"); textSize = 9f; letterSpacing = .12f; setTextColor(uiTheme.accent); setTypeface(null, Typeface.BOLD) })
        identity.addView(TextView(dialogContext).apply { text = ReaderLanguage.text(title); textSize = 18f; setTextColor(ink); setTypeface(null, Typeface.BOLD) })
        heading.addView(identity, LinearLayout.LayoutParams(0, -2, 1f))
        heading.addView(iconButton("close", ReaderLanguage.text("Close"), false) { dialog.dismiss() }, LinearLayout.LayoutParams(dp(48), dp(48)))
        content.addView(heading)
        content.addView(TextView(dialogContext).apply { text = options.optString("name", "Document"); textSize = 12f; setTextColor(uiTheme.muted); maxLines = 2; ellipsize = android.text.TextUtils.TruncateAt.END; setPadding(0, dp(4), 0, dp(12)) })
        textIndex?.let { index -> content.addView(TextView(dialogContext).apply { text = ReaderLanguage.text(if (index.complete && index.partial) "Search text cached · size limit reached" else if (index.complete) "Document text indexed for Smart Engine" else "Text indexing · ${index.progress} / $totalPages pages · while idle"); textSize = 12f; setTextColor(uiTheme.muted); setPadding(0, 0, 0, dp(8)) }) }
        populate(content, dialog)
        scroll.addView(content)
        backdrop.addView(scroll, FrameLayout.LayoutParams(minOf(dp(520), resources.displayMetrics.widthPixels - dp(24)), -2, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL))
        dialog.setContentView(backdrop)
        dialog.window?.apply {
            setBackgroundDrawableResource(android.R.color.transparent)
            addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND); setDimAmount(.70f)
            statusBarColor = panel; navigationBarColor = panel
            WindowCompat.setDecorFitsSystemWindows(this, true)
        }
        dialog.show(); dialog.window?.setLayout(-1, -1)
        readerSheet = dialog
        return dialog
    }

    private fun showMenu() {
        showReaderSheet(ReaderLanguage.text("Reader menu")) { content, dialog ->
            fun action(icon: String, label: String, ready: Boolean = document != null, run: () -> Unit) {
                val destructive = label == "Remove bookmark"
                val item = row().apply {
                    background = if (destructive) uiTheme.destructiveTouch(this@NativeReaderActivity) else uiTheme.touch(this@NativeReaderActivity, uiTheme.raised, 12)
                    setPadding(dp(14), dp(12), dp(14), dp(12)); minimumHeight = dp(52)
                    isEnabled = ready; alpha = if (ready) 1f else .4f; isClickable = true; isFocusable = true
                    contentDescription = ReaderLanguage.text(label); setOnClickListener { dialog.dismiss(); run() }
                }
                item.addView(ImageView(dialogContext).apply { setImageDrawable(NativeReaderIcon(icon, if (destructive) uiTheme.destructiveInk else uiTheme.accent, resources.displayMetrics.density)); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }, LinearLayout.LayoutParams(dp(24), dp(24)))
                item.addView(TextView(dialogContext).apply { text = ReaderLanguage.text(label); textSize = 15f; setTextColor(if (destructive) uiTheme.destructiveInk else ink); setPadding(dp(14), 0, 0, 0); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }, LinearLayout.LayoutParams(0, -2, 1f))
                content.addView(item, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) })
            }
            val definitions = options.optJSONArray("readerMenu")
            if(definitions != null && definitions.length() > 0) {
                for(index in 0 until definitions.length()) {
                    val entry = definitions.optJSONObject(index) ?: continue
                    val id = entry.optString("id"); val label = entry.optString("label"); val icon = entry.optString("icon").let { if(it == "save") "passage" else it }
                    when(id) {
                        "contents" -> action(icon,label) { showOutline() }
                        "find" -> action(icon,label) { findDialog() }
                        "saved" -> action(icon,label) { showSaved() }
                        "add-to-board" -> action(icon,label,document != null && passages.isNotEmpty()) { addSavedPassagesToBoard() }
                        "bookmark" -> action(icon,if(bookmarks.any { bookmarkPage(it) == reader.currentPageIndex + 1 }) "Remove bookmark" else label) { toggleBookmark() }
                        "save-passage" -> action(icon,label) { saveSelectedPassage() }
                        "extend-passage" -> action(icon,label,reader.hasTextSelection()) { selectThroughPageDialog() }
                        "save-image" -> action(icon,label) { captureToNote("Image") }
                        "comment" -> action(icon,label) { composePassage(reader.currentPageIndex,"",0) }
                        "view" -> action(icon,label) { showViewOptions() }
                        "fullscreen" -> action(icon,label,true) { setChrome(false) }
                        "help" -> action(icon,label,true) {
                            showDialog(dialogBuilder().setTitle(ReaderLanguage.text(label)).setMessage(ReaderLanguage.text(options.optString("readerWorkflow"))).setPositiveButton(ReaderLanguage.text("Close"),null).create())
                        }
                    }
                }
            } else {
            action("contents", "Contents") { showOutline() }
            action("find", "Find in document") { findDialog() }
            action("notes", "Notes & Passages") { showSaved() }
            action("notes", "Add saved passages to Board", document != null && passages.isNotEmpty()) { addSavedPassagesToBoard() }
            action("bookmark", if (bookmarks.any { bookmarkPage(it) == reader.currentPageIndex + 1 }) "Remove bookmark" else "Bookmark") { toggleBookmark() }
            action("passage", "Save passage") { saveSelectedPassage() }
            action("passage", "Select through page…", reader.hasTextSelection()) { selectThroughPageDialog() }
            action("passage", "Save image") { captureToNote("Image") }
            action("view", "View & reading") { showViewOptions() }
            action("fullscreen", "Full screen", true) { setChrome(false) }
            action("passage", "Add note to this page") { composePassage(reader.currentPageIndex, "", 0) }
            }
        }
    }

    private fun showOutline() {
        val doc = document ?: return
        status.text = ReaderLanguage.text("Loading contents…")
        worker.execute {
            val result = runCatching { doc.outline() }
            runOnUiThread {
                if (closed) return@runOnUiThread
                status.text = ""
                result.onSuccess { entries ->
                    if (entries.isEmpty()) { goToPageDialog(); return@onSuccess }
                    showDialog(dialogBuilder().setTitle(ReaderLanguage.text("Contents")).setItems(entries.map { "  ".repeat(it.depth.coerceAtMost(6)) + it.title + " · ${it.pageIndex + 1}" }.toTypedArray()) { _, which -> reader.goToPage(entries[which].pageIndex) }.setNegativeButton(ReaderLanguage.text("Close"), null).create())
                }.onFailure { toast(it.message ?: "Contents are unavailable.") }
            }
        }
    }

    private fun addBookmark() {
        if (document == null) return
        val page = reader.currentPageIndex + 1
        if (bookmarks.any { bookmarkPage(it) == page }) { toast("This page is already bookmarked"); return }
        val bookmark = JSONObject().put("id", UUID.randomUUID().toString()).put("title", "Page $page").put("created", System.currentTimeMillis()).put("updated", System.currentTimeMillis())
            .put("location", JSONObject().put("type", documentFormat).put("page", page).put("pageScroll", reader.getPageOffset()).put("scroll", reader.getPageOffset()))
        if (!sendEvent(event("bookmark").put("bookmark", bookmark)) { bookmarks.add(0, bookmark); updateBookmarkState() }) return
        toast("Bookmark saved")
    }

    private fun bookmarkPage(bookmark: JSONObject) = bookmark.optJSONObject("location")?.optInt("page", 1) ?: bookmark.optInt("page", 1)
    private fun updateBookmarkState() {
        val saved = bookmarks.any { bookmarkPage(it) == reader.currentPageIndex + 1 }
        bookmarkButton.setImageDrawable(NativeReaderIcon("bookmark", if (saved) uiTheme.destructiveInk else ink, resources.displayMetrics.density, saved))
        bookmarkControl.background = if (saved) uiTheme.destructiveTouch(this) else uiTheme.touch(this)
        bookmarkControl.contentDescription = ReaderLanguage.text(if (saved) "Remove bookmark from this page" else "Save bookmark")
        bookmarkControl.tooltipText = bookmarkControl.contentDescription
    }
    private fun toggleBookmark() {
        if (document == null) return
        val existing = bookmarks.firstOrNull { bookmarkPage(it) == reader.currentPageIndex + 1 }
        if (existing == null) addBookmark()
        else {
            for (mark in bookmarks.filter { bookmarkPage(it) == reader.currentPageIndex + 1 }.toList()) {
                if (!sendEvent(event("deleteBookmark").put("id", mark.optString("id"))) { bookmarks.remove(mark); updateBookmarkState() }) return
            }
            updateBookmarkState(); toast("Bookmark removed")
        }
    }

    private fun showSaved() {
        savedItemsUI?.dismiss()
        savedItemsUI = ReaderSavedPassagesUI(this,uiTheme) { action,bookmark,item ->
            val id=item.optString("id")
            when(action) {
                "read" -> {
                    val location=item.optJSONObject("location") ?: JSONObject().put("page",item.optInt("page",1))
                    val revision=location.optString("sourceRevision")
                    if(!bookmark && revision.isNotBlank() && revision != options.optString("sourceRevision")) {
                        toast("The source file was replaced. Edit this passage in Notes instead.");false
                    } else {
                        reader.restorePosition(location.optInt("page",1)-1,location.optDouble("pageScroll",location.optDouble("scroll",0.0)).toFloat(),reader.zoomFactor)
                        if(!bookmark)reader.selectPassage(location,item.optString("quote",item.optString("selectionQuote")))
                        true
                    }
                }
                "edit" -> { editPassageInNotes(id);true }
                "delete" -> sendEvent(event(if(bookmark)"deleteBookmark" else "deletePassage").put("id",id)) {
                    if(bookmark)bookmarks.removeAll { it.optString("id")==id } else { passages.removeAll { it.optString("id")==id };reader.setSavedPassages(passages) }
                    updateBookmarkState();toast(if(bookmark)"Bookmark deleted" else "Moved to Trash")
                }
                else -> true
            }
        }.also { it.open(JSONArray(bookmarks),JSONArray(passages)) }
    }

    private fun updateTextActions(selected: ReaderTextSelection?) {
        if (selected == null) {
            val previous = textActionMode; textActionMode = null; previous?.finish(); return
        }
        textActionMode?.let { it.invalidate(); it.invalidateContentRect(); return }
        textActionMode = reader.startActionMode(object : ActionMode.Callback2() {
            override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
                ReaderTextActions.populate(menu,paged=true)
                return true
            }
            override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean {
                val selected = reader.getTextSelection()
                menu.findItem(7101)?.title = if (selected != null && selected.endPage > selected.page) "Save first page as image" else "Save as image"
                return true
            }
            override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
                if (item.itemId != 2 && !reader.isTextSelectionReady()) {
                    toast("Loading selected pages…"); return true
                }
                when (item.itemId) {
                    android.R.id.copy -> { reader.copySelectedText(); mode.finish() }
                    android.R.id.selectAll -> reader.selectAllText()
                    7102 -> reader.extendTextSelection()
                    7103 -> selectThroughPageDialog()
                    ReaderExternalActions.TRANSLATE -> reader.getTextSelection()?.let { ReaderExternalActions.translate(this@NativeReaderActivity, it.text) }
                    ReaderExternalActions.SAVE_PASSAGE -> saveSelectedPassage()
                    ReaderExternalActions.SHARE -> reader.getTextSelection()?.let { ReaderExternalActions.share(this@NativeReaderActivity, it.text) }
                    2 -> mode.finish()
                    7101 -> { val page=reader.getTextSelection()?.page; mode.finish(); captureToNote("Image",page) }
                    else -> return false
                }
                return true
            }
            override fun onGetContentRect(mode: ActionMode, view: View, outRect: Rect) { reader.getTextSelectionBounds(outRect) }
            override fun onDestroyActionMode(mode: ActionMode) {
                if (textActionMode === mode) { textActionMode = null; reader.clearTextSelection() }
            }
        }, ActionMode.TYPE_FLOATING)
    }

    private fun selectThroughPageDialog() {
        val selected = reader.getTextSelection() ?: return
        val input = editField("Last page to select").apply { inputType = InputType.TYPE_CLASS_NUMBER; setText(minOf(totalPages, selected.endPage + 2).toString()); selectAll() }
        val dialog = dialogBuilder().setTitle(ReaderLanguage.text("Select across pages")).setMessage(ReaderLanguage.text("Keep this selection and extend it through the last page. You can also tap Next while text is selected, or drag the end handle to the bottom edge."))
            .setView(input).setPositiveButton(ReaderLanguage.text("Extend selection"), null).setNegativeButton(ReaderLanguage.text("Cancel"), null).create()
        dialog.setOnShowListener { dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            val page = input.text.toString().toIntOrNull()
            if(page == null || page !in (selected.endPage + 1)..minOf(totalPages, selected.page + 128)) { input.error = "Choose a page from "+(selected.endPage + 1)+" to "+minOf(totalPages, selected.page + 128); return@setOnClickListener }
            dialog.dismiss(); reader.extendTextSelectionThrough(page - 1, selected)
        } }; showDialog(dialog)
    }

    private fun saveSelectedPassage() {
        if (document == null) return
        val selected = reader.getTextSelection()
        if (selected != null && !reader.isTextSelectionReady()) { toast("Loading selected pages…"); return }
        if (selected != null) composePassage(selected.page, selected.text, selected.start, selected.pageOffset, selected)
        else {
            val page = reader.currentPageIndex
            toast("Hold a word and drag the handles, then choose Save passage. Use Add note to this page for a comment."); reader.beginTextSelection(page)
        }
    }

    private fun passageBoards(): List<JSONObject> {
        val values = options.optJSONArray("boards") ?: return emptyList()
        return (0 until values.length()).mapNotNull { values.optJSONObject(it) }.filter { it.optString("id").isNotBlank() }
    }

    private fun addSavedPassagesToBoard() {
        val boards = passageBoards()
        if (boards.isEmpty()) { toast("Create a Board in Noteject first. Your passages are kept in Notes."); return }
        showDialog(dialogBuilder().setTitle(ReaderLanguage.text("Add all saved passages to Board")).setItems(boards.map { it.optString("name", ReaderLanguage.text("Board")) }.toTypedArray()) { _, index ->
            val board = boards[index]
            if (sendEvent(event("addPassagesToBoard").put("boardId", board.optString("id")))) {
                options.put("passageBoardId", board.optString("id"))
                toast("Passages saved for ${board.optString("name", "Board")}. New passages will use this Board too.")
            }
        }.setNegativeButton(ReaderLanguage.text("Cancel"), null).create())
    }

    private fun composePassage(pageIndex:Int,quote:String,textOffset:Int,pageOffset:Float=reader.getPageOffset(),range:ReaderTextSelection?=null) {
        val config=JSONObject().put("quote",quote).put("sourceLabel",options.optString("name")+" · Page "+(pageIndex+1))
            .put("folders",options.optJSONArray("noteFolders") ?: JSONArray()).put("folder",options.optString("passageFolder").ifBlank { options.optString("folder","Inbox") })
            .put("boards",options.optJSONArray("boards") ?: JSONArray()).put("boardId",options.optString("passageBoardId").ifBlank { options.optString("defaultBoardId") })
            .put("addToBoard",options.optString("passageBoardId").isNotBlank())
        passageComposerUI?.dismiss()
        passageComposerUI=ReaderPassageComposerUI(this,uiTheme).open(config,onSave=save@{ fields->
            val location=JSONObject().put("type",documentFormat).put("page",pageIndex+1).put("pageScroll",pageOffset).put("scroll",pageOffset).put("textOffset",textOffset).put("sourceRevision",options.optString("sourceRevision"))
            if(range!=null && range.endPage>range.page) {
                location.put("endPage",range.endPage+1).put("endTextOffset",range.endOffset)
                val pages=JSONArray();range.parts.forEach { part->pages.put(JSONObject().put("page",part.page+1).put("textOffset",part.start).put("quote",part.text)) };location.put("pages",pages)
            }
            val duplicate=quote.isNotBlank() && passages.any { prior->
                val where=prior.optJSONObject("location") ?: JSONObject()
                ReaderTextSearch.index(prior.optString("quote")).text.trim()==ReaderTextSearch.index(quote).text.trim() && where.optInt("page")==pageIndex+1 && where.optInt("textOffset",-1)==textOffset && where.optString("sourceRevision")==options.optString("sourceRevision")
            }
            if(duplicate){toast(ReaderLanguage.text("This passage is already saved. Open Notes & Passages, then Edit in Notes."));return@save false}
            val passage=fields.put("id",UUID.randomUUID().toString()).put("location",location)
            if(!sendEvent(event("selection").put("passage",passage)){passages.add(0,passage);reader.setSavedPassages(passages)})return@save false
            options.put("passageFolder",fields.optString("folder")).put("passageBoardId",fields.optString("boardId"));reader.clearTextSelection()
            handler.post { if(!closed)showDialog(dialogBuilder().setTitle(ReaderLanguage.text("Saved in Notes")).setMessage(ReaderLanguage.text("Open Notes & Passages, then Edit in Notes. Save your changes and use Return to passage to continue reading."))
                .setPositiveButton(ReaderLanguage.text("Edit in Notes")){ _,_->editPassageInNotes(passage.optString("id")) }.setNegativeButton(ReaderLanguage.text("Continue reading"),null).create()) }
            true
        },onCancel={})
    }

    private fun captureToNote(kind: String, selectedPage: Int? = null) {
        if (document == null) return
        val page = selectedPage ?: reader.currentPageIndex
        val pageOffset = reader.getPageOffset()
        reader.clearTextSelection(); status.text = ReaderLanguage.text("Preparing page capture…")
        reader.capturePage(page, null) { preview, error ->
            status.text = ""
            if (preview == null) { toast(error ?: "Could not prepare this page."); return@capturePage }
            val form = LinearLayout(dialogContext).apply { orientation=LinearLayout.VERTICAL; setPadding(dp(16),dp(8),dp(16),dp(8)) }
            form.addView(TextView(dialogContext).apply {
                text = ReaderLanguage.formatted("Drag a rectangle around the {kind}. Drag inside to move it. This saves the original page appearance, including scanned pages.", mapOf("kind" to ReaderLanguage.text(kind.lowercase())))
                setTextColor(uiTheme.muted); textSize=13f
            })
            val crop = ReaderCaptureView(dialogContext,preview,uiTheme.accent)
            val previewHeight = (resources.displayMetrics.heightPixels * .46f).toInt().coerceIn(dp(180),dp(420))
            form.addView(crop,LinearLayout.LayoutParams(-1,previewHeight))
            val wholePage = button("Use whole page", "Select the whole page") { crop.wholePage() }.apply { minimumHeight=dp(48) }
            form.addView(wholePage)
            val title = editField("Title / caption").apply { setSingleLine(); setText("$kind · page ${page+1}") }
            form.addView(title)
            val choices = mutableListOf<JSONObject>()
            val available = options.optJSONArray("notes") ?: JSONArray()
            for (index in 0 until available.length()) available.optJSONObject(index)?.let(choices::add)
            val picker = Spinner(dialogContext).apply {
                contentDescription=ReaderLanguage.text("Destination note"); minimumHeight=dp(48)
                adapter=ArrayAdapter(dialogContext,android.R.layout.simple_spinner_dropdown_item,listOf(ReaderLanguage.text("Create new note"))+choices.map { it.optString("title",ReaderLanguage.text("Untitled note"))+" · "+it.optString("folder",options.optString("folder","Inbox")) })
            }
            form.addView(TextView(dialogContext).apply { text=ReaderLanguage.text("Save to Notes"); setTextColor(uiTheme.muted); textSize=12f })
            form.addView(picker)
            val boards = passageBoards()
            val rememberedBoard = options.optString("captureBoardId")
            val addToBoard = CheckBox(dialogContext).apply {
                text=ReaderLanguage.text("Also add to Board"); setTextColor(ink); minimumHeight=dp(48)
                buttonTintList=ColorStateList.valueOf(uiTheme.accent)
                isEnabled=boards.isNotEmpty(); isChecked=boards.any { it.optString("id")==rememberedBoard }
            }
            val boardPicker = Spinner(dialogContext).apply {
                contentDescription=ReaderLanguage.text("Board for this capture"); minimumHeight=dp(48)
                adapter=ArrayAdapter(dialogContext,android.R.layout.simple_spinner_dropdown_item,boards.map { it.optString("name","Board") })
                setSelection(boards.indexOfFirst { it.optString("id")==rememberedBoard.ifBlank { options.optString("defaultBoardId") } }.coerceAtLeast(0))
                isEnabled=addToBoard.isChecked
            }
            addToBoard.setOnCheckedChangeListener { _,checked -> boardPicker.isEnabled=checked }
            form.addView(addToBoard); form.addView(boardPicker)
            if(boards.isEmpty()) form.addView(TextView(dialogContext).apply { text=ReaderLanguage.text("Create a Board in the workspace first. This capture can still be saved in Notes.");setTextColor(uiTheme.muted);textSize=12f })
            val scroll=ScrollView(dialogContext).apply { addView(form) }
            val dialog=dialogBuilder().setTitle(ReaderLanguage.text("Save ${kind.lowercase()}")).setView(scroll).setPositiveButton(ReaderLanguage.text("Save"),null).setNegativeButton(ReaderLanguage.text("Cancel"),null).create()
            var saving=false
            dialog.setOnDismissListener { documentControls.remove(wholePage); preview.recycle() }
            dialog.setOnShowListener { dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                if(saving) return@setOnClickListener
                val selected=crop.region()
                if(selected.width() < .01f || selected.height() < .01f) { toast("Select an area first."); return@setOnClickListener }
                saving=true; dialog.setCancelable(false)
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled=false; dialog.getButton(AlertDialog.BUTTON_NEGATIVE).isEnabled=false
                val label=title.text.toString().trim().ifBlank { "$kind · page ${page+1}" }
                val target=choices.getOrNull(picker.selectedItemPosition-1)?.optString("id") ?: ""
                val noteId=if(target.isBlank()) UUID.randomUUID().toString() else target
                val selectedBoard=if(addToBoard.isChecked) boards.getOrNull(boardPicker.selectedItemPosition)?.optString("id") ?: "" else ""
                reader.capturePage(page,selected) captured@{ bitmap, failure ->
                    if(bitmap == null) {
                        saving=false; dialog.setCancelable(true); dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled=true; dialog.getButton(AlertDialog.BUTTON_NEGATIVE).isEnabled=true
                        toast(failure ?: "Could not capture this area."); return@captured
                    }
                    worker.execute {
                        var captureId: String?=null
                        val result=runCatching { NativeReaderCaptures.save(this,bitmap).also { captureId=it } }
                        bitmap.recycle()
                        runOnUiThread {
                            if(closed) { captureId?.let { NativeReaderCaptures.remove(this,it) }; return@runOnUiThread }
                            result.onSuccess { id ->
                                val location=JSONObject().put("type",documentFormat).put("page",page+1).put("pageScroll",pageOffset).put("scroll",pageOffset)
                                    .put("region",JSONArray(listOf(selected.left,selected.top,selected.right,selected.bottom))).put("sourceRevision",options.optString("sourceRevision"))
                                val event=event("capture").put("captureId",id).put("kind",kind.lowercase()).put("title",label).put("noteId",noteId)
                                    .put("append",target.isNotBlank()).put("folder",options.optString("folder","Inbox")).put("location",location)
                                    .put("addToBoard",selectedBoard.isNotBlank()).put("boardId",selectedBoard)
                                if(sendEvent(event)) {
                                    options.put("captureBoardId",selectedBoard)
                                    if(target.isBlank()) { val note=JSONObject().put("id",noteId).put("title",label); choices.add(note); val list=options.optJSONArray("notes") ?: JSONArray().also { options.put("notes",it) }; list.put(note) }
                                    dialog.dismiss(); toast(if(selectedBoard.isNotBlank()) "$kind saved for Notes and Board. Return to the workspace to open it." else "$kind saved. Return to the workspace to open it in Notes.")
                                } else { NativeReaderCaptures.remove(this,id); saving=false }
                            }.onFailure { saving=false; toast(it.message ?: "Could not save this capture.") }
                            if(!saving && dialog.isShowing) { dialog.setCancelable(true); dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled=true; dialog.getButton(AlertDialog.BUTTON_NEGATIVE).isEnabled=true }
                        }
                    }
                }
            } }
            showDialog(dialog)
        }
    }

    private fun findDialog() {
        if (document == null) return
        val input = editField("Find words or phrase").apply { setSingleLine(); setText(lastFindQuery); selectAll(); filters = arrayOf(android.text.InputFilter.LengthFilter(500)) }
        val dialog = dialogBuilder().setTitle(ReaderLanguage.text("Find in document")).setView(input).setPositiveButton(ReaderLanguage.text("Find"), null).setNegativeButton(ReaderLanguage.text("Cancel"), null).create()
        dialog.setOnShowListener { dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            val query = input.text.toString().trim()
            if (ReaderTextSearch.index(query).text.isBlank()) { input.error = "Enter words to find"; return@setOnClickListener }
            lastFindQuery = query; dialog.dismiss(); find(query)
        } }; showDialog(dialog)
    }

    private fun find(query: String) {
        val doc = document ?: return
        val generation = searchGeneration.incrementAndGet()
        val found = mutableListOf<FindHit>(); val labels = mutableListOf<String>()
        val adapter = ArrayAdapter(dialogContext, android.R.layout.simple_list_item_1, labels)
        val start = reader.currentPageIndex; val count = totalPages
        var scanned = 0; var skipped = 0
        val dialog = dialogBuilder().setTitle(ReaderLanguage.text("Finding…")).setAdapter(adapter) { _, which ->
            val match = found.getOrNull(which) ?: return@setAdapter
            reader.goToPage(match.page); reader.selectQuote(match.page, match.quote, match.start)
        }.setNegativeButton(ReaderLanguage.text("Close"), null).create()
        dialog.setOnDismissListener { searchGeneration.incrementAndGet() }; showDialog(dialog)
        fun valid() = !closed && searchGeneration.get() == generation && document === doc
        fun scanNext() {
            if (!valid()) return
            val page = (start + scanned) % count; val remaining = 1000 - found.size
            worker.execute {
                if (!valid()) return@execute
                val batch = runCatching {
                    val cached = findCache[page] ?: doc.text(page).let { source ->
                        FindPage(source, ReaderTextSearch.index(source)).also { record ->
                            if (source.length <= 400_000) {
                                while (findCacheChars + source.length > 400_000 && findCache.isNotEmpty()) {
                                    val first = findCache.keys.first(); findCacheChars -= findCache.remove(first)!!.source.length
                                }
                                findCache[page] = record; findCacheChars += source.length
                            }
                        }
                    }
                    ReaderTextSearch.find(cached.index, query, remaining).map { range ->
                        FindHit(page, range.first, cached.source.substring(range.first, range.last + 1),
                            cached.source.substring(maxOf(0, range.first - 30), minOf(cached.source.length, range.last + 81)).replace(Regex("\\s+"), " "))
                    }
                }
                runOnUiThread {
                    if (!valid()) return@runOnUiThread
                    scanned++; if (batch.isFailure) skipped++
                    val hits = batch.getOrDefault(emptyList()); found.addAll(hits)
                    labels.addAll(hits.map { ReaderLanguage.formatted("Page {page}", mapOf("page" to (it.page+1).toString()))+" · "+it.excerpt }); adapter.notifyDataSetChanged()
                    val complete = scanned >= count || found.size >= 1000
                    dialog.setTitle(if (complete) ReaderLanguage.formatted("{count} matches", mapOf("count" to (found.size.toString()+(if(found.size>=1000) "+" else ""))))+(if(skipped>0) " · "+ReaderLanguage.formatted("{count} pages skipped", mapOf("count" to skipped.toString())) else "") else ReaderLanguage.formatted("{count} matches · {page}/{total} pages", mapOf("count" to found.size.toString(), "page" to scanned.toString(), "total" to count.toString())))
                    if (complete) {
                        if (found.isEmpty()) toast(if(skipped>0) "Some pages could not be searched. Reopen the original file and try again." else "No matching text. Scanned pages need an embedded text layer.")
                    } else handler.postDelayed({ scanNext() }, 16)
                }
            }
        }
        if (count > 0) scanNext()
    }

    private fun editPassageInNotes(id: String) {
        if (id.isNotBlank() && sendEvent(event("editNote").put("id", id))) finish()
    }

    private fun event(type: String) = JSONObject().put("type", type).put("documentId", options.getString("documentId")).put("requestId", options.optString("requestId")).put("workspaceGeneration", options.optString("workspaceGeneration", "original")).put("sourceRevision", options.optString("sourceRevision"))
    private fun sendEvent(event: JSONObject, apply: () -> Unit = {}): Boolean = NativeReaderMutation.commit(
        { NativeReaderEvents.enqueue(this, event) }, apply,
        { toast(it.message ?: "Reader change could not be saved. Try again.") }
    )
    private fun persistPosition(publish: Boolean = false) {
        if (document == null) return
        if (closed) return
        val page = reader.currentPageIndex + 1; val offset = reader.getPageOffset(); val zoom = reader.zoomFactor
        val key = "$page:${(offset * 10000).toInt()}:${(zoom * 1000).toInt()}"
        if (key == positionWritten && !publish) return
        runCatching { NativeReaderEvents.saveProgress(this, event("progress").put("page", page).put("pages", totalPages).put("offset", offset).put("zoom", zoom), publish) }
            .onSuccess { positionWritten = key }.onFailure { toast(it.message ?: "Reading position could not be saved.") }
    }
    private fun toast(message: String) { Toast.makeText(this, ReaderLanguage.text(message), Toast.LENGTH_LONG).show() }

    override fun onSaveInstanceState(outState: Bundle) {
        if (::reader.isInitialized) options.put("page", reader.currentPageIndex + 1).put("offset", reader.getPageOffset()).put("zoom", reader.zoomFactor).put("forceLocation", true)
        options.put("bookmarks", JSONArray(bookmarks)).put("passages", JSONArray(passages))
        launchFile?.let { file -> runCatching { file.writeText(options.toString(), Charsets.UTF_8); outState.putString("readerOptionsPath", file.path) } }
        super.onSaveInstanceState(outState)
    }
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        savedItemsUI?.dismiss(); savedItemsUI = null
        passageComposerUI?.dismiss();passageComposerUI=null
        readerSheet?.dismiss(); readerSheet = null
        if (::header.isInitialized) updateChromeLayout()
    }
    override fun onPause() { if (::reader.isInitialized) reader.backgroundWorkEnabled = false; persistPosition(publish = !finishSent); handler.removeCallbacks(savePosition); super.onPause() }
    override fun onResume() { super.onResume(); if (::reader.isInitialized) { reader.backgroundWorkEnabled = true; handler.post(savePosition) } }
    override fun finish() {
        persistPosition(publish = true)
        if (::options.isInitialized && !finishSent && options.optString("documentId").isNotBlank()) { finishSent = true; sendEvent(event("closed")) }
        setResult(RESULT_OK); super.finish()
    }
    override fun onDestroy() {
        if (::reader.isInitialized && ::options.isInitialized) runCatching {
            val metrics = reader.performanceSnapshot().put("documentType", documentFormat).put("documentId", options.optString("documentId"))
                .put("capturedAt", System.currentTimeMillis()).put("processPssKb", android.os.Debug.getPss()).put("version", BuildConfig.VERSION_NAME)
            val target = android.util.AtomicFile(File(filesDir, "reader-performance.json")); val output = target.startWrite()
            try { output.write(metrics.toString(2).toByteArray()); target.finishWrite(output) } catch (error: Throwable) { target.failWrite(output); throw error }
        }
        closed = true; searchGeneration.incrementAndGet(); handler.removeCallbacksAndMessages(null)
        savedItemsUI?.dismiss(); savedItemsUI = null
        passageComposerUI?.dismiss(); passageComposerUI = null
        readerSheet?.dismiss(); readerSheet = null
        if (::reader.isInitialized) reader.close { preparedCache.releaseAll() } else preparedCache.releaseAll()
        worker.shutdownNow(); descriptor?.close(); descriptor = null; document = null
        super.onDestroy()
    }
    override fun onTrimMemory(level: Int) { super.onTrimMemory(level); if (::reader.isInitialized) reader.trimMemory() }
}
