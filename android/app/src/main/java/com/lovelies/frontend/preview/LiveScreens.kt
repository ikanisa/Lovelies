package com.lovelies.frontend.preview

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.res.pluralStringResource
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.debounce
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.staggeredgrid.*
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.launch

/** Live screens reuse the screenshot's native controls and palette, with server-owned identity and photos. */
@Composable
fun LiveScreen(state: PreviewState) {
    val live=state.live
    AccountRecoveryDialogs(state)
    PurchaseDialog(state)
    var photoPickerOwner by remember { mutableStateOf<NativePhotoPickerOwner?>(null) }
    var filePickerOwner by remember { mutableStateOf<NativePhotoPickerOwner?>(null) }
    val picker=rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(100)) { uris ->
        val owner=photoPickerOwner;photoPickerOwner=null;live.acceptPickedPhotos(uris,owner)
    }
    val files=rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        val owner=filePickerOwner;filePickerOwner=null;live.acceptPickedPhotos(uris,owner)
    }
    val choose: ()->Unit={
        live.beginPhotoPicker()?.let { owner ->
            photoPickerOwner=owner
            try { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }
            catch(problem: Exception) { photoPickerOwner=null;live.cancelPhotoPicker(owner);state.info("Photo picker unavailable","Choose From Files to select photos on this device.") }
        }
    }
    val chooseFiles: ()->Unit={
        live.beginPhotoPicker()?.let { owner ->
            filePickerOwner=owner
            try { files.launch(arrayOf("image/*")) }
            catch(problem: Exception) { filePickerOwner=null;live.cancelPhotoPicker(owner);state.info("File picker unavailable","Choose From This Device to select photos.") }
        }
    }
    when(state.route) {
        1,2 -> OnboardingScreen(state)
        3,4,5 -> LiveWelcome(state,choose)
        6,7 -> LiveCapture(state)
        8 -> LiveProgress(state,"Setting up your face", "Your registered face authenticates your account.","processing-hero.png",live.busy)
        9 -> LiveSetupComplete(state)
        in 10..16 -> LiveGallery(state)
        17,18 -> LiveActivity(state)
        19 -> LiveUploadEntry(state)
        20 -> LiveUploadSources(state,choose,chooseFiles)
        21,22 -> LiveUploadReview(state,choose)
        23 -> LiveUploadProgress(state)
        24 -> LiveUploadComplete(state)
        25 -> LiveMatchSummary(state)
        26,29,30 -> LiveSelectPhotos(state)
        27 -> LivePhotoPeople(state)
        28 -> LivePersonPhotos(state)
        31,32 -> LiveSelectPeople(state)
        33 -> LiveFinalReview(state)
        34 -> LiveProgress(state,"Sharing your photos","Saving your reviewed selections…","sharing-hero.png",live.busy)
        35 -> LiveReceipts(state)
        36 -> LiveReport(state)
        in 37..46 -> LiveAccount(state,choose)
        47 -> LiveEmpty(state)
        48 -> LiveError(state)
    }
}

@Composable
private fun LivePage(state: PreviewState,title: String,back: Boolean=true,bottom: Int?=null,
    content: @Composable ColumnScope.()->Unit) {
    Column(Modifier.fillMaxSize().padding(horizontal=18.dp)) {
        ScreenHeader(title,onBack=if(back || state.route !in setOf(10,13,37))({state.back()}) else null,right={Overflow(state)})
        Column(Modifier.weight(1f),content=content)
        if(bottom!=null)BottomBar(state,bottom,Modifier.padding(top=8.dp,bottom=8.dp))
    }
}

@Composable
private fun AccountRecoveryDialogs(state: PreviewState) {
    val live=state.live;val context=LocalContext.current
    if(live.recoveryImportVisible) {
        var backup by remember { mutableStateOf("") }
        AlertDialog(onDismissRequest={backup="";live.dismissAccountRecoveryImport()},backgroundColor=Panel,shape=RoundedCornerShape(24.dp),
            properties=androidx.compose.ui.window.DialogProperties(securePolicy=androidx.compose.ui.window.SecureFlagPolicy.SecureOn),
            title={Text(stringResource(R.string.copy_recover_my_account_8b0b03be),color=Color.White)},
            text={Column {
                BodyText(stringResource(R.string.copy_enter_your_saved_private_recovery_b_48653b34),size=13)
                OutlinedTextField(value=backup,onValueChange={backup=it.take(100)},label={Text(stringResource(R.string.copy_private_recovery_backup_0573f471))},singleLine=true,
                    visualTransformation=androidx.compose.ui.text.input.PasswordVisualTransformation(),
                    keyboardOptions=androidx.compose.foundation.text.KeyboardOptions(autoCorrectEnabled=false,keyboardType=androidx.compose.ui.text.input.KeyboardType.Ascii),
                    modifier=Modifier.fillMaxWidth().padding(top=16.dp),colors=TextFieldDefaults.outlinedTextFieldColors(textColor=Color.White,focusedBorderColor=Pink,unfocusedBorderColor=Hairline,cursorColor=Pink))
            }},confirmButton={TextButton(enabled=backup.isNotBlank() && !live.busy,onClick={val entered=backup;backup="";live.recoverAccount(entered)}) { Text(stringResource(R.string.copy_continue_2e026239),color=Pink) }},
            dismissButton={TextButton(onClick={backup="";live.dismissAccountRecoveryImport()}) { Text(stringResource(R.string.copy_cancel_77dfd213),color=Muted) }})
    }
    live.recoveryBackupDisplay?.let { backup ->
        AlertDialog(onDismissRequest=live::hideRecoveryBackup,backgroundColor=Panel,shape=RoundedCornerShape(24.dp),
            properties=androidx.compose.ui.window.DialogProperties(securePolicy=androidx.compose.ui.window.SecureFlagPolicy.SecureOn),
            title={Text(stringResource(R.string.copy_save_your_recovery_backup_e8ed0c24),color=Color.White)},text={Column {
                BodyText(stringResource(R.string.copy_keep_this_backup_somewhere_you_can__e41bab8d),size=13)
                androidx.compose.foundation.text.selection.SelectionContainer { Text(backup,color=Color.White,fontSize=13.sp,modifier=Modifier.padding(top=16.dp)) }
            }},confirmButton={TextButton(onClick={
                val manager=context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                val clip=android.content.ClipData.newPlainText("Private recovery backup",backup)
                clip.description.extras=android.os.PersistableBundle().apply { putBoolean("android.content.extra.IS_SENSITIVE",true) }
                manager.setPrimaryClip(clip)
            }) { Text(stringResource(R.string.copy_copy_backup_c76efb2a),color=Pink) }},dismissButton={TextButton(onClick=live::hideRecoveryBackup) { Text(stringResource(R.string.copy_done_e9b450d1),color=Muted) }})
    }
}

@Composable
private fun LiveWelcome(state: PreviewState,choose: ()->Unit) {
    val live=state.live
    LivePage(state,if(state.route==5)"Let’s get you set up" else "Your photos") {
        Spacer(Modifier.weight(1f))
        SourceHero("photo-heart.png",.40f,1f)
        Text(stringResource(R.string.copy_your_photos_your_choice_5f10a2e7),color=Color.White,fontSize=25.sp,lineHeight=32.sp,textAlign=TextAlign.Center,
            modifier=Modifier.fillMaxWidth().padding(top=24.dp,bottom=16.dp))
        BodyText(stringResource(R.string.copy_choose_photos_when_you_want_to_uplo_c1b898aa),Modifier.padding(horizontal=12.dp))
        Spacer(Modifier.weight(1f))
        if(state.route==4) {
            PinkButton(stringResource(R.string.copy_continue_2e026239),enabled=!live.busy) { state.navigate(5) }
            OutlineButton(stringResource(R.string.copy_choose_photos_0df966e4),Modifier.padding(top=12.dp),icon=Glyph.PHOTO,onClick=choose)
        } else {
            BodyText(stringResource(R.string.copy_by_continuing_you_consent_to_use_yo_7c404e1b),Modifier.padding(bottom=18.dp),size=12)
            PinkButton(if(live.repository.identity!=null)"Sign in with my face" else "Set Up My Face",enabled=!live.busy) { state.navigate(6) }
        }
        if(!live.hasGuestDeletion)TextButton(onClick={if(live.hasAccountRecovery)state.navigate(6) else live.showAccountRecoveryImport()},enabled=!live.busy,
            modifier=Modifier.align(Alignment.CenterHorizontally)) { Text(if(live.hasAccountRecovery)"Continue account recovery" else "Recover my account",color=Pink) }
        if(live.canDeleteGuest)OutlineButton(stringResource(R.string.copy_delete_guest_account_8e0f6d76),Modifier.padding(top=12.dp),enabled=!live.busy) { live.confirmGuestDeletion() }
        Spacer(Modifier.height(20.dp))
    }
}

@Composable
private fun LiveCapture(state: PreviewState) {
    val live=state.live
    val captureContext=live.captureContext()
    var shutter by remember(captureContext) { mutableStateOf<(() -> Unit)?>(null) }
    val poses=(live.faceChallenge?.get("poses") as? List<*>)?.mapNotNull { it as? String } ?: emptyList()
    val pose=poses.getOrNull(live.captureCount) ?: "front"
    val ready=live.cameraForUpload || live.faceChallenge!=null
    Column(Modifier.fillMaxSize().padding(horizontal=18.dp),horizontalAlignment=Alignment.CenterHorizontally) {
        ScreenHeader(if(live.cameraForUpload)"Take a photo" else if(live.faceChallenge?.get("purpose")=="login")"Welcome back"
            else when(live.repository.faceLifecycle?.intent?.action) { "replace"->"Replace Your Face Profile";"restore_authentication"->"Restore Face Sign-In";"enroll"->"Set Up Your Face";
                else->if(live.hasAccountRecovery)"Recover your account" else "Set Up Your Face" },onBack={live.cancelFace()})
        Text(if(live.cameraForUpload)"Capture a memory" else when(pose){"left"->"Turn slightly to your left";"right"->"Turn slightly to your right";else->"Look straight at the camera"},
            color=Color.White,fontSize=18.sp,modifier=Modifier.padding(top=14.dp,bottom=10.dp))
        BodyText(if(live.cameraForUpload)"Review this photo before uploading." else "Keep your face inside the frame.",size=13)
        Box(Modifier.weight(1f).padding(top=22.dp,bottom=20.dp).fillMaxWidth().clip(RoundedCornerShape(24.dp)).background(Panel)) {
            if(live.reviewingCapture && live.reviewPreview!=null)androidx.compose.foundation.Image(live.reviewPreview!!.asImageBitmap(),
                contentDescription="Unsent ${if(live.cameraForUpload)"photo" else "selfie"} preview",modifier=Modifier.fillMaxSize(),contentScale=androidx.compose.ui.layout.ContentScale.Fit)
            else if(ready && captureContext!=null)NativeCameraPane(Modifier.fillMaxSize(),front=!live.cameraForUpload,active=live.foregroundActive,
                captureContext=captureContext,onShutter=live::shutterContext,
                onReady={owner,action->if(owner==live.captureContext()) { shutter=action;live.cameraReady=action!=null }},
                onPhoto=live::capture,onError=live::cameraError,onStatus=live::cameraState)
            else Box(Modifier.fillMaxSize(),contentAlignment=Alignment.Center) { CircularProgressIndicator(color=Pink,modifier=Modifier.semantics { contentDescription="Preparing camera" }) }
            if(ready && !live.cameraForUpload && !live.reviewingCapture)Box(Modifier.align(Alignment.Center).fillMaxWidth(.78f).fillMaxHeight(.66f)
                .border(2.dp,Pink,RoundedCornerShape(55.dp)))
            if(live.busy)Box(Modifier.fillMaxSize().background(Ink.copy(alpha=.62f)),contentAlignment=Alignment.Center) { CircularProgressIndicator(color=Pink,modifier=Modifier.semantics { contentDescription="Preparing camera" }) }
        }
        live.error?.let { BodyText(readableError(it.code),Modifier.padding(bottom=12.dp),size=13) }
        if(live.reviewingCapture) {
            BodyText(if(live.cameraForUpload)"Review your photo." else "Review this selfie. Face quality will be checked after you use it.",Modifier.padding(bottom=12.dp),size=13)
            PinkButton("Use this ${if(live.cameraForUpload)"photo" else "selfie"}",enabled=!live.busy,onClick=live::approveCapture)
            OutlineButton(stringResource(R.string.copy_retake_16457335),Modifier.padding(top=10.dp,bottom=12.dp),enabled=!live.busy,onClick=live::retakeCapture)
        }
        if(live.error?.code in setOf("camera_image_invalid","capture_too_large","camera_review_expired","capture_context_changed") && ready)
            OutlineButton(stringResource(R.string.copy_retake_16457335),Modifier.padding(bottom=12.dp),enabled=!live.busy,onClick=live::retakeCapture)
        if(live.error!=null && !ready)OutlineButton(if(live.error?.code in setOf("enrollment_in_flight","account_recovery_in_flight","face_profile_in_flight","face_login_in_flight"))"Check setup status" else if(isFaceCaptureRejection(live.error?.code.orEmpty()))"Retake selfies" else "Try again") { live.beginFace() }
        if(live.hasAccountRecovery && live.error!=null)TextButton(onClick={
            state.confirm("Use another recovery key?","Your previous request will stay saved on this device. This does not cancel it on the server.","Use another key") { live.showAccountRecoveryImport(true) }
        },enabled=!live.busy) { Text(stringResource(R.string.copy_use_another_recovery_key_99e60eca),color=Pink) }
        if(!live.cameraForUpload)Row(horizontalArrangement=Arrangement.spacedBy(12.dp),modifier=Modifier.padding(bottom=15.dp)) {
            repeat(if(poses.isEmpty())3 else poses.size) { index -> Box(Modifier.size(9.dp).clip(CircleShape).background(if(index<live.captureCount)Pink else Hairline)) }
        }
        if(!live.reviewingCapture)Box(Modifier.padding(bottom=18.dp).size(72.dp).border(3.dp,Color.White,CircleShape).padding(7.dp).clip(CircleShape)
            .background(if(shutter!=null && !live.busy)Color.White else Hairline)
            .clickable(enabled=shutter!=null && !live.busy,role=Role.Button){shutter?.invoke()}
            .semantics { contentDescription="Capture ${if(live.cameraForUpload)"photo" else "$pose selfie"}" })
        TextButton(onClick={live.cancelFace()}) { Text(stringResource(R.string.copy_cancel_77dfd213),color=Muted) }
    }
}

