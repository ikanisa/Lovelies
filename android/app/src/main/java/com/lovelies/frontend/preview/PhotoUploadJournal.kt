package com.lovelies.frontend.preview

/** Durable intentions contain no credentials or media. Bytes live in the private encrypted staging store. */
data class PhotoUploadFile(
    val localId: String,val uri: String,val title: String,val contentType: String?=null,
    val byteSize: Long=0,val sha256: String?=null,val assetId: String?=null,val version: String?=null,
    val reserveKey: String="android-upload-reserve-${java.util.UUID.randomUUID()}",
    val completeKey: String="android-upload-complete-${java.util.UUID.randomUUID()}",val cancelKey: String="android-upload-cancel-${java.util.UUID.randomUUID()}",
    val acknowledged: Long=0,val status: String="staging",val error: String?=null
) {
    fun wire(): WireObject=mapOf("local_id" to localId,"uri" to uri,"title" to title,"content_type" to contentType,
        "byte_size" to byteSize,"sha256" to sha256,"asset_id" to assetId,"version" to version,
        "reserve_key" to reserveKey,"complete_key" to completeKey,"cancel_key" to cancelKey,
        "acknowledged" to acknowledged,"status" to status,"error" to error)
    fun bindStatus(value: WireObject,batch: String): PhotoUploadFile {
        if(NativeProtocol.id(value["asset_id"])!=assetId || NativeProtocol.id(value["version"])!=version
            || NativeProtocol.mediaSource(value["source"])!="personal" || NativeProtocol.id(value["upload_batch_id"])!=batch
            || NativeProtocol.integer(value["byte_size"],1,MAX_BYTES)!=byteSize || value["content_type"]!=contentType
            || value["checksum_sha256"]!=sha256 || value["resumable"]!=true || NativeProtocol.integer(value["maximum_chunk_bytes"],262144,262144)!=262144L)throw LiveFailure("upload_scope_changed")
        val next=NativeProtocol.text(value["status"])
        if(next !in SERVER_STATES)throw LiveFailure("upload_status_invalid")
        val received=NativeProtocol.integer(value["bytes_received"],0,byteSize)
        if(received!=byteSize && received%262144!=0L)throw LiveFailure("upload_status_invalid")
        if(next in setOf("uploaded","processing","ready","failed") && received!=byteSize)throw LiveFailure("upload_status_invalid")
        if(received<acknowledged && next!="cancelled")throw LiveFailure("upload_progress_changed")
        return copy(acknowledged=received,status=next,error=(value["error_code"] as? String)?.take(100))
    }
    companion object {
        const val MAX_BYTES=20L*1024*1024
        val TYPES=setOf("image/jpeg","image/png","image/webp")
        val SERVER_STATES=setOf("uploading","uploaded","processing","ready","failed","cancelled")
        private fun key(row: WireObject,name: String)=NativeProtocol.text(row[name],200).takeIf { Regex("^[A-Za-z0-9_-]{8,200}$").matches(it) } ?: throw LiveFailure("upload_journal_invalid")
        fun restore(value: Any?): PhotoUploadFile {
            val row=NativeProtocol.obj(value);val size=NativeProtocol.integer(row["byte_size"],0,MAX_BYTES)
            val type=(row["content_type"] as? String)?.also { if(it !in TYPES)throw LiveFailure("upload_journal_invalid") }
            val hash=(row["sha256"] as? String)?.also { if(!Regex("^[0-9a-f]{64}$").matches(it))throw LiveFailure("upload_journal_invalid") }
            val asset=(row["asset_id"] as? String)?.let(NativeProtocol::id);val version=(row["version"] as? String)?.let(NativeProtocol::id)
            val status=NativeProtocol.text(row["status"])
            if(status !in SERVER_STATES+setOf("staging","staged","reserving") || (asset==null)!=(version==null)
                || size==0L && hash!=null || size>0 && (hash==null || type==null)
                || status=="reserving" && (hash==null || size==0L)
                || asset!=null && size==0L || status in SERVER_STATES && asset==null || asset!=null && status !in SERVER_STATES)throw LiveFailure("upload_journal_invalid")
            return PhotoUploadFile(NativeProtocol.id(row["local_id"]),NativeProtocol.text(row["uri"],8192),NativeProtocol.text(row["title"],500),type,size,hash,asset,version,
                key(row,"reserve_key"),key(row,"complete_key"),key(row,"cancel_key"),
                NativeProtocol.integer(row["acknowledged"],0,size),status,(row["error"] as? String)?.take(100))
        }
    }
}

