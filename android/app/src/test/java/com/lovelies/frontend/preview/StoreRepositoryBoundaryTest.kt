package com.lovelies.frontend.preview

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/** Execute real repository/deletion callers with same-subject synthetic local/JSON boundaries.
 * These tests do not assert Android Keystore, live authentication or provider acceptance. */
class StoreRepositoryBoundaryTest {
    private val origin="https://ltqfplqevxztlswlzexn.supabase.co/functions/v1/lovelies-api"
    private val account="00000000-0000-4000-8000-000000000001"
    private val product="lovelies.pro.monthly"
    private val token="same-subject-repository-purchase-token-0001"
    private val key="android-store-repository-operation-0001"
    private val session=LiveCredentials(account,"synthetic-local-session","synthetic-refresh","registered_face",Long.MAX_VALUE/2,
        mapOf("account_id" to account,"auth_method" to "registered_face"))
    private fun journal()=StorePurchaseJournal.create(origin,account,product,token,key)
    private fun result(value: StorePurchaseJournal): WireObject=mapOf("active" to true,"billing_environment" to "production",
        "expires_at" to "2026-11-29T12:00:00.000Z","financial_eligible" to true,"original_transaction_id" to value.credentialSha256,
        "product_id" to value.product,"provider" to "google_play","stale" to false,"transaction_id" to "same-subject-order-1")
    private fun receipt(value: StorePurchaseJournal): WireObject=mapOf("protocol" to "lovelies-store-operation-receipt-v1","actor_id" to account,
        "operation_key" to value.key,"status" to "committed","action" to "store.google","source" to "store","payload_hash" to value.inputHash("digest-v1"),
        "input_scheme" to "digest-v1","credential_sha256" to value.credentialSha256,"receipt_scope" to "historical","result" to result(value))
    private fun unknown(value: StorePurchaseJournal): WireObject=mapOf("protocol" to "lovelies-store-operation-receipt-v1","actor_id" to account,"operation_key" to value.key,"status" to "unknown")
    private class Disk(initial: WireObject=emptyMap()): RepositoryVault {
        @Volatile private var disk=copy(initial)
        @Volatile var beforeWrite: ((WireObject)->Unit)?=null
        @Volatile var afterWrite: ((WireObject)->Unit)?=null
        val writes=AtomicInteger()
        override fun load(): WireObject=copy(disk)
        override fun save(value: WireObject) {
            val next=copy(value);beforeWrite?.invoke(next);disk=next;writes.incrementAndGet();afterWrite?.invoke(next)
        }
        companion object {
            private fun nested(value: Any?): Any?=when(value) { is Map<*,*>->value.entries.associate { (it.key as String) to nested(it.value) };is List<*>->value.map(::nested);else->value }
            fun copy(value: WireObject): WireObject=NativeProtocol.obj(nested(value))
        }
    }
    private fun stored(disk: Disk)=StorePurchasePersistence.retained(
        disk.load()["google_store_operation"]?.let { StorePurchaseJournal.restore(it,origin) },
        disk.load()["google_store_write_uncertainty"]?.let { StorePurchaseJournal.restore(it,origin) })!!
    private fun failure(block: suspend ()->Unit): Throwable=try { runBlocking { block() };throw AssertionError("Expected a retained operation") } catch(problem: Throwable) { if(problem is AssertionError)throw problem;problem }
    private fun await(latch: CountDownLatch) { assertTrue("Bounded boundary wait",latch.await(4,TimeUnit.SECONDS)) }

