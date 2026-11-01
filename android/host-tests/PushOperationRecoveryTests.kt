package com.lovelies.frontend.preview

import kotlinx.coroutines.runBlocking

private const val account="00000000-0000-4000-8000-000000000001"
private const val device="00000000-0000-4000-8000-000000000002"
private const val registration="00000000-0000-4000-8000-000000000003"
private const val origin="https://push-recovery.invalid"
private const val token="synthetic-provider-token-000001"
private fun record()=PushOperationJournal.create(origin,account,device,token=token)
private fun unknown(record:PushOperationJournal)=mapOf("protocol" to "lovelies-push-operation-receipt-v1","operation_key" to record.key,"status" to "unknown")
private fun receipt(record:PushOperationJournal,active:Int=1,legacy:Boolean=false):WireObject {
    val id=record.target ?: registration
    val result=if(record.kind=="register")mapOf("id" to id,"platform" to "android","active" to true) else mapOf("id" to id,"active" to false)
    return mapOf("protocol" to "lovelies-push-operation-receipt-v1","operation_key" to record.key,"status" to "committed","action" to record.action,
        "payload_hash" to if(legacy)record.legacyInputHash else record.digestInputHash,"result" to result,
        "current" to mapOf("id" to id,"auth_device_id" to device,"platform" to "android","active" to active))
}
private class Fixture(val original:PushOperationJournal=record()) {
    var stored=original;var current=true;var committed=false;var calls=0;var lookups=0;var loseBefore=false;var loseAfter=false;var failPersist=false
    var response:WireObject?=null;var afterLookup:(()->Unit)?=null
    var lookupFailure:LiveFailure?=null;var dispatchFailure:LiveFailure?=null
    val requests=mutableListOf<WireObject>()
    val recovery=PushOperationRecovery(
        persist={ if(failPersist)throw LiveFailure("storage_failed");stored=it },
        assertCurrent={ if(!current)throw LiveFailure("session_changed") },
        dispatch={ held -> calls++;requests+=held.payload();dispatchFailure?.let { throw it };if(loseBefore) { loseBefore=false;throw LiveFailure("network",503,true) };committed=true
            if(loseAfter) { loseAfter=false;throw LiveFailure("network",503,true) };NativeProtocol.obj(receipt(held)["result"]) },
        lookup={ key -> check(key==original.key);lookups++;afterLookup?.invoke();lookupFailure?.let { throw it };response ?: if(committed)receipt(original) else unknown(original) }
    )
}
fun main()=runBlocking {
    run {
        val old=mapOf("protocol" to "lovelies-android-push-intent-v1","origin" to origin,"account" to account,"device" to device,
            "operation_key" to "android-push-legacy-key-12345","token" to token,"removal" to null)
        val migrated=PushOperationJournal.restore(old,origin)
        check(migrated.key==old["operation_key"] && migrated.token==token && migrated.account==account && migrated.device==device)
        check(migrated.payload()["operation_key"]==old["operation_key"])
        check(runCatching { PushOperationJournal.restore(old+mapOf("origin" to "https://different.invalid"),origin) }.isFailure)
        check(runCatching { PushOperationJournal.restore(old+mapOf("unexpected" to true),origin) }.isFailure)
    }

    var checks=0
    fun checkCase(name:String,work:()->Unit) { work();checks++;println("PASS $name") }
    suspend fun asyncCase(name:String,work:suspend ()->Unit) { work();checks++;println("PASS $name") }
    checkCase("unresolved original token and exact digest survive vault serialization") {
        val value=record();val restored=PushOperationJournal.restore(value.wire(),origin)
        check(restored==value && restored.payload()["operation_key"]==value.key)
    }
    checkCase("wrong origin and changed original token are rejected") {
        val value=record()
        check(runCatching { PushOperationJournal.restore(value.wire(),"https://other.invalid") }.isFailure)
        check(runCatching { PushOperationJournal.restore(value.wire()+mapOf("token" to "synthetic-replacement-token"),origin) }.isFailure)
    }
    checkCase("typed committed receipt validates both supported persisted input schemes") {
        val value=record();check(PushOperationProtocol.receipt(receipt(value),value)!=null);check(PushOperationProtocol.receipt(receipt(value,legacy=true),value)!=null)
    }
    checkCase("wrong operation action, key, or digest cannot authorize completion") {
        val value=record();for(change in listOf(mapOf("operation_key" to "android-push-wrong-original"),mapOf("action" to "notification./other.POST"),mapOf("payload_hash" to "0".repeat(64)))) {
            check(runCatching { PushOperationProtocol.receipt(receipt(value)+change,value) }.isFailure)
        }
    }
    checkCase("another authentication device cannot adopt a historical registration") {
        val value=record();val current=NativeProtocol.obj(receipt(value)["current"])+mapOf("auth_device_id" to account)
        check(runCatching { PushOperationProtocol.receipt(receipt(value)+mapOf("current" to current),value) }.isFailure)
        check(runCatching { value.assertOwner(origin,device,device) }.isFailure)
    }
    checkCase("historical registration remains distinct from currently inactive device") {
        val value=record();val observed=receipt(value,active=0)
        check(PushOperationProtocol.receipt(observed,value)?.get("active")==true && NativeProtocol.obj(observed["current"])["active"]==0)
    }
    checkCase("removal receipt binds exact device ID") {
        val value=PushOperationJournal.create(origin,account,device,target=registration)
        check(PushOperationProtocol.receipt(receipt(value,active=0),value)!=null)
        check(runCatching { PushOperationProtocol.receipt(receipt(value)+mapOf("result" to mapOf("id" to account,"active" to false)),value) }.isFailure)
    }
    asyncCase("lost registration response recovers from typed receipt without a second POST") {
        val f=Fixture();f.loseAfter=true
        val done=f.recovery.run(f.original,true) { true }
        check(f.calls==1 && f.lookups==1 && done.receipt!=null && done.token==null)
    }
    asyncCase("restart after server commit looks up original key without redispatch") {
        val f=Fixture();f.committed=true
        val done=f.recovery.run(PushOperationJournal.restore(f.stored.wire(),origin),false) { true }
        check(f.calls==0 && done.receipt!=null)
    }
    asyncCase("dropped request before commit retries only original key and exact token") {
        val f=Fixture();f.loseBefore=true
        check(runCatching { f.recovery.run(f.original,true) { true } }.isFailure)
        check(f.stored==f.original)
        val done=f.recovery.run(PushOperationJournal.restore(f.stored.wire(),origin),false) { true }
        check(done.receipt!=null && f.calls==2 && f.requests.distinct().size==1)
    }
    asyncCase("permission withdrawal keeps unresolved registration lookup only") {
        val f=Fixture()
        val error=runCatching { f.recovery.run(f.original,false) { false } }.exceptionOrNull()
        check((error as? LiveFailure)?.code=="push_registration_pending_revocation" && f.calls==0 && f.lookups==1 && f.stored.token==token)
    }
    asyncCase("committed earlier registration can reconcile after opt-out for revocation") {
        val f=Fixture();f.committed=true
        check(f.recovery.run(f.original,false) { false }.receipt!=null && f.calls==0)
    }
    asyncCase("revocation survives restart and may dispatch while opted out") {
        val f=Fixture(PushOperationJournal.create(origin,account,device,target=registration))
        val done=f.recovery.run(f.original,false) { false }
        check(done.receipt!=null && f.calls==1 && f.requests.single()==mapOf("operation_key" to f.original.key))
    }
    asyncCase("authority changes between actor reply and continuation cannot persist success") {
        val f=Fixture();f.committed=true;f.afterLookup={ f.current=false }
        check(runCatching { f.recovery.run(f.original,false) { true } }.isFailure && f.stored.receipt==null && f.calls==0)
    }
    asyncCase("failed receipt write remains unresolved and is not reported as registered") {
        val f=Fixture();f.committed=true;f.failPersist=true
        check(runCatching { f.recovery.run(f.original,false) { true } }.isFailure && f.stored.receipt==null && f.calls==0)
    }
    asyncCase("missing previously committed receipt never replays a retired token") {
        val value=record().let { it.resolved(receipt(it)) };val f=Fixture(value)
        check(runCatching { f.recovery.run(value,false) { true } }.isFailure && f.calls==0)
    }
    checkCase("resolved journal drops raw token and preserves immutable input binding") {
        val value=record();val done=value.resolved(receipt(value))
        val restored=PushOperationJournal.restore(done.wire(),origin)
        check(restored.token==null && restored.tokenHash==value.tokenHash && restored.digestInputHash==value.digestInputHash)
    }
    asyncCase("terminal dispatch durably erases only the original credential and never retries its key") {
        val f=Fixture();f.dispatchFailure=LiveFailure("operation_recovered_without_result",409)
        val failure=runCatching { f.recovery.run(f.original,true) { true } }.exceptionOrNull() as? LiveFailure
        check(failure?.code=="operation_recovered_without_result" && f.stored.retired && f.stored.token==null && f.calls==1 && f.lookups==0)
        val restored=PushOperationJournal.restore(f.stored.wire(),origin)
        check(runCatching { f.recovery.run(restored,false) { true } }.isFailure && f.calls==1 && f.lookups==0)
    }
    asyncCase("terminal exact-key lookup retires an unresolved registration without dispatch") {
        val f=Fixture();f.lookupFailure=LiveFailure("operation_recovered_without_result",409)
        check(runCatching { f.recovery.run(f.original,false) { true } }.isFailure && f.stored.retired && f.calls==0 && f.lookups==1)
    }
    asyncCase("exact 410 replay retirement normalizes only after preserving original source code and hashes") {
        val f=Fixture();f.dispatchFailure=LiveFailure("operation_retired_by_recovery",410)
        val failure=runCatching { f.recovery.run(f.original,true) { true } }.exceptionOrNull() as? LiveFailure
        val restored=PushOperationJournal.restore(f.stored.wire(),origin)
        check(failure?.code=="operation_recovered_without_result" && failure.status==409 && restored.retired && restored.token==null)
        check(restored.sourceStatus==410 && restored.sourceCode=="operation_retired_by_recovery" && restored.observedAt!=null && restored.digestInputHash==f.original.digestInputHash && restored.legacyInputHash==f.original.legacyInputHash)
        check(runCatching { f.recovery.run(restored,false) { true } }.isFailure && f.stored.sourceStatus==410 && f.calls==1 && f.lookups==0)
    }
    asyncCase("410 storage failure preserves original input and never falls through to lookup") {
        val f=Fixture();f.dispatchFailure=LiveFailure("operation_retired_by_recovery",410);f.failPersist=true
        check((runCatching { f.recovery.run(f.original,true) { true } }.exceptionOrNull() as? LiveFailure)?.code=="storage_failed")
        check(f.stored==f.original && f.calls==1 && f.lookups==0)
    }
    asyncCase("failed terminal persistence keeps the original operation unresolved") {
        val f=Fixture();f.lookupFailure=LiveFailure("operation_recovered_without_result",409);f.failPersist=true
        val failure=runCatching { f.recovery.run(f.original,false) { true } }.exceptionOrNull() as? LiveFailure
        check(failure?.code=="storage_failed" && f.stored==f.original && f.calls==0)
    }
    asyncCase("nonterminal status or authority failures cannot erase original push evidence") {
        for(problem in listOf(LiveFailure("operation_recovered_without_result",503),LiveFailure("operation_retired_by_recovery",409),LiveFailure("operation_key_conflict",409),LiveFailure("other_conflict",409),LiveFailure("authentication_required",401))) {
            val f=Fixture();f.lookupFailure=problem
            check(runCatching { f.recovery.run(f.original,false) { true } }.isFailure && f.stored==f.original && f.calls==0)
        }
    }
    asyncCase("late terminal lookup after account retirement cannot persist disposition") {
        val f=Fixture();f.lookupFailure=LiveFailure("operation_recovered_without_result",409);f.afterLookup={ f.current=false }
        check(runCatching { f.recovery.run(f.original,false) { true } }.isFailure && f.stored==f.original && f.calls==0)
    }
    asyncCase("a terminal rollback cannot overwrite previously committed receipt evidence") {
        val original=record().let { it.resolved(receipt(it)) };val f=Fixture(original);f.lookupFailure=LiveFailure("operation_recovered_without_result",409)
        val failure=runCatching { f.recovery.run(original,false) { true } }.exceptionOrNull() as? LiveFailure
        check(failure?.code=="push_operation_receipt_changed" && f.stored==original && f.calls==0)
    }
    checkCase("retired records reject credential resurrection, forged dispositions and altered digest") {
        val retired=record().retiredWithoutResult()
        check(PushOperationJournal.restore(retired.wire(),origin)==retired)
        for(change in listOf(mapOf("token" to token),mapOf("disposition" to "completed"),mapOf("digest_input_hash" to "0".repeat(64)))) {
            check(runCatching { PushOperationJournal.restore(retired.wire()+change,origin) }.isFailure)
        }
        val legacy=record();check(PushOperationJournal.restore(legacy.wire()-setOf("disposition","source_status","source_code","observed_at"),origin)==legacy)
    }
    println("RESULT total=$checks passed=$checks failed=0")
}