@Composable
private fun LiveSetupComplete(state: PreviewState) {
    LivePage(state,"",back=false) {
        Spacer(Modifier.weight(1f));SourceHero("setup-hero.png",.733f,1f)
        Text(stringResource(R.string.copy_you_re_all_set_063aa1b0),color=Color.White,fontSize=26.sp,modifier=Modifier.align(Alignment.CenterHorizontally).padding(top=16.dp))
        BodyText(stringResource(R.string.copy_your_face_is_registered_and_you_re__deb732c4),Modifier.fillMaxWidth().padding(top=12.dp))
        Spacer(Modifier.weight(1f))
        PinkButton(stringResource(R.string.copy_let_s_go_09b2882d),enabled=state.live.registered) { state.navigate(if(state.live.photos.isEmpty())47 else 10) }
        OutlineButton(stringResource(R.string.copy_set_photo_preferences_58dc8238),Modifier.padding(top=12.dp)) { state.navigate(40) };Spacer(Modifier.height(18.dp))
    }
}

@Composable
private fun LiveUploadProgress(state: PreviewState) {
    val live=state.live;val record=live.uploadRecovery
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),horizontalAlignment=Alignment.CenterHorizontally) {
        Spacer(Modifier.height(56.dp));SourceHero("upload-hero.png",.68f,184f/101f)
        Text(when { record?.cancelled==true->"Uploads cancelled";record?.finished==true->"Upload Complete";live.busy->"Uploading your photos";else->"Upload paused" },
            color=Color.White,fontSize=23.sp,modifier=Modifier.padding(top=24.dp,bottom=12.dp))
        BodyText(live.error?.let { readableError(it.code) } ?: live.uploadStatus)
        if(record!=null && !record.finished && !record.cancelled)LiveToggle("Continue with background scheduling","Android may defer work. Each accepted chunk remains saved.",live.backgroundUploads) { live.configureBackgroundUploads(!live.backgroundUploads) }
        if(record!=null && record.files.all { it.sha256!=null } && record.bytesTotal>0) {
            LinearProgressIndicator(progress=(record.bytesAcknowledged.toDouble()/record.bytesTotal).toFloat(),color=Pink,backgroundColor=Hairline,
                modifier=Modifier.fillMaxWidth().padding(top=24.dp).semantics { contentDescription="${record.bytesAcknowledged} of ${record.bytesTotal} photo bytes saved" })
            BodyText("${(record.bytesAcknowledged*100/record.bytesTotal)}% saved",Modifier.padding(top=10.dp),size=13)
        } else if(live.busy)CircularProgressIndicator(color=Pink,modifier=Modifier.padding(top=24.dp).size(28.dp))
        Spacer(Modifier.height(28.dp))
        if(record?.finished==true)PinkButton(stringResource(R.string.copy_view_matches_731444f2),enabled=!live.busy) { live.reviewPhotos(batch=record.batch) }
        else if(record?.cancelled!=true) {
            if(live.busy)OutlineButton(stringResource(R.string.copy_pause_781961bc),onClick=live::pauseUploads)
            else PinkButton(if(record?.cancelling==true)"Finish cancellation" else if(live.error!=null || record?.error!=null)"Retry" else "Resume",enabled=live.registered) { live.resumeUploads(retryFailed=true) }
            if(record?.cancelling!=true)OutlineButton(stringResource(R.string.copy_cancel_remaining_uploads_8e597ca8),Modifier.padding(top=12.dp),onClick=live::cancelUploads)
        }
        OutlineButton(stringResource(R.string.copy_back_to_photos_b080279d),Modifier.padding(top=12.dp),enabled=!live.busy) { state.navigate(13) }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun LiveProgress(state: PreviewState,title: String,message: String,art: String,busy: Boolean) {
    Column(Modifier.fillMaxSize().padding(horizontal=24.dp),horizontalAlignment=Alignment.CenterHorizontally) {
        ScreenHeader(title,onBack=state::back)
        Spacer(Modifier.weight(1f))
        SourceHero(art,.68f,if(art=="upload-hero.png")184f/101f else if(art=="sharing-hero.png")168f/117f else 154f/163f)
        Text(title,color=Color.White,fontSize=23.sp,modifier=Modifier.padding(top=24.dp,bottom=12.dp))
        BodyText(message,Modifier.semantics { liveRegion=LiveRegionMode.Polite })
        if(busy)CircularProgressIndicator(color=Pink,modifier=Modifier.padding(top=24.dp).size(28.dp).semantics { contentDescription=title })
        Spacer(Modifier.weight(1f))
    }
}

@Composable
private fun LiveGallery(state: PreviewState) {
    val live=state.live
    if(state.route==12) { LiveViewer(state);return }
    if(state.route==16) {
        LivePage(state,"Filters") {
            BodyText(stringResource(R.string.copy_photo_source_dfe0371b),center=false,modifier=Modifier.padding(vertical=18.dp))
            Segments(listOf("All","Contributed","Received"),state.category,onSelect=live::updateSource)
            BodyText(stringResource(R.string.copy_newest_first_search_and_photo_sourc_8b7617ee),Modifier.padding(top=16.dp),center=false,size=13)
            Spacer(Modifier.weight(1f));PinkButton(stringResource(R.string.copy_apply_filters_6b2a78a8)) { state.navigate(13) };Spacer(Modifier.height(18.dp))
        };return
    }
    if(state.route==11 && state.category!="Received") {
        LivePage(state,"Matches",back=false,bottom=11) {
            LiveMatchesNavigation(state,received=false)
            BodyText(stringResource(R.string.copy_review_matched_people_before_sharin_c105f158),Modifier.padding(vertical=14.dp),center=false)
            if(live.snapshot!=null) {
                val snap=live.snapshot!!
                SectionTitle(stringResource(R.string.photo_summary,personCount(snap.people.size),photoCount(snap.photos.size)))
                LivePhotoGrid(live,snap.photos,Modifier.weight(1f),onClick={live.selectedPhoto=it;state.navigate(27)})
                PinkButton(stringResource(R.string.copy_select_photos_to_share_52f9b7e4),enabled=snap.pairs.isNotEmpty()) { state.navigate(29) }
            } else {
                Spacer(Modifier.weight(1f));SourceHero("matches-hero.png",.531f,127f/106f);Spacer(Modifier.weight(1f))
                PinkButton(stringResource(R.string.copy_review_my_photos_23b36063),enabled=!live.busy) {
                    live.reviewPhotos()
                }
            }
        };return
    }
    val received=state.route==11
    val title=when { received->"Matches";state.route==10->"Your memories";state.route==14->"Favorites";state.route==15->"Search";else->"All Photos" }
    val rows=live.photos.filter { photo -> state.route!=14 || photo.id in live.favorites }
    LivePage(state,title,back=state.route==15,bottom=when { received->11;state.route==10->10;state.route==14->14;else->13 }) {
        if(received) {
            LiveMatchesNavigation(state,received=true)
            BodyText("Photos you can access as a recipient.",Modifier.padding(top=12.dp),center=false,size=13)
        }
        SearchInput(live.search,stringResource(R.string.search_photos),Modifier.padding(top=8.dp,bottom=12.dp),onValue={live.updateSearch(it);if(state.route!=15)state.navigate(15)},onFilter={state.navigate(16)})
        Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween,verticalAlignment=Alignment.CenterVertically) {
            Text(if(live.libraryCursor!=null)stringResource(R.string.loaded_photo_count,photoCount(rows.size)) else photoCount(rows.size),color=Muted,fontSize=13.sp)
            TextButton(onClick={state.navigate(19)}) { Text(stringResource(R.string.add_photos),color=Pink,fontSize=13.sp) }
        }
        if(rows.isEmpty())Box(Modifier.weight(1f).fillMaxWidth(),contentAlignment=Alignment.Center) { BodyText(if(live.libraryLoading)"Searching…" else if(state.route==14)"Your favorite photos will appear here. Load more to find favorites outside this page." else "No photos match this search.") }
        else LivePhotoGrid(live,rows,Modifier.weight(1f),columns=if(state.route==10)4 else 3,route=state.route,onClick={live.openPhoto(it,rows)})
        live.libraryError?.let { BodyText(readableError(it.code),Modifier.semantics { liveRegion=LiveRegionMode.Polite },size=13) }
        if(live.libraryCursor!=null)OutlineButton(if(live.libraryLoading)"Loading…" else "Load More Photos",enabled=!live.libraryLoading && !live.busy) { live.loadMorePhotos() }
        else if(live.libraryLoading)LinearProgressIndicator(color=Pink,modifier=Modifier.fillMaxWidth())
    }
}

@Composable
private fun LiveMatchesNavigation(state: PreviewState,received: Boolean) {
    Segments(listOf("Received","To review"),if(received)"Received" else "To review") { selected ->
        if(selected=="Received" && !received) {
            if(state.category!="Received")state.live.updateSource("Received")
            state.navigate(11)
        } else if(selected=="To review" && received) {
            state.live.updateSource("Contributed")
            state.navigate(11)
        }
    }
}

