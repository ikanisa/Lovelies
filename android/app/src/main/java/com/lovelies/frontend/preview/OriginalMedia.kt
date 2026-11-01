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
import java.io.DataInputStream
import java.io.DataOutputStream
import java.nio.channels.Channels
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.attribute.BasicFileAttributeView
import java.nio.file.attribute.FileTime
import kotlinx.coroutines.delay

/** A displayed preview never outlives the credential that authorized its load.
 * Elapsed time caps creation age even if the wall clock moves backwards. */
internal class PrivatePreviewLease private constructor(
    private val scope: SessionScope,private val token: String,private val sessionExpiry: Long,
    private val expiry: Long,private val createdElapsed: Long,private val deadlineElapsed: Long
) {
    fun remaining(current: SessionScope,actor: LiveCredentials?,now: Long,elapsed: Long): Long {
        if(current!=scope || actor==null || actor.account!=scope.accountId || actor.method!="registered_face" || actor.token!=token ||
            actor.expires!=sessionExpiry || now<0 || now>=expiry || elapsed<createdElapsed || elapsed>=deadlineElapsed)return 0
        return minOf(expiry-now,deadlineElapsed-elapsed)
    }
    companion object {
        const val MAX_AGE_MS=2L*24*60*60*1000
        fun create(scope: SessionScope,actor: LiveCredentials?,now: Long,elapsed: Long,additionalExpiry: Long=Long.MAX_VALUE): PrivatePreviewLease? {
            if(scope.accountId==null || actor==null || actor.account!=scope.accountId || actor.method!="registered_face" || now<0 || elapsed<0)return null
            val expiry=minOf(actor.expires,additionalExpiry)
            if(expiry<=now)return null
            val age=minOf(MAX_AGE_MS,expiry-now)
            val deadline=if(elapsed>Long.MAX_VALUE-age)Long.MAX_VALUE else elapsed+age
            return PrivatePreviewLease(scope,actor.token,actor.expires,expiry,elapsed,deadline)
        }
    }
}

/** The actual Compose consumer waits on this deadline, rather than requiring a
 * new request/recomposition to discover that an offline preview has expired. */
internal suspend fun awaitPrivatePreviewExpiry(
    lease: PrivatePreviewLease,current: ()->SessionScope,actor: ()->LiveCredentials?,
    wallClock: ()->Long,elapsedClock: ()->Long,sleep: suspend (Long)->Unit={ delay(it) }
) {
    while(true) {
        val remaining=lease.remaining(current(),actor(),wallClock(),elapsedClock())
        if(remaining<=0)return
        sleep(remaining)
    }
}

/** Only the app's two temporary folders participate. Durable encrypted upload
 * staging and user-saved Photos/Files are outside this inventory. */
