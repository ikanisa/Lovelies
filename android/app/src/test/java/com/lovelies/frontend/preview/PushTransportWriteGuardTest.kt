package com.lovelies.frontend.preview

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL

/** The real transport's body-write port with a local connection fake. Opening
 * its output stream models a blocking setup interval; no socket is opened. */
class PushTransportWriteGuardTest {
    private class Connection(private val afterStreamOpen: ()->Unit={},private val failWrite: Boolean=false): HttpURLConnection(URL("https://synthetic.invalid")) {
        val sent=ByteArrayOutputStream();var writes=0;var closed=false;var disconnected=false
        override fun connect() {}
        override fun disconnect() { disconnected=true }
        override fun usingProxy()=false
        override fun getOutputStream(): OutputStream {
            afterStreamOpen()
            return object: OutputStream() {
                override fun write(value: Int) { writes++;if(failWrite)throw IOException("Synthetic interrupted write");sent.write(value) }
                override fun write(bytes: ByteArray,offset: Int,length: Int) { writes++;if(failWrite)throw IOException("Synthetic interrupted write");sent.write(bytes,offset,length) }
                override fun close() { closed=true }
            }
        }
        override fun getResponseCode()=200
        override fun getContentType()="application/json"
        override fun getInputStream()=ByteArrayInputStream("{}".toByteArray())
    }
    @Test fun preferenceAndPermissionAreCheckedAfterOutputStreamAcquisitionBeforeAnyBodyWrite() {
        for(reason in listOf("permission","preference")) {
            var allowed=true;var attempted=false;var checked=0
            val fence=SessionFence();val scope=fence.switch("synthetic-owner")
            val guard={checked++;if(!allowed)throw LiveFailure("push_permission_changed",409,true)}
            guard() // The repository's earlier admission passes.
            val connection=Connection(afterStreamOpen={allowed=false})
            try {
                CloudflareTransport("https://synthetic.invalid",fence) { connection }.request("/me/push-devices",scope,"synthetic-token","POST","{}".toByteArray(),
                    beforeWrite=guard,onWriteAttempt={attempted=true})
                fail("$reason changed during setup but reached the body writer")
            } catch(problem: LiveFailure) { assertEquals("push_permission_changed",problem.code) }
            assertEquals(2,checked);assertFalse(attempted);assertEquals(0,connection.writes);assertEquals(0,connection.sent.size())
            assertTrue(connection.closed);assertTrue(connection.disconnected)
        }
    }
    @Test fun sameAccountSessionChangeDuringOutputStreamAcquisitionPreventsBodyWrite() {
        var attempted=false;val fence=SessionFence();val scope=fence.switch("synthetic-owner")
        val connection=Connection(afterStreamOpen={fence.switch("synthetic-owner")})
        try {
            CloudflareTransport("https://synthetic.invalid",fence) { connection }.request("/me/push-devices",scope,"synthetic-token","POST","{}".toByteArray(),
                beforeWrite={fail("A stale session cannot reach product admission")},onWriteAttempt={attempted=true})
            fail("Changed session reached the body writer")
        } catch(problem: LiveFailure) { assertEquals("session_changed",problem.code) }
        assertFalse(attempted);assertEquals(0,connection.writes);assertTrue(connection.closed);assertTrue(connection.disconnected)
    }
    @Test fun interruptedBodyWriteIsMarkedAttemptedAndRemainsAmbiguousEvenWhenFakeSentNoBytes() {
        var attempted=false;val fence=SessionFence();val scope=fence.switch("synthetic-owner")
        val connection=Connection(failWrite=true)
        try {
            CloudflareTransport("https://synthetic.invalid",fence) { connection }.request("/me/push-devices",scope,"synthetic-token","POST","{}".toByteArray(),
                beforeWrite={},onWriteAttempt={attempted=true})
            fail("Expected an interrupted write")
        } catch(problem: LiveFailure) { assertEquals("connection_unavailable",problem.code);assertTrue(problem.ambiguous) }
        assertTrue(attempted);assertEquals(1,connection.writes);assertEquals(0,connection.sent.size());assertTrue(connection.disconnected)
    }
    @Test fun outputStreamSetupFailureDoesNotInventAWriteOrAConfirmedServerOutcome() {
        var attempted=false;var guarded=false;val fence=SessionFence();val scope=fence.switch("synthetic-owner")
        val connection=Connection(afterStreamOpen={throw IOException("Synthetic connection setup timeout")})
        try {
            CloudflareTransport("https://synthetic.invalid",fence) { connection }.request("/me/push-devices",scope,"synthetic-token","POST","{}".toByteArray(),
                beforeWrite={guarded=true},onWriteAttempt={attempted=true})
            fail("Expected setup failure")
        } catch(problem: LiveFailure) { assertEquals("connection_unavailable",problem.code);assertTrue(problem.ambiguous) }
        assertFalse(guarded);assertFalse(attempted);assertEquals(0,connection.writes);assertTrue(connection.disconnected)
    }
    @Test fun acceptedWritePreservesItsExactBodyAndExistingUnGuardedCallers() {
        for(guarded in listOf(false,true)) {
            val fence=SessionFence();val scope=fence.switch("synthetic-owner");var attempted=false
            val connection=Connection();val bytes="{\"operation_key\":\"synthetic-original-key\"}".toByteArray()
            val response=CloudflareTransport("https://synthetic.invalid",fence) { connection }.request("/me/push-devices",scope,"synthetic-token","POST",bytes,
                beforeWrite=if(guarded)({}) else null,onWriteAttempt=if(guarded)({attempted=true}) else null)
            assertArrayEquals(bytes,connection.sent.toByteArray());assertEquals("{}",response.toString(Charsets.UTF_8));assertEquals(guarded,attempted)
            assertEquals(1,connection.writes);assertTrue(connection.closed);assertTrue(connection.disconnected)
        }
    }
}
