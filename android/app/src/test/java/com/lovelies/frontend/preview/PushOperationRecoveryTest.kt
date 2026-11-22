package com.lovelies.frontend.preview

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

/** Actual typed parser, coordinator and repository callers with one synthetic
 * subject and local persistence/JSON fakes. No Firebase or provider dispatch. */
class PushOperationRecoveryTest {
    private val origin="https://ltqfplqevxztlswlzexn.supabase.co/functions/v1/lovelies-api"
    private val account="00000000-0000-4000-8000-000000000001"
    private val device="00000000-0000-4000-8000-000000000002"
    private val id="00000000-0000-4000-8000-000000000003"
    private val token="synthetic-current-android-token-0001"
    private val nextToken="synthetic-rotated-android-token-0002"
    private val key="android-push-local-operation-0001"
    private fun operation()=PushOperation.registration(origin,account,device,token,key)
    private fun unknown(op: PushOperation): WireObject=mapOf("protocol" to "lovelies-push-operation-receipt-v1","operation_key" to op.key,"status" to "unknown")
    private fun receipt(op: PushOperation,active: Boolean=true,hash: String=op.inputHashes.first()): WireObject=mapOf(
        "protocol" to "lovelies-push-operation-receipt-v1","operation_key" to op.key,"status" to "committed","action" to op.action,"payload_hash" to hash,
        "result" to if(op.kind=="register")mapOf("id" to id,"platform" to "android","active" to true) else mapOf("id" to op.registrationId,"active" to false),
        "current" to mapOf("id" to if(op.kind=="register")id else op.registrationId,"auth_device_id" to device,"platform" to "android","active" to if(active)1 else 0))
    private fun failure(code: String,body: ()->Unit) {
        try { body();fail("Expected $code") } catch(problem: LiveFailure) { assertEquals(code,problem.code) }
    }
    @Test fun exactTypedReceiptBindsKeyInputDeviceActionAndCurrentState() {
        val op=operation();assertEquals(PushOperationReceipt(id,true),PushOperationProtocol.receipt(receipt(op),op));assertNull(PushOperationProtocol.receipt(unknown(op),op))
        for(change in listOf(mapOf("operation_key" to "different-push-operation-key"),mapOf("payload_hash" to "b".repeat(64)),mapOf("action" to "notification./me/push-devices.DELETE"),
            mapOf("current" to (NativeProtocol.obj(receipt(op)["current"])+mapOf("auth_device_id" to id))),mapOf("status" to "recorded")))
            failure("push_operation_receipt_invalid") { PushOperationProtocol.receipt(receipt(op)+change,op) }
        failure("push_operation_receipt_invalid") { PushOperationProtocol.receipt(unknown(op)+mapOf("result" to emptyMap<String,Any?>()),op) }
    }
    @Test fun newJournalHasNoRawTokenAndStrictlyRoundTripsItsOwner() {
        val op=operation();assertFalse(NativeProtocol.canonical(op.wire()).contains(token));assertEquals(op,PushOperation.restore(op.wire(),origin))
        failure("push_operation_account_changed") { op.assertOwner(origin,id,device) }
        failure("push_operation_account_changed") { op.assertOwner(origin,account,id) }
        failure("push_operation_scope_changed") { PushOperation.restore(op.wire()+mapOf("token" to token),origin) }
    }
    private fun legacy()=PendingIntent(account,"notification","notification.push.register",key,
        mapOf("platform" to "android","push_token" to token,"operation_key" to key),"/me/push-devices","POST")
    @Test fun legacyPayloadKeepsItsExactKeyAndBothSupportedServerReceiptHashes() {
        val original=legacy();val op=PushOperation.legacy(original.wire(),origin,device)
        assertEquals(key,op.key);assertEquals(2,op.inputHashes.size)
        for(hash in op.inputHashes)assertEquals(PushOperationReceipt(id,true),PushOperationProtocol.receipt(receipt(op,hash=hash),op))
        assertEquals(original.wire(),PushOperationRetention.keep(mapOf("pending" to original.wire()),emptyMap())["push_operation_legacy"])
        failure("push_operation_scope_changed") { PushOperation.legacy(original.wire()+mapOf("path" to "/me/push-devices/other"),origin,device) }
    }
    private inner class Flow {
        var enabled=true;var current=true;var previous: WireObject?=null
        var read: suspend ()->String={token};var recovered: suspend ()->Unit={}
        var beforeSend: ()->Unit={};val events=mutableListOf<String>()
        fun check() { if(!current)throw LiveFailure("session_changed") }
        fun flow()=PushRegistrationFlow(account,device,::check,{enabled},
            recover={events.add("lookup");recovered()},previous={previous},token={events.add("token");read()},
            register={_,guard->beforeSend();guard();events.add("register")},remove={_,guard->guard();events.add("remove")},disable={events.add("disable")})
    }
    @Test fun startupOrForegroundReadsSdkRotationAndDoesNotPreRemoveTheOldRegistration()=runBlocking {
        val f=Flow();f.previous=mapOf("account" to account,"device" to device,"id" to id,"hash" to "old")
        f.flow().run();assertEquals(listOf("lookup","token","register"),f.events)
        f.previous=f.previous!!+mapOf("hash" to NativeProtocol.sha256(token.toByteArray()))
        f.events.clear();f.flow().run();assertEquals(listOf("lookup","token"),f.events)
    }
    @Test fun permissionOrPreferenceChangingDuringTokenReadCannotDispatch()=runBlocking {
        val f=Flow();f.read={f.enabled=false;token}
        failure("push_permission_changed") { runBlocking { f.flow().run() } };assertEquals(listOf("lookup","token"),f.events)
    }
    @Test fun preferenceChangingDuringRecoveryIsReadBeforeAnyTokenOrRegistration()=runBlocking {
        val f=Flow();f.recovered={f.enabled=false}
        f.flow().run();assertEquals(listOf("lookup","disable"),f.events)
    }
    @Test fun preferenceChangingAtTheDispatchPortCannotRegister()=runBlocking {
        val f=Flow();f.beforeSend={f.enabled=false}
        failure("push_permission_changed") { runBlocking { f.flow().run() } };assertEquals(listOf("lookup","token"),f.events)
    }
    @Test fun accountChangingDuringRecoveryOrTokenReadCannotPublishOrSend()=runBlocking {
        for(duringToken in listOf(false,true)) {
            val f=Flow();if(duringToken)f.read={f.current=false;token} else f.recovered={f.current=false}
            failure("session_changed") { runBlocking { f.flow().run() } };assertFalse(f.events.contains("register"));assertFalse(f.events.contains("remove"))
        }
    }
    @Test fun unknownPriorRegistrationStopsOnlyPushBeforeSdkRotation()=runBlocking {
        val f=Flow();f.recovered={throw LiveFailure("push_operation_requires_status",503,true)}
        failure("push_operation_requires_status") { runBlocking { f.flow().run() } };assertEquals(listOf("lookup"),f.events)
    }
    @Test fun optOutRemovesOnlyTheCurrentAccountAndDeviceRegistration()=runBlocking {
        for(owner in listOf(account,id))for(registeredDevice in listOf(device,id)) {
            val f=Flow();f.enabled=false;f.previous=mapOf("account" to owner,"device" to registeredDevice,"id" to id)
            f.flow().run();assertEquals(owner==account && registeredDevice==device,f.events.contains("remove"));assertFalse(f.events.contains("register"))
        }
    }
    private class Disk(initial: WireObject): RepositoryVault {
        var value=initial;var beforeSave: ((WireObject)->Unit)?=null;var afterSave: ((WireObject)->Unit)?=null
        override fun load()=value
        override fun save(value: WireObject) { beforeSave?.invoke(value);this.value=value.toMap();afterSave?.invoke(value) }
    }
    private inner class RepositoryFixture(initial: WireObject=emptyMap(),pending: PendingIntent?=null) {
        val session=LiveCredentials(account,"synthetic-session","synthetic-refresh","registered_face",Long.MAX_VALUE/2,emptyMap())
        val disk=Disk(initial+mapOf("device" to mapOf("account" to account,"alias" to "synthetic-alias","handle" to "synthetic-handle","device" to device))+
            (pending?.let { mapOf("pending" to it.wire()) } ?: emptyMap()))
        val requests=mutableListOf<String>();var lookupUnknown=false;var lookupActive: Boolean?=null;var loseDispatchReply=false;var duringLookup: (()->Unit)?=null;var beforeWrite: (()->Unit)?=null
        val repo: CloudflareRepository=CloudflareRepository(origin,RepositoryBoundary(disk,{path,scope,bearer,method,body,_->
            requests.add(path);assertEquals(account,scope.accountId);assertEquals(session.token,bearer)
            when {
                path=="/me"->mapOf("authenticated" to true)
                path=="/me/push-operations"->{
                    assertEquals("POST",method);val op=PushOperation.retained(disk.value,origin)!!;assertEquals(mapOf("operation_key" to op.key),body)
                    duringLookup?.invoke();if(lookupUnknown)unknown(op) else receipt(op,active=lookupActive ?: (op.kind=="register"))
                }
                path=="/me/push-devices" || path.startsWith("/me/push-devices/")->{
                    val op=PushOperation.retained(disk.value,origin)!!;assertEquals(op.key,body!!["operation_key"])
                    if(loseDispatchReply)throw LiveFailure("connection_unavailable",ambiguous=true)
                    if(op.kind=="register")mapOf("id" to id,"platform" to "android","active" to true) else mapOf("id" to op.registrationId,"active" to false)
                }
                path=="/me/photo-preferences"->mapOf("updated" to true)
                else->error("Unexpected synthetic boundary: $path")
            }
        },initialStorage=disk.value,initialSession=session,initialPending=pending,beforeJsonWrite={beforeWrite?.invoke()}))
        suspend fun ready() { repo.bootstrap();requests.clear() }
    }
    @Test fun actualLostRegisterReplyConsumesExactReceiptThenAllowsNewTokenRotation()=runBlocking {
        val f=RepositoryFixture();f.ready();f.loseDispatchReply=true;f.lookupUnknown=true
        failure("push_operation_requires_status") { runBlocking { f.repo.registerPushToken(token,device){} } }
        val original=PushOperation.retained(f.disk.value,origin)!!;assertNull(f.repo.saved("push_registration"));assertFalse(NativeProtocol.canonical(f.disk.value).contains(token))
        f.lookupUnknown=false;f.repo.recoverPushOperation(device){}
        assertNull(PushOperation.retained(f.disk.value,origin));assertEquals(original.tokenHash,NativeProtocol.obj(f.repo.saved("push_registration"))["hash"])
        f.loseDispatchReply=false;f.repo.registerPushToken(nextToken,device){}
        assertEquals(NativeProtocol.sha256(nextToken.toByteArray()),NativeProtocol.obj(f.repo.saved("push_registration"))["hash"])
        assertEquals(2,f.requests.count { it=="/me/push-devices" });assertFalse(f.requests.any { it.startsWith("/me/push-devices/") })
    }
    @Test fun actualHistoricalRegisterReceiptCannotReviveACurrentlyInactiveRegistration()=runBlocking {
        val op=operation();val prior=mapOf("account" to account,"device" to device,"id" to id,"hash" to op.tokenHash)
        val f=RepositoryFixture(mapOf("push_operation" to op.wire(),"push_registration" to prior));f.ready();f.lookupActive=false
        // The historical result still says active=true; the authenticated
        // current row is inactive after a later retirement.
        assertEquals(true,NativeProtocol.obj(receipt(op,active=false)["result"])["active"])
        f.repo.recoverPushOperation(device){}
        assertNull(f.repo.saved("push_registration"));assertNull(f.disk.value["push_registration"])
        assertNull(PushOperation.retained(f.disk.value,origin));assertEquals(listOf("/me/push-operations"),f.requests)
    }
    @Test fun actualHistoricalRemovalCannotClearASameIdSuccessorOrReplayTheOldDelete()=runBlocking {
        val op=PushOperation.removal(origin,account,device,id,key)
        val successor=mapOf("account" to account,"device" to device,"id" to id,"hash" to NativeProtocol.sha256(nextToken.toByteArray()))
        val f=RepositoryFixture(mapOf("push_operation" to op.wire(),"push_registration" to successor));f.ready();f.lookupActive=true
        // A later registration reused the row ID. Its active current state
        // takes precedence over the old operation's active=false result.
        assertEquals(false,NativeProtocol.obj(receipt(op,active=true)["result"])["active"])
        failure("push_registration_changed") { runBlocking { f.repo.recoverPushOperation(device){} } }
        assertEquals(successor,f.repo.saved("push_registration"));assertEquals(successor,f.disk.value["push_registration"])
        assertNull(PushOperation.retained(f.disk.value,origin));assertEquals(listOf("/me/push-operations"),f.requests)
        f.repo.recoverPushOperation(device){};assertEquals(listOf("/me/push-operations"),f.requests)
    }
    @Test fun actualUnknownLegacyOperationMovesOnlyAfterDurableHoldAndDoesNotBlockUnrelatedMutations()=runBlocking {
        val legacy=legacy();val f=RepositoryFixture(pending=legacy);f.ready();f.lookupUnknown=true
        failure("push_operation_requires_status") { runBlocking { f.repo.recoverPushOperation(device){} } }
        assertNull(f.repo.pending);assertNull(f.disk.value["pending"]);assertEquals(legacy.wire(),f.disk.value["push_operation_legacy"])
        val held=PushOperation.retained(f.disk.value,origin)!!
        f.repo.mutate("preferences.fixture",mapOf("enabled" to true),path="/me/photo-preferences",method="PATCH")
        assertEquals(held,PushOperation.retained(f.disk.value,origin));assertEquals(legacy.wire(),f.disk.value["push_operation_legacy"])
        failure("push_operation_requires_status") { runBlocking { f.repo.registerPushToken(nextToken,device){} } }
        assertEquals(held,PushOperation.retained(f.disk.value,origin));assertFalse(f.requests.contains("/me/push-devices"))
    }
    @Test fun actualFailedLegacyAdoptionRetainsGenericSlotAndExactEvidenceUntilAcknowledged()=runBlocking {
        val legacy=legacy();val f=RepositoryFixture(pending=legacy);f.ready();f.lookupUnknown=true
        f.disk.beforeSave={if(it["push_operation"]!=null)throw IOException("Synthetic local write failure")}
        failure("push_operation_storage_requires_status") { runBlocking { f.repo.recoverPushOperation(device){} } }
        assertEquals(legacy,f.repo.pending);assertEquals(legacy.wire(),f.disk.value["pending"])
        assertNotNull(f.repo.saved("push_operation_uncertainty"));assertFalse(f.requests.contains("/me/push-operations"))
        f.disk.beforeSave=null
        failure("push_operation_requires_status") { runBlocking { f.repo.recoverPushOperation(device){} } }
        assertNull(f.repo.pending);assertEquals(legacy.wire(),f.disk.value["push_operation_legacy"])
    }
    @Test fun actualLostMarkerAcknowledgementSurvivesUnrelatedSaveAndRestartWithoutDispatch()=runBlocking {
        val f=RepositoryFixture();f.ready();var first=true
        f.disk.afterSave={if(it["push_operation"]!=null && first) { first=false;throw IOException("Synthetic lost local acknowledgement") }}
        failure("push_operation_storage_requires_status") { runBlocking { f.repo.registerPushToken(token,device){} } }
        assertNotNull(f.repo.saved("push_operation_uncertainty"));assertFalse(f.requests.contains("/me/push-devices"))
        f.disk.afterSave=null;f.repo.remember("unrelated_draft","preserved")
        val original=PushOperation.retained(f.disk.value,origin)!!
        val restarted=RepositoryFixture(f.disk.value);restarted.ready();restarted.lookupUnknown=true
        failure("push_operation_requires_status") { runBlocking { restarted.repo.recoverPushOperation(device){} } }
        assertEquals(original,PushOperation.retained(restarted.disk.value,origin));assertEquals("preserved",restarted.disk.value["unrelated_draft"])
        assertFalse(restarted.requests.contains("/me/push-devices"))
    }
    @Test fun actualLostReceiptPublicationIsReconciledWithoutASecondRegister()=runBlocking {
        val f=RepositoryFixture();f.ready()
        f.disk.afterSave={if(it["push_registration"]!=null && it["push_operation"]==null)throw IOException("Synthetic lost publication acknowledgement")}
        failure("push_operation_storage_requires_status") { runBlocking { f.repo.registerPushToken(token,device){} } }
        assertNotNull(f.repo.saved("push_operation_uncertainty"));f.disk.afterSave=null
        f.repo.remember("unrelated_draft","preserved");f.repo.recoverPushOperation(device){}
        assertNull(PushOperation.retained(f.disk.value,origin));assertEquals(NativeProtocol.sha256(token.toByteArray()),NativeProtocol.obj(f.repo.saved("push_registration"))["hash"])
        assertEquals(1,f.requests.count { it=="/me/push-devices" });assertEquals("preserved",f.disk.value["unrelated_draft"])
    }
    @Test fun actualAccountChangeDuringReceiptReadKeepsTheUnresolvedJournal()=runBlocking {
        val f=RepositoryFixture(mapOf("push_operation" to operation().wire()));f.ready();f.duringLookup={f.repo.authenticationLost()}
        failure("session_changed") { runBlocking { f.repo.recoverPushOperation(device){} } }
        assertEquals(operation(),PushOperation.retained(f.disk.value,origin));assertNull(f.repo.saved("push_registration"))
    }
    @Test fun actualOptOutBeforeTransportCancelsOnlyItsProvablyUndispatchedReservation()=runBlocking {
        val f=RepositoryFixture();f.ready();var checks=0
        failure("push_permission_changed") { runBlocking { f.repo.registerPushToken(token,device) { if(++checks==2)throw LiveFailure("push_permission_changed") } } }
        assertNull(PushOperation.retained(f.disk.value,origin));assertFalse(f.requests.contains("/me/push-devices"))
    }
    @Test fun actualJsonBoundaryCarriesPermissionGuardPastTheEarlyRepositoryAdmission()=runBlocking {
        val f=RepositoryFixture();f.ready();var allowed=true;var checks=0
        f.beforeWrite={allowed=false}
        failure("push_permission_changed") { runBlocking { f.repo.registerPushToken(token,device) {
            checks++;if(!allowed)throw LiveFailure("push_permission_changed",409,true)
        } } }
        assertEquals(3,checks);assertFalse(f.requests.contains("/me/push-devices"));assertFalse(f.requests.contains("/me/push-operations"))
        assertNull(PushOperation.retained(f.disk.value,origin));assertNull(f.repo.saved("push_registration"))
    }
    @Test fun actualSetupFailureWithoutFinalGuardDenialKeepsItsReservedOperationForLookupOnly()=runBlocking {
        val f=RepositoryFixture();f.ready();f.beforeWrite={throw LiveFailure("connection_unavailable",503,true)}
        failure("connection_unavailable") { runBlocking { f.repo.registerPushToken(token,device){} } }
        val held=PushOperation.retained(f.disk.value,origin)!!
        assertFalse(f.requests.contains("/me/push-devices"));assertNull(f.repo.saved("push_registration"))
        f.beforeWrite=null;f.lookupUnknown=true
        failure("push_operation_requires_status") { runBlocking { f.repo.recoverPushOperation(device){} } }
        assertEquals(held,PushOperation.retained(f.disk.value,origin));assertFalse(f.requests.contains("/me/push-devices"))
    }
    @Test fun actualLogoutRetainsDigestHoldAndLegacyPayloadWithoutRestoringCredentials()=runBlocking {
        val legacy=legacy();val op=PushOperation.legacy(legacy.wire(),origin,device)
        val evidence=mapOf("push_operation" to op.wire(),"push_operation_legacy" to legacy.wire())
        val f=RepositoryFixture(evidence);f.ready();f.repo.authenticationLost();f.repo.logout()
        evidence.forEach { (key,value)->assertEquals(value,f.disk.value[key]) };assertNull(f.repo.credentials)
    }
}
