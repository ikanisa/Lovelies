package com.google.firebase.messaging
import android.content.Context
open class FirebaseMessagingService:Context() { open fun onNewToken(token:String){};open fun onMessageReceived(message:RemoteMessage){} }
class RemoteMessage(val data:Map<String,String>)
object FakeFirebase {
    var token="synthetic-new-token";var onComplete:(()->Unit)?=null
    var initialized=true;var initializations=0;var autoInit=true;var setAttempts=0;var failSetter=false
    fun reset() { initialized=true;initializations=0;autoInit=true;setAttempts=0;failSetter=false;onComplete=null }
}
class FakeTask { fun addOnCompleteListener(block:(FakeTask)->Unit) { block(this);FakeFirebase.onComplete?.invoke() };val isSuccessful=true;val result get()=FakeFirebase.token }
class FirebaseMessaging {
    var isAutoInitEnabled:Boolean
        get()=FakeFirebase.autoInit
        set(value) { FakeFirebase.setAttempts++;if(FakeFirebase.failSetter)throw IllegalStateException("synthetic Firebase failure");FakeFirebase.autoInit=value }
    val token=FakeTask();companion object { fun getInstance()=FirebaseMessaging() }
}
