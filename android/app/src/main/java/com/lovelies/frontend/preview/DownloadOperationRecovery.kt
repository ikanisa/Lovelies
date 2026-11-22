package com.lovelies.frontend.preview

import java.security.SecureRandom
import java.util.UUID

/** Protected local evidence, never a generic mutation receipt or photo-access authority. */
internal data class DownloadOperation(
    val origin: String,val account: String,val session: String,val device: String,val key: String,
    val capability: String,val asset: String,val version: String,val effect: String,val sessionExpires: Long,
    val stage: String,val phase: String="intent",val createdAt: Long?=null,val expiresAt: Long?=null,
    val checksum: String?=null,val mime: String?=null,val length: Long?=null
) {
    override fun toString()="DownloadOperation(phase=$phase,protected=true)"
    fun input(): WireObject=mapOf("protocol" to DownloadProtocol.INPUT,"operation_key" to key,"original_session_id" to session,"asset_id" to asset,"source_version" to version)
    fun headers()=mapOf(DownloadProtocol.CAPABILITY_HEADER to capability)
    fun wire(): WireObject=mapOf("protocol" to "lovelies-android-download-v2","origin" to origin,"account" to account,"session" to session,
        "device" to device,"key" to key,"capability" to capability,"asset" to asset,"version" to version,"effect" to effect,
        "session_expires" to sessionExpires,"stage" to stage,"phase" to phase,"created_at" to createdAt,"expires_at" to expiresAt,
        "checksum" to checksum,"mime" to mime,"length" to length)
    fun sameIntent(other: DownloadOperation): Boolean=copy(phase=other.phase,createdAt=other.createdAt,expiresAt=other.expiresAt,checksum=other.checksum,mime=other.mime,length=other.length)==other
    fun assertCurrent(origin: String,scope: SessionScope,actor: LiveCredentials?,session: String,device: String?,now: Long) {
        if(this.origin!=origin || account!=scope.accountId || actor?.account!=account || actor.method!="registered_face" || this.session!=session || this.device!=device ||
            actor.expires!=sessionExpires || now>=sessionExpires)throw LiveFailure("download_authority_changed",409,true)
        if(expiresAt!=null && now>=expiresAt)throw LiveFailure("download_expired",410,true)
    }
    fun receipt(value: WireObject): DownloadOperation {
        val keys=setOf("protocol","status","account_id","operation_key","original_session_id","asset_id","source_version")
        if(value["protocol"]!=DownloadProtocol.RECEIPT || value["account_id"]!=account || value["operation_key"]!=key || value["original_session_id"]!=session ||
            value["asset_id"]!=asset || value["source_version"]!=version)DownloadProtocol.invalid()
        if(value["status"]=="not_issued") {
            if(value.keys!=keys || createdAt!=null || phase in setOf("staging","staged","effect_started","effect_completed"))DownloadProtocol.invalid()
            return copy(phase="not_issued")
        }
        if(value["status"]!="recorded" || value.keys!=keys+setOf("created_at","expires_at"))DownloadProtocol.invalid()
        val created=NativeProtocol.integer(value["created_at"],0,DownloadProtocol.MAX_SAFE_INTEGER)
        val expiry=NativeProtocol.integer(value["expires_at"],1,DownloadProtocol.MAX_SAFE_INTEGER)
        if(expiry<=created || expiry-created>120_000 || expiry>sessionExpires || createdAt!=null && (created!=createdAt || expiry!=expiresAt) || phase=="not_issued")DownloadProtocol.invalid()
        return copy(phase=if(phase in setOf("intent","signing"))"recorded" else phase,createdAt=created,expiresAt=expiry)
    }
    fun verified(content: DownloadContent): DownloadOperation {
        val hash=content.headers["x-lovelies-content-sha256"]
        val size=content.headers["content-length"]
        val type=content.headers["content-type"]?.substringBefore(';')?.trim()
        if(content.headers["x-lovelies-source-version"]!=version || hash==null || !Regex("[0-9a-f]{64}").matches(hash) ||
            content.bytes.size !in 1..DownloadProtocol.MAX_BYTES || size!=content.bytes.size.toString() || type !in DownloadProtocol.MIMES ||
            NativeProtocol.sha256(content.bytes)!=hash || OriginalMedia.format(content.bytes).mime!=type ||
            checksum!=null && (checksum!=hash || length!=content.bytes.size.toLong() || mime!=type))throw LiveFailure("download_content_invalid",503,true)
        return copy(phase="staging",checksum=hash,mime=type,length=content.bytes.size.toLong())
    }
    fun verifyStaged(bytes: ByteArray) {
        if(bytes.size !in 1..DownloadProtocol.MAX_BYTES || bytes.size.toLong()!=length || NativeProtocol.sha256(bytes)!=checksum || OriginalMedia.format(bytes).mime!=mime)
            throw LiveFailure("download_staging_invalid",503,true)
    }
    companion object {
        fun create(origin: String,account: String,session: String,device: String,photo: LivePhoto,share: Boolean,sessionExpires: Long): DownloadOperation {
            NativeProtocol.mediaSource(photo.mediaSource)
            val random=ByteArray(32).also(SecureRandom()::nextBytes)
            val capability=try { "lvd_v2_"+NativeProtocol.base64(random) } finally { random.fill(0) }
            return DownloadOperation(origin,NativeProtocol.id(account),NativeProtocol.id(session),NativeProtocol.id(device),"android-download-${UUID.randomUUID()}",capability,
                NativeProtocol.id(photo.id),NativeProtocol.text(photo.version,1000).takeIf(String::isNotEmpty) ?: throw LiveFailure("download_authority_changed"),
                if(share)"share" else "save",sessionExpires,UUID.randomUUID().toString())
        }
        fun restore(raw: Any?,origin: String): DownloadOperation {
            val row=NativeProtocol.obj(raw)
            val keys=setOf("protocol","origin","account","session","device","key","capability","asset","version","effect","session_expires","stage","phase","created_at","expires_at","checksum","mime","length")
            if(row.keys!=keys || row["protocol"]!="lovelies-android-download-v2" || row["origin"]!=origin)DownloadProtocol.invalid()
            val cap=NativeProtocol.text(row["capability"],64)
            val decoded=runCatching { java.util.Base64.getUrlDecoder().decode(cap.removePrefix("lvd_v2_")) }.getOrNull() ?: DownloadProtocol.invalid()
            if(!cap.startsWith("lvd_v2_") || decoded.size!=32 || "lvd_v2_"+NativeProtocol.base64(decoded)!=cap)DownloadProtocol.invalid()
            decoded.fill(0)
            val phase=NativeProtocol.text(row["phase"])
            if(phase !in DownloadProtocol.PHASES || row["effect"] !in setOf("save","share"))DownloadProtocol.invalid()
            val created=row["created_at"]?.let { NativeProtocol.integer(it,0,DownloadProtocol.MAX_SAFE_INTEGER) }
            val expiry=row["expires_at"]?.let { NativeProtocol.integer(it,1,DownloadProtocol.MAX_SAFE_INTEGER) }
            val checksum=row["checksum"]?.let { NativeProtocol.text(it,64) }
            val mime=row["mime"]?.let { NativeProtocol.text(it,64) }
            val length=row["length"]?.let { NativeProtocol.integer(it,1,DownloadProtocol.MAX_BYTES.toLong()) }
            val expires=NativeProtocol.integer(row["session_expires"],1,DownloadProtocol.MAX_SAFE_INTEGER)
            if((created==null)!=(expiry==null) || created!=null && (expiry!!<=created || expiry-created>120_000 || expiry>expires) ||
                phase=="not_issued" && created!=null ||
                phase !in setOf("intent","signing","not_issued") && created==null ||
                checksum!=null && (!Regex("[0-9a-f]{64}").matches(checksum) || mime !in DownloadProtocol.MIMES || length==null) ||
                checksum==null && (mime!=null || length!=null) || phase in setOf("staging","staged","effect_started","effect_completed") && checksum==null)DownloadProtocol.invalid()
            return DownloadOperation(origin,NativeProtocol.id(row["account"]),NativeProtocol.id(row["session"]),NativeProtocol.id(row["device"]),AudienceProtocol.operationKey(row["key"]),cap,
                NativeProtocol.id(row["asset"]),NativeProtocol.text(row["version"],1000).takeIf(String::isNotEmpty) ?: DownloadProtocol.invalid(),NativeProtocol.text(row["effect"]),expires,
                NativeProtocol.id(row["stage"]),phase,created,expiry,checksum,mime,length)
        }
    }
}

