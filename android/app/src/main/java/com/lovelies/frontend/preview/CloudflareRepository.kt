package com.lovelies.frontend.preview

import android.content.Context
import android.net.Uri
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

data class LiveCredentials(val account: String,val token: String,val refresh: String,val method: String,val expires: Long,val wire: WireObject)
data class PendingIntent(val account: String,val source: String,val action: String,val key: String,val payload: WireObject,val path: String?=null,val method: String="POST") {
    fun wire(): WireObject = mapOf("account" to account,"source" to source,"action" to action,"key" to key,"payload" to payload,"path" to path,"method" to method)
}
class CloudflareTransport(private val endpoint: String,private val fence: SessionFence) {
    private val connections=ConcurrentHashMap.newKeySet<HttpURLConnection>()
    fun cancel() { connections.forEach(HttpURLConnection::disconnect);connections.clear() }
    fun action(action: String,payload: WireObject,scope: SessionScope,token: String?): ByteArray {
        NativeProtocol.validateActionPayload(action,payload)
        val bytes=NativeProtocol.canonical(mapOf("action" to action,"payload" to payload)).toByteArray(Charsets.UTF_8)
        return try { request("/community/action",scope,token,"POST",bytes) } finally { bytes.fill(0) }
    }
    fun request(path: String,scope: SessionScope,token: String?,method: String="GET",body: ByteArray?=null,
        type: String="application/json",headers: Map<String,String> = emptyMap(),binary: Boolean=false,binaryLimit: Int=4*1024*1024,documentLimit: Int?=null): ByteArray {
        if(!path.startsWith('/') || path.startsWith("//") || path.contains('\\'))throw LiveFailure("invalid_api_path")
        if(endpoint.isBlank())throw LiveFailure("api_endpoint_unconfigured")
        fence.assert(scope)
        val connection=URL(endpoint+path).openConnection() as HttpURLConnection
        connections.add(connection)
        try {
            connection.connectTimeout=10000;connection.readTimeout=45000;connection.instanceFollowRedirects=false
            connection.requestMethod=method;connection.setRequestProperty("Accept",if(binary)"image/*" else "application/json")
            if(token!=null)connection.setRequestProperty("Authorization","Bearer $token")
            headers.forEach { (key,value) -> connection.setRequestProperty(key,value) }
            if(body!=null) {
                connection.doOutput=true;connection.setRequestProperty("Content-Type",type);connection.setFixedLengthStreamingMode(body.size)
                fence.assert(scope);connection.outputStream.use { stream -> stream.write(body) }
            }
            val status=connection.responseCode;fence.assert(scope)
            if(status in 300..399)throw LiveFailure("unsafe_redirect",status,method!="GET")
            val input=if(status in 200..299)connection.inputStream else connection.errorStream
            val maximum=if(binary && status in 200..299)binaryLimit.coerceIn(1,25*1024*1024) else documentLimit?.coerceIn(1,20*1024*1024) ?: (2*1024*1024)
            val bytes=input?.use { stream ->
                val output=java.io.ByteArrayOutputStream();val buffer=ByteArray(8192)
                try { while(true) { val n=stream.read(buffer);fence.assert(scope);if(n<0)break
                    if(output.size()+n>maximum)throw LiveFailure("response_too_large");output.write(buffer,0,n) };output.toByteArray() }
                finally { buffer.fill(0);output.reset() }
            } ?: ByteArray(0)
            fence.assert(scope)
            if(status !in 200..299) {
                val code=runCatching { JSONObject(bytes.toString(Charsets.UTF_8)).optJSONObject("error")?.optString("code") }.getOrNull()?.takeIf { it.isNotEmpty() } ?: "server_unavailable"
                bytes.fill(0);throw LiveFailure(code,status,method!="GET" && status>=500)
            }
            if(binary && !Regex("image/(jpeg|png|webp|gif)(;.*)?").matches(connection.contentType.orEmpty())) { bytes.fill(0);throw LiveFailure("preview_invalid") }
            if(!binary && !connection.contentType.orEmpty().startsWith("application/json")) { bytes.fill(0);throw LiveFailure("response_invalid") }
            return bytes
        } catch(error: LiveFailure) { throw error }
        catch(error: Exception) { fence.assert(scope);throw LiveFailure("connection_unavailable",ambiguous=method!="GET") }
        finally { connections.remove(connection);connection.disconnect() }
    }
}

