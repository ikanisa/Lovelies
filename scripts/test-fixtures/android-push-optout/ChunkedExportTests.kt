package com.lovelies.frontend.preview

import java.io.IOException
import java.time.Instant
import java.security.MessageDigest
import kotlinx.coroutines.runBlocking

/** Runs the real protocol parser/recovery engine against bounded synthetic file/transport ports. */
private class ChunkFixture(size:Int=1048576+19) {
    private val account="00000000-0000-4000-8000-000000000091"
    private val session="00000000-0000-4000-8000-000000000092"
    private val request="00000000-0000-4000-8000-000000000093"
    private val delivery="00000000-0000-4000-8000-000000000094"
    private val publication="00000000-0000-4000-8000-000000000095"
    private val now=Instant.parse("2026-10-29T12:00:00Z").toEpochMilli()
    val payload=ByteArray(size) { 'a'.code.toByte() }.also { bytes ->
        "{\"value\":\"".toByteArray().copyInto(bytes);"\"}".toByteArray().copyInto(bytes,bytes.size-2)
        // UTF-8 code point deliberately crosses the chunk boundary.
        bytes[1048575]=0xe2.toByte();bytes[1048576]=0x82.toByte();bytes[1048577]=0xac.toByte()
    }
    val initial=PrivacyExportIntent.create("https://fixture",account,session,"1".repeat(64),now+3_600_000,request,now,1_000)
    private val descriptors:List<WireObject>
    val proof:PrivacyExportDelivery
    val pages=mutableMapOf<Int,WireObject>();private val decoded=mutableMapOf<String,WireObject>()
    val files=mutableMapOf<String,ByteArray>();val reads=mutableListOf<Int>();val manifests=mutableListOf<Int>()
    val createKeys=mutableListOf<String>();val ackKeys=mutableListOf<String>()
    var durable=initial;var acknowledged=false;var published=0;var outputHash:String?=null;var outputCount=0L
    var failChunk:Int?=null;var failStaging:Int?=null;var failAck=false;var failPublish=false;var failStagedJournal=false
    var current=true;var expired=false;var afterAck:(()->Unit)?=null
    init {
        val count=(payload.size+1048575)/1048576
        var previous=ExportManifestPage.seed(PrivacyExportDelivery(delivery,now+3_600_000,NativeProtocol.sha256(payload),payload.size.toLong(),false,publication,count,1048576,"0".repeat(64)))
        descriptors=(0 until count).map { index ->
            val bytes=payload.copyOfRange(index*1048576,minOf(payload.size,(index+1)*1048576))
            val digest=NativeProtocol.sha256(bytes);previous=ExportManifestPage.next(previous,index,bytes.size,digest)
            mapOf("index" to index,"bytes" to bytes.size,"sha256" to digest,"root_sha256" to previous,"retrieve_path" to "/privacy-exports/deliveries/$delivery/chunks/$index")
        }
        proof=PrivacyExportDelivery(delivery,now+3_600_000,NativeProtocol.sha256(payload),payload.size.toLong(),false,publication,count,1048576,previous)
        for(offset in 0 until count step 128) {
            val rows=descriptors.drop(offset).take(128)
            val page=mapOf("protocol" to "lovelies-privacy-export-manifest-v1","publication_id" to publication,"total_bytes" to proof.bytes,"sha256" to proof.hash,
                "chunk_count" to proof.chunks,"chunk_bytes" to proof.chunkBytes,"manifest_sha256" to proof.manifestHash,"offset" to offset,
                "next_offset" to if(offset+rows.size<count)offset+rows.size else null,"previous_root" to if(offset==0)ExportManifestPage.seed(proof) else descriptors[offset-1]["root_sha256"],"chunks" to rows)
            pages[offset]=page;decoded[NativeProtocol.canonical(page)]=page
        }
    }
    private fun assertOwned(value:PrivacyExportIntent) {
        check(value.owns(initial.origin,account,session,initial.tokenHash))
        if(!current)throw LiveFailure("session_changed")
        if(expired)throw LiveFailure("privacy_export_delivery_expired")
    }
    private fun persist(value:PrivacyExportIntent) {
        assertOwned(value);durable=PrivacyExportIntent.restore(value.wire(),initial.origin)
        if(failStagedJournal && value.staged) { failStagedJournal=false;throw IOException("Lost staged journal reply") }
    }
    private fun response(value:PrivacyExportIntent):WireObject=mapOf("protocol" to "lovelies-privacy-export-delivery-v3","operation_key" to value.createKey,"request_id" to request,
        "delivery_id" to delivery,"account_id" to account,"session_id" to session,"state" to if(acknowledged)"acknowledged" else "available",
        "expires_at" to Instant.ofEpochMilli(proof.expires).toString(),"sha256" to proof.hash,"bytes" to proof.bytes,"retrieve_path" to proof.retrievePath,"ack_path" to proof.ackPath,
        "publication_id" to proof.publication,"chunk_count" to proof.chunks,"chunk_bytes" to proof.chunkBytes,"manifest_sha256" to proof.manifestHash)
    private fun chunks()=ChunkedPrivacyExportRecovery(::persist,::assertOwned,
        read={ _,id->files[id]?.copyOf() },write={ value,id,bytes->
            files[id]=bytes.copyOf()
            if(failStaging?.let { id==ExportChunkFiles.id(value,"chunk",it) }==true) { failStaging=null;throw IOException("Lost chunk write reply") }
        },decode={ decoded[it.toString(Charsets.UTF_8)] ?: throw LiveFailure("privacy_export_unverified") },
        fetchManifest={ path->check(!acknowledged);val offset=path.substringAfter("offset=").toInt();manifests.add(offset);pages[offset]!! },
        fetchChunk={ path->check(!acknowledged);val index=path.substringAfterLast('/').toInt();reads.add(index)
            if(failChunk==index) { failChunk=null;throw IOException("Lost chunk response") }
            payload.copyOfRange(index*1048576,minOf(payload.size,(index+1)*1048576)) },
        ack={ value->check(durable.staged);check(value.createKey!=value.ackKey);ackKeys.add(value.ackKey);acknowledged=true
            if(failAck) { failAck=false;throw IOException("Lost ACK reply") };afterAck?.invoke()
            mapOf("acknowledged" to true,"delivery_id" to delivery,"request_id" to request) },
        publish={ pump->if(failPublish) { failPublish=false;throw IOException("Document unavailable") }
            val hash=MessageDigest.getInstance("SHA-256");var count=0L
            pump { bytes->check(bytes.size<=1048576);hash.update(bytes);count+=bytes.size }
            outputHash=hash.digest().joinToString("") { "%02x".format(it.toInt() and 255) };outputCount=count;published++ })
    private fun engine()=PrivacyExportRecovery(::persist,::assertOwned,
        create={ value->createKeys.add(value.createKey);response(value) },retrieve={ error("v2 GET used for chunked export") },
        readStage={ error("v2 file used for chunked export") },writeStage={ _,_->error("v2 write used") },validateDocument={ error("v2 document used") },
        ack={ error("v2 ACK used") },publish={ _,_->error("v2 publish used") },chunkedRun={ chunks().run(it) })
    fun attempt()=runCatching { runBlocking { engine().run(durable) } }
    fun success() { check(attempt().isSuccess);check(durable.completed && published==1 && outputHash==proof.hash && outputCount==proof.bytes) }
}