    @Test fun actualStoreMarkerAndUnrelatedRememberShareOneSnapshotWritePublicationBoundary() {
        val disk=Disk();val entered=CountDownLatch(1);val release=CountDownLatch(1);val rememberAttempt=CountDownLatch(1);val rememberDone=CountDownLatch(1)
        val intercepted=AtomicBoolean();val dispatches=AtomicInteger();val executor=Executors.newFixedThreadPool(2)
        disk.beforeWrite={ value->if(value["google_store_operation"]!=null && intercepted.compareAndSet(false,true)) { entered.countDown();await(release) } }
        val repo=CloudflareRepository(origin,RepositoryBoundary(disk,{ path,scope,bearer,method,body,_ ->
            assertEquals(account,scope.accountId);assertEquals(session.token,bearer);assertEquals("POST",method)
            when(path) {
                "/subscriptions/google/transactions"->{ dispatches.incrementAndGet();val saved=stored(disk);assertEquals(saved.key,body!!["operation_key"]);result(saved) }
                "/me/store-operations"->{val saved=stored(disk);assertEquals(mapOf("operation_key" to saved.key),body);receipt(saved)}
                else->error("Unexpected JSON boundary")
            }
        },initialSession=session))
        try {
            val purchase=executor.submit { runBlocking { repo.verifyGooglePurchase(product,token) } }
            await(entered)
            val edit=executor.submit { rememberAttempt.countDown();repo.remember("support_draft",mapOf("account" to account,"subject" to "Keep this draft"));rememberDone.countDown() }
            await(rememberAttempt)
            assertFalse("Unrelated save must wait until marker publication",rememberDone.await(200,TimeUnit.MILLISECONDS))
            release.countDown();purchase.get(5,TimeUnit.SECONDS);edit.get(5,TimeUnit.SECONDS)
            assertEquals(1,dispatches.get());assertNotNull(stored(disk).receipt)
            assertEquals("Keep this draft",NativeProtocol.obj(disk.load()["support_draft"])["subject"])
            assertEquals(repo.saved("google_store_operation"),disk.load()["google_store_operation"])
        } finally { release.countDown();executor.shutdownNow();assertTrue(executor.awaitTermination(4,TimeUnit.SECONDS)) }
    }
    @Test fun actualLostMarkerWriteAcknowledgementSurvivesCompetingEditAndRestartsWithoutDispatch() {
        val disk=Disk();val entered=CountDownLatch(1);val release=CountDownLatch(1);val rememberAttempt=CountDownLatch(1);val rememberDone=CountDownLatch(1)
        val intercepted=AtomicBoolean();val dispatches=AtomicInteger();val executor=Executors.newFixedThreadPool(2)
        disk.afterWrite={ value->if(value["google_store_operation"]!=null && intercepted.compareAndSet(false,true)) { entered.countDown();await(release);throw IOException("Synthetic lost local acknowledgement") } }
        val json: RepositoryJsonBoundary={path,scope,bearer,method,body,_ ->
            assertEquals(account,scope.accountId);assertEquals(session.token,bearer);assertEquals("POST",method)
            if(path=="/subscriptions/google/transactions") { dispatches.incrementAndGet();error("A failed marker write must not dispatch") }
            assertEquals("/me/store-operations",path);val saved=stored(disk);assertEquals(mapOf("operation_key" to saved.key),body);unknown(saved)
        }
        val repo=CloudflareRepository(origin,RepositoryBoundary(disk,json,initialSession=session))
        try {
            val purchase=executor.submit<Throwable> { failure { repo.verifyGooglePurchase(product,token) } }
            await(entered)
            val edit=executor.submit { rememberAttempt.countDown();repo.remember("unrelated_draft","kept");rememberDone.countDown() }
            await(rememberAttempt);assertFalse(rememberDone.await(200,TimeUnit.MILLISECONDS));release.countDown()
            assertEquals("store_operation_storage_requires_status",(purchase.get(5,TimeUnit.SECONDS) as LiveFailure).code);edit.get(5,TimeUnit.SECONDS)
            val original=stored(disk);assertNull(original.receipt);assertNotNull(disk.load()["google_store_write_uncertainty"]);assertEquals("kept",disk.load()["unrelated_draft"])
            disk.afterWrite=null
            // The same-subject session is synthetic; actual journal restoration/recovery methods run unchanged.
            val restarted=CloudflareRepository(origin,RepositoryBoundary(disk,json,initialStorage=disk.load(),initialSession=session))
            assertEquals("store_operation_requires_status",(failure { restarted.recoverGooglePurchase() } as LiveFailure).code)
            assertEquals(original.key,stored(disk).key);assertEquals(0,dispatches.get())
        } finally { release.countDown();executor.shutdownNow();assertTrue(executor.awaitTermination(4,TimeUnit.SECONDS)) }
    }