class CloudflareRepository(private val context: Context,endpoint: String = BuildConfig.API_BASE_URL) {
    val baseUrl=if(endpoint.isBlank())"" else NativeProtocol.baseUrl(endpoint,BuildConfig.DEBUG)
    val fence=SessionFence()
    private val transport=CloudflareTransport(baseUrl,fence)
    private val vault=SecureSession(context,baseUrl)
    private val mutex=Mutex()
    private val photoUploadMutex=Mutex()
    private val storage = ConcurrentHashMap<String,Any?>()
    @Volatile var credentials: LiveCredentials?=null;private set
    var identity: DeviceIdentity?=null;private set
    var pending: PendingIntent?=null;private set
    @Volatile var accountDeletion: GuestDeletionRecord?=null;private set
    @Volatile var guestDeletion: GuestDeletionRecord?=null;private set
    @Volatile var enrollment: EnrollmentJournal?=null;private set
    @Volatile var accountRecovery: AccountRecoveryJournal?=null;private set
    @Volatile var recoveryKeyIntent: RecoveryKeyIntent?=null;private set
    @Volatile var faceLifecycle: FaceLifecycleJournal?=null;private set
    private var storageBlocked=false
    val faceCaptureCount get()=if(faceLifecycle?.loginKey!=null)faceLifecycle?.accepted?.size ?: 0
        else if(faceLifecycle?.intent?.capture==true && faceLifecycle?.state !in setOf("registered","credentials_pending"))faceLifecycle?.accepted?.size ?: 0
        else if(accountRecovery!=null && accountRecovery?.state !in setOf("registered","credentials_pending")) { if(accountRecovery?.accepted==true)1 else 0 }
        else if(challenge?.get("purpose")=="registration")enrollment?.accepted?.size ?: captures.size else captures.size
    private var challenge: WireObject?=null
    private var signingAlias: String?=null
    private var pendingDevice: DeviceIdentity?=null
    private val captures=mutableListOf<WireObject>()
    fun currentScope()=fence.scope()
    private fun save() = vault.save(storage)
    fun saved(key: String): Any? = synchronized(storage) { storage[key] }
    fun remember(key: String,value: Any?) { synchronized(storage) { if(value==null)storage.remove(key) else storage[key]=value;save() } }
    private fun cameraLogin(): CameraLoginJournal?=storage["camera_login"]?.let { CameraLoginJournal.restore(it,baseUrl) }
    val cameraLoginHeld get()=storage.containsKey("camera_login")
    private fun cameraLoginOwner(record: CameraLoginJournal): CameraLoginOwner {
        val life=faceLifecycle;val recovery=accountRecovery;val setup=enrollment
        val active=when {
            life?.blocksPrivate==true->CameraLoginOwner(life.account,life.alias,life.device,life.jwk)
            recovery!=null->CameraLoginOwner(recovery.account,recovery.alias,recovery.device ?: throw LiveFailure("face_login_scope_changed"),recovery.jwk)
            setup!=null->CameraLoginOwner(setup.account,setup.alias,setup.device ?: throw LiveFailure("face_login_scope_changed"),setup.jwk)
            else->null
        }
        val stable=identity?.let { CameraLoginOwner(it.account,it.alias,it.device) }
            ?: life?.let { CameraLoginOwner(it.account,it.alias,it.device,it.jwk) }
        return selectCameraLoginOwner(record,active,stable).also { it.assertKey(vault.existingDevice(it.alias)) }
    }
    private fun saveCameraLogin(value: CameraLoginJournal?,scope: SessionScope)=synchronized(fence) {
        fence.assert(scope)
        val candidate=storage.toMap().filterKeys { it!="camera_login" }+(value?.let { mapOf("camera_login" to it.wire()) } ?: emptyMap())
        synchronized(storage) { vault.save(candidate);storage.clear();storage.putAll(candidate) }
    }
    private fun clearPrivateScope() {
        transport.cancel();challenge=null;captures.clear()
        listOfNotNull(signingAlias,pendingDevice?.alias).filter { it!=identity?.alias && it!=enrollment?.alias && it!=accountRecovery?.alias && it!=faceLifecycle?.alias }.distinct().forEach(vault::deleteDevice)
        signingAlias=null;pendingDevice=null
    }
    fun invalidateReads(expected: SessionScope?=null): SessionScope = synchronized(fence) {
        expected?.let(fence::assert);transport.cancel();fence.switch(credentials?.account)
    }
    fun cancelFace(expected: SessionScope?=null): SessionScope = synchronized(fence) {
        val scope=invalidateReads(expected);clearPrivateScope()
        if(cameraLogin()?.state in setOf("ready","rejected"))saveCameraLogin(null,scope)
        scope
    }
    fun authenticationLost() = synchronized(fence) { clearPrivateScope();credentials=null;if(enrollment==null && accountRecovery==null && faceLifecycle==null && !hasPendingRefresh())storage.remove("credentials");fence.switch(null);save() }
    fun abandonReadReview() {
        if(pending?.action in listOf("sharing.snapshot","sharing.preview")) { pending=null;storage.remove("pending");save() }
    }
    private fun parseCredentials(value: WireObject,expected: String? = null): LiveCredentials {
        val token=NativeProtocol.text(value["access_token"],8192);val parts=token.split('.')
        if(parts.size!=3)throw LiveFailure("credentials_invalid")
        val claims=runCatching { jsonMap(JSONObject(Base64.getUrlDecoder().decode(parts[1]).toString(Charsets.UTF_8))) }.getOrElse { throw LiveFailure("credentials_invalid") }
        val account=NativeProtocol.id(claims["sub"])
        if(expected!=null && account!=expected || value["account_id"]!=null && NativeProtocol.id(value["account_id"])!=account
            || claims["iss"]!=BuildConfig.FACE_TOKEN_ISSUER || claims["aud"]!="lovelies-clients")throw LiveFailure("credentials_invalid")
        val method=NativeProtocol.text(value["auth_method"])
        if(method !in listOf("anonymous","registered_face") || method!=claims["auth_method"])throw LiveFailure("credentials_invalid")
        NativeProtocol.credentialRoles(claims["roles"])
        val expires=NativeProtocol.integer(claims["exp"],1,9007199254740991)*1000
        val refresh=NativeProtocol.text(value["refresh_token"],200)
        if(!Regex("lvs_[A-Za-z0-9_-]{43}").matches(refresh))throw LiveFailure("credentials_invalid")
        return LiveCredentials(account,token,refresh,method,expires,value)
    }
    private fun refreshJournal()=storage["refresh_delivery"]?.let { RefreshDeliveryJournal.restore(it,baseUrl) }
    private fun hasPendingRefresh()=storage.containsKey("refresh_delivery")
    private fun needsRefresh(actor: LiveCredentials)=hasPendingRefresh() || actor.expires<=System.currentTimeMillis()+30000
    private fun retiredRefreshes(value: WireObject=storage.toMap()): List<RefreshDeliveryJournal> =
        value["retired_refresh_deliveries"]?.let { NativeProtocol.rows(it,16).map { row->RefreshDeliveryJournal.restore(row,baseUrl) } } ?: emptyList()
    private fun retireRefreshCandidate(candidate: WireObject): WireObject {
        val journal=refreshJournal()
        val held=(retiredRefreshes()+retiredRefreshes(candidate)+listOfNotNull(journal?.retired())).distinctBy { it.rotationKey }
        if(held.isEmpty())return candidate
        val retained=if(held.size<=16)held else held.filter { it.state!="cancelled" }
        if(retained.size>16)throw LiveFailure("secure_storage_full")
        return candidate.filterKeys { it!="refresh_delivery" }+mapOf("retired_refresh_deliveries" to retained.map(RefreshDeliveryJournal::wire))
    }
    /** Only already validated face verification may supersede an unresolved refresh attempt. */
    private fun credentialCandidate(candidate: WireObject): WireObject {
        if(!hasPendingRefresh())return candidate
        val value=candidate["credentials"]?.let(NativeProtocol::obj) ?: return candidate
        val journal=refreshJournal()!!
        val stored=storage["credentials"]?.let(NativeProtocol::obj)
        // Phase records retain their face-auth envelope. Keep the delivery proof in the credential slot
        // until the separate journal-clear write succeeds, including a restart between those writes.
        if(stored!=null && journal.isSuccessor(stored) && stored["access_token"]==value["access_token"] && stored["refresh_token"]==value["refresh_token"])
            return candidate+mapOf("credentials" to stored)
        if(value["protocol"]=="lovelies-face-auth-v1" && value["status"]=="authenticated" && value["auth_method"]=="registered_face") {
            if(stored?.get("access_token")!=value["access_token"] && !journal.isSuccessor(value))return retireRefreshCandidate(candidate)
        }
        return candidate
    }
    private fun refreshActor(initial: LiveCredentials,initialScope: SessionScope,
        publish: (WireObject,LiveCredentials,SessionScope)->SessionScope): Pair<LiveCredentials,SessionScope> {
        var actor=initial;var scope=initialScope;var rotations=0
        while(needsRefresh(actor)) {
            if(rotations++>=3)throw LiveFailure("refresh_delivery_requires_status")
            val owner=identity?.takeIf { it.account==actor.account }
            val journal=synchronized(fence) {
                fence.assert(scope)
                (refreshJournal() ?: RefreshDeliveryJournal.create(baseUrl,actor.account,actor.method,actor.refresh,owner?.device,owner?.alias)).also {
                    it.assertOwner(baseUrl,actor.account,actor.method,owner?.device,owner?.alias)
                }
            }
            val restored=storage["credentials"]?.let { parseCredentials(NativeProtocol.obj(it),actor.account) }
                ?.takeIf { journal.isSuccessor(it.wire) }
            val adopted=deliverRefresh(
                writeIntent={ synchronized(fence) {
                    fence.assert(scope)
                    val held=refreshJournal()
                    if(held!=null)journal.assertIntent(held)
                    val saved=storage["credentials"]?.let { parseCredentials(NativeProtocol.obj(it),actor.account) }
                        ?: throw LiveFailure("refresh_delivery_scope_changed")
                    if(restored==null) { journal.assertOriginal(actor.refresh);journal.assertOriginal(saved.refresh) }
                    else if(saved.token!=restored.token || saved.refresh!=restored.refresh)throw LiveFailure("refresh_delivery_scope_changed")
                    synchronized(storage) {
                        val candidate=storage.toMap()+mapOf("refresh_delivery" to journal.wire())
                        vault.save(candidate);storage.clear();storage.putAll(candidate)
                    }
                } },
                dispatch={ restored?.wire ?: json("/auth/session/refresh",scope,null,"POST",journal.request()) },
                adoptDurably={ value->
                    val next=parseCredentials(value,actor.account)
                    journal.assertSuccessor(value,next.account,next.method,next.refresh,next.expires)
                    synchronized(fence) { fence.assert(scope);journal.assertIntent(refreshJournal()) }
                    val nextScope=publish(value,next,scope)
                    next to nextScope
                },
                retireAfterAdoption={ (next,nextScope)-> synchronized(fence) {
                    fence.assert(nextScope);journal.assertIntent(refreshJournal())
                    val saved=storage["credentials"]?.let { parseCredentials(NativeProtocol.obj(it),next.account) }
                        ?: throw LiveFailure("refresh_delivery_storage_unavailable")
                    if(saved.token!=next.token || saved.refresh!=next.refresh)throw LiveFailure("refresh_delivery_scope_changed")
                    synchronized(storage) {
                        val candidate=storage.toMap()-"refresh_delivery"
                        vault.save(candidate);storage.clear();storage.putAll(candidate)
                    }
                } })
            actor=adopted.first;scope=adopted.second
        }
        return actor to scope
    }
    /** Local retirement precedes network work; an ambiguous cancellation never restores credentials. */
    private fun cancelRetiredRefresh() {
        val journal=retiredRefreshes().firstOrNull { it.state=="retired" } ?: return
        runCatching {
            val localFence=SessionFence();val scope=localFence.switch(journal.account)
            val body=NativeProtocol.canonical(journal.cancellationBody()).toByteArray()
            val response=try { CloudflareTransport(baseUrl,localFence).request("/auth/session/refresh/cancel",scope,null,"POST",body) } finally { body.fill(0) }
            val next=try { journal.cancelled(jsonMap(JSONObject(response.toString(Charsets.UTF_8)))) } finally { response.fill(0) }
            synchronized(fence) { synchronized(storage) {
                val held=retiredRefreshes();val current=held.firstOrNull { it.rotationKey==journal.rotationKey } ?: return@runCatching
                journal.assertIntent(current)
                val candidate=storage.toMap()+mapOf("retired_refresh_deliveries" to held.map { if(it.rotationKey==journal.rotationKey)next.wire() else it.wire() })
                vault.save(candidate);storage.clear();storage.putAll(candidate)
            } }
        }
    }
    private fun install(value: WireObject,expected: String?=null,expectedScope: SessionScope=currentScope()): SessionScope = synchronized(fence) {
        fence.assert(expectedScope)
        val next=parseCredentials(value,expected)
        val candidate=credentialCandidate(storage.toMap()+mapOf("credentials" to value))
        vault.save(candidate)
        clearPrivateScope();credentials=next;val scope=fence.switch(next.account)
        storage.clear();storage.putAll(candidate);scope
    }
    private fun json(path: String,scope: SessionScope=currentScope(),token: String?=credentials?.token,method: String="GET",body: WireObject?=null): WireObject {
        val bytes=body?.let { NativeProtocol.canonical(it).toByteArray(Charsets.UTF_8) }
        val response=try { transport.request(path,scope,token,method,bytes) } finally { bytes?.fill(0) }
        try { fence.assert(scope);return jsonMap(JSONObject(response.toString(Charsets.UTF_8))) }
        catch(error: LiveFailure) { throw error } catch(error: Exception) { throw LiveFailure("response_invalid") }
        finally { response.fill(0) }
    }
    fun canRestoreBackground(account: String,device: String,batch: String): Boolean {
        val held=vault.load()
        if(held.keys.any { it in setOf("registered_deletion","guest_deletion","enrollment","account_recovery","camera_login") })return false
        val lifecycle=held["face_lifecycle"]?.let { FaceLifecycleJournal.restore(it,baseUrl) }
        if(lifecycle?.blocksPrivate==true)return false
        val credentials=(held["credentials"] as? Map<*,*>)?.let(NativeProtocol::obj)?.let { parseCredentials(it,account) } ?: return false
        val identity=held["device"] as? Map<*,*> ?: return false
        return credentials.method=="registered_face" && identity["account"]==account && identity["device"]==device
            && BackgroundTransfers.permitted(held["background_upload"],account,device,batch)
    }
    suspend fun bootstrap(): WireObject = withContext(Dispatchers.IO) { mutex.withLock {
        val restoreScope=currentScope()
        val loaded=try { vault.load() } catch(problem: Exception) { storageBlocked=true;throw problem }
        if(loaded.isEmpty() && vault.hasEnrollmentKeys()) { storageBlocked=true;throw LiveFailure("enrollment_storage_unavailable") }
        synchronized(fence) {
        fence.assert(restoreScope)
        storageBlocked=false;storage.clear();storage.putAll(loaded.filterValues { it!=null })
        faceLifecycle=try { storage["face_lifecycle"]?.let { FaceLifecycleJournal.restore(it,baseUrl) } } catch(problem: Exception) { storageBlocked=true;throw problem }
        accountRecovery=try { storage["account_recovery"]?.let { AccountRecoveryJournal.restore(it,baseUrl) } } catch(problem: Exception) { storageBlocked=true;throw problem }
        recoveryKeyIntent=storage["recovery_key_intent"]?.let { RecoveryKeyIntent.restore(it,baseUrl) }
        enrollment=try { storage["enrollment"]?.let { EnrollmentJournal.restore(it,baseUrl) } } catch(problem: Exception) { storageBlocked=true;throw problem }
        storage["photo_uploads"]?.let { raw -> val held=PhotoUploadBatch.restore(raw,baseUrl);storage["photo_uploads"]=held.copy(paused=true).wire();save() }
        identity=(storage["device"] as? Map<*, *>)?.let { NativeProtocol.obj(it) }?.let { DeviceIdentity(NativeProtocol.id(it["account"]),NativeProtocol.text(it["alias"]),NativeProtocol.text(it["handle"]),NativeProtocol.id(it["device"])) }
        cameraLogin()?.let { held->
            cameraLoginOwner(held)
        }
        pending=(storage["pending"] as? Map<*, *>)?.let { NativeProtocol.obj(it) }?.let {
            val action=NativeProtocol.text(it["action"])
            val payload=NativeProtocol.obj(it["payload"]);NativeProtocol.validateActionPayload(action,payload)
            PendingIntent(NativeProtocol.id(it["account"]),NativeProtocol.operationSource(action,it["source"]),action,NativeProtocol.text(it["key"]),payload,it["path"] as? String,it["method"] as? String ?: "POST")
        }
        (storage["credentials"] as? Map<*, *>)?.let { credentials=parseCredentials(NativeProtocol.obj(it));fence.switch(credentials!!.account) }
        refreshJournal()?.let { if(it.state!="pending")throw LiveFailure("refresh_delivery_storage_unavailable") }
        retiredRefreshes().forEach { if(it.state=="pending")throw LiveFailure("refresh_delivery_storage_unavailable") }
        guestDeletion=storage["guest_deletion"]?.let { GuestDeletionRecord.restore(it,baseUrl,credentials?.account,credentials?.method) }
        accountDeletion=storage["registered_deletion"]?.let { GuestDeletionRecord.restore(it,baseUrl,null,null) }
        if(accountDeletion!=null) {
            if(credentials!=null && credentials?.account!=accountDeletion!!.account)throw LiveFailure("deletion_account_changed")
            return@withLock emptyMap()
        }
        // A deletion receipt must be recovered before /me or a replacement anonymous account.
        if(guestDeletion!=null) {
            credentials=null;fence.switch(null)
            if(guestDeletion?.receipt?.completed==true) { storage.remove("credentials");save() }
            return@withLock emptyMap()
        }
        if(vault.hasUnreferencedEnrollmentKeys((listOfNotNull(enrollment?.alias,identity?.alias,accountRecovery?.alias,faceLifecycle?.alias)+retiredAliases().map { NativeProtocol.text(it["alias"]) }+archivedRecoveries().map { it.alias }+retiredLifecycles().map { it.alias }).toSet())) {
            storageBlocked=true;throw LiveFailure("enrollment_storage_unavailable")
        }
        faceLifecycle?.let {
            val stagedRecovery=!it.blocksPrivate && accountRecovery?.account==it.account && identity?.alias==accountRecovery?.alias && identity?.device==accountRecovery?.device
            if(!stagedRecovery && (identity?.account!=it.account || identity?.device!=it.device || identity?.alias!=it.alias))throw LiveFailure("face_profile_scope_changed")
            if(it.blocksPrivate)return@withLock emptyMap()
        }
        accountRecovery?.let {
            if(credentials!=null && credentials!!.account !in listOfNotNull(it.sourceAccount,it.account))throw LiveFailure("account_recovery_scope_changed")
            return@withLock emptyMap()
        }
        enrollment?.let {
            if(credentials!=null && credentials!!.account!=it.account)throw LiveFailure("enrollment_scope_changed")
            return@withLock emptyMap()
        }
        }
        cancelRetiredRefresh()
        if(cameraLoginHeld)return@withLock emptyMap()
        if(credentials!=null) {
            try { ensureFresh();return@withLock json("/me") }
            catch(error: LiveFailure) { if(error.status !in listOf(401,403) || hasPendingRefresh())throw error;credentials=null;if(faceLifecycle==null)storage.remove("credentials");storage.remove("pending");pending=null;fence.switch(null);save() }
        }
        if(faceLifecycle!=null || identity!=null)return@withLock emptyMap()
        if(hasPendingRefresh())throw LiveFailure("refresh_delivery_requires_status")
        val scope=currentScope();install(json("/auth/anonymous",scope,null,"POST",emptyMap()),expectedScope=scope)
        json("/me")
    } }
    private fun publishGuestStorage(candidate: WireObject,record: GuestDeletionRecord?,afterDurableWrite: ()->Unit = {}) {
        record?.assertOrigin(baseUrl)
        var retained=candidate+(storage["retired_refresh_deliveries"]?.let { mapOf("retired_refresh_deliveries" to it) } ?: emptyMap())
        val refresh=refreshJournal()
        if(refresh!=null)retained=if(record?.receipt?.completed==true || retained["credentials"]==null)retireRefreshCandidate(retained)
            else retained+mapOf("refresh_delivery" to refresh.wire())
        persistGuestDeletionState(retained,vault::save) { saved ->
            afterDurableWrite()
            storage.clear();storage.putAll(saved.filterValues { it!=null })
            guestDeletion=record
        }
    }
    private fun saveGuestDeletion(record: GuestDeletionRecord) = synchronized(storage) {
        publishGuestStorage(storage.toMap()+mapOf("guest_deletion" to record.wire()),record)
    }
    private fun assertGuestDeletion(record: GuestDeletionRecord,scope: SessionScope) {
        fence.assert(scope);record.assertOrigin(baseUrl);record.assertSameIntent(guestDeletion)
        credentials?.let { record.assertOriginalAnonymous(it.account,it.method) }
    }
    private class GuestPhase(var scope: SessionScope)
    private data class GuestPhaseResult(val record: GuestDeletionRecord,val scope: SessionScope)
    private fun acceptGuestDeletion(record: GuestDeletionRecord,response: WireObject,phase: GuestPhase): GuestDeletionRecord =
        withGuestDeletionPhase(fence,phase.scope,record,{guestDeletion}) {
        assertGuestDeletion(record,phase.scope)
        val next=record.copy(receipt=GuestDeletionReceipt.parse(response,record),statusUnavailable=false)
        synchronized(storage) {
            val retiredForAccount=if(next.receipt?.completed==true)retiredAliases().filter { it["account"]==record.account } else emptyList()
            val retiredRecoveries=if(next.receipt?.completed==true)archivedRecoveries().filter { it.account==record.account } else emptyList()
            val previous=storage.toMap()+(identity?.wire()?.let { mapOf("device" to it) } ?: emptyMap())
            val candidate=next.acceptedStorage(previous)
            publishGuestStorage(candidate,next) {
                // A failed vault write must leave the prior receipt, credentials and device refs intact.
                clearPrivateScope()
                if(identity?.account==record.account) { vault.deleteDevice(identity?.alias);identity=null }
                retiredForAccount.forEach { vault.deleteDevice(NativeProtocol.text(it["alias"])) }
                retiredRecoveries.forEach { vault.deleteDevice(it.alias) }
                if(next.receipt?.completed==true && enrollment?.account==record.account) { vault.deleteDevice(enrollment?.alias);enrollment=null }
                if(next.receipt?.completed==true && accountRecovery?.account==record.account) { vault.deleteDevice(accountRecovery?.alias);accountRecovery=null }
                credentials=null;pending=null;phase.scope=fence.switch(null)
            }
            recoveryKeyIntent=storage["recovery_key_intent"]?.let { RecoveryKeyIntent.restore(it,baseUrl) }
        }
        next
    }
    private fun thawOriginalGuest(record: GuestDeletionRecord,phase: GuestPhase): Pair<LiveCredentials,SessionScope> {
        val original=withGuestDeletionPhase(fence,phase.scope,record,{guestDeletion}) {
            assertGuestDeletion(record,phase.scope)
            val stored=storage["credentials"]?.let { parseCredentials(NativeProtocol.obj(it),record.account) }
                ?: throw LiveFailure("deletion_account_unavailable")
            record.assertOriginalAnonymous(stored.account,stored.method)
            credentials=stored;phase.scope=fence.switch(stored.account)
            stored
        }
        try {
            if(needsRefresh(original)) {
                refreshActor(original,phase.scope) { result,refreshed,refreshScope->
                withGuestDeletionPhase(fence,refreshScope,record,{guestDeletion}) {
                    assertGuestDeletion(record,refreshScope)
                    record.assertOriginalAnonymous(refreshed.account,refreshed.method)
                    synchronized(storage) {
                        publishGuestStorage(storage.toMap()+mapOf("credentials" to result),guestDeletion) {
                            clearPrivateScope();credentials=refreshed;phase.scope=fence.switch(refreshed.account)
                        }
                    }
                    phase.scope
                }
                }
            }
            return withGuestDeletionPhase(fence,phase.scope,record,{guestDeletion}) {
                assertGuestDeletion(record,phase.scope)
                (credentials ?: throw LiveFailure("deletion_account_unavailable")) to phase.scope
            }
        } catch(problem: Throwable) {
            freezeGuest(record,phase)
            throw problem
        }
    }
    private fun freezeGuest(record: GuestDeletionRecord,phase: GuestPhase) {
        try {
            withGuestDeletionPhase(fence,phase.scope,record,{guestDeletion}) {
                credentials?.let {
                    record.assertOriginalAnonymous(it.account,it.method)
                    clearPrivateScope();credentials=null;phase.scope=fence.switch(null)
                }
            }
        } catch(problem: LiveFailure) {
            // A cancelled phase cannot clean up or reinstate a newer session.
            if(problem.code!="session_changed")throw problem
        }
    }
    private fun dispatchGuestDeletion(record: GuestDeletionRecord,phase: GuestPhase): GuestDeletionRecord {
        try {
            val (original,scope)=thawOriginalGuest(record,phase)
            assertGuestDeletion(record,scope)
            return acceptGuestDeletion(record,json("/privacy/account-deletion",scope,original.token,"POST",record.requestBody()),phase)
        } finally { if(guestDeletion!=null)freezeGuest(record,phase) }
    }
    private fun checkGuestDeletionLocked(): GuestPhaseResult {
        val record=guestDeletion ?: throw LiveFailure("deletion_record_unavailable")
        val phase=GuestPhase(currentScope());val scope=phase.scope;assertGuestDeletion(record,scope)
        try {
            // The receipt is read-only and independent of revoked enrollment credentials.
            val result=json("/privacy/account-deletion/status",scope,null,"POST",mapOf("status_token" to record.statusToken))
            return GuestPhaseResult(acceptGuestDeletion(record,result,phase),phase.scope)
        } catch(problem: LiveFailure) {
            if(problem.status!=404 || problem.code!="deletion_status_unavailable")throw problem
            val unavailable=synchronized(fence) {
                assertGuestDeletion(record,scope)
                record.copy(statusUnavailable=true).also(::saveGuestDeletion)
            }
            val original=storage["credentials"]?.let { parseCredentials(NativeProtocol.obj(it),record.account) }
            if(!unavailable.mayRetry(original?.account,original?.method))return GuestPhaseResult(unavailable,phase.scope)
            try { return GuestPhaseResult(dispatchGuestDeletion(unavailable,phase),phase.scope) }
            catch(expired: LiveFailure) {
                if(expired.status !in listOf(401,403) || hasPendingRefresh())throw expired
                // Expired/revoked credentials cannot recreate the old account or redirect this receipt.
                return withGuestDeletionPhase(fence,phase.scope,unavailable,{guestDeletion}) {
                    assertGuestDeletion(unavailable,phase.scope)
                    synchronized(storage) {
                        publishGuestStorage(storage.toMap().filterKeys { it!="credentials" },unavailable) {
                            clearPrivateScope();credentials=null;phase.scope=fence.switch(null)
                        }
                    }
                    GuestPhaseResult(unavailable,phase.scope)
                }
            }
        }
    }
    fun stagedExport(): WireObject?=(saved("staged_export") as? Map<*,*>)?.let(NativeProtocol::obj)?.takeIf { it["account"]==credentials?.account }
    suspend fun saveExport(requestId: String,destination: Uri)=withContext(Dispatchers.IO) {
        val (scope,actor)=ready();NativeProtocol.id(requestId)
        var staged=stagedExport()?.takeIf { it["request"]==requestId }
        if(staged==null) {
            val grant=post("/privacy-exports/$requestId/grant",emptyMap())
            fence.assert(scope)
            if(NativeProtocol.id(grant["request_id"])!=requestId)throw LiveFailure("privacy_export_unavailable")
            NativeProtocol.expiry(grant["expires_at"],System.currentTimeMillis())
            val path=NativeProtocol.text(grant["grant_path"],500)
            if(!Regex("^/privacy-exports/retrieve\\?grant=[A-Za-z0-9%._~-]{1,200}$").matches(path))throw LiveFailure("privacy_export_unavailable")
            val bytes=transport.request(path,scope,actor.token,documentLimit=20*1024*1024)
            try {
                fence.assert(scope)
                // Preserve the one-time response before attempting a potentially fallible document-provider write.
                jsonMap(JSONObject(bytes.toString(Charsets.UTF_8)))
                val local=UUID.randomUUID().toString()
                vault.stagePhoto(actor.account,requestId,local,bytes)
                val metadata=mapOf("account" to actor.account,"request" to requestId,"file" to local,"sha256" to NativeProtocol.sha256(bytes))
                synchronized(fence) { fence.assert(scope);remember("staged_export",metadata) };staged=metadata
            } finally { bytes.fill(0) }
        }
        val metadata=staged ?: throw LiveFailure("privacy_export_unavailable")
        val local=NativeProtocol.id(metadata["file"])
        val bytes=vault.stagedPhoto(actor.account,requestId,local)
        try {
            if(NativeProtocol.sha256(bytes)!=metadata["sha256"])throw LiveFailure("privacy_export_unverified")
            fence.assert(scope)
            context.contentResolver.openOutputStream(destination,"wt")?.use { it.write(bytes);it.flush() } ?: throw LiveFailure("export_write_failed")
            synchronized(fence) { fence.assert(scope);vault.removeStagedPhoto(local);remember("staged_export",null) }
        } catch(problem: java.io.IOException) { throw LiveFailure("export_write_failed") }
        finally { bytes.fill(0) }
    }
    private fun saveAccountDeletion(record: GuestDeletionRecord) = synchronized(fence) {
        record.assertOrigin(baseUrl)
        val candidate=storage.toMap()+mapOf("registered_deletion" to record.wire())
        vault.save(candidate);storage.clear();storage.putAll(candidate);accountDeletion=record
    }
    suspend fun requestAccountDeletion(): GuestDeletionRecord=withContext(Dispatchers.IO) { mutex.withLock {
        if(accountDeletion!=null)return@withLock checkAccountDeletionLocked()
        registered();if(pending!=null)throw LiveFailure("pending_operation_requires_reconciliation")
        val record=GuestDeletionRecord.create(baseUrl,credentials!!.account)
        saveAccountDeletion(record)
        val scope=currentScope()
        val response=json("/privacy/account-deletion",scope,credentials!!.token,"POST",record.requestBody())
        val next=record.copy(receipt=GuestDeletionReceipt.parse(response,record));saveAccountDeletion(next);next
    } }
    private fun checkAccountDeletionLocked(): GuestDeletionRecord {
        val record=accountDeletion ?: throw LiveFailure("deletion_requires_status")
        val scope=currentScope()
        val response=try { json("/privacy/account-deletion/status",scope,null,"POST",mapOf("status_token" to record.statusToken)) }
        catch(problem: LiveFailure) {
            if(record.receipt==null && problem.status==404 && credentials?.account==record.account && credentials?.method=="registered_face")
                json("/privacy/account-deletion",scope,credentials!!.token,"POST",record.requestBody())
            else throw problem
        }
        val next=record.copy(receipt=GuestDeletionReceipt.parse(response,record),statusUnavailable=false)
        saveAccountDeletion(next)
        if(next.receipt?.completed==true) {
            val keys=listOfNotNull(identity?.takeIf { it.account==record.account }?.alias,enrollment?.takeIf { it.account==record.account }?.alias,
                accountRecovery?.takeIf { it.account==record.account }?.alias,faceLifecycle?.takeIf { it.account==record.account }?.alias)+
                retiredAliases().filter { it["account"]==record.account }.map { NativeProtocol.text(it["alias"]) }+
                archivedRecoveries().filter { it.account==record.account }.map { it.alias }+retiredLifecycles().filter { it.account==record.account }.map { it.alias }
            stagedExport()?.get("file")?.let { vault.removeStagedPhoto(NativeProtocol.id(it)) }
            photoUploads()?.takeIf { it.account==record.account }?.files?.forEach { vault.removeStagedPhoto(it.localId) }
            val candidate=retireRefreshCandidate(next.restartStorage(storage.toMap())+mapOf("registered_deletion" to next.wire()))
            vault.save(candidate);clearPrivateScope();credentials=null;identity=null;enrollment=null;accountRecovery=null;faceLifecycle=null;recoveryKeyIntent=null;pending=null
            storage.clear();storage.putAll(candidate);fence.switch(null);keys.distinct().forEach(vault::deleteDevice)
        }
        return next
    }
    suspend fun checkAccountDeletion(): GuestDeletionRecord=withContext(Dispatchers.IO) { mutex.withLock { checkAccountDeletionLocked() } }
    suspend fun resumeAfterAccountDeletion(): WireObject=withContext(Dispatchers.IO) { mutex.withLock {
        val record=checkAccountDeletionLocked();record.assertResumeAllowed()
        val candidate=storage.toMap()-"registered_deletion";vault.save(candidate);storage.clear();storage.putAll(candidate);accountDeletion=null
        if(credentials!=null) { ensureFresh();json("/me") } else emptyMap()
    } }
    suspend fun restartAfterAccountDeletion()=withContext(Dispatchers.IO) { mutex.withLock {
        val record=checkAccountDeletionLocked();record.assertRestartAllowed()
        val candidate=retireRefreshCandidate(record.restartStorage(storage.toMap()));vault.save(candidate);storage.clear();storage.putAll(candidate);accountDeletion=null
    } }
    suspend fun requestGuestDeletion(): GuestDeletionRecord=withContext(Dispatchers.IO) { mutex.withLock {
        if(guestDeletion!=null)return@withLock checkGuestDeletionLocked().record
        if(faceLifecycle!=null)throw LiveFailure("face_profile_requires_status")
        val actor=credentials ?: throw LiveFailure("authentication_required")
        if(actor.method!="anonymous")throw LiveFailure("anonymous_account_required",403)
        if(pending!=null)throw LiveFailure("pending_operation_requires_reconciliation")
        if(accountRecovery!=null)throw LiveFailure("account_recovery_requires_status")
        enrollment?.let { prior ->
            val recovery=reconcileEnrollment(prior,EnrollmentPhase(currentScope()),retryAbsentStart=false)
            if(recovery.waiting)throw LiveFailure("enrollment_in_flight")
            if(recovery.state in setOf("registered","credentials_pending"))throw LiveFailure("enrollment_requires_recovery")
        }
        val phase=GuestPhase(currentScope());val scope=phase.scope
        val record=synchronized(fence) {
            fence.assert(scope)
            if(credentials?.account!=actor.account || credentials?.method!="anonymous")throw LiveFailure("deletion_account_changed")
            GuestDeletionRecord.create(baseUrl,actor.account).also {
                saveGuestDeletion(it) // Write the original key and secure status proof before any deletion dispatch.
                clearPrivateScope()
            }
        }
        dispatchGuestDeletion(record,phase)
    } }
    suspend fun checkGuestDeletion(): GuestDeletionRecord=withContext(Dispatchers.IO) { mutex.withLock { checkGuestDeletionLocked().record } }
    suspend fun resumeGuestSetup(): WireObject=withContext(Dispatchers.IO) { mutex.withLock {
        val found=checkGuestDeletionLocked();val record=found.record;val phase=GuestPhase(found.scope)
        record.assertResumeAllowed()
        try {
            val (original,scope)=thawOriginalGuest(record,phase)
            val me=json("/me",scope,original.token)
            enrollment?.let { prior ->
                if(prior.account!=record.account)throw LiveFailure("enrollment_scope_changed")
                val recovery=reconcileEnrollment(prior,EnrollmentPhase(scope),allowGuest=true,retryAbsentStart=false)
                if(recovery.waiting)throw LiveFailure("enrollment_in_flight")
            }
            withGuestDeletionPhase(fence,scope,record,{guestDeletion}) {
                assertGuestDeletion(record,scope)
                record.assertResumedAccount(me)
                synchronized(storage) {
                    publishGuestStorage(storage.toMap().filterKeys { it!="guest_deletion" },null)
                }
            }
            me
        } finally { if(guestDeletion!=null)freezeGuest(record,phase) }
    } }
    suspend fun restartAfterGuestDeletion()=withContext(Dispatchers.IO) { mutex.withLock {
        val record=guestDeletion ?: throw LiveFailure("deletion_record_unavailable")
        val scope=currentScope()
        withGuestDeletionPhase(fence,scope,record,{guestDeletion}) {
            record.assertOrigin(baseUrl);record.assertRestartAllowed()
            credentials?.let { record.assertOriginalAnonymous(it.account,it.method) }
            synchronized(storage) {
                publishGuestStorage(record.restartStorage(storage.toMap()),null) {
                    clearPrivateScope();credentials=null;pending=null;fence.switch(null)
                }
            }
        }
    } }
    private fun ensureFresh() {
        val current=credentials ?: throw LiveFailure("authentication_required")
        refreshActor(current,currentScope()) { value,_,scope->install(value,current.account,scope) }
    }
    private fun registered() { if(accountDeletion!=null)throw LiveFailure("deletion_requires_status");if(faceLifecycle?.blocksPrivate==true)throw LiveFailure("face_profile_requires_status");if(cameraLoginHeld)throw LiveFailure("face_login_requires_status");if(accountRecovery!=null)throw LiveFailure("account_recovery_requires_status");if(enrollment!=null)throw LiveFailure("enrollment_requires_recovery");ensureFresh();if(credentials?.method!="registered_face")throw LiveFailure("registered_face_required",403) }
    private suspend fun ready(requireRegistered: Boolean=true): Pair<SessionScope,LiveCredentials> = mutex.withLock {
        if(requireRegistered)registered() else ensureFresh()
        currentScope() to (credentials ?: throw LiveFailure("authentication_required"))
    }
    suspend fun get(path: String,protected: Boolean=true): WireObject=withContext(Dispatchers.IO) {
        val (scope,actor)=ready(protected);json(path,scope,actor.token)
    }
    suspend fun post(path: String,payload: WireObject): WireObject=withContext(Dispatchers.IO) {
        val (scope,actor)=ready();json(path,scope,actor.token,"POST",payload)
    }
    private class EnrollmentPhase(var scope: SessionScope)
    private fun assertEnrollment(record: EnrollmentJournal,scope: SessionScope,allowGuest: Boolean=false) {
        fence.assert(scope);record.assertIntent(enrollment)
        if(record.origin!=baseUrl || credentials?.account?.let { it!=record.account }==true)throw LiveFailure("enrollment_scope_changed")
        if(!allowGuest && guestDeletion!=null)throw LiveFailure("deletion_requires_status")
    }
    private fun enrollmentKey(record: EnrollmentJournal): String {
        record.assertKey(vault.existingDevice(record.alias));return record.alias
    }
    private fun saveEnrollment(record: EnrollmentJournal,phase: EnrollmentPhase,allowGuest: Boolean=false,extra: WireObject=emptyMap(),afterWrite: ()->Unit = {}) {
        val previous=enrollment ?: throw LiveFailure("enrollment_requires_recovery")
        withEnrollmentPhase(fence,phase.scope,previous,{enrollment}) {
            assertEnrollment(previous,phase.scope,allowGuest)
            synchronized(storage) {
                persistEnrollmentState(credentialCandidate(storage.toMap()+extra+mapOf("enrollment" to record.wire())),vault::save) { saved ->
                    afterWrite();storage.clear();storage.putAll(saved.filterValues { it!=null });enrollment=record
                }
            }
        }
    }
    private fun originalAnonymous(record: EnrollmentJournal,phase: EnrollmentPhase,allowGuest: Boolean=false): LiveCredentials {
        var current=withEnrollmentPhase(fence,phase.scope,record,{enrollment}) {
            assertEnrollment(record,phase.scope,allowGuest)
            val stored=credentials ?: storage["credentials"]?.let { parseCredentials(NativeProtocol.obj(it),record.account) }
                ?: throw LiveFailure("enrollment_account_unavailable")
            if(stored.account!=record.account || stored.method!="anonymous")throw LiveFailure("enrollment_account_unavailable")
            if(credentials==null) { credentials=stored;phase.scope=fence.switch(stored.account) }
            stored
        }
        if(needsRefresh(current)) {
            current=refreshActor(current,phase.scope) { result,refreshed,scope->
            withEnrollmentPhase(fence,scope,record,{enrollment}) {
                assertEnrollment(record,scope,allowGuest)
                if(refreshed.method!="anonymous")throw LiveFailure("enrollment_account_unavailable")
                saveEnrollment(record,phase,allowGuest,mapOf("credentials" to result)) {
                    credentials=refreshed;phase.scope=fence.switch(refreshed.account)
                }
                phase.scope
            }
            }.first
        }
        withEnrollmentPhase(fence,phase.scope,record,{enrollment}) { assertEnrollment(record,phase.scope,allowGuest) }
        return current
    }
    private fun startEnrollment(record: EnrollmentJournal,phase: EnrollmentPhase): EnrollmentJournal {
        val actor=originalAnonymous(record,phase);val scope=phase.scope
        val body=record.startBody(vault.sign(enrollmentKey(record),record.startEnvelope()))
        val result=json("/auth/face/registration/challenge",scope,actor.token,"POST",body)
        val next=record.withChallenge(result)
        saveEnrollment(next,phase);return next
    }
    private fun reconcileEnrollment(record: EnrollmentJournal,phase: EnrollmentPhase,allowGuest: Boolean=false,retryAbsentStart: Boolean=true): EnrollmentJournal {
        withEnrollmentPhase(fence,phase.scope,record,{enrollment}) { assertEnrollment(record,phase.scope,allowGuest) }
        if(record.generation==0L && credentials?.method=="anonymous" && credentials!!.expires<=System.currentTimeMillis()+30000 && !allowGuest)
            originalAnonymous(record,phase)
        val nonce=UUID.randomUUID().toString();val fields=record.queryFields(nonce,System.currentTimeMillis()+45000)
        val body=fields+mapOf("device_signature" to vault.sign(enrollmentKey(record),record.envelope(fields,"status")))
        // Read-only status may succeed after the old anonymous session was revoked by completion.
        val token=credentials?.takeIf { it.account==record.account && it.method=="anonymous" && it.expires>System.currentTimeMillis() }?.token
        try {
            val result=json("/auth/face/registration/recovery",phase.scope,token,"POST",body)
            val next=record.reconcile(result,nonce,System.currentTimeMillis());saveEnrollment(next,phase,allowGuest);return next
        } catch(problem: LiveFailure) {
            if(record.allowsStartRetry(problem,token!=null)) {
                withEnrollmentPhase(fence,phase.scope,record,{enrollment}) { assertEnrollment(record,phase.scope,allowGuest) }
                if(!retryAbsentStart)return record
                if(!allowGuest)return startEnrollment(record,phase)
            }
            throw problem
        }
    }
    private fun resumeEnrollment(record: EnrollmentJournal,phase: EnrollmentPhase): EnrollmentJournal {
        val actor=originalAnonymous(record,phase)
        val predecessor=record.challengeId ?: throw LiveFailure("enrollment_requires_recovery")
        val resume=record.resume ?: mapOf("resume_key" to UUID.randomUUID().toString(),"expected_generation" to record.generation,
            "expected_challenge_id" to predecessor)
        val saved=record.copy(resume=resume);saveEnrollment(saved,phase)
        val fields=saved.queryFields(UUID.randomUUID().toString(),System.currentTimeMillis()+45000)+resume
        val body=fields+mapOf("device_signature" to vault.sign(enrollmentKey(saved),saved.envelope(fields,"resume")))
        val result=json("/auth/face/registration/resume",phase.scope,actor.token,"POST",body)
        val next=saved.withChallenge(result,successor=true);saveEnrollment(next,phase);return next
    }
    private fun validateFaceCredentials(record: EnrollmentJournal,result: WireObject): EnrollmentJournal {
        val actor=parseCredentials(result,record.account)
        if(actor.method!="registered_face" || result["protocol"]!="lovelies-face-auth-v1" || result["status"]!="authenticated" ||
            NativeProtocol.id(result["device_id"])!=record.device)throw LiveFailure("enrollment_response_changed")
        val profile=mapOf("id" to NativeProtocol.id(result["profile_id"]),"revision" to NativeProtocol.text(result["profile_revision"]),"model_id" to NativeProtocol.text(result["model_id"]))
        if(record.profile!=null && NativeProtocol.canonical(profile)!=NativeProtocol.canonical(record.profile))throw LiveFailure("enrollment_response_changed")
        return record.copy(state="credentials_pending",profile=profile,credentialResult=result)
    }
    private fun promoteEnrollment(record: EnrollmentJournal,phase: EnrollmentPhase): WireObject {
        var promoting=record
        // A surviving same-account registered slot may be newer than the initial completion result.
        val surviving=storage["credentials"]?.let { parseCredentials(NativeProtocol.obj(it),record.account) }
        if(surviving?.method=="registered_face")promoting=record.rotatedCredentials(surviving.wire)
        var result=promoting.credentialResult ?: throw LiveFailure("enrollment_requires_recovery")
        var actor=parseCredentials(result,record.account)
        if(actor.method!="registered_face")throw LiveFailure("enrollment_response_changed")
        val device=DeviceIdentity(record.account,enrollmentKey(record),record.handle,record.device ?: throw LiveFailure("enrollment_response_changed"))
        saveEnrollment(promoting,phase,extra=mapOf("credentials" to result,"device" to device.wire())) {
            clearPrivateScope();identity=device;credentials=actor;phase.scope=fence.switch(actor.account)
        }
        if(needsRefresh(actor)) {
            actor=refreshActor(actor,phase.scope) { refreshed,current,_->
            if(current.method!="registered_face")throw LiveFailure("enrollment_response_changed")
            val rotated=promoting.rotatedCredentials(refreshed)
            saveEnrollment(rotated,phase,extra=mapOf("credentials" to refreshed)) { credentials=current;phase.scope=fence.switch(current.account) }
            promoting=rotated;result=refreshed;phase.scope
            }.first
        }
        val scope=phase.scope
        val me=json("/me",scope,actor.token)
        val devices=json("/me/devices",scope,actor.token)
        if(NativeProtocol.rows(devices["items"]).singleOrNull { it["current"]==true }?.get("id")!=record.device)throw LiveFailure("enrollment_response_changed")
        return withEnrollmentPhase(fence,scope,promoting,{enrollment}) {
            assertEnrollment(promoting,scope)
            if(me["user_id"]!=record.account || me["authenticated"]!=true || me["auth_method"]!="registered_face" ||
                me["profile_id"]!=record.profile?.get("id") || me["profile_revision"]!=record.profile?.get("revision"))throw LiveFailure("enrollment_response_changed")
            synchronized(storage) {
                persistEnrollmentState(storage.toMap().filterKeys { it!="enrollment" },vault::save) { saved ->
                    storage.clear();storage.putAll(saved.filterValues { it!=null });enrollment=null
                }
            }
            result
        }
    }
    private fun completeEnrollment(record: EnrollmentJournal,phase: EnrollmentPhase): WireObject {
        if(record.accepted.size!=3 || record.state!="pending")throw LiveFailure("enrollment_requires_recovery")
        val value=record.challenge ?: throw LiveFailure("challenge_unavailable")
        val actor=originalAnonymous(record,phase)
        val complete=record.completion ?: mapOf("challenge_id" to value["challenge_id"],"device_signature" to vault.sign(enrollmentKey(record),
            NativeProtocol.faceEnvelope(value)+mapOf("step" to "complete","capture_manifest" to record.accepted.map(EnrollmentCapture::wire))))
        val saved=record.copy(state="completion_pending",completion=complete);saveEnrollment(saved,phase)
        val result=json("/auth/face/registration/complete",phase.scope,actor.token,"POST",complete)
        val next=validateFaceCredentials(saved,result);saveEnrollment(next,phase)
        return promoteEnrollment(next,phase)
    }
    private fun loginChallenge(account: String,alias: String,handle: String,device: String,scope: SessionScope,profile: WireObject?=null): WireObject {
        vault.existingDevice(alias)
        val ordinary=faceLifecycle?.loginKey==null
        val restored=if(ordinary)cameraLogin() else null
        val held=restored?.takeIf { it.state=="credentials_pending" }?.let { staged->
            val actor=parseCredentials(staged.credentials ?: throw LiveFailure("face_login_requires_status"),account)
            staged.assertCredentialBinding(actor.wire)
            val stripped=staged.withoutExpiredCredentials(actor.expires,System.currentTimeMillis())
            if(stripped!=staged)saveCameraLogin(stripped,scope)
            stripped
        } ?: restored
        held?.assertOwner(baseUrl,account,alias,device)
        if(held?.blocked(System.currentTimeMillis())==true)throw LiveFailure("face_login_in_flight")
        if(held?.state=="credentials_pending") {
            val result=held.credentials ?: throw LiveFailure("face_login_requires_status")
            val actor=parseCredentials(result,account)
            held.assertCredentialBinding(result)
            faceLifecycle?.takeIf { it.intent?.capture==true }?.let { record->
                val phase=LifecyclePhase(scope);val next=record.withCredentials(result);saveLifecycle(next,phase)
                val promoted=promoteLifecycle(next,phase);saveCameraLogin(null,currentScope());return promoted
            }
            enrollment?.let { record->
                val phase=EnrollmentPhase(scope);val next=validateFaceCredentials(record,result);saveEnrollment(next,phase)
                val promoted=promoteEnrollment(next,phase);saveCameraLogin(null,currentScope());return promoted
            }
            accountRecovery?.let { record->
                val phase=AccountPhase(scope);val next=record.withCredentials(result);saveAccountRecovery(next,phase)
                val promoted=promoteAccountRecovery(next,phase);saveCameraLogin(null,currentScope());return promoted
            }
            val promoted=install(result,account,scope)
            val me=json("/me",promoted,actor.token);val devices=json("/me/devices",promoted,actor.token)
            assertCameraLoginSession(held,me,devices)
            faceLifecycle?.let { lifecycleStatusLocked(it,LifecyclePhase(promoted)) }
            saveCameraLogin(null,promoted);return result
        }
        val result=if(held?.state=="ready" && !held.expired(System.currentTimeMillis()))held.challenge
            else json("/auth/face/challenge",scope,null,"POST",mapOf("face_handle" to handle,"device_id" to device))
        NativeProtocol.bindFaceChallenge(result,account,"login",device)
        NativeProtocol.expiry(result["expires_at"],System.currentTimeMillis())
        if(result["protocol"]!="lovelies-face-auth-v1" || NativeProtocol.integer(result["required_captures"],1,3)!=1L ||
            profile!=null && (result["profile_id"]!=profile["id"] || result["profile_revision"]!=profile["revision"] || result["model_id"]!=profile["model_id"]))throw LiveFailure("challenge_invalid")
        if(ordinary)saveCameraLogin(CameraLoginJournal(baseUrl,account,alias,device,result),scope)
        synchronized(fence) {
            fence.assert(scope);if(guestDeletion!=null)throw LiveFailure("deletion_requires_status")
            signingAlias=alias;challenge=result;captures.clear()
        }
        return result
    }
    suspend fun faceChallenge(): WireObject = withContext(Dispatchers.IO) { mutex.withLock {
        if(guestDeletion!=null)throw LiveFailure("deletion_requires_status")
        if(faceLifecycle?.blocksPrivate==true || faceLifecycle!=null && accountRecovery==null && enrollment==null)return@withLock lifecycleChallengeLocked()
        if(storageBlocked || storage.containsKey("account_recovery") && accountRecovery==null)throw LiveFailure("account_recovery_storage_unavailable")
        if(accountRecovery!=null)return@withLock accountRecoveryChallenge()
        if(storageBlocked || storage.containsKey("enrollment") && enrollment==null)throw LiveFailure("enrollment_storage_unavailable")
        if(guestDeletion!=null)throw LiveFailure("deletion_requires_status")
        clearPrivateScope()
        enrollment?.let { previous ->
            val phase=EnrollmentPhase(currentScope())
            var recovered=reconcileEnrollment(previous,phase)
            if(recovered.state in setOf("capture_pending","verifying"))throw LiveFailure("enrollment_in_flight")
            if(recovered.state=="credentials_pending") {
                try { return@withLock promoteEnrollment(recovered,phase) }
                catch(problem: LiveFailure) {
                    if(problem.status !in listOf(401,403))throw problem
                    recovered=recovered.copy(state="registered",credentialResult=null);saveEnrollment(recovered,phase)
                }
            }
            if(recovered.state=="registered")return@withLock loginChallenge(recovered.account,enrollmentKey(recovered),recovered.handle,
                recovered.device!!,phase.scope,recovered.profile)
            if(recovered.state=="restart_required")recovered=resumeEnrollment(recovered,phase)
            if(recovered.accepted.size==3)return@withLock completeEnrollment(recovered,phase)
            NativeProtocol.expiry(recovered.challenge?.get("expires_at"),System.currentTimeMillis())
            withEnrollmentPhase(fence,phase.scope,recovered,{enrollment}) {
                assertEnrollment(recovered,phase.scope);challenge=recovered.challenge;signingAlias=enrollmentKey(recovered)
            }
            return@withLock recovered.challenge!!
        }
        identity?.let { old -> return@withLock loginChallenge(old.account,old.alias,old.handle,old.device,currentScope()) }
        if(credentials==null) {
            if(hasPendingRefresh()) {
                val held=storage["credentials"]?.let { parseCredentials(NativeProtocol.obj(it)) } ?: throw LiveFailure("refresh_delivery_requires_status")
                synchronized(fence) { credentials=held;fence.switch(held.account) }
            }
        }
        if(credentials==null) {
            if(vault.hasEnrollmentKeys())throw LiveFailure("enrollment_storage_unavailable")
            val before=currentScope();install(json("/auth/anonymous",before,null,"POST",emptyMap()),expectedScope=before)
        }
        ensureFresh();val actor=credentials ?: throw LiveFailure("authentication_required")
        if(actor.method!="anonymous")throw LiveFailure("enrollment_scope_changed")
        val before=currentScope();val policy=json("/auth/face/policy",before,null)
        if(policy["protocol"]!="lovelies-face-auth-v1" || policy["available"]!=true || NativeProtocol.integer(policy["required_captures"],1,3)!=3L)throw LiveFailure("face_authentication_unavailable",503)
        val saved=synchronized(fence) {
            fence.assert(before);if(credentials?.account!=actor.account || guestDeletion!=null || enrollment!=null)throw LiveFailure("enrollment_scope_changed")
            val alias=vault.enrollmentAlias(actor.account);val jwk=vault.createDevice(alias)
            val record=EnrollmentJournal.create(baseUrl,actor.account,alias,jwk,NativeProtocol.text(policy["policy_version"]))
            synchronized(storage) {
                try {
                    persistEnrollmentState(storage.toMap()+mapOf("enrollment" to record.wire()),vault::save) { candidate ->
                        storage.clear();storage.putAll(candidate.filterValues { it!=null });enrollment=record
                    }
                } catch(problem: Exception) { storageBlocked=true;throw problem }
            }
            record
        }
        val phase=EnrollmentPhase(before);val result=startEnrollment(saved,phase)
        withEnrollmentPhase(fence,phase.scope,result,{enrollment}) { assertEnrollment(result,phase.scope);challenge=result.challenge;signingAlias=result.alias }
        result.challenge!!
    } }
    private fun assertCurrentFrame(frame: NativeCaptureContext,scope: SessionScope,value: WireObject) {
        val index=if(faceLifecycle?.loginKey!=null)faceLifecycle?.accepted?.size ?: 0
            else if(faceLifecycle?.intent?.capture==true && faceLifecycle?.state !in setOf("registered","credentials_pending"))faceLifecycle?.accepted?.size ?: 0
            else if(value["purpose"]=="registration")enrollment?.accepted?.size ?: 0
            else if(accountRecovery?.state !in setOf("registered","credentials_pending") && accountRecovery!=null) { if(accountRecovery?.accepted==true)1 else 0 }
            else captures.size
        val request=faceLifecycle?.loginKey ?: if(faceLifecycle?.intent?.capture==true)"${faceLifecycle!!.intent!!.key}:${faceLifecycle!!.generation}"
            else accountRecovery?.requestId ?: enrollment?.key ?: NativeProtocol.id(value["challenge_id"])
        assertFaceFrameBinding(frame,scope,baseUrl,value,request,index)
    }
    private fun signCapturedFrame(bytes: ByteArray,frame: NativeCaptureContext?,scope: SessionScope,alias: String,envelope: WireObject): String {
        try { return synchronized(fence) {
            fence.assert(scope)
            frame?.let { assertCurrentFrame(it,scope,challenge ?: throw LiveFailure("capture_context_changed")) }
            vault.sign(alias,envelope)
        } } catch(problem: LiveFailure) { bytes.fill(0);throw problem }
    }
    suspend fun faceCapture(bytes: ByteArray,frame: NativeCaptureContext?=null): Pair<Int,WireObject?> = withContext(Dispatchers.IO) { mutex.withLock {
        val scope=frame?.session ?: currentScope()
        val value=try {
            synchronized(fence) {
                fence.assert(scope)
                if(guestDeletion!=null)throw LiveFailure("deletion_requires_status")
                val current=challenge ?: throw LiveFailure("challenge_unavailable")
                frame?.let { assertCurrentFrame(it,scope,current) }
                current
            }
        } catch(problem: LiveFailure) { if(frame!=null)bytes.fill(0);throw problem }
        NativeProtocol.expiry(value["expires_at"],System.currentTimeMillis())
        faceLifecycle?.let { life->
            if(life.loginKey!=null)return@withLock lifecycleLoginCapture(bytes,life,scope,frame)
            if(life.intent?.capture==true && life.state !in setOf("registered","credentials_pending"))return@withLock lifecycleCapture(bytes,life,scope,frame)
        }
        val recovery=accountRecovery
        if(recovery!=null && recovery.state !in setOf("registered","credentials_pending"))return@withLock accountRecoveryCapture(bytes,recovery,scope,frame)
        if(value["purpose"]=="registration") {
            val previous=enrollment ?: throw LiveFailure("enrollment_requires_recovery")
            val phase=EnrollmentPhase(scope);originalAnonymous(previous,phase)
            val planned=previous.plan(bytes);val item=planned.planned.last();saveEnrollment(planned,phase)
            val signed=NativeProtocol.faceEnvelope(value)+mapOf("step" to "capture","capture_index" to item.index,"capture_sha256" to item.hash,"mime" to item.mime,"byte_size" to item.bytes)
            val response=transport.request("/auth/face/proof/${value["challenge_id"]}/${item.index}",phase.scope,credentials!!.token,"PUT",bytes,item.mime,
                mapOf("x-lovelies-capture-sha256" to item.hash,"x-lovelies-capture-bytes" to item.bytes.toString(),"x-lovelies-device-signature" to signCapturedFrame(bytes,frame,phase.scope,enrollmentKey(planned),signed)))
            try { item.assertAcknowledgement(jsonMap(JSONObject(response.toString(Charsets.UTF_8))),NativeProtocol.id(value["challenge_id"])) }
            catch(problem: LiveFailure) { throw problem }
            catch(problem: Exception) { throw LiveFailure("capture_acknowledgement_changed") }
            finally { response.fill(0) }
            val next=planned.copy(state="pending",accepted=planned.planned);saveEnrollment(next,phase)
            if(next.accepted.size<3)return@withLock next.accepted.size to null
            return@withLock 3 to completeEnrollment(next,phase)
        }
        val index=captures.size;val required=NativeProtocol.integer(value["required_captures"],1,3).toInt()
        if(index>=required || bytes.isEmpty() || bytes.size>8*1024*1024)throw LiveFailure("capture_too_large")
        val hash=NativeProtocol.sha256(bytes);val mime="image/jpeg"
        val manifest=mapOf("index" to index,"sha256" to hash,"mime" to mime,"byte_size" to bytes.size)
        val signed=NativeProtocol.faceEnvelope(value)+mapOf("step" to "capture","capture_index" to index,"capture_sha256" to hash,"mime" to mime,"byte_size" to bytes.size)
        val alias=signingAlias ?: throw LiveFailure("device_key_unavailable")
        vault.existingDevice(alias)
        val held=cameraLogin()?.also { it.assertOwner(baseUrl,NativeProtocol.id(value["account_id"]),alias,NativeProtocol.id(value["device_id"])) }
        val planned=held?.plan(bytes);if(planned!=null)saveCameraLogin(planned,scope)
        val response=transport.request("/auth/face/proof/${value["challenge_id"]}/$index",scope,null,"PUT",bytes,mime,
            mapOf("x-lovelies-capture-sha256" to hash,"x-lovelies-capture-bytes" to bytes.size.toString(),"x-lovelies-device-signature" to signCapturedFrame(bytes,frame,scope,alias,signed)))
        try { EnrollmentCapture(index,hash,mime,bytes.size.toLong()).assertAcknowledgement(jsonMap(JSONObject(response.toString(Charsets.UTF_8))),NativeProtocol.id(value["challenge_id"])) }
        catch(problem: LiveFailure) { throw problem }
        catch(problem: Exception) { throw LiveFailure("capture_acknowledgement_changed") }
        finally { response.fill(0) }
        synchronized(fence) { fence.assert(scope);captures.add(manifest) }
        val completion=mapOf("challenge_id" to value["challenge_id"],"device_signature" to vault.sign(alias,
            NativeProtocol.faceEnvelope(value)+mapOf("step" to "complete","capture_manifest" to captures.toList())))
        val completing=planned?.complete(completion);if(completing!=null)saveCameraLogin(completing,scope)
        val result=try { json("/auth/face/complete",scope,null,"POST",completion) }
            catch(problem: LiveFailure) {
                if(completing?.terminal(problem)==true)saveCameraLogin(completing.copy(state="rejected",credentials=null),scope)
                throw problem
            }
        if(completing!=null)saveCameraLogin(completing.copy(state="credentials_pending",credentials=result),scope)
        faceLifecycle?.let { record->
            if(record.intent?.capture==true) {
                val phase=LifecyclePhase(scope);val next=record.withCredentials(result);saveLifecycle(next,phase)
                val promoted=promoteLifecycle(next,phase);saveCameraLogin(null,currentScope());return@withLock required to promoted
            }
            if(result["profile_id"]!=record.metadata.profile?.get("id") || result["profile_revision"]!=record.metadata.profile?.get("revision") ||
                result["model_id"]!=record.metadata.profile?.get("model_id"))throw LiveFailure("face_profile_response_changed")
            val nextScope=install(result,record.account,scope)
            lifecycleStatusLocked(record,LifecyclePhase(nextScope));saveCameraLogin(null,currentScope())
            return@withLock required to result
        }
        accountRecovery?.let { record ->
            parseCredentials(result,record.account)
            val phase=AccountPhase(scope);val next=record.withCredentials(result);saveAccountRecovery(next,phase)
            val promoted=promoteAccountRecovery(next,phase);saveCameraLogin(null,currentScope());return@withLock required to promoted
        }
        enrollment?.let { record ->
            val phase=EnrollmentPhase(scope);val next=validateFaceCredentials(record,result);saveEnrollment(next,phase)
            val promoted=promoteEnrollment(next,phase);saveCameraLogin(null,currentScope());return@withLock required to promoted
        }
        val validating=completing ?: throw LiveFailure("face_login_requires_status")
        validating.assertCredentialBinding(result)
        synchronized(fence) { fence.assert(scope);install(result,NativeProtocol.id(value["account_id"]),scope) }
        val promoted=currentScope();val me=json("/me",promoted);val devices=json("/me/devices",promoted)
        assertCameraLoginSession(validating,me,devices)
        saveCameraLogin(null,promoted);required to result
    } }
    private class LifecyclePhase(var scope: SessionScope)
    private fun retiredLifecycles(): List<FaceLifecycleJournal> = storage["retired_face_lifecycles"]?.let {
        NativeProtocol.rows(it,16).map { row->FaceLifecycleJournal.restore(row,baseUrl) }
    } ?: emptyList()
    private fun assertLifecycle(record: FaceLifecycleJournal,scope: SessionScope) {
        fence.assert(scope);record.assertIntent(faceLifecycle)
        if(guestDeletion!=null)throw LiveFailure("deletion_requires_status")
        if(record.origin!=baseUrl || identity?.account!=record.account || identity?.alias!=record.alias || identity?.device!=record.device ||
            credentials?.let { it.method=="registered_face" && it.account!=record.account }==true)throw LiveFailure("face_profile_scope_changed")
    }
    private fun lifecycleKey(record: FaceLifecycleJournal): String { record.assertKey(vault.existingDevice(record.alias));return record.alias }
    private fun saveLifecycle(record: FaceLifecycleJournal,phase: LifecyclePhase,extra: WireObject=emptyMap(),retire: Boolean=false,after: ()->Unit={}) {
        val previous=faceLifecycle ?: throw LiveFailure("face_profile_requires_status")
        withLifecyclePhase(fence,phase.scope,previous,{faceLifecycle}) {
            assertLifecycle(previous,phase.scope)
            var candidate=storage.toMap()+extra+mapOf("face_lifecycle" to record.wire())
            if(record.metadata.version!=previous.metadata.version || retire)candidate=candidate.filterKeys { it !in setOf("review","last_outcome","pending") }
            if(retire)candidate=candidate.filterKeys { it !in setOf("credentials","picked_uris","upload_ids","upload_batch","upload_records","favorites") }
            candidate=if(retire)retireRefreshCandidate(candidate) else credentialCandidate(candidate)
            synchronized(storage) { persistLifecycle(candidate,vault::save) { saved->
                if(record.metadata.version!=previous.metadata.version)pending=null
                if(retire) { clearPrivateScope();credentials=null;pending=null;phase.scope=fence.switch(null) }
                after();storage.clear();storage.putAll(saved.filterValues { it!=null });faceLifecycle=record
            } }
        }
    }
    private fun signedLifecycle(record: FaceLifecycleJournal,phase: LifecyclePhase,step: String,path: String,fields: WireObject=emptyMap()): Pair<WireObject,String> {
        val nonce=UUID.randomUUID().toString();val body=record.query(nonce)+fields
        val signature=withLifecyclePhase(fence,phase.scope,record,{faceLifecycle}) {
            assertLifecycle(record,phase.scope);vault.sign(lifecycleKey(record),record.envelope(step,body))
        }
        return json(path,phase.scope,null,"POST",body+mapOf("device_signature" to signature)) to nonce
    }
    private fun dispatchLifecycleControl(record: FaceLifecycleJournal,phase: LifecyclePhase): FaceLifecycleJournal {
        val actor=withLifecyclePhase(fence,phase.scope,record,{faceLifecycle}) {
            assertLifecycle(record,phase.scope)
            credentials?.takeIf { it.account==record.account && it.method=="registered_face" && it.expires>System.currentTimeMillis() }
                ?: throw LiveFailure("face_profile_control_requires_login")
        }
        val body=record.controlBody();val signature=withLifecyclePhase(fence,phase.scope,record,{faceLifecycle}) {
            assertLifecycle(record,phase.scope);vault.sign(lifecycleKey(record),record.envelope("control",body))
        }
        val value=json("/auth/face/profile/control",phase.scope,actor.token,"POST",body+mapOf("device_signature" to signature))
        val next=record.reconcile(value);saveLifecycle(next,phase);return next
    }
    private fun ensureLifecycle(expectedScope: SessionScope): Pair<FaceLifecycleJournal,SessionScope> {
        faceLifecycle?.let { record->return withLifecyclePhase(fence,expectedScope,record,{faceLifecycle}) { assertLifecycle(record,expectedScope);record to expectedScope } }
        if(storageBlocked)throw LiveFailure("face_profile_storage_unavailable")
        if(guestDeletion!=null)throw LiveFailure("deletion_requires_status")
        if(enrollment!=null || accountRecovery!=null || pending!=null)throw LiveFailure("pending_operation_requires_reconciliation")
        val original=synchronized(fence) {
            fence.assert(expectedScope);val scope=expectedScope;val actor=credentials?.takeIf { it.method=="registered_face" } ?: throw LiveFailure("registered_face_required",403)
            scope to actor
        }
        var scope=original.first;var actor=original.second
        if(needsRefresh(actor)) {
            val refreshed=refreshActor(actor,scope) { value,_,expected->install(value,actor.account,expected) }
            actor=refreshed.first;scope=refreshed.second
        }
        val device=synchronized(fence) { fence.assert(scope);identity?.takeIf { it.account==actor.account } ?: throw LiveFailure("device_key_unavailable") }
        val jwk=vault.existingDevice(device.alias);val digest=NativeProtocol.sha256(NativeProtocol.canonical(jwk).toByteArray())
        val metadata=FaceLifecycleMetadata.parse(json("/me/face-profile",scope,actor.token),actor.account,device.device,digest)
        val record=FaceLifecycleJournal.create(baseUrl,device,jwk,metadata)
        synchronized(fence) {
            fence.assert(scope);if(faceLifecycle!=null || guestDeletion!=null || identity!=device)throw LiveFailure("face_profile_scope_changed")
            synchronized(storage) { persistLifecycle(storage.toMap()+mapOf("face_lifecycle" to record.wire()),vault::save) { saved->
                storage.clear();storage.putAll(saved.filterValues { it!=null });faceLifecycle=record
            } }
        }
        val phase=LifecyclePhase(scope);return dispatchLifecycleControl(record,phase) to phase.scope
    }
    private fun dispatchLifecycleIntent(record: FaceLifecycleJournal,phase: LifecyclePhase): FaceLifecycleJournal {
        val intent=record.intent ?: throw LiveFailure("face_profile_requires_status")
        val (value,nonce)=signedLifecycle(record,phase,if(intent.capture)"challenge" else "action",
            if(intent.capture)"/auth/face/profile/challenge" else "/auth/face/profile/action",intent.body())
        val next=if(intent.capture)record.withChallenge(value) else record.reconcile(value,nonce)
        saveLifecycle(next,phase,retire=!intent.capture && !next.metadata.authenticationEnabled);return next
    }
    private fun lifecycleStatusLocked(record: FaceLifecycleJournal,phase: LifecyclePhase): FaceLifecycleJournal {
        try {
            val (value,nonce)=signedLifecycle(record,phase,"status","/auth/face/profile/status",record.intent?.let { mapOf("operation_key" to it.key) } ?: emptyMap())
            val next=if(record.state=="cancel_pending" && NativeProtocol.obj(value["operation"])["state"] in setOf("cancelled","completed"))record.cancelAcknowledgement(value,nonce)
                else record.reconcile(value,nonce)
            saveLifecycle(next,phase,retire=!next.metadata.authenticationEnabled && next.state!="credentials_pending");return next
        } catch(problem: LiveFailure) {
            if(!record.acknowledged && problem.status==404 && problem.code=="face_profile_control_not_found")return dispatchLifecycleControl(record,phase)
            val intent=record.intent
            if(problem.status!=404 || problem.code!="face_profile_operation_not_found" || intent==null)throw problem
            val (value,nonce)=signedLifecycle(record,phase,"status","/auth/face/profile/status")
            val resolution=record.resolveAbsentOperation(value,nonce);saveLifecycle(resolution.journal,phase)
            if(!resolution.retryOriginal)throw LiveFailure("face_profile_cancel_pending")
            return dispatchLifecycleIntent(resolution.journal,phase)
        }
    }
    suspend fun lifecycleStatus(expectedScope: SessionScope=currentScope()): FaceLifecycleMetadata=withContext(Dispatchers.IO) { mutex.withLock {
        val (record,scope)=ensureLifecycle(expectedScope)
        if(record.loginKey!=null) {
            if(record.state=="login_credentials_pending")return@withLock promoteLifecycleLogin(record,LifecyclePhase(scope)).let { faceLifecycle!!.metadata }
            throw LiveFailure("face_profile_login_pending")
        }
        lifecycleStatusLocked(record,LifecyclePhase(scope)).metadata
    } }
    /** Explicit same-device sign-in; a control never supplies authentication or consent. */
    suspend fun lifecycleVerify(expectedScope: SessionScope=currentScope()): WireObject=withContext(Dispatchers.IO) { mutex.withLock {
        val record=faceLifecycle ?: throw LiveFailure("face_profile_requires_status");val phase=LifecyclePhase(expectedScope)
        assertLifecycle(record,phase.scope)
        val saved=if(record.loginKey==null)record.beginStableLogin().also { saveLifecycle(it,phase) } else record
        lifecycleLoginChallenge(saved,phase)
    } }
    private fun currentLifecycleMetadata(record: FaceLifecycleJournal,phase: LifecyclePhase,actor: LiveCredentials,profile: WireObject?=null): FaceLifecycleMetadata {
        if(actor.account!=record.account || actor.method!="registered_face")throw LiveFailure("face_profile_control_requires_login")
        val me=json("/me",phase.scope,actor.token);val devices=json("/me/devices",phase.scope,actor.token)
        val meta=FaceLifecycleMetadata.parse(json("/me/face-profile",phase.scope,actor.token),record.account,record.device,record.digest,
            record.metadata.deviceRevision,minimum=record.metadata.version)
        return withLifecyclePhase(fence,phase.scope,record,{faceLifecycle}) {
            assertLifecycle(record,phase.scope)
            assertLifecycleSession(record,meta,me,devices,profile)
            meta
        }
    }
    /** Renewal is explicit, current-bearer authorized, and journals its new secret before POST. */
    suspend fun lifecycleRenew(expectedScope: SessionScope=currentScope()): FaceLifecycleMetadata=withContext(Dispatchers.IO) { mutex.withLock {
        val prior=faceLifecycle ?: throw LiveFailure("face_profile_requires_status");val phase=LifecyclePhase(expectedScope)
        assertLifecycle(prior,phase.scope)
        if(prior.blocksPrivate || prior.loginKey!=null || enrollment!=null || accountRecovery!=null)throw LiveFailure("face_profile_requires_status")
        var actor=withLifecyclePhase(fence,phase.scope,prior,{faceLifecycle}) {
            credentials?.takeIf { it.account==prior.account && it.method=="registered_face" } ?: throw LiveFailure("face_profile_control_requires_login")
        }
        if(needsRefresh(actor)) {
            actor=refreshActor(actor,phase.scope) { refresh,next,_->
                saveLifecycle(prior,phase,mapOf("credentials" to refresh)) { credentials=next;phase.scope=fence.switch(next.account) };phase.scope
            }.first
        }
        val meta=currentLifecycleMetadata(prior,phase,actor)
        try { lifecycleStatusLocked(prior,phase);throw LiveFailure("face_profile_control_not_expired") }
        catch(problem: LiveFailure) { if(problem.status!=401 || problem.code!="face_profile_control_unavailable")throw problem }
        val history=(retiredLifecycles()+prior).distinctBy { it.controlOperation }
        if(history.size>16)throw LiveFailure("secure_storage_full")
        val renewed=prior.renew(meta)
        saveLifecycle(renewed,phase,mapOf("retired_face_lifecycles" to history.map(FaceLifecycleJournal::wire))) {
            clearPrivateScope();phase.scope=fence.switch(actor.account)
        }
        dispatchLifecycleControl(renewed,phase).metadata
    } }
    suspend fun lifecycleAction(action: String,reviewedVersion: Long?=faceLifecycle?.metadata?.version,expectedScope: SessionScope=currentScope()): FaceLifecycleMetadata=withContext(Dispatchers.IO) { mutex.withLock {
        val (prior,scope)=ensureLifecycle(expectedScope);val phase=LifecyclePhase(scope)
        val current=lifecycleStatusLocked(prior,phase)
        if(reviewedVersion!=null && current.metadata.version!=reviewedVersion)throw LiveFailure("face_profile_version_changed")
        val next=current.begin(action)
        if(next.intent?.capture==true)throw LiveFailure("face_profile_action_invalid")
        saveLifecycle(next,phase);dispatchLifecycleIntent(next,phase).metadata
    } }
    suspend fun lifecycleBegin(action: String,reviewedVersion: Long?=faceLifecycle?.metadata?.version,expectedScope: SessionScope=currentScope()): WireObject=withContext(Dispatchers.IO) { mutex.withLock {
        val (prior,scope)=ensureLifecycle(expectedScope);val phase=LifecyclePhase(scope);val current=lifecycleStatusLocked(prior,phase)
        if(reviewedVersion!=null && current.metadata.version!=reviewedVersion)throw LiveFailure("face_profile_version_changed")
        val next=current.begin(action);if(next.intent?.capture!=true)throw LiveFailure("face_profile_action_invalid")
        saveLifecycle(next,phase);val started=dispatchLifecycleIntent(next,phase)
        withLifecyclePhase(fence,phase.scope,started,{faceLifecycle}) { assertLifecycle(started,phase.scope);challenge=started.challenge;signingAlias=started.alias;captures.clear() }
        started.challenge!!
    } }
    private fun cancelLifecycleLocked(record: FaceLifecycleJournal,phase: LifecyclePhase): FaceLifecycleJournal {
        if(record.loginKey!=null) {
            val stopped=record.forExplicitLogout();saveLifecycle(stopped,phase,retire=true);return stopped
        }
        val op=record.intent?.takeIf { it.capture } ?: return record
        val saved=record.copy(state="cancel_pending");saveLifecycle(saved,phase)
        val (value,nonce)=signedLifecycle(saved,phase,"cancel","/auth/face/profile/cancel",mapOf("operation_key" to op.key))
        val next=saved.cancelAcknowledgement(value,nonce);saveLifecycle(next,phase,retire=!next.metadata.authenticationEnabled)
        return next
    }
    suspend fun lifecycleCancel(expectedScope: SessionScope=currentScope()): FaceLifecycleMetadata=withContext(Dispatchers.IO) { mutex.withLock {
        val record=faceLifecycle ?: throw LiveFailure("face_profile_requires_status")
        cancelLifecycleLocked(record,LifecyclePhase(expectedScope)).metadata
    } }
    private fun resumeLifecycle(record: FaceLifecycleJournal,phase: LifecyclePhase): FaceLifecycleJournal {
        if(record.state!="restart_required")throw LiveFailure("face_profile_requires_status")
        val fields=record.resume ?: mapOf("resume_key" to UUID.randomUUID().toString(),"expected_challenge_id" to record.challengeId,"expected_generation" to record.generation)
        val saved=record.copy(resume=fields);saveLifecycle(saved,phase)
        val (value,_)=signedLifecycle(saved,phase,"resume","/auth/face/profile/resume",fields+mapOf("operation_key" to saved.intent!!.key))
        val next=saved.withChallenge(value,true);saveLifecycle(next,phase);return next
    }
    private fun promoteLifecycle(record: FaceLifecycleJournal,phase: LifecyclePhase): WireObject {
        var promoting=lifecycleStatusLocked(record,phase)
        var result=promoting.credentialResult ?: throw LiveFailure("face_profile_requires_status")
        val profile=promoting.metadata.profile ?: throw LiveFailure("face_profile_response_changed")
        if(result["profile_id"]!=profile["id"] || result["profile_revision"]!=profile["revision"] || result["model_id"]!=profile["model_id"] || !promoting.metadata.authenticationEnabled)
            throw LiveFailure("face_profile_response_changed")
        var actor=parseCredentials(result,promoting.account)
        val device=DeviceIdentity(promoting.account,lifecycleKey(promoting),promoting.handle,promoting.device)
        saveLifecycle(promoting,phase,mapOf("credentials" to result,"device" to device.wire())) {
            clearPrivateScope();credentials=actor;identity=device;phase.scope=fence.switch(actor.account)
        }
        if(needsRefresh(actor)) {
            actor=refreshActor(actor,phase.scope) { refreshed,current,_->
            val next=promoting.rotatedCredentials(refreshed)
            saveLifecycle(next,phase,mapOf("credentials" to refreshed)) { credentials=current;phase.scope=fence.switch(current.account) }
            promoting=next;result=refreshed;phase.scope
            }.first
        }
        val scope=phase.scope;val me=json("/me",scope,actor.token);val devices=json("/me/devices",scope,actor.token)
        if(me["user_id"]!=promoting.account || me["authenticated"]!=true || me["auth_method"]!="registered_face" || me["profile_id"]!=profile["id"] || me["profile_revision"]!=profile["revision"] ||
            NativeProtocol.rows(devices["items"]).singleOrNull { it["current"]==true && it["status"]=="active" }?.get("id")!=promoting.device)throw LiveFailure("face_profile_response_changed")
        val ready=promoting.copy(state="ready",intent=null,challenge=null,challengeId=null,generation=0,planned=emptyList(),accepted=emptyList(),retired=emptyList(),completion=null,resume=null,credentialResult=null)
        saveLifecycle(ready,phase)
        return result
    }
    private fun completeLifecycle(record: FaceLifecycleJournal,phase: LifecyclePhase): WireObject {
        val intent=record.intent?.takeIf { it.capture } ?: throw LiveFailure("face_profile_requires_status")
        if(record.state!="pending" || record.accepted.size!=intent.count || record.challenge==null)throw LiveFailure("face_profile_requires_status")
        val body=record.completion ?: withLifecyclePhase(fence,phase.scope,record,{faceLifecycle}) {
            assertLifecycle(record,phase.scope)
            mapOf("challenge_id" to record.challengeId,"device_signature" to vault.sign(lifecycleKey(record),
                NativeProtocol.faceEnvelope(record.challenge)+mapOf("step" to "complete","capture_manifest" to record.accepted.map(EnrollmentCapture::wire))))
        }
        val saved=record.copy(state="completion_pending",completion=body);saveLifecycle(saved,phase)
        val value=json("/auth/face/profile/complete",phase.scope,null,"POST",body);parseCredentials(value,record.account)
        val next=saved.withCredentials(value);saveLifecycle(next,phase);return promoteLifecycle(next,phase)
    }
    private fun lifecycleChallengeLocked(): WireObject {
        val original=faceLifecycle ?: throw LiveFailure("face_profile_requires_status");val phase=LifecyclePhase(currentScope())
        if(original.loginKey!=null)return lifecycleLoginChallenge(original,phase)
        var current=lifecycleStatusLocked(original,phase)
        if(current.waiting)throw LiveFailure("face_profile_in_flight")
        if(current.state=="cancel_pending")throw LiveFailure("face_profile_cancel_pending")
        if(current.state=="credentials_pending")return promoteLifecycle(current,phase)
        if(current.state=="registered")return loginChallenge(current.account,lifecycleKey(current),current.handle,current.device,phase.scope,current.metadata.profile)
        if(current.state=="restart_required")current=resumeLifecycle(current,phase)
        if(current.intent==null && current.metadata.authenticationEnabled) {
            val saved=current.beginStableLogin();saveLifecycle(saved,phase);return lifecycleLoginChallenge(saved,phase)
        }
        if(current.intent?.capture!=true || current.state!="pending")throw LiveFailure("face_profile_requires_status")
        if(current.accepted.size==current.intent.count)return completeLifecycle(current,phase)
        NativeProtocol.expiry(current.challenge?.get("expires_at"),System.currentTimeMillis())
        withLifecyclePhase(fence,phase.scope,current,{faceLifecycle}) { assertLifecycle(current,phase.scope);challenge=current.challenge;signingAlias=current.alias;captures.clear() }
        return current.challenge!!
    }
    private fun lifecycleLoginChallenge(record: FaceLifecycleJournal,phase: LifecyclePhase): WireObject {
        if(record.loginKey==null || record.intent!=null)throw LiveFailure("face_profile_requires_status")
        assertLifecycle(record,phase.scope);lifecycleKey(record)
        if(record.state=="login_credentials_pending") {
            try { return promoteLifecycleLogin(record,phase) }
            catch(problem: LiveFailure) { if(problem.status !in setOf(401,403))throw problem }
        }
        if(record.state in setOf("login_capture_pending","login_completion_pending") && record.challenge?.let {
            java.time.Instant.parse(NativeProtocol.text(it["expires_at"])).toEpochMilli()>System.currentTimeMillis()
        }==true)throw LiveFailure("face_login_in_flight")
        if(record.state=="login_pending" && record.challenge?.let {
            java.time.Instant.parse(NativeProtocol.text(it["expires_at"])).toEpochMilli()>System.currentTimeMillis()
        }==true) {
            withLifecyclePhase(fence,phase.scope,record,{faceLifecycle}) { assertLifecycle(record,phase.scope);challenge=record.challenge;signingAlias=record.alias;captures.clear() }
            return record.challenge!!
        }
        // Explicit retry follows a known terminal rejection or expiry, never an uncertain one-use write.
        val reset=record.copy(state="login_start",challenge=null,challengeId=null,planned=emptyList(),accepted=emptyList(),completion=null,credentialResult=null)
        saveLifecycle(reset,phase)
        val value=loginChallenge(reset.account,lifecycleKey(reset),reset.handle,reset.device,phase.scope)
        val next=reset.withLoginChallenge(value);saveLifecycle(next,phase)
        return value
    }
    private fun promoteLifecycleLogin(record: FaceLifecycleJournal,phase: LifecyclePhase): WireObject {
        var current=record;var result=current.credentialResult ?: throw LiveFailure("face_profile_requires_status")
        var actor=parseCredentials(result,current.account)
        saveLifecycle(current,phase,mapOf("credentials" to result)) { clearPrivateScope();credentials=actor;phase.scope=fence.switch(actor.account) }
        if(needsRefresh(actor)) {
            actor=refreshActor(actor,phase.scope) { refresh,updated,_->
            val next=current.rotatedCredentials(refresh)
            saveLifecycle(next,phase,mapOf("credentials" to refresh)) { credentials=updated;phase.scope=fence.switch(updated.account) }
            current=next;result=refresh;phase.scope
            }.first
        }
        val proof=current.challenge ?: throw LiveFailure("face_profile_requires_status")
        val profile=mapOf("id" to proof["profile_id"],"revision" to proof["profile_revision"],"model_id" to proof["model_id"])
        val meta=currentLifecycleMetadata(current,phase,actor,profile)
        val ready=current.copy(metadata=meta,state="ready",loginKey=null,challenge=null,challengeId=null,planned=emptyList(),accepted=emptyList(),
            retired=emptyList(),completion=null,resume=null,credentialResult=null)
        saveLifecycle(ready,phase);return result
    }
    private fun lifecycleLoginCapture(bytes: ByteArray,record: FaceLifecycleJournal,scope: SessionScope,frame: NativeCaptureContext?): Pair<Int,WireObject?> {
        val phase=LifecyclePhase(scope);val planned=record.planLogin(bytes);saveLifecycle(planned,phase)
        val item=planned.planned.single();val value=planned.challenge!!
        val envelope=NativeProtocol.faceEnvelope(value)+mapOf("step" to "capture","capture_index" to 0,"capture_sha256" to item.hash,"mime" to item.mime,"byte_size" to item.bytes)
        val response=transport.request("/auth/face/proof/${planned.challengeId}/0",scope,null,"PUT",bytes,item.mime,
            mapOf("x-lovelies-capture-sha256" to item.hash,"x-lovelies-capture-bytes" to item.bytes.toString(),"x-lovelies-device-signature" to signCapturedFrame(bytes,frame,scope,lifecycleKey(planned),envelope)))
        try { item.assertAcknowledgement(jsonMap(JSONObject(response.toString(Charsets.UTF_8))),planned.challengeId!!) } finally { response.fill(0) }
        val accepted=planned.copy(state="login_completion_pending",accepted=planned.planned)
        val body=withLifecyclePhase(fence,phase.scope,planned,{faceLifecycle}) {
            assertLifecycle(planned,phase.scope)
            mapOf("challenge_id" to planned.challengeId,"device_signature" to vault.sign(lifecycleKey(planned),
                NativeProtocol.faceEnvelope(value)+mapOf("step" to "complete","capture_manifest" to accepted.accepted.map(EnrollmentCapture::wire))))
        }
        val completing=accepted.copy(completion=body);saveLifecycle(completing,phase)
        val result=try { json("/auth/face/complete",phase.scope,null,"POST",body) }
            catch(problem: LiveFailure) {
                if(problem.status==422 && isFaceCaptureRejection(problem.code) || problem.status==401 && problem.code=="face_verification_failed")
                    saveLifecycle(completing.copy(state="login_start",challenge=null,challengeId=null,planned=emptyList(),accepted=emptyList(),completion=null,credentialResult=null),phase)
                throw problem
            }
        parseCredentials(result,record.account)
        val staged=completing.withLoginCredentials(result);saveLifecycle(staged,phase)
        return 1 to promoteLifecycleLogin(staged,phase)
    }
    private fun lifecycleCapture(bytes: ByteArray,record: FaceLifecycleJournal,scope: SessionScope,frame: NativeCaptureContext?): Pair<Int,WireObject?> {
        val phase=LifecyclePhase(scope);val planned=record.plan(bytes);saveLifecycle(planned,phase);val item=planned.planned.last()
        val value=planned.challenge!!;val signed=NativeProtocol.faceEnvelope(value)+mapOf("step" to "capture","capture_index" to item.index,"capture_sha256" to item.hash,"mime" to item.mime,"byte_size" to item.bytes)
        val result=transport.request("/auth/face/proof/${planned.challengeId}/${item.index}",scope,null,"PUT",bytes,item.mime,
            mapOf("x-lovelies-capture-sha256" to item.hash,"x-lovelies-capture-bytes" to item.bytes.toString(),"x-lovelies-device-signature" to signCapturedFrame(bytes,frame,scope,lifecycleKey(planned),signed)))
        try { item.assertAcknowledgement(jsonMap(JSONObject(result.toString(Charsets.UTF_8))),planned.challengeId!!) } finally { result.fill(0) }
        val accepted=planned.copy(state="pending",accepted=planned.planned);saveLifecycle(accepted,phase)
        if(accepted.accepted.size<accepted.intent!!.count)return accepted.accepted.size to null
        return accepted.accepted.size to completeLifecycle(accepted,phase)
    }
    private fun archivedRecoveries(): List<AccountRecoveryJournal> = storage["retired_account_recoveries"]?.let { value ->
        NativeProtocol.rows(value,16).map { AccountRecoveryJournal.restore(it,baseUrl) }
    } ?: emptyList()
    private fun retiredAliases(): List<WireObject> = storage["retired_device_aliases"]?.let { value ->
        NativeProtocol.rows(value,100).onEach { row ->
            NativeProtocol.id(row["account"])
            if(!NativeProtocol.text(row["alias"]).startsWith("lovelies.device."))throw LiveFailure("account_recovery_scope_changed")
        }
    } ?: emptyList()
    private fun savedRetiredAliases(record: AccountRecoveryJournal): List<WireObject> = (retiredAliases()+listOfNotNull(
        identity?.let { mapOf("account" to it.account,"alias" to it.alias) },
        enrollment?.let { mapOf("account" to it.account,"alias" to it.alias) }))
        .filter { it["alias"]!=record.alias }.distinctBy { it["alias"] }.also { if(it.size>100)throw LiveFailure("secure_storage_full") }
    private fun publishRecoveryKey(intent: RecoveryKeyIntent?,scope: SessionScope) = synchronized(fence) {
        fence.assert(scope)
        synchronized(storage) {
            val candidate=storage.toMap().filterKeys { it!="recovery_key_intent" }+(intent?.let { mapOf("recovery_key_intent" to it.wire()) } ?: emptyMap())
            persistAccountRecovery(candidate,vault::save) { saved -> storage.clear();storage.putAll(saved.filterValues { it!=null });recoveryKeyIntent=intent }
        }
    }
    private fun keyMetadata(value: WireObject,account: String): RecoveryKeyReceipt? {
        if(value["protocol"]!="lovelies-account-recovery-v1" || value["account_id"]!=account)throw LiveFailure("recovery_key_response_changed")
        return when(value["state"]) { "ready" -> RecoveryKeyReceipt.parse(value,account).also { if(it.expiresAt<=System.currentTimeMillis())throw LiveFailure("recovery_key_unavailable") }
            "unavailable" -> null;else -> throw LiveFailure("recovery_key_response_changed") }
    }
    suspend fun recoveryKey(): RecoveryKeyReceipt?=withContext(Dispatchers.IO) { mutex.withLock {
        registered();val actor=credentials!!.account;val scope=currentScope()
        val receipt=keyMetadata(json("/auth/face/recovery/key",scope),actor)
        val stored=recoveryKeyIntent
        if(receipt!=null && stored?.backup?.account==actor && receipt.operation==stored.operation)publishRecoveryKey(stored.copy(receipt=receipt),scope)
        receipt
    } }
    suspend fun createRecoveryKey(replacePending: Boolean=false): RecoveryKeyReceipt=withContext(Dispatchers.IO) { mutex.withLock {
        registered();val account=credentials!!.account;val scope=currentScope()
        val old=recoveryKeyIntent?.takeIf { it.backup.account==account }
        val intent=if(old!=null && old.receipt==null && !replacePending)old else RecoveryKeyIntent.create(baseUrl,account)
        publishRecoveryKey(intent,scope) // Secret and UUID must exist durably before POST or UI disclosure.
        val receipt=RecoveryKeyReceipt.parse(json("/auth/face/recovery/key",scope,method="POST",body=intent.body()),account,intent.operation)
        val current=keyMetadata(json("/auth/face/recovery/key",scope),account)
        if(current==null || !current.same(receipt))throw LiveFailure("recovery_key_unavailable")
        publishRecoveryKey(intent.copy(receipt=receipt),scope);receipt
    } }
    suspend fun recoveryBackupText(): String=withContext(Dispatchers.IO) { mutex.withLock {
        registered();val actor=credentials!!.account;val scope=currentScope()
        val intent=recoveryKeyIntent ?: throw LiveFailure("recovery_backup_unavailable")
        if(intent.backup.account!=actor || intent.origin!=baseUrl || intent.receipt==null)throw LiveFailure("recovery_backup_unavailable")
        val current=keyMetadata(json("/auth/face/recovery/key",scope),actor)
        if(current==null || !current.same(intent.receipt))throw LiveFailure("recovery_key_unavailable")
        synchronized(fence) { fence.assert(scope);intent.backup.text() }
    } }
    suspend fun revokeRecoveryKey()=withContext(Dispatchers.IO) { mutex.withLock {
        registered();val actor=credentials!!.account;val scope=currentScope()
        val result=json("/auth/face/recovery/key",scope,method="DELETE")
        if(result["protocol"]!="lovelies-account-recovery-v1" || result["state"]!="revoked" || result["account_id"]!=actor)throw LiveFailure("recovery_key_response_changed")
        publishRecoveryKey(null,scope)
    } }
    private class AccountPhase(var scope: SessionScope)
    private fun assertAccountRecovery(record: AccountRecoveryJournal,scope: SessionScope) {
        fence.assert(scope);record.assertIntent(accountRecovery)
        if(guestDeletion!=null)throw LiveFailure("deletion_requires_status")
        if(record.origin!=baseUrl || credentials?.account?.let { it !in listOfNotNull(record.sourceAccount,record.account) }==true)throw LiveFailure("account_recovery_scope_changed")
    }
    private fun accountRecoveryKey(record: AccountRecoveryJournal): String { record.assertKey(vault.existingDevice(record.alias));return record.alias }
    private fun saveAccountRecovery(record: AccountRecoveryJournal,phase: AccountPhase,extra: WireObject=emptyMap(),after: ()->Unit={}) {
        val previous=accountRecovery ?: throw LiveFailure("account_recovery_requires_status")
        withAccountRecoveryPhase(fence,phase.scope,previous,{accountRecovery}) {
            assertAccountRecovery(previous,phase.scope)
            synchronized(storage) { persistAccountRecovery(credentialCandidate(storage.toMap()+extra+mapOf("account_recovery" to record.wire())),vault::save) { saved ->
                after();storage.clear();storage.putAll(saved.filterValues { it!=null });accountRecovery=record
            } }
        }
    }
    private fun dispatchAccountRecovery(record: AccountRecoveryJournal,phase: AccountPhase): AccountRecoveryJournal {
        val fields=record.base();val result=json("/auth/face/recovery/challenge",phase.scope,null,"POST",fields+
            mapOf("device_signature" to vault.sign(accountRecoveryKey(record),record.envelope("start",fields))))
        val next=record.withChallenge(result);saveAccountRecovery(next,phase);return next
    }
    private fun reconcileAccountRecovery(record: AccountRecoveryJournal,phase: AccountPhase): AccountRecoveryJournal {
        withAccountRecoveryPhase(fence,phase.scope,record,{accountRecovery}) { assertAccountRecovery(record,phase.scope) }
        val nonce=UUID.randomUUID().toString();val fields=record.query(nonce,System.currentTimeMillis()+45000)
        try {
            val result=json("/auth/face/recovery/status",phase.scope,null,"POST",fields+
                mapOf("device_signature" to vault.sign(accountRecoveryKey(record),record.envelope("status",fields))))
            val next=record.reconcile(result,nonce,System.currentTimeMillis());saveAccountRecovery(next,phase);return next
        } catch(problem: LiveFailure) {
            if(!record.allowsStartRetry(problem))throw problem
            withAccountRecoveryPhase(fence,phase.scope,record,{accountRecovery}) { assertAccountRecovery(record,phase.scope) }
            return dispatchAccountRecovery(record,phase)
        }
    }
    private fun resumeAccountRecovery(record: AccountRecoveryJournal,phase: AccountPhase): AccountRecoveryJournal {
        val operation=record.resume ?: mapOf("resume_key" to UUID.randomUUID().toString(),"expected_generation" to record.generation,
            "expected_challenge_id" to (record.challengeId ?: throw LiveFailure("account_recovery_requires_status")))
        val saved=record.copy(resume=operation);saveAccountRecovery(saved,phase)
        val fields=saved.query(UUID.randomUUID().toString(),System.currentTimeMillis()+45000)+operation
        val result=json("/auth/face/recovery/resume",phase.scope,null,"POST",fields+mapOf("device_signature" to vault.sign(accountRecoveryKey(saved),saved.envelope("resume",fields))))
        val next=saved.withChallenge(result,successor=true);saveAccountRecovery(next,phase);return next
    }
    private fun promoteAccountRecovery(record: AccountRecoveryJournal,phase: AccountPhase): WireObject {
        var promoting=record
        val savedDevice=storage["device"]?.let(NativeProtocol::obj)
        val surviving=if(savedDevice?.get("alias")==record.alias && savedDevice["device"]==record.device && savedDevice["account"]==record.account)
            storage["credentials"]?.let { parseCredentials(NativeProtocol.obj(it),record.account) }?.takeIf { it.method=="registered_face" } else null
        if(surviving!=null)promoting=record.rotatedCredentials(surviving.wire)
        var result=promoting.credentialResult ?: throw LiveFailure("account_recovery_requires_status")
        var actor=parseCredentials(result,record.account)
        if(actor.method!="registered_face")throw LiveFailure("account_recovery_response_changed")
        val device=DeviceIdentity(record.account,accountRecoveryKey(record),record.handle,record.device!!)
        val aliases=savedRetiredAliases(record)
        saveAccountRecovery(promoting,phase,mapOf("credentials" to result,"device" to device.wire(),"retired_device_aliases" to aliases)) {
            clearPrivateScope();credentials=actor;identity=device;phase.scope=fence.switch(actor.account)
        }
        if(needsRefresh(actor)) {
            actor=refreshActor(actor,phase.scope) { refreshed,current,_->
            if(current.method!="registered_face")throw LiveFailure("account_recovery_response_changed")
            val rotated=promoting.rotatedCredentials(refreshed)
            saveAccountRecovery(rotated,phase,mapOf("credentials" to refreshed)) { credentials=current;phase.scope=fence.switch(current.account) }
            promoting=rotated;result=refreshed;phase.scope
            }.first
        }
        val scope=phase.scope;val me=json("/me",scope,actor.token);val devices=json("/me/devices",scope,actor.token)
        if(me["user_id"]!=record.account || me["authenticated"]!=true || me["auth_method"]!="registered_face" ||
            me["profile_id"]!=record.profile?.get("id") || me["profile_revision"]!=record.profile?.get("revision") ||
            NativeProtocol.rows(devices["items"]).singleOrNull { it["current"]==true && it["status"]=="active" }?.get("id")!=record.device)
            throw LiveFailure("account_recovery_response_changed")
        return withAccountRecoveryPhase(fence,scope,promoting,{accountRecovery}) {
            assertAccountRecovery(promoting,scope)
            // Only after current server validation may superseded private state/A01 cease to be active.
            val oldLifecycle=faceLifecycle?.takeIf { it.account==record.account && !it.blocksPrivate }
            val retired=(retiredLifecycles()+listOfNotNull(oldLifecycle)).distinctBy { it.controlOperation }
            if(retired.size>16)throw LiveFailure("secure_storage_full")
            val candidate=mapOf("credentials" to credentials!!.wire,"device" to device.wire(),"retired_device_aliases" to aliases,
                "retired_account_recoveries" to archivedRecoveries().map(AccountRecoveryJournal::wire),"retired_face_lifecycles" to retired.map(FaceLifecycleJournal::wire),
                "retired_refresh_deliveries" to retiredRefreshes().map(RefreshDeliveryJournal::wire))
            synchronized(storage) { persistAccountRecovery(candidate,vault::save) { saved ->
                storage.clear();storage.putAll(saved.filterValues { it!=null });accountRecovery=null;enrollment=null;pending=null;recoveryKeyIntent=null
                if(oldLifecycle!=null)faceLifecycle=null
            } }
            result
        }
    }
    private fun completeAccountRecovery(record: AccountRecoveryJournal,phase: AccountPhase): WireObject {
        if(record.state!="pending" || !record.accepted || record.planned==null || record.challenge==null)throw LiveFailure("account_recovery_requires_status")
        val value=record.challenge
        val completion=record.completion ?: mapOf("challenge_id" to record.challengeId,"device_signature" to vault.sign(accountRecoveryKey(record),
            NativeProtocol.faceEnvelope(value)+mapOf("step" to "complete","capture_manifest" to listOf(record.planned.wire()))))
        val saved=record.copy(state="completion_pending",completion=completion);saveAccountRecovery(saved,phase)
        val result=json("/auth/face/complete",phase.scope,null,"POST",completion);parseCredentials(result,record.account)
        val next=saved.withCredentials(result);saveAccountRecovery(next,phase);return promoteAccountRecovery(next,phase)
    }
    private fun accountRecoveryChallenge(expectedScope: SessionScope=currentScope()): WireObject {
        val previous=withAccountRecoveryStartPhase(fence,expectedScope) {
            if(guestDeletion!=null)throw LiveFailure("deletion_requires_status")
            val record=accountRecovery ?: throw LiveFailure("account_recovery_requires_status")
            assertAccountRecovery(record,expectedScope);clearPrivateScope();record
        }
        val phase=AccountPhase(expectedScope);var current=reconcileAccountRecovery(previous,phase)
        if(current.state in setOf("capture_pending","verifying"))throw LiveFailure("account_recovery_in_flight")
        if(current.state=="credentials_pending") {
            try { return promoteAccountRecovery(current,phase) }
            catch(problem: LiveFailure) { if(problem.status !in listOf(401,403))throw problem
                current=current.copy(state="registered",credentialResult=null);saveAccountRecovery(current,phase) }
        }
        if(current.state=="registered")return loginChallenge(current.account,accountRecoveryKey(current),current.handle,current.device!!,phase.scope,current.profile)
        if(current.state=="restart_required")current=resumeAccountRecovery(current,phase)
        if(current.accepted)return completeAccountRecovery(current,phase)
        NativeProtocol.expiry(current.challenge?.get("expires_at"),System.currentTimeMillis())
        withAccountRecoveryPhase(fence,phase.scope,current,{accountRecovery}) { assertAccountRecovery(current,phase.scope);challenge=current.challenge;signingAlias=current.alias }
        return current.challenge!!
    }
    suspend fun beginAccountRecovery(backupText: String): WireObject=withContext(Dispatchers.IO) { mutex.withLock {
        val scope=currentScope()
        if(storageBlocked)throw LiveFailure("account_recovery_storage_unavailable")
        if(guestDeletion!=null)throw LiveFailure("deletion_requires_status")
        if(faceLifecycle?.blocksPrivate==true)throw LiveFailure("face_profile_requires_status")
        val backup=RecoveryBackup.parse(backupText)
        if(faceLifecycle?.account?.let { it!=backup.account }==true)throw LiveFailure("account_recovery_account_changed")
        assertRecoveryTarget(backup,identity?.account,enrollment?.account)
        accountRecovery?.let { if(it.backup!=backup)throw LiveFailure("account_recovery_requires_status");return@withLock accountRecoveryChallenge(scope) }
        if(credentials?.method=="registered_face")throw LiveFailure("account_recovery_sign_out_required")
        createAccountRecovery(backup,scope)
    } }
    suspend fun switchAccountRecovery(backupText: String): WireObject=withContext(Dispatchers.IO) { mutex.withLock {
        val scope=currentScope()
        if(storageBlocked)throw LiveFailure("account_recovery_storage_unavailable")
        if(guestDeletion!=null)throw LiveFailure("deletion_requires_status")
        if(faceLifecycle?.blocksPrivate==true)throw LiveFailure("face_profile_requires_status")
        if(credentials?.method=="registered_face")throw LiveFailure("account_recovery_sign_out_required")
        val backup=RecoveryBackup.parse(backupText)
        if(faceLifecycle?.account?.let { it!=backup.account }==true)throw LiveFailure("account_recovery_account_changed")
        assertRecoveryTarget(backup,identity?.account,enrollment?.account)
        val old=accountRecovery ?: throw LiveFailure("account_recovery_requires_status")
        if(old.backup==backup)return@withLock accountRecoveryChallenge(scope)
        val history=archivedRecoveries()
        if(history.size>=16)throw LiveFailure("account_recovery_history_full")
        val policy=json("/auth/face/policy",scope,null)
        val replacementScope=withAccountRecoveryPhase(fence,scope,old,{accountRecovery}) {
            assertAccountRecovery(old,scope)
            val candidate=archiveRecoveryCandidate(storage.toMap(),old,baseUrl)
            synchronized(storage) { persistAccountRecovery(candidate,vault::save) { saved ->
                clearPrivateScope();storage.clear();storage.putAll(saved.filterValues { it!=null });accountRecovery=null;fence.switch(credentials?.account)
            } }
        }
        createAccountRecovery(backup,replacementScope,policy)
    } }
    private fun createAccountRecovery(backup: RecoveryBackup,scope: SessionScope,knownPolicy: WireObject?=null): WireObject {
        val policy=knownPolicy ?: json("/auth/face/policy",scope,null)
        if(policy["protocol"]!="lovelies-face-auth-v1" || policy["available"]!=true)throw LiveFailure("face_authentication_unavailable",503)
        val saved=withAccountRecoveryStartPhase(fence,scope) {
            if(guestDeletion!=null || accountRecovery!=null || credentials?.method=="registered_face")throw LiveFailure("account_recovery_scope_changed")
            assertRecoveryTarget(backup,identity?.account,enrollment?.account)
            val alias=vault.recoveryAlias();val jwk=vault.createDevice(alias)
            val record=AccountRecoveryJournal.create(baseUrl,backup,alias,jwk,NativeProtocol.text(policy["policy_version"]),credentials?.account)
            synchronized(storage) {
                try { persistAccountRecovery(storage.toMap()+mapOf("account_recovery" to record.wire()),vault::save) { candidate ->
                    clearPrivateScope();storage.clear();storage.putAll(candidate.filterValues { it!=null });accountRecovery=record
                } } catch(problem: Exception) { storageBlocked=true;throw problem }
            }
            record
        }
        val phase=AccountPhase(scope)
        try {
            val next=dispatchAccountRecovery(saved,phase)
            withAccountRecoveryPhase(fence,phase.scope,next,{accountRecovery}) { assertAccountRecovery(next,phase.scope);challenge=next.challenge;signingAlias=next.alias }
            return next.challenge!!
        } catch(problem: LiveFailure) { if(problem.code!="account_recovery_registered" || problem.status!=409)throw problem;return accountRecoveryChallenge(phase.scope) }
    }
    private fun accountRecoveryCapture(bytes: ByteArray,previous: AccountRecoveryJournal,scope: SessionScope,frame: NativeCaptureContext?): Pair<Int,WireObject?> {
        val phase=AccountPhase(scope);val planned=previous.plan(bytes);saveAccountRecovery(planned,phase)
        val value=planned.challenge!!;val item=planned.planned!!
        val signed=NativeProtocol.faceEnvelope(value)+mapOf("step" to "capture","capture_index" to 0,"capture_sha256" to item.hash,"mime" to item.mime,"byte_size" to item.bytes)
        val response=transport.request("/auth/face/proof/${planned.challengeId}/0",phase.scope,null,"PUT",bytes,item.mime,
            mapOf("x-lovelies-capture-sha256" to item.hash,"x-lovelies-capture-bytes" to item.bytes.toString(),"x-lovelies-device-signature" to signCapturedFrame(bytes,frame,phase.scope,accountRecoveryKey(planned),signed)))
        try { item.assertAcknowledgement(jsonMap(JSONObject(response.toString(Charsets.UTF_8))),planned.challengeId!!) }
        catch(problem: LiveFailure) { throw problem } catch(problem: Exception) { throw LiveFailure("capture_acknowledgement_changed") }
        finally { response.fill(0) }
        val accepted=planned.copy(state="pending",accepted=true);saveAccountRecovery(accepted,phase)
        return 1 to completeAccountRecovery(accepted,phase)
    }
    suspend fun photoPreferences(): WireObject=get("/me/photo-preferences")
    private fun performAction(action: String,payload: WireObject,scope: SessionScope=currentScope(),token: String?=credentials?.token): WireObject {
        val response=transport.action(action,payload,scope,token)
        try { fence.assert(scope);return jsonMap(JSONObject(response.toString(Charsets.UTF_8))) }
        catch(error: LiveFailure) { throw error } catch(error: Exception) { throw LiveFailure("response_invalid") }
        finally { response.fill(0) }
    }
    suspend fun communityRead(action: String,payload: WireObject=emptyMap()): WireObject=withContext(Dispatchers.IO) {
        NativeProtocol.validateActionPayload(action,payload)
        val (scope,actor)=ready();val response=performAction(action,payload,scope,actor.token)
        if(action=="receipt")NativeProtocol.mediaSource(response["source"])
        if(action=="inbox")NativeProtocol.rows(response["items"]).forEach { NativeProtocol.mediaSource(it["source"]) }
        response
    }
    suspend fun mutate(action: String,payload: WireObject,source: String="personal",path: String?=null,method: String="POST",validate: ((WireObject,String)->Unit)?=null,operationKey: String?=null): WireObject=withContext(Dispatchers.IO) { mutex.withLock {
        NativeProtocol.operationSource(action,source);NativeProtocol.validateActionPayload(action,payload)
        registered();val actor=credentials!!.account;val scope=currentScope()
        val existing=pending
        if(existing!=null && (operationKey!=null && existing.key!=operationKey || existing.account!=actor || existing.source!=source || existing.action!=action || existing.path!=path || existing.method!=method || NativeProtocol.canonical(existing.payload.filterKeys { it!="operation_key" })!=NativeProtocol.canonical(payload)))throw LiveFailure("pending_operation_requires_reconciliation")
        val intent=existing ?: (operationKey ?: "android-${UUID.randomUUID()}").let { key -> PendingIntent(actor,source,action,key,payload+mapOf("operation_key" to key),path,method) }
        synchronized(fence) { fence.assert(scope);pending=intent;storage["pending"]=intent.wire();save() }
        try {
            val looked=if(existing!=null)performAction("operation",mapOf("operation_key" to intent.key)) else null
            val result=if(looked!=null && looked["status"]!="unknown")looked else if(path!=null)json(path,scope,method=method,body=intent.payload) else performAction(action,intent.payload)
            synchronized(fence) {
                fence.assert(scope)
                if(intent.action in listOf("sharing.snapshot","sharing.preview","sharing.commit"))NativeProtocol.bindSharingSource(result,intent.action,intent.source)
                if(intent.action=="request.decide")NativeProtocol.mediaSource(result["source"],intent.source)
                validate?.invoke(result,intent.key);pending=null;storage.remove("pending");save()
            };result
        } catch(error: LiveFailure) {
            if(!error.ambiguous && error.status in 400..499)synchronized(fence) {
                fence.assert(scope);if(pending?.key==intent.key) { pending=null;storage.remove("pending");save() }
            }
            throw error
        }
    } }
    suspend fun reconcile(validate: ((WireObject,String)->Unit)?=null): WireObject=withContext(Dispatchers.IO) { mutex.withLock {
        val intent=pending ?: throw LiveFailure("no_pending_operation")
        NativeProtocol.operationSource(intent.action,intent.source);NativeProtocol.validateActionPayload(intent.action,intent.payload)
        registered()
        if(intent.account!=credentials!!.account)throw LiveFailure("operation_account_changed")
        val result=performAction("operation",mapOf("operation_key" to intent.key))
        if(result["status"]!="unknown") {
            if(intent.action in listOf("sharing.snapshot","sharing.preview","sharing.commit"))NativeProtocol.bindSharingSource(result,intent.action,intent.source)
            if(intent.action=="request.decide")NativeProtocol.mediaSource(result["source"],intent.source)
            validate?.invoke(result,intent.key);pending=null;storage.remove("pending");save()
        };result
    } }
    suspend fun resumePending(): WireObject {
        val intent=pending ?: throw LiveFailure("no_pending_operation")
        if(intent.action=="sharing.commit")throw LiveFailure("review_recovery_required")
        return mutate(intent.action,intent.payload.filterKeys { it!="operation_key" },intent.source,intent.path,intent.method)
    }
    suspend fun photoPage(source: String="all",query: String?=null,cursor: LibraryCursor?=null): LibraryPage {
        val payload=mapOf("source" to source,"limit" to 100)+(query?.takeIf { it.isNotBlank() }?.let { mapOf("query" to it.take(500)) } ?: emptyMap())+(cursor?.wire() ?: emptyMap())
        return LibraryPage.parse(communityRead("photos",payload),cursor)
    }
    suspend fun photos(source: String="all",query: String?=null): List<LivePhoto> = photoPage(source,query).items
    suspend fun preview(photo: LivePhoto): ByteArray=withContext(Dispatchers.IO) {
        NativeProtocol.mediaSource(photo.mediaSource)
        val (scope,actor)=ready()
        val allowed=performAction("photos.validate",mapOf("asset_ids" to listOf(photo.id)),scope,actor.token)
        if(NativeProtocol.idList(allowed["authorized_ids"])!=listOf(photo.id))throw LiveFailure("photo_forbidden",403)
        fence.assert(scope);transport.request("/community/media/${photo.id}/preview",scope,actor.token,binary=true)
    }
    suspend fun original(photo: LivePhoto): ByteArray=withContext(Dispatchers.IO) {
        NativeProtocol.mediaSource(photo.mediaSource)
        val owned=currentScope()
        val ticket=mutate("download.sign",mapOf("asset_id" to photo.id),"media",path="/downloads/sign")
        fence.assert(owned)
        if(ticket["method"]!="GET" || ticket["source_version"]!=photo.version || NativeProtocol.integer(ticket["expires_in"],1,120)<1)throw LiveFailure("download_authority_changed")
        val path=NativeProtocol.downloadPath(NativeProtocol.text(ticket["download_url"],2048),baseUrl)
        val (scope,actor)=ready();fence.assert(owned)
        transport.request(path,scope,actor.token,binary=true,binaryLimit=25*1024*1024)
    }
    fun photoUploads(): PhotoUploadBatch?=saved("photo_uploads")?.let { PhotoUploadBatch.restore(it,baseUrl) }
    fun clearFinishedPhotoUploads() {
        val record=photoUploads() ?: return
        record.assertOwner(baseUrl,credentials?.account,identity?.device)
        if(!record.finished && !record.cancelled)throw LiveFailure("upload_recovery_required")
        synchronized(fence) { record.files.forEach { vault.removeStagedPhoto(it.localId) };remember("photo_uploads",null) }
    }
    fun photoUploadDraft(): WireObject?=(saved("upload_draft") as? Map<*,*>)?.let(NativeProtocol::obj)?.also {
        if(it["account"]!=credentials?.account || it["device"]!=identity?.device)throw LiveFailure("upload_account_changed")
    }
    fun savePhotoUploadDraft(picked: List<Uri>,selected: List<Uri>,caption: String) {
        val scope=currentScope();val account=credentials?.account ?: throw LiveFailure("authentication_required")
        if(credentials?.method!="registered_face" || identity?.account!=account)throw LiveFailure("registered_face_required")
        synchronized(fence) { fence.assert(scope);remember("upload_draft",mapOf("account" to account,"device" to identity!!.device,
            "picked" to picked.map(Uri::toString),"selected" to selected.map(Uri::toString),"caption" to caption.take(200))) }
    }
    private fun changePhotoUploads(scope: SessionScope,change: (PhotoUploadBatch)->PhotoUploadBatch): PhotoUploadBatch=synchronized(fence) {
        fence.assert(scope);val record=photoUploads() ?: throw LiveFailure("upload_recovery_required")
        record.assertOwner(baseUrl,credentials?.account,identity?.device)
        val next=change(record);next.assertOwner(baseUrl,record.account,record.device)
        remember("photo_uploads",next.wire());next
    }
    fun pausePhotoUploads(): PhotoUploadBatch? {
        val record=photoUploads() ?: return null
        if(record.finished || record.cancelled)return record
        val next=changePhotoUploads(currentScope()) { it.copy(paused=true) };transport.cancel();return next
    }
    fun requestPhotoUploadCancellation(): PhotoUploadBatch {
        val next=changePhotoUploads(currentScope()) { it.copy(paused=true,cancelling=true,error=null) };transport.cancel();return next
    }
    private fun assertPhotoUpload(scope: SessionScope,allowPaused: Boolean=false): PhotoUploadBatch {
        fence.assert(scope);val current=photoUploads() ?: throw LiveFailure("upload_recovery_required")
        current.assertOwner(baseUrl,credentials?.account,identity?.device)
        if(!allowPaused && (current.paused || current.cancelling))throw LiveFailure("upload_paused")
        return current
    }
    /** Resume always retains the original record, even if cancellation needs no remote asset. Only an explicit new selection may replace a terminal batch. */
    suspend fun openPhotoUploadBatch(startNew: Boolean,picked: List<Uri>,selected: List<Uri>,caption: String): PhotoUploadBatch {
        val (_,actor)=ready();val current=photoUploads()
        current?.assertOwner(baseUrl,actor.account,identity?.device)
        if(current!=null && (!startNew || !current.finished && !current.cancelled))return current
        if(!startNew)throw LiveFailure("upload_recovery_required")
        return preparePhotoUploads(picked,selected,caption)
    }
    suspend fun preparePhotoUploads(picked: List<Uri>,selected: List<Uri>,caption: String,batch: String=UUID.randomUUID().toString()): PhotoUploadBatch=withContext(Dispatchers.IO) {
        val (scope,actor)=ready();val device=identity ?: throw LiveFailure("device_key_unavailable")
        photoUploads()?.let { old ->
            old.assertOwner(baseUrl,actor.account,device.device)
            if(!old.finished && !old.cancelled)throw LiveFailure("upload_recovery_required")
            old.files.forEach { vault.removeStagedPhoto(it.localId) }
        }
        val next=PhotoUploadBatch.create(baseUrl,actor.account,device.device,batch,picked.map(Uri::toString),selected.map(Uri::toString),caption)
        synchronized(fence) { fence.assert(scope);remember("photo_uploads",next.wire()) };next
    }
    private fun stagedUploadBytes(record: PhotoUploadBatch,file: PhotoUploadFile): ByteArray {
        val bytes=vault.stagedPhoto(record.account,record.batch,file.localId)
        if(file.sha256!=null && (bytes.size.toLong()!=file.byteSize || NativeProtocol.sha256(bytes)!=file.sha256)) { bytes.fill(0);throw LiveFailure("upload_source_changed") }
        return bytes
    }
    private fun stageUploadFile(scope: SessionScope,file: PhotoUploadFile): PhotoUploadFile {
        val record=assertPhotoUpload(scope)
        if(file.sha256!=null)return file
        val type=file.contentType ?: context.contentResolver.getType(Uri.parse(file.uri)) ?: throw LiveFailure("image_required")
        if(type !in PhotoUploadFile.TYPES)throw LiveFailure("image_required")
        // MIME is durable before importing. A completed encrypted import is reused if its journal acknowledgement was interrupted.
        val typed=file.copy(contentType=type);changePhotoUploads(scope) { it.replace(typed) }
        val bytes=if(vault.hasStagedPhoto(file.localId))stagedUploadBytes(record,typed) else {
            val imported=try { context.contentResolver.openInputStream(Uri.parse(file.uri))?.use { stream ->
                val out=java.io.ByteArrayOutputStream();val buffer=ByteArray(8192)
                try { while(true) { assertPhotoUpload(scope);val n=stream.read(buffer);if(n<0)break
                    if(out.size().toLong()+n>PhotoUploadFile.MAX_BYTES)throw LiveFailure("image_too_large");out.write(buffer,0,n) };out.toByteArray() }
                finally { buffer.fill(0);out.reset() }
            } ?: throw LiveFailure("upload_source_unavailable") }
            catch(problem: LiveFailure) { throw problem }
            catch(problem: Exception) { throw LiveFailure("upload_source_unavailable") }
            try { assertPhotoUpload(scope);vault.stagePhoto(record.account,record.batch,file.localId,imported);imported }
            catch(problem: Exception) { imported.fill(0);throw problem }
        }
        try {
            if(bytes.isEmpty())throw LiveFailure("image_required")
            val staged=typed.copy(byteSize=bytes.size.toLong(),sha256=NativeProtocol.sha256(bytes),status="staged")
            changePhotoUploads(scope) { it.replace(staged) };return staged
        } finally { bytes.fill(0) }
    }
    private suspend fun reserveUpload(scope: SessionScope,file: PhotoUploadFile): PhotoUploadFile {
        val record=assertPhotoUpload(scope,allowPaused=true)
        // The file-level dispatch intention outlives the shared pending slot, including expiry/re-authentication.
        // Cancellation must recover its original reservation before it can discard a locally nil asset ID.
        changePhotoUploads(scope) { it.replace(file.copy(status="reserving")) }
        val payload=mapOf("content_type" to file.contentType,"byte_size" to file.byteSize,"upload_batch_id" to record.batch,"source" to "personal",
            "title" to file.title,"resumable" to true,"checksum_sha256" to file.sha256)
        var accepted: PhotoUploadFile?=null
        mutate("photo.upload.reserve",payload,path="/uploads/session",operationKey=file.reserveKey,validate={ value,key ->
            if(key!=file.reserveKey || value["source"]!="personal" || value["upload_batch_id"]!=record.batch || value["resumable"]!=true
                || value["byte_size"]!=file.byteSize && (value["byte_size"] as? Number)?.toLong()!=file.byteSize
                || value["content_type"]!=file.contentType || value["checksum_sha256"]!=file.sha256
                || NativeProtocol.integer(value["maximum_chunk_bytes"],262144,262144)!=262144L)throw LiveFailure("upload_scope_changed")
            val next=file.copy(assetId=NativeProtocol.id(value["asset_id"]),version=NativeProtocol.id(value["version"]),status="uploading")
            if(value["chunk_url"]!="/uploads/${next.assetId}/chunks")throw LiveFailure("upload_scope_changed")
            changePhotoUploads(scope) { it.replace(next) };accepted=next
        });return accepted ?: throw LiveFailure("upload_recovery_required")
    }
    private suspend fun currentUploadStatus(scope: SessionScope,file: PhotoUploadFile): PhotoUploadFile {
        val record=assertPhotoUpload(scope,allowPaused=true)
        val next=file.bindStatus(get("/uploads/${file.assetId}/status"),record.batch)
        changePhotoUploads(scope) { it.replace(next) }
        if(next.status in setOf("ready","cancelled"))vault.removeStagedPhoto(next.localId)
        return next
    }
    private suspend fun completePhotoUpload(scope: SessionScope,file: PhotoUploadFile) {
        assertPhotoUpload(scope,allowPaused=true)
        mutate("photo.upload.complete",emptyMap(),path="/uploads/${file.assetId}/complete",operationKey=file.completeKey,validate={ value,key ->
            if(key!=file.completeKey || NativeProtocol.id(value["asset_id"])!=file.assetId || NativeProtocol.id(value["version"])!=file.version
                || value["status"] !in setOf("processing","ready"))throw LiveFailure("upload_scope_changed")
            if(value["status"]=="processing")NativeProtocol.id(value["attempt_id"])
        })
    }
    /** Only current authoritative accepted bytes advance this journal. Sending a chunk never creates a sharing grant. */
    suspend fun resumePhotoUploads(retryFailed: Boolean=false,onProgress: suspend (PhotoUploadBatch)->Unit={}): PhotoUploadBatch=withContext(Dispatchers.IO) { photoUploadMutex.withLock {
        val (scope,_)=ready()
        changePhotoUploads(scope) { it.copy(paused=false,error=null) };onProgress(assertPhotoUpload(scope,allowPaused=true))
        try {
            if(!assertPhotoUpload(scope,allowPaused=true).cancelling) {
                // Stabilize the complete selected subset before the first reservation or network upload.
                for(file in assertPhotoUpload(scope).files.filter { it.assetId==null && it.sha256==null }) {
                    stageUploadFile(scope,file);onProgress(assertPhotoUpload(scope))
                }
            }
            for(original in assertPhotoUpload(scope,allowPaused=true).files) {
                var file=assertPhotoUpload(scope,allowPaused=true).files.single { it.localId==original.localId }
                if(!assertPhotoUpload(scope,allowPaused=true).cancelling) {
                    assertPhotoUpload(scope)
                    if(file.assetId==null) { file=stageUploadFile(scope,file);onProgress(assertPhotoUpload(scope));file=reserveUpload(scope,file) }
                } else if(file.assetId==null && (file.status=="reserving" || pending?.key==file.reserveKey))file=reserveUpload(scope,file)
                if(file.assetId==null) { vault.removeStagedPhoto(file.localId);continue }
                file=currentUploadStatus(scope,file);onProgress(assertPhotoUpload(scope,allowPaused=true))
                if(assertPhotoUpload(scope,allowPaused=true).cancelling) {
                    // A previously dispatched complete must be reconciled before a different cancellation can be sent.
                    if(pending?.key==file.completeKey)completePhotoUpload(scope,file)
                    file=currentUploadStatus(scope,file)
                    if(file.status in setOf("uploading","uploaded") || pending?.key==file.cancelKey) {
                        try { mutate("photo.upload.cancel",emptyMap(),path="/uploads/${file.assetId}/cancel",operationKey=file.cancelKey,validate={ value,key ->
                            if(key!=file.cancelKey || NativeProtocol.id(value["asset_id"])!=file.assetId || NativeProtocol.id(value["version"])!=file.version || value["status"]!="cancelled"
                                || value["processing_creates_access"]!=false)throw LiveFailure("upload_scope_changed")
                        }) } catch(problem: LiveFailure) { if(problem.status!=409 || problem.code!="upload_already_processing")throw problem }
                        file=currentUploadStatus(scope,file)
                    }
                    if(file.status=="cancelled")vault.removeStagedPhoto(file.localId)
                    onProgress(assertPhotoUpload(scope,allowPaused=true));continue
                }
                if(file.status=="cancelled")throw LiveFailure("upload_cancelled")
                if(file.status=="uploading") {
                    val record=assertPhotoUpload(scope);val bytes=stagedUploadBytes(record,file)
                    try {
                        while(file.status=="uploading") {
                            assertPhotoUpload(scope)
                            val offset=if(file.acknowledged==file.byteSize)((file.byteSize-1)/262144)*262144 else file.acknowledged
                            val end=minOf(file.byteSize,offset+262144).toInt();val chunk=bytes.copyOfRange(offset.toInt(),end)
                            try {
                                val response=transport.request("/uploads/${file.assetId}/chunks?offset=$offset",scope,credentials!!.token,"PUT",chunk,file.contentType!!,
                                    mapOf("X-Lovelies-Chunk-SHA256" to NativeProtocol.sha256(chunk)))
                                try {
                                    val value=jsonMap(JSONObject(response.toString(Charsets.UTF_8)))
                                    if(NativeProtocol.id(value["asset_id"])!=file.assetId || NativeProtocol.id(value["version"])!=file.version
                                        || NativeProtocol.integer(value["byte_size"],1,PhotoUploadFile.MAX_BYTES)!=file.byteSize)throw LiveFailure("upload_scope_changed")
                                } finally { response.fill(0) }
                            } finally { chunk.fill(0) }
                            file=currentUploadStatus(scope,file);onProgress(assertPhotoUpload(scope,allowPaused=true))
                            if(file.status=="uploading" && file.acknowledged==file.byteSize)throw LiveFailure("upload_finalizing")
                        }
                    } finally { bytes.fill(0) }
                }
                assertPhotoUpload(scope)
                if(pending?.key==file.completeKey) { completePhotoUpload(scope,file);file=currentUploadStatus(scope,file) }
                if(file.status=="failed") {
                    if(!retryFailed)throw LiveFailure(file.error ?: "photo_processing_failed")
                    file=file.copy(completeKey="android-upload-complete-${UUID.randomUUID()}",error=null)
                    changePhotoUploads(scope) { it.replace(file) }
                }
                if(file.status in setOf("uploaded","failed")) {
                    completePhotoUpload(scope,file)
                    file=currentUploadStatus(scope,file);onProgress(assertPhotoUpload(scope,allowPaused=true))
                }
                if(file.status !in setOf("processing","ready"))throw LiveFailure("photo_processing_failed")
            }
            val final=changePhotoUploads(scope) { it.copy(paused=it.cancelling,error=null) };onProgress(final);final
        } catch(problem: Exception) {
            if(runCatching { fence.assert(scope) }.isSuccess)runCatching {
                val held=changePhotoUploads(scope) { it.copy(paused=true,error=(problem as? LiveFailure)?.code ?: "connection_unavailable") };onProgress(held)
            }
            throw problem
        }
    } }
    suspend fun refreshPhotoUploads(): PhotoUploadBatch=withContext(Dispatchers.IO) {
        val (scope,_)=ready();val record=assertPhotoUpload(scope,allowPaused=true)
        record.files.filter { it.assetId!=null }.forEach { currentUploadStatus(scope,it) };assertPhotoUpload(scope,allowPaused=true)
    }
    suspend fun upload(uri: Uri,batch: String,title: String): String=withContext(Dispatchers.IO) {
        val (scope,actor)=ready();val type=context.contentResolver.getType(uri) ?: throw LiveFailure("image_required")
        if(type !in listOf("image/jpeg","image/png","image/webp","image/gif"))throw LiveFailure("image_required")
        val bytes=context.contentResolver.openInputStream(uri)?.use { stream ->
            val output=java.io.ByteArrayOutputStream();val buffer=ByteArray(8192)
            try { while(true) { val n=stream.read(buffer);fence.assert(scope);if(n<0)break;if(output.size()+n>20*1024*1024)throw LiveFailure("image_too_large");output.write(buffer,0,n) };output.toByteArray() }
            finally { buffer.fill(0);output.reset() }
        } ?: throw LiveFailure("image_unavailable")
        try {
            val hash=NativeProtocol.sha256(bytes)
            val records=NativeProtocol.rows(saved("upload_records") ?: emptyList<WireObject>()).toMutableList()
            val previous=records.firstOrNull { it["account"]==actor.account && it["uri"]==uri.toString() && it["batch"]==batch }
            if(previous!=null && (previous["hash"]!=hash || previous["title"]!=title))throw LiveFailure("upload_source_changed")
            var id=previous?.get("asset_id")?.let(NativeProtocol::id)
            if(id==null) {
                mutate("photo.upload.reserve",mapOf("content_type" to type,"byte_size" to bytes.size,"upload_batch_id" to batch,"source" to "personal","title" to title),path="/uploads/session",validate={ value,_ ->
                    val assetId=NativeProtocol.id(value["asset_id"])
                    if(value["source"]!="personal" || value["upload_batch_id"]!=batch)throw LiveFailure("upload_scope_changed")
                    records.add(mapOf("account" to actor.account,"uri" to uri.toString(),"batch" to batch,"hash" to hash,"title" to title,"asset_id" to assetId))
                    remember("upload_records",records.toList());id=assetId
                })
            }
            fence.assert(scope);val assetId=id ?: throw LiveFailure("upload_recovery_required")
            val status=get("/uploads/$assetId/status")["status"]
            if(status=="uploading") {
                val response=transport.request("/uploads/$assetId",scope,credentials!!.token,"PUT",bytes,type);response.fill(0)
            }
            if(status in listOf("uploading","uploaded") || pending?.path=="/uploads/$assetId/complete")mutate("photo.upload.complete",emptyMap(),path="/uploads/$assetId/complete")
            else if(status !in listOf("processing","ready"))throw LiveFailure("photo_processing_failed")
            assetId
        } finally { bytes.fill(0) }
    }
    suspend fun logout(revokeIdentity: Boolean=false,expectedScope: SessionScope=currentScope()) {
        val phase=LifecyclePhase(expectedScope)
        val heldCameraActor=synchronized(fence) {
            fence.assert(expectedScope)
            cameraLogin()?.takeIf { it.state=="credentials_pending" }?.let { staged->
                val original=cameraLoginOwner(staged)
                val actor=parseCredentials(staged.credentials ?: throw LiveFailure("face_login_requires_status"),original.account)
                staged.assertCredentialBinding(actor.wire);actor
            }
        }
        val heldLoginActor=synchronized(fence) { fence.assert(expectedScope);credentials?.takeIf { faceLifecycle?.loginKey!=null } }
        var cancelFailure: LiveFailure?=null
        if(faceLifecycle?.intent?.capture==true || faceLifecycle?.loginKey!=null)withContext(Dispatchers.IO) { mutex.withLock {
            val record=faceLifecycle ?: throw LiveFailure("face_profile_requires_status")
            try { cancelLifecycleLocked(record,phase) }
            catch(problem: LiveFailure) { if(problem.code=="session_changed")throw problem;cancelFailure=problem }
            val current=faceLifecycle ?: throw LiveFailure("face_profile_requires_status")
            val held=current.forExplicitLogout();if(held!=current)saveLifecycle(held,phase)
        } }
        // Paused enrollment and deletion retain their original encrypted account/key; no replacement bootstrap.
        val current=synchronized(fence) {
            fence.assert(phase.scope)
            val previous=credentials ?: heldLoginActor
            val deletion=guestDeletion;val journal=enrollment;val recovery=accountRecovery;val life=faceLifecycle
            val frozen=heldAnonymousLogoutCredentials(storage["credentials"],deletion?.receipt?.completed!=true && (deletion!=null || journal!=null || recovery!=null))
            stagedExport()?.get("file")?.let { vault.removeStagedPhoto(NativeProtocol.id(it)) }
            val candidate=linkedMapOf<String,Any?>()
            if(!revokeIdentity || journal?.alias==identity?.alias || recovery?.alias==identity?.alias || life?.alias==identity?.alias)storage["device"]?.let { candidate["device"]=it }
            accountDeletion?.let { candidate["registered_deletion"]=it.wire() }
            if(deletion!=null)candidate["guest_deletion"]=deletion.wire()
            if(journal!=null)candidate["enrollment"]=journal.wire()
            if(recovery!=null)candidate["account_recovery"]=recovery.wire()
            if(life!=null)candidate["face_lifecycle"]=life.wire()
            if(!revokeIdentity)cameraLogin()?.let { held->candidate["camera_login"]=held.forExplicitLogout().wire() }
            storage["retired_face_lifecycles"]?.let { candidate["retired_face_lifecycles"]=it }
            storage["retired_account_recoveries"]?.let { candidate["retired_account_recoveries"]=it }
            storage["retired_refresh_deliveries"]?.let { candidate["retired_refresh_deliveries"]=it }
            if(!revokeIdentity)storage["recovery_key_intent"]?.let { candidate["recovery_key_intent"]=it }
            if(!revokeIdentity) {
                photoUploads()?.let { candidate["photo_uploads"]=it.copy(paused=true).wire() }
                storage["upload_draft"]?.let { candidate["upload_draft"]=it }
                pending?.takeIf { it.action.startsWith("photo.upload.") }?.let { candidate["pending"]=it.wire() }
            } else photoUploads()?.files?.forEach { vault.removeStagedPhoto(it.localId) }
            val retainedAliases=retiredAliases().filter { !revokeIdentity || it["account"]!=identity?.account || it["alias"] in listOfNotNull(journal?.alias,recovery?.alias) }
            if(retainedAliases.isNotEmpty())candidate["retired_device_aliases"]=retainedAliases
            if(frozen!=null)candidate["credentials"]=frozen
            val retired=retireRefreshCandidate(candidate)
            vault.save(retired)
            clearPrivateScope();credentials=null;pending=if(!revokeIdentity)pending?.takeIf { it.action.startsWith("photo.upload.") } else null;fence.switch(null)
            if(revokeIdentity && identity?.alias!=journal?.alias && identity?.alias!=recovery?.alias && identity?.alias!=life?.alias) {
                val account=identity?.account
                retiredAliases().filter { it["account"]==account }.forEach { vault.deleteDevice(NativeProtocol.text(it["alias"])) }
                vault.deleteDevice(identity?.alias);identity=null;recoveryKeyIntent=null
            }
            storage.clear();storage.putAll(retired)
            recoveryKeyIntent=storage["recovery_key_intent"]?.let { RecoveryKeyIntent.restore(it,baseUrl) }
            // Do not revoke the retained anonymous session needed to reconcile an unresolved enrollment/deletion.
            listOfNotNull(heldCameraActor,previous?.takeUnless { it.method=="anonymous" && (journal!=null || deletion!=null || recovery!=null) }).distinctBy { it.token }
        }
        withContext(Dispatchers.IO) { cancelRetiredRefresh();current.forEach { actor->runCatching {
            val body=NativeProtocol.canonical(emptyMap<String,Any?>()).toByteArray()
            try {
                // Staged authority is revoked first, then any distinct published token, after durable local sign-out.
                val localFence=SessionFence();val scope=localFence.switch(actor.account)
                CloudflareTransport(baseUrl,localFence).request("/auth/logout",scope,actor.token,"POST",body).fill(0)
            } finally { body.fill(0) }
        } } }
        cancelFailure?.let { throw it }
    }
}
