package com.lovelies.frontend.preview

import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

class GuestDeletionTest {
    private val origin="http://10.0.2.2:18887"
    private val account="00000000-0000-4000-8000-000000000001"
    private val other="00000000-0000-4000-8000-000000000002"
    private val request="00000000-0000-4000-8000-000000000003"
    private val created=100000L
    private fun date(time: Long)=Instant.ofEpochMilli(time).toString()
    private fun record()=GuestDeletionRecord.create(origin,account)
    private fun response(intent: GuestDeletionRecord,status: String="pending_approval",expired: Boolean=false): WireObject = mapOf(
        "protocol" to "lovelies-account-deletion-v1","source" to "privacy","operation_key" to intent.operationKey,
        "privacy_request" to mapOf("id" to request,"request_type" to "delete","status" to status,"created_at" to date(created),
            "reviewed_at" to if(status=="pending_approval")null else date(created+1000),"completed_at" to if(status=="completed")date(created+2000) else null,"failure_code" to null),
        "deletion_status" to mapOf("expires_at" to date(created+30L*86400000)),"request_expires_at" to date(created+7L*86400000),
        "request_expired" to expired,"deletion_completed" to (status=="completed"))
    private fun failed(code: String?=null,block: ()->Unit) {
        try { block();fail("Expected a bound, fail-closed rejection") }
        catch(problem: LiveFailure) { if(code!=null)assertEquals(code,problem.code) }
    }
    @Test fun statusProofHasFullSecureTokenAndExactOriginalBodySurvivesRestoration() {
        val intent=record();val second=record()
        assertTrue(Regex("^lvd_[0-9a-f]{64}$").matches(intent.statusToken));assertNotEquals(intent.statusToken,second.statusToken)
        assertNotEquals(intent.operationKey,second.operationKey)
        val restored=GuestDeletionRecord.restore(intent.wire(),origin,account,"anonymous")
        assertEquals(NativeProtocol.canonical(intent.requestBody()),NativeProtocol.canonical(restored.requestBody()))
        assertEquals(setOf("operation_key","status_token"),restored.requestBody().keys)
        assertEquals(account,restored.account)
        assertTrue(restored.mayRetry(account,"anonymous"))
        assertFalse(restored.mayRetry(other,"anonymous"));assertFalse(restored.mayRetry(account,"registered_face"));assertFalse(restored.mayRetry(null,null))
    }
    @Test fun encryptedRecordCannotMoveToAnotherOriginActorOrAuthenticationMethod() {
        val intent=record()
        failed("deletion_origin_changed") { GuestDeletionRecord.restore(intent.wire(),"https://example.com",account,"anonymous") }
        failed("deletion_account_changed") { GuestDeletionRecord.restore(intent.wire(),origin,other,"anonymous") }
        failed("deletion_account_changed") { GuestDeletionRecord.restore(intent.wire(),origin,account,"registered_face") }
        listOf("lvd_"+"A".repeat(64),"lvd_"+"a".repeat(63),"a".repeat(64),"lvd_"+"z".repeat(64)).forEach { token ->
            failed("deletion_record_invalid") { GuestDeletionRecord.restore(intent.wire()+mapOf("status_token" to token),origin,null,null) }
        }
    }
    @Test fun acknowledgementAndReadOnlyStatusBindProtocolSourceOriginalKeyAndRequestOwner() {
        val intent=record();val valid=response(intent)
        listOf(valid+mapOf("protocol" to "reviewed-sharing-v1"),valid+mapOf("source" to "personal"),valid+mapOf("operation_key" to record().operationKey)).forEach {
            failed("deletion_receipt_scope_changed") { GuestDeletionReceipt.parse(it,intent) }
        }
        val row=NativeProtocol.obj(valid["privacy_request"])
        failed("deletion_account_changed") { GuestDeletionReceipt.parse(valid+mapOf("privacy_request" to row+mapOf("subject_user_id" to other)),intent) }
        failed("deletion_receipt_invalid") { GuestDeletionReceipt.parse(valid+mapOf("privacy_request" to row+mapOf("request_type" to "export")),intent) }
        assertEquals("Awaiting review",GuestDeletionReceipt.parse(valid,intent).label)
    }
    @Test fun everyNonCompletedStatusBlocksNewAccountAndOnlySafeTerminalStatesPermitResume() {
        listOf("pending_approval","approved","queued","processing","failed","rejected","cancelled").forEach { status ->
            val intent=record();val saved=intent.copy(receipt=GuestDeletionReceipt.parse(response(intent,status),intent))
            assertFalse(saved.receipt!!.completed);assertFalse(saved.mayRetry(account,"anonymous"))
            failed("deletion_not_completed") { saved.assertRestartAllowed() }
            if(status in listOf("rejected","cancelled"))saved.assertResumeAllowed()
            else failed("deletion_cannot_resume") { saved.assertResumeAllowed() }
        }
        val unknown=record().copy(statusUnavailable=true)
        failed("deletion_not_completed") { unknown.assertRestartAllowed() }
        failed("deletion_requires_status") { unknown.assertResumeAllowed() }
    }
    @Test fun DayEightRequestExpiryIsDistinctFromReceiptExpiryAndCompletion() {
        val intent=record();val receipt=GuestDeletionReceipt.parse(response(intent,expired=true),intent)
        assertEquals("Request expired",receipt.label);assertFalse(receipt.completed)
        assertTrue(receipt.expiresAt>receipt.requestExpiresAt)
        val saved=intent.copy(receipt=receipt);saved.assertResumeAllowed()
        failed("deletion_not_completed") { saved.assertRestartAllowed() }
        failed("deletion_cannot_resume") { saved.copy(statusUnavailable=true).assertResumeAllowed() }
        val restored=GuestDeletionRecord.restore(saved.wire(),origin,null,null)
        val restoredReceipt=requireNotNull(restored.receipt)
        assertTrue(restoredReceipt.requestExpired);assertEquals(receipt.requestExpiresAt,restoredReceipt.requestExpiresAt)
    }
    @Test fun completedProofRequiresExactServerStatusAndCleanupTimestamp() {
        val intent=record();val pending=response(intent)
        failed("deletion_receipt_invalid") { GuestDeletionReceipt.parse(pending+mapOf("deletion_completed" to true),intent) }
        val complete=response(intent,"completed")
        val row=NativeProtocol.obj(complete["privacy_request"])
        failed("deletion_receipt_invalid") { GuestDeletionReceipt.parse(complete+mapOf("privacy_request" to row+mapOf("completed_at" to null)),intent) }
        failed("deletion_receipt_invalid") { GuestDeletionReceipt.parse(complete+mapOf("request_expired" to true),intent) }
        val saved=intent.copy(receipt=GuestDeletionReceipt.parse(complete,intent));saved.assertRestartAllowed()
        failed("deletion_cannot_resume") { saved.assertResumeAllowed() }
        assertEquals("Account deleted",saved.receipt!!.label)
    }
    @Test fun pollingCannotRenewExpirySwitchRequestOrRegressConfirmedCompletion() {
        val intent=record();val saved=intent.copy(receipt=GuestDeletionReceipt.parse(response(intent),intent))
        val valid=response(intent)
        failed("deletion_receipt_scope_changed") { GuestDeletionReceipt.parse(valid+mapOf("deletion_status" to mapOf("expires_at" to date(created+31L*86400000))),saved) }
        failed("deletion_receipt_scope_changed") { GuestDeletionReceipt.parse(valid+mapOf("request_expires_at" to date(created+8L*86400000)),saved) }
        val row=NativeProtocol.obj(valid["privacy_request"])
        failed("deletion_receipt_scope_changed") { GuestDeletionReceipt.parse(valid+mapOf("privacy_request" to row+mapOf("id" to other)),saved) }
        val completed=intent.copy(receipt=GuestDeletionReceipt.parse(response(intent,"completed"),intent))
        failed("deletion_receipt_scope_changed") { GuestDeletionReceipt.parse(valid,completed) }
    }
    @Test fun ResumeSetupCannotUpgradeFaceOrBootstrapAnotherGuest() {
        val intent=record();val me=mapOf("user_id" to account,"auth_method" to "anonymous","authenticated" to false)
        intent.assertResumedAccount(me)
        failed("deletion_account_changed") { intent.assertResumedAccount(me+mapOf("user_id" to other)) }
        failed("deletion_account_changed") { intent.assertResumedAccount(me+mapOf("auth_method" to "registered_face","authenticated" to true)) }
        failed("deletion_account_changed") { intent.assertResumedAccount(me+mapOf("authenticated" to true)) }
    }
    @Test fun requestIdentityRejectsTokenBodyAccountOriginAndKeyChangesBeforeDelayedReplies() {
        val intent=record();intent.assertSameIntent(intent.copy(statusUnavailable=true))
        listOf(intent.copy(statusToken=record().statusToken),intent.copy(operationKey=record().operationKey),intent.copy(account=other),
            intent.copy(origin="https://example.com"),intent.copy(reason="different request")).forEach { changed ->
            failed("deletion_scope_changed") { intent.assertSameIntent(changed) }
        }
        failed("deletion_scope_changed") { intent.assertSameIntent(null) }
        val fence=SessionFence();val before=fence.switch(account);fence.switch(null)
        failed("session_changed") { fence.assert(before) }
    }
    @Test fun logoutBetweenPersistenceStatusRefreshOrResumeCannotThawFrozenCredentials() {
        for(boundary in listOf("persisted request","status404 retry","status acknowledgement","refresh response")) {
            val intent=record();val fence=SessionFence()
            val before=fence.switch(if(boundary in listOf("persisted request","refresh response"))account else null)
            val sameRecord=intent.copy(statusUnavailable=boundary=="status404 retry")
            val frozenBody=NativeProtocol.canonical(intent.requestBody())
            val thawed=AtomicBoolean(false)
            // Logout may retain the same record and even the same account; its epoch still cancels the old attempt.
            fence.switch(before.accountId)
            failed("session_changed") {
                withGuestDeletionPhase(fence,before,intent,{sameRecord}) {
                    thawed.set(true);fence.switch(account)
                }
            }
            assertFalse("Cancelled $boundary was allowed to reinstate credentials",thawed.get())
            assertEquals(frozenBody,NativeProtocol.canonical(sameRecord.requestBody()))
        }
    }
    @Test fun phaseGuardChecksCurrentIntentInsideTheTransitionAndReturnsOnlyItsOwnedScope() {
        val intent=record();val fence=SessionFence();val before=fence.switch(null)
        val changed=intent.copy(operationKey=record().operationKey)
        failed("deletion_scope_changed") {
            withGuestDeletionPhase(fence,before,intent,{changed}) { error("Changed intent reached installation") }
        }
        val installed=withGuestDeletionPhase(fence,before,intent,{intent}) { fence.switch(account) }
        fence.assert(installed)
        failed("session_changed") { withGuestDeletionPhase(fence,before,intent,{intent}) { error("Consumed epoch reached installation") } }
        fence.switch(null)
        failed("session_changed") { withGuestDeletionPhase(fence,installed,intent,{intent}) { error("Later logout epoch was adopted") } }
    }
    @Test fun logoutCannotInterleaveInsideTheGuardedCredentialAndEpochTransition() {
        val intent=record();val fence=SessionFence();val before=fence.switch(null)
        val entered=CountDownLatch(1);val release=CountDownLatch(1);val attempted=CountDownLatch(1)
        val installed=AtomicReference<SessionScope>();val failure=AtomicReference<Throwable>();val loggedOut=AtomicBoolean(false)
        val worker=Thread({
            try { withGuestDeletionPhase(fence,before,intent,{intent}) {
                entered.countDown();check(release.await(5,TimeUnit.SECONDS));installed.set(fence.switch(account))
            } } catch(problem: Throwable) { failure.set(problem) }
        },"GuestDeletionPhaseTest")
        val logout=Thread({ attempted.countDown();fence.switch(null);loggedOut.set(true) },"GuestDeletionLogoutTest")
        try {
            worker.start();assertTrue(entered.await(5,TimeUnit.SECONDS));logout.start();assertTrue(attempted.await(5,TimeUnit.SECONDS))
            val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(2)
            while(logout.state!=Thread.State.BLOCKED && !loggedOut.get() && System.nanoTime()<deadline)Thread.yield()
            assertEquals("Logout must share the phase monitor",Thread.State.BLOCKED,logout.state)
            assertFalse(loggedOut.get());release.countDown();worker.join(5000);logout.join(5000)
            failure.get()?.let { throw AssertionError("Phase transition failed",it) }
            assertTrue(loggedOut.get())
            val owned=requireNotNull(installed.get())
            failed("session_changed") { withGuestDeletionPhase(fence,owned,intent,{intent}) { error("Cancelled installed credentials were dispatched") } }
        } finally { release.countDown();worker.join(5000);if(logout.state!=Thread.State.NEW)logout.join(5000) }
    }
    @Test fun failedCompletionWriteCannotPublishCompletionOrCleanThePriorGuestState() {
        val intent=record();val prior=intent.copy(receipt=GuestDeletionReceipt.parse(response(intent),intent))
        val completed=prior.copy(receipt=GuestDeletionReceipt.parse(response(intent,"completed"),prior))
        val credentials=mapOf("account_id" to account,"auth_method" to "anonymous","access_token" to "encrypted-test-token")
        val foreignDevice=mapOf("account" to other,"alias" to "foreign-hardware-key","handle" to "opaque-test-handle","device" to other)
        var durable: WireObject=mapOf("guest_deletion" to prior.wire(),"credentials" to credentials,"device" to foreignDevice,
            "private_photo_refs" to listOf(request))
        var visible=prior;var cleanupRan=false
        val candidate=completed.acceptedStorage(durable)
        assertNull(candidate["credentials"]);assertNull(candidate["private_photo_refs"]);assertEquals(foreignDevice,candidate["device"])
        val original=NativeProtocol.canonical(durable)
        failed("deletion_storage_unavailable") {
            persistGuestDeletionState(candidate,{ throw IOException("Synthetic durable-write failure") }) { committed ->
                cleanupRan=true;durable=committed;visible=completed
            }
        }
        assertFalse(cleanupRan);assertFalse(visible.receipt!!.completed);assertEquals(original,NativeProtocol.canonical(durable))
        val restored=GuestDeletionRecord.restore(durable["guest_deletion"],origin,account,"anonymous")
        failed("deletion_not_completed") { restored.assertRestartAllowed() }
        assertEquals(credentials,durable["credentials"]);assertEquals(listOf(request),durable["private_photo_refs"])
        persistGuestDeletionState(candidate,{ staged -> durable=staged }) { committed ->
            assertEquals(NativeProtocol.canonical(committed),NativeProtocol.canonical(durable))
            cleanupRan=true;visible=completed
        }
        assertTrue(cleanupRan);assertTrue(visible.receipt!!.completed)
        assertNull(durable["credentials"]);assertEquals(foreignDevice,durable["device"])
        GuestDeletionRecord.restore(durable["guest_deletion"],origin,null,null).assertRestartAllowed()
    }
    @Test fun failedRestartWriteKeepsTheCompletedReceiptAndNeverReleasesAutomaticBootstrap() {
        val intent=record();val complete=intent.copy(receipt=GuestDeletionReceipt.parse(response(intent,"completed"),intent))
        val foreignDevice=mapOf("account" to other,"alias" to "foreign-hardware-key","handle" to "opaque-test-handle","device" to other)
        var durable: WireObject=complete.acceptedStorage(mapOf("device" to foreignDevice))
        var visible: GuestDeletionRecord?=complete;var bootstrapAllowed=false
        failed("deletion_storage_unavailable") {
            persistGuestDeletionState(complete.restartStorage(durable),{ throw IOException("Synthetic restart write failure") }) {
                visible=null;bootstrapAllowed=true
            }
        }
        assertSame(complete,visible);assertFalse(bootstrapAllowed)
        val restored=GuestDeletionRecord.restore(durable["guest_deletion"],origin,null,null)
        assertTrue(restored.receipt!!.completed);assertEquals(complete.operationKey,restored.operationKey)
        persistGuestDeletionState(complete.restartStorage(durable),{ staged -> durable=staged }) {
            assertNull(durable["guest_deletion"]);assertNull(durable["credentials"])
            visible=null;bootstrapAllowed=true
        }
        assertNull(visible);assertTrue(bootstrapAllowed);assertEquals(mapOf("device" to foreignDevice),durable)
    }
    @Test fun pendingReceiptStoragePreservesOnlyOriginalCredentialsAndUnrelatedVerifiedDevice() {
        val intent=record();val pending=intent.copy(receipt=GuestDeletionReceipt.parse(response(intent),intent))
        val credentials=mapOf("account_id" to account,"auth_method" to "anonymous","access_token" to "encrypted-test-token")
        val ownDevice=mapOf("account" to account,"alias" to "guest-key")
        val staged=pending.acceptedStorage(mapOf("credentials" to credentials,"device" to ownDevice,"review" to "private-test-draft"))
        assertEquals(setOf("guest_deletion","credentials"),staged.keys)
        assertEquals(credentials,staged["credentials"]);assertNull(staged["device"]);assertNull(staged["review"])
        failed("deletion_account_changed") { pending.acceptedStorage(mapOf("credentials" to credentials+mapOf("account_id" to other))) }
        failed("deletion_account_changed") { pending.acceptedStorage(mapOf("credentials" to credentials+mapOf("auth_method" to "registered_face"))) }
        var published=false
        failed("deletion_storage_unavailable") {
            persistGuestDeletionState(staged,{ throw IOException("Initial request persistence fails") }) { published=true }
        }
        assertFalse(published)
    }
}
