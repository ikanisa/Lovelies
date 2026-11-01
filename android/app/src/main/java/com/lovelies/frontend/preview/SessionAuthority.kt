package com.lovelies.frontend.preview

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicReference

/** A publication scope is one immutable value. It is never protected by a disk-I/O monitor. */
data class SessionScope(val epoch: Long,val accountId: String?,val authorityGeneration: Long=0)
class SessionFence internal constructor(private val retirement: SessionAuthorityClock=SessionAuthorityClock()) {
    private val state=AtomicReference(SessionScope(0,null,retirement.get()))
    fun scope(): SessionScope {
        while(true) {
            val before=state.get();val generation=retirement.get()
            if(before.authorityGeneration==generation)return before
            if(state.compareAndSet(before,SessionScope(Math.addExact(before.epoch,1),null,generation)))continue
        }
    }
    fun assert(scope: SessionScope) { if(scope!=scope())throw LiveFailure("session_changed") }
    fun switch(accountId: String?): SessionScope = publish(scope(),accountId)
    /** Callers must carry the scope from before the network/storage work, never reacquire it after that work. */
    fun publish(expected: SessionScope,accountId: String?): SessionScope {
        if(expected.authorityGeneration!=retirement.get())throw LiveFailure("session_changed")
        val next=SessionScope(Math.addExact(expected.epoch,1),accountId,expected.authorityGeneration)
        if(!state.compareAndSet(expected,next))throw LiveFailure("session_changed")
        assert(next);return next
    }
    /** Immediate, shared with every repository for this vault, and independent of blocked storage. */
    fun retire(expected: SessionScope=scope()): SessionScope {
        assert(expected)
        if(!retirement.compareAndSet(expected.authorityGeneration,Math.addExact(expected.authorityGeneration,1)))throw LiveFailure("session_changed")
        return scope()
    }
}

/** A cold-process retirement is relative to the last durable generation, which
 * may not have been loaded yet. This lock protects only counters, never I/O. */
internal class SessionAuthorityClock {
    @Volatile private var value=0L
    private var restored=false
    private var pending=0L
    fun get()=value
    @Synchronized fun compareAndSet(expected: Long,next: Long): Boolean {
        if(value!=expected)return false
        value=next
        if(!restored)pending=Math.addExact(pending,next-expected)
        return true
    }
    @Synchronized fun restore(generation: Long): Long {
        value=if(restored)maxOf(value,generation) else maxOf(value,Math.addExact(generation,pending))
        pending=0;restored=true;return value
    }
}

internal class SessionStorageCoordinator {
    val snapshots=Any()
    val authority=Any()
    val generation=SessionAuthorityClock()
    companion object {
        private val owners=ConcurrentHashMap<Any,SessionStorageCoordinator>()
        fun forVault(key: Any)=owners.computeIfAbsent(key) { SessionStorageCoordinator() }
    }
}

/** Only hashes and a monotonic generation are kept in the independent encrypted journal.
 * A stale session snapshot cannot replace this file. A missing/damaged journal after migration
 * fails closed; neither a storage exception nor an uncertain write means a fresh installation. */
