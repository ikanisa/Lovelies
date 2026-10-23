package com.lovelies.frontend.preview

import java.security.SecureRandom
import java.time.Instant
import java.util.Base64
import java.util.UUID

/** Stored only inside SecureSession's encrypted, atomic, no-backup document. */
internal class RefreshDeliveryJournal private constructor(
    val origin: String,val account: String,val method: String,val device: String?,val alias: String?,
    val rotationKey: String,private val originalRefresh: String,private val deliverySecret: String,
    val state: String
) {
    fun wire(): WireObject = mapOf("origin" to origin,"account" to account,"method" to method,
        "device" to device,"alias" to alias,"rotation_key" to rotationKey,"refresh_token" to originalRefresh,
        "delivery_secret" to deliverySecret,"state" to state)
    private fun body(): WireObject = mapOf("protocol" to PROTOCOL,"refresh_token" to originalRefresh,
        "rotation_key" to rotationKey,"delivery_secret" to deliverySecret)
    fun request(): WireObject { if(state!="pending")throw LiveFailure("refresh_delivery_retired");return body() }
    fun cancellationBody(): WireObject { if(state=="pending")throw LiveFailure("refresh_delivery_not_retired");return body() }
    fun assertOriginal(refresh: String) { if(refresh!=originalRefresh)throw LiveFailure("refresh_delivery_scope_changed") }
    fun assertOwner(origin: String,account: String,method: String,device: String?,alias: String?) {
        if(this.origin!=origin || this.account!=account || this.method!=method || this.device!=device || this.alias!=alias)
            throw LiveFailure("refresh_delivery_scope_changed")
    }
    fun assertIntent(current: RefreshDeliveryJournal?) {
        if(current==null || NativeProtocol.canonical(wire())!=NativeProtocol.canonical(current.wire()))
            throw LiveFailure("refresh_delivery_scope_changed")
    }
    fun isSuccessor(value: WireObject)=value["protocol"]==PROTOCOL && value["rotation_key"]==rotationKey
    fun assertSuccessor(value: WireObject,credentialAccount: String,credentialMethod: String,refresh: String,accessExpires: Long) {
        if(state!="pending" || !isSuccessor(value) || value["account_id"]!=account || credentialAccount!=account ||
            credentialMethod!=method || refresh==originalRefresh || value.containsKey("delivery_secret"))throw LiveFailure("refresh_delivery_response_changed")
        val access=absolute(value["access_expires_at"])
        val refreshExpiry=absolute(value["refresh_expires_at"])
        val delivery=absolute(value["delivery_expires_at"])
        // A replay may contain expired access. Never manufacture a new lifetime from expires_in.
        if(access!=accessExpires || refreshExpiry<=access || delivery>refreshExpiry)throw LiveFailure("refresh_delivery_response_changed")
    }
    fun retired(): RefreshDeliveryJournal = copyState(if(state=="cancelled")state else "retired")
    fun cancelled(value: WireObject): RefreshDeliveryJournal {
        if(state=="pending" || value["protocol"]!=PROTOCOL || value["rotation_key"]!=rotationKey ||
            value["account_id"]!=account || value["status"]!="cancelled" ||
            value.keys!=setOf("protocol","rotation_key","account_id","status"))throw LiveFailure("refresh_delivery_response_changed")
        return copyState("cancelled")
    }
    private fun copyState(value: String)=RefreshDeliveryJournal(origin,account,method,device,alias,rotationKey,originalRefresh,deliverySecret,value)
    override fun toString()="RefreshDeliveryJournal(state=$state, secrets=redacted)"
    companion object {
        const val PROTOCOL="lovelies-refresh-delivery-v1"
        private fun absolute(value: Any?): Long = runCatching { Instant.parse(NativeProtocol.text(value)).toEpochMilli() }
            .getOrElse { throw LiveFailure("refresh_delivery_response_changed") }.also { if(it<=0)throw LiveFailure("refresh_delivery_response_changed") }
        fun create(origin: String,account: String,method: String,refresh: String,device: String?,alias: String?): RefreshDeliveryJournal {
            val bytes=ByteArray(32);SecureRandom().nextBytes(bytes)
            val secret=try { NativeProtocol.base64(bytes) } finally { bytes.fill(0) }
            return restore(mapOf("origin" to origin,"account" to account,"method" to method,"device" to device,"alias" to alias,
                "rotation_key" to UUID.randomUUID().toString(),"refresh_token" to refresh,"delivery_secret" to secret,"state" to "pending"),origin)
        }
        fun restore(value: Any?,origin: String): RefreshDeliveryJournal {
            val row=NativeProtocol.obj(value)
            if(row["origin"]!=origin || row["method"] !in setOf("anonymous","registered_face") || row["state"] !in setOf("pending","retired","cancelled"))
                throw LiveFailure("refresh_delivery_scope_changed")
            val refresh=NativeProtocol.text(row["refresh_token"],200);val secret=NativeProtocol.text(row["delivery_secret"],43)
            val decoded=runCatching { Base64.getUrlDecoder().decode(secret) }.getOrElse { throw LiveFailure("refresh_delivery_storage_unavailable") }
            try { if(decoded.size!=32 || NativeProtocol.base64(decoded)!=secret || !Regex("lvs_[A-Za-z0-9_-]{43}").matches(refresh))
                throw LiveFailure("refresh_delivery_storage_unavailable") } finally { decoded.fill(0) }
            val device=row["device"]?.let(NativeProtocol::id);val alias=row["alias"]?.let { NativeProtocol.text(it,1000) }
            if((device==null)!=(alias==null) || alias?.isBlank()==true)throw LiveFailure("refresh_delivery_scope_changed")
            return RefreshDeliveryJournal(origin,NativeProtocol.id(row["account"]),NativeProtocol.text(row["method"]),device,alias,
                NativeProtocol.id(row["rotation_key"]),refresh,secret,NativeProtocol.text(row["state"]))
        }
    }
}

/** A failed intent write never dispatches; failed dispatch/adoption never retires the original attempt. */
internal fun <T> deliverRefresh(writeIntent: ()->Unit,dispatch: ()->WireObject,
    adoptDurably: (WireObject)->T,retireAfterAdoption: (T)->Unit): T {
    writeIntent()
    val adopted=adoptDurably(dispatch())
    retireAfterAdoption(adopted)
    return adopted
}
