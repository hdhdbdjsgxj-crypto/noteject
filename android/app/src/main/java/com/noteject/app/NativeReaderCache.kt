package com.noteject.app

import java.io.File

/** Disposable prepared books; original workspace attachments never enter this cache. */
internal class NativeReaderCache(
    directory: File,
    private val budget: Long = 512L * 1024 * 1024,
    private val maxBooks: Int = 64,
    private val freeBytes: () -> Long = { directory.usableSpace }
) {
    private val directory = directory.canonicalFile
    private val owner = Any()
    private fun checked(file: File): File = file.canonicalFile.also {
        require(it.parentFile == directory && it.name.matches(BOOK)) { "Invalid prepared book cache path." }
    }
    fun reserve(file: File) = synchronized(lock) {
        pins.getOrPut(checked(file).path) { mutableSetOf() }.add(owner)
    }
    fun pin(file: File) = synchronized(lock) {
        val book = checked(file)
        check(book.isFile) { "The prepared book is unavailable." }
        reserve(book)
        book.setLastModified(System.currentTimeMillis())
    }
    fun retire(file: File) = synchronized(lock) {
        retired.add(checked(file).path)
        deleteRetired()
    }
    fun releaseAll(trimCache: Boolean = true) = synchronized(lock) {
        for (path in pins.keys.toList()) {
            pins[path]?.remove(owner)
            if (pins[path].isNullOrEmpty()) pins.remove(path)
        }
        deleteRetired()
        if (trimCache) trim()
    }
    fun trim(requiredFree: Long = 0) = synchronized(lock) {
        deleteRetired()
        val books = directory.listFiles()?.filter { it.isFile && it.name.matches(BOOK) }?.sortedBy { it.lastModified() }.orEmpty()
        var bytes = books.sumOf { it.length() }
        var remaining = books.size
        for (book in books) {
            val pressure = freeBytes() < requiredFree
            // Keep one warm large book instead of copying it again on every open.
            if (!pressure && ((bytes <= budget && remaining <= maxBooks) || remaining <= 1)) break
            if (pins.containsKey(book.canonicalPath)) continue
            val size = book.length()
            if (book.delete()) { bytes -= size; remaining-- }
        }
    }
    private fun deleteRetired() {
        for (path in retired.toList()) {
            if (pins.containsKey(path)) continue
            val file = File(path)
            if (!file.exists() || file.delete()) retired.remove(path)
        }
    }
    companion object {
        // Launch host and Reader own separate pins, including during recreation.
        private val lock = Any()
        private val pins = mutableMapOf<String, MutableSet<Any>>()
        private val retired = mutableSetOf<String>()
        private val BOOK = Regex("[a-f0-9]{64}\\.(pdf|djvu)")
    }
}
