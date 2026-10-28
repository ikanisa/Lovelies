package com.google.firebase
import android.content.Context
import com.google.firebase.messaging.FakeFirebase
class FirebaseOptions { class Builder { fun setProjectId(v:String)=this;fun setApplicationId(v:String)=this;fun setApiKey(v:String)=this;fun setGcmSenderId(v:String)=this;fun build()=FirebaseOptions() } }
class FirebaseApp { companion object {
    fun getApps(c:Context)=if(FakeFirebase.initialized)listOf(FirebaseApp()) else emptyList()
    fun initializeApp(c:Context,o:FirebaseOptions):FirebaseApp { FakeFirebase.initializations++;FakeFirebase.initialized=true;return FirebaseApp() }
} }
