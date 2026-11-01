package androidx.compose.runtime
import kotlin.reflect.KProperty
/** State storage only; no Compose rendering or Android application is simulated. */
class MutableState<T>(@Volatile var value:T) {
    operator fun getValue(owner:Any?,property:KProperty<*>)=value
    operator fun setValue(owner:Any?,property:KProperty<*>,next:T) { value=next }
}
fun <T> mutableStateOf(value:T)=MutableState(value)
fun <T> mutableStateListOf()=mutableListOf<T>()
