package com.lovelies.frontend.preview
import android.content.Context
import android.content.FakeSystem
import com.google.firebase.messaging.FakeFirebase
import kotlinx.coroutines.runBlocking

// Actual PushMessaging.kt and NativeProtocol.kt, linked to synthetic fakes.
private val registrationID="00000000-0000-4000-8000-000000000082"
private fun setup(enabled:Boolean):Pair<Context,CloudflareRepository> {
    FakeSystem.reset();val c=Context();PushConfiguration.setOptedIn(c,enabled);return c to CloudflareRepository()
}
private fun test(name:String,body:()->Unit):Boolean=try { body();println("PASS $name");true } catch(e:Throwable){println("FAIL $name: ${e.message}");false}
fun main() {
    var total=0;var failed=0
    fun run(name:String,body:()->Unit){total++;if(!test(name,body))failed++}
    run("explicit opt-out is saved even if the registered session is absent") {
        val (c,repo)=setup(true);repo.credentials=null
        runBlocking { PushRegistration(c,repo).sync(false) }
        check(!PushConfiguration.optedIn(c) && repo.mutations.isEmpty())
        check(!FakeFirebase.autoInit && FakeFirebase.setAttempts==1)
    }
    run("absent-session preference write failure is surfaced") {
        val (c,repo)=setup(true);repo.credentials=null;FakeSystem.commitResult=false
        val error=runBlocking { runCatching { PushRegistration(c,repo).sync(false) }.exceptionOrNull() }
        check((error as? LiveFailure)?.code=="push_preference_unavailable" && !FakeFirebase.autoInit && FakeFirebase.setAttempts==1)
        check(repo.mutations.isEmpty())
    }
    run("temporary absent-session sync without an explicit change preserves preference") {
        val (c,repo)=setup(true);repo.credentials=null
        runBlocking { PushRegistration(c,repo).sync() }
        check(PushConfiguration.optedIn(c) && repo.mutations.isEmpty())
    }
    run("enabling without registered credentials reports the missing session") {
        val (c,repo)=setup(false);repo.credentials=null
        val error=runBlocking { runCatching { PushRegistration(c,repo).sync(true) }.exceptionOrNull() }
        check((error as? LiveFailure)?.code=="registered_face_required")
        check(!PushConfiguration.optedIn(c) && repo.mutations.isEmpty() && FakeFirebase.setAttempts==0)
    }
    run("enabling from an anonymous session reports the missing registered session") {
        val (c,repo)=setup(false);repo.credentials=Credentials(repo.credentials!!.account,"anonymous")
        val error=runBlocking { runCatching { PushRegistration(c,repo).sync(true) }.exceptionOrNull() }
        check((error as? LiveFailure)?.code=="registered_face_required")
        check(!PushConfiguration.optedIn(c) && repo.mutations.isEmpty() && FakeFirebase.setAttempts==0)
    }
    run("failed opt-in preference commit is surfaced before provider or backend work") {
        val (c,repo)=setup(false);FakeSystem.commitResult=false;FakeFirebase.initialized=false
        val error=runBlocking { runCatching { PushRegistration(c,repo).sync(true) }.exceptionOrNull() }
        check((error as? LiveFailure)?.code=="push_preference_unavailable")
        check(!PushConfiguration.optedIn(c) && FakeFirebase.initializations==0 && FakeFirebase.setAttempts==0 && repo.mutations.isEmpty())
    }
    run("exception saving opt-in is surfaced before provider or backend work") {
        val (c,repo)=setup(false);FakeSystem.commitThrows=true;FakeFirebase.initialized=false
        val error=runBlocking { runCatching { PushRegistration(c,repo).sync(true) }.exceptionOrNull() }
        check((error as? LiveFailure)?.code=="push_preference_unavailable")
        check(!PushConfiguration.optedIn(c) && FakeFirebase.initializations==0 && FakeFirebase.setAttempts==0 && repo.mutations.isEmpty())
    }
    run("a later successful opt-in clears the process-local failure fence") {
        val (c,repo)=setup(false);FakeSystem.commitResult=false
        val error=runBlocking { runCatching { PushRegistration(c,repo).sync(true) }.exceptionOrNull() }
        check((error as? LiveFailure)?.code=="push_preference_unavailable" && !PushConfiguration.optedIn(c))
        FakeSystem.commitResult=true
        val previous=mapOf("account" to repo.credentials!!.account,"id" to registrationID,"device" to repo.identity!!.device,"hash" to NativeProtocol.sha256(FakeFirebase.token.toByteArray()))
        repo.registration=previous;FakeFirebase.autoInit=false
        runBlocking { PushRegistration(c,repo).sync(true) }
        check(PushConfiguration.optedIn(c) && FakeFirebase.autoInit && repo.registration==previous && repo.mutations.isEmpty())
    }
    run("successful registered opt-in preserves an existing matching registration") {
        val (c,repo)=setup(false)
        val previous=mapOf("account" to repo.credentials!!.account,"id" to registrationID,"device" to repo.identity!!.device,"hash" to NativeProtocol.sha256(FakeFirebase.token.toByteArray()))
        repo.registration=previous;FakeFirebase.autoInit=false
        runBlocking { PushRegistration(c,repo).sync(true) }
        check(PushConfiguration.optedIn(c) && FakeFirebase.autoInit && repo.registration==previous && repo.mutations.isEmpty())
    }
    run("registered opt-out removes the same saved device once") {
        val (c,repo)=setup(true)
        repo.registration=mapOf("account" to repo.credentials!!.account,"id" to registrationID,"device" to repo.identity!!.device,"hash" to "fixture")
        runBlocking { PushRegistration(c,repo).sync(false) }
        check(!PushConfiguration.optedIn(c) && repo.registration==null)
        check(repo.mutations==listOf(Triple("notification.push.remove","/me/push-devices/$registrationID","DELETE")))
    }
    run("failed explicit preference write is not reported successful for a registered session") {
        val (c,repo)=setup(true)
        repo.registration=mapOf("account" to repo.credentials!!.account,"id" to registrationID,"device" to repo.identity!!.device,"hash" to "fixture")
        FakeSystem.commitResult=false
        val error=runBlocking { runCatching { PushRegistration(c,repo).sync(false) }.exceptionOrNull() }
        check((error as? LiveFailure)?.code=="push_preference_unavailable" && repo.mutations.isEmpty())
    }
    run("registered opt-out without a saved row makes no removal request") {
        val (c,repo)=setup(true);runBlocking { PushRegistration(c,repo).sync(false) }
        check(!PushConfiguration.optedIn(c) && repo.mutations.isEmpty())
    }
    run("explicit opt-out leaves unrelated preference entries unchanged") {
        val (c,repo)=setup(true);repo.credentials=null
        c.getSharedPreferences("lovelies-device-push",Context.MODE_PRIVATE).edit().putBoolean("fixture_other",true).commit()
        runBlocking { PushRegistration(c,repo).sync(false) }
        check(c.getSharedPreferences("lovelies-device-push",Context.MODE_PRIVATE).getBoolean("fixture_other",false))
    }
    run("an uninitialized Firebase app does not make local opt-out fail") {
        val (c,repo)=setup(true);repo.credentials=null;FakeFirebase.initialized=false;FakeFirebase.failSetter=true
        val error=runBlocking { runCatching { PushRegistration(c,repo).sync(false) }.exceptionOrNull() }
        check(error==null && FakeFirebase.initializations==0 && FakeFirebase.setAttempts==0)
        check(!PushConfiguration.optedIn(c) && repo.mutations.isEmpty())
    }
    run("a failed best-effort SDK switch does not pretend to be a preference failure") {
        val (c,repo)=setup(true);repo.credentials=null;FakeFirebase.failSetter=true
        val error=runBlocking { runCatching { PushRegistration(c,repo).sync(false) }.exceptionOrNull() }
        check(error==null && FakeFirebase.autoInit && repo.mutations.isEmpty())
        check(FakeFirebase.setAttempts==1 && !PushConfiguration.optedIn(c))
    }
    run("app-level notification disablement is effective before Android 13") {
        val(c,_)=setup(true);android.os.Build.VERSION.SDK_INT=24;FakeSystem.manager.notificationsEnabled=false
        try { check(!PushConfiguration.permitted(c)) } finally { android.os.Build.VERSION.SDK_INT=33 }
    }
    run("a muted updates channel is not reported enabled") {
        val(c,_)=setup(true)
        FakeSystem.manager.createNotificationChannel(android.app.NotificationChannel(PushConfiguration.CHANNEL,"Updates",android.app.NotificationManager.IMPORTANCE_NONE))
        check(PushConfiguration.runtimePermitted(c) && !PushConfiguration.permitted(c))
    }
    run("foreground token reconciliation consumes a rotation only after current registration") {
        val(c,repo)=setup(true);PushConfiguration.markRotation(c)
        runBlocking { PushRegistration(c,repo).sync() }
        check(repo.mutations.single().first=="notification.push.register")
        check(!c.getSharedPreferences("lovelies-device-push",Context.MODE_PRIVATE).getBoolean("rotation_pending",true))
    }
    run("a concurrent newer rotation is preserved for the next reconciliation") {
        val(c,repo)=setup(true);PushConfiguration.markRotation(c);val first=PushConfiguration.rotationVersion(c)
        FakeFirebase.onComplete={ PushConfiguration.markRotation(c) }
        runBlocking { PushRegistration(c,repo).sync() }
        check(PushConfiguration.rotationVersion(c)!=null && PushConfiguration.rotationVersion(c)!=first)
        check(c.getSharedPreferences("lovelies-device-push",Context.MODE_PRIVATE).getBoolean("rotation_pending",false))
    }
    run("a matching local hash cannot hide server deactivation") {
        val(c,repo)=setup(true);repo.remoteActive=false
        repo.registration=mapOf("account" to repo.credentials!!.account,"id" to registrationID,"device" to repo.identity!!.device,"hash" to NativeProtocol.sha256(FakeFirebase.token.toByteArray()))
        runBlocking { PushRegistration(c,repo).sync() }
        check(repo.mutations.single().first=="notification.push.register")
    }
    run("unconfirmed push status does not dispatch a second mutation or turn opt-out back on") {
        val(c,repo)=setup(true);repo.recoveryFailure=LiveFailure("push_operation_requires_status",503,true)
        val problem=runBlocking { runCatching { PushRegistration(c,repo).sync(false) }.exceptionOrNull() }
        check((problem as? LiveFailure)?.code=="push_operation_requires_status")
        check(!PushConfiguration.optedIn(c) && repo.mutations.isEmpty())
    }
    run("same permission action survives a transient read invalidation") {
        val context=PhotoActionContext("account-a","session-a","device-a","photo-a","personal",12)
        val owner=PhotoActionOwner.create(context)!!
        check(owner.matches(context.copy())) // UI/read epoch is intentionally absent from this binding.
    }
    run("photo actions reject changed selection route session account and device") {
        val context=PhotoActionContext("account-a","session-a","device-a","photo-a","personal",12)
        val owner=PhotoActionOwner.create(context)!!
        listOf(context.copy(photo="photo-b"),context.copy(source="contributions"),context.copy(route=10),context.copy(session="session-b"),context.copy(account="account-b"),context.copy(device="device-b"))
            .forEach { check(!owner.matches(it)) }
        check(PhotoActionOwner.create(context.copy(account=null))==null)
    }
    run("push typed receipt validates redacted input and current device without using historical active as authority") {
        val journal=PushOperationJournal.create("https://fixture", "00000000-0000-4000-8000-000000000081","00000000-0000-4000-8000-000000000084",token="synthetic-private-push-token")
        val payload=mapOf("protocol" to "lovelies-push-registration-receipt-v1","operation_key" to journal.key,"platform" to "android","push_token_sha256" to journal.tokenHash)
        val hash=NativeProtocol.sha256(NativeProtocol.canonical(mapOf("action" to journal.action,"source" to "notification","payload" to payload)).toByteArray())
        val receipt=mapOf("protocol" to "lovelies-push-operation-receipt-v1","operation_key" to journal.key,"status" to "committed","action" to journal.action,"payload_hash" to hash,
            "result" to mapOf("id" to registrationID,"platform" to "android","active" to true),
            "current" to mapOf("id" to registrationID,"auth_device_id" to journal.device,"platform" to "android","active" to 0))
        check(PushOperationProtocol.receipt(receipt,journal)!=null && NativeProtocol.obj(receipt["current"])["active"]==0)
        check(runCatching { PushOperationProtocol.receipt(receipt+mapOf("payload_hash" to "0".repeat(64)),journal) }.isFailure)
        check(runCatching { PushOperationProtocol.receipt(receipt+mapOf("current" to (NativeProtocol.obj(receipt["current"])+mapOf("auth_device_id" to registrationID))),journal) }.isFailure)
    }
    run("unknown typed push receipt carries no registration authority") {
        val journal=PushOperationJournal.create("https://fixture","00000000-0000-4000-8000-000000000081","00000000-0000-4000-8000-000000000084",target=registrationID)
        val unknown=mapOf("protocol" to "lovelies-push-operation-receipt-v1","operation_key" to journal.key,"status" to "unknown")
        check(PushOperationProtocol.receipt(unknown,journal)==null)
        check(runCatching { PushOperationProtocol.receipt(unknown+mapOf("result" to mapOf("active" to true)),journal) }.isFailure)
        check(PushOperationJournal.restore(journal.wire(),journal.origin)==journal)
    }
    runRecoveryChecks(::run)
    runAccountCollectionChecks(::run)
    runSessionAuthorityChecks(::run)
    runChunkedExportChecks(::run)
    run("replacement is confirmed before the previous device is revoked") {
        val (c,repo)=setup(true)
        repo.registration=mapOf("account" to repo.credentials!!.account,"id" to registrationID,"device" to repo.identity!!.device,"hash" to "old-hash")
        runBlocking { PushRegistration(c,repo).sync() }
        check(repo.mutations.map { it.first }==listOf("notification.push.register","notification.push.remove"))
        check(repo.registration?.get("id")=="00000000-0000-4000-8000-000000000099")
    }
    run("ambiguous replacement leaves the previous registration intact") {
        val (c,repo)=setup(true)
        val old=mapOf("account" to repo.credentials!!.account,"id" to registrationID,"device" to repo.identity!!.device,"hash" to "old-hash")
        repo.registration=old;repo.registerFailure=LiveFailure("push_operation_requires_status",503,true)
        check(runBlocking { runCatching { PushRegistration(c,repo).sync() }.isFailure })
        check(repo.registration==old && repo.mutations.none { it.first=="notification.push.remove" })
    }
    run("rotation callback during registration cannot be cleared by an older sync") {
        val (c,repo)=setup(true);PushConfiguration.markRotation(c)
        val before=PushConfiguration.rotationVersion(c)
        repo.afterRegister={ PushConfiguration.markRotation(c) }
        runBlocking { PushRegistration(c,repo).sync() }
        check(PushConfiguration.rotationPending(c) && PushConfiguration.rotationVersion(c)>before)
    }
    run("same token cached locally is re-registered when server row is inactive") {
        val (c,repo)=setup(true)
        repo.registration=mapOf("account" to repo.credentials!!.account,"id" to registrationID,"device" to repo.identity!!.device,"hash" to NativeProtocol.sha256(FakeFirebase.token.toByteArray()))
        repo.rows=listOf(mapOf("id" to registrationID,"platform" to "android","auth_device_id" to repo.identity!!.device,"active" to 0))
        runBlocking { PushRegistration(c,repo).sync() }
        check(repo.mutations.map { it.first }==listOf("notification.push.register"))
    }
    run("opt-out revokes only this authentication device's Android rows") {
        val (c,repo)=setup(true)
        repo.rows=listOf(mapOf("id" to registrationID,"platform" to "android","auth_device_id" to repo.identity!!.device,"active" to 1),
            mapOf("id" to "00000000-0000-4000-8000-000000000093","platform" to "android","auth_device_id" to "00000000-0000-4000-8000-000000000094","active" to 1),
            mapOf("id" to "00000000-0000-4000-8000-000000000095","platform" to "ios","auth_device_id" to repo.identity!!.device,"active" to 1))
        runBlocking { PushRegistration(c,repo).sync(false) }
        check(repo.mutations==listOf(Triple("notification.push.remove","/me/push-devices/$registrationID","DELETE")))
    }
    run("permission withdrawal during registration cannot publish success or retire old rows") {
        val (c,repo)=setup(true)
        repo.registration=mapOf("account" to repo.credentials!!.account,"id" to registrationID,"device" to repo.identity!!.device,"hash" to "old-hash")
        repo.afterRegister={ PushConfiguration.setOptedIn(c,false) }
        check(runBlocking { runCatching { PushRegistration(c,repo).sync() }.isFailure })
        check(repo.registration?.get("id")==registrationID && repo.mutations.none { it.first=="notification.push.remove" } && PushConfiguration.rotationPending(c))
    }
    run("successful rotation consumes the durable marker and reconciles original operations") {
        val (c,repo)=setup(true);PushConfiguration.markRotation(c)
        runBlocking { PushRegistration(c,repo).sync() }
        check(!PushConfiguration.rotationPending(c) && repo.reconciliations==1)
    }
    run("automatic sync cannot replace a terminal registration with a new key") {
        val (c,repo)=setup(true);PushConfiguration.markRotation(c)
        repo.registerFailure=LiveFailure("operation_recovered_without_result",409)
        val failure=runBlocking { runCatching { PushRegistration(c,repo).sync() }.exceptionOrNull() } as? LiveFailure
        check(failure?.code=="operation_recovered_without_result" && repo.terminalReplacementPermissions==listOf("register" to false))
        check(repo.registration==null && PushConfiguration.rotationPending(c))
    }
    run("an explicit enabled setting authorizes a fresh operation after terminal registration") {
        val (c,repo)=setup(true);repo.registerFailure=LiveFailure("operation_recovered_without_result",409)
        runBlocking { PushRegistration(c,repo).sync(true) }
        check(repo.terminalReplacementPermissions==listOf("register" to true) && repo.registration!=null)
    }
    run("automatic opt-out recovery cannot replace a terminal removal") {
        val (c,repo)=setup(false);repo.registration=mapOf("account" to repo.credentials!!.account,"device" to repo.identity!!.device,"id" to registrationID,"hash" to "fixture")
        repo.removeFailure=LiveFailure("operation_recovered_without_result",409)
        val failure=runBlocking { runCatching { PushRegistration(c,repo).sync() }.exceptionOrNull() } as? LiveFailure
        check(failure?.code=="operation_recovered_without_result" && repo.terminalReplacementPermissions==listOf("remove" to false) && repo.registration!=null)
    }
    run("explicit disable authorizes a fresh removal after a terminal rollback") {
        val (c,repo)=setup(true);repo.registration=mapOf("account" to repo.credentials!!.account,"device" to repo.identity!!.device,"id" to registrationID,"hash" to "fixture")
        repo.removeFailure=LiveFailure("operation_recovered_without_result",409)
        runBlocking { PushRegistration(c,repo).sync(false) }
        check(repo.terminalReplacementPermissions==listOf("remove" to true) && repo.registration==null && !PushConfiguration.optedIn(c))
    }
    println("RESULT total=$total passed=${total-failed} failed=$failed");if(failed>0)kotlin.system.exitProcess(1)
}
