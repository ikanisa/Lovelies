package com.lovelies.frontend.preview

import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.time.Instant

class RefreshDeliveryTest {
    private val origin="https://ltqfplqevxztlswlzexn.supabase.co/functions/v1/lovelies-api"
    private val account="00000000-0000-4000-8000-000000000001"
    private val device="00000000-0000-4000-8000-000000000002"
    private val other="00000000-0000-4000-8000-000000000003"
    private val old="lvs_"+"A".repeat(43)
    private val successor="lvs_"+"B".repeat(43)
    private val expires=1_800_000_000_000L
    private fun date(time: Long)=Instant.ofEpochMilli(time).toString()
    private fun intent(method: String="anonymous")=RefreshDeliveryJournal.create(origin,account,method,old,
        if(method=="anonymous")null else device,if(method=="anonymous")null else "device-key")
    private fun response(journal: RefreshDeliveryJournal,access: Long=expires): WireObject=mapOf(
        "protocol" to RefreshDeliveryJournal.PROTOCOL,"rotation_key" to journal.rotationKey,"account_id" to account,
        "auth_method" to journal.method,"refresh_token" to successor,"access_token" to "prepared-successor",
        "expires_in" to 900,"access_expires_at" to date(access),"refresh_expires_at" to date(expires+30L*86400000),
        "delivery_expires_at" to date(expires+86400000))
    private fun denied(code: String?=null,block: ()->Unit) {
        try { block();fail("Expected refresh delivery rejection") }
        catch(problem: LiveFailure) { if(code!=null)assertEquals(code,problem.code) }
    }
    @Test fun encryptedIntentRestoresExactOriginalRequestAndRandomCanonicalSecret() {
        val journal=intent();val restored=RefreshDeliveryJournal.restore(journal.wire(),origin)
        assertEquals(journal.wire(),restored.wire());assertEquals(journal.request(),restored.request())
        assertEquals(setOf("protocol","rotation_key","delivery_secret","refresh_token"),restored.request().keys)
        assertEquals(old,restored.request()["refresh_token"])
        assertEquals(43,(restored.request()["delivery_secret"] as String).length)
        assertNotEquals(journal.rotationKey,intent().rotationKey)
        assertNotEquals(journal.request()["delivery_secret"],intent().request()["delivery_secret"])
        assertFalse(journal.toString().contains(old));assertFalse(journal.toString().contains(restored.request()["delivery_secret"] as String))
    }
    @Test fun intentCannotMoveBetweenOriginAccountMethodDeviceOrRefreshPredecessor() {
        val journal=intent("registered_face")
        journal.assertOwner(origin,account,"registered_face",device,"device-key");journal.assertOriginal(old)
        denied("refresh_delivery_scope_changed") { journal.assertOwner(origin,other,"registered_face",device,"device-key") }
        denied("refresh_delivery_scope_changed") { journal.assertOwner(origin,account,"anonymous",device,"device-key") }
        denied("refresh_delivery_scope_changed") { journal.assertOwner(origin,account,"registered_face",other,"device-key") }
        denied("refresh_delivery_scope_changed") { journal.assertOwner(origin,account,"registered_face",device,"other-key") }
        denied("refresh_delivery_scope_changed") { journal.assertOriginal(successor) }
        denied("refresh_delivery_scope_changed") { RefreshDeliveryJournal.restore(journal.wire(),"https://other.example") }
        denied { RefreshDeliveryJournal.restore(journal.wire()+mapOf("delivery_secret" to "A".repeat(42)+"B"),origin) }
    }
    @Test fun replayUsesAbsoluteExpiryEvenWhenOriginalAccessHasAlreadyExpired() {
        val journal=intent();val past=expires-900000
        val prepared=response(journal,past)
        journal.assertSuccessor(prepared,account,"anonymous",successor,past)
        denied("refresh_delivery_response_changed") { journal.assertSuccessor(prepared,account,"anonymous",successor,expires) }
        assertEquals(900,prepared["expires_in"])
    }
    @Test fun responseBindsExactKeyAccountMethodDistinctSuccessorAndAbsoluteTimes() {
        val journal=intent();val valid=response(journal)
        journal.assertSuccessor(valid,account,"anonymous",successor,expires)
        for(change in listOf(mapOf("protocol" to "other"),mapOf("rotation_key" to other),mapOf("account_id" to other),
            mapOf("access_expires_at" to date(expires+1)),mapOf("refresh_expires_at" to "invalid"),
            mapOf("delivery_expires_at" to date(expires+31L*86400000)),mapOf("delivery_secret" to "secret")))
            denied("refresh_delivery_response_changed") { journal.assertSuccessor(valid+change,account,"anonymous",successor,expires) }
        denied("refresh_delivery_response_changed") { journal.assertSuccessor(valid,other,"anonymous",successor,expires) }
        denied("refresh_delivery_response_changed") { journal.assertSuccessor(valid,account,"registered_face",successor,expires) }
        denied("refresh_delivery_response_changed") { journal.assertSuccessor(valid,account,"anonymous",old,expires) }
    }
    @Test fun failedProtectedWriteNeverDispatchesOrPublishes() {
        var dispatched=false;var published=false;var cleared=false
        try { deliverRefresh({throw IOException("vault unavailable")},{dispatched=true;emptyMap()},
            {published=true;it},{cleared=true});fail("Expected storage failure") } catch(_: IOException) {}
        assertFalse(dispatched);assertFalse(published);assertFalse(cleared)
    }
    @Test fun lostCommittedReplyReplaysOnePersistedIntentAndOnePreparedSuccessor() {
        var persisted: WireObject?=null;var prepared: WireObject?=null;var rotations=0;var credentials: WireObject?=null
        val first=intent();var attempt=first
        fun request(loseReply: Boolean): WireObject = deliverRefresh(
            { persisted=attempt.wire() },
            { assertEquals(first.request(),attempt.request());if(prepared==null) { prepared=response(attempt);rotations++ }
                if(loseReply)throw IOException("reply lost");prepared!! },
            { attempt.assertSuccessor(it,account,"anonymous",successor,expires);credentials=it;it },
            { persisted=null })
        try { request(true);fail("Expected lost reply") } catch(_: IOException) {}
        assertNull(credentials);assertNotNull(persisted)
        attempt=RefreshDeliveryJournal.restore(persisted,origin)
        assertEquals(prepared,request(false));assertEquals(1,rotations);assertEquals(prepared,credentials);assertNull(persisted)
    }
    @Test fun successorSaveFailureRetainsOriginalJournalAndClearRunsOnlyAfterDurableSave() {
        val journal=intent();val events=mutableListOf<String>();var pending=true
        try { deliverRefresh({events+="intent"},{events+="dispatch";response(journal)},
            {events+="save";throw IOException("disk full")},{_: Unit->pending=false;events+="clear"});fail("Expected save failure") } catch(_: IOException) {}
        assertEquals(listOf("intent","dispatch","save"),events);assertTrue(pending)
        events.clear()
        deliverRefresh({events+="intent"},{events+="replay";response(journal)},{events+="save";it},{pending=false;events+="clear"})
        assertEquals(listOf("intent","replay","save","clear"),events);assertFalse(pending)
    }
    @Test fun failedJournalClearCanRecoverFromStoredMatchingSuccessorWithoutRedispatch() {
        val journal=intent();var stored: WireObject?=null;var dispatches=0
        try { deliverRefresh({},{dispatches++;response(journal)},{stored=it;it},{throw IOException("clear failed")});fail("Expected clear failure") } catch(_: IOException) {}
        assertTrue(journal.isSuccessor(stored!!));journal.assertSuccessor(stored!!,account,"anonymous",successor,expires)
        val recovered=deliverRefresh({},{stored!!},{it},{})
        assertEquals(stored,recovered);assertEquals(1,dispatches)
    }
    @Test fun cancelledEpochCannotPublishOrClearAndRetiredIntentCannotBeDispatched() {
        val journal=intent();val fence=SessionFence();val scope=fence.switch(account);var cleared=false
        denied("session_changed") { deliverRefresh({},{fence.switch(null);response(journal)},
            {fence.assert(scope);it},{cleared=true}) }
        assertFalse(cleared)
        val retired=RefreshDeliveryJournal.restore(journal.retired().wire(),origin)
        denied("refresh_delivery_retired") { retired.request() }
        denied("refresh_delivery_scope_changed") { journal.assertIntent(retired) }
        assertEquals(journal.request(),retired.cancellationBody())
    }
    @Test fun cancellationAcknowledgementContainsOnlyExactRetiredIdentityAndNeverCredentials() {
        val journal=intent().retired();val acknowledgement: WireObject=mapOf("protocol" to RefreshDeliveryJournal.PROTOCOL,
            "rotation_key" to journal.rotationKey,"account_id" to account,"status" to "cancelled")
        val cancelled=journal.cancelled(acknowledgement)
        assertEquals("cancelled",cancelled.state);assertEquals(journal.cancellationBody(),cancelled.cancellationBody())
        assertEquals("cancelled",cancelled.cancelled(acknowledgement).state)
        for(change in listOf(mapOf("account_id" to other),mapOf("rotation_key" to other),mapOf("status" to "ready"),mapOf("access_token" to "forbidden")))
            denied("refresh_delivery_response_changed") { journal.cancelled(acknowledgement+change) }
        denied("refresh_delivery_not_retired") { intent().cancellationBody() }
    }
}
