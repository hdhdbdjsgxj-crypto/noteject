package com.noteject.app

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import org.json.JSONObject

/** Colors are resolved by the workspace before opening the native PDF surface. */
internal data class NativeReaderTheme(
    val dark: Boolean,
    val background: Int,
    val panel: Int,
    val raised: Int,
    val line: Int,
    val ink: Int,
    val muted: Int,
    val accent: Int,
    val accentInk: Int
) {
    val destructiveFill get() = Color.parseColor("#302126")
    val destructiveInk get() = Color.parseColor("#E6A1AA")

    fun destructiveTouch(context: Context): Drawable = RippleDrawable(
        ColorStateList.valueOf(Color.parseColor("#33E6A1AA")),
        surface(context, destructiveFill, 12).apply {
            setStroke(context.resources.displayMetrics.density.toInt().coerceAtLeast(1), Color.parseColor("#69434B"))
        }, surface(context, Color.WHITE, 12)
    )

    fun surface(context: Context, fill: Int = raised, radius: Int = 12, border: Boolean = false) = GradientDrawable().apply {
        setColor(fill)
        cornerRadius = radius * context.resources.displayMetrics.density
        if (border) setStroke(context.resources.displayMetrics.density.toInt().coerceAtLeast(1), line)
    }

    fun touch(context: Context, fill: Int = Color.TRANSPARENT, radius: Int = 12): Drawable = RippleDrawable(
        ColorStateList.valueOf((accent and 0x00ffffff) or 0x33000000),
        surface(context, fill, radius), surface(context, Color.WHITE, radius)
    )

    companion object {
        fun read(json: JSONObject?): NativeReaderTheme {
            val dark = json?.optString("mode", "dark") != "light"
            val defaults = if (dark) arrayOf("#111722", "#1b2535", "#273349", "#36445b", "#e9edf5", "#aebcd4", "#c8afff", "#281c3b")
                else arrayOf("#f4f5f9", "#ffffff", "#ebeef5", "#d9deea", "#252936", "#657087", "#7155b1", "#ffffff")
            val keys = arrayOf("background", "panel", "raised", "line", "ink", "muted", "accent", "accentInk")
            val values = keys.mapIndexed { index, key -> parseColor(json?.optString(key), Color.parseColor(defaults[index])) }
            return NativeReaderTheme(dark, values[0], values[1], values[2], values[3], values[4], values[5], values[6], values[7])
        }

        // Computed CSS colors normally arrive as rgb()/rgba(), while fallbacks use hex.
        private fun parseColor(value: String?, fallback: Int): Int = runCatching {
            val color = value?.trim().orEmpty()
            if (color.startsWith("rgb")) {
                val components = color.substringAfter('(').substringBefore(')').split(Regex("[, /]+"))
                    .filter { it.isNotBlank() }.map { it.toFloat() }
                require(components.size >= 3)
                Color.rgb(components[0].toInt().coerceIn(0, 255), components[1].toInt().coerceIn(0, 255), components[2].toInt().coerceIn(0, 255))
            } else Color.parseColor(color)
        }.getOrDefault(fallback)
    }
}

/** The same simple, rounded outline symbols used by the workspace Reader dock. */
internal class NativeReaderIcon(private val name: String, color: Int, density: Float, private val selected: Boolean = false) : Drawable() {
    private val size = (24 * density + .5f).toInt()
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        this.color = color; strokeWidth = 1.8f; style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
    }

    override fun getIntrinsicWidth() = size
    override fun getIntrinsicHeight() = size
    override fun getOpacity() = PixelFormat.TRANSLUCENT
    override fun setAlpha(alpha: Int) { paint.alpha = alpha; invalidateSelf() }
    override fun setColorFilter(colorFilter: ColorFilter?) { paint.colorFilter = colorFilter; invalidateSelf() }
    override fun draw(canvas: Canvas) {
        val checkpoint = canvas.save()
        canvas.translate(bounds.left.toFloat(), bounds.top.toFloat())
        canvas.scale(bounds.width() / 24f, bounds.height() / 24f)
        fun line(vararg points: Float) {
            val path = Path().apply { moveTo(points[0], points[1]); for (i in 2 until points.size step 2) lineTo(points[i], points[i + 1]) }
            canvas.drawPath(path, paint)
        }
        when (name) {
            "back" -> { line(15f, 5f, 8f, 12f, 15f, 19f); line(8f, 12f, 21f, 12f) }
            "previous" -> line(14f, 6f, 8f, 12f, 14f, 18f)
            "next" -> line(10f, 6f, 16f, 12f, 10f, 18f)
            "minus" -> line(5f, 12f, 19f, 12f)
            "close" -> { line(6f, 6f, 18f, 18f); line(18f, 6f, 6f, 18f) }
            "plus" -> { line(5f, 12f, 19f, 12f); line(12f, 5f, 12f, 19f) }
            "find" -> { canvas.drawCircle(10.5f, 10.5f, 6.5f, paint); line(16f, 16f, 21f, 21f) }
            "menu" -> for (y in arrayOf(5f, 12f, 19f)) { paint.style = Paint.Style.FILL; canvas.drawCircle(12f, y, 1.5f, paint); paint.style = Paint.Style.STROKE }
            "contents" -> for (y in arrayOf(5f, 12f, 19f)) { line(8f, y, 20f, y); line(3f, y, 3.1f, y) }
            "bookmark" -> {
                val path = Path().apply { moveTo(6f, 3f); lineTo(18f, 3f); lineTo(18f, 21f); lineTo(12f, 17f); lineTo(6f, 21f); close() }
                if (selected) paint.style = Paint.Style.FILL
                canvas.drawPath(path, paint); paint.style = Paint.Style.STROKE
            }
            "passage" -> { line(4f, 16f, 3f, 21f, 8f, 20f, 21f, 7f, 17f, 3f, 4f, 16f); line(15f, 5f, 19f, 9f); line(4f, 16f, 8f, 20f) }
            "notes" -> { canvas.drawRoundRect(5f, 3f, 19f, 21f, 2f, 2f, paint); line(8f, 8f, 16f, 8f); line(8f, 12f, 16f, 12f); line(8f, 16f, 13f, 16f) }
            "view" -> { line(4f, 6f, 20f, 6f); line(4f, 12f, 20f, 12f); line(4f, 18f, 20f, 18f); for ((x, y) in arrayOf(9f to 6f, 15f to 12f, 9f to 18f)) { paint.style = Paint.Style.FILL; canvas.drawCircle(x, y, 2.5f, paint); paint.style = Paint.Style.STROKE } }
            "fullscreen" -> { line(9f, 3f, 3f, 3f, 3f, 9f); line(15f, 3f, 21f, 3f, 21f, 9f); line(3f, 15f, 3f, 21f, 9f, 21f); line(21f, 15f, 21f, 21f, 15f, 21f) }
        }
        canvas.restoreToCount(checkpoint)
    }
}
