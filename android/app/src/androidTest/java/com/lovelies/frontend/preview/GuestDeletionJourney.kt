package com.lovelies.frontend.preview

import android.app.Activity
import android.app.Instrumentation
import android.content.Context
import android.content.ContextWrapper
import android.os.Bundle
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.File
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.net.URL
import java.util.Collections
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Real production repository, Android Keystore and local Cloudflare. No fabricated success or privileged client role. */
internal class GuestDeletionJourney(private val instrumentation: Instrumentation,private val arguments: Bundle) {
    private val checks=mutableListOf<WireObject>()
    private val scopes=mutableListOf<WireObject>()
    private class IsolatedContext(base: Context,private val directory: File): ContextWrapper(base) {
        override fun getNoBackupFilesDir()=File(directory,"no-backup").apply { check(isDirectory || mkdirs()) }
        override fun getCacheDir()=File(directory,"cache").apply { check(isDirectory || mkdirs()) }
    }
    private fun pass(name: String) {
        checks.add(mapOf("name" to name,"status" to "passed"))
        instrumentation.sendStatus(1,Bundle().apply { putString("stream","PASS $name\n") })
    }
    private suspend fun denied(codes: Set<String>,block: suspend ()->Unit) {
        try { block();error("Expected protected or lifecycle denial") }
        catch(problem: LiveFailure) { check(problem.code in codes) { "Unexpected denial ${problem.code}" } }
    }
    fun run() {
        var success=false
        var failure: String?=null
        var origin: String?=null
        val directory=File(instrumentation.targetContext.noBackupFilesDir,"guest-deletion-journey/${UUID.randomUUID()}")
        try {
            check(BuildConfig.DEBUG) { "Local failure injection requires a debug test APK" }
            val apiOrigin=NativeProtocol.baseUrl(arguments.getString("lovelies_api") ?: "http://10.0.2.2:18887",true)
            origin=apiOrigin
            val uri=URI(apiOrigin)
            check(uri.scheme=="http" && uri.host in setOf("10.0.2.2","127.0.0.1","localhost"))
            check(directory.mkdirs())
            runBlocking { withTimeout(270000) {
                for(mode in listOf("before","after")) {
                    val context=IsolatedContext(instrumentation.targetContext,File(directory,mode))
                    FailureRelay(apiOrigin).use { relay ->
                        relay.failureMode.set(mode)
                        val repository=CloudflareRepository(context,relay.url)
                        val me=repository.bootstrap();val original=repository.credentials ?: error("Anonymous credentials absent")
                        check(original.method=="anonymous" && me["authenticated"]==false && me["user_id"]==original.account)
                        denied(setOf("registered_face_required")) { repository.get("/me/gallery") }
                        denied(setOf("registered_face_required")) { repository.mutate("privacy.request.export",emptyMap(),"privacy",path="/privacy/export") }
                        pass("$mode: actual anonymous bootstrap preserves protected gallery/export guards")
                        repository.remember("private_test_reference","must retire")
                        relay.beforeDeletion={ body ->
                            val vault=SecureSession(context,relay.url).load()
                            val record=GuestDeletionRecord.restore(vault["guest_deletion"],relay.url,original.account,"anonymous")
                            check(NativeProtocol.canonical(record.requestBody())==body)
                        }
                        denied(setOf("connection_unavailable")) { repository.requestGuestDeletion() }
                        val saved=repository.guestDeletion ?: error("Lost-response intent absent")
                        check(saved.receipt==null && repository.credentials==null)
                        check(relay.deleteBodies.isNotEmpty() && relay.deleteBodies.all { it==NativeProtocol.canonical(saved.requestBody()) })
                        pass("$mode: secure original account/key/token are persisted before a real dropped transport reply")
                        val anonymousCalls=relay.anonymousCalls.get()
                        val restored=CloudflareRepository(context,relay.url)
                        check(restored.bootstrap().isEmpty() && restored.credentials==null)
                        check(relay.anonymousCalls.get()==anonymousCalls)
                        saved.assertSameIntent(restored.guestDeletion)
                        pass("$mode: encrypted-vault restart holds the original guest before automatic bootstrap")
                        relay.failureMode.set("none")
                        val acknowledged=restored.checkGuestDeletion()
                        val receipt=acknowledged.receipt ?: error("Actual server receipt absent")
                        check(receipt.status=="pending_approval" && !receipt.completed && !receipt.requestExpired)
                        check(acknowledged.operationKey==saved.operationKey && acknowledged.statusToken==saved.statusToken)
                        check(relay.forwardedCreates.get()==1)
                        check(relay.deleteBodies.all { it==NativeProtocol.canonical(saved.requestBody()) })
                        pass(if(mode=="before")"before: real status404 retries the exact original body once" else "after: real status reconciles a request created before its reply was dropped")
                        val vault=SecureSession(context,relay.url).load()
                        val frozen=NativeProtocol.obj(vault["credentials"])
                        check(frozen["account_id"]==original.account && frozen["auth_method"]=="anonymous")
                        check(vault["private_test_reference"]==null && restored.credentials==null && !relay.statusHadBearer.get())
                        denied(setOf("authentication_required")) { restored.get("/me/gallery") }
                        val fence=SessionFence();val scope=fence.switch(original.account)
                        try { CloudflareTransport(relay.url,fence).request("/me/gallery",scope,original.token);error("Anonymous backend gallery access granted") }
                        catch(problem: LiveFailure) { check(problem.status==403) }
                        try { CloudflareTransport(relay.url,fence).request("/me/gallery",scope,saved.statusToken);error("Receipt was treated as an authentication credential") }
                        catch(problem: LiveFailure) { check(problem.status==401) }
                        pass("$mode: uncredentialed status retires private refs, freezes original credentials and grants no protected access")
                        val again=CloudflareRepository(context,relay.url)
                        check(again.bootstrap().isEmpty())
                        val polled=again.checkGuestDeletion().receipt ?: error("Receipt not restored")
                        check(polled.requestId==receipt.requestId && polled.operationKey==receipt.operationKey && polled.expiresAt==receipt.expiresAt)
                        denied(setOf("deletion_cannot_resume")) { again.resumeGuestSetup() }
                        denied(setOf("deletion_not_completed")) { again.restartAfterGuestDeletion() }
                        check(relay.anonymousCalls.get()==anonymousCalls && !relay.statusHadBearer.get())
                        pass("$mode: pending review blocks both resume and replacement guest; status polling never renews receipt")
                        relay.assertHealthy()
                        scopes.add(mapOf("scenario" to mode,"account_id" to original.account,"request_id" to receipt.requestId,
                            "operation_key" to saved.operationKey,"request_status" to receipt.status,"actual_creations" to relay.forwardedCreates.get()))
                    }
                }
            } }
            success=true
        } catch(problem: Throwable) {
            failure=if(problem is LiveFailure)"${problem.code} (${problem.status})" else "${problem.javaClass.simpleName}: ${problem.message}"
        } finally { directory.deleteRecursively() }
        val report=mapOf("scenario" to "guest-deletion","status" to if(success)"passed" else "failed","checks" to checks,"passed" to checks.size,
            "failure" to failure,"api_origin" to origin,"scopes" to scopes,"hosted" to false,"camera_sensor_evidence" to false,
            "runtime" to "Production Android CloudflareRepository / Android Keystore / actual local workerd SQLite",
            "failure_injection" to "Local loopback relay closes deletion connections before dispatch or after a real successful backend response; every delivered response is from Cloudflare",
            "fixture_accounts_retained_for_independent_privacy_review" to true,"fake_backend_success" to false)
        instrumentation.finish(if(success)Activity.RESULT_OK else Activity.RESULT_CANCELED,Bundle().apply {
            putString("native_cloudflare_journey",NativeProtocol.canonical(report))
            putString("stream","\nGuest deletion ${if(success)"PASSED" else "FAILED"}: ${checks.size} checks${failure?.let { "; $it" } ?: ""}\n")
        })
    }