@Composable
private fun LiveViewer(state: PreviewState) {
    val live=state.live
    val rows=live.viewerRows.toList().ifEmpty { listOfNotNull(live.selectedPhoto) }
    if(rows.isEmpty()) { LivePage(state,"Photo") { BodyText(stringResource(R.string.copy_this_photo_is_unavailable_return_to_9a6755dc));OutlineButton(stringResource(R.string.copy_back_to_photos_b080279d)) { state.navigate(13) } };return }
    val pager=rememberPagerState(initialPage=rows.indexOfFirst { it.id==live.selectedPhoto?.id }.coerceAtLeast(0),pageCount={rows.size})
    var chrome by remember { mutableStateOf(true) }
    var zoomed by remember { mutableStateOf(false) }
    val context=LocalContext.current
    val savePermission=rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted->
        if(granted)live.selectedPhoto?.let { live.original(it) }
        else state.info("Allow photo saving","Open Android Settings and allow storage access to save originals on this Android version.")
    }
    LaunchedEffect(live.shareIntent) { live.shareIntent?.let { intent->
        try { context.startActivity(android.content.Intent.createChooser(intent,"Share photo"));live.clearShareIntent() }
        catch(_: android.content.ActivityNotFoundException) { live.clearShareIntent();state.info("Share unavailable","No installed app can share this photo.") }
    } }
    val scope=rememberCoroutineScope()
    LaunchedEffect(pager.settledPage) {
        live.selectedPhoto=rows.getOrNull(pager.settledPage);live.persistNavigation();zoomed=false
    }
    val photo=rows.getOrNull(pager.currentPage) ?: rows.first()
    Column(Modifier.fillMaxSize()) {
        if(chrome)ScreenHeader(photo.title,onBack=state::back,right={Overflow(state)})
        HorizontalPager(state=pager,userScrollEnabled=!zoomed,modifier=Modifier.fillMaxWidth().weight(1f)) { page ->
            var scale by remember(rows[page].id) { mutableFloatStateOf(1f) }
            var pan by remember(rows[page].id) { mutableStateOf(Offset.Zero) }
            var bounds by remember { mutableStateOf(IntSize.Zero) }
            val zoomLabel=stringResource(if(scale>1f)R.string.reset_zoom else R.string.zoom_photo)
            val controlsLabel=stringResource(if(chrome)R.string.hide_photo_controls else R.string.show_photo_controls)
            val pageDescription=stringResource(R.string.photo_of_total,page+1,rows.size)
            val transform=rememberTransformableState { zoom,offset,_ ->
                scale=(scale*zoom).coerceIn(1f,5f)
                pan=if(scale<=1f)Offset.Zero else Offset((pan.x+offset.x).coerceIn(-bounds.width*(scale-1)/2,bounds.width*(scale-1)/2),(pan.y+offset.y).coerceIn(-bounds.height*(scale-1)/2,bounds.height*(scale-1)/2))
                if(page==pager.currentPage)zoomed=scale>1.01f
            }
            Box(Modifier.fillMaxSize().clipToBounds().onSizeChanged { bounds=it }.semantics {
                contentDescription=rows[page].title;stateDescription=pageDescription
                customActions=listOf(
                    CustomAccessibilityAction(zoomLabel) { scale=if(scale>1f)1f else 2f;pan=Offset.Zero;zoomed=scale>1f;true },
                    CustomAccessibilityAction(controlsLabel) { chrome=!chrome;true })
            }
                .pointerInput(rows[page].id) { detectTapGestures(onTap={chrome=!chrome},onDoubleTap={scale=if(scale>1)1f else 2f;pan=Offset.Zero;zoomed=scale>1}) }
                .transformable(transform,canPan={scale>1f})) {
                LivePhotoImage(live,rows[page],Modifier.fillMaxSize().graphicsLayer { scaleX=scale;scaleY=scale;translationX=pan.x;translationY=pan.y },ContentScale.Fit)
            }
        }
        if(chrome) {
            Row(Modifier.fillMaxWidth().padding(vertical=8.dp),horizontalArrangement=Arrangement.SpaceEvenly,verticalAlignment=Alignment.CenterVertically) {
                TextButton(enabled=pager.currentPage>0,onClick={scope.launch { pager.scrollToPage(pager.currentPage-1) }}) { Text(stringResource(R.string.previous),color=if(pager.currentPage>0)Pink else Muted) }
                Text("${pager.currentPage+1} / ${rows.size}",color=Muted)
                TextButton(enabled=pager.currentPage<rows.lastIndex,onClick={scope.launch { pager.scrollToPage(pager.currentPage+1) }}) { Text(stringResource(R.string.next),color=if(pager.currentPage<rows.lastIndex)Pink else Muted) }
            }
            Row(Modifier.fillMaxWidth().padding(vertical=12.dp),horizontalArrangement=Arrangement.SpaceEvenly) {
                IconAction(Glyph.HEART,if(photo.id in live.favorites)"Remove favorite" else "Add favorite",color=if(photo.id in live.favorites)Pink else Color.White) { live.toggleFavorite(photo.id) }
                if(photo.source=="contributions")IconAction(Glyph.PEOPLE,"Matched people") { live.selectedPhotoMatches() }
                IconAction(Glyph.HELP,"Report") { state.navigate(36) }
            }
            if(photo.source=="contributions")PinkButton(stringResource(R.string.copy_review_matched_people_bda254b4),enabled=!live.busy) { live.selectedPhotoMatches() }
            Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceEvenly) {
                TextButton(enabled=!live.busy,onClick={if(OriginalMedia.hasSavePermission(context))live.original(photo) else savePermission.launch(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)}) { Text(stringResource(R.string.save_original),color=Pink) }
                TextButton(enabled=!live.busy,onClick={live.original(photo,true)}) { Text(stringResource(R.string.share_original),color=Pink) }
            }
            if(live.mediaStatus.isNotBlank())BodyText(live.mediaStatus,Modifier.padding(horizontal=18.dp).semantics { liveRegion=LiveRegionMode.Polite },size=12)
            Spacer(Modifier.height(14.dp))
        } else TextButton(onClick={chrome=true},modifier=Modifier.align(Alignment.CenterHorizontally)) { Text(stringResource(R.string.show_controls),color=Pink) }
    }
}

@Composable
private fun LiveActivity(state: PreviewState) {
    val live=state.live;val isNotification=state.route==18
    LivePage(state,if(isNotification)"Notifications" else "Activity",bottom=10) {
        Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween) {
            TextButton(onClick={state.navigate(17)}) { Text("Requests (${live.inbox.size})",color=if(!isNotification)Pink else Muted) }
            TextButton(onClick={state.navigate(18)}) { Text(stringResource(R.string.copy_notifications_753a22b2),color=if(isNotification)Pink else Muted) }
        }
        if(isNotification)LazyColumn(verticalArrangement=Arrangement.spacedBy(9.dp)) {
            items(live.notifications,key={it["id"] as String}) { row -> SettingRow(row["title"] as? String ?: "Notification",subtitle=row["kind"] as? String,
                icon=Glyph.BELL,trailing=if(row["read_at"]!=null)"Read" else "New") { live.readNotification(row) } }
        } else if(live.inbox.isEmpty())Box(Modifier.fillMaxSize(),contentAlignment=Alignment.Center) { BodyText(stringResource(R.string.copy_photo_requests_will_appear_here_375f2958)) }
        else LazyColumn(verticalArrangement=Arrangement.spacedBy(9.dp)) {
            items(live.inbox,key={it["id"] as String}) { row ->
                val person=row["person"] as? Map<*,*>;val count=(row["photo_count"] as? Number)?.toInt() ?: 0
                SettingRow(person?.get("name") as? String ?: "Photo request",subtitle=stringResource(R.string.photo_status,photoCount(count),receiptLabel(row["status"] as? String)),icon=Glyph.PEOPLE) { live.openReceipt(row) }
            }
        }
    }
}

@Composable
private fun LiveUploadEntry(state: PreviewState) {
    LivePage(state,"Add Photos") {
        Spacer(Modifier.weight(1f));SourceHero("photo-heart.png",.45f,1f)
        Text(stringResource(R.string.copy_bring_your_memories_to_lovelies_40789f6a),color=Color.White,fontSize=24.sp,lineHeight=31.sp,textAlign=TextAlign.Center,modifier=Modifier.fillMaxWidth().padding(vertical=20.dp))
        BodyText(stringResource(R.string.copy_choose_photos_review_matched_people_bc56958c))
        Spacer(Modifier.weight(1f))
        PinkButton(stringResource(R.string.copy_choose_source_8bc9b333)) { state.navigate(20) }
        Spacer(Modifier.height(22.dp))
    }
}

@Composable
private fun LiveUploadSources(state: PreviewState,choose: ()->Unit,files: ()->Unit) {
    Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
        ScreenHeader(stringResource(R.string.copy_choose_source_8bc9b333), onBack = state::back, leading = Glyph.CLOSE)
        UploadSourceList(Modifier.weight(1f)) { source ->
            when(source) {
                UploadSourceChoice.DEVICE, UploadSourceChoice.ALBUMS -> choose()
                UploadSourceChoice.FILES -> files()
                UploadSourceChoice.CAMERA -> state.live.cameraUpload()
                UploadSourceChoice.GOOGLE_PHOTOS -> state.confirm("Google Photos",
                    "In the Android photo picker, choose Google Photos if it is available as your cloud media provider. You can change the cloud provider in the picker's settings.",
                    "Open photos", choose)
                UploadSourceChoice.GOOGLE_DRIVE, UploadSourceChoice.DROPBOX, UploadSourceChoice.ONEDRIVE ->
                    state.confirm(source.title,
                        "In the Android file picker, open Browse and choose ${source.title}. Its app must be installed, signed in, and available as a file provider. Only the photos you choose are added to Lovelies.",
                        "Open files", files)
            }
        }
    }
}

@Composable
private fun LiveUploadReview(state: PreviewState,choose: ()->Unit) {
    val live=state.live
    LivePage(state,if(state.route==22)"Review Upload" else "Select Photos") {
        SectionTitle("${live.selectedUploads.size} selected",trailing="Add more",onTrailing=choose)
        LazyVerticalStaggeredGrid(columns=StaggeredGridCells.Fixed(3),modifier=Modifier.weight(1f),horizontalArrangement=Arrangement.spacedBy(6.dp),verticalItemSpacing=6.dp) {
            items(live.picked,key={it.toString()}) { uri ->
                Box(Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(10.dp))
                    .toggleable(uri in live.selectedUploads,role=Role.Checkbox,onValueChange={live.toggleUpload(uri)})
                    .semantics { contentDescription="Upload photo${if(uri in live.selectedUploads)", selected" else ", not selected"}" }) {
                    LocalPhotoImage(uri,Modifier.fillMaxSize(),live.foregroundActive);SelectionMark(uri in live.selectedUploads,Modifier.align(Alignment.TopEnd).padding(6.dp))
                }
            }
        }
        if(state.route==22) {
            OutlinedTextField(value=live.caption,onValueChange=live::uploadCaption,label={Text(stringResource(R.string.copy_photo_title_optional_029237d2))},modifier=Modifier.fillMaxWidth().padding(vertical=12.dp),
                colors=TextFieldDefaults.outlinedTextFieldColors(textColor=Color.White,focusedBorderColor=Pink,unfocusedBorderColor=Hairline,cursorColor=Pink))
            if(!live.processingConsent)SettingRow(stringResource(R.string.copy_enable_photo_processing_5ba32687),subtitle="Save this choice before uploading",icon=Glyph.SHIELD) { state.navigate(40) }
            PinkButton(stringResource(R.string.copy_upload_photo_count,photoCount(live.selectedUploads.size)),enabled=live.selectedUploads.isNotEmpty() && live.processingConsent && !live.busy) { live.upload() }
        } else PinkButton(stringResource(R.string.copy_continue_2e026239),enabled=live.selectedUploads.isNotEmpty()) { state.navigate(22) }
        Spacer(Modifier.height(18.dp))
    }
}

@Composable
private fun LiveUploadComplete(state: PreviewState) {
    val live=state.live
    LivePage(state,"Upload Complete",back=false) {
        Spacer(Modifier.weight(1f));SourceHero("upload-hero.png",.716f,184f/101f)
        Text(stringResource(R.string.copy_photos_uploaded_40ce29e6),color=Color.White,fontSize=25.sp,modifier=Modifier.align(Alignment.CenterHorizontally).padding(top=25.dp))
        BodyText(stringResource(R.string.photos_processed,photoCount(live.uploadIds.size)),Modifier.padding(top=14.dp))
        Spacer(Modifier.weight(1f))
        PinkButton(stringResource(R.string.copy_view_matches_731444f2),enabled=live.uploadIds.isNotEmpty() && !live.busy) { live.reviewPhotos(batch=live.uploadBatch) }
        OutlineButton(stringResource(R.string.copy_back_to_photos_b080279d),Modifier.padding(top=12.dp)) { state.navigate(13) };Spacer(Modifier.height(18.dp))
    }
}

@Composable
private fun LiveMatchSummary(state: PreviewState) {
    val live=state.live;val snap=live.snapshot
    LivePage(state,"Matches Found") {
        Spacer(Modifier.weight(1f));SourceHero("matches-hero.png",.531f,127f/106f)
        Text(stringResource(R.string.copy_your_memories_connected_ea90b2ef),color=Color.White,fontSize=22.sp,textAlign=TextAlign.Center,modifier=Modifier.fillMaxWidth().padding(top=22.dp,bottom=12.dp))
        BodyText(stringResource(R.string.photo_summary,photoCount(snap?.photos?.size),personCount(snap?.people?.size)))
        if(snap?.limited==true)ScopeNotice()
        Spacer(Modifier.weight(1f));PinkButton(stringResource(R.string.copy_select_photos_to_share_52f9b7e4),enabled=snap?.pairs?.isNotEmpty()==true) { state.navigate(29) }
        OutlineButton(stringResource(R.string.copy_explore_matches_4f1186fc),Modifier.padding(top=12.dp)) { state.navigate(26) };Spacer(Modifier.height(18.dp))
    }
}

