package com.lovelies.frontend.preview

enum class CameraPermissionState { NOT_REQUESTED, GRANTED, DENIED, PERMANENTLY_DENIED, REVOKED }
enum class CameraPhase { IDLE, INITIALIZING, READY, CAPTURING, REVIEW, INTERRUPTED, FAILED }
data class CameraStatus(val phase: CameraPhase, val code: String?=null)

internal fun cameraPermission(granted: Boolean,requested: Boolean,rationale: Boolean,previouslyGranted: Boolean): CameraPermissionState = when {
    granted -> CameraPermissionState.GRANTED
    previouslyGranted -> CameraPermissionState.REVOKED
    !requested -> CameraPermissionState.NOT_REQUESTED
    rationale -> CameraPermissionState.DENIED
    else -> CameraPermissionState.PERMANENTLY_DENIED
}

/** A producer lease belongs to one camera instance and one immutable capture owner. */
internal class CameraProducer(private val owner: NativeCaptureContext) {
    private var generation=0L
    private var phase=CameraPhase.IDLE
    @Synchronized fun initialize(): Long { generation++;phase=CameraPhase.INITIALIZING;return generation }
    @Synchronized fun ready(token: Long): Boolean {
        if(token!=generation || phase!=CameraPhase.INITIALIZING)return false
        phase=CameraPhase.READY;return true
    }
    @Synchronized fun shutter(token: Long,current: NativeCaptureContext?): Boolean {
        if(token!=generation || phase!=CameraPhase.READY || owner!=current)return false
        phase=CameraPhase.CAPTURING;return true
    }
    @Synchronized fun frame(token: Long,bytes: ByteArray): Boolean {
        if(token!=generation || phase!=CameraPhase.CAPTURING) { bytes.fill(0);return false }
        phase=CameraPhase.REVIEW;return true
    }
    @Synchronized fun isCurrent(token: Long)=token==generation && phase !in setOf(CameraPhase.FAILED,CameraPhase.INTERRUPTED)
    @Synchronized fun fail(token: Long): Boolean {
        if(!isCurrent(token))return false
        generation++;phase=CameraPhase.FAILED;return true
    }
    @Synchronized fun interrupt() { generation++;phase=CameraPhase.INTERRUPTED }
}

/** One unsent JPEG, kept only in memory. Review is not face-quality or authentication proof. */
internal data class CameraReviewFrame(val owner: NativeCaptureContext,val bytes: ByteArray,val created: Long) {
    override fun toString()="CameraReviewFrame(unsent=true,bytes=${bytes.size})"
}
internal class CameraReviewBuffer(private val now: ()->Long={System.currentTimeMillis()}) {
    companion object { const val MAX_BYTES=8*1024*1024;const val MAX_AGE_MS=120000L }
    private var value: CameraReviewFrame?=null
    @Synchronized fun offer(bytes: ByteArray,owner: NativeCaptureContext,current: NativeCaptureContext?): Boolean {
        if(bytes.isEmpty() || bytes.size>MAX_BYTES || owner!=current || value!=null) { bytes.fill(0);return false }
        value=CameraReviewFrame(owner,bytes,now());return true
    }
    @Synchronized fun owner()=value?.owner
    @Synchronized fun approve(current: NativeCaptureContext?): CameraReviewFrame? {
        val frame=value ?: return null;value=null
        if(frame.owner!=current || now()<frame.created || now()-frame.created>MAX_AGE_MS) { frame.bytes.fill(0);return null }
        return frame
    }
    @Synchronized fun clear() { value?.bytes?.fill(0);value=null }
}

internal fun cameraJpegOrientation(sensor: Int,displayDegrees: Int,front: Boolean): Int =
    (sensor+(if(front)displayDegrees else -displayDegrees)+360)%360

