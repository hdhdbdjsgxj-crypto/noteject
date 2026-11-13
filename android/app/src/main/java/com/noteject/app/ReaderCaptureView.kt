package com.noteject.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.view.MotionEvent
import android.view.View
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/** Drag an area on a whole-page preview; coordinates are independent of preview resolution. */
internal class ReaderCaptureView(context: Context, private val bitmap: Bitmap, private val accent: Int) : View(context) {
    private val paper = RectF()
    private val selected = RectF(.08f, .25f, .92f, .55f)
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private var downX = 0f
    private var downY = 0f
    private var moving = false
    private var original = RectF()
    init { contentDescription = ReaderLanguage.text("Page capture. Drag to select an equation or image. Drag inside the selection to move it."); isFocusable = true }
    fun region() = RectF(selected)
    fun wholePage() { selected.set(0f, 0f, 1f, 1f); invalidate() }
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val scale = min(width.toFloat() / bitmap.width, height.toFloat() / bitmap.height)
        val w = bitmap.width * scale; val h = bitmap.height * scale
        paper.set((width-w)/2, (height-h)/2, (width+w)/2, (height+h)/2)
        paint.color = Color.WHITE; paint.style = Paint.Style.FILL
        canvas.drawRect(paper, paint); canvas.drawBitmap(bitmap, null, paper, paint)
        val crop = RectF(paper.left + selected.left*paper.width(), paper.top + selected.top*paper.height(), paper.left + selected.right*paper.width(), paper.top + selected.bottom*paper.height())
        paint.color = 0x88000000.toInt()
        canvas.drawRect(paper.left,paper.top,paper.right,crop.top,paint)
        canvas.drawRect(paper.left,crop.bottom,paper.right,paper.bottom,paint)
        canvas.drawRect(paper.left,crop.top,crop.left,crop.bottom,paint)
        canvas.drawRect(crop.right,crop.top,paper.right,crop.bottom,paint)
        paint.color = accent; paint.style = Paint.Style.STROKE; paint.strokeWidth = 2 * resources.displayMetrics.density
        canvas.drawRect(crop, paint); paint.style = Paint.Style.FILL
        for (x in listOf(crop.left,crop.right)) for (y in listOf(crop.top,crop.bottom)) canvas.drawCircle(x,y,4*resources.displayMetrics.density,paint)
    }
    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (paper.width() <= 0 || paper.height() <= 0) return false
        val x = ((event.x-paper.left)/paper.width()).coerceIn(0f,1f)
        val y = ((event.y-paper.top)/paper.height()).coerceIn(0f,1f)
        when(event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                parent.requestDisallowInterceptTouchEvent(true); downX=x; downY=y; original=RectF(selected)
                val inset = min(.025f, min(selected.width(),selected.height())/4)
                moving = x > selected.left+inset && x < selected.right-inset && y > selected.top+inset && y < selected.bottom-inset
                if (!moving) selected.set(x,y,x,y)
            }
            MotionEvent.ACTION_MOVE -> {
                if(moving) {
                    val dx=(x-downX).coerceIn(-original.left,1-original.right)
                    val dy=(y-downY).coerceIn(-original.top,1-original.bottom)
                    selected.set(original.left+dx,original.top+dy,original.right+dx,original.bottom+dy)
                } else selected.set(min(downX,x),min(downY,y),max(downX,x),max(downY,y))
                invalidate()
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                parent.requestDisallowInterceptTouchEvent(false)
                if(abs(selected.width()) < .01f || abs(selected.height()) < .01f) selected.set(original)
                performClick(); invalidate()
            }
        }
        return true
    }
    override fun performClick(): Boolean { super.performClick(); return true }
}
