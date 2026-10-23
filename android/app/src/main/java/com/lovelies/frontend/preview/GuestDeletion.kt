package com.lovelies.frontend.preview

import java.security.SecureRandom
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CancellationException

/** Check the captured epoch and immutable intent under the same monitor used by logout. */
internal fun <T> withGuestDeletionPhase(fence: SessionFence,expected: SessionScope,record: GuestDeletionRecord,
    current: ()->GuestDeletionRecord?,transition: ()->T): T = synchronized(fence) {
    fence.assert(expected)
    record.assertSameIntent(current())
    transition()
}

/** Publish only after the complete encrypted candidate has been durably accepted by the vault. */
internal fun <T> persistGuestDeletionState(candidate: WireObject,write: (WireObject)->Unit,publish: (WireObject)->T): T {
    val staged=candidate.toMap()
    try { write(staged) }
    catch(problem: Exception) { if(problem is CancellationException)throw problem;throw LiveFailure("deletion_storage_unavailable") }
    return publish(staged)
}

/** A narrowly scoped deletion receipt. It never authorizes photos, exports or another account. */
data class GuestDeletionRecord(
    val origin: String,
    val account: String,
    val operationKey: String,
    val statusToken: String,
    val reason: String? = null,
    val receipt: GuestDeletionReceipt? = null,
    val statusUnavailable: Boolean = false
) {
    fun requestBody(): WireObject = mapOf("operation_key" to operationKey,"status_token" to statusToken)+
        (reason?.let { mapOf("reason" to it) } ?: emptyMap())
    fun wire(): WireObject = mapOf("origin" to origin,"account" to account,"operation_key" to operationKey,
        "status_token" to statusToken,"reason" to reason,"receipt" to receipt?.wire(),"status_unavailable" to statusUnavailable)
    fun assertOrigin(currentOrigin: String) {
        if(origin!=currentOrigin)throw LiveFailure("deletion_origin_changed")
    }
    fun assertSameIntent(current: GuestDeletionRecord?) {
        if(current==null || current.origin!=origin || current.account!=account ||
            NativeProtocol.canonical(current.requestBody())!=NativeProtocol.canonical(requestBody()))throw LiveFailure("deletion_scope_changed")
    }
    fun assertOriginalAnonymous(currentAccount: String?,method: String?) {
        if(currentAccount!=account || method!="anonymous")throw LiveFailure("deletion_account_changed")
    }
    fun mayRetry(currentAccount: String?,method: String?) = receipt==null && currentAccount==account && method=="anonymous"
    fun assertResumeAllowed() {
        val current=receipt ?: throw LiveFailure("deletion_requires_status")
        if(statusUnavailable || current.completed || (!current.requestExpired && current.status !in setOf("rejected","cancelled")))
            throw LiveFailure("deletion_cannot_resume")
    }
    fun assertRestartAllowed() {
        if(receipt?.completed!=true)throw LiveFailure("deletion_not_completed")
    }
    fun assertResumedAccount(me: WireObject) {
        if(NativeProtocol.id(me["user_id"])!=account || me["auth_method"]!="anonymous" || me["authenticated"]!=false)
            throw LiveFailure("deletion_account_changed")
    }
    private fun retainedDevice(previous: WireObject): WireObject? = previous["device"]?.let(NativeProtocol::obj)?.takeIf {
        NativeProtocol.id(it["account"])!=account
    }
    fun acceptedStorage(previous: WireObject): WireObject {
        val confirmed=receipt ?: throw LiveFailure("deletion_requires_status")
        val staged=linkedMapOf<String,Any?>("guest_deletion" to wire())
        retainedDevice(previous)?.let { staged["device"]=it }
        previous["enrollment"]?.let {
            val journal=NativeProtocol.obj(it)
            if(!confirmed.completed || NativeProtocol.id(journal["account"])!=account)staged["enrollment"]=journal
        }
        previous["account_recovery"]?.let {
            val journal=NativeProtocol.obj(it)
            if(!confirmed.completed || NativeProtocol.id(journal["account"])!=account)staged["account_recovery"]=journal
        }
        previous["recovery_key_intent"]?.let { if(!confirmed.completed || NativeProtocol.id(NativeProtocol.obj(it)["account"])!=account)staged["recovery_key_intent"]=it }
        previous["face_lifecycle"]?.let { if(!confirmed.completed || NativeProtocol.id(NativeProtocol.obj(it)["account"])!=account)staged["face_lifecycle"]=it }
        previous["retired_face_lifecycles"]?.let { rows ->
            val retained=NativeProtocol.rows(rows,16).filter { !confirmed.completed || NativeProtocol.id(it["account"])!=account }
            if(retained.isNotEmpty())staged["retired_face_lifecycles"]=retained
        }
        previous["retired_device_aliases"]?.let { rows ->
            val retained=NativeProtocol.rows(rows,100).filter { !confirmed.completed || NativeProtocol.id(it["account"])!=account }
            if(retained.isNotEmpty())staged["retired_device_aliases"]=retained
        }
        previous["retired_account_recoveries"]?.let { rows ->
            val retained=NativeProtocol.rows(rows,16).filter { !confirmed.completed || NativeProtocol.id(it["account"])!=account }
            if(retained.isNotEmpty())staged["retired_account_recoveries"]=retained
        }
        if(!confirmed.completed)previous["credentials"]?.let {
            val original=NativeProtocol.obj(it)
            assertOriginalAnonymous(NativeProtocol.id(original["account_id"]),original["auth_method"] as? String)
            staged["credentials"]=original
        }
        return staged
    }
    fun restartStorage(previous: WireObject): WireObject {
        assertRestartAllowed()
        val staged=linkedMapOf<String,Any?>()
        retainedDevice(previous)?.let { staged["device"]=it }
        previous["enrollment"]?.let { if(NativeProtocol.id(NativeProtocol.obj(it)["account"])!=account)staged["enrollment"]=it }
        previous["account_recovery"]?.let { if(NativeProtocol.id(NativeProtocol.obj(it)["account"])!=account)staged["account_recovery"]=it }
        previous["recovery_key_intent"]?.let { if(NativeProtocol.id(NativeProtocol.obj(it)["account"])!=account)staged["recovery_key_intent"]=it }
        previous["face_lifecycle"]?.let { if(NativeProtocol.id(NativeProtocol.obj(it)["account"])!=account)staged["face_lifecycle"]=it }
        previous["retired_face_lifecycles"]?.let { rows ->
            val retained=NativeProtocol.rows(rows,16).filter { NativeProtocol.id(it["account"])!=account }
            if(retained.isNotEmpty())staged["retired_face_lifecycles"]=retained
        }
        previous["retired_device_aliases"]?.let { rows ->
            val retained=NativeProtocol.rows(rows,100).filter { NativeProtocol.id(it["account"])!=account }
            if(retained.isNotEmpty())staged["retired_device_aliases"]=retained
        }
        previous["retired_account_recoveries"]?.let { rows ->
            val retained=NativeProtocol.rows(rows,16).filter { NativeProtocol.id(it["account"])!=account }
            if(retained.isNotEmpty())staged["retired_account_recoveries"]=retained
        }
        return staged
    }
    companion object {
        fun create(origin: String,account: String): GuestDeletionRecord {
            val bytes=ByteArray(32).also { SecureRandom().nextBytes(it) }
            val token=try { "lvd_"+bytes.joinToString("") { "%02x".format(it.toInt() and 255) } } finally { bytes.fill(0) }
            return GuestDeletionRecord(origin,NativeProtocol.id(account),"android-delete-${UUID.randomUUID()}",token)
        }
        fun restore(value: Any?,currentOrigin: String,currentAccount: String?,currentMethod: String?): GuestDeletionRecord {
            val row=NativeProtocol.obj(value)
            val record=GuestDeletionRecord(NativeProtocol.text(row["origin"]),NativeProtocol.id(row["account"]),
                NativeProtocol.text(row["operation_key"],120),NativeProtocol.text(row["status_token"],68),
                row["reason"]?.let { NativeProtocol.text(it) },statusUnavailable=row["status_unavailable"] as? Boolean ?: false)
            record.assertOrigin(currentOrigin)
            if(!Regex("^[A-Za-z0-9._:-]{8,120}$").matches(record.operationKey) ||
                !Regex("^lvd_[0-9a-f]{64}$").matches(record.statusToken) ||
                record.reason?.any { it.code in 0..8 || it.code in 11..12 || it.code in 14..31 }==true)throw LiveFailure("deletion_record_invalid")
            if(currentAccount!=null)record.assertOriginalAnonymous(currentAccount,currentMethod)
            return record.copy(receipt=row["receipt"]?.let { GuestDeletionReceipt.parse(NativeProtocol.obj(it),record) })
        }
    }
}

