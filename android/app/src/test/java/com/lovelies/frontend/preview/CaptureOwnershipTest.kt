package com.lovelies.frontend.preview

import org.junit.Assert.*
import org.junit.Test

class CaptureOwnershipTest {
    private val session=SessionScope(4,"00000000-0000-4000-8000-000000000001")
    private val challenge: WireObject=mapOf("challenge_id" to "00000000-0000-4000-8000-000000000002","nonce" to "one-use",
        "purpose" to "login","poses" to listOf("front"),"profile_revision" to "revision-1")
    private fun owner()=NativeCaptureContext(7,session,"http://10.0.2.2:18887",CameraCaptureMode.FACE,"face_authentication",
        "00000000-0000-4000-8000-000000000003",NativeCaptureContext.fingerprint(challenge),0,"front")

    @Test fun delayedOldProducerCannotSignOrReachUploadAfterAnyOwnershipChange() {
        val atShutter=owner();var current: NativeCaptureContext?=atShutter
        var signs=0;var uploads=0
        val delayed: (ByteArray)->Boolean={ bytes->dispatchBoundCaptureFrame(bytes,atShutter,{current},
            {_,_->signs++},{_,_->uploads++}) }
        val changed=listOf(atShutter.copy(uiEpoch=8),atShutter.copy(session=session.copy(epoch=5)),
            atShutter.copy(session=session.copy(accountId="00000000-0000-4000-8000-000000000004")),
            atShutter.copy(origin="https://other.example"),atShutter.copy(requestId="00000000-0000-4000-8000-000000000005"),
            atShutter.copy(challengeFingerprint=NativeCaptureContext.fingerprint(challenge+mapOf("nonce" to "successor"))),
            atShutter.copy(index=1),atShutter.copy(pose="left"),atShutter.copy(source="professional"),
            atShutter.copy(mode=CameraCaptureMode.UPLOAD,source="personal",challengeFingerprint=null,pose="photo"))
        for(next in changed) {
            current=next;val bytes=byteArrayOf(1,2,3,4)
            assertFalse(delayed(bytes));assertArrayEquals(ByteArray(4),bytes)
        }
        current=null;val bytes=byteArrayOf(9,8,7)
        assertFalse(delayed(bytes));assertArrayEquals(ByteArray(3),bytes)
        assertEquals(0,signs);assertEquals(0,uploads)
    }

    @Test fun delayedOrdinaryPhotoCannotBecomeFaceProofOrAnotherUpload() {
        val atShutter=owner().copy(mode=CameraCaptureMode.UPLOAD,source="personal",challengeFingerprint=null,pose="photo")
        var signs=0;var uploads=0
        for(current in listOf(owner(),atShutter.copy(requestId="new-camera-task"),atShutter.copy(source="professional"))) {
            val bytes=byteArrayOf(1,4,8)
            assertFalse(dispatchBoundCaptureFrame(bytes,atShutter,{current},{_,_->signs++},{_,_->uploads++}))
            assertArrayEquals(ByteArray(3),bytes)
        }
        assertEquals(0,signs);assertEquals(0,uploads)
    }

    @Test fun matchingFrameUsesImmutableModeAndOwnershipOnly() {
        val face=owner();val bytes=byteArrayOf(1,2,3);var received: NativeCaptureContext?=null
        assertTrue(dispatchBoundCaptureFrame(bytes,face,{face.copy()}, {data,binding->
            received=binding;assertArrayEquals(byteArrayOf(1,2,3),data);data.fill(0)
        },{_,_->fail("Face frame reached ordinary upload")}))
        assertSame(face,received);assertArrayEquals(ByteArray(3),bytes)
        val upload=face.copy(mode=CameraCaptureMode.UPLOAD,source="personal",challengeFingerprint=null,pose="photo")
        val photo=byteArrayOf(4,5,6)
        assertTrue(dispatchBoundCaptureFrame(photo,upload,{upload.copy()},{_,_->fail("Ordinary photo reached face signing")},
            {data,binding->assertSame(upload,binding);assertArrayEquals(byteArrayOf(4,5,6),data);data.fill(0)}))
        assertArrayEquals(ByteArray(3),photo)
    }

