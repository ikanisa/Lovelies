package com.lovelies.frontend.preview

import java.security.SecureRandom
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CancellationException

internal fun <T> persistAccountRecovery(candidate: WireObject,write: (WireObject)->Unit,publish: (WireObject)->T): T {
    val staged=candidate.toMap()
    try { write(staged) } catch(problem: Exception) {
        if(problem is CancellationException)throw problem
        throw LiveFailure("account_recovery_storage_unavailable")
    }
    return publish(staged)
}
internal fun <T> withAccountRecoveryPhase(fence: SessionFence,scope: SessionScope,expected: AccountRecoveryJournal,
    current: ()->AccountRecoveryJournal?,body: ()->T): T = synchronized(fence) {
    fence.assert(scope);expected.assertIntent(current());body()
}
internal fun <T> withAccountRecoveryStartPhase(fence: SessionFence,scope: SessionScope,body: ()->T): T = synchronized(fence) {
    fence.assert(scope);body()
}
private fun recoveryRandom(prefix: String): String {
    val bytes=ByteArray(32).also { SecureRandom().nextBytes(it) }
    return try { prefix+NativeProtocol.base64(bytes) } finally { bytes.fill(0) }
}
private fun recoverySecret(value: Any?): String {
    val secret=NativeProtocol.text(value,47)
    if(!Regex("lfr_[A-Za-z0-9_-]{43}").matches(secret))throw LiveFailure("recovery_backup_invalid")
    val bytes=runCatching { java.util.Base64.getUrlDecoder().decode(secret.removePrefix("lfr_")) }.getOrElse { throw LiveFailure("recovery_backup_invalid") }
    try { if(bytes.size!=32 || NativeProtocol.base64(bytes)!=secret.removePrefix("lfr_"))throw LiveFailure("recovery_backup_invalid") }
    finally { bytes.fill(0) }
    return secret
}
data class RecoveryBackup(val account: String,val secret: String) {
    fun text()="LVR1:$account:$secret"
    override fun toString()="RecoveryBackup(redacted)"
    companion object {
        fun create(account: String)=RecoveryBackup(NativeProtocol.id(account),recoveryRandom("lfr_"))
        fun parse(value: String): RecoveryBackup {
            val fields=value.trim().split(':')
            if(fields.size!=3 || fields[0]!="LVR1" || fields[1]!=fields[1].lowercase())throw LiveFailure("recovery_backup_invalid")
            return try { RecoveryBackup(NativeProtocol.id(fields[1]),recoverySecret(fields[2])) }
            catch(problem: LiveFailure) { throw LiveFailure("recovery_backup_invalid") }
        }
    }
}
internal fun assertRecoveryTarget(backup: RecoveryBackup,identityAccount: String?,enrollmentAccount: String?) {
    if(identityAccount!=null && identityAccount!=backup.account || enrollmentAccount!=null && enrollmentAccount!=backup.account)
        throw LiveFailure("account_recovery_account_changed")
}
internal fun archiveRecoveryCandidate(previous: WireObject,record: AccountRecoveryJournal,origin: String): WireObject {
    val history=previous["retired_account_recoveries"]?.let { NativeProtocol.rows(it,16).map { row->AccountRecoveryJournal.restore(row,origin) } } ?: emptyList()
    if(history.size>=16)throw LiveFailure("account_recovery_history_full")
    return previous.filterKeys { it!="account_recovery" }+mapOf("retired_account_recoveries" to (history+record).map(AccountRecoveryJournal::wire))
}
data class RecoveryKeyReceipt(val account: String,val operation: String,val keyId: String,val expiresAt: Long) {
    fun wire(): WireObject=mapOf("protocol" to "lovelies-account-recovery-v1","state" to "ready","account_id" to account,
        "operation_key" to operation,"key_id" to keyId,"expires_at" to Instant.ofEpochMilli(expiresAt).toString())
    fun same(other: RecoveryKeyReceipt)=account==other.account && operation==other.operation && keyId==other.keyId && expiresAt==other.expiresAt
    companion object {
        fun parse(value: WireObject,account: String,operation: String?=null): RecoveryKeyReceipt {
            if(value["protocol"]!="lovelies-account-recovery-v1" || value["state"]!="ready" || value["account_id"]!=account ||
                operation!=null && value["operation_key"]!=operation)throw LiveFailure("recovery_key_response_changed")
            return RecoveryKeyReceipt(account,NativeProtocol.id(value["operation_key"]),NativeProtocol.id(value["key_id"]),
                runCatching { Instant.parse(NativeProtocol.text(value["expires_at"])).toEpochMilli() }.getOrElse { throw LiveFailure("recovery_key_response_changed") })
        }
    }
}
data class RecoveryKeyIntent(val origin: String,val backup: RecoveryBackup,val operation: String,val receipt: RecoveryKeyReceipt?=null) {
    fun body(): WireObject=mapOf("operation_key" to operation,"recovery_key" to backup.secret)
    fun wire(): WireObject=mapOf("origin" to origin,"account" to backup.account,"secret" to backup.secret,"operation" to operation,"receipt" to receipt?.wire())
    override fun toString()="RecoveryKeyIntent(redacted)"
    companion object {
        fun create(origin: String,account: String)=RecoveryKeyIntent(origin,RecoveryBackup.create(account),UUID.randomUUID().toString())
        fun restore(value: Any?,origin: String): RecoveryKeyIntent {
            val row=NativeProtocol.obj(value);val account=NativeProtocol.id(row["account"])
            if(row["origin"]!=origin)throw LiveFailure("account_recovery_scope_changed")
            val operation=NativeProtocol.id(row["operation"])
            return RecoveryKeyIntent(origin,RecoveryBackup(account,recoverySecret(row["secret"])),operation,
                row["receipt"]?.let { RecoveryKeyReceipt.parse(NativeProtocol.obj(it),account,operation) })
        }
    }
}
/** Secret and metadata live only in the encrypted vault; camera JPEGs never enter the journal. */
data class AccountRecoveryJournal(val origin: String,val backup: RecoveryBackup,val requestId: String,val alias: String,val jwk: WireObject,
    val handle: String,val policy: String,val sourceAccount: String?,val state: String="start",val generation: Long=0,
    val device: String?=null,val revision: String?=null,val challengeId: String?=null,val challenge: WireObject?=null,
    val profile: WireObject?=null,val planned: EnrollmentCapture?=null,val accepted: Boolean=false,val retired: EnrollmentCapture?=null,
    val completion: WireObject?=null,val resume: WireObject?=null,val credentialResult: WireObject?=null,val receiptExpires: Long?=null) {
    val account get()=backup.account
    val digest get()=NativeProtocol.sha256(NativeProtocol.canonical(jwk).toByteArray())
    val waiting get()=state in setOf("capture_pending","completion_pending","verifying")
    override fun toString()="AccountRecoveryJournal(state=$state, redacted)"
    fun wire(): WireObject=mapOf("origin" to origin,"account" to account,"secret" to backup.secret,"request_id" to requestId,"alias" to alias,"jwk" to jwk,
        "handle" to handle,"policy" to policy,"source_account" to sourceAccount,"state" to state,"generation" to generation,"device" to device,"revision" to revision,
        "challenge_id" to challengeId,"challenge" to challenge,"profile" to profile,"planned" to planned?.wire(),"accepted" to accepted,"retired" to retired?.wire(),
        "completion" to completion,"resume" to resume,"credential_result" to credentialResult,"receipt_expires" to receiptExpires)
    fun assertIntent(current: AccountRecoveryJournal?) {
        if(current==null || current.origin!=origin || current.backup!=backup || current.requestId!=requestId || current.alias!=alias ||
            current.handle!=handle || current.policy!=policy || current.sourceAccount!=sourceAccount || NativeProtocol.canonical(current.jwk)!=NativeProtocol.canonical(jwk))
            throw LiveFailure("account_recovery_scope_changed")
    }
    fun assertKey(actual: WireObject) { if(NativeProtocol.canonical(actual)!=NativeProtocol.canonical(jwk))throw LiveFailure("device_key_unavailable") }
    fun base(): WireObject=mapOf("account_id" to account,"recovery_key" to backup.secret,"recovery_request_id" to requestId,
        "face_handle" to handle,"device_public_jwk" to jwk,"policy_version" to policy)
    fun envelope(step: String,fields: WireObject=base())=fields+mapOf("protocol" to "lovelies-account-recovery-device-v1","step" to step)
    fun query(nonce: String,expires: Long)=base()+mapOf("request_nonce" to nonce,"request_expires_at" to expires)
    fun allowsStartRetry(error: LiveFailure)=state=="start" && generation==0L && device==null && error.status==404 && error.code=="account_recovery_not_found"
    private fun bindProfile(value: WireObject): WireObject {
        val id=NativeProtocol.id(value["id"]);val revision=NativeProtocol.text(value["revision"])
        val model=(value["model_id"] as? String)?.takeIf { it.isNotBlank() && it.length<=1000 }
            ?: throw LiveFailure("account_recovery_response_changed")
        if(profile!=null && (profile["id"]!=id || profile["revision"]!=revision || profile["model_id"]!=model))
            throw LiveFailure("account_recovery_response_changed")
        return mapOf("id" to id,"revision" to revision,"model_id" to model)
    }
    fun withChallenge(value: WireObject,successor: Boolean=false,statusGeneration: Long?=null): AccountRecoveryJournal {
        if(value["protocol"]!="lovelies-face-auth-v1" || value["policy_version"]!=policy || NativeProtocol.integer(value["required_captures"],1,1)!=1L ||
            value["poses"]!=listOf("front") || statusGeneration==null && value["recovery_request_id"]!=requestId)throw LiveFailure("account_recovery_response_changed")
        NativeProtocol.bindFaceChallenge(value,account,"login",device)
        val id=NativeProtocol.id(value["device_id"]);val rev=NativeProtocol.text(value["device_revision"])
        if(revision!=null && rev!=revision)throw LiveFailure("account_recovery_response_changed")
        val gen=statusGeneration ?: NativeProtocol.integer(value["recovery_generation"],1,1000000)
        if(value.containsKey("recovery_request_id") && value["recovery_request_id"]!=requestId ||
            value.containsKey("recovery_generation") && NativeProtocol.integer(value["recovery_generation"],1,1000000)!=gen)
            throw LiveFailure("account_recovery_response_changed")
        if(generation>0 && gen!=generation && !(successor && gen==generation+1))throw LiveFailure("account_recovery_response_changed")
        val cid=NativeProtocol.id(value["challenge_id"])
        if(challengeId!=null && gen==generation && cid!=challengeId)throw LiveFailure("account_recovery_response_changed")
        val p=bindProfile(mapOf("id" to value["profile_id"],"revision" to value["profile_revision"],"model_id" to value["model_id"]))
        if((p["model_id"] as? String).isNullOrBlank())throw LiveFailure("account_recovery_response_changed")
        NativeProtocol.text(value["nonce"]);Instant.parse(NativeProtocol.text(value["expires_at"]))
        val changed=gen!=generation
        if(state=="restart_required" && !changed)throw LiveFailure("account_recovery_response_changed")
        val fields=setOf("protocol","challenge_id","nonce","purpose","account_id","device_id","device_revision","policy_version","profile_id","profile_revision","model_id","expires_at","required_captures","poses")
        if(!changed && challenge!=null && NativeProtocol.canonical(challenge.filterKeys { it in fields })!=NativeProtocol.canonical(value.filterKeys { it in fields }))
            throw LiveFailure("account_recovery_response_changed")
        return copy(state="pending",generation=gen,device=id,revision=rev,challengeId=cid,challenge=value,profile=p,
            planned=if(changed)null else planned,accepted=if(changed)false else accepted,retired=if(changed)null else retired,
            completion=if(changed)null else completion,resume=if(changed)null else resume)
    }
    fun plan(bytes: ByteArray): AccountRecoveryJournal {
        if(state!="pending" || challenge==null || planned!=null || accepted)throw LiveFailure("account_recovery_requires_status")
        if(bytes.isEmpty() || bytes.size>8*1024*1024)throw LiveFailure("capture_too_large")
        return copy(state="capture_pending",planned=EnrollmentCapture(0,NativeProtocol.sha256(bytes),"image/jpeg",bytes.size.toLong()))
    }
    fun reconcile(value: WireObject,nonce: String,now: Long): AccountRecoveryJournal {
        if(value["protocol"]!="lovelies-account-recovery-v1" || value["authenticated"]!=false || value["account_id"]!=account ||
            value["recovery_request_id"]!=requestId || value["public_key_digest"]!=digest || value["policy_version"]!=policy || value["request_nonce"]!=nonce)
            throw LiveFailure("account_recovery_response_changed")
        val expiry=NativeProtocol.expiry(value["expires_at"],now)
        if(receiptExpires!=null && receiptExpires!=expiry)throw LiveFailure("account_recovery_response_changed")
        val id=NativeProtocol.id(value["device_id"]);val rev=NativeProtocol.text(value["device_revision"])
        if(device!=null && device!=id || revision!=null && revision!=rev)throw LiveFailure("account_recovery_response_changed")
        val cid=NativeProtocol.id(value["challenge_id"]);val gen=NativeProtocol.integer(value["generation"],1,1000000)
        if(challengeId!=null && gen==generation && cid!=challengeId)throw LiveFailure("account_recovery_response_changed")
        val successor=gen==generation+1 && generation>0 && resume?.get("expected_challenge_id")==challengeId &&
            resume?.get("expected_generation")?.let { NativeProtocol.integer(it)==generation }==true
        if(generation>0 && gen!=generation && !successor)throw LiveFailure("account_recovery_response_changed")
        val status=NativeProtocol.text(value["state"])
        if(status !in setOf("pending","capture_pending","verifying","restart_required","registered"))throw LiveFailure("account_recovery_response_changed")
        val rows=NativeProtocol.rows(value["captures"],1).map(EnrollmentCapture::parse)
        if(rows.any { it.index!=0 })throw LiveFailure("account_recovery_capture_changed")
        val nested=value["challenge"]?.let(NativeProtocol::obj)
        if(nested!=null && nested["challenge_id"]!=cid)throw LiveFailure("account_recovery_response_changed")
        val p=bindProfile(NativeProtocol.obj(value["profile"]))
        if(p["model_id"]==null)throw LiveFailure("account_recovery_response_changed")
        val bound=copy(device=id,revision=rev,generation=gen,challengeId=cid,profile=p,receiptExpires=expiry)
        if(status=="registered") {
            if(nested!=null || rows.isNotEmpty())throw LiveFailure("account_recovery_response_changed")
            return bound.copy(state=if(credentialResult==null)"registered" else "credentials_pending")
        }
        if(successor && rows.isNotEmpty())throw LiveFailure("account_recovery_capture_changed")
        if(status=="restart_required") {
            if(nested!=null || credentialResult!=null)throw LiveFailure("account_recovery_response_changed")
            val known=planned ?: retired
            rows.forEach { if(it!=known)throw LiveFailure("account_recovery_capture_changed") }
            return bound.copy(state=status,challenge=null,planned=null,accepted=false,completion=null,resume=null,retired=if(successor)null else known)
        }
        if(state=="restart_required" && !successor || accepted && rows.isEmpty())throw LiveFailure("account_recovery_capture_changed")
        rows.forEach { if(it!=planned)throw LiveFailure("account_recovery_capture_changed") }
        val next=if(nested!=null)withChallenge(nested,successor=successor,statusGeneration=gen).copy(profile=p,receiptExpires=expiry) else bound.copy(challenge=if(successor)null else challenge,
            planned=if(successor)null else planned,accepted=if(successor)false else accepted,completion=if(successor)null else completion,resume=if(successor)null else resume,retired=if(successor)null else retired)
        return next.copy(state=status,accepted=rows.isNotEmpty(),planned=if(status=="pending")rows.singleOrNull() else next.planned)
    }
    fun withCredentials(value: WireObject): AccountRecoveryJournal {
        if(value["protocol"]!="lovelies-face-auth-v1" || value["status"]!="authenticated" || value["account_id"]!=account ||
            value["auth_method"]!="registered_face" || value["device_id"]!=device)throw LiveFailure("account_recovery_response_changed")
        val p=bindProfile(mapOf("id" to value["profile_id"],"revision" to value["profile_revision"],"model_id" to value["model_id"]))
        if(p["model_id"]==null)throw LiveFailure("account_recovery_response_changed")
        return copy(state="credentials_pending",profile=p,credentialResult=value)
    }
    fun rotatedCredentials(value: WireObject): AccountRecoveryJournal {
        if(state!="credentials_pending" || credentialResult==null || value["account_id"]!=account || value["auth_method"]!="registered_face")throw LiveFailure("account_recovery_response_changed")
        return copy(credentialResult=credentialResult+value.filterKeys { it in setOf("access_token","refresh_token","account_id","auth_method","roles","expires_in","token_type") })
    }
    companion object {
        fun create(origin: String,backup: RecoveryBackup,alias: String,jwk: WireObject,policy: String,sourceAccount: String?)=
            AccountRecoveryJournal(origin,backup,UUID.randomUUID().toString(),alias,jwk,recoveryRandom("lfh_"),policy,sourceAccount)
        fun restore(value: Any?,origin: String): AccountRecoveryJournal {
            val row=NativeProtocol.obj(value)
            val j=AccountRecoveryJournal(NativeProtocol.text(row["origin"]),RecoveryBackup(NativeProtocol.id(row["account"]),recoverySecret(row["secret"])),
                NativeProtocol.id(row["request_id"]),NativeProtocol.text(row["alias"]),NativeProtocol.obj(row["jwk"]),NativeProtocol.text(row["handle"]),NativeProtocol.text(row["policy"]),
                row["source_account"]?.let(NativeProtocol::id),NativeProtocol.text(row["state"]),NativeProtocol.integer(row["generation"],0,1000000),
                row["device"]?.let(NativeProtocol::id),row["revision"]?.let { NativeProtocol.text(it) },row["challenge_id"]?.let(NativeProtocol::id),row["challenge"]?.let(NativeProtocol::obj),
                row["profile"]?.let(NativeProtocol::obj),row["planned"]?.let(EnrollmentCapture::parse),row["accepted"] as? Boolean ?: throw LiveFailure("account_recovery_capture_changed"),
                row["retired"]?.let(EnrollmentCapture::parse),row["completion"]?.let(NativeProtocol::obj),row["resume"]?.let(NativeProtocol::obj),row["credential_result"]?.let(NativeProtocol::obj),
                row["receipt_expires"]?.let { NativeProtocol.integer(it,1) })
            if(j.origin!=origin || !j.alias.startsWith("lovelies.device.recovery.") || !Regex("lfh_[A-Za-z0-9_-]{43}").matches(j.handle))throw LiveFailure("account_recovery_scope_changed")
            if(j.jwk.keys!=setOf("kty","crv","x","y","ext","key_ops") || j.jwk["kty"]!="EC" || j.jwk["crv"]!="P-256" || j.jwk["ext"]!=true || j.jwk["key_ops"]!=listOf("verify") ||
                listOf("x","y").any { !Regex("[A-Za-z0-9_-]{43}").matches(NativeProtocol.text(j.jwk[it])) })throw LiveFailure("device_key_unavailable")
            if(j.state !in setOf("start","pending","capture_pending","completion_pending","verifying","restart_required","registered","credentials_pending") ||
                j.state=="start" && (j.generation!=0L || j.challengeId!=null || j.device!=null || j.planned!=null) ||
                j.state!="start" && (j.generation<1 || j.challengeId==null || j.device==null || j.revision==null || j.profile==null) ||
                j.planned?.index?.let { it!=0 }==true || j.retired?.index?.let { it!=0 }==true || j.accepted && j.planned==null ||
                j.state=="completion_pending" && (!j.accepted || j.completion==null) || j.state=="credentials_pending" && j.credentialResult==null)
                throw LiveFailure("account_recovery_capture_changed")
            j.profile?.let { j.bindProfile(it) }
            j.challenge?.let {
                NativeProtocol.bindFaceChallenge(it,j.account,"login",j.device)
                if(it["challenge_id"]!=j.challengeId || it["device_revision"]!=j.revision || it["policy_version"]!=j.policy || it["required_captures"]?.let { n->NativeProtocol.integer(n) }!=1L ||
                    it["poses"]!=listOf("front") || it["profile_id"]!=j.profile?.get("id") || it["profile_revision"]!=j.profile?.get("revision") || it["model_id"]!=j.profile?.get("model_id") ||
                    it.containsKey("recovery_request_id") && it["recovery_request_id"]!=j.requestId ||
                    it.containsKey("recovery_generation") && NativeProtocol.integer(it["recovery_generation"],1,1000000)!=j.generation)
                    throw LiveFailure("account_recovery_response_changed")
            }
            if(j.retired!=null && (j.state!="restart_required" || j.planned!=null || j.accepted || j.challenge!=null || j.completion!=null))throw LiveFailure("account_recovery_capture_changed")
            j.resume?.let {
                NativeProtocol.id(it["resume_key"])
                if(it.keys!=setOf("resume_key","expected_generation","expected_challenge_id") || NativeProtocol.integer(it["expected_generation"])!=j.generation || it["expected_challenge_id"]!=j.challengeId)
                    throw LiveFailure("account_recovery_response_changed")
            }
            j.completion?.let {
                if(it.keys!=setOf("challenge_id","device_signature") || it["challenge_id"]!=j.challengeId || !Regex("[A-Za-z0-9_-]{86}").matches(NativeProtocol.text(it["device_signature"])))
                    throw LiveFailure("account_recovery_response_changed")
            }
            return j
        }
    }
}
