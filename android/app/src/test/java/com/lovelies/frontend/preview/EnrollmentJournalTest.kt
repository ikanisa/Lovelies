package com.lovelies.frontend.preview

import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

class EnrollmentJournalTest {
    private val account="00000000-0000-4000-8000-000000000001"
    private val device="00000000-0000-4000-8000-000000000002"
    private val challengeId="00000000-0000-4000-8000-000000000003"
    private val other="00000000-0000-4000-8000-000000000004"
    private val origin="http://10.0.2.2:18887"
    private val now=100000L
    private val nonce="00000000-0000-4000-8000-000000000005"
    private val jwk=mapOf("kty" to "EC","crv" to "P-256","x" to "A".repeat(43),"y" to "B".repeat(43),"ext" to true,"key_ops" to listOf("verify"))
    private fun journal()=EnrollmentJournal.create(origin,account,"lovelies.device.$account.test",jwk,"model-v1")
    private fun challenge(j: EnrollmentJournal,generation: Long=1,id: String=challengeId): WireObject=mapOf(
        "protocol" to "lovelies-face-auth-v1","enrollment_key" to j.key,"public_key_digest" to j.digest,"enrollment_generation" to generation,
        "face_handle" to j.handle,"challenge_id" to id,"account_id" to account,"device_id" to device,"device_revision" to "device-r1",
        "nonce" to "one-use-nonce","purpose" to "registration","policy_version" to j.policy,"profile_id" to null,"profile_revision" to null,
        "required_captures" to 3,"poses" to listOf("front","left","right"),"expires_at" to Instant.ofEpochMilli(now+60000).toString())
    private fun baseChallenge(j: EnrollmentJournal)=challenge(j).filterKeys { it !in setOf("enrollment_key","public_key_digest","enrollment_generation","face_handle") }
    private fun response(j: EnrollmentJournal,state: String="pending",captures: List<EnrollmentCapture> = j.accepted): WireObject=mapOf(
        "protocol" to "lovelies-face-enrollment-v1","account_id" to account,"enrollment_key" to j.key,"device_id" to device,
        "device_revision" to "device-r1","public_key_digest" to j.digest,"policy_version" to j.policy,"enrollment_generation" to 1,
        "challenge_id" to challengeId,"request_nonce" to nonce,"expires_at" to Instant.ofEpochMilli(now+86400000).toString(),"authenticated" to false,"state" to state,
        "challenge" to if(state in setOf("registered","restart_required"))null else baseChallenge(j),
        "captures" to if(state=="registered")emptyList<Any>() else captures.map(EnrollmentCapture::wire),
        "profile" to if(state=="registered")mapOf("id" to other,"revision" to "profile-r1","model_id" to "sface-v1") else null)
    private fun failed(code: String?=null,block: ()->Unit) {
        try { block();fail("Expected a fail-closed enrollment rejection") }
        catch(problem: LiveFailure) { if(code!=null)assertEquals(code,problem.code) }
    }
    @Test fun startIsAccountKeyPolicyAndHandleBoundBeforeDispatchAndMetadataOnly() {
        val j=journal();val restored=EnrollmentJournal.restore(j.wire(),origin)
        assertEquals(j,restored)
        assertTrue(j.handle.matches(Regex("lfh_[A-Za-z0-9_-]{43}")))
        assertEquals(setOf("protocol","step","account_id","enrollment_key","face_handle","policy_version","device_public_jwk"),j.startEnvelope().keys)
        assertEquals("start",j.startEnvelope()["step"])
        assertEquals("face_authentication",NativeProtocol.obj(j.startBody("signature")["consent"])["purpose"])
        assertEquals(j.digest,NativeProtocol.sha256(NativeProtocol.canonical(jwk).toByteArray()))
        assertFalse(NativeProtocol.canonical(j.wire()).contains("jpeg_bytes"))
    }
    @Test fun onlyExplicitSameAnonymousAccountAbsencePermitsOriginalStartRetry() {
        val j=journal()
        assertTrue(j.allowsStartRetry(LiveFailure("enrollment_not_found",404),true))
        assertFalse(j.allowsStartRetry(LiveFailure("enrollment_not_found",404),false))
        for(error in listOf(LiveFailure("enrollment_recovery_unavailable",404),LiveFailure("invalid_device_signature",401),
            LiveFailure("connection_unavailable",ambiguous=true),LiveFailure("enrollment_not_found",503)))assertFalse(j.allowsStartRetry(error,true))
        assertFalse(j.withChallenge(challenge(j)).allowsStartRetry(LiveFailure("enrollment_not_found",404),true))
    }
    @Test fun lostStartAdoptsDeviceOnceFromExactStatusAndBaseNestedChallenge() {
        val j=journal();val recovered=j.reconcile(response(j),nonce,now)
        assertEquals(device,recovered.device);assertEquals(1L,recovered.generation);assertEquals("pending",recovered.state)
        assertEquals(j.key,recovered.key);assertEquals(j.alias,recovered.alias);assertEquals(j.handle,recovered.handle)
        val changed=response(recovered)+mapOf("device_id" to other)
        failed("enrollment_response_changed") { recovered.reconcile(changed,nonce,now) }
        failed("enrollment_response_changed") { recovered.reconcile(response(recovered)+mapOf("device_revision" to "changed"),nonce,now) }
    }
    @Test fun firstLostStartCanRecoverExpiredPredecessorWithoutAnExpiredChallengeBody() {
        val j=journal();val expired=j.reconcile(response(j,"restart_required"),nonce,now)
        assertNull(expired.challenge);assertEquals(challengeId,expired.challengeId);assertEquals(1L,expired.generation)
        assertEquals(expired,EnrollmentJournal.restore(expired.wire(),origin))
        val resumed=expired.withChallenge(challenge(expired,2,other),successor=true)
        assertEquals(other,resumed.challengeId);assertEquals(2L,resumed.generation)
        assertEquals(0,resumed.accepted.size)
        failed("enrollment_response_changed") { j.reconcile(response(j)+mapOf("challenge_id" to other),nonce,now) }
        failed("enrollment_response_changed") { expired.reconcile(response(expired,"restart_required")+mapOf("challenge_id" to other),nonce,now) }
    }
    @Test fun nonceAccountKeyDigestPolicyAndProfileChangesDoNotRecover() {
        val j=journal().let { it.withChallenge(challenge(it)) }
        for(change in listOf(mapOf("account_id" to other),mapOf("enrollment_key" to other),mapOf("public_key_digest" to "0".repeat(64)),
            mapOf("policy_version" to "other"),mapOf("request_nonce" to other),mapOf("authenticated" to true),mapOf("state" to "authenticated")))
            failed("enrollment_response_changed") { j.reconcile(response(j)+change,nonce,now) }
        failed("review_expired") { j.reconcile(response(j)+mapOf("expires_at" to Instant.ofEpochMilli(now).toString()),nonce,now) }
        failed("device_key_unavailable") { j.assertKey(jwk+mapOf("x" to "C".repeat(43))) }
    }
    @Test fun captureWriterRetainsPlannedHashAndBlocksDuplicateUntilAuthoritativeAbsent() {
        val j=journal().let { it.withChallenge(challenge(it)) }.plan(byteArrayOf(1,2,3))
        assertEquals("capture_pending",j.state);assertEquals(0,j.accepted.size)
        val writing=j.reconcile(response(j,"capture_pending",emptyList()),nonce,now)
        assertEquals(j.planned,writing.planned);assertTrue(writing.waiting)
        failed("enrollment_requires_recovery") { writing.plan(byteArrayOf(4,5,6)) }
        val absent=j.reconcile(response(j,"pending",emptyList()),nonce,now)
        assertEquals(emptyList<EnrollmentCapture>(),absent.planned)
        assertEquals(0,absent.plan(byteArrayOf(4,5,6)).planned.single().index)
    }
    @Test fun lostCaptureReplyRestoresOnlyIdenticalContiguousAcceptedProofs() {
        val j=journal().let { it.withChallenge(challenge(it)) }.plan(byteArrayOf(1,2,3))
        val accepted=j.reconcile(response(j,"pending",j.planned),nonce,now)
        assertEquals(j.planned,accepted.accepted)
        assertEquals(1,accepted.plan(byteArrayOf(4,5,6)).planned.last().index)
        failed("enrollment_capture_changed") { j.reconcile(response(j,"pending",listOf(j.planned.single().copy(hash="0".repeat(64)))),nonce,now) }
        failed("enrollment_capture_changed") { j.reconcile(response(j,"pending",listOf(j.planned.single().copy(index=1))),nonce,now) }
    }
    @Test fun registeredStatusNeverCarriesCredentialsOrReplaysCompletion() {
        val j=journal().let { it.withChallenge(challenge(it)) }
        val registered=j.reconcile(response(j,"registered"),nonce,now)
        assertEquals("registered",registered.state);assertNull(registered.credentialResult)
        assertEquals(j.alias,registered.alias);assertEquals(j.account,registered.account)
        failed("enrollment_requires_recovery") { registered.plan(byteArrayOf(1,2,3)) }
        failed("enrollment_response_changed") { j.reconcile(response(j,"registered")+mapOf("challenge" to baseChallenge(j)),nonce,now) }
        failed("enrollment_response_changed") { registered.reconcile(response(registered,"registered")+mapOf("profile" to mapOf("id" to other,"revision" to "changed","model_id" to "sface-v1")),nonce,now) }
    }
    @Test fun successorRequiresSavedPredecessorAndResetsOnlyToFreshEmptyCaptureSet() {
        val j=journal().let { it.withChallenge(challenge(it)) }.plan(byteArrayOf(1,2,3))
        val accepted=j.copy(state="pending",accepted=j.planned)
        val successor=challenge(j,2,other)
        failed("enrollment_response_changed") { accepted.withChallenge(successor) }
        val resumed=accepted.withChallenge(successor,successor=true)
        assertEquals(2L,resumed.generation);assertTrue(resumed.planned.isEmpty());assertTrue(resumed.accepted.isEmpty())
        val intent=accepted.copy(resume=mapOf("resume_key" to nonce,"expected_generation" to 1L,"expected_challenge_id" to challengeId))
        val status=response(intent)+mapOf("challenge_id" to other,"enrollment_generation" to 2,"challenge" to successor.filterKeys { it !in setOf("face_handle","enrollment_key","public_key_digest","enrollment_generation") },"captures" to emptyList<Any>())
        assertEquals(2L,intent.reconcile(status,nonce,now).generation)
        failed("enrollment_response_changed") { accepted.reconcile(status,nonce,now) }
        failed("enrollment_capture_changed") { intent.reconcile(status+mapOf("captures" to accepted.accepted.map(EnrollmentCapture::wire)),nonce,now) }
    }
    @Test fun lostResumeReplyThenExpiredSuccessorRetiresPreviousGenerationProofsBeforeSaveAndRestart() {
        val j=journal().let { it.withChallenge(challenge(it)) }
        val pending=j.copy(resume=mapOf("resume_key" to nonce,"expected_generation" to 1L,"expected_challenge_id" to challengeId),
            completion=mapOf("challenge_id" to challengeId,"device_signature" to "A".repeat(86)))
        val status=response(pending,"restart_required")+mapOf("challenge_id" to other,"enrollment_generation" to 2)
        val recovered=pending.reconcile(status,nonce,now)
        assertEquals(2L,recovered.generation);assertEquals(other,recovered.challengeId);assertEquals("restart_required",recovered.state)
        assertNull(recovered.resume);assertNull(recovered.completion);assertNull(recovered.challenge)
        assertTrue(recovered.planned.isEmpty());assertTrue(recovered.accepted.isEmpty())
        var durable: WireObject=emptyMap()
        persistEnrollmentState(mapOf("enrollment" to recovered.wire()),{durable=it}) {}
        val restored=EnrollmentJournal.restore(durable["enrollment"],origin)
        assertEquals(recovered,restored)
        val next=restored.withChallenge(challenge(restored,3,nonce),successor=true)
        assertEquals(3L,next.generation);assertEquals(nonce,next.challengeId);assertTrue(next.accepted.isEmpty())
    }
    @Test fun acceptedCaptureExpiryAndEmptyCleanupRetiresOldProgressBeforeDurableSameKeySuccessor() {
        var old=journal().let { it.withChallenge(challenge(it)) }
        for(bytes in listOf(byteArrayOf(1,2,3),byteArrayOf(4,5,6))) {
            old=old.plan(bytes).let { it.copy(state="pending",accepted=it.planned) }
        }
        val before=old.copy(completion=mapOf("challenge_id" to challengeId,"device_signature" to "A".repeat(86)),
            resume=mapOf("resume_key" to nonce,"expected_generation" to 1L,"expected_challenge_id" to challengeId))
        val cleaned=before.reconcile(response(before,"restart_required",emptyList()),nonce,now)
        assertEquals("restart_required",cleaned.state);assertNull(cleaned.challenge)
        assertTrue(cleaned.accepted.isEmpty());assertTrue(cleaned.planned.isEmpty());assertNull(cleaned.completion);assertNull(cleaned.resume)
        assertEquals(old.planned,cleaned.retiredCaptures)
        failed("enrollment_requires_recovery") { cleaned.plan(byteArrayOf(7,8,9)) }
        var durable: WireObject=emptyMap()
        persistEnrollmentState(mapOf("enrollment" to cleaned.wire()),{durable=it}) {}
        val restored=EnrollmentJournal.restore(durable["enrollment"],origin)
        assertEquals(cleaned,restored)
        val fresh=restored.withChallenge(challenge(restored,2,other),successor=true)
        assertEquals(old.account,fresh.account);assertEquals(old.alias,fresh.alias);assertEquals(old.digest,fresh.digest);assertEquals(old.handle,fresh.handle)
        assertEquals(2L,fresh.generation);assertEquals(0,fresh.accepted.size);assertTrue(fresh.retiredCaptures.isEmpty());assertNull(fresh.completion)
        assertEquals(0,fresh.plan(byteArrayOf(7,8,9)).planned.single().index)
        assertEquals(fresh,EnrollmentJournal.restore(fresh.wire(),origin))
    }
    @Test fun partialTerminalCleanupAllowsSparseKnownRowsButNeverReusesThemAsCompletionProgress() {
        var old=journal().let { it.withChallenge(challenge(it)) }
        for(bytes in listOf(byteArrayOf(1,2,3),byteArrayOf(4,5,6))) {
            old=old.plan(bytes).let { it.copy(state="pending",accepted=it.planned) }
        }
        val remaining=listOf(old.planned[1]) // Pose0 retired, pose1 deletion/HEAD verification has not settled.
        val terminal=response(old,"restart_required",remaining)
        val cleaned=old.reconcile(terminal,nonce,now)
        assertTrue(cleaned.accepted.isEmpty());assertTrue(cleaned.planned.isEmpty());assertEquals(old.planned,cleaned.retiredCaptures)
        var durable: WireObject=emptyMap()
        persistEnrollmentState(mapOf("enrollment" to cleaned.wire()),{durable=it}) {}
        val restored=EnrollmentJournal.restore(durable["enrollment"],origin)
        val polled=restored.reconcile(terminal,nonce,now)
        assertEquals(restored,polled);assertNull(polled.completion)
        failed("enrollment_capture_changed") { restored.reconcile(terminal+mapOf("captures" to listOf(remaining[0].copy(hash="0".repeat(64)).wire())),nonce,now) }
        failed("enrollment_capture_changed") { restored.reconcile(terminal+mapOf("captures" to listOf(remaining[0].copy(index=2).wire())),nonce,now) }
        failed("enrollment_capture_changed") { restored.reconcile(terminal+mapOf("captures" to listOf(remaining[0].wire(),remaining[0].wire())),nonce,now) }
        failed("enrollment_response_changed") { restored.reconcile(response(restored,"pending",emptyList()),nonce,now) }
        failed("enrollment_capture_changed") { old.reconcile(response(old,"pending",remaining),nonce,now) }
        val resume=polled.copy(resume=mapOf("resume_key" to nonce,"expected_generation" to 1L,"expected_challenge_id" to challengeId))
        assertEquals(resume,EnrollmentJournal.restore(resume.wire(),origin))
        val fresh=resume.withChallenge(challenge(resume,2,other),successor=true)
        assertEquals(old.key,fresh.key);assertEquals(old.device,fresh.device);assertEquals(old.alias,fresh.alias)
        assertTrue(fresh.retiredCaptures.isEmpty());assertTrue(fresh.accepted.isEmpty())
        val planned=fresh.plan(byteArrayOf(7,8,9));assertEquals(0,planned.planned.single().index)
        assertEquals(planned,EnrollmentJournal.restore(planned.wire(),origin))
    }
    @Test fun durableWriteFailureCannotPublishCompletionCredentialsOrClearRecovery() {
        val prior=journal().let { it.withChallenge(challenge(it)) }
        var durable: WireObject=mapOf("enrollment" to prior.wire(),"credentials" to mapOf("account_id" to account,"auth_method" to "anonymous"))
        var visible=prior;var published=false
        val candidate=prior.copy(state="credentials_pending",profile=mapOf("id" to other,"revision" to "r1","model_id" to "sface-v1"),
            credentialResult=mapOf("encrypted_result" to true))
        failed("enrollment_storage_unavailable") {
            persistEnrollmentState(durable+mapOf("enrollment" to candidate.wire()),{throw IOException("Controlled disk interruption")}) {
                published=true;visible=candidate
            }
        }
        assertFalse(published);assertEquals(prior,visible);assertEquals(prior,EnrollmentJournal.restore(durable["enrollment"],origin))
        persistEnrollmentState(durable+mapOf("enrollment" to candidate.wire()),{durable=it}) { visible=candidate }
        assertEquals(candidate,EnrollmentJournal.restore(durable["enrollment"],origin));assertEquals(candidate,visible)
        failed("enrollment_storage_unavailable") { persistEnrollmentState(durable.filterKeys { it!="enrollment" },{throw IOException("Promotion interrupted")}) { published=true } }
        assertFalse(published);assertNotNull(durable["enrollment"])
    }
    @Test fun rotatedSingleUseCredentialsSurviveMeLossAndRetirementWriteFailureAcrossRestart() {
        val pending=journal().let { it.withChallenge(challenge(it)) }.copy(state="credentials_pending",
            profile=mapOf("id" to other,"revision" to "r1","model_id" to "sface-v1"),
            credentialResult=mapOf("account_id" to account,"auth_method" to "registered_face","refresh_token" to "consumed-original",
                "access_token" to "expired-original","protocol" to "lovelies-face-auth-v1","status" to "authenticated","device_id" to device))
        val fresh=mapOf("account_id" to account,"auth_method" to "registered_face","refresh_token" to "single-use-current","access_token" to "current")
        val rotated=pending.rotatedCredentials(fresh)
        var durable: WireObject=mapOf("enrollment" to pending.wire(),"credentials" to pending.credentialResult)
        persistEnrollmentState(durable+mapOf("enrollment" to rotated.wire(),"credentials" to fresh),{durable=it}) {}
        // The actual /me reply or final journal-retirement write can fail after successful rotation.
        failed("enrollment_storage_unavailable") { persistEnrollmentState(durable.filterKeys { it!="enrollment" },{throw IOException("Retirement failed")}) {} }
        val restored=EnrollmentJournal.restore(durable["enrollment"],origin)
        val selected=restored.rotatedCredentials(NativeProtocol.obj(durable["credentials"])).credentialResult!!
        assertEquals("single-use-current",selected["refresh_token"]);assertEquals("current",selected["access_token"])
        assertEquals("authenticated",selected["status"]);assertEquals(device,selected["device_id"])
        assertNotEquals("consumed-original",selected["refresh_token"])
        // Compatibility: a previously surviving newer slot must also win over an older journal result.
        assertEquals("single-use-current",pending.rotatedCredentials(fresh).credentialResult!!["refresh_token"])
        failed("enrollment_response_changed") { restored.rotatedCredentials(fresh+mapOf("account_id" to other)) }
        failed("enrollment_response_changed") { restored.rotatedCredentials(fresh+mapOf("auth_method" to "anonymous")) }
    }
    @Test fun captureAcceptanceRequiresExactActualAcknowledgementAndMismatchRetainsPendingProof() {
        val j=journal().let { it.withChallenge(challenge(it)) }.plan(byteArrayOf(1,2,3));val capture=j.planned.single()
        val ack=mapOf("protocol" to "lovelies-face-auth-v1","status" to "capture_received","challenge_id" to challengeId,
            "capture_index" to 0,"capture_sha256" to capture.hash,"byte_size" to capture.bytes)
        capture.assertAcknowledgement(ack,challengeId)
        for(change in listOf(mapOf("protocol" to "other"),mapOf("status" to "authenticated"),mapOf("challenge_id" to other),
            mapOf("capture_index" to 1),mapOf("capture_sha256" to "0".repeat(64)),mapOf("byte_size" to capture.bytes+1))) {
            failed("capture_acknowledgement_changed") { capture.assertAcknowledgement(ack+change,challengeId) }
            assertEquals("capture_pending",j.state);assertEquals(0,j.accepted.size)
        }
        assertEquals(1,j.reconcile(response(j,"pending",j.planned),nonce,now).accepted.size)
    }
    @Test fun cancellationCannotAdoptANewerEpochAtRecoveryRefreshCaptureOrPromotion() {
        val j=journal();val fence=SessionFence()
        for(phase in listOf("recovery","refresh","capture","promotion")) {
            val before=fence.switch(account);fence.switch(account)
            failed("session_changed") { withEnrollmentPhase(fence,before,j,{j}) { error("Cancelled $phase reached publication") } }
        }
        val before=fence.switch(account)
        failed("enrollment_scope_changed") { withEnrollmentPhase(fence,before,j,{j.copy(key=other)}) { error("Foreign enrollment reached publication") } }
    }
    @Test fun credentialEpochAndStoragePublicationShareLogoutMonitor() {
        val j=journal();val fence=SessionFence();val before=fence.switch(account)
        val entered=CountDownLatch(1);val release=CountDownLatch(1);val attempted=CountDownLatch(1)
        val owned=AtomicReference<SessionScope>();val failure=AtomicReference<Throwable>();val loggedOut=AtomicBoolean(false)
        val writer=Thread { try { withEnrollmentPhase(fence,before,j,{j}) {
            entered.countDown();check(release.await(5,TimeUnit.SECONDS));owned.set(fence.switch(account))
        } } catch(problem: Throwable) { failure.set(problem) } }
        val logout=Thread { attempted.countDown();fence.switch(null);loggedOut.set(true) }
        try {
            writer.start();assertTrue(entered.await(5,TimeUnit.SECONDS));logout.start();assertTrue(attempted.await(5,TimeUnit.SECONDS))
            val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(2)
            while(logout.state!=Thread.State.BLOCKED && !loggedOut.get() && System.nanoTime()<deadline)Thread.yield()
            assertEquals(Thread.State.BLOCKED,logout.state);assertFalse(loggedOut.get())
            release.countDown();writer.join(5000);logout.join(5000);failure.get()?.let { throw AssertionError(it) }
            assertTrue(loggedOut.get());failed("session_changed") { fence.assert(requireNotNull(owned.get())) }
        } finally { release.countDown();writer.join(5000);if(logout.state!=Thread.State.NEW)logout.join(5000) }
    }
    @Test fun deletionHoldsJournalUntilConfirmedOwnDeletionAndPreservesForeignKeyReference() {
        val intent=GuestDeletionRecord.create(origin,account)
        val created=now;fun date(t: Long)=Instant.ofEpochMilli(t).toString()
        fun receipt(status: String): WireObject=mapOf("protocol" to "lovelies-account-deletion-v1","source" to "privacy","operation_key" to intent.operationKey,
            "privacy_request" to mapOf("id" to other,"request_type" to "delete","status" to status,"created_at" to date(created),
                "reviewed_at" to if(status=="completed")date(created+1) else null,"completed_at" to if(status=="completed")date(created+2) else null,"failure_code" to null),
            "deletion_status" to mapOf("expires_at" to date(created+30L*86400000)),"request_expires_at" to date(created+7L*86400000),"request_expired" to false,"deletion_completed" to (status=="completed"))
        val pending=intent.copy(receipt=GuestDeletionReceipt.parse(receipt("pending_approval"),intent))
        val prior=mapOf("enrollment" to journal().wire(),"credentials" to mapOf("account_id" to account,"auth_method" to "anonymous"))
        assertNotNull(pending.acceptedStorage(prior)["enrollment"])
        val completed=pending.copy(receipt=GuestDeletionReceipt.parse(receipt("completed"),pending))
        assertNull(completed.acceptedStorage(prior)["enrollment"])
        val foreign=prior+mapOf("enrollment" to journal().copy(account=other).wire())
        assertEquals(foreign["enrollment"],completed.acceptedStorage(foreign)["enrollment"])
        assertEquals(foreign["enrollment"],completed.restartStorage(foreign)["enrollment"])
    }
}
