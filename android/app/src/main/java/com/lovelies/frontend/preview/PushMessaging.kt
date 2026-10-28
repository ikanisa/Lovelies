package com.lovelies.frontend.preview

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal object PushConfiguration {
    fun initialize(context: Context): FirebaseMessaging {
        val required=listOf(BuildConfig.FIREBASE_PROJECT_ID,BuildConfig.FIREBASE_APP_ID,BuildConfig.FIREBASE_API_KEY,BuildConfig.FIREBASE_SENDER_ID)
        if(required.any(String::isBlank))throw LiveFailure("push_provider_unconfigured")
        if(FirebaseApp.getApps(context).isEmpty())FirebaseApp.initializeApp(context,FirebaseOptions.Builder()
            .setProjectId(required[0]).setApplicationId(required[1]).setApiKey(required[2]).setGcmSenderId(required[3]).build())
        return FirebaseMessaging.getInstance()
    }
    fun permitted(context: Context)=Build.VERSION.SDK_INT<33 || ContextCompat.checkSelfPermission(context,Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED
    fun optedIn(context: Context)=context.getSharedPreferences("lovelies-device-push",Context.MODE_PRIVATE).getBoolean("opted_in",false)
    fun setOptedIn(context: Context,value: Boolean): Boolean = context.getSharedPreferences("lovelies-device-push",Context.MODE_PRIVATE).edit().putBoolean("opted_in",value).commit()
    fun disableAutoInitIfInitialized(context: Context) {
        if(FirebaseApp.getApps(context).isNotEmpty())FirebaseMessaging.getInstance().isAutoInitEnabled=false
    }
}
class PushRegistration(private val context: Context,private val repository: CloudflareRepository) {
    suspend fun sync(enable: Boolean?=null) {
        if(enable==false) {
            val saved=runCatching { PushConfiguration.setOptedIn(context,false) }.getOrDefault(false)
            runCatching { PushConfiguration.disableAutoInitIfInitialized(context) }
            if(!saved)throw LiveFailure("push_preference_unavailable")
        }
        val owned=repository.currentScope();val account=repository.credentials?.takeIf { it.method=="registered_face" }?.account ?: return
        if(enable==true)PushConfiguration.setOptedIn(context,true)
        val previous=(repository.saved("push_registration") as? Map<*,*>)?.let(NativeProtocol::obj)
        if(!PushConfiguration.optedIn(context) || !PushConfiguration.permitted(context)) {
            if(previous?.get("account")==account) {
                val id=NativeProtocol.id(previous["id"])
                repository.mutate("notification.push.remove",emptyMap(),"notification",path="/me/push-devices/$id",method="DELETE")
                repository.fence.assert(owned);repository.remember("push_registration",null)
            }
            runCatching { PushConfiguration.initialize(context).isAutoInitEnabled=false }
            return
        }
        val messaging=PushConfiguration.initialize(context);messaging.isAutoInitEnabled=true
        val token=suspendCancellableCoroutine<String> { continuation->messaging.token.addOnCompleteListener { result ->
            if(continuation.isActive) { if(result.isSuccessful)continuation.resume(result.result) else continuation.resumeWithException(LiveFailure("push_registration_failed")) }
        } }
        repository.fence.assert(owned)
        val hash=NativeProtocol.sha256(token.toByteArray())
        if(previous?.get("account")==account && previous["hash"]==hash && previous["device"]==repository.identity?.device)return
        // Remove the original registration before rotating, so one account/device has one current token.
        if(previous?.get("account")==account)repository.mutate("notification.push.remove",emptyMap(),"notification",path="/me/push-devices/${NativeProtocol.id(previous["id"])}",method="DELETE")
        repository.fence.assert(owned)
        val result=repository.mutate("notification.push.register",mapOf("platform" to "android","push_token" to token),"notification",path="/me/push-devices")
        repository.fence.assert(owned)
        if(result["active"]!=true || result["platform"]!="android")throw LiveFailure("push_registration_failed")
        repository.remember("push_registration",mapOf("account" to account,"device" to repository.identity?.device,"id" to NativeProtocol.id(result["id"]),"hash" to hash))
    }
}
class LoveliesMessagingService: FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        // The SDK retains its token. Bind or rotate it only after current signed-in authority is checked.
        getSharedPreferences("lovelies-device-push",MODE_PRIVATE).edit().putBoolean("rotation_pending",true).apply()
    }
    override fun onMessageReceived(message: RemoteMessage) {
        if(!PushConfiguration.optedIn(this) || !PushConfiguration.permitted(this))return
        val id=runCatching { NativeProtocol.id(message.data["id"] ?: message.data["notification_id"]) }.getOrNull() ?: return
        if(Build.VERSION.SDK_INT>=26) {
            val manager=getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(NotificationChannel("lovelies-updates",getString(R.string.notification_channel),NotificationManager.IMPORTANCE_DEFAULT).apply {
                description=getString(R.string.controller_a6e0f9a6503b);lockscreenVisibility=android.app.Notification.VISIBILITY_PRIVATE
            })
        }
        // Intent extras do not participate in PendingIntent identity. Give each
        // validated notification an exact action and a matching system tag.
        val open=Intent(this,MainActivity::class.java).setAction("$packageName.notification.$id")
            .putExtra("notification_id",id).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val tap=PendingIntent.getActivity(this,0,open,PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification=NotificationCompat.Builder(this,"lovelies-updates").setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.notification_title)).setContentText(getString(R.string.notification_body))
            .setAutoCancel(true).setContentIntent(tap).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build()
        if(!PushConfiguration.optedIn(this) || !PushConfiguration.permitted(this))return
        try { NotificationManagerCompat.from(this).notify("lovelies-notification:$id",0,notification) }
        catch(_: SecurityException) { return } // Permission may change after the fresh check.
    }
}
