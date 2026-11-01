package android.net
class Uri private constructor(private val value:String) {
    override fun toString()=value
    companion object { fun parse(value:String)=Uri(value) }
}
