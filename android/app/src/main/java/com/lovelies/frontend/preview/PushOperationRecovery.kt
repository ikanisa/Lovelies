package com.lovelies.frontend.preview

import java.util.UUID

/** Registration/revocation effects use their own account/auth-device journal.
 * Raw tokens remain only in the encrypted unresolved record, never a log/UI. */
internal data class PushOperationJournal(
    val origin:String,val account:String,val device:String,val key:String,val kind:String,
    val target:String?,val token:String?,val tokenHash:String?,val digestInputHash:String,val legacyInputHash:String,
    val receipt:WireObject?=null,val disposition:String?=null,
    val sourceStatus:Int?=null,val sourceCode:String?=null,val observedAt:Long?=null
) {
    val retired get()=disposition=="operation_recovered_without_result"
    val path get()=if(kind=="register")"/me/push-devices" else "/me/push-devices/$target"
    val method get()=if(kind=="register")"POST" else "DELETE"
    val action get()="notification.$path.$method"
    fun payload():WireObject=if(kind=="register")mapOf("operation_key" to key,"platform" to "android","push_token" to (token ?: invalid())) else mapOf("operation_key" to key)
    fun wire():WireObject=mapOf("protocol" to "lovelies-android-push-operation-v1","origin" to origin,"account" to account,"device" to device,
        "key" to key,"kind" to kind,"target" to target,"token" to token,"token_hash" to tokenHash,
        "digest_input_hash" to digestInputHash,"legacy_input_hash" to legacyInputHash,"receipt" to receipt,"disposition" to disposition,
        "source_status" to sourceStatus,"source_code" to sourceCode,"observed_at" to observedAt)
    fun assertOwner(origin:String,account:String,device:String) { if(this.origin!=origin || this.account!=account || this.device!=device)throw LiveFailure("push_operation_scope_changed",409,true) }
    fun resolved(value:WireObject):PushOperationJournal { if(retired)invalid();PushOperationProtocol.receipt(value,this) ?: invalid();return copy(token=null,receipt=value) }
    fun retiredWithoutResult(problem:LiveFailure=LiveFailure("operation_recovered_without_result",409)):PushOperationJournal {
        if(receipt!=null || !OperationRetirement.isTerminal(problem))invalid()
        return copy(token=null,disposition="operation_recovered_without_result",sourceStatus=sourceStatus ?: problem.status,
            sourceCode=sourceCode ?: problem.code,observedAt=observedAt ?: System.currentTimeMillis())
    }
    companion object {
        private fun invalid():Nothing=throw LiveFailure("push_operation_receipt_invalid",503,true)
        private fun hash(action:String,payload:WireObject)=NativeProtocol.sha256(NativeProtocol.canonical(mapOf("action" to action,"source" to "notification","payload" to payload)).toByteArray(Charsets.UTF_8))
        fun create(origin:String,account:String,device:String,token:String?=null,target:String?=null,key:String="android-push-${UUID.randomUUID()}"):PushOperationJournal {
            if((token==null)==(target==null) || origin.isBlank() || !Regex("^[A-Za-z0-9._:-]{16,128}$").matches(key))invalid()
            val kind=if(token!=null)"register" else "remove"
            val id=target?.let(NativeProtocol::id)
            if(token!=null && (token.length !in 16..4096 || token.any(Char::isWhitespace) || key.contains(token)))invalid()
            val action="notification."+(if(token!=null)"/me/push-devices.POST" else "/me/push-devices/$id.DELETE")
            val tokenHash=token?.let { NativeProtocol.sha256(it.toByteArray(Charsets.UTF_8)) }
            val legacy=if(token!=null)mapOf("operation_key" to key,"platform" to "android","push_token" to token) else mapOf("operation_key" to key,"device_id" to id)
            val digest=if(token!=null)mapOf("protocol" to "lovelies-push-registration-receipt-v1","operation_key" to key,"platform" to "android","push_token_sha256" to tokenHash) else legacy
            return PushOperationJournal(origin,NativeProtocol.id(account),NativeProtocol.id(device),key,kind,id,token,tokenHash,hash(action,digest),hash(action,legacy))
        }
        fun restore(raw:Any?,origin:String):PushOperationJournal {
            val row=NativeProtocol.obj(raw)
            if(row["protocol"]=="lovelies-android-push-intent-v1") {
                if(row.keys!=setOf("protocol","origin","account","device","operation_key","token","removal") || row["origin"]!=origin)invalid()
                return create(origin,NativeProtocol.id(row["account"]),NativeProtocol.id(row["device"]),
                    row["token"]?.let { NativeProtocol.text(it,4096) },row["removal"]?.let(NativeProtocol::id),NativeProtocol.text(row["operation_key"],128))
            }
            val fields=setOf("protocol","origin","account","device","key","kind","target","token","token_hash","digest_input_hash","legacy_input_hash","receipt")
            if(row.keys !in setOf(fields,fields+"disposition",fields+setOf("disposition","source_status","source_code","observed_at")) ||
                row["protocol"]!="lovelies-android-push-operation-v1" || row["origin"]!=origin || row["kind"] !in setOf("register","remove"))invalid()
            val kind=row["kind"] as String
            val token=row["token"]?.let { NativeProtocol.text(it,4096) };val target=row["target"]?.let(NativeProtocol::id)
            val key=NativeProtocol.text(row["key"],128)
            if(!Regex("^[A-Za-z0-9._:-]{16,128}$").matches(key) || kind=="register" && target!=null || kind=="remove" && (target==null || token!=null || row["token_hash"]!=null))invalid()
            val digest=NativeProtocol.text(row["digest_input_hash"],64);val legacy=NativeProtocol.text(row["legacy_input_hash"],64)
            if(!Regex("^[0-9a-f]{64}$").matches(digest) || !Regex("^[0-9a-f]{64}$").matches(legacy))invalid()
            val tokenHash=row["token_hash"]?.let { NativeProtocol.text(it,64) }
            if(kind=="register" && (tokenHash==null || !Regex("^[0-9a-f]{64}$").matches(tokenHash)))invalid()
            val receipt=row["receipt"]?.let(NativeProtocol::obj)
            val disposition=row["disposition"]?.let { NativeProtocol.text(it,100) }
            if(disposition!=null && (disposition!="operation_recovered_without_result" || token!=null || receipt!=null))invalid()
            val sourceStatus=row["source_status"]?.let { NativeProtocol.integer(it,400,599).toInt() }
            val sourceCode=row["source_code"]?.let { NativeProtocol.text(it,100) }
            val observedAt=row["observed_at"]?.let { NativeProtocol.integer(it,1) }
            if(listOf(sourceStatus,sourceCode,observedAt).any { it!=null } && (disposition==null || sourceStatus==null || sourceCode==null || observedAt==null || !OperationRetirement.isTerminal(LiveFailure(sourceCode,sourceStatus))))invalid()
            val held=PushOperationJournal(origin,NativeProtocol.id(row["account"]),NativeProtocol.id(row["device"]),key,kind,target,token,tokenHash,digest,legacy,receipt,disposition,sourceStatus,sourceCode,observedAt)
            if(token!=null || kind=="remove") {
                val expected=create(origin,held.account,held.device,token,target,key)
                if(expected.digestInputHash!=digest || expected.legacyInputHash!=legacy || expected.tokenHash!=tokenHash)invalid()
            } else {
                if(receipt==null && !held.retired)invalid()
                val exact=mapOf("protocol" to "lovelies-push-registration-receipt-v1","operation_key" to key,"platform" to "android","push_token_sha256" to tokenHash)
                if(hash(held.action,exact)!=digest)invalid()
            }
            if(receipt!=null && PushOperationProtocol.receipt(receipt,held)==null)invalid()
            return held
        }
    }
}

