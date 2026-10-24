package com.lovelies.frontend.preview

import java.math.BigDecimal
import java.net.URI
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64

class LiveFailure(val code: String, val status: Int = 0, val ambiguous: Boolean = false) : Exception(code)
typealias WireObject = Map<String, Any?>

object NativeProtocol {
    private val ids = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
    fun id(value: Any?): String = (value as? String)?.takeIf { ids.matches(it) }?.lowercase() ?: throw LiveFailure("invalid_response")
    fun text(value: Any?, maximum: Int = 1000): String = (value as? String)?.takeIf { it.length <= maximum } ?: throw LiveFailure("invalid_response")
    fun mediaSource(value: Any?,expected: String?=null,code: String="source_mismatch"): String {
        val source=(value as? String)?.takeIf { it=="personal" } ?: throw LiveFailure(code)
        if(expected!=null && source!=expected)throw LiveFailure(code)
        return source
    }
    fun operationSource(action: String,value: Any?): String =
        if(action.startsWith("sharing.") || action.startsWith("photo.upload.") || action=="request.decide")mediaSource(value) else text(value)
    fun credentialRoles(value: Any?): List<String> {
        val roles=value as? List<*> ?: throw LiveFailure("credentials_invalid")
        if(roles.isEmpty() || roles.size>2 || roles.toSet().size!=roles.size || roles.any { it !in listOf("user","admin") })throw LiveFailure("credentials_invalid")
        return roles.map { it as String }
    }
    fun validateActionPayload(action: String,payload: WireObject) {
        if(action=="sharing.photos.validate")throw LiveFailure("unsupported_action")
        if(action=="photos") {
            if(payload.containsKey("source") && payload["source"] !in listOf("all","received","contributions"))throw LiveFailure("source_mismatch")
        } else if(action.startsWith("sharing.") || action.startsWith("photo.upload.") || action in listOf("request.decide","photos.validate")) {
            if(payload.containsKey("source"))mediaSource(payload["source"])
        }
    }
    fun bindSharingSource(response: WireObject,action: String,expected: String,code: String="source_mismatch"): String {
        mediaSource(expected,code=code)
        if(response["protocol"]!="reviewed-sharing-v1")throw LiveFailure(code)
        val source=when {
            action=="sharing.snapshot" && response["status"]=="ready" -> obj(response["snapshot"])["source"]
            action=="sharing.preview" && response["status"]=="ready" -> obj(response["preview"])["source"]
            else -> response["source"]
        }
        return mediaSource(source,expected,code)
    }
    fun obj(value: Any?): WireObject = (value as? Map<*, *>)?.entries?.associate { (key,value) -> (key as? String ?: throw LiveFailure("invalid_response")) to value } ?: throw LiveFailure("invalid_response")
    fun rows(value: Any?, limit: Int = 100): List<WireObject> = (value as? List<*>)?.takeIf { it.size <= limit }?.map(::obj) ?: throw LiveFailure("invalid_response")
    fun integer(value: Any?, minimum: Long = 0, maximum: Long = Long.MAX_VALUE): Long {
        val number = value as? Number ?: throw LiveFailure("invalid_response")
        val long = number.toLong()
        if (number.toDouble() != long.toDouble() || long !in minimum..maximum) throw LiveFailure("invalid_response")
        return long
    }
    fun idList(value: Any?, limit: Int = 100): List<String> {
        val list = (value as? List<*>)?.takeIf { it.size <= limit }?.map(::id) ?: throw LiveFailure("invalid_response")
        if (list.toSet().size != list.size) throw LiveFailure("invalid_response")
        return list
    }
    fun expiry(value: Any?, now: Long): Long {
        val time = runCatching { Instant.parse(text(value)).toEpochMilli() }.getOrElse { throw LiveFailure("invalid_response") }
        if (time <= now) throw LiveFailure("review_expired")
        return time
    }
    fun baseUrl(raw: String, debug: Boolean): String {
        val uri = runCatching { URI(raw) }.getOrElse { throw LiveFailure("invalid_api_endpoint") }
        val local = uri.host in setOf("10.0.2.2", "localhost", "127.0.0.1")
        if (uri.userInfo != null || uri.fragment != null || uri.query != null || uri.host.isNullOrEmpty()
            || uri.path !in listOf("", "/", "/functions/v1/lovelies-api", "/functions/v1/lovelies-api/") || (uri.scheme != "https" && !(debug && local && uri.scheme == "http"))) throw LiveFailure("invalid_api_endpoint")
        return raw.trimEnd('/')
    }
    /** Capability URLs remain on the configured API and cannot escape the Edge Function prefix. */
    fun downloadPath(raw: String,base: String): String {
        val origin=URI(base);val target=runCatching { URI(raw) }.getOrElse { throw LiveFailure("download_authority_changed") }
        val prefix=origin.path.trimEnd('/')
        val path=target.rawPath ?: throw LiveFailure("download_authority_changed")
        if(target.scheme!=origin.scheme || target.host!=origin.host || target.port!=origin.port || target.userInfo!=null || target.rawQuery!=null || target.rawFragment!=null
            || !path.startsWith(prefix+"/downloads/"))throw LiveFailure("download_authority_changed")
        val relative=path.removePrefix(prefix)
        if(!Regex("/downloads/[0-9a-fA-F-]{36}").matches(relative))throw LiveFailure("download_authority_changed")
        id(relative.substringAfterLast('/'));return relative
    }
    fun canonical(value: Any?): String = when (value) {
        null -> "null"
        is String -> quote(value)
        is Boolean -> value.toString()
        is Byte, is Short, is Int, is Long -> value.toString()
        is Number -> {
            if (!value.toDouble().isFinite()) throw LiveFailure("invalid_wire_number")
            BigDecimal.valueOf(value.toDouble()).stripTrailingZeros().toPlainString()
        }
        is Map<*, *> -> value.entries.map { (k,v) -> (k as? String ?: throw LiveFailure("invalid_wire_key")) to v }
            .sortedBy { it.first }.joinToString(",", "{", "}") { quote(it.first) + ":" + canonical(it.second) }
        is List<*> -> value.joinToString(",", "[", "]") { canonical(it) }
        else -> throw LiveFailure("invalid_wire_value")
    }
    private fun quote(value: String): String = buildString {
        append('"')
        value.forEachIndexed { index,c ->
            when (c) {
                '"' -> append("\\\""); '\\' -> append("\\\\"); '\b' -> append("\\b")
                '\u000c' -> append("\\f"); '\n' -> append("\\n"); '\r' -> append("\\r"); '\t' -> append("\\t")
                else -> if (c.code < 32 || c.isSurrogate() && !(c.isHighSurrogate() && index+1 < value.length && value[index+1].isLowSurrogate()
                    || c.isLowSurrogate() && index>0 && value[index-1].isHighSurrogate())) append("\\u%04x".format(c.code)) else append(c)
            }
        }
        append('"')
    }
    fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    fun base64(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    fun derToRaw(der: ByteArray): ByteArray {
        var position = 0
        fun next(): Int { if (position >= der.size) throw LiveFailure("invalid_device_signature"); return der[position++].toInt() and 255 }
        if (next() != 0x30 || next() != der.size - 2 || der.size !in 8..72) throw LiveFailure("invalid_device_signature")
        fun integer(): ByteArray {
            if (next() != 2) throw LiveFailure("invalid_device_signature")
            val length = next()
            if (length !in 1..33 || position+length > der.size) throw LiveFailure("invalid_device_signature")
            val part = der.copyOfRange(position,position+length); position += length
            if (part[0].toInt() and 128 != 0 || part.size>1 && part[0].toInt()==0 && part[1].toInt() and 128 == 0) throw LiveFailure("invalid_device_signature")
            val unsigned = if(part.size>1 && part[0].toInt()==0)part.copyOfRange(1,part.size) else part
            if (unsigned.size>32 || unsigned.all { it.toInt()==0 }) throw LiveFailure("invalid_device_signature")
            return ByteArray(32).also { unsigned.copyInto(it,32-unsigned.size) }
        }
        val raw = integer()+integer()
        if (position != der.size) throw LiveFailure("invalid_device_signature")
        return raw
    }
    fun faceEnvelope(challenge: WireObject): WireObject = linkedMapOf<String,Any?>("protocol" to "lovelies-face-device-v1").apply {
        listOf("challenge_id","nonce","purpose","account_id","device_id","device_revision","profile_id","profile_revision","policy_version")
            .forEach { put(it,challenge[it]) }
    }
    fun bindFaceChallenge(challenge: WireObject,expectedAccount: String,purpose: String,device: String?=null) {
        if(id(challenge["account_id"])!=expectedAccount || challenge["purpose"]!=purpose
            || device!=null && id(challenge["device_id"])!=device)throw LiveFailure("challenge_identity_changed")
    }
}

data class LivePhoto(val id: String,val version: String,val source: String,val mediaSource: String,
    val title: String,val width: Int?,val height: Int?,val matchId: String?=null,val titleDefaulted: Boolean=false) {
    val ratio: Float get() = if(width != null && height != null) (width.toFloat()/height).coerceIn(.35f,3f) else 1f
    companion object { fun parse(value: WireObject): LivePhoto = LivePhoto(NativeProtocol.id(value["media_asset_id"] ?: value["id"]),
        NativeProtocol.text(value["version"] ?: ""),NativeProtocol.text(value["source"] ?: "received"),
        NativeProtocol.mediaSource(value["media_source"]),NativeProtocol.text(value["title"] ?: "Photo"),
        value["width"]?.let { NativeProtocol.integer(it,1,100000).toInt() },value["height"]?.let { NativeProtocol.integer(it,1,100000).toInt() },value["match_id"]?.let(NativeProtocol::id),titleDefaulted=value["title"]==null) }
}
data class LivePair(val photo: String,val person: String,val version: String = "") {
    fun wire(): WireObject = mapOf("asset_id" to photo,"recipient_id" to person)
}
data class LivePerson(val id: String,val name: String)
data class LiveSnapshot(val id: String,val version: String,val source: String,val expires: Long,
    val photos: List<LivePhoto>,val people: List<LivePerson>,val pairs: List<LivePair>,val limited: Boolean,val wire: WireObject) {
    companion object { fun parse(response: WireObject,now: Long,requestedSource: String,assetIds: List<String>?): LiveSnapshot {
        if(response["protocol"]!="reviewed-sharing-v1" || response["status"]!="ready")throw LiveFailure("invalid_snapshot")
        val value = NativeProtocol.obj(response["snapshot"]); val source = NativeProtocol.bindSharingSource(response,"sharing.snapshot",requestedSource)
        val photos = NativeProtocol.rows(value["assets"]).map(LivePhoto::parse)
        if(photos.map { it.id }.toSet().size != photos.size || assetIds != null && photos.map { it.id }.toSet()!=assetIds.toSet())throw LiveFailure("snapshot_scope_changed")
        if(photos.any { it.mediaSource!=source })throw LiveFailure("source_mismatch")
        val people = NativeProtocol.rows(value["recipients"]).map { LivePerson(NativeProtocol.id(it["id"]),NativeProtocol.text(it["name"])) }
        if(people.map { it.id }.toSet().size!=people.size)throw LiveFailure("invalid_snapshot")
        val pairs = NativeProtocol.rows(value["pairs"],1000).map { LivePair(NativeProtocol.id(it["asset_id"]),NativeProtocol.id(it["recipient_id"]),NativeProtocol.text(it["version"])) }
        if(pairs.map { it.photo to it.person }.toSet().size!=pairs.size || pairs.any { p -> photos.none { it.id==p.photo } || people.none { it.id==p.person } })throw LiveFailure("invalid_snapshot")
        val scope = NativeProtocol.obj(value["scope"])
        NativeProtocol.integer(scope["asset_limit"],1,100); NativeProtocol.integer(scope["recipient_limit"],1,100);NativeProtocol.integer(scope["pair_limit"],1,1000)
        if(scope["has_more"] !is Boolean || scope["selection_limited"] !is Boolean)throw LiveFailure("invalid_snapshot")
        return LiveSnapshot(NativeProtocol.id(value["id"]),NativeProtocol.text(value["version"]),source,NativeProtocol.expiry(value["expires_at"],now),photos,people,pairs,
            scope["has_more"]==true || scope["selection_limited"]==true,value)
    } }
}
data class LiveDraft(val version: Int,val photos: Set<String>,val people: Set<String>,val excluded: Set<LivePair>) {
    fun effective(snapshot: LiveSnapshot): List<LivePair> {
        if(version<1 || photos.any { id -> snapshot.photos.none { it.id==id } } || people.any { id -> snapshot.people.none { it.id==id } }
            || excluded.any { p -> snapshot.pairs.none { it.photo==p.photo && it.person==p.person } })throw LiveFailure("selection_outside_snapshot")
        return snapshot.pairs.filter { it.photo in photos && it.person in people && excluded.none { x -> x.photo==it.photo && x.person==it.person } }
    }
    fun wire(snapshot: LiveSnapshot): WireObject = mapOf("snapshot_id" to snapshot.id,"snapshot_version" to snapshot.version,"draft_version" to version,
        "selected_asset_ids" to photos.sorted(),"selected_recipient_ids" to people.sorted(),"excluded_pairs" to excluded.sortedWith(compareBy({it.photo},{it.person})).map(LivePair::wire))
}
data class LivePreview(val id: String,val version: String,val draftVersion: Int,val expires: Long,val pairs: List<LivePair>,val wire: WireObject) {
    companion object { fun parse(response: WireObject,snapshot: LiveSnapshot,draft: LiveDraft,now: Long): LivePreview {
        NativeProtocol.bindSharingSource(response,"sharing.preview",snapshot.source,"review_scope_changed")
        if(response["status"]=="changed")throw LiveFailure("review_changed",409)
        if(response["protocol"]!="reviewed-sharing-v1" || response["status"]!="ready")throw LiveFailure("empty_review")
        val value=NativeProtocol.obj(response["preview"])
        if(value["draft_version"] != draft.version)throw LiveFailure("review_scope_changed")
        val pairs=NativeProtocol.rows(value["pairs"],1000).map { LivePair(NativeProtocol.id(it["asset_id"]),NativeProtocol.id(it["recipient_id"])) }
        if(pairs.map { it.photo to it.person }.toSet()!=draft.effective(snapshot).map { it.photo to it.person }.toSet() || pairs.size!=draft.effective(snapshot).size)throw LiveFailure("review_scope_changed")
        validateManifest(value,pairs)
        val expiry=NativeProtocol.expiry(value["expires_at"],now);if(expiry>snapshot.expires)throw LiveFailure("review_scope_changed")
        return LivePreview(NativeProtocol.id(value["id"]),NativeProtocol.text(value["version"]),draft.version,expiry,pairs,value)
    } }
}
fun validateManifest(value: WireObject,pairs: List<LivePair>) {
    val totals=NativeProtocol.obj(value["totals"]);val people=NativeProtocol.rows(value["recipients"])
    if(NativeProtocol.integer(totals["photos"])!=pairs.map { it.photo }.toSet().size.toLong()
        || NativeProtocol.integer(totals["recipients"])!=pairs.map { it.person }.toSet().size.toLong()
        || NativeProtocol.integer(totals["pairs"])!=pairs.size.toLong() || people.size!=pairs.map { it.person }.toSet().size)throw LiveFailure("invalid_manifest")
    val seen=mutableSetOf<String>()
    people.forEach { person -> val id=NativeProtocol.id(person["recipient_id"]);val photos=NativeProtocol.idList(person["asset_ids"])
        if(!seen.add(id) || photos.toSet()!=pairs.filter { it.person==id }.map { it.photo }.toSet() || NativeProtocol.integer(person["photo_count"])!=photos.size.toLong())throw LiveFailure("invalid_manifest") }
}
fun validateOutcome(value: WireObject,preview: LivePreview,source: String,key: String): WireObject {
    NativeProtocol.bindSharingSource(value,"sharing.commit",source,"invalid_receipt")
    NativeProtocol.mediaSource(preview.wire["source"],source,"invalid_receipt")
    if(value["status"]=="changed")throw LiveFailure("review_changed",409)
    if(value["protocol"]!="reviewed-sharing-v1" || value["operation_key"]!=key
        || value["status"] !in listOf("pending_acceptance","access_available","partial","unavailable"))throw LiveFailure("invalid_receipt")
    if(value["status"]=="unavailable" && value["recipients"]==null)return value
    if(value["preview_id"]!=preview.id)throw LiveFailure("receipt_scope_changed")
    val people=NativeProtocol.rows(value["recipients"]);val pairs=people.flatMap { person -> NativeProtocol.idList(person["asset_ids"]).map { LivePair(it,NativeProtocol.id(person["recipient_id"])) } }
    if(pairs.map { it.photo to it.person }.toSet()!=preview.pairs.map { it.photo to it.person }.toSet() || pairs.size!=preview.pairs.size)throw LiveFailure("receipt_scope_changed")
    validateManifest(value,pairs)
    val available=people.sumOf { person ->
        NativeProtocol.id(person["request_id"])
        if(person["status"] !in listOf("requested","accepted","declined","withdrawn","revoked","expired","failed","unknown"))throw LiveFailure("invalid_receipt")
        NativeProtocol.integer(person["available_count"],0,NativeProtocol.idList(person["asset_ids"]).size.toLong())
    }
    val total=pairs.size.toLong()
    when(value["status"]) { "pending_acceptance" -> if(available!=0L || NativeProtocol.integer(value["grants_created"])!=0L)throw LiveFailure("invalid_receipt")
        "access_available" -> if(available!=total)throw LiveFailure("invalid_receipt")
        "partial" -> if(available<=0 || available>=total)throw LiveFailure("invalid_receipt")
        "unavailable" -> if(available!=0L)throw LiveFailure("invalid_receipt") }
    return value
}
