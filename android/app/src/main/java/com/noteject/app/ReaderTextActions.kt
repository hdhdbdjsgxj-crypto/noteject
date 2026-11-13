package com.noteject.app

import android.view.Menu
import android.view.MenuItem

/** Shared floating selection menu; engines keep only their format-specific extensions. */
internal object ReaderTextActions {
    const val CLEAR = 2
    const val EXTEND = 7102
    const val THROUGH_PAGE = 7103
    const val IMAGE = 7101
    fun populate(menu: Menu, paged: Boolean, extend: Boolean = paged) {
        menu.clear()
        menu.add(0,ReaderExternalActions.TRANSLATE,0,ReaderLanguage.text("Translate")).setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM)
        menu.add(0,ReaderExternalActions.SAVE_PASSAGE,1,ReaderLanguage.text("Save passage")).setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM)
        menu.add(0,android.R.id.copy,2,ReaderLanguage.text("Copy")).setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM)
        menu.add(0,ReaderExternalActions.SHARE,3,ReaderLanguage.text("Share"))
        menu.add(0,android.R.id.selectAll,4,ReaderLanguage.text("Select all"))
        menu.add(0,CLEAR,5,ReaderLanguage.text("Clear selection"))
        if(extend) menu.add(0,EXTEND,6,ReaderLanguage.text(if(paged) "Extend to next page" else "Extend to next chapter"))
        if(paged) {
            menu.add(0,THROUGH_PAGE,7,ReaderLanguage.text("Select through page…"))
            menu.add(0,IMAGE,8,ReaderLanguage.text("Save as image"))
        }
    }
}