internal object PushOperationProtocol {
    private fun invalid():Nothing=throw LiveFailure("push_operation_receipt_invalid",503,true)
    fun result(value:WireObject,record:PushOperationJournal) {
        val id=runCatching { NativeProtocol.id(value["id"]) }.getOrElse { invalid() }
        if(record.kind=="register") {
            if(value.keys!=setOf("id","platform","active") || value["platform"]!="android" || value["active"]!=true)invalid()
        } else if(value.keys!=setOf("id","active") || value["active"]!=false || id!=record.target)invalid()
    }
    /** Current-device binding is separate from the historical result. A
     * committed registration may already be inactive and cannot be reused. */
    fun receipt(value:WireObject,record:PushOperationJournal):WireObject? {
        if(value["protocol"]!="lovelies-push-operation-receipt-v1" || value["operation_key"]!=record.key)invalid()
        if(value["status"]=="unknown") {
            if(value.keys!=setOf("protocol","operation_key","status"))invalid()
            return null
        }
        if(value.keys!=setOf("protocol","operation_key","status","action","payload_hash","result","current") || value["status"]!="committed" ||
            value["action"]!=record.action || value["payload_hash"] !in setOf(record.digestInputHash,record.legacyInputHash))invalid()
        val result=NativeProtocol.obj(value["result"]);result(result,record)
        val current=NativeProtocol.obj(value["current"])
        if(current.keys!=setOf("id","auth_device_id","platform","active") || NativeProtocol.id(current["id"])!=NativeProtocol.id(result["id"]) ||
            NativeProtocol.id(current["auth_device_id"])!=record.device || current["platform"]!="android")invalid()
        NativeProtocol.integer(current["active"],0,1)
        return result
    }
}

