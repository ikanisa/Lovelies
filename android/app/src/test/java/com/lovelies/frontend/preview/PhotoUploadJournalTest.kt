package com.lovelies.frontend.preview

import org.junit.Assert.*
import org.junit.Test

class PhotoUploadJournalTest {
    private val origin="http://10.0.2.2:18887"
    private val account="10000000-0000-4000-8000-000000000001"
    private val device="10000000-0000-4000-8000-000000000002"
    private val batch="10000000-0000-4000-8000-000000000003"
    private val asset="10000000-0000-4000-8000-000000000004"
    private val version="10000000-0000-4000-8000-000000000005"
    private fun journal()=PhotoUploadBatch.create(origin,account,device,batch,listOf("content://provider/one","content://provider/two","content://provider/three"),
        listOf("content://provider/three","content://provider/one"),"Same private caption")
    private fun staged(seed: PhotoUploadFile=journal().files.first())=seed.copy(contentType="image/jpeg",byteSize=600000,sha256="a".repeat(64),assetId=asset,version=version,status="uploading")
    private fun status(file: PhotoUploadFile,offset: Long=262144,state: String="uploading"): WireObject=mapOf("asset_id" to file.assetId,"version" to file.version,
        "source" to "personal","upload_batch_id" to batch,"resumable" to true,"maximum_chunk_bytes" to 262144,
        "byte_size" to file.byteSize,"content_type" to file.contentType,"checksum_sha256" to file.sha256,"bytes_received" to offset,"status" to state)
    private fun denied(code: String?=null,block: ()->Unit) {
        try { block();fail("Expected an ownership, binding or journal denial") } catch(problem: LiveFailure) { if(code!=null)assertEquals(code,problem.code) }
    }
    @Test fun restartPreservesOriginalBatchChosenOrderDeselectionsCaptionAndAllOperationKeys() {
        val before=journal();val after=PhotoUploadBatch.restore(before.wire(),origin)
        assertEquals(before,after);assertEquals(3,after.picked.size);assertEquals(2,after.selected.size)
        assertEquals(listOf("content://provider/three","content://provider/one"),after.files.map { it.uri })
        assertEquals(before.files.map { listOf(it.reserveKey,it.completeKey,it.cancelKey) },after.files.map { listOf(it.reserveKey,it.completeKey,it.cancelKey) })
    }
    @Test fun accountDeviceAndOriginMustAllMatchBeforeResuming() {
        val value=journal();value.assertOwner(origin,account,device)
        denied("upload_account_changed") { value.assertOwner(origin,asset,device) }
        denied("upload_account_changed") { value.assertOwner(origin,account,asset) }
        denied("upload_account_changed") { value.assertOwner("https://other.invalid",account,device) }
        denied { PhotoUploadBatch.restore(value.wire(),"https://other.invalid") }
    }
    @Test fun partialAcknowledgementSurvivesRestartWithoutBecomingProcessingOrAccess() {
        val original=journal();val file=staged(original.files.first());val accepted=file.bindStatus(status(file),batch)
        val value=original.replace(accepted).copy(paused=true)
        val restored=PhotoUploadBatch.restore(value.wire(),origin)
        assertEquals(262144L,restored.bytesAcknowledged);assertFalse(restored.finished);assertEquals(0,restored.readyCount)
        assertEquals("uploading",restored.files.first().status);assertTrue(restored.paused)
    }
    @Test fun changedServerAssetVersionBatchTypeSizeHashAndSourceCannotAdvanceProgress() {
        val file=staged();val changes=mapOf<String,Any?>("asset_id" to device,"version" to device,"upload_batch_id" to device,
            "content_type" to "image/png","byte_size" to 600001,"checksum_sha256" to "b".repeat(64),"source" to "professional",
            "resumable" to false,"maximum_chunk_bytes" to 524288)
        changes.forEach { (key,value)->denied { file.bindStatus(status(file)+(key to value),batch) } }
    }
    @Test fun serverCannotRegressOrInventAcknowledgedBytesOrClaimReadyBeforeCompleteSource() {
        val file=staged().copy(acknowledged=262144)
        denied("upload_progress_changed") { file.bindStatus(status(file,0),batch) }
        denied { file.bindStatus(status(file,600001),batch) }
        denied("upload_status_invalid") { file.bindStatus(status(file,262145),batch) }
        denied("upload_status_invalid") { file.bindStatus(status(file,262144,"ready"),batch) }
        assertEquals("ready",file.bindStatus(status(file,600000,"ready"),batch).status)
    }
    @Test fun acceptedBytesAndProcessedCountStayDistinctForMixedBatches() {
        val first=staged().copy(acknowledged=600000,status="processing")
        val second=journal().files[1].copy(contentType="image/jpeg",byteSize=100,sha256="b".repeat(64),assetId=device,version=account,acknowledged=100,status="ready")
        val mixed=journal().copy(files=listOf(first,second))
        assertEquals(600100L,mixed.bytesAcknowledged);assertEquals(600100L,mixed.bytesTotal);assertEquals(1,mixed.readyCount);assertFalse(mixed.finished)
    }
    @Test fun cancellationKeepsPreviouslyProcessingPhotosAndOnlySettlesWhenUnfinishedAssetsAreCancelled() {
        val first=staged().copy(acknowledged=600000,status="processing")
        val second=journal().files[1].copy(contentType="image/jpeg",byteSize=100,sha256="b".repeat(64),assetId=device,version=account,status="uploading")
        val held=journal().copy(files=listOf(first,second),cancelling=true)
        assertFalse(held.cancelled);assertTrue(held.replace(second.copy(status="cancelled")).cancelled)
        assertEquals("processing",held.replace(second.copy(status="cancelled")).files.first().status)
    }
    @Test fun cancellationBeforeFirstReservationRemainsTheSameLocalBatchWithEveryOriginalKey() {
        val original=journal();val cancelled=PhotoUploadBatch.restore(original.copy(cancelling=true).wire(),origin)
        assertTrue(cancelled.cancelled);assertEquals(original.batch,cancelled.batch)
        assertEquals(original.files,cancelled.files);assertTrue(cancelled.files.all { it.assetId==null && it.acknowledged==0L })
        assertEquals(original.selected,cancelled.selected);assertEquals(original.caption,cancelled.caption)
    }
    @Test fun locallyNilAssetWithDispatchedReserveCannotBeDeclaredCancelledBeforeOriginalReceiptRecovery() {
        val original=journal();val pending=staged(original.files.first()).copy(assetId=null,version=null,status="reserving")
        val held=PhotoUploadBatch.restore(original.replace(pending).copy(cancelling=true).wire(),origin)
        assertFalse(held.cancelled);assertEquals(original.batch,held.batch)
        assertEquals(original.files.first().reserveKey,held.files.first().reserveKey)
        val recovered=pending.copy(assetId=asset,version=version,status="cancelled")
        assertTrue(held.replace(recovered).cancelled);assertEquals(0L,held.replace(recovered).bytesAcknowledged)
    }
    @Test fun malformedSubsetDuplicateIdentityUnsafeTypeAndTruncatedMetadataFailClosed() {
        val before=journal()
        denied { PhotoUploadBatch.restore(before.wire()+("selected" to listOf("content://unselected")),origin) }
        denied { PhotoUploadBatch.restore(before.wire()+("files" to listOf(before.files.first().wire(),before.files.first().wire())),origin) }
        denied { PhotoUploadFile.restore(staged().wire()+("content_type" to "image/gif")) }
        denied { PhotoUploadFile.restore(staged().wire()+("sha256" to null)) }
        denied { PhotoUploadFile.restore(staged().wire()+("reserve_key" to "../unsafe")) }
        denied { PhotoUploadFile.restore(staged().wire()+("byte_size" to PhotoUploadFile.MAX_BYTES+1)) }
    }
    @Test fun retryOfDefinitivelyFailedProcessingCanChangeOnlyCompleteOperationKey() {
        val old=staged().copy(acknowledged=600000,status="failed",error="processing_authority_expired")
        val retry=old.copy(completeKey="android-upload-complete-new-key",error=null)
        assertEquals(old.reserveKey,retry.reserveKey);assertEquals(old.cancelKey,retry.cancelKey);assertEquals(old.assetId,retry.assetId)
        assertEquals(old.sha256,retry.sha256);assertEquals(old.acknowledged,retry.acknowledged);assertNotEquals(old.completeKey,retry.completeKey)
    }
}
