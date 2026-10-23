package com.lovelies.frontend.preview

import android.content.Context
import android.util.AtomicFile
import kotlinx.coroutines.delay
import org.json.JSONObject
import java.io.File

/** Independent installation vaults and actual Cloudflare responses; no key/capture seed or fabricated success. */
internal class AccountRecoveryJourney(private val sourceContext: Context,private val newContext: Context,private val origin: String,port: Int,
    private val selfies: List<String>,private val fresh: String,private val input: (String)->ByteArray,
    private val pass: (String,WireObject)->Unit): AutoCloseable {
    private val relay=EnrollmentReplyLossRelay(origin,port)
    val endpoint get()=relay.url
    private val checkpoint=AtomicFile(File(newContext.noBackupFilesDir,"account-recovery-checkpoint.json"))
    private var marker: WireObject=if(checkpoint.baseFile.exists())jsonMap(JSONObject(checkpoint.readFully().toString(Charsets.UTF_8))) else emptyMap()
    var repository: CloudflareRepository?=null;private set
    val account get()=NativeProtocol.id(marker["account"])
    val phase get()=marker["phase"] as? String
    private fun saveMarker(j: AccountRecoveryJournal,phase: String,oldDevice: String?=null,oldAlias: String?=null) {
        // Only identifiers/public-key digest go into test progress; the private backup remains encrypted.
        val next=mapOf("account" to j.account,"request_id" to j.requestId,"alias" to j.alias,"digest" to j.digest,
            "origin" to endpoint,"api_origin" to origin,"phase" to phase,"old_device" to (oldDevice ?: marker["old_device"]),
            "old_alias" to (oldAlias ?: marker["old_alias"]))
        val bytes=NativeProtocol.canonical(next).toByteArray();val stream=checkpoint.startWrite()
        try { stream.write(bytes);checkpoint.finishWrite(stream);marker=next }
        catch(problem: Throwable) { checkpoint.failWrite(stream);throw problem } finally { bytes.fill(0) }
    }
    private fun same(j: AccountRecoveryJournal) {
        check(j.account==marker["account"] && j.requestId==marker["request_id"] && j.alias==marker["alias"] && j.digest==marker["digest"])
        check(endpoint==marker["origin"] && origin==marker["api_origin"])
        j.assertKey(SecureSession(newContext,endpoint).existingDevice(j.alias))
    }
    private suspend fun lost(block: suspend ()->Unit) {
        try { block();error("Expected a real dropped reply") }
        catch(problem: LiveFailure) { check(problem.code=="connection_unavailable" && problem.ambiguous) { "Unexpected transport failure ${problem.code}" } }
        relay.assertHealthy();check(relay.lastLostStatus.get() in 200..299)
    }
    private suspend fun denied(codes: Set<String>,block: suspend ()->Unit) {
        try { block();error("Expected a fail-closed native denial") }
        catch(problem: LiveFailure) { check(problem.code in codes) { "Unexpected denial ${problem.code}" } }
    }
    private suspend fun ready(repo: CloudflareRepository): WireObject {
        repeat(30) {
            try { return repo.faceChallenge() }
            catch(problem: LiveFailure) { if(problem.code!="account_recovery_in_flight")throw problem;delay(500) }
        }
        error("Actual recovery writer did not settle")
    }
    private suspend fun recover(): CloudflareRepository {
        val before=relay.anonymousCalls.get();val repo=CloudflareRepository(newContext,endpoint)
        check(repo.bootstrap().isEmpty());val journal=repo.accountRecovery ?: error("New-device recovery journal absent")
        same(journal);check(relay.anonymousCalls.get()==before)
        repository=repo
        pass("Separate-installation encrypted journal restores before any replacement anonymous bootstrap",mapOf("phase" to phase,"account_id" to journal.account))
        return repo
    }
    private suspend fun capture(repo: CloudflareRepository,path: String): Pair<Int,WireObject?> {
        val bytes=input(path);return try { repo.faceCapture(bytes) } finally { bytes.fill(0) }
    }
    private fun raw(path: String,token: String?=null,method: String="GET",body: WireObject?=null): WireObject {
        val fence=SessionFence();val scope=fence.switch(null);val bytes=body?.let { NativeProtocol.canonical(it).toByteArray() }
        val response=try { CloudflareTransport(endpoint,fence).request(path,scope,token,method,bytes) } finally { bytes?.fill(0) }
        return try { jsonMap(JSONObject(response.toString(Charsets.UTF_8))) } finally { response.fill(0) }
    }
    suspend fun run(until: String="finish"): CloudflareRepository? {
        check(until in setOf("start","capture","completion","finish"));check(selfies.size==3)
        if(marker.isNotEmpty() && phase==until) { recover();pass("Requested account-recovery checkpoint already exists; no mutation repeated",mapOf("phase" to until));return null }
        if(marker.isEmpty()) {
            val health=raw("/health");check(health["database"]=="cloudflare_durable_object_sqlite" && health["database_ready"]==true)
            try { raw("/auth/otp/start",method="POST",body=emptyMap());error("OTP unexpectedly available") }
            catch(problem: LiveFailure) { check(problem.status in setOf(404,410)) }
            pass("Actual Cloudflare SQLite is ready and OTP is unavailable",emptyMap())
            val source=CloudflareRepository(sourceContext,endpoint);source.bootstrap();val initial=source.credentials!!.account
            source.faceChallenge();selfies.forEachIndexed { index,path -> check(capture(source,path).first==index+1) }
            check(source.credentials!!.account==initial && source.get("/me")["authenticated"]==true)
            val oldIdentity=source.identity ?: error("Original registered device missing")
            relay.beforeDispatch={ path -> if(path=="/auth/face/recovery/key") {
                val intent=RecoveryKeyIntent.restore(SecureSession(sourceContext,endpoint).load()["recovery_key_intent"],endpoint)
                check(intent.backup.account==initial && intent.receipt==null)
            } }
            relay.arm("/auth/face/recovery/key")
            lost { source.createRecoveryKey() }
            relay.release();relay.beforeDispatch=null
            val restoredSource=CloudflareRepository(sourceContext,endpoint);check(restoredSource.bootstrap()["authenticated"]==true)
            val receipt=restoredSource.recoveryKey() ?: error("Actual key receipt absent")
            val saved=restoredSource.recoveryKeyIntent ?: error("Original key intent absent")
            check(saved.operation==receipt.operation && saved.receipt!!.same(receipt))
            val backup=restoredSource.recoveryBackupText()
            check(RecoveryBackup.parse(backup).account==initial)
            pass("Recovery key secret/UUID precede HTTP; lost real issuance reply reconciles without another key",mapOf("account_id" to initial,"key_id" to receipt.keyId))
            denied(setOf("account_recovery_sign_out_required")) { restoredSource.beginAccountRecovery(backup) }
            pass("Authenticated current client cannot start account recovery before signing out",emptyMap())
            val repo=CloudflareRepository(newContext,endpoint);repo.bootstrap()
            check(repo.credentials!!.method=="anonymous" && repo.credentials!!.account!=initial)
            val wrong=RecoveryBackup.create(initial)
            denied(setOf("account_recovery_unavailable")) { repo.beginAccountRecovery(wrong.text()) }
            val failed=repo.accountRecovery ?: error("Unavailable request was silently discarded")
            val oldScope=repo.currentScope();val count=relay.anonymousCalls.get()
            check(failed.backup==wrong && repo.identity==null)
            relay.beforeDispatch={ path -> if(path=="/auth/face/recovery/challenge") {
                val vault=SecureSession(newContext,endpoint).load()
                val active=AccountRecoveryJournal.restore(vault["account_recovery"],endpoint)
                val history=NativeProtocol.rows(vault["retired_account_recoveries"],16).map { AccountRecoveryJournal.restore(it,endpoint) }
                check(active.backup==RecoveryBackup.parse(backup) && history.single().requestId==failed.requestId && history.single().alias==failed.alias)
            } }
            relay.arm("/auth/face/recovery/challenge")
            lost { repo.switchAccountRecovery(backup) }
            relay.release();relay.beforeDispatch=null
            val j=repo.accountRecovery ?: error("Lost start discarded corrected recovery intent")
            check(j.account==initial && j.state=="start" && j.alias!=oldIdentity.alias && j.alias!=failed.alias && j.requestId!=failed.requestId)
            check(relay.anonymousCalls.get()==count)
            denied(setOf("session_changed")) { repo.fence.assert(oldScope) }
            saveMarker(j,"start",oldIdentity.device,oldIdentity.alias);repository=repo
            pass("Explicit corrected backup archives failed request; old callbacks and key references are fenced",mapOf("archived_requests" to 1))
            pass("Lost real recovery-start reply preserves original target account and distinct new Keystore key",mapOf("account_id" to initial))
            if(until=="start")return null
        }
        if(phase=="start") {
            val repo=recover();val challenge=ready(repo);val j=repo.accountRecovery!!;same(j)
            check(challenge["purpose"]=="login" && NativeProtocol.integer(challenge["required_captures"])==1L && j.device!=marker["old_device"])
            denied(setOf("account_recovery_requires_status")) { repo.get("/me/gallery") }
            val old=SecureSession(sourceContext,endpoint).load()["credentials"]?.let(NativeProtocol::obj) ?: error("Original session missing")
            check(raw("/me",NativeProtocol.text(old["access_token"]))["authenticated"]==true)
            pass("Signed progress grants no access and leaves old authority active until fresh-face completion",emptyMap())
            relay.arm("/auth/face/proof/${j.challengeId}/0")
            lost { capture(repo,fresh) }
            val pending=repo.accountRecovery!!;same(pending)
            check(pending.state=="capture_pending" && pending.planned!=null && !pending.accepted)
            saveMarker(pending,"capture");relay.release()
            pass("Lost real one-pose proof reply preserves exact hash without premature credentials",emptyMap())
            if(until=="capture")return null
        }
        if(phase=="capture") {
            val repo=recover();relay.arm("/auth/face/complete")
            lost { ready(repo) }
            val pending=repo.accountRecovery!!;same(pending)
            check(pending.state=="completion_pending" && pending.accepted && pending.completion!=null && pending.credentialResult==null)
            saveMarker(pending,"completion");relay.release()
            pass("Accepted proof reconciles once; lost actual completion keeps durable same-account receipt",emptyMap())
            if(until=="completion")return null
        }
        check(phase=="completion")
        val repo=recover();val login=ready(repo);same(repo.accountRecovery!!)
        check(repo.accountRecovery!!.state=="registered" && login["purpose"]=="login" && login["account_id"]==account &&
            login["device_id"]==repo.accountRecovery!!.device && NativeProtocol.integer(login["required_captures"])==1L && repo.credentials?.method=="anonymous") {
            "Read-only A02 status published credentials or changed the original-account/new-device fresh-login challenge"
        }
        val held=CameraLoginJournal.restore(repo.saved("camera_login"),endpoint)
        held.assertOwner(endpoint,repo.accountRecovery!!.account,repo.accountRecovery!!.alias,repo.accountRecovery!!.device!!)
        check(repo.cameraLoginHeld && held.state=="ready" && held.capture==null && held.completion==null && held.credentials==null &&
            NativeProtocol.canonical(held.challenge)==NativeProtocol.canonical(login)) { "A02 fresh-login hold lost its original recovery binding or already carried credential authority" }
        denied(setOf("face_login_requires_status")) { repo.get("/me/gallery") }
        val original=SecureSession(sourceContext,endpoint).load();val old=NativeProtocol.obj(original["credentials"])
        try { raw("/me",NativeProtocol.text(old["access_token"]));error("Old session survived recovery") } catch(problem: LiveFailure) { check(problem.status==401) }
        val oldIdentity=NativeProtocol.obj(original["device"])
        try { raw("/auth/face/challenge",method="POST",body=mapOf("face_handle" to oldIdentity["handle"],"device_id" to oldIdentity["device"]));error("Old device survived recovery") }
        catch(problem: LiveFailure) { check(problem.status==401) }
        check(SecureSession(sourceContext,endpoint).existingDevice(NativeProtocol.text(marker["old_alias"])).isNotEmpty())
        pass("Actual committed recovery revokes old session/device while retaining the old local hardware key",emptyMap())
        pass("Registered readonly receipt gives no credentials; saved new device performs fresh-selfie login",emptyMap())
        check(capture(repo,fresh).second!=null) { "A02 fresh registered-reference capture did not return validated credentials" }
        check(repo.accountRecovery==null && !repo.cameraLoginHeld && repo.identity!!.alias==marker["alias"] && repo.credentials!!.account==account) {
            "A02 fresh login did not clear recovery holds while preserving the original account/new device key"
        }
        val me=repo.get("/me");check(me["authenticated"]==true && me["user_id"]==account)
        val devices=NativeProtocol.rows(repo.get("/me/devices")["items"])
        check(devices.single { it["current"]==true }["id"]==repo.identity!!.device)
        check(devices.filter { it["id"]!=repo.identity!!.device }.all { it["status"]=="revoked" })
        check(repo.recoveryKey()==null)
        check(NativeProtocol.rows(SecureSession(newContext,endpoint).load()["retired_account_recoveries"],16).size==1)
        pass("New-key login durably restores original account/profile; consumed backup and old devices stay unusable",mapOf("account_id" to account,"active_devices" to 1))
        repository=repo;relay.assertHealthy();return repo
    }
    override fun close() { relay.close() }
}
