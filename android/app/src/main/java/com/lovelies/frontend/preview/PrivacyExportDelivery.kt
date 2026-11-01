package com.lovelies.frontend.preview

import java.time.Instant
import java.util.UUID

internal data class PrivacyExportDelivery(val id: String,val expires: Long,val hash: String,val bytes: Long,val acknowledged: Boolean,
    val publication: String?=null,val chunks: Int=0,val chunkBytes: Int=0,val manifestHash: String?=null) {
    val chunked get()=publication!=null
    private val path get()="/privacy-exports/deliveries/$id"
    val retrievePath get()=if(chunked)"$path/manifest?offset=0" else path
    val ackPath get()="$path/ack"
    fun manifestPath(offset: Int)="$path/manifest?offset=$offset"
    fun chunkPath(index: Int)="$path/chunks/$index"
    fun wire(): WireObject=mapOf("id" to id,"expires" to expires,"sha256" to hash,"bytes" to bytes,"acknowledged" to acknowledged)+
        if(chunked)mapOf("publication_id" to publication,"chunk_count" to chunks,"chunk_bytes" to chunkBytes,"manifest_sha256" to manifestHash) else emptyMap()
    fun assertBytes(value: ByteArray) {
        if(chunked || value.size.toLong()!=bytes || NativeProtocol.sha256(value)!=hash)throw LiveFailure("privacy_export_unverified")
    }
    companion object {
        private val base=setOf("id","expires","sha256","bytes","acknowledged")
        private val chunkFields=setOf("publication_id","chunk_count","chunk_bytes","manifest_sha256")
        fun restore(raw: Any?): PrivacyExportDelivery {
            val row=NativeProtocol.obj(raw);val chunked=row.containsKey("publication_id")
            if(row.keys!=base+(if(chunked)chunkFields else emptySet()) || row["acknowledged"] !is Boolean
                || !Regex("^[0-9a-f]{64}$").matches(NativeProtocol.text(row["sha256"],64)))throw LiveFailure("privacy_export_unverified")
            val bytes=NativeProtocol.integer(row["bytes"],1,if(chunked)9007199254740991L else 20L*1024*1024)
            val count=if(chunked)NativeProtocol.integer(row["chunk_count"],1,Int.MAX_VALUE.toLong()).toInt() else 0
            val chunkBytes=if(chunked)NativeProtocol.integer(row["chunk_bytes"],1048576,1048576).toInt() else 0
            val root=if(chunked)NativeProtocol.text(row["manifest_sha256"],64).also { if(!Regex("[0-9a-f]{64}").matches(it))throw LiveFailure("privacy_export_unverified") } else null
            if(chunked && (bytes/chunkBytes+(if(bytes%chunkBytes==0L)0 else 1))!=count.toLong())throw LiveFailure("privacy_export_unverified")
            return PrivacyExportDelivery(NativeProtocol.id(row["id"]),NativeProtocol.integer(row["expires"],1,Long.MAX_VALUE),NativeProtocol.text(row["sha256"],64),
                bytes,row["acknowledged"] as Boolean,if(chunked)NativeProtocol.id(row["publication_id"]) else null,count,chunkBytes,root)
        }
        fun response(value: WireObject,intent: PrivacyExportIntent): PrivacyExportDelivery {
            val v3=value["protocol"]=="lovelies-privacy-export-delivery-v3"
            val fields=setOf("protocol","operation_key","request_id","delivery_id","account_id","session_id","state","expires_at","sha256","bytes","retrieve_path","ack_path")
            if(value.keys!=fields+(if(v3)chunkFields else emptySet())
                || value["protocol"] !in setOf("lovelies-privacy-export-delivery-v2","lovelies-privacy-export-delivery-v3") || value["operation_key"]!=intent.createKey || value["request_id"]!=intent.request
                || value["account_id"]!=intent.account || value["session_id"]!=intent.session || value["state"] !in setOf("available","acknowledged"))throw LiveFailure("privacy_export_unverified")
            val expires=runCatching { Instant.parse(NativeProtocol.text(value["expires_at"])).toEpochMilli() }.getOrElse { throw LiveFailure("privacy_export_unverified") }
            val result=restore(mapOf("id" to value["delivery_id"],"expires" to expires,"sha256" to value["sha256"],"bytes" to value["bytes"],"acknowledged" to (value["state"]=="acknowledged"))+
                if(v3)value.filterKeys { it in chunkFields } else emptyMap())
            if(value["retrieve_path"]!=result.retrievePath || value["ack_path"]!=result.ackPath)throw LiveFailure("privacy_export_unverified")
            intent.delivery?.let { previous->
                if(previous.copy(acknowledged=result.acknowledged)!=result || previous.acknowledged && !result.acknowledged)throw LiveFailure("privacy_export_delivery_changed")
            }
            return result
        }
    }
}

