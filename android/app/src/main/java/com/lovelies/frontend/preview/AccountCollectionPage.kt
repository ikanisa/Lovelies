package com.lovelies.frontend.preview

/** Opaque cursors describe a list position; they never authorize an account or a stale response. */
internal data class AccountCollectionRequest(val scope: SessionScope,val cursor: String?) {
    fun assertCurrent(current: SessionScope) {
        if(scope.accountId==null || current!=scope)throw LiveFailure("session_changed")
    }
    companion object {
        fun create(scope: SessionScope,cursor: String?,owner: String?,reset: Boolean): AccountCollectionRequest {
            if(scope.accountId==null || !reset && owner!=scope.accountId)throw LiveFailure("collection_account_changed")
            return AccountCollectionRequest(scope,if(reset)null else cursor)
        }
    }
}
internal data class AccountCollectionPage(val items: List<WireObject>,val nextCursor: String?,val total: Long) {
    fun appending(previous: List<WireObject>): List<WireObject> {
        val byId=linkedMapOf<String,WireObject>()
        (previous+items).forEach { byId[NativeProtocol.id(it["id"])]=it }
        return byId.values.toList()
    }
    companion object {
        const val LIMIT=100
        fun request(cursor: String?): WireObject=mapOf("limit" to LIMIT)+(cursor?.let { mapOf("cursor" to it) } ?: emptyMap())
        fun path(base: String,cursor: String?): String {
            if(!base.startsWith('/') || base.startsWith("//") || base.any { it in "?#\\" })throw LiveFailure("invalid_api_path")
            return "$base?limit=$LIMIT"+(cursor?.let { "&cursor="+java.net.URLEncoder.encode(it,"UTF-8") } ?: "")
        }
        fun parse(value: WireObject,key: String="items",requested: String?=null,seen: Set<String> = emptySet()): AccountCollectionPage {
            val items=NativeProtocol.rows(value[key],LIMIT)
            val ids=items.map { NativeProtocol.id(it["id"]) }
            if(ids.toSet().size!=ids.size)throw LiveFailure("collection_page_invalid")
            val page=NativeProtocol.obj(value["page"])
            if(!page.containsKey("next_cursor") || NativeProtocol.integer(page["limit"],1,LIMIT.toLong())!=LIMIT.toLong())throw LiveFailure("collection_page_invalid")
            val total=NativeProtocol.integer(page["total"],items.size.toLong())
            val next=page["next_cursor"]?.let { NativeProtocol.text(it,2048) }
            if(next!=null && (next.isBlank() || next==requested || next in seen || items.isEmpty()))throw LiveFailure("collection_page_invalid")
            if(page.containsKey("has_more") && page["has_more"]!=(next!=null))throw LiveFailure("collection_page_invalid")
            return AccountCollectionPage(items,next,total)
        }
    }
}
