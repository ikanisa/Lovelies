package com.lovelies.frontend.preview

import android.app.Activity
import android.app.Instrumentation
import android.content.Context
import android.content.ContextWrapper
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.os.Bundle
import androidx.core.content.FileProvider
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import java.io.File
import java.io.ByteArrayOutputStream
import java.net.URI
import java.util.UUID

/** Declare only a newly created synthetic actor through the real audience API. */
internal suspend fun admitFreshSyntheticAdult(repository: CloudflareRepository) {
    val actor=repository.credentials ?: error("Fresh anonymous synthetic actor missing")
    check(actor.method=="anonymous" && !repository.audienceOperationPending)
    val unknown=repository.audienceStatus()
    check(unknown.account==actor.account && unknown.band=="unknown" && unknown.status=="unknown" && unknown.version==0L &&
        unknown.capabilities.values.none { it }) { "Fresh synthetic audience must start unknown" }
    // Production declareAudience supplies the current AudienceProtocol.POLICY
    // and durably journals its idempotency key before sending the real request.
    val admitted=repository.declareAudience("18_plus",0).audience ?: error("Adult audience projection missing")
    check(admitted.account==actor.account && admitted.band=="18_plus" && admitted.status=="eligible" && admitted.version==1L &&
        admitted.request==null && AudienceProtocol.purposes.all { admitted.allows(it) }) { "Synthetic adult admission was not approved" }
    check(repository.audienceStatus()==admitted && !repository.audienceOperationPending)
    check(repository.credentials?.account==actor.account && repository.credentials?.token==actor.token &&
        repository.credentials?.method=="anonymous") { "Audience declaration changed anonymous account/session authority" }
}

