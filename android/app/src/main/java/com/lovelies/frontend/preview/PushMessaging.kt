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
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal object PushConfiguration {
    const val CHANNEL="lovelies-updates"
    // SharedPreferences may change its in-memory value even when commit fails.
    // Do not treat that unconfirmed write as an opt-in in this process.
    @Volatile private var preferenceWriteUnconfirmed=false
    val changes=MutableSharedFlow<Unit>(extraBufferCapacity=1)
    @Volatile private var rotationWriteUnconfirmed=false
    @Synchronized fun rotationVersion(context:Context)=context.getSharedPreferences("lovelies-device-push",Context.MODE_PRIVATE).getLong("rotation_version",0L)
    @Synchronized fun markRotation(context:Context) {
        rotationWriteUnconfirmed=true
        val prefs=context.getSharedPreferences("lovelies-device-push",Context.MODE_PRIVATE)
        val next=prefs.getLong("rotation_version",0L).let { if(it==Long.MAX_VALUE)0L else it+1L }
        if(runCatching { prefs.edit().putLong("rotation_version",next).putBoolean("rotation_pending",true).commit() }.getOrDefault(false))rotationWriteUnconfirmed=false
        changes.tryEmit(Unit)
    }
    fun rotationPending(context:Context)=rotationWriteUnconfirmed || context.getSharedPreferences("lovelies-device-push",Context.MODE_PRIVATE).getBoolean("rotation_pending",false)
    @Synchronized fun confirmRotation(context:Context,version:Long) {
        if(rotationVersion(context)!=version)return
        if(!context.getSharedPreferences("lovelies-device-push",Context.MODE_PRIVATE).edit().putBoolean("rotation_pending",false).commit())throw LiveFailure("push_preference_unavailable")
        rotationWriteUnconfirmed=false
    }
    fun initialize(context: Context): FirebaseMessaging {
        val required=listOf(BuildConfig.FIREBASE_PROJECT_ID,BuildConfig.FIREBASE_APP_ID,BuildConfig.FIREBASE_API_KEY,BuildConfig.FIREBASE_SENDER_ID)
        if(required.any(String::isBlank))throw LiveFailure("push_provider_unconfigured")
        if(FirebaseApp.getApps(context).isEmpty())FirebaseApp.initializeApp(context,FirebaseOptions.Builder()
            .setProjectId(required[0]).setApplicationId(required[1]).setApiKey(required[2]).setGcmSenderId(required[3]).build())
        return FirebaseMessaging.getInstance()
    }
    fun runtimePermitted(context: Context)=Build.VERSION.SDK_INT<33 || ContextCompat.checkSelfPermission(context,Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED
    fun permitted(context: Context): Boolean {
        if(!runtimePermitted(context) || !NotificationManagerCompat.from(context).areNotificationsEnabled())return false
        return Build.VERSION.SDK_INT<26 || context.getSystemService(NotificationManager::class.java).getNotificationChannel(CHANNEL)?.importance!=NotificationManager.IMPORTANCE_NONE
    }
    fun permissionRequested(context: Context)=context.getSharedPreferences("lovelies-device-push",Context.MODE_PRIVATE).getBoolean("permission_requested",false)
    fun markPermissionRequested(context: Context)=context.getSharedPreferences("lovelies-device-push",Context.MODE_PRIVATE).edit().putBoolean("permission_requested",true).commit()
    fun optedIn(context: Context)=!preferenceWriteUnconfirmed && context.getSharedPreferences("lovelies-device-push",Context.MODE_PRIVATE).getBoolean("opted_in",false)
    @Synchronized fun setOptedIn(context: Context,value: Boolean): Boolean {
        preferenceWriteUnconfirmed=true
        val saved=context.getSharedPreferences("lovelies-device-push",Context.MODE_PRIVATE).edit().putBoolean("opted_in",value).commit()
        if(saved)preferenceWriteUnconfirmed=false
        return saved
    }
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
        val owned=repository.currentScope();val account=repository.credentials?.takeIf { it.method=="registered_face" }?.account
        if(account==null) {
            if(enable==true)throw LiveFailure("registered_face_required",403)
            return
        }
        if(enable==true) {
            val saved=runCatching { PushConfiguration.setOptedIn(context,true) }.getOrDefault(false)
            if(!saved)throw LiveFailure("push_preference_unavailable")
        }
        val device=repository.identity?.device ?: throw LiveFailure("push_operation_scope_changed")
        val previous=(repository.saved("push_registration") as? Map<*,*>)?.let(NativeProtocol::obj)
        fun allowed()=PushConfiguration.optedIn(context) && PushConfiguration.permitted(context)
        suspend fun activeRows():List<WireObject> {
            val rows=NativeProtocol.rows(repository.get("/me/push-devices")["items"])
            repository.fence.assert(owned)
            return rows.filter { it["platform"]=="android" && it["auth_device_id"]==device && it["active"] in setOf(true,1,1L) }
        }
        if(!PushConfiguration.optedIn(context) || !PushConfiguration.permitted(context)) {
            // An uncertain earlier registration gets lookup only after opt-out.
            // Known active devices are still retired while that receipt waits.
            var held:LiveFailure?=null
            try { repository.reconcilePushOperations { false } }
            catch(problem:LiveFailure) { if(problem.code !in setOf("push_registration_pending_revocation","push_operation_requires_status"))throw problem;held=problem }
            for(row in activeRows()) {
                repository.removePushDevice(NativeProtocol.id(row["id"]),allowNewAfterTerminal=enable==false);repository.fence.assert(owned)
            }
            if(previous?.get("account")==account && previous["device"]==device)repository.remember("push_registration",null)
            runCatching { PushConfiguration.disableAutoInitIfInitialized(context) }
            if(held!=null)throw held
            return
        }
        val rotation=PushConfiguration.rotationVersion(context)
        val messaging=PushConfiguration.initialize(context);messaging.isAutoInitEnabled=true
        val token=suspendCancellableCoroutine<String> { continuation->messaging.token.addOnCompleteListener { result ->
            if(continuation.isActive) { if(result.isSuccessful)continuation.resume(result.result) else continuation.resumeWithException(LiveFailure("push_registration_failed")) }
        } }
        repository.fence.assert(owned)
        if(!allowed()) { PushConfiguration.markRotation(context);throw LiveFailure("push_registration_pending_revocation",503,true) }
        repository.reconcilePushOperations(::allowed);repository.fence.assert(owned)
        val hash=NativeProtocol.sha256(token.toByteArray())
        val rows=activeRows()
        val retained=previous?.takeIf { it["account"]==account && it["hash"]==hash && it["device"]==device && rows.any { row->row["id"]==it["id"] } }
        val id=if(retained!=null)NativeProtocol.id(retained["id"]) else {
            val receipt=repository.registerPushToken(token,::allowed,allowNewAfterTerminal=enable==true);repository.fence.assert(owned)
            val result=NativeProtocol.obj(receipt["result"]);val current=NativeProtocol.obj(receipt["current"])
            if(!allowed() || result["active"]!=true || result["platform"]!="android" || NativeProtocol.integer(current["active"],0,1)!=1L || current["auth_device_id"]!=device) {
                PushConfiguration.markRotation(context);throw LiveFailure("push_registration_pending_revocation",503,true)
            }
            NativeProtocol.id(result["id"]).also { repository.remember("push_registration",mapOf("account" to account,"device" to device,"id" to it,"hash" to hash)) }
        }
        // Replacement is durably confirmed before any prior token is retired.
        for(row in activeRows())if(row["id"]!=id) {
            repository.removePushDevice(NativeProtocol.id(row["id"]));repository.fence.assert(owned)
        }
        if(!allowed()) { PushConfiguration.markRotation(context);throw LiveFailure("push_registration_pending_revocation",503,true) }
        PushConfiguration.confirmRotation(context,rotation)
    }
}
class LoveliesMessagingService: FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        // The SDK retains its token. Bind or rotate it only after current signed-in authority is checked.
        PushConfiguration.markRotation(this)
    }
    override fun onMessageReceived(message: RemoteMessage) {
        if(!PushConfiguration.optedIn(this) || !PushConfiguration.permitted(this))return
        val id=runCatching { NativeProtocol.id(message.data["id"] ?: message.data["notification_id"]) }.getOrNull() ?: return
        if(Build.VERSION.SDK_INT>=26) {
            val manager=getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(NotificationChannel(PushConfiguration.CHANNEL,getString(R.string.notification_channel),NotificationManager.IMPORTANCE_DEFAULT).apply {
                description=getString(R.string.controller_a6e0f9a6503b);lockscreenVisibility=android.app.Notification.VISIBILITY_PRIVATE
            })
        }
        // Intent extras do not participate in PendingIntent identity. Give each
        // validated notification an exact action and a matching system tag.
        val open=Intent(this,MainActivity::class.java).setAction("$packageName.notification.$id")
            .putExtra("notification_id",id).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val tap=PendingIntent.getActivity(this,0,open,PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification=NotificationCompat.Builder(this,PushConfiguration.CHANNEL).setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.notification_title)).setContentText(getString(R.string.notification_body))
            .setAutoCancel(true).setContentIntent(tap).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build()
        if(!PushConfiguration.optedIn(this) || !PushConfiguration.permitted(this))return
        try { NotificationManagerCompat.from(this).notify("lovelies-notification:$id",0,notification) }
        catch(_: SecurityException) { return } // Permission may change after the fresh check.
    }
}