@Composable
private fun LiveSelectPhotos(state: PreviewState) {
    val live=state.live;val snap=live.snapshot
    LivePage(state,if(state.route==26)"Matched Photos" else "Select Photos to Share") {
        if(snap==null) { BodyText(stringResource(R.string.copy_open_a_photo_review_from_your_galle_7b747039));return@LivePage }
        SectionTitle("Photos (${live.draft.photos.size})",trailing=if(live.draft.photos.isEmpty())"Select all" else "Deselect all",onTrailing={
            live.allPhotos(live.draft.photos.isEmpty())
        })
        if(snap.limited)ScopeNotice()
        LivePhotoGrid(live,snap.photos,Modifier.weight(1f),selections=if(state.route==26)null else live.draft.photos,onClick={
            if(state.route==26) { live.selectedPhoto=it;state.navigate(27) } else live.togglePhoto(it.id)
        })
        PinkButton(stringResource(R.string.copy_continue_2e026239),enabled=live.effective.isNotEmpty() && !live.busy) { state.navigate(31) };Spacer(Modifier.height(18.dp))
    }
}

@Composable
private fun LivePhotoPeople(state: PreviewState) {
    val live=state.live;val snap=live.snapshot
    val photo=live.selectedPhoto?.let { selected -> snap?.photos?.firstOrNull { it.id==selected.id } } ?: snap?.photos?.firstOrNull()
    LivePage(state,"People in this photo") {
        if(snap==null || photo==null) { BodyText(stringResource(R.string.copy_open_a_photo_to_review_its_matches_cd430a24));return@LivePage }
        LivePhotoImage(live,photo,Modifier.fillMaxWidth().height(230.dp).clip(RoundedCornerShape(18.dp)))
        SectionTitle(stringResource(R.string.copy_matched_people_27323e24))
        LazyColumn(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(8.dp)) {
            items(snap.people.filter { person -> snap.pairs.any { it.photo==photo.id && it.person==person.id } },key={it.id}) { person ->
                val selected=live.effective.any { it.photo==photo.id && it.person==person.id }
                LivePersonRow(person,if(person.id !in live.draft.people)"Excluded from all photos" else "This photo only",selected,
                    onCheck={live.togglePair(photo.id,person.id)},onOpen={live.openPerson(person.id)})
            }
        }
        BodyText(stringResource(R.string.copy_uncheck_a_person_to_exclude_this_ph_897f2a03),Modifier.padding(vertical=12.dp),size=12)
        PinkButton(stringResource(R.string.copy_select_photos_to_share_52f9b7e4),enabled=live.effective.isNotEmpty()) { state.navigate(29) };Spacer(Modifier.height(18.dp))
    }
}

@Composable
private fun LivePersonPhotos(state: PreviewState) {
    val live=state.live;val snap=live.snapshot
    val person=snap?.people?.firstOrNull { it.id==live.focusedPerson } ?: snap?.people?.firstOrNull()
    LivePage(state,person?.name ?: "Matched Person") {
        if(snap==null || person==null) { BodyText(stringResource(R.string.copy_select_a_matched_person_first_ba1e7627));return@LivePage }
        InitialAvatar(person.name,Modifier.align(Alignment.CenterHorizontally).padding(vertical=16.dp).size(76.dp))
        val rows=snap.photos.filter { photo -> snap.pairs.any { it.photo==photo.id && it.person==person.id } }
        val selected=live.effective.filter { it.person==person.id }.map { it.photo }.toSet()
        SectionTitle("Photos (${selected.size})")
        LivePhotoGrid(live,rows,Modifier.weight(1f),selections=selected,onClick={live.togglePair(it.id,person.id)})
        BodyText(if(person.id !in live.draft.people)"This person is excluded from all sharing." else "Only checked photos will be included for ${person.name}.",Modifier.padding(vertical=12.dp),size=12)
        OutlineButton(if(person.id in live.draft.people)"Exclude this person globally" else "Include this person globally") { live.togglePerson(person.id) }
        PinkButton(stringResource(R.string.copy_continue_2e026239),Modifier.padding(top=12.dp),enabled=live.effective.isNotEmpty()) { state.navigate(31) };Spacer(Modifier.height(18.dp))
    }
}

@Composable
private fun LiveSelectPeople(state: PreviewState) {
    val live=state.live;val snap=live.snapshot
    LivePage(state,"Select People to Share With") {
        if(snap==null) { BodyText(stringResource(R.string.copy_open_a_photo_review_first_e2f30cd2));return@LivePage }
        SectionTitle("People (${live.draft.people.size})")
        LazyColumn(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(9.dp)) {
            items(snap.people,key={it.id}) { person ->
                val count=live.effective.count { it.person==person.id }
                LivePersonRow(person,stringResource(R.string.photos_in_subset,photoCount(count)),person.id in live.draft.people,
                    onCheck={live.togglePerson(person.id)},onOpen={live.openPerson(person.id)})
            }
        }
        BodyText(stringResource(R.string.copy_excluded_people_receive_none_of_you_6f684f22),Modifier.padding(vertical=12.dp),size=12)
        PinkButton(stringResource(R.string.copy_review_share_023d8493),enabled=live.effective.isNotEmpty() && !live.busy) { live.prepareShare() };Spacer(Modifier.height(18.dp))
    }
}

@Composable
private fun LiveFinalReview(state: PreviewState) {
    val live=state.live;val snap=live.snapshot;val view=live.preview
    LivePage(state,"Review & Share") {
        if(snap==null || view==null) { BodyText(stringResource(R.string.copy_review_your_current_selection_befor_b592a97e));PinkButton(stringResource(R.string.copy_review_selection_04dd6243)) { live.prepareShare() };return@LivePage }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            ReviewHeading("Photos (${view.pairs.map { it.photo }.toSet().size})") { state.navigate(29) }
            Row(Modifier.fillMaxWidth().height(155.dp),horizontalArrangement=Arrangement.spacedBy(5.dp)) {
                snap.photos.filter { photo -> view.pairs.any { it.photo==photo.id } }.take(6).forEach { photo ->
                    LivePhotoImage(live,photo,Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(9.dp)))
                }
            }
            ReviewHeading("People (${view.pairs.map { it.person }.toSet().size})") { state.navigate(31) }
            snap.people.filter { p -> view.pairs.any { it.person==p.id } }.forEach { person ->
                val ids=view.pairs.filter { it.person==person.id }.map { it.photo }.toSet()
                Row(Modifier.fillMaxWidth().padding(vertical=9.dp),verticalAlignment=Alignment.CenterVertically) {
                    InitialAvatar(person.name,Modifier.size(42.dp));Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) { Text(person.name,color=Color.White,fontSize=14.sp);Text(photoCount(ids.size),color=Muted,fontSize=12.sp) }
                    TextButton(onClick={live.openPerson(person.id)}) { Text(stringResource(R.string.copy_view_subset_2ead249e),color=Pink,fontSize=12.sp) }
                }
                Row(horizontalArrangement=Arrangement.spacedBy(4.dp)) {
                    snap.photos.filter { it.id in ids }.take(8).forEach { photo -> LivePhotoImage(live,photo,Modifier.size(35.dp).clip(RoundedCornerShape(6.dp))) }
                }
                DividerLine(Modifier.padding(top=12.dp))
            }
        }
        BodyText(stringResource(R.string.copy_each_person_receives_only_the_photo_cc4a906a),Modifier.padding(vertical=15.dp),size=12)
        PinkButton(stringResource(R.string.copy_share_photo_count,photoCount(view.pairs.map { it.photo }.toSet().size)),enabled=live.effective.isNotEmpty() && !live.busy) { live.commitShare() }
        Spacer(Modifier.height(18.dp))
    }
}

@Composable
private fun ReviewHeading(title: String,onEdit: ()->Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical=15.dp),verticalAlignment=Alignment.CenterVertically) {
        Text(title,color=Color.White,fontSize=17.sp,fontWeight=FontWeight.SemiBold,modifier=Modifier.weight(1f))
        Box(Modifier.clip(CircleShape).border(1.dp,Hairline,CircleShape).clickable(role=Role.Button,onClick=onEdit).padding(horizontal=16.dp,vertical=7.dp)) { Text(stringResource(R.string.copy_edit_5301648d),color=Color.White,fontSize=12.sp) }
    }
}

@Composable
private fun LiveReceipts(state: PreviewState) {
    val live=state.live;val receipt=live.focusedReceipt
    LivePage(state,if(receipt!=null)"Photo Request" else "Shared History") {
        if(receipt!=null) {
            val person=receipt["person"] as? Map<*,*>;val status=receipt["status"] as? String
            InitialAvatar(person?.get("name") as? String ?: "Person",Modifier.align(Alignment.CenterHorizontally).padding(top=24.dp).size(78.dp))
            Text(person?.get("name") as? String ?: "Photo request",color=Color.White,fontSize=24.sp,modifier=Modifier.align(Alignment.CenterHorizontally).padding(vertical=16.dp))
            BodyText(stringResource(R.string.photo_status,photoCount(receipt["photo_count"]),receiptLabel(status)))
            BodyText(stringResource(R.string.photos_available,photoCount(receipt["available_count"])),Modifier.padding(top=12.dp))
            Spacer(Modifier.weight(1f))
            if(receipt["sender"]!=true && status=="requested") {
                PinkButton(stringResource(R.string.copy_accept_photos_e8b4342a),enabled=!live.busy) { live.decide("accept") }
                OutlineButton(stringResource(R.string.copy_decline_b59cf9ed),Modifier.padding(top=12.dp)) { live.decide("decline") }
            } else if(receipt["sender"]==true && status=="requested")OutlineButton(stringResource(R.string.copy_withdraw_request_f6da7054)) { live.decide("withdraw") }
            else if(status=="accepted")OutlineButton(stringResource(R.string.copy_revoke_access_094386f6)) { live.decide("revoke") }
            PinkButton(stringResource(R.string.copy_back_to_photos_b080279d),Modifier.padding(top=12.dp)) { live.closeReceipt();state.navigate(13) }
            Spacer(Modifier.height(18.dp));return@LivePage
        }
        val result=live.outcome
        if(result==null) {
            if(live.outgoing.isEmpty())BodyText(stringResource(R.string.copy_your_outgoing_photo_requests_will_a_c770b1b1),Modifier.padding(top=30.dp))
            LazyColumn(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(9.dp)) {
                items(live.outgoing,key={NativeProtocol.id(it["id"])}) { row->
                    val person=row["person"] as? Map<*,*>
                    SettingRow(person?.get("name") as? String ?: "Photo request",subtitle=stringResource(R.string.photo_status,photoCount(row["photo_count"]),receiptLabel(row["status"] as? String)),icon=Glyph.PEOPLE) { live.openReceipt(row) }
                }
            }
            OutlineButton(stringResource(R.string.copy_refresh_history_5ffdb33d),enabled=!live.busy) { live.refreshHistory() };return@LivePage
        }
        BodyText(when(result["status"]){"pending_acceptance"->"Your requests are saved. Access starts after each person accepts.";"access_available"->"All approved photos are available to the accepted recipients.";"partial"->"Some approved photos are available. Check each person’s status.";else->"No photos are currently available from this operation."},Modifier.padding(vertical=20.dp))
        LazyColumn(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(9.dp)) {
            items(NativeProtocol.rows(result["recipients"] ?: emptyList<WireObject>()),key={it["recipient_id"] as String}) { row ->
                val person=live.snapshot?.people?.firstOrNull { it.id==row["recipient_id"] }
                SettingRow(person?.name ?: "Recipient",subtitle=stringResource(R.string.photo_status,photoCount(row["photo_count"]),receiptLabel(row["status"] as? String)),
                    trailing=stringResource(R.string.photos_available,photoCount(row["available_count"])),icon=Glyph.PEOPLE) { live.openRequest(NativeProtocol.id(row["request_id"])) }
            }
        }
        OutlineButton(stringResource(R.string.copy_all_outgoing_requests_708f14a0),enabled=!live.busy) { live.showHistory() }
        OutlineButton(stringResource(R.string.copy_refresh_status_28a0e95a),enabled=!live.busy) { live.refreshOutcome() }
        PinkButton(stringResource(R.string.copy_back_to_photos_b080279d),Modifier.padding(top=12.dp)) { state.navigate(13) };Spacer(Modifier.height(18.dp))
    }
}

