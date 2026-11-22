package com.lovelies.frontend.preview

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL

/** Exercise the real HTTP adapter without sockets or provider calls. */
class DownloadTransportTest {
    private val bytes=byteArrayOf(0xff.toByte(),0xd8.toByte(),0xff.toByte(),1,2,3)
    private val capability="lvd_v2_"+NativeProtocol.base64(ByteArray(32) { (it+1).toByte() })
    private class Connection(val data: ByteArray,val headers: Map<String,String>,val opened: ()->Unit={}): HttpURLConnection(URL("https://synthetic.invalid")) {
        val body=ByteArrayOutputStream();var writes=0;var disconnected=false
        override fun connect() {}
        override fun disconnect() { disconnected=true }
        override fun usingProxy()=false
        override fun getOutputStream(): OutputStream {
            opened()
            return object: OutputStream() {
                override fun write(value: Int) { writes++;body.write(value) }
                override fun write(bytes: ByteArray,offset: Int,length: Int) { writes++;body.write(bytes,offset,length) }
            }
        }
        override fun getResponseCode()=200
        override fun getContentType()=headers["content-type"]
        override fun getHeaderField(name: String)=headers[name.lowercase()]
        override fun getInputStream()=ByteArrayInputStream(data)
    }
    private fun headers()=mapOf("content-type" to "image/jpeg","content-length" to bytes.size.toString(),
        "x-lovelies-source-version" to "source-r7","x-lovelies-content-sha256" to NativeProtocol.sha256(bytes))
    @Test fun actualV2PostCarriesCapabilityOnlyInHeaderAndExposesIntegrityFields() {
        val fence=SessionFence();val scope=fence.switch("synthetic-account");val connection=Connection(bytes,headers())
        val input=NativeProtocol.canonical(mapOf("protocol" to DownloadProtocol.INPUT,"operation_key" to "synthetic-original-key",
            "original_session_id" to "00000000-0000-4000-8000-000000000092","asset_id" to "00000000-0000-4000-8000-000000000094","source_version" to "source-r7")).toByteArray()
        var received=emptyMap<String,String>();var openedURL=""
        val response=CloudflareTransport("https://synthetic.invalid/functions/v1/lovelies-api",fence) { url->openedURL=url;connection }
            .request("/downloads/v2/content",scope,"synthetic-jwt","POST",input,headers=mapOf(DownloadProtocol.CAPABILITY_HEADER to capability),
                binary=true,binaryLimit=DownloadProtocol.MAX_BYTES,expectedStatus=200,responseHeaders={received=it})
        assertEquals("https://synthetic.invalid/functions/v1/lovelies-api/downloads/v2/content",openedURL)
        assertFalse(openedURL.contains(capability));assertFalse(input.toString(Charsets.UTF_8).contains(capability))
        assertEquals(capability,connection.getRequestProperty(DownloadProtocol.CAPABILITY_HEADER));assertEquals("POST",connection.requestMethod)
        assertArrayEquals(input,connection.body.toByteArray());assertArrayEquals(bytes,response);assertEquals(headers(),received);assertTrue(connection.disconnected)
    }
    @Test fun authorityChangesWhileOpeningContentStreamPreventAnyBodyWrite() {
        val fence=SessionFence();val scope=fence.switch("synthetic-account");var allowed=true
        val connection=Connection(bytes,headers()) { allowed=false }
        try {
            CloudflareTransport("https://synthetic.invalid",fence) { connection }.request("/downloads/v2/content",scope,"synthetic-jwt","POST","{}".toByteArray(),
                headers=mapOf(DownloadProtocol.CAPABILITY_HEADER to capability),binary=true,binaryLimit=DownloadProtocol.MAX_BYTES,
                beforeWrite={if(!allowed)throw LiveFailure("download_authority_changed",409,true)})
            fail("Changed authority reached content dispatch")
        } catch(problem: LiveFailure) { assertEquals("download_authority_changed",problem.code) }
        assertEquals(0,connection.writes);assertTrue(connection.disconnected)
    }
    @Test fun bodyOverTwentyMiBLimitCannotReachIntegrityAcceptance() {
        val fence=SessionFence();val scope=fence.switch("synthetic-account");val connection=Connection(ByteArray(DownloadProtocol.MAX_BYTES+1),headers())
        var accepted=false
        try {
            CloudflareTransport("https://synthetic.invalid",fence) { connection }.request("/downloads/v2/content",scope,"synthetic-jwt","POST","{}".toByteArray(),
                binary=true,binaryLimit=DownloadProtocol.MAX_BYTES,responseHeaders={accepted=true})
            fail("Accepted an oversized original")
        } catch(problem: LiveFailure) { assertEquals("response_too_large",problem.code) }
        assertFalse(accepted);assertTrue(connection.disconnected)
    }
}