internal object PrivateTemporaryMedia {
    const val CAMERA_AGE_MS=PrivatePreviewLease.MAX_AGE_MS
    const val SHARE_AGE_MS=15L*60*1000
    private const val RETRY_MS=60_000L
    private val uuid="[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    enum class Kind(val directory: String,val age: Long) { CAMERA("camera",CAMERA_AGE_MS),SHARED("shared-originals",SHARE_AGE_MS) }
    data class Sweep(val removed: Set<String>,val nextDelay: Long?,val failed: Boolean)
    data class Owned internal constructor(val file: File,internal val kind: Kind,internal val nonce: String,internal val identity: String)
    private data class Ownership(val nonce: String,val identity: String,val created: Long)
    private const val OWNERS="private-media-ownership-v1"
    private fun owns(kind: Kind,name: String)=when(kind) {
        Kind.CAMERA->Regex("$uuid\\.jpg",RegexOption.IGNORE_CASE).matches(name)
        Kind.SHARED->Regex("lovelies-$uuid-$uuid\\.(jpg|png|webp|gif)",RegexOption.IGNORE_CASE).matches(name)
    }
    private fun directory(cache: File,kind: Kind,create: Boolean=false): Path? = try {
        val root=cache.toPath()
        if(!Files.isDirectory(root,LinkOption.NOFOLLOW_LINKS) || Files.isSymbolicLink(root))null else {
            val owned=root.toRealPath().resolve(kind.directory)
            if(create && !Files.exists(owned,LinkOption.NOFOLLOW_LINKS))Files.createDirectory(owned)
            owned.takeIf { Files.isDirectory(it,LinkOption.NOFOLLOW_LINKS) && !Files.isSymbolicLink(it) && it.toRealPath()==it }
        }
    } catch(_: Exception) { null }
    private fun ownershipPath(cache: File,kind: Kind,name: String,create: Boolean=false): Path? = try {
        if(!owns(kind,name))null else {
            val root=cache.toPath()
            if(Files.isSymbolicLink(root) || !Files.isDirectory(root,LinkOption.NOFOLLOW_LINKS))null else {
                val folder=root.toRealPath().resolve(OWNERS)
                if(create && !Files.exists(folder,LinkOption.NOFOLLOW_LINKS))Files.createDirectory(folder)
                if(Files.isSymbolicLink(folder) || !Files.isDirectory(folder,LinkOption.NOFOLLOW_LINKS) || folder.toRealPath()!=folder)null
                else folder.resolve("${kind.name.lowercase()}-$name.owner")
            }
        }
    } catch(_: Exception) { null }
    private fun identity(path: Path): String? = try {
        val attributes=Files.readAttributes(path,BasicFileAttributes::class.java,LinkOption.NOFOLLOW_LINKS)
        if(!attributes.isRegularFile || attributes.isSymbolicLink)null
        else attributes.fileKey()?.toString()?.takeIf { it.length in 1..256 }
    } catch(_: Exception) { null }
    private fun ownership(cache: File,kind: Kind,name: String): Ownership? { return try {
        val path=ownershipPath(cache,kind,name) ?: return null
        if(Files.isSymbolicLink(path) || !Files.isRegularFile(path,LinkOption.NOFOLLOW_LINKS) || Files.size(path)>1024)return null
        Files.newInputStream(path,LinkOption.NOFOLLOW_LINKS).use { raw -> DataInputStream(raw).use { input ->
            if(input.readUTF()!="lovelies-private-media-v1" || input.readUTF()!=kind.name || input.readUTF()!=name)return null
            val result=Ownership(input.readUTF(),input.readUTF(),input.readLong())
            if(!Regex(uuid,RegexOption.IGNORE_CASE).matches(result.nonce) || result.identity.length !in 1..300 || result.created<=0 || input.read()!=-1)null else result
        } }
    } catch(_: Exception) { null } }
    private fun syncDirectory(path: Path) {
        // Android's desugared FileChannel rejects directory opens on API 24.
        // Public API-21 flags reject final symlinks and avoid blocking if a
        // replaced path is a FIFO; verify the opened descriptor is a directory.
        val descriptor=android.system.Os.open(path.toString(),android.system.OsConstants.O_RDONLY or
            android.system.OsConstants.O_NOFOLLOW or android.system.OsConstants.O_NONBLOCK,0)
        try {
            if(!android.system.OsConstants.S_ISDIR(android.system.Os.fstat(descriptor).st_mode))throw LiveFailure("save_failed")
            android.system.Os.fsync(descriptor)
        }
        catch(problem: Throwable) {
            try { android.system.Os.close(descriptor) } catch(closeProblem: Throwable) { problem.addSuppressed(closeProblem) }
            throw problem
        }
        android.system.Os.close(descriptor)
    }
    private fun recordOwnership(cache: File,kind: Kind,name: String,value: Ownership,directorySync: (Path)->Unit) {
        val path=ownershipPath(cache,kind,name,true) ?: throw LiveFailure("save_failed")
        FileChannel.open(path,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE,LinkOption.NOFOLLOW_LINKS).use { channel ->
            val output=DataOutputStream(Channels.newOutputStream(channel))
            output.writeUTF("lovelies-private-media-v1");output.writeUTF(kind.name);output.writeUTF(name)
            output.writeUTF(value.nonce);output.writeUTF(value.identity);output.writeLong(value.created);output.flush();channel.force(true)
        }
        // The ownership filename (and a newly-created metadata directory) must survive before private bytes are written.
        directorySync(path.parent)
        directorySync(cache.toPath().toRealPath())
    }
    /** All app writers and cleanup use this monitor. FileProvider only receives read grants.
     * A filename never proves ownership: a durable creation record and the same file identity are required.
     * Legacy or replaced files without that proof remain untouched. */
    @Synchronized fun owned(cache: File,kind: Kind,file: File): Owned? {
        val folder=directory(cache,kind) ?: return null
        if(file.toPath().parent!=folder)return null
        val record=ownership(cache,kind,file.name) ?: return null
        if(identity(file.toPath())!=record.identity)return null
        return Owned(file,kind,record.nonce,record.identity)
    }
    @Synchronized fun discard(cache: File,value: Owned): Boolean {
        val current=owned(cache,value.kind,value.file) ?: return false
        if(current.nonce!=value.nonce || current.identity!=value.identity)return false
        return try {
            val removed=Files.deleteIfExists(value.file.toPath())
            if(removed)ownershipPath(cache,value.kind,value.file.name)?.let { Files.deleteIfExists(it) }
            removed
        } catch(_: Exception) { false }
    }
    fun cameraNames(uris: Collection<String>,authority: String): Set<String> = uris.mapNotNull { raw ->
        runCatching {
            val uri=java.net.URI(raw);val name=uri.path?.removePrefix("/camera/")
            name?.takeIf { uri.scheme=="content" && uri.rawAuthority==authority && uri.query==null && uri.fragment==null &&
                uri.rawPath=="/camera/$it" && owns(Kind.CAMERA,it) }
        }.getOrNull()
    }.toSet()
    /** A null result preserves camera scratch until its recovery inventory can
     * be read and bound. An upload draft has its own lifecycle; cache aging must
     * not silently destroy its only source before it has been submitted. */
    fun cameraRecoveryNames(batch: Any?,draft: Any?,origin: String,account: String?,device: String?,
        liveUris: Collection<String>,authority: String): Set<String>? = try {
        val references=liveUris.toMutableList()
        batch?.let {
            val record=PhotoUploadBatch.restore(it,origin)
            record.assertOwner(origin,account,device)
            if(!record.finished && !record.cancelled)references.addAll(record.picked+record.selected+record.files.map { file->file.uri })
        }
        draft?.let {
            val row=NativeProtocol.obj(it)
            if(account==null || device==null || row["account"]!=account || row["device"]!=device)throw LiveFailure("upload_account_changed")
            fun uris(key: String): List<String> = (row[key] as? List<*>)?.takeIf { values->values.size<=100 }?.map { value ->
                NativeProtocol.text(value,8192).also { raw->if(!java.net.URI(raw).isAbsolute)throw LiveFailure("upload_journal_invalid") }
            }?.takeIf { values->values.toSet().size==values.size } ?: throw LiveFailure("upload_journal_invalid")
            val picked=uris("picked");val selected=uris("selected")
            if(!picked.containsAll(selected))throw LiveFailure("upload_journal_invalid")
            references.addAll(picked+selected)
        }
        cameraNames(references,authority)
    } catch(_: Exception) { null }
    @Synchronized fun write(cache: File,kind: Kind,name: String,bytes: ByteArray,createdAt: Long=System.currentTimeMillis(),
        directorySync: (Path)->Unit=::syncDirectory): File {
        if(!owns(kind,name) || createdAt<=0)throw LiveFailure("save_failed")
        val folder=directory(cache,kind,true) ?: throw LiveFailure("save_failed")
        val target=folder.resolve(name)
        var createdIdentity: String?=null
        val nonce=java.util.UUID.randomUUID().toString()
        try {
            FileChannel.open(target,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE,LinkOption.NOFOLLOW_LINKS).use { channel ->
                val key=identity(target) ?: throw LiveFailure("save_failed");createdIdentity=key
                // Persist ownership before any private bytes. An interrupted writer can be retired using this exact identity.
                recordOwnership(cache,kind,name,Ownership(nonce,key,createdAt),directorySync)
                val output=Channels.newOutputStream(channel);output.write(bytes);output.flush();channel.force(true)
            }
            // These files are written once. The persisted stamp records creation,
            // rather than extending their life whenever they are read/shared.
            if(directory(cache,kind)!=folder)throw LiveFailure("save_failed")
            Files.getFileAttributeView(target,BasicFileAttributeView::class.java,LinkOption.NOFOLLOW_LINKS).setTimes(FileTime.fromMillis(createdAt),null,null)
            directorySync(folder)
            return target.toFile()
        } catch(problem: Exception) {
            if(createdIdentity!=null && directory(cache,kind)==folder && identity(target)==createdIdentity) {
                runCatching { Files.deleteIfExists(target) }
                if(ownership(cache,kind,name)?.nonce==nonce)ownershipPath(cache,kind,name)?.let { path->runCatching { Files.deleteIfExists(path) } }
            }
            throw problem
        }
    }
    @Synchronized fun sweep(cache: File,kind: Kind,now: Long,preserved: Set<String> = emptySet(),all: Boolean=false,
        remove: (Path)->Boolean={ Files.deleteIfExists(it) }): Sweep {
        val folder=directory(cache,kind) ?: return Sweep(emptySet(),null,false)
        val removed=mutableSetOf<String>();var next: Long?=null;var failed=false
        fun retry() { failed=true;next=minOf(next ?: RETRY_MS,RETRY_MS) }
        try {
            Files.newDirectoryStream(folder).use { files -> files.forEach { entry ->
                val name=entry.fileName.toString()
                if(!owns(kind,name) || name in preserved)return@forEach
                try {
                    val proof=owned(cache,kind,entry.toFile()) ?: return@forEach
                    val record=ownership(cache,kind,name) ?: return@forEach
                    val attributes=Files.readAttributes(entry,BasicFileAttributes::class.java,LinkOption.NOFOLLOW_LINKS)
                    if(!attributes.isRegularFile || attributes.isSymbolicLink)return@forEach
                    val stamp=attributes.lastModifiedTime().toMillis()
                    val created=if(stamp>now)stamp else minOf(stamp,record.created)
                    val remaining=if(created<=0 || now<created)0 else (kind.age-(now-created)).coerceAtLeast(0)
                    if(all || remaining==0L) {
                        // Recheck the owned parent before unlinking; never recurse
                        // through a nested directory or a symbolic link.
                        if(directory(cache,kind)!=folder || owned(cache,kind,entry.toFile())!=proof) { retry();return@forEach }
                        if(remove(entry)) {
                            removed.add(name);ownershipPath(cache,kind,name)?.let { Files.deleteIfExists(it) }
                        } else if(Files.exists(entry,LinkOption.NOFOLLOW_LINKS))retry()
                    } else next=minOf(next ?: remaining,remaining)
                } catch(_: Exception) { retry() }
            } }
        } catch(_: Exception) { retry() }
        return Sweep(removed,next,failed)
    }
}

