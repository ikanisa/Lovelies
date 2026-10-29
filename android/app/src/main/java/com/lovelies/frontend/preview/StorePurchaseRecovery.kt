package com.lovelies.frontend.preview

import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import java.util.UUID

/** The original credential stays in the encrypted vault. A lookup returns only its digest. */
internal data class StorePurchaseJournal(
    val origin: String,val account: String,val key: String,val product: String,val token: String,
    val receipt: WireObject?=null,val observations: List<WireObject> = emptyList()
) {
    val credentialSha256 get()=NativeProtocol.sha256(token.toByteArray(Charsets.UTF_8))
    val request: WireObject get()=mapOf("operation_key" to key,"product_id" to product,"purchase_token" to token)
    fun inputHash(scheme: String): String {
        val payload=when(scheme) {
            "legacy-raw-v0"->request
            "digest-v1"->mapOf("protocol" to "lovelies-store-operation-input-v1","operation_key" to key,"product_id" to product,"credential_sha256" to credentialSha256)
            else->throw LiveFailure("store_operation_receipt_invalid",503,true)
        }
        return NativeProtocol.sha256(NativeProtocol.canonical(mapOf("action" to "store.google","source" to "store","payload" to payload)).toByteArray(Charsets.UTF_8))
    }
    fun matches(product: String,token: String)=this.product==product && this.token==token
    fun wire(): WireObject=mapOf("protocol" to "lovelies-android-store-intent-v1","origin" to origin,"account" to account,"operation_key" to key,
        "product_id" to product,"purchase_token" to token,"credential_sha256" to credentialSha256,"dispatch_state" to "started",
        "receipt" to receipt,"observations" to observations)
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
            if(row.keys!=setOf("protocol","origin","account","operation_key","product_id","purchase_token","credential_sha256","dispatch_state","receipt","observations")
                || row["protocol"]!="lovelies-android-store-intent-v1" || row["origin"]!=origin || row["dispatch_state"]!="started")throw LiveFailure("store_operation_scope_changed",409,true)
            val journal=checked(origin,NativeProtocol.id(row["account"]),NativeProtocol.text(row["operation_key"],128),NativeProtocol.text(row["product_id"],160),NativeProtocol.text(row["purchase_token"],4096))
            if(row["credential_sha256"]!=journal.credentialSha256)throw LiveFailure("store_operation_scope_changed",409,true)
            val observations=NativeProtocol.rows(row["observations"],32)
            observations.forEach { item->
                if(item.keys!=setOf("kind","code","http_status","response_sha256") || NativeProtocol.text(item["kind"],60).isBlank())throw LiveFailure("store_operation_scope_changed",409,true)
                item["code"]?.let { NativeProtocol.text(it,160) };item["http_status"]?.let { NativeProtocol.integer(it,0,599) }
                item["response_sha256"]?.let { if(!Regex("^[0-9a-f]{64}$").matches(NativeProtocol.text(it,64)))throw LiveFailure("store_operation_scope_changed",409,true) }
            }
            val receipt=row["receipt"]?.let(NativeProtocol::obj)
            if(receipt!=null && StorePurchaseProtocol.receipt(receipt,journal)==null)throw LiveFailure("store_operation_receipt_invalid",503,true)
            return journal.copy(receipt=receipt,observations=observations)
        }
    }
}
internal object StorePurchaseProtocol {
    private val resultKeys=setOf("active","billing_environment","expires_at","financial_eligible","original_transaction_id","product_id","provider","stale","transaction_id")
    private fun invalid(): Nothing=throw LiveFailure("store_operation_receipt_invalid",503,true)
    fun result(value: WireObject,journal: StorePurchaseJournal): WireObject {
        if(value.keys!=resultKeys || value["provider"]!="google_play" || value["product_id"]!=journal.product
            || value["original_transaction_id"]!=journal.credentialSha256 || value["active"] !is Boolean || value["stale"] !is Boolean
            || value["financial_eligible"] !is Boolean || value["billing_environment"] !in setOf("production","sandbox")
            || value["financial_eligible"]!=(value["billing_environment"]=="production"))invalid()
        val transaction=value["transaction_id"] as? String ?: invalid()
        if(transaction.length !in 1..160 || transaction.any { it.code<=32 })invalid()
        val date=value["expires_at"] as? String ?: invalid()
        val instant=runCatching { Instant.parse(date) }.getOrElse { invalid() }
        if(DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(instant)!=date)invalid()
        if(NativeProtocol.canonical(value).contains(journal.token))invalid()
        return value
    }
    /** Historical commit evidence; this value never grants a current entitlement. */
    fun receipt(value: WireObject,journal: StorePurchaseJournal): WireObject? {
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
    fun uncertainCopy(current: StorePurchaseJournal?,attempted: StorePurchaseJournal): StorePurchaseJournal {
        // A failed replacement write can leave both the prior committed intent and a new unsent marker.
        // Keep both records in separate slots; conflicting identities require reconciliation, never a guessed overwrite.
        if(current==null || current.origin!=attempted.origin || current.account!=attempted.account || current.key!=attempted.key
            || !current.matches(attempted.product,attempted.token))return attempted
        return retained(current,attempted)!!
    }
    fun retained(current: StorePurchaseJournal?,uncertain: StorePurchaseJournal?): StorePurchaseJournal? {
        if(current==null)return uncertain
        if(uncertain==null)return current
        if(current.origin!=uncertain.origin || current.account!=uncertain.account || current.key!=uncertain.key
            || !current.matches(uncertain.product,uncertain.token))throw LiveFailure("store_operation_storage_changed",503,true)
        if(current.receipt!=null && uncertain.receipt!=null && NativeProtocol.canonical(current.receipt)!=NativeProtocol.canonical(uncertain.receipt))throw LiveFailure("store_operation_receipt_invalid",503,true)
        val observations=(current.observations+uncertain.observations).distinct()
        if(observations.size>32)throw LiveFailure("store_operation_evidence_full",503,true)
        return current.copy(receipt=current.receipt ?: uncertain.receipt,observations=observations)
    }
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
        if(firstDispatch) {
            // The repository has already durably saved this exact marker before admitting this one dispatch.
            val response=try { dispatch(held.request).also { assertCurrent() } }
            catch(problem: kotlinx.coroutines.CancellationException) { throw problem }
            catch(problem: Exception) {
                val failure=problem as? LiveFailure
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
