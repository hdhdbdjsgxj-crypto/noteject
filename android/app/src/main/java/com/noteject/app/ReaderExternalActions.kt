package com.noteject.app

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import java.util.Locale

/** External actions run only after an explicit selection-menu tap. */
internal object ReaderExternalActions {
    const val TRANSLATE = 0x4e4a01
    const val SAVE_PASSAGE = 0x4e4a02
    const val SHARE = 0x4e4a03
    private const val GOOGLE_TRANSLATE = "com.google.android.apps.translate"

    fun translate(activity: Activity, selection: String) {
        val text = selection.trim()
        if (text.isEmpty()) { message(activity, "Select text in the document first."); return }
        if (text.codePointCount(0, text.length) > 5_000) {
            message(activity, "Select up to 5,000 characters to translate."); return
        }
        val native = Intent(Intent.ACTION_PROCESS_TEXT).setType("text/plain").setPackage(GOOGLE_TRANSLATE)
            .putExtra(Intent.EXTRA_PROCESS_TEXT, text).putExtra(Intent.EXTRA_PROCESS_TEXT_READONLY, true)
        if (launch(activity, native)) return
        val target = Locale.getDefault().language.ifBlank { "en" }
        val uri = Uri.Builder().scheme("https").authority("translate.google.com").path("/")
            .appendQueryParameter("sl", "auto").appendQueryParameter("tl", target)
            .appendQueryParameter("text", text).appendQueryParameter("op", "translate").build()
        if (!launch(activity, Intent(Intent.ACTION_VIEW, uri))) {
            message(activity, "Install Google Translate or a browser to translate this passage.")
        }
    }

    fun share(activity: Activity, selection: String) {
        val text = selection.trim()
        if (text.isEmpty()) { message(activity, "Select text in the document first."); return }
        if (text.length > 200_000) { message(activity, "Select a smaller passage to share."); return }
        val intent = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
        if (!launch(activity, Intent.createChooser(intent, ReaderLanguage.text("Share passage")))) message(activity, "No app is available to share this passage.")
    }

    private fun launch(activity: Activity, intent: Intent): Boolean = try {
        activity.startActivity(intent); true
    } catch (_: ActivityNotFoundException) { false } catch (_: SecurityException) { false }

    private fun message(activity: Activity, text: String) = Toast.makeText(activity, ReaderLanguage.text(text), Toast.LENGTH_LONG).show()
}
