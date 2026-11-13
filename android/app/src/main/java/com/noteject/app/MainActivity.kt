package com.noteject.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceError
import android.webkit.WebView
import android.webkit.WebViewClient
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.widget.FrameLayout
import android.widget.Toast
import android.webkit.MimeTypeMap
import java.io.File
import java.io.FileOutputStream
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.Lifecycle
import androidx.core.view.ViewCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean

class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private lateinit var contentContainer: FrameLayout
    private lateinit var assetLoader: WebViewAssetLoader
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    @Volatile private var saveFolderRequestId: String? = null
    private val network = Executors.newFixedThreadPool(2)
    private val exportWorker = Executors.newSingleThreadExecutor()
    @Volatile private var destroyed = false
    @Volatile private var keyboardVisible = false
    @Volatile private var readerFullscreen = false
    private var pageReady = false
    private var quickActions: AndroidQuickActions? = null
    private var backPending = false
    private var backRequestId = 0
    private var unavailableBackAt = 0L
    private val pendingNotices = mutableListOf<String>()
    private val activityPrefs by lazy { getSharedPreferences("noteject_activity_state", MODE_PRIVATE) }
    private val readerFiles by lazy { NativeReaderFiles(this) }
    private val nativeReaderOpen = AtomicBoolean(false)
    @Volatile private var nativeReaderSession: JSONObject? = null
    private var nativeReaderLaunchFile: File? = null
    private var readerSavedUI: ReaderSavedPassagesUI? = null
    private var readerComposerUI: android.app.AlertDialog? = null
    private val nativeReaderLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        nativeReaderOpen.set(false)
        readerFiles.releasePreparedFiles()
        nativeReaderSession?.let { session -> evaluate("window.__notejectNativeReaderEvent?.($session)") }; nativeReaderSession = null
        nativeReaderLaunchFile?.delete(); nativeReaderLaunchFile = null
        evaluate("window.NotejectNativeReader?.drain()")
    }
    private var fullscreenView: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null
    private val exportLock = Any()
    private data class ExportFile(val id: String, val name: String, val mime: String, val size: Long, val file: File, var output: FileOutputStream?, var written: Long = 0, val deleteAfter: Boolean = true, val audioRequestId: String? = null)
    private var currentExport: ExportFile? = null
    private var audio: AndroidAudio? = null
    private var microphoneReply: ((Boolean) -> Unit)? = null
    private var microphonePermissionResult: Boolean? = null
    private var audioScreenAwake = false
    private val microphonePermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
            audio?.onStart()
            val callback = microphoneReply; microphoneReply = null
            callback?.invoke(granted)
        } else microphonePermissionResult = granted
    }
    private val savePicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val item = synchronized(exportLock) { currentExport } ?: return@registerForActivityResult
        val uri = result.data?.data
        if (result.resultCode != RESULT_OK || uri == null) {
            finishExport(item, "cancelled", "Save cancelled")
            return@registerForActivityResult
        }
        try {
            exportWorker.execute {
                runCatching {
                    val output = contentResolver.openOutputStream(uri, "wt") ?: error("Could not open the selected file for saving.")
                    output.use { target -> item.file.inputStream().use { it.copyTo(target) } }
                }.onSuccess { finishExport(item, "saved", "Saved ${item.name}") }
                    .onFailure { finishExport(item, "error", it.message ?: "Could not save this file.") }
            }
        } catch (_: RejectedExecutionException) { finishExport(item, "error", "The app closed before the file was saved.") }
    }
    private val saveFolderPicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val callbackId = saveFolderRequestId; saveFolderRequestId = null
        if (callbackId == null) return@registerForActivityResult
        val intent = result.data
        val uri = intent?.data
        if (result.resultCode != RESULT_OK || uri == null) {
            evaluate("window.__notejectAndroidSaveFolderResult?.(${JSONObject.quote(callbackId)},${JSONObject.quote("cancelled")},${JSONObject.quote("")})")
            return@registerForActivityResult
        }
        val grantFlags = (intent.flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION))
        val previous = activityPrefs.getString("save_folder_uri", null)
        val folderName = runCatching {
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            }
        }.getOrNull()?.takeIf { it.isNotBlank() }
            ?: runCatching { DocumentsContract.getTreeDocumentId(uri).substringAfter(':').substringAfterLast('/') }.getOrNull()?.takeIf { it.isNotBlank() }
            ?: "Selected folder"
        runCatching {
            require(grantFlags != 0) { "Android did not grant access to that folder. Choose it again." }
            contentResolver.takePersistableUriPermission(uri, grantFlags)
        }.onFailure { error ->
            evaluate("window.__notejectAndroidSaveFolderResult?.(${JSONObject.quote(callbackId)},${JSONObject.quote("error")},${JSONObject.quote(error.message ?: "Could not access that folder.")})")
            return@registerForActivityResult
        }
        activityPrefs.edit().putString("save_folder_uri", uri.toString()).putString("save_folder_name", folderName).apply()
        if (!previous.isNullOrBlank() && previous != uri.toString()) {
            runCatching { contentResolver.releasePersistableUriPermission(Uri.parse(previous), Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION) }
        }
        evaluate("window.__notejectAndroidSaveFolderResult?.(${JSONObject.quote(callbackId)},${JSONObject.quote("selected")},${JSONObject.quote(folderName)})")
    }
    private val picker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val callback = fileCallback
        fileCallback = null
        activityPrefs.edit().remove("pending_import").apply()
        if (callback == null) return@registerForActivityResult
        val intent = result.data
        val uris = if (result.resultCode == RESULT_OK && intent != null) {
            val values = mutableListOf<Uri>()
            intent.clipData?.let { clip -> for (i in 0 until clip.itemCount) values.add(clip.getItemAt(i).uri) }
            if (values.isEmpty()) intent.data?.let(values::add)
            values.filter { it.scheme == "content" }.distinct().toTypedArray().takeIf { it.isNotEmpty() }
        } else null
        uris?.forEach { uri -> runCatching { readerFiles.rememberSelection(uri, intent?.flags ?: 0) } }
        callback.onReceiveValue(uris)
    }

    private val securePrefs by lazy { EncryptedSharedPreferences.create(
        this,
        "noteject_secure",
        MasterKey.Builder(this).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    ) }

    private fun evaluate(script: String) {
        runOnUiThread { if (!destroyed) webView.evaluateJavascript(script, null) }
    }

    private fun dispatchAudio(event: JSONObject) {
        runOnUiThread {
            if (destroyed) return@runOnUiThread
            if (event.optString("type") == "state") audioScreenAwake = event.optString("status") in setOf("recording", "transcribing")
            if (audioScreenAwake) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            webView.evaluateJavascript("window.__notejectAndroidAudioEvent?.($event)", null)
        }
    }

    private fun requestMicrophone(callback: (Boolean) -> Unit) {
        runOnUiThread {
            if (destroyed) { callback(false); return@runOnUiThread }
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) callback(true)
            else if (microphoneReply != null) callback(false)
            else {
                microphoneReply = callback
                runCatching { microphonePermission.launch(Manifest.permission.RECORD_AUDIO) }.onFailure {
                    microphoneReply = null; callback(false)
                }
            }
        }
    }

    private fun finishExport(item: ExportFile, status: String, message: String) {
        synchronized(exportLock) {
            if (currentExport?.id == item.id) currentExport = null
            runCatching { item.output?.close() }; item.output = null
            if (item.deleteAfter) item.file.delete()
        }
        activityPrefs.edit().remove("pending_export").apply()
        if (item.audioRequestId != null) dispatchAudio(JSONObject().put("requestId", item.audioRequestId).put("action", "export").put("ok", status != "error").put("status", status).put("message", message).apply { if (status == "error") put("error", message) })
        else evaluate("window.__notejectAndroidExportResult?.(${JSONObject.quote(item.id)},${JSONObject.quote(status)},${JSONObject.quote(message)})")
    }

    private fun createSaveIntent(item: ExportFile): Intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = item.mime
        putExtra(Intent.EXTRA_TITLE, item.name)
        activityPrefs.getString("save_folder_uri", null)?.let { raw ->
            runCatching { Uri.parse(raw) }.getOrNull()?.let { putExtra(DocumentsContract.EXTRA_INITIAL_URI, it) }
        }
        addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
    }

    private fun sendSaveFolderResult(id: String, status: String, value: String) {
        evaluate("window.__notejectAndroidSaveFolderResult?.(${JSONObject.quote(id)},${JSONObject.quote(status)},${JSONObject.quote(value)})")
    }

    private fun exportAudio(requestId: String, recordingId: String, name: String) {
        val file = audio?.recordingFile(recordingId) ?: error("The recording is unavailable.")
        var safeName = name.substringAfterLast('/').substringAfterLast('\\').replace(Regex("[\\p{Cntrl}<>:\"|?*]"), "_").trim().take(170).ifBlank { "Recording.wav" }
        if (!safeName.endsWith(".wav", true)) safeName += ".wav"
        val item = synchronized(exportLock) {
            check(currentExport == null) { "Finish or cancel the current file save first." }
            ExportFile(java.util.UUID.randomUUID().toString(), safeName, "audio/wav", file.length(), file, null, deleteAfter = false, audioRequestId = requestId).also { currentExport = it }
        }
        activityPrefs.edit().putString("pending_export", item.file.name).apply()
        runOnUiThread {
            if (destroyed) { finishExport(item, "error", "Saving was interrupted. Your recording is still saved."); return@runOnUiThread }
            runCatching {
                savePicker.launch(createSaveIntent(item))
            }.onFailure { finishExport(item, "error", "No Android file manager is available for saving.") }
        }
    }

    private fun dispatchKeyboardState() {
        evaluate("window.dispatchEvent(new CustomEvent('noteject:android-insets',{detail:{keyboardVisible:$keyboardVisible}}))")
    }

    private fun dispatchPendingNotices() {
        if (!pageReady) return
        val notices = pendingNotices.toList(); pendingNotices.clear()
        for (message in notices) evaluate("window.dispatchEvent(new CustomEvent('noteject:android-notice',{detail:{message:${JSONObject.quote(message)}}}))")
    }

    private fun recoverInterruptedPickers() {
        if (activityPrefs.getBoolean("pending_import", false)) {
            pendingNotices.add("File selection was interrupted. Your saved files are safe; choose the files again to import them.")
        }
        val exportName = activityPrefs.getString("pending_export", null)
        if (exportName != null) {
            // Only the exact app-created temporary transfer file can be removed here.
            val directory = File(cacheDir, "exports").canonicalFile
            val target = File(directory, exportName).canonicalFile
            if (target.parentFile == directory && exportName.matches(Regex("^noteject-[a-zA-Z0-9._-]+\\.tmp$"))) target.delete()
            pendingNotices.add("Saving was interrupted before it finished. Please save the file again.")
        }
        activityPrefs.edit().remove("pending_import").remove("pending_export").apply()
    }

    private fun fallbackBack() {
        if (webView.canGoBack()) { webView.goBack(); return }
        val now = android.os.SystemClock.elapsedRealtime()
        if (unavailableBackAt > 0 && now - unavailableBackAt < 2000) finish()
        else {
            unavailableBackAt = now
            Toast.makeText(this, ReaderLanguage.text("Press Back again to close noteject"), Toast.LENGTH_SHORT).show()
        }
    }

    private fun openExternal(uri: Uri) {
        if (uri.scheme?.lowercase() !in setOf("http", "https", "mailto", "tel")) return
        if (uri.scheme in setOf("http", "https") && uri.host.isNullOrBlank()) return
        if (uri.scheme in setOf("http", "https")) {
            val host = uri.host.orEmpty().lowercase().removePrefix("[").removeSuffix("]")
            if (host == "localhost" || host.endsWith(".localhost") || host == "127.0.0.1" || host.startsWith("127.") || host == "::1" || host == "0.0.0.0" || host == "::") return
            if (uri.scheme == "https" && host == "appassets.androidplatform.net") return
        }
        runOnUiThread { if (!destroyed) runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri)) } }
    }

    private fun closeFullscreen() {
        fullscreenView?.let { (it.parent as? FrameLayout)?.removeView(it) }
        fullscreenView = null
        val callback = fullscreenCallback; fullscreenCallback = null
        callback?.onCustomViewHidden()
        webView.visibility = View.VISIBLE
        applyFullscreenState()
    }

    private fun applyFullscreenState() {
        if (!::webView.isInitialized) return
        WindowCompat.getInsetsController(window, webView).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            if (readerFullscreen || fullscreenView != null) hide(WindowInsetsCompat.Type.systemBars())
            else show(WindowInsetsCompat.Type.systemBars())
        }
        if (::contentContainer.isInitialized) ViewCompat.requestApplyInsets(contentContainer)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        runCatching { securePrefs.edit().remove("api_key").apply() }
        quickActions = AndroidQuickActions(this) { action ->
            evaluate("window.dispatchEvent(new CustomEvent('noteject:quick-action',{detail:$action}))")
        }
        if (savedInstanceState?.getBoolean("quick_actions_captured", false) != true) acceptQuickAction(intent)
        recoverInterruptedPickers()
        // Only our completed/abandoned transfer cache is eligible for cleanup.
        File(cacheDir, "exports").listFiles()?.filter { it.isFile && it.name.startsWith("noteject-") && it.name.endsWith(".tmp") && it.lastModified() < System.currentTimeMillis() - 86400000L }?.forEach { it.delete() }
        window.statusBarColor = android.graphics.Color.rgb(16, 17, 20)
        window.navigationBarColor = android.graphics.Color.rgb(16, 17, 20)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        assetLoader = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        webView = ReaderSelectionWebView(this)
        webView.setBackgroundColor(android.graphics.Color.rgb(16, 17, 20))
        val container = FrameLayout(this).apply {
            setBackgroundColor(android.graphics.Color.rgb(16, 17, 20))
            addView(webView, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        }
        contentContainer = container
        setContentView(container)
        WindowCompat.getInsetsController(window, container).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }
        ViewCompat.setOnApplyWindowInsetsListener(container) { view, insets ->
            // Transient bars overlay a focused reader; cutouts and the keyboard still reserve space.
            val safeTypes = if (readerFullscreen || fullscreenView != null) WindowInsetsCompat.Type.displayCutout()
                else WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            val bars = insets.getInsets(safeTypes)
            val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
            keyboardVisible = insets.isVisible(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
            if (::webView.isInitialized) dispatchKeyboardState()
            WindowInsetsCompat.CONSUMED
        }
        ViewCompat.requestApplyInsets(container)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.databaseEnabled = true
        webView.settings.allowFileAccess = false
        webView.settings.allowContentAccess = true
        webView.addJavascriptInterface(AndroidBridge(), "NotejectAndroid")
        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                pageReady = false
                quickActions?.setReady(false)
                readerFullscreen = false
                if (fullscreenView != null) closeFullscreen() else applyFullscreenState()
            }
            override fun onPageFinished(view: WebView, url: String?) {
                pageReady = true
                dispatchKeyboardState()
                dispatchPendingNotices()
                evaluate("window.NotejectNativeReader?.drain()")
            }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) pageReady = false
            }
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) = AndroidAudioFiles.response(request, audio) ?: assetLoader.shouldInterceptRequest(request.url)
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                if (uri.scheme == "https" && uri.host == "appassets.androidplatform.net") return false
                openExternal(uri)
                return true
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                if (fullscreenView != null) { callback.onCustomViewHidden(); return }
                fullscreenView = view; fullscreenCallback = callback
                webView.visibility = View.GONE
                container.addView(view, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
                applyFullscreenState()
            }
            override fun onHideCustomView() { closeFullscreen() }
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    val types = params.acceptTypes.flatMap { it.split(',') }.mapNotNull { value ->
                        val accept = value.trim().lowercase()
                        if (accept.startsWith('.')) when (accept) {
                            ".epub" -> "application/epub+zip"
                            ".json" -> "application/json"
                            ".zip" -> "application/zip"
                            else -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(accept.removePrefix("."))
                        } else accept.takeIf { it.contains('/') }
                    }.distinct()
                    if (types.size == 1) type = types.first()
                    else if (types.isNotEmpty()) putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
                }
                return try {
                    activityPrefs.edit().putBoolean("pending_import", true).commit()
                    picker.launch(intent); true
                } catch (_: Exception) {
                    activityPrefs.edit().remove("pending_import").apply()
                    fileCallback = null; callback.onReceiveValue(null)
                    Toast.makeText(this@MainActivity, ReaderLanguage.text("No Android file picker is available."), Toast.LENGTH_LONG).show()
                    true
                }
            }
        }
        audio = AndroidAudio(this, ::dispatchAudio, ::requestMicrophone)
        webView.loadUrl("https://appassets.androidplatform.net/assets/index.html")
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (fullscreenView != null) { closeFullscreen(); return }
                if (keyboardVisible) {
                    keyboardVisible = false
                    WindowCompat.getInsetsController(window, webView).hide(WindowInsetsCompat.Type.ime())
                    return
                }
                if (backPending || destroyed) return
                if (!pageReady) { fallbackBack(); return }
                backPending = true
                val requestId = ++backRequestId
                webView.postDelayed({ if (backRequestId == requestId) backPending = false }, 1500)
                webView.evaluateJavascript("(()=>{try{return typeof window.NotejectMobile?.handleBack==='function'?(window.NotejectMobile.handleBack()?'handled':'exit'):'unavailable'}catch(_){return 'unavailable'}})()") { handled ->
                    if (destroyed || backRequestId != requestId) return@evaluateJavascript
                    backPending = false
                    when (handled) {
                        "\"handled\"" -> unavailableBackAt = 0L
                        "\"exit\"" -> finish()
                        else -> fallbackBack()
                    }
                }
            }
        })
    }

    private fun acceptQuickAction(incoming: Intent?) {
        if (incoming?.action !in setOf(AndroidQuickActions.NEW_NOTE, AndroidQuickActions.NEW_RECORDING)) return
        val accepted = quickActions?.accept(incoming) == true
        // The queued request survives process death. Clear the launch action so a
        // recreated Activity cannot create the same note or recording twice.
        setIntent(Intent(incoming).apply { action = Intent.ACTION_MAIN })
        if (!accepted) Toast.makeText(this, ReaderLanguage.text("Open noteject to finish the pending quick actions first."), Toast.LENGTH_LONG).show()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        acceptQuickAction(intent)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean("quick_actions_captured", true)
        super.onSaveInstanceState(outState)
    }

    override fun onPause() {
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        audio?.onStop()
        if (::webView.isInitialized && !destroyed) {
            webView.evaluateJavascript("(()=>{try{window.NotejectMobile?.persistDraft();if(typeof readerSelections!=='undefined')readerSelections.persistDraft?.();if(typeof saveReaderProgress==='function')saveReaderProgress();if(typeof workspaceStore!=='undefined')workspaceStore.flush()}catch(_){}})()", null)
            webView.onPause()
        }
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        audio?.onStart()
        microphonePermissionResult?.let { granted ->
            microphonePermissionResult = null
            val callback = microphoneReply; microphoneReply = null
            callback?.invoke(granted)
        }
        if (::webView.isInitialized && !destroyed) {
            webView.onResume()
            applyFullscreenState()
            evaluate("window.NotejectNativeReader?.drain()")
        }
    }

    override fun onDestroy() {
        readerSavedUI?.dismiss();readerSavedUI=null
        readerComposerUI?.dismiss();readerComposerUI=null
        destroyed = true
        quickActions?.setReady(false)
        microphoneReply?.invoke(false); microphoneReply = null; microphonePermissionResult = null
        audio?.close(); audio = null
        readerFullscreen = false
        if (fullscreenView != null) closeFullscreen() else applyFullscreenState()
        fileCallback?.onReceiveValue(null); fileCallback = null
        network.shutdownNow(); exportWorker.shutdownNow()
        synchronized(exportLock) {
            currentExport?.let { runCatching { it.output?.close() }; if (it.deleteAfter) it.file.delete() }
            currentExport = null
        }
        webView.removeJavascriptInterface("NotejectAndroid")
        readerFiles.closeAll()
        (webView.parent as? FrameLayout)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    inner class AndroidBridge {
        @JavascriptInterface fun getAppVersion(): String = BuildConfig.VERSION_NAME
        @JavascriptInterface fun setAppLanguage(language: String, translationsJson: String): Boolean = runCatching {
            ReaderLanguage.update(language, translationsJson); true
        }.getOrDefault(false)
        @JavascriptInterface fun prepareNativeReader(optionsJson: String): String = runCatching {
            check(!nativeReaderOpen.get()) { "Close the current Reader first." }
            require(optionsJson.length <= 10_000) { "Invalid Reader request." }; readerFiles.prepare(optionsJson)
        }.getOrElse { JSONObject().put("error", it.message ?: "Could not prepare this PDF.").toString() }
        @JavascriptInterface fun writeNativeReaderChunk(uploadId: String, base64: String): Boolean = runCatching { readerFiles.writeChunk(uploadId, base64) }.getOrDefault(false)
        @JavascriptInterface fun finishNativeReaderUpload(uploadId: String): String = runCatching { readerFiles.finishUpload(uploadId) }.getOrElse { JSONObject().put("error", it.message ?: "The PDF transfer is incomplete.").toString() }
        @JavascriptInterface fun cancelNativeReaderUpload(uploadId: String) { readerFiles.cancelUpload(uploadId) }
        @JavascriptInterface fun forgetNativeReaderDocument(documentId: String): Boolean = runCatching { readerFiles.forgetDocument(documentId); true }.getOrDefault(false)
        @JavascriptInterface fun getNativeReaderEvents(): String = NativeReaderEvents.pending(this@MainActivity)
        @JavascriptInterface fun readNativeReaderCapture(id: String, offset: Long): String = runCatching {
            NativeReaderCaptures.read(this@MainActivity, id, offset).toString()
        }.getOrElse { JSONObject().put("error", it.message ?: "Reader capture unavailable").toString() }
        @JavascriptInterface fun readNativeReaderTextIndex(key: String, offset: Long): String = runCatching {
            NativeReaderTextIndex.read(this@MainActivity, key, offset).toString()
        }.getOrElse { if (it is java.io.FileNotFoundException) JSONObject().put("missing", true).toString() else JSONObject().put("error", it.message ?: "Text index unavailable.").toString() }
        @JavascriptInterface fun acknowledgeNativeReaderEvents(idsJson: String): Boolean = runCatching { NativeReaderEvents.acknowledge(this@MainActivity, idsJson); true }.getOrDefault(false)
        @JavascriptInterface fun openReaderPassageComposer(optionsJson:String):String=runCatching {
            require(optionsJson.length<=2_000_000 && !destroyed) { "Invalid passage request." }
            val options=JSONObject(optionsJson);val requestId=options.getString("requestId");val documentId=options.getString("documentId")
            require(requestId.length in 1..200 && documentId.length in 1..200) { "Invalid Reader identity." }
            runOnUiThread {
                if(!destroyed) {
                    readerComposerUI?.dismiss()
                    fun emit(action:String,fields:JSONObject=JSONObject()) { evaluate("window.__notejectReaderComposerResult?.("+JSONObject().put("requestId",requestId).put("documentId",documentId).put("action",action).put("fields",fields).toString()+")") }
                    readerComposerUI=ReaderPassageComposerUI(this@MainActivity,NativeReaderTheme.read(options.optJSONObject("uiTheme"))).open(options,
                        onSave={ fields->emit("save",fields);true },onCancel={emit("close")},onDraft={ fields->emit("draft",fields) })
                }
            }
            JSONObject().put("ok",true).toString()
        }.getOrElse { JSONObject().put("error",it.message ?: "Passage form could not open.").toString() }

        @JavascriptInterface fun openReaderSavedItems(optionsJson: String): String = runCatching {
            require(optionsJson.length <= 8_000_000 && !destroyed) { "Invalid Reader request." }
            val options=JSONObject(optionsJson);val requestId=options.getString("requestId")
            require(requestId.length in 1..200 && options.optString("documentId").length in 1..200) { "Invalid Reader identity." }
            val bookmarks=options.optJSONArray("bookmarks") ?: JSONArray();val passages=options.optJSONArray("passages") ?: JSONArray()
            require(bookmarks.length()+passages.length() <= 5000) { "Too many saved items to display at once." }
            runOnUiThread {
                if(!destroyed) {
                    readerSavedUI?.dismiss()
                    readerSavedUI=ReaderSavedPassagesUI(this@MainActivity,NativeReaderTheme.read(options.optJSONObject("uiTheme"))) { action,bookmark,item ->
                        val result=JSONObject().put("requestId",requestId).put("documentId",options.optString("documentId")).put("action",action).put("bookmark",bookmark).put("id",item.optString("id"))
                        evaluate("window.__notejectReaderSavedResult?.("+result.toString()+")");true
                    }.also { it.open(bookmarks,passages) }
                }
            }
            JSONObject().put("ok",true).toString()
        }.getOrElse { JSONObject().put("error",it.message ?: "Saved Reader items could not open.").toString() }

        @JavascriptInterface fun openNativeReader(optionsJson: String): String = runCatching {
            require(optionsJson.length <= 8_000_000 && !destroyed) { "Invalid Reader launch." }
            check(nativeReaderOpen.compareAndSet(false, true)) { "Close the current Reader first." }
            try {
                val options = JSONObject(optionsJson)
                require(options.optString("documentId").length in 1..200) { "Invalid document identity." }
                val documentType = options.optString("documentType", "pdf")
                require(documentType in setOf("pdf", "djvu")) { "Unsupported native Reader format." }
                if (!options.isNull("fileKey") && options.optString("fileKey").isNotBlank()) options.put("localPath", readerFiles.localFile(options.getString("fileKey"), documentType).absolutePath)
                else {
                    val uri = readerFiles.approvedSourceUri(options.optString("sourceUri")) ?: error("The document source has expired. Open it again from Documents.")
                    options.put("sourceUri", uri.toString()); options.remove("localPath")
                }
                val launchDirectory = File(cacheDir, "native-reader-launch").apply { mkdirs() }
                val launchFile = File(launchDirectory, java.util.UUID.randomUUID().toString() + ".json")
                launchFile.writeText(options.toString(), Charsets.UTF_8)
                nativeReaderSession = JSONObject().put("type", "closed").put("documentId", options.optString("documentId")).put("requestId", options.optString("requestId"))
                nativeReaderLaunchFile = launchFile
                runOnUiThread {
                    runCatching { nativeReaderLauncher.launch(Intent(this@MainActivity, NativeReaderActivity::class.java).putExtra("optionsPath", launchFile.absolutePath)) }
                        .onFailure { error ->
                            nativeReaderOpen.set(false); launchFile.delete()
                            NativeReaderEvents.enqueue(this@MainActivity, JSONObject().put("type", "error").put("documentId", options.optString("documentId")).put("requestId", options.optString("requestId")).put("message", error.message ?: "Could not start the Reader."))
                            evaluate("window.NotejectNativeReader?.drain()")
                        }
                }
                JSONObject().put("ok", true).toString()
            } catch (error: Throwable) { nativeReaderOpen.set(false); throw error }
        }.getOrElse { JSONObject().put("error", it.message ?: "Could not open the Reader.").toString() }
        @JavascriptInterface fun getPendingQuickAction(): String = quickActions?.pending().orEmpty()
        @JavascriptInterface fun acknowledgeQuickAction(id: String): Boolean = quickActions?.acknowledge(id) ?: false
        @JavascriptInterface fun setQuickActionsReady(ready: Boolean) { quickActions?.setReady(ready) }
        @JavascriptInterface fun audioRequest(requestId: String, action: String, optionsJson: String) {
            if (destroyed) return
            if (!requestId.matches(Regex("^[a-zA-Z0-9_-]{1,100}$")) || optionsJson.length > 1000000) return
            val manager = audio ?: return
            val options = runCatching { JSONObject(optionsJson) }.getOrElse {
                dispatchAudio(JSONObject().put("requestId", requestId).put("ok", false).put("error", "Invalid audio request.")); return
            }
            if (action == "url" || action == "export") {
                try {
                    network.execute {
                        try {
                            val recordingId = options.optString("id")
                            manager.recordingFile(recordingId)
                            if (action == "export") exportAudio(requestId, recordingId, options.optString("name", "Recording.wav"))
                            else dispatchAudio(JSONObject().put("requestId", requestId).put("action", action).put("ok", true).put("url", "https://appassets.androidplatform.net/recordings/$recordingId.wav"))
                        } catch (error: Exception) {
                            dispatchAudio(JSONObject().put("requestId", requestId).put("action", action).put("ok", false).put("error", error.message ?: "This recording is unavailable."))
                        }
                    }
                } catch (_: RejectedExecutionException) { dispatchAudio(JSONObject().put("requestId", requestId).put("ok", false).put("error", "Reopen noteject to access this recording.")) }
                return
            }
            if (action == "transcribe" && options.optString("mode") != "device") {
                dispatchAudio(JSONObject().put("requestId", requestId).put("ok", false).put("error", "Online transcription is not available here. Choose on-device transcription.").put("code", "managed_transcription_unavailable"))
            } else manager.request(requestId, action, optionsJson)
        }
        @JavascriptInterface fun apiRequest(path: String, method: String, body: String, callbackId: String) {
            if (destroyed) return
            try {
                network.execute {
                    val (result, status) = runCatching { handleApi(path, method, body) to 200 }
                        .getOrElse { JSONObject().put("error", it.message ?: "Request failed").toString() to 400 }
                    evaluate("window.__notejectAndroidResponse?.(${JSONObject.quote(callbackId)},${JSONObject.quote(result)},$status)")
                }
            } catch (_: RejectedExecutionException) { evaluate("window.__notejectAndroidResponse?.(${JSONObject.quote(callbackId)},'{\"error\":\"Android service closed.\"}',503)") }
        }
        @JavascriptInterface fun exitApp() { runOnUiThread { finish() } }
        @JavascriptInterface fun isKeyboardVisible(): Boolean = keyboardVisible
        @JavascriptInterface fun setReaderFullscreen(enabled: Boolean) {
            runOnUiThread {
                if (!destroyed) {
                    readerFullscreen = enabled
                    applyFullscreenState()
                }
            }
        }
        @JavascriptInterface fun openExternal(url: String) { runCatching { this@MainActivity.openExternal(Uri.parse(url)) } }
        @JavascriptInterface fun getSaveFolderName(): String = activityPrefs.getString("save_folder_name", "").orEmpty()
        @JavascriptInterface fun chooseSaveFolder(callbackId: String): String {
            if (!callbackId.matches(Regex("^[a-zA-Z0-9_-]{1,100}$"))) return "Invalid folder request."
            runOnUiThread {
                if (destroyed) { sendSaveFolderResult(callbackId, "error", "Noteject is closing."); return@runOnUiThread }
                if (saveFolderRequestId != null) { sendSaveFolderResult(callbackId, "error", "A folder picker is already open."); return@runOnUiThread }
                saveFolderRequestId = callbackId
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
                    activityPrefs.getString("save_folder_uri", null)?.let { raw ->
                        runCatching { Uri.parse(raw) }.getOrNull()?.let { putExtra(DocumentsContract.EXTRA_INITIAL_URI, it) }
                    }
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
                }
                runCatching { saveFolderPicker.launch(intent) }.onFailure { error ->
                    saveFolderRequestId = null
                    sendSaveFolderResult(callbackId, "error", error.message ?: "No Android folder picker is available.")
                }
            }
            return ""
        }
        @JavascriptInterface fun clearSaveFolder(): Boolean {
            val raw = activityPrefs.getString("save_folder_uri", null)
            activityPrefs.edit().remove("save_folder_uri").remove("save_folder_name").apply()
            if (!raw.isNullOrBlank()) runCatching {
                contentResolver.releasePersistableUriPermission(Uri.parse(raw), Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            }
            return true
        }

        // The file crosses the WebView bridge in bounded chunks, never as one large string.
        @JavascriptInterface fun beginExport(id: String, name: String, mime: String, size: Long): String = synchronized(exportLock) {
            if (destroyed) return@synchronized "The app is closing."
            if (currentExport != null) return@synchronized "Finish or cancel the current save first."
            if (!id.matches(Regex("^[a-zA-Z0-9_-]{1,100}$")) || size < 0 || size > 536870912L) return@synchronized "This file exceeds the 512 MB export limit."
            runCatching {
                val safeName = name.substringAfterLast('/').substringAfterLast('\\').replace(Regex("[\\p{Cntrl}<>:\"|?*]"), "_").trim().take(180).ifBlank { "noteject-export" }
                val safeMime = mime.substringBefore(';').takeIf { it.matches(Regex("^[a-zA-Z0-9.+_-]+/[a-zA-Z0-9.+_-]+$")) } ?: "application/octet-stream"
                val directory = File(cacheDir, "exports").apply { mkdirs() }
                val temp = File.createTempFile("noteject-", ".tmp", directory)
                currentExport = ExportFile(id, safeName, safeMime, size, temp, FileOutputStream(temp))
                activityPrefs.edit().putString("pending_export", temp.name).commit()
                ""
            }.getOrElse { it.message ?: "Could not prepare this file for saving." }
        }

        @JavascriptInterface fun appendExport(id: String, chunk: String): String = synchronized(exportLock) {
            val item = currentExport?.takeIf { it.id == id && it.output != null } ?: return@synchronized "The save is no longer active."
            runCatching {
                require(chunk.length <= 349528) { "File chunk is too large." }
                val bytes = Base64.decode(chunk, Base64.NO_WRAP)
                require(item.written + bytes.size <= item.size) { "The file size changed during saving." }
                item.output!!.write(bytes); item.written += bytes.size
                ""
            }.getOrElse { it.message ?: "Could not prepare the file." }
        }

        @JavascriptInterface fun completeExport(id: String): String = synchronized(exportLock) {
            val item = currentExport?.takeIf { it.id == id && it.output != null } ?: return@synchronized "The save is no longer active."
            if (item.written != item.size) return@synchronized "The file transfer was incomplete."
            runCatching {
                item.output!!.close(); item.output = null
                runOnUiThread {
                    if (!destroyed) runCatching {
                        savePicker.launch(createSaveIntent(item))
                    }.onFailure { finishExport(item, "error", "No Android file manager is available for saving.") }
                }
                ""
            }.getOrElse { it.message ?: "Could not open Save file." }
        }

        @JavascriptInterface fun cancelExport(id: String) {
            val item = synchronized(exportLock) { currentExport?.takeIf { it.id == id } } ?: return
            finishExport(item, "cancelled", "Save cancelled")
        }

        private fun handleApi(path: String, method: String, body: String): String {
            val route = path.substringBefore('?')
            if (route == "/api/key-status") return JSONObject().put("configured", false).put("managed", true).toString()
            if (route in setOf("/api/key", "/api/models", "/api/ask")) throw IllegalStateException("Sign in to your Noteject account to use Noteject AI. Personal API keys are not supported.")
            if (route == "/api/file-status") return JSONObject().put("fileStorage", true).put("path", File(filesDir, "projects").absolutePath).put("storageBrowserVersion", 2).toString()
            if (route == "/api/choose-folder") return JSONObject().put("cancelled", true).toString()
            if (route == "/api/storage-path") return JSONObject().put("ok", true).put("path", File(filesDir, "projects").absolutePath).toString()
            if (route == "/api/projects" && method.equals("POST", true)) {
                val project = JSONObject(body).optString("project")
                val directory = projectDirectory(project)
                check(directory.mkdirs() || directory.isDirectory) { "Could not create the project on this device." }
                return JSONObject().put("ok", true).put("project", project).toString()
            }
            if (route == "/api/project-notes" && method.uppercase() in listOf("POST", "DELETE")) {
                val note = JSONObject(body)
                val project = projectDirectory(note.optString("project"))
                val noteId = note.optString("id")
                require(noteId.matches(Regex("^[a-zA-Z0-9_-]{1,100}$"))) { "Invalid project note ID." }
                val notes = File(project, "notes")
                val target = File(notes, "$noteId.md")
                if (method.equals("DELETE", true)) {
                    target.delete()
                    return JSONObject().put("ok", true).toString()
                }
                check(notes.mkdirs() || notes.isDirectory) { "Could not create the project notes folder." }
                val title = note.optString("title", "Untitled note").replace(Regex("[\\r\\n]+"), " ").take(500)
                target.writeText("# $title\n\n${note.optString("content")}\n", Charsets.UTF_8)
                return JSONObject().put("ok", true).toString()
            }
            throw IllegalArgumentException("Unsupported Android service request.")
        }

        private fun projectDirectory(project: String): File {
            require(project.matches(Regex("^[a-zA-Z0-9_-]{1,100}$"))) { "Invalid project storage name." }
            val root = File(filesDir, "projects").canonicalFile
            val directory = File(root, project).canonicalFile
            require(directory.parentFile == root) { "Invalid project storage path." }
            return directory
        }


    }
}
