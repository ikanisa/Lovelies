package com.lovelies.frontend.preview

import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import java.util.UUID

/** The unresolved credential stays in the encrypted vault. Proven terminal
 * rollback removes it while retaining the exact original key and input hashes. */
internal data class StorePurchaseJournal(
    val origin: String,val account: String,val key: String,val product: String,val token: String?,
    val receipt: WireObject?=null,val observations: List<WireObject> = emptyList(),val disposition:String?=null,
    val credentialSha256:String=NativeProtocol.sha256((token ?: throw LiveFailure("store_operation_scope_changed",409,true)).toByteArray(Charsets.UTF_8)),
    val retiredLegacyHash:String?=null
) {
    val retired get()=disposition=="operation_recovered_without_result"
    val request: WireObject get() {
        if(retired || token==null)throw LiveFailure("operation_recovered_without_result",409)
        return mapOf("operation_key" to key,"product_id" to product,"purchase_token" to token)
    }
    fun inputHash(scheme: String): String {
        if(scheme=="legacy-raw-v0" && retired)return retiredLegacyHash ?: throw LiveFailure("store_operation_scope_changed",409,true)
        val payload=when(scheme) {
            "legacy-raw-v0"->request
            "digest-v1"->mapOf("protocol" to "lovelies-store-operation-input-v1","operation_key" to key,"product_id" to product,"credential_sha256" to credentialSha256)
            else->throw LiveFailure("store_operation_receipt_invalid",503,true)
        }
        return NativeProtocol.sha256(NativeProtocol.canonical(mapOf("action" to "store.google","source" to "store","payload" to payload)).toByteArray(Charsets.UTF_8))
    }
    fun matches(product: String,token: String)=this.product==product && credentialSha256==NativeProtocol.sha256(token.toByteArray(Charsets.UTF_8))
    fun sameSubject(other:StorePurchaseJournal)=origin==other.origin && account==other.account && product==other.product && credentialSha256==other.credentialSha256
    fun terminal():StorePurchaseJournal {
        if(receipt!=null || observations.any { it["kind"]=="direct_success" })throw LiveFailure("store_operation_receipt_invalid",503,true)
        return copy(token=null,disposition="operation_recovered_without_result",retiredLegacyHash=inputHash("legacy-raw-v0"))
    }
    fun wire(): WireObject=mapOf("protocol" to "lovelies-android-store-intent-v1","origin" to origin,"account" to account,"operation_key" to key,
        "product_id" to product,"purchase_token" to token,"credential_sha256" to credentialSha256,"dispatch_state" to "started",
        "receipt" to receipt,"observations" to observations,"disposition" to disposition,"legacy_input_hash" to inputHash("legacy-raw-v0"))
    fun observed(kind: String,code: String?=null,status: Int?=null,value: WireObject?=null): StorePurchaseJournal {
        val item=mapOf("kind" to kind,"code" to code,"http_status" to status,"response_sha256" to value?.let { NativeProtocol.sha256(NativeProtocol.canonical(it).toByteArray(Charsets.UTF_8)) })
        if(observations.lastOrNull()==item)return this
        if(observations.size>=32)throw LiveFailure("store_operation_evidence_full",503,true)
        return copy(observations=observations+item)
    }
    fun assertOwner(origin: String,account: String) {
        if(this.origin!=origin || this.account!=account)throw LiveFailure("store_operation_account_changed",403,true)
    }
    companion object {
        private fun checked(origin: String,account: String,key: String,product: String,token: String): StorePurchaseJournal {
            if(origin.isBlank() || !Regex("^[A-Za-z0-9._:-]{16,128}$").matches(key) || product.length !in 1..160 || product.any { it.code<=32 }
                || token.length !in 16..4096 || token.any { it.code<=32 } || key.contains(token))throw LiveFailure("store_operation_scope_changed",409,true)
            return StorePurchaseJournal(origin,NativeProtocol.id(account),key,product,token)
        }
        fun create(origin: String,account: String,product: String,token: String,key: String="android-store-${UUID.randomUUID()}")=checked(origin,account,key,product,token)
        fun legacy(intent: PendingIntent,origin: String,account: String): StorePurchaseJournal {
            if(intent.account!=account || intent.action!="store.google" || intent.source!="store" || intent.path!="/subscriptions/google/transactions"
                || intent.method!="POST" || intent.payload.keys!=setOf("product_id","purchase_token","operation_key") || intent.payload["operation_key"]!=intent.key)
                throw LiveFailure("store_operation_scope_changed",409,true)
            return checked(origin,account,intent.key,NativeProtocol.text(intent.payload["product_id"],160),NativeProtocol.text(intent.payload["purchase_token"],4096))
        }
        fun restore(raw: Any?,origin: String): StorePurchaseJournal {
            val row=NativeProtocol.obj(raw)
            val fields=setOf("protocol","origin","account","operation_key","product_id","purchase_token","credential_sha256","dispatch_state","receipt","observations")
            if(row.keys !in setOf(fields,fields+setOf("disposition","legacy_input_hash"))
                || row["protocol"]!="lovelies-android-store-intent-v1" || row["origin"]!=origin || row["dispatch_state"]!="started")throw LiveFailure("store_operation_scope_changed",409,true)
            val disposition=row["disposition"]?.let { NativeProtocol.text(it,100) }
            val journal=if(disposition==null)checked(origin,NativeProtocol.id(row["account"]),NativeProtocol.text(row["operation_key"],128),NativeProtocol.text(row["product_id"],160),NativeProtocol.text(row["purchase_token"],4096)) else {
                val key=NativeProtocol.text(row["operation_key"],128);val product=NativeProtocol.text(row["product_id"],160)
                val digest=NativeProtocol.text(row["credential_sha256"],64);val legacy=NativeProtocol.text(row["legacy_input_hash"],64)
                if(disposition!="operation_recovered_without_result" || row["purchase_token"]!=null || row["receipt"]!=null || origin.isBlank()
                    || !Regex("^[A-Za-z0-9._:-]{16,128}$").matches(key) || product.isBlank() || product.any { it.code<=32 }
                    || !Regex("^[0-9a-f]{64}$").matches(digest) || !Regex("^[0-9a-f]{64}$").matches(legacy))throw LiveFailure("store_operation_scope_changed",409,true)
                StorePurchaseJournal(origin,NativeProtocol.id(row["account"]),key,product,null,disposition=disposition,credentialSha256=digest,retiredLegacyHash=legacy)
            }
            if(row["credential_sha256"]!=journal.credentialSha256)throw LiveFailure("store_operation_scope_changed",409,true)
            if("legacy_input_hash" in row && row["legacy_input_hash"]!=journal.inputHash("legacy-raw-v0"))throw LiveFailure("store_operation_scope_changed",409,true)
            val observations=NativeProtocol.rows(row["observations"],32)
            observations.forEach { item->
                if(item.keys!=setOf("kind","code","http_status","response_sha256") || NativeProtocol.text(item["kind"],60).isBlank())throw LiveFailure("store_operation_scope_changed",409,true)
                item["code"]?.let { NativeProtocol.text(it,160) };item["http_status"]?.let { NativeProtocol.integer(it,0,599) }
                item["response_sha256"]?.let { if(!Regex("^[0-9a-f]{64}$").matches(NativeProtocol.text(it,64)))throw LiveFailure("store_operation_scope_changed",409,true) }
            }
            val receipt=row["receipt"]?.let(NativeProtocol::obj)
            if(journal.retired && observations.any { it["kind"]=="direct_success" || it["kind"]=="commit_confirmed" })throw LiveFailure("store_operation_receipt_invalid",503,true)
            val restored=journal.copy(receipt=receipt,observations=observations)
            if(receipt!=null && StorePurchaseProtocol.receipt(receipt,restored)==null)throw LiveFailure("store_operation_receipt_invalid",503,true)
            return restored
        }
    }
}
internal object StorePurchaseProtocol {
    private val resultKeys=setOf("active","billing_environment","expires_at","financial_eligible","original_transaction_id","product_id","provider","stale","transaction_id")
    private fun invalid(): Nothing=throw LiveFailure("store_operation_receipt_invalid",503,true)
    fun result(value: WireObject,journal: StorePurchaseJournal): WireObject {
        if(journal.retired)invalid()
        if(value.keys!=resultKeys || value["provider"]!="google_play" || value["product_id"]!=journal.product
            || value["original_transaction_id"]!=journal.credentialSha256 || value["active"] !is Boolean || value["stale"] !is Boolean
            || value["financial_eligible"] !is Boolean || value["billing_environment"] !in setOf("production","sandbox")
            || value["financial_eligible"]!=(value["billing_environment"]=="production"))invalid()
        val transaction=value["transaction_id"] as? String ?: invalid()
        if(transaction.length !in 1..160 || transaction.any { it.code<=32 })invalid()
        val date=value["expires_at"] as? String ?: invalid()
        val instant=runCatching { Instant.parse(date) }.getOrElse { invalid() }
        if(DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(instant)!=date)invalid()
        if(journal.token?.let { NativeProtocol.canonical(value).contains(it) }==true)invalid()
        val resultDigest=NativeProtocol.sha256(NativeProtocol.canonical(value).toByteArray(Charsets.UTF_8))
        if(journal.observations.any { it["kind"]=="direct_success" && it["response_sha256"]!=resultDigest })invalid()
        return value
    }
    /** Historical commit evidence; this value never grants a current entitlement. */
    fun receipt(value: WireObject,journal: StorePurchaseJournal): WireObject? {
        if(journal.retired)invalid()
        if(value["protocol"]!="lovelies-store-operation-receipt-v1" || value["actor_id"]!=journal.account || value["operation_key"]!=journal.key)invalid()
        if(value["status"]=="unknown") {
            if(value.keys!=setOf("protocol","actor_id","operation_key","status"))invalid()
            return null
        }
        if(value.keys!=setOf("protocol","actor_id","operation_key","status","action","source","payload_hash","result","input_scheme","credential_sha256","receipt_scope")
            || value["status"]!="committed" || value["action"]!="store.google" || value["source"]!="store" || value["receipt_scope"]!="historical"
            || value["credential_sha256"]!=journal.credentialSha256 || value["payload_hash"]!=journal.inputHash(value["input_scheme"] as? String ?: invalid()))invalid()
        val valueResult=runCatching { NativeProtocol.obj(value["result"]) }.getOrElse { invalid() }
        return result(valueResult,journal)
    }
}

