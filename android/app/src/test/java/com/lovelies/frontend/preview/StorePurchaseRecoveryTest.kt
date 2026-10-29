package com.lovelies.frontend.preview

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

/** Same-subject synthetic receipts only. No Play/provider or cross-account backend simulation. */
class StorePurchaseRecoveryTest {
    private val origin="https://ltqfplqevxztlswlzexn.supabase.co/functions/v1/lovelies-api"
    private val account="00000000-0000-4000-8000-000000000001"
    private val product="lovelies.pro.monthly"
    private val token="same-subject-play-purchase-token-0001"
    private val key="android-store-operation-0001"
    private fun original()=StorePurchaseJournal.create(origin,account,product,token,key)
    private fun result(journal: StorePurchaseJournal=original()): WireObject=mapOf("active" to true,"billing_environment" to "production",
        "expires_at" to "2026-11-29T12:00:00.000Z","financial_eligible" to true,"original_transaction_id" to journal.credentialSha256,
        "product_id" to journal.product,"provider" to "google_play","stale" to false,"transaction_id" to "same-subject-order-1")
    private fun receipt(journal: StorePurchaseJournal=original(),scheme: String="digest-v1",value: WireObject=result(journal)): WireObject=mapOf(
        "protocol" to "lovelies-store-operation-receipt-v1","actor_id" to journal.account,"operation_key" to journal.key,"status" to "committed",
        "action" to "store.google","source" to "store","payload_hash" to journal.inputHash(scheme),"input_scheme" to scheme,
        "credential_sha256" to journal.credentialSha256,"receipt_scope" to "historical","result" to value)
    private fun unknown(journal: StorePurchaseJournal=original()): WireObject=mapOf("protocol" to "lovelies-store-operation-receipt-v1",
        "actor_id" to journal.account,"operation_key" to journal.key,"status" to "unknown")
    private class Disk(var value: WireObject)
    private fun loaded(disk: Disk)=StorePurchaseJournal.restore(disk.value,origin)
    private fun failed(block: suspend ()->Unit): LiveFailure=try { runBlocking { block() };throw AssertionError("Expected a held store operation") } catch(problem: LiveFailure) { problem }

