package com.lovelies.frontend.preview

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import kotlinx.coroutines.delay
import java.io.ByteArrayOutputStream

/** Declared synthetic JPEGs exercise real signed Cloudflare rejection/reconciliation, never optical face proof. */
internal class CameraRecoveryJourney(private val context: Context,private val origin: String,private val pass: (String,WireObject)->Unit): AutoCloseable {
    private val relay=EnrollmentReplyLossRelay(origin,0)
    var repository=CloudflareRepository(context,relay.url);private set
    override fun close()=relay.close()
    private fun blank(index: Int): ByteArray {
        val image=Bitmap.createBitmap(640,640,Bitmap.Config.ARGB_8888)
        image.eraseColor(Color.rgb(255-index*20,255-index*20,255-index*20))
        return try { ByteArrayOutputStream().use { out->check(image.compress(Bitmap.CompressFormat.JPEG,90-index*5,out));out.toByteArray() } }
        finally { image.eraseColor(0);image.recycle() }
    }
    suspend fun rejectAndRecover(): WireObject {
        val original=repository.enrollment ?: error("Original enrollment journal missing")
        val first=original.challenge ?: error("Original challenge missing")
        val current=NativeCaptureContext(1,repository.currentScope(),repository.baseUrl,CameraCaptureMode.FACE,"face_authentication",original.key,
            NativeCaptureContext.fingerprint(first),0,"front")
        val review=CameraReviewBuffer();val beforeProofs=relay.proofCalls.get()
        val bytes=blank(0);val hash=NativeProtocol.sha256(bytes)
        check(review.offer(bytes,current,current));review.clear();check(bytes.all { it==0.toByte() })
        check(repository.enrollment?.planned?.isEmpty()==true && repository.enrollment?.accepted?.isEmpty()==true && relay.proofCalls.get()==beforeProofs)
        pass("A04 local review and retake keep the original challenge and dispatch no signed capture",mapOf("fixture" to "on-device plain-colour synthetic JPEG",
            "sha256" to hash,"bytes" to bytes.size,"capture_manifest_unchanged" to true,"proof_puts_dispatched" to relay.proofCalls.get()-beforeProofs))
        repeat(3) { index->
            val capture=blank(index);val owner=current.copy(index=index,pose=listOf("front","left","right")[index])
            check(review.offer(capture,owner,owner));val approved=review.approve(owner)!!;check(review.approve(owner)==null)
            try {
                val result=repository.faceCapture(approved.bytes,approved.owner)
                check(index<2 && result.first==index+1 && result.second==null && repository.credentials?.method=="anonymous")
            } catch(problem: LiveFailure) {
                check(index==2 && problem.status==422 && problem.code=="face_capture_no_face")
                pass("A04 backend rejects no-face captures without authenticating or granting matching access",mapOf("code" to problem.code,"status" to problem.status,
                    "fixture" to "three distinct on-device plain-colour JPEGs","account_id" to original.account,"original_device_key_retained" to true))
            } finally { approved.bytes.fill(0) }
        }
        check(repository.credentials?.method=="anonymous" && repository.credentials?.account==original.account)
        repository.cancelFace()
        var successor: WireObject?=null
        repeat(60) {
            if(successor==null)try { successor=repository.faceChallenge() }
            catch(problem: LiveFailure) { if(problem.code!="enrollment_in_flight")throw problem;delay(250) }
        }
        val next=successor ?: error("Rejected captures did not settle into an explicit successor")
        val restored=repository.enrollment ?: error("Original encrypted enrollment disappeared")
        check(restored.account==original.account && restored.alias==original.alias && restored.key==original.key && restored.device==original.device)
        check(restored.generation>original.generation && restored.challengeId!=original.challengeId && restored.accepted.isEmpty() && restored.planned.isEmpty())
        check(next["required_captures"]==3L || next["required_captures"]==3)
        pass("A04 signed recovery retires rejected proofs and allows all three retakes on the same account/device key",mapOf("generation" to restored.generation,
            "account_id" to restored.account,"new_challenge" to true,"no_otp" to true,"no_new_account" to true))
        return next
    }
    suspend fun approve(challenge: WireObject,bytes: ByteArray,index: Int): Pair<Int,WireObject?> {
        val saved=repository.enrollment ?: error("Saved enrollment missing")
        val pose=(challenge["poses"] as List<*>)[index] as String
        val owner=NativeCaptureContext(2,repository.currentScope(),repository.baseUrl,CameraCaptureMode.FACE,"face_authentication",saved.key,
            NativeCaptureContext.fingerprint(challenge),index,pose)
        val image=decodeCameraReview(bytes);check(image.width<=1280 && image.height<=1280);if(image.isMutable)image.eraseColor(0)
        val review=CameraReviewBuffer();val before=relay.proofCalls.get()
        check(review.offer(bytes,owner,owner));check(relay.proofCalls.get()==before && repository.enrollment!!.accepted.size==index)
        val approved=review.approve(owner) ?: error("Explicit approval did not release current frame")
        val result=try { repository.faceCapture(approved.bytes,approved.owner) } finally { approved.bytes.fill(0) }
        check(relay.proofCalls.get()==before+1)
        pass("A04 retaken selfie ${index+1} uploads exactly once after explicit review approval",mapOf("proof_puts_dispatched" to 1,"optical_camera_proof" to false))
        return result
    }
    suspend fun interruptedLogin(fresh: ByteArray): CloudflareRepository {
        val original=repository.identity ?: error("Original face/device identity missing")
        val oldAccount=repository.credentials!!.account;val previousAnon=relay.anonymousCalls.get()
        val proof=repository.faceChallenge()
        check(proof["purpose"]=="login" && proof["account_id"]==oldAccount && proof["device_id"]==original.device && NativeProtocol.integer(proof["required_captures"])==1L) {
            "Interrupted-login challenge did not bind the original account/device to one registered-reference capture"
        }
        relay.arm("/auth/face/complete")
        try { repository.faceCapture(fresh);error("Expected the actual login completion response to be lost") }
        catch(problem: LiveFailure) { check(problem.code=="connection_unavailable" && problem.ambiguous) }
        relay.assertHealthy();check(relay.lastLostStatus.get() in 200..299);relay.release()
        val saved=CameraLoginJournal.restore(repository.saved("camera_login"),repository.baseUrl)
        check(saved.state=="completion_pending" && saved.capture!=null && saved.completion!=null && saved.credentials==null)
        val restarted=CloudflareRepository(context,repository.baseUrl);check(restarted.bootstrap().isEmpty())
        check(restarted.identity==original && relay.anonymousCalls.get()==previousAnon)
        val before=relay.proofCalls.get()
        try { restarted.faceChallenge();error("Uncertain one-use login proof was immediately replaced") }
        catch(problem: LiveFailure) { check(problem.code=="face_login_in_flight") }
        try { restarted.get("/me/gallery");error("Unvalidated ordinary login hold exposed private media") }
        catch(problem: LiveFailure) { check(problem.code=="face_login_requires_status") }
        check(relay.proofCalls.get()==before)
        val expires=java.time.Instant.parse(NativeProtocol.text(proof["expires_at"])).toEpochMilli()
        val checkedAt=System.currentTimeMillis();val remaining=expires-checkedAt
        // Workerd and the emulator have independent wall clocks. This test-only 2s allowance
        // bounds the real wait; it does not change the signed expiry, 120s backend TTL or any auth gate.
        val clockSkewAllowance=2000L;val maximumWait=120000L+clockSkewAllowance
        check(remaining in 0..maximumWait) {
            "Signed login expiry has ${remaining}ms remaining on the Android clock; expected 0..${maximumWait}ms with test-only ${clockSkewAllowance}ms clock allowance (checked_at=$checkedAt, expires_at=$expires)"
        }
        pass("A04 interrupted ordinary login restores the exact encrypted original-device hold without another account or proof",mapOf("account_id" to oldAccount,
            "state" to saved.state,"no_new_proof" to true,"private_media_denied" to true,"signed_expires_at_ms" to expires,
            "android_checked_at_ms" to checkedAt,"remaining_ms" to remaining,"test_clock_skew_allowance_ms" to clockSkewAllowance))
        while(System.currentTimeMillis()<=expires)delay(minOf(500L,expires-System.currentTimeMillis()+1))
        val next=restarted.faceChallenge()
        check(next["challenge_id"]!=proof["challenge_id"]) { "Expired one-use login challenge was reused instead of obtaining a fresh challenge" }
        check(next["account_id"]==oldAccount && next["device_id"]==original.device) { "Fresh login challenge changed the original account/device" }
        val result=restarted.faceCapture(fresh)
        check(result.first==1) { "Fresh original-device login returned ${result.first} captures; expected one" }
        check(result.second!=null) { "Fresh original-device login did not return verified credentials" }
        check(!restarted.cameraLoginHeld) { "Validated fresh original-device login did not release the encrypted one-use hold" }
        check(restarted.identity==original) { "Fresh original-device login changed the saved handle/device/key alias" }
        check(restarted.credentials?.account==oldAccount && restarted.credentials?.method=="registered_face") { "Fresh login did not authenticate the original account with registered-face credentials" }
        check(relay.anonymousCalls.get()==previousAnon) { "Expiry recovery silently created a replacement anonymous account" }
        pass("A04 explicit fresh sign-in after real challenge expiry verifies the same face/account/device key",mapOf("account_id" to oldAccount,"real_expiry_wait" to true,
            "new_challenge" to true,"new_account_created" to false,"no_otp" to true))
        repository=restarted;return restarted
    }
    suspend fun stagedLogout(selfies: List<String>,fresh: String,input: (String)->ByteArray) {
        val directory=java.io.File(context.noBackupFilesDir,"staged-logout-control")
        val isolated=object: android.content.ContextWrapper(context) {
            override fun getNoBackupFilesDir()=java.io.File(directory,"no-backup").apply { check(isDirectory || mkdirs()) }
            override fun getCacheDir()=java.io.File(directory,"cache").apply { check(isDirectory || mkdirs()) }
        }
        val checkpointRelay=EnrollmentReplyLossRelay(origin,0)
        var stagedRepo=CloudflareRepository(isolated,checkpointRelay.url);var success=false
        try {
            stagedRepo.bootstrap();admitFreshSyntheticAdult(stagedRepo);stagedRepo.faceChallenge()
            selfies.forEach { path->val data=input(path);try { stagedRepo.faceCapture(data) } finally { data.fill(0) } }
            val original=stagedRepo.identity ?: error("Original test device missing")
            val previous=stagedRepo.credentials ?: error("Original registered test credentials missing")
            val vault=SecureSession(isolated,checkpointRelay.url);val key=vault.existingDevice(original.alias)
            stagedRepo.faceChallenge();checkpointRelay.arm("/me")
            val data=input(fresh)
            try { stagedRepo.faceCapture(data);error("Expected actual validation response to be dropped") }
            catch(problem: LiveFailure) { check(problem.code=="connection_unavailable" && !problem.ambiguous) }
            finally { data.fill(0) }
            checkpointRelay.assertHealthy();check(checkpointRelay.lastLostStatus.get() in 200..299);checkpointRelay.release()
            val staged=CameraLoginJournal.restore(stagedRepo.saved("camera_login"),checkpointRelay.url)
            check(staged.state=="credentials_pending");val actual=staged.credentials ?: error("Actual staged JWT missing")
            val stagedToken=NativeProtocol.text(actual["access_token"],8192)
            check(stagedToken!=previous.token);staged.assertCredentialBinding(actual)
            // This exact durable state existed between staging the real reply and install(); no response is fabricated.
            val snapshot=vault.load();vault.save(snapshot+mapOf("credentials" to previous.wire))
            val restored=CloudflareRepository(isolated,checkpointRelay.url);check(restored.bootstrap().isEmpty())
            check(restored.identity==original && restored.credentials?.token==previous.token)
            val stagedBefore=CameraLoginJournal.restore(restored.saved("camera_login"),checkpointRelay.url)
            check(stagedBefore==staged && checkpointRelay.anonymousCalls.get()==1)
            fun authorization(token: String,expected: Int) {
                val fence=SessionFence();val scope=fence.switch(original.account)
                try {
                    val response=CloudflareTransport(checkpointRelay.url,fence).request("/me",scope,token)
                    response.fill(0);check(expected==200) { "A real staged or published token remained active after logout" }
                } catch(problem: LiveFailure) { check(problem.status==expected) { "Unexpected token denial ${problem.code}: ${problem.status}" } }
            }
            authorization(previous.token,200);authorization(stagedToken,200)
            pass("A04 real staged login checkpoint restores old published credentials and the new bound completion JWT",mapOf("storage_checkpoint" to "exact pre-install vault state",
                "separate_repository_rehydration" to true,"both_tokens_verified_active" to true,"fake_backend_success" to false))
            stagedRepo=restored;restored.logout(false)
            authorization(stagedToken,401);authorization(previous.token,401)
            val held=CameraLoginJournal.restore(restored.saved("camera_login"),checkpointRelay.url)
            check(held.state=="completion_pending" && held.credentials==null && held.capture==staged.capture && held.completion==staged.completion)
            check(restored.identity==original && restored.credentials==null && NativeProtocol.canonical(vault.existingDevice(original.alias))==NativeProtocol.canonical(key))
            val rehydrated=CloudflareRepository(isolated,checkpointRelay.url);check(rehydrated.bootstrap().isEmpty())
            check(rehydrated.identity==original && checkpointRelay.anonymousCalls.get()==1)
            try { rehydrated.get("/me/gallery");error("Explicit logout exposed held private media") }
            catch(problem: LiveFailure) { check(problem.code=="face_login_requires_status") }
            val before=checkpointRelay.proofCalls.get()
            try { rehydrated.faceChallenge();error("Explicit logout automatically restored staged sign-in") }
            catch(problem: LiveFailure) { check(problem.code=="face_login_in_flight") }
            check(checkpointRelay.proofCalls.get()==before)
            pass("A04 explicit logout revokes the real staged token first and the distinct published token while retaining the original noncredential hold",mapOf("staged_token_denied" to true,
                "published_token_denied" to true,"original_account_device_key_retained" to true,"private_media_denied" to true,"new_account_created" to false))
            success=true
        } finally {
            if(success)stagedRepo.logout(true)
            checkpointRelay.close()
        }
    }
}