internal data class DownloadContent(val bytes: ByteArray,val headers: Map<String,String>) {
    override fun toString()="DownloadContent(protected=true)"
}
internal object DownloadProtocol {
    const val INPUT="lovelies-download-input-v2"
    const val RECEIPT="lovelies-download-operation-v2"
    const val CAPABILITY_HEADER="X-Lovelies-Download-Capability"
    const val MAX_BYTES=20*1024*1024
    const val MAX_SAFE_INTEGER=9007199254740991L
    val MIMES=setOf("image/jpeg","image/png","image/webp","image/gif")
    val PHASES=setOf("intent","signing","recorded","content_started","staging","staged","effect_started","effect_completed","not_issued")
    fun invalid(): Nothing=throw LiveFailure("download_operation_outcome_unresolved",503,true)
}

/** Unknown installed intents remain exact evidence, independently of the shared
 * mutation slot. Clearing authentication is never download disposition. */
internal object DownloadRecoveryRetention {
    val fields=setOf("download_operation","download_uncertainty","download_history","download_legacy")
    fun isLegacy(raw: Any?): Boolean {
        val row=raw as? Map<*,*> ?: return false
        return row["action"]=="download.sign" || row["path"]=="/downloads/sign" || row["source"]=="media" && (row["action"] as? String)?.startsWith("download.")==true
    }
    fun keep(previous: WireObject,candidate: WireObject): WireObject {
        val legacy=previous["pending"]?.takeIf(::isLegacy)
        val held=previous["download_legacy"]
        if(legacy!=null && held!=null && held!=legacy)DownloadProtocol.invalid()
        return candidate+previous.filterKeys { it in fields }+((held ?: legacy)?.let { mapOf("download_legacy" to it) } ?: emptyMap())
    }
}
