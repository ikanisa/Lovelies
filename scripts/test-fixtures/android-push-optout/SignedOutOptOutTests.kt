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
    run("permission loss during the SDK token suspension prevents registration") {
        val (c,repo)=setup(true);FakeFirebase.onComplete={FakeSystem.permission=-1}
        val error=runBlocking { runCatching { PushRegistration(c,repo).sync() }.exceptionOrNull() }
        check((error as? LiveFailure)?.code=="push_permission_changed" && repo.mutations.isEmpty() && !FakeFirebase.autoInit)
    }
    run("opt-out during the SDK token suspension prevents registration") {
        val (c,repo)=setup(true);FakeFirebase.onComplete={PushConfiguration.setOptedIn(c,false)}
        val error=runBlocking { runCatching { PushRegistration(c,repo).sync() }.exceptionOrNull() }
        check((error as? LiveFailure)?.code=="push_permission_changed" && repo.mutations.isEmpty() && !FakeFirebase.autoInit)
    }
    run("account scope change during SDK token acquisition prevents registration") {
        val (c,repo)=setup(true);FakeFirebase.onComplete={repo.epoch++}
        val error=runBlocking { runCatching { PushRegistration(c,repo).sync() }.exceptionOrNull() }
        check((error as? LiveFailure)?.code=="session_changed" && repo.mutations.isEmpty())
    }
    run("foreground sync reads and acknowledges a retained rotation marker") {
        val (c,repo)=setup(true);PushConfiguration.markRotation(c)
        check(PushConfiguration.rotationPending(c))
        runBlocking { PushRegistration(c,repo).sync() }
        check(!PushConfiguration.rotationPending(c) && repo.mutations.single().first=="notification.push.register")
    }
    run("a newer SDK callback during sync keeps its generation pending") {
        val (c,repo)=setup(true);PushConfiguration.markRotation(c)
        FakeFirebase.onComplete={PushConfiguration.markRotation(c)}
        val sync=PushRegistration(c,repo);runBlocking { sync.sync() }
        check(PushConfiguration.rotationPending(c));FakeFirebase.onComplete=null
        runBlocking { sync.sync() };check(!PushConfiguration.rotationPending(c) && repo.mutations.size==1)
    }
    run("unknown registration blocks SDK rotation without reusing generic mutations") {
        val (c,repo)=setup(true);repo.recoveryFailure=LiveFailure("push_operation_requires_status",503,true)
        val error=runBlocking { runCatching { PushRegistration(c,repo).sync() }.exceptionOrNull() }
        check((error as? LiveFailure)?.code=="push_operation_requires_status" && repo.mutations.isEmpty() && FakeFirebase.setAttempts==0)
    }
    println("RESULT total=$total passed=${total-failed} failed=$failed");if(failed>0)kotlin.system.exitProcess(1)
}
