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
    run("enabling without registered credentials remains unchanged") {
        val (c,repo)=setup(false);repo.credentials=null
        runBlocking { PushRegistration(c,repo).sync(true) }
        check(!PushConfiguration.optedIn(c) && repo.mutations.isEmpty())
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
    println("RESULT total=$total passed=${total-failed} failed=$failed");if(failed>0)kotlin.system.exitProcess(1)
}
