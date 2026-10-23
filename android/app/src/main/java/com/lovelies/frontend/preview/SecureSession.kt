package com.lovelies.frontend.preview

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.concurrent.atomic.AtomicLong
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class SessionScope(val epoch: Long,val accountId: String?)
class SessionFence {
    private val epoch=AtomicLong(0)
    @Volatile private var account: String? = null
    @Synchronized fun switch(accountId: String?): SessionScope { account=accountId;return SessionScope(epoch.incrementAndGet(),accountId) }
    fun scope() = SessionScope(epoch.get(),account)
    fun assert(scope: SessionScope) { if(scope.epoch!=epoch.get() || scope.accountId!=account)throw LiveFailure("session_changed") }
}

/** No exported private key, plaintext tokens, backup or shared external storage. */
class SecureSession(context: Context,endpoint: String) {
    private val store=KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private val alias="lovelies.session.aes.v2"
    private val file=AtomicFile(File(context.noBackupFilesDir,"lovelies-session-v2-${NativeProtocol.sha256(endpoint.toByteArray()).take(16)}.bin"))
    private val aad="${context.packageName}:$endpoint:v2".toByteArray(Charsets.UTF_8)
    private val deviceScope=NativeProtocol.sha256("$endpoint:${context.noBackupFilesDir.absolutePath}".toByteArray()).take(16)
    private val uploadDirectory=File(context.noBackupFilesDir,"photo-uploads-$deviceScope")
    private fun uploadFile(id: String)=AtomicFile(File(uploadDirectory,"${NativeProtocol.id(id)}.bin"))
    private fun uploadAad(account: String,batch: String,id: String)=aad+":photo:${NativeProtocol.id(account)}:${NativeProtocol.id(batch)}:${NativeProtocol.id(id)}".toByteArray()
    /** Atomic encrypted originals survive provider grant loss, cache eviction and process death. */
    @Synchronized fun stagePhoto(account: String,batch: String,id: String,bytes: ByteArray) {
        if(bytes.size.toLong() !in 1..PhotoUploadFile.MAX_BYTES)throw LiveFailure("image_too_large")
        if(!uploadDirectory.isDirectory && !uploadDirectory.mkdirs())throw LiveFailure("upload_storage_unavailable")
        if(uploadDirectory.usableSpace<bytes.size+1024L*1024)throw LiveFailure("upload_storage_full")
        val cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,secret());cipher.updateAAD(uploadAad(account,batch,id))
        val sealed=byteArrayOf(1)+cipher.iv+cipher.doFinal(bytes);val target=uploadFile(id);val stream=target.startWrite()
        try { stream.write(sealed);target.finishWrite(stream) }
        catch(problem: Exception) { target.failWrite(stream);throw LiveFailure("upload_storage_unavailable") }
        finally { sealed.fill(0) }
    }
    @Synchronized fun hasStagedPhoto(id: String)=uploadFile(id).baseFile.isFile
    @Synchronized fun stagedPhoto(account: String,batch: String,id: String): ByteArray {
        val target=uploadFile(id)
        if(!target.baseFile.isFile || target.baseFile.length() !in 30..(PhotoUploadFile.MAX_BYTES+29))throw LiveFailure("upload_source_unavailable")
        val sealed=target.readFully()
        try {
            if(sealed[0].toInt()!=1)throw LiveFailure("upload_source_changed")
            val cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,secret(),GCMParameterSpec(128,sealed.copyOfRange(1,13)))
            cipher.updateAAD(uploadAad(account,batch,id));return cipher.doFinal(sealed.copyOfRange(13,sealed.size))
        } catch(problem: Exception) { throw LiveFailure("upload_source_changed") }
        finally { sealed.fill(0) }
    }
    @Synchronized fun removeStagedPhoto(id: String) { uploadFile(id).delete() }
    fun enrollmentAlias(account: String)="lovelies.device.$account.$deviceScope.${java.util.UUID.randomUUID()}"
    fun recoveryAlias()="lovelies.device.recovery.$deviceScope.${java.util.UUID.randomUUID()}"
    fun hasEnrollmentKeys()=hasUnreferencedEnrollmentKeys(emptySet())
    fun hasUnreferencedEnrollmentKeys(known: Set<String>)=store.aliases().asSequence().any {
        it.startsWith("lovelies.device.") && it.contains(".$deviceScope.") && it !in known
    }
    private fun secret(): SecretKey {
        (store.getKey(alias,null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).setRandomizedEncryptionRequired(true).build())
        }.generateKey()
    }
    @Synchronized fun load(): WireObject {
        if(!file.baseFile.exists())return emptyMap()
        val encrypted=file.readFully()
        try {
            if(encrypted.size !in 30..2097152 || encrypted[0].toInt()!=2)throw LiveFailure("secure_storage_invalid")
            val cipher=Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE,secret(),GCMParameterSpec(128,encrypted.copyOfRange(1,13)));cipher.updateAAD(aad)
            val plain=cipher.doFinal(encrypted.copyOfRange(13,encrypted.size))
            try { return jsonMap(JSONObject(plain.toString(Charsets.UTF_8))) } finally { plain.fill(0) }
        } catch(error: Exception) { throw LiveFailure("secure_storage_reset") } finally { encrypted.fill(0) }
    }
    @Synchronized fun save(value: WireObject) {
        val plain=NativeProtocol.canonical(value).toByteArray(Charsets.UTF_8)
        if(plain.size>1572864)throw LiveFailure("secure_storage_full")
        try {
            val cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,secret());cipher.updateAAD(aad)
            val data=byteArrayOf(2)+cipher.iv+cipher.doFinal(plain)
            val stream=file.startWrite()
            try { stream.write(data);file.finishWrite(stream) } catch(error: Exception) { file.failWrite(stream);throw error }
            finally { data.fill(0) }
        } finally { plain.fill(0) }
    }
    @Synchronized fun clear() { file.delete() }
    fun createDevice(alias: String): WireObject {
        if(!store.containsAlias(alias))KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC,"AndroidKeyStore").apply {
            initialize(KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1")).setDigests(KeyProperties.DIGEST_SHA256).build());generateKeyPair()
        }
        return existingDevice(alias)
    }
    fun existingDevice(alias: String): WireObject {
        if(!store.containsAlias(alias) || store.getKey(alias,null) !is java.security.PrivateKey)throw LiveFailure("device_key_unavailable")
        val key=store.getCertificate(alias)?.publicKey as? ECPublicKey ?: throw LiveFailure("device_key_unavailable")
        fun coordinate(value: java.math.BigInteger): String {
            val bytes=value.toByteArray();val unsigned=if(bytes.size>32 && bytes[0].toInt()==0)bytes.copyOfRange(1,bytes.size) else bytes
            if(unsigned.size>32)throw LiveFailure("device_key_invalid")
            return NativeProtocol.base64(ByteArray(32).also { unsigned.copyInto(it,32-unsigned.size) })
        }
        return mapOf("kty" to "EC","crv" to "P-256","x" to coordinate(key.w.affineX),"y" to coordinate(key.w.affineY),"ext" to true,"key_ops" to listOf("verify"))
    }
    fun sign(alias: String,envelope: WireObject): String {
        val signature=Signature.getInstance("SHA256withECDSA")
        signature.initSign(store.getKey(alias,null) as? java.security.PrivateKey ?: throw LiveFailure("device_key_unavailable"))
        val bytes=NativeProtocol.canonical(envelope).toByteArray(Charsets.UTF_8)
        try { signature.update(bytes);return NativeProtocol.base64(NativeProtocol.derToRaw(signature.sign())) } finally { bytes.fill(0) }
    }
    fun deleteDevice(alias: String?) { if(alias!=null && alias.startsWith("lovelies.device."))store.deleteEntry(alias) }
}

fun jsonMap(json: JSONObject): WireObject = json.keys().asSequence().associateWith { key -> jsonValue(json.opt(key)) }
private fun jsonValue(value: Any?): Any? = when(value) {
    null,JSONObject.NULL -> null
    is JSONObject -> jsonMap(value)
    is org.json.JSONArray -> (0 until value.length()).map { jsonValue(value.opt(it)) }
    else -> value
}
