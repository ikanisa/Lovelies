package com.lovelies.frontend.preview

import java.io.IOException
import java.time.Instant
import org.junit.Assert.*
import org.junit.Test

class FaceLifecycleTest {
    private val account="00000000-0000-4000-8000-000000000001"
    private val device="00000000-0000-4000-8000-000000000002"
    private val profile="00000000-0000-4000-8000-000000000003"
    private val cid="00000000-0000-4000-8000-000000000004"
    private val nextCid="00000000-0000-4000-8000-000000000005"
    private val nonce="00000000-0000-4000-8000-000000000006"
    private val origin="http://10.0.2.2:18887"
    private val reference=mapOf("id" to profile,"revision" to "reference-r1","model_id" to "sface-v1")
    private val jwk=mapOf("kty" to "EC","crv" to "P-256","x" to "A".repeat(43),"y" to "A".repeat(43),"ext" to true,"key_ops" to listOf("verify"))
    private val digest=NativeProtocol.sha256(NativeProtocol.canonical(jwk).toByteArray())
    private fun metadata(change: WireObject=emptyMap()): WireObject=mapOf("protocol" to "lovelies-face-profile-v1","authenticated" to false,
        "account_id" to account,"device_id" to device,"device_revision" to "device-r1","public_key_digest" to digest,"version" to 1L,
        "auth_policy_version" to "auth-v1","photo_policy_version" to "photo-v1","profile" to reference,"authentication_enabled" to true,
        "matching_enabled" to true,"processing_enabled" to true,"receive_matches" to true,"matching_paused" to false,"removal_state" to "none","operation" to null)+change
    private fun journal(change: WireObject=emptyMap()): FaceLifecycleJournal {
        val meta=FaceLifecycleMetadata.parse(metadata(change),account,device,digest)
        val identity=DeviceIdentity(account,"lovelies.device.lifecycle.test","lfh_"+"A".repeat(43),device)
        return FaceLifecycleJournal.create(origin,identity,jwk,meta).reconcile(meta.wire)
    }
    private fun challenge(j: FaceLifecycleJournal,generation: Long=1,id: String=cid): WireObject {
        val op=j.intent!!
        return mapOf("protocol" to "lovelies-face-auth-v1","account_id" to account,"device_id" to device,"device_revision" to "device-r1",
            "challenge_id" to id,"nonce" to "one-use-capture","purpose" to op.purpose,"policy_version" to op.authPolicy,
            "required_captures" to op.count,"poses" to if(op.count==1)listOf("front") else listOf("front","left","right"),
            "profile_id" to op.reference?.get("id"),"profile_revision" to op.reference?.get("revision"),"model_id" to op.reference?.get("model_id"),
            "expires_at" to Instant.ofEpochMilli(1000000).toString(),"lifecycle_operation_key" to op.key,"lifecycle_generation" to generation)
    }
    private fun response(j: FaceLifecycleJournal,state: String="pending",caps: List<EnrollmentCapture> = j.accepted,
        change: WireObject=emptyMap(),generation: Long=j.generation,id: String?=j.challengeId): WireObject {
        val op=j.intent!!
        val row=mapOf("operation_key" to op.key,"action" to op.action,"state" to state,"generation" to if(op.capture)generation else 0L,
            "challenge_id" to id,"challenge" to if(state=="pending")j.challenge else null,"captures" to caps.map(EnrollmentCapture::wire),"cleanup_state" to "none")
        return j.metadata.wire+mapOf("operation" to row,"request_nonce" to nonce)+change
    }
    private fun denied(code: String?=null,block: ()->Unit) {
        try { block();fail("Expected a lifecycle authority or durability denial") }
        catch(problem: LiveFailure) { if(code!=null)assertEquals(code,problem.code) }
    }
    @Test fun controlIsPrivateOriginalDeviceBoundAndContainsNoRawCaptures() {
        val j=journal();val restored=FaceLifecycleJournal.restore(j.wire(),origin)
        assertEquals(j,restored);assertEquals(32,java.util.Base64.getUrlDecoder().decode(j.control.substring(4)).size)
        assertEquals(setOf("account_id","device_id","control_key","control_operation_key"),j.controlBody().keys)
        assertEquals("lovelies-face-profile-device-v1",j.envelope("status",j.query(nonce))["protocol"])
        assertFalse(j.toString().contains(j.control));assertFalse(j.toString().contains(j.handle));assertNull(j.credentialResult)
        denied("face_profile_scope_changed") { FaceLifecycleJournal.restore(j.wire(),"https://different.invalid") }
        denied("device_key_unavailable") { j.assertKey(jwk+mapOf("x" to "B".repeat(43))) }
    }
    @Test fun readonlyMetadataRequiresExactAccountDeviceDigestNonceAndNondecreasingVersion() {
        for(change in listOf(mapOf("account_id" to nextCid),mapOf("device_id" to nextCid),mapOf("public_key_digest" to "0".repeat(64)),
            mapOf("device_revision" to "changed"),mapOf("request_nonce" to cid),mapOf("authenticated" to true),mapOf("version" to 0L),
            mapOf("profile" to reference+mapOf("model_id" to "")))) {
            denied { FaceLifecycleMetadata.parse(metadata()+mapOf("request_nonce" to nonce)+change,account,device,digest,"device-r1",nonce) }
        }
        denied { FaceLifecycleMetadata.parse(metadata(),account,device,digest,minimum=2) }
    }
    @Test fun purposeChoicesAreIndependentAndReadonlyStateNeverAuthenticates() {
        val pause=journal().begin("pause");assertNull(pause.intent!!.consent)
        val paused=pause.reconcile(response(pause,"applied",change=mapOf("version" to 2L,"matching_enabled" to false,"matching_paused" to true,"receive_matches" to false)),nonce)
        assertTrue(paused.metadata.authenticationEnabled);assertTrue(paused.metadata.processingEnabled);assertNull(paused.credentialResult)
        assertEquals(mapOf("purpose" to "photo_matching","policy_version" to "photo-v1","granted" to true),paused.begin("resume").intent!!.consent)
        val withdrawal=journal().begin("withdraw_authentication")
        val off=withdrawal.reconcile(response(withdrawal,"applied",change=mapOf("version" to 2L,"authentication_enabled" to false)),nonce)
        assertTrue(off.blocksPrivate);assertTrue(off.metadata.matchingEnabled);assertTrue(off.metadata.processingEnabled)
        assertEquals(1,off.begin("restore_authentication").intent!!.count)
        assertEquals("face_authentication",off.begin("restore_authentication").intent!!.consent!!["purpose"])
    }
    @Test fun removalRequiresVerifiedCleanupBeforeSameAccountFreshEnrollment() {
        val removal=journal().begin("remove")
        val pending=removal.reconcile(response(removal,"applied",change=mapOf("version" to 2L,"authentication_enabled" to false,
            "matching_enabled" to false,"receive_matches" to false,"profile" to null,"removal_state" to "pending")),nonce)
        assertEquals("removal_pending",pending.state);assertTrue(pending.blocksPrivate)
        denied { pending.begin("enroll") }
        val cleaned=pending.reconcile(response(pending,"applied",change=mapOf("profile" to null,"removal_state" to "completed")),nonce)
        assertNull(cleaned.intent);val enrollment=cleaned.begin("enroll");assertNull(enrollment.intent!!.reference)
        val fresh=enrollment.withChallenge(challenge(enrollment));assertEquals(3,fresh.intent!!.count);assertNull(fresh.challenge!!["model_id"])
        denied { fresh.withChallenge(challenge(fresh)+mapOf("profile_id" to profile)) }
        assertEquals(account,fresh.account);assertEquals(removal.alias,fresh.alias)
    }
    @Test fun everyReplacementChallengeBindsReferenceModelPurposePolicyPoseAndGeneration() {
        val j=journal().begin("replace").let { it.withChallenge(challenge(it)) }
        for(change in listOf(mapOf("account_id" to nextCid),mapOf("device_id" to nextCid),mapOf("device_revision" to "other"),mapOf("purpose" to "registration"),
            mapOf("profile_revision" to "new"),mapOf("model_id" to "other"),mapOf("policy_version" to "other"),mapOf("required_captures" to 1),
            mapOf("poses" to listOf("front","right","left")),mapOf("lifecycle_operation_key" to nonce),mapOf("lifecycle_generation" to 2)))
            denied { j.withChallenge(challenge(j)+change) }
        denied { FaceLifecycleJournal.restore(j.wire()+mapOf("challenge" to challenge(j)+mapOf("model_id" to "other")),origin) }
        denied("face_profile_version_changed") { j.reconcile(response(j,change=mapOf("version" to 2L)),nonce) }
        denied("face_profile_version_changed") { j.reconcile(response(j,change=mapOf("profile" to reference+mapOf("revision" to "changed"))),nonce) }
    }
    @Test fun acceptedPrefixContinuesButUnresolvedWriterCannotDuplicateProof() {
        val first=journal().begin("replace").let { it.withChallenge(challenge(it)) }.plan(byteArrayOf(1,2,3))
        denied { first.plan(byteArrayOf(4,5,6)) }
        val waiting=first.reconcile(response(first,"capture_pending"),nonce);assertTrue(waiting.waiting)
        denied { waiting.plan(byteArrayOf(4,5,6)) }
        val accepted=first.reconcile(response(first,caps=first.planned),nonce)
        assertEquals(1,accepted.accepted.size);assertEquals(1,accepted.plan(byteArrayOf(4,5,6)).planned.last().index)
        denied("face_profile_capture_changed") { accepted.reconcile(response(accepted,caps=emptyList()),nonce) }
        denied("face_profile_capture_changed") { first.reconcile(response(first,caps=listOf(first.planned.single().copy(hash="0".repeat(64)))),nonce) }
    }
    @Test fun aggregateCaptureBytesAndDistinctHashesAreCheckedBeforeDispatchAndAfterRestore() {
        val bytes=ByteArray(4*1024*1024) { 1 }
        val first=journal().begin("replace").let { it.withChallenge(challenge(it)) }.plan(bytes)
        val accepted=first.copy(state="pending",accepted=first.planned)
        denied("duplicate_capture") { accepted.plan(bytes) }
        bytes.fill(2)
        val second=accepted.plan(bytes);val two=second.copy(state="pending",accepted=second.planned)
        denied("capture_too_large") { two.plan(byteArrayOf(3)) }
        val restored=FaceLifecycleJournal.restore(two.wire(),origin);assertEquals(8L*1024*1024,restored.planned.sumOf { it.bytes })
        val forged=two.planned.mapIndexed { index,item->if(index==1)item.copy(bytes=item.bytes+1) else item }
        denied("face_profile_capture_changed") { FaceLifecycleJournal.restore(two.copy(planned=forged,accepted=forged).wire(),origin) }
        val duplicate=two.planned.mapIndexed { index,item->if(index==1)item.copy(hash=two.planned[0].hash) else item }
        denied("face_profile_capture_changed") { FaceLifecycleJournal.restore(two.copy(planned=duplicate,accepted=duplicate).wire(),origin) }
        bytes.fill(0)
    }
    @Test fun emptyAndSparseTerminalCleanupNeverCountAsCompletionAndSurviveSaveRestart() {
        val first=journal().begin("replace").let { it.withChallenge(challenge(it)) }.plan(byteArrayOf(1,2,3))
        val second=first.copy(state="pending",accepted=first.planned).plan(byteArrayOf(4,5,6))
        for(caps in listOf(emptyList(),listOf(second.planned[1]))) {
            val terminal=second.reconcile(response(second,"restart_required",caps),nonce)
            assertTrue(terminal.accepted.isEmpty());assertTrue(terminal.planned.isEmpty());assertNull(terminal.completion);assertNull(terminal.challenge)
            val restored=FaceLifecycleJournal.restore(terminal.wire(),origin)
            val resume=restored.copy(resume=mapOf("resume_key" to nonce,"expected_challenge_id" to cid,"expected_generation" to 1L))
            val successor=resume.withChallenge(challenge(resume,2,nextCid),true)
            assertEquals(second.alias,successor.alias);assertEquals(second.account,successor.account);assertTrue(successor.retired.isEmpty())
            assertEquals(0,successor.plan(byteArrayOf(7,8,9)).planned.single().index)
        }
    }
    @Test fun lostSuccessorReplyThenExpiryRetiresThePredecessorResumeAcrossRestart() {
        val j=journal().begin("replace").let { it.withChallenge(challenge(it)) }
            .copy(resume=mapOf("resume_key" to nonce,"expected_challenge_id" to cid,"expected_generation" to 1L))
        val adopted=j.reconcile(response(j,"restart_required",generation=2,id=nextCid),nonce)
        val restored=FaceLifecycleJournal.restore(adopted.wire(),origin)
        assertEquals(2L,restored.generation);assertNull(restored.resume);assertNull(restored.completion)
        assertEquals(3L,restored.withChallenge(challenge(restored,3,nonce),true).generation)
    }
    @Test fun cancellationRetainsUnknownIntentAndCannotUndoACommittedProfile() {
        val j=journal().begin("replace").let { it.withChallenge(challenge(it)) }.copy(state="cancel_pending")
        val still=j.reconcile(response(j),nonce);assertEquals("cancel_pending",still.state);assertTrue(still.blocksPrivate)
        denied { still.plan(byteArrayOf(1,2,3)) }
        val stopped=j.cancelAcknowledgement(response(j,"cancelled"),nonce)
        assertEquals("ready",stopped.state);assertNull(stopped.intent);assertEquals(j.alias,stopped.alias)
        val already=j.cancelAcknowledgement(response(j,"completed",change=mapOf("version" to 2L,"profile" to reference+mapOf("revision" to "new-r2"))),nonce)
        assertEquals("registered",already.state);assertTrue(already.blocksPrivate);assertNull(already.credentialResult)
        denied { j.copy(state="cancelled").withChallenge(challenge(j,1,cid)) }
    }
    @Test fun cancellationAfterLostStartCannotRecreateAnAuthoritativelyAbsentOperation() {
        val start=journal().begin("replace")
        val stopped=start.copy(state="cancel_pending")
        val status=metadata()+mapOf("request_nonce" to nonce)
        val resolution=stopped.resolveAbsentOperation(status,nonce)
        assertFalse(resolution.retryOriginal);assertEquals(stopped.intent,resolution.journal.intent)
        assertEquals("cancel_pending",resolution.journal.state);assertTrue(resolution.journal.blocksPrivate)
        val restored=FaceLifecycleJournal.restore(resolution.journal.wire(),origin)
        assertFalse(restored.resolveAbsentOperation(status+mapOf("version" to 2L,"profile" to reference+mapOf("revision" to "current-r2")),nonce).retryOriginal)
        val liveStart=start.resolveAbsentOperation(status,nonce)
        assertTrue(liveStart.retryOriginal);assertEquals(start.intent!!.body(),liveStart.journal.intent!!.body())
        denied("face_profile_version_changed") { start.resolveAbsentOperation(status+mapOf("version" to 2L),nonce) }
    }
    @Test fun profileCredentialsAreStagedAndRotatedAtomicallyBeforeRelease() {
        val j=journal().begin("replace").let { it.withChallenge(challenge(it)) }
        val value=mapOf("protocol" to "lovelies-face-auth-v1","status" to "authenticated","account_id" to account,"device_id" to device,
            "auth_method" to "registered_face","profile_id" to profile,"profile_revision" to "new-r2","model_id" to "sface-v1","refresh_token" to "spent")
        val pending=j.withCredentials(value);var visible=j;var durable: WireObject=mapOf("face_lifecycle" to j.wire(),"original_alias" to j.alias)
        denied("face_profile_storage_unavailable") { persistLifecycle(durable+mapOf("face_lifecycle" to pending.wire()),{throw IOException("Controlled write failure")}) { visible=pending } }
        assertEquals(j,visible);assertEquals(j.alias,durable["original_alias"])
        val rotated=pending.rotatedCredentials(mapOf("account_id" to account,"auth_method" to "registered_face","refresh_token" to "current"))
        persistLifecycle(durable+mapOf("face_lifecycle" to rotated.wire()),{durable=it}) { visible=rotated }
        denied("face_profile_storage_unavailable") { persistLifecycle(emptyMap(),{throw IOException("Retirement failure")}) {} }
        assertEquals("current",FaceLifecycleJournal.restore(durable["face_lifecycle"],origin).credentialResult!!["refresh_token"])
        denied { pending.withCredentials(value+mapOf("device_id" to nextCid)) }
    }
    @Test fun originalPhaseCannotPublishAfterLogoutOrAReplacementControl() {
        val j=journal();var active: FaceLifecycleJournal?=j;val fence=SessionFence();val scope=fence.switch(account)
        fence.switch(account)
        denied("session_changed") { withLifecyclePhase(fence,scope,j,{active}) { error("Late response reached publication") } }
        active=j.renew(j.metadata)
        denied("face_profile_scope_changed") { withLifecyclePhase(fence,fence.scope(),j,{active}) { error("Old control reached new journal") } }
    }
    @Test fun explicitRegisteredLogoutRetainsManagementButNeverRestoresTheCredentialSlot() {
        val j=journal().begin("replace").let { it.withChallenge(challenge(it)) }.copy(state="cancel_pending")
        val registered=mapOf("account_id" to account,"auth_method" to "registered_face","access_token" to "old-private-session")
        val anonymous=mapOf("account_id" to account,"auth_method" to "anonymous","access_token" to "original-guest")
        assertNull(heldAnonymousLogoutCredentials(registered,true));assertNull(heldAnonymousLogoutCredentials(registered,false))
        assertEquals(anonymous,heldAnonymousLogoutCredentials(anonymous,true));assertNull(heldAnonymousLogoutCredentials(anonymous,false))
        var durable: WireObject=mapOf("face_lifecycle" to j.wire(),"credentials" to registered)
        val candidate=mapOf("face_lifecycle" to j.forExplicitLogout().wire(),"original_alias" to j.alias)
        persistLifecycle(candidate,{durable=it}) {}
        val restarted=FaceLifecycleJournal.restore(durable["face_lifecycle"],origin)
        assertTrue(restarted.blocksPrivate);assertEquals(j.control,restarted.control);assertEquals(j.alias,durable["original_alias"])
        assertNull(durable["credentials"]);assertNull(restarted.credentialResult)
    }
    private fun login(j: FaceLifecycleJournal): WireObject=mapOf("protocol" to "lovelies-face-auth-v1","account_id" to account,"device_id" to device,
        "device_revision" to j.metadata.deviceRevision,"challenge_id" to cid,"purpose" to "login","required_captures" to 1,"poses" to listOf("front"),
        "profile_id" to profile,"profile_revision" to "reference-r1","model_id" to "sface-v1","nonce" to "fresh-login",
        "policy_version" to "auth-v1","expires_at" to Instant.ofEpochMilli(1000000).toString())
    @Test fun expiredControlFreshLoginIsExplicitSameDeviceAndCannotRegrantWithdrawnAuthority() {
        val j=journal();val seam=j.beginStableLogin();assertTrue(seam.blocksPrivate);assertNotNull(seam.loginKey);assertNull(seam.intent)
        assertEquals(j.control,seam.control);assertEquals(j.alias,seam.alias);assertFalse(seam.wire().containsKey("consent"))
        val proof=seam.withLoginChallenge(login(seam)).planLogin(byteArrayOf(1,2,3))
        val restored=FaceLifecycleJournal.restore(proof.wire(),origin);assertEquals(seam.loginKey,restored.loginKey);assertTrue(restored.blocksPrivate)
        denied { seam.withLoginChallenge(login(seam)+mapOf("purpose" to "registration")) }
        denied { seam.withLoginChallenge(login(seam)+mapOf("model_id" to "")) }
        denied { journal(mapOf("authentication_enabled" to false)).beginStableLogin() }
        denied { journal(mapOf("profile" to null,"removal_state" to "completed","authentication_enabled" to false)).beginStableLogin() }
        denied { j.begin("replace").beginStableLogin() }
        assertNull(restored.forExplicitLogout().loginKey);assertEquals("ready",restored.forExplicitLogout().state)
    }
    @Test fun currentCredentialProfileAndUniqueActiveDeviceAreRequiredBeforeLoginPublication() {
        val j=journal().beginStableLogin().let { it.withLoginChallenge(login(it)) }
        val meta=j.metadata
        val me=mapOf("user_id" to account,"authenticated" to true,"auth_method" to "registered_face","profile_id" to profile,"profile_revision" to "reference-r1")
        val devices=mapOf("items" to listOf(mapOf("id" to device,"current" to true,"status" to "active")))
        assertLifecycleSession(j,meta,me,devices,reference)
        denied { assertLifecycleSession(j,meta.copy(authenticationEnabled=false),me,devices,reference) }
        denied { assertLifecycleSession(j,meta,me+mapOf("user_id" to nextCid),devices,reference) }
        denied { assertLifecycleSession(j,meta,me+mapOf("profile_revision" to "old"),devices,reference) }
        denied { assertLifecycleSession(j,meta,me,mapOf("items" to listOf(mapOf("id" to device,"current" to true,"status" to "revoked"))),reference) }
        denied { assertLifecycleSession(j,meta,me,mapOf("items" to listOf(mapOf("id" to device,"current" to true,"status" to "active"),mapOf("id" to nextCid,"current" to true,"status" to "active"))),reference) }
        denied { assertLifecycleSession(j,meta,me,devices,reference+mapOf("model_id" to "other")) }
    }
    @Test fun explicitRenewalRetainsOriginalKeyAndExactNewIntentAfterRestart() {
        val j=journal();val renewed=j.renew(j.metadata)
        assertEquals(j.alias,renewed.alias);assertEquals(j.account,renewed.account);assertEquals(j.handle,renewed.handle)
        assertNotEquals(j.control,renewed.control);assertNotEquals(j.controlOperation,renewed.controlOperation)
        assertEquals(j.controlOperation,renewed.controlBody()["previous_control_operation_key"]);assertEquals(true,renewed.controlBody()["renew"])
        assertEquals(renewed,FaceLifecycleJournal.restore(renewed.wire(),origin));assertTrue(renewed.blocksPrivate)
        denied { j.copy(metadata=j.metadata.copy(authenticationEnabled=false)).renew(j.metadata.copy(authenticationEnabled=false)) }
        denied { j.begin("replace").renew(j.metadata) }
    }
}
