package com.lovelies.frontend.preview

import android.content.Context

/** Narrow injectable local/HTTP boundaries. Production always supplies Android Keystore/AtomicFile and HTTPS transport. */
internal interface RepositoryVault {
    val authorityKey: Any get()=this
    fun load(): WireObject
    fun save(value: WireObject)
    fun loadAuthority(): WireObject?=throw LiveFailure("session_authority_unavailable",503,true)
    fun saveAuthority(value: WireObject): Unit=throw LiveFailure("session_authority_unavailable",503,true)
    fun createDevice(alias: String): WireObject=throw LiveFailure("device_key_unavailable")
    fun deleteDevice(alias: String?) {}
    fun enrollmentAlias(account: String): String=throw LiveFailure("device_key_unavailable")
    fun existingDevice(alias: String): WireObject=throw LiveFailure("device_key_unavailable")
    fun hasEnrollmentKeys(): Boolean=false
    fun hasStagedPhoto(id: String): Boolean=false
    fun hasUnreferencedEnrollmentKeys(known: Set<String>): Boolean=false
    fun recoveryAlias(): String=throw LiveFailure("device_key_unavailable")
    fun removeStagedPhoto(id: String) {}
    fun sign(alias: String,envelope: WireObject): String=throw LiveFailure("device_key_unavailable")
    fun stagePhoto(account: String,batch: String,id: String,bytes: ByteArray) { throw LiveFailure("upload_storage_unavailable") }
    fun stagedPhoto(account: String,batch: String,id: String): ByteArray=throw LiveFailure("upload_source_unavailable")
}
internal class AndroidRepositoryVault(context: Context,endpoint: String): RepositoryVault {
    private val delegate=SecureSession(context,endpoint)
    override val authorityKey: Any=delegate.authorityKey
    override fun load()=delegate.load()
    override fun save(value: WireObject)=delegate.save(value)
    override fun loadAuthority()=delegate.loadAuthority()
    override fun saveAuthority(value: WireObject)=delegate.saveAuthority(value)
    override fun createDevice(alias: String)=delegate.createDevice(alias)
    override fun deleteDevice(alias: String?)=delegate.deleteDevice(alias)
    override fun enrollmentAlias(account: String)=delegate.enrollmentAlias(account)
    override fun existingDevice(alias: String)=delegate.existingDevice(alias)
    override fun hasEnrollmentKeys()=delegate.hasEnrollmentKeys()
    override fun hasStagedPhoto(id: String)=delegate.hasStagedPhoto(id)
    override fun hasUnreferencedEnrollmentKeys(known: Set<String>)=delegate.hasUnreferencedEnrollmentKeys(known)
    override fun recoveryAlias()=delegate.recoveryAlias()
    override fun removeStagedPhoto(id: String)=delegate.removeStagedPhoto(id)
    override fun sign(alias: String,envelope: WireObject)=delegate.sign(alias,envelope)
    override fun stagePhoto(account: String,batch: String,id: String,bytes: ByteArray)=delegate.stagePhoto(account,batch,id,bytes)
    override fun stagedPhoto(account: String,batch: String,id: String)=delegate.stagedPhoto(account,batch,id)
}
internal typealias RepositoryJsonBoundary=(String,SessionScope,String?,String,WireObject?,Int?)->WireObject
internal data class RepositoryBoundary(val vault: RepositoryVault,val json: RepositoryJsonBoundary,
    val initialStorage: WireObject=emptyMap(),val initialSession: LiveCredentials?=null,val initialPending: PendingIntent?=null)

