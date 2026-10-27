package com.lovelies.frontend.preview

import android.app.Activity
import android.app.Instrumentation
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.RemoteMessage
import java.util.UUID

/** Unexecuted device qualification: only a fresh root-owned Debug AVD/app. */
class NotificationIdentityJourney : Instrumentation() {
    private lateinit var args: Bundle
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments);args=arguments ?: Bundle();start() }
    override fun onStart() {
        val a="5757a80d-d440-4cbf-b524-5071f57fa02b"
        val b="1e8d74f4-bb72-42bf-a262-ba4e9b27d213"
        val ids=listOf(a,b);val tags=ids.map { "lovelies-notification:$it" }
        val context=targetContext
        val manager=context.getSystemService(NotificationManager::class.java)
        val pending=mutableListOf<PendingIntent>()
        val ownedTags=mutableListOf<String>()
        var ownedLegacy=false;var activity:MainActivity?=null;var prefs:String?=null
        var failure:String?=null;var cleanupFailure=false
        fun newIntent(id:String)=Intent(context,MainActivity::class.java).setAction("${context.packageName}.notification.$id")
        fun oldIntent()=Intent(context,MainActivity::class.java).putExtra("notification_id",a).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        fun findTap(code:Int,intent:Intent)=PendingIntent.getActivity(context,code,intent,PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE)
        fun awaitState(expected:String) {
            val deadline=SystemClock.uptimeMillis()+5000
            var seen=false
            do {
                runOnMainSync {
                    val field=MainActivity::class.java.getDeclaredField("activeState").apply { isAccessible=true }
                    val state=field.get(activity) as? PreviewState
                    if(state!=null) {
                        check(state.live.repository.credentials==null && !state.live.registered) { "Fixture must not contain a signed-in actor" }
                        seen=state.live.pendingLink==AppLink("notifications",expected)
                    }
                }
                if(!seen)SystemClock.sleep(25)
            } while(!seen && SystemClock.uptimeMillis()<deadline)
            check(seen) { "Actual MainActivity did not dispatch the expected notification" }
        }
        try {
            check(args.getString("owned_disposable_runtime")=="true" && args.getString("fresh_debug_install")=="true")
            check(BuildConfig.DEBUG && BuildConfig.API_BASE_URL=="http://127.0.0.1:9") { "Fresh Debug app must use the isolated closed loopback origin" }
            check(Build.VERSION.SDK_INT>=24 && PushConfiguration.permitted(context)) { "Notification permission must already be granted" }
            check(a.hashCode()==b.hashCode() && a!=b)
            check(manager.activeNotifications.none { (it.tag in tags && it.id==0) || (it.tag==null && it.id==a.hashCode()) }) { "Preserve existing notification" }
            check(ids.all { findTap(0,newIntent(it))==null } && findTap(a.hashCode(),oldIntent())==null) { "Preserve existing tap" }
            val preference="notification-identity-${UUID.randomUUID()}";prefs=preference
            val notificationContext=object:ContextWrapper(context) {
                override fun getSharedPreferences(name:String,mode:Int)=super.getSharedPreferences(preference,mode)
            }
            PushConfiguration.setOptedIn(notificationContext,true)
            val service=LoveliesMessagingService()
            ContextWrapper::class.java.getDeclaredMethod("attachBaseContext",Context::class.java).apply { isAccessible=true }.invoke(service,notificationContext)
            if(Build.VERSION.SDK_INT>=26) {
                val channel=android.app.NotificationChannel("lovelies-updates",context.getString(R.string.notification_channel),NotificationManager.IMPORTANCE_DEFAULT)
                manager.createNotificationChannel(channel)
            }
            val legacy=PendingIntent.getActivity(context,a.hashCode(),oldIntent(),PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            pending.add(legacy);ownedLegacy=true
            manager.notify(a.hashCode(),NotificationCompat.Builder(context,"lovelies-updates").setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(context.getString(R.string.notification_title)).setContentText(context.getString(R.string.notification_body))
                .setContentIntent(legacy).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setAutoCancel(true).build())
            ids.forEachIndexed { index,id ->
                ownedTags.add(tags[index])
                service.onMessageReceived(RemoteMessage.Builder("owned-local-notification-probe").addData("id",id).build())
                findTap(0,newIntent(id))?.let(pending::add)
            }
            val deadline=SystemClock.uptimeMillis()+3000
            var shown=manager.activeNotifications.filter { (it.tag in tags && it.id==0) || (it.tag==null && it.id==a.hashCode()) }
            while(shown.size!=3 && SystemClock.uptimeMillis()<deadline) { SystemClock.sleep(25);shown=manager.activeNotifications.filter { (it.tag in tags && it.id==0) || (it.tag==null && it.id==a.hashCode()) } }
            check(shown.size==3) { "Expected both exact notifications and the legacy notification" }
            val first=shown.single { it.tag==tags[0] }.notification
            val second=shown.single { it.tag==tags[1] }.notification
            check(first.contentIntent!=second.contentIntent && first.contentIntent!=legacy && second.contentIntent!=legacy)
            check(first.visibility==android.app.Notification.VISIBILITY_PRIVATE && second.visibility==android.app.Notification.VISIBILITY_PRIVATE)
            service.onMessageReceived(RemoteMessage.Builder("owned-local-notification-probe").addData("id",a.uppercase()).build())
            check(manager.activeNotifications.count { it.tag in tags && it.id==0 }==2)
            val monitor=addMonitor(MainActivity::class.java.name,null,false)
            first.contentIntent.send()
            activity=waitForMonitorWithTimeout(monitor,5000) as? MainActivity ?: error("MainActivity did not open")
            awaitState(a)
            second.contentIntent.send();awaitState(b)
            legacy.send();awaitState(a)
        } catch(error:Throwable) { failure="${error.javaClass.simpleName}: ${error.message}" }
        finally {
            runCatching { activity?.let { runOnMainSync { it.finish() } } }.onFailure { cleanupFailure=true }
            runCatching {
                ownedTags.forEach { tag -> manager.cancel(tag,0);findTap(0,newIntent(tag.removePrefix("lovelies-notification:")))?.cancel() }
                if(ownedLegacy)manager.cancel(a.hashCode());pending.forEach { it.cancel() }
            }.onFailure { cleanupFailure=true }
            prefs?.let { name -> runCatching { check(context.deleteSharedPreferences(name)) }.onFailure { cleanupFailure=true } }
            runCatching {
                val cleanupDeadline=SystemClock.uptimeMillis()+3000
                while(manager.activeNotifications.any { (it.tag in ownedTags && it.id==0) || (ownedLegacy && it.tag==null && it.id==a.hashCode()) } && SystemClock.uptimeMillis()<cleanupDeadline)SystemClock.sleep(25)
                check(manager.activeNotifications.none { (it.tag in ownedTags && it.id==0) || (ownedLegacy && it.tag==null && it.id==a.hashCode()) })
                check(ids.filterIndexed { index,_->tags[index] in ownedTags }.all { findTap(0,newIntent(it))==null })
                if(ownedLegacy)check(findTap(a.hashCode(),oldIntent())==null)
            }.onFailure { cleanupFailure=true }
        }
        val passed=failure==null && !cleanupFailure
        finish(if(passed)Activity.RESULT_OK else Activity.RESULT_CANCELED,Bundle().apply {
            putString("notification_identity",if(passed)"passed" else "failed: ${failure ?: "cleanup unconfirmed"}")
            putString("stream","\nNotification identity ${if(passed)"passed" else "failed"}; provider delivery not tested.\n")
        })
    }
}
