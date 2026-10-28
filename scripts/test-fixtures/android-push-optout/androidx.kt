package androidx.core.content
import android.content.Context
import android.content.FakeSystem
object ContextCompat { fun checkSelfPermission(context:Context,permission:String):Int = FakeSystem.permission }
