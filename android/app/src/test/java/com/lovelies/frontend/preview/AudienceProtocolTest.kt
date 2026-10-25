package com.lovelies.frontend.preview

import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

/** Permission responses never establish identity, subject consent or a media grant. */
class AudienceProtocolTest {
    private val now=10_000L
    private fun id(n: Int)="00000000-0000-4000-8000-%012d".format(n)
    private fun date(offset: Long=60_000)=Instant.ofEpochMilli(now+offset).toString()
    private fun flags(auth: Boolean=false,matching: Boolean=false,processing: Boolean=false): WireObject =
        mapOf("face_authentication" to auth,"photo_matching" to matching,"photo_processing" to processing)
    private fun request(state: String="approved",choices: WireObject=flags(auth=true)): WireObject=mapOf(
        "id" to id(2),"child_account_id" to id(1),"state" to state,"revision" to 2,
        "policy_version" to AudienceProtocol.POLICY,"created_at" to date(-1_000),"expires_at" to date(),"purposes" to choices)
    private fun projection(band: String="unknown",status: String="unknown",choices: WireObject=flags(),guardian: WireObject?=null): WireObject=mapOf(
        "protocol" to AudienceProtocol.PROTOCOL,"policy_version" to AudienceProtocol.POLICY,"account_id" to id(1),
        "audience" to mapOf("age_band" to band,"status" to status,"version" to if(band=="unknown")0 else 1,
            "policy_version" to if(band=="unknown")null else AudienceProtocol.POLICY,"next_review_at" to if(band=="13_17")date() else null),
        "guardian_request" to guardian,"capabilities" to choices)
    private fun rejected(block: ()->Unit) {
        try { block();fail("Expected closed permission parsing") } catch(expected: LiveFailure) { }
    }
    @Test fun missingOrUnknownAgeNeverDefaultsToAdultOrCameraPermission() {
        val unknown=AudienceState.parse(projection(),id(1))
        assertEquals("unknown",unknown.band)
        AudienceProtocol.purposes.forEach { assertFalse(unknown.allows(it,now)) }
        rejected { AudienceState.parse(projection()-"audience",id(1)) }
        rejected { AudienceState.parse(projection(choices=flags(auth=true)),id(1)) }
        rejected { AudienceState.parse(projection()+mapOf("account_id" to id(9)),id(1)) }
    }
    @Test fun under13AndPendingMinorRemainClosedForEveryPurpose() {
        listOf(projection("under13","blocked"),projection("13_17","guardian_pending",guardian=request("pending",flags()))).forEach { value ->
            val state=AudienceState.parse(value,id(1))
            AudienceProtocol.purposes.forEach { assertFalse(state.allows(it,now)) }
        }
        rejected { AudienceState.parse(projection("under13","eligible",flags(auth=true)),id(1)) }
        rejected { AudienceState.parse(projection("13_17","guardian_pending",flags(auth=true),request("pending",flags())),id(1)) }
    }
    @Test fun approvedMinorPurposesStaySeparateAndExpireWithoutRestoringOtherAccess() {
        val state=AudienceState.parse(projection("13_17","eligible",flags(auth=true),request()),id(1))
        assertTrue(state.allows("face_authentication",now))
        assertFalse(state.allows("photo_matching",now));assertFalse(state.allows("photo_processing",now))
        assertFalse(state.allows("face_authentication",now+60_000))
        assertFalse(state.allows("download_photos",now))
        rejected { AudienceState.parse(projection("13_17","eligible",flags(auth=true),null),id(1)) }
        rejected { AudienceState.parse(projection("13_17","eligible",flags(auth=true),request()+mapOf("child_account_id" to id(8))),id(1)) }
    }
    @Test fun malformedPolicyFlagsAndStalePendingApprovalsCannotAuthorize() {
        rejected { AudienceState.parse(projection()+mapOf("policy_version" to "old"),id(1)) }
        rejected { AudienceState.parse(projection()+mapOf("capabilities" to flags()+mapOf("face_authentication" to "true")),id(1)) }
        rejected { AudienceState.parse(projection()+mapOf("capabilities" to flags()+mapOf("photo_access" to true)),id(1)) }
        rejected { AudienceState.parse(projection("13_17","eligible",flags(auth=true),request("under_review",flags(auth=true))),id(1)) }
        val adult=AudienceState.parse(projection("18_plus","eligible",flags(auth=true,matching=true,processing=true)),id(1))
        assertTrue(adult.allows("photo_processing",now));assertFalse(adult.allows("identity_verified",now))
    }
    private fun challenge(): WireObject {
        val value=mapOf("account_id" to id(1),"device_id" to id(3),"challenge_id" to id(4),"purpose" to "login","expires_at" to date())
        return value+mapOf("audience_authority" to (value+mapOf("protocol" to "lovelies-audience-challenge-v1","policy_version" to AudienceProtocol.POLICY,"audience_version" to 7)))
    }
    @Test fun loggedOutCaptureAuthorityIsBoundToExactlyOneTargetChallengeAndPurpose() {
        val challenge=challenge();AudienceProtocol.captureAuthority(challenge,now)
        for(key in listOf("account_id","device_id","challenge_id")) {
            val changed=NativeProtocol.obj(challenge["audience_authority"])+mapOf(key to id(9))
            rejected { AudienceProtocol.captureAuthority(challenge+mapOf("audience_authority" to changed),now) }
        }
        rejected { AudienceProtocol.captureAuthority(challenge+mapOf("purpose" to "registration"),now) }
        rejected { AudienceProtocol.captureAuthority(challenge-"audience_authority",now) }
        // A capture authority is deliberately not a full audience projection or product permission.
        rejected { AudienceState.parse(NativeProtocol.obj(challenge["audience_authority"]),id(1)) }
    }
    @Test fun captureAuthorityCannotOutliveChallengeOrUseAnOldPolicyOrZeroVersion() {
        val challenge=challenge();val original=NativeProtocol.obj(challenge["audience_authority"])
        listOf(mapOf("expires_at" to date(60_001)),mapOf("expires_at" to date(0)),mapOf("policy_version" to "old"),mapOf("audience_version" to 0)).forEach { delta ->
            rejected { AudienceProtocol.captureAuthority(challenge+mapOf("audience_authority" to (original+delta)),now) }
        }
        rejected { AudienceProtocol.operationKey("short") }
        rejected { AudienceProtocol.operationKey("unsafe/key-with-slash") }
        assertEquals("android-audience-operation-0001",AudienceProtocol.operationKey("android-audience-operation-0001"))
    }
}