@Composable
private fun LiveReport(state: PreviewState) {
    val live=state.live
    LivePage(state,"Report Incorrect Match") {
        live.selectedPhoto?.let { LivePhotoImage(live,it,Modifier.fillMaxWidth().height(210.dp).clip(RoundedCornerShape(18.dp))) }
        SectionTitle(stringResource(R.string.copy_tell_us_what_s_wrong_08e99516))
        var reason by remember { mutableStateOf("This isn’t me") }
        listOf("This isn’t me","Wrong person","Other").forEach { option ->
            Row(Modifier.fillMaxWidth().toggleable(reason==option,role=Role.RadioButton,onValueChange={reason=option}).padding(vertical=15.dp),verticalAlignment=Alignment.CenterVertically) {
                RadioButton(selected=reason==option,onClick=null,colors=RadioButtonDefaults.colors(selectedColor=Pink,unselectedColor=Muted));Text(option,color=Color.White,fontSize=15.sp)
            }
        }
        Spacer(Modifier.weight(1f));PinkButton(stringResource(R.string.copy_submit_report_1ca00033),enabled=live.selectedPhoto!=null && !live.busy) { live.report(reason) };Spacer(Modifier.height(18.dp))
    }
}

@Composable
private fun LiveAccount(state: PreviewState,choose: ()->Unit) {
    val live=state.live
    when(state.route) {
        37 -> LivePage(state,"Profile",back=false,bottom=37) {
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                InitialAvatar(live.name,Modifier.align(Alignment.CenterHorizontally).padding(top=18.dp).size(80.dp))
                Text(live.name,color=Color.White,fontSize=26.sp,modifier=Modifier.align(Alignment.CenterHorizontally).padding(top=14.dp))
                Text(photoCount(live.photos.size),color=Muted,fontSize=14.sp,modifier=Modifier.align(Alignment.CenterHorizontally).padding(vertical=12.dp))
                var editing by remember { mutableStateOf(false) };var name by remember(live.name) { mutableStateOf(live.name) }
                OutlineButton(stringResource(R.string.copy_edit_profile_cd280a41)) { editing=true }
                if(editing)AlertDialog(onDismissRequest={editing=false},backgroundColor=Panel,title={Text(stringResource(R.string.copy_edit_profile_cd280a41),color=Color.White)},text={TextField(name,{name=it.take(80)},label={Text(stringResource(R.string.copy_name_709a2322))})},
                    confirmButton={TextButton(onClick={editing=false;live.rename(name)},enabled=name.isNotBlank()){Text(stringResource(R.string.copy_save_efc007a3),color=Pink)}},dismissButton={TextButton(onClick={editing=false}){Text(stringResource(R.string.copy_cancel_77dfd213),color=Muted)}})
                Spacer(Modifier.height(18.dp))
                listOf(Triple("Manage Your Face",Glyph.FACE,38),Triple("Manage People",Glyph.PEOPLE,39),Triple("Privacy & Sharing",Glyph.SHIELD,40),Triple("Photo Access",Glyph.PHOTO,41),
                    Triple("Notifications",Glyph.BELL,42),Triple("Storage",Glyph.ANALYTICS,43),Triple("Export Your Data",Glyph.EXPORT,44),Triple("Account & Security",Glyph.LOCK,46),Triple("Help Center",Glyph.HELP,45)).forEach { (label,icon,route) ->
                    SettingRow(label,icon=icon,modifier=Modifier.padding(bottom=8.dp)) { state.navigate(route) }
                }
                SettingRow(stringResource(R.string.copy_all_48_reference_screens_6b3d3425),subtitle="Explicit screenshot review with local sample data",icon=Glyph.PHOTO) { state.enterReview() }
            }
        }
        38 -> LiveFaceProfile(state)
        39 -> LivePeopleSettings(state)
        40 -> LivePage(state,"Privacy & Sharing") {
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                SectionTitle(stringResource(R.string.copy_your_preferences_41bc34e5))
                PolicyRow(state,R.string.privacy_policy,BuildConfig.PRIVACY_POLICY_URL)
                LiveToggle("Process my uploaded photos","Find matches in the photos I choose to upload",live.processingConsent) { live.processingConsent=!live.processingConsent }
                LiveToggle("Use my face for photo matching","Allow my registered face to appear as a possible match",live.matchingConsent) { live.matchingConsent=!live.matchingConsent }
                LiveToggle("Receive matched photos","Requires contributor approval and my acceptance",live.receiveMatches) { live.receiveMatches=!live.receiveMatches }
                BodyText(stringResource(R.string.copy_these_choices_are_separate_from_fac_234cd232),Modifier.padding(vertical=20.dp),center=false,size=12)
                SettingRow(stringResource(R.string.copy_manage_people_a3539654),icon=Glyph.PEOPLE) { state.navigate(39) }
            }
            PinkButton(stringResource(R.string.copy_save_preferences_e9fdd169),enabled=live.photoPolicy["policy_version"] is String && !live.busy) { live.savePhotoPreferences() };Spacer(Modifier.height(18.dp))
        }
        41 -> LivePage(state,"Photo Access") {
            Spacer(Modifier.height(18.dp));SettingRow(stringResource(R.string.copy_choose_photos_155a4f76),subtitle="Android grants access only to the photos you select",icon=Glyph.PHOTO,onClick=choose)
            BodyText(stringResource(R.string.copy_lovelies_uses_the_system_photo_pick_a33bfeb7),Modifier.padding(top=22.dp),center=false)
            Spacer(Modifier.weight(1f));PinkButton(stringResource(R.string.copy_choose_photos_155a4f76),onClick=choose);Spacer(Modifier.height(18.dp))
        }
        42 -> LivePage(state,"Notifications") {
            val notificationPermission=rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted->if(granted)live.enablePush(true) else state.info("Notifications are off","You can allow notifications later in Android Settings.") }
            val context=LocalContext.current
            LiveToggle("This device",null,PushConfiguration.optedIn(context) && PushConfiguration.permitted(context)) {
                if(PushConfiguration.optedIn(context))live.enablePush(false)
                else if(android.os.Build.VERSION.SDK_INT>=33 && !PushConfiguration.permitted(context))notificationPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
                else live.enablePush(true)
            }
            if(live.pushStatus.isNotBlank())BodyText(live.pushStatus,Modifier.semantics { liveRegion=LiveRegionMode.Polite },size=13)

            SectionTitle(stringResource(R.string.copy_notification_preferences_0ead6c12))
            listOf("match_alerts" to "New Matches","support_alerts" to "Support Updates").forEach { (key,title) ->
                LiveToggle(title,null,live.notificationSettings[key]==true) { live.saveNotification(key,live.notificationSettings[key]!=true) }
            }
            BodyText(stringResource(R.string.copy_these_preferences_are_saved_to_your_a848bd4b),Modifier.padding(top=18.dp),center=false,size=12)
        }
        43 -> LivePage(state,"Storage") {
            SectionTitle(stringResource(R.string.copy_private_photo_storage_d3b1cb7a))
            BodyText(stringResource(R.string.copy_protected_previews_are_held_in_memo_951bd453),Modifier.padding(vertical=18.dp),center=false)
            SettingRow(stringResource(R.string.copy_clear_previews_7c3c42fd),subtitle="Discard currently loaded preview images",icon=Glyph.ANALYTICS) { live.clearImages();state.info("Previews cleared","Private previews will be loaded again only after a current authorization check.") }
        }
        44 -> if(live.accountDeletion!=null || live.repository.accountDeletion!=null)LiveAccountDeletion(state) else if(!live.registered)LiveGuestDeletion(state) else LivePage(state,"Export Your Data") {
            SectionTitle(stringResource(R.string.copy_your_account_data_41640209))
            BodyText(stringResource(R.string.copy_request_a_copy_of_your_data_the_sta_5aa86443),Modifier.padding(vertical=15.dp),center=false)
            var selectedExport by remember { mutableStateOf<String?>(null) }
            val document=rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { destination->
                val id=selectedExport;selectedExport=null
                if(destination!=null && id!=null)live.saveExport(id,destination)
            }
            NativeProtocol.rows(live.privacyCenter["requests"] ?: emptyList<WireObject>()).forEach { row ->
                val id=NativeProtocol.id(row["id"])
                val ready=row["request_type"]=="export" && (row["download_state"]=="ready" || live.repository.stagedExport()?.get("request")==id)
                SettingRow(row["request_type"] as? String ?: "Request",subtitle=listOfNotNull(row["status"] as? String,row["failure_code"] as? String).joinToString(" · "),trailing=if(ready)"Save" else "Status",icon=Glyph.EXPORT,modifier=Modifier.padding(bottom=8.dp)) {
                    if(ready) { selectedExport=id;document.launch("lovelies-export-$id.json") }
                    else state.info("Request status",listOfNotNull(row["status"] as? String,row["reason"] as? String,row["failure_code"] as? String).joinToString("\n"))
                }
            }
            OutlineButton(stringResource(R.string.copy_refresh_requests_3dc3afd4),enabled=!live.busy) { live.refreshPrivacy() }
            live.error?.let { BodyText(readableError(it.code),Modifier.padding(top=12.dp).semantics { liveRegion=LiveRegionMode.Polite },size=13) }
            Spacer(Modifier.weight(1f));PinkButton(stringResource(R.string.copy_request_export_cfe37002),enabled=!live.busy) { live.requestExport() }
            OutlineButton(stringResource(R.string.copy_request_account_deletion_faa6919a),Modifier.padding(top=12.dp)) { state.confirm("Request account deletion?","This sends your account deletion request for review.","Request") { live.requestDeletion() } }
            Spacer(Modifier.height(18.dp))
        }
        45 -> LivePage(state,"Help Center") {
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            SectionTitle(stringResource(R.string.copy_how_lovelies_works_964ea584))
            BodyText(stringResource(R.string.copy_register_your_face_using_the_camera_5215d56a),Modifier.padding(vertical=18.dp),center=false)
            SettingRow(stringResource(R.string.copy_photo_preferences_d1ccbb74),icon=Glyph.SHIELD) { state.navigate(40) }
            PolicyRow(state,R.string.privacy_policy,BuildConfig.PRIVACY_POLICY_URL)
            PolicyRow(state,R.string.terms_of_use,BuildConfig.TERMS_URL)
            PolicyRow(state,R.string.account_deletion_help,BuildConfig.DELETION_URL)
            if(!live.registered)SettingRow(if(live.hasGuestDeletion)"Guest deletion status" else "Delete guest account",icon=Glyph.SHIELD,
                modifier=Modifier.padding(top=9.dp)) { state.navigate(44) }
            if(BuildConfig.REFERENCE_SCREENS)SettingRow(stringResource(R.string.copy_review_reference_screens_693e2915),subtitle="Local screenshot fixtures",icon=Glyph.PHOTO,modifier=Modifier.padding(top=9.dp)) { state.enterReview() }
            if(live.registered) {
                OutlinedTextField(value=live.supportSubject,onValueChange={live.supportSubject=it.take(160);live.persistNavigation()},label={Text(stringResource(R.string.copy_subject_8d183dbd))},modifier=Modifier.fillMaxWidth().padding(top=12.dp),colors=liveFieldColors())
                OutlinedTextField(value=live.supportDetails,onValueChange={live.supportDetails=it.take(4000);live.persistNavigation()},label={Text(stringResource(R.string.copy_how_can_we_help_d9961547))},modifier=Modifier.fillMaxWidth().padding(top=8.dp),minLines=3,colors=liveFieldColors())
                PinkButton(stringResource(R.string.copy_send_support_request_5ebcb06b),Modifier.padding(top=12.dp),enabled=!live.busy && live.supportSubject.trim().length>=3 && live.supportDetails.trim().length>=5) { live.submitSupport() }
                live.supportSubmitted?.let { BodyText(stringResource(R.string.copy_your_support_request_is_saved_9fb2c9cf),Modifier.padding(top=10.dp).semantics { liveRegion=LiveRegionMode.Polite },size=13) }
                live.error?.let { BodyText(readableError(it.code),Modifier.padding(top=8.dp),size=13) }
                SectionTitle(stringResource(R.string.copy_your_requests_91d672ff),trailing="Refresh",onTrailing=live::refreshSupport)
                Column {
                    live.supportRequests.forEach { row->SettingRow(row["subject"] as? String ?: "Support request",subtitle=receiptLabel(row["status"] as? String),icon=Glyph.HELP,modifier=Modifier.padding(bottom=8.dp)) {
                        state.info(row["subject"] as? String ?: "Support request",listOfNotNull(row["status"] as? String,row["review_notes"] as? String).joinToString("\n"))
                    } }
                }
            }
            }
        }
        46 -> LivePage(state,"Account & Security") {
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                SectionTitle(stringResource(R.string.copy_sessions_e11e37a9))
                live.sessions.forEach { row -> SettingRow(if(row["current"]==true)"This session" else "Session",subtitle=row["created_at"]?.toString(),trailing="Revoke",icon=Glyph.LOCK,modifier=Modifier.padding(bottom=8.dp)) {
                    state.confirm("Revoke session?","The session will lose access immediately.","Revoke") { live.revoke(row,false) }
                } }
                SectionTitle(stringResource(R.string.copy_recovery_key_2e524a4f))
                BodyText(stringResource(R.string.copy_save_a_private_backup_key_to_recove_845d2912),Modifier.padding(vertical=10.dp),size=13)
                live.recoveryKeyMetadata?.let { BodyText("Backup key available · expires ${java.text.DateFormat.getDateInstance(java.text.DateFormat.MEDIUM).format(java.util.Date(it.expiresAt))}",size=12) }
                SettingRow(if(live.recoveryKeyMetadata==null)"Create recovery key" else "Create a new recovery key",icon=Glyph.LOCK,modifier=Modifier.padding(top=9.dp)) {
                    state.confirm("Create recovery key?","This replaces any previous recovery key. Save the new backup before changing devices.","Create") { live.generateRecoveryKey(true) }
                }
                if(live.repository.recoveryKeyIntent?.receipt==null && live.repository.recoveryKeyIntent!=null)SettingRow(stringResource(R.string.copy_retry_saved_key_request_c8c5da9e),icon=Glyph.LOCK,modifier=Modifier.padding(top=9.dp)) { live.generateRecoveryKey() }
                if(live.recoveryKeyMetadata!=null) {
                    SettingRow(stringResource(R.string.copy_view_saved_backup_ff31fab2),icon=Glyph.LOCK,modifier=Modifier.padding(top=9.dp)) { live.showRecoveryBackup() }
                    SettingRow(stringResource(R.string.copy_revoke_recovery_key_f01a6d60),icon=Glyph.LOCK,modifier=Modifier.padding(top=9.dp,bottom=12.dp)) {
                        state.confirm("Revoke recovery key?","The saved backup will stop working.","Revoke") { live.revokeRecoveryKey() }
                    }
                }
                live.error?.let { BodyText(readableError(it.code),Modifier.padding(vertical=8.dp),size=12) }
                SectionTitle(stringResource(R.string.copy_registered_devices_4faea88f))
                live.devices.forEach { row -> SettingRow(if(row["current"]==true)"This device" else "Device",subtitle=row["created_at"]?.toString(),trailing="Revoke",icon=Glyph.PHONE,modifier=Modifier.padding(bottom=8.dp)) {
                    state.confirm("Revoke device?","This clears the revoked device’s authentication reference.","Revoke") { live.revoke(row,true) }
                } }
            }
            PinkButton(stringResource(R.string.copy_sign_out_61fd08ff),enabled=!live.busy) { live.logout() }
            OutlineButton(stringResource(R.string.copy_sign_out_forget_this_device_82f2999b),Modifier.padding(top=12.dp)) { live.logout(true) };Spacer(Modifier.height(18.dp))
        }
    }
}

