package com.lovelies.frontend.preview
class MainActivity
object BuildConfig { const val FIREBASE_PROJECT_ID="fixture";const val FIREBASE_APP_ID="fixture";const val FIREBASE_API_KEY="fixture";const val FIREBASE_SENDER_ID="fixture";const val LINK_HOST="lovelies.app" }
object R { object string { const val notification_channel=1;const val controller_a6e0f9a6503b=2;const val notification_title=3;const val notification_body=4 };object drawable { const val ic_notification=1 } }
data class SessionScope(val epoch:Long,val accountId:String?)
data class Credentials(val account:String,val method:String)
data class FakeIdentity(val device:String)
class FakeFence(private val repo:CloudflareRepository) { fun assert(scope:SessionScope) { if(scope!=repo.currentScope())throw LiveFailure("session_changed") } }
class CloudflareRepository {
    var credentials:Credentials?=Credentials("00000000-0000-4000-8000-000000000081","registered_face")
    var identity:FakeIdentity?=FakeIdentity("00000000-0000-4000-8000-000000000084")
    var epoch=1L;val fence=FakeFence(this)
    var registration:WireObject?=null
    val mutations=mutableListOf<Triple<String,String?,String>>()
    fun currentScope()=SessionScope(epoch,credentials?.account)
    fun saved(key:String):Any?=if(key=="push_registration")registration else null
    fun remember(key:String,value:Any?) { if(key=="push_registration")registration=value as? WireObject }
    suspend fun mutate(action:String,payload:WireObject,source:String="personal",path:String?=null,method:String="POST"):WireObject {
        mutations.add(Triple(action,path,method));return emptyMap()
    }
}
