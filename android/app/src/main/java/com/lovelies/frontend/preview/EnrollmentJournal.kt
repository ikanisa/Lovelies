package com.lovelies.frontend.preview

import java.security.SecureRandom
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CancellationException

internal fun <T> withEnrollmentPhase(fence: SessionFence,scope: SessionScope,expected: EnrollmentJournal,
    current: ()->EnrollmentJournal?,body: ()->T): T = synchronized(fence) {
    fence.assert(scope);expected.assertIntent(current());body()
}
internal fun <T> persistEnrollmentState(candidate: WireObject,write: (WireObject)->Unit,publish: (WireObject)->T): T {
    val snapshot=candidate.toMap()
    try { write(snapshot) } catch(problem: Exception) {
        if(problem is CancellationException)throw problem
        throw LiveFailure("enrollment_storage_unavailable")
    }
    return publish(snapshot)
}
data class EnrollmentCapture(val index: Int,val hash: String,val mime: String,val bytes: Long) {
    fun assertAcknowledgement(value: WireObject,challenge: String) {
        if(value["protocol"]!="lovelies-face-auth-v1" || value["status"]!="capture_received" || value["challenge_id"]!=challenge ||
            NativeProtocol.integer(value["capture_index"],0,2)!=index.toLong() || value["capture_sha256"]!=hash ||
            NativeProtocol.integer(value["byte_size"],1,8*1024*1024)!=bytes)throw LiveFailure("capture_acknowledgement_changed")
    }
    fun wire(): WireObject=mapOf("index" to index,"sha256" to hash,"mime" to mime,"byte_size" to bytes)
    companion object { fun parse(value: Any?): EnrollmentCapture {
        val row=NativeProtocol.obj(value);val hash=NativeProtocol.text(row["sha256"])
        val mime=NativeProtocol.text(row["mime"])
        if(!Regex("[0-9a-f]{64}").matches(hash) || mime!="image/jpeg")throw LiveFailure("enrollment_capture_changed")
        return EnrollmentCapture(NativeProtocol.integer(row["index"],0,2).toInt(),hash,mime,NativeProtocol.integer(row["byte_size"],1,8*1024*1024))
    } }
}
data class EnrollmentJournal(val origin: String,val account: String,val key: String,val alias: String,val jwk: WireObject,
    val handle: String,val policy: String,val state: String="start",val challenge: WireObject?=null,val generation: Long=0,
    val device: String?=null,val revision: String?=null,val planned: List<EnrollmentCapture> = emptyList(),
    val accepted: List<EnrollmentCapture> = emptyList(),val completion: WireObject?=null,val resume: WireObject?=null,
    val profile: WireObject?=null,val credentialResult: WireObject?=null,val challengeId: String?=null,
    val retiredCaptures: List<EnrollmentCapture> = emptyList()) {
    val digest get()=NativeProtocol.sha256(NativeProtocol.canonical(jwk).toByteArray())
    val waiting get()=state in setOf("capture_pending","completion_pending","verifying")
    fun wire(): WireObject=mapOf("origin" to origin,"account" to account,"enrollment_key" to key,"alias" to alias,"jwk" to jwk,
        "handle" to handle,"policy" to policy,"state" to state,"challenge" to challenge,"generation" to generation,"device" to device,
        "revision" to revision,"planned" to planned.map(EnrollmentCapture::wire),"accepted" to accepted.map(EnrollmentCapture::wire),
        "completion" to completion,"resume" to resume,"profile" to profile,"credential_result" to credentialResult,"challenge_id" to challengeId,"retired_captures" to retiredCaptures.map(EnrollmentCapture::wire))
    fun assertIntent(current: EnrollmentJournal?) {
        if(current==null || current.origin!=origin || current.account!=account || current.key!=key || current.alias!=alias ||
            current.handle!=handle || current.policy!=policy || NativeProtocol.canonical(current.jwk)!=NativeProtocol.canonical(jwk))
            throw LiveFailure("enrollment_scope_changed")
    }
    fun assertKey(actual: WireObject) { if(NativeProtocol.canonical(actual)!=NativeProtocol.canonical(jwk))throw LiveFailure("device_key_unavailable") }
    fun rotatedCredentials(value: WireObject): EnrollmentJournal {
        if(state!="credentials_pending" || credentialResult==null || profile==null || value["account_id"]!=account || value["auth_method"]!="registered_face")
            throw LiveFailure("enrollment_response_changed")
        val allowed=setOf("access_token","refresh_token","expires_in","token_type","roles","auth_method","account_id")
        return copy(credentialResult=credentialResult+value.filterKeys { it in allowed })
    }
    fun allowsStartRetry(problem: LiveFailure,hasAnonymousBearer: Boolean)=hasAnonymousBearer && problem.status==404 && problem.code=="enrollment_not_found" &&
        generation==0L && device==null && state=="start" && planned.isEmpty()
    fun startFields(): WireObject=mapOf("account_id" to account,"enrollment_key" to key,"face_handle" to handle,
        "policy_version" to policy,"device_public_jwk" to jwk)
    fun startEnvelope()=startFields()+mapOf("protocol" to "lovelies-face-enrollment-device-v1","step" to "start")
    fun startBody(signature: String): WireObject=mapOf("account_id" to account,"enrollment_key" to key,"face_handle" to handle,
        "device_public_jwk" to jwk,"consent" to mapOf("purpose" to "face_authentication","policy_version" to policy,"granted" to true),"device_signature" to signature)
    fun queryFields(nonce: String,expires: Long): WireObject=mapOf("account_id" to account,"enrollment_key" to key,"face_handle" to handle,
        "request_nonce" to nonce,"request_expires_at" to expires)
    fun envelope(fields: WireObject,step: String)=fields+mapOf("protocol" to "lovelies-face-enrollment-device-v1","step" to step)
    fun withChallenge(value: WireObject,successor: Boolean=false,recoveryGeneration: Long?=null): EnrollmentJournal {
        if(value["protocol"]!="lovelies-face-auth-v1" || recoveryGeneration==null && (value["enrollment_key"]!=key || value["public_key_digest"]!=digest || value["face_handle"]!=handle) ||
            value["policy_version"]!=policy || NativeProtocol.integer(value["required_captures"],1,3)!=3L)
            throw LiveFailure("enrollment_response_changed")
        NativeProtocol.bindFaceChallenge(value,account,"registration",device)
        val id=NativeProtocol.id(value["device_id"]);val rev=NativeProtocol.text(value["device_revision"])
        if(revision!=null && revision!=rev)throw LiveFailure("enrollment_response_changed")
        val nextChallengeId=NativeProtocol.id(value["challenge_id"])
        val gen=recoveryGeneration ?: NativeProtocol.integer(value["enrollment_generation"],1,1000000)
        if(challengeId!=null && gen==generation && nextChallengeId!=challengeId)throw LiveFailure("enrollment_response_changed")
        if(generation>0 && gen!=generation && !(successor && gen==generation+1))throw LiveFailure("enrollment_response_changed")
        NativeProtocol.id(value["challenge_id"]);NativeProtocol.text(value["nonce"])
        Instant.parse(NativeProtocol.text(value["expires_at"]))
        val core=setOf("protocol","challenge_id","account_id","device_id","device_revision","nonce","purpose","policy_version","profile_id","profile_revision","expires_at","required_captures","poses")
        if(challenge!=null && gen==generation && NativeProtocol.canonical(challenge.filterKeys { it in core })!=NativeProtocol.canonical(value.filterKeys { it in core }))throw LiveFailure("enrollment_response_changed")
        val changed=gen!=generation
        if(state=="restart_required" && !changed)throw LiveFailure("enrollment_response_changed")
        return copy(challenge=value,challengeId=nextChallengeId,generation=gen,device=id,revision=rev,state="pending",resume=if(changed)null else resume,
            planned=if(changed)emptyList() else planned,accepted=if(changed)emptyList() else accepted,completion=if(changed)null else completion,
            retiredCaptures=if(changed)emptyList() else retiredCaptures)
    }
    fun plan(bytes: ByteArray): EnrollmentJournal {
        if(state!="pending" || challenge==null || accepted.size>=3 || planned.size!=accepted.size)throw LiveFailure("enrollment_requires_recovery")
        val item=EnrollmentCapture(accepted.size,NativeProtocol.sha256(bytes),"image/jpeg",bytes.size.toLong())
        if(bytes.isEmpty() || bytes.size>8*1024*1024 || planned.sumOf { it.bytes }+bytes.size>8*1024*1024 || planned.any { it.hash==item.hash })
            throw LiveFailure("capture_too_large")
        return copy(planned=planned+item,state="capture_pending")
    }
    fun reconcile(response: WireObject,nonce: String,now: Long): EnrollmentJournal {
        if(response["protocol"]!="lovelies-face-enrollment-v1" || response["account_id"]!=account || response["enrollment_key"]!=key ||
            response["public_key_digest"]!=digest || response["policy_version"]!=policy || response["request_nonce"]!=nonce || response["authenticated"]!=false)
            throw LiveFailure("enrollment_response_changed")
        NativeProtocol.expiry(response["expires_at"],now)
        val id=NativeProtocol.id(response["device_id"]);val rev=NativeProtocol.text(response["device_revision"])
        if(device!=null && id!=device || revision!=null && rev!=revision)throw LiveFailure("enrollment_response_changed")
        val currentChallenge=NativeProtocol.id(response["challenge_id"])
        val nested=response["challenge"]?.let(NativeProtocol::obj)
        if(nested!=null && NativeProtocol.id(nested["challenge_id"])!=currentChallenge)throw LiveFailure("enrollment_response_changed")
        val gen=NativeProtocol.integer(response["enrollment_generation"],1,1000000)
        if(challengeId!=null && gen==generation && currentChallenge!=challengeId)throw LiveFailure("enrollment_response_changed")
        val successor=generation>0 && gen==generation+1 && resume?.get("expected_generation")?.let { NativeProtocol.integer(it)==generation }==true &&
            resume?.get("expected_challenge_id")==challengeId
        if(generation>0 && gen!=generation && !successor)throw LiveFailure("enrollment_response_changed")
        val status=NativeProtocol.text(response["state"])
        if(status !in setOf("pending","capture_pending","verifying","registered","restart_required"))throw LiveFailure("enrollment_response_changed")
        val captures=NativeProtocol.rows(response["captures"],3).map(EnrollmentCapture::parse)
        val indices=captures.map { it.index }
        if(indices.toSet().size!=indices.size || indices!=indices.sorted() || captures.sumOf { it.bytes }>8*1024*1024 ||
            status!="restart_required" && indices!=captures.indices.toList())throw LiveFailure("enrollment_capture_changed")
        if(status=="registered") {
            if(response["challenge"]!=null || captures.isNotEmpty())throw LiveFailure("enrollment_response_changed")
            val p=NativeProtocol.obj(response["profile"]);NativeProtocol.id(p["id"]);NativeProtocol.text(p["revision"]);NativeProtocol.text(p["model_id"])
            if(profile!=null && NativeProtocol.canonical(profile)!=NativeProtocol.canonical(p))throw LiveFailure("enrollment_response_changed")
            return copy(state=if(credentialResult==null)"registered" else "credentials_pending",device=id,revision=rev,generation=gen,profile=p,challengeId=currentChallenge)
        }
        if(response["profile"]!=null)throw LiveFailure("enrollment_response_changed")
        if(status=="restart_required") {
            if(nested!=null || profile!=null || credentialResult!=null)throw LiveFailure("enrollment_response_changed")
            val known=if(planned.isNotEmpty())planned else retiredCaptures
            if(successor && captures.isNotEmpty())throw LiveFailure("enrollment_capture_changed")
            captures.forEach { if(known.getOrNull(it.index)!=it)throw LiveFailure("enrollment_capture_changed") }
            // Cleanup can retire proofs independently. Their remaining hashes are evidence only,
            // never accepted progress or a reusable completion for this terminal generation.
            return copy(state=status,device=id,revision=rev,generation=gen,challengeId=currentChallenge,challenge=null,
                planned=emptyList(),accepted=emptyList(),completion=null,resume=null,
                retiredCaptures=if(successor)emptyList() else known)
        }
        if(state=="restart_required" && !successor)throw LiveFailure("enrollment_response_changed")
        if(successor && captures.isNotEmpty() || !successor && captures.size<accepted.size)throw LiveFailure("enrollment_capture_changed")
        captures.forEach { if(planned.getOrNull(it.index)!=it)throw LiveFailure("enrollment_capture_changed") }
        val next=response["challenge"]?.let { withChallenge(NativeProtocol.obj(it),successor=successor,recoveryGeneration=gen) }
            ?: copy(device=id,revision=rev,generation=gen,challengeId=currentChallenge,
                challenge=if(successor)null else challenge,resume=if(successor)null else resume,completion=if(successor)null else completion,
                planned=if(successor)emptyList() else planned,accepted=if(successor)emptyList() else accepted)
        return next.copy(state=status,accepted=captures,planned=if(status=="pending")captures else next.planned)
    }
    companion object {
        fun create(origin: String,account: String,alias: String,jwk: WireObject,policy: String): EnrollmentJournal {
            val bytes=ByteArray(32).also { SecureRandom().nextBytes(it) }
            val handle=try { "lfh_"+NativeProtocol.base64(bytes) } finally { bytes.fill(0) }
            return EnrollmentJournal(origin,NativeProtocol.id(account),UUID.randomUUID().toString(),alias,jwk,handle,policy)
        }
        fun restore(value: Any?,origin: String): EnrollmentJournal {
            val row=NativeProtocol.obj(value)
            val journal=EnrollmentJournal(NativeProtocol.text(row["origin"]),NativeProtocol.id(row["account"]),NativeProtocol.id(row["enrollment_key"]),
                NativeProtocol.text(row["alias"]),NativeProtocol.obj(row["jwk"]),NativeProtocol.text(row["handle"]),NativeProtocol.text(row["policy"]),
                NativeProtocol.text(row["state"]),row["challenge"]?.let(NativeProtocol::obj),NativeProtocol.integer(row["generation"]),row["device"]?.let(NativeProtocol::id),
                row["revision"]?.let { NativeProtocol.text(it) },NativeProtocol.rows(row["planned"],3).map(EnrollmentCapture::parse),
                NativeProtocol.rows(row["accepted"],3).map(EnrollmentCapture::parse),row["completion"]?.let(NativeProtocol::obj),row["resume"]?.let(NativeProtocol::obj),
                row["profile"]?.let(NativeProtocol::obj),row["credential_result"]?.let(NativeProtocol::obj),row["challenge_id"]?.let(NativeProtocol::id),
                row["retired_captures"]?.let { NativeProtocol.rows(it,3).map(EnrollmentCapture::parse) } ?: emptyList())
            if(journal.origin!=origin || !journal.alias.startsWith("lovelies.device.${journal.account}.") || !Regex("lfh_[A-Za-z0-9_-]{43}").matches(journal.handle))
                throw LiveFailure("enrollment_scope_changed")
            if(journal.jwk.keys!=setOf("kty","crv","x","y","ext","key_ops") || journal.jwk["kty"]!="EC" || journal.jwk["crv"]!="P-256" ||
                journal.jwk["ext"]!=true || journal.jwk["key_ops"]!=listOf("verify") || listOf("x","y").any { !Regex("[A-Za-z0-9_-]{43}").matches(NativeProtocol.text(journal.jwk[it])) })
                throw LiveFailure("device_key_unavailable")
            if(journal.planned.map { it.index }!=journal.planned.indices.toList() || journal.accepted!=journal.planned.take(journal.accepted.size) ||
                journal.state !in setOf("start","pending","capture_pending","completion_pending","verifying","registered","restart_required","credentials_pending"))
                throw LiveFailure("enrollment_capture_changed")
            if(journal.state=="start" && (journal.generation!=0L || journal.device!=null || journal.challenge!=null || journal.challengeId!=null || journal.planned.isNotEmpty()) ||
                journal.state!="start" && (journal.generation<1 || journal.device==null || journal.revision==null || journal.challengeId==null) ||
                journal.state=="completion_pending" && (journal.completion==null || journal.accepted.size!=3) ||
                journal.state=="credentials_pending" && (journal.credentialResult==null || journal.profile==null))throw LiveFailure("enrollment_capture_changed")
            if(journal.retiredCaptures.map { it.index }!=journal.retiredCaptures.indices.toList() || journal.retiredCaptures.sumOf { it.bytes }>8*1024*1024 ||
                journal.retiredCaptures.isNotEmpty() && (journal.state!="restart_required" || journal.challenge!=null || journal.planned.isNotEmpty() ||
                    journal.accepted.isNotEmpty() || journal.completion!=null))throw LiveFailure("enrollment_capture_changed")
            journal.challenge?.let { value ->
                NativeProtocol.bindFaceChallenge(value,journal.account,"registration",journal.device)
                if(value["challenge_id"]!=journal.challengeId || value["policy_version"]!=journal.policy || NativeProtocol.text(value["device_revision"])!=journal.revision || NativeProtocol.integer(value["required_captures"])!=3L)
                    throw LiveFailure("enrollment_response_changed")
            }
            journal.completion?.let { value ->
                if(value.keys!=setOf("challenge_id","device_signature") || value["challenge_id"]!=journal.challenge?.get("challenge_id") ||
                    !Regex("[A-Za-z0-9_-]{86}").matches(NativeProtocol.text(value["device_signature"])))throw LiveFailure("enrollment_response_changed")
            }
            journal.resume?.let { value ->
                if(value.keys!=setOf("resume_key","expected_generation","expected_challenge_id") || NativeProtocol.integer(value["expected_generation"])!=journal.generation ||
                    value["expected_challenge_id"]!=journal.challengeId)throw LiveFailure("enrollment_response_changed")
                NativeProtocol.id(value["resume_key"])
            }
            return journal
        }
    }
}