    @Test fun directSuccessRequiresSavedMarkerAndExactReceiptBeforeCompletion()=runBlocking {
        val journal=original();val disk=Disk(journal.wire());var dispatches=0;var lookups=0
        val coordinator=StorePurchaseRecovery({disk.value=it.wire()},{}, { payload ->
            dispatches++;assertEquals(journal.request,payload);assertEquals(key,loaded(disk).key);assertNull(loaded(disk).receipt);result()
        }, { payload -> lookups++;assertEquals(mapOf("operation_key" to key),payload);receipt() })
        assertEquals(result(),coordinator.run(journal,true));assertEquals(1,dispatches);assertEquals(1,lookups)
        assertEquals(receipt(),loaded(disk).receipt)
        // Already-committed replays remain read-only and avoid appending duplicate receipt evidence.
        val size=loaded(disk).observations.size
        assertEquals(result(),coordinator.run(loaded(disk),false));assertEquals(1,dispatches);assertEquals(2,lookups)
        assertEquals(size,loaded(disk).observations.size)
    }
    @Test fun bothServerInputSchemesRecoverOriginalKeyWithoutCredentialResubmission()=runBlocking {
        for(scheme in listOf("legacy-raw-v0","digest-v1")) {
            val journal=original();val disk=Disk(journal.wire());var dispatched=false
            val coordinator=StorePurchaseRecovery({disk.value=it.wire()},{},{dispatched=true;error("Must not dispatch recovered credentials")},{ payload->
                assertEquals(setOf("operation_key"),payload.keys);assertEquals(key,payload["operation_key"]);receipt(scheme=scheme)
            })
            assertEquals(result(),coordinator.run(journal,false));assertFalse(dispatched);assertNotNull(loaded(disk).receipt)
        }
    }
    @Test fun alteredReceiptBindingsAndResultsCannotRetireTheOriginal() {
        val invalids=listOf(
            receipt()+mapOf("actor_id" to "00000000-0000-4000-8000-000000000099"),
            receipt()+mapOf("operation_key" to "android-store-other-operation"),
            receipt()+mapOf("action" to "store.apple"),receipt()+mapOf("source" to "account"),
            receipt()+mapOf("payload_hash" to "0".repeat(64)),receipt()+mapOf("input_scheme" to "unvalidated"),
            receipt()+mapOf("credential_sha256" to "0".repeat(64)),receipt()+mapOf("receipt_scope" to "current_entitlement"),
            receipt(value=result()+mapOf("product_id" to "wrong-product")),
            receipt(value=result()+mapOf("original_transaction_id" to NativeProtocol.sha256("different-token".toByteArray()))),
            receipt(value=result()+mapOf("provider" to "apple_app_store")),
            receipt(value=result()+mapOf("extra" to true)),receipt(value=result()+mapOf("billing_environment" to "sandbox")),
            unknown()+mapOf("actor_id" to "00000000-0000-4000-8000-000000000099"),unknown()+mapOf("result" to result())
        )
        invalids.forEach { response->
            val journal=original();val disk=Disk(journal.wire());var dispatches=0
            val coordinator=StorePurchaseRecovery({disk.value=it.wire()},{},{dispatches++;result()},{response})
            assertEquals("store_operation_receipt_invalid",failed { coordinator.run(journal,false) }.code)
            assertEquals(0,dispatches);assertEquals(key,loaded(disk).key);assertEquals(token,loaded(disk).token);assertNull(loaded(disk).receipt)
        }
    }
    @Test fun malformedDirectSuccessIsRejectedBeforeAnyReceiptAdmission() {
        val journal=original();val disk=Disk(journal.wire());var lookups=0
        val coordinator=StorePurchaseRecovery({disk.value=it.wire()},{},{result()+mapOf("product_id" to "wrong-product")},{lookups++;receipt()})
        assertEquals("store_operation_receipt_invalid",failed { coordinator.run(journal,true) }.code)
        assertEquals(0,lookups);assertNull(loaded(disk).receipt);assertEquals("direct_rejected",loaded(disk).observations.last()["kind"])
        assertEquals(result(),runBlocking { coordinator.run(loaded(disk),false) });assertEquals(1,lookups)
    }
    @Test fun lostDirectReplyCanRecoverCommittedReceiptWithoutRepeatingAcknowledgement()=runBlocking {
        val journal=original();val disk=Disk(journal.wire());var acknowledgements=0
        val coordinator=StorePurchaseRecovery({disk.value=it.wire()},{},{acknowledgements++;throw LiveFailure("connection_unavailable",0,true)},{receipt()})
        assertEquals(result(),coordinator.run(journal,true));assertEquals(1,acknowledgements)
        val restarted=StorePurchaseRecovery({disk.value=it.wire()},{},{acknowledgements++;error("Unexpected redispatch")},{receipt()})
        assertEquals(result(),restarted.run(loaded(disk),false));assertEquals(1,acknowledgements)
    }
    @Test fun unknownAfterPossibleAcknowledgementNeverProvesNoncommitOrRedispatches() {
        val journal=original();val disk=Disk(journal.wire());var acknowledgements=0;var available=false
        val coordinator=StorePurchaseRecovery({disk.value=it.wire()},{},{acknowledgements++;throw LiveFailure("connection_unavailable",0,true)},{if(available)receipt() else unknown()})
        assertEquals("store_operation_requires_status",failed { coordinator.run(journal,true) }.code)
        assertEquals("store_operation_requires_status",failed { coordinator.run(loaded(disk),false) }.code)
        assertEquals(1,acknowledgements);assertNull(loaded(disk).receipt);assertEquals(key,loaded(disk).key)
        available=true
        assertEquals(result(),runBlocking { coordinator.run(loaded(disk),false) });assertEquals(1,acknowledgements)
    }
    @Test fun definitiveHttpErrorsAfterDispatchStillHoldOriginalAndRecoverReadOnly() {
        for(code in listOf(400,401,403,404,409,410,422,503)) {
            val journal=original();val disk=Disk(journal.wire());var dispatches=0;var current=false
            val coordinator=StorePurchaseRecovery({disk.value=it.wire()},{},{dispatches++;throw LiveFailure("store_receipt_retired",code,false)},{if(current)receipt() else throw LiveFailure("store_receipt_retired",code,false)})
            assertTrue(failed { coordinator.run(journal,true) }.ambiguous)
            assertEquals(key,loaded(disk).key);assertNull(loaded(disk).receipt);assertEquals(1,dispatches)
            current=true
            assertEquals(result(),runBlocking { coordinator.run(loaded(disk),false) });assertEquals(1,dispatches)
        }
    }
    @Test fun expiredSessionBeforeLookupDoesNotRemoveLegacyOrSavedIntent() {
        val journal=original();val disk=Disk(journal.wire());var lookups=0;var authenticated=false
        val coordinator=StorePurchaseRecovery({disk.value=it.wire()},{if(!authenticated)throw LiveFailure("authentication_required",401)},{error("No new dispatch")},{lookups++;receipt()})
        assertEquals(401,failed { coordinator.run(journal,false) }.status);assertEquals(0,lookups);assertEquals(journal.wire(),disk.value)
        authenticated=true;assertEquals(result(),runBlocking { coordinator.run(loaded(disk),false) });assertEquals(1,lookups)
    }
    @Test fun sessionChangeAfterReplyCannotPublishTheStaleReceipt() {
        val journal=original();val disk=Disk(journal.wire());var epoch=1;val captured=epoch
        val coordinator=StorePurchaseRecovery({disk.value=it.wire()},{if(epoch!=captured)throw LiveFailure("session_changed")},{result()},{epoch++;receipt()})
        assertEquals("session_changed",failed { coordinator.run(journal,true) }.code)
        assertNull(loaded(disk).receipt);assertEquals(key,loaded(disk).key)
        val recovered=StorePurchaseRecovery({disk.value=it.wire()},{},{error("No provider retry")},{receipt()})
        assertEquals(result(),runBlocking { recovered.run(loaded(disk),false) })
    }
    @Test fun ambiguousVaultSaveStopsNetworkProgressAndRestartRetainsExactMarker() {
        val journal=original();val disk=Disk(journal.wire());var dispatches=0;var lookups=0
        val coordinator=StorePurchaseRecovery({disk.value=it.wire();throw LiveFailure("secure_storage_unavailable")},{},{dispatches++;result()},{lookups++;receipt()})
        assertEquals("secure_storage_unavailable",failed { coordinator.run(journal,true) }.code)
        assertEquals(1,dispatches);assertEquals(0,lookups);assertEquals(key,loaded(disk).key);assertNull(loaded(disk).receipt)
        val restarted=StorePurchaseRecovery({disk.value=it.wire()},{},{dispatches++;error("No provider retry")},{lookups++;receipt()})
        assertEquals(result(),runBlocking { restarted.run(loaded(disk),false) });assertEquals(1,dispatches);assertEquals(1,lookups)
    }
    @Test fun legacyIntentAdoptionPreservesExactOriginalInputAndRejectsMismatches() {
        val journal=original();val pending=PendingIntent(account,"store","store.google",key,journal.request,"/subscriptions/google/transactions","POST")
        assertEquals(journal,StorePurchaseJournal.legacy(pending,origin,account))
        assertEquals(pending.payload,StorePurchaseJournal.restore(journal.wire(),origin).request)
        listOf(pending.copy(account="00000000-0000-4000-8000-000000000099"),pending.copy(action="store.apple"),pending.copy(source="account"),pending.copy(method="GET"),pending.copy(payload=journal.request+mapOf("other" to true))).forEach {
            assertThrows(LiveFailure::class.java) { StorePurchaseJournal.legacy(it,origin,account) }
        }
        assertEquals(journal.request,pending.payload)
    }
    @Test fun processRestartRejectsChangedOriginCredentialDigestAndCommittedReceipt() {
        val journal=original()
        assertEquals(journal,StorePurchaseJournal.restore(journal.wire(),origin))
        listOf(journal.wire()+mapOf("origin" to "https://other.invalid"),journal.wire()+mapOf("credential_sha256" to "0".repeat(64)),
            journal.wire()+mapOf("receipt" to receipt()+mapOf("payload_hash" to "0".repeat(64)))).forEach { raw->
            assertThrows(LiveFailure::class.java) { StorePurchaseJournal.restore(raw,origin) }
        }
    }
    @Test fun inputDigestsMatchIndependentCanonicalGoldenVectors() {
        assertEquals("8898d53431598f59cacaa04b36ce6928fba52f17405df7708d66bdf704be8041",original().inputHash("legacy-raw-v0"))
        assertEquals("c5c81822dfd2cb9846c774571144b6d6b65806c3ec1c2e194244cafce7fa0897",original().inputHash("digest-v1"))
    }

