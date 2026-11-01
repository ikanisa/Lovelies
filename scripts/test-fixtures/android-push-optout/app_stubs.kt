package com.lovelies.frontend.preview
class MainActivity
object BuildConfig { const val FIREBASE_PROJECT_ID="fixture";const val FIREBASE_APP_ID="fixture";const val FIREBASE_API_KEY="fixture";const val FIREBASE_SENDER_ID="fixture";const val LINK_HOST="lovelies.app" }
object R { object string { const val notification_channel=1;const val controller_a6e0f9a6503b=2;const val notification_title=3;const val notification_body=4 };object drawable { const val ic_notification=1 } }
data class LiveCredentials(val account:String,val token:String,val refresh:String,val method:String,val expires:Long,val wire:WireObject)
data class Credentials(val account:String,val method:String)
data class FakeIdentity(val device:String)
data class PendingIntent(val account:String,val source:String,val action:String,val key:String,val payload:WireObject,val path:String?=null,val method:String="POST")
class FakeFence(private val repo:CloudflareRepository) { fun assert(scope:SessionScope) { if(scope!=repo.currentScope())throw LiveFailure("session_changed") } }
class CloudflareRepository {
    var credentials:Credentials?=Credentials("00000000-0000-4000-8000-000000000081","registered_face")
    var identity:FakeIdentity?=FakeIdentity("00000000-0000-4000-8000-000000000084")
    var epoch=1L;val fence=FakeFence(this)
    var registration:WireObject?=null
    var remoteActive=true;var recoveryFailure:LiveFailure?=null;var recoveries=0
    var rows:List<WireObject>?=null
    var registerFailure:LiveFailure?=null
    var removeFailure:LiveFailure?=null
    var afterRegister:(()->Unit)?=null
    var reconciliations=0
    val terminalReplacementPermissions=mutableListOf<Pair<String,Boolean>>()
    val mutations=mutableListOf<Triple<String,String?,String>>()
    fun currentScope()=SessionScope(epoch,credentials?.account)
    fun saved(key:String):Any?=if(key=="push_registration")registration else null
    fun remember(key:String,value:Any?) { if(key=="push_registration")registration=value as? WireObject }
    suspend fun get(path:String):WireObject {
        check(path=="/me/push-devices")
        if(rows==null)rows=registration?.let { listOf(mapOf("id" to it["id"],"platform" to "android","auth_device_id" to it["device"],"active" to if(remoteActive)1 else 0)) } ?: emptyList()
        return mapOf("items" to rows)
    }
    suspend fun reconcilePushOperations(allowRegistration:()->Boolean) { reconciliations++;recoveryFailure?.let { throw it } }
    suspend fun registerPushToken(token:String,allowed:()->Boolean,allowNewAfterTerminal:Boolean=false):WireObject {
        terminalReplacementPermissions+="register" to allowNewAfterTerminal
        check(allowed());mutations.add(Triple("notification.push.register","/me/push-devices","POST"))
        registerFailure?.let { if(it.code!="operation_recovered_without_result" || !allowNewAfterTerminal)throw it }
        val id="00000000-0000-4000-8000-000000000099"
        rows=(rows ?: emptyList()).filter { it["id"]!=id }+mapOf("id" to id,"platform" to "android","auth_device_id" to identity!!.device,"active" to 1)
        afterRegister?.invoke()
        return mapOf("result" to mapOf("id" to id,"platform" to "android","active" to true),"current" to mapOf("id" to id,"platform" to "android","auth_device_id" to identity!!.device,"active" to 1))
    }
    suspend fun removePushDevice(id:String,allowNewAfterTerminal:Boolean=false):WireObject {
        terminalReplacementPermissions+="remove" to allowNewAfterTerminal
        removeFailure?.let { if(it.code!="operation_recovered_without_result" || !allowNewAfterTerminal)throw it }
        mutations.add(Triple("notification.push.remove","/me/push-devices/$id","DELETE"));rows=(rows ?: emptyList()).filter { it["id"]!=id }
        return mapOf("id" to id,"active" to false)
    }
    suspend fun mutate(action:String,payload:WireObject,source:String="personal",path:String?=null,method:String="POST"):WireObject {
        mutations.add(Triple(action,path,method));return emptyMap()
    }
}
