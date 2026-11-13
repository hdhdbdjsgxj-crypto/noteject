package com.noteject.app

import android.app.ActivityOptions
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.os.Build
import android.widget.RemoteViews

/** Widgets open the existing workspace; recording still requires microphone consent. */
abstract class QuickActionWidget : AppWidgetProvider() {
    protected abstract val layout: Int
    protected abstract val action: String

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        for (id in ids) {
            val intent = Intent(context, MainActivity::class.java).apply {
                action = this@QuickActionWidget.action
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            }
            // These explicit, immutable intents are used only by user-tapped
            // launcher widgets. Android 15+ requires a creator-side opt-in.
            val options = if (Build.VERSION.SDK_INT >= 35) ActivityOptions.makeBasic()
                .setPendingIntentCreatorBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED)
                .toBundle() else null
            val launch = PendingIntent.getActivity(context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE, options)
            val views = RemoteViews(context.packageName, layout).apply { setOnClickPendingIntent(R.id.widget_action, launch) }
            manager.updateAppWidget(id, views)
        }
    }
}

class NewNoteWidget : QuickActionWidget() {
    override val layout = R.layout.widget_new_note
    override val action = AndroidQuickActions.NEW_NOTE
}

class NewRecordingWidget : QuickActionWidget() {
    override val layout = R.layout.widget_new_recording
    override val action = AndroidQuickActions.NEW_RECORDING
}
