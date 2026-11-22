package com.lovelies.frontend.preview

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

/** Real repository and protected-storage port; every network/provider is a
 * deterministic fake. No test treats issuance as content or external success. */
class DownloadOperationRecoveryTest {
    private val origin="https://synthetic.invalid"
    private val account="00000000-0000-4000-8000-000000000091"
    private val session="00000000-0000-4000-8000-000000000092"
    private val device="00000000-0000-4000-8000-000000000093"
    private val asset="00000000-0000-4000-8000-000000000094"
    private val other="00000000-0000-4000-8000-000000000095"
    private val photo=LivePhoto(asset,"source-r7","received","personal","Synthetic",1,1)
    private val jpeg=byteArrayOf(0xff.toByte(),0xd8.toByte(),0xff.toByte(),1,2,3,4)
    private fun receipt(op: DownloadOperation,status: String="recorded",now: Long=System.currentTimeMillis()): WireObject =
        mapOf("protocol" to DownloadProtocol.RECEIPT,"status" to status,"account_id" to op.account,"operation_key" to op.key,
            "original_session_id" to op.session,"asset_id" to op.asset,"source_version" to op.version)+
            if(status=="recorded")mapOf("created_at" to now,"expires_at" to now+120_000) else emptyMap()
    private fun content()=DownloadContent(jpeg.copyOf(),mapOf("content-type" to "image/jpeg","content-length" to jpeg.size.toString(),
        "x-lovelies-source-version" to photo.version,"x-lovelies-content-sha256" to NativeProtocol.sha256(jpeg)))
    private fun operation()=DownloadOperation.create(origin,account,session,device,photo,false,System.currentTimeMillis()+3_600_000)
    private fun failure(code: String,block: ()->Unit) {
        try { block();fail("Expected $code") } catch(problem: LiveFailure) { assertEquals(code,problem.code) }
    }
    private class Disk(initial: WireObject): RepositoryVault {
        var value=initial
        var beforeSave: ((WireObject)->Unit)?=null
        var afterSave: ((WireObject)->Unit)?=null
        var failStage=false
        var duringStage: (()->Unit)?=null
        val files=mutableMapOf<String,Triple<String,String,ByteArray>>()
        override fun load()=value.toMap()
        override fun save(value: WireObject) { beforeSave?.invoke(value);this.value=value.toMap();afterSave?.invoke(value) }
        override fun stageOriginal(account: String,session: String,id: String,bytes: ByteArray) {
            duringStage?.invoke();if(failStage)throw LiveFailure("download_staging_unavailable",503,true)
            files[id]=Triple(account,session,bytes.copyOf())
        }
        override fun stagedOriginal(account: String,session: String,id: String): ByteArray {
            val held=files[id] ?: throw LiveFailure("download_staging_unavailable",503,true)
            check(held.first==account && held.second==session);return held.third.copyOf()
        }
        override fun removeStagedOriginal(id: String) { files.remove(id)?.third?.fill(0) }
    }
    private inner class Fixture(initial: WireObject=emptyMap(),val sessionID: String=session,val owner: String=account,val disk: Disk=Disk(initial)) {
        private val originalExpiry=((disk.value["download_operation"] ?: disk.value["download_uncertainty"]) as? Map<*,*>)?.get("session_expires") as? Long
        val actor=LiveCredentials(owner,"synthetic-$sessionID","synthetic-refresh","registered_face",originalExpiry ?: (System.currentTimeMillis()+3_600_000),emptyMap())
        val calls=mutableListOf<Pair<String,WireObject>>()
        val receipts=mutableMapOf<String,WireObject>()
        val signPhases=mutableListOf<String>()
        var loseSign=false;var unknownStatus=false;var notIssued=false;var failContent=false
        var modifyContent: ((DownloadContent)->DownloadContent)?=null
        var duringContent: (()->Unit)?=null
        var beforeWrite: (()->Unit)?=null
        init { disk.value=disk.value+mapOf("device" to mapOf("account" to owner,"alias" to "synthetic-alias","handle" to "synthetic-handle","device" to device)) }
        val repo=CloudflareRepository(origin,RepositoryBoundary(disk,{path,_,_,_,_,_->
            when(path) { "/me"->mapOf("authenticated" to true);"/me/photo-preferences"->mapOf("updated" to true);else->error("Unexpected generic boundary $path") }
        },initialStorage=disk.load(),initialSession=actor,initialPending=(disk.value["pending"] as? Map<*,*>)?.let { StoreRecoveryRetention.restorePending(it) },
            beforeJsonWrite={beforeWrite?.invoke()},decodedClaims={token->
                assertEquals(actor.token,token);mapOf("jti" to sessionID,"sub" to owner,"auth_method" to "registered_face")
            },headerJson={path,scope,bearer,method,body,expected,headers->
                assertEquals(owner,scope.accountId);assertEquals(actor.token,bearer);assertEquals("POST",method);assertEquals(200,expected)
                val held=DownloadOperation.restore(disk.value["download_operation"] ?: disk.value["download_uncertainty"],origin)
                assertEquals(held.input(),body);assertEquals(held.headers(),headers);assertFalse(path.contains(held.capability));calls.add(path to body!!)
                when(path) {
                    "/downloads/v2/sign"->{
                        signPhases.add(held.phase)
                        val result=receipts.getOrPut(held.key) { receipt(held,if(notIssued)"not_issued" else "recorded") }
                        if(loseSign)throw LiveFailure("connection_unavailable",ambiguous=true)
                        result
                    }
                    "/downloads/v2/status"->{
                        if(unknownStatus)throw LiveFailure("download_operation_outcome_unresolved",503,true)
                        receipts.getOrPut(held.key) { receipt(held,if(notIssued)"not_issued" else "recorded") }
                    }
                    else->error("Unexpected typed boundary $path")
                }
            },downloadContent={path,scope,bearer,body,headers->
                val held=DownloadOperation.restore(disk.value["download_operation"],origin)
                assertEquals("/downloads/v2/content",path);assertEquals(held.input(),body);assertEquals(held.headers(),headers)
                assertEquals(owner,scope.accountId);assertEquals(actor.token,bearer);calls.add(path to body)
                duringContent?.invoke();if(failContent)throw LiveFailure("connection_unavailable",ambiguous=true)
                content().let { modifyContent?.invoke(it) ?: it }
            }))
        suspend fun ready() { repo.bootstrap();calls.clear() }
        fun held()=DownloadOperation.restore(disk.value["download_uncertainty"] ?: disk.value["download_operation"],origin)
        fun restart(newSession: String=sessionID): Fixture=Fixture(sessionID=newSession,owner=owner,disk=disk).also { it.receipts.putAll(receipts) }
    }
    @Test fun capabilityAndExactOriginalContextSurviveProtectedRoundTripWithoutURLSecrets() {
        val op=operation();assertEquals(op,DownloadOperation.restore(op.wire(),origin))
        assertEquals(5,op.input().size);assertFalse(NativeProtocol.canonical(op.input()).contains(op.capability));assertFalse(op.toString().contains(op.capability))
        assertEquals(32,java.util.Base64.getUrlDecoder().decode(op.capability.removePrefix("lvd_v2_")).size)
        assertNotEquals(op.capability,operation().capability);assertNotEquals(op.key,operation().key)
        failure("download_operation_outcome_unresolved") { DownloadOperation.restore(op.wire()+mapOf("capability" to op.capability+"="),origin) }
        failure("download_operation_outcome_unresolved") { DownloadOperation.restore(op.wire()+mapOf("origin" to "https://other.invalid"),origin) }
    }
    @Test fun everyReceiptIdentityFieldDatesAndUnexpectedSecretAreRejected() {
        val op=operation();val valid=receipt(op)
        for((key,value) in listOf("protocol" to "v1","account_id" to other,"operation_key" to "different-key-value","original_session_id" to other,
            "asset_id" to other,"source_version" to "source-r8","status" to "unknown","created_at" to -1L,"expires_at" to 1L,"download_url" to "https://other.invalid")) {
            try { op.receipt(valid+mapOf(key to value));fail("Accepted substituted $key") } catch(_: LiveFailure) {}
        }
        val committed=op.receipt(valid)
        failure("download_operation_outcome_unresolved") { committed.receipt(valid+mapOf("expires_at" to ((valid["expires_at"] as Long)+1))) }
        failure("download_operation_outcome_unresolved") { committed.receipt(receipt(op,"not_issued")) }
        failure("download_operation_outcome_unresolved") { op.receipt(receipt(op,"not_issued")+mapOf("created_at" to 0)) }
    }
    @Test fun contentRequiresExactVersionDigestLengthTypeAndTwentyMiBBound() {
        val op=operation()
        op.verified(content())
        for(change in listOf(mapOf("x-lovelies-source-version" to "other"),mapOf("x-lovelies-content-sha256" to "a".repeat(64)),
            mapOf("content-length" to "999"),mapOf("content-type" to "image/png"))) {
            failure("download_content_invalid") { op.verified(content().let { it.copy(headers=it.headers+change) }) }
        }
        failure("download_content_invalid") { op.verified(content().copy(headers=emptyMap())) }
        failure("download_content_invalid") { op.verified(DownloadContent(ByteArray(DownloadProtocol.MAX_BYTES+1),content().headers)) }
        failure("download_authority_changed") { NativeProtocol.downloadSession(mapOf("sub" to other,"jti" to session,"auth_method" to "registered_face"),account) }
        failure("download_authority_changed") { NativeProtocol.downloadSession(mapOf("sub" to account,"jti" to session.uppercase(),"auth_method" to "anonymous"),account) }
    }
    @Test fun lostSignReplyThenProcessDeathUsesOriginalStatusContentAndNoResign()=runBlocking {
        val f=Fixture();f.ready();f.loseSign=true;f.unknownStatus=true
        failure("download_operation_outcome_unresolved") { runBlocking { f.repo.original(photo) } }
        val original=f.held();assertEquals("signing",original.phase);assertTrue(f.disk.files.isEmpty())
        val restarted=f.restart();restarted.ready();val result=restarted.repo.original(photo)
        assertEquals(original.key,result.key);assertEquals(original.capability,result.capability);assertEquals("staged",result.phase)
        assertEquals(listOf("/downloads/v2/status","/downloads/v2/content"),restarted.calls.map { it.first })
    }
    @Test fun restartBeforeSigningDispatchesTheExactPersistedIntentOnceWithoutInventingPriorIssuance()=runBlocking {
        val original=operation()
        val f=Fixture(mapOf("download_operation" to original.wire()));f.ready();f.unknownStatus=true
        assertTrue(f.receipts.isEmpty())
        val staged=f.repo.original(photo)
        assertEquals(original.key,staged.key);assertEquals(original.capability,staged.capability)
        assertEquals(listOf("signing"),f.signPhases)
        assertEquals(listOf("/downloads/v2/sign","/downloads/v2/content"),f.calls.map { it.first })
        val restarted=f.restart();restarted.ready();val recovered=restarted.repo.original(photo)
        assertEquals(original.key,recovered.key);assertEquals(original.capability,recovered.capability)
        assertTrue(restarted.signPhases.isEmpty());assertEquals(listOf("/downloads/v2/status","/downloads/v2/content"),restarted.calls.map { it.first })
    }
    @Test fun persistedSigningWithoutAConfirmedResultNeverDispatchesAgain()=runBlocking {
        val original=operation().copy(phase="signing")
        val f=Fixture(mapOf("download_operation" to original.wire()));f.ready();f.unknownStatus=true
        assertTrue(f.receipts.isEmpty())
        failure("download_operation_outcome_unresolved") { runBlocking { f.repo.original(photo) } }
        assertEquals(original.key,f.held().key);assertEquals(original.capability,f.held().capability)
        assertTrue(f.signPhases.isEmpty());assertEquals(listOf("/downloads/v2/status"),f.calls.map { it.first })
    }
    @Test fun committedIssuanceIsNeverReportedAsContentOrSaveAndContentFailureKeepsExactIntent()=runBlocking {
        val f=Fixture();f.ready();f.failContent=true
        failure("connection_unavailable") { runBlocking { f.repo.original(photo) } }
        val held=f.held();assertEquals("content_started",held.phase);assertTrue(f.disk.files.isEmpty())
        f.failContent=false;val result=f.repo.original(photo);assertEquals(held.key,result.key)
        assertEquals(1,f.calls.count { it.first=="/downloads/v2/sign" });assertEquals("staged",f.held().phase)
    }
    @Test fun notIssuedDoesNotReplayAndPurchaseContinuationCannotCreateANewIntent()=runBlocking {
        val f=Fixture();f.ready();f.notIssued=true
        failure("download_not_issued") { runBlocking { f.repo.original(photo) } }
        val old=f.held();f.calls.clear()
        failure("download_requires_explicit_action") { runBlocking { f.repo.original(photo,resumeOnly=true) } }
        assertTrue(f.calls.isEmpty());assertFalse(f.repo.canResumeOriginal(photo,false))
        f.notIssued=false;val next=f.repo.original(photo)
        assertNotEquals(old.key,next.key);assertNotEquals(old.capability,next.capability)
    }
    @Test fun unresolvedIntentBeforeDispatchNeverLeavesProtectedStorageOrSendsSign()=runBlocking {
        val f=Fixture();f.ready();f.disk.beforeSave={value->if(value.containsKey("download_operation"))throw LiveFailure("synthetic-disk-full")}
        failure("download_storage_unavailable") { runBlocking { f.repo.original(photo) } }
        assertTrue(f.calls.isEmpty());assertNotNull(f.repo.saved("download_uncertainty"))
        f.disk.beforeSave=null;f.repo.authenticationLost()
        assertNotNull(f.disk.value["download_uncertainty"])
    }
    @Test fun stageFailureAndStagedCommitLossPreserveExactRecoverableContentIntent()=runBlocking {
        for(afterWrite in listOf(false,true)) {
            val f=Fixture();f.ready()
            if(afterWrite)f.disk.afterSave={value->if((value["download_operation"] as? Map<*,*>)?.get("phase")=="staged")throw LiveFailure("synthetic-lost-storage-ack")}
            else f.disk.failStage=true
            failure(if(afterWrite)"download_storage_unavailable" else "download_staging_unavailable") { runBlocking { f.repo.original(photo) } }
            val original=f.held();f.disk.afterSave=null;f.disk.failStage=false
            val restarted=f.restart();restarted.ready();assertEquals(original.key,restarted.repo.original(photo).key)
            assertEquals(0,restarted.calls.count { it.first=="/downloads/v2/sign" })
        }
    }
    @Test fun interruptedExternalEffectNeverRepeatsAfterRestartOrThroughOriginalAction()=runBlocking {
        val f=Fixture();f.ready();val staged=f.repo.original(photo);var effects=0
        try { f.repo.performOriginalEffect(staged.key) { effects++;throw java.io.IOException("Synthetic unknown provider result") };fail("Expected interruption") } catch(_: java.io.IOException) {}
        assertEquals("effect_started",f.held().phase);assertEquals(1,effects)
        val restarted=f.restart();restarted.ready()
        failure("download_external_outcome_unresolved") { runBlocking { restarted.repo.performOriginalEffect(staged.key) { effects++ } } }
        failure("download_external_outcome_unresolved") { runBlocking { restarted.repo.original(photo) } }
        assertEquals(1,effects);assertTrue(restarted.calls.isEmpty())
    }
    @Test fun effectRevalidatesActualContentBeforeFirstProviderCallAndCommitsOnlyItsAcknowledgement()=runBlocking {
        val f=Fixture();f.ready();val staged=f.repo.original(photo);f.calls.clear();var calls=0
        f.repo.performOriginalEffect(staged.key) { bytes->
            assertArrayEquals(jpeg,bytes);assertEquals("effect_started",f.held().phase);assertEquals("/downloads/v2/content",f.calls.last().first);calls++
        }
        assertEquals(1,calls);assertEquals("effect_completed",f.held().phase);assertTrue(f.disk.files.isEmpty())
        failure("download_staging_unavailable") { runBlocking { f.repo.performOriginalEffect(staged.key) { calls++ } } };assertEquals(1,calls)
    }
    @Test fun effectCommitAcknowledgementLossKeepsAmbiguityWithoutRepeatingProvider()=runBlocking {
        val f=Fixture();f.ready();val staged=f.repo.original(photo);var calls=0
        f.disk.afterSave={value->if((value["download_operation"] as? Map<*,*>)?.get("phase")=="effect_completed")throw LiveFailure("synthetic-ack-loss")}
        failure("download_storage_unavailable") { runBlocking { f.repo.performOriginalEffect(staged.key) { calls++ } } }
        assertEquals(1,calls);assertEquals("effect_started",DownloadOperation.restore(f.repo.saved("download_uncertainty"),origin).phase)
        failure("download_external_outcome_unresolved") { runBlocking { f.repo.performOriginalEffect(staged.key) { calls++ } } };assertEquals(1,calls)
    }
    @Test fun changedAuthorityOrCorruptStagingNeverReachesProvider()=runBlocking {
        for(reason in listOf("content","foreground","session","staging")) {
            val f=Fixture();f.ready();val staged=f.repo.original(photo);var effects=0;var foreground=true
            when(reason) {
                "content"->f.modifyContent={it.copy(headers=it.headers+mapOf("x-lovelies-source-version" to "changed"))}
                "foreground"->f.duringContent={foreground=false}
                "session"->f.duringContent={f.repo.invalidateReads()}
                "staging"->f.disk.files[staged.stage]!!.third[3]=99
            }
            try { f.repo.performOriginalEffect(staged.key,{if(!foreground)throw LiveFailure("download_authority_changed")}) { effects++ };fail("Accepted changed $reason") } catch(_: LiveFailure) {}
            assertEquals(0,effects);assertNotEquals("effect_started",f.held().phase)
        }
    }
    @Test fun renewedSessionCanInspectButCannotRedeemOriginalSessionOrSilentlySign()=runBlocking {
        val f=Fixture();f.ready();val staged=f.repo.original(photo)
        val renewed=f.restart(other);renewed.ready();assertEquals(staged.key,renewed.repo.recoverOriginalIssuance()!!.key)
        failure("download_authority_changed") { runBlocking { renewed.repo.performOriginalEffect(staged.key) { fail("Renewed session redeemed content") } } }
        failure("download_authority_changed") { runBlocking { renewed.repo.original(photo) } }
        assertTrue(renewed.calls.all { it.first=="/downloads/v2/status" })
        assertEquals(staged.key,DownloadOperation.restore(NativeProtocol.rows(renewed.disk.value["download_history"]).single(),origin).key)
    }
    @Test fun legacyAdoptionIsDurableBeforeSlotReleaseAndNeverGainsV2Proof()=runBlocking {
        val legacy=PendingIntent(account,"media","download.sign","android-legacy-download-key",mapOf("asset_id" to asset,"operation_key" to "android-legacy-download-key"),"/downloads/sign")
        val f=Fixture(mapOf("pending" to legacy.wire()));var heldBeforeRelease=false
        f.disk.beforeSave={candidate->
            if(!candidate.containsKey("pending")) { assertEquals(legacy.wire(),f.disk.value["download_legacy"]);heldBeforeRelease=true }
        }
        f.ready();assertTrue(heldBeforeRelease);assertNull(f.repo.pending);assertEquals(legacy.wire(),f.disk.value["download_legacy"])
        failure("download_legacy_outcome_unresolved") { runBlocking { f.repo.original(photo) } };assertTrue(f.calls.isEmpty())
        f.repo.mutate("photo.preferences",mapOf("enabled" to false),"account",path="/me/photo-preferences")
        assertEquals(legacy.wire(),f.disk.value["download_legacy"])
    }
    @Test fun uncertainLegacyAdoptionRetainsGenericSlotAndOriginalPayload()=runBlocking {
        val legacy=PendingIntent(account,"media","download.sign","android-legacy-download-key",mapOf("asset_id" to asset,"operation_key" to "android-legacy-download-key"),"/downloads/sign")
        for(afterWrite in listOf(false,true)) {
            val f=Fixture(mapOf("pending" to legacy.wire()))
            val reject: (WireObject)->Unit={if(it.containsKey("download_legacy"))throw LiveFailure("synthetic-storage-fault")}
            if(afterWrite)f.disk.afterSave=reject else f.disk.beforeSave=reject
            failure("download_storage_unavailable") { runBlocking { f.ready() } }
            assertEquals(legacy.wire(),f.disk.value["pending"]);assertEquals(legacy,f.repo.pending);assertTrue(f.calls.isEmpty())
        }
    }
    @Test fun accountCleanupRetiresBytesAndRetainsUnknownMetadataAlongsidePushEvidence()=runBlocking {
        val f=Fixture();f.ready();val staged=f.repo.original(photo)
        val evidence=f.disk.value+mapOf("push_operation_legacy" to mapOf("unknown" to "retained"))
        assertEquals(staged.wire(),StoreRecoveryRetention.keep(evidence,emptyMap())["download_operation"])
        assertEquals(evidence["push_operation_legacy"],StoreRecoveryRetention.keep(evidence,emptyMap())["push_operation_legacy"])
        f.repo.authenticationLost();assertTrue(f.disk.files.isEmpty());assertEquals(staged.wire(),f.disk.value["download_operation"])
    }
    @Test fun expiredStagingIsRetiredWhileExactMinimalOperationEvidenceRemains()=runBlocking {
        val f=Fixture();f.ready();val staged=f.repo.original(photo)
        assertTrue(f.disk.files.containsKey(staged.stage))
        f.repo.retireOriginalStaging(staged.expiresAt!!)
        assertTrue(f.disk.files.isEmpty());assertEquals(staged.wire(),f.disk.value["download_operation"])
    }
    @Test fun archivedAmbiguousEffectStillBlocksTheSameAssetAfterAnAccountChange()=runBlocking {
        val f=Fixture();f.ready();val staged=f.repo.original(photo)
        try { f.repo.performOriginalEffect(staged.key) { throw java.io.IOException("Synthetic interrupted external effect") } } catch(_: java.io.IOException) {}
        val changed=Fixture(sessionID=other,owner=other,disk=f.disk);changed.ready();changed.repo.original(photo)
        val returned=Fixture(disk=f.disk);returned.ready()
        failure("download_external_outcome_unresolved") { runBlocking { returned.repo.original(photo) } }
        assertTrue(returned.calls.isEmpty())
        assertEquals(staged.key,DownloadOperation.restore(NativeProtocol.rows(returned.disk.value["download_history"]).first(),origin).key)
    }
    @Test fun archivedUncertainIssuanceReturnsToItsOriginalKeyRatherThanFreshSigning()=runBlocking {
        val f=Fixture();f.ready();f.loseSign=true;f.unknownStatus=true
        failure("download_operation_outcome_unresolved") { runBlocking { f.repo.original(photo) } };val original=f.held()
        val changed=Fixture(sessionID=other,owner=other,disk=f.disk);changed.ready();changed.repo.original(photo)
        val returned=Fixture(disk=f.disk);returned.receipts.putAll(f.receipts);returned.ready()
        val recovered=returned.repo.original(photo)
        assertEquals(original.key,recovered.key);assertEquals(original.capability,recovered.capability)
        assertEquals(listOf("/downloads/v2/status","/downloads/v2/content"),returned.calls.map { it.first })
    }
}
