package com.lovelies.frontend.preview

import android.content.Context
import android.util.AtomicFile
import java.io.File
import kotlinx.coroutines.delay
import org.json.JSONObject

/** Actual Cloudflare mutations and copied private face models; JPEG assets are declared test inputs. */
internal class FaceLifecycleJourney(private val context: Context,private val origin: String,port: Int,
    private val selfies: List<String>,private val fresh: String,private val input: (String)->ByteArray,
    private val pass: (String,WireObject)->Unit) : AutoCloseable {
    private val relay=EnrollmentReplyLossRelay(origin,port)
    val endpoint get()=relay.url
    private val checkpoint=AtomicFile(File(context.noBackupFilesDir,"lifecycle-checkpoint.json"))
    private var marker: WireObject=if(checkpoint.baseFile.exists())jsonMap(JSONObject(checkpoint.readFully().toString(Charsets.UTF_8))) else emptyMap()
    val phase get()=marker["phase"] as? String
    var repository: CloudflareRepository?=null;private set
    var account: String?=marker["account"] as? String;private set
    private fun durableMarker(j: FaceLifecycleJournal,phase: String) {
        val next=mapOf("account" to j.account,"device" to j.device,"alias" to j.alias,"digest" to j.digest,
            "control_operation" to j.controlOperation,"operation_key" to j.intent!!.key,"reference" to j.intent.reference,
            "api_origin" to origin,"origin" to endpoint,"phase" to phase)
        val bytes=NativeProtocol.canonical(next).toByteArray();val stream=checkpoint.startWrite()
        try { stream.write(bytes);checkpoint.finishWrite(stream);marker=next }
        catch(problem: Throwable) { checkpoint.failWrite(stream);throw problem } finally { bytes.fill(0) }
    }
    private fun same(j: FaceLifecycleJournal) {
        check(j.account==marker["account"] && j.device==marker["device"] && j.alias==marker["alias"] && j.digest==marker["digest"] &&
            j.controlOperation==marker["control_operation"] && j.intent?.key==marker["operation_key"])
        check(endpoint==marker["origin"] && origin==marker["api_origin"])
        j.assertKey(SecureSession(context,endpoint).existingDevice(j.alias))
    }
    private suspend fun recover(): CloudflareRepository {
        val count=relay.anonymousCalls.get();val repo=CloudflareRepository(context,endpoint)
        check(repo.bootstrap().isEmpty());same(repo.faceLifecycle ?: error("Saved lifecycle journal missing"))
        check(relay.anonymousCalls.get()==count && repo.credentials?.account==account)
        repository=repo
        pass("A03 process checkpoint restores the original encrypted account/device/key before bootstrap",mapOf("phase" to phase,"account_id" to account))
        return repo
    }
    private suspend fun lost(block: suspend ()->Unit) {
        try { block();error("Expected a real successful Cloudflare mutation reply to be dropped") }
        catch(problem: LiveFailure) { check(problem.code=="connection_unavailable" && problem.ambiguous) }
        relay.assertHealthy();check(relay.lastLostStatus.get() in 200..299);relay.release()
    }
    private suspend fun preferences(repo: CloudflareRepository,matching: Boolean,processing: Boolean=true) {
        val policy=repo.photoPreferences()
        repo.mutate("photo.preferences",mapOf("policy_version" to NativeProtocol.text(policy["policy_version"]),"receive_matches" to matching,
            "photo_matching_consent" to matching,"processing_consent" to processing),"account",path="/me/photo-preferences")
    }
    private suspend fun capture(repo: CloudflareRepository,path: String): Pair<Int,WireObject?> {
        val bytes=input(path);return try { repo.faceCapture(bytes) } finally { bytes.fill(0) }
    }
    private suspend fun privateDenied(repo: CloudflareRepository) {
        try { repo.get("/me/gallery");error("Lifecycle management granted private gallery access") }
        catch(problem: LiveFailure) { check(problem.code=="face_profile_requires_status") }
    }
    private fun tokenDenied(token: String,account: String) {
        val fence=SessionFence();val scope=fence.switch(account)
        try { CloudflareTransport(endpoint,fence).request("/me",scope,token);error("Old registered credential survived revocation") }
        catch(problem: LiveFailure) { check(problem.status==401) }
    }
    private suspend fun ready(repo: CloudflareRepository): WireObject {
        repeat(60) {
            try { return repo.faceChallenge() }
            catch(problem: LiveFailure) { if(problem.code!="face_profile_in_flight")throw problem;delay(250) }
        }
        error("Actual lifecycle writer/verifier did not settle")
    }
    private suspend fun cleanup(repo: CloudflareRepository): FaceLifecycleMetadata {
        repeat(90) {
            val meta=repo.lifecycleStatus()
            if(meta.removal=="completed")return meta
            check(meta.removal in setOf("pending","failed","blocked")) { "Unexpected cleanup state ${meta.removal}" }
            check(!meta.authenticationEnabled && !meta.matchingEnabled && meta.profile==null)
            privateDenied(repo);delay(500)
        }
        error("Physical reference deletion did not reach verified completion")
    }
    private suspend fun complete(repo: CloudflareRepository,action: String,expectedProfile: WireObject?=null): FaceLifecycleMetadata {
        val before=repo.faceLifecycle ?: error("Saved management control missing")
        val challenge=repo.lifecycleBegin(action)
        val count=if(action=="restore_authentication")1 else 3
        check(challenge["purpose"]==if(action=="replace")"replacement" else "registration")
        check(NativeProtocol.integer(challenge["required_captures"])==count.toLong())
        check(challenge["device_id"]==before.device && challenge["account_id"]==before.account)
        if(action=="enroll") {
            val accepted=repo.faceLifecycle ?: error("Accepted lifecycle challenge lost its journal")
            check(before.metadata.removal=="completed" && before.metadata.profile==null)
            check(accepted.metadata.removal=="completed" && accepted.metadata.profile==null && accepted.intent?.reference==null)
            check(accepted.account==before.account && accepted.alias==before.alias && accepted.device==before.device)
            check(listOf("profile_id","profile_revision","model_id").all { challenge[it]==null })
        }
        else check(challenge["profile_id"]==expectedProfile?.get("id") && challenge["profile_revision"]==expectedProfile?.get("revision") && challenge["model_id"]==expectedProfile?.get("model_id"))
        privateDenied(repo)
        repeat(count) { index->
            val result=capture(repo,if(count==1)fresh else selfies[index]);check(result.first==index+1)
            if(index<count-1)check(result.second==null) else check(result.second!=null)
        }
        val meta=repo.lifecycleStatus()
        check(meta.authenticationEnabled && meta.profile!=null && repo.credentials?.method=="registered_face")
        check(repo.credentials?.account==before.account && repo.identity?.device==before.device && repo.identity?.alias==before.alias)
        check(repo.get("/me")["authenticated"]==true)
        return meta
    }
    /** Each checkpoint may run in a separate instrumentation process on the same isolated vault and relay port. */
    suspend fun run(until: String="finish"): CloudflareRepository? {
        check(until in setOf("start","capture","completion","finish") && selfies.size==3)
        if(marker.isNotEmpty() && phase==until) {
            recover();pass("A03 checkpoint is already durable; no original mutation repeated",mapOf("phase" to until));return null
        }
        if(marker.isEmpty()) {
            val repo=CloudflareRepository(context,endpoint);val me=repo.bootstrap();val anonymous=repo.credentials ?: error("Anonymous actor missing")
            check(anonymous.method=="anonymous" && me["authenticated"]==false);account=anonymous.account
            repo.faceChallenge();repeat(3) { index->check(capture(repo,selfies[index]).first==index+1) }
            check(repo.credentials?.account==account && repo.credentials?.method=="registered_face")
            preferences(repo,true)
            val original=repo.lifecycleStatus();val control=repo.faceLifecycle ?: error("Original control absent")
            control.assertKey(SecureSession(context,endpoint).existingDevice(control.alias))
            val persisted=FaceLifecycleJournal.restore(SecureSession(context,endpoint).load()["face_lifecycle"],endpoint)
            check(persisted.controlOperation==control.controlOperation && persisted.alias==control.alias && persisted.acknowledged)
            pass("A03 creates a durable original-device private control without changing the enrolled account",mapOf("account_id" to account,"profile_version" to original.version))
            val pause=repo.lifecycleAction("pause")
            check(!pause.matchingEnabled && pause.matchingPaused && !pause.receiveMatches && pause.authenticationEnabled && pause.processingEnabled)
            check(repo.get("/me")["authenticated"]==true)
            val resume=repo.lifecycleAction("resume")
            check(resume.matchingEnabled && !resume.matchingPaused && resume.receiveMatches && resume.authenticationEnabled && resume.processingEnabled)
            pass("Pause and explicit resume change only matching/receiving while authentication and processing remain",emptyMap())
            repo.lifecycleBegin("replace");check(capture(repo,selfies[0]).first==1)
            val cancelledKey=repo.faceLifecycle!!.intent!!.key
            repo.lifecycleCancel(repo.cancelFace())
            check(repo.faceLifecycle!!.intent==null && repo.faceLifecycle!!.metadata.operation?.state=="cancelled" && repo.faceLifecycle!!.metadata.operation?.key==cancelledKey)
            check(repo.faceLifecycle!!.alias==control.alias && repo.faceLifecycle!!.account==account)
            pass("Explicit capture stop cancels the exact server operation and retains the original device key",emptyMap())
            relay.beforeDispatch={ path->if(path=="/auth/face/profile/challenge") {
                val saved=FaceLifecycleJournal.restore(SecureSession(context,endpoint).load()["face_lifecycle"],endpoint)
                check(saved.state=="capture_start" && saved.intent?.action=="replace" && saved.alias==control.alias && saved.account==account)
                saved.assertKey(SecureSession(context,endpoint).existingDevice(saved.alias))
            } }
            relay.arm("/auth/face/profile/challenge");lost { repo.lifecycleBegin("replace") };relay.beforeDispatch=null
            val saved=repo.faceLifecycle!!;check(saved.state=="capture_start" && saved.challenge==null && saved.intent!=null)
            durableMarker(saved,"start");repository=repo
            pass("Lost lifecycle start reply retains a previously durable original account/key/operation",emptyMap())
            if(until=="start")return null
        } else check(phase in setOf("start","capture","completion")) { "Refusing to reuse a completed lifecycle test run" }
        if(phase=="start") {
            val repo=recover();val replacement=ready(repo);same(repo.faceLifecycle!!)
            val oldProfile=NativeProtocol.obj(marker["reference"])
            check(replacement["purpose"]=="replacement" && replacement["profile_id"]==oldProfile["id"] && replacement["profile_revision"]==oldProfile["revision"])
            check(repo.faceCaptureCount==0 && repo.faceLifecycle!!.generation==1L)
            relay.arm("/auth/face/proof/${replacement["challenge_id"]}/0");lost { capture(repo,selfies[0]) }
            val saved=repo.faceLifecycle!!;same(saved);check(saved.state=="capture_pending" && saved.planned.size==1 && saved.accepted.isEmpty())
            durableMarker(saved,"capture")
            pass("Lost first replacement capture reply preserves its exact durable hash and accepted server proof",emptyMap())
            if(until=="capture")return null
        }
        if(phase=="capture") {
            val repo=recover();ready(repo);same(repo.faceLifecycle!!)
            check(repo.faceCaptureCount==1 && repo.faceLifecycle!!.accepted.size==1)
            pass("Signed lifecycle status recovers the settled first proof without duplicate upload",emptyMap())
            check(capture(repo,selfies[1]).first==2)
            relay.arm("/auth/face/profile/complete");lost { capture(repo,selfies[2]) }
            val saved=repo.faceLifecycle!!;same(saved)
            check(saved.state=="completion_pending" && saved.accepted.size==3 && saved.credentialResult==null)
            durableMarker(saved,"completion")
            pass("Lost committed replacement completion preserves the original account/key and three-proof journal",emptyMap())
            if(until=="completion")return null
        }
        check(phase=="completion")
        val repo=recover();val control=repo.faceLifecycle!!;val oldToken=repo.credentials!!.token;val oldProfile=NativeProtocol.obj(marker["reference"])
        val committed=repo.lifecycleStatus()
        check(committed.operation?.state=="completed" && committed.profile!!["id"]==oldProfile["id"] && committed.profile["revision"]!=oldProfile["revision"])
        privateDenied(repo);tokenDenied(oldToken,account!!)
        pass("Lost committed replacement reply restores the same encrypted account/key; status grants no session",emptyMap())
        val login=ready(repo);check(login["purpose"]=="login" && NativeProtocol.integer(login["required_captures"])==1L)
        check(capture(repo,fresh).second!=null && repo.faceLifecycle!!.intent==null)
        check(repo.credentials!!.account==account && repo.identity!!.alias==control.alias && repo.identity!!.device==control.device)
        val current=repo.lifecycleStatus();check(current.authenticationEnabled && current.matchingEnabled && current.processingEnabled)
        pass("Fresh one-selfie registered-reference login validates the replaced current profile before private access",emptyMap())

        val activeProfile=current.profile!!;val beforeWithdrawal=repo.credentials!!.token
        val withdrawn=repo.lifecycleAction("withdraw_authentication")
        check(!withdrawn.authenticationEnabled && withdrawn.matchingEnabled && withdrawn.processingEnabled && withdrawn.profile==activeProfile && withdrawn.removal=="none")
        check(repo.credentials==null);privateDenied(repo);tokenDenied(beforeWithdrawal,account!!)
        try { repo.lifecycleVerify();error("Withdrawn authentication entered ordinary sign-in seam") }
        catch(problem: LiveFailure) { check(problem.code=="face_profile_requires_status") }
        val restored=complete(repo,"restore_authentication",activeProfile)
        check(restored.profile==activeProfile && restored.matchingEnabled && restored.processingEnabled)
        pass("Authentication withdrawal fences access; explicit one-selfie restore preserves independent matching and processing",emptyMap())

        val removed=repo.lifecycleAction("remove")
        check(!removed.authenticationEnabled && !removed.matchingEnabled && removed.processingEnabled && !removed.receiveMatches)
        check(removed.removal in setOf("pending","failed","blocked","completed"));privateDenied(repo)
        // The signed status preflight may finish real DELETE/absent-HEAD cleanup; the earlier action reply is not its current gate.
        val gone=cleanup(repo);check(gone.profile==null && gone.processingEnabled)
        val newProfile=complete(repo,"enroll")
        check(newProfile.profile!!["id"]!=activeProfile["id"] && !newProfile.matchingEnabled && newProfile.processingEnabled)
        pass("Removal waits for actual private-reference cleanup before same-account three-selfie enrollment",emptyMap())

        // No remaining matching purpose: withdrawing auth must retire the reference rather than offering comparison against it.
        val authOnly=repo.lifecycleAction("withdraw_authentication")
        check(!authOnly.authenticationEnabled && !authOnly.matchingEnabled && authOnly.processingEnabled)
        cleanup(repo);val enrolledAgain=complete(repo,"enroll")
        check(!enrolledAgain.matchingEnabled && enrolledAgain.processingEnabled && repo.identity!!.alias==control.alias)
        preferences(repo,true)
        check(repo.get("/me")["user_id"]==account && repo.faceLifecycle!!.account==account)
        pass("Authentication-only withdrawal also verifies cleanup and reenrolls on the original account/key",emptyMap())
        repository=repo;relay.assertHealthy();return repo
    }
    override fun close() { relay.close() }
}
