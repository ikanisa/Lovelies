package com.lovelies.frontend.preview

import com.android.billingclient.api.*
import kotlinx.coroutines.*
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

private const val storeAccount="00000000-0000-4000-8000-000000000001"
private const val storeOther="00000000-0000-4000-8000-000000000099"
private const val storeOrigin="https://store-fixture.invalid"
private const val storeProduct="lovelies.pro.monthly"
private const val storeToken="same-subject-play-purchase-token-0001"
private const val storeOtherToken="other-account-play-purchase-token-0099"
private const val storeKey="android-store-operation-0001"
private fun storeOriginal()=StorePurchaseJournal.create(storeOrigin,storeAccount,storeProduct,storeToken,storeKey)
private fun storeResult(record:StorePurchaseJournal):WireObject=mapOf("active" to true,"billing_environment" to "production","expires_at" to "2099-01-01T00:00:00.000Z",
    "financial_eligible" to true,"original_transaction_id" to record.credentialSha256,"product_id" to record.product,"provider" to "google_play","stale" to false,"transaction_id" to "synthetic-play-order-1")
private fun storeReceipt(record:StorePurchaseJournal,scheme:String="digest-v1"):WireObject=mapOf("protocol" to "lovelies-store-operation-receipt-v1","actor_id" to record.account,
    "operation_key" to record.key,"status" to "committed","action" to "store.google","source" to "store","payload_hash" to record.inputHash(scheme),"input_scheme" to scheme,
    "credential_sha256" to record.credentialSha256,"receipt_scope" to "historical","result" to storeResult(record))
private fun storeUnknown(record:StorePurchaseJournal):WireObject=mapOf("protocol" to "lovelies-store-operation-receipt-v1","actor_id" to record.account,"operation_key" to record.key,"status" to "unknown")
private class StoreEngine(val original:StorePurchaseJournal=storeOriginal()) {
    var held=original;var current=true;var failWrite=false;var dispatches=0;var lookups=0
    var directFailure:LiveFailure?=null;var lookupFailure:LiveFailure?=null;var response:WireObject?=null;var afterLookup:(()->Unit)?=null
    val engine=StorePurchaseRecovery({ if(failWrite)throw LiveFailure("storage_failed");held=it },{ if(!current)throw LiveFailure("session_changed") },
        { check(it==original.request);dispatches++;directFailure?.let { throw it };storeResult(original) },
        { check(it==mapOf("operation_key" to original.key));lookups++;afterLookup?.invoke();lookupFailure?.let { throw it };response ?: storeReceipt(original) })
}
private class StoreVault:RepositoryVault {
    private var authority:WireObject?=null
    override fun loadAuthority()=authority
    override fun saveAuthority(value:WireObject) { authority=value }

    @Volatile var value:WireObject=emptyMap()
    @Volatile var fail=false
    @Volatile var failTerminal=false
    @Volatile var loseReplacementWrite=false
    @Volatile var loseArchiveWrite=false
    override fun load()=value
    override fun save(value:WireObject) {
        val record=value["google_store_operation"]?.let { StorePurchaseJournal.restore(it,storeOrigin) }
        if(fail || failTerminal && record?.retired==true)throw LiveFailure("storage_failed")
        this.value=value
        if(loseArchiveWrite && record==null && NativeProtocol.rows(value["google_store_history"] ?: emptyList<WireObject>()).isNotEmpty()) { loseArchiveWrite=false;throw LiveFailure("storage_ack_lost") }
        if(loseReplacementWrite && record!=null && record.key!=storeKey && !record.retired) { loseReplacementWrite=false;throw LiveFailure("storage_ack_lost") }
    }
}
private class StoreRepositoryFixture(start:StorePurchaseJournal=storeOriginal(),legacy:Boolean=false) {
    val vault=StoreVault();val original=start
    val calls=CopyOnWriteArrayList<Pair<String,WireObject?>>()
    val terminal=ConcurrentHashMap.newKeySet<String>().apply { add(start.key) }
    val receipts=ConcurrentHashMap<String,WireObject>()
    @Volatile var terminalAll=false
    @Volatile var afterLookup:(()->Unit)?=null
    init {
        vault.value=mapOf("google_store_operation" to start.wire())
        if(legacy)vault.value=vault.value+mapOf("pending" to PendingIntent(start.account,"store","store.google",start.key,start.request,"/subscriptions/google/transactions","POST").wire())
    }
    fun record()=StorePurchasePersistence.retained(vault.value["google_store_operation"]?.let { StorePurchaseJournal.restore(it,storeOrigin) },
        vault.value["google_store_write_uncertainty"]?.let { StorePurchaseJournal.restore(it,storeOrigin) })!!
    fun history()=NativeProtocol.rows(vault.value["google_store_history"] ?: emptyList<WireObject>(),64).map { StorePurchaseJournal.restore(it,storeOrigin) }
    fun repository(owner:String=storeAccount):CloudflareRepository {
        val actor=LiveCredentials(owner,"synthetic-session","synthetic-refresh","registered_face",Long.MAX_VALUE/2,emptyMap())
        return CloudflareRepository(storeOrigin,RepositoryBoundary(vault=vault,initialStorage=vault.value,initialSession=actor,json={ path,scope,_,method,body,_ ->
            calls+=path to body;check(scope.accountId==owner && method=="POST")
            val key=NativeProtocol.text(body!!["operation_key"])
            if(path=="/me/store-operations") {
                afterLookup?.invoke()
                if(key in terminal || terminalAll)throw LiveFailure("operation_recovered_without_result",409)
                receipts[key] ?: storeUnknown(record())
            } else {
                check(path=="/subscriptions/google/transactions")
                if(key in terminal || terminalAll)throw LiveFailure("operation_recovered_without_result",409)
                val held=record();check(body==held.request);receipts[key]=storeReceipt(held);storeResult(held)
            }
        }))
    }
    fun dispatches()=calls.filter { it.first=="/subscriptions/google/transactions" }
}
private class StoreContext:android.app.Activity() {
    override fun getString(id:Int)=if(id==R.string.store_verification_ended_restore)"Purchase verification ended without confirmation. Choose Restore purchases to try again." else "fixture-$id"
}
private fun sdkPurchase(owner:String=storeAccount,state:Int=Purchase.PurchaseState.PURCHASED,token:String=storeToken)=Purchase(token,listOf(storeProduct),state,AccountIdentifiers(NativeProtocol.sha256(owner.toByteArray())))
private suspend fun settled(test:()->Boolean) { withTimeout(5000) { while(!test())delay(5) } }

