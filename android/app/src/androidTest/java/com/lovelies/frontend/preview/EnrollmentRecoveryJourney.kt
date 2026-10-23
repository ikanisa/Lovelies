package com.lovelies.frontend.preview

import android.content.Context
import android.content.ContextWrapper
import android.util.AtomicFile
import kotlinx.coroutines.delay
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.File
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** A real HTTP consumer; the relay drops a reply only after the actual Cloudflare mutation succeeded. */
internal class EnrollmentRecoveryJourney(private val context: Context,private val origin: String,port: Int,
    private val selfies: List<String>,private val fresh: String,private val input: (String)->ByteArray,
    private val pass: (String,WireObject)->Unit) : AutoCloseable {
    private val relay=EnrollmentReplyLossRelay(origin,port)
    val endpoint get()=relay.url
    private val checkpoint=AtomicFile(File(context.noBackupFilesDir,"recovery-checkpoint.json"))
    private var marker: WireObject=if(checkpoint.baseFile.exists())jsonMap(JSONObject(checkpoint.readFully().toString(Charsets.UTF_8))) else emptyMap()
    var repository: CloudflareRepository?=null;private set
    val account get()=NativeProtocol.id(marker["account"])
    val phase get()=marker["phase"] as? String
    private fun durableMarker(j: EnrollmentJournal,phase: String) {
        val next=mapOf("account" to j.account,"alias" to j.alias,"enrollment_key" to j.key,"digest" to j.digest,
            "origin" to endpoint,"api_origin" to origin,"phase" to phase)
        val bytes=NativeProtocol.canonical(next).toByteArray()
        val stream=checkpoint.startWrite()
        try { stream.write(bytes);checkpoint.finishWrite(stream);marker=next }
        catch(problem: Throwable) { checkpoint.failWrite(stream);throw problem } finally { bytes.fill(0) }
    }
    private fun same(j: EnrollmentJournal) {
        check(j.account==marker["account"] && j.alias==marker["alias"] && j.key==marker["enrollment_key"] && j.digest==marker["digest"])
        check(endpoint==marker["origin"] && origin==marker["api_origin"])
        j.assertKey(SecureSession(context,endpoint).existingDevice(j.alias))
    }
    private suspend fun lost(block: suspend ()->Unit) {
        try { block();error("Expected a real reply loss") }
        catch(problem: LiveFailure) { check(problem.code=="connection_unavailable" && problem.ambiguous) { "Unexpected reply loss ${problem.code}" } }
        relay.assertHealthy();check(relay.lastLostStatus.get() in 200..299)
    }
    private suspend fun recover(): CloudflareRepository {
        val count=relay.anonymousCalls.get()
        val repo=CloudflareRepository(context,endpoint)
        check(repo.bootstrap().isEmpty());val j=repo.enrollment ?: error("Durable enrollment missing")
        same(j);check(repo.credentials?.account==j.account)
        check(relay.anonymousCalls.get()==count) { "Recovery silently created a replacement account" }
        repository=repo
        pass("Encrypted journal restores original account and Keystore key before anonymous bootstrap",mapOf("phase" to phase,"account_id" to j.account,"key_digest" to j.digest))
        return repo
    }
    private suspend fun ready(repo: CloudflareRepository): WireObject {
        repeat(30) {
            try { return repo.faceChallenge() }
            catch(problem: LiveFailure) { if(problem.code!="enrollment_in_flight")throw problem;delay(500) }
        }
        error("Actual enrollment writer did not settle")
    }
    private suspend fun capture(repo: CloudflareRepository,index: Int): Pair<Int,WireObject?> {
        val bytes=input(selfies[index]);return try { repo.faceCapture(bytes) } finally { bytes.fill(0) }
    }
    /** start/capture/completion return with the exact isolated encrypted vault and key intentionally retained. */
    suspend fun run(until: String="finish"): CloudflareRepository? {
        check(until in setOf("start","capture","completion","finish"));check(selfies.size==3)
        if(marker.isNotEmpty() && phase==until) {
            recover();pass("Requested process checkpoint was already durable; no mutation repeated",mapOf("phase" to until));return null
        }
        if(marker.isEmpty()) {
            val repo=CloudflareRepository(context,endpoint);val me=repo.bootstrap()
            val actor=repo.credentials ?: error("Anonymous credentials missing")
            check(actor.method=="anonymous" && me["authenticated"]==false)
            try { repo.get("/me/gallery");error("Anonymous gallery granted") } catch(problem: LiveFailure) { check(problem.code=="registered_face_required") }
            relay.beforeStart={
                val j=EnrollmentJournal.restore(SecureSession(context,endpoint).load()["enrollment"],endpoint)
                check(j.account==actor.account && j.state=="start");j.assertKey(SecureSession(context,endpoint).existingDevice(j.alias))
            }
            relay.arm("/auth/face/registration/challenge")
            lost { repo.faceChallenge() }
            val j=repo.enrollment ?: error("Lost start discarded the journal")
            check(j.account==actor.account && j.state=="start" && j.generation==0L)
            durableMarker(j,"start");relay.release();relay.beforeStart=null;repository=repo
            pass("Lost start reply retains a previously durable same-account enrollment/key intent",mapOf("account_id" to j.account,"actual_mutations" to 1))
            if(until=="start")return null
        } else check(phase in setOf("start","capture","completion")) { "Refusing to reuse a completed test run" }
        if(phase=="start") {
            val repo=recover();val challenge=ready(repo);val j=repo.enrollment!!;same(j)
            check(challenge["purpose"]=="registration" && repo.faceCaptureCount==0 && j.generation>=1L)
            relay.arm("/auth/face/proof/${challenge["challenge_id"]}/0")
            lost { capture(repo,0) }
            val saved=repo.enrollment!!;same(saved)
            check(saved.state=="capture_pending" && saved.planned.size==1 && saved.accepted.isEmpty())
            durableMarker(saved,"capture");relay.release()
            pass("Lost capture reply preserves exact planned hash; actual proof was accepted by Cloudflare",mapOf("capture_index" to 0))
            if(until=="capture")return null
        }
        if(phase=="capture") {
            val repo=recover();ready(repo);same(repo.enrollment!!)
            check(repo.faceCaptureCount==1 && repo.enrollment!!.accepted.size==1)
            pass("Signed status recovers the accepted first proof without duplicate upload",mapOf("accepted_captures" to 1))
            val prefix="lovelies-session-v2-${NativeProtocol.sha256(endpoint.toByteArray()).take(16)}.bin.new"
            val blocked=File(context.noBackupFilesDir,prefix);check(blocked.mkdir());File(blocked,"controlled-failure").writeText("test-only")
            val before=relay.proofCalls.get()
            try {
                try { capture(repo,1);error("Controlled storage failure was ignored") }
                catch(problem: LiveFailure) { check(problem.code=="enrollment_storage_unavailable") }
                check(relay.proofCalls.get()==before && repo.enrollment!!.accepted.size==1)
                val restored=EnrollmentJournal.restore(SecureSession(context,endpoint).load()["enrollment"],endpoint)
                check(restored.accepted.size==1 && restored.planned.size==1);same(restored)
            } finally { check(blocked.deleteRecursively()) }
            pass("Actual Android AtomicFile write failure preserves prior journal and prevents proof dispatch",emptyMap())
            check(capture(repo,1).first==2)
            relay.arm("/auth/face/registration/complete")
            lost { capture(repo,2) }
            val saved=repo.enrollment!!;same(saved)
            check(saved.state=="completion_pending" && saved.accepted.size==3 && saved.completion!=null && saved.credentialResult==null)
            durableMarker(saved,"completion");relay.release()
            pass("Lost completion reply keeps original account/key and durable three-proof completion",emptyMap())
            if(until=="completion")return null
        }
        check(phase=="completion")
        val repo=recover();val old=repo.credentials!!.token
        val login=ready(repo);same(repo.enrollment!!)
        check(login["purpose"]=="login" && login["account_id"]==account && login["device_id"]==repo.enrollment!!.device && NativeProtocol.integer(login["required_captures"])==1L) {
            "Registered A01 status did not produce a fresh one-capture challenge for the original account/device"
        }
        check(repo.enrollment!!.state=="registered" && repo.credentials!!.method=="anonymous") {
            "Read-only A01 status published credentials or changed the original anonymous setup"
        }
        val held=CameraLoginJournal.restore(repo.saved("camera_login"),endpoint)
        held.assertOwner(endpoint,repo.enrollment!!.account,repo.enrollment!!.alias,repo.enrollment!!.device!!)
        check(repo.cameraLoginHeld && held.state=="ready" && held.capture==null && held.completion==null && held.credentials==null &&
            NativeProtocol.canonical(held.challenge)==NativeProtocol.canonical(login)) { "A01 fresh-login hold lost its original binding or already carried credential authority" }
        try { repo.get("/me/gallery");error("Read-only recovery authenticated the guest") }
        catch(problem: LiveFailure) { check(problem.code=="face_login_requires_status") { "A01 ready login hold returned ${problem.code}; expected exact face_login_requires_status denial" } }
        pass("Registered status grants no session; original-key one-fresh-selfie login is required",emptyMap())
        val bytes=input(fresh)
        try { check(repo.faceCapture(bytes).second!=null) { "A01 fresh registered-reference capture did not return validated credentials" } } finally { bytes.fill(0) }
        check(repo.enrollment==null && !repo.cameraLoginHeld && repo.identity!!.alias==marker["alias"] && repo.credentials!!.account==account) {
            "A01 fresh login did not clear recovery holds while preserving the original account/device key"
        }
        val me=repo.get("/me");check(me["user_id"]==account && me["authenticated"]==true && me["auth_method"]=="registered_face")
        val localFence=SessionFence();val scope=localFence.switch(account)
        try { CloudflareTransport(endpoint,localFence).request("/me",scope,old);error("Pre-enrollment token survived completion") }
        catch(problem: LiveFailure) { check(problem.status==401) }
        check(SecureSession(context,endpoint).load()["enrollment"]==null)
        pass("Fresh registered-face login durably promotes same account/key after lost completion",mapOf("account_id" to account,"required_fresh_captures" to 1))
        repository=repo;relay.assertHealthy();return repo
    }
    private class NegativeContext(base: Context,private val directory: File): ContextWrapper(base) {
        override fun getNoBackupFilesDir()=File(directory,"no-backup").apply { check(isDirectory || mkdirs()) }
        override fun getCacheDir()=File(directory,"cache").apply { check(isDirectory || mkdirs()) }
    }
    suspend fun verifySafetyFailures() {
        val keyContext=NegativeContext(context,File(context.noBackupFilesDir,"missing-key-case"))
        val keyVault=SecureSession(keyContext,endpoint)
        val keyRepo=CloudflareRepository(keyContext,endpoint);keyRepo.bootstrap();keyRepo.faceChallenge()
        val intent=keyRepo.enrollment ?: error("Missing-key setup intent absent")
        val calls=relay.anonymousCalls.get()
        keyVault.deleteDevice(intent.alias)
        try {
            val restored=CloudflareRepository(keyContext,endpoint);check(restored.bootstrap().isEmpty())
            try { restored.faceChallenge();error("Missing original key was replaced") }
            catch(problem: LiveFailure) { check(problem.code=="device_key_unavailable") }
            check(relay.anonymousCalls.get()==calls && restored.enrollment!!.key==intent.key && restored.enrollment!!.alias==intent.alias)
            pass("Missing Android Keystore key blocks recovery without a replacement account or key",emptyMap())
        } finally { keyVault.clear() }
        val revokedContext=NegativeContext(context,File(context.noBackupFilesDir,"revoked-device-case"))
        val revokedVault=SecureSession(revokedContext,endpoint)
        val revoked=CloudflareRepository(revokedContext,endpoint);revoked.bootstrap();revoked.faceChallenge()
        val original=revoked.enrollment ?: error("Revocation setup intent absent")
        capture(revoked,0);capture(revoked,1)
        val durable=revokedVault.load() // Encrypted-vault input held only in test memory, not a public seed route.
        try {
            check(capture(revoked,2).second!=null)
            val decision=revoked.post("/auth/device/revoke",mapOf("device_id" to revoked.identity!!.device))
            check(decision["status"]=="revoked" && decision["current_session_revoked"]==true)
            revokedVault.save(durable)
            val count=relay.anonymousCalls.get();val restored=CloudflareRepository(revokedContext,endpoint)
            check(restored.bootstrap().isEmpty())
            try { restored.faceChallenge();error("Revoked device recovered credentials") }
            catch(problem: LiveFailure) { check(problem.code=="enrollment_recovery_unavailable" && problem.status==404) }
            check(relay.anonymousCalls.get()==count && restored.enrollment!!.account==original.account && restored.credentials?.method=="anonymous")
            pass("Actual own-device revocation fences signed enrollment recovery and never recreates the guest",emptyMap())
        } finally { revokedVault.deleteDevice(original.alias);revokedVault.clear() }
        relay.assertHealthy()
    }
    override fun close() { relay.close() }
}

