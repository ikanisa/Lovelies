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
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal object PushConfiguration {
    // SharedPreferences may change its in-memory value even when commit fails.
    // Do not treat that unconfirmed write as an opt-in in this process.
    @Volatile private var preferenceWriteUnconfirmed=false
    val rotationChanges=MutableStateFlow(0L)
    fun initialize(context: Context): FirebaseMessaging {
        val required=listOf(BuildConfig.FIREBASE_PROJECT_ID,BuildConfig.FIREBASE_APP_ID,BuildConfig.FIREBASE_API_KEY,BuildConfig.FIREBASE_SENDER_ID)
        if(required.any(String::isBlank))throw LiveFailure("push_provider_unconfigured")
        if(FirebaseApp.getApps(context).isEmpty())FirebaseApp.initializeApp(context,FirebaseOptions.Builder()
            .setProjectId(required[0]).setApplicationId(required[1]).setApiKey(required[2]).setGcmSenderId(required[3]).build())
        return FirebaseMessaging.getInstance()
    }
    fun permitted(context: Context)=Build.VERSION.SDK_INT<33 || ContextCompat.checkSelfPermission(context,Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED
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
    fun rotationPending(context: Context)=context.getSharedPreferences("lovelies-device-push",Context.MODE_PRIVATE).getBoolean("rotation_pending",false)
    @Synchronized fun rotationGeneration(context: Context)=context.getSharedPreferences("lovelies-device-push",Context.MODE_PRIVATE).getLong("rotation_generation",0)
    @Synchronized fun markRotation(context: Context) {
        val preferences=context.getSharedPreferences("lovelies-device-push",Context.MODE_PRIVATE)
        val next=maxOf(preferences.getLong("rotation_generation",0),rotationChanges.value)+1L
        // The SDK retains the token. This journal contains no raw token and a
        // failed preference write cannot authorize registration. Foreground
        // also reads the current SDK token rather than trusting this marker.
        runCatching { preferences.edit().putBoolean("rotation_pending",true).putLong("rotation_generation",next).commit() }
        rotationChanges.value=next
    }
    @Synchronized fun acknowledgeRotation(context: Context,generation: Long) {
        val preferences=context.getSharedPreferences("lovelies-device-push",Context.MODE_PRIVATE)
        if(preferences.getLong("rotation_generation",0)!=generation || !rotationPending(context))return
        if(!preferences.edit().putBoolean("rotation_pending",false).commit())throw LiveFailure("push_preference_unavailable")
    }
}
class PushRegistration(private val context: Context,private val repository: CloudflareRepository) {
    private val mutex=Mutex()
    suspend fun sync(enable: Boolean?=null) {
        if(enable==false) {
            val saved=runCatching { PushConfiguration.setOptedIn(context,false) }.getOrDefault(false)
            runCatching { PushConfiguration.disableAutoInitIfInitialized(context) }
            if(!saved)throw LiveFailure("push_preference_unavailable")
        }
        mutex.withLock { syncLocked(enable) }
    }
    private suspend fun syncLocked(enable: Boolean?) {
        val owned=repository.currentScope();val account=repository.credentials?.takeIf { it.method=="registered_face" }?.account
        if(account==null) {
            if(enable==true)throw LiveFailure("registered_face_required",403)
            return
        }
        if(enable==true) {
            val saved=runCatching { PushConfiguration.setOptedIn(context,true) }.getOrDefault(false)
            if(!saved)throw LiveFailure("push_preference_unavailable")
        }
        val device=repository.identity?.device ?: throw LiveFailure("push_operation_account_changed",403,true)
        val generation=PushConfiguration.rotationGeneration(context)
        val assertCurrent={ repository.fence.assert(owned);if(repository.credentials?.account!=account || repository.credentials?.method!="registered_face" || repository.identity?.device!=device)throw LiveFailure("push_operation_account_changed",403,true) }
        val allowed={ PushConfiguration.optedIn(context) && PushConfiguration.permitted(context) }
        val disable={ runCatching { PushConfiguration.disableAutoInitIfInitialized(context) };Unit }
        if(!allowed())disable()
        try { PushRegistrationFlow(account,device,assertCurrent,allowed,
            recover={ repository.recoverPushOperation(device,assertCurrent) },
            previous={ (repository.saved("push_registration") as? Map<*,*>)?.let(NativeProtocol::obj) },
            token={
                assertCurrent();if(!allowed())throw LiveFailure("push_permission_changed",409,true)
                val messaging=PushConfiguration.initialize(context);messaging.isAutoInitEnabled=true
                suspendCancellableCoroutine<String> { continuation->messaging.token.addOnCompleteListener { result ->
                    if(continuation.isActive) { if(result.isSuccessful)continuation.resume(result.result) else continuation.resumeWithException(LiveFailure("push_registration_failed")) }
                } }
            },
            register={ token,guard -> repository.registerPushToken(token,device,guard) },
            remove={ id,guard -> repository.removePushRegistration(id,device,guard) },disable=disable).run() }
        finally { if(!allowed())disable() }
        assertCurrent()
        // A callback arriving while token/receipt work was suspended owns a
        // newer generation and must be observed by the next foreground pass.
        if(allowed())PushConfiguration.acknowledgeRotation(context,generation)
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