/** Durable one-use ordinary login hold. It never stores JPEG bytes or creates a new device key. */
internal data class CameraLoginJournal(val origin: String,val account: String,val alias: String,val device: String,
    val challenge: WireObject,val state: String="ready",val capture: EnrollmentCapture?=null,
    val completion: WireObject?=null,val credentials: WireObject?=null) {
    override fun toString()="CameraLoginJournal(state=$state,capture_present=${capture!=null},credentials_present=${credentials!=null})"
    fun wire(): WireObject=mapOf("protocol" to "lovelies-camera-login-v1","origin" to origin,"account" to account,
        "alias" to alias,"device" to device,"challenge" to challenge,"state" to state,"capture" to capture?.wire(),
        "completion" to completion,"credentials" to credentials)
    fun assertOwner(origin: String,account: String,alias: String,device: String) {
        if(this.origin!=origin || this.account!=account || this.alias!=alias || this.device!=device)throw LiveFailure("face_login_scope_changed")
    }
    fun expired(now: Long)=java.time.Instant.parse(NativeProtocol.text(challenge["expires_at"],100)).toEpochMilli()<=now
    fun blocked(now: Long)=state in setOf("capture_pending","completion_pending") && !expired(now)
    fun plan(bytes: ByteArray): CameraLoginJournal {
        if(state!="ready" || bytes.isEmpty() || bytes.size>CameraReviewBuffer.MAX_BYTES)throw LiveFailure("face_login_requires_status")
        return copy(state="capture_pending",capture=EnrollmentCapture(0,NativeProtocol.sha256(bytes),"image/jpeg",bytes.size.toLong()))
    }
    fun complete(body: WireObject): CameraLoginJournal {
        if(state!="capture_pending" || capture==null || body["challenge_id"]!=challenge["challenge_id"] ||
            (body["device_signature"] as? String)?.matches(Regex("[A-Za-z0-9_-]{86}"))!=true)throw LiveFailure("face_login_response_changed")
        return copy(state="completion_pending",completion=body)
    }
    fun terminal(problem: LiveFailure)=problem.status==422 && isFaceCaptureRejection(problem.code) ||
        problem.status==401 && problem.code=="face_verification_failed"
    fun assertCredentialBinding(value: WireObject) {
        if(value["protocol"]!="lovelies-face-auth-v1" || value["status"]!="authenticated" || value["account_id"]!=account ||
            value["auth_method"]!="registered_face" || value["device_id"]!=device || value["profile_id"]!=challenge["profile_id"] ||
            value["profile_revision"]!=challenge["profile_revision"] || value["model_id"]!=challenge["model_id"])throw LiveFailure("face_login_response_changed")
    }
    /** Expired staged authority is stripped durably; the uncertain proof and key remain. */
    fun withoutExpiredCredentials(expires: Long,now: Long): CameraLoginJournal =
        if(state=="credentials_pending" && expires<=now)copy(state="completion_pending",credentials=null) else this
    fun forExplicitLogout(): CameraLoginJournal =
        if(state=="credentials_pending")copy(state="completion_pending",credentials=null) else this
    companion object {
        fun restore(value: Any?,origin: String): CameraLoginJournal {
            try {
                val wire=NativeProtocol.obj(value)
                if(wire.keys!=setOf("protocol","origin","account","alias","device","challenge","state","capture","completion","credentials") ||
                    NativeProtocol.canonical(wire).toByteArray().size>65536)throw LiveFailure("face_login_response_changed")
                val state=NativeProtocol.text(wire["state"])
                val account=NativeProtocol.id(wire["account"]);val device=NativeProtocol.id(wire["device"])
                val alias=NativeProtocol.text(wire["alias"],200);val challenge=NativeProtocol.obj(wire["challenge"])
                if(wire["protocol"]!="lovelies-camera-login-v1" || wire["origin"]!=origin || !alias.startsWith("lovelies.device.") ||
                    state !in setOf("ready","capture_pending","completion_pending","rejected","credentials_pending"))throw LiveFailure("face_login_response_changed")
                NativeProtocol.bindFaceChallenge(challenge,account,"login",device)
                if(challenge["protocol"]!="lovelies-face-auth-v1")throw LiveFailure("face_login_response_changed")
                NativeProtocol.id(challenge["challenge_id"]);NativeProtocol.id(challenge["profile_id"])
                NativeProtocol.text(challenge["nonce"],1000);NativeProtocol.text(challenge["policy_version"],200)
                NativeProtocol.text(challenge["profile_revision"],200);NativeProtocol.text(challenge["model_id"],200)
                if(NativeProtocol.integer(challenge["required_captures"],1,3)!=1L || challenge["poses"]!=listOf("front") ||
                    java.time.Instant.parse(NativeProtocol.text(challenge["expires_at"],100)).toEpochMilli()<=0)
                    throw LiveFailure("face_login_response_changed")
                val capture=wire["capture"]?.let { row->
                    val item=NativeProtocol.obj(row)
                    EnrollmentCapture(NativeProtocol.integer(item["index"],0,0).toInt(),NativeProtocol.text(item["sha256"]),
                        NativeProtocol.text(item["mime"]),NativeProtocol.integer(item["byte_size"],1,CameraReviewBuffer.MAX_BYTES.toLong())).also {
                        if(!it.hash.matches(Regex("[a-f0-9]{64}")) || it.mime!="image/jpeg")throw LiveFailure("face_login_response_changed")
                    }
                }
                val complete=wire["completion"]?.let(NativeProtocol::obj);val credentials=wire["credentials"]?.let(NativeProtocol::obj)
                if(state=="ready" && (capture!=null || complete!=null || credentials!=null) ||
                    state in setOf("capture_pending","completion_pending","credentials_pending") && capture==null ||
                    state in setOf("completion_pending","credentials_pending") && complete==null ||
                    state=="credentials_pending" && credentials==null || state!="credentials_pending" && credentials!=null ||
                    complete!=null && (complete["challenge_id"]!=challenge["challenge_id"] ||
                    (complete["device_signature"] as? String)?.matches(Regex("[A-Za-z0-9_-]{86}"))!=true))throw LiveFailure("face_login_response_changed")
                return CameraLoginJournal(origin,account,alias,device,challenge,state,capture,complete,credentials)
            } catch(problem: LiveFailure) { throw problem }
            catch(problem: Exception) { throw LiveFailure("face_login_response_changed") }
        }
    }
}

