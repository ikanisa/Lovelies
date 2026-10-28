package android.content
import android.app.NotificationManager
import java.util.concurrent.ConcurrentHashMap
open class Context {
    companion object { const val MODE_PRIVATE=0 }
    open val packageName="com.lovelies.memories"
    open fun getSharedPreferences(name:String,mode:Int)=FakeSystem.preferences.computeIfAbsent(name) { SharedPreferences() }
    open fun <T> getSystemService(type:Class<T>):T=type.cast(FakeSystem.manager)
    open fun getString(id:Int)=when(id) { 1->"Updates";2->"Private";3->"Lovelies";4->"Open Lovelies";else->"unknown" }
}
class SharedPreferences {
    private val values=ConcurrentHashMap<String,Boolean>()
    fun getBoolean(key:String,default:Boolean)=values[key] ?: default
    fun edit()=Editor(values)
    class Editor(private val values:MutableMap<String,Boolean>) {
        private val staged=mutableMapOf<String,Boolean>()
        fun putBoolean(key:String,value:Boolean)=apply { staged[key]=value }
        fun commit():Boolean { values.putAll(staged);return FakeSystem.commitResult }
        fun apply() { commit() }
    }
}
class Intent(val context:Context?=null,val component:Class<*>?=null) {
    companion object { const val FLAG_ACTIVITY_SINGLE_TOP=0x20000000;const val FLAG_ACTIVITY_CLEAR_TOP=0x04000000 }
    var action:String?=null;private set
    fun setAction(value:String)=apply { action=value }
    fun putExtra(name:String,value:String)=this
    fun addFlags(value:Int)=this
}
object FakeSystem {
    val preferences=ConcurrentHashMap<String,SharedPreferences>()
    @Volatile var manager=NotificationManager()
    @Volatile var permission=0
    @Volatile var commitResult=true
    @Volatile var beforeBuild:(()->Unit)?=null
    @Volatile var beforeNotify:(()->Unit)?=null
    fun reset() { preferences.clear();manager=NotificationManager();permission=0;commitResult=true;beforeBuild=null;beforeNotify=null;com.google.firebase.messaging.FakeFirebase.reset() }
}