@Composable
private fun LiveFaceProfile(state: PreviewState) {
    val live=state.live;val meta=live.faceProfile ?: live.repository.faceLifecycle?.metadata;val record=live.repository.faceLifecycle
    LivePage(state,"Manage Your Face") {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()),horizontalAlignment=Alignment.CenterHorizontally) {
            GlowSymbol(Glyph.FACE,Modifier.padding(top=18.dp))
            Text(when { meta==null->"Your registered face";meta.removal=="completed"->"Profile removed";!meta.authenticationEnabled->"Face sign-in is off";
                meta.matchingPaused->"Photo matching is paused";else->"Your registered face" },color=Color.White,fontSize=22.sp,
                textAlign=TextAlign.Center,modifier=Modifier.fillMaxWidth().padding(top=20.dp,bottom=14.dp))
            BodyText(stringResource(R.string.copy_face_sign_in_photo_matching_and_upl_c6aedef1),size=13)
            if(meta!=null) {
                SectionTitle(stringResource(R.string.copy_current_status_3aa1d93d))
                BodyText("Face sign-in: ${if(meta.authenticationEnabled)"On" else "Off"}\nPhoto matching: ${if(meta.matchingPaused)"Paused" else if(meta.matchingEnabled)"On" else "Off"}\nUpload processing: ${if(meta.processingEnabled)"On" else "Off"}",
                    Modifier.fillMaxWidth().padding(bottom=12.dp),center=false,size=13)
                if(meta.removal!="none")BodyText(when(meta.removal) {
                    "completed"->"The server verified that the removed face reference is gone."
                    "failed"->"Reference removal failed. Check the status before setting up another profile."
                    "blocked"->"Reference removal is blocked by unresolved work. Check the status again."
                    else->"Sign-in and matching have stopped. Reference removal is still pending."
                },Modifier.fillMaxWidth().padding(bottom=15.dp).semantics { liveRegion=LiveRegionMode.Polite },center=false,size=13)
                if(meta.operation?.cleanup in setOf("pending","failed","blocked") && meta.removal=="none")
                    BodyText("Previous reference cleanup: ${meta.operation?.cleanup}. Your current profile remains separate.",Modifier.padding(bottom=12.dp),size=12)
            }
            live.error?.let { BodyText(readableError(it.code),Modifier.padding(vertical=12.dp).semantics { liveRegion=LiveRegionMode.Polite },size=13) }
            if(record?.intent!=null || record?.acknowledged==false || record?.loginKey!=null) {
                BodyText(when(record?.state) { "cancelled"->"This change was cancelled by the server. No saved capture can be reused."
                    "registered"->"The profile update is complete. Verify your face once to sign in."
                    "credentials_pending"->"The server response is saved. Current sign-in still needs confirmation."
                    "restart_required"->"Fresh captures are required. Your original account and device key remain saved."
                    "removal_pending"->"Reference cleanup must finish before a new profile can be enrolled."
                    "login_start","login_pending","login_capture_pending","login_completion_pending","login_credentials_pending"->"Your original account and key are saved. A fresh face sign-in must be confirmed by the server before private access returns."
                    else->"Your change is saved on this device. Check its server status before continuing." },Modifier.padding(bottom=14.dp),size=13)
                OutlineButton(stringResource(R.string.copy_check_profile_status_a4432f02),enabled=!live.busy) { live.checkFaceProfile() }
                if(record?.state=="cancel_pending")OutlineButton(stringResource(R.string.copy_retry_stop_f7cc0a3e),Modifier.padding(top=10.dp),enabled=!live.busy) { live.retryProfileCancellation() }
                if(record?.intent?.capture==true && record.state!="cancelled")OutlineButton(stringResource(R.string.copy_continue_face_setup_cf156d7e),Modifier.padding(top=10.dp),enabled=!live.busy) { state.navigate(6) }
                if(record?.loginKey!=null)OutlineButton(stringResource(R.string.copy_continue_face_sign_in_51a3763a),Modifier.padding(top=10.dp),enabled=!live.busy) { live.verifyFaceProfile() }
            } else if(meta!=null) {
                if(meta.profile!=null && meta.removal=="none") {
                    SettingRow(if(meta.matchingEnabled)"Pause Photo Matching" else "Resume Photo Matching",icon=Glyph.PEOPLE,modifier=Modifier.padding(top=10.dp)) {
                        live.confirmFaceProfile(if(meta.matchingEnabled)"pause" else "resume",if(meta.matchingEnabled)"Pause photo matching?" else "Resume photo matching?",
                            if(meta.matchingEnabled)"Future matching and receiving stop. Previous candidate access is retired; face sign-in and upload processing stay separate."
                            else "Allow your face profile to produce future matches. Previously revoked access stays retired.",if(meta.matchingEnabled)"Pause" else "Resume",meta.version)
                    }
                    if(meta.authenticationEnabled) {
                        SettingRow(stringResource(R.string.copy_replace_face_profile_2fd80a65),icon=Glyph.FACE,modifier=Modifier.padding(top=9.dp)) {
                            live.confirmFaceProfile("replace","Replace your face profile?","Take three fresh selfies to update this registered reference. Face sign-in uses the new reference; previous matching access is retired.","Continue",meta.version)
                        }
                        SettingRow(stringResource(R.string.copy_withdraw_face_sign_in_consent_b5af30ef),icon=Glyph.LOCK,modifier=Modifier.padding(top=9.dp)) {
                            live.confirmFaceProfile("withdraw_authentication","Turn off face sign-in?","Face sign-in will stop. If photo matching is off, the unused face reference will also be removed. Upload processing stays separate.","Withdraw",meta.version)
                        }
                    } else SettingRow(stringResource(R.string.copy_restore_face_sign_in_5364a734),icon=Glyph.LOCK,modifier=Modifier.padding(top=9.dp)) {
                        live.confirmFaceProfile("restore_authentication","Restore face sign-in?","Consent to use your retained registered reference for authentication, then take one fresh selfie. Photo matching and processing are separate choices.","Continue",meta.version)
                    }
                    SettingRow(stringResource(R.string.copy_remove_face_profile_1d28e692),icon=Glyph.SHIELD,modifier=Modifier.padding(top=9.dp)) {
                        live.confirmFaceProfile("remove","Remove your face profile?","Face sign-in and matching stop. Your account and uploads remain. Removal status stays visible until the server verifies cleanup.","Remove",meta.version)
                    }
                }
                if(meta.removal=="completed" && meta.profile==null)SettingRow(stringResource(R.string.copy_set_up_a_new_face_profile_017b2a6f),icon=Glyph.FACE,modifier=Modifier.padding(top=9.dp)) {
                    live.confirmFaceProfile("enroll","Set up your face again?","Consent to face sign-in using a new profile and take three selfies. Photo matching stays off until you choose it.","Continue",meta.version)
                }
                OutlineButton(stringResource(R.string.copy_refresh_status_28a0e95a),Modifier.padding(top=16.dp),enabled=!live.busy) { live.checkFaceProfile() }
                if(meta.authenticationEnabled && record?.blocksPrivate==false)OutlineButton(stringResource(R.string.copy_verify_my_face_7d81b5df),Modifier.padding(top=10.dp),enabled=!live.busy) { live.verifyFaceProfile() }
                if(meta.authenticationEnabled && record?.blocksPrivate==false && live.registered)OutlineButton(stringResource(R.string.copy_renew_expired_management_247280ad),Modifier.padding(top=10.dp),enabled=!live.busy) { live.confirmProfileRenewal() }
                if(!live.registered && record?.blocksPrivate==false)TextButton(onClick={live.showAccountRecoveryImport()},enabled=!live.busy) { Text(stringResource(R.string.copy_recover_with_my_backup_bf4d877b),color=Pink) }
            }
            Spacer(Modifier.height(18.dp))
        }
        OutlineButton(stringResource(R.string.copy_sign_out_61fd08ff),Modifier.padding(vertical=12.dp),enabled=!live.busy) { live.logout() }
    }
}

