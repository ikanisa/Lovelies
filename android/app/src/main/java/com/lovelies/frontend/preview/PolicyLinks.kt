package com.lovelies.frontend.preview

import android.content.Context
import android.content.Intent
import android.net.Uri
import java.net.URI

/** Policy addresses are release inputs; a local draft is never presented as a published policy. */
internal object PolicyLinks {
    fun valid(raw: String): Boolean=runCatching {
        val url=URI(raw)
        raw.isNotBlank() && url.scheme=="https" && !url.host.isNullOrBlank() && url.userInfo==null &&
            url.port in setOf(-1,443) && url.query==null && url.fragment==null && url.normalize()==url
    }.getOrDefault(false)

    fun open(context: Context,raw: String): Boolean {
        if(!valid(raw))return false
        return runCatching {
            context.startActivity(Intent(Intent.ACTION_VIEW,Uri.parse(raw)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));true
        }.getOrDefault(false)
    }
}