internal fun assertCameraLoginSession(record: CameraLoginJournal,me: WireObject,devices: WireObject) {
    val current=NativeProtocol.rows(devices["items"]).filter { it["current"]==true }.singleOrNull()
    if(me["authenticated"]!=true || me["user_id"]!=record.account || me["auth_method"]!="registered_face" ||
        me["profile_id"]!=record.challenge["profile_id"] || me["profile_revision"]!=record.challenge["profile_revision"] ||
        current?.get("id")!=record.device || current?.get("status")!="active")throw LiveFailure("face_login_response_changed")
}

internal data class CameraLoginOwner(val account: String,val alias: String,val device: String,val jwk: WireObject?=null) {
    fun assertKey(actual: WireObject) {
        if(jwk!=null && NativeProtocol.canonical(jwk)!=NativeProtocol.canonical(actual))throw LiveFailure("device_key_unavailable")
    }
}
/** An active recovery owns the target key even while an old source identity is retained. */
internal fun selectCameraLoginOwner(record: CameraLoginJournal,active: CameraLoginOwner?,stable: CameraLoginOwner?): CameraLoginOwner {
    val selected=active ?: stable ?: throw LiveFailure("face_login_scope_changed")
    record.assertOwner(record.origin,selected.account,selected.alias,selected.device)
    return selected
}

internal fun isFaceCaptureRejection(code: String)=code in setOf("face_capture_no_face","face_capture_multiple_faces",
    "face_capture_quality_low","face_capture_invalid_image")

internal fun cameraRecoveryMessage(code: String,context: android.content.Context): String=context.getString(when(code) {
    "camera_permission_required" -> R.string.camera_recovery_permission_required
    "camera_initialization_timeout" -> R.string.camera_recovery_initialization_timeout
    "camera_disconnected" -> R.string.camera_recovery_disconnected
    "camera_surface_replaced" -> R.string.camera_recovery_surface_replaced
    "camera_unavailable" -> R.string.camera_recovery_unavailable
    "capture_failed","capture_timeout" -> R.string.camera_recovery_capture_failed
    "camera_review_expired","capture_context_changed" -> R.string.camera_recovery_review_expired
    "camera_image_invalid","face_capture_invalid_image","capture_format_invalid" -> R.string.camera_recovery_image_invalid
    "capture_too_large" -> R.string.camera_recovery_capture_too_large
    "face_capture_no_face" -> R.string.camera_recovery_no_face
    "face_capture_multiple_faces" -> R.string.camera_recovery_multiple_faces
    "face_capture_quality_low" -> R.string.camera_recovery_quality_low
    else -> R.string.camera_recovery_cannot_continue
})