data class GuestDeletionReceipt(
    val operationKey: String,val requestId: String,val status: String,val createdAt: Long,
    val reviewedAt: Long?,val completedAt: Long?,val failureCode: String?,val expiresAt: Long,
    val requestExpiresAt: Long,val requestExpired: Boolean,val completed: Boolean
) {
    fun wire(): WireObject = mapOf("protocol" to "lovelies-account-deletion-v1","source" to "privacy",
        "operation_key" to operationKey,"privacy_request" to mapOf("id" to requestId,"request_type" to "delete","status" to status,
            "created_at" to date(createdAt),"reviewed_at" to reviewedAt?.let(::date),"completed_at" to completedAt?.let(::date),"failure_code" to failureCode),
        "deletion_status" to mapOf("expires_at" to date(expiresAt)),"request_expires_at" to date(requestExpiresAt),
        "request_expired" to requestExpired,"deletion_completed" to completed)
    val label: String get() = if(requestExpired)"Request expired" else when(status) {
        "pending_approval"->"Awaiting review";"approved"->"Approved";"queued"->"Deletion queued";"processing"->"Deleting account"
        "completed"->"Account deleted";"rejected"->"Request rejected";"failed"->"Deletion could not finish";else->"Request cancelled"
    }
    companion object {
        private val statuses=setOf("pending_approval","approved","queued","processing","completed","rejected","failed","cancelled")
        private fun date(value: Long)=Instant.ofEpochMilli(value).toString()
        private fun time(value: Any?): Long = try { Instant.parse(NativeProtocol.text(value)).toEpochMilli() }
            catch(problem: Exception) { throw LiveFailure("deletion_receipt_invalid") }
        fun parse(value: WireObject,intent: GuestDeletionRecord): GuestDeletionReceipt {
            if(value["protocol"]!="lovelies-account-deletion-v1" || value["source"]!="privacy" ||
                value["operation_key"]!=intent.operationKey)throw LiveFailure("deletion_receipt_scope_changed")
            val row=NativeProtocol.obj(value["privacy_request"])
            if(row["request_type"]!="delete")throw LiveFailure("deletion_receipt_invalid")
            listOf("subject_user_id","subject_id","requested_by").forEach { key ->
                if(row[key]!=null && NativeProtocol.id(row[key])!=intent.account)throw LiveFailure("deletion_account_changed")
            }
            val status=NativeProtocol.text(row["status"])
            if(status !in statuses)throw LiveFailure("deletion_receipt_invalid")
            val completed=value["deletion_completed"] as? Boolean ?: throw LiveFailure("deletion_receipt_invalid")
            val requestExpired=value["request_expired"] as? Boolean ?: throw LiveFailure("deletion_receipt_invalid")
            val created=time(row["created_at"])
            val reviewed=row["reviewed_at"]?.let(::time)
            val finished=row["completed_at"]?.let(::time)
            val receipt=GuestDeletionReceipt(intent.operationKey,NativeProtocol.id(row["id"]),status,created,reviewed,finished,
                row["failure_code"]?.let { NativeProtocol.text(it,200) },time(NativeProtocol.obj(value["deletion_status"])["expires_at"]),
                time(value["request_expires_at"]),requestExpired,completed)
            if(completed!=(status=="completed") || completed!=(finished!=null) ||
                requestExpired && status in setOf("completed","rejected","cancelled") ||
                receipt.expiresAt<=created || receipt.requestExpiresAt<=created || receipt.requestExpiresAt>receipt.expiresAt ||
                reviewed!=null && reviewed<created || finished!=null && finished<created)throw LiveFailure("deletion_receipt_invalid")
            intent.receipt?.let { previous ->
                if(previous.requestId!=receipt.requestId || previous.createdAt!=created || previous.expiresAt!=receipt.expiresAt ||
                    previous.requestExpiresAt!=receipt.requestExpiresAt || previous.completed && !completed)throw LiveFailure("deletion_receipt_scope_changed")
            }
            return receipt
        }
    }
}