data class PhotoUploadBatch(val origin: String,val account: String,val device: String,val batch: String,
    val picked: List<String>,val selected: List<String>,val caption: String,val files: List<PhotoUploadFile>,
    val paused: Boolean=true,val cancelling: Boolean=false,val error: String?=null) {
    val finished get()=files.isNotEmpty() && files.all { it.status=="ready" }
    val cancelled get()=cancelling && files.all { if(it.assetId==null)it.status!="reserving" else it.status in setOf("cancelled","processing","ready","failed") }
    val bytesAcknowledged get()=files.sumOf { it.acknowledged }
    val bytesTotal get()=files.sumOf { it.byteSize }
    val readyCount get()=files.count { it.status=="ready" }
    val assetIds get()=files.mapNotNull { it.assetId }
    fun assertOwner(expectedOrigin: String,expectedAccount: String?,expectedDevice: String?) {
        if(origin!=expectedOrigin || account!=expectedAccount || device!=expectedDevice)throw LiveFailure("upload_account_changed")
    }
    fun replace(file: PhotoUploadFile)=copy(files=files.map { if(it.localId==file.localId)file else it })
    fun wire(): WireObject=mapOf("version" to 1,"origin" to origin,"account" to account,"device" to device,"batch" to batch,
        "picked" to picked,"selected" to selected,"caption" to caption,"files" to files.map(PhotoUploadFile::wire),"paused" to paused,"cancelling" to cancelling,"error" to error)
    companion object {
        fun create(origin: String,account: String,device: String,batch: String,picked: List<String>,selected: List<String>,caption: String): PhotoUploadBatch {
            val files=selected.mapIndexed { index,uri -> PhotoUploadFile(java.util.UUID.randomUUID().toString(),uri,caption.ifBlank { "Photo ${index+1}" }) }
            return restore(mapOf("version" to 1,"origin" to origin,"account" to account,"device" to device,"batch" to batch,
                "picked" to picked,"selected" to selected,"caption" to caption,"files" to files.map(PhotoUploadFile::wire),"paused" to true,"cancelling" to false),origin)
        }
        fun restore(value: Any?,expectedOrigin: String): PhotoUploadBatch {
            val row=NativeProtocol.obj(value)
            if(row["version"]!=1 && (row["version"] as? Number)?.toInt()!=1 || row["origin"]!=expectedOrigin)throw LiveFailure("upload_journal_invalid")
            fun uris(key: String): List<String> =(row[key] as? List<*>)?.takeIf { it.size in 1..100 }?.map { NativeProtocol.text(it,8192) }
                ?.takeIf { it.toSet().size==it.size } ?: throw LiveFailure("upload_journal_invalid")
            val picked=uris("picked");val selected=uris("selected")
            val files=NativeProtocol.rows(row["files"]).map(PhotoUploadFile::restore)
            if(!picked.containsAll(selected) || files.map { it.uri }!=selected || files.map { it.localId }.toSet().size!=files.size
                || files.mapNotNull { it.assetId }.let { it.toSet().size!=it.size }
                || files.flatMap { listOf(it.reserveKey,it.completeKey,it.cancelKey) }.let { it.toSet().size!=it.size }
                || row["paused"] !is Boolean || row["cancelling"] !is Boolean)throw LiveFailure("upload_journal_invalid")
            return PhotoUploadBatch(expectedOrigin,NativeProtocol.id(row["account"]),NativeProtocol.id(row["device"]),NativeProtocol.id(row["batch"]),picked,selected,
                NativeProtocol.text(row["caption"],200),files,row["paused"] as Boolean,row["cancelling"] as Boolean,(row["error"] as? String)?.take(100))
        }
    }
}
