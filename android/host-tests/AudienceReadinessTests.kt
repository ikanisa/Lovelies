package com.lovelies.frontend.preview

import java.time.Instant
import kotlinx.coroutines.runBlocking

private const val a="00000000-0000-4000-8000-000000000601"
private const val b="00000000-0000-4000-8000-000000000602"
private const val d="00000000-0000-4000-8000-000000000603"
private const val g="00000000-0000-4000-8000-000000000604"
private const val origin="https://audience-native-fixture.invalid"
private const val alias="lovelies.device.audience-fixture"
private const val policy="face-fixture-current-v1"
private val device=DeviceIdentity(a,alias,"lfh_"+"a".repeat(43),d)
private val jwk:WireObject=mapOf("kty" to "EC","crv" to "P-256","x" to "x".repeat(43),"y" to "y".repeat(43),"ext" to true,"key_ops" to listOf("verify"))
private fun iso(value:Long)=Instant.ofEpochMilli(value).toString()
private fun flags(enabled:Boolean)=AudienceProtocol.purposes.associateWith { enabled }
private fun decision(minor:Boolean=false,version:Long=1,expired:Boolean=false,known:Boolean=true,under13:Boolean=false,now:Long=System.currentTimeMillis()):WireObject=mapOf(
    "at_least_13" to if(known)!under13 else null,"guardian_required" to if(known)minor else null,
    "status" to if(!known)"unknown" else if(under13)"blocked" else if(minor)"guardian_pending" else if(expired)"suspended" else "eligible",
    "version" to if(known)version else 0,"policy_version" to if(known)AudienceProtocol.POLICY else null,
    "source" to if(known)"self_declaration" else null,"rule_version" to if(known)"audience-13-plus-guardian-v1" else null,
    "territory" to if(known)"global" else null,"declared_at" to if(known)iso(now-60_000) else null,
    "next_review_at" to if(known)iso(now+if(expired)-1_000 else 86_400_000) else null,"review_required" to (known && expired))
private fun projection(value:WireObject=decision(),enabled:Boolean=true,guardian:WireObject?=null,authority:Long?=System.currentTimeMillis()+60_000):WireObject=mapOf(
    "protocol" to AudienceProtocol.PROTOCOL,"policy_version" to AudienceProtocol.POLICY,"account_id" to a,
    "audience" to value,"guardian_request" to guardian,"capabilities" to flags(enabled),"authority_expires_at" to if(enabled)authority?.let(::iso) else null)
private class AudienceVault:RepositoryVault {
    private var authority:WireObject?=null
    override fun loadAuthority()=authority
    override fun saveAuthority(value:WireObject) { authority=value }

