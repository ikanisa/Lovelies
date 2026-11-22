package com.lovelies.frontend.preview

import java.util.UUID

/** An unresolved push operation is evidence, never permission to replay it.
 * New records retain only the token digest; an adopted legacy payload is kept
 * separately until an exact authenticated receipt has been durably consumed. */
internal data class PushOperation(
    val origin: String,val account: String,val device: String,val key: String,
    val kind: String,val tokenHash: String?,val registrationId: String?,val inputHashes: List<String>
) {
    val action get()=if(kind=="register")"notification./me/push-devices.POST" else "notification./me/push-devices/$registrationId.DELETE"
    fun assertOwner(origin: String,account: String,device: String) {
        if(this.origin!=origin || this.account!=account || this.device!=device)throw LiveFailure("push_operation_account_changed",403,true)
    }
    fun wire(): WireObject=mapOf("protocol" to "lovelies-android-push-intent-v1","origin" to origin,"account" to account,
        "device" to device,"operation_key" to key,"kind" to kind,"token_sha256" to tokenHash,"registration_id" to registrationId,"input_hashes" to inputHashes)
    companion object {
        private val hash=Regex("^[0-9a-f]{64}$")
        private fun input(action: String,payload: WireObject)=NativeProtocol.sha256(NativeProtocol.canonical(
            mapOf("action" to action,"source" to "notification","payload" to payload)).toByteArray(Charsets.UTF_8))
        fun registration(origin: String,account: String,device: String,token: String,key: String="android-push-${UUID.randomUUID()}"): PushOperation {
            if(token.length !in 16..4096 || token.any(Char::isWhitespace) || key.contains(token))throw LiveFailure("push_operation_scope_changed",409,true)
            val tokenHash=NativeProtocol.sha256(token.toByteArray(Charsets.UTF_8))
            return checked(origin,account,device,key,"register",tokenHash,null,listOf(input("notification./me/push-devices.POST",
                mapOf("protocol" to "lovelies-push-registration-receipt-v1","operation_key" to key,"platform" to "android","push_token_sha256" to tokenHash))))
        }
        fun removal(origin: String,account: String,device: String,id: String,key: String="android-push-${UUID.randomUUID()}"): PushOperation {
            val registration=NativeProtocol.id(id)
            return checked(origin,account,device,key,"remove",null,registration,listOf(input("notification./me/push-devices/$registration.DELETE",
                mapOf("operation_key" to key,"device_id" to registration))))
        }
        fun legacy(raw: Any?,origin: String,device: String): PushOperation {
            val row=NativeProtocol.obj(raw);val payload=NativeProtocol.obj(row["payload"])
            val account=NativeProtocol.id(row["account"]);val key=NativeProtocol.text(row["key"],128)
            if(row.keys!=setOf("account","source","action","key","payload","path","method") || row["source"]!="notification" || payload["operation_key"]!=key)
                throw LiveFailure("push_operation_scope_changed",409,true)
            if(row["action"]=="notification.push.register" && row["path"]=="/me/push-devices" && row["method"]=="POST" &&
                payload.keys==setOf("platform","push_token","operation_key") && payload["platform"]=="android") {
                val selected=registration(origin,account,device,NativeProtocol.text(payload["push_token"],4096),key)
                return selected.copy(inputHashes=selected.inputHashes+input(selected.action,payload))
            }
            val path=row["path"] as? String
            if(row["action"]=="notification.push.remove" && row["method"]=="DELETE" && payload.keys==setOf("operation_key") &&
                path!=null && path.startsWith("/me/push-devices/")) {
                val id=NativeProtocol.id(path.substringAfterLast('/'))
                if(path=="/me/push-devices/$id")return removal(origin,account,device,id,key)
            }
            throw LiveFailure("push_operation_scope_changed",409,true)
        }
        private fun checked(origin: String,account: String,device: String,key: String,kind: String,tokenHash: String?,registrationId: String?,hashes: List<String>): PushOperation {
            if(origin.isBlank() || !Regex("^[A-Za-z0-9._:-]{16,128}$").matches(key) || kind !in setOf("register","remove") ||
                (kind=="register")!=(tokenHash!=null) || (kind=="remove")!=(registrationId!=null) || tokenHash?.let { !hash.matches(it) }==true ||
                hashes.size !in 1..2 || hashes.distinct().size!=hashes.size || hashes.any { !hash.matches(it) })throw LiveFailure("push_operation_scope_changed",409,true)
            return PushOperation(origin,NativeProtocol.id(account),NativeProtocol.id(device),key,kind,tokenHash,registrationId?.let(NativeProtocol::id),hashes)
        }
        fun restore(raw: Any?,origin: String): PushOperation {
            val row=NativeProtocol.obj(raw)
            if(row.keys!=setOf("protocol","origin","account","device","operation_key","kind","token_sha256","registration_id","input_hashes") ||
                row["protocol"]!="lovelies-android-push-intent-v1" || row["origin"]!=origin)throw LiveFailure("push_operation_scope_changed",409,true)
            val hashes=(row["input_hashes"] as? List<*>)?.map { NativeProtocol.text(it,64) } ?: throw LiveFailure("push_operation_scope_changed",409,true)
            return checked(origin,NativeProtocol.id(row["account"]),NativeProtocol.id(row["device"]),NativeProtocol.text(row["operation_key"],128),
                NativeProtocol.text(row["kind"],16),row["token_sha256"]?.let { NativeProtocol.text(it,64) },row["registration_id"]?.let(NativeProtocol::id),hashes)
        }
        fun retained(storage: WireObject,origin: String): PushOperation? {
            val current=storage["push_operation"]?.let { restore(it,origin) }
            val uncertain=storage["push_operation_uncertainty"]?.let { restore(it,origin) }
            if(current!=null && uncertain!=null && current!=uncertain)throw LiveFailure("push_operation_scope_changed",409,true)
            return current ?: uncertain
        }
    }
}

