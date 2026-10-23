package com.lovelies.frontend.preview

import org.junit.Assert.*
import org.junit.Test

class ReleaseReadinessTest {
    private fun id(n: Int)="00000000-0000-4000-8000-%012d".format(n)
    private fun photo(n: Int)=mapOf("id" to id(n),"version" to id(10+n),"source" to "received","media_source" to "personal","title" to "Photo $n","width" to 800,"height" to 1200)
    @Test fun paginationRetainsOpaqueTimeIdBoundaryAndRefusesRepeats() {
        val cursor=mapOf("before_at" to "2026-10-23T10:00:00.000Z","before_id" to id(2))
        val page=LibraryPage.parse(mapOf("items" to listOf(photo(1),photo(2)),"next_cursor" to cursor))
        assertEquals(2,page.items.size);assertEquals(cursor,page.next!!.wire())
        assertThrows(LiveFailure::class.java) { LibraryPage.parse(mapOf("items" to emptyList<WireObject>(),"next_cursor" to cursor),page.next) }
        assertThrows(LiveFailure::class.java) { LibraryPage.parse(mapOf("items" to listOf(photo(1),photo(1)),"next_cursor" to null)) }
    }
    @Test fun functionEndpointAndOriginalCapabilitiesStayInsideExactApi() {
        val base="https://ltqfplqevxztlswlzexn.supabase.co/functions/v1/lovelies-api"
        assertEquals(base,NativeProtocol.baseUrl(base,false))
        assertEquals("/downloads/${id(1)}",NativeProtocol.downloadPath("$base/downloads/${id(1)}",base))
        listOf("https://evil.example/downloads/${id(1)}","https://ltqfplqevxztlswlzexn.supabase.co/downloads/${id(1)}","$base/downloads/${id(1)}?x=1","$base/downloads/${id(1)}#x","$base/downloads/not-an-id").forEach {
            assertThrows(LiveFailure::class.java) { NativeProtocol.downloadPath(it,base) }
        }
    }
    @Test fun deepLinksAreOnlyNamedHttpsTargetsAndNeverCarryAuthority() {
        val host="lovelies.app"
        assertEquals(AppLink("requests",id(1)),AppLink.parse("https://$host/requests/${id(1)}",host))
        listOf("http://$host/requests/${id(1)}","https://evil.example/requests/${id(1)}","https://$host/requests/${id(1)}?token=secret","https://$host/other/${id(1)}","https://$host/requests/${id(1)}/extra").forEach { assertNull(AppLink.parse(it,host)) }
    }
    @Test fun originalsUseTheirActualFormatWithoutChangingBytes() {
        val jpeg=byteArrayOf(0xff.toByte(),0xd8.toByte(),0xff.toByte(),0,1,2)
        val before=jpeg.copyOf();assertEquals("image/jpeg",OriginalMedia.format(jpeg).mime);assertArrayEquals(before,jpeg)
        assertEquals("image/png",OriginalMedia.format(byteArrayOf(0x89.toByte(),0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a)).mime)
        assertThrows(LiveFailure::class.java) { OriginalMedia.format("<html>not an image</html>".toByteArray()) }
    }
    @Test fun uiAndBackgroundWorkCannotCrossAccountsOrBatches() {
        val row=mapOf("enabled" to true,"account" to id(1),"device" to id(2),"batch" to id(3))
        assertTrue(ownsUiState(row,id(1)));assertFalse(ownsUiState(row,id(4)));assertFalse(ownsUiState(emptyMap<String,Any?>(),null))
        assertTrue(BackgroundTransfers.permitted(row,id(1),id(2),id(3)))
        assertFalse(BackgroundTransfers.permitted(row,id(4),id(2),id(3)))
        assertFalse(BackgroundTransfers.permitted(row,id(1),id(2),id(4)))
        assertFalse(BackgroundTransfers.permitted(row+mapOf("enabled" to false),id(1),id(2),id(3)))
    }
    @Test fun viewerNavigationUsesStableAssetIdsAndStopsAtBounds() {
        val rows=(1..3).map { LivePhoto.parse(photo(it)) }
        assertEquals(id(3),adjacentPhoto(rows,id(2),1)!!.id)
        assertEquals(id(1),adjacentPhoto(rows,id(2),-1)!!.id)
        assertNull(adjacentPhoto(rows,id(1),-1));assertNull(adjacentPhoto(rows,id(3),1));assertNull(adjacentPhoto(rows,id(4),1))
    }
}
