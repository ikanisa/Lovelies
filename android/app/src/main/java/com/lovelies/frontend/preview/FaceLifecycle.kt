package com.lovelies.frontend.preview

import java.security.SecureRandom
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CancellationException

internal fun <T> persistLifecycle(candidate: WireObject,write: (WireObject)->Unit,publish: (WireObject)->T): T {
    val staged=candidate.toMap()
    try { write(staged) } catch(problem: Exception) {
        if(problem is CancellationException)throw problem
        throw LiveFailure("face_profile_storage_unavailable")
    }
    return publish(staged)
}
internal fun <T> withLifecyclePhase(fence: SessionFence,scope: SessionScope,expected: FaceLifecycleJournal,
    current: ()->FaceLifecycleJournal?,body: ()->T): T = synchronized(fence) {
    fence.assert(scope);expected.assertIntent(current());body()
}
private fun lifecycleText(value: Any?): String=NativeProtocol.text(value).takeIf { it.isNotBlank() }
    ?: throw LiveFailure("face_profile_response_changed")
private fun lifecycleProfile(value: Any?): WireObject?=value?.let {
    val row=NativeProtocol.obj(it)
    mapOf("id" to NativeProtocol.id(row["id"]),"revision" to lifecycleText(row["revision"]),"model_id" to lifecycleText(row["model_id"]))
}
internal fun assertLifecycleSession(record: FaceLifecycleJournal,meta: FaceLifecycleMetadata,me: WireObject,devices: WireObject,profile: WireObject?=null) {
    if(!meta.authenticationEnabled || meta.profile==null || meta.removal!="none" || profile!=null && meta.profile!=profile ||
        me["user_id"]!=record.account || me["authenticated"]!=true || me["auth_method"]!="registered_face" ||
        me["profile_id"]!=meta.profile["id"] || me["profile_revision"]!=meta.profile["revision"] ||
        NativeProtocol.rows(devices["items"]).singleOrNull { it["current"]==true && it["status"]=="active" }?.get("id")!=record.device)
        throw LiveFailure("face_profile_response_changed")
}
internal data class LifecycleAbsentResolution(val journal: FaceLifecycleJournal,val retryOriginal: Boolean)
internal fun heldAnonymousLogoutCredentials(value: Any?,unresolvedGuestWork: Boolean): WireObject? {
    if(!unresolvedGuestWork || value==null)return null
    return NativeProtocol.obj(value).takeIf { it["auth_method"]=="anonymous" }
}
data class FaceLifecycleOperation(val key: String,val action: String,val state: String,val generation: Long,val challengeId: String?,
    val challenge: WireObject?,val captures: List<EnrollmentCapture>,val cleanup: String,val wire: WireObject) {
    companion object {
        fun parse(value: Any?): FaceLifecycleOperation {
            val row=NativeProtocol.obj(value);val action=lifecycleText(row["action"]);val state=lifecycleText(row["state"])
            if(action !in FaceLifecycleIntent.actions || state !in setOf("applied","pending","capture_pending","verifying","restart_required","completed","cancelled","failed"))
                throw LiveFailure("face_profile_response_changed")
            val cleanup=lifecycleText(row["cleanup_state"])
            if(cleanup !in FaceLifecycleMetadata.removalStates)throw LiveFailure("face_profile_response_changed")
            val captures=NativeProtocol.rows(row["captures"],3).map(EnrollmentCapture::parse)
            val generation=NativeProtocol.integer(row["generation"],0,1000000)
            if(action in setOf("replace","restore_authentication","enroll") && generation<1 || action !in setOf("replace","restore_authentication","enroll") && generation!=0L)
                throw LiveFailure("face_profile_response_changed")
            if(captures.map { it.index }.distinct().size!=captures.size || state in setOf("applied","completed") && (row["challenge"]!=null || captures.isNotEmpty()))
                throw LiveFailure("face_profile_capture_changed")
            return FaceLifecycleOperation(NativeProtocol.id(row["operation_key"]),action,state,generation,
                row["challenge_id"]?.let(NativeProtocol::id),row["challenge"]?.let(NativeProtocol::obj),captures,cleanup,row)
        }
    }
}
data class FaceLifecycleMetadata(val version: Long,val deviceRevision: String,val authPolicy: String,val photoPolicy: String,
    val profile: WireObject?,val authenticationEnabled: Boolean,val matchingEnabled: Boolean,val processingEnabled: Boolean,
    val receiveMatches: Boolean,val matchingPaused: Boolean,val removal: String,val operation: FaceLifecycleOperation?,val wire: WireObject) {
    companion object {
        val removalStates=setOf("none","pending","failed","blocked","completed")
        fun parse(value: WireObject,account: String,device: String,digest: String,revision: String?=null,nonce: String?=null,minimum: Long=1): FaceLifecycleMetadata {
            if(value["protocol"]!="lovelies-face-profile-v1" || value["authenticated"]!=false || value["account_id"]!=account || value["device_id"]!=device ||
                value["public_key_digest"]!=digest || nonce!=null && value["request_nonce"]!=nonce)throw LiveFailure("face_profile_response_changed")
            val rev=lifecycleText(value["device_revision"])
            if(revision!=null && rev!=revision)throw LiveFailure("face_profile_response_changed")
            val version=NativeProtocol.integer(value["version"],minimum,9007199254740991)
            fun flag(key: String)=value[key] as? Boolean ?: throw LiveFailure("face_profile_response_changed")
            val removal=lifecycleText(value["removal_state"])
            if(removal !in removalStates)throw LiveFailure("face_profile_response_changed")
            return FaceLifecycleMetadata(version,rev,lifecycleText(value["auth_policy_version"]),lifecycleText(value["photo_policy_version"]),lifecycleProfile(value["profile"]),
                flag("authentication_enabled"),flag("matching_enabled"),flag("processing_enabled"),flag("receive_matches"),flag("matching_paused"),removal,
                value["operation"]?.let(FaceLifecycleOperation::parse),value)
        }
    }
}
data class FaceLifecycleIntent(val key: String,val action: String,val expectedVersion: Long,val consent: WireObject?,
    val reference: WireObject?,val authPolicy: String,val photoPolicy: String) {
    val capture get()=action in setOf("replace","restore_authentication","enroll")
    val count get()=if(action=="restore_authentication")1 else 3
    val purpose get()=if(action=="replace")"replacement" else "registration"
    fun body(): WireObject=mapOf("operation_key" to key,"action" to action,"expected_version" to expectedVersion)+(consent?.let { mapOf("consent" to it) } ?: emptyMap())
    fun wire(): WireObject=body()+mapOf("reference" to reference,"auth_policy" to authPolicy,"photo_policy" to photoPolicy)
    companion object {
        val actions=setOf("pause","resume","withdraw_authentication","remove","replace","restore_authentication","enroll")
        fun create(action: String,metadata: FaceLifecycleMetadata): FaceLifecycleIntent {
            if(action !in actions)throw LiveFailure("face_profile_action_invalid")
            if(action=="enroll" && (metadata.removal!="completed" || metadata.profile!=null))throw LiveFailure("face_profile_cleanup_pending")
            if(action in setOf("replace","restore_authentication","resume") && (metadata.profile==null || metadata.removal!="none"))throw LiveFailure("face_profile_reference_unavailable")
            if(action=="replace" && !metadata.authenticationEnabled || action=="restore_authentication" && metadata.authenticationEnabled)
                throw LiveFailure("face_profile_action_invalid")
            val consent=when(action) {
                "resume"->mapOf("purpose" to "photo_matching","policy_version" to metadata.photoPolicy,"granted" to true)
                "replace","restore_authentication","enroll"->mapOf("purpose" to "face_authentication","policy_version" to metadata.authPolicy,"granted" to true)
                else->null
            }
            return FaceLifecycleIntent(UUID.randomUUID().toString(),action,metadata.version,consent,metadata.profile,metadata.authPolicy,metadata.photoPolicy)
        }
        fun restore(value: Any?): FaceLifecycleIntent {
            val row=NativeProtocol.obj(value);val action=lifecycleText(row["action"])
            if(action !in actions)throw LiveFailure("face_profile_action_invalid")
            val result=FaceLifecycleIntent(NativeProtocol.id(row["operation_key"]),action,NativeProtocol.integer(row["expected_version"],1),
                row["consent"]?.let(NativeProtocol::obj),lifecycleProfile(row["reference"]),lifecycleText(row["auth_policy"]),lifecycleText(row["photo_policy"]))
            val expected=when(action) {
                "resume"->mapOf("purpose" to "photo_matching","policy_version" to result.photoPolicy,"granted" to true)
                "replace","restore_authentication","enroll"->mapOf("purpose" to "face_authentication","policy_version" to result.authPolicy,"granted" to true)
                else->null
            }
            if(result.consent!=expected || action=="enroll" && result.reference!=null || action in setOf("replace","restore_authentication") && result.reference==null)
                throw LiveFailure("face_profile_response_changed")
            return result
        }
    }
}
/** Lifecycle control is private management authority only; no status response installs a session. */
data class FaceLifecycleJournal(val origin: String,val account: String,val device: String,val alias: String,val handle: String,val jwk: WireObject,
    val control: String,val controlOperation: String,val metadata: FaceLifecycleMetadata,val acknowledged: Boolean=false,val state: String="control_pending",
    val intent: FaceLifecycleIntent?=null,val generation: Long=0,val challengeId: String?=null,val challenge: WireObject?=null,
    val planned: List<EnrollmentCapture> = emptyList(),val accepted: List<EnrollmentCapture> = emptyList(),val retired: List<EnrollmentCapture> = emptyList(),
    val resume: WireObject?=null,val completion: WireObject?=null,val credentialResult: WireObject?=null,
    val previousControl: String?=null,val loginKey: String?=null) {
    val digest get()=NativeProtocol.sha256(NativeProtocol.canonical(jwk).toByteArray(Charsets.UTF_8))
    val blocksPrivate get()=!acknowledged || intent!=null || !metadata.authenticationEnabled || state!="ready"
    val waiting get()=state in setOf("capture_pending","verifying","completion_pending")
    override fun toString()="FaceLifecycleJournal(state=$state, action=${intent?.action}, redacted)"
    fun base(): WireObject=mapOf("account_id" to account,"device_id" to device,"control_key" to control)
    fun query(nonce: String)=base()+mapOf("request_nonce" to nonce,"request_expires_at" to System.currentTimeMillis()+45000)
    fun controlBody()=base()+mapOf("control_operation_key" to controlOperation)+(previousControl?.let { mapOf("renew" to true,"previous_control_operation_key" to it) } ?: emptyMap())
    fun envelope(step: String,body: WireObject)=body+mapOf("protocol" to "lovelies-face-profile-device-v1","step" to step)
    fun wire(): WireObject=mapOf("origin" to origin,"account" to account,"device" to device,"alias" to alias,"handle" to handle,"jwk" to jwk,
        "control" to control,"control_operation" to controlOperation,"metadata" to metadata.wire,"acknowledged" to acknowledged,"state" to state,
        "intent" to intent?.wire(),"generation" to generation,"challenge_id" to challengeId,"challenge" to challenge,
        "planned" to planned.map(EnrollmentCapture::wire),"accepted" to accepted.map(EnrollmentCapture::wire),"retired" to retired.map(EnrollmentCapture::wire),
        "resume" to resume,"completion" to completion,"credential_result" to credentialResult,"previous_control" to previousControl,"login_key" to loginKey)
    fun assertIntent(other: FaceLifecycleJournal?) {
        if(other==null || other.origin!=origin || other.account!=account || other.device!=device || other.alias!=alias || other.handle!=handle ||
            other.control!=control || other.controlOperation!=controlOperation || other.previousControl!=previousControl || other.loginKey!=loginKey || other.intent?.key!=intent?.key || NativeProtocol.canonical(other.jwk)!=NativeProtocol.canonical(jwk))
            throw LiveFailure("face_profile_scope_changed")
    }
    fun assertKey(actual: WireObject) { if(NativeProtocol.canonical(actual)!=NativeProtocol.canonical(jwk))throw LiveFailure("device_key_unavailable") }
    fun begin(action: String): FaceLifecycleJournal {
        if(!acknowledged || intent!=null || loginKey!=null)throw LiveFailure("face_profile_requires_status")
        val op=FaceLifecycleIntent.create(action,metadata)
        return copy(intent=op,state=if(op.capture)"capture_start" else "action_pending",generation=0,challengeId=null,challenge=null,
            planned=emptyList(),accepted=emptyList(),retired=emptyList(),resume=null,completion=null,credentialResult=null)
    }
    fun withChallenge(value: WireObject,successor: Boolean=false,statusGeneration: Long?=null): FaceLifecycleJournal {
        val op=intent?.takeIf { it.capture } ?: throw LiveFailure("face_profile_requires_status")
        if(state=="cancelled" || state=="cancel_pending" && statusGeneration==null)throw LiveFailure("face_profile_cancel_pending")
        if(value["protocol"]!="lovelies-face-auth-v1" || statusGeneration==null && value["lifecycle_operation_key"]!=op.key || value["purpose"]!=op.purpose ||
            value["device_revision"]!=metadata.deviceRevision || value["policy_version"]!=op.authPolicy || NativeProtocol.integer(value["required_captures"],1,3)!=op.count.toLong() ||
            value["poses"]!=if(op.count==1)listOf("front") else listOf("front","left","right"))throw LiveFailure("face_profile_response_changed")
        NativeProtocol.bindFaceChallenge(value,account,op.purpose,device)
        for((key,profileKey) in listOf("profile_id" to "id","profile_revision" to "revision","model_id" to "model_id"))
            if(value[key]!=op.reference?.get(profileKey))throw LiveFailure("face_profile_response_changed")
        val gen=statusGeneration ?: NativeProtocol.integer(value["lifecycle_generation"],1,1000000);val cid=NativeProtocol.id(value["challenge_id"])
        if(value.containsKey("lifecycle_operation_key") && value["lifecycle_operation_key"]!=op.key ||
            value.containsKey("lifecycle_generation") && NativeProtocol.integer(value["lifecycle_generation"],1,1000000)!=gen)throw LiveFailure("face_profile_response_changed")
        if(generation>0 && gen!=generation && !(successor && gen==generation+1) || gen==generation && challengeId!=null && cid!=challengeId)
            throw LiveFailure("face_profile_response_changed")
        lifecycleText(value["nonce"]);Instant.parse(lifecycleText(value["expires_at"]))
        val changed=gen!=generation
        if(state=="restart_required" && !changed)throw LiveFailure("face_profile_response_changed")
        if(!changed && challenge!=null && NativeProtocol.canonical(challenge)!=NativeProtocol.canonical(value))throw LiveFailure("face_profile_response_changed")
        return copy(state="pending",generation=gen,challengeId=cid,challenge=value,planned=if(changed)emptyList() else planned,
            accepted=if(changed)emptyList() else accepted,retired=if(changed)emptyList() else retired,resume=if(changed)null else resume,completion=if(changed)null else completion)
    }
    fun plan(bytes: ByteArray): FaceLifecycleJournal {
        val op=intent?.takeIf { it.capture } ?: throw LiveFailure("face_profile_requires_status")
        if(state!="pending" || challenge==null || planned.size!=accepted.size || accepted.size>=op.count)throw LiveFailure("face_profile_requires_status")
        if(bytes.isEmpty() || planned.sumOf { it.bytes }+bytes.size>8L*1024*1024)throw LiveFailure("capture_too_large")
        val hash=NativeProtocol.sha256(bytes)
        if(planned.any { it.hash==hash })throw LiveFailure("duplicate_capture")
        return copy(state="capture_pending",planned=planned+EnrollmentCapture(accepted.size,hash,"image/jpeg",bytes.size.toLong()))
    }
    fun reconcile(value: WireObject,nonce: String?=null): FaceLifecycleJournal {
        val meta=FaceLifecycleMetadata.parse(value,account,device,digest,metadata.deviceRevision,nonce,metadata.version)
        val op=intent
        if(op==null) {
            if(loginKey!=null)throw LiveFailure("face_profile_requires_status")
            return copy(metadata=meta,acknowledged=true,state="ready")
        }
        if(meta.authPolicy!=op.authPolicy || meta.photoPolicy!=op.photoPolicy)throw LiveFailure("face_profile_version_changed")
        val result=meta.operation ?: throw LiveFailure("face_profile_operation_missing")
        if(result.key!=op.key || result.action!=op.action)throw LiveFailure("face_profile_response_changed")
        if(!op.capture) {
            if(result.state!="applied" || result.challenge!=null || result.captures.isNotEmpty())throw LiveFailure("face_profile_response_changed")
            val cleanup=meta.removal in setOf("pending","failed","blocked")
            return copy(metadata=meta,acknowledged=true,state=if(cleanup)"removal_pending" else "ready",intent=if(cleanup)op else null)
        }
        if(result.state=="completed") {
            val profile=meta.profile ?: throw LiveFailure("face_profile_response_changed")
            if(meta.version<=op.expectedVersion)throw LiveFailure("face_profile_version_changed")
            if(!meta.authenticationEnabled || op.action=="replace" && (profile["id"]!=op.reference?.get("id") || profile["revision"]==op.reference?.get("revision")) ||
                op.action=="restore_authentication" && profile!=op.reference)throw LiveFailure("face_profile_response_changed")
            return copy(metadata=meta,acknowledged=true,state=if(credentialResult==null)"registered" else "credentials_pending",challenge=null,planned=emptyList(),accepted=emptyList(),retired=emptyList(),resume=null,completion=null)
        }
        if(meta.version!=op.expectedVersion || meta.profile!=op.reference)throw LiveFailure("face_profile_version_changed")
        if(result.generation<1 || result.challengeId==null)throw LiveFailure("face_profile_response_changed")
        val successor=result.generation==generation+1 && generation>0 && resume?.get("expected_challenge_id")==challengeId &&
            resume?.get("expected_generation")?.let { NativeProtocol.integer(it)==generation }==true
        if(generation>0 && result.generation!=generation && !successor || result.generation==generation && challengeId!=null && result.challengeId!=challengeId)
            throw LiveFailure("face_profile_response_changed")
        val terminal=result.state in setOf("restart_required","failed","cancelled")
        val known=(planned+retired).associateBy { it.index }
        result.captures.forEach { if(it!=known[it.index])throw LiveFailure("face_profile_capture_changed") }
        if(terminal) {
            if(result.challenge!=null)throw LiveFailure("face_profile_response_changed")
            return copy(metadata=meta,acknowledged=true,state=if(result.state=="cancelled")"cancelled" else "restart_required",generation=result.generation,challengeId=result.challengeId,
                challenge=null,planned=emptyList(),accepted=emptyList(),retired=if(successor)emptyList() else known.values.sortedBy { it.index },resume=null,completion=null)
        }
        if(result.state !in setOf("pending","capture_pending","verifying") || state in setOf("restart_required","cancelled") && !successor || successor && result.captures.isNotEmpty() ||
            result.captures.map { it.index }!=result.captures.indices.toList() || !successor && result.captures.size<accepted.size)throw LiveFailure("face_profile_capture_changed")
        val next=if(result.challenge!=null)withChallenge(result.challenge,successor,result.generation) else copy(generation=result.generation,challengeId=result.challengeId)
        return next.copy(metadata=meta,acknowledged=true,state=if(state=="cancel_pending")"cancel_pending" else result.state,accepted=result.captures,
            planned=if(result.state=="pending")result.captures else next.planned)
    }
    /** Authoritative absence never turns an explicit cancellation back into a start mutation. */
    internal fun resolveAbsentOperation(value: WireObject,nonce: String): LifecycleAbsentResolution {
        val op=intent ?: throw LiveFailure("face_profile_requires_status")
        val meta=FaceLifecycleMetadata.parse(value,account,device,digest,metadata.deviceRevision,nonce,metadata.version)
        val next=copy(metadata=meta,acknowledged=true)
        if(state=="cancel_pending")return LifecycleAbsentResolution(next,false)
        if(meta.version!=op.expectedVersion || meta.authPolicy!=op.authPolicy || meta.photoPolicy!=op.photoPolicy || meta.profile!=op.reference)
            throw LiveFailure("face_profile_version_changed")
        return LifecycleAbsentResolution(next,true)
    }
    fun withCredentials(value: WireObject): FaceLifecycleJournal {
        val op=intent?.takeIf { it.capture } ?: throw LiveFailure("face_profile_requires_status")
        if(value["protocol"]!="lovelies-face-auth-v1" || value["status"]!="authenticated" || value["account_id"]!=account || value["device_id"]!=device || value["auth_method"]!="registered_face")
            throw LiveFailure("face_profile_response_changed")
        val profile=lifecycleProfile(mapOf("id" to value["profile_id"],"revision" to value["profile_revision"],"model_id" to value["model_id"]))!!
        if(op.action=="replace" && profile["id"]!=op.reference?.get("id") || op.action=="restore_authentication" && profile!=op.reference ||
            state=="registered" && profile!=metadata.profile)throw LiveFailure("face_profile_response_changed")
        return copy(state="credentials_pending",credentialResult=value)
    }
    fun rotatedCredentials(value: WireObject): FaceLifecycleJournal {
        if(credentialResult==null || value["account_id"]!=account || value["auth_method"]!="registered_face")throw LiveFailure("face_profile_response_changed")
        return copy(credentialResult=credentialResult+value.filterKeys { it in setOf("access_token","refresh_token","expires_in","token_type","roles","auth_method","account_id") })
    }
    fun cancelAcknowledgement(value: WireObject,nonce: String): FaceLifecycleJournal {
        val next=reconcile(value,nonce)
        return when(next.state) {
            "cancelled"->next.copy(state="ready",intent=null,generation=0,challengeId=null,challenge=null,planned=emptyList(),accepted=emptyList(),retired=emptyList(),resume=null,completion=null,credentialResult=null)
            "registered","credentials_pending"->next // Publication already won; a cancel receipt cannot undo it.
            else->throw LiveFailure("face_profile_cancel_pending")
        }
    }
    fun forExplicitLogout(): FaceLifecycleJournal {
        if(loginKey!=null)return copy(state="ready",loginKey=null,challenge=null,challengeId=null,planned=emptyList(),accepted=emptyList(),
            retired=emptyList(),completion=null,resume=null,credentialResult=null)
        if(credentialResult==null)return this
        return copy(credentialResult=null,state=if(metadata.operation?.state=="completed")"registered" else "verifying")
    }
    fun beginStableLogin(): FaceLifecycleJournal {
        if(intent!=null || state!="ready" || !acknowledged || !metadata.authenticationEnabled || metadata.profile==null || metadata.removal!="none")
            throw LiveFailure("face_profile_requires_status")
        return copy(state="login_start",loginKey=UUID.randomUUID().toString(),challenge=null,challengeId=null,planned=emptyList(),accepted=emptyList(),retired=emptyList(),completion=null,credentialResult=null)
    }
    fun withLoginChallenge(value: WireObject): FaceLifecycleJournal {
        if(loginKey==null || intent!=null || value["protocol"]!="lovelies-face-auth-v1" || value["purpose"]!="login" ||
            value["device_revision"]!=metadata.deviceRevision || NativeProtocol.integer(value["required_captures"],1,1)!=1L || value["poses"]!=listOf("front"))
            throw LiveFailure("face_profile_response_changed")
        NativeProtocol.bindFaceChallenge(value,account,"login",device)
        lifecycleProfile(mapOf("id" to value["profile_id"],"revision" to value["profile_revision"],"model_id" to value["model_id"]))
        lifecycleText(value["policy_version"]);lifecycleText(value["nonce"]);Instant.parse(lifecycleText(value["expires_at"]))
        return copy(state="login_pending",challenge=value,challengeId=NativeProtocol.id(value["challenge_id"]),planned=emptyList(),accepted=emptyList(),retired=emptyList(),completion=null,credentialResult=null)
    }
    fun planLogin(bytes: ByteArray): FaceLifecycleJournal {
        if(loginKey==null || state!="login_pending" || planned.isNotEmpty() || bytes.isEmpty() || bytes.size>8*1024*1024)throw LiveFailure("face_profile_requires_status")
        return copy(state="login_capture_pending",planned=listOf(EnrollmentCapture(0,NativeProtocol.sha256(bytes),"image/jpeg",bytes.size.toLong())))
    }
    fun withLoginCredentials(value: WireObject): FaceLifecycleJournal {
        val captured=challenge ?: throw LiveFailure("face_profile_requires_status")
        if(loginKey==null || value["protocol"]!="lovelies-face-auth-v1" || value["status"]!="authenticated" || value["account_id"]!=account ||
            value["device_id"]!=device || value["auth_method"]!="registered_face" || value["profile_id"]!=captured["profile_id"] ||
            value["profile_revision"]!=captured["profile_revision"] || value["model_id"]!=captured["model_id"])throw LiveFailure("face_profile_response_changed")
        return copy(state="login_credentials_pending",credentialResult=value)
    }
    fun renew(metadata: FaceLifecycleMetadata): FaceLifecycleJournal {
        if(intent!=null || loginKey!=null || state!="ready" || !metadata.authenticationEnabled || metadata.profile==null || metadata.deviceRevision!=this.metadata.deviceRevision)
            throw LiveFailure("face_profile_requires_status")
        return create(origin,DeviceIdentity(account,alias,handle,device),jwk,metadata).copy(previousControl=controlOperation)
    }
    companion object {
        fun create(origin: String,identity: DeviceIdentity,jwk: WireObject,meta: FaceLifecycleMetadata): FaceLifecycleJournal {
            val bytes=ByteArray(32).also { SecureRandom().nextBytes(it) }
            val secret=try { "lfl_"+NativeProtocol.base64(bytes) } finally { bytes.fill(0) }
            return FaceLifecycleJournal(origin,identity.account,identity.device,identity.alias,identity.handle,jwk,secret,UUID.randomUUID().toString(),meta)
        }
        fun restore(value: Any?,origin: String): FaceLifecycleJournal {
            val row=NativeProtocol.obj(value);val account=NativeProtocol.id(row["account"]);val device=NativeProtocol.id(row["device"]);val jwk=NativeProtocol.obj(row["jwk"])
            val digest=NativeProtocol.sha256(NativeProtocol.canonical(jwk).toByteArray(Charsets.UTF_8))
            val meta=FaceLifecycleMetadata.parse(NativeProtocol.obj(row["metadata"]),account,device,digest)
            val j=FaceLifecycleJournal(lifecycleText(row["origin"]),account,device,lifecycleText(row["alias"]),lifecycleText(row["handle"]),jwk,lifecycleText(row["control"]),NativeProtocol.id(row["control_operation"]),meta,
                row["acknowledged"] as? Boolean ?: throw LiveFailure("face_profile_response_changed"),lifecycleText(row["state"]),row["intent"]?.let(FaceLifecycleIntent::restore),
                NativeProtocol.integer(row["generation"],0,1000000),row["challenge_id"]?.let(NativeProtocol::id),row["challenge"]?.let(NativeProtocol::obj),
                NativeProtocol.rows(row["planned"],3).map(EnrollmentCapture::parse),NativeProtocol.rows(row["accepted"],3).map(EnrollmentCapture::parse),NativeProtocol.rows(row["retired"],3).map(EnrollmentCapture::parse),
                row["resume"]?.let(NativeProtocol::obj),row["completion"]?.let(NativeProtocol::obj),row["credential_result"]?.let(NativeProtocol::obj),
                row["previous_control"]?.let(NativeProtocol::id),row["login_key"]?.let(NativeProtocol::id))
            if(j.origin!=origin || !j.alias.startsWith("lovelies.device.") || !Regex("lfh_[A-Za-z0-9_-]{43}").matches(j.handle) || !Regex("lfl_[A-Za-z0-9_-]{43}").matches(j.control) ||
                jwk.keys!=setOf("kty","crv","x","y","ext","key_ops") || jwk["kty"]!="EC" || jwk["crv"]!="P-256" || jwk["ext"]!=true || jwk["key_ops"]!=listOf("verify") ||
                listOf("x","y").any { !Regex("[A-Za-z0-9_-]{43}").matches(NativeProtocol.text(jwk[it])) })throw LiveFailure("face_profile_scope_changed")
            if(j.state !in setOf("control_pending","ready","action_pending","capture_start","pending","capture_pending","completion_pending","verifying","restart_required","registered","credentials_pending","removal_pending","cancel_pending","cancelled","login_start","login_pending","login_capture_pending","login_completion_pending","login_credentials_pending") ||
                j.intent==null && j.loginKey==null && j.state !in setOf("control_pending","ready") || j.intent!=null && j.loginKey!=null ||
                j.loginKey!=null && !j.state.startsWith("login_") || j.accepted.map { it.index }!=j.accepted.indices.toList() || j.planned.map { it.index }!=j.planned.indices.toList() ||
                j.accepted!=j.planned.take(j.accepted.size) || j.intent?.capture==true && j.planned.size>j.intent.count || j.loginKey!=null && j.planned.size>1 ||
                j.state in setOf("credentials_pending","login_credentials_pending") && j.credentialResult==null)
                throw LiveFailure("face_profile_capture_changed")
            j.challenge?.let { val checked=if(j.loginKey!=null)j.withLoginChallenge(it) else j.withChallenge(it,statusGeneration=j.generation)
                if(checked.generation!=j.generation || checked.challengeId!=j.challengeId)throw LiveFailure("face_profile_response_changed") }
            j.resume?.let { if(it.keys!=setOf("resume_key","expected_challenge_id","expected_generation") || NativeProtocol.id(it["expected_challenge_id"])!=j.challengeId ||
                NativeProtocol.integer(it["expected_generation"])!=j.generation)throw LiveFailure("face_profile_response_changed");NativeProtocol.id(it["resume_key"]) }
            j.completion?.let { if(it.keys!=setOf("challenge_id","device_signature") || it["challenge_id"]!=j.challengeId || !Regex("[A-Za-z0-9_-]{86}").matches(NativeProtocol.text(it["device_signature"])))
                throw LiveFailure("face_profile_response_changed") }
            for(items in listOf(j.planned,j.retired)) {
                if(items.sumOf { it.bytes }>8L*1024*1024 || items.map { it.hash }.distinct().size!=items.size)throw LiveFailure("face_profile_capture_changed")
            }
            return j
        }
    }
}