fun runChunkedExportChecks(run:(String,()->Unit)->Unit) {
    run("large export streams over 20 MiB and preserves UTF-8 across raw chunk boundaries") {
        val fixture=ChunkFixture(21*1048576+19);fixture.success()
        check(fixture.reads.size==22 && fixture.manifests==listOf(0));check(fixture.files.values.all { it.size<=1048576 })
    }
    run("chunk download interruption resumes the same create and acknowledgement identities") {
        val fixture=ChunkFixture();fixture.failChunk=1;check(fixture.attempt().isFailure);check(fixture.ackKeys.isEmpty())
        fixture.success();check(fixture.reads==listOf(0,1,1) && fixture.manifests==listOf(0));check(fixture.createKeys.toSet().size==1)
    }
    run("lost chunk write acknowledgement reuses only exact verified local chunks") {
        val fixture=ChunkFixture();fixture.failStaging=0;check(fixture.attempt().isFailure);fixture.success();check(fixture.reads==listOf(0,1))
    }
    run("lost chunk export journal acknowledgement resumes durable staging before ACK") {
        val fixture=ChunkFixture();fixture.failStagedJournal=true;check(fixture.attempt().isFailure && fixture.ackKeys.isEmpty())
        fixture.success();check(fixture.reads==listOf(0,1))
    }
    run("lost large export ACK reply recovers from protected chunks without another remote GET") {
        val fixture=ChunkFixture();fixture.failAck=true;check(fixture.attempt().isFailure && fixture.acknowledged)
        fixture.success();check(fixture.reads==listOf(0,1) && fixture.manifests==listOf(0));check(fixture.ackKeys.size==2 && fixture.ackKeys.toSet().size==1)
    }
    run("missing acknowledged chunk preserves evidence and cannot publish or fetch retired publication") {
        val fixture=ChunkFixture();fixture.failPublish=true;check(fixture.attempt().isFailure && fixture.acknowledged)
        fixture.files.remove(ExportChunkFiles.id(fixture.durable,"chunk",1));check(fixture.attempt().isFailure)
        check(fixture.published==0 && fixture.reads==listOf(0,1) && !fixture.durable.completed)
    }
    run("corrupted acknowledged chunk is rejected before publication without overwriting evidence") {
        val fixture=ChunkFixture();fixture.failAck=true;check(fixture.attempt().isFailure)
        val id=ExportChunkFiles.id(fixture.durable,"chunk",0);fixture.files[id]!![100]=0
        check(fixture.attempt().isFailure && fixture.files[id]!![100].toInt()==0 && fixture.published==0)
    }
    run("logout or expiry while large export ACK returns closes publication") {
        for(expire in listOf(false,true)) {
            val fixture=ChunkFixture();fixture.afterAck={ if(expire)fixture.expired=true else fixture.current=false }
            check(fixture.attempt().isFailure && fixture.acknowledged && fixture.published==0 && !fixture.durable.completed)
        }
    }
    run("manifest rejects out-of-scope paths hashes counts and unexpected continuation") {
        val fixture=ChunkFixture();val page=fixture.pages[0]!!;val first=(page["chunks"] as List<*>).first() as Map<*,*>
        val rows=(page["chunks"] as List<*>).map { NativeProtocol.obj(it) }
        for(candidate in listOf(page+("next_offset" to 128),page+("total_bytes" to fixture.proof.bytes+1),
            page+("chunks" to (listOf(NativeProtocol.obj(first)+("retrieve_path" to "https://other.invalid/chunk"))+rows.drop(1))),
            page+("chunks" to (listOf(NativeProtocol.obj(first)+("sha256" to "0".repeat(64)))+rows.drop(1))))) {
            check(runCatching { ExportManifestPage.parse(candidate,fixture.proof,0,ExportManifestPage.seed(fixture.proof)) }.isFailure)
        }
    }
    run("manifest pagination binds 128-row pages to the previous root and total publication") {
        val fixture=ChunkFixture();val original=fixture.proof
        val count=129;var root=ExportManifestPage.seed(original);val digest="a".repeat(64)
        val descriptors=(0 until count).map { index ->
            val bytes=if(index==128)19 else 1048576;root=ExportManifestPage.next(root,index,bytes,digest)
            mapOf("index" to index,"bytes" to bytes,"sha256" to digest,"root_sha256" to root,"retrieve_path" to original.chunkPath(index))
        }
        val proof=original.copy(chunks=count,bytes=128L*1048576+19,manifestHash=root)
        fun page(offset:Int):WireObject=fixture.pages[0]!!+mapOf("chunk_count" to count,"total_bytes" to proof.bytes,"manifest_sha256" to root,
            "offset" to offset,"next_offset" to if(offset==0)128 else null,"previous_root" to if(offset==0)ExportManifestPage.seed(proof) else descriptors[127]["root_sha256"],"chunks" to descriptors.drop(offset).take(128))
        val first=ExportManifestPage.parse(page(0),proof,0,ExportManifestPage.seed(proof));check(first.next==128)
        val last=ExportManifestPage.parse(page(128),proof,128,first.chunks.last().root);check(last.next==null && last.chunks.size==1)
        check(runCatching { ExportManifestPage.parse(page(128),proof,128,"0".repeat(64)) }.isFailure)
    }
}