    private val created=Instant.parse("2026-10-29T00:00:00Z").toEpochMilli()
    private fun deletionResponse(intent: GuestDeletionRecord,complete: Boolean): WireObject {
        val finished=created+2000L
        return mapOf("protocol" to "lovelies-account-deletion-v1","source" to "privacy","operation_key" to intent.operationKey,
            "privacy_request" to mapOf("id" to "00000000-0000-4000-8000-000000000011","request_type" to "delete","status" to if(complete)"completed" else "pending_approval",
                "created_at" to Instant.ofEpochMilli(created).toString(),"reviewed_at" to if(complete)Instant.ofEpochMilli(created+1000).toString() else null,
                "completed_at" to if(complete)Instant.ofEpochMilli(finished).toString() else null,"failure_code" to null),
            "deletion_status" to mapOf("expires_at" to Instant.ofEpochMilli((if(complete)finished else created)+30L*86400000).toString()),
            "request_expires_at" to Instant.ofEpochMilli(created+30L*86400000).toString(),"request_expired" to false,"deletion_completed" to complete)
    }
    private inner class DeletionFixture {
        val original=journal()
        val legacy=PendingIntent(account,"store","store.google",key,original.request,"/subscriptions/google/transactions","POST")
        val evidence: WireObject=mapOf("google_store_operation" to original.wire(),"google_store_write_uncertainty" to original.observed("lookup_unknown").wire(),
            "google_store_history" to listOf(original.wire()),"pending" to legacy.wire())
        val disk=Disk(evidence+mapOf("private_draft" to "Removed only by completed cleanup"))
        var intent: GuestDeletionRecord?=null
        val anonymousBoundaryCalls=AtomicInteger()
        val json: RepositoryJsonBoundary={path,scope,bearer,method,body,_ ->
            assertEquals("POST",method)
            when(path) {
                "/privacy/account-deletion"->{ assertEquals(account,scope.accountId);assertEquals(session.token,bearer)
                    val record=GuestDeletionRecord(origin,account,NativeProtocol.text(body!!["operation_key"]),NativeProtocol.text(body["status_token"]))
                    intent=record;deletionResponse(record,false)
                }
                "/privacy/account-deletion/status"->{ assertNull(bearer);val record=intent!!;assertEquals(mapOf("status_token" to record.statusToken),body);deletionResponse(record,true) }
                "/auth/anonymous"->{ assertNull(bearer);anonymousBoundaryCalls.incrementAndGet();throw LiveFailure("synthetic_stop_before_new_account") }
                else->error("Unexpected JSON boundary")
            }
        }
        val repository=CloudflareRepository(origin,RepositoryBoundary(disk,json,initialStorage=disk.load(),initialSession=session,initialPending=legacy))
        fun assertEvidence(value: WireObject=disk.load()) { evidence.forEach { (key,raw)->assertEquals("Retain $key exactly",raw,value[key]) } }
        fun restarted()=CloudflareRepository(origin,RepositoryBoundary(disk,json))
    }
    @Test fun actualRegisteredDeletionCompletionBootstrapAndStartAgainRetainStoreAndCompletedReceipt()=runBlocking {
        val fixture=DeletionFixture();val repo=fixture.repository
        repo.requestAccountDeletion();val completed=repo.checkAccountDeletion()
        assertTrue(completed.receipt!!.completed);fixture.assertEvidence();assertNull(repo.credentials);assertNull(repo.currentScope().accountId)
        assertEquals(fixture.legacy,repo.pending);assertNull(fixture.disk.load()["private_draft"])
        val restored=fixture.restarted();assertTrue(restored.bootstrap().isEmpty());assertTrue(restored.accountDeletion!!.receipt!!.completed)
        assertEquals(fixture.legacy,restored.pending);fixture.assertEvidence()
        restored.restartAfterAccountDeletion();assertNull(restored.accountDeletion);assertEquals(fixture.legacy,restored.pending);fixture.assertEvidence()
        val history=NativeProtocol.rows(fixture.disk.load()["completed_registered_deletions"])
        assertEquals(1,history.size);assertEquals(completed.wire(),history.single());assertNull(fixture.disk.load()["registered_deletion"])
        val next=fixture.restarted()
        assertEquals("synthetic_stop_before_new_account",(failure { next.bootstrap() } as LiveFailure).code)
        assertEquals(1,fixture.anonymousBoundaryCalls.get());assertNull(next.credentials);fixture.assertEvidence()
        assertEquals(history,fixture.disk.load()["completed_registered_deletions"])
    }
    @Test fun actualLostCompletedReceiptWriteAcknowledgementCannotBeErasedByUnrelatedEdit()=runBlocking {
        val fixture=DeletionFixture();fixture.repository.requestAccountDeletion();val fired=AtomicBoolean()
        fixture.disk.afterWrite={ value->val record=value["registered_deletion"]?.let { GuestDeletionRecord.restore(it,origin,null,null) }
            if(record?.receipt?.completed==true && fired.compareAndSet(false,true))throw IOException("Synthetic lost receipt acknowledgement") }
        assertEquals("deletion_storage_unavailable",(failure { fixture.repository.checkAccountDeletion() } as LiveFailure).code)
        fixture.repository.remember("unrelated_draft","kept");fixture.assertEvidence()
        val strongest=StoreRecoveryRetention.registeredDeletion(fixture.disk.load(),origin)!!
        assertTrue(strongest.receipt!!.completed);assertNotNull(fixture.disk.load()["registered_deletion_write_uncertainty"])
        fixture.disk.afterWrite=null
        val restored=fixture.restarted();restored.bootstrap();assertTrue(restored.accountDeletion!!.receipt!!.completed)
        restored.checkAccountDeletion();fixture.assertEvidence();assertNull(fixture.disk.load()["registered_deletion_write_uncertainty"])
        assertTrue(GuestDeletionRecord.restore(fixture.disk.load()["registered_deletion"],origin,null,null).receipt!!.completed)
    }
    @Test fun actualLostStartAgainWriteAcknowledgementRetainsCompletedProofAndRetriesIdempotently()=runBlocking {
        val fixture=DeletionFixture();fixture.repository.requestAccountDeletion();val completed=fixture.repository.checkAccountDeletion();val fired=AtomicBoolean()
        fixture.disk.afterWrite={ value->if(value["completed_registered_deletions"]!=null && fired.compareAndSet(false,true))throw IOException("Synthetic lost archive acknowledgement") }
        assertTrue(failure { fixture.repository.restartAfterAccountDeletion() } is IOException)
        fixture.repository.remember("unrelated_draft","kept");fixture.assertEvidence()
        assertTrue(StoreRecoveryRetention.registeredDeletion(fixture.disk.load(),origin)!!.receipt!!.completed)
        fixture.disk.afterWrite=null
        val restored=fixture.restarted();restored.bootstrap();restored.restartAfterAccountDeletion();fixture.assertEvidence()
        assertEquals(listOf(completed.wire()),NativeProtocol.rows(fixture.disk.load()["completed_registered_deletions"]))
        assertNull(restored.credentials);assertEquals(fixture.legacy,restored.pending)
    }