/** A failed AtomicFile acknowledgement must not let later unrelated vault saves erase stronger evidence. */
internal object StorePurchasePersistence {
    fun archived(history: List<StorePurchaseJournal>,record: StorePurchaseJournal)=record.receipt!=null && history.any { item->
        item.origin==record.origin && item.account==record.account && item.key==record.key && item.sameSubject(record)
            && item.receipt==record.receipt && item.observations.containsAll(record.observations)
    }
    fun archive(history: List<StorePurchaseJournal>,completed: StorePurchaseJournal): List<StorePurchaseJournal> {
        if(completed.receipt==null)throw LiveFailure("store_operation_requires_status",503,true)
        val index=history.indexOfFirst { it.key==completed.key }
        if(index>=0) {
            val retained=retained(history[index],completed)!!
            return history.mapIndexed { at,item->if(at==index)retained else item }
        }
        if(history.size>=64)throw LiveFailure("store_operation_evidence_full",503,true)
        return history+completed
    }
    fun uncertainCopy(current: StorePurchaseJournal?,attempted: StorePurchaseJournal): StorePurchaseJournal {
        // A failed replacement write can leave both the prior committed intent and a new unsent marker.
        // Keep both records in separate slots; conflicting identities require reconciliation, never a guessed overwrite.
        if(current==null || current.key!=attempted.key || !current.sameSubject(attempted))return attempted
        return retained(current,attempted)!!
    }
    fun retained(current: StorePurchaseJournal?,uncertain: StorePurchaseJournal?): StorePurchaseJournal? {
        if(current==null)return uncertain
        if(uncertain==null)return current
        if(!current.sameSubject(uncertain))throw LiveFailure("store_operation_storage_changed",503,true)
        if(current.key!=uncertain.key) {
            // A durably retired parent cannot dispatch. Its explicitly admitted
            // replacement marker remains potentially dispatched after a lost write.
            if(current.retired && !uncertain.retired)return uncertain
            throw LiveFailure("store_operation_storage_changed",503,true)
        }
        if(current.retired && uncertain.receipt!=null || uncertain.retired && current.receipt!=null)throw LiveFailure("store_operation_receipt_invalid",503,true)
        if(current.receipt!=null && uncertain.receipt!=null && NativeProtocol.canonical(current.receipt)!=NativeProtocol.canonical(uncertain.receipt))throw LiveFailure("store_operation_receipt_invalid",503,true)
        val observations=(current.observations+uncertain.observations).distinct()
        if(observations.size>32)throw LiveFailure("store_operation_evidence_full",503,true)
        val strongest=if(current.retired)current else if(uncertain.retired)uncertain else current
        if(strongest.retired && observations.any { it["kind"]=="direct_success" || it["kind"]=="commit_confirmed" })throw LiveFailure("store_operation_receipt_invalid",503,true)
        val retained=strongest.copy(receipt=current.receipt ?: uncertain.receipt,observations=observations)
        retained.receipt?.let { StorePurchaseProtocol.receipt(it,retained) }
        return retained
    }
}