/** Financial recovery evidence has no sign-in or photo-access authority and is not discarded by account cleanup. */
internal object StoreRecoveryRetention {
    val fields=setOf("google_store_operation","google_store_write_uncertainty","google_store_history","completed_registered_deletions","registered_deletion_write_uncertainty","push_operations","push_write_uncertainty","push_terminal_operations","audience_device_renewals","audience_terminal_operations","operation_terminal_operations")
    fun isStore(value: Any?): Boolean {
        val row=value as? Map<*,*> ?: return false
        return row["source"]=="store" || (row["action"] as? String)?.startsWith("store.")==true
            || (row["path"] as? String)?.startsWith("/subscriptions/")==true
    }
    fun pending(value: PendingIntent?): PendingIntent?=value?.takeIf { isStore(it.wire()) }
    /** A retained store intent is evidence, including unknown/mixed shapes; it is never generic dispatch authority. */
    fun restorePending(value: Any?): PendingIntent? {
        if(value==null)return null
        val row=NativeProtocol.obj(value);val action=NativeProtocol.text(row["action"])
        val payload=NativeProtocol.obj(row["payload"])
        val source=if(isStore(row))NativeProtocol.text(row["source"]) else {
            NativeProtocol.validateActionPayload(action,payload);NativeProtocol.operationSource(action,row["source"])
        }
        return PendingIntent(NativeProtocol.id(row["account"]),source,action,NativeProtocol.text(row["key"]),payload,
            row["path"] as? String,row["method"] as? String ?: "POST")
    }
    fun heldPending(previous: WireObject,memory: PendingIntent?): PendingIntent? =
        previous["pending"]?.takeIf(::isStore)?.let(::restorePending) ?: pending(memory)
    fun keep(previous: WireObject,candidate: WireObject): WireObject {
        fun recoveryPending(value:Any?):Boolean = isStore(value) || ((value as? Map<*,*>)?.get("path") as? String)?.let { it=="/me/push-devices" || it.startsWith("/me/push-devices/") }==true
        val retained=previous.filterKeys { it in fields }+
            (previous["pending"]?.takeIf(::recoveryPending)?.let { mapOf("pending" to it) } ?: emptyMap())
        // Preserve exact original bytes/fields; cleanup is not qualified financial disposition.
        return candidate+retained
    }
    fun registeredDeletion(previous: WireObject,origin: String): GuestDeletionRecord? {
        val current=previous["registered_deletion"]?.let { GuestDeletionRecord.restore(it,origin,null,null) }
        val uncertain=previous["registered_deletion_write_uncertainty"]?.let { GuestDeletionRecord.restore(it,origin,null,null) }
        if(current==null)return uncertain
        if(uncertain==null)return current
        current.assertSameIntent(uncertain)
        if(current.receipt?.completed==true && uncertain.receipt?.completed==true && NativeProtocol.canonical(current.receipt.wire())!=NativeProtocol.canonical(uncertain.receipt.wire()))throw LiveFailure("deletion_scope_changed")
        return if(uncertain.receipt?.completed==true)uncertain else current
    }
    fun completedRegistered(record: GuestDeletionRecord,previous: WireObject,keepActive: Boolean): WireObject {
        record.assertRestartAllowed()
        var base=keep(previous,record.restartStorage(previous))
        for(field in listOf("push_operations","push_write_uncertainty","push_terminal_operations","audience_device_renewals","audience_terminal_operations","operation_terminal_operations")) {
            val kept=NativeProtocol.rows(base[field] ?: emptyList<WireObject>(),128).filter { it["account"]!=record.account }
            base=if(kept.isEmpty())base-field else base+mapOf(field to kept)
        }
        if(keepActive)return base+mapOf("registered_deletion" to record.wire())
        val history=NativeProtocol.rows(previous["completed_registered_deletions"] ?: emptyList<WireObject>(),64)
        val found=history.firstOrNull { it["operation_key"]==record.operationKey }
        if(found!=null && NativeProtocol.canonical(found)!=NativeProtocol.canonical(record.wire()))throw LiveFailure("deletion_scope_changed")
        if(found==null && history.size>=64)throw LiveFailure("secure_storage_full")
        return (base-"registered_deletion")+mapOf("completed_registered_deletions" to if(found==null)history+record.wire() else history)
    }
}