/** Unlike a provider charge/send, device registration is an idempotent local
 * database effect. A typed unknown can retry the exact original key/body under
 * the same current account/device and an explicit registration permission.
 * Permission withdrawal permits lookup/revocation only, never registration. */
internal class PushOperationRecovery(
    private val persist:(PushOperationJournal)->Unit,
    private val assertCurrent:()->Unit,
    private val dispatch:suspend (PushOperationJournal)->WireObject,
    private val lookup:suspend (String)->WireObject
) {
    suspend fun run(original:PushOperationJournal,firstDispatch:Boolean,allowRegistration:()->Boolean):PushOperationJournal {
        assertCurrent()
        fun retire(problem:LiveFailure):Nothing {
            assertCurrent()
            if(original.receipt!=null)throw LiveFailure("push_operation_receipt_changed",503,true)
            persist(original.retiredWithoutResult(problem)) // The original credential is erased only after durable acknowledgment.
            throw LiveFailure("operation_recovered_without_result",409)
        }
        suspend fun observe():WireObject = try { lookup(original.key).also { assertCurrent() } }
        catch(problem:LiveFailure) {
            if(OperationRetirement.isTerminal(problem))retire(problem)
            throw problem
        }
        if(original.retired)retire(LiveFailure("operation_recovered_without_result",409))
        if(!firstDispatch || original.receipt!=null) {
            val observed=observe()
            if(PushOperationProtocol.receipt(observed,original)!=null) {
                val confirmed=original.resolved(observed);persist(confirmed);return confirmed
            }
            if(original.receipt!=null)throw LiveFailure("push_operation_receipt_changed",503,true)
        }
        assertCurrent()
        if(original.kind=="register" && !allowRegistration())throw LiveFailure("push_registration_pending_revocation",503,true)
        var direct:WireObject?=null
        try { direct=dispatch(original);assertCurrent();PushOperationProtocol.result(direct,original) }
        catch(problem:kotlinx.coroutines.CancellationException) { throw problem }
        catch(problem:LiveFailure) {
            if(OperationRetirement.isTerminal(problem))retire(problem)
            if(problem.code=="session_changed" || problem.code=="push_operation_receipt_invalid" || problem.status in setOf(401,403))throw problem
        }
        val observed=observe()
        val result=PushOperationProtocol.receipt(observed,original) ?: throw LiveFailure("push_operation_requires_status",503,true)
        if(direct!=null && NativeProtocol.canonical(direct)!=NativeProtocol.canonical(result))throw LiveFailure("push_operation_receipt_invalid",503,true)
        val confirmed=original.resolved(observed);persist(confirmed);return confirmed
    }
}
