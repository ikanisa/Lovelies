package com.lovelies.frontend.preview

import java.net.URI

/** A link selects a current server-owned item; it never grants media access. */
data class AppLink(val kind: String,val id: String) {
    companion object {
        fun parse(raw: String,host: String=BuildConfig.LINK_HOST): AppLink?=runCatching {
            val uri=URI(raw)
            if(uri.scheme!="https" || uri.host!=host || uri.port !in setOf(-1,443) || uri.userInfo!=null || uri.query!=null || uri.fragment!=null)return null
            val path=uri.path.split('/').filter(String::isNotEmpty)
            if(path.size!=2 || path[0] !in setOf("requests","notifications"))return null
            AppLink(path[0],NativeProtocol.id(path[1]))
        }.getOrNull()
    }
}
