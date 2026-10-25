package com.lovelies.frontend.preview

import org.junit.Assert.*
import org.junit.Test

/** Strong own-profile authority is separate from an eligible audience or a weak privacy session. */
class LocalCollectionAuthorityTest {
    private val now=10_000L
    private val account="00000000-0000-4000-8000-000000000001"
    private val other="00000000-0000-4000-8000-000000000002"
    private val scope=SessionScope(7,account)
    private val actor=LiveCredentials(account,"private-session-token","refresh","registered_face",now+60_000,emptyMap())
    private val profile: WireObject=mapOf("user_id" to account,"name" to "Jean","profile_scope" to "registered_face_profile")
    private fun audience(band: String="18_plus",status: String="eligible",auth: Boolean=true,processing: Boolean=true,request: GuardianRequest?=null)=
        AudienceState(account,band,status,2,null,mapOf("face_authentication" to auth,"photo_matching" to false,"photo_processing" to processing),request)
    private fun authority(permission: AudienceState=audience())=LocalCollectionAuthority.parse(profile,permission,scope,actor,now)
    private fun rejected(block: ()->Unit) {
        try { block();fail("Expected local photo collection to remain closed") } catch(expected: LiveFailure) { }
    }
    @Test fun strongOwnProfileAndCurrentPurposesBindTheNextCollectionStep() {
        val permit=authority()
        permit.assertCurrent(scope,actor,now)
        assertEquals(account,permit.account)
        assertFalse(permit.audience.allows("photo_matching",now))
        assertFalse(permit.toString().contains(actor.token))
    }
    @Test fun weakMeOrAudienceProjectionCannotSubstituteForStrongProfileRead() {
        val weakMe: WireObject=mapOf("authenticated" to true,"user_id" to account,"auth_method" to "registered_face","name" to "Jean")
        rejected { LocalCollectionAuthority.parse(weakMe,audience(),scope,actor,now) }
        rejected { LocalCollectionAuthority.parse(mapOf("account_id" to account,"capabilities" to audience().capabilities),audience(),scope,actor,now) }
        rejected { LocalCollectionAuthority.parse(profile-"profile_scope",audience(),scope,actor,now) }
        rejected { LocalCollectionAuthority.parse(profile+mapOf("profile_scope" to "own_privacy"),audience(),scope,actor,now) }
    }
    @Test fun anotherAccountOrMalformedProfileNeverAuthorizesCollection() {
        rejected { LocalCollectionAuthority.parse(profile+mapOf("user_id" to other),audience(),scope,actor,now) }
        rejected { LocalCollectionAuthority.parse(profile+mapOf("name" to null),audience(),scope,actor,now) }
        rejected { LocalCollectionAuthority.parse(profile+mapOf("name" to 7),audience(),scope,actor,now) }
        rejected { LocalCollectionAuthority.parse(profile,audience().copy(account=other),scope,actor,now) }
        rejected { LocalCollectionAuthority.parse(profile,audience(),scope.copy(accountId=other),actor,now) }
    }
    @Test fun sessionEpochTokenMethodOrAccountChangesInvalidateThePermit() {
        val permit=authority()
        rejected { permit.assertCurrent(scope.copy(epoch=8),actor,now) }
        rejected { permit.assertCurrent(scope.copy(accountId=other),actor,now) }
        rejected { permit.assertCurrent(scope,actor.copy(token="replacement-token"),now) }
        rejected { permit.assertCurrent(scope,actor.copy(method="anonymous"),now) }
        rejected { permit.assertCurrent(scope,actor.copy(account=other),now) }
        rejected { permit.assertCurrent(scope,null,now) }
    }
    @Test fun unknownAgeAndIndependentPurposeDenialsCannotOpenPersonalCollection() {
        rejected { authority(audience("unknown","unknown",false,false)) }
        rejected { authority(audience("under13","blocked",false,false)) }
        rejected { authority(audience("13_17","guardian_pending",false,false)) }
        rejected { authority(audience(auth=false)) }
        rejected { authority(audience(processing=false)) }
        rejected { authority(audience(status="suspended")) }
    }
    @Test fun minorApprovalForAuthenticationAloneDoesNotGrantPhotoProcessing() {
        val guardian=GuardianRequest(other,account,"approved",2,now+60_000,
            mapOf("face_authentication" to true,"photo_matching" to false,"photo_processing" to false))
        rejected { authority(audience("13_17",request=guardian)) }
        val permitted=guardian.copy(purposes=guardian.purposes+mapOf("photo_processing" to true))
        val permit=authority(audience("13_17",request=permitted))
        permit.assertCurrent(scope,actor,now)
        rejected { permit.assertCurrent(scope,actor.copy(expires=now+120_000),now+60_000) }
    }
    @Test fun tokenExpiryAndAudienceReviewExpiryRemainClosedAtUseTime() {
        val permit=authority()
        rejected { permit.assertCurrent(scope,actor,actor.expires) }
        rejected { LocalCollectionAuthority.parse(profile,audience(),scope,actor.copy(expires=now),now) }
        val reviewed=authority(audience().copy(nextReview=now+1_000))
        rejected { reviewed.assertCurrent(scope,actor,now+1_000) }
    }
}
