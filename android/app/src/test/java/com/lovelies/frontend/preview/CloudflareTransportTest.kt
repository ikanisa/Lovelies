package com.lovelies.frontend.preview

import org.junit.Assert.*
import org.junit.Test
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Real bounded loopback HTTP tests, without an Android account, public fixture route or external service. */
class CloudflareTransportTest {
    private data class Request(val method: String,val path: String,val headers: Map<String,String>,val body: ByteArray)
    private data class Reply(val status: Int,val body: ByteArray=ByteArray(0),val headers: Map<String,String> = mapOf("Content-Type" to "application/json"))

    /** java.net works on Android's unit boot classpath; the JDK-only HttpServer module does not. */
    private class LoopbackServer : AutoCloseable {
        private val socket=ServerSocket().apply { bind(InetSocketAddress("127.0.0.1",0),8) }
        val url="http://127.0.0.1:${socket.localPort}"
        private val closed=AtomicBoolean(false)
        private val requests=AtomicInteger(0)
        private val failure=AtomicReference<Throwable>()
        private val routes=ConcurrentHashMap<String,(Request)->Reply>()
        private val active=ConcurrentHashMap.newKeySet<Socket>()
        private val executor=Executors.newFixedThreadPool(4)
        private val listener=Thread({
            while(!closed.get()) {
                val client=try { socket.accept() } catch(problem: Exception) {
                    if(!closed.get())failure.compareAndSet(null,problem)
                    break
                }
                if(requests.incrementAndGet()>16) { client.close();failure.compareAndSet(null,AssertionError("Fixture request bound exceeded"));continue }
                active.add(client)
                executor.execute {
                    try { client.use { handle(it) } }
                    catch(problem: Exception) { if(!closed.get())failure.compareAndSet(null,problem) }
                    finally { active.remove(client) }
                }
            }
        },"LoveliesLoopbackTest").apply { isDaemon=true;start() }

