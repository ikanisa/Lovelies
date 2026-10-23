package com.lovelies.frontend.preview

import java.time.Instant

/** The API sorts by created_at descending. Search and source filters are server scoped. */
data class LibraryCursor(val beforeAt: String,val beforeId: String) {
    fun wire(): WireObject=mapOf("before_at" to beforeAt,"before_id" to beforeId)
    companion object {
        fun parse(raw: Any?): LibraryCursor? {
            if(raw==null)return null
            val value=NativeProtocol.obj(raw)
            val timestamp=NativeProtocol.text(value["before_at"],64)
            runCatching { Instant.parse(timestamp) }.getOrElse { throw LiveFailure("invalid_cursor") }
            return LibraryCursor(timestamp,NativeProtocol.id(value["before_id"]))
        }
    }
}
data class LibraryPage(val items: List<LivePhoto>,val next: LibraryCursor?) {
    companion object {
        fun parse(value: WireObject,previous: LibraryCursor?=null): LibraryPage {
            val items=NativeProtocol.rows(value["items"]).map(LivePhoto::parse)
            if(items.map { it.id }.toSet().size!=items.size)throw LiveFailure("invalid_response")
            val next=LibraryCursor.parse(value["next_cursor"])
            if(next!=null && next==previous)throw LiveFailure("gallery_cursor_stalled")
            return LibraryPage(items,next)
        }
    }
}
data class GalleryPosition(val item: Int=0,val offset: Int=0) {
    fun wire(): WireObject=mapOf("item" to item,"offset" to offset)
    companion object { fun parse(raw: Any?): GalleryPosition {
        if(raw==null)return GalleryPosition()
        val value=NativeProtocol.obj(raw)
        return GalleryPosition(NativeProtocol.integer(value["item"],0,1000000).toInt(),NativeProtocol.integer(value["offset"],0,1000000).toInt())
    } }
}

internal fun gallerySource(category: String)=when(category) { "Contributed"->"contributions";"Received"->"received";else->"all" }
internal fun adjacentPhoto(rows: List<LivePhoto>,current: String,delta: Int): LivePhoto? {
    val index=rows.indexOfFirst { it.id==current }
    if(index<0 || delta !in setOf(-1,1))return null
    return rows.getOrNull(index+delta)
}

/** Persisted UI values are accepted only for the currently authenticated account. */
internal fun ownsUiState(value: Any?,account: String?): Boolean=(value as? Map<*,*>)?.get("account")==account && account!=null