/** Kept only for one explicit Restore purchases invocation. The SDK token is
 * represented by a digest; duplicate query rows cannot spend permission twice. */
internal class StoreRestoreAttempt {
    private val claimed=mutableSetOf<Triple<String,String,String>>()
    @Synchronized fun claim(account:String,product:String,token:String):Boolean =
        claimed.add(Triple(NativeProtocol.id(account),product,NativeProtocol.sha256(token.toByteArray(Charsets.UTF_8))))
}

/** Every saved intent is potentially dispatched. Recovery never resubmits its credential. */
internal class StorePurchaseRecovery(
    private val persist: (StorePurchaseJournal)->Unit,
    private val assertCurrent: ()->Unit,
    private val dispatch: suspend (WireObject)->WireObject,
    private val lookup: suspend (WireObject)->WireObject
) {
    private fun safeCode(value: String?)=value?.takeIf { Regex("^[a-z][a-z0-9_]{0,159}$").matches(it) } ?: "store_operation_unavailable"
    suspend fun run(original: StorePurchaseJournal,firstDispatch: Boolean): WireObject {
        var held=original
        fun save(next: StorePurchaseJournal) { assertCurrent();persist(next);held=next }
        var direct: WireObject?=null
        assertCurrent()
        fun terminal(problem:LiveFailure):Nothing {
            save(if(held.retired)held else held.observed("terminal_without_result",problem.code,problem.status).terminal())
            throw LiveFailure("operation_recovered_without_result",409)
        }
        if(held.retired)terminal(LiveFailure("operation_recovered_without_result",409))
        if(firstDispatch) {
            // The repository has already durably saved this exact marker before admitting this one dispatch.
            val response=try { dispatch(held.request).also { assertCurrent() } }
            catch(problem: kotlinx.coroutines.CancellationException) { throw problem }
            catch(problem: Exception) {
                val failure=problem as? LiveFailure
                if(failure!=null && OperationRetirement.isTerminal(failure))terminal(failure)
                save(held.observed("direct_unresolved",safeCode(failure?.code),failure?.status))
                if(failure?.code=="session_changed")throw failure
                null
            }
            if(response!=null) {
                direct=try { StorePurchaseProtocol.result(response,held) }
                catch(problem: LiveFailure) { save(held.observed("direct_rejected",problem.code,problem.status,response));throw problem }
                // A persistence ambiguity stops here. It is never interpreted as a network failure or retried dispatch.
                save(held.observed("direct_success",value=response))
            }
        }
        assertCurrent()
        val response=try { lookup(mapOf("operation_key" to held.key)) }
        catch(problem: kotlinx.coroutines.CancellationException) { throw problem }
        catch(problem: Exception) {
            val failure=problem as? LiveFailure
            if(failure!=null && OperationRetirement.isTerminal(failure))terminal(failure)
            save(held.observed("lookup_unavailable",safeCode(failure?.code),failure?.status))
            throw LiveFailure(safeCode(failure?.code),failure?.status ?: 503,true)
        }
        assertCurrent()
        val result=try { StorePurchaseProtocol.receipt(response,held) }
        catch(problem: LiveFailure) {
            save(held.observed("lookup_rejected",problem.code,problem.status,response));throw problem
        }
        if(result==null) {
            save(held.observed("lookup_unknown",value=response))
            throw LiveFailure("store_operation_requires_status",503,true)
        }
        if(held.receipt!=null && NativeProtocol.canonical(held.receipt)!=NativeProtocol.canonical(response)) {
            save(held.observed("historical_receipt_changed",value=response));throw LiveFailure("store_operation_receipt_invalid",503,true)
        }
        if(direct!=null && NativeProtocol.canonical(direct)!=NativeProtocol.canonical(result)) {
            save(held.observed("direct_receipt_mismatch",value=response));throw LiveFailure("store_operation_receipt_invalid",503,true)
        }
        if(held.receipt==null || NativeProtocol.canonical(held.receipt)!=NativeProtocol.canonical(response))save(held.copy(receipt=response).observed("commit_confirmed",value=response))
        return result
    }
}
