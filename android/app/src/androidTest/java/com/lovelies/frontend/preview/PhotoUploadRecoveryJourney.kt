package com.lovelies.frontend.preview

import android.content.Context
import android.net.Uri
import android.util.AtomicFile
import kotlinx.coroutines.delay
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

/** Drops replies only after the real Worker accepted them; checkpoints survive separate instrumented processes. */
internal class PhotoUploadRecoveryJourney(private val context: Context,private val origin: String,port: Int,
    private val selfies: List<String>,private val photos: List<Pair<String,String>>,private val input: (String)->ByteArray,
    private val importPhoto: (String,ByteArray)->Uri,private val beforeUpload: suspend ()->Unit,
    private val pass: (String,WireObject)->Unit): AutoCloseable {
    private val relay=EnrollmentReplyLossRelay(origin,port)
    val endpoint get()=relay.url
    private val checkpoint=AtomicFile(File(context.noBackupFilesDir,"upload-recovery-checkpoint.json"))
    private var marker: WireObject=if(checkpoint.baseFile.exists())jsonMap(JSONObject(checkpoint.readFully().toString(Charsets.UTF_8))) else emptyMap()
    val account get()=NativeProtocol.id(marker["account"])
    val batch get()=NativeProtocol.id(marker["batch"])
    val ids get()=NativeProtocol.obj(marker["ids"]).mapValues { NativeProtocol.id(it.value) }
    private fun durable(repo: CloudflareRepository,phase: String) {
        val record=repo.photoUploads() ?: error("Upload journal missing")
        val next=mapOf("account" to record.account,"device" to record.device,"alias" to repo.identity!!.alias,"batch" to record.batch,
            "phase" to phase,"origin" to endpoint,"names" to photos.map { it.first },"manifest" to record.wire(),
            "ids" to photos.mapIndexedNotNull { index,pair ->record.files[index].assetId?.let { pair.first to it } }.toMap())
        val bytes=NativeProtocol.canonical(next).toByteArray();val stream=checkpoint.startWrite()
        try { stream.write(bytes);checkpoint.finishWrite(stream);marker=next }
        catch(problem: Throwable) { checkpoint.failWrite(stream);throw problem } finally { bytes.fill(0) }
    }
    private fun same(repo: CloudflareRepository): PhotoUploadBatch {
        val record=repo.photoUploads() ?: error("Durable upload journal missing")
        check(record.account==account && record.device==marker["device"] && record.batch==batch && record.origin==endpoint)
        check(repo.identity?.alias==marker["alias"] && repo.credentials?.account==account && repo.credentials?.method=="registered_face")
        SecureSession(context,endpoint).existingDevice(repo.identity!!.alias)
        val original=PhotoUploadBatch.restore(marker["manifest"],endpoint)
        check(record.picked==original.picked && record.selected==original.selected && record.caption==original.caption)
        check(record.files.map { listOf(it.localId,it.uri,it.sha256,it.byteSize,it.title,it.reserveKey,it.completeKey,it.cancelKey) }==
            original.files.map { listOf(it.localId,it.uri,it.sha256,it.byteSize,it.title,it.reserveKey,it.completeKey,it.cancelKey) })
        return record
    }
    private suspend fun restored(): CloudflareRepository {
        val before=relay.anonymousCalls.get();val repo=CloudflareRepository(context,endpoint)
        check(repo.bootstrap()["authenticated"]==true);check(relay.anonymousCalls.get()==before)
        val record=same(repo);check(record.paused)
        pass("T01 encrypted upload journal restores original account/device, batch, ordered subset, caption and operation keys without anonymous replacement",
            mapOf("phase" to marker["phase"],"files" to record.files.size,"picked" to record.picked.size,"selected" to record.selected.size,"batch" to record.batch))
        return repo
    }
    private suspend fun lost(block: suspend ()->Unit) {
        try { block();error("Expected accepted-mutation reply loss") }
        catch(problem: LiveFailure) { check(problem.code=="connection_unavailable" && problem.ambiguous) { "Unexpected recovery failure ${problem.code} (${problem.status})" } }
        relay.assertHealthy();check(relay.lastLostStatus.get() in 200..299);relay.release()
    }
    private suspend fun preferences(repo: CloudflareRepository) {
        val policy=repo.photoPreferences();repo.mutate("photo.preferences",mapOf("policy_version" to policy["policy_version"],"receive_matches" to true,
            "photo_matching_consent" to true,"processing_consent" to true),"account",path="/me/photo-preferences")
    }
    suspend fun run(until: String="finish"): CloudflareRepository? {
        check(until in setOf("start","capture","completion","finish"))
        if(marker.isEmpty()) {
            val repo=CloudflareRepository(context,endpoint);check(repo.bootstrap()["authenticated"]==false)
            val original=repo.credentials!!.account;repo.faceChallenge()
            selfies.forEach { path ->val bytes=input(path);try { repo.faceCapture(bytes) } finally { bytes.fill(0) } }
            check(repo.credentials?.method=="registered_face" && repo.credentials?.account==original);preferences(repo);beforeUpload()
            val uris=photos.mapIndexed { index,pair ->
                val bytes=input(pair.second)
                if(index==0)check(bytes.size>2*262144) { "First declared photo must span at least three actual chunks" }
                try { importPhoto(pair.first,bytes) } finally { bytes.fill(0) }
            }
            val extra=input(photos.first().second);val excluded=try { importPhoto("not-selected",extra) } finally { extra.fill(0) }
            repo.preparePhotoUploads(uris+excluded,uris,"Recovered private photos")
            relay.beforeDispatch={ path -> if(path=="/uploads/session") {
                val record=PhotoUploadBatch.restore(SecureSession(context,endpoint).load()["photo_uploads"],endpoint)
                check(record.files.all { it.sha256!=null && it.byteSize>0 }) { "Every selected photo must be durably staged before reserving" }
                check(repo.pending?.key==record.files.first().reserveKey)
            } }
            relay.arm("/uploads/session");lost { repo.resumePhotoUploads() };relay.beforeDispatch=null
            check(repo.pending?.action=="photo.upload.reserve" && repo.photoUploads()!!.files.all { it.assetId==null })
            durable(repo,"start")
            pass("T01 lost reserve reply retains one original operation and a fully staged selected subset before process restart",
                mapOf("staged_files" to uris.size,"unselected_files" to 1,"first_source_bytes" to repo.photoUploads()!!.files.first().byteSize,
                    "first_source_sha256" to repo.photoUploads()!!.files.first().sha256,"derived_fixture_scope" to "Declared P2-large fixture from shared manifest; original decoded pixels verified separately by root"))
            if(until=="start")return null
        } else check(marker["phase"] in setOf("start","capture","completion")) { "Refusing to repeat a completed upload fixture run" }
        if(marker["phase"]=="start") {
            val repo=restored();val file=same(repo).files.first()
            val reserve=repo.communityRead("operation",mapOf("operation_key" to file.reserveKey))
            check(reserve["upload_batch_id"]==batch)
            check(reserve["status"]!="unknown")
            // The production reserve call uses that same persisted key and recovers its receipt into the file journal.
            val asset=NativeProtocol.id(reserve["asset_id"]);relay.arm("/uploads/$asset/chunks?offset=0")
            lost { repo.resumePhotoUploads() }
            val current=repo.photoUploads()!!.files.first();check(current.assetId==asset && current.acknowledged==0L)
            check(NativeProtocol.integer(repo.get("/uploads/$asset/status")["bytes_received"])==262144L)
            durable(repo,"capture")
            pass("T03 lost first chunk reply leaves the client offset unacknowledged while Cloudflare durably retains 262144 bytes on the original asset",
                mapOf("accepted_server_bytes" to 262144,"client_acknowledged_bytes" to 0,"asset_id" to asset))
            if(until=="capture")return null
        }
        if(marker["phase"]=="capture") {
            val repo=restored();val file=same(repo).files.first();val asset=file.assetId!!;val replayedZero=AtomicInteger()
            relay.beforeDispatch={ path ->if(path=="/uploads/$asset/chunks?offset=0")replayedZero.incrementAndGet() }
            relay.arm("/uploads/$asset/complete");lost { repo.resumePhotoUploads() };relay.beforeDispatch=null
            check(replayedZero.get()==0) { "Already retained chunk was sent again instead of using status offset" }
            val current=repo.photoUploads()!!.files.first();check(current.assetId==asset && current.acknowledged==current.byteSize && current.status=="uploaded")
            check(repo.pending?.key==current.completeKey && repo.pending?.action=="photo.upload.complete")
            durable(repo,"completion")
            pass("T03 recovery skips the retained chunk and lost completion keeps the original complete operation after all source bytes were accepted",
                mapOf("replayed_first_chunks" to 0,"accepted_bytes" to current.acknowledged,"asset_id" to asset))
            if(until=="completion")return null
        }
        check(marker["phase"]=="completion")
        val repo=restored();val first=same(repo).files.first();val completeCount=AtomicInteger()
        relay.beforeDispatch={ path ->if(path=="/uploads/${first.assetId}/complete")completeCount.incrementAndGet() }
        repo.resumePhotoUploads();relay.beforeDispatch=null
        check(completeCount.get()==0) { "Known accepted complete was resent instead of reconciling operation status" }
        var ready=false;var polls=0
        while(!ready && polls++<180) {
            val record=repo.refreshPhotoUploads()
            check(record.files.none { it.status=="failed" }) { "Actual processing failed: ${record.files.firstOrNull { it.status=="failed" }?.error}" }
            ready=record.finished;if(!ready)delay(1000)
        }
        val finished=repo.photoUploads()!!;check(finished.finished && finished.assetIds.toSet().size==photos.size)
        check(repo.pending==null && finished.files.all { !SecureSession(context,endpoint).hasStagedPhoto(it.localId) })
        durable(repo,"finish")
        pass("T01/T03 all resumed original assets finish real R2/Queue/model processing; ready originals are removed from private local staging",
            mapOf("assets" to finished.assetIds.size,"same_complete_posts" to completeCount.get(),"processing_creates_access" to false))
        verifyPauseCancel(repo)
        return repo
    }
    private suspend fun verifyPauseCancel(owner: CloudflareRepository) {
        val directory=File(context.noBackupFilesDir,"isolated-cancel-test").apply { check(isDirectory || mkdirs()) }
        val child=object: android.content.ContextWrapper(context) {
            override fun getNoBackupFilesDir()=directory
        }
        val held=SecureSession(context,endpoint).load().filterKeys { it !in setOf("photo_uploads","upload_draft","pending") }
        SecureSession(child,endpoint).save(held)
        var repo=CloudflareRepository(child,endpoint);check(repo.bootstrap()["authenticated"]==true)
        val bytes=input(photos.first().second)
        val uri=try { importPhoto("cancel-transfer",bytes) } finally { bytes.fill(0) }
        val neverDispatched=repo.preparePhotoUploads(listOf(uri),listOf(uri),"Cancel before first reservation")
        val unexpectedWrites=AtomicInteger()
        relay.beforeDispatch={ path ->if(path=="/uploads/session" || path.contains("/chunks?") || path.endsWith("/complete"))unexpectedWrites.incrementAndGet() }
        repo.requestPhotoUploadCancellation()
        val localRecovery=repo.openPhotoUploadBatch(false,emptyList(),emptyList(),"Must not replace the cancelled selection")
        check(localRecovery.batch==neverDispatched.batch && localRecovery.files==neverDispatched.files && localRecovery.cancelling)
        val localCancelled=repo.resumePhotoUploads();relay.beforeDispatch=null
        check(localCancelled.cancelled && localCancelled.batch==neverDispatched.batch && localCancelled.files==neverDispatched.files && unexpectedWrites.get()==0)
        pass("T03 cancelling before first reserve resumes the original nil-asset batch with no reservation, chunk or completion dispatch",
            mapOf("batch" to localCancelled.batch,"new_upload_writes" to 0))

        val beforeLostReserve=repo.preparePhotoUploads(listOf(uri),listOf(uri),"Cancel unknown reserve")
        relay.arm("/uploads/session");lost { repo.resumePhotoUploads() }
        val uncertain=repo.photoUploads()!!;val nil=uncertain.files.single()
        check(nil.assetId==null && nil.status=="reserving" && repo.pending?.key==nil.reserveKey && nil.reserveKey==beforeLostReserve.files.single().reserveKey)
        val actual=repo.communityRead("operation",mapOf("operation_key" to nil.reserveKey));val acceptedAsset=NativeProtocol.id(actual["asset_id"])
        repo.requestPhotoUploadCancellation()
        repo=CloudflareRepository(child,endpoint);check(repo.bootstrap()["authenticated"]==true)
        val sameRecovery=repo.openPhotoUploadBatch(false,emptyList(),emptyList(),"Do not create a new batch")
        check(sameRecovery.batch==beforeLostReserve.batch && sameRecovery.files.single().reserveKey==nil.reserveKey && sameRecovery.cancelling && !sameRecovery.cancelled)
        val repeatedReserve=AtomicInteger();val sentChunks=AtomicInteger()
        relay.beforeDispatch={ path ->if(path=="/uploads/session")repeatedReserve.incrementAndGet();if(path.contains("/chunks?"))sentChunks.incrementAndGet() }
        val recoveredCancellation=repo.resumePhotoUploads();relay.beforeDispatch=null
        check(recoveredCancellation.cancelled && recoveredCancellation.batch==beforeLostReserve.batch && recoveredCancellation.files.single().assetId==acceptedAsset)
        check(recoveredCancellation.files.single().reserveKey==nil.reserveKey && recoveredCancellation.files.single().cancelKey==nil.cancelKey && repeatedReserve.get()==0 && sentChunks.get()==0)
        val cancelledStatus=repo.get("/uploads/$acceptedAsset/status")
        check(cancelledStatus["status"]=="cancelled" && NativeProtocol.integer(cancelledStatus["bytes_received"])==0L)
        pass("T03 cancellation after a lost reserve reply reconciles the original nil-asset intention and cancels that exact server asset without a new batch or any chunks",
            mapOf("batch" to recoveredCancellation.batch,"asset_id" to acceptedAsset,"repeated_reserve_posts" to 0,"chunk_puts" to 0))

        repo.preparePhotoUploads(listOf(uri),listOf(uri),"Cancel this unfinished transfer")
        var pause=true
        try { repo.resumePhotoUploads { progress ->if(pause && progress.bytesAcknowledged==262144L) { pause=false;repo.pausePhotoUploads() } };error("Paused transfer continued") }
        catch(problem: LiveFailure) { check(problem.code=="upload_paused") }
        val file=repo.photoUploads()!!.files.single();check(file.acknowledged==262144L && file.status=="uploading" && repo.photoUploads()!!.paused)
        delay(150);check(NativeProtocol.integer(repo.get("/uploads/${file.assetId}/status")["bytes_received"])==262144L)
        pass("T03 Pause stops scheduling after one acknowledged chunk and retains the exact unfinished photo",mapOf("accepted_bytes" to 262144))
        repo.requestPhotoUploadCancellation();relay.arm("/uploads/${file.assetId}/cancel");lost { repo.resumePhotoUploads() }
        check(repo.pending?.key==file.cancelKey)
        repo=CloudflareRepository(child,endpoint);check(repo.bootstrap()["authenticated"]==true)
        val cancelled=repo.resumePhotoUploads();check(cancelled.cancelled && cancelled.files.single().assetId==file.assetId && repo.pending==null)
        val status=repo.get("/uploads/${file.assetId}/status");check(status["status"]=="cancelled" && status["processing_creates_access"]==false)
        check(!SecureSession(child,endpoint).hasStagedPhoto(file.localId))
        check(owner.photoUploads()!!.finished && owner.credentials?.account==account)
        pass("T03 interrupted cancellation recovers the original cancel key, deletes local staged bytes and preserves already completed photos",
            mapOf("cancelled_asset" to file.assetId,"cleanup_pending" to status["cleanup_pending"],"ready_batch_unchanged" to true))
        repo.invalidateReads();check(directory.deleteRecursively())
    }
    override fun close() { relay.close() }
}