fun main()=runBlocking {
    var checks=0
    suspend fun case(name:String,work:suspend ()->Unit) { work();checks++;println("PASS $name") }
    case("store input hashes retain independent canonical golden vectors") {
        val value=storeOriginal()
        check(value.inputHash("legacy-raw-v0")=="8898d53431598f59cacaa04b36ce6928fba52f17405df7708d66bdf704be8041")
        check(value.inputHash("digest-v1")=="c5c81822dfd2cb9846c774571144b6d6b65806c3ec1c2e194244cafce7fa0897")
        check(StorePurchaseJournal.restore(value.wire()-setOf("disposition","legacy_input_hash"),storeOrigin)==value)
    }
    case("normal direct verification requires exact typed receipt and survives restart read only") {
        val f=StoreEngine();check(f.engine.run(f.original,true)==storeResult(f.original))
        check(f.held.receipt!=null && f.dispatches==1 && f.lookups==1)
        check(f.engine.run(StorePurchaseJournal.restore(f.held.wire(),storeOrigin),false)==storeResult(f.original) && f.dispatches==1)
    }
    case("legacy and digest receipt schemes bind the same original independently") {
        for(scheme in listOf("legacy-raw-v0","digest-v1")) {
            val f=StoreEngine();f.response=storeReceipt(f.original,scheme)
            check(f.engine.run(f.original,false)==storeResult(f.original) && f.dispatches==0)
        }
    }
    case("unknown lookup retains original key and never resends a saved credential") {
        val f=StoreEngine();f.response=storeUnknown(f.original)
        repeat(2) { check((runCatching { f.engine.run(f.held,false) }.exceptionOrNull() as? LiveFailure)?.code=="store_operation_requires_status") }
        check(f.dispatches==0 && f.held.token==storeToken && f.held.key==storeKey)
    }
    case("wrong actor key product hash and credential cannot confirm the original") {
        for(change in listOf(mapOf("actor_id" to storeOther),mapOf("operation_key" to "android-other-operation"),mapOf("payload_hash" to "0".repeat(64)),mapOf("credential_sha256" to "0".repeat(64)))) {
            val f=StoreEngine();f.response=storeReceipt(f.original)+change
            check(runCatching { f.engine.run(f.original,false) }.isFailure && f.held.receipt==null && !f.held.retired)
        }
    }
    case("terminal direct response persists minimized exact operation without lookup or success") {
        val f=StoreEngine();f.directFailure=LiveFailure("operation_recovered_without_result",409)
        val failure=runCatching { f.engine.run(f.original,true) }.exceptionOrNull() as? LiveFailure
        check(failure?.code=="operation_recovered_without_result" && f.held.retired && f.held.token==null && f.held.receipt==null && f.lookups==0)
        check(!NativeProtocol.canonical(f.held.wire()).contains(storeToken) && f.held.credentialSha256==f.original.credentialSha256)
    }
    case("terminal exact-key lookup retires without dispatch and stays retired after restart") {
        val f=StoreEngine();f.lookupFailure=LiveFailure("operation_recovered_without_result",409)
        check(runCatching { f.engine.run(f.original,false) }.isFailure && f.held.retired && f.dispatches==0)
        val restored=StorePurchaseJournal.restore(f.held.wire(),storeOrigin)
        check(runCatching { f.engine.run(restored,true) }.isFailure && f.dispatches==0 && f.lookups==1)
        check(runCatching { restored.request }.isFailure)
    }
    case("exact 410 store replay retains original server code and both input schemes without provider replay") {
        val f=StoreEngine();f.directFailure=LiveFailure("operation_retired_by_recovery",410)
        val failure=runCatching { f.engine.run(f.original,true) }.exceptionOrNull() as? LiveFailure
        val restored=StorePurchaseJournal.restore(f.held.wire(),storeOrigin)
        check(failure?.code=="operation_recovered_without_result" && failure.status==409 && restored.retired && restored.token==null && f.dispatches==1 && f.lookups==0)
        check(restored.inputHash("legacy-raw-v0")==f.original.inputHash("legacy-raw-v0") && restored.inputHash("digest-v1")==f.original.inputHash("digest-v1"))
        check(restored.observations.single()["code"]=="operation_retired_by_recovery" && restored.observations.single()["http_status"]==410)
    }
    case("terminal persistence failure leaves original credential and key held") {
        val f=StoreEngine();f.lookupFailure=LiveFailure("operation_recovered_without_result",409);f.failWrite=true
        check((runCatching { f.engine.run(f.original,false) }.exceptionOrNull() as? LiveFailure)?.code=="storage_failed" && f.held==f.original)
    }
    case("late terminal result cannot retire another account generation") {
        val f=StoreEngine();f.lookupFailure=LiveFailure("operation_recovered_without_result",409);f.afterLookup={ f.current=false }
        check(runCatching { f.engine.run(f.original,false) }.isFailure && f.held==f.original)
    }
    case("terminal rollback contradicting a saved receipt is rejected without erasing evidence") {
        val original=storeOriginal().let { it.copy(receipt=storeReceipt(it)) };val f=StoreEngine(original);f.lookupFailure=LiveFailure("operation_recovered_without_result",409)
        check((runCatching { f.engine.run(original,false) }.exceptionOrNull() as? LiveFailure)?.code=="store_operation_receipt_invalid" && f.held==original)
    }
    case("direct success followed by terminal lookup remains a contradiction hold") {
        val f=StoreEngine();f.lookupFailure=LiveFailure("operation_recovered_without_result",409)
        check(runCatching { f.engine.run(f.original,true) }.isFailure && !f.held.retired && f.held.token==storeToken && f.held.observations.any { it["kind"]=="direct_success" })
    }
    case("other HTTP errors and wrong terminal status preserve unresolved evidence") {
        for(problem in listOf(LiveFailure("operation_recovered_without_result",503),LiveFailure("operation_retired_by_recovery",409),LiveFailure("operation_key_conflict",409),LiveFailure("other_conflict",409),LiveFailure("authentication_required",401))) {
            val f=StoreEngine();f.lookupFailure=problem
            check(runCatching { f.engine.run(f.original,false) }.isFailure && !f.held.retired && f.held.token==storeToken)
        }
    }
    case("terminal persistence merge wins over pending but rejects committed contradiction") {
        val original=storeOriginal();val retired=original.terminal()
        check(StorePurchasePersistence.retained(original,retired)==retired && StorePurchasePersistence.retained(retired,original)==retired)
        check(runCatching { StorePurchasePersistence.retained(original.copy(receipt=storeReceipt(original)),retired) }.isFailure)
        check(runCatching { StorePurchasePersistence.retained(original.observed("direct_success"),retired) }.isFailure)
    }
    case("terminal serialization rejects token resurrection and keeps original input hashes") {
        val retired=storeOriginal().terminal();val restored=StorePurchaseJournal.restore(retired.wire(),storeOrigin)
        check(restored==retired && restored.inputHash("legacy-raw-v0")==storeOriginal().inputHash("legacy-raw-v0"))
        for(change in listOf(mapOf("purchase_token" to storeToken),mapOf("disposition" to "confirmed"),mapOf("receipt" to storeReceipt(storeOriginal())))) {
            check(runCatching { StorePurchaseJournal.restore(retired.wire()+change,storeOrigin) }.isFailure)
        }
    }
    case("one restore attempt admits a token once and never stores its raw credential") {
        val attempt=StoreRestoreAttempt();check(attempt.claim(storeAccount,storeProduct,storeToken))
        check(!attempt.claim(storeAccount,storeProduct,storeToken) && StoreRestoreAttempt().claim(storeAccount,storeProduct,storeToken))
    }
    case("actual repository retires terminal store and generic legacy credential together") {
        val f=StoreRepositoryFixture(legacy=true);val repo=f.repository()
        check((runCatching { repo.recoverGooglePurchase() }.exceptionOrNull() as? LiveFailure)?.code=="operation_recovered_without_result")
        check(f.record().retired && f.record().token==null && f.vault.value["pending"]==null && repo.pending==null && f.dispatches().isEmpty())
    }
    case("actual automatic callbacks cannot replace a retired verification or grant a receipt") {
        val f=StoreRepositoryFixture();val repo=f.repository();runCatching { repo.recoverGooglePurchase() }
        repeat(2) { check((runCatching { f.repository().verifyGooglePurchase(storeProduct,storeToken) }.exceptionOrNull() as? LiveFailure)?.code=="operation_recovered_without_result") }
        check(f.record().key==storeKey && f.record().receipt==null && f.dispatches().isEmpty())
    }
    case("explicit same-token restoration admits one fresh key after durable retirement") {
        val f=StoreRepositoryFixture();val result=f.repository().verifyGooglePurchase(storeProduct,storeToken,allowTerminalReplacement=true)
        check(result["active"]==true && f.record().key!=storeKey && f.dispatches().size==1)
        val history=NativeProtocol.rows(f.vault.value["google_store_history"]).map { StorePurchaseJournal.restore(it,storeOrigin) }
        check(history.single().key==storeKey && history.single().retired && history.single().token==null)
    }
    case("a replacement receiving terminal outcome stops after one fresh verification") {
        val f=StoreRepositoryFixture();f.terminalAll=true
        check(runCatching { f.repository().verifyGooglePurchase(storeProduct,storeToken,allowTerminalReplacement=true) }.isFailure)
        check(f.dispatches().size==1 && f.record().retired && f.record().key!=storeKey)
    }
    case("failed terminal write cannot authorize a fresh store key") {
        val f=StoreRepositoryFixture();f.vault.failTerminal=true;val repo=f.repository()
        check((runCatching { repo.verifyGooglePurchase(storeProduct,storeToken,allowTerminalReplacement=true) }.exceptionOrNull() as? LiveFailure)?.code=="store_operation_storage_requires_status")
        check(f.dispatches().isEmpty() && !f.record().retired && f.record().token==storeToken)
        f.vault.failTerminal=false;check(repo.verifyGooglePurchase(storeProduct,storeToken,allowTerminalReplacement=true)["active"]==true && f.dispatches().size==1)
    }
    case("lost replacement marker acknowledgement keeps new key lookup-only across restart") {
        val f=StoreRepositoryFixture();val repo=f.repository();runCatching { repo.recoverGooglePurchase() };f.vault.loseReplacementWrite=true
        check(runCatching { repo.verifyGooglePurchase(storeProduct,storeToken,allowTerminalReplacement=true) }.isFailure && f.dispatches().isEmpty())
        val key=f.record().key;check(key!=storeKey)
        check((runCatching { f.repository().verifyGooglePurchase(storeProduct,storeToken,allowTerminalReplacement=true) }.exceptionOrNull() as? LiveFailure)?.code=="store_operation_requires_status")
        check(f.record().key==key && f.dispatches().isEmpty())
    }
    case("another account and late account switch cannot consume a terminal restoration") {
        val f=StoreRepositoryFixture();val foreign=f.repository(storeOther)
        check(runCatching { foreign.verifyGooglePurchase(storeProduct,storeToken,true,SessionScope(foreign.currentScope().epoch,storeAccount)) }.isFailure && f.calls.isEmpty())
        val repo=f.repository();f.afterLookup={ repo.fence.switch(storeOther) }
        check(runCatching { repo.verifyGooglePurchase(storeProduct,storeToken,true) }.isFailure && !f.record().retired && f.dispatches().isEmpty())
    }
    case("actual Play callback remains automatic and tells user to restore without repurchase") {
        FakePlay.reset();val f=StoreRepositoryFixture(storeOriginal().terminal());var grants=0
        val billing=PlayPurchases(StoreContext(),f.repository(),Dispatchers.Unconfined) { grants++ }
        billing.load();settled { !billing.busy };FakePlay.emit(listOf(sdkPurchase()));settled { billing.status.contains("Choose Restore purchases") }
        check(grants==0 && f.dispatches().isEmpty() && FakePlay.sheets==0);billing.dispose()
    }
    case("explicit Play restore queries purchased ownership then verifies fresh without billing sheet") {
        FakePlay.reset();val f=StoreRepositoryFixture();var grants=0;FakePlay.purchases=listOf(sdkPurchase())
        val billing=PlayPurchases(StoreContext(),f.repository(),Dispatchers.Unconfined) { grants++ };billing.restore();settled { !billing.busy }
        check(grants==1 && FakePlay.queries==1 && FakePlay.sheets==0 && f.dispatches().size==1);billing.dispose()
    }
    case("duplicate Play enumeration cannot replace two terminal keys in one restore") {
        FakePlay.reset();val f=StoreRepositoryFixture();f.terminalAll=true;var grants=0;FakePlay.purchases=listOf(sdkPurchase(),sdkPurchase())
        val billing=PlayPurchases(StoreContext(),f.repository(),Dispatchers.Unconfined) { grants++ };billing.restore();settled { !billing.busy }
        check(grants==0 && f.dispatches().size==1 && FakePlay.sheets==0 && billing.status.contains("Choose Restore purchases"));billing.dispose()
    }
    case("pending or foreign SDK purchase cannot authorize terminal replacement") {
        FakePlay.reset();val f=StoreRepositoryFixture();var grants=0;FakePlay.purchases=listOf(sdkPurchase(state=Purchase.PurchaseState.PENDING),sdkPurchase(owner=storeOther))
        val billing=PlayPurchases(StoreContext(),f.repository(),Dispatchers.Unconfined) { grants++ };billing.restore();settled { !billing.busy }
        check(grants==0 && f.dispatches().isEmpty() && f.record().retired && FakePlay.sheets==0);billing.dispose()
    }
    case("purchase button cannot open another provider sheet while original verification is terminal") {
        FakePlay.reset();val f=StoreRepositoryFixture(storeOriginal().terminal());var grants=0
        val billing=PlayPurchases(StoreContext(),f.repository(),Dispatchers.Unconfined) { grants++ };billing.purchase(StoreContext(),"fixture-offer");settled { !billing.busy }
        check(grants==0 && FakePlay.sheets==0 && FakePlay.queries==0 && f.dispatches().isEmpty());billing.dispose()
    }
    case("Play restore stops before SDK retry when terminal persistence fails") {
        FakePlay.reset();val f=StoreRepositoryFixture();f.vault.failTerminal=true;var grants=0;FakePlay.purchases=listOf(sdkPurchase())
        val billing=PlayPurchases(StoreContext(),f.repository(),Dispatchers.Unconfined) { grants++ };billing.restore();settled { !billing.busy }
        check(grants==0 && FakePlay.queries==0 && FakePlay.sheets==0 && f.dispatches().isEmpty() && !f.record().retired);billing.dispose()
    }
    case("restarted receipt cannot contradict a persisted direct success result") {
        val first=StoreEngine();first.lookupFailure=LiveFailure("fixture_lookup_unavailable",503,true)
        check(runCatching { first.engine.run(first.original,true) }.isFailure && first.held.receipt==null)
        val saved=StorePurchaseJournal.restore(first.held.wire(),storeOrigin)
        val restarted=StoreEngine(saved)
        restarted.response=storeReceipt(saved)+mapOf("result" to (storeResult(saved)+mapOf("active" to false)))
        check((runCatching { restarted.engine.run(saved,false) }.exceptionOrNull() as? LiveFailure)?.code=="store_operation_receipt_invalid")
        check(restarted.dispatches==0 && restarted.held.receipt==null && restarted.held.observations.any { it["kind"]=="direct_success" })
    }
    case("uncertain direct success constrains a later receipt and contradictory receipt merges") {
        val original=storeOriginal();val observed=original.observed("direct_success",value=storeResult(original))
        val retained=StorePurchasePersistence.retained(original,observed)!!
        val changed=storeReceipt(original)+mapOf("result" to (storeResult(original)+mapOf("transaction_id" to "different-order-2")))
        val f=StoreEngine(retained);f.response=changed
        check((runCatching { f.engine.run(retained,false) }.exceptionOrNull() as? LiveFailure)?.code=="store_operation_receipt_invalid" && f.held.receipt==null)
        check(runCatching { StorePurchasePersistence.retained(original.copy(receipt=changed),observed) }.isFailure)
        check(runCatching { StorePurchasePersistence.retained(observed,original.copy(receipt=changed)) }.isFailure)
        check(runCatching { StorePurchaseJournal.restore(retained.copy(receipt=changed).wire(),storeOrigin) }.isFailure)
    }
    case("missing or contradictory persisted direct proof cannot admit a receipt") {
        val original=storeOriginal();val hashA=original.observed("direct_success",value=storeResult(original))
        val hashB=original.observed("direct_success",value=storeResult(original)+mapOf("active" to false))
        val malformed=original.observed("direct_success")
        for(held in listOf(malformed,original.copy(observations=hashA.observations+hashB.observations))) {
            val restored=StorePurchaseJournal.restore(held.wire(),storeOrigin);val f=StoreEngine(restored)
            check((runCatching { f.engine.run(restored,false) }.exceptionOrNull() as? LiveFailure)?.code=="store_operation_receipt_invalid")
            check(f.dispatches==0 && f.held.receipt==null && !f.held.retired)
        }
        val invalid=hashA.wire()+mapOf("observations" to listOf(hashA.observations.single()+mapOf("response_sha256" to "not-a-digest")))
        check(runCatching { StorePurchaseJournal.restore(invalid,storeOrigin) }.isFailure)
    }
    case("both repository store entries reject a foreign originating scope before archival") {
        val f=StoreRepositoryFixture(storeOriginal().terminal());val before=f.vault.value;val repo=f.repository(storeOther)
        val foreign=SessionScope(repo.currentScope().epoch,storeAccount)
        check((runCatching { repo.verifyGooglePurchase(storeProduct,storeOtherToken,true,foreign) }.exceptionOrNull() as? LiveFailure)?.code=="session_changed")
        check((runCatching { repo.recoverGooglePurchase(foreign) }.exceptionOrNull() as? LiveFailure)?.code=="session_changed")
        check(f.calls.isEmpty() && f.vault.value==before)
    }
    case("repository mutex wait cannot reuse a prior session verification permission") {
        val original=storeOriginal().let { it.copy(receipt=storeReceipt(it)) };val f=StoreRepositoryFixture(original)
        f.terminal.clear();f.receipts[original.key]=original.receipt!!
        val repo=f.repository();val captured=repo.currentScope()
        val entered=CountDownLatch(1);val release=CountDownLatch(1)
        f.afterLookup={ entered.countDown();check(release.await(5,TimeUnit.SECONDS)) }
        val running=async(Dispatchers.Default) { runCatching { repo.verifyGooglePurchase(storeProduct,storeToken,expectedScope=captured) } }
        check(withContext(Dispatchers.IO) { entered.await(5,TimeUnit.SECONDS) })
        val verifyQueued=CompletableDeferred<Unit>();val recoverQueued=CompletableDeferred<Unit>()
        val queued=async(Dispatchers.Default) { verifyQueued.complete(Unit);runCatching { repo.verifyGooglePurchase(storeProduct,storeToken,true,captured) } }
        val recovery=async(Dispatchers.Default) { recoverQueued.complete(Unit);runCatching { repo.recoverGooglePurchase(captured) } }
        verifyQueued.await();recoverQueued.await();repo.fence.switch(storeAccount);release.countDown()
        withTimeout(5000) {
            check(running.await().isFailure)
            check((queued.await().exceptionOrNull() as? LiveFailure)?.code=="session_changed")
            check((recovery.await().exceptionOrNull() as? LiveFailure)?.code=="session_changed")
        }
        check(f.calls.size==1 && f.dispatches().isEmpty() && f.record().key==storeKey)
    }
    case("Play restore SDK wait retains its original account and session epoch") {
        for(next in listOf(storeAccount,storeOther)) {
            FakePlay.reset();FakePlay.holdQueries=true
            val f=StoreRepositoryFixture(storeOriginal().terminal());val repo=f.repository();val grants=AtomicInteger()
            val billing=PlayPurchases(StoreContext(),repo,Dispatchers.Unconfined) { grants.incrementAndGet() }
            billing.restore();settled { FakePlay.pendingQueries()==1 }
            val held=f.vault.value;repo.fence.switch(next)
            FakePlay.completeQuery(listOf(sdkPurchase(owner=next,token=if(next==storeOther)storeOtherToken else storeToken)))
            settled { !billing.busy }
            check(f.vault.value==held && f.dispatches().isEmpty() && grants.get()==0 && FakePlay.sheets==0)
            billing.dispose()
        }
    }
    case("Play restore waiting for verification cannot spend permission after an A B A session switch") {
        FakePlay.reset();FakePlay.holdQueries=true
        val original=storeOriginal().let { it.copy(receipt=storeReceipt(it)) };val f=StoreRepositoryFixture(original)
        f.terminal.clear();f.receipts[original.key]=original.receipt!!
        val other=StorePurchaseJournal.create(storeOrigin,storeAccount,storeProduct,"same-account-other-play-token-0002","android-store-terminal-0002").terminal()
        f.vault.value=f.vault.value+mapOf("google_store_history" to listOf(other.wire()))
        val repo=f.repository();val entered=CompletableDeferred<Unit>();val release=CompletableDeferred<Unit>();val callbacks=AtomicInteger()
        val billing=PlayPurchases(StoreContext(),repo,Dispatchers.Unconfined) {
            callbacks.incrementAndGet();entered.complete(Unit);release.await()
        }
        billing.load();settled { !billing.busy };FakePlay.emit(listOf(sdkPurchase()))
        withTimeout(5000) { entered.await() }
        billing.restore();settled { FakePlay.pendingQueries()==1 }
        FakePlay.completeQuery(listOf(sdkPurchase(token="same-account-other-play-token-0002")))
        check(billing.busy) // The actual verifier still holds its mutex at the callback above.
        repo.fence.switch(storeOther);repo.fence.switch(storeAccount);release.complete(Unit)
        settled { !billing.busy }
        check(f.dispatches().isEmpty() && callbacks.get()==1 && f.record().key==original.key && f.history().single().key==other.key)
        check(FakePlay.sheets==0);billing.dispose()
    }
    case("account activation preserves pending terminal and confirmed work across A B A") {
        for(first in listOf(storeOriginal(),storeOriginal().terminal(),storeOriginal().let { it.copy(receipt=storeReceipt(it)) })) {
            val f=StoreRepositoryFixture(first);f.terminal.clear();first.receipt?.let { f.receipts[first.key]=it }
            check(f.repository(storeOther).verifyGooglePurchase(storeProduct,storeOtherToken)["active"]==true)
            val other=f.record();check(other.account==storeOther && other.key!=first.key && f.history().single()==first)
            val returned=runCatching { f.repository().recoverGooglePurchase() }
            if(first.retired)check((returned.exceptionOrNull() as? LiveFailure)?.code=="operation_recovered_without_result")
            else if(first.receipt==null)check((returned.exceptionOrNull() as? LiveFailure)?.code=="store_operation_requires_status")
            else check(returned.isSuccess && returned.getOrNull()==null)
            check(f.record().key==first.key && f.record().account==storeAccount && f.dispatches().size==1)
            check(f.history().any { it.key==other.key && it.receipt==other.receipt })
        }
    }
    case("foreign legacy and terminal write uncertainty archive together without resurrecting credentials") {
        val original=storeOriginal();val f=StoreRepositoryFixture(legacy=true)
        f.vault.value=f.vault.value+mapOf("google_store_write_uncertainty" to original.terminal().wire())
        check(f.repository(storeOther).verifyGooglePurchase(storeProduct,storeOtherToken)["active"]==true)
        val archived=f.history().single();check(archived==original.terminal() && archived.token==null && f.vault.value["pending"]==null && f.vault.value["google_store_write_uncertainty"]==null)
        check(!NativeProtocol.canonical(f.vault.value).contains(storeToken))
        check((runCatching { f.repository().recoverGooglePurchase() }.exceptionOrNull() as? LiveFailure)?.code=="operation_recovered_without_result")
        check(f.dispatches().size==1 && f.record().key==storeKey && f.record().token==null)
    }
    case("foreign legacy pending credential becomes exact read-only account history") {
        val f=StoreRepositoryFixture(legacy=true);f.terminal.clear()
        check(f.repository(storeOther).verifyGooglePurchase(storeProduct,storeOtherToken)["active"]==true)
        check(f.history().single()==storeOriginal() && f.vault.value["pending"]==null)
        check((runCatching { f.repository().recoverGooglePurchase() }.exceptionOrNull() as? LiveFailure)?.code=="store_operation_requires_status")
        check(f.record().key==storeKey && f.record().token==storeToken && f.dispatches().size==1)
    }
    case("uncertain replacement child remains lookup-only through another account activation") {
        val parent=storeOriginal().terminal();val child=StorePurchaseJournal.create(storeOrigin,storeAccount,storeProduct,storeToken,"android-store-replacement-0002")
        val f=StoreRepositoryFixture(parent);f.terminal.clear()
        f.vault.value=f.vault.value+mapOf("google_store_write_uncertainty" to child.wire(),"google_store_history" to listOf(parent.wire()))
        check(f.repository(storeOther).verifyGooglePurchase(storeProduct,storeOtherToken)["active"]==true)
        check(f.history().any { it==parent } && f.history().any { it==child })
        check((runCatching { f.repository().recoverGooglePurchase() }.exceptionOrNull() as? LiveFailure)?.code=="store_operation_requires_status")
        check(f.record().key==child.key && f.dispatches().size==1 && f.history().any { it==parent })
    }
    case("failed foreign archive cannot create another account operation") {
        val f=StoreRepositoryFixture();val before=f.vault.value;val repo=f.repository(storeOther);f.vault.fail=true
        check((runCatching { repo.verifyGooglePurchase(storeProduct,storeOtherToken) }.exceptionOrNull() as? LiveFailure)?.code=="storage_failed")
        check(f.calls.isEmpty() && f.vault.value==before && repo.saved("google_store_operation")==before["google_store_operation"])
        f.vault.fail=false;check(repo.verifyGooglePurchase(storeProduct,storeOtherToken)["active"]==true && f.dispatches().size==1)
        check(f.history().single()==storeOriginal())
    }
    case("lost foreign archive acknowledgement preserves original work for restart") {
        val f=StoreRepositoryFixture();f.vault.loseArchiveWrite=true
        check((runCatching { f.repository(storeOther).verifyGooglePurchase(storeProduct,storeOtherToken) }.exceptionOrNull() as? LiveFailure)?.code=="storage_ack_lost")
        check(f.calls.isEmpty() && f.vault.value["google_store_operation"]==null && f.history().single()==storeOriginal())
        check(f.repository(storeOther).verifyGooglePurchase(storeProduct,storeOtherToken)["active"]==true && f.dispatches().size==1)
        check(f.history().single()==storeOriginal())
    }
    case("full account archive holds rather than evicting pending or terminal markers") {
        val f=StoreRepositoryFixture()
        val full=(0 until 64).map { index->StorePurchaseJournal.create(storeOrigin,storeAccount,storeProduct,"fixture-history-purchase-token-$index","android-store-history-${index.toString().padStart(4,'0')}").terminal() }
        f.vault.value=f.vault.value+mapOf("google_store_history" to full.map(StorePurchaseJournal::wire));val before=f.vault.value
        check((runCatching { f.repository(storeOther).verifyGooglePurchase(storeProduct,storeOtherToken) }.exceptionOrNull() as? LiveFailure)?.code=="store_operation_evidence_full")
        check(f.calls.isEmpty() && f.vault.value==before && f.history()==full && f.record()==storeOriginal())
    }
    case("foreign contradictory committed uncertainty blocks archival without dropping evidence") {
        val original=storeOriginal();val f=StoreRepositoryFixture(original.copy(receipt=storeReceipt(original)))
        f.vault.value=f.vault.value+mapOf("google_store_write_uncertainty" to original.terminal().wire());val before=f.vault.value
        check((runCatching { f.repository(storeOther).verifyGooglePurchase(storeProduct,storeOtherToken) }.exceptionOrNull() as? LiveFailure)?.code=="store_operation_receipt_invalid")
        check(f.calls.isEmpty() && f.vault.value==before)
    }
    case("terminal recovery minimizes the same operation in current and account history") {
        val f=StoreRepositoryFixture()
        check(f.repository(storeOther).verifyGooglePurchase(storeProduct,storeOtherToken)["active"]==true)
        val other=f.record();check(f.history().single()==storeOriginal())
        check((runCatching { f.repository().recoverGooglePurchase() }.exceptionOrNull() as? LiveFailure)?.code=="operation_recovered_without_result")
        val current=f.record();val archived=f.history().single { it.key==storeKey }
        check(current.key==storeKey && current.retired && current.token==null && archived==current)
        check(!NativeProtocol.canonical(f.vault.value).contains(storeToken) && f.vault.value["google_store_write_uncertainty"]==null)
        check(f.history().single { it.key==other.key }==other && f.dispatches().size==1)
        check((runCatching { f.repository().recoverGooglePurchase() }.exceptionOrNull() as? LiveFailure)?.code=="operation_recovered_without_result")
        check(f.dispatches().size==1 && !NativeProtocol.canonical(f.vault.value).contains(storeToken))
    }
    case("failed same-key terminal history save holds original and safely retries minimization") {
        val f=StoreRepositoryFixture()
        check(f.repository(storeOther).verifyGooglePurchase(storeProduct,storeOtherToken)["active"]==true)
        val other=f.record();val repo=f.repository();f.vault.failTerminal=true
        check((runCatching { repo.recoverGooglePurchase() }.exceptionOrNull() as? LiveFailure)?.code=="store_operation_storage_requires_status")
        check(f.record().key==storeKey && !f.record().retired && f.record().token==storeToken)
        check(f.history().single { it.key==storeKey }.token==storeToken && f.dispatches().size==1)
        f.vault.failTerminal=false
        check((runCatching { repo.recoverGooglePurchase() }.exceptionOrNull() as? LiveFailure)?.code=="operation_recovered_without_result")
        check(f.record().retired && f.history().single { it.key==storeKey }==f.record())
        check(!NativeProtocol.canonical(f.vault.value).contains(storeToken) && f.vault.value["google_store_write_uncertainty"]==null)
        check(f.history().single { it.key==other.key }==other && f.dispatches().size==1)
    }
    case("stronger same-key historical commit rejects terminal despite weaker current record") {
        val original=storeOriginal();val committed=original.copy(receipt=storeReceipt(original));val f=StoreRepositoryFixture(original)
        f.vault.value=f.vault.value+mapOf("google_store_history" to listOf(committed.wire()))
        check((runCatching { f.repository().verifyGooglePurchase(storeProduct,storeToken,allowTerminalReplacement=true) }.exceptionOrNull() as? LiveFailure)?.code=="store_operation_receipt_invalid")
        check(f.record().key==storeKey && !f.record().retired && f.record().receipt==committed.receipt)
        check(f.history().single().key==storeKey && f.history().single().receipt==committed.receipt && !f.history().single().retired)
        check(f.dispatches().isEmpty() && f.calls.single().first=="/me/store-operations")
    }
    println("RESULT total=$checks passed=$checks failed=0")
}