@Composable
private fun LiveGuestDeletion(state: PreviewState) {
    val live=state.live
    val record=live.guestDeletion
    val receipt=record?.receipt
    LivePage(state,"Guest account deletion",back=record==null) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            SectionTitle(if(record==null)"Your guest account" else "Deletion status")
            val label=when {
                receipt?.completed==true -> receipt.label
                record?.statusUnavailable==true -> if(receipt!=null && receipt.expiresAt<=System.currentTimeMillis())"Status receipt expired" else "Status unavailable"
                receipt!=null -> receipt.label
                record!=null -> "Request not confirmed"
                else -> "Before face setup"
            }
            Text(label,color=Pink,fontSize=20.sp,fontWeight=FontWeight.SemiBold,
                modifier=Modifier.fillMaxWidth().padding(top=22.dp,bottom=14.dp).semantics {
                    contentDescription="Deletion status: $label";liveRegion=LiveRegionMode.Polite
                })
            val explanation=when {
                receipt?.completed==true -> "The server has confirmed that this guest account was deleted. You can start again when you’re ready."
                record?.statusUnavailable==true -> "We can’t retrieve this request’s status. This does not confirm deletion. Your saved receipt remains on this device."
                receipt?.requestExpired==true -> "The approval window has ended. This does not confirm deletion. Resume setup only after the same guest account is verified again."
                receipt?.status=="rejected" -> "The deletion request was rejected. You can resume setup after the same guest account is verified again."
                receipt?.status=="cancelled" -> "The deletion request was cancelled. You can resume setup after the same guest account is verified again."
                receipt?.status=="failed" -> "Deletion could not finish. Check the status again for an update. Your account is not confirmed deleted."
                receipt?.status=="processing" -> "Deletion is in progress. Completion will appear here after the server confirms cleanup."
                receipt!=null -> "Your deletion request is saved for review. Face setup is paused while this request is unresolved."
                record!=null -> "We couldn’t confirm whether the request reached the server. Check status to reconcile your saved request."
                else -> "Request deletion of this guest account before registering your face. The request requires review; submitting it does not mean deletion is complete."
            }
            BodyText(explanation,center=false)
            receipt?.let {
                val dateFormat=java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.MEDIUM,java.text.DateFormat.SHORT)
                BodyText("Requested ${dateFormat.format(java.util.Date(it.createdAt))}",Modifier.padding(top=20.dp),center=false,size=12)
                if(!it.completed)BodyText("Approval window ends ${dateFormat.format(java.util.Date(it.requestExpiresAt))}",Modifier.padding(top=10.dp),center=false,size=12)
            }
            live.error?.let { BodyText(when {
                it.code=="deletion_storage_unavailable" -> "We couldn’t save this change on your device. Your previous account state has been kept. Try again when device storage is available."
                it.code.startsWith("deletion_") -> "We couldn’t verify this account or its deletion status. Check status again; no new guest account has been created."
                else -> readableError(it.code)
            },Modifier.padding(top=20.dp),center=false,size=13) }
        }
        when {
            receipt?.completed==true -> PinkButton(stringResource(R.string.copy_start_again_b6fffc5a),enabled=!live.busy) { live.startAgainAfterDeletion() }
            record!=null -> {
                PinkButton(if(live.busy)"Checking status…" else "Check deletion status",enabled=!live.busy) { live.checkGuestDeletion() }
                if(!record.statusUnavailable && receipt!=null && (receipt.requestExpired || receipt.status in listOf("rejected","cancelled")))
                    OutlineButton(stringResource(R.string.copy_resume_setup_e799297d),Modifier.padding(top=12.dp),enabled=!live.busy) { live.resumeGuestSetup() }
            }
            else -> OutlineButton(stringResource(R.string.copy_request_guest_account_deletion_c17f5942),enabled=live.canDeleteGuest && !live.busy) { live.confirmGuestDeletion() }
        }
        OutlineButton(stringResource(R.string.copy_help_c47ae153),Modifier.padding(top=12.dp),enabled=!live.busy) { state.navigate(45) }
        Spacer(Modifier.height(18.dp))
    }
}

@Composable
private fun LivePeopleSettings(state: PreviewState) {
    val live=state.live
    val blockedIds=live.blocked.map { NativeProtocol.id(it["blocked_id"] ?: it["account_id"] ?: it["id"]) }.toSet()
    val candidates=live.snapshot?.people?.filter { it.id !in blockedIds }?.distinctBy { it.id } ?: emptyList()
    LivePage(state,"Manage People") {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            BodyText(stringResource(R.string.copy_matched_people_are_allowed_by_defau_1cb367d3),
                Modifier.padding(top=8.dp,bottom=16.dp),center=false,size=12)
            SectionTitle("Blocked (${blockedIds.size})")
            if(live.blocked.isEmpty())BodyText(stringResource(R.string.copy_no_blocked_people_dd602f71),Modifier.padding(vertical=22.dp))
            live.blocked.distinctBy { NativeProtocol.id(it["blocked_id"] ?: it["account_id"] ?: it["id"]) }.forEach { row ->
                val name=row["name"] as? String ?: "Blocked person"
                SettingRow(name,trailing="Unblock",icon=Glyph.PERSON,modifier=Modifier.padding(bottom=9.dp)) {
                    state.confirm("Unblock $name?","This allows future matching and sharing. Previous access and excluded photos are not restored.","Unblock") {
                        live.block(NativeProtocol.id(row["blocked_id"] ?: row["account_id"] ?: row["id"]),false)
                    }
                }
            }
            SectionTitle("Matched in current review (${candidates.size})")
            if(live.snapshot==null)BodyText(stringResource(R.string.copy_open_a_photo_review_to_see_its_matc_18b4a6ae),
                Modifier.padding(vertical=12.dp),center=false,size=12)
            candidates.forEach { person -> SettingRow(person.name,subtitle="Can share with",trailing="Block",icon=Glyph.PERSON,modifier=Modifier.padding(bottom=9.dp)) {
                state.confirm("Block ${person.name}?","This blocks sharing between your accounts.","Block") { live.block(person.id,true) }
            } }
        }
    }
}

@Composable
private fun LiveEmpty(state: PreviewState) {
    LivePage(state,"",back=false,bottom=10) {
        Spacer(Modifier.weight(1f));SourceHero("empty-hero.png",.598f,152f/144f)
        Text(if(state.live.photos.isEmpty())"Your memories start here" else "No matches yet",color=Color.White,fontSize=23.sp,modifier=Modifier.align(Alignment.CenterHorizontally).padding(top=25.dp))
        BodyText(if(state.live.photos.isEmpty())"Add photos to find the people in your memories." else "Only currently eligible matches appear in a review.",Modifier.padding(top=12.dp))
        Spacer(Modifier.weight(1f));PinkButton(stringResource(R.string.copy_add_photos_be917560)) { state.navigate(19) }
        OutlineButton(stringResource(R.string.copy_photo_preferences_d1ccbb74),Modifier.padding(top=12.dp)) { state.navigate(40) };Spacer(Modifier.height(18.dp))
    }
}

@Composable
private fun LiveError(state: PreviewState) {
    val live=state.live;val problem=live.error
    LivePage(state,"Something went wrong") {
        Spacer(Modifier.weight(1f));SourceHero("offline-hero.png",.504f,128f/93f)
        Text(stringResource(R.string.copy_let_s_try_again_c201e419),color=Color.White,fontSize=24.sp,modifier=Modifier.align(Alignment.CenterHorizontally).padding(top=25.dp))
        BodyText(readableError(problem?.code ?: "connection_unavailable"),Modifier.padding(top=15.dp))
        if(live.repository.pending!=null)BodyText(stringResource(R.string.copy_a_saved_operation_needs_reconciliat_f323e585),Modifier.padding(top=15.dp),size=12)
        Spacer(Modifier.weight(1f))
        if(live.repository.pending?.action=="sharing.commit") {
            PinkButton(stringResource(R.string.copy_check_share_status_9e34c4e7),enabled=!live.busy) { live.reconcileShare() }
            OutlineButton(stringResource(R.string.copy_retry_original_share_b4d52f73),Modifier.padding(top=12.dp),enabled=!live.busy) { live.retryPending() }
        } else PinkButton(stringResource(R.string.copy_try_again_cef2fe09),enabled=!live.busy) { live.retryPending() }
        if(problem?.code?.contains("consent")==true)OutlineButton(stringResource(R.string.copy_photo_preferences_d1ccbb74),Modifier.padding(top=12.dp)) { state.navigate(40) }
        else OutlineButton(if(live.registered)"Back to Photos" else "Back to Setup",Modifier.padding(top=12.dp)) { state.navigate(if(live.registered)13 else 5) }
        Spacer(Modifier.height(18.dp))
    }
}

@Composable
private fun LivePhotoGrid(live: LiveController,photos: List<LivePhoto>,modifier: Modifier,columns: Int=3,selections: Set<String>?=null,route: Int?=null,onClick: (LivePhoto)->Unit) {
    val position=route?.let { live.galleryPositions[it] } ?: GalleryPosition()
    val grid=rememberLazyStaggeredGridState(initialFirstVisibleItemIndex=position.item.coerceAtMost((photos.size-1).coerceAtLeast(0)),initialFirstVisibleItemScrollOffset=position.offset)
    LaunchedEffect(grid,route) { if(route!=null)snapshotFlow { GalleryPosition(grid.firstVisibleItemIndex,grid.firstVisibleItemScrollOffset) }.distinctUntilChanged().collect { live.updateGalleryPosition(route,it.item,it.offset) } }
    DisposableEffect(grid,route) { onDispose { if(route!=null) { live.updateGalleryPosition(route,grid.firstVisibleItemIndex,grid.firstVisibleItemScrollOffset);live.persistNavigation() } } }
    val maxColumns=if(androidx.compose.ui.platform.LocalConfiguration.current.screenWidthDp<360)2 else columns
    LazyVerticalStaggeredGrid(columns=StaggeredGridCells.Fixed(maxColumns),state=grid,modifier=modifier,
        horizontalArrangement=Arrangement.spacedBy(6.dp),verticalItemSpacing=6.dp,contentPadding=PaddingValues(bottom=8.dp)) {
        items(photos,key={it.id}) { photo ->
            val action=if(selections!=null)Modifier.toggleable(photo.id in selections,role=Role.Checkbox,onValueChange={onClick(photo)}) else Modifier.clickable(role=Role.Button){onClick(photo)}
            Box(Modifier.fillMaxWidth().aspectRatio(photo.ratio).clip(RoundedCornerShape(9.dp)).then(action)
                .semantics { contentDescription=photo.title }) {
                LivePhotoImage(live,photo,Modifier.fillMaxSize())
                if(selections!=null)SelectionMark(photo.id in selections,Modifier.align(Alignment.TopEnd).padding(5.dp))
                else if(photo.id in live.favorites)SelectionMark(true,Modifier.align(Alignment.TopEnd).padding(5.dp),favorite=true)
            }
        }
    }
}

@Composable
private fun LivePhotoImage(live: LiveController,photo: LivePhoto,modifier: Modifier,scale: ContentScale=ContentScale.Crop) {
    var bitmap by remember(photo.id,photo.version) { mutableStateOf<Bitmap?>(null) }
    var failed by remember(photo.id,photo.version) { mutableStateOf(false) }
    val generation=live.mediaGeneration;val active=live.foregroundActive
    LaunchedEffect(photo.id,photo.version,generation,active) {
        bitmap=null;failed=false
        if(active && live.registered)try {
            val scope=live.repository.currentScope()
            val decoded=withContext(Dispatchers.IO) {
                val bytes=live.repository.preview(photo)
                try { decodePhoto(bytes) } finally { bytes.fill(0) }
            }
            live.repository.fence.assert(scope)
            if(live.foregroundActive && generation==live.mediaGeneration)bitmap=decoded
        } catch(problem: kotlinx.coroutines.CancellationException) { throw problem } catch(problem: Exception) { failed=true }
    }
    DisposableEffect(photo.id,photo.version) { onDispose { bitmap=null } }
    Box(modifier.background(Panel),contentAlignment=Alignment.Center) {
        if(active && bitmap!=null)Image(bitmap!!.asImageBitmap(),contentDescription=null,modifier=Modifier.fillMaxSize(),contentScale=scale)
        else AppIcon(if(failed)Glyph.LOCK else Glyph.PHOTO,Modifier.size(24.dp),Muted)
    }
}

private fun decodePhoto(bytes: ByteArray): Bitmap? {
    val size=BitmapFactory.Options().apply { inJustDecodeBounds=true };BitmapFactory.decodeByteArray(bytes,0,bytes.size,size)
    if(size.outWidth<=0 || size.outHeight<=0)return null
    var sample=1;while(size.outWidth/sample>2048 || size.outHeight/sample>2048)sample*=2
    return BitmapFactory.decodeByteArray(bytes,0,bytes.size,BitmapFactory.Options().apply { inSampleSize=sample })
}

@Composable
private fun LocalPhotoImage(uri: Uri,modifier: Modifier,active: Boolean) {
    val context=LocalContext.current
    var bitmap by remember(uri) { mutableStateOf<Bitmap?>(null) }
    LaunchedEffect(uri,active) { bitmap=null;if(active)bitmap=withContext(Dispatchers.IO) { runCatching {
        val dimensions=BitmapFactory.Options().apply { inJustDecodeBounds=true }
        context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it,null,dimensions) }
        var sample=1;while(dimensions.outWidth/sample>700 || dimensions.outHeight/sample>700)sample*=2
        context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it,null,BitmapFactory.Options().apply { inSampleSize=sample }) }
    }.getOrNull() } }
    DisposableEffect(uri) { onDispose { bitmap=null } }
    Box(modifier.background(Panel),contentAlignment=Alignment.Center) { if(active && bitmap!=null)Image(bitmap!!.asImageBitmap(),null,Modifier.fillMaxSize(),contentScale=ContentScale.Crop) else AppIcon(Glyph.PHOTO,Modifier.size(28.dp),Muted) }
}