/** Real Android/Keystore/HTTP consumer. Image assets are declared fixtures, never camera evidence. */
class NativeCloudflareJourney : Instrumentation() {
    private lateinit var arguments: Bundle
    private val checks=mutableListOf<WireObject>()
    private val actors=linkedMapOf<String,Actor>()
    private lateinit var base: String
    private lateinit var fixture: Fixture
    private lateinit var root: File
    private lateinit var uploadRoot: File
    private var retainedOwner=false
    private var recovery: EnrollmentRecoveryJourney?=null
    private var accountRecoveryJourney: AccountRecoveryJourney?=null
    private var lifecycleJourney: FaceLifecycleJourney?=null
    private var cameraRecoveryJourney: CameraRecoveryJourney?=null
    private var uploadRecoveryJourney: PhotoUploadRecoveryJourney?=null
    private var retainedRecovery=false
    private var recoveryCheckpoint: String?=null
    private var recoveryRun: String?=null
    private var approved: Map<String,List<String>> = emptyMap()
    private var authority: WireObject=emptyMap()
    private data class Actor(val context: Context,val repository: CloudflareRepository,val account: String)
    private data class InputPhoto(val name: String,val path: String,val matches: List<String>)
    private data class Fixture(val wire: WireObject,val scope: String,val actorInputs: Map<String,List<String>>,val fresh: Map<String,String>,
        val photos: List<InputPhoto>,val exclusions: List<Pair<String,String>>,val globalExcludedPhotos: Set<String>,val approved: Map<String,List<String>>,val files: Map<String,WireObject>)
    private class IsolatedContext(base: Context,private val directory: File): ContextWrapper(base) {
        override fun getNoBackupFilesDir()=File(directory,"no-backup").apply { check(isDirectory || mkdirs()) }
        override fun getCacheDir()=File(directory,"cache").apply { check(isDirectory || mkdirs()) }
    }

    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        this.arguments=arguments ?: Bundle()
        start()
    }
    override fun onStart() {
        if(arguments.getString("scenario")=="camera-native") { CameraNativeJourney(this,arguments).run();return }
        if(arguments.getString("scenario")=="guest-deletion") {
            GuestDeletionJourney(this,arguments).run()
            return
        }
        var success=false
        var failure: String?=null
        var failureLocation: WireObject?=null
        try {
            base=NativeProtocol.baseUrl(arguments.getString("lovelies_api") ?: "http://10.0.2.2:18887",true)
            val endpoint=URI(base)
            check(endpoint.scheme=="http" && endpoint.host in setOf("10.0.2.2","127.0.0.1","localhost")) { "Test requires a declared local HTTP authority" }
            val recovering=arguments.getString("scenario") in setOf("enrollment-recovery","account-recovery","lifecycle","resumable-upload")
            recoveryCheckpoint=if(recovering)arguments.getString("recovery_checkpoint") else null
            if(recoveryCheckpoint!=null)check(recoveryCheckpoint in setOf("start","capture","completion","finish"))
            val run=if(recovering && recoveryCheckpoint!=null)NativeProtocol.id(arguments.getString("recovery_run_id")) else UUID.randomUUID().toString()
            recoveryRun=if(recovering)run else null
            root=File(targetContext.noBackupFilesDir,"native-cloudflare-journey/$run").apply { check(isDirectory || mkdirs()) }
            uploadRoot=File(targetContext.cacheDir,"camera/native-cloudflare-journey/$run").apply { check(isDirectory || mkdirs()) }
            fixture=loadFixture(arguments.getString("fixture_manifest") ?: "android-journey.json")
            if(recovering) {
                check(arguments.getString("keep_owner")!="true") { "Reply-loss relay vault is isolated and must not replace the normal endpoint vault" }
                val port=arguments.getString("recovery_port")?.toInt() ?: if(recoveryCheckpoint==null)0 else 18989
                check(port==0 && recoveryCheckpoint==null || port in 1024..65535)
                if(arguments.getString("scenario")=="resumable-upload")uploadRecoveryJourney=PhotoUploadRecoveryJourney(IsolatedContext(targetContext,File(root,"owner")),base,port,
                    fixture.actorInputs.getValue("owner"),fixture.photos.map { it.name to it.path },::input,{ name,bytes ->
                        val file=File(uploadRoot,"$name.jpg");file.outputStream().use { it.write(bytes) }
                        FileProvider.getUriForFile(targetContext,"${targetContext.packageName}.camera-files",file)
                    },{ enroll("aline");enroll("eric") },::pass)
                else if(arguments.getString("scenario")=="lifecycle")lifecycleJourney=FaceLifecycleJourney(IsolatedContext(targetContext,File(root,"owner")),base,port,
                    fixture.actorInputs.getValue("owner"),fixture.fresh.getValue("owner"),::input,::pass)
                else if(arguments.getString("scenario")=="account-recovery")accountRecoveryJourney=AccountRecoveryJourney(
                    IsolatedContext(targetContext,File(root,"recovery-source")),IsolatedContext(targetContext,File(root,"owner")),base,port,
                    fixture.actorInputs.getValue("owner"),fixture.fresh.getValue("owner"),::input,::pass,
                    expectedDatabase=arguments.getString("expected_database") ?: "supabase_postgresql")
                else recovery=EnrollmentRecoveryJourney(IsolatedContext(targetContext,File(root,"owner")),base,port,
                    fixture.actorInputs.getValue("owner"),fixture.fresh.getValue("owner"),::input,::pass)
            }
            runBlocking { withTimeout(540000) {
                if(recoveryCheckpoint!=null && recoveryCheckpoint!="finish") {
                    val checkpointResult=if(uploadRecoveryJourney!=null)uploadRecoveryJourney!!.run(recoveryCheckpoint!!) else if(lifecycleJourney!=null)lifecycleJourney!!.run(recoveryCheckpoint!!) else if(accountRecoveryJourney!=null)accountRecoveryJourney!!.run(recoveryCheckpoint!!) else recovery!!.run(recoveryCheckpoint!!)
                    check(checkpointResult==null);retainedRecovery=true
                    pass("Process checkpoint is durable; root runner may force-stop before the next invocation",mapOf("phase" to recoveryCheckpoint,"run_id" to run))
                } else journey()
            } }
            success=true
        } catch(problem: Throwable) {
            failure=when(problem) { is LiveFailure -> "${problem.code} (${problem.status})";else->"${problem.javaClass.simpleName}: ${problem.message}" }
            failureLocation=problem.stackTrace.firstOrNull { it.className.startsWith("com.lovelies.frontend.preview.") }?.let {
                mapOf("class" to it.className,"file" to it.fileName,"method" to it.methodName,"line" to it.lineNumber)
            }
        } finally {
            if(::base.isInitialized)runBlocking {
                val preserveGraph=success && retainedOwner
                val preserveUploadActors=uploadRecoveryJourney!=null && retainedRecovery
                actors.forEach { (name,actor) -> if(!preserveUploadActors && (name!="owner" || !preserveGraph)) {
                    runCatching {
                        if(!preserveGraph)preferences(actor.repository,false)
                        actor.repository.logout(true)
                    }
                    if(preserveGraph)File(root,name).deleteRecursively()
                } }
            }
            if((recovery!=null || accountRecoveryJourney!=null || lifecycleJourney!=null || cameraRecoveryJourney!=null || uploadRecoveryJourney!=null) && !success)retainedRecovery=true
            recovery?.close();accountRecoveryJourney?.close();lifecycleJourney?.close();cameraRecoveryJourney?.close();uploadRecoveryJourney?.close()
            if(::uploadRoot.isInitialized)uploadRoot.deleteRecursively()
            if(::root.isInitialized && !retainedOwner && !retainedRecovery)root.deleteRecursively()
        }
        val report=mapOf("status" to if(success)"passed" else "failed","checks" to checks,"passed" to checks.size,"failure" to failure,"failure_location" to failureLocation,
            "runtime" to "Actual Android CloudflareRepository / Android Keystore / declared loopback API / private face-service",
            "authority" to authority,
            "input_scope" to if(::fixture.isInitialized)fixture.scope else "Declared test asset manifest",
            "api_origin" to if(::base.isInitialized)base else null,"camera_sensor_evidence" to false,"hosted" to false,
            "scenario" to (arguments.getString("scenario") ?: "sharing"),"recovery_checkpoint" to recoveryCheckpoint,
            "recovery_run_id" to recoveryRun,"retained_isolated_recovery_journal" to retainedRecovery,
            "process_restart_scope" to if(recoveryCheckpoint!=null)"Separate instrumentation invocations; force-stop evidence supplied by root runner" else if(recovery!=null || accountRecoveryJourney!=null || lifecycleJourney!=null || uploadRecoveryJourney!=null)"Repository rehydration within one process" else null,
            "fake_backend_success" to false,"retained_owner" to retainedOwner,"retained_matching_consent_for_local_fixture_readback" to (success && retainedOwner),
            "accounts" to actors.mapValues { it.value.account },"approved_subsets" to approved,
            "fixture_files" to if(::fixture.isInitialized)fixture.files.values.toList() else emptyList<WireObject>())
        val result=Bundle().apply {
            putString("native_cloudflare_journey",NativeProtocol.canonical(report))
            putString("stream","\nNative Cloudflare journey ${if(success)"PASSED" else "FAILED"}: ${checks.size} checks${failure?.let { "; $it" } ?: ""}\n")
        }
        finish(if(success)Activity.RESULT_OK else Activity.RESULT_CANCELED,result)
    }
    private fun pass(name: String,details: WireObject=emptyMap()) {
        checks.add(mapOf("name" to name,"status" to "passed","details" to details))
        sendStatus(1,Bundle().apply { putString("stream","PASS $name\n") })
    }
    private fun loadFixture(name: String): Fixture {
        check(name.matches(Regex("[A-Za-z0-9._/-]+")) && !name.contains("..") && !name.startsWith('/'))
        val bytes=context.assets.open(name).use { it.readBytes() }
        check(bytes.size in 1..65536)
        val manifestHash=NativeProtocol.sha256(bytes)
        val value=try { jsonMap(JSONObject(bytes.toString(Charsets.UTF_8))) } finally { bytes.fill(0) }
        val actorLists=value["actors"]?.let(NativeProtocol::obj)
        val legacyInputs=if(actorLists==null)mapOf("owner" to NativeProtocol.obj(value["owner"]))+
            NativeProtocol.obj(value["recipients"]).mapValues { NativeProtocol.obj(it.value) } else emptyMap()
        val faces=if(actorLists!=null)actorLists.mapValues { (_,items) -> (items as? List<*>)?.map { NativeProtocol.text(it) }?.also { check(it.size==3) } ?: error("Three declared selfies required") }
            else legacyInputs.mapValues { (_,input) -> (input["selfies"] as? List<*>)?.map { NativeProtocol.text(it) }?.also { check(it.size==3) } ?: error("Three declared selfies required") }
        check(faces.keys==setOf("owner","aline","eric")) { "This bounded journey requires owner, Aline and Eric" }
        val fresh=if(actorLists!=null)value["fresh_selfies"]?.let(NativeProtocol::obj)?.mapValues { NativeProtocol.text(it.value) }
            ?: faces.mapValues { it.value.first() } else legacyInputs.mapValues { NativeProtocol.text(it.value["fresh_selfie"]) }
        check(fresh.keys==faces.keys) { "Every declared actor requires one returning-login input" }
        val pairs=if(value["expected_pairs"]!=null)NativeProtocol.rows(value["expected_pairs"],100) else emptyList()
        val photos=if(value["uploads"]!=null)NativeProtocol.rows(value["uploads"],12).map { row ->
            val id=NativeProtocol.text(row["id"]);InputPhoto(id,NativeProtocol.text(row["asset"]),pairs.filter { it["photo"]==id }.map { NativeProtocol.text(it["recipient"]) })
        } else NativeProtocol.rows(value["photos"],12).map { row -> InputPhoto(NativeProtocol.text(row["name"]),NativeProtocol.text(row["path"]),
            (row["matches"] as? List<*>)?.map { NativeProtocol.text(it) } ?: error("Expected candidate graph missing")) }
        check(photos.size in 2..12 && photos.map { it.name }.toSet().size==photos.size)
        check(photos.all { it.matches.isNotEmpty() && it.matches.toSet().size==it.matches.size && it.matches.all { name -> name in setOf("aline","eric") } })
        val exclusions=NativeProtocol.rows(value["excluded_pairs"] ?: value["exclusions"],100).map { NativeProtocol.text(it["photo"]) to NativeProtocol.text(it["recipient"]) }
        val globalExcluded=(value["global_excluded_photos"] as? List<*>)?.map { NativeProtocol.text(it) }?.toSet() ?: emptySet()
        check(globalExcluded.all { name -> photos.any { it.name==name } })
        val expected=NativeProtocol.obj(value["expected_approved"] ?: value["approved"]).mapValues { (_,items) -> (items as? List<*>)?.map { NativeProtocol.text(it) } ?: error("Approved subset missing") }
        check(expected.keys==setOf("aline","eric") && expected.values.all { it.isNotEmpty() })
        val hashes=if(value["files"]!=null)value["files"] else context.assets.open("native-journey-hashes.json").use { stream ->
            val declared=jsonMap(JSONObject(stream.readBytes().toString(Charsets.UTF_8)))
            check(declared["source_manifest_sha256"]==manifestHash) { "Fixture graph manifest changed" };declared["files"]
        }
        val files=NativeProtocol.rows(hashes,100).associateBy { NativeProtocol.text(it["path"]) }
        val referenced=faces.values.flatten()+fresh.values+photos.map { it.path }
        check(referenced.all(files::containsKey)) { "All inputs require declared hash and byte count" }
        val result=Fixture(value,NativeProtocol.text(value["input_scope"] ?: value["scope"],2000),faces,fresh,photos,exclusions,globalExcluded,expected,files)
        referenced.distinct().forEach { input -> checkedInput(result,input).fill(0) }
        return result
    }
    private fun checkedInput(data: Fixture,path: String): ByteArray {
        val name=path.substringAfterLast('/')
        check(name.matches(Regex("[A-Za-z0-9._-]+\\.jpg")))
        val declared=data.files[path] ?: error("Undeclared input")
        val bytes=context.assets.open(name).use { it.readBytes() }
        check(bytes.size in 1..8*1024*1024 && bytes.size.toLong()==NativeProtocol.integer(declared["bytes"]))
        check(NativeProtocol.sha256(bytes)==NativeProtocol.text(declared["sha256"])) { "Fixture bytes changed" }
        return bytes
    }
    private fun input(path: String)=checkedInput(fixture,path)
    private fun raw(path: String,token: String?=null,method: String="GET",body: WireObject?=null): WireObject {
        val fence=SessionFence();val scope=fence.switch(null);val transport=CloudflareTransport(base,fence)
        val request=body?.let { NativeProtocol.canonical(it).toByteArray(Charsets.UTF_8) }
        val bytes=try { transport.request(path,scope,token,method,request) } finally { request?.fill(0) }
        return try { jsonMap(JSONObject(bytes.toString(Charsets.UTF_8))) } finally { bytes.fill(0) }
    }
    private suspend fun denied(statuses: Set<Int>,operation: suspend ()->Unit) {
        try { operation();error("Expected authorization denial") } catch(problem: LiveFailure) { check(problem.status in statuses) { "Unexpected denial ${problem.code} (${problem.status})" } }
    }
    private suspend fun preferences(repository: CloudflareRepository,enabled: Boolean) {
        val policy=repository.photoPreferences()
        repository.mutate("photo.preferences",mapOf("policy_version" to NativeProtocol.text(policy["policy_version"]),"receive_matches" to enabled,
            "photo_matching_consent" to enabled,"processing_consent" to enabled),"account",path="/me/photo-preferences")
    }
    private suspend fun enroll(name: String): Actor {
        val isolated=IsolatedContext(targetContext,File(root,name))
        if(arguments.getString("scenario")=="resumable-upload" && name!="owner" && SecureSession(isolated,base).load().isNotEmpty()) {
            val repo=CloudflareRepository(isolated,base);val me=repo.bootstrap();val actor=repo.credentials ?: error("Retained recipient credentials missing")
            check(actor.method=="registered_face" && me["authenticated"]==true)
            preferences(repo,true)
            return Actor(isolated,repo,actor.account).also { actors[name]=it;pass("$name: same pre-processing recipient face profile/session restored after upload process checkpoints",mapOf("account_id" to actor.account)) }
        }
        if(name=="owner" && uploadRecoveryJourney!=null) {
            val repo=uploadRecoveryJourney!!.run("finish") ?: error("Upload recovery did not validate original credentials")
            val actor=Actor(isolated,repo,uploadRecoveryJourney!!.account);actors[name]=actor
            preferences(repo,true);return actor
        }
        if(name=="owner" && lifecycleJourney!=null) {
            val repo=lifecycleJourney!!.run("finish") ?: error("Lifecycle credentials were not confirmed");val account=lifecycleJourney!!.account ?: error("Lifecycle account missing")
            val actor=Actor(isolated,repo,account);actors[name]=actor
            preferences(repo,true)
            repo.mutate("account.profile.update",mapOf("name" to "Native lifecycle owner"),"account",path="/me/profile",method="PATCH")
            return actor
        }
        if(name=="owner" && accountRecoveryJourney!=null) {
            val repo=accountRecoveryJourney!!.run("finish") ?: error("Account recovery did not validate credentials")
            val actor=Actor(isolated,repo,accountRecoveryJourney!!.account);actors[name]=actor
            preferences(repo,true)
            repo.mutate("account.profile.update",mapOf("name" to "Native recovered owner"),"account",path="/me/profile",method="PATCH")
            return actor
        }
        if(name=="owner" && recovery!=null) {
            val repo=recovery!!.run("finish") ?: error("Recovery did not produce validated credentials")
            val account=recovery!!.account
            val actor=Actor(isolated,repo,account);actors[name]=actor
            recovery!!.verifySafetyFailures()
            preferences(repo,true)
            repo.mutate("account.profile.update",mapOf("name" to "Native recovery owner"),"account",path="/me/profile",method="PATCH")
            return actor
        }
        if(name=="owner" && arguments.getString("scenario")=="camera-recovery")cameraRecoveryJourney=CameraRecoveryJourney(isolated,base,::pass)
        var repository=if(name=="owner" && cameraRecoveryJourney!=null)cameraRecoveryJourney!!.repository else CloudflareRepository(isolated,base)
        val anonymous=repository.bootstrap()
        check(anonymous["authenticated"]==false && repository.credentials?.method=="anonymous")
        val account=repository.credentials!!.account;val oldToken=repository.credentials!!.token
        admitFreshSyntheticAdult(repository)
        val initial=repository.faceChallenge()
        val challenge=if(name=="owner" && cameraRecoveryJourney!=null)cameraRecoveryJourney!!.rejectAndRecover() else initial
        check(challenge["account_id"]==account && challenge["purpose"]=="registration" && NativeProtocol.integer(challenge["required_captures"])==3L)
        fixture.actorInputs.getValue(name).forEachIndexed { index,path ->
            val bytes=input(path)
            val result=try { if(name=="owner" && cameraRecoveryJourney!=null)cameraRecoveryJourney!!.approve(challenge,bytes,index) else repository.faceCapture(bytes) } finally { bytes.fill(0) }
            check(result.first==index+1)
            if(index<2)check(result.second==null && repository.credentials?.method=="anonymous")
            else check(result.second!=null)
        }
        if(name=="owner" && cameraRecoveryJourney!=null) {
            val fresh=input(fixture.fresh.getValue("owner"));repository=try { cameraRecoveryJourney!!.interruptedLogin(fresh) } finally { fresh.fill(0) }
            cameraRecoveryJourney!!.stagedLogout(fixture.actorInputs.getValue("owner"),fixture.fresh.getValue("owner"),::input)
        }
        val current=repository.get("/me")
        check(repository.credentials?.method=="registered_face" && repository.credentials!!.account==account)
        check(current["user_id"]==account && current["authenticated"]==true)
        denied(setOf(401)) { raw("/me",oldToken) }
        val actor=Actor(isolated,repository,account);actors[name]=actor
        preferences(repository,true)
        repository.mutate("account.profile.update",mapOf("name" to if(name=="owner")"Native journey owner" else name.replaceFirstChar { it.uppercase() }),"account",path="/me/profile",method="PATCH")
        pass("$name: actual Keystore three-capture enrollment upgrades the same anonymous account",mapOf("account_id" to account,"captures" to 3,"old_session_denied" to true))
        return actor
    }
    private fun currentGallery(rows: WireObject)=NativeProtocol.rows(rows["gallery_items"]).map(LivePhoto::parse)
    private suspend fun noAccess(actor: Actor,photos: List<LivePhoto>) {
        check(currentGallery(actor.repository.get("/me/gallery")).none { row -> photos.any { it.id==row.id } })
        photos.forEach { photo -> denied(setOf(403,404)) { actor.repository.preview(photo).fill(0) } }
    }
    private suspend fun journey() {
        val health=raw("/health")
        val expectedDatabase=arguments.getString("expected_database") ?: "supabase_postgresql"
        check(expectedDatabase in setOf("supabase_postgresql","cloudflare_durable_object_sqlite")) { "Unsupported declared test authority" }
        check(health["database"]==expectedDatabase && health["database_ready"]==true) { "API authority differs from the declared local target" }
        authority=health.filterKeys { it in setOf("service","database","database_ready","schema_version","verification","liveness_required") }
        if(expectedDatabase=="supabase_postgresql") {
            val ready=raw("/ready")
            check(ready["service"]=="lovelies-supabase-api" && ready["database"]==expectedDatabase && ready["database_ready"]==true && ready["inference_ready"]==true)
            check(ready["verification"]=="registered_face_comparison" && ready["liveness_required"]==false)
            authority=authority+mapOf("inference_ready" to true)
        }
        pass(if(expectedDatabase=="supabase_postgresql")"Declared local Supabase API and private inference readiness are confirmed" else "Declared historical local Cloudflare authority is ready",authority)
        denied(setOf(404,410)) { raw("/auth/otp/start",method="POST",body=emptyMap()) }
        pass("OTP endpoint is unavailable")
        val owner=enroll("owner");val aline=enroll("aline");val eric=enroll("eric")
        val batch=uploadRecoveryJourney?.batch ?: UUID.randomUUID().toString();val ids=linkedMapOf<String,String>()
        if(uploadRecoveryJourney!=null)ids.putAll(uploadRecoveryJourney!!.ids)
        else for(photo in fixture.photos) {
            val bytes=input(photo.path);val file=File(uploadRoot,"${photo.name}.jpg")
            try { file.outputStream().use { it.write(bytes) } } finally { bytes.fill(0) }
            val uri=FileProvider.getUriForFile(targetContext,"${targetContext.packageName}.camera-files",file)
            ids[photo.name]=owner.repository.upload(uri,batch,"Native fixture ${photo.name}")
        }
        var finished=false
        repeat(180) {
            if(!finished) {
                val status=ids.values.map { owner.repository.get("/uploads/$it/status") }
                check(status.none { it["status"]=="failed" }) { "Real private processing failed: ${status.firstOrNull { it["status"]=="failed" }?.get("error_code")}" }
                finished=status.all { it["status"]=="ready" }
                if(!finished)delay(1000)
            }
        }
        check(finished) { "Actual processing remained pending" }
        val photos=owner.repository.photos("contributions").filter { it.id in ids.values }
        check(photos.size==ids.size && photos.all { it.width!=null && it.height!=null })
        pass("ContentResolver uploads complete through the declared API storage/job boundary and private face/photo service",mapOf("assets" to ids.size,"database" to expectedDatabase))
        noAccess(aline,photos);noAccess(eric,photos)
        pass("Processing candidates create no gallery or preview access")
        val source="personal"
        val snapshotResponse=owner.repository.mutate("sharing.snapshot",mapOf("asset_ids" to ids.values.toList(),"upload_batch_id" to batch),source,
            validate={ value,_ -> LiveSnapshot.parse(value,System.currentTimeMillis(),source,ids.values.toList()) })
        val snapshot=LiveSnapshot.parse(snapshotResponse,System.currentTimeMillis(),source,ids.values.toList())
        val people=mapOf("aline" to aline.account,"eric" to eric.account)
        val expectedPairs=fixture.photos.flatMap { photo -> photo.matches.map { person -> ids.getValue(photo.name) to people.getValue(person) } }.toSet()
        check(snapshot.pairs.map { it.photo to it.person }.toSet()==expectedPairs)
        check(snapshot.people.map { it.id }.toSet()==people.values.toSet())
        pass("Actual sparse matched graph equals the declared model-qualified fixture graph",mapOf("pairs" to snapshot.pairs.size,"photos" to snapshot.photos.size,"people" to snapshot.people.size))
        val all=LiveDraft(1,ids.values.toSet(),people.values.toSet(),emptySet())
        val sharedPhoto=fixture.photos.first { it.matches.size>1 }.let { ids.getValue(it.name) }
        val withoutPhoto=all.copy(photos=all.photos-sharedPhoto)
        check(withoutPhoto.effective(snapshot).none { it.photo==sharedPhoto })
        check(withoutPhoto.effective(snapshot).map { it.photo to it.person }.toSet()==expectedPairs.filter { it.first!=sharedPhoto }.toSet())
        val withoutEric=all.copy(people=all.people-eric.account)
        check(withoutEric.effective(snapshot).none { it.person==eric.account })
        check(withoutEric.effective(snapshot).map { it.photo to it.person }.toSet()==expectedPairs.filter { it.second!=eric.account }.toSet())
        check(all.copy(photos=emptySet()).effective(snapshot).isEmpty())
        check(all.copy(people=emptySet()).effective(snapshot).isEmpty())
        pass("Native global photo/person exclusions preserve the real sparse graph and zero-selection guards")
        val excluded=fixture.exclusions.map { LivePair(ids.getValue(it.first),people.getValue(it.second)) }.toSet()
        val draft=all.copy(version=3,photos=all.photos-fixture.globalExcludedPhotos.map(ids::getValue).toSet(),excluded=excluded)
        approved=fixture.approved.mapValues { (_,names) -> names.map(ids::getValue) }
        val approvedPairs=approved.flatMap { (person,photoIds) -> photoIds.map { it to people.getValue(person) } }.toSet()
        check(draft.effective(snapshot).map { it.photo to it.person }.toSet()==approvedPairs)
        val previewResponse=owner.repository.mutate("sharing.preview",draft.wire(snapshot),source,
            validate={ value,_ -> LivePreview.parse(value,snapshot,draft,System.currentTimeMillis()) })
        val preview=LivePreview.parse(previewResponse,snapshot,draft,System.currentTimeMillis())
        check(preview.pairs.map { it.photo to it.person }.toSet()==approvedPairs)
        pass("Native per-pair exclusion produces the exact authoritative final subsets",mapOf("approved_pairs" to approvedPairs.size))
        var operationKey=""
        val outcome=owner.repository.mutate("sharing.commit",mapOf("preview_id" to preview.id,"preview_version" to preview.version,"draft_version" to draft.version),source,
            validate={ value,key -> validateOutcome(value,preview,source,key);operationKey=key })
        check(outcome["status"]=="pending_acceptance" && NativeProtocol.integer(outcome["grants_created"])==0L)
        noAccess(aline,photos);noAccess(eric,photos)
        pass("Contributor commit creates requests and still no recipient grants")
        val reconciled=owner.repository.communityRead("operation",mapOf("operation_key" to operationKey))
        validateOutcome(reconciled,preview,source,operationKey)
        check(reconciled["status"]=="pending_acceptance")
        pass("Original native operation key reconciles the unchanged reviewed manifest")
        for((name,actor) in listOf("aline" to aline,"eric" to eric)) {
            val inbox=NativeProtocol.rows(actor.repository.communityRead("inbox")["items"])
            val requests=inbox.filter { NativeProtocol.obj(it["person"])["id"]==owner.account }
            check(requests.size==1)
            val request=actor.repository.communityRead("request.detail",mapOf("request_id" to NativeProtocol.id(requests.single()["id"])))
            check(request["status"]=="requested" && NativeProtocol.idList(request["asset_ids"]).isEmpty())
            check(NativeProtocol.integer(request["photo_count"])==approved.getValue(name).size.toLong())
            actor.repository.mutate("request.decide",mapOf("request_id" to NativeProtocol.id(request["id"]),"decision" to "accept"),source)
            val gallery=currentGallery(actor.repository.get("/me/gallery"))
            check(gallery.map { it.id }.toSet()==approved.getValue(name).toSet())
            for(photo in photos) {
                if(photo.id in approved.getValue(name)) {
                    val bytes=actor.repository.preview(photo)
                    try { check(bytes.isNotEmpty());check(BitmapFactory.decodeByteArray(bytes,0,bytes.size)!=null) { "Authorized rendition is not a real image" } }
                    finally { bytes.fill(0) }
                } else denied(setOf(403,404)) { actor.repository.preview(photo).fill(0) }
            }
            pass("$name accepts and can view only their approved photo subset",mapOf("available_photos" to gallery.size))
        }
        val available=owner.repository.communityRead("operation",mapOf("operation_key" to operationKey))
        validateOutcome(available,preview,source,operationKey)
        check(available["status"]=="access_available" && NativeProtocol.integer(available["grants_created"])==approvedPairs.size.toLong())
        pass("Actual native share receipt reports the current approved access count")
        denied(setOf(403)) { eric.repository.mutate("downloads.sign",mapOf("asset_id" to approved.getValue("eric").first()),"download",path="/downloads/sign") }
        pass("Original download remains denied without verified subscription entitlement")
        val old=eric.repository.currentScope();val oldToken=eric.repository.credentials!!.token
        val originalIdentity=eric.repository.identity ?: error("Eric's registered device identity was not saved before logout")
        val originalKey=SecureSession(eric.context,base).existingDevice(originalIdentity.alias)
        eric.repository.logout()
        try { eric.repository.fence.assert(old);error("Old native scope survived logout") } catch(problem: LiveFailure) { check(problem.code=="session_changed") }
        denied(setOf(401)) { raw("/me",oldToken) }
        val again=eric.repository.bootstrap()
        check(again.isEmpty() && eric.repository.credentials==null) { "Post-logout bootstrap replaced the saved identity with another session" }
        check(eric.repository.identity==originalIdentity && originalIdentity.account==eric.account) { "Post-logout bootstrap changed the original account/device/handle/key alias" }
        check(NativeProtocol.canonical(SecureSession(eric.context,base).existingDevice(originalIdentity.alias))==NativeProtocol.canonical(originalKey)) {
            "Post-logout bootstrap changed the original registered device key"
        }
        var rejectedChallenge: String?=null
        suspend fun rejectReturningInput(label: String,data: ByteArray,code: String,status: Int) {
            val challenge=eric.repository.faceChallenge()
            check(challenge["purpose"]=="login" && challenge["account_id"]==eric.account && challenge["device_id"]==originalIdentity.device &&
                NativeProtocol.integer(challenge["required_captures"])==1L && challenge["challenge_id"]!=rejectedChallenge)
            try { eric.repository.faceCapture(data);error("Invalid returning input authenticated") }
            catch(problem: LiveFailure) { check(problem.code==code && problem.status==status && !problem.ambiguous) { "Unexpected rejection ${problem.code} (${problem.status})" } }
            finally { data.fill(0) }
            val held=CameraLoginJournal.restore(eric.repository.saved("camera_login"),base)
            check(held.state=="rejected" && held.credentials==null && held.challenge==challenge && held.capture!=null && held.completion!=null)
            check(eric.repository.credentials==null && eric.repository.identity==originalIdentity)
            check(NativeProtocol.canonical(SecureSession(eric.context,base).existingDevice(originalIdentity.alias))==NativeProtocol.canonical(originalKey))
            try { eric.repository.get("/me/gallery");error("Rejected comparison exposed private gallery") }
            catch(problem: LiveFailure) { check(problem.code=="face_login_requires_status") }
            rejectedChallenge=NativeProtocol.id(challenge["challenge_id"])
            pass("Returning $label rejection retains the original account/device/key and grants no session",mapOf("code" to code,"status" to status,"capture_count" to 1,"optical_capture_evidence" to false))
        }
        rejectReturningInput("malformed-image",byteArrayOf(255.toByte(),216.toByte(),255.toByte(),224.toByte()),"face_capture_invalid_image",422)
        val blank=Bitmap.createBitmap(64,64,Bitmap.Config.ARGB_8888)
        val noFace=try { blank.eraseColor(Color.WHITE);ByteArrayOutputStream().use { out->check(blank.compress(Bitmap.CompressFormat.JPEG,90,out));out.toByteArray() } }
            finally { blank.eraseColor(0);blank.recycle() }
        rejectReturningInput("no-face",noFace,"face_capture_no_face",422)
        rejectReturningInput("multiple-face",input(fixture.photos.first { it.matches.size>1 }.path),"face_capture_multiple_faces",422)
        rejectReturningInput("wrong-person",input(fixture.fresh.getValue("owner")),"face_verification_failed",401)
        val login=eric.repository.faceChallenge()
        check(login["purpose"]=="login" && login["account_id"]==eric.account && login["device_id"]==originalIdentity.device && NativeProtocol.integer(login["required_captures"])==1L && login["challenge_id"]!=rejectedChallenge) {
            "Fresh login challenge did not bind the original account/device and one registered-reference selfie"
        }
        val bytes=input(fixture.fresh.getValue("eric"));val hash=NativeProtocol.sha256(bytes);val size=bytes.size
        try { check(eric.repository.faceCapture(bytes).second!=null) { "Fresh registered-reference comparison did not return validated credentials" } } finally { bytes.fill(0) }
        check(eric.repository.credentials?.account==eric.account && eric.repository.identity==originalIdentity && eric.repository.get("/me")["authenticated"]==true) {
            "Fresh face login changed the original account/device or did not authenticate"
        }
        check(currentGallery(eric.repository.get("/me/gallery")).map { it.id }.toSet()==approved.getValue("eric").toSet()) {
            "Fresh face login changed the recipient's approved photo subset"
        }
        pass("Native logout fences the old session; fresh registered-face comparison authenticates the original account")
        val identity=eric.repository.identity ?: error("Verified identity missing")
        val completion=mapOf("challenge_id" to login["challenge_id"],"device_signature" to SecureSession(eric.context,base).sign(identity.alias,
            NativeProtocol.faceEnvelope(login)+mapOf("step" to "complete","capture_manifest" to listOf(mapOf("index" to 0,"sha256" to hash,"mime" to "image/jpeg","byte_size" to size)))))
        denied(setOf(409)) { raw("/auth/face/complete",method="POST",body=completion) }
        pass("Actual server rejects replay of a completed one-use face challenge")
        owner.repository.remember("review",mapOf("snapshot" to snapshot.wire,"draft" to mapOf("version" to draft.version,"photos" to draft.photos.sorted(),"people" to draft.people.sorted(),
            "excluded" to draft.excluded.map(LivePair::wire)),"preview" to preview.wire))
        owner.repository.remember("last_outcome",available)
        if(arguments.getString("keep_owner")=="true")promoteOwner(owner,snapshot,draft,preview,available)
    }
    private fun promoteOwner(owner: Actor,snapshot: LiveSnapshot,draft: LiveDraft,preview: LivePreview,outcome: WireObject) {
        check(BuildConfig.DEBUG && NativeProtocol.baseUrl(BuildConfig.API_BASE_URL,true)==base) { "UI readback requires the debug APK configured for this exact local origin" }
        val prefix="lovelies-session-v2-${NativeProtocol.sha256(base.toByteArray()).take(16)}"
        check(targetContext.noBackupFilesDir.listFiles()?.none { it.name.startsWith(prefix) }!=false) { "Refusing to overwrite an existing endpoint vault" }
        val identity=owner.repository.identity ?: error("Verified owner device missing")
        SecureSession(targetContext,base).save(mapOf("credentials" to owner.repository.credentials!!.wire,"device" to identity.wire(),"review" to mapOf("snapshot" to snapshot.wire,
            "draft" to mapOf("version" to draft.version,"photos" to draft.photos.sorted(),"people" to draft.people.sorted(),"excluded" to draft.excluded.map(LivePair::wire)),
            "preview" to preview.wire),"last_outcome" to outcome))
        retainedOwner=true
        pass("Authenticated owner vault retained for endpoint-specific native UI readback",mapOf("default_source_configuration_changed" to false))
    }
}