internal data class PushOperationReceipt(val id: String,val active: Boolean)
internal object PushOperationProtocol {
    private fun invalid(): Nothing=throw LiveFailure("push_operation_receipt_invalid",503,true)
    fun receipt(value: WireObject,operation: PushOperation): PushOperationReceipt? {
        if(value["protocol"]!="lovelies-push-operation-receipt-v1" || value["operation_key"]!=operation.key)invalid()
        if(value["status"]=="unknown") {
            if(value.keys!=setOf("protocol","operation_key","status"))invalid()
            return null
        }
        if(value.keys!=setOf("protocol","operation_key","status","action","payload_hash","result","current") || value["status"]!="committed" ||
            value["action"]!=operation.action || value["payload_hash"] !in operation.inputHashes)invalid()
        val result=NativeProtocol.obj(value["result"]);val current=NativeProtocol.obj(value["current"])
        val id=NativeProtocol.id(result["id"])
        if(current.keys!=setOf("id","auth_device_id","platform","active") || NativeProtocol.id(current["id"])!=id ||
            NativeProtocol.id(current["auth_device_id"])!=operation.device || current["platform"]!="android")invalid()
        val active=NativeProtocol.integer(current["active"],0,1)==1L
        if(operation.kind=="register") {
            if(result.keys!=setOf("id","platform","active") || result["platform"]!="android" || result["active"]!=true)invalid()
        } else if(result.keys!=setOf("id","active") || result["active"]!=false || id!=operation.registrationId)invalid()
        return PushOperationReceipt(id,active)
    }
}

/** Shared by the real Firebase adapter and provider-free JVM tests. A typed
 * lookup runs before rotation; unknown outcomes stop only this push workflow. */
internal class PushRegistrationFlow(
    private val account: String,private val device: String,
    private val assertCurrent: ()->Unit,private val allowed: ()->Boolean,
    private val recover: suspend ()->Unit,private val previous: ()->WireObject?,
    private val token: suspend ()->String,private val register: suspend (String,()->Unit)->Unit,
    private val remove: suspend (String,()->Unit)->Unit,private val disable: ()->Unit
) {
    private fun registrationGuard() { assertCurrent();if(!allowed())throw LiveFailure("push_permission_changed",409,true) }
    private fun ownPrevious(): WireObject?=previous()?.takeIf { it["account"]==account && it["device"]==device }
    suspend fun run() {
        assertCurrent();recover();assertCurrent()
        if(!allowed()) {
            disable()
            ownPrevious()?.let { remove(NativeProtocol.id(it["id"]),assertCurrent);assertCurrent() }
            return
        }
        registrationGuard()
        val currentToken=token()
        registrationGuard()
        val hash=NativeProtocol.sha256(currentToken.toByteArray(Charsets.UTF_8))
        if(ownPrevious()?.get("hash")==hash)return
        // The backend atomically rotates this device/platform. A separate old
        // DELETE creates an avoidable second operation and can erase a successor.
        register(currentToken,::registrationGuard)
        registrationGuard()
    }
}

internal object PushOperationRetention {
    val fields=setOf("push_operation","push_operation_uncertainty","push_operation_legacy")
    fun isLegacy(raw: Any?): Boolean {
        val row=raw as? Map<*,*> ?: return false
        return row["source"]=="notification" && row["action"] in setOf("notification.push.register","notification.push.remove")
    }
    fun keep(previous: WireObject,candidate: WireObject): WireObject {
        val legacy=previous["pending"]?.takeIf(::isLegacy)
        val old=previous["push_operation_legacy"]
        if(legacy!=null && old!=null && legacy!=old)throw LiveFailure("push_operation_scope_changed",409,true)
        return candidate+previous.filterKeys { it in fields }+((old ?: legacy)?.let { mapOf("push_operation_legacy" to it) } ?: emptyMap())
    }
}