    private fun storeVariants(): List<PendingIntent> = listOf(
        PendingIntent(account,"store","store.google",key,journal().request,"/subscriptions/google/transactions","POST"),
        PendingIntent(account,"store","future.unknown",key,mapOf("opaque" to "Keep original source-only evidence"),"/future/unknown","POST"),
        PendingIntent(account,"personal","store.unknown",key,mapOf("opaque" to "Keep original action-only evidence"),"/future/unknown","POST"),
        PendingIntent(account,"personal","future.unknown",key,mapOf("opaque" to "Keep original path-only evidence"),"/subscriptions/future/unknown","POST"),
        PendingIntent(account,"store","sharing.preview",key,mapOf("opaque" to "Mixed source must never gain sharing authority"),"/future/unknown","POST")
    )
    private fun completedGuest(legacy: PendingIntent): Pair<GuestDeletionRecord,Disk> {
        val intent=GuestDeletionRecord.create(origin,account)
        val completed=intent.copy(receipt=GuestDeletionReceipt.parse(deletionResponse(intent,true),intent))
        return completed to Disk(mapOf("guest_deletion" to completed.wire(),"pending" to legacy.wire(),
            "google_store_operation" to journal().wire(),"google_store_history" to listOf(journal().wire())))
    }
    private val noJson: RepositoryJsonBoundary={_,_,_,_,_,_->error("No provider or JSON boundary is allowed")}
    @Test fun actualGuestStartAgainThenLogoutBeforeBootstrapRetainsTheOriginalLegacySlot()=runBlocking {
        for(revoke in listOf(false,true)) {
            val legacy=storeVariants().first();val (completed,disk)=completedGuest(legacy)
            val original=disk.load().filterKeys { it!="guest_deletion" }
            val repo=CloudflareRepository(origin,RepositoryBoundary(disk,noJson))
            repo.bootstrap();assertEquals(completed,repo.guestDeletion);assertEquals(legacy,repo.pending)
            repo.restartAfterGuestDeletion();assertNull(repo.guestDeletion);assertEquals(legacy,repo.pending)
            repo.logout(revokeIdentity=revoke);assertNull(repo.credentials);assertEquals(legacy,repo.pending)
            original.forEach { (field,value)->assertEquals("Retain $field across restart/logout",value,disk.load()[field]) }
            val restarted=CloudflareRepository(origin,RepositoryBoundary(disk,{path,_,_,_,_,_->
                assertEquals("/auth/anonymous",path);throw LiveFailure("synthetic_stop_before_new_account")
            }))
            assertEquals("synthetic_stop_before_new_account",(failure { restarted.bootstrap() } as LiveFailure).code)
            assertEquals(legacy,restarted.pending);assertEquals(legacy.wire(),disk.load()["pending"])
        }
    }
    @Test fun actualLostGuestStartAgainWriteAcknowledgementThenLogoutKeepsTheOriginalEvidence()=runBlocking {
        val legacy=storeVariants().first();val (_,disk)=completedGuest(legacy)
        val repo=CloudflareRepository(origin,RepositoryBoundary(disk,noJson));repo.bootstrap();val fired=AtomicBoolean()
        disk.afterWrite={value->if(value["guest_deletion"]==null && fired.compareAndSet(false,true))throw IOException("Synthetic lost restart acknowledgement")}
        assertEquals("deletion_storage_unavailable",(failure { repo.restartAfterGuestDeletion() } as LiveFailure).code)
        assertEquals(legacy,repo.pending);assertNotNull(repo.guestDeletion)
        repo.logout(revokeIdentity=true);assertEquals(legacy.wire(),disk.load()["pending"])
        val restarted=CloudflareRepository(origin,RepositoryBoundary(disk,noJson));restarted.bootstrap()
        assertTrue(restarted.guestDeletion!!.receipt!!.completed);assertEquals(legacy,restarted.pending)
    }
    @Test fun actualLogoutRetainsEveryStoreSafetyPredicateWithOrWithoutRestoredMemory()=runBlocking {
        for(intent in storeVariants())for(revoke in listOf(false,true))for(restored in listOf(false,true)) {
            val evidence=mapOf("pending" to (intent.wire()+mapOf("future_evidence" to "Do not normalize unknown evidence")),"google_store_history" to listOf(journal().wire()))
            val disk=Disk(evidence)
            val repo=CloudflareRepository(origin,RepositoryBoundary(disk,noJson,initialStorage=evidence))
            // Memory may still be null before bootstrap, or it may have been restored by an actual prior transition.
            if(restored) {
                val completed=GuestDeletionRecord.create(origin,account).let { it.copy(receipt=GuestDeletionReceipt.parse(deletionResponse(it,true),it)) }
                disk.save(evidence+mapOf("guest_deletion" to completed.wire()));repo.bootstrap();repo.restartAfterGuestDeletion()
            }
            repo.logout(revokeIdentity=revoke)
            assertEquals(intent,repo.pending);evidence.forEach { (field,value)->assertEquals(value,disk.load()[field]) }
            assertNull(repo.credentials);assertNull(repo.currentScope().accountId)
        }
    }
    @Test fun actualBootstrapAuthenticationFailureAndLogoutRetainMixedAndUnknownStoreEvidence()=runBlocking {
        for(intent in storeVariants())for(status in listOf(401,403)) {
            val raw=intent.wire()+mapOf("future_evidence" to "Exact original bytes remain held")
            val disk=Disk(mapOf("pending" to raw,"google_store_history" to listOf(journal().wire())))
            val reads=AtomicInteger();val anonymous=AtomicInteger()
            val repo=CloudflareRepository(origin,RepositoryBoundary(disk,{path,scope,bearer,_,_,_->
                when(path) {
                    "/me"->{reads.incrementAndGet();assertEquals(account,scope.accountId);assertEquals(session.token,bearer);throw LiveFailure("synthetic_session_expired",status)}
                    "/auth/anonymous"->{anonymous.incrementAndGet();assertNull(scope.accountId);assertNull(bearer);throw LiveFailure("synthetic_stop_before_new_account")}
                    else->error("No provider or store boundary is allowed")
                }
            },initialSession=session))
            assertEquals("synthetic_stop_before_new_account",(failure { repo.bootstrap() } as LiveFailure).code)
            assertEquals(1,reads.get());assertEquals(1,anonymous.get());assertEquals(intent,repo.pending);assertNull(repo.credentials)
            assertEquals(raw,disk.load()["pending"]);repo.logout();assertEquals(raw,disk.load()["pending"])
            assertEquals(intent,repo.pending);assertNull(repo.currentScope().accountId)
        }
    }
    @Test fun actualMixedStoreEvidenceCannotBeAbandonedReconciledOrOpenAnotherPurchase()=runBlocking {
        for(intent in storeVariants().drop(1)) {
            val disk=Disk(mapOf("pending" to intent.wire()))
            val repo=CloudflareRepository(origin,RepositoryBoundary(disk,noJson,initialStorage=disk.load(),initialSession=session,initialPending=intent))
            repo.abandonReadReview();assertEquals(intent,repo.pending)
            assertEquals("store_operation_scope_changed",(failure { repo.reconcile() } as LiveFailure).code)
            assertEquals("store_operation_scope_changed",(failure { repo.recoverGooglePurchase() } as LiveFailure).code)
            assertEquals("store_operation_scope_changed",(failure { repo.verifyGooglePurchase(product,token) } as LiveFailure).code)
            assertEquals("store_operation_scope_changed",(failure { repo.resumePending() } as LiveFailure).code)
            assertEquals(intent.wire(),disk.load()["pending"])
        }
    }
    @Test fun actualLostLogoutWriteAcknowledgementCannotEraseUnrestoredStoreEvidence()=runBlocking {
        val intent=storeVariants()[3];val raw=intent.wire()+mapOf("future_evidence" to "Preserve opaque evidence")
        val disk=Disk(mapOf("pending" to raw));val fired=AtomicBoolean()
        val repo=CloudflareRepository(origin,RepositoryBoundary(disk,noJson,initialStorage=disk.load()))
        disk.afterWrite={if(fired.compareAndSet(false,true))throw IOException("Synthetic lost logout acknowledgement")}
        assertTrue(failure { repo.logout() } is IOException);assertEquals(raw,disk.load()["pending"])
        repo.remember("unrelated_draft","kept");assertEquals(raw,disk.load()["pending"])
        repo.logout(revokeIdentity=true);assertEquals(intent,repo.pending);assertEquals(raw,disk.load()["pending"])
    }
}
