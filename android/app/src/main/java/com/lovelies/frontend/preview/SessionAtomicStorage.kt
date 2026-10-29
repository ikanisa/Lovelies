package com.lovelies.frontend.preview

import android.util.AtomicFile
import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.security.MessageDigest

/** Platform AtomicFile is injected only at this internal file boundary; production uses the platform implementation. */
internal interface SessionAtomicFile {
    val baseFile: File
    fun readFully(): ByteArray
    fun startWrite(): FileOutputStream
    fun finishWrite(stream: FileOutputStream)
    fun failWrite(stream: FileOutputStream)
    fun delete()
}
internal class PlatformSessionAtomicFile(override val baseFile: File): SessionAtomicFile {
    private val delegate=AtomicFile(baseFile)
    override fun readFully()=delegate.readFully()
    override fun startWrite()=delegate.startWrite()
    override fun finishWrite(stream: FileOutputStream)=delegate.finishWrite(stream)
    override fun failWrite(stream: FileOutputStream)=delegate.failWrite(stream)
    override fun delete()=delegate.delete()
}

/** Session bytes only; Android Keystore encryption remains in SecureSession.
 * AtomicFile has no locking and finishWrite may log rather than throw: callers serialize access,
 * and acceptance requires exact readback through the same recovery path before publication. */
internal class SessionAtomicStorage(private val file: SessionAtomicFile) {
    private var held=false
    private fun artifacts(): Set<String> {
        val names=file.baseFile.parentFile?.list() ?: throw LiveFailure("secure_storage_unavailable",503,true)
        val base=file.baseFile.name
        return names.filter { it==base || it=="$base.bak" || it=="$base.new" }.toSet()
    }
    @Synchronized fun hold() { held=true }
    @Synchronized fun read(): ByteArray? {
        try {
            val before=artifacts()
            // Do not gate on base.exists(): API24–29 can recover only a .bak; API30+ also handles it.
            return try {
                val value=file.readFully()
                try {
                    // Failed rename/delete may be logged by AtomicFile instead of thrown. Never accept that ambiguity.
                    if(artifacts().any { it!=file.baseFile.name })throw LiveFailure("secure_storage_unavailable",503,true)
                    value
                } catch(problem: Exception) { value.fill(0);throw problem }
            } catch(problem: FileNotFoundException) {
                // A .new-only first write has no committed value. Preserve it and block; absence is not freshness.
                if(held || before.isNotEmpty() || artifacts().isNotEmpty())throw LiveFailure("secure_storage_unavailable",503,true)
                null
            }
        } catch(problem: Exception) {
            held=true
            if(problem is LiveFailure)throw problem
            throw LiveFailure("secure_storage_unavailable",503,true)
        }
    }
    @Synchronized fun write(value: ByteArray) {
        if(held)throw LiveFailure("secure_storage_unavailable",503,true)
        // Recover a legacy backup before startWrite can replace it. Any auxiliary-only uncertainty blocks writing.
        read()?.fill(0)
        val stream=try { file.startWrite() } catch(problem: Exception) { held=true;throw LiveFailure("secure_storage_unavailable",503,true) }
        try { stream.write(value) }
        catch(problem: Exception) {
            held=true;runCatching { file.failWrite(stream) }
            throw LiveFailure("secure_storage_unavailable",503,true)
        }
        try { file.finishWrite(stream) }
        catch(problem: Exception) {
            // finishWrite may already have committed. failWrite here could delete that accepted file on API24–29.
            held=true;runCatching { stream.close() }
            throw LiveFailure("secure_storage_unavailable",503,true)
        }
        val accepted=read()
        try {
            if(accepted==null || !MessageDigest.isEqual(value,accepted)) {
                held=true;throw LiveFailure("secure_storage_unavailable",503,true)
            }
        } finally { accepted?.fill(0) }
    }
    @Synchronized fun clear() {
        file.delete()
        if(artifacts().isNotEmpty()) { held=true;throw LiveFailure("secure_storage_unavailable",503,true) }
    }
}
