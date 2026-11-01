package com.lovelies.frontend.preview

import kotlinx.coroutines.runBlocking

private const val account="00000000-0000-4000-8000-000000000201"
private const val other="00000000-0000-4000-8000-000000000202"
private const val request="00000000-0000-4000-8000-000000000203"
private const val origin="https://repository-fixture.invalid"
private class ExportVault:RepositoryVault {
    private var authority:WireObject?=null
    override fun loadAuthority()=authority
    override fun saveAuthority(value:WireObject) { authority=value }

    var value:WireObject=emptyMap();val files=mutableMapOf<String,ByteArray>();var fail=false
    override fun load()=value
    override fun save(value:WireObject) { if(fail)throw LiveFailure("storage_failed");this.value=value }
}
private class PushRepositoryFixture {
    val device="00000000-0000-4000-8000-000000000205"
    val token="synthetic-push-repository-token-000001"
    val original=PushOperationJournal.create(origin,account,device,token=token)
    val vault=ExportVault()
    val terminal=mutableSetOf(original.key)
    val committed=mutableMapOf<String,WireObject>()
    val requests=mutableListOf<Pair<String,WireObject?>>()
    var afterLookup:(()->Unit)?=null
    init { vault.value=mapOf("device" to mapOf("account" to account,"device" to device,"alias" to "fixture-alias","handle" to "fixture-handle"),"push_operations" to listOf(original.wire())) }
    fun receipt(record:PushOperationJournal):WireObject {
        val id=record.target ?: "00000000-0000-4000-8000-000000000206"
        return mapOf("protocol" to "lovelies-push-operation-receipt-v1","operation_key" to record.key,"status" to "committed","action" to record.action,
            "payload_hash" to record.digestInputHash,"result" to if(record.kind=="register")mapOf("id" to id,"platform" to "android","active" to true) else mapOf("id" to id,"active" to false),
            "current" to mapOf("id" to id,"auth_device_id" to device,"platform" to "android","active" to if(record.kind=="register")1 else 0))
    }
    suspend fun create():CloudflareRepository {
        val actor=LiveCredentials(account,"synthetic-session","synthetic-refresh","registered_face",Long.MAX_VALUE/2,emptyMap())
        val repository=CloudflareRepository(origin,RepositoryBoundary(vault=vault,initialSession=actor,initialStorage=vault.value,json={ path,scope,_,method,body,_ ->
            requests+=path to body;check(scope.accountId==account)
            when(path) {
                "/me"->mapOf("user_id" to account,"auth_method" to "registered_face","authenticated" to true)
                "/me/push-operations"->{
                    val key=NativeProtocol.text(body!!["operation_key"]);afterLookup?.invoke()
                    if(key in terminal)throw LiveFailure("operation_recovered_without_result",409)
                    committed[key] ?: mapOf("protocol" to "lovelies-push-operation-receipt-v1","operation_key" to key,"status" to "unknown")
                }
                else->{
                    check(path=="/me/push-devices" && method=="POST" || path.startsWith("/me/push-devices/") && method=="DELETE")
                    val key=NativeProtocol.text(body!!["operation_key"])
                    val record=NativeProtocol.rows(vault.value["push_operations"]).map { PushOperationJournal.restore(it,origin) }.single { it.key==key }
                    check(key !in terminal);val result=receipt(record);committed[key]=result;NativeProtocol.obj(result["result"])
                }
            }
        }))
        repository.bootstrap();return repository
    }
    fun records()=NativeProtocol.rows(vault.value["push_operations"]).map { PushOperationJournal.restore(it,origin) }
    fun dispatches()=requests.filter { it.first=="/me/push-devices" || it.first.startsWith("/me/push-devices/") }
}
fun main()=runBlocking {
    var checks=0
    suspend fun case(name:String,work:suspend ()->Unit) { work();checks++;println("PASS $name") }
    case("terminal restrictive-recovery response removes only the original generic pending body") {
        val vault=ExportVault();val calls=mutableListOf<WireObject>()
        val actor=LiveCredentials(account,"synthetic-session","synthetic-refresh","registered_face",Long.MAX_VALUE/2,emptyMap())
        val repository=CloudflareRepository(origin,RepositoryBoundary(vault=vault,initialSession=actor,json={ _,_,_,_,body,_ ->
            calls+=body!!;throw LiveFailure("operation_recovered_without_result",409)
        }))
        val failure=runCatching { repository.mutate("account.profile.update",mapOf("name" to "Synthetic"),"account",path="/me/profile",method="PATCH") }.exceptionOrNull() as? LiveFailure
        check(failure?.code=="operation_recovered_without_result" && repository.pending==null && repository.saved("pending")==null && calls.size==1)
        val terminal=NativeProtocol.rows(vault.value["operation_terminal_operations"]).single()
        check(terminal["operation_key"]==calls.single()["operation_key"] && terminal["source_status"]==409 && terminal["source_code"]=="operation_recovered_without_result" && "body" !in terminal)
    }
    case("terminal lookup after restart clears pending without replaying the original business action") {
        val vault=ExportVault();val original=PendingIntent(account,"account","account.profile.update","android-original-terminal-key",mapOf("name" to "Synthetic","operation_key" to "android-original-terminal-key"),"/me/profile","PATCH")
        vault.value=mapOf("pending" to original.wire());val paths=mutableListOf<String>()
        val actor=LiveCredentials(account,"synthetic-session","synthetic-refresh","registered_face",Long.MAX_VALUE/2,emptyMap())
        val repository=CloudflareRepository(origin,RepositoryBoundary(vault=vault,initialSession=actor,initialStorage=vault.value,initialPending=original,json={ path,_,_,_,body,_ ->
            paths+=path;check(body?.get("action")=="operation");throw LiveFailure("operation_recovered_without_result",409)
        }))
        check(runCatching { repository.reconcile() }.isFailure && repository.pending==null && paths==listOf("/community/action"))
    }
    case("unknown commit keeps original body and key across explicit retries") {
        val vault=ExportVault();val bodies=mutableListOf<WireObject>()
        val actor=LiveCredentials(account,"synthetic-session","synthetic-refresh","registered_face",Long.MAX_VALUE/2,emptyMap())
        val repository=CloudflareRepository(origin,RepositoryBoundary(vault=vault,initialSession=actor,json={ path,_,_,_,body,_ ->
            if(path=="/community/action")mapOf("status" to "unknown") else { bodies+=body!!;throw LiveFailure("commit_unknown",503,true) }
        }))
        check(runCatching { repository.mutate("account.profile.update",mapOf("name" to "Synthetic"),"account",path="/me/profile",method="PATCH") }.isFailure)
        val original=repository.pending!!;check(runCatching { repository.resumePending() }.isFailure)
        check(repository.pending==original && bodies.size==2 && bodies.distinct().size==1)
    }
    case("failed terminal-body retirement keeps the exact pending operation held locally") {
        val vault=ExportVault();val actor=LiveCredentials(account,"synthetic-session","synthetic-refresh","registered_face",Long.MAX_VALUE/2,emptyMap())
        val repository=CloudflareRepository(origin,RepositoryBoundary(vault=vault,initialSession=actor,json={ _,_,_,_,_,_ ->
            vault.fail=true;throw LiveFailure("operation_recovered_without_result",409)
        }))
        check(runCatching { repository.mutate("account.profile.update",mapOf("name" to "Synthetic"),"account",path="/me/profile",method="PATCH") }.isFailure)
        check(repository.pending!=null && repository.saved("pending")==repository.pending!!.wire() && vault.value["pending"]!=null)
    }
    case("terminal push lookup durably retires raw token and survives an actual repository restart") {
        val f=PushRepositoryFixture();val repository=f.create();repository.reconcilePushOperations { true }
        check(f.records().single().retired && f.records().single().token==null && f.dispatches().isEmpty())
        val lookups=f.requests.count { it.first=="/me/push-operations" }
        f.create().reconcilePushOperations { true }
        check(f.requests.count { it.first=="/me/push-operations" }==lookups && f.dispatches().isEmpty())
    }
    case("one terminal push row cannot block unrelated pending operations or erase another account") {
        val f=PushRepositoryFixture()
        val next=PushOperationJournal.create(origin,account,f.device,token="synthetic-push-repository-token-000002")
        val foreign=PushOperationJournal.create(origin,other,f.device,token="synthetic-foreign-push-token-000003")
        f.vault.value=f.vault.value+mapOf("push_operations" to listOf(f.original.wire(),next.wire(),foreign.wire()))
        f.create().reconcilePushOperations { true }
        check(f.records().single { it.key==f.original.key }.retired && f.records().single { it.key==next.key }.receipt!=null)
        check(f.records().single { it.key==foreign.key }==foreign && f.dispatches().single().second?.get("operation_key")==next.key)
    }
    case("automatic registration retries cannot silently replace a terminal original operation") {
        val f=PushRepositoryFixture();val repository=f.create();repository.reconcilePushOperations { true }
        repeat(2) {
            val failure=runCatching { repository.registerPushToken(f.token,{ true }) }.exceptionOrNull() as? LiveFailure
            check(failure?.code=="operation_recovered_without_result")
        }
        check(f.records().single().key==f.original.key && f.records().single().retired && f.dispatches().isEmpty())
    }
    case("explicit new setting action can replace exactly its retired registration") {
        val f=PushRepositoryFixture();val repository=f.create();repository.reconcilePushOperations { true }
        val result=repository.registerPushToken(f.token,{ true },allowNewAfterTerminal=true)
        check(NativeProtocol.obj(result["result"])["active"]==true && f.dispatches().size==1)
        check(f.records().single().key!=f.original.key && f.records().single().receipt!=null)
        val retained=NativeProtocol.rows(f.vault.value["push_terminal_operations"]).map { PushOperationJournal.restore(it,origin) }.single()
        check(retained.key==f.original.key && retained.retired && retained.token==null && retained.digestInputHash==f.original.digestInputHash)
    }
    case("failed terminal push persistence remains blocked until its exact disposition is durably saved") {
        val f=PushRepositoryFixture();val repository=f.create();f.vault.fail=true
        val first=runCatching { repository.reconcilePushOperations { true } }.exceptionOrNull() as? LiveFailure
        check(first?.code=="push_operation_storage_changed" && f.records().single().token==f.token && !f.records().single().retired)
        check(runCatching { repository.reconcilePushOperations { true } }.isFailure)
        f.vault.fail=false;repository.reconcilePushOperations { true }
        check(f.records().single().retired && f.records().single().token==null && repository.saved("push_write_uncertainty")==null && f.dispatches().isEmpty())
    }
    case("late terminal push response cannot mutate another account generation") {
        val f=PushRepositoryFixture();val repository=f.create();f.afterLookup={ repository.fence.switch(other) }
        check(runCatching { repository.reconcilePushOperations { true } }.isFailure && !f.records().single().retired && f.dispatches().isEmpty())
    }
    case("generic exact 410 preserves negative identity while key conflicts retain pending body") {
        for(problem in listOf(LiveFailure("operation_retired_by_recovery",410),LiveFailure("operation_key_conflict",409))) {
            val vault=ExportVault();val actor=LiveCredentials(account,"synthetic-session","synthetic-refresh","registered_face",Long.MAX_VALUE/2,emptyMap())
            val repository=CloudflareRepository(origin,RepositoryBoundary(vault=vault,initialSession=actor,json={ _,_,_,_,_,_->throw problem }))
            val failure=runCatching { repository.mutate("account.profile.update",mapOf("name" to "Synthetic"),"account",path="/me/profile",method="PATCH") }.exceptionOrNull() as? LiveFailure
            if(problem.status==410) {
                val terminal=NativeProtocol.rows(vault.value["operation_terminal_operations"]).single()
                check(failure?.code=="operation_recovered_without_result" && repository.pending==null && terminal["source_status"]==410 && terminal["source_code"]==problem.code)
            } else check(failure?.code==problem.code && repository.pending!=null && vault.value["operation_terminal_operations"]==null)
        }
    }
    println("RESULT total=$checks passed=$checks failed=0")
}