/** No re-encoding: the server-authorized original is written verbatim. */
internal object OriginalMedia {
    data class Format(val mime: String,val extension: String)
    data class Share(val intent: Intent,val file: PrivateTemporaryMedia.Owned)
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
    fun share(context: Context,id: String,bytes: ByteArray,current: ()->Unit): Share {
        prune(context)
        val format=format(bytes)
        val target=PrivateTemporaryMedia.write(context.cacheDir,PrivateTemporaryMedia.Kind.SHARED,
            "lovelies-${NativeProtocol.id(id)}-${java.util.UUID.randomUUID()}.${format.extension}",bytes)
        val owned=PrivateTemporaryMedia.owned(context.cacheDir,PrivateTemporaryMedia.Kind.SHARED,target) ?: throw LiveFailure("save_failed")
        try {
            current()
            val uri=FileProvider.getUriForFile(context,"${context.packageName}.camera-files",target)
            val intent=Intent(Intent.ACTION_SEND).setType(format.mime).putExtra(Intent.EXTRA_STREAM,uri)
                .apply { clipData=ClipData.newUri(context.contentResolver,context.getString(R.string.controller_f72a6f212afb),uri);addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION) }
            return Share(intent,owned)
        } catch(problem: Exception) { PrivateTemporaryMedia.discard(context.cacheDir,owned);throw problem }
    }
    fun prune(context: Context,all: Boolean=false) { PrivateTemporaryMedia.sweep(context.cacheDir,PrivateTemporaryMedia.Kind.SHARED,System.currentTimeMillis(),all=all) }
    fun pruneCamera(context: Context,all: Boolean=false) { PrivateTemporaryMedia.sweep(context.cacheDir,PrivateTemporaryMedia.Kind.CAMERA,System.currentTimeMillis(),all=all) }
    fun camera(context: Context,bytes: ByteArray): Uri {
        val target=PrivateTemporaryMedia.write(context.cacheDir,PrivateTemporaryMedia.Kind.CAMERA,"${java.util.UUID.randomUUID()}.jpg",bytes)
        return try { FileProvider.getUriForFile(context,"${context.packageName}.camera-files",target) }
        catch(problem: Exception) { PrivateTemporaryMedia.owned(context.cacheDir,PrivateTemporaryMedia.Kind.CAMERA,target)?.let { PrivateTemporaryMedia.discard(context.cacheDir,it) };throw problem }
    }
}
