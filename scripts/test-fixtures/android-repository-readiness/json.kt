package org.json
/** JSON parsing must use the injected production repository boundary in this
 * suite; an accidental real transport invocation fails rather than being faked. */
class JSONObject(raw:String) {
    init { error("JSON/platform transport unavailable in injected host fixture") }
    fun optJSONObject(name:String):JSONObject?=error("unreachable")
    fun optString(name:String):String=error("unreachable")
}
