package com.lovelies.frontend.preview

import java.security.MessageDigest

internal data class ExportChunk(val index: Int,val bytes: Int,val hash: String,val root: String,val path: String)
internal data class ExportManifestPage(val offset: Int,val next: Int?,val previous: String,val chunks: List<ExportChunk>) {
    companion object {
        const val PAGE_SIZE=128
        private fun hash(value: Any?): String=NativeProtocol.text(value,64).also {
            if(!Regex("[0-9a-f]{64}").matches(it))throw LiveFailure("privacy_export_unverified")
        }
        fun seed(proof: PrivacyExportDelivery)=NativeProtocol.sha256(NativeProtocol.canonical(mapOf(
            "protocol" to "lovelies-privacy-export-chunks-v1","publication_id" to proof.publication)).toByteArray(Charsets.UTF_8))
        fun next(previous: String,index: Int,bytes: Int,sha256: String)=NativeProtocol.sha256(NativeProtocol.canonical(mapOf(
            "previous_sha256" to previous,"index" to index,"bytes" to bytes,"sha256" to sha256)).toByteArray(Charsets.UTF_8))
        fun parse(value: WireObject,proof: PrivacyExportDelivery,offset: Int,previous: String): ExportManifestPage {
            if(!proof.chunked || value.keys!=setOf("protocol","publication_id","total_bytes","sha256","chunk_count","chunk_bytes","manifest_sha256","offset","next_offset","previous_root","chunks") ||
                value["protocol"]!="lovelies-privacy-export-manifest-v1" || value["publication_id"]!=proof.publication || value["sha256"]!=proof.hash ||
                NativeProtocol.integer(value["total_bytes"])!=proof.bytes || NativeProtocol.integer(value["chunk_count"])!=proof.chunks.toLong() ||
                NativeProtocol.integer(value["chunk_bytes"])!=proof.chunkBytes.toLong() || value["manifest_sha256"]!=proof.manifestHash ||
                NativeProtocol.integer(value["offset"])!=offset.toLong() || offset%PAGE_SIZE!=0 || offset !in 0 until proof.chunks || value["previous_root"]!=previous)
                throw LiveFailure("privacy_export_unverified")
            val rows=NativeProtocol.rows(value["chunks"],PAGE_SIZE)
            if(rows.size!=minOf(PAGE_SIZE,proof.chunks-offset))throw LiveFailure("privacy_export_unverified")
            var root=previous
            val chunks=rows.mapIndexed { slot,row ->
                val index=offset+slot
                val length=if(index==proof.chunks-1)proof.bytes-index.toLong()*proof.chunkBytes else proof.chunkBytes.toLong()
                if(row.keys!=setOf("index","bytes","sha256","root_sha256","retrieve_path") || NativeProtocol.integer(row["index"])!=index.toLong() ||
                    NativeProtocol.integer(row["bytes"],1,proof.chunkBytes.toLong())!=length || row["retrieve_path"]!=proof.chunkPath(index))throw LiveFailure("privacy_export_unverified")
                val digest=hash(row["sha256"]);root=next(root,index,length.toInt(),digest)
                if(hash(row["root_sha256"])!=root)throw LiveFailure("privacy_export_unverified")
                ExportChunk(index,length.toInt(),digest,root,proof.chunkPath(index))
            }
            val nextOffset=if(offset+rows.size<proof.chunks)offset+rows.size else null
            val actualNext=value["next_offset"]?.let { NativeProtocol.integer(it,0,Int.MAX_VALUE.toLong()).toInt() }
            if(actualNext!=nextOffset || nextOffset==null && root!=proof.manifestHash)throw LiveFailure("privacy_export_unverified")
            return ExportManifestPage(offset,nextOffset,previous,chunks)
        }
    }
}

/** All files are exact deterministic children of the one random durable delivery identity.
 * No directory scan, arbitrary path, external URI or server-supplied filename grants ownership. */
internal object ExportChunkFiles {
    fun id(intent: PrivacyExportIntent,kind: String,index: Int): String {
        if(kind !in setOf("manifest","chunk") || index<0)throw LiveFailure("privacy_export_unverified")
        val hash=NativeProtocol.sha256(NativeProtocol.canonical(mapOf("protocol" to "lovelies-local-export-chunk-v1",
            "file" to intent.file,"kind" to kind,"index" to index)).toByteArray(Charsets.UTF_8))
        val chars=hash.take(32).toCharArray();chars[12]='8';chars[16]="89ab"[chars[16].digitToInt(16) and 3]
        val hex=String(chars);return "${hex.take(8)}-${hex.substring(8,12)}-${hex.substring(12,16)}-${hex.substring(16,20)}-${hex.substring(20)}"
    }
    fun each(intent: PrivacyExportIntent,body: (String)->Unit) {
        val proof=intent.delivery ?: return
        if(!proof.chunked)return
        for(index in 0 until proof.chunks)body(id(intent,"chunk",index))
        var offset=0
        while(offset<proof.chunks) { body(id(intent,"manifest",offset));offset+=minOf(ExportManifestPage.PAGE_SIZE,proof.chunks-offset) }
    }
}