internal data class SessionAuthorityRecord(val origin: String,val generation: Long,
    val credentials: Set<String> = emptySet(),val challenges: Set<String> = emptySet(),val refreshes: Set<String> = emptySet()) {
    fun wire(): WireObject=mapOf("protocol" to PROTOCOL,"origin" to origin,"generation" to generation,
        "retired_credentials" to credentials.sorted(),"retired_challenges" to challenges.sorted(),"retired_refreshes" to refreshes.sorted())
    fun retire(snapshot: WireObject,next: Long): SessionAuthorityRecord {
        val c=credentials.toMutableSet();val h=challenges.toMutableSet();val r=refreshes.toMutableSet()
        fun visit(value: Any?) {
            when(value) {
                is Map<*,*> -> {
                    val token=value["access_token"] as? String;val refresh=value["refresh_token"] as? String
                    // A retained anonymous enrollment/deletion credential is a narrow recovery
                    // input, not registered product authority. Preserve that existing contract.
                    if(token!=null && refresh!=null && value["auth_method"]!="anonymous")c.add(fingerprint(token,refresh))
                    (value["challenge_id"] as? String)?.let { h.add(hash(it)) }
                    (value["rotation_key"] as? String)?.let { r.add(hash(it)) }
                    value.values.forEach(::visit)
                }
                is List<*> -> value.forEach(::visit)
            }
        }
        visit(snapshot)
        if(c.size>MAX_FACTS || h.size>MAX_FACTS || r.size>MAX_FACTS)throw LiveFailure("session_retirement_storage_full",503,true)
        return copy(generation=maxOf(generation,next),credentials=c,challenges=h,refreshes=r)
    }
    fun permits(value: WireObject): Boolean = fingerprint(value) !in credentials
    fun permitsRequest(body: WireObject?): Boolean = body==null ||
        (body["challenge_id"] as? String)?.let { hash(it) !in challenges }!=false &&
        (body["rotation_key"] as? String)?.let { hash(it) !in refreshes }!=false
    companion object {
        const val PROTOCOL="lovelies-session-authority-v1"
        private const val MAX_FACTS=8192
        fun hash(value: String)=NativeProtocol.sha256(value.toByteArray(Charsets.UTF_8))
        fun fingerprint(token: String,refresh: String)=hash(NativeProtocol.canonical(mapOf("access_token" to token,"refresh_token" to refresh)))
        fun fingerprint(value: WireObject)=fingerprint(NativeProtocol.text(value["access_token"],8192),NativeProtocol.text(value["refresh_token"],200))
        fun parse(value: WireObject,origin: String): SessionAuthorityRecord {
            if(value.keys!=setOf("protocol","origin","generation","retired_credentials","retired_challenges","retired_refreshes") || value["protocol"]!=PROTOCOL || value["origin"]!=origin)throw LiveFailure("session_authority_invalid",503,true)
            fun hashes(key: String): Set<String> {
                val rows=value[key] as? List<*> ?: throw LiveFailure("session_authority_invalid",503,true)
                if(rows.size>MAX_FACTS)throw LiveFailure("session_authority_invalid",503,true)
                return rows.map { item -> NativeProtocol.text(item,64).also { if(!Regex("[0-9a-f]{64}").matches(it))throw LiveFailure("session_authority_invalid",503,true) } }.toSet().also { if(it.size!=rows.size)throw LiveFailure("session_authority_invalid",503,true) }
            }
            return SessionAuthorityRecord(origin,NativeProtocol.integer(value["generation"],0),hashes("retired_credentials"),hashes("retired_challenges"),hashes("retired_refreshes"))
        }
    }
}

/** Snapshot CAS is separate from publication and from the independent retirement file.
 * Every main-vault writer goes through this port, including background transfers and recovery.
 * Exact source snapshots are compared before replacement so another repository's new work is
 * never erased by an older in-memory copy. Failed writes remain unconfirmed; only an exact
 * own-attempt readback can repair the baseline for retaining the caller's unresolved journals. */
