package com.lovelies.frontend.preview

import org.junit.Assert.*
import org.junit.Test

/** Scope/ambiguity boundaries for controls that must outlive product consent. */
class OwnAccountControlsTest {
    private fun id(n: Int)="00000000-0000-4000-8000-%012d".format(n)
    private val account=id(1)
    private val origin="https://example.test/functions/v1/lovelies-api"
    private val key="android-privacy-original-0001"
    private fun intent(): WireObject=PendingIntent(account,"privacy","privacy.request.export",key,mapOf("operation_key" to key),"/privacy/export","POST").wire()
    private fun denied(block: ()->Unit) {
        try { block();fail("Expected an own-account scope rejection") } catch(expected: LiveFailure) { }
    }
    @Test fun weakRoutingRequiresTheSameRetainedRegisteredSessionInsteadOfProductState() {
        assertTrue(OwnAccountControls.registeredSession(account,account,"registered_face"))
        assertFalse(OwnAccountControls.registeredSession(account,id(2),"registered_face"))
        assertFalse(OwnAccountControls.registeredSession(account,account,"anonymous"))
        assertFalse(OwnAccountControls.registeredSession(null,null,"registered_face"))
    }
    @Test fun ownReadAndRevocationAllowlistNeverIncludesBiometricsMediaOrCommunityOperations() {
        listOf("/privacy/center","/me/sessions","/me/devices","/privacy/operations/$key").forEach { assertTrue(it,OwnAccountControls.weakRead(it)) }
        listOf("/me/photos","/community/action","/privacy/operations/$key/extra","/privacy/operations/short","/privacy/center?other=1","/me/../me/sessions","/admin/privacy-requests").forEach { assertFalse(it,OwnAccountControls.weakRead(it)) }
        listOf("/auth/session/revoke","/auth/device/revoke","/privacy-exports/${id(3)}/grant").forEach { assertTrue(it,OwnAccountControls.weakPost(it)) }
        listOf("/auth/face/challenge","/privacy/export","/community/action","/privacy-exports/${id(3)}/grant/extra","/privacy-exports/${id(3)}/grant?other=1").forEach { assertFalse(it,OwnAccountControls.weakPost(it)) }
    }
    @Test fun exportRecoveryRetainsOnlyTheExactOriginalOwnPrivacyIntent() {
        val restored=OwnAccountControls.exportIntent(intent(),account)
        assertEquals(key,restored.key);assertEquals(mapOf("operation_key" to key),restored.payload)
        listOf(mapOf("account" to id(9)),mapOf("source" to "personal"),mapOf("action" to "sharing.commit"),mapOf("path" to "/community/action"),mapOf("method" to "DELETE"),mapOf("payload" to mapOf("operation_key" to "$key-changed")),mapOf("payload" to mapOf("operation_key" to key,"asset_id" to id(4)))).forEach { change ->
            denied { OwnAccountControls.exportIntent(intent()+change,account) }
        }
    }
    @Test fun anExportReceiptForAnotherSubjectOrRequesterCannotClearTheSavedIntent() {
        val request=mapOf("id" to id(3),"request_type" to "export","subject_user_id" to account,"requested_by" to account)
        OwnAccountControls.exportReceipt(mapOf("privacy_request" to request),account)
        denied { OwnAccountControls.exportReceipt(mapOf("privacy_request" to (request+mapOf("subject_user_id" to id(9)))),account) }
        denied { OwnAccountControls.exportReceipt(mapOf("privacy_request" to (request+mapOf("requested_by" to id(9)))),account) }
        denied { OwnAccountControls.exportReceipt(mapOf("privacy_request" to (request+mapOf("request_type" to "delete"))),account) }
        denied { OwnAccountControls.exportReceipt(mapOf("status" to "unknown"),account) }
    }
    @Test fun guardianRecoveryReferenceContainsNoPhotoGrantAndCannotCrossOriginOrAccount() {
        val reference=OwnAccountControls.guardianReference(origin,account,id(3))
        assertEquals(setOf("origin","account","request"),reference.keys)
        assertEquals(id(3),OwnAccountControls.referenceRequest(reference,origin,account))
        denied { OwnAccountControls.referenceRequest(reference,"https://elsewhere.test",account) }
        denied { OwnAccountControls.referenceRequest(reference,origin,id(9)) }
        denied { OwnAccountControls.referenceRequest(reference+mapOf("photo_access" to true),origin,account) }
        denied { OwnAccountControls.referenceRequest(reference+mapOf("request" to "not-a-request"),origin,account) }
    }
    @Test fun anUnconfirmedOwnWithdrawalBlocksCaptureButAForeignChildRequestGrantsNothing() {
        val own=mapOf("origin" to origin,"account" to account,"child" to account)
        assertTrue(OwnAccountControls.withdrawalBlocksOwn(own,origin,account))
        assertTrue(OwnAccountControls.withdrawalBlocksOwn(own-"child",origin,account))
        assertFalse(OwnAccountControls.withdrawalBlocksOwn(own+mapOf("child" to id(3)),origin,account))
        assertFalse(OwnAccountControls.withdrawalBlocksOwn(own,"https://other.test",account))
        assertFalse(OwnAccountControls.withdrawalBlocksOwn(own,origin,id(9)))
    }
    @Test fun conflictAndAmbiguityKeepTheSameSavedAudienceRequest() {
        assertTrue(OwnAccountControls.retainAudienceFailure(LiveFailure("operation_key_conflict",409)))
        assertTrue(OwnAccountControls.retainAudienceFailure(LiveFailure("connection_unavailable",ambiguous=true)))
        assertTrue(OwnAccountControls.retainAudienceFailure(LiveFailure("server_unavailable",503)))
        assertTrue(OwnAccountControls.retainAudienceFailure(LiveFailure("audience_response_invalid")))
        assertFalse(OwnAccountControls.retainAudienceFailure(LiveFailure("audience_version_changed",409)))
    }
}
