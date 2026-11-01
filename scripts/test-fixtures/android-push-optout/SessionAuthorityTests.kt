package com.lovelies.frontend.preview

import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

private const val authorityOrigin="https://fixture"
private val authorityCredential=mapOf("access_token" to "synthetic-access","refresh_token" to "synthetic-refresh","auth_method" to "registered_face")
private class AuthorityDisk(initial: WireObject=emptyMap()): RepositoryVault {
    @Volatile var snapshot: WireObject=initial
    @Volatile var authority: WireObject?=null
    var beforeSnapshot: (()->Unit)?=null
    var beforeAuthority: (()->Unit)?=null
    var afterAuthority: (()->Unit)?=null
    override fun load()=snapshot
    override fun save(value: WireObject) { beforeSnapshot?.invoke();snapshot=value.toMap() }
    override fun loadAuthority()=authority
    override fun saveAuthority(value: WireObject) { beforeAuthority?.invoke();authority=value.toMap();afterAuthority?.invoke() }
}
private class AuthorityFixture(val disk: AuthorityDisk=AuthorityDisk(),val owner: SessionStorageCoordinator=SessionStorageCoordinator()) {
    val fence=SessionFence(owner.generation)
    val storage=SessionAuthorityStorage(disk,authorityOrigin,owner,fence)
    fun restore()=storage.load()
    fun putCredential() {
        restore();storage.save(mapOf("credentials" to authorityCredential),fence.scope(),true)
        fence.publish(fence.scope(),"account-A")
    }
}
private fun rejected(block:()->Unit): LiveFailure=try { block();error("Expected fail-closed result") } catch(problem: LiveFailure) { problem }
fun runSessionAuthorityChecks(run:(String,()->Unit)->Unit) {
    run("cold-process logout advances the durable generation before loading old credentials") {
        val disk=AuthorityDisk(mapOf("credentials" to authorityCredential,SessionAuthorityStorage.STAMP to mapOf("generation" to 7,"credential_sha256" to SessionAuthorityRecord.fingerprint(authorityCredential))))
        disk.authority=SessionAuthorityRecord(authorityOrigin,7).wire()
        val cold=AuthorityFixture(disk)
        val before=cold.fence.scope();val requested=cold.fence.retire(before)
        val confirmed=cold.storage.persistRetirement(requested,emptyMap())
        check(confirmed.authorityGeneration==8L && confirmed.accountId==null)
        check(NativeProtocol.integer(disk.authority!!["generation"])==8L)
        check(cold.storage.reloadRetired(confirmed)["credentials"]==null)
        check(AuthorityFixture(disk).restore()["credentials"]==null)
    }
    run("retirement publication and independent durability do not wait for a blocked session snapshot") {
        val f=AuthorityFixture();f.putCredential();val old=f.fence.scope()
        val entered=CountDownLatch(1);val release=CountDownLatch(1);val executor=Executors.newFixedThreadPool(2)
        f.disk.beforeSnapshot={ entered.countDown();check(release.await(4,TimeUnit.SECONDS)) }
        try {
            val write=executor.submit<Throwable?> { runCatching { f.storage.save(mapOf("credentials" to authorityCredential,"pending" to mapOf("operation_key" to "original-proof")),old) }.exceptionOrNull() }
            check(entered.await(2,TimeUnit.SECONDS))
            val retired=executor.submit<SessionScope> {
                val next=f.fence.retire(old);f.storage.persistRetirement(next,mapOf("credentials" to authorityCredential));next
            }.get(2,TimeUnit.SECONDS)
            check(retired.accountId==null && rejected { f.fence.assert(old) }.code=="session_changed")
            check(NativeProtocol.integer(f.disk.authority!!["generation"])==1L)
            release.countDown();check((write.get(2,TimeUnit.SECONDS) as? LiveFailure)?.code=="session_changed")
            val restarted=AuthorityFixture(f.disk);val loaded=restarted.restore()
            check(loaded["credentials"]==null && NativeProtocol.obj(loaded["pending"])["operation_key"]=="original-proof")
        } finally { release.countDown();executor.shutdownNow() }
    }
    run("late credential publication must compare the pre-write scope") {
        val f=AuthorityFixture();f.putCredential();val old=f.fence.scope();val retired=f.fence.retire(old)
        f.storage.persistRetirement(retired,mapOf("credentials" to authorityCredential))
        check(rejected { f.fence.publish(old,"account-A") }.code=="session_changed")
        check(rejected { f.storage.assertPublication(retired) }.code=="session_changed")
        check(f.fence.scope().accountId==null)
    }
    run("shared-vault retirement invalidates a background repository immediately") {
        val f=AuthorityFixture();f.putCredential();val other=AuthorityFixture(f.disk,f.owner);other.restore()
        val previous=other.fence.publish(other.fence.scope(),"account-A")
        f.fence.retire();check(other.fence.scope().accountId==null)
        check(rejected { other.fence.assert(previous) }.code=="session_changed")
    }
    run("snapshot compare-and-swap preserves a newer repository's operation evidence") {
        val f=AuthorityFixture();f.putCredential();val other=AuthorityFixture(f.disk,f.owner);val stale=other.restore()
        val next=f.restore()+mapOf("pending" to mapOf("operation_key" to "newer-operation"))
        f.storage.save(next,f.fence.scope())
        check(rejected { other.storage.save(stale+mapOf("pending" to mapOf("operation_key" to "old-operation")),other.fence.scope()) }.code=="secure_storage_changed")
        check(NativeProtocol.obj(f.disk.snapshot["pending"])["operation_key"]=="newer-operation")
    }
    run("lost retirement write acknowledgement still prevents old credentials after restart") {
        val f=AuthorityFixture();f.putCredential();val next=f.fence.retire()
        f.disk.afterAuthority={ throw IOException("lost durable acknowledgement") }
        check(runCatching { f.storage.persistRetirement(next,mapOf("credentials" to authorityCredential)) }.isFailure)
        f.disk.afterAuthority=null
        val restarted=AuthorityFixture(f.disk);check(restarted.restore()["credentials"]==null)
        check(rejected { restarted.storage.assertCredential(authorityCredential) }.code=="session_reauthentication_required")
    }
    run("failed retirement persistence remains unconfirmed and keeps the live gate closed") {
        val f=AuthorityFixture();f.putCredential();val old=f.fence.scope();val next=f.fence.retire()
        f.disk.beforeAuthority={ throw IOException("locked authority file") }
        check(runCatching { f.storage.persistRetirement(next,mapOf("credentials" to authorityCredential)) }.isFailure)
        check(f.fence.scope().accountId==null && rejected { f.fence.assert(old) }.code=="session_changed")
        // A crash before a successful durable write is intentionally not reported as durable sign-out.
    }
    run("a missing authority file after migration cannot be mistaken for a fresh install") {
        val f=AuthorityFixture();f.putCredential();f.disk.authority=null
        check(rejected { AuthorityFixture(f.disk).restore() }.code=="session_authority_unavailable")
    }
    run("a damaged credential stamp fails closed and preserves its original bytes") {
        val f=AuthorityFixture();f.putCredential()
        f.disk.snapshot=f.disk.snapshot+mapOf(SessionAuthorityStorage.STAMP to mapOf("generation" to 0,"credential_sha256" to "0".repeat(64)))
        val before=f.disk.snapshot
        check(rejected { AuthorityFixture(f.disk).restore() }.code=="session_authority_invalid")
        check(before==f.disk.snapshot)
    }
    run("retired challenge and refresh identities cannot adopt an unseen late credential") {
        val f=AuthorityFixture();f.putCredential();val next=f.fence.retire()
        f.storage.persistRetirement(next,mapOf("challenge_id" to "old-challenge","rotation_key" to "old-rotation","credentials" to authorityCredential))
        f.storage.reloadRetired(next)
        val unseen=authorityCredential+mapOf("access_token" to "late-never-published-access","refresh_token" to "late-refresh")
        check(rejected { f.storage.assertResponse(mapOf("challenge_id" to "old-challenge"),unseen,next) }.code=="session_reauthentication_required")
        check(rejected { f.storage.assertResponse(mapOf("rotation_key" to "old-rotation"),unseen,next) }.code=="session_reauthentication_required")
        f.storage.assertResponse(mapOf("challenge_id" to "fresh-challenge"),unseen,next)
    }
    run("retirement preserves unknown generic and upload evidence without reauthorizing it") {
        val raw=mapOf("credentials" to authorityCredential,"pending" to mapOf("unknown_version" to 999,"proof" to "exact-input"),
            "photo_uploads" to mapOf("opaque" to "original"),"enrollment" to mapOf("credential_result" to authorityCredential,"state" to "credentials_pending","enrollment_key" to "original-key"))
        val next=SessionAuthorityStorage.retiredSnapshot(raw)
        check(next["credentials"]==null && next["pending"]==raw["pending"] && next["photo_uploads"]==raw["photo_uploads"])
        check(NativeProtocol.obj(next["enrollment"])["credential_result"]==null && NativeProtocol.obj(next["enrollment"])["enrollment_key"]=="original-key")
    }
    run("an unrelated marker change cannot silently adopt another account credential") {
        val f=AuthorityFixture();f.putCredential();val loaded=f.restore()
        val replacement=authorityCredential+mapOf("access_token" to "independent-account-access")
        check(rejected { f.storage.save(loaded+mapOf("credentials" to replacement),f.fence.scope()) }.code=="session_credential_adoption_required")
        f.storage.save(loaded+mapOf("credentials" to replacement),f.fence.scope(),true)
        check(f.disk.snapshot["credentials"]==replacement)
    }
}
