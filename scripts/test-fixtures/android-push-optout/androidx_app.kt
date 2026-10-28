package androidx.core.app
import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.FakeSystem
class NotificationCompat { companion object { const val VISIBILITY_PRIVATE=0 }
    class Builder(private val context:Context,private val channel:String) {
        fun setSmallIcon(id:Int)=this
        fun setContentTitle(value:String)=this
        fun setContentText(value:String)=this
        fun setVisibility(value:Int)=this
        fun setContentIntent(value:PendingIntent)=this
        fun setAutoCancel(value:Boolean)=this
        fun build():Notification { FakeSystem.beforeBuild?.invoke();return Notification() }
    }
}
class NotificationManagerCompat { companion object { fun from(context:Context)=NotificationManagerCompat() }
    fun notify(tag:String,id:Int,notification:Notification) { FakeSystem.manager.enqueue(tag,id,notification) }
}
