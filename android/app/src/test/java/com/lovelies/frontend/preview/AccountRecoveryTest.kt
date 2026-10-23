package com.lovelies.frontend.preview

import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.time.Instant

class AccountRecoveryTest {
    private val account="00000000-0000-4000-8000-000000000001"
    private val source="00000000-0000-4000-8000-000000000002"
    private val device="00000000-0000-4000-8000-000000000003"
    private val cid="00000000-0000-4000-8000-000000000004"
    private val profile="00000000-0000-4000-8000-000000000005"
    private val nonce="00000000-0000-4000-8000-000000000006"
    private val nextCid="00000000-0000-4000-8000-000000000007"
    private val origin="http://10.0.2.2:18887"
    private val now=100000L
    private val jwk=mapOf("kty" to "EC","crv" to "P-256","x" to "A".repeat(43),"y" to "A".repeat(43),"ext" to true,"key_ops" to listOf("verify"))
    private fun journal()=AccountRecoveryJournal.create(origin,RecoveryBackup.create(account),"lovelies.device.recovery.test",jwk,"policy-v1",source)
    private fun challenge(j: AccountRecoveryJournal,generation: Int=1,id: String=cid): WireObject=mapOf("protocol" to "lovelies-face-auth-v1",
        "recovery_request_id" to j.requestId,"recovery_generation" to generation,"challenge_id" to id,"account_id" to account,"device_id" to device,
        "device_revision" to "device-r1","profile_id" to profile,"profile_revision" to "profile-r1","model_id" to "sface-v1",
        "nonce" to "one-use-proof","purpose" to "login","policy_version" to j.policy,"required_captures" to 1,"poses" to listOf("front"),
        "expires_at" to Instant.ofEpochMilli(now+60000).toString())
    private fun response(j: AccountRecoveryJournal,state: String="pending",caps: List<EnrollmentCapture> = if(j.accepted)listOf(j.planned!!) else emptyList()): WireObject=
        mapOf("protocol" to "lovelies-account-recovery-v1","authenticated" to false,"account_id" to account,"recovery_request_id" to j.requestId,
            "device_id" to device,"device_revision" to "device-r1","public_key_digest" to j.digest,"policy_version" to j.policy,"challenge_id" to cid,
            "generation" to 1,"request_nonce" to nonce,"expires_at" to Instant.ofEpochMilli(now+7L*86400000).toString(),"state" to state,
            "challenge" to if(state=="pending")challenge(j).filterKeys { it !in setOf("recovery_request_id","recovery_generation") } else null,
            "captures" to if(state=="registered")emptyList<Any>() else caps.map(EnrollmentCapture::wire),
            "profile" to mapOf("id" to profile,"revision" to "profile-r1","model_id" to "sface-v1"))
    private fun failed(code: String?=null,block: ()->Unit) {
        try { block();fail("Expected a recovery binding or durability denial") }
        catch(problem: LiveFailure) { if(code!=null)assertEquals(code,problem.code) }
    }
    @Test fun backupHasCanonical256BitSecretAndRedactedDiagnostics() {
        val b=RecoveryBackup.create(account)
        assertEquals(b,RecoveryBackup.parse(b.text()));assertEquals(32,java.util.Base64.getUrlDecoder().decode(b.secret.substring(4)).size)
        assertFalse(b.toString().contains(b.secret))
        for(value in listOf("$account:${b.secret}","LVR2:$account:${b.secret}","LVR1:not-account:${b.secret}","LVR1:$account:lfr_short","LVR1:$account:lfr_"+"B".repeat(43)))
            failed("recovery_backup_invalid") { RecoveryBackup.parse(value) }
    }
    @Test fun recoveryKeyIntentPersistsOriginalSecretAndOperationBeforeDisclosureOrRetry() {
        val intent=RecoveryKeyIntent.create(origin,account);var durable: WireObject=emptyMap();var shown=false
        failed("account_recovery_storage_unavailable") {
            persistAccountRecovery(mapOf("recovery_key_intent" to intent.wire()),{throw IOException("Controlled write failure")}) { shown=true }
        }
        assertFalse(shown);assertTrue(durable.isEmpty())
        persistAccountRecovery(mapOf("recovery_key_intent" to intent.wire()),{durable=it}) {}
        val restored=RecoveryKeyIntent.restore(durable["recovery_key_intent"],origin)
        assertEquals(intent,restored);assertEquals(NativeProtocol.canonical(intent.body()),NativeProtocol.canonical(restored.body()))
        assertFalse(intent.toString().contains(intent.backup.secret))
    }
    @Test fun keyReceiptBindsExactCurrentAccountKeyOperationAndExpiryWithoutEchoingSecret() {
        val intent=RecoveryKeyIntent.create(origin,account)
        val wire=mapOf("protocol" to "lovelies-account-recovery-v1","state" to "ready","account_id" to account,"operation_key" to intent.operation,
            "key_id" to device,"expires_at" to Instant.ofEpochMilli(now+365L*86400000).toString())
        val receipt=RecoveryKeyReceipt.parse(wire,account,intent.operation)
        assertTrue(receipt.same(RecoveryKeyReceipt.parse(receipt.wire(),account,intent.operation)))
        assertFalse(NativeProtocol.canonical(receipt.wire()).contains(intent.backup.secret))
        failed("recovery_key_response_changed") { RecoveryKeyReceipt.parse(wire+mapOf("account_id" to source),account) }
        failed("recovery_key_response_changed") { RecoveryKeyReceipt.parse(wire+mapOf("operation_key" to nonce),account,intent.operation) }
        assertFalse(receipt.same(receipt.copy(keyId=nextCid)))
    }
    @Test fun requestIsSeparateFromA01WithOriginalAccountAndNewKeyBoundEnvelope() {
        val j=journal();assertEquals(j,AccountRecoveryJournal.restore(j.wire(),origin))
        assertEquals(account,j.account);assertEquals(source,j.sourceAccount)
        assertEquals(setOf("account_id","recovery_key","recovery_request_id","face_handle","device_public_jwk","policy_version","protocol","step"),j.envelope("start").keys)
        assertEquals("lovelies-account-recovery-device-v1",j.envelope("start")["protocol"])
        assertFalse(j.toString().contains(j.backup.secret));assertFalse(j.toString().contains(j.handle))
        failed("account_recovery_scope_changed") { AccountRecoveryJournal.restore(j.wire(),"https://different.invalid") }
        failed("device_key_unavailable") { j.assertKey(jwk+mapOf("x" to "C".repeat(43))) }
    }
    @Test fun onlyAuthenticatedKeyBoundNotFoundPermitsSameSavedStartRetry() {
        val j=journal();assertTrue(j.allowsStartRetry(LiveFailure("account_recovery_not_found",404)))
        assertFalse(j.allowsStartRetry(LiveFailure("account_recovery_unavailable",401)))
        assertFalse(j.allowsStartRetry(LiveFailure("server_unavailable",404)))
        assertFalse(j.withChallenge(challenge(j)).allowsStartRetry(LiveFailure("account_recovery_not_found",404)))
    }
    @Test fun responseLossAdoptsOneDeviceAndAllExactProfileModelBindings() {
        val j=journal();val recovered=j.reconcile(response(j),nonce,now)
        assertEquals(device,recovered.device);assertEquals("sface-v1",recovered.profile!!["model_id"])
        assertEquals(j.requestId,recovered.requestId);assertEquals(j.alias,recovered.alias)
        val fields=listOf(mapOf("account_id" to source),mapOf("recovery_request_id" to nonce),mapOf("public_key_digest" to "0".repeat(64)),
            mapOf("request_nonce" to cid),mapOf("device_id" to nextCid),mapOf("device_revision" to "changed"),mapOf("policy_version" to "other"),mapOf("authenticated" to true))
        fields.forEach { failed("account_recovery_response_changed") { recovered.reconcile(response(recovered)+it,nonce,now) } }
        failed("account_recovery_response_changed") { recovered.reconcile(response(recovered)+mapOf("profile" to mapOf("id" to profile,"revision" to "profile-r1","model_id" to "changed")),nonce,now) }
    }
    @Test fun firstChallengeSuccessorAndRestorationBindActualNonemptyModel() {
        val j=journal().let { it.withChallenge(challenge(it)) };assertEquals("sface-v1",j.profile!!["model_id"])
        failed("account_recovery_response_changed") { j.withChallenge(challenge(j)+mapOf("model_id" to "changed")) }
        failed("account_recovery_response_changed") { j.withChallenge(challenge(j,2,nextCid)+mapOf("model_id" to "changed"),successor=true) }
        failed("account_recovery_response_changed") { journal().let { it.withChallenge(challenge(it)+mapOf("model_id" to "")) } }
        failed("account_recovery_response_changed") { AccountRecoveryJournal.restore(j.wire()+mapOf("challenge" to challenge(j)+mapOf("model_id" to "changed")),origin) }
        failed("account_recovery_response_changed") { AccountRecoveryJournal.restore(j.copy(state="registered",challenge=null).wire()+mapOf("profile" to mapOf("id" to profile,"revision" to "profile-r1","model_id" to null)),origin) }
    }
    @Test fun nestedStatusChallengeCannotSubstituteAnotherRequestOrGeneration() {
        val j=journal().let { it.withChallenge(challenge(it)) }
        assertEquals(j.requestId,j.reconcile(response(j)+mapOf("challenge" to challenge(j)),nonce,now).requestId)
        for(change in listOf(mapOf("recovery_request_id" to nextCid),mapOf("recovery_generation" to 2))) {
            failed("account_recovery_response_changed") { j.reconcile(response(j)+mapOf("challenge" to challenge(j)+change),nonce,now) }
            failed("account_recovery_response_changed") { AccountRecoveryJournal.restore(j.wire()+mapOf("challenge" to challenge(j)+change),origin) }
        }
    }
    @Test fun pendingWriterCannotDuplicateProofAndAcceptedMetadataCannotChange() {
        val j=journal().let { it.withChallenge(challenge(it)) }.plan(byteArrayOf(1,2,3))
        val pending=j.reconcile(response(j,"capture_pending"),nonce,now)
        assertEquals(j.planned,pending.planned);assertTrue(pending.waiting);assertFalse(pending.accepted)
        failed("account_recovery_requires_status") { pending.plan(byteArrayOf(4,5,6)) }
        val accepted=j.reconcile(response(j,caps=listOf(j.planned!!)),nonce,now)
        assertTrue(accepted.accepted)
        failed("account_recovery_capture_changed") { j.reconcile(response(j,caps=listOf(j.planned!!.copy(hash="0".repeat(64)))),nonce,now) }
        failed("account_recovery_capture_changed") { accepted.reconcile(response(accepted,caps=emptyList()),nonce,now) }
    }
    @Test fun terminalCleanupRetiresProgressAndRequiresFreshOneCaptureSuccessorAcrossRestart() {
        val planned=journal().let { it.withChallenge(challenge(it)) }.plan(byteArrayOf(1,2,3))
        val j=planned.copy(state="completion_pending",accepted=true,completion=mapOf("challenge_id" to cid,"device_signature" to "A".repeat(86)))
        val terminal=j.reconcile(response(j,"restart_required",emptyList()),nonce,now)
        assertNull(terminal.planned);assertFalse(terminal.accepted);assertNull(terminal.completion);assertNull(terminal.challenge)
        assertEquals(j.planned,terminal.retired)
        val restored=AccountRecoveryJournal.restore(terminal.wire(),origin)
        val polled=restored.reconcile(response(restored,"restart_required",listOf(restored.retired!!)),nonce,now)
        assertFalse(polled.accepted);assertNull(polled.planned)
        val fresh=polled.withChallenge(challenge(polled,2,nextCid),successor=true)
        assertEquals(j.alias,fresh.alias);assertEquals(j.account,fresh.account);assertEquals(j.handle,fresh.handle);assertNull(fresh.retired)
        assertEquals(0,fresh.plan(byteArrayOf(4,5,6)).planned!!.index)
    }
    @Test fun lostResumeThenSuccessorExpiryCanSaveAndRestartWithoutPredecessorProofs() {
        val j=journal().let { it.withChallenge(challenge(it)) }.copy(resume=mapOf("resume_key" to nonce,"expected_generation" to 1L,"expected_challenge_id" to cid))
        val status=response(j,"restart_required")+mapOf("generation" to 2,"challenge_id" to nextCid)
        val restored=AccountRecoveryJournal.restore(j.reconcile(status,nonce,now).wire(),origin)
        assertEquals(2L,restored.generation);assertEquals(nextCid,restored.challengeId);assertNull(restored.resume)
        assertEquals(3L,restored.withChallenge(challenge(restored,3,nonce),successor=true).generation)
    }
    @Test fun registeredReadonlyStatusDoesNotAuthenticateOrPublishReplacementProfile() {
        val j=journal().let { it.withChallenge(challenge(it)) }
        val registered=j.reconcile(response(j,"registered"),nonce,now)
        assertEquals("registered",registered.state);assertNull(registered.credentialResult)
        failed("account_recovery_requires_status") { registered.plan(byteArrayOf(1,2,3)) }
        failed("account_recovery_response_changed") { j.reconcile(response(j,"registered")+mapOf("challenge" to challenge(j)),nonce,now) }
        failed("account_recovery_response_changed") { j.withCredentials(mapOf("protocol" to "lovelies-face-auth-v1","status" to "authenticated","account_id" to source,"auth_method" to "registered_face","device_id" to device)) }
    }
    @Test fun credentialWriteOrRetirementFailureKeepsOriginalA01AndDeviceUntilVerifiedPromotion() {
        val j=journal().let { it.withChallenge(challenge(it)) }
        val result=mapOf("protocol" to "lovelies-face-auth-v1","status" to "authenticated","account_id" to account,"auth_method" to "registered_face",
            "device_id" to device,"profile_id" to profile,"profile_revision" to "profile-r1","model_id" to "sface-v1","refresh_token" to "consumed")
        val pending=j.withCredentials(result);var durable: WireObject=mapOf("account_recovery" to j.wire(),"enrollment" to mapOf("original" to true),"device" to mapOf("old" to true))
        var visible=j
        failed("account_recovery_storage_unavailable") { persistAccountRecovery(durable+mapOf("account_recovery" to pending.wire()),{throw IOException("Controlled write error")}) { visible=pending } }
        assertEquals(j,visible);assertNotNull(durable["enrollment"]);assertNotNull(durable["device"])
        val rotated=pending.rotatedCredentials(mapOf("account_id" to account,"auth_method" to "registered_face","refresh_token" to "current"))
        persistAccountRecovery(durable+mapOf("account_recovery" to rotated.wire()),{durable=it}) { visible=rotated }
        failed("account_recovery_storage_unavailable") { persistAccountRecovery(mapOf("new-device" to true),{throw IOException("Retirement error")}) {} }
        val restored=AccountRecoveryJournal.restore(durable["account_recovery"],origin)
        assertEquals("current",restored.credentialResult!!["refresh_token"]);assertNotNull(durable["enrollment"])
    }
    @Test fun foreignRetainedIdentityOrA01IsRejectedBeforeAnyNewRequestAndPreserved() {
        val b=RecoveryBackup.create(account)
        assertRecoveryTarget(b,null,null);assertRecoveryTarget(b,account,account)
        val identity=mapOf("account" to source,"handle" to "original-handle","alias" to "original-key","device" to device)
        val originalA01=mapOf("account" to source,"original_pending_metadata" to true)
        val existing=mapOf("device" to identity,"enrollment" to originalA01)
        failed("account_recovery_account_changed") { assertRecoveryTarget(b,source,null) }
        failed("account_recovery_account_changed") { assertRecoveryTarget(b,null,source) }
        assertEquals(identity,existing["device"]);assertEquals(originalA01,existing["enrollment"])
    }
    @Test fun explicitCorrectedBackupArchivesUnknownIntentAndCancelsItsEpochWithoutDroppingA01() {
        val old=journal();val correct=RecoveryBackup.create(account)
        var durable: WireObject=mapOf("account_recovery" to old.wire(),"enrollment" to mapOf("preserved" to true),"device" to mapOf("preserved" to true))
        val fence=SessionFence();val before=fence.switch(source);var active: AccountRecoveryJournal?=old
        val candidate=archiveRecoveryCandidate(durable,old,origin)
        withAccountRecoveryPhase(fence,before,old,{active}) { persistAccountRecovery(candidate,{durable=it}) { active=null;fence.switch(source) } }
        assertNotNull(durable["enrollment"]);assertNotNull(durable["device"]);assertNull(durable["account_recovery"])
        val archived=AccountRecoveryJournal.restore(NativeProtocol.rows(durable["retired_account_recoveries"],16).single(),origin)
        assertEquals(old,archived)
        val replacement=AccountRecoveryJournal.create(origin,correct,"lovelies.device.recovery.corrected",jwk,"policy-v1",source)
        assertNotEquals(old.requestId,replacement.requestId);assertNotEquals(old.alias,replacement.alias)
        active=replacement
        failed("session_changed") { withAccountRecoveryPhase(fence,before,old,{active}) { error("Late previous reply reached promotion") } }
        val full=durable+mapOf("retired_account_recoveries" to List(16) { old.wire() })
        failed("account_recovery_history_full") { archiveRecoveryCandidate(full,old,origin) }
        assertEquals(16,NativeProtocol.rows(full["retired_account_recoveries"],16).size)
    }
    @Test fun archiveWriteFailureDoesNotExposeReplacementOrDestroyOriginalSecret() {
        val old=journal();var active: AccountRecoveryJournal?=old
        val durable=mapOf("account_recovery" to old.wire())
        failed("account_recovery_storage_unavailable") { persistAccountRecovery(archiveRecoveryCandidate(durable,old,origin),{throw IOException("Archive write failed")}) { active=null } }
        assertEquals(old,active);assertEquals(old,AccountRecoveryJournal.restore(durable["account_recovery"],origin))
    }
    @Test fun archivedRequestHandsOffOnlyItsOwnedScopeAndCannotAdoptConcurrentLogout() {
        val old=journal();val fence=SessionFence();val previous=fence.switch(source)
        var active: AccountRecoveryJournal?=old;var durable: WireObject=mapOf("account_recovery" to old.wire())
        val replacementScope=withAccountRecoveryPhase(fence,previous,old,{active}) {
            persistAccountRecovery(archiveRecoveryCandidate(durable,old,origin),{durable=it}) { active=null;fence.switch(source) }
        }
        withAccountRecoveryStartPhase(fence,replacementScope) { assertNull(active) }
        fence.switch(null) // Sign-out after successful archival but before a new key or request is created.
        var keyCreated=false
        failed("session_changed") { withAccountRecoveryStartPhase(fence,replacementScope) { keyCreated=true } }
        assertFalse(keyCreated);assertNull(active)
        assertEquals(old,AccountRecoveryJournal.restore(NativeProtocol.rows(durable["retired_account_recoveries"],16).single(),origin))
    }
}