    @Test fun strongerReceiptEvidenceSurvivesAmbiguousSaveAndUnrelatedVaultSnapshot() {
        val original=original()
        val attempted=original.copy(receipt=receipt()).observed("commit_confirmed",value=receipt())
        // AtomicFile may have committed attempted while the repository still holds its earlier candidate.
        val uncertainty=StorePurchasePersistence.uncertainCopy(original,attempted)
        val vaultAfterUnrelatedSave=mapOf("google_store_operation" to original.wire(),"google_store_write_uncertainty" to uncertainty.wire(),"unrelated_draft" to "kept")
        val kept=StorePurchasePersistence.retained(StorePurchaseJournal.restore(vaultAfterUnrelatedSave["google_store_operation"],origin),
            StorePurchaseJournal.restore(vaultAfterUnrelatedSave["google_store_write_uncertainty"],origin))!!
        assertEquals(receipt(),kept.receipt);assertEquals(key,kept.key);assertEquals("kept",vaultAfterUnrelatedSave["unrelated_draft"])
        var dispatches=0;var held=kept
        val recovery=StorePurchaseRecovery({held=it},{},{dispatches++;error("No provider retry")},{unknown()})
        assertEquals("store_operation_requires_status",failed { recovery.run(kept,false) }.code)
        assertEquals(receipt(),held.receipt);assertEquals(0,dispatches)
    }
    @Test fun changedHistoricalReceiptCannotReplacePreviouslyValidatedEvidence() {
        val kept=original().copy(receipt=receipt());var held=kept
        val changed=receipt(value=result()+mapOf("active" to false))
        val recovery=StorePurchaseRecovery({held=it},{},{error("No provider retry")},{changed})
        assertEquals("store_operation_receipt_invalid",failed { recovery.run(kept,false) }.code)
        assertEquals(receipt(),held.receipt);assertEquals("historical_receipt_changed",held.observations.last()["kind"])
    }
    @Test fun failedReplacementRetainsBothMarkersAndRequiresExplicitReconciliation() {
        val prior=original().copy(receipt=receipt())
        val next=StorePurchaseJournal.create(origin,account,product,"same-subject-new-purchase-token-0002","android-store-new-operation-0002")
        val uncertain=StorePurchasePersistence.uncertainCopy(prior,next)
        assertEquals(next,uncertain)
        assertThrows(LiveFailure::class.java) { StorePurchasePersistence.retained(prior,uncertain) }
        assertEquals(key,prior.key);assertEquals(next.key,uncertain.key);assertNotNull(prior.receipt)
    }
    @Test fun malformedNestedResultStaysTypedAndRetainsIntent() {
        val original=original();var held=original
        val recovery=StorePurchaseRecovery({held=it},{},{error("No provider retry")},{receipt()+mapOf("result" to listOf("unrelated"))})
        val failure=failed { recovery.run(original,false) }
        assertEquals("store_operation_receipt_invalid",failure.code);assertTrue(failure.ambiguous);assertEquals(key,held.key);assertNull(held.receipt)
    }

}
