package com.lovelies.frontend.preview

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import androidx.compose.runtime.*
import kotlinx.coroutines.*
import java.util.UUID
import kotlinx.coroutines.sync.withLock

class LiveController(private val state: PreviewState,private val context: Context) {
    val repository=BackgroundTransfers.repository(context.applicationContext)
    private val scope=CoroutineScope(SupervisorJob()+Dispatchers.Main.immediate)
    private var uiEpoch=0L
    private val photoPickerOwnership=PhotoPickerOwnership()
    private var started=false
    private var work: Job?=null
    private var temporaryMediaCleanup: Job?=null
    @Volatile private var cameraInventoryReady=false
    /** Deadline cleanup also runs during a long foreground session. Restart and
     * foreground sweep again after process suspension; durable upload staging
     * and user-saved media never enter these two private-folder inventories. */
    private fun maintainTemporaryMedia() {
        temporaryMediaCleanup?.cancel()
        temporaryMediaCleanup=scope.launch {
            while(isActive) {
                val next=withContext(Dispatchers.IO) {
                    synchronized(repository.fence) {
                        val now=System.currentTimeMillis()
                        val shared=PrivateTemporaryMedia.sweep(context.cacheDir,PrivateTemporaryMedia.Kind.SHARED,now)
                        val camera=if(cameraInventoryReady) {
                            val protected=PrivateTemporaryMedia.cameraRecoveryNames(repository.saved("photo_uploads"),repository.saved("upload_draft"),
                                repository.baseUrl,repository.credentials?.account,repository.identity?.device,
                                picked.map(Uri::toString)+selectedUploads.map(Uri::toString),"${context.packageName}.camera-files")
                            // Unknown recovery ownership is a preservation hold,
                            // re-evaluated on the next lifecycle/journal change.
                            protected?.let { PrivateTemporaryMedia.sweep(context.cacheDir,PrivateTemporaryMedia.Kind.CAMERA,now,it) }
                        } else null
                        listOfNotNull(shared.nextDelay,camera?.nextDelay).minOrNull()
                    }
                }
                if(next==null)break
                delay(next.coerceAtLeast(1L))
            }
        }
    }
    var busy by mutableStateOf(false);private set
    var error by mutableStateOf<LiveFailure?>(null);private set
    var me by mutableStateOf<WireObject>(emptyMap());private set
    var photoPolicy by mutableStateOf<WireObject>(emptyMap());private set
    val photos=mutableStateListOf<LivePhoto>()
    val inbox=mutableStateListOf<WireObject>()
    val favorites=mutableStateListOf<String>()
    val picked=mutableStateListOf<Uri>()
    val selectedUploads=mutableStateListOf<Uri>()
    val uploadIds=mutableStateListOf<String>()
    var uploadBatch by mutableStateOf<String?>(null);private set
    var uploadStatus by mutableStateOf("");private set
    var uploadRecovery by mutableStateOf<PhotoUploadBatch?>(null);private set
    var selectedPhoto by mutableStateOf<LivePhoto?>(null)
    var focusedPerson by mutableStateOf<String?>(null)
    var snapshot by mutableStateOf<LiveSnapshot?>(null);private set
    var draft by mutableStateOf(LiveDraft(1,emptySet(),emptySet(),emptySet()));private set
    var preview by mutableStateOf<LivePreview?>(null);private set
    var outcome by mutableStateOf<WireObject?>(null);private set
    var focusedReceipt by mutableStateOf<WireObject?>(null);private set
    var faceChallenge by mutableStateOf<WireObject?>(null);private set
    var captureCount by mutableIntStateOf(0);private set
    var mediaGeneration by mutableIntStateOf(0);private set
    var cameraReady by mutableStateOf(false)
    var cameraStatus by mutableStateOf(CameraStatus(CameraPhase.IDLE));private set
    var reviewPreview by mutableStateOf<Bitmap?>(null);private set
    var reviewingCapture by mutableStateOf(false);private set
    private val cameraReview=CameraReviewBuffer()
    private var reviewExpiry: Job?=null
    private fun invalidateCameraReview() {
        reviewExpiry?.cancel();reviewExpiry=null;cameraReview.clear();reviewPreview?.let { if(it.isMutable)it.eraseColor(0) };reviewPreview=null;reviewingCapture=false;cameraReady=false
    }
    var foregroundActive by mutableStateOf(false);private set
    var cameraForUpload by mutableStateOf(false)
    private var cameraUploadId: String?=null
    var notificationSettings by mutableStateOf<WireObject>(emptyMap());private set
    var privacyCenter by mutableStateOf<WireObject>(emptyMap());private set
    var guestDeletion by mutableStateOf<GuestDeletionRecord?>(null);private set
    val notifications=mutableStateListOf<WireObject>()
    val sessions=mutableStateListOf<WireObject>()
    val devices=mutableStateListOf<WireObject>()
    val blocked=mutableStateListOf<WireObject>()
    var matchingConsent by mutableStateOf(false)
    var processingConsent by mutableStateOf(false)
    var receiveMatches by mutableStateOf(false)
    var caption by mutableStateOf("")
    var search by mutableStateOf("");private set
    var libraryCursor by mutableStateOf<LibraryCursor?>(null);private set
    var libraryLoading by mutableStateOf(false);private set
    var libraryError by mutableStateOf<LiveFailure?>(null);private set
    private var libraryQuery=""
    private var librarySource="all"
    private var libraryEpoch=0L
    private var queryJob: Job?=null
    private var restoredUi=false
    private var restoringNavigation=false
    private var restoredViewer: String?=null
    val galleryPositions=mutableStateMapOf<Int,GalleryPosition>()
    val viewerRows=mutableStateListOf<LivePhoto>()
    val supportRequests=mutableStateListOf<WireObject>()
    var supportSubject by mutableStateOf("")
    var supportDetails by mutableStateOf("")
    var supportSubmitted by mutableStateOf<String?>(null);private set
    var entitlement by mutableStateOf<WireObject>(emptyMap());private set
    val outgoing=mutableStateListOf<WireObject>()
    var purchaseVisible by mutableStateOf(false);private set
    var mediaStatus by mutableStateOf("");private set
    var shareIntent by mutableStateOf<android.content.Intent?>(null);private set
    private var interruptedOriginal: Pair<LivePhoto,Boolean>?=null
    val purchases=PlayPurchases(context,repository) {
        entitlement=repository.get("/me/entitlements")
        if(entitlement["download_photos"]==true) {
            purchaseVisible=false
            val resume=interruptedOriginal;interruptedOriginal=null
            if(resume!=null && foregroundActive)original(resume.first,resume.second)
        }
    }
    fun dismissPurchases() { purchaseVisible=false }
    fun clearShareIntent() { shareIntent=null }
    fun original(photo: LivePhoto,share: Boolean=false) {
        if(busy || !registered)return
        run(false) {
            val owned=repository.currentScope();mediaStatus=context.getString(R.string.controller_30f58b93760b)
            try {
                val bytes=repository.original(photo)
                try {
                    repository.fence.assert(owned)
                    val output=withContext(Dispatchers.IO) {
                        if(share)OriginalMedia.share(context,photo.id,bytes) { repository.fence.assert(owned) }
                        else { OriginalMedia.save(context,photo.id,bytes) { repository.fence.assert(owned) };null }
                    }
                    repository.fence.assert(owned)
                    if(share) { shareIntent=output;mediaStatus=context.getString(R.string.controller_15669a062c47);maintainTemporaryMedia() }
                    else mediaStatus=context.getString(R.string.controller_ad87b0a11a23)
                } finally { bytes.fill(0) }
            } catch(problem: LiveFailure) {
                mediaStatus=readableError(problem.code,context)
                if(problem.code=="missing_entitlement") { interruptedOriginal=photo to share;purchaseVisible=true;purchases.load() }
                else throw problem
            } catch(problem: java.io.IOException) { mediaStatus=context.getString(R.string.controller_57d25e1f7252);throw LiveFailure("save_failed") }
        }
    }
    val push=PushRegistration(context,repository)
    var pushStatus by mutableStateOf("");private set
    var pendingLink by mutableStateOf<AppLink?>(null);private set
    var backgroundUploads by mutableStateOf(false);private set
    fun configureBackgroundUploads(enabled: Boolean) {
        backgroundUploads=enabled
        val record=repository.photoUploads()
        if(record!=null)repository.remember("background_upload",mapOf("enabled" to enabled,"account" to record.account,"device" to record.device,"batch" to record.batch))
        if(!enabled)BackgroundTransfers.cancel(context)
    }
    fun enablePush(enabled: Boolean)=run(false) {
        pushStatus=context.getString(R.string.controller_17d1551e8be5)
        try { push.sync(enabled);pushStatus=if(enabled)context.getString(R.string.controller_995526390e92) else context.getString(R.string.controller_9efb2f41cf2d) }
        catch(problem: LiveFailure) { pushStatus=readableError(problem.code,context);throw problem }
    }
    fun receiveLink(value: AppLink) { pendingLink=value;if(registered && !busy)openPendingLink() }
    private fun openPendingLink() {
        val value=pendingLink ?: return
        if(!registered || busy)return
        pendingLink=null
        run(false) {
            if(value.kind=="requests") { focusedReceipt=repository.communityRead("receipt",mapOf("request_id" to value.id));state.navigate(35) }
            else {
                val current=NativeProtocol.rows(repository.get("/me/notifications")["items"]).firstOrNull { it["id"]==value.id } ?: throw LiveFailure("notification_unavailable",404)
                notifications.clear();notifications.addAll(NativeProtocol.rows(repository.get("/me/notifications")["items"]))
                state.navigate(18)
                if(current["kind"]=="support")state.navigate(45)
            }
            pendingLink=null
        }
    }
    private var replaceRecoveryImport=false
    var recoveryImportVisible by mutableStateOf(false);private set
    var recoveryBackupDisplay by mutableStateOf<String?>(null);private set
    var recoveryKeyMetadata by mutableStateOf<RecoveryKeyReceipt?>(null);private set
    var faceProfile by mutableStateOf<FaceLifecycleMetadata?>(null);private set
    var audience by mutableStateOf<AudienceState?>(null);private set
    var audienceVisible by mutableStateOf(false);private set
    var guardianClaim by mutableStateOf<GuardianRequest?>(null);private set
    val audienceOperationPending get()=repository.audienceOperationPending
    val guardianWithdrawalOperationPending get()=repository.guardianWithdrawalOperationPending
    val ownGuardianWithdrawalPending get()=repository.ownGuardianWithdrawalPending
    // Local routing predicate only. Each own-account action still refreshes and validates its durable session at the API.
    val weakRegisteredSession get()=OwnAccountControls.registeredSession(repository.credentials?.account,repository.currentScope().accountId,repository.credentials?.method)
    val privacyExportOperationPending get()=repository.privacyExportOperationPending
    val guardianReference get()=runCatching { repository.guardianReference() }.getOrNull()
    val identityAuthenticated get()=repository.accountDeletion==null && !repository.cameraLoginHeld && !lifecycleHold && repository.accountRecovery==null && repository.enrollment==null && repository.credentials?.method=="registered_face" && me["authenticated"]==true
    private fun clearAudienceMedia() {
        photoPickerOwnership.clear();invalidateCameraReview();BackgroundTransfers.cancel(context);repository.invalidateReads()
        OriginalMedia.prune(context,true);shareIntent=null;interruptedOriginal=null;purchaseVisible=false
        clearImages();photos.clear();inbox.clear();picked.clear();selectedUploads.clear();snapshot=null;preview=null;outcome=null;focusedReceipt=null;focusedPerson=null
        faceChallenge=null;captureCount=0;cameraForUpload=false;cameraUploadId=null;cameraReady=false
    }
    private suspend fun refreshAudienceInternal(epoch: Long=uiEpoch): AudienceState {
        val next=repository.audienceStatus()
        if(epoch!=uiEpoch)throw CancellationException("Audience UI changed")
        audience=next
        val reference=repository.guardianReference()
        if(reference!=null) {
            guardianClaim=null
            try {
                val restored=repository.restoreGuardianReference()
                if(epoch!=uiEpoch)throw CancellationException("Guardian status UI changed")
                guardianClaim=restored
            } catch(problem: LiveFailure) { if(epoch!=uiEpoch)throw CancellationException("Guardian status UI changed");if(problem.status==401)throw problem;error=problem }
        }
        if(!next.allows("face_authentication") || ownGuardianWithdrawalPending) { clearAudienceMedia();audienceVisible=true }
        return next
    }
    private suspend fun requireAudience(purpose: String,epoch: Long=uiEpoch): AudienceState {
        val next=refreshAudienceInternal(epoch)
        if(ownGuardianWithdrawalPending) { audienceVisible=true;clearAudienceMedia();throw LiveFailure("guardian_withdrawal_pending",403) }
        if(!next.allows(purpose)) {
            audienceVisible=true;clearAudienceMedia()
            throw LiveFailure(when(next.band) { "under13"->"age_not_supported";"unknown"->"audience_required";else->"guardian_approval_required" },403)
        }
        return next
    }
    private suspend fun requireLocalCollection(epoch: Long,session: SessionScope=repository.currentScope()): LocalCollectionAuthority {
        if(epoch!=uiEpoch)throw CancellationException("Photo collection UI changed")
        val authority=repository.localCollectionAuthority(session)
        return synchronized(repository.fence) {
            if(!foregroundActive || epoch!=uiEpoch)throw CancellationException("Photo collection UI changed")
            repository.assertLocalCollection(authority)
            audience=authority.audience
            authority
        }
    }
    fun showAudience() {
        if(busy)return
        clearAudienceMedia();audienceVisible=true;state.navigate(5)
        refreshAudience()
    }
    fun refreshAudience()=run(false) { refreshAudienceInternal() }
    fun declareAudience(band: String)=run(false) {
        val epoch=uiEpoch;val held=audience ?: throw LiveFailure("audience_status_required")
        val result=repository.declareAudience(band,held.version)
        if(epoch!=uiEpoch)throw CancellationException("Audience UI changed")
        audience=result.audience ?: throw LiveFailure("audience_response_invalid")
        refreshAudienceInternal(epoch)
    }
    fun createGuardianRequest()=run(false) {
        val epoch=uiEpoch;val held=audience ?: throw LiveFailure("audience_status_required")
        val result=repository.createGuardianRequest(held.version)
        if(epoch!=uiEpoch)throw CancellationException("Guardian UI changed")
        audience=result.audience ?: throw LiveFailure("audience_response_invalid");refreshAudienceInternal(epoch)
    }
    fun retryAudienceChange()=run(false) {
        val epoch=uiEpoch;val result=repository.retryAudienceOperation()
        if(epoch!=uiEpoch)throw CancellationException("Guardian UI changed")
        result.request?.let { if(it.child!=repository.credentials?.account)guardianClaim=it }
        result.audience?.let { audience=it };refreshAudienceInternal(epoch)
    }
    fun checkGuardianRequest(id: String)=run(false) {
        val epoch=uiEpoch;val result=repository.guardianStatus(id)
        if(epoch!=uiEpoch)throw CancellationException("Guardian UI changed")
        if(result.child==repository.credentials?.account)refreshAudienceInternal(epoch) else guardianClaim=result
    }
    fun claimGuardianRequest(id: String,revision: Long,purposes: Set<String>)=run(false) {
        val epoch=uiEpoch;val held=requireAudience("face_authentication",epoch)
        if(held.band!="18_plus" || !identityAuthenticated)throw LiveFailure("guardian_adult_required",403)
        val result=repository.claimGuardianRequest(id,revision,purposes)
        if(epoch!=uiEpoch)throw CancellationException("Guardian UI changed")
        guardianClaim=result.request ?: throw LiveFailure("audience_response_invalid")
    }
    fun withdrawGuardianRequest(request: GuardianRequest)=run(false) {
        val epoch=uiEpoch
        if(request.child==repository.credentials?.account) { audience=null;audienceVisible=true;clearAudienceMedia() }
        val result=repository.withdrawGuardianRequest(request)
        if(epoch!=uiEpoch)throw CancellationException("Guardian UI changed")
        if(request.child==repository.credentials?.account) { audienceVisible=true;clearAudienceMedia();refreshAudienceInternal(epoch) }
        else guardianClaim=result.request
    }
    fun retryGuardianWithdrawal()=run(false) {
        val epoch=uiEpoch;val result=repository.retryGuardianWithdrawal()
        if(epoch!=uiEpoch)throw CancellationException("Guardian withdrawal UI changed")
        result.request?.let { if(it.child!=repository.credentials?.account)guardianClaim=it }
        refreshAudienceInternal(epoch)
    }
    fun continueAfterAudience() {
        if(busy || ownGuardianWithdrawalPending || audience?.allows("face_authentication")!=true)return
        audienceVisible=false;state.navigate(if(identityAuthenticated)13 else 5)
    }
    val hasAccountRecovery get()=repository.accountRecovery!=null
    val hasLifecycle get()=repository.faceLifecycle!=null
    val lifecycleHold get()=repository.faceLifecycle?.blocksPrivate==true
    val registered get()=identityAuthenticated && !audienceVisible && !ownGuardianWithdrawalPending && audience?.account==repository.credentials?.account && audience?.allows("face_authentication")==true
    val hasGuestDeletion get()=guestDeletion!=null || repository.guestDeletion!=null
    val canDeleteGuest get()=!registered && !hasGuestDeletion && !hasLifecycle && repository.credentials?.method=="anonymous" && !hasAccountRecovery && repository.enrollment?.state !in setOf("registered","credentials_pending")
    val name get()=(me["name"] as? String)?.takeIf { it.isNotBlank() } ?: context.getString(R.string.controller_528d89ad72cb)
    val effective get()=snapshot?.let { draft.effective(it) } ?: emptyList()
    val totals get()=mapOf("photos" to effective.map { it.photo }.toSet().size,"people" to effective.map { it.person }.toSet().size,"pairs" to effective.size)