    @Test fun ioMutexGuardRechecksChallengeRequestPoseSourceAndScopeBeforeSigning() {
        val atShutter=owner()
        assertFaceFrameBinding(atShutter,session,atShutter.origin,challenge,atShutter.requestId,0)
        var signs=0
        val attempts=listOf(atShutter.copy(session=session.copy(epoch=5)),atShutter.copy(requestId="other"),
            atShutter.copy(pose="left"),atShutter.copy(source="personal"),atShutter.copy(mode=CameraCaptureMode.UPLOAD),
            atShutter.copy(challengeFingerprint="different"),atShutter.copy(index=1))
        for(frame in attempts) {
            try { assertFaceFrameBinding(frame,session,atShutter.origin,challenge,atShutter.requestId,0);signs++;fail("Old frame reached signing") }
            catch(problem: LiveFailure) { assertEquals("capture_context_changed",problem.code) }
        }
        try {
            assertFaceFrameBinding(atShutter,session,atShutter.origin,challenge+mapOf("nonce" to "replacement"),atShutter.requestId,0)
            signs++;fail("Replacement challenge accepted old JPEG")
        } catch(problem: LiveFailure) { assertEquals("capture_context_changed",problem.code) }
        assertEquals(0,signs)
    }

    private fun pickerOwner()=NativePhotoPickerOwner(owner().copy(mode=CameraCaptureMode.UPLOAD,
        source="personal",requestId="picker-request",challengeFingerprint=null,pose="photo"),"registered-device")

    @Test fun externalPickerBackgroundKeepsOriginalOwnerAndConsumesItOnlyOnce() {
        val opened=pickerOwner();val lease=PhotoPickerOwnership()
        assertTrue(lease.begin(opened))
        val returned=opened.copy(capture=opened.capture.copy(uiEpoch=opened.capture.uiEpoch+1,
            session=opened.capture.session.copy(epoch=opened.capture.session.epoch+1)))
        lease.background(opened,returned)
        assertEquals(opened,lease.opened)
        assertTrue(lease.consume(opened,returned))
        assertNull(lease.opened)
        assertFalse(lease.consume(opened,returned))
    }

    @Test fun staleOrRestoredPickerCannotReachGrantRetentionOrDraftMutation() {
        val opened=pickerOwner()
        val replacements=listOf(null,opened.copy(device="another-device"),
            opened.copy(capture=opened.capture.copy(uiEpoch=8)),
            opened.copy(capture=opened.capture.copy(session=session.copy(epoch=5))),
            opened.copy(capture=opened.capture.copy(session=session.copy(accountId="another-account"))),
            opened.copy(capture=opened.capture.copy(origin="https://other.example")),
            opened.copy(capture=opened.capture.copy(requestId="successor-picker")))
        var retainedGrants=0;var changedDrafts=0
        for(current in replacements) {
            val lease=PhotoPickerOwnership();assertTrue(lease.begin(opened))
            if(lease.consume(opened,current)) { retainedGrants++;changedDrafts++ }
            assertNull(lease.opened)
        }
        val restored=PhotoPickerOwnership()
        assertFalse(restored.consume(opened,opened))
        assertTrue(restored.begin(opened))
        assertFalse(restored.consume(null,opened))
        assertEquals(0,retainedGrants);assertEquals(0,changedDrafts)
    }

    @Test fun pickerBackgroundCannotRebaseAcrossAnotherAccountDeviceOrUnexpectedUiChange() {
        val opened=pickerOwner()
        val advanced=opened.copy(capture=opened.capture.copy(uiEpoch=opened.capture.uiEpoch+1,
            session=opened.capture.session.copy(epoch=opened.capture.session.epoch+1)))
        for(changed in listOf(null,advanced.copy(device="replacement-device"),
            advanced.copy(capture=advanced.capture.copy(uiEpoch=advanced.capture.uiEpoch+1)),
            advanced.copy(capture=advanced.capture.copy(session=advanced.capture.session.copy(accountId="another-account"))))) {
            val lease=PhotoPickerOwnership();assertTrue(lease.begin(opened))
            lease.background(opened,changed)
            assertNull(lease.opened);assertFalse(lease.consume(opened,changed))
        }
    }

    @Test fun cancelledOldPickerCannotConsumeOrReplaceANewerRequest() {
        val opened=pickerOwner();val replacement=opened.copy(capture=opened.capture.copy(requestId="second-picker"))
        val lease=PhotoPickerOwnership();assertTrue(lease.begin(opened))
        assertFalse(lease.begin(replacement))
        lease.cancel(opened);assertTrue(lease.begin(replacement))
        assertFalse(lease.consume(opened,replacement))
        assertEquals(replacement,lease.opened)
        assertTrue(lease.consume(replacement,replacement))
    }
}
