package android.app
import android.content.Context
import android.content.FakeSystem
import android.content.Intent
class Notification { companion object { const val VISIBILITY_PRIVATE=0 } }
class NotificationChannel(val id:String,val name:String,val importance:Int) { var description="";var lockscreenVisibility=0 }
data class StatusBarNotification(val packageName:String?,val tag:String?,val id:Int)
class NotificationManager {
    companion object { const val IMPORTANCE_DEFAULT=3 }
    private val rows=linkedSetOf<StatusBarNotification>()
    private val queued=linkedSetOf<String>()
    val activeNotifications:Array<StatusBarNotification> get()=synchronized(this) { rows.toTypedArray() }
    fun seed(row:StatusBarNotification)=synchronized(this) { rows.add(row);Unit }
    fun queuedTags():Set<String> = synchronized(this) { queued.toSet() }
    fun createNotificationChannel(channel:NotificationChannel) {}
    fun cancel(tag:String?,id:Int)=synchronized(this) {
        rows.removeAll { it.packageName=="com.lovelies.memories" && it.tag==tag && it.id==id }
        if(id==0 && tag!=null)queued.remove(tag)
        Unit
    }
    fun enqueue(tag:String,id:Int,notification:Notification) {
        FakeSystem.beforeNotify?.invoke()
        synchronized(this) { queued.add(tag) }
    }
}
class PendingIntent private constructor() {
    companion object {
        const val FLAG_UPDATE_CURRENT=0x08000000;const val FLAG_IMMUTABLE=0x04000000
        fun getActivity(context:Context,requestCode:Int,intent:Intent,flags:Int)=PendingIntent()
    }
}
