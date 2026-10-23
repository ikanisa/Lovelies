package com.lovelies.frontend.preview

import android.Manifest
import android.content.ClipData
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import java.io.File

/** No re-encoding: the server-authorized original is written verbatim. */
internal object OriginalMedia {
    data class Format(val mime: String,val extension: String)
    fun format(bytes: ByteArray): Format {
        fun starts(vararg signature: Int)=bytes.size>=signature.size && signature.indices.all { (bytes[it].toInt() and 255)==signature[it] }
        return when {
            starts(0xff,0xd8,0xff)->Format("image/jpeg","jpg")
            starts(0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a)->Format("image/png","png")
            bytes.size>=12 && bytes.copyOfRange(0,4).toString(Charsets.US_ASCII)=="RIFF" && bytes.copyOfRange(8,12).toString(Charsets.US_ASCII)=="WEBP"->Format("image/webp","webp")
            bytes.size>=6 && bytes.copyOfRange(0,6).toString(Charsets.US_ASCII) in setOf("GIF87a","GIF89a")->Format("image/gif","gif")
            else->throw LiveFailure("source_unverified")
        }
    }
    fun hasSavePermission(context: Context)=Build.VERSION.SDK_INT>=29 || ContextCompat.checkSelfPermission(context,Manifest.permission.WRITE_EXTERNAL_STORAGE)==PackageManager.PERMISSION_GRANTED
    fun save(context: Context,id: String,bytes: ByteArray,current: ()->Unit): Uri {
        if(!hasSavePermission(context))throw LiveFailure("save_permission_required")
        val format=format(bytes);val values=ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME,"lovelies-${NativeProtocol.id(id)}.${format.extension}")
            put(MediaStore.Images.Media.MIME_TYPE,format.mime)
            if(Build.VERSION.SDK_INT>=29) { put(MediaStore.Images.Media.RELATIVE_PATH,Environment.DIRECTORY_PICTURES+"/Lovelies");put(MediaStore.Images.Media.IS_PENDING,1) }
        }
        current()
        val uri=context.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,values) ?: throw LiveFailure("save_failed")
        try {
            context.contentResolver.openOutputStream(uri,"w")?.use { stream->stream.write(bytes);stream.flush() } ?: throw LiveFailure("save_failed")
            current()
            if(Build.VERSION.SDK_INT>=29 && context.contentResolver.update(uri,ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING,0) },null,null)!=1)throw LiveFailure("save_failed")
            current();return uri
        } catch(problem: Exception) { runCatching { context.contentResolver.delete(uri,null,null) };throw problem }
    }
    fun share(context: Context,id: String,bytes: ByteArray,current: ()->Unit): Intent {
        prune(context)
        val format=format(bytes);val directory=File(context.cacheDir,"shared-originals").apply { if(!isDirectory && !mkdirs())throw LiveFailure("save_failed") }
        val target=File(directory,"lovelies-${NativeProtocol.id(id)}-${java.util.UUID.randomUUID()}.${format.extension}")
        try {
            target.outputStream().use { it.write(bytes);it.flush() };current()
            val uri=FileProvider.getUriForFile(context,"${context.packageName}.camera-files",target)
            return Intent(Intent.ACTION_SEND).setType(format.mime).putExtra(Intent.EXTRA_STREAM,uri)
                .apply { clipData=ClipData.newUri(context.contentResolver,"Lovelies photo",uri);addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION) }
        } catch(problem: Exception) { target.delete();throw problem }
    }
    fun prune(context: Context,all: Boolean=false) { File(context.cacheDir,"shared-originals").listFiles()?.forEach { if(all || System.currentTimeMillis()-it.lastModified()>15*60*1000)it.delete() } }
}