/** Both operation keys and the staging name are durable before the first request. No capability URL is persisted. */
internal data class PrivacyExportIntent(val origin: String,val account: String,val session: String,val tokenHash: String,val sessionExpiry: Long,
    val request: String,val createKey: String,val ackKey: String,val file: String,val created: Long,val elapsed: Long,
    val delivery: PrivacyExportDelivery?=null,val staged: Boolean=false,val completed: Boolean=false) {
    val deadline get()=minOf(sessionExpiry,created+(if(delivery?.chunked==false)300_000L else MAX_AGE),delivery?.expires ?: Long.MAX_VALUE)
    fun live(now: Long,clock: Long)=now>=created && now<deadline && clock>=elapsed && clock-elapsed<MAX_AGE
    fun owns(origin: String,account: String?,session: String?,tokenHash: String?)=this.origin==origin && this.account==account && this.session==session && this.tokenHash==tokenHash
    fun wire(): WireObject=mapOf("protocol" to "lovelies-android-export-delivery-v2","origin" to origin,"account" to account,"session" to session,"token_sha256" to tokenHash,
        "session_expires" to sessionExpiry,"request" to request,"create_key" to createKey,"ack_key" to ackKey,"file" to file,"created" to created,"elapsed" to elapsed,
        "delivery" to delivery?.wire(),"staged" to staged,"completed" to completed)
    companion object {
        const val MAX_AGE=3_600_000L
        fun create(origin: String,account: String,session: String,tokenHash: String,sessionExpiry: Long,request: String,now: Long,elapsed: Long)=
            restore(mapOf("protocol" to "lovelies-android-export-delivery-v2","origin" to origin,"account" to account,"session" to session,"token_sha256" to tokenHash,
                "session_expires" to sessionExpiry,"request" to request,"create_key" to "android-export-${UUID.randomUUID()}","ack_key" to "android-export-ack-${UUID.randomUUID()}",
                "file" to UUID.randomUUID().toString(),"created" to now,"elapsed" to elapsed,"delivery" to null,"staged" to false,"completed" to false),origin)
        fun restore(raw: Any?,origin: String): PrivacyExportIntent {
            val row=NativeProtocol.obj(raw)
            if(row.keys!=setOf("protocol","origin","account","session","token_sha256","session_expires","request","create_key","ack_key","file","created","elapsed","delivery","staged","completed")
                || row["protocol"]!="lovelies-android-export-delivery-v2" || row["origin"]!=origin || row["staged"] !is Boolean || row["completed"] !is Boolean)throw LiveFailure("privacy_export_unverified")
            val keys=listOf("create_key","ack_key").map { NativeProtocol.text(row[it],128).also { value->if(!Regex("^[A-Za-z0-9._:-]{16,128}$").matches(value))throw LiveFailure("privacy_export_unverified") } }
            val hash=NativeProtocol.text(row["token_sha256"],64)
            if(keys[0]==keys[1] || !Regex("^[0-9a-f]{64}$").matches(hash))throw LiveFailure("privacy_export_unverified")
            val created=NativeProtocol.integer(row["created"],1,Long.MAX_VALUE-MAX_AGE)
            val result=PrivacyExportIntent(origin,NativeProtocol.id(row["account"]),NativeProtocol.id(row["session"]),hash,NativeProtocol.integer(row["session_expires"],created+1,Long.MAX_VALUE),
                NativeProtocol.id(row["request"]),keys[0],keys[1],NativeProtocol.id(row["file"]),created,NativeProtocol.integer(row["elapsed"],0,Long.MAX_VALUE-MAX_AGE),
                row["delivery"]?.let(PrivacyExportDelivery::restore),row["staged"] as Boolean,row["completed"] as Boolean)
            if(result.staged && result.delivery==null || result.completed && !result.staged)throw LiveFailure("privacy_export_unverified")
            return result
        }
    }
}

/** Real caller supplies encrypted staging and the chosen document stream. Transport loss can replay only the exact
 * create/ACK keys; GET remains repeatable until durable staging is acknowledged. Historical ACK is not current authority. */
internal class PrivacyExportRecovery(private val persist: (PrivacyExportIntent)->Unit,private val assertCurrent: (PrivacyExportIntent)->Unit,
    private val create: suspend (PrivacyExportIntent)->WireObject,private val retrieve: suspend (PrivacyExportDelivery)->ByteArray,
    private val readStage: (PrivacyExportIntent)->ByteArray?,private val writeStage: (PrivacyExportIntent,ByteArray)->Unit,
    private val validateDocument: (ByteArray)->Unit,private val ack: suspend (PrivacyExportIntent)->WireObject,
    private val publish: suspend (ByteArray,()->Unit)->Unit,
    private val chunkedRun: (suspend (PrivacyExportIntent)->PrivacyExportIntent)?=null) {
    suspend fun run(original: PrivacyExportIntent): PrivacyExportIntent {
        var held=original
        fun current() { assertCurrent(held) }
        fun save(next: PrivacyExportIntent) { assertCurrent(next);persist(next);held=next }
        current();if(held.completed)throw LiveFailure("privacy_export_already_saved")
        save(held)
        save(held.copy(delivery=PrivacyExportDelivery.response(create(held),held)))
        val proof=held.delivery!!
        if(proof.chunked)return (chunkedRun ?: throw LiveFailure("privacy_export_chunk_delivery_unavailable"))(held)
        var bytes=readStage(held)
        try {
            if(bytes==null) {
                if(proof.acknowledged || held.staged)throw LiveFailure("privacy_export_staged_copy_unavailable")
                val downloaded=retrieve(proof)
                try { current();proof.assertBytes(downloaded);validateDocument(downloaded);writeStage(held,downloaded) }
                finally { downloaded.fill(0) }
                bytes=readStage(held) ?: throw LiveFailure("privacy_export_staged_copy_unavailable")
            }
            current();proof.assertBytes(bytes!!);validateDocument(bytes!!)
            // A previous staging/journal write may have lost its local acknowledgement. Require durable confirmation again.
            save(held.copy(staged=true))
            val receipt=ack(held)
            if(receipt.keys!=setOf("acknowledged","delivery_id","request_id") || receipt["acknowledged"]!=true || receipt["delivery_id"]!=proof.id || receipt["request_id"]!=held.request)throw LiveFailure("privacy_export_unverified")
            current();publish(bytes!!,::current);current();save(held.copy(completed=true));return held
        } finally { bytes?.fill(0) }
    }
}
