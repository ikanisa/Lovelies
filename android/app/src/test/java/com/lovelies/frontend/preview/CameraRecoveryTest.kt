package com.lovelies.frontend.preview

import java.time.Instant
import org.junit.Assert.*
import org.junit.Test

class CameraRecoveryTest {
    private val account="00000000-0000-4000-8000-000000000001"
    private val device="00000000-0000-4000-8000-000000000002"
    private val cid="00000000-0000-4000-8000-000000000003"
    private val origin="http://10.0.2.2:18887"
    private val alias="lovelies.device.camera.test"
    private fun owner()=NativeCaptureContext(4,SessionScope(2,account),origin,CameraCaptureMode.FACE,"face_authentication",cid,"challenge-digest",0,"front")
    private fun challenge(): WireObject=mapOf("protocol" to "lovelies-face-auth-v1","purpose" to "login","account_id" to account,"device_id" to device,
        "challenge_id" to cid,"nonce" to "one-use","policy_version" to "auth-v1","required_captures" to 1,"poses" to listOf("front"),
        "profile_id" to cid,"profile_revision" to "revision-1","model_id" to "sface-v1","expires_at" to Instant.ofEpochMilli(1000000).toString())
    private fun journal()=CameraLoginJournal(origin,account,alias,device,challenge())
    private fun denied(block: ()->Unit) { try { block();fail("Expected a bounded camera or ownership denial") } catch(problem: LiveFailure) { } }