        fun route(path: String,handler: (Request)->Reply) { routes[path]=handler }
        val requestCount get()=requests.get()
        private fun line(input: BufferedInputStream): String {
            val bytes=ByteArrayOutputStream()
            while(bytes.size()<8192) {
                val next=input.read();if(next<0)throw EOFException("Incomplete HTTP fixture request")
                if(next==10) {
                    val value=bytes.toByteArray()
                    if(value.isEmpty() || value.last()!=13.toByte())throw IllegalArgumentException("Expected CRLF")
                    return String(value,0,value.size-1,Charsets.US_ASCII)
                }
                bytes.write(next)
            }
            throw IllegalArgumentException("HTTP fixture line bound exceeded")
        }
        private fun handle(client: Socket) {
            client.soTimeout=5000
            val input=BufferedInputStream(client.getInputStream())
            val requestLine=line(input).split(' ')
            require(requestLine.size==3 && requestLine[2] in listOf("HTTP/1.0","HTTP/1.1"))
            val headers=mutableMapOf<String,String>()
            var total=0
            while(true) {
                val value=line(input);total+=value.length;require(total<=32768)
                if(value.isEmpty())break
                val separator=value.indexOf(':');require(separator>0)
                val key=value.substring(0,separator).lowercase();require(key !in headers)
                headers[key]=value.substring(separator+1).trim()
            }
            require("transfer-encoding" !in headers)
            val size=headers["content-length"]?.toInt() ?: 0;require(size in 0..65536)
            val body=ByteArray(size);var offset=0
            while(offset<size) { val count=input.read(body,offset,size-offset);if(count<0)throw EOFException("Incomplete HTTP fixture body");offset+=count }
            val request=Request(requestLine[0],URI(requestLine[1]).path,headers,body)
            val response=routes[request.path]?.invoke(request) ?: Reply(404)
            val description=when(response.status) {200->"OK";307->"Temporary Redirect";503->"Service Unavailable";else->"Not Found"}
            val prefix=buildString {
                append("HTTP/1.1 ${response.status} $description\r\n")
                response.headers.forEach { (key,value) -> require('\r' !in key && '\n' !in key && '\r' !in value && '\n' !in value);append("$key: $value\r\n") }
                append("Content-Length: ${response.body.size}\r\nConnection: close\r\n\r\n")
            }.toByteArray(Charsets.US_ASCII)
            client.getOutputStream().apply { write(prefix+response.body);flush() }
        }
        override fun close() {
            closed.set(true);socket.close();active.forEach { runCatching { it.close() } };executor.shutdownNow()
            listener.join(2000);executor.awaitTermination(2,TimeUnit.SECONDS)
            failure.get()?.let { throw AssertionError("Loopback fixture failed",it) }
        }
    }
    private fun serve(block: (LoopbackServer,String)->Unit) {
        val server=LoopbackServer()
        try { block(server,server.url) } finally { server.close() }
    }
    @Test fun actualHttpCarriesExactCanonicalIntentAndTokenWithoutFollowingRedirects()=serve { server,url ->
        val received=AtomicReference<String>();val token=AtomicReference<String>();val requestPath=AtomicReference<String>();val method=AtomicReference<String>()
        server.route("/community/action") { request ->
            received.set(request.body.toString(Charsets.UTF_8));token.set(request.headers["authorization"]);requestPath.set(request.path);method.set(request.method)
            Reply(200,"{\"status\":\"unknown\"}".toByteArray())
        }
        val fence=SessionFence();val scope=fence.switch("account-a");val body=NativeProtocol.canonical(mapOf("payload" to mapOf("operation_key" to "original-key"),"action" to "operation")).toByteArray()
        val response=CloudflareTransport(url,fence).request("/community/action",scope,"test-bearer","POST",body)
        assertEquals("{\"status\":\"unknown\"}",response.toString(Charsets.UTF_8));assertEquals(body.toString(Charsets.UTF_8),received.get())
        assertEquals("Bearer test-bearer",token.get());assertEquals("/community/action",requestPath.get());assertEquals("POST",method.get())
    }
    @Test fun retiredMediaActionsAndSourcesAreRejectedBeforeAnyHttpRequest()=serve { server,url ->
        server.route("/community/action") { _ -> Reply(200,"{}".toByteArray()) }
        val fence=SessionFence();val scope=fence.switch("account-a");val transport=CloudflareTransport(url,fence)
        listOf("sharing.snapshot" to mapOf("source" to "professional"),"photos.validate" to mapOf("source" to "professional"),
            "photos" to mapOf("source" to "professional"),"sharing.photos.validate" to emptyMap<String,Any?>()).forEach { (action,payload) ->
            try { transport.action(action,payload,scope,"test-bearer");fail("Retired scope reached the transport") }
            catch(problem: LiveFailure) { assertTrue(problem.code in listOf("source_mismatch","unsupported_action")) }
        }
        assertEquals(0,server.requestCount)
    }
    @Test fun personalSnapshotUsesGuardedTransportWithItsExactSourceAndIntent()=serve { server,url ->
        val received=AtomicReference<String>();val token=AtomicReference<String>()
        server.route("/community/action") { request -> received.set(request.body.toString(Charsets.UTF_8));token.set(request.headers["authorization"]);Reply(200,"{}".toByteArray()) }
        val fence=SessionFence();val scope=fence.switch("account-a")
        val payload=mapOf("source" to "personal","operation_key" to "original-key","asset_ids" to listOf("asset-a"))
        val response=CloudflareTransport(url,fence).action("sharing.snapshot",payload,scope,"test-bearer")
        assertEquals("{}",response.toString(Charsets.UTF_8))
        assertEquals(NativeProtocol.canonical(mapOf("action" to "sharing.snapshot","payload" to payload)),received.get())
        assertEquals("Bearer test-bearer",token.get());assertEquals(1,server.requestCount)
    }
    @Test fun delayedPreviewCannotReturnBytesAcrossEvenSameAccountSessionRefresh()=serve { server,url ->
        val reached=CountDownLatch(1);val release=CountDownLatch(1);val problem=AtomicReference<Throwable>();val exposed=AtomicReference<ByteArray>()
        server.route("/preview") { _ ->
            reached.countDown();check(release.await(3,TimeUnit.SECONDS));Reply(200,byteArrayOf(1,2,3),mapOf("Content-Type" to "image/jpeg"))
        }
        val fence=SessionFence();val before=fence.switch("same-account");val transport=CloudflareTransport(url,fence)
        val task=Thread { try { exposed.set(transport.request("/preview",before,"old-session",binary=true)) } catch(error: Throwable) { problem.set(error) } }
        task.start();assertTrue(reached.await(3,TimeUnit.SECONDS));fence.switch("same-account");release.countDown();task.join(5000);transport.cancel()
        assertFalse(task.isAlive);assertNull(exposed.get());assertEquals("session_changed",(problem.get() as LiveFailure).code)
    }
    @Test fun anAmbiguousServerFailureIsNeverReportedAsCommitted()=serve { server,url ->
        server.route("/community/action") { _ -> Reply(503,"{\"error\":{\"code\":\"service_unavailable\"}}".toByteArray()) }
        val fence=SessionFence();val scope=fence.switch("account-a")
        try { CloudflareTransport(url,fence).request("/community/action",scope,"test-token","POST","{}".toByteArray());fail("Expected ambiguous failure") }
        catch(problem: LiveFailure) { assertTrue(problem.ambiguous);assertEquals(503,problem.status) }
    }
    @Test fun redirectsCannotTransferBearerCredentialsOrCaptureBytesToAnotherPath()=serve { server,url ->
        val followed=AtomicInteger(0);val capture=AtomicReference<Request>()
        server.route("/capture") { request -> capture.set(request);Reply(307,headers=mapOf("Location" to url+"/sink")) }
        server.route("/sink") { _ -> followed.incrementAndGet();Reply(200) }
        val fence=SessionFence();val scope=fence.switch("account-a")
        try { CloudflareTransport(url,fence).request("/capture",scope,"test-token","PUT",byteArrayOf(1,2,3),"image/jpeg");fail("Expected redirect rejection") }
        catch(problem: LiveFailure) { assertEquals("unsafe_redirect",problem.code);assertTrue(problem.ambiguous) }
        assertEquals("PUT",capture.get().method);assertEquals("Bearer test-token",capture.get().headers["authorization"])
        assertArrayEquals(byteArrayOf(1,2,3),capture.get().body);assertEquals(0,followed.get())
    }
}
