package com.lovelies.frontend.preview

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.attribute.FileTime
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class PrivateMediaRetentionTest {
    @get:Rule val temporary=TemporaryFolder()
    private val now=PrivateTemporaryMedia.CAMERA_AGE_MS*3
    private val elapsed=1_000L
    private val account="00000000-0000-4000-8000-000000000001"
    private val device="00000000-0000-4000-8000-000000000002"
    private val batchId="00000000-0000-4000-8000-000000000003"
    private val scope=SessionScope(4,account)
    private val actor=LiveCredentials(account,"private-preview-session","refresh","registered_face",now+60_000,emptyMap())
    private val cameraName="00000000-0000-4000-8000-000000000004.jpg"
    private val otherCameraName="00000000-0000-4000-8000-000000000005.jpg"
    private val shareName="lovelies-00000000-0000-4000-8000-000000000004-00000000-0000-4000-8000-000000000005.jpg"
    private val authority="com.lovelies.memories.camera-files"
    private val cameraUri="content://$authority/camera/$cameraName"
    private val origin="https://ltqfplqevxztlswlzexn.supabase.co/functions/v1/lovelies-api"
    private val bytes=byteArrayOf(1,2,3,4)
    private fun cache()=temporary.newFolder()
    private fun draft(picked: List<String> = listOf(cameraUri),selected: List<String> = picked): WireObject=
        mapOf("account" to account,"device" to device,"picked" to picked,"selected" to selected,"caption" to "")
    private fun batch()=PhotoUploadBatch.create(origin,account,device,batchId,listOf(cameraUri),listOf(cameraUri),"")
    private fun protection(batch: Any?=null,draft: Any?=null,account: String?=this.account,device: String?=this.device,uris: List<String> = emptyList())=
        PrivateTemporaryMedia.cameraRecoveryNames(batch,draft,origin,account,device,uris,authority)
    private fun write(cache: File,kind: PrivateTemporaryMedia.Kind,name: String,created: Long)=
        PrivateTemporaryMedia.write(cache,kind,name,bytes,created)

    @Test fun alreadyDisplayedOfflinePreviewClearsAtSessionDeadlineWithoutAnotherRequest()=runBlocking {
        val lease=PrivatePreviewLease.create(scope,actor,now,elapsed)!!
        var wall=now;var monotonic=elapsed;var displayed=true;val sleeps=mutableListOf<Long>()
        awaitPrivatePreviewExpiry(lease,{scope},{actor},{wall},{monotonic}) { duration ->
            sleeps.add(duration);wall+=duration;monotonic+=duration
        }
        displayed=false
        assertFalse(displayed);assertEquals(listOf(60_000L),sleeps)
        assertEquals(0L,lease.remaining(scope,actor,wall,monotonic))
    }

    @Test fun twoDayCreationCeilingSurvivesWallClockRollbackAndContinuedForeground()=runBlocking {
        val longSession=actor.copy(expires=Long.MAX_VALUE)
        val lease=PrivatePreviewLease.create(scope,longSession,now,elapsed)!!
        var wall=now;var monotonic=elapsed;val sleeps=mutableListOf<Long>()
        awaitPrivatePreviewExpiry(lease,{scope},{longSession},{wall},{monotonic}) { duration ->
            sleeps.add(duration);wall=now-1_000;monotonic+=duration
        }
        assertEquals(listOf(PrivatePreviewLease.MAX_AGE_MS),sleeps)
        assertEquals(0L,lease.remaining(scope,longSession,wall,monotonic))
    }

    @Test fun lateDecodeCannotPublishAfterExpiryOrUnderReplacementSession() {
        val lease=PrivatePreviewLease.create(scope,actor,now,elapsed)!!
        val lateReplyAllowed={ current: SessionScope,credentials: LiveCredentials?,wall: Long,clock: Long ->
            lease.remaining(current,credentials,wall,clock)>0
        }
        assertTrue(lateReplyAllowed(scope,actor,now,elapsed))
        assertFalse(lateReplyAllowed(scope,actor,actor.expires,elapsed+60_000))
        assertFalse(lateReplyAllowed(scope.copy(epoch=5),actor,now,elapsed))
        assertFalse(lateReplyAllowed(scope,actor.copy(token="successor"),now,elapsed))
        assertFalse(lateReplyAllowed(scope,actor.copy(account=device),now,elapsed))
        assertFalse(lateReplyAllowed(scope,actor.copy(method="anonymous"),now,elapsed))
        assertFalse(lateReplyAllowed(scope,actor.copy(expires=actor.expires+1),now,elapsed))
        assertFalse(lateReplyAllowed(scope,null,now,elapsed))
        assertFalse(lateReplyAllowed(scope,actor,now,elapsed-1))
    }

    @Test fun guardianReviewDeadlineBoundsTheDisplayAndExpiredAuthorityCannotCreateLease() {
        val lease=PrivatePreviewLease.create(scope,actor,now,elapsed,now+1_000)!!
        assertEquals(1_000L,lease.remaining(scope,actor,now,elapsed))
        assertEquals(0L,lease.remaining(scope,actor,now+1_000,elapsed+1_000))
        assertNull(PrivatePreviewLease.create(scope,actor,actor.expires,elapsed))
        assertNull(PrivatePreviewLease.create(scope,actor,now,elapsed,now))
        assertNull(PrivatePreviewLease.create(scope,null,now,elapsed))
        assertNull(PrivatePreviewLease.create(scope,actor.copy(method="anonymous"),now,elapsed))
        assertNull(PrivatePreviewLease.create(scope.copy(accountId=device),actor,now,elapsed))
    }

    @Test fun shareAndCameraExpireAtTheirOwnCreationDeadlinesWithoutReadExtension() {
        val cache=cache()
        val shared=write(cache,PrivateTemporaryMedia.Kind.SHARED,shareName,now)
        val camera=write(cache,PrivateTemporaryMedia.Kind.CAMERA,cameraName,now)
        assertArrayEquals(bytes,shared.readBytes());assertArrayEquals(bytes,camera.readBytes())
        assertEquals(1L,PrivateTemporaryMedia.sweep(cache,PrivateTemporaryMedia.Kind.SHARED,now+PrivateTemporaryMedia.SHARE_AGE_MS-1).nextDelay)
        assertTrue(shared.exists())
        val expiredShare=PrivateTemporaryMedia.sweep(cache,PrivateTemporaryMedia.Kind.SHARED,now+PrivateTemporaryMedia.SHARE_AGE_MS)
        assertEquals(setOf(shareName),expiredShare.removed);assertFalse(shared.exists());assertTrue(camera.exists())
        assertEquals(1L,PrivateTemporaryMedia.sweep(cache,PrivateTemporaryMedia.Kind.CAMERA,now+PrivateTemporaryMedia.CAMERA_AGE_MS-1).nextDelay)
        assertEquals(setOf(cameraName),PrivateTemporaryMedia.sweep(cache,PrivateTemporaryMedia.Kind.CAMERA,now+PrivateTemporaryMedia.CAMERA_AGE_MS).removed)
    }

    @Test fun startupSweepRemovesOldScratchButPreservesBoundUnsubmittedDraftAndRecoverySources() {
        val cache=cache();val old=now-PrivateTemporaryMedia.CAMERA_AGE_MS
        val source=write(cache,PrivateTemporaryMedia.Kind.CAMERA,cameraName,old)
        val orphan=write(cache,PrivateTemporaryMedia.Kind.CAMERA,otherCameraName,old)
        val preserved=protection(batch().wire(),draft())!!
        val result=PrivateTemporaryMedia.sweep(cache,PrivateTemporaryMedia.Kind.CAMERA,now,preserved)
        assertEquals(setOf(otherCameraName),result.removed);assertFalse(orphan.exists());assertArrayEquals(bytes,source.readBytes())
        assertEquals(setOf(cameraName),protection(draft=draft()))
        assertEquals(setOf(cameraName),protection(uris=listOf(cameraUri)))
    }

    @Test fun unreadableOrWrongOwnerRecoveryPreventsScratchAgingRatherThanLosingPossibleSource() {
        val candidates=listOf<Any?>("unreadable",emptyMap<String,Any?>(),draft()+mapOf("picked" to "broken"),
            draft()+mapOf("selected" to listOf("content://other/not-picked")),draft()+mapOf("picked" to listOf("bad uri")))
        candidates.forEach { assertNull(protection(draft=it)) }
        assertNull(protection(batch="unreadable"));assertNull(protection(batch=batch().wire(),account=device))
        assertNull(protection(batch=batch().wire(),device=account));assertNull(protection(draft=draft(),account=null))
        assertNull(protection(draft=draft(),device=account))
        val cache=cache();val source=write(cache,PrivateTemporaryMedia.Kind.CAMERA,cameraName,now-PrivateTemporaryMedia.CAMERA_AGE_MS)
        protection(batch="unreadable")?.let { PrivateTemporaryMedia.sweep(cache,PrivateTemporaryMedia.Kind.CAMERA,now,it) }
        assertArrayEquals(bytes,source.readBytes())
    }

    @Test fun externalOrEncodedTraversalUrisCannotPreserveAnotherPrivateFile() {
        val wrong=listOf("content://other/camera/$cameraName","content://$authority/camera/../$cameraName",
            "content://$authority/camera/%2e%2e/$cameraName","content://$authority/camera/%30${cameraName.drop(1)}",
            "file:///camera/$cameraName","content://$authority/camera/$cameraName?other=1","content://$authority/camera/$cameraName#fragment")
        assertTrue(PrivateTemporaryMedia.cameraNames(wrong,authority).isEmpty())
        assertEquals(setOf(cameraName),PrivateTemporaryMedia.cameraNames(wrong+cameraUri,authority))
    }

    @Test fun terminalBatchAloneDoesNotProtectAbandonedScratchButDraftStillHasItsOwnLifecycle() {
        val cancelled=batch().copy(cancelling=true).wire()
        assertTrue(protection(batch=cancelled)!!.isEmpty())
        assertEquals(setOf(cameraName),protection(batch=cancelled,draft=draft()))
    }

    @Test fun sweeperNeverTraversesUnknownFoldersEncryptedRecoveryOrUserSavedMedia() {
        val cache=cache();val own=write(cache,PrivateTemporaryMedia.Kind.CAMERA,cameraName,now)
        val unknown=File(own.parentFile,"other.jpg").apply { writeBytes(bytes) }
        val nested=File(own.parentFile,"nested").apply { mkdir() }.resolve(otherCameraName).apply { writeBytes(bytes) }
        val encrypted=File(cache,"noBackupFilesDir/photo-uploads-account").apply { mkdirs() }.resolve(cameraName).apply { writeBytes(bytes) }
        val photos=File(cache,"Pictures/Lovelies").apply { mkdirs() }.resolve(cameraName).apply { writeBytes(bytes) }
        val files=File(cache,"Files").apply { mkdir() }.resolve(cameraName).apply { writeBytes(bytes) }
        val result=PrivateTemporaryMedia.sweep(cache,PrivateTemporaryMedia.Kind.CAMERA,now,all=true)
        assertEquals(setOf(cameraName),result.removed)
        listOf(unknown,nested,encrypted,photos,files).forEach { assertArrayEquals(bytes,it.readBytes()) }
    }

    @Test fun symbolicLinkFileAndSymbolicLinkOwnedDirectoryCannotReachOutsideInventory() {
        val cache=cache();val folder=File(cache,"camera").apply { mkdir() }
        val outsideFolder=temporary.newFolder();val outside=outsideFolder.resolve(cameraName).apply { writeBytes(bytes) }
        val link=File(folder,cameraName).toPath();Files.createSymbolicLink(link,outside.toPath())
        assertTrue(PrivateTemporaryMedia.sweep(cache,PrivateTemporaryMedia.Kind.CAMERA,now,all=true).removed.isEmpty())
        assertTrue(Files.isSymbolicLink(link));assertArrayEquals(bytes,outside.readBytes())
        Files.delete(link);Files.delete(folder.toPath());Files.createSymbolicLink(folder.toPath(),outsideFolder.toPath())
        assertTrue(PrivateTemporaryMedia.sweep(cache,PrivateTemporaryMedia.Kind.CAMERA,now,all=true).removed.isEmpty())
        assertArrayEquals(bytes,outside.readBytes())
        try { write(cache,PrivateTemporaryMedia.Kind.CAMERA,otherCameraName,now);fail("Symlink directory accepted private bytes") }
        catch(_: LiveFailure) { }
        assertFalse(outsideFolder.resolve(otherCameraName).exists())
    }

    @Test fun nameCollisionAndUnsafeWriteNeverReplaceOrRemoveExistingFile() {
        val cache=cache();val original=write(cache,PrivateTemporaryMedia.Kind.CAMERA,cameraName,now)
        try { PrivateTemporaryMedia.write(cache,PrivateTemporaryMedia.Kind.CAMERA,cameraName,byteArrayOf(9),now);fail("Existing file was replaced") }
        catch(_: IOException) { }
        assertArrayEquals(bytes,original.readBytes())
        try { write(cache,PrivateTemporaryMedia.Kind.CAMERA,"../$cameraName",now);fail("Traversal write accepted") }
        catch(_: LiveFailure) { }
        assertEquals(listOf(cameraName),requireNotNull(original.parentFile).list()!!.toList())
    }

    @Test fun failedDeletionRetainsTheFileAndSchedulesRetryWithoutClaimingRemoval() {
        val cache=cache();val source=write(cache,PrivateTemporaryMedia.Kind.SHARED,shareName,now-PrivateTemporaryMedia.SHARE_AGE_MS)
        val result=PrivateTemporaryMedia.sweep(cache,PrivateTemporaryMedia.Kind.SHARED,now,remove={ throw IOException("fixture deletion failed") })
        assertTrue(result.failed);assertTrue(result.removed.isEmpty());assertEquals(60_000L,result.nextDelay)
        assertArrayEquals(bytes,source.readBytes())
        assertEquals(setOf(shareName),PrivateTemporaryMedia.sweep(cache,PrivateTemporaryMedia.Kind.SHARED,now).removed)
    }

    @Test fun futureOrUnusableCreationStampCannotExtendPrivateTempRetention() {
        val cache=cache();val source=write(cache,PrivateTemporaryMedia.Kind.CAMERA,cameraName,now+60_000)
        assertEquals(setOf(cameraName),PrivateTemporaryMedia.sweep(cache,PrivateTemporaryMedia.Kind.CAMERA,now).removed)
        write(cache,PrivateTemporaryMedia.Kind.CAMERA,cameraName,now)
        Files.setLastModifiedTime(source.toPath(),FileTime.fromMillis(0))
        assertEquals(setOf(cameraName),PrivateTemporaryMedia.sweep(cache,PrivateTemporaryMedia.Kind.CAMERA,now).removed)
        assertFalse(Files.exists(source.toPath(),LinkOption.NOFOLLOW_LINKS))
    }
}