internal typealias ExportChunkSink=(ByteArray)->Unit
internal typealias ExportChunkPump=(ExportChunkSink)->Unit

/** Holds at most one raw chunk and one bounded descriptor page. Durable readback precedes
 * advancing; restart revalidates the whole chain and every local chunk before acknowledging.
 * An acknowledged publication can be resumed entirely from its protected manifest/chunk files. */
internal class ChunkedPrivacyExportRecovery(private val persist: (PrivacyExportIntent)->Unit,
    private val assertCurrent: (PrivacyExportIntent)->Unit,
    private val read: (PrivacyExportIntent,String)->ByteArray?,private val write: (PrivacyExportIntent,String,ByteArray)->Unit,
    private val decode: (ByteArray)->WireObject,
    private val fetchManifest: suspend (String)->WireObject,private val fetchChunk: suspend (String)->ByteArray,
    private val ack: suspend (PrivacyExportIntent)->WireObject,private val publish: suspend (ExportChunkPump)->Unit) {
    suspend fun run(original: PrivacyExportIntent): PrivacyExportIntent {
        var held=original
        val proof=held.delivery?.takeIf { it.chunked } ?: throw LiveFailure("privacy_export_unverified")
        fun current()=assertCurrent(held)
        fun save(next: PrivacyExportIntent) { assertCurrent(next);persist(next);held=next }
        fun verifiedChunk(chunk: ExportChunk,bytes: ByteArray) {
            if(bytes.size!=chunk.bytes || NativeProtocol.sha256(bytes)!=chunk.hash)throw LiveFailure("privacy_export_unverified")
        }
        var offset=0;var root=ExportManifestPage.seed(proof)
        while(offset<proof.chunks) {
            current();val pageID=ExportChunkFiles.id(held,"manifest",offset)
            var bytes=read(held,pageID)
            if(bytes==null) {
                if(proof.acknowledged || held.staged)throw LiveFailure("privacy_export_staged_copy_unavailable")
                val value=fetchManifest(proof.manifestPath(offset))
                ExportManifestPage.parse(value,proof,offset,root)
                val encoded=NativeProtocol.canonical(value).toByteArray(Charsets.UTF_8)
                try { current();write(held,pageID,encoded) } finally { encoded.fill(0) }
                bytes=read(held,pageID) ?: throw LiveFailure("privacy_export_staged_copy_unavailable")
            }
            val page=try { current();ExportManifestPage.parse(decode(bytes),proof,offset,root) } finally { bytes.fill(0) }
            for(chunk in page.chunks) {
                current();val id=ExportChunkFiles.id(held,"chunk",chunk.index)
                var existing=read(held,id)
                if(existing==null) {
                    if(proof.acknowledged || held.staged)throw LiveFailure("privacy_export_staged_copy_unavailable")
                    val received=fetchChunk(chunk.path)
                    try { current();verifiedChunk(chunk,received);write(held,id,received) } finally { received.fill(0) }
                    existing=read(held,id) ?: throw LiveFailure("privacy_export_staged_copy_unavailable")
                }
                try { current();verifiedChunk(chunk,existing) } finally { existing.fill(0) }
            }
            root=page.chunks.last().root;offset=page.next ?: proof.chunks
        }
        fun pump(sink: ExportChunkSink) {
            val digest=MessageDigest.getInstance("SHA-256");var count=0L
            var cursor=0;var previous=ExportManifestPage.seed(proof)
            while(cursor<proof.chunks) {
                current();val data=read(held,ExportChunkFiles.id(held,"manifest",cursor)) ?: throw LiveFailure("privacy_export_staged_copy_unavailable")
                val page=try { ExportManifestPage.parse(decode(data),proof,cursor,previous) } finally { data.fill(0) }
                for(chunk in page.chunks) {
                    current();val bytes=read(held,ExportChunkFiles.id(held,"chunk",chunk.index)) ?: throw LiveFailure("privacy_export_staged_copy_unavailable")
                    try { verifiedChunk(chunk,bytes);digest.update(bytes);count=Math.addExact(count,bytes.size.toLong());current();sink(bytes);current() }
                    finally { bytes.fill(0) }
                }
                previous=page.chunks.last().root;cursor=page.next ?: proof.chunks
            }
            val hash=digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
            if(count!=proof.bytes || hash!=proof.hash || previous!=proof.manifestHash)throw LiveFailure("privacy_export_unverified")
            current()
        }
        // Validate full-file bytes without materializing the complete JSON document.
        pump { };save(held.copy(staged=true))
        val receipt=ack(held)
        if(receipt.keys!=setOf("acknowledged","delivery_id","request_id") || receipt["acknowledged"]!=true || receipt["delivery_id"]!=proof.id || receipt["request_id"]!=held.request)throw LiveFailure("privacy_export_unverified")
        current();publish(::pump);current();save(held.copy(completed=true));return held
    }
}