    var value:WireObject=mapOf("device" to device.wire());var rejectWrite=false;var failClear=false;var keyMissing=false;var failTerminal=false
    val signatures=mutableListOf<WireObject>();val deleted=mutableListOf<String>();var afterSign:(()->Unit)?=null
    override fun load()=value
    override fun save(value:WireObject) { if(rejectWrite || failTerminal && value["audience_terminal_operations"]!=null || failClear && this.value["audience_device_renewals"]!=null && value["audience_device_renewals"]==null)throw LiveFailure("fixture_storage_failure");this.value=value }
    override fun existingDevice(alias:String):WireObject { check(alias==com.lovelies.frontend.preview.alias);if(keyMissing)throw LiveFailure("device_key_unavailable");return jwk }
    override fun sign(alias:String,envelope:WireObject):String { existingDevice(alias);signatures+=envelope;afterSign?.invoke();return "s".repeat(86) }
    override fun deleteDevice(alias:String?) { alias?.let(deleted::add) }
}
private class AudienceFixture {
    val vault=AudienceVault();val calls=mutableListOf<Pair<String,WireObject?>>()
    var current=decision(expired=true);var currentGuardian:WireObject?=null;var nextStep="audience_review"
    var loseMutation=false;var rejectPolicy=false;var servedPolicy=policy;var corrupt:String?=null;var beforeReturn:(()->Unit)?=null
    var mutationFailure:LiveFailure?=null
    val receipts=linkedMapOf<String,WireObject>();val inputs=linkedMapOf<String,WireObject>()
    var controlExpiry=System.currentTimeMillis()-60_000;val controlBinding="c".repeat(64)
    val controlReceipts=linkedMapOf<String,WireObject>();var controlRecord:FaceLifecycleJournal?=null
    fun session(owner:String=a)=LiveCredentials(owner,"fixture-session","fixture-refresh","anonymous",System.currentTimeMillis()+3600_000,emptyMap())
    fun create(actor:LiveCredentials?=null):CloudflareRepository=CloudflareRepository(origin,RepositoryBoundary(vault=vault,initialStorage=vault.value,initialSession=actor,json={path,_,bearer,method,body,_ ->
        calls+=path to body
        when {
            path=="/auth/face/policy"->mapOf("protocol" to "lovelies-face-auth-v1","available" to true,"policy_version" to servedPolicy)
            path=="/me"->mapOf("user_id" to a,"authenticated" to false,"auth_method" to "anonymous")
            path=="/me/audience" && method=="GET"->projection(current,current["status"]=="eligible")
            path=="/me/audience" || path=="/me/audience/renew"->{
                check(bearer!=null);val input=body!!;val key=NativeProtocol.text(input["operation_key"])
                check(NativeProtocol.obj(vault.value["audience_operation"])["body"]==input)
                mutationFailure?.let { throw it }
                if(rejectPolicy)throw LiveFailure("explicit_auth_consent_required",400)
                val response=receipts.getOrPut(key) {
                    inputs[key]=input
                    val band=input["age_band"] ?: if(input["at_least_13"]==false)"under13" else if(input["guardian_required"]==true)"13_17" else "18_plus"
                    current=decision(minor=band=="13_17",under13=band=="under13",version=NativeProtocol.integer(input["expected_version"])+1)
                    projection(current,current["status"]=="eligible")+(if(path.endsWith("/renew"))mapOf("renewal" to mapOf("operation_key" to key,"from_version" to input["expected_version"],"to_version" to current["version"],"next_step" to "profile_recovery")) else emptyMap())
                }
                check(inputs[key]==input)
                if(loseMutation) { loseMutation=false;throw LiveFailure("fixture_lost_reply",503,true) }
                beforeReturn?.invoke();response
            }
            path.startsWith("/auth/face/audience/")->{
                check(bearer==null);val input=body!!;val step=path.substringAfterLast('/')
                val signature=vault.signatures.last();check(signature==input.filterKeys { it!="device_signature" }+mapOf("protocol" to "lovelies-audience-device-v1","step" to step))
                check(input["account_id"]==a && input["device_id"]==d && input["face_handle"]==device.handle)
                NativeProtocol.id(input["request_nonce"]);check(NativeProtocol.integer(input["request_expires_at"]) in System.currentTimeMillis()..System.currentTimeMillis()+60_000)
                var receipt:WireObject?=null
                if(step!="status") {
                    val operation=input.filterKeys { it !in setOf("account_id","device_id","face_handle","request_nonce","request_expires_at","device_signature") }
                    val key=AudienceProtocol.operationKey(operation["operation_key"])
                    val saved=NativeProtocol.rows(vault.value["audience_device_renewals"]).single { it["account"]==a }
                    check(saved["body"]==operation && "age_band" !in operation)
                    mutationFailure?.let { throw it }
                    receipt=receipts.getOrPut(key) {
                        inputs[key]=operation;val from=NativeProtocol.integer(operation["expected_version"]);val minor=step=="guardian-review"
                        check(operation["at_least_13"]==true && operation["guardian_required"]==minor)
                        if(minor)check("consent" !in operation) else check(operation["consent"]==AudienceProtocol.renewalConsent(policy))
                        current=decision(minor=minor,version=from+1)
                        currentGuardian=if(minor)mapOf("id" to g,"state" to "pending","revision" to 1,"policy_version" to AudienceProtocol.POLICY,"expires_at" to iso(System.currentTimeMillis()+60_000)) else null
                        nextStep=if(minor)"guardian_review" else "profile_recovery"
                        mapOf("operation_key" to key,"from_version" to from,"to_version" to from+1,"next_step" to nextStep)+(if(minor)mapOf("guardian_request_id" to g) else emptyMap())
                    }
                    check(inputs[key]==operation)
                    if(loseMutation) { loseMutation=false;throw LiveFailure("fixture_lost_reply",503,true) }
                }
                var result=mapOf("protocol" to "lovelies-audience-device-v1","account_id" to a,"device_id" to d,"request_nonce" to input["request_nonce"],"audience" to current,
                    "renewal_available" to (current["at_least_13"]==true && current["guardian_required"]==false),"guardian_review_available" to (current["guardian_required"]==true),"next_step" to nextStep,"guardian_request" to currentGuardian,"authority_expires_at" to null)+(receipt?.let { mapOf("renewal" to it) } ?: emptyMap())
                result=when(corrupt) { "nonce"->result+mapOf("request_nonce" to g);"account"->result+mapOf("account_id" to b);"graph"->result+mapOf("capabilities" to flags(true));"receipt"->result+mapOf("renewal" to receipt!!+mapOf("to_version" to 900));else->result }
                beforeReturn?.invoke();result
            }
            path=="/auth/face/profile/status"->{
                val held=FaceLifecycleJournal.restore(vault.value["face_lifecycle"],origin);val input=body!!
                check(input["control_key"]==held.control && input["operation_key"]==held.intent?.key)
                val operation=held.intent?.let { mapOf("operation_key" to if(corrupt=="cancel-key")b else it.key,"action" to it.action,"state" to "cancelled","generation" to 1,"challenge_id" to g,"challenge" to null,"captures" to emptyList<WireObject>(),"cleanup_state" to "completed") }
                held.metadata.wire+mapOf("request_nonce" to input["request_nonce"],"version" to 2,"auth_policy_version" to "rotated-face-policy","operation" to operation)
            }
            path.startsWith("/auth/face/profile/control/")->{
                check(bearer==null);val input=body!!;val record=controlRecord!!;val step=if(path.endsWith("/status"))"control-status" else "control-renew"
                check(input["account_id"]==a && input["device_id"]==d && input["control_key"]==record.control && "face_handle" !in input)
                check(vault.signatures.last()==input.filterKeys { it!="device_signature" }+mapOf("protocol" to "lovelies-face-profile-device-v1","step" to step))
                var receipt:WireObject?=null
                if(step=="control-renew") {
                    val operation=input.filterKeys { it !in setOf("account_id","device_id","control_key","request_nonce","request_expires_at","device_signature") }
                    check(FaceLifecycleJournal.restore(vault.value["face_lifecycle"],origin).controlRecoveryRenewal?.body==operation)
                    val key=NativeProtocol.id(operation["operation_key"])
                    receipt=controlReceipts.getOrPut(key) {
                        val before=controlExpiry;controlExpiry=System.currentTimeMillis()+365L*86_400_000
                        mapOf("operation_key" to key,"from_expires_at" to iso(before),"to_expires_at" to iso(controlExpiry))
                    }
                    if(loseMutation) { loseMutation=false;throw LiveFailure("fixture_lost_reply",503,true) }
                }
                beforeReturn?.invoke()
                record.metadata.wire+mapOf("auth_policy_version" to servedPolicy,"request_nonce" to input["request_nonce"],"control_recovery" to mapOf("binding" to controlBinding,"expires_at" to iso(controlExpiry)))+(receipt?.let { mapOf("control_renewal" to it) } ?: emptyMap())
            }
            else->error("Unexpected fixture request $method $path")
        }
    }))
    fun installControl() {
        val digest=NativeProtocol.sha256(NativeProtocol.canonical(jwk).toByteArray())
        val meta=FaceLifecycleMetadata.parse(mapOf("protocol" to "lovelies-face-profile-v1","authenticated" to false,"account_id" to a,"device_id" to d,
            "public_key_digest" to digest,"device_revision" to g,"version" to 1,"auth_policy_version" to policy,"photo_policy_version" to "photo-fixture-v1",
            "profile" to null,"authentication_enabled" to false,"matching_enabled" to false,"processing_enabled" to false,"receive_matches" to false,"matching_paused" to true,"removal_state" to "completed","operation" to null),a,d,digest)
        controlRecord=FaceLifecycleJournal.create(origin,device,jwk,meta).copy(acknowledged=true,state="ready")
        vault.value=vault.value+mapOf("face_lifecycle" to controlRecord!!.wire())
    }
}
fun main()=runBlocking {
    var checks=0
    suspend fun case(name:String,work:suspend ()->Unit) { work();checks++;println("PASS $name") }
    fun fails(work:()->Unit) { check(runCatching(work).isFailure) }
    case("known decisions require finite annual metadata and valid minimized boolean tuples") {
        val row=decision();check(AudienceDecision.parse(row).band=="18_plus")
        for(delta in listOf(mapOf("declared_at" to null),mapOf("next_review_at" to null),mapOf("source" to "invented"),mapOf("at_least_13" to 1),mapOf("at_least_13" to false,"guardian_required" to true),mapOf("next_review_at" to iso(System.currentTimeMillis()+366L*86_400_000))))fails { AudienceDecision.parse(row+delta) }
    }
    case("unknown and blocked decisions never acquire product capabilities") {
        val unknown=AudienceState.parse(projection(decision(known=false),false),a);check(unknown.band=="unknown" && !unknown.allows("face_authentication"))
        val blocked=AudienceState.parse(projection(decision(under13=true),false),a);check(!blocked.allows("photo_processing"))
        fails { AudienceState.parse(projection(decision(known=false)),a) }
    }
    case("earliest effective authority deadline expires before own annual review") {
        val now=System.currentTimeMillis();val row=AudienceState.parse(projection(authority=now+1000),a)
        check(row.allows("face_authentication",now) && !row.allows("face_authentication",now+1000) && row.nextReview!!>now+1000)
        fails { AudienceState.parse(projection(authority=null),a) }
    }
    case("minor own review remains separate from earlier guardian authority deadline") {
        val now=System.currentTimeMillis();val guardian=mapOf("id" to g,"child_account_id" to a,"state" to "approved","revision" to 2,"policy_version" to AudienceProtocol.POLICY,"created_at" to iso(now-1000),"expires_at" to iso(now+2000),"purposes" to flags(true))
        val row=AudienceState.parse(projection(decision(minor=true)+mapOf("status" to "eligible"),guardian=guardian,authority=now+1000),a)
        check(row.allows("photo_processing",now) && !row.allows("photo_processing",now+1000) && row.nextReview!!>row.request!!.expires)
        fails { AudienceState.parse(projection(decision(minor=true)+mapOf("status" to "eligible"),guardian=guardian,authority=now+3000),a) }
    }
    case("legacy projection is accepted only for exact receipt recovery and cannot authorize") {
        val legacy=mapOf("protocol" to AudienceProtocol.LEGACY_PROTOCOL,"policy_version" to AudienceProtocol.POLICY,"account_id" to a,"audience" to mapOf("age_band" to "18_plus","status" to "eligible","version" to 1,"policy_version" to AudienceProtocol.POLICY,"next_review_at" to null),"guardian_request" to null,"capabilities" to flags(true))
        fails { AudienceState.parse(legacy,a) };check(!AudienceState.parse(legacy,a,true).allows("face_authentication"))
    }
    case("actual new declaration persists only decision flags before dispatch") {
        val f=AudienceFixture();f.current=decision(known=false);val r=f.create(f.session());val result=r.declareAudience("13_17",0)
        check(result.audience?.band=="13_17" && f.inputs.values.single()["guardian_required"]==true && "age_band" !in f.inputs.values.single() && r.saved("audience_operation")==null)
    }
    case("failed durable declaration write dispatches no request") {
        val f=AudienceFixture();f.vault.rejectWrite=true
        check(runCatching { f.create(f.session()).declareAudience("18_plus",0) }.isFailure && f.calls.isEmpty())
    }
    case("lost declaration response retries exact original input after repository restart") {
        val f=AudienceFixture();f.loseMutation=true;val first=f.create(f.session());check(runCatching { first.declareAudience("18_plus",0) }.isFailure)
        val held=f.vault.value["audience_operation"];check(runCatching { first.declareAudience("13_17",0) }.isFailure && held==f.vault.value["audience_operation"])
        val result=f.create(f.session()).retryAudienceOperation();check(result.audience?.band=="18_plus" && f.inputs.size==1 && f.calls.filter { it.first=="/me/audience" }.map { it.second }.distinct().size==1)
    }
    case("legacy pending declaration retains its exact age-band key and body") {
        val f=AudienceFixture();val body=mapOf("age_band" to "13_17","expected_version" to 0,"policy_version" to AudienceProtocol.POLICY,"operation_key" to "legacy-audience-saved-operation")
        f.vault.value=f.vault.value+mapOf("audience_operation" to mapOf("origin" to origin,"account" to a,"action" to "declare","path" to "/me/audience","method" to "PUT","body" to body))
        f.create(f.session()).retryAudienceOperation();check(f.calls.single().second==body)
    }
    case("signed expired adult status precedes camera and publishes no session") {
        val f=AudienceFixture();val r=f.create();val status=r.audienceDeviceStatus()
        check(status.nextStep=="audience_review" && status.decision.needsReview() && status.authorityExpires==null && r.credentials==null && f.calls.single().first.endsWith("/status"))
    }
    case("weak status rejects another account nonce and injected product graph") {
        for(kind in listOf("account","nonce","graph")) { val f=AudienceFixture();f.corrupt=kind;check(runCatching { f.create().audienceDeviceStatus() }.isFailure) }
    }
    case("missing device key never creates a substitute identity") {
        val f=AudienceFixture();f.vault.keyMissing=true;check(runCatching { f.create().audienceDeviceStatus() }.isFailure && f.calls.isEmpty() && f.vault.deleted.isEmpty())
    }
    case("foreign session cannot submit retained device review") {
        val f=AudienceFixture();check(runCatching { f.create(f.session(b)).audienceDeviceStatus() }.isFailure && f.calls.isEmpty())
    }
    case("adult renewal needs its separate immutable current face consent") {
        val f=AudienceFixture();val r=f.create();check(runCatching { r.renewDeviceAudience(1,null) }.isFailure && f.calls.isEmpty())
        val value=r.renewDeviceAudience(1,policy);check(value.renewalNextStep=="profile_recovery" && r.credentials==null && f.inputs.values.single()["consent"]==AudienceProtocol.renewalConsent(policy))
    }
    case("failed device renewal persistence occurs before signing or HTTP") {
        val f=AudienceFixture();f.vault.rejectWrite=true;check(runCatching { f.create().renewDeviceAudience(1,policy) }.isFailure && f.vault.signatures.isEmpty() && f.calls.isEmpty())
    }
    case("lost renewal response survives restart with same key consent and fresh nonce") {
        val f=AudienceFixture();f.loseMutation=true;val r=f.create();check(runCatching { r.renewDeviceAudience(1,policy) }.isFailure)
        val saved=f.vault.value["audience_device_renewals"];check(r.audienceDeviceRenewalPending)
        check(runCatching { r.renewDeviceAudience(2,policy) }.isFailure && f.vault.value["audience_device_renewals"]==saved)
        f.servedPolicy="rotated-face-policy";val restored=f.create();check(restored.audienceReviewPolicy()=="rotated-face-policy");val result=restored.renewDeviceAudience(0,null,retryOriginal=true)
        check(result.decision.version==2L && f.inputs.size==1 && f.vault.signatures.map { it["request_nonce"] }.distinct().size==2 && !restored.audienceDeviceRenewalPending)
    }
    case("malformed renewal receipt retains original operation through restart") {
        val f=AudienceFixture();f.corrupt="receipt";check(runCatching { f.create().renewDeviceAudience(1,policy) }.isFailure)
        val original=f.vault.value["audience_device_renewals"];check(original!=null)
        f.corrupt=null;f.create().renewDeviceAudience(0,null,retryOriginal=true);check(f.inputs.size==1)
    }
    case("failed receipt retirement keeps durable recovery marker and retries same key") {
        val f=AudienceFixture();f.vault.failClear=true;check(runCatching { f.create().renewDeviceAudience(1,policy) }.isFailure)
        check(f.vault.value["audience_device_renewals"]!=null);f.vault.failClear=false;f.create().renewDeviceAudience(0,null,retryOriginal=true);check(f.inputs.size==1)
    }
    case("account generation change during signing prevents renewal dispatch") {
        val f=AudienceFixture();val r=f.create();f.vault.afterSign={r.fence.switch(b)}
        check(runCatching { r.renewDeviceAudience(1,policy) }.isFailure && f.calls.isEmpty() && f.vault.value["audience_device_renewals"]!=null)
    }
    case("late signed reply cannot retire another account generation's journal") {
        val f=AudienceFixture();val r=f.create();f.beforeReturn={r.fence.switch(b)}
        check(runCatching { r.renewDeviceAudience(1,policy) }.isFailure && f.vault.value["audience_device_renewals"]!=null)
    }
    case("minor review atomically requests fresh guardian approval without face consent") {
        val f=AudienceFixture();f.current=decision(minor=true,expired=true);val r=f.create();val result=r.renewDeviceAudience(1,null,guardianRequired=true)
        check(result.nextStep=="guardian_review" && result.request?.id==g && result.decision.guardianRequired==true && r.credentials==null && f.calls.single().first.endsWith("/guardian-review") && "consent" !in f.inputs.values.single())
    }
    case("lost minor guardian-review uses original decision and guardian request receipt") {
        val f=AudienceFixture();f.current=decision(minor=true,expired=true);f.loseMutation=true;check(runCatching { f.create().renewDeviceAudience(1,null,guardianRequired=true) }.isFailure)
        val result=f.create().renewDeviceAudience(0,null,retryOriginal=true);check(result.renewalNextStep=="guardian_review" && result.request?.id==g && f.inputs.size==1)
    }
    case("historical renewal receipt does not replace newer current eligibility") {
        val f=AudienceFixture();f.loseMutation=true;check(runCatching { f.create().renewDeviceAudience(1,policy) }.isFailure)
        f.current=decision(version=3,expired=true);f.nextStep="audience_review"
        val result=f.create().renewDeviceAudience(0,null,retryOriginal=true);check(result.decision.version==3L && result.nextStep=="audience_review" && result.decision.needsReview())
    }
    case("foreign renewal records survive successful own-account retirement") {
        val f=AudienceFixture();val foreign=mapOf("origin" to origin,"account" to b,"device" to g,"alias" to "foreign-key","face_handle" to "foreign-handle","body" to mapOf("unresolved" to true))
        f.vault.value=f.vault.value+mapOf("audience_device_renewals" to listOf(foreign));f.create().renewDeviceAudience(1,policy)
        check(f.vault.value["audience_device_renewals"]==listOf(foreign))
    }
    case("logout preserves pending review and exact device proof without creating identity") {
        val f=AudienceFixture();f.loseMutation=true;val r=f.create();check(runCatching { r.renewDeviceAudience(1,policy) }.isFailure)
        val saved=f.vault.value["audience_device_renewals"];r.logout(true)
        check(f.vault.value["audience_device_renewals"]==saved && f.vault.value["device"]==device.wire() && f.vault.deleted.isEmpty() && r.credentials==null)
    }
    case("session annual renewal returns explicit recovery step and minimized saved consent") {
        val f=AudienceFixture();val result=f.create(f.session()).renewAudience(1,policy)
        check(result.nextStep=="profile_recovery" && f.inputs.values.single()["consent"]==AudienceProtocol.renewalConsent(policy) && "age_band" !in f.inputs.values.single())
    }
    case("expired retained control status exposes only management metadata") {
        val f=AudienceFixture();f.installControl();val r=f.create();r.bootstrap();val value=r.lifecycleControlStatus()
        check(value.controlRecovery?.expires==f.controlExpiry && r.credentials==null && r.faceLifecycle?.control==f.controlRecord?.control && !value.authenticationEnabled)
    }
    case("retained control renewal persists exact old secret and reviewed consent before dispatch") {
        val f=AudienceFixture();f.installControl();val r=f.create();r.bootstrap();r.lifecycleControlStatus();val old=r.faceLifecycle!!
        r.lifecycleControlRenew(policy);val next=r.faceLifecycle!!
        check(next.control==old.control && next.controlOperation==old.controlOperation && next.controlRecoveryRenewal==null && next.metadata.controlRecovery!!.expires>System.currentTimeMillis() && !next.metadata.authenticationEnabled && r.credentials==null)
    }
    case("lost retained-control renewal replays original binding key and consent with fresh proof") {
        val f=AudienceFixture();f.installControl();val first=f.create();first.bootstrap();first.lifecycleControlStatus();f.loseMutation=true
        check(runCatching { first.lifecycleControlRenew(policy) }.isFailure);val operation=first.faceLifecycle!!.controlRecoveryRenewal!!
        val restored=f.create();restored.bootstrap();check(restored.faceLifecycle!!.controlRecoveryRenewal==operation)
        check(runCatching { restored.lifecycleControlRenew(policy) }.isFailure)
        f.servedPolicy="rotated-face-policy";check(restored.lifecycleControlRenew(null,retryOriginal=true).authPolicy=="rotated-face-policy")
        val calls=f.calls.filter { it.first.endsWith("/control/renew") };check(calls.size==2 && calls.map { it.second!!["operation_key"] }.distinct().size==1 && calls.map { it.second!!["request_nonce"] }.distinct().size==2 && f.controlReceipts.size==1)
    }
    case("control renewal cannot sign before durable original review is saved") {
        val f=AudienceFixture();f.installControl();val r=f.create();r.bootstrap();r.lifecycleControlStatus();val before=f.vault.signatures.size;f.vault.rejectWrite=true
        check(runCatching { r.lifecycleControlRenew(policy) }.isFailure && f.vault.signatures.size==before && f.controlReceipts.isEmpty())
    }
    case("policy refusal retains the exact session renewal journal until original-key reconciliation") {
        val f=AudienceFixture();f.rejectPolicy=true;val r=f.create(f.session())
        check(runCatching { r.renewAudience(1,policy) }.isFailure)
        val original=f.vault.value["audience_operation"];check(original!=null)
        f.rejectPolicy=false;r.retryAudienceOperation()
        check(f.calls.map { it.second }.distinct().size==1 && f.vault.value["audience_operation"]==null)
    }
    case("earlier guardian expiry exposes separate minor review availability without adult renewal") {
        val f=AudienceFixture();f.current=decision(minor=true,expired=false);f.nextStep="guardian_review"
        f.currentGuardian=mapOf("id" to g,"state" to "approved","revision" to 2,"policy_version" to AudienceProtocol.POLICY,"expires_at" to iso(System.currentTimeMillis()+60000))
        val status=f.create().audienceDeviceStatus()
        check(!status.decision.needsReview() && status.guardianReviewAvailable && !status.renewalAvailable && status.nextStep=="guardian_review" && status.authorityExpires==null)
    }
    case("exact server cancellation releases old capture only after bound reconciliation across policy advance") {
        val f=AudienceFixture();f.installControl();val pending=f.controlRecord!!.begin("enroll").copy(state="pending",generation=1,challengeId=g)
        f.controlRecord=pending;f.vault.value=f.vault.value+mapOf("face_lifecycle" to pending.wire())
        val r=f.create();r.bootstrap();r.lifecycleControlStatus();r.lifecycleControlRenew(policy)
        check(r.faceLifecycle!!.intent!!.key==pending.intent!!.key)
        f.corrupt="cancel-key";check(runCatching { r.lifecycleStatus() }.isFailure && r.faceLifecycle!!.intent!!.key==pending.intent.key)
        f.corrupt=null;r.lifecycleStatus()
        check(r.faceLifecycle!!.intent==null && r.faceLifecycle!!.state=="ready" && r.faceLifecycle!!.metadata.version==2L && r.faceLifecycle!!.metadata.authPolicy=="rotated-face-policy" && r.credentials==null)
    }
    for(problem in listOf(LiveFailure("operation_recovered_without_result",409),LiveFailure("operation_retired_by_recovery",410))) {
        case("session audience ${problem.status} retains exact negative evidence before releasing pending input") {
            val f=AudienceFixture();f.mutationFailure=problem;val r=f.create(f.session())
            val failure=runCatching { r.renewAudience(1,policy) }.exceptionOrNull() as? LiveFailure
            val input=f.calls.single().second!!;val row=NativeProtocol.rows(f.vault.value["audience_terminal_operations"]).single()
            check(failure?.code=="audience_operation_recovered_without_result" && r.saved("audience_operation")==null)
            check(row["operation_key"]==input["operation_key"] && row["source_status"]==problem.status && row["source_code"]==problem.code && row["status"]=="operation_recovered_without_result")
            check(row["input_sha256"]==NativeProtocol.sha256(NativeProtocol.canonical(input).toByteArray(Charsets.UTF_8)) && "body" !in row)
            val calls=f.calls.size;check(runCatching { r.retryAudienceOperation() }.isFailure && f.calls.size==calls)
            f.mutationFailure=null;r.renewAudience(1,policy)
            check(f.calls.last().second!!["operation_key"]!=input["operation_key"] && NativeProtocol.rows(f.vault.value["audience_terminal_operations"]).single()==row)
        }
        case("signed audience ${problem.status} requires a fresh decision and preserves source evidence across restart") {
            val f=AudienceFixture();f.mutationFailure=problem;val r=f.create()
            check((runCatching { r.renewDeviceAudience(1,policy) }.exceptionOrNull() as? LiveFailure)?.code=="audience_operation_recovered_without_result")
            val row=NativeProtocol.rows(f.vault.value["audience_terminal_operations"]).single()
            check(row["source_code"]==problem.code && row["source_status"]==problem.status && !r.audienceDeviceRenewalPending && f.receipts.isEmpty())
            val restarted=f.create();val calls=f.calls.size;check(runCatching { restarted.renewDeviceAudience(0,null,retryOriginal=true) }.isFailure && f.calls.size==calls)
            val current=restarted.audienceDeviceStatus();check(current.decision.version==1L && row==NativeProtocol.rows(f.vault.value["audience_terminal_operations"]).single())
            f.mutationFailure=null;restarted.renewDeviceAudience(1,policy)
            check(f.inputs.keys.single()!=row["operation_key"] && row==NativeProtocol.rows(f.vault.value["audience_terminal_operations"]).single())
        }
    }
    case("failed terminal audience evidence write leaves both journal forms unchanged and unresolved") {
        for(signed in listOf(false,true)) {
            val f=AudienceFixture();f.mutationFailure=LiveFailure("operation_retired_by_recovery",410);f.vault.failTerminal=true;val r=f.create(if(signed)null else f.session())
            check(runCatching { if(signed)r.renewDeviceAudience(1,policy) else r.renewAudience(1,policy) }.isFailure)
            check(f.vault.value[if(signed)"audience_device_renewals" else "audience_operation"]!=null && f.vault.value["audience_terminal_operations"]==null)
        }
    }
    case("signed current status cannot retire an unresolved renewal or normalize a conflict") {
        for(problem in listOf(LiveFailure("audience_operation_outcome_unresolved",503,true),LiveFailure("operation_key_conflict",409))) {
            val f=AudienceFixture();f.mutationFailure=problem;val r=f.create()
            check(runCatching { r.renewDeviceAudience(1,policy) }.isFailure);val held=f.vault.value["audience_device_renewals"]
            r.audienceDeviceStatus();check(r.audienceDeviceRenewalPending && f.vault.value["audience_device_renewals"]==held && f.vault.value["audience_terminal_operations"]==null)
        }
    }
    println("RESULT total=$checks passed=$checks failed=0")
}