/** No fabricated status or success; only bounded private local response-loss injection. */
internal class EnrollmentReplyLossRelay(private val origin: String,port: Int): AutoCloseable {
    private val listener=ServerSocket().apply { reuseAddress=true;bind(InetSocketAddress("127.0.0.1",port),8) }
    val url="http://127.0.0.1:${listener.localPort}"
    val anonymousCalls=AtomicInteger();val proofCalls=AtomicInteger();val lastLostStatus=AtomicInteger()
    @Volatile var beforeStart: (()->Unit)?=null
    @Volatile var beforeDispatch: ((String)->Unit)?=null
    private val dropPath=AtomicReference<String?>(null);private val forwarded=AtomicBoolean()
    private val closed=AtomicBoolean();private val failures=AtomicReference<Throwable>()
    private val active=ConcurrentHashMap.newKeySet<Socket>();private val calls=AtomicInteger()
    private val executor=Executors.newFixedThreadPool(4)
    fun arm(path: String) { forwarded.set(false);lastLostStatus.set(0);dropPath.set(path) }
    fun release() { dropPath.set(null) }
    private val thread=Thread({
        while(!closed.get()) {
            val socket=try { listener.accept() } catch(problem: Exception) { if(!closed.get())failures.compareAndSet(null,problem);break }
            active.add(socket);executor.execute {
                try { socket.use { handle(it) } } catch(problem: Throwable) { if(!closed.get())failures.compareAndSet(null,problem) }
                finally { active.remove(socket) }
            }
        }
    },"EnrollmentReplyLossRelay").apply { isDaemon=true;start() }
    private fun line(input: BufferedInputStream): String {
        val data=ByteArrayOutputStream()
        while(data.size()<8192) {
            val byte=input.read();if(byte<0)throw EOFException("Incomplete HTTP request")
            if(byte==10) { val b=data.toByteArray();check(b.isNotEmpty() && b.last()==13.toByte());return String(b,0,b.size-1,Charsets.US_ASCII) }
            data.write(byte)
        }
        error("Oversize request line")
    }
    private fun handle(socket: Socket) {
        check(calls.incrementAndGet()<=600);socket.soTimeout=60000
        val input=BufferedInputStream(socket.getInputStream());val request=line(input).split(' ');check(request.size==3)
        val method=request[0];val path=request[1];check(path.startsWith('/') && !path.startsWith("//") && !path.contains(".."))
        val headers=mutableMapOf<String,String>();var count=0
        while(true) {
            val text=line(input);count+=text.length;check(count<=32768);if(text.isEmpty())break
            val colon=text.indexOf(':');check(colon>0);headers[text.substring(0,colon).lowercase()]=text.substring(colon+1).trim()
        }
        check("transfer-encoding" !in headers)
        val length=headers["content-length"]?.toInt() ?: 0;check(length in 0..20*1024*1024)
        val body=ByteArray(length);var position=0
        while(position<length) { val read=input.read(body,position,length-position);if(read<0)throw EOFException("Incomplete body");position+=read }
        val drop=path==dropPath.get()
        if(drop && !forwarded.compareAndSet(false,true)) { body.fill(0);return }
        if(path=="/auth/anonymous")anonymousCalls.incrementAndGet()
        if(path.startsWith("/auth/face/proof/"))proofCalls.incrementAndGet()
        if(path=="/auth/face/registration/challenge")beforeStart?.invoke()
        beforeDispatch?.invoke(path)
        val connection=URL(origin+path).openConnection() as HttpURLConnection
        try {
            connection.requestMethod=method;connection.instanceFollowRedirects=false;connection.connectTimeout=10000;connection.readTimeout=45000
            headers.filterKeys { it in setOf("authorization","content-type","accept") || it.startsWith("x-lovelies-") }
                .forEach { (key,value) -> connection.setRequestProperty(key,value) }
            if(length>0) { connection.doOutput=true;connection.setFixedLengthStreamingMode(length);connection.outputStream.use { it.write(body) } }
            val status=connection.responseCode;val stream=if(status in 200..299)connection.inputStream else connection.errorStream
            val response=stream?.use { source ->
                val data=ByteArrayOutputStream();val buffer=ByteArray(8192)
                try { while(true) { val n=source.read(buffer);if(n<0)break;check(data.size()+n<=4*1024*1024);data.write(buffer,0,n) };data.toByteArray() }
                finally { buffer.fill(0);data.reset() }
            } ?: ByteArray(0)
            try {
                if(drop) { lastLostStatus.set(status);check(status in 200..299) { "Actual mutation failed: HTTP$status" };return }
                val type=connection.contentType ?: "application/json"
                val envelope="HTTP/1.1 $status Response\r\nContent-Type: $type\r\nContent-Length: ${response.size}\r\nConnection: close\r\n\r\n"
                socket.getOutputStream().apply { write(envelope.toByteArray(Charsets.US_ASCII));write(response);flush() }
            } finally { response.fill(0) }
        } finally { body.fill(0);connection.disconnect() }
    }
    fun assertHealthy() { failures.get()?.let { throw AssertionError("Actual enrollment relay failed",it) } }
    override fun close() {
        closed.set(true);listener.close();active.forEach { runCatching { it.close() } };executor.shutdownNow();thread.join(2000)
        executor.awaitTermination(2,TimeUnit.SECONDS)
    }
}