    private fun run(destinationOnError: Boolean=true,block: suspend ()->Unit) {
        if(busy)return
        val epoch=uiEpoch;busy=true;error=null
        work=scope.launch {
            try { BackgroundTransfers.lease.withLock { block() } }
            catch(error: CancellationException) { throw error }
            catch(problem: LiveFailure) { if(epoch==uiEpoch) {
                if(problem.status==401 || problem.code in listOf("session_revoked","registered_face_required","authentication_required")) {
                    loseAuthentication()
                }
                if(problem.code in AudienceProtocol.gateErrors || problem.code in setOf("audience_response_invalid","audience_authority_expired","guardian_withdrawal_pending")) {
                    audience=null;audienceVisible=true;clearAudienceMedia();state.navigate(5)
                }
                error=problem;if(destinationOnError && !audienceVisible)state.navigate(48)
            } }
            catch(problem: Exception) { if(epoch==uiEpoch) { error=LiveFailure("connection_unavailable");if(destinationOnError)state.navigate(48) } }
            finally { if(epoch==uiEpoch) { busy=false;if(pendingLink!=null && registered)openPendingLink() } }
        }
    }
    fun start() {
        if(started)return;started=true
        val epoch=uiEpoch
        run {
            val restored=repository.bootstrap()
            if(epoch!=uiEpoch)throw CancellationException("Startup UI changed")
            cameraInventoryReady=true;maintainTemporaryMedia()
            me=restored
            if(repository.credentials!=null && repository.credentials?.account==audienceTargetAccount() && repository.accountDeletion==null && repository.guestDeletion==null) {
                val eligibility=refreshAudienceInternal(epoch)
                if(!eligibility.allows("face_authentication")) { state.navigate(5);return@run }
            }
            if(repository.accountDeletion!=null) {
                accountDeletion=repository.accountDeletion;me=emptyMap();state.navigate(44);checkAccountDeletionInternal()
            } else if(repository.guestDeletion!=null) {
                guestDeletion=repository.guestDeletion;me=emptyMap();state.navigate(44)
                try { refreshGuestDeletionInternal() }
                catch(problem: LiveFailure) { error=problem }
            } else if(lifecycleHold || hasLifecycle && repository.credentials?.method!="registered_face" && repository.accountRecovery==null && repository.enrollment==null) {
                faceProfile=repository.faceLifecycle?.metadata;me=emptyMap()
                state.navigate(if(repository.faceLifecycle?.intent?.capture==true || repository.faceLifecycle?.loginKey!=null)6 else 38)
                try {
                    if(state.route==6)restoreFace(epoch) else faceProfile=repository.lifecycleStatus()
                } catch(problem: LiveFailure) { error=problem;faceChallenge=null }
            } else if(repository.accountRecovery!=null || repository.enrollment!=null || repository.cameraLoginHeld) {
                state.navigate(6)
                try { restoreFace(epoch) } catch(problem: LiveFailure) { error=problem;faceChallenge=null }
            } else if(registered) {
                restoreReview();restoreUi();refreshData()
                restoreUploads()
                if(repository.pending?.action=="sharing.commit") { state.navigate(35);reconcileShareInternal() }
                else if(!restoreNavigation())state.navigate(if(uploadRecovery?.let { !it.finished && !it.cancelled }==true)23 else if(photos.isEmpty())47 else 10)
            } else if(state.route>=10)state.navigate(2)
        }
    }
    private suspend fun refreshData() {
        if(!registered)return
        loadLibraryInternal(reset=true)
        val requests=repository.communityRead("inbox")
        photoPolicy=repository.photoPreferences()
        receiveMatches=photoPolicy["receive_matches"]==true
        matchingConsent=photoPolicy["matching_enabled"]==true || photoPolicy["photo_matching_consent"]==true
        processingConsent=photoPolicy["processing_enabled"]==true || photoPolicy["processing_consent"]==true
        inbox.clear();inbox.addAll(NativeProtocol.rows(requests["items"]))
        favorites.clear();favorites.addAll((repository.saved("favorites") as? List<*>)?.mapNotNull { it as? String } ?: emptyList())
        mediaGeneration++
    }
    private suspend fun loadLibraryInternal(reset: Boolean) {
        val scope=repository.currentScope()
        val request=libraryEpoch
        val source=gallerySource(state.category);val query=search.trim()
        val cursor=if(reset)null else libraryCursor ?: return
        val page=repository.photoPage(source,query,cursor)
        repository.fence.assert(scope)
        if(request!=libraryEpoch || source!=gallerySource(state.category) || query!=search.trim())return
        if(reset)photos.clear()
        val known=photos.map { it.id }.toMutableSet()
        photos.addAll(page.items.filter { known.add(it.id) })
        libraryCursor=page.next;librarySource=source;libraryQuery=query;libraryError=null
        selectedPhoto?.let { selected->photos.firstOrNull { it.id==selected.id }?.let { selectedPhoto=it } }
    }
    fun loadMorePhotos() {
        if(libraryLoading || busy || libraryCursor==null || !registered)return
        val request=libraryEpoch
        libraryLoading=true
        scope.launch {
            try { loadLibraryInternal(reset=false) }
            catch(problem: CancellationException) { throw problem }
            catch(problem: LiveFailure) { libraryFailure(problem,request) }
            finally { if(request==libraryEpoch)libraryLoading=false }
        }
    }
    fun updateSearch(value: String) {
        search=value.take(500);persistNavigation();scheduleLibrarySearch()
    }
    fun updateSource(value: String) {
        state.category=value;persistNavigation();scheduleLibrarySearch()
    }
    private fun scheduleLibrarySearch() {
        libraryEpoch++
        val request=libraryEpoch
        // A cursor belongs to one exact search/source. Never use it while a new query is pending.
        libraryCursor=null;libraryError=null;libraryLoading=true;photos.clear();galleryPositions.clear()
        queryJob?.cancel()
        queryJob=scope.launch {
            try {
                delay(300)
                while(busy)delay(100)
                if(!registered)return@launch
                loadLibraryInternal(reset=true)
            }
            catch(problem: CancellationException) { throw problem }
            catch(problem: LiveFailure) { libraryFailure(problem,request) }
            finally { if(request==libraryEpoch)libraryLoading=false }
        }
    }
    private fun libraryFailure(problem: LiveFailure,request: Long) {
        if(request!=libraryEpoch)return
        libraryError=problem
        if(problem.code in AudienceProtocol.gateErrors || problem.code=="guardian_withdrawal_pending") {
            audience=null;audienceVisible=true;clearAudienceMedia();error=problem;state.navigate(5);return
        }
        if(problem.status==401 || problem.code in listOf("session_revoked","registered_face_required","authentication_required")) {
            loseAuthentication();error=problem;state.navigate(48)
        }
    }
    private fun loseAuthentication() {
        libraryEpoch++;queryJob?.cancel();libraryLoading=false;libraryCursor=null
        BackgroundTransfers.cancel(context);PushConfiguration.setOptedIn(context,false);purchases.clearAccount();purchaseVisible=false
        repository.authenticationLost();clearGuestPresentation();viewerRows.clear();outgoing.clear();supportRequests.clear()
        supportSubject="";supportDetails="";supportSubmitted=null;entitlement=emptyMap();restoredUi=false;galleryPositions.clear()
    }
    fun persistNavigation() {
        if(!registered || restoringNavigation)return
        repository.remember("ui_context",mapOf("account" to repository.credentials!!.account,"route" to state.route,"query" to search,
            "category" to state.category,"viewer" to selectedPhoto?.id,"positions" to galleryPositions.mapKeys { it.key.toString() }.mapValues { it.value.wire() }))
        repository.remember("support_draft",mapOf("account" to repository.credentials!!.account,"subject" to supportSubject,"details" to supportDetails))
    }
    private var restoredRoute=10
    private fun restoreUi() {
        if(restoredUi || !registered)return
        restoredUi=true
        val saved=repository.saved("ui_context") as? Map<*,*> ?: return
        if(saved["account"]!=repository.credentials?.account)return
        restoringNavigation=true
        try {
            search=(saved["query"] as? String)?.take(500).orEmpty()
            state.category=(saved["category"] as? String)?.takeIf { it in setOf("All","Contributed","Received") } ?: "All"
            restoredRoute=(saved["route"] as? Number)?.toInt()?.takeIf { it in setOf(10,11,12,13,14,15,16,17,18,19,21,22,23,25,26,27,28,29,30,31,32,33,35,37,39,40,41,42,43,44,45,46) } ?: 10
            restoredViewer=saved["viewer"] as? String
            (saved["positions"] as? Map<*,*>)?.forEach { (key,value)->(key as? String)?.toIntOrNull()?.let { galleryPositions[it]=GalleryPosition.parse(value) } }
        } catch(_: Exception) { restoredRoute=10;galleryPositions.clear() }
        finally { restoringNavigation=false }
        (repository.saved("support_draft") as? Map<*,*>)?.takeIf { it["account"]==repository.credentials?.account }?.let {
            supportSubject=(it["subject"] as? String).orEmpty();supportDetails=(it["details"] as? String).orEmpty()
        }
    }
    private fun restoreNavigation(): Boolean {
        if(!restoredUi)return false
        val target=restoredRoute
        if(target==12) {
            selectedPhoto=photos.firstOrNull { it.id==restoredViewer }
            if(selectedPhoto==null)return false
            viewerRows.clear();viewerRows.addAll(photos)
        }
        if(target in 25..33 && snapshot==null)return false
        state.navigate(target);return true
    }
    fun updateGalleryPosition(route: Int,item: Int,offset: Int) {
        galleryPositions[route]=GalleryPosition(item,offset)
    }
    fun refresh()=run { if(me.isEmpty()) { me=repository.bootstrap() };if(registered) { refreshData();state.navigate(if(photos.isEmpty())47 else 10) } else state.navigate(2) }
    fun route(destination: Int): Int {
        if(destination in setOf(44,45))return destination
        if(destination==46)return if(weakRegisteredSession)46 else 45
        if(audienceVisible && destination !in setOf(2,5,44,45,48))return 5
        if(repository.accountDeletion!=null && destination !in listOf(44,45,48))return 44
        if(hasGuestDeletion && destination !in listOf(44,45,48))return 44
        val life=repository.faceLifecycle
        val mayVerify=life?.intent?.capture==true || life?.intent==null && life?.metadata?.authenticationEnabled==true
        if(lifecycleHold && destination !in listOf(38,45,48) && !(destination==6 && mayVerify))return 38
        if(hasLifecycle && !registered && repository.accountRecovery==null && repository.enrollment==null && destination>=10 && destination !in listOf(38,45,48))return 38
        if(hasLifecycle && destination==38)return 38
        if(destination==3)return if(registered)10 else 4
        if(destination>=10 && destination !in listOf(44,45,48) && !registered)return 6
        return destination
    }
    fun onRoute(destination: Int) {
        if(destination !in setOf(6,7))invalidateCameraReview()
        if(destination==38 && !busy && (registered || hasLifecycle))checkFaceProfile()
        if(destination==6 && !cameraForUpload && faceChallenge==null && !busy)beginFace()
        if(destination==35 && !busy && registered)refreshHistory()
        if(destination==35 && outcome==null)(repository.saved("last_outcome") as? Map<*,*>)?.let { outcome=NativeProtocol.obj(it) }
        if(destination==45 && !busy && registered)refreshSupport()
        if(destination==17 && !busy && registered)run(false) { refreshData() }
        if(destination==18 && !busy && registered)run { notifications.clear();notifications.addAll(NativeProtocol.rows(repository.get("/me/notifications")["items"])) }
        if(destination==42 && !busy && registered)run { notificationSettings=repository.get("/me/notification-settings") }
        if(destination==44 && !busy && repository.accountDeletion!=null)checkAccountDeletion()
        if(destination==44 && !busy && weakRegisteredSession)run(false) { privacyCenter=repository.get("/privacy/center") }
        if(destination==44 && !busy && !registered && hasGuestDeletion)checkGuestDeletion()
        if(destination==39 && !busy && registered)run { blocked.clear();blocked.addAll(NativeProtocol.rows(repository.get("/me/blocks")["items"])) }
        if(destination==46 && !busy && weakRegisteredSession)refreshOwnSecurity()
    }
    private suspend fun loadOwnSecurity() {
        sessions.clear();sessions.addAll(NativeProtocol.rows(repository.get("/me/sessions")["items"]))
        devices.clear();devices.addAll(NativeProtocol.rows(repository.get("/me/devices")["items"]))
        recoveryKeyMetadata=if(registered)repository.recoveryKey() else null
    }
    fun refreshOwnSecurity()=run(false) { loadOwnSecurity() }
    private fun audienceTargetAccount(): String?=repository.faceLifecycle?.account ?: repository.accountRecovery?.account ?: repository.enrollment?.account ?: repository.identity?.account ?: repository.credentials?.account
    private suspend fun restoreFace(epoch: Long) {
        if(ownGuardianWithdrawalPending)throw LiveFailure("guardian_withdrawal_pending",403)
        // A retained logged-out key may obtain only a target-bound server capture authority.
        // It cannot declare a new age or supply general product/purpose eligibility.
        if(repository.credentials!=null && repository.credentials?.account==audienceTargetAccount())requireAudience("face_authentication",epoch)

        cameraForUpload=false
        val restored=repository.faceChallenge()
        if(epoch!=uiEpoch)throw CancellationException("Face UI changed")
        if(!repository.cameraLoginHeld && !lifecycleHold && repository.enrollment==null && repository.accountRecovery==null && repository.credentials?.method=="registered_face") {
            me=repository.get("/me",false)
            if(epoch!=uiEpoch)throw CancellationException("Face UI changed")
            requireAudience("face_authentication",epoch);audienceVisible=false
            faceChallenge=null;captureCount=0;mediaGeneration++;faceProfile=repository.faceLifecycle?.metadata;restoreReview();refreshData();restoreUploads()
            if(repository.pending?.action=="sharing.commit") { reconcileShareInternal();state.navigate(35) }
            else state.navigate(if(hasLifecycle)38 else if(uploadRecovery?.let { !it.finished && !it.cancelled }==true)23 else 9)
        } else {
            AudienceProtocol.captureAuthority(restored)
            audienceVisible=false;faceChallenge=restored;captureCount=repository.faceCaptureCount;state.selfieCount=captureCount;cameraReady=false
        }
    }
    fun beginFace() {
        if(busy)return
        invalidateCameraReview();uiEpoch++;repository.invalidateReads();faceChallenge=null;captureCount=0;cameraReady=false
        cameraForUpload=false;cameraUploadId=null
        run(false) { restoreFace(uiEpoch) }
    }
    fun checkFaceProfile()=run(false) {
        val epoch=uiEpoch;val result=repository.lifecycleStatus()
        if(epoch!=uiEpoch)throw CancellationException("Profile UI changed")
        faceProfile=result
        if(!result.authenticationEnabled)clearLifecyclePresentation()
    }
    fun verifyFaceProfile() {
        if(busy || hasGuestDeletion)return
        val reviewed=repository.currentScope();val owned=try { repository.invalidateReads(reviewed) } catch(problem: LiveFailure) { error=problem;return }
        invalidateCameraReview();uiEpoch++;faceChallenge=null;captureCount=0;cameraReady=false;cameraForUpload=false;cameraUploadId=null
        val epoch=uiEpoch
        run(false) {
            val next=repository.lifecycleVerify(owned)
            if(epoch!=uiEpoch)throw CancellationException("Profile sign-in UI changed")
            if(!lifecycleHold && repository.credentials?.method=="registered_face") {
                me=repository.get("/me",false);requireAudience("face_authentication",epoch);audienceVisible=false;faceProfile=repository.faceLifecycle?.metadata;refreshData();state.navigate(38)
            } else { AudienceProtocol.captureAuthority(next);audienceVisible=false;faceChallenge=next;captureCount=repository.faceCaptureCount;state.navigate(6) }
        }
    }
    fun confirmProfileRenewal() {
        if(busy || hasGuestDeletion)return
        val epoch=uiEpoch;val reviewed=repository.currentScope()
        state.confirm(context.getString(R.string.controller_ec7d2382fde4),context.getString(R.string.controller_f108323d93e8),context.getString(R.string.controller_90c1689b0b74)) {
            if(epoch!=uiEpoch) { error=LiveFailure("session_changed");return@confirm }
            val owned=try { repository.invalidateReads(reviewed) } catch(problem: LiveFailure) { error=problem;return@confirm }
            invalidateCameraReview();uiEpoch++;faceChallenge=null;captureCount=0;cameraReady=false
            val nextEpoch=uiEpoch
            run(false) {
                val next=repository.lifecycleRenew(owned)
                if(nextEpoch!=uiEpoch)throw CancellationException("Profile renewal UI changed")
                faceProfile=next;me=repository.get("/me",false);state.navigate(38)
            }
        }
    }
    private fun clearLifecyclePresentation() {
        OriginalMedia.prune(context,true);shareIntent=null;interruptedOriginal=null
        invalidateCameraReview()
        clearImages();photos.clear();inbox.clear();snapshot=null;preview=null;outcome=null;focusedReceipt=null;focusedPerson=null;me=emptyMap()
        picked.clear();selectedUploads.clear();uploadIds.clear();uploadBatch=null;uploadStatus="";uploadRecovery=null;caption=""
        recoveryBackupDisplay=null;recoveryKeyMetadata=null;faceChallenge=null;cameraForUpload=false;cameraUploadId=null;cameraReady=false
        OriginalMedia.pruneCamera(context,true)
    }
    fun confirmFaceProfile(action: String,title: String,body: String,button: String,version: Long) {
        if(busy || hasGuestDeletion)return
        val epoch=uiEpoch;val reviewedScope=repository.currentScope()
        state.confirm(title,body,button) {
            if(action in setOf("replace","restore_authentication","enroll"))beginFaceProfile(action,version,epoch,reviewedScope)
            else faceProfileAction(action,version,epoch,reviewedScope)
        }
    }
    fun faceProfileAction(action: String,version: Long?=faceProfile?.version,reviewedEpoch: Long=uiEpoch,reviewedScope: SessionScope=repository.currentScope()) {
        if(busy || hasGuestDeletion)return
        if(reviewedEpoch!=uiEpoch) { error=LiveFailure("session_changed");return }
        val owned=try { repository.invalidateReads(reviewedScope) } catch(problem: LiveFailure) { error=problem;return }
        invalidateCameraReview();uiEpoch++;faceChallenge=null;captureCount=0;cameraReady=false;cameraForUpload=false;cameraUploadId=null
        val epoch=uiEpoch
        run(false) {
            try {
                val result=repository.lifecycleAction(action,version,owned)
                if(epoch!=uiEpoch)throw CancellationException("Profile UI changed")
                faceProfile=result;clearImages();snapshot=null;preview=null;outcome=null;focusedReceipt=null
                if(!result.authenticationEnabled)clearLifecyclePresentation() else { me=repository.get("/me",false);refreshData() }
                state.navigate(38)
            } finally { if(epoch==uiEpoch)faceProfile=repository.faceLifecycle?.metadata }
        }
    }
    fun beginFaceProfile(action: String,version: Long?=faceProfile?.version,reviewedEpoch: Long=uiEpoch,reviewedScope: SessionScope=repository.currentScope()) {
        if(busy || hasGuestDeletion)return
        if(reviewedEpoch!=uiEpoch) { error=LiveFailure("session_changed");return }
        val owned=try { repository.invalidateReads(reviewedScope) } catch(problem: LiveFailure) { error=problem;return }
        invalidateCameraReview();uiEpoch++;faceChallenge=null;captureCount=0;cameraReady=false;cameraForUpload=false;cameraUploadId=null
        val epoch=uiEpoch
        run(false) {
            try {
                val next=repository.lifecycleBegin(action,version,owned)
                if(epoch!=uiEpoch)throw CancellationException("Profile capture UI changed")
                AudienceProtocol.captureAuthority(next);audienceVisible=false
                faceProfile=repository.faceLifecycle?.metadata;faceChallenge=next;captureCount=repository.faceCaptureCount;state.navigate(6)
            } catch(problem: LiveFailure) {
                if(epoch==uiEpoch) { faceProfile=repository.faceLifecycle?.metadata;if(repository.faceLifecycle?.intent?.capture==true)state.navigate(6) }
                throw problem
            }
        }
    }
    fun showAccountRecoveryImport(replace: Boolean=false) { if(!hasGuestDeletion && !busy) { replaceRecoveryImport=replace;recoveryImportVisible=true;error=null } }
    fun dismissAccountRecoveryImport() { recoveryImportVisible=false }
    fun recoverAccount(backup: String) {
        if(busy || hasGuestDeletion)return
        recoveryImportVisible=false;val replace=replaceRecoveryImport;replaceRecoveryImport=false
        invalidateCameraReview();uiEpoch++;repository.invalidateReads();faceChallenge=null;captureCount=0;cameraReady=false;cameraForUpload=false;cameraUploadId=null
        val epoch=uiEpoch
        run(false) {
            try {
                val next=if(replace)repository.switchAccountRecovery(backup) else repository.beginAccountRecovery(backup)
                if(epoch!=uiEpoch)throw CancellationException("Recovery UI changed")
                me=emptyMap();clearImages();photos.clear();inbox.clear();snapshot=null;preview=null;outcome=null;mediaGeneration++
                AudienceProtocol.captureAuthority(next);audienceVisible=false
                cameraForUpload=false;faceChallenge=next;captureCount=repository.faceCaptureCount;cameraReady=false;state.navigate(6)
            } catch(problem: LiveFailure) {
                if(epoch==uiEpoch && repository.accountRecovery!=null) { me=emptyMap();faceChallenge=null;state.navigate(6) }
                throw problem
            }
        }
    }
    fun generateRecoveryKey(replacePending: Boolean=false)=run(false) {
        val epoch=uiEpoch;val result=repository.createRecoveryKey(replacePending)
        if(epoch!=uiEpoch)throw CancellationException("Recovery key UI changed")
        recoveryKeyMetadata=result;recoveryBackupDisplay=null
    }
    fun showRecoveryBackup()=run(false) {
        val epoch=uiEpoch;val text=repository.recoveryBackupText()
        if(epoch!=uiEpoch || !registered)throw CancellationException("Recovery key UI changed")
        recoveryBackupDisplay=text
    }
    fun hideRecoveryBackup() { recoveryBackupDisplay=null }
    fun revokeRecoveryKey()=run(false) {
        val epoch=uiEpoch;repository.revokeRecoveryKey()
        if(epoch!=uiEpoch)throw CancellationException("Recovery key UI changed")
        recoveryBackupDisplay=null;recoveryKeyMetadata=null
    }
    fun captureContext(): NativeCaptureContext? {
        return synchronized(repository.fence) {
            if(!foregroundActive || ownGuardianWithdrawalPending || state.route !in setOf(6,7) || hasGuestDeletion)return@synchronized null
            val session=repository.currentScope()
            if(cameraForUpload) {
                if(audience?.account!=repository.credentials?.account || audience?.allows("photo_processing")!=true)return@synchronized null
                val request=cameraUploadId ?: return@synchronized null
                return@synchronized NativeCaptureContext(uiEpoch,session,repository.baseUrl,CameraCaptureMode.UPLOAD,"personal",request,null,0,"photo")
            }
            val challenge=faceChallenge ?: return@synchronized null
            if(runCatching { AudienceProtocol.captureAuthority(challenge) }.isFailure)return@synchronized null
            val index=captureCount
            val pose=(challenge["poses"] as? List<*>)?.getOrNull(index) as? String ?: return@synchronized null
            val request=repository.faceLifecycle?.loginKey ?: if(repository.faceLifecycle?.intent?.capture==true)"${repository.faceLifecycle!!.intent!!.key}:${repository.faceLifecycle!!.generation}"
                else repository.accountRecovery?.requestId ?: repository.enrollment?.key ?: NativeProtocol.id(challenge["challenge_id"])
            NativeCaptureContext(uiEpoch,session,repository.baseUrl,CameraCaptureMode.FACE,"face_authentication",request,
                NativeCaptureContext.fingerprint(challenge),index,pose)
        }
    }
    fun shutterContext(expected: NativeCaptureContext): NativeCaptureContext? {
        if(androidx.core.content.ContextCompat.checkSelfPermission(context,android.Manifest.permission.CAMERA)!=android.content.pm.PackageManager.PERMISSION_GRANTED) {
            cameraError(expected,"camera_permission_required");return null
        }
        if(busy || reviewingCapture)return null
        return captureContext()?.takeIf { it==expected }
    }
    /** Each personal camera boundary needs fresh strong profile authority; face challenges keep their own authority. */
    fun authorizePersonalCollection(expected: NativeCaptureContext,onResult: (Boolean)->Unit) {
        if(expected.mode!=CameraCaptureMode.UPLOAD || busy || !foregroundActive || expected!=captureContext()) { onResult(false);return }
        val replied=java.util.concurrent.atomic.AtomicBoolean(false)
        fun reply(allowed: Boolean) { if(replied.compareAndSet(false,true))onResult(allowed) }
        run(false) {
            var accepted=false
            try {
                val authority=requireLocalCollection(expected.uiEpoch,expected.session)
                synchronized(repository.fence) {
                    repository.assertLocalCollection(authority)
                    if(expected!=captureContext())throw LiveFailure("capture_context_changed")
                    accepted=true
                }
            } finally { reply(accepted) }
        }
        // Cancellation while waiting for the shared transfer lease still releases adapter-held buffers.
        work?.invokeOnCompletion { reply(false) }
    }
    /** Camera arrival is local review only; signing/upload require explicit approval. */
    fun capture(bytes: ByteArray,owner: NativeCaptureContext) {
        if(androidx.core.content.ContextCompat.checkSelfPermission(context,android.Manifest.permission.CAMERA)!=android.content.pm.PackageManager.PERMISSION_GRANTED) {
            bytes.fill(0);cameraError(owner,"camera_permission_required");return
        }
        if(busy || reviewingCapture || !acceptBoundCaptureFrame(bytes,owner,captureContext())) { bytes.fill(0);return }
        val preview=try { decodeCameraReview(bytes) } catch(problem: Exception) { bytes.fill(0);cameraError(owner,(problem as? LiveFailure)?.code ?: "camera_image_invalid");return }
        if(!cameraReview.offer(bytes,owner,captureContext())) { preview.recycle();return }
        reviewPreview=preview;reviewingCapture=true;cameraReady=false;cameraStatus=CameraStatus(CameraPhase.REVIEW);error=null
        reviewExpiry=scope.launch {
            delay(CameraReviewBuffer.MAX_AGE_MS)
            if(cameraReview.owner()==owner) {
                invalidateCameraReview();uiEpoch++;cameraStatus=CameraStatus(CameraPhase.FAILED,"camera_review_expired");error=LiveFailure("camera_review_expired")
            }
        }
    }
    fun retakeCapture() {
        if(busy)return
        invalidateCameraReview();uiEpoch++;cameraStatus=CameraStatus(CameraPhase.IDLE);error=null
    }
    fun approveCapture() {
        if(busy || !reviewingCapture)return
        if(androidx.core.content.ContextCompat.checkSelfPermission(context,android.Manifest.permission.CAMERA)!=android.content.pm.PackageManager.PERMISSION_GRANTED) {
            val owner=cameraReview.owner();invalidateCameraReview();owner?.let { cameraError(it,"camera_permission_required") };return
        }
        reviewExpiry?.cancel();reviewExpiry=null
        val frame=cameraReview.approve(captureContext())
        reviewPreview?.let { if(it.isMutable)it.eraseColor(0) };reviewPreview=null;reviewingCapture=false
        if(frame==null) { cameraStatus=CameraStatus(CameraPhase.FAILED,"camera_review_expired");error=LiveFailure("camera_review_expired");return }
        dispatchBoundCaptureFrame(frame.bytes,frame.owner,::captureContext,::captureFace,::captureUpload)
    }
    fun cameraState(owner: NativeCaptureContext,value: CameraStatus) {
        if(owner==captureContext() && !reviewingCapture)cameraStatus=value
    }
    private fun captureUpload(bytes: ByteArray,owner: NativeCaptureContext) {
        run(false) captureWork@{
            try {
                if(!acceptBoundCaptureFrame(bytes,owner,captureContext()))return@captureWork
                val authority=requireLocalCollection(owner.uiEpoch,owner.session)
                synchronized(repository.fence) {
                    if(!acceptBoundCaptureFrame(bytes,owner,captureContext()))return@synchronized
                    repository.assertLocalCollection(authority)
                    val uri=OriginalMedia.camera(context,bytes)
                    cameraForUpload=false;cameraUploadId=null;choosePhotos(listOf(uri))
                }
            } finally { bytes.fill(0) }
        }
    }
    private fun captureFace(bytes: ByteArray,owner: NativeCaptureContext) {
        val epoch=owner.uiEpoch
        run(false) captureWork@{
            try {
                if(!acceptBoundCaptureFrame(bytes,owner,captureContext()))return@captureWork
                val (count,result)=repository.faceCapture(bytes,owner)
                if(epoch!=uiEpoch)throw CancellationException("Face UI changed")
                captureCount=count;state.selfieCount=count
                if(result!=null) {
                    me=repository.get("/me",false)
                    if(epoch!=uiEpoch)throw CancellationException("Face UI changed")
                    requireAudience("face_authentication",epoch);audienceVisible=false
                    faceChallenge=null;mediaGeneration++;restoreReview();refreshData();restoreUploads()
                    faceProfile=repository.faceLifecycle?.metadata
                    if(repository.pending?.action=="sharing.commit") { reconcileShareInternal();state.navigate(35) } else state.navigate(if(hasLifecycle)38 else if(uploadRecovery?.let { !it.finished && !it.cancelled }==true)23 else 9)
                }
            } catch(problem: LiveFailure) { if(epoch==uiEpoch) { repository.cancelFace();faceChallenge=null;captureCount=repository.faceLifecycle?.accepted?.size ?: if(repository.accountRecovery?.accepted==true)1 else repository.enrollment?.accepted?.size ?: 0 };throw problem }
            finally { bytes.fill(0) }
        }
    }
    fun cancelFace() {
        invalidateCameraReview();uiEpoch++;work?.cancel();busy=false;val owned=repository.cancelFace();faceChallenge=null;captureCount=0;cameraReady=false
        mediaGeneration++;state.navigate(if(cameraForUpload)20 else if(hasLifecycle)38 else 5);cameraForUpload=false;cameraUploadId=null
        if(repository.faceLifecycle?.intent?.capture==true || repository.faceLifecycle?.loginKey!=null)run(false) { faceProfile=repository.lifecycleCancel(owned);state.navigate(38) }
    }
    fun retryProfileCancellation()=run(false) { faceProfile=repository.lifecycleCancel() }
    fun cameraUpload() {
        if(busy)return
        invalidateCameraReview();uiEpoch++;repository.invalidateReads();faceChallenge=null;captureCount=0;cameraReady=false
        val epoch=uiEpoch
        run(false) { requireLocalCollection(epoch);cameraUploadId=UUID.randomUUID().toString();cameraForUpload=true;state.navigate(6) }
    }
    fun cameraError(owner: NativeCaptureContext,code: String) {
        if(owner!=captureContext())return
        invalidateCameraReview();error=LiveFailure(code);cameraStatus=CameraStatus(CameraPhase.FAILED,code)
    }
    private fun photoPickerContext(request: String): NativePhotoPickerOwner? {
        if(!registered || audience?.allows("photo_processing")!=true || state.reviewMode || hasGuestDeletion)return null
        val actor=repository.credentials ?: return null
        val device=repository.identity ?: return null
        val session=repository.currentScope()
        if(actor.method!="registered_face" || actor.expires<=System.currentTimeMillis() ||
            device.account!=actor.account || session.accountId!=actor.account)return null
        return NativePhotoPickerOwner(NativeCaptureContext(uiEpoch,session,repository.baseUrl,CameraCaptureMode.UPLOAD,
            "personal",request,null,0,"photo"),device.device)
    }
    fun beginPhotoPicker(onReady: (NativePhotoPickerOwner)->Unit) {
        if(busy || !foregroundActive || photoPickerOwnership.opened!=null)return
        val epoch=uiEpoch
        run(false) {
            val authority=requireLocalCollection(epoch)
            synchronized(repository.fence) {
                if(!foregroundActive || epoch!=uiEpoch)throw CancellationException("Picker UI changed")
                repository.assertLocalCollection(authority)
                val owner=photoPickerContext(UUID.randomUUID().toString()) ?: throw LiveFailure("registered_face_required",403)
                if(photoPickerOwnership.begin(owner))onReady(owner)
            }
        }
    }
    fun cancelPhotoPicker(owner: NativePhotoPickerOwner) = synchronized(repository.fence) { photoPickerOwnership.cancel(owner) }
    fun acceptPickedPhotos(uris: List<Uri>,owner: NativePhotoPickerOwner?) {
        val expected=synchronized(repository.fence) {
            val current=owner?.capture?.requestId?.let(::photoPickerContext)
            if(photoPickerOwnership.consume(owner,current) && uris.isNotEmpty())current else null
        } ?: return
        val epoch=expected.capture.uiEpoch
        run(false) {
            val authority=requireLocalCollection(epoch,expected.capture.session)
            synchronized(repository.fence) {
                repository.assertLocalCollection(authority)
                if(expected!=photoPickerContext(expected.capture.requestId))throw LiveFailure("capture_context_changed")
                choosePhotos(uris)
            }
        }
    }
    private fun choosePhotos(uris: List<Uri>) {
        if(repository.photoUploads()?.let { !it.finished && !it.cancelled }==true) { restoreUploads();state.navigate(23);return }
        repository.clearFinishedPhotoUploads()
        picked.clear();picked.addAll(uris.distinct().take(100));selectedUploads.clear();selectedUploads.addAll(picked);state.navigate(21)
        picked.forEach { runCatching { context.contentResolver.takePersistableUriPermission(it,android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION) } }
        repository.savePhotoUploadDraft(picked.toList(),selectedUploads.toList(),caption);uploadRecovery=null;uploadBatch=null;uploadIds.clear()
        maintainTemporaryMedia()
    }
    fun toggleUpload(uri: Uri) { if(busy)return;if(uri in selectedUploads)selectedUploads.remove(uri) else selectedUploads.add(uri);persistUploadDraft() }
    fun uploadCaption(value: String) { caption=value.take(200);persistUploadDraft() }
    private fun persistUploadDraft() { if(registered)repository.savePhotoUploadDraft(picked.toList(),selectedUploads.toList(),caption) }
    private fun presentUpload(record: PhotoUploadBatch) {
        val terminalChanged=(record.finished || record.cancelled) && uploadRecovery!=record
        backgroundUploads=BackgroundTransfers.permitted(repository.saved("background_upload"),record.account,record.device,record.batch)
        uploadRecovery=record;uploadBatch=record.batch;uploadIds.clear();uploadIds.addAll(record.assetIds)
        uploadStatus=when {
            record.cancelled->context.getString(R.string.controller_c572c62d9ac7)
            record.finished->context.resources.getQuantityString(R.plurals.controller_photos_processed,record.readyCount,record.readyCount)
            record.cancelling->context.getString(R.string.controller_84050f9a2b22)
            record.error!=null->readableError(record.error,context)
            record.files.any { it.sha256==null }->context.resources.getQuantityString(R.plurals.controller_photos_preparing,record.files.size,record.files.count { it.sha256!=null },record.files.size)
            record.files.all { it.status in setOf("processing","ready","failed") }->context.resources.getQuantityString(R.plurals.controller_photos_progress,record.files.size,record.readyCount,record.files.size)
            else->context.resources.getQuantityString(R.plurals.controller_bytes_saved,record.bytesTotal.coerceAtMost(Int.MAX_VALUE.toLong()).toInt(),record.bytesAcknowledged,record.bytesTotal)
        }
        if(terminalChanged)maintainTemporaryMedia()
    }
    private fun restoreUploads() {
        val record=repository.photoUploads()
        if(record!=null) {
            record.assertOwner(repository.baseUrl,repository.credentials?.account,repository.identity?.device)
            presentUpload(record);picked.clear();picked.addAll(record.picked.map(Uri::parse));selectedUploads.clear();selectedUploads.addAll(record.selected.map(Uri::parse));caption=record.caption
        } else repository.photoUploadDraft()?.let { draft ->
            picked.clear();picked.addAll((draft["picked"] as? List<*>)?.map { Uri.parse(NativeProtocol.text(it,8192)) } ?: emptyList())
            selectedUploads.clear();selectedUploads.addAll((draft["selected"] as? List<*>)?.map { Uri.parse(NativeProtocol.text(it,8192)) }?.filter { it in picked } ?: emptyList());caption=draft["caption"] as? String ?: ""
        }
    }
    fun upload() {
        if(selectedUploads.isEmpty())return
        runUploads(startNew=true)
    }
    fun resumeUploads(retryFailed: Boolean=false)=runUploads(startNew=false,retryFailed=retryFailed)
    private fun runUploads(startNew: Boolean,retryFailed: Boolean=false) {
        run(destinationOnError=false) {
            if(repository.photoUploads()?.cancelling!=true)requireAudience("photo_processing")
            if(!processingConsent && repository.photoUploads()?.cancelling!=true)throw LiveFailure("processing_consent_required",403)
            val epoch=uiEpoch
            presentUpload(repository.openPhotoUploadBatch(startNew,picked.toList(),selectedUploads.toList(),caption))
            state.navigate(23)
            presentUpload(repository.resumePhotoUploads(retryFailed) { record -> withContext(Dispatchers.Main.immediate) { if(epoch==uiEpoch)presentUpload(record) } })
            if(uploadRecovery?.cancelled==true) { refreshData();return@run }
            var attempts=0
            while(attempts++<120) {
                val current=repository.refreshPhotoUploads();if(epoch!=uiEpoch)throw CancellationException("Upload UI changed");presentUpload(current)
                val failed=current.files.firstOrNull { it.status=="failed" }
                if(failed!=null)throw LiveFailure(failed.error ?: "photo_processing_failed")
                if(current.finished) { refreshData();state.navigate(24);return@run }
                delay(2500)
            }
            throw LiveFailure("processing_pending")
        }
    }
    fun pauseUploads() {
        configureBackgroundUploads(false)
        uiEpoch++;work?.cancel();work=null;repository.pausePhotoUploads()?.let(::presentUpload);busy=false;error=null;state.navigate(23)
    }
    fun cancelUploads() {
        state.confirm(context.getString(R.string.controller_a9d087af281a),context.getString(R.string.controller_23a3f52d76e9),context.getString(R.string.controller_b3f81aca8528)) {
            pauseUploads();presentUpload(repository.requestPhotoUploadCancellation());resumeUploads()
        }
    }
    fun reviewPhotos(ids: List<String>?=null,batch: String?=null,source: String="personal")=run {
        NativeProtocol.mediaSource(source)
        val response=repository.mutate("sharing.snapshot",mutableMapOf<String,Any?>().apply {
            if(ids!=null)put("asset_ids",ids);if(batch!=null)put("upload_batch_id",batch);put("source","personal")
        },source,validate={ value,_ -> LiveSnapshot.parse(value,System.currentTimeMillis(),source,ids) })
        snapshot=LiveSnapshot.parse(response,System.currentTimeMillis(),source,ids)
        val snap=snapshot!!;draft=LiveDraft(1,snap.photos.map { it.id }.toSet(),snap.people.map { it.id }.toSet(),emptySet());preview=null;outcome=null
        focusedPerson=null;persistDraft()
        state.navigate(if(snap.pairs.isEmpty())47 else if(ids?.size==1)27 else 25)
    }
    fun selectedPhotoMatches() { selectedPhoto?.let { reviewPhotos(listOf(it.id),source=it.mediaSource) } }
    fun togglePhoto(id: String) { changeDraft(draft.copy(photos=if(id in draft.photos)draft.photos-id else draft.photos+id)) }
    fun allPhotos(selected: Boolean) { changeDraft(draft.copy(photos=if(selected)snapshot?.photos?.map { it.id }?.toSet() ?: emptySet() else emptySet())) }
    fun togglePerson(id: String) { changeDraft(draft.copy(people=if(id in draft.people)draft.people-id else draft.people+id)) }
    fun togglePair(photo: String,person: String) {
        val pair=LivePair(photo,person);changeDraft(draft.copy(excluded=if(draft.excluded.any { it.photo==photo && it.person==person })draft.excluded.filterNot { it.photo==photo && it.person==person }.toSet() else draft.excluded+pair))
    }
    private fun changeDraft(next: LiveDraft) { if(busy || repository.pending!=null)return;draft=next.copy(version=draft.version+1);preview=null;persistDraft() }
    private fun persistDraft() {
        val snap=snapshot ?: return
        repository.remember("review",mapOf("snapshot" to snap.wire,"draft" to mapOf("version" to draft.version,"photos" to draft.photos.sorted(),
            "people" to draft.people.sorted(),"excluded" to draft.excluded.map(LivePair::wire)),"preview" to preview?.wire))
    }
    private fun restoreReview() {
        val saved=(repository.saved("review") as? Map<*,*>)?.let(NativeProtocol::obj) ?: return
        runCatching {
            val value=NativeProtocol.obj(saved["snapshot"]);val source=NativeProtocol.mediaSource(value["source"])
            snapshot=LiveSnapshot.parse(mapOf("protocol" to "reviewed-sharing-v1","status" to "ready","snapshot" to value),0,source,null)
            val d=NativeProtocol.obj(saved["draft"]);draft=LiveDraft(NativeProtocol.integer(d["version"],1).toInt(),NativeProtocol.idList(d["photos"]).toSet(),NativeProtocol.idList(d["people"]).toSet(),
                NativeProtocol.rows(d["excluded"],1000).map { LivePair(NativeProtocol.id(it["asset_id"]),NativeProtocol.id(it["recipient_id"])) }.toSet())
            if(saved["preview"]!=null)preview=LivePreview.parse(mapOf("protocol" to "reviewed-sharing-v1","status" to "ready","preview" to saved["preview"]),snapshot!!,draft,0)
        }.onFailure { snapshot=null;preview=null;repository.remember("review",null) }
    }
    fun prepareShare() {
        val snap=snapshot ?: return
        if(effective.isEmpty())return
        run {
            val response=repository.mutate("sharing.preview",draft.wire(snap),snap.source,validate={ value,_ -> LivePreview.parse(value,snap,draft,System.currentTimeMillis()) })
            preview=LivePreview.parse(response,snap,draft,System.currentTimeMillis());persistDraft();state.navigate(33)
        }
    }
    fun commitShare() {
        val snap=snapshot ?: return;val view=preview ?: return
        if(view.draftVersion!=draft.version || view.pairs.map { it.photo to it.person }.toSet()!=effective.map { it.photo to it.person }.toSet()) { error=LiveFailure("review_changed");return }
        run {
            state.navigate(34)
            val response=repository.mutate("sharing.commit",mapOf("preview_id" to view.id,"preview_version" to view.version,"draft_version" to view.draftVersion),snap.source,
                validate={ value,key -> validateOutcome(value,view,snap.source,key) })
            outcome=response;repository.remember("last_outcome",response);refreshData();state.navigate(35)
        }
    }
    private suspend fun reconcileShareInternal() {
        val view=preview ?: throw LiveFailure("review_recovery_required")
        val snap=snapshot ?: throw LiveFailure("review_recovery_required")
        val result=repository.reconcile { value,key -> validateOutcome(value,view,snap.source,key) }
        if(result["status"]=="unknown")throw LiveFailure("pending_operation_requires_reconciliation")
        outcome=result;repository.remember("last_outcome",result)
    }
    fun reconcileShare()=run { reconcileShareInternal();state.navigate(35) }
    fun retryPending() {
        if(repository.pending?.action=="sharing.commit") { commitShare();return }
        if(repository.photoUploads()?.let { !it.finished && !it.cancelled }==true) { state.navigate(23);resumeUploads(retryFailed=true);return }
        if(error?.code in listOf("review_changed","review_expired","eligibility_changed_review_required")) {
            repository.abandonReadReview();snapshot?.let { reviewPhotos(it.photos.map { photo -> photo.id },source=it.source) };return
        }
        if(repository.pending!=null)run { repository.resumePending();refreshData();state.navigate(if(registered)13 else 5) }
        else refresh()
    }
    fun openPhoto(photo: LivePhoto,rows: List<LivePhoto> = photos.toList()) { viewerRows.clear();viewerRows.addAll(rows);selectedPhoto=photo;state.navigate(12) }
    fun movePhoto(delta: Int) { selectedPhoto?.let { current->adjacentPhoto(viewerRows,current.id,delta)?.let { selectedPhoto=it;persistNavigation() } } }
    fun refreshHistory()=run(false) { outgoing.clear();outgoing.addAll(NativeProtocol.rows(repository.communityRead("history")["items"])) }
    fun refreshSupport()=run(false) { supportRequests.clear();supportRequests.addAll(NativeProtocol.rows(repository.get("/support/requests")["support_requests"])) }
    fun submitSupport()=run(false) {
        val subject=supportSubject.trim();val details=supportDetails.trim()
        if(subject.length !in 3..160 || details.length !in 5..4000)throw LiveFailure("invalid_support_request")
        val result=repository.mutate("support.create",mapOf("subject" to subject,"details" to details),"support",path="/support/requests")
        supportSubmitted=NativeProtocol.id(result["id"]);supportSubject="";supportDetails="";persistNavigation()
        supportRequests.clear();supportRequests.addAll(NativeProtocol.rows(repository.get("/support/requests")["support_requests"]))
    }
    fun openPerson(id: String) { focusedPerson=id;state.navigate(28) }
    fun toggleFavorite(id: String) { if(id in favorites)favorites.remove(id) else favorites.add(id);repository.remember("favorites",favorites.toList()) }
    fun openReceipt(value: WireObject) {
        val id=NativeProtocol.id(value["id"])
        openRequest(id)
    }
    fun openRequest(id: String)=run { focusedReceipt=repository.communityRead("receipt",mapOf("request_id" to id));state.navigate(35) }
    fun closeReceipt() { focusedReceipt=null }
    fun showHistory() { focusedReceipt=null;outcome=null;refreshHistory() }
    fun refreshOutcome()=run {
        val current=outcome ?: throw LiveFailure("review_recovery_required")
        val view=preview ?: throw LiveFailure("review_recovery_required")
        val source=snapshot?.source ?: throw LiveFailure("review_recovery_required")
        val key=NativeProtocol.text(current["operation_key"])
        val response=repository.communityRead("operation",mapOf("operation_key" to key));validateOutcome(response,view,source,key)
        outcome=response;repository.remember("last_outcome",response)
    }
    fun block(id: String,value: Boolean)=run {
        OriginalMedia.prune(context,true);shareIntent=null
        repository.mutate("safety.block",emptyMap(),"safety",path="/me/blocks/$id",method=if(value)"POST" else "DELETE")
        blocked.clear();blocked.addAll(NativeProtocol.rows(repository.get("/me/blocks")["items"]));snapshot=null;preview=null;repository.remember("review",null);refreshData()
    }
    fun report(reason: String)=run {
        val photo=selectedPhoto ?: throw LiveFailure("photo_required")
        val notMe=reason=="This isn’t me" && photo.matchId!=null
        repository.mutate(if(notMe)"safety.not_me" else "safety.report",mapOf("reason" to reason)+(if(notMe)emptyMap() else mapOf("asset_id" to photo.id)),
            "safety",path=if(notMe)"/matches/${photo.matchId}/not-me" else "/safety/reports")
        refreshData();state.info(context.getString(R.string.controller_94cbfcc0d1d3),context.getString(R.string.controller_41f9a4941e80));state.navigate(13)
    }
    fun decide(decision: String) {
        val receipt=focusedReceipt ?: return;val id=NativeProtocol.id(receipt["id"])
        run {
            repository.mutate("request.decide",mapOf("request_id" to id,"decision" to decision),NativeProtocol.mediaSource(receipt["source"]))
            focusedReceipt=repository.communityRead("receipt",mapOf("request_id" to id));refreshData()
        }
    }
    fun savePhotoPreferences()=run {
        if(matchingConsent)requireAudience("photo_matching")
        if(processingConsent)requireAudience("photo_processing")
        val policy=NativeProtocol.text(photoPolicy["policy_version"])
        photoPolicy=repository.mutate("photo.preferences",mapOf("receive_matches" to receiveMatches,"photo_matching_consent" to matchingConsent,
            "processing_consent" to processingConsent,"policy_version" to policy),"account",path="/me/photo-preferences")
        refreshData();state.navigate(37)
    }
    fun rename(name: String)=run { val response=repository.mutate("account.profile.update",mapOf("name" to name),"account",path="/me/profile",method="PATCH");me=me+mapOf("name" to response["name"]);state.navigate(37) }
    fun saveExport(id: String,destination: Uri)=run(false) { repository.saveExport(id,destination);privacyCenter=repository.get("/privacy/center");state.info(context.getString(R.string.controller_0a0d775d7d14),context.getString(R.string.controller_eaec755aa61d)) }
    fun refreshPrivacy()=run(false) { privacyCenter=repository.get("/privacy/center") }
    fun requestExport()=run(false) { repository.requestPrivacyExport();privacyCenter=repository.get("/privacy/center");state.info(context.getString(R.string.controller_a50a0663baa7),context.getString(R.string.controller_6834ba087c0b)) }
    var accountDeletion by mutableStateOf<GuestDeletionRecord?>(null);private set
    fun requestDeletion()=run(false) {
        try { accountDeletion=repository.requestAccountDeletion() }
        finally { accountDeletion=repository.accountDeletion;if(accountDeletion!=null) { clearGuestPresentation();state.navigate(44) } }
    }
    private suspend fun checkAccountDeletionInternal() {
        try { accountDeletion=repository.checkAccountDeletion() }
        finally { accountDeletion=repository.accountDeletion;if(accountDeletion?.receipt?.completed==true)clearGuestPresentation() }
    }
    fun checkAccountDeletion()=run(false) { checkAccountDeletionInternal() }
    fun resumeAfterAccountDeletion()=run(false) { me=repository.resumeAfterAccountDeletion();accountDeletion=null;if(registered) { refreshData();state.navigate(13) } else state.navigate(2) }
    fun restartAfterAccountDeletion()=run(false) { repository.restartAfterAccountDeletion();accountDeletion=null;me=repository.bootstrap();state.navigate(2) }
    fun confirmGuestDeletion() {
        if(!canDeleteGuest || busy)return
        state.confirm(context.getString(R.string.controller_c6f0b6f0a522),context.getString(R.string.controller_05c6f53286dc),context.getString(R.string.controller_0e07b0e306d0)) {
            requestGuestDeletion()
        }
    }
    private fun clearGuestPresentation() {
        OriginalMedia.prune(context,true);shareIntent=null;interruptedOriginal=null
        context.contentResolver.persistedUriPermissions.forEach { permission -> runCatching {
            context.contentResolver.releasePersistableUriPermission(permission.uri,android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } }
        clearImages();photos.clear();inbox.clear();picked.clear();selectedUploads.clear();uploadIds.clear()
        uploadBatch=null;uploadStatus="";uploadRecovery=null;caption="";search="";snapshot=null;preview=null;outcome=null;focusedReceipt=null;focusedPerson=null
        faceChallenge=null;captureCount=0;state.selfieCount=0;cameraForUpload=false;cameraUploadId=null;cameraReady=false;me=emptyMap();photoPolicy=emptyMap();audience=null;guardianClaim=null;audienceVisible=false
        matchingConsent=false;processingConsent=false;receiveMatches=false
        sessions.clear();devices.clear();notifications.clear();favorites.clear();privacyCenter=emptyMap();notificationSettings=emptyMap();blocked.clear()
        OriginalMedia.pruneCamera(context,true)
    }
    private suspend fun refreshGuestDeletionInternal() {
        val epoch=uiEpoch
        try { repository.checkGuestDeletion() }
        finally {
            if(epoch==uiEpoch) {
                guestDeletion=repository.guestDeletion
                if(guestDeletion?.receipt!=null)clearGuestPresentation()
            }
        }
    }
    private fun requestGuestDeletion()=run(false) {
        val epoch=uiEpoch
        try { repository.requestGuestDeletion() }
        finally {
            if(epoch==uiEpoch) {
                guestDeletion=repository.guestDeletion
                if(guestDeletion?.receipt!=null)clearGuestPresentation()
                state.navigate(44)
            }
        }
    }
    fun checkGuestDeletion()=run(false) { refreshGuestDeletionInternal() }
    fun resumeGuestSetup()=run(false) {
        try {
            val restored=repository.resumeGuestSetup()
            guestDeletion=null;me=restored;state.navigate(5)
        } finally { guestDeletion=repository.guestDeletion }
    }
    fun startAgainAfterDeletion()=run(false) {
        repository.restartAfterGuestDeletion();clearGuestPresentation();guestDeletion=null
        me=repository.bootstrap();state.navigate(2)
    }
    fun saveNotification(key: String,value: Boolean)=run {
        notificationSettings=repository.mutate("notification.settings",mapOf(key to value),"account",path="/me/notification-settings",method="PATCH")
    }
    fun readNotification(row: WireObject)=run {
        repository.mutate("notification.read",emptyMap(),"account",path="/me/notifications/${NativeProtocol.id(row["id"])}/read")
        notifications.clear();notifications.addAll(NativeProtocol.rows(repository.get("/me/notifications")["items"]))
    }
    fun revoke(row: WireObject,device: Boolean)=run {
        val response=repository.post(if(device)"/auth/device/revoke" else "/auth/session/revoke",mapOf((if(device)"device_id" else "session_id") to NativeProtocol.id(row["id"])))
        if(response["current_session_revoked"]==true)logout(response["clear_device_identity"]==true)
        else {
            sessions.clear();sessions.addAll(NativeProtocol.rows(repository.get("/me/sessions")["items"]))
            devices.clear();devices.addAll(NativeProtocol.rows(repository.get("/me/devices")["items"]))
        }
    }
    fun logout(revokeIdentity: Boolean=false) {
        libraryEpoch++;libraryLoading=false
        persistNavigation();queryJob?.cancel();purchases.clearAccount();BackgroundTransfers.cancel(context);PushConfiguration.setOptedIn(context,false);purchaseVisible=false;interruptedOriginal=null;OriginalMedia.prune(context,true);shareIntent=null;restoredUi=false;galleryPositions.clear();viewerRows.clear();supportRequests.clear();supportSubject="";supportDetails="";outgoing.clear();libraryCursor=null;libraryError=null;search="";
        photoPickerOwnership.clear()
        context.contentResolver.persistedUriPermissions.forEach { permission -> runCatching { context.contentResolver.releasePersistableUriPermission(permission.uri,android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION) } }
        invalidateCameraReview();uiEpoch++;work?.cancel();work=null;busy=true;val owned=repository.cancelFace();clearImages();photos.clear();inbox.clear();picked.clear();selectedUploads.clear();uploadIds.clear()
        snapshot=null;preview=null;outcome=null;focusedReceipt=null;faceChallenge=null;captureCount=0;me=emptyMap();audience=null;guardianClaim=null;audienceVisible=false;started=false;uploadRecovery=null;uploadBatch=null;uploadStatus="";caption=""
        cameraForUpload=false;cameraUploadId=null
        recoveryBackupDisplay=null;recoveryImportVisible=false;recoveryKeyMetadata=null
        sessions.clear();devices.clear();notifications.clear();favorites.clear();privacyCenter=emptyMap();notificationSettings=emptyMap()
        cameraInventoryReady=false;OriginalMedia.pruneCamera(context,true)
        val epoch=uiEpoch
        scope.launch {
            try { repository.logout(revokeIdentity,owned);if(epoch==uiEpoch) { busy=false;state.navigate(if(hasLifecycle)38 else 2);start() } }
            catch(problem: LiveFailure) { if(epoch==uiEpoch) { busy=false;error=problem;faceProfile=repository.faceLifecycle?.metadata;state.navigate(if(hasLifecycle)38 else 48) } }
        }
    }
    fun clearImages() { selectedPhoto=null;mediaGeneration++ }
    fun leaveForReview() { photoPickerOwnership.clear();invalidateCameraReview();uiEpoch++;work?.cancel();busy=false;started=false;foregroundActive=false;repository.invalidateReads();clearImages();me=emptyMap();photos.clear();inbox.clear() }
    fun background(): Unit = synchronized(repository.fence) {
        persistNavigation();queryJob?.cancel()
        val pickerBefore=photoPickerOwnership.opened?.capture?.requestId?.let(::photoPickerContext)
        foregroundActive=false;invalidateCameraReview();uiEpoch++;work?.cancel();busy=false
        if(uploadRecovery?.let { !it.finished && !it.cancelled }==true)runCatching { repository.pausePhotoUploads()?.let(::presentUpload) }
        repository.invalidateReads();mediaGeneration++;cameraReady=false
        photoPickerOwnership.background(pickerBefore,pickerBefore?.capture?.requestId?.let(::photoPickerContext))
        recoveryBackupDisplay=null;recoveryImportVisible=false
        if(repository.enrollment!=null || repository.accountRecovery!=null || hasLifecycle)faceChallenge=null
        if(backgroundUploads && registered && photoPickerOwnership.opened==null)repository.photoUploads()?.let { BackgroundTransfers.schedule(context,it) }
        Unit
    }
    fun foreground() {
        BackgroundTransfers.cancel(context)
        if(BackgroundTransfers.running)repository.invalidateReads()
        maintainTemporaryMedia()
        foregroundActive=true
        if(state.route==44 && weakRegisteredSession && !busy) { if(repository.accountDeletion!=null)checkAccountDeletion() else refreshPrivacy();return }
        if(state.route==46 && weakRegisteredSession && !busy) { refreshOwnSecurity();return }
        if(photoPickerOwnership.opened!=null)return
        if(!hasGuestDeletion && (repository.enrollment!=null || repository.accountRecovery!=null || repository.faceLifecycle?.intent?.capture==true || repository.faceLifecycle?.loginKey!=null || repository.cameraLoginHeld) && state.route==6 && !busy)beginFace()
        else if(hasLifecycle && state.route==38 && !busy)checkFaceProfile()
        else if(identityAuthenticated && !busy)run(false) { requireAudience("face_authentication");refreshData() }
    }
    fun dispose() { photoPickerOwnership.clear();invalidateCameraReview();uiEpoch++;repository.invalidateReads();scope.cancel();purchases.dispose();clearImages() }
}
