package com.lovelies.frontend.preview

import org.junit.Assert.*
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.time.Instant

class NativeProtocolTest {
    private val now=10000L
    private fun id(n: Int)="00000000-0000-4000-8000-%012d".format(n)
    private val alice=id(20)
    private val eric=id(21)
    private fun expires()=Instant.ofEpochMilli(now+600000).toString()
    private fun graph(source: String="personal",count: Int=4): WireObject {
        val photos=(1..count).map { mapOf("id" to id(it),"version" to "asset-$it","media_source" to source,"width" to 800,"height" to 1200,"title" to "P$it") }
        val pairs=if(count==4)listOf(1 to alice,2 to alice,4 to alice,2 to eric,3 to eric) else (1..count).map { it to alice }
        return mapOf("protocol" to "reviewed-sharing-v1","status" to "ready","snapshot" to mapOf("id" to id(40),"version" to "snapshot-v1","source" to source,"expires_at" to expires(),
            "assets" to photos,"recipients" to if(count==4)listOf(mapOf("id" to alice,"name" to "Aline"),mapOf("id" to eric,"name" to "Eric")) else listOf(mapOf("id" to alice,"name" to "Aline")),
            "pairs" to pairs.map { mapOf("asset_id" to id(it.first),"recipient_id" to it.second,"version" to "match-v1") },
            "scope" to mapOf("asset_limit" to 100,"recipient_limit" to 100,"pair_limit" to 1000,"has_more" to false,"selection_limited" to false)))
    }
    private fun snapshot(source: String="personal",count: Int=4)=LiveSnapshot.parse(graph(source,count),now,source,null)
    private fun draft(snap: LiveSnapshot)=LiveDraft(1,snap.photos.map { it.id }.toSet(),snap.people.map { it.id }.toSet(),emptySet())
    private fun manifest(pairs: List<LivePair>): WireObject=mapOf("totals" to mapOf("photos" to pairs.map { it.photo }.toSet().size,"recipients" to pairs.map { it.person }.toSet().size,"pairs" to pairs.size),
        "recipients" to pairs.map { it.person }.distinct().map { person -> val ids=pairs.filter { it.person==person }.map { it.photo };mapOf("recipient_id" to person,"asset_ids" to ids,"photo_count" to ids.size) })
    private fun reviewed(snap: LiveSnapshot,draft: LiveDraft): WireObject {
        val pairs=draft.effective(snap)
        return mapOf("protocol" to "reviewed-sharing-v1","status" to "ready","preview" to (mapOf("id" to id(41),"version" to "preview-v1","source" to snap.source,"draft_version" to draft.version,
            "expires_at" to expires(),"pairs" to pairs.map(LivePair::wire))+manifest(pairs)))
    }
    private fun fail(code: String?=null,block: ()->Unit) {
        try { block();org.junit.Assert.fail("Expected fail-closed rejection") } catch(problem: LiveFailure) { if(code!=null)assertEquals(code,problem.code) }
    }
    @Test fun canonicalCaptureWireIsSortedAndPreservesNullsUnicodeAndEscapes() {
        assertEquals("{\"a\":null,\"emoji\":\"💗\",\"n\":1,\"text\":\"x\\n\\\"\\\\\",\"z\":[true,3]}",
            NativeProtocol.canonical(linkedMapOf("z" to listOf(true,3),"text" to "x\n\"\\","n" to 1.0,"emoji" to "💗","a" to null)))
        assertEquals("\"\\ud800\"",NativeProtocol.canonical("\ud800"))
        fail("invalid_wire_number") { NativeProtocol.canonical(Double.NaN) }
    }
    @Test fun p256DerConversionRetainsAnActuallyVerifiableDeviceSignature() {
        val keys=KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val wire=NativeProtocol.canonical(mapOf("nonce" to "one-use-nonce","step" to "capture","capture_index" to 0,"capture_sha256" to "a".repeat(64))).toByteArray()
        val signing=Signature.getInstance("SHA256withECDSA").apply { initSign(keys.private);update(wire) }
        val der=signing.sign();val raw=NativeProtocol.derToRaw(der)
        assertEquals(64,raw.size);assertEquals(86,NativeProtocol.base64(raw).length)
        fun integer(bytes: ByteArray): ByteArray {
            val significant=bytes.dropWhile { it==0.toByte() }.toByteArray();val value=if(significant[0].toInt() and 128!=0)byteArrayOf(0)+significant else significant
            return byteArrayOf(2,value.size.toByte())+value
        }
        val encoded=integer(raw.copyOfRange(0,32))+integer(raw.copyOfRange(32,64));val roundTrip=byteArrayOf(0x30,encoded.size.toByte())+encoded
        val verifying=Signature.getInstance("SHA256withECDSA").apply { initVerify(keys.public);update(wire) }
        assertTrue(verifying.verify(roundTrip));assertArrayEquals(der,roundTrip)
    }
    @Test fun malformedAndNonMinimalDerCannotBecomeDeviceProofs() {
        listOf(byteArrayOf(0x30,6,2,1,0,2,1,1),byteArrayOf(0x30,6,2,1,0x80.toByte(),2,1,1),
            byteArrayOf(0x30,7,2,2,0,1,2,1,1),byteArrayOf(0x30,6,2,1,1,2,1,1,0)).forEach { der -> fail("invalid_device_signature") { NativeProtocol.derToRaw(der) } }
    }
    @Test fun envelopeBindsCurrentChallengeAndDeviceAndNeverAddsLiveness() {
        val challenge=mapOf("challenge_id" to id(30),"nonce" to "nonce","purpose" to "registration","account_id" to id(31),"device_id" to id(32),"device_revision" to 1,
            "profile_id" to null,"profile_revision" to null,"policy_version" to "registered-face-opencv-v1","ignored" to "x")
        val envelope=NativeProtocol.faceEnvelope(challenge)
        assertEquals("lovelies-face-device-v1",envelope["protocol"]);assertEquals(id(32),envelope["device_id"])
        assertTrue(envelope.containsKey("profile_revision"));assertFalse(envelope.containsKey("ignored"));assertFalse(envelope.containsKey("liveness"))
        assertNotEquals(NativeProtocol.sha256(NativeProtocol.canonical(envelope).toByteArray()),NativeProtocol.sha256(NativeProtocol.canonical(envelope+mapOf("nonce" to "different")).toByteArray()))
    }
    @Test fun enrollmentChallengeCannotUpgradeAForeignAnonymousAccount() {
        val challenge=mapOf("account_id" to id(31),"device_id" to id(32),"purpose" to "registration")
        NativeProtocol.bindFaceChallenge(challenge,id(31),"registration")
        fail("challenge_identity_changed") { NativeProtocol.bindFaceChallenge(challenge,id(99),"registration") }
        fail("challenge_identity_changed") { NativeProtocol.bindFaceChallenge(challenge,id(31),"login") }
    }
    @Test fun freshFaceLoginUsesOnlyTheRetainedRegisteredAccountAndDevice() {
        val challenge=mapOf("account_id" to id(31),"device_id" to id(32),"purpose" to "login")
        NativeProtocol.bindFaceChallenge(challenge,id(31),"login",id(32))
        fail("challenge_identity_changed") { NativeProtocol.bindFaceChallenge(challenge,id(99),"login",id(32)) }
        fail("challenge_identity_changed") { NativeProtocol.bindFaceChallenge(challenge,id(31),"login",id(99)) }
    }
    @Test fun sparseAlineEricGraphNeverBecomesCartesianAndGlobalPhotoExclusionAffectsBoth() {
        val snap=snapshot();val all=draft(snap)
        assertEquals(5,all.effective(snap).size)
        val noP2=all.copy(photos=all.photos-id(2))
        assertEquals(setOf(id(1),id(4)),noP2.effective(snap).filter { it.person==alice }.map { it.photo }.toSet())
        assertEquals(listOf(id(3)),noP2.effective(snap).filter { it.person==eric }.map { it.photo })
        val noAlineP4=noP2.copy(excluded=setOf(LivePair(id(4),alice)))
        assertEquals(setOf(id(1) to alice,id(3) to eric),noAlineP4.effective(snap).map { it.photo to it.person }.toSet())
        assertTrue(noAlineP4.copy(people=emptySet()).effective(snap).isEmpty())
    }
    @Test fun globalPersonExclusionPreservesOtherRecipientsAndPairExclusions() {
        val snap=snapshot();val d=draft(snap).copy(people=setOf(eric),excluded=setOf(LivePair(id(2),eric)))
        assertEquals(listOf(id(3) to eric),d.effective(snap).map { it.photo to it.person })
        fail("selection_outside_snapshot") { d.copy(excluded=setOf(LivePair(id(1),eric))).effective(snap) }
        fail("selection_outside_snapshot") { d.copy(photos=d.photos+id(99)).effective(snap) }
    }
    @Test fun sourceScopeAndDuplicateCandidateEdgesAreRejected() {
        fail("source_mismatch") { LiveSnapshot.parse(graph("professional"),now,"personal",null) }
        fail("snapshot_scope_changed") { LiveSnapshot.parse(graph(),now,"personal",listOf(id(1))) }
        val value=NativeProtocol.obj(graph()["snapshot"]);val pairs=NativeProtocol.rows(value["pairs"])
        val forged=value+mapOf("pairs" to pairs+(pairs.first()+mapOf("version" to "different")))
        fail("invalid_snapshot") { LiveSnapshot.parse(graph()+mapOf("snapshot" to forged),now,"personal",null) }
    }
    @Test fun explicitPersonalSourceBindsSnapshotPreviewAndReceipt() {
        listOf("personal").forEach { source ->
            val response=graph(source);val snap=LiveSnapshot.parse(response,now,source,null);val d=draft(snap)
            assertEquals(source,snap.source);assertTrue(snap.photos.all { it.mediaSource==source })
            assertEquals(source,NativeProtocol.bindSharingSource(response,"sharing.snapshot",source))
            val review=reviewed(snap,d);val view=LivePreview.parse(review,snap,d,now)
            assertEquals(source,NativeProtocol.bindSharingSource(review,"sharing.preview",source))
            val receipt=outcome(view)
            assertSame(receipt,validateOutcome(receipt,view,source,"original-operation"))
            assertEquals(source,NativeProtocol.bindSharingSource(receipt,"sharing.commit",source))
        }
    }
    @Test fun retiredMediaModesCannotAuthorizeEvenMatchingSourceClaims() {
        listOf<Any?>("professional","photographer",null,"received",1).forEach { source ->
            fail("source_mismatch") { NativeProtocol.mediaSource(source) }
        }
        fail("source_mismatch") { LiveSnapshot.parse(graph("professional"),now,"professional",null) }
        fail("source_mismatch") { NativeProtocol.bindSharingSource(graph("personal"),"sharing.snapshot","professional") }
    }
    @Test fun credentialRolesRetainCurrentUserAndAdminRolesButRejectRetiredOrMalformedRoles() {
        assertEquals(listOf("user"),NativeProtocol.credentialRoles(listOf("user")))
        assertEquals(listOf("user","admin"),NativeProtocol.credentialRoles(listOf("user","admin")))
        listOf<Any?>(null,emptyList<String>(),listOf("photographer"),listOf("user","photographer"),listOf("user","admin","photographer"),listOf("user","user"),listOf(1)).forEach { roles ->
            fail("credentials_invalid") { NativeProtocol.credentialRoles(roles) }
        }
    }
    @Test fun mediaPayloadGuardsRejectRetiredModesWhileKeepingPhotoListScopesDistinct() {
        listOf("sharing.snapshot","sharing.preview","sharing.commit","photo.upload.reserve","request.decide","photos.validate").forEach { action ->
            NativeProtocol.validateActionPayload(action,emptyMap())
            NativeProtocol.validateActionPayload(action,mapOf("source" to "personal"))
            listOf<Any?>(null,"professional","photographer","all").forEach { source ->
                fail("source_mismatch") { NativeProtocol.validateActionPayload(action,mapOf("source" to source)) }
            }
        }
        listOf("all","received","contributions").forEach { source -> NativeProtocol.validateActionPayload("photos",mapOf("source" to source)) }
        fail("source_mismatch") { NativeProtocol.validateActionPayload("photos",mapOf("source" to "professional")) }
        fail("unsupported_action") { NativeProtocol.validateActionPayload("sharing.photos.validate",emptyMap()) }
    }
    @Test fun enrollmentPreferencesAndPersistedDomainIntentsKeepTheirOwnSourcesWhileMediaIntentsStayStrict() {
        mapOf("photo.preferences" to "account","account.profile.update" to "account","notification.settings" to "account",
            "privacy.request.export" to "privacy","safety.block" to "safety","downloads.sign" to "download").forEach { (action,source) ->
            assertEquals(source,NativeProtocol.operationSource(action,source))
            val restored=mapOf("action" to action,"source" to source)
            assertEquals(source,NativeProtocol.operationSource(NativeProtocol.text(restored["action"]),restored["source"]))
            fail("invalid_response") { NativeProtocol.operationSource(action,null) }
        }
        listOf("sharing.snapshot","sharing.preview","sharing.commit","photo.upload.reserve","photo.upload.complete","request.decide").forEach { action ->
            assertEquals("personal",NativeProtocol.operationSource(action,"personal"))
            listOf<Any?>(null,"professional","account","privacy","download",1).forEach { source -> fail("source_mismatch") { NativeProtocol.operationSource(action,source) } }
        }
    }
    @Test fun snapshotAndProtectedPhotoMetadataCannotDefaultMissingOrForeignSourcesToPersonal() {
        listOf("personal").forEach { source ->
            val response=graph(source);val value=NativeProtocol.obj(response["snapshot"])
            val other=if(source=="personal")"professional" else "personal"
            listOf<Any?>(null,other,"received",1).forEach { supplied ->
                val changed=response+mapOf("snapshot" to value+mapOf("source" to supplied))
                fail("source_mismatch") { LiveSnapshot.parse(changed,now,source,null) }
                fail("source_mismatch") { NativeProtocol.bindSharingSource(changed,"sharing.snapshot",source) }
            }
            fail("source_mismatch") { LiveSnapshot.parse(response+mapOf("snapshot" to value-"source"),now,source,null) }
            val photos=NativeProtocol.rows(value["assets"]);val first=photos.first()
            listOf<Any?>(null,other,"received").forEach { supplied ->
                val changed=value+mapOf("assets" to listOf(first+mapOf("media_source" to supplied))+photos.drop(1))
                fail("source_mismatch") { LiveSnapshot.parse(response+mapOf("snapshot" to changed),now,source,null) }
            }
            fail("source_mismatch") { LivePhoto.parse(first-"media_source") }
        }
    }
    @Test fun readyChangedAndEmptyPreviewResponsesRemainBoundToTheRequestedSource() {
        listOf("personal").forEach { source ->
            val snap=snapshot(source);val d=draft(snap);val response=reviewed(snap,d);val value=NativeProtocol.obj(response["preview"])
            val other=if(source=="personal")"professional" else "personal"
            listOf<Any?>(null,other,"received").forEach { supplied ->
                fail("review_scope_changed") { LivePreview.parse(response+mapOf("preview" to value+mapOf("source" to supplied)),snap,d,now) }
            }
            fail("review_scope_changed") { LivePreview.parse(response+mapOf("preview" to value-"source"),snap,d,now) }
            listOf("changed","empty").forEach { status ->
                val terminal=mapOf("protocol" to "reviewed-sharing-v1","status" to status,"source" to source)
                fail(if(status=="changed")"review_changed" else "empty_review") { LivePreview.parse(terminal,snap,d,now) }
                fail("review_scope_changed") { LivePreview.parse(terminal-"source",snap,d,now) }
                fail("review_scope_changed") { LivePreview.parse(terminal+mapOf("source" to other),snap,d,now) }
                fail("source_mismatch") { NativeProtocol.bindSharingSource(terminal+mapOf("source" to other),"sharing.preview",source) }
            }
        }
    }
    @Test fun commitAndOperationReconciliationRejectMissingOrDifferentSourceBeforeConsumingAReceipt() {
        listOf("personal").forEach { source ->
            val snap=snapshot(source);val d=draft(snap);val view=LivePreview.parse(reviewed(snap,d),snap,d,now);val receipt=outcome(view)
            val other=if(source=="personal")"professional" else "personal"
            listOf<Any?>(null,other,"received").forEach { supplied ->
                val changed=receipt+mapOf("source" to supplied)
                fail("invalid_receipt") { validateOutcome(changed,view,source,"original-operation") }
                fail("source_mismatch") { NativeProtocol.bindSharingSource(changed,"sharing.commit",source) }
            }
            fail("invalid_receipt") { validateOutcome(receipt-"source",view,source,"original-operation") }
            fail("invalid_receipt") { validateOutcome(receipt,view.copy(wire=view.wire+mapOf("source" to other)),source,"original-operation") }
            val changed=mapOf("protocol" to "reviewed-sharing-v1","status" to "changed","source" to source)
            fail("review_changed") { validateOutcome(changed,view,source,"original-operation") }
            fail("invalid_receipt") { validateOutcome(changed-"source",view,source,"original-operation") }
        }
    }
    @Test fun aHundredActualAssetsAreAcceptedWithoutReducingThePrescribedLimit() {
        val snap=snapshot(count=100);val d=draft(snap)
        assertEquals(100,d.effective(snap).size);assertEquals(100,(d.wire(snap)["selected_asset_ids"] as List<*>).size)
        val view=LivePreview.parse(reviewed(snap,d),snap,d,now);assertEquals(100,view.pairs.size)
    }
    @Test fun previewCannotAddPhotosOrChangeDraftOrExtendItsLifetime() {
        val snap=snapshot();val d=draft(snap).copy(photos=setOf(id(1),id(2)))
        val response=reviewed(snap,d);val value=NativeProtocol.obj(response["preview"])
        val extra=NativeProtocol.rows(value["pairs"])+LivePair(id(4),eric).wire()
        fail("review_scope_changed") { LivePreview.parse(response+mapOf("preview" to value+mapOf("pairs" to extra)),snap,d,now) }
        fail("review_scope_changed") { LivePreview.parse(response+mapOf("preview" to value+mapOf("draft_version" to 2)),snap,d,now) }
        fail("review_scope_changed") { LivePreview.parse(response+mapOf("preview" to value+mapOf("expires_at" to Instant.ofEpochMilli(snap.expires+1).toString())),snap,d,now) }
        fail("review_changed") { LivePreview.parse(mapOf("protocol" to "reviewed-sharing-v1","status" to "changed","source" to snap.source),snap,d,now) }
    }
    private fun outcome(view: LivePreview,key: String="original-operation"): WireObject {
        val manifest=manifest(view.pairs)
        return mapOf("protocol" to "reviewed-sharing-v1","source" to view.wire["source"],"status" to "pending_acceptance","operation_key" to key,"preview_id" to view.id,"grants_created" to 0,
            "totals" to manifest["totals"],"recipients" to NativeProtocol.rows(manifest["recipients"]).mapIndexed { i,row -> row+mapOf("request_id" to id(70+i),"status" to "requested","available_count" to 0) })
    }
    @Test fun uncertainCommitReconciliationMustMatchOriginalKeyAndExactApprovedSubset() {
        val snap=snapshot();val d=draft(snap);val view=LivePreview.parse(reviewed(snap,d),snap,d,now);val result=outcome(view)
        assertSame(result,validateOutcome(result,view,"personal","original-operation"))
        fail("invalid_receipt") { validateOutcome(result,view,"personal","new-key") }
        val people=NativeProtocol.rows(result["recipients"]);val forged=people.first()+mapOf("asset_ids" to NativeProtocol.idList(people.first()["asset_ids"])+id(99))
        fail("receipt_scope_changed") { validateOutcome(result+mapOf("recipients" to listOf(forged)+people.drop(1)),view,"personal","original-operation") }
    }
    @Test fun pendingAcceptanceCannotClaimAccessAndLaterUnavailableDoesNotInventReplacementAudience() {
        val snap=snapshot();val d=draft(snap);val view=LivePreview.parse(reviewed(snap,d),snap,d,now);val result=outcome(view)
        val people=NativeProtocol.rows(result["recipients"])
        fail("invalid_receipt") { validateOutcome(result+mapOf("grants_created" to 1),view,"personal","original-operation") }
        fail("invalid_receipt") { validateOutcome(result+mapOf("recipients" to listOf(people.first()+mapOf("available_count" to 1))+people.drop(1)),view,"personal","original-operation") }
        assertEquals("unavailable",validateOutcome(result+mapOf("status" to "unavailable","recipients" to people.map { it+mapOf("status" to "revoked") }),view,"personal","original-operation")["status"])
    }
    @Test fun delayedSameAccountAndCrossAccountResponsesCannotCrossSessionEpochs() {
        val fence=SessionFence();val original=fence.switch(id(1));fence.assert(original)
        val refreshed=fence.switch(id(1));fail("session_changed") { fence.assert(original) };fence.assert(refreshed)
        val next=fence.switch(id(2));fail("session_changed") { fence.assert(refreshed) };fence.assert(next)
        fence.switch(null);fail("session_changed") { fence.assert(next) }
    }
    @Test fun onlyDebugLoopbackMayUseCleartextAndCredentialsCannotBeEmbeddedInBaseUrl() {
        assertEquals("http://10.0.2.2:8787",NativeProtocol.baseUrl("http://10.0.2.2:8787/",true))
        assertEquals("https://example.com",NativeProtocol.baseUrl("https://example.com",false))
        listOf("http://10.0.2.2:8787","http://example.com","https://user:secret@example.com","https://example.com/api","https://example.com?token=x").forEach { raw -> fail("invalid_api_endpoint") { NativeProtocol.baseUrl(raw,false) } }
        fail("invalid_api_endpoint") { NativeProtocol.baseUrl("http://192.168.1.2:8787",true) }
    }
}