    @Test fun permissionStatesDistinguishFirstChoiceDenialPermanentDenialAndSettingsRevocation() {
        assertEquals(CameraPermissionState.NOT_REQUESTED,cameraPermission(false,false,false,false))
        assertEquals(CameraPermissionState.GRANTED,cameraPermission(true,true,false,false))
        assertEquals(CameraPermissionState.DENIED,cameraPermission(false,true,true,false))
        assertEquals(CameraPermissionState.PERMANENTLY_DENIED,cameraPermission(false,true,false,false))
        assertEquals(CameraPermissionState.REVOKED,cameraPermission(false,true,false,true))
        assertEquals(CameraPermissionState.GRANTED,cameraPermission(true,true,false,true))
    }
    @Test fun lateOpenAndConfigureCannotReviveInterruptedOrReplacedProducer() {
        val camera=CameraProducer(owner());val old=camera.initialize();camera.interrupt()
        assertFalse(camera.ready(old));assertFalse(camera.shutter(old,owner()))
        val next=camera.initialize();assertFalse(camera.ready(old));assertTrue(camera.ready(next));assertFalse(camera.ready(next))
    }
    @Test fun disconnectedAndTimedOutCameraRequireASeparateProducerLease() {
        for(ready in listOf(false,true)) {
            val camera=CameraProducer(owner());val token=camera.initialize();if(ready)assertTrue(camera.ready(token))
            assertTrue(camera.fail(token));assertFalse(camera.fail(token));assertFalse(camera.ready(token));assertFalse(camera.shutter(token,owner()))
            val stale=byteArrayOf(1,2,3);assertFalse(camera.frame(token,stale));assertArrayEquals(ByteArray(3),stale)
        }
    }
    @Test fun shutterNeedsReadyCurrentAccountOriginChallengePoseAndRequest() {
        val camera=CameraProducer(owner());val token=camera.initialize();assertFalse(camera.shutter(token,owner()));assertTrue(camera.ready(token))
        for(changed in listOf(owner().copy(uiEpoch=5),owner().copy(session=SessionScope(3,account)),owner().copy(origin="https://different.invalid"),
            owner().copy(requestId="replacement"),owner().copy(challengeFingerprint="other"),owner().copy(index=1,pose="left")))assertFalse(camera.shutter(token,changed))
        assertTrue(camera.shutter(token,owner()));assertFalse(camera.shutter(token,owner()))
    }
    @Test fun captureFrameDeliveredOnceAndLateBuffersAreZeroed() {
        val camera=CameraProducer(owner());val token=camera.initialize();assertTrue(camera.ready(token));assertTrue(camera.shutter(token,owner()))
        assertTrue(camera.frame(token,byteArrayOf(1,2)));val duplicate=byteArrayOf(3,4);assertFalse(camera.frame(token,duplicate));assertArrayEquals(ByteArray(2),duplicate)
        assertFalse(camera.shutter(token,owner()));camera.interrupt();val late=byteArrayOf(9);assertFalse(camera.frame(token,late));assertArrayEquals(ByteArray(1),late)
    }
    @Test fun localReviewAndRepeatedRetakesNeverDispatchOrSign() {
        val review=CameraReviewBuffer();var uploads=0;var signatures=0
        repeat(5) {
            val bytes=byteArrayOf(1,2,3);assertTrue(review.offer(bytes,owner(),owner()));assertEquals(owner(),review.owner())
            review.clear();assertArrayEquals(ByteArray(3),bytes)
            val submitted=review.approve(owner())
            submitted?.let { dispatchBoundCaptureFrame(it.bytes,it.owner,{owner()},{_,_->signatures++},{_,_->uploads++}) }
            assertNull(submitted)
        }
        assertEquals(0,uploads);assertEquals(0,signatures)
    }
    @Test fun explicitApprovalMovesOriginalBytesOnceAndCannotReachAnotherCaptureMode() {
        val review=CameraReviewBuffer();val bytes=byteArrayOf(1,2,3);assertTrue(review.offer(bytes,owner(),owner()))
        val moved=review.approve(owner())!!;assertSame(bytes,moved.bytes);assertEquals(owner(),moved.owner);assertNull(review.approve(owner()))
        var dispatches=0;assertTrue(dispatchBoundCaptureFrame(moved.bytes,moved.owner,{owner()},{data,_->dispatches++;data.fill(0)},{_,_->fail("Face preview reached personal upload")}))
        assertEquals(1,dispatches);assertArrayEquals(ByteArray(3),bytes)
    }
    @Test fun backgroundLogoutSessionOrChallengeChangeDestroysUnsentReview() {
        for(current in listOf(null,owner().copy(uiEpoch=5),owner().copy(session=SessionScope(9,account)),owner().copy(challengeFingerprint="successor"),
            owner().copy(mode=CameraCaptureMode.UPLOAD,source="personal"))) {
            val review=CameraReviewBuffer();val bytes=byteArrayOf(1,4,7);assertTrue(review.offer(bytes,owner(),owner()))
            assertNull(review.approve(current));assertArrayEquals(ByteArray(3),bytes)
        }
    }
    @Test fun reviewMemoryAndAgeAreBoundedAndOverflowDoesNotReplaceCurrentPreview() {
        var now=1000L;val review=CameraReviewBuffer { now };val held=byteArrayOf(1);assertTrue(review.offer(held,owner(),owner()))
        val replacement=byteArrayOf(2,3);assertFalse(review.offer(replacement,owner(),owner()));assertArrayEquals(ByteArray(2),replacement)
        now+=CameraReviewBuffer.MAX_AGE_MS+1;assertNull(review.approve(owner()));assertArrayEquals(ByteArray(1),held)
        val overflow=ByteArray(CameraReviewBuffer.MAX_BYTES+1) { 7 };assertFalse(review.offer(overflow,owner(),owner()));assertTrue(overflow.all { it==0.toByte() })
        val empty=ByteArray(0);assertFalse(review.offer(empty,owner(),owner()))
    }
    @Test fun wallClockRollbackCannotExtendAnUnsentReview() {
        var now=1000L;val review=CameraReviewBuffer { now };val bytes=byteArrayOf(1,2);assertTrue(review.offer(bytes,owner(),owner()))
        now=1;assertNull(review.approve(owner()));assertArrayEquals(ByteArray(2),bytes)
    }
    @Test fun sensorAndDisplayRotationsPreserveUprightJpegForBothCameras() {
        for(sensor in listOf(0,90,180,270))for(display in listOf(0,90,180,270)) {
            assertEquals((sensor+display+360)%360,cameraJpegOrientation(sensor,display,true))
            assertEquals((sensor-display+360)%360,cameraJpegOrientation(sensor,display,false))
        }
    }
    @Test fun uncertainCaptureAndCompletionPersistOriginalBindingAndUnblockOnlyAtExpiry() {
        val planned=journal().plan(byteArrayOf(1,2,3));val held=CameraLoginJournal.restore(planned.wire(),origin)
        assertEquals(planned,held);assertTrue(held.blocked(999999));assertFalse(held.blocked(1000000));assertEquals(account,held.account);assertEquals(alias,held.alias)
        val complete=held.complete(mapOf("challenge_id" to cid,"device_signature" to "A".repeat(86)))
        assertEquals(complete,CameraLoginJournal.restore(complete.wire(),origin));assertTrue(complete.blocked(999999));denied { complete.plan(byteArrayOf(9)) }
        assertFalse(NativeProtocol.canonical(complete.wire()).contains("raw_capture"));assertNull(complete.credentials)
    }
    @Test fun loginHoldRejectsOtherOriginAccountDeviceAliasAndMalformedOrUnboundedSlots() {
        val original=journal();denied { original.assertOwner(origin,cid,alias,device) };denied { original.assertOwner(origin,account,"new-alias",device) }
        denied { original.assertOwner(origin,account,alias,cid) };denied { CameraLoginJournal.restore(original.wire(),"https://different.invalid") }
        val planned=original.plan(byteArrayOf(1,2));val bad=listOf(mapOf("state" to "invented"),mapOf("capture" to null),
            mapOf("capture" to planned.capture!!.wire()+mapOf("byte_size" to CameraReviewBuffer.MAX_BYTES+1)),
            mapOf("capture" to planned.capture!!.wire()+mapOf("index" to 1)),mapOf("capture" to planned.capture!!.wire()+mapOf("sha256" to "invalid")),
            mapOf("challenge" to challenge()+mapOf("account_id" to cid)),mapOf("challenge" to challenge()+mapOf("poses" to listOf("left"))))
        bad.forEach { denied { CameraLoginJournal.restore(planned.wire()+it,origin) } }
    }
    @Test fun onlyKnownTerminalBackendRejectionAllowsExplicitFreshFaceRetry() {
        val held=journal().plan(byteArrayOf(1))
        for(code in listOf("face_capture_no_face","face_capture_multiple_faces","face_capture_quality_low","face_capture_invalid_image")) {
            assertTrue(held.terminal(LiveFailure(code,422)));assertFalse(held.terminal(LiveFailure(code,503,true)))
            assertFalse(cameraRecoveryMessage(code).contains("verified",true))
        }
        assertTrue(held.terminal(LiveFailure("face_verification_failed",401)))
        assertFalse(held.terminal(LiveFailure("connection_unavailable",ambiguous=true)));assertFalse(held.terminal(LiveFailure("server_unavailable",503,true)))
        assertFalse(held.terminal(LiveFailure("session_revoked",401)));assertFalse(held.terminal(LiveFailure("capture_changed",409)))
        assertFalse(held.copy(state="rejected").blocked(999999))
    }
    private fun staged(): CameraLoginJournal {
        val complete=journal().plan(byteArrayOf(1,2)).complete(mapOf("challenge_id" to cid,"device_signature" to "A".repeat(86)))
        val result=mapOf("protocol" to "lovelies-face-auth-v1","status" to "authenticated","account_id" to account,"device_id" to device,
            "auth_method" to "registered_face","profile_id" to cid,"profile_revision" to "revision-1","model_id" to "sface-v1",
            "access_token" to "synthetic-staged-token","refresh_token" to "synthetic-refresh-token")
        return complete.copy(state="credentials_pending",credentials=result)
    }
    @Test fun stagedCredentialsMustMatchOriginalAccountDeviceProfileRevisionAndModelBeforeUseOrRevocation() {
        val saved=staged();val good=saved.credentials!!;saved.assertCredentialBinding(good)
        for(delta in listOf(mapOf("account_id" to cid),mapOf("device_id" to cid),mapOf("profile_id" to device),mapOf("profile_revision" to "different"),
            mapOf("model_id" to "different"),mapOf("auth_method" to "anonymous"),mapOf("protocol" to "invented"),mapOf("status" to "pending")))
            denied { saved.assertCredentialBinding(good+delta) }
    }
    @Test fun explicitLogoutErasesStagedAuthorityButRetainsOriginalManifestAndUncertainHold() {
        val saved=staged();val held=saved.forExplicitLogout()
        assertEquals("completion_pending",held.state);assertNull(held.credentials);assertEquals(saved.capture,held.capture)
        assertEquals(saved.completion,held.completion);assertEquals(saved.challenge,held.challenge);assertEquals(saved.account,held.account)
        assertEquals(saved.device,held.device);assertEquals(saved.alias,held.alias);assertTrue(held.blocked(999999))
        assertFalse(NativeProtocol.canonical(held.wire()).contains("synthetic-staged-token"))
        assertEquals(held,CameraLoginJournal.restore(held.wire(),origin));assertEquals(held,held.forExplicitLogout())
    }
    @Test fun expiredStagedCredentialsCannotBeRepublishedAndFreshRetryStillWaitsForOriginalChallengeExpiry() {
        val saved=staged();assertSame(saved,saved.withoutExpiredCredentials(1001,1000))
        val expired=saved.withoutExpiredCredentials(1000,1000)
        assertNull(expired.credentials);assertEquals("completion_pending",expired.state);assertEquals(saved.capture,expired.capture)
        assertTrue(expired.blocked(999999));assertFalse(expired.blocked(1000000));assertEquals(saved.alias,expired.alias)
        assertEquals(expired,CameraLoginJournal.restore(expired.wire(),origin));assertSame(expired,expired.withoutExpiredCredentials(0,999999))
    }
    @Test fun stagedSessionValidationRequiresExactlyOneOriginalCurrentDeviceWithActualActiveStatus() {
        val saved=staged();val me=mapOf("authenticated" to true,"user_id" to account,"auth_method" to "registered_face",
            "profile_id" to cid,"profile_revision" to "revision-1")
        val current=mapOf("id" to device,"current" to true,"status" to "active")
        assertCameraLoginSession(saved,me,mapOf("items" to listOf(current)))
        for(row in listOf(current-mapOf("status" to "active").keys,current+mapOf("status" to "revoked"),current+mapOf("status" to "unknown"),
            current+mapOf("id" to cid),current+mapOf("current" to false),current-mapOf("status" to "active").keys+mapOf("active" to true)))
            denied { assertCameraLoginSession(saved,me,mapOf("items" to listOf(row))) }
        denied { assertCameraLoginSession(saved,me,mapOf("items" to listOf(current,current))) }
        denied { assertCameraLoginSession(saved,me+mapOf("profile_revision" to "old"),mapOf("items" to listOf(current))) }
        denied { assertCameraLoginSession(saved,me+mapOf("auth_method" to "anonymous"),mapOf("items" to listOf(current))) }
    }
    @Test fun activeEnrollmentOrRecoveryOwnsPreidentityStageAndRetainedOldSourceIdentityCannotOverrideIt() {
        val key=mapOf("kty" to "EC","crv" to "P-256","x" to "A".repeat(43),"y" to "B".repeat(43),"ext" to true,"key_ops" to listOf("verify"))
        val target=CameraLoginOwner(account,alias,device,key);val old=CameraLoginOwner(cid,"lovelies.device.old-source",cid)
        assertEquals(target,selectCameraLoginOwner(staged(),target,null));assertEquals(target,selectCameraLoginOwner(staged(),target,old))
        selectCameraLoginOwner(staged(),target,old).assertKey(key)
        denied { selectCameraLoginOwner(staged(),target,old).assertKey(key+mapOf("x" to "changed")) }
        val stable=CameraLoginOwner(account,alias,device);assertEquals(stable,selectCameraLoginOwner(staged(),null,stable))
        denied { selectCameraLoginOwner(staged(),null,old) };denied { selectCameraLoginOwner(staged(),null,null) }
    }
    @Test fun unrelatedActiveJournalCannotBorrowStableIdentityOrAnotherAccountKeyForAStagedToken() {
        val correct=CameraLoginOwner(account,alias,device)
        for(wrong in listOf(correct.copy(account=cid),correct.copy(alias="lovelies.device.other"),correct.copy(device=cid)))
            denied { selectCameraLoginOwner(staged(),wrong,correct) }
    }
}