internal class SessionAuthorityStorage(private val vault: RepositoryVault,private val origin: String,
    val coordinator: SessionStorageCoordinator,private val fence: SessionFence) {
    private var expectedDisk: WireObject?=null
    private data class UnconfirmedWrite(val scope: SessionScope,val before: String,val attempted: String)
    private var unconfirmedWrite: UnconfirmedWrite?=null
    private var loadedGeneration: Long?=null
    @Volatile private var record: SessionAuthorityRecord?=null
    private fun equal(a: WireObject,b: WireObject)=NativeProtocol.canonical(a)==NativeProtocol.canonical(b)
    private fun authority(allowCreate: Boolean=false): SessionAuthorityRecord = synchronized(coordinator.authority) {
        val raw=vault.loadAuthority()
        var next=if(raw==null) {
            if(!allowCreate)throw LiveFailure("session_authority_unavailable",503,true)
            SessionAuthorityRecord(origin,0).also { vault.saveAuthority(it.wire()) }
        } else SessionAuthorityRecord.parse(raw,origin)
        val current=coordinator.generation.restore(next.generation)
        if(current>next.generation) {
            next=next.copy(generation=current);vault.saveAuthority(next.wire())
            val confirmed=vault.loadAuthority()?.let { SessionAuthorityRecord.parse(it,origin) }
            if(confirmed!=next)throw LiveFailure("session_retirement_unconfirmed",503,true)
        }
        record=next;next
    }
    fun assertCredential(value: WireObject) {
        if(record?.permits(value)==false)throw LiveFailure("session_reauthentication_required",403)
    }
    fun assertLoaded(scope: SessionScope) {
        fence.assert(scope)
        if(loadedGeneration!=scope.authorityGeneration)throw LiveFailure("session_changed")
    }
    fun assertPublication(scope: SessionScope) {
        fence.assert(scope)
        if(loadedGeneration!=null && loadedGeneration!=scope.authorityGeneration)throw LiveFailure("session_changed")
    }
    fun assertResponse(body: WireObject?,value: WireObject,scope: SessionScope) {
        fence.assert(scope)
        val current=authority()
        if(current.generation!=scope.authorityGeneration || !current.permitsRequest(body) || !current.permits(value))throw LiveFailure("session_reauthentication_required",403)
    }
    fun load(): WireObject=synchronized(coordinator.snapshots) {
        val disk=vault.load();val stamp=disk[STAMP]?.let(NativeProtocol::obj)
        val current=authority(allowCreate=stamp==null)
        if(stamp!=null && (stamp.keys!=setOf("generation","credential_sha256") || NativeProtocol.integer(stamp["generation"],0)>current.generation))throw LiveFailure("session_authority_invalid",503,true)
        expectedDisk=disk
        val savedGeneration=stamp?.get("generation")?.let { NativeProtocol.integer(it,0) } ?: 0L
        loadedGeneration=current.generation
        var value=disk-STAMP
        val stored=value["credentials"]?.let(NativeProtocol::obj)
        if(stamp!=null && stamp["credential_sha256"]!=stored?.let(SessionAuthorityRecord::fingerprint))throw LiveFailure("session_authority_invalid",503,true)
        if(savedGeneration<current.generation) {
            // The old writer may have committed after retirement. Capture all late auth evidence
            // before interpreting any journal or considering a replacement credential.
            synchronized(coordinator.authority) {
                val latest=authority().retire(value,current.generation)
                vault.saveAuthority(latest.wire());record=latest
            }
            value=retiredSnapshot(value)
        } else if(stored!=null && !current.permits(stored))value=value-"credentials"
        unconfirmedWrite=null
        value
    }
    fun save(value: WireObject,scope: SessionScope,adoptingCredential: Boolean=false) = synchronized(coordinator.snapshots) {
        fence.assert(scope)
        if(expectedDisk==null) {
            val disk=vault.load();expectedDisk=disk
            val current=authority(allowCreate=disk[STAMP]==null)
            loadedGeneration=current.generation
        }
        var current=authority();fence.assert(scope)
        if(current.generation!=scope.authorityGeneration || loadedGeneration!=scope.authorityGeneration)throw LiveFailure("session_changed")
        var old=expectedDisk!!;val disk=vault.load()
        unconfirmedWrite?.let { held ->
            // A vault may commit before losing its acknowledgement, or fail its first
            // readback. Only this writer's two exact images can reconcile that outcome.
            // This repairs the CAS baseline, never the caller's published state/credentials.
            if(held.scope!=scope || held.scope.authorityGeneration!=current.generation)throw LiveFailure("session_changed")
            val before=NativeProtocol.canonical(old);val observed=NativeProtocol.canonical(disk)
            if((before!=held.before && before!=held.attempted) || (observed!=held.before && observed!=held.attempted))throw LiveFailure("secure_storage_changed",503,true)
            current=authority();fence.assert(scope)
            if(current.generation!=held.scope.authorityGeneration)throw LiveFailure("session_changed")
            expectedDisk=disk;old=disk
        }
        if(!equal(old,disk))throw LiveFailure("secure_storage_changed",503,true)
        val nextCredential=value["credentials"]?.let(NativeProtocol::obj)
        if(nextCredential!=null) {
            if(!current.permits(nextCredential))throw LiveFailure("session_reauthentication_required",403)
            val oldCredential=old["credentials"]?.let(NativeProtocol::obj)
            if(!adoptingCredential && oldCredential?.let(SessionAuthorityRecord::fingerprint)!=SessionAuthorityRecord.fingerprint(nextCredential))throw LiveFailure("session_credential_adoption_required",503,true)
        }
        val candidate=value+mapOf(STAMP to mapOf("generation" to scope.authorityGeneration,"credential_sha256" to nextCredential?.let(SessionAuthorityRecord::fingerprint)))
        // Capture immutable canonical values before entering the potentially ambiguous
        // writer. An exception still propagates unchanged; it never admits publication.
        val attempted=NativeProtocol.canonical(candidate)
        unconfirmedWrite=UnconfirmedWrite(scope,NativeProtocol.canonical(old),attempted)
        vault.save(candidate)
        // A retirement can complete while this write is blocked. Its independent journal wins
        // on restart, and this callback cannot publish or update its in-memory baseline.
        fence.assert(scope)
        if(authority().generation!=scope.authorityGeneration)throw LiveFailure("session_changed")
        val accepted=vault.load()
        if(attempted!=NativeProtocol.canonical(accepted))throw LiveFailure("secure_storage_changed",503,true)
        fence.assert(scope);expectedDisk=accepted;unconfirmedWrite=null
    }
    fun persistRetirement(scope: SessionScope,snapshot: WireObject): SessionScope = synchronized(coordinator.authority) {
            // Only an unloaded durable counter may rebase this ticket. An
            // unrelated later scope still invalidates this writer normally.
            fence.assert(scope)
            val old=authority(allowCreate=true)
            val effective=fence.scope()
            val next=old.retire(snapshot,effective.authorityGeneration)
            vault.saveAuthority(next.wire())
            val read=vault.loadAuthority()?.let { SessionAuthorityRecord.parse(it,origin) }
                ?: throw LiveFailure("session_retirement_unconfirmed",503,true)
            if(read!=next)throw LiveFailure("session_retirement_unconfirmed",503,true)
            fence.assert(effective);record=read;effective
    }
    /** Refresh the exact current bytes after the independent tombstone is confirmed. */
    fun reloadRetired(scope: SessionScope): WireObject {
        fence.assert(scope)
        return load().also { fence.assert(scope) }
    }
    companion object {
        const val STAMP="session_authority"
        fun retiredSnapshot(value: WireObject): WireObject {
            val next=value.toMutableMap()
            val anonymous=(next["credentials"] as? Map<*,*>)?.get("auth_method")=="anonymous"
            val recoveryHeld=next.keys.any { it in setOf("enrollment","account_recovery","guest_deletion","audience_operation","guardian_withdrawal_operation") }
            if(!anonymous || !recoveryHeld)next.remove("credentials")
            next.remove("review");next.remove("ui_context");next.remove("last_outcome")
            // Keep operation identities and status/cancellation evidence. A credential embedded
            // in a promotion journal is not allowed to bypass the retirement generation.
            for(key in listOf("enrollment","account_recovery"))next[key]?.let { raw ->
                val row=NativeProtocol.obj(raw)
                if(row["credential_result"]!=null)next[key]=row+mapOf("credential_result" to null,"state" to "registered")
            }
            next["face_lifecycle"]?.let { raw ->
                val row=NativeProtocol.obj(raw)
                if(row["login_key"]!=null)next["face_lifecycle"]=row+mapOf("state" to "ready","login_key" to null,"challenge" to null,"challenge_id" to null,
                    "planned" to emptyList<Any>(),"accepted" to emptyList<Any>(),"retired" to emptyList<Any>(),"completion" to null,"resume" to null,"credential_result" to null)
                else if(row["credential_result"]!=null) {
                    val metadata=row["metadata"] as? Map<*,*>;val operation=metadata?.get("operation") as? Map<*,*>
                    next["face_lifecycle"]=row+mapOf("credential_result" to null,"state" to if(operation?.get("state")=="completed")"registered" else "verifying")
                }
            }
            next["camera_login"]?.let { raw ->
                // Keep the original uncertain proof in a nonauthorizing archive. A retired
                // challenge is never retried as a new sign-in; the camera starts a fresh one.
                val held=(next["retired_camera_logins"] as? List<*>) ?: emptyList<Any>()
                val row=NativeProtocol.obj(raw);val exact=row+mapOf("credentials" to null)
                val digest=NativeProtocol.sha256(NativeProtocol.canonical(exact).toByteArray())
                if(held.none { NativeProtocol.sha256(NativeProtocol.canonical(it).toByteArray())==digest }) {
                    if(held.size>=256)throw LiveFailure("session_retirement_storage_full",503,true)
                    next["retired_camera_logins"]=held+listOf(exact)
                }
                next.remove("camera_login")
            }
            return next
        }
    }
}
