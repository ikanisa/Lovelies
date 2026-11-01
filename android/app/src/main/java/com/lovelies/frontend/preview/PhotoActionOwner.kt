package com.lovelies.frontend.preview

import java.util.UUID

/** User intent survives a permission/Billing activity, but never a new account, session, device or viewer selection.
 * Read epochs are deliberately absent: ON_PAUSE invalidates reads without changing this requested action. */
internal data class PhotoActionContext(val account: String?,val session: String?,val device: String?,val photo: String?,val source: String?,val route: Int)
internal data class PhotoActionOwner private constructor(val id: String,private val context: PhotoActionContext) {
    fun matches(current: PhotoActionContext)=current==context && current.route==12 && !current.account.isNullOrBlank() && !current.session.isNullOrBlank()
    companion object {
        fun create(context: PhotoActionContext): PhotoActionOwner? = if(context.route!=12 || context.account.isNullOrBlank()
            || context.session.isNullOrBlank() || context.photo.isNullOrBlank() || context.source.isNullOrBlank())null
            else PhotoActionOwner(UUID.randomUUID().toString(),context)
    }
}
