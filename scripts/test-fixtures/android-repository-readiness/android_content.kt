package android.content

import android.net.Uri
import java.io.InputStream
import java.io.OutputStream

/** Compile-only platform boundary. Repository tests inject vault and network
 * and must not reach these Android document-provider methods. */
open class Context {
    open val applicationContext:Context get()=this
    open val contentResolver:ContentResolver get()=error("Android platform unavailable in host fixture")
    open fun getString(id:Int):String=error("Android resources unavailable in host fixture")
}
open class ContentResolver {
    open fun getType(uri:Uri):String?=error("Android platform unavailable in host fixture")
    open fun openInputStream(uri:Uri):InputStream?=error("Android platform unavailable in host fixture")
    open fun openOutputStream(uri:Uri,mode:String):OutputStream?=error("Android platform unavailable in host fixture")
}