    /** Test-only bounded HTTP relay. It never synthesizes a successful backend response. */
    private class FailureRelay(private val origin: String): AutoCloseable {
        private val listener=ServerSocket().apply { bind(InetSocketAddress("127.0.0.1",0),8) }
        val url="http://127.0.0.1:${listener.localPort}"
        val failureMode=AtomicReference("none")
        val anonymousCalls=AtomicInteger(0)
        val forwardedCreates=AtomicInteger(0)
        val statusHadBearer=AtomicBoolean(false)
        val deleteBodies=Collections.synchronizedList(mutableListOf<String>())
        @Volatile var beforeDeletion: ((String)->Unit)?=null
        private val afterDispatched=AtomicBoolean(false)
        private val closed=AtomicBoolean(false)
        private val failures=AtomicReference<Throwable>()
        private val calls=AtomicInteger(0)
        private val active=ConcurrentHashMap.newKeySet<Socket>()
        private val executor=Executors.newFixedThreadPool(3)
        private val thread=Thread({
            while(!closed.get()) {
                val socket=try { listener.accept() } catch(problem: Exception) { if(!closed.get())failures.compareAndSet(null,problem);break }
                active.add(socket)
                executor.execute {
                    try { socket.use { handle(it) } }
                    catch(problem: Throwable) { if(!closed.get())failures.compareAndSet(null,problem) }
                    finally { active.remove(socket) }
                }
            }
        },"GuestDeletionFailureRelay").apply { isDaemon=true;start() }
        private fun line(input: BufferedInputStream): String {
            val data=ByteArrayOutputStream()
            while(data.size()<8192) {
                val byte=input.read();if(byte<0)throw EOFException("Incomplete request")
                if(byte==10) {
                    val bytes=data.toByteArray();check(bytes.isNotEmpty() && bytes.last()==13.toByte())
                    return String(bytes,0,bytes.size-1,Charsets.US_ASCII)
                }
                data.write(byte)
            }
            error("Request line too large")
        }
        private fun handle(socket: Socket) {
            check(calls.incrementAndGet()<=64);socket.soTimeout=60000
            val input=BufferedInputStream(socket.getInputStream())
            val request=line(input).split(' ');check(request.size==3)
            val path=request[1];check(path.startsWith('/') && !path.startsWith("//") && !path.contains(".."))
            val headers=mutableMapOf<String,String>();var headerBytes=0
            while(true) {
                val value=line(input);headerBytes+=value.length;check(headerBytes<=32768)
                if(value.isEmpty())break
                val colon=value.indexOf(':');check(colon>0)
                headers[value.substring(0,colon).lowercase()]=value.substring(colon+1).trim()
            }
            check("transfer-encoding" !in headers)
            val length=headers["content-length"]?.toInt() ?: 0;check(length in 0..65536)
            val body=ByteArray(length);var position=0
            while(position<length) { val read=input.read(body,position,length-position);if(read<0)throw EOFException("Incomplete body");position+=read }
            val deletion=path=="/privacy/account-deletion" && request[0]=="POST"
            if(path=="/auth/anonymous")anonymousCalls.incrementAndGet()
            if(path=="/privacy/account-deletion/status" && headers.containsKey("authorization"))statusHadBearer.set(true)
            if(deletion) {
                val original=body.toString(Charsets.UTF_8);deleteBodies.add(original);beforeDeletion?.invoke(original)
                if(failureMode.get()=="before" || failureMode.get()=="after" && !afterDispatched.compareAndSet(false,true)) { body.fill(0);return }
                forwardedCreates.incrementAndGet()
            }
            val connection=URL(origin+path).openConnection() as HttpURLConnection
            try {
                connection.requestMethod=request[0];connection.instanceFollowRedirects=false;connection.connectTimeout=10000;connection.readTimeout=45000
                for(header in listOf("authorization","content-type","accept"))headers[header]?.let { connection.setRequestProperty(header,it) }
                if(length>0) { connection.doOutput=true;connection.setFixedLengthStreamingMode(length);connection.outputStream.use { it.write(body) } }
                val status=connection.responseCode
                val stream=if(status in 200..299)connection.inputStream else connection.errorStream
                val response=stream?.use { source ->
                    val data=ByteArrayOutputStream();val buffer=ByteArray(8192)
                    try { while(true) { val count=source.read(buffer);if(count<0)break;check(data.size()+count<=2097152);data.write(buffer,0,count) };data.toByteArray() }
                    finally { buffer.fill(0);data.reset() }
                } ?: ByteArray(0)
                try {
                    if(deletion && failureMode.get()=="after") { check(status in 200..299);return }
                    val type=connection.contentType ?: "application/json"
                    val envelope="HTTP/1.1 $status Response\r\nContent-Type: $type\r\nContent-Length: ${response.size}\r\nConnection: close\r\n\r\n"
                    socket.getOutputStream().apply { write(envelope.toByteArray(Charsets.US_ASCII));write(response);flush() }
                } finally { response.fill(0) }
            } finally { body.fill(0);connection.disconnect() }
        }
        fun assertHealthy() { failures.get()?.let { throw AssertionError("Relay failed",it) } }
        override fun close() {
            closed.set(true);listener.close();active.forEach { runCatching { it.close() } };executor.shutdownNow();thread.join(2000)
            executor.awaitTermination(2,TimeUnit.SECONDS);deleteBodies.clear()
        }
    }
}