@Composable
private fun InitialAvatar(name: String,modifier: Modifier) {
    Box(modifier.clip(CircleShape).background(Panel).border(1.dp,Pink.copy(alpha=.5f),CircleShape),contentAlignment=Alignment.Center) {
        Text(name.trim().split(Regex("\\s+")).take(2).mapNotNull { it.firstOrNull() }.joinToString("").uppercase(),color=Pink,fontSize=21.sp,fontWeight=FontWeight.Medium)
    }
}

@Composable
private fun LivePersonRow(person: LivePerson,subtitle: String,selected: Boolean,onCheck: ()->Unit,onOpen: ()->Unit) {
    val openLabel=stringResource(R.string.open_person,person.name)
    val includeLabel=stringResource(R.string.include_person,person.name)
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Panel).padding(12.dp),verticalAlignment=Alignment.CenterVertically) {
        Row(Modifier.weight(1f).heightIn(min=48.dp).clickable(role=Role.Button,onClick=onOpen)
            .semantics { contentDescription=openLabel },verticalAlignment=Alignment.CenterVertically) {
            InitialAvatar(person.name,Modifier.size(48.dp).clearAndSetSemantics { })
            Column(Modifier.weight(1f).padding(horizontal=13.dp)) { Text(person.name,color=Color.White,fontSize=15.sp);Text(subtitle,color=Muted,fontSize=12.sp,modifier=Modifier.padding(top=3.dp)) }
        }
        Box(Modifier.size(48.dp).toggleable(selected,role=Role.Checkbox,onValueChange={onCheck()}).semantics { contentDescription=includeLabel },contentAlignment=Alignment.Center) { SelectionMark(selected) }
    }
}

@Composable
private fun LiveToggle(title: String,subtitle: String?,checked: Boolean,onChange: ()->Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min=48.dp).toggleable(checked,role=Role.Switch,onValueChange={onChange()}).padding(vertical=17.dp),verticalAlignment=Alignment.CenterVertically) {
        Column(Modifier.weight(1f).padding(end=14.dp)) { Text(title,color=Color.White,fontSize=15.sp);if(subtitle!=null)Text(subtitle,color=Muted,fontSize=12.sp,modifier=Modifier.padding(top=6.dp)) }
        PinkToggle(checked,title,interactive=false,onToggle=onChange)
    }
    DividerLine()
}

@Composable private fun photoCount(raw: Any?): String { val count=(raw as? Number)?.toInt()?.coerceAtLeast(0) ?: 0;return pluralStringResource(R.plurals.photo_count,count,count) }
@Composable private fun personCount(raw: Any?): String { val count=(raw as? Number)?.toInt()?.coerceAtLeast(0) ?: 0;return pluralStringResource(R.plurals.person_count,count,count) }

@Composable private fun PolicyRow(state: PreviewState,label: Int,url: String) {
    val context=LocalContext.current
    val unavailable=stringResource(R.string.legal_link_unavailable)
    val details=stringResource(R.string.legal_link_unavailable_detail)
    val openFailed=stringResource(R.string.legal_link_open_failed)
    SettingRow(stringResource(label),icon=Glyph.SHIELD,modifier=Modifier.padding(top=8.dp)) {
        if(!PolicyLinks.valid(url))state.info(unavailable,details)
        else if(!PolicyLinks.open(context,url))state.info(unavailable,openFailed)
    }
}

@Composable private fun ScopeNotice() { BodyText(stringResource(R.string.copy_this_review_is_limited_to_the_photo_cdbe75a2),Modifier.padding(vertical=10.dp),center=false,size=12) }
private fun receiptLabel(status: String?)=when(status){"open"->"Open";"under_review"->"Under review";"resolved"->"Resolved";"closed"->"Closed";"requested"->"Awaiting acceptance";"accepted"->"Accepted";"declined"->"Declined";"withdrawn"->"Withdrawn";"revoked"->"Revoked";"expired"->"Expired";"failed"->"Failed";else->"Unavailable"}
internal fun readableError(code: String)=when(code) {
    "face_capture_no_face","face_capture_multiple_faces","face_capture_quality_low","face_capture_invalid_image",
    "camera_permission_required","camera_initialization_timeout","camera_disconnected","camera_surface_replaced","camera_unavailable",
    "capture_failed","capture_timeout","camera_review_expired","capture_context_changed","camera_image_invalid","capture_too_large","capture_format_invalid"->cameraRecoveryMessage(code)
    "face_login_in_flight"->"Your previous sign-in photo may still be processing. Wait for its saved challenge to expire before taking a fresh selfie."
    "face_login_requires_status","face_login_scope_changed","face_login_response_changed"->"The saved sign-in must be recovered on this original account and device. No new account was created."
    "face_profile_in_flight"->"A capture or verification is still in progress. Check its status before retaking."
    "face_profile_requires_status","face_profile_cancel_pending"->"Check the saved profile change before continuing. Your original account and device key are retained."
    "face_profile_control_requires_login"->"Verify your registered face to finish establishing private profile management."
    "face_profile_control_unavailable"->"Profile management is unavailable. If face sign-in is still authorized, verify your face on this original device and explicitly renew an expired control."
    "face_profile_control_not_expired"->"This private control is still current. It does not need renewal."
    "face_profile_login_pending"->"Continue the saved fresh face sign-in. Status alone cannot authenticate your account."
    "face_profile_cleanup_pending"->"Reference removal has not been verified. Check its status before enrolling another profile."
    "face_profile_reference_unavailable"->"There is no retained active reference for this action. Check the removal status."
    "face_profile_version_changed","face_profile_response_changed","face_profile_scope_changed","face_profile_capture_changed"->"The saved profile authority changed. No new access was granted. Check the current status."
    "face_profile_storage_unavailable"->"The saved profile change could not be written safely. Keep this installation and retry its status."
    "api_endpoint_unconfigured"->"Configure the API endpoint for this build before continuing."
    "connection_unavailable","server_unavailable"->"The service could not be reached. Check your connection and try again."
    "account_recovery_account_changed"->"This device holds setup or identity for another account. It has been preserved; use the backup for that same account."
    "account_recovery_sign_out_required"->"Sign out of the current account before recovering an account with a backup key."
    "account_recovery_history_full"->"Saved recovery history is full. No previous request or device key was removed."
    "account_recovery_in_flight"->"Your recovery photo is still being checked. Check status before taking another photo."
    "recovery_backup_invalid"->"Enter the full saved recovery backup, beginning with LVR1."
    "recovery_backup_unavailable"->"This device does not have that private backup. Create a new recovery key while signed in and save it."
    "account_recovery_unavailable","recovery_key_unavailable"->"That recovery key is unavailable. Your saved request has been kept; no replacement account was created."
    "account_recovery_storage_unavailable"->"We couldn’t save recovery on this device. Your previous account and keys have been kept. Free device storage, then try again."
    "account_recovery_requires_status"->"Check the saved account recovery request before continuing."
    "account_recovery_response_changed","account_recovery_scope_changed","account_recovery_capture_changed","recovery_key_response_changed"->"The recovery response did not match your saved account and device. Your original request has been kept."
    "enrollment_in_flight"->"Your previous photo is still being checked. Check again before taking another photo."
    "enrollment_storage_unavailable"->"We couldn’t save your setup on this device. Your original account and device key have been kept. Free device storage, then try again."
    "device_key_unavailable"->"The original device key is unavailable. Setup cannot continue on a replacement key."
    "enrollment_recovery_unavailable","enrollment_account_unavailable"->"We couldn’t recover this account’s setup. No new account has been created. Check your connection and try again."
    "enrollment_response_changed","enrollment_capture_changed","enrollment_scope_changed","capture_acknowledgement_changed"->"Your saved setup no longer matches the server. Check your original account before continuing."
    "enrollment_requires_recovery"->"Recover your existing face setup before continuing."
    "face_verifier_unavailable","face_authentication_unavailable"->"Face verification is unavailable. Try again when the service is ready."
    "processing_consent_required"->"Enable photo processing in Photo Preferences before uploading."
    "session_changed","registered_face_required","authentication_required"->"Your session changed. Verify your face again to continue."
    "face_comparison_failed","face_registration_mismatch"->"The face could not be verified. Retake a clear camera photo and try again."
    "review_changed","review_expired","eligibility_changed_review_required"->"Matches or permissions changed. Open a fresh review before sharing."
    "upload_storage_full","upload_storage_unavailable"->"Your upload is saved. Free device storage, then resume."
    "upload_source_changed","upload_source_unavailable"->"The saved photo is unavailable or changed. Cancel unfinished uploads and select it again."
    "upload_account_changed","upload_scope_changed","upload_progress_changed"->"This upload does not match your current account or saved photo. Its original details have been kept."
    "upload_expired"->"This unfinished upload expired. Cancel it before choosing the photo again."
    "upload_finalizing"->"Your photo bytes are saved. Resume to check finalization."
    "upload_paused"->"Upload paused. Resume when you are ready."
    "image_too_large"->"Choose a photo smaller than 20 MB."
    "processing_pending"->"Processing is still pending. Check your photos again shortly."
    else->code.replace('_',' ').replaceFirstChar { it.uppercase() }
}

@Composable private fun liveFieldColors()=TextFieldDefaults.outlinedTextFieldColors(textColor=Color.White,focusedBorderColor=Pink,unfocusedBorderColor=Hairline,cursorColor=Pink)

@Composable private fun PurchaseDialog(state: PreviewState) {
    val live=state.live
    if(!live.purchaseVisible)return
    val context=LocalContext.current
    val activity=remember(context) { generateSequence(context) { (it as? android.content.ContextWrapper)?.baseContext }.filterIsInstance<android.app.Activity>().firstOrNull() }
    val billing=live.purchases
    AlertDialog(onDismissRequest=live::dismissPurchases,backgroundColor=Panel,shape=RoundedCornerShape(24.dp),
        title={Text(stringResource(R.string.copy_original_photo_access_fe8275e8),color=Color.White)},text={Column(Modifier.verticalScroll(rememberScrollState())) {
            BodyText(stringResource(R.string.copy_a_verified_subscription_is_required_6773aca5),center=false,size=13)
            billing.plans.forEach { plan->OutlineButton("${plan.title} · ${plan.terms}",Modifier.padding(top=12.dp),enabled=!billing.busy && activity!=null) { activity?.let { billing.purchase(it,plan.token) } } }
            if(billing.status.isNotBlank())BodyText(billing.status,Modifier.padding(top=14.dp).semantics { liveRegion=LiveRegionMode.Polite },center=false,size=12)
        }},confirmButton={TextButton(enabled=!billing.busy,onClick=billing::restore) { Text(stringResource(R.string.copy_restore_purchases_2d557413),color=Pink) }},dismissButton={TextButton(onClick=live::dismissPurchases) { Text(stringResource(R.string.copy_close_bbfa773e),color=Muted) }})
}

@Composable private fun LiveAccountDeletion(state: PreviewState) {
    val live=state.live;val record=live.accountDeletion ?: live.repository.accountDeletion;val receipt=record?.receipt
    LivePage(state,"Account deletion",back=false) {
        Text(receipt?.label ?: "Checking your original deletion request",color=Pink,fontSize=22.sp,modifier=Modifier.padding(vertical=22.dp).semantics { liveRegion=LiveRegionMode.Polite })
        BodyText(if(receipt?.completed==true)"The server confirmed account cleanup. You can start again with a new guest account."
            else "Your original deletion request is saved privately on this device. Keep this installation to check its status. Completion is shown only after the server confirms cleanup.",center=false)
        receipt?.failureCode?.let { BodyText(readableError(it),Modifier.padding(top=12.dp),center=false) }
        live.error?.let { BodyText(readableError(it.code),Modifier.padding(top=12.dp),center=false) }
        Spacer(Modifier.weight(1f))
        PinkButton(stringResource(R.string.copy_check_status_99f3765b),enabled=!live.busy) { live.checkAccountDeletion() }
        if(receipt?.completed==true)OutlineButton(stringResource(R.string.copy_start_again_1721c828),Modifier.padding(top=12.dp),enabled=!live.busy) { live.restartAfterAccountDeletion() }
        else if(receipt?.requestExpired==true || receipt?.status in setOf("rejected","cancelled"))OutlineButton(stringResource(R.string.copy_return_to_my_account_1e0b386e),Modifier.padding(top=12.dp),enabled=!live.busy) { live.resumeAfterAccountDeletion() }
        Spacer(Modifier.height(18.dp))
    }
}
