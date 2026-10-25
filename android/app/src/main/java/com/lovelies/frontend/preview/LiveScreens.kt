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
import androidx.compose.foundation.selection.selectable
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
    val uiContext = androidx.compose.ui.platform.LocalContext.current
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
        live.beginPhotoPicker { owner ->
            photoPickerOwner=owner
            try { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }
            catch(problem: Exception) { photoPickerOwner=null;live.cancelPhotoPicker(owner);state.info(uiContext.getString(R.string.copy_photo_picker_unavailable_97ae963d),uiContext.getString(R.string.copy_choose_from_files_to_select_photos_o_5320fffa)) }
        }
    }
    val chooseFiles: ()->Unit={
        live.beginPhotoPicker { owner ->
            filePickerOwner=owner
            try { files.launch(arrayOf("image/*")) }
            catch(problem: Exception) { filePickerOwner=null;live.cancelPhotoPicker(owner);state.info(uiContext.getString(R.string.copy_file_picker_unavailable_eb77ff9d),uiContext.getString(R.string.copy_choose_from_this_device_to_select_ph_19666de8)) }
        }
    }
    if(live.audienceVisible && state.route !in setOf(44,45,46,48)) {
        LiveAudience(state)
        return
    }
    when(state.route) {
        1,2 -> OnboardingScreen(state)
        3,4,5 -> LiveWelcome(state,choose)
        6,7 -> LiveCapture(state)
        8 -> LiveProgress(state,uiContext.getString(R.string.copy_setting_up_your_face_500180cc), uiContext.getString(R.string.copy_your_registered_face_authenticates_y_741dff9b),"processing-hero.png",live.busy)
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
        34 -> LiveProgress(state,uiContext.getString(R.string.copy_sharing_your_photos_4cca8673),uiContext.getString(R.string.copy_saving_your_reviewed_selections_ec9aac60),"sharing-hero.png",live.busy)
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
    val uiContext = androidx.compose.ui.platform.LocalContext.current
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
                val clip=android.content.ClipData.newPlainText(uiContext.getString(R.string.copy_private_recovery_backup_0573f471),backup)
                clip.description.extras=android.os.PersistableBundle().apply { putBoolean("android.content.extra.IS_SENSITIVE",true) }
                manager.setPrimaryClip(clip)
            }) { Text(stringResource(R.string.copy_copy_backup_c76efb2a),color=Pink) }},dismissButton={TextButton(onClick=live::hideRecoveryBackup) { Text(stringResource(R.string.copy_done_e9b450d1),color=Muted) }})
    }
}

@Composable
private fun LiveWelcome(state: PreviewState,choose: ()->Unit) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val live=state.live
    LivePage(state,if(state.route==5)uiContext.getString(R.string.copy_let_s_get_you_set_up_2bfbee62) else uiContext.getString(R.string.copy_your_photos_5f6f6aaf)) {
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
            PinkButton(if(live.repository.identity!=null)uiContext.getString(R.string.copy_sign_in_with_my_face_cd6b18c6) else uiContext.getString(R.string.copy_set_up_my_face_5d397ceb),enabled=!live.busy) { state.navigate(6) }
        }
        if(!live.hasGuestDeletion)TextButton(onClick={if(live.hasAccountRecovery)state.navigate(6) else live.showAccountRecoveryImport()},enabled=!live.busy,
            modifier=Modifier.align(Alignment.CenterHorizontally)) { Text(if(live.hasAccountRecovery)uiContext.getString(R.string.copy_continue_account_recovery_f4bc949a) else uiContext.getString(R.string.copy_recover_my_account_8b0b03be),color=Pink) }
        if(live.canDeleteGuest)OutlineButton(stringResource(R.string.copy_delete_guest_account_8e0f6d76),Modifier.padding(top=12.dp),enabled=!live.busy) { live.confirmGuestDeletion() }
        Spacer(Modifier.height(20.dp))
    }
}

@Composable
private fun LiveAudience(state: PreviewState) {
    val live=state.live
    val context=LocalContext.current
    val audience=live.audience
    var chosen by remember(audience?.account,audience?.version) { mutableStateOf<String?>(null) }
    var requestId by remember { mutableStateOf("") }
    var revision by remember { mutableStateOf("") }
    var attested by remember { mutableStateOf(false) }
    var purposes by remember { mutableStateOf(emptySet<String>()) }
    val purposeLabels=mapOf("face_authentication" to R.string.audience_purpose_auth,"photo_matching" to R.string.audience_purpose_matching,"photo_processing" to R.string.audience_purpose_processing)
    LivePage(state,stringResource(R.string.audience_title),back=false) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            BodyText(stringResource(R.string.audience_intro),Modifier.padding(top=12.dp,bottom=18.dp),center=false)
            Text(when {
                live.ownGuardianWithdrawalPending -> stringResource(R.string.audience_withdrawal_pending)
                audience==null -> stringResource(R.string.audience_check_required)
                audience.band=="under13" -> stringResource(R.string.audience_under13_blocked)
                audience.band=="unknown" -> stringResource(R.string.audience_choose_age)
                audience.allows("face_authentication") -> stringResource(R.string.audience_eligible)
                else -> stringResource(R.string.audience_guardian_pending)
            },color=Color.White,fontSize=17.sp,modifier=Modifier.fillMaxWidth().padding(bottom=18.dp).semantics { liveRegion=LiveRegionMode.Polite })
            if(audience?.band=="unknown" && live.repository.credentials!=null) {
                SectionTitle(stringResource(R.string.audience_age_label))
                listOf("under13" to R.string.audience_under13,"13_17" to R.string.audience_13_17,"18_plus" to R.string.audience_18_plus).forEach { (band,label) ->
                    Row(Modifier.fillMaxWidth().heightIn(min=48.dp).selectable(selected=chosen==band,enabled=!live.busy,role=Role.RadioButton,onClick={chosen=band}).padding(vertical=8.dp),verticalAlignment=Alignment.CenterVertically) {
                        RadioButton(selected=chosen==band,onClick=null,colors=RadioButtonDefaults.colors(selectedColor=Pink,unselectedColor=Muted))
                        Text(stringResource(label),color=Color.White,fontSize=16.sp,modifier=Modifier.weight(1f).padding(start=12.dp))
                    }
                }
                PinkButton(stringResource(R.string.audience_save_age),Modifier.padding(top=12.dp),enabled=chosen!=null && !live.busy && !live.audienceOperationPending) { chosen?.let(live::declareAudience) }
            }
            if(audience?.band=="13_17") {
                audience.request?.let { request ->
                    GuardianRequestSummary(request)
                    if(request.state in setOf("pending","under_review","approved"))OutlineButton(stringResource(R.string.audience_withdraw),Modifier.padding(top=12.dp),enabled=!live.busy && !live.guardianWithdrawalOperationPending) {
                        state.confirm(context.getString(R.string.audience_withdraw),context.getString(R.string.audience_withdraw_detail),context.getString(R.string.audience_withdraw)) { live.withdrawGuardianRequest(request) }
                    }
                }
                if(audience.request==null || audience.request.state in setOf("rejected","withdrawn","expired"))OutlineButton(stringResource(R.string.audience_create_request),Modifier.padding(top=12.dp),enabled=!live.busy && !live.audienceOperationPending && !live.guardianWithdrawalOperationPending) { live.createGuardianRequest() }
            }
            if(audience?.band=="18_plus" && audience.allows("face_authentication") && live.identityAuthenticated) {
                SectionTitle(stringResource(R.string.audience_guardian_heading))
                BodyText(stringResource(R.string.audience_guardian_intro),Modifier.padding(vertical=12.dp),center=false,size=13)
                OutlinedTextField(value=requestId,onValueChange={requestId=it.take(36)},label={Text(stringResource(R.string.audience_request_reference))},singleLine=true,enabled=!live.busy,
                    keyboardOptions=androidx.compose.foundation.text.KeyboardOptions(autoCorrectEnabled=false,keyboardType=androidx.compose.ui.text.input.KeyboardType.Ascii),colors=liveFieldColors(),modifier=Modifier.fillMaxWidth())
                OutlinedTextField(value=revision,onValueChange={revision=it.filter(Char::isDigit).take(18)},label={Text(stringResource(R.string.audience_request_revision))},singleLine=true,enabled=!live.busy,
                    keyboardOptions=androidx.compose.foundation.text.KeyboardOptions(keyboardType=androidx.compose.ui.text.input.KeyboardType.Number),colors=liveFieldColors(),modifier=Modifier.fillMaxWidth().padding(top=10.dp))
                LiveToggle(stringResource(R.string.audience_relationship),null,attested,enabled=!live.busy) { attested=!attested }
                purposeLabels.forEach { (purpose,label) -> LiveToggle(stringResource(label),null,purpose in purposes,enabled=!live.busy) { purposes=if(purpose in purposes)purposes-purpose else purposes+purpose } }
                BodyText(stringResource(R.string.audience_claim_limit),Modifier.padding(vertical=12.dp),center=false,size=13)
                PinkButton(stringResource(R.string.audience_claim),enabled=!live.busy && !live.audienceOperationPending && !live.guardianWithdrawalOperationPending && attested && purposes.isNotEmpty() && revision.toLongOrNull()?.let { it>0 }==true && runCatching { NativeProtocol.id(requestId.trim()) }.isSuccess) {
                    live.claimGuardianRequest(requestId.trim(),revision.toLong(),purposes)
                }
                OutlineButton(stringResource(R.string.copy_check_status_99f3765b),Modifier.padding(top=12.dp),enabled=!live.busy && runCatching { NativeProtocol.id(requestId.trim()) }.isSuccess) { live.checkGuardianRequest(requestId.trim()) }
            }
            live.guardianClaim?.let { request ->
                GuardianRequestSummary(request)
                OutlineButton(stringResource(R.string.copy_check_status_99f3765b),Modifier.padding(top=12.dp),enabled=!live.busy) { live.checkGuardianRequest(request.id) }
                if(request.state in setOf("pending","under_review","approved"))OutlineButton(stringResource(R.string.audience_withdraw),Modifier.padding(top=12.dp),enabled=!live.busy && !live.guardianWithdrawalOperationPending) {
                    state.confirm(context.getString(R.string.audience_withdraw),context.getString(R.string.audience_withdraw_detail),context.getString(R.string.audience_withdraw)) { live.withdrawGuardianRequest(request) }
                }
            }
            if(live.guardianClaim==null)live.guardianReference?.let { reference ->
                SectionTitle(stringResource(R.string.audience_request_heading))
                androidx.compose.foundation.text.selection.SelectionContainer { Text(reference,color=Color.White,fontSize=14.sp,modifier=Modifier.fillMaxWidth().padding(vertical=12.dp)) }
                BodyText(stringResource(R.string.audience_guardian_restore),center=false,size=13)
                OutlineButton(stringResource(R.string.copy_check_status_99f3765b),Modifier.padding(top=12.dp),enabled=!live.busy) { live.checkGuardianRequest(reference) }
            }
            live.error?.let { BodyText(readableError(it.code,context),Modifier.padding(vertical=14.dp).semantics { liveRegion=LiveRegionMode.Polite },center=false,size=13) }
            if(live.guardianWithdrawalOperationPending) {
                BodyText(stringResource(R.string.audience_withdrawal_pending),Modifier.padding(vertical=12.dp),center=false,size=13)
                OutlineButton(stringResource(R.string.audience_retry_withdrawal),enabled=!live.busy && live.repository.credentials!=null) { live.retryGuardianWithdrawal() }
            }
            if(live.audienceOperationPending) {
                BodyText(stringResource(R.string.audience_saved_change),Modifier.padding(vertical=12.dp),center=false,size=13)
                OutlineButton(stringResource(R.string.audience_retry_saved),enabled=!live.busy) { live.retryAudienceChange() }
            }
            OutlineButton(stringResource(R.string.copy_check_status_99f3765b),Modifier.padding(top=12.dp),enabled=!live.busy && live.repository.credentials!=null) { live.refreshAudience() }
            if(audience?.allows("face_authentication")==true && !live.ownGuardianWithdrawalPending)PinkButton(stringResource(R.string.copy_continue_2e026239),Modifier.padding(top=12.dp),enabled=!live.busy) { live.continueAfterAudience() }
            else if(live.repository.credentials==null && (live.repository.identity!=null || live.hasAccountRecovery || live.hasLifecycle))OutlineButton(stringResource(R.string.audience_check_sign_in),Modifier.padding(top=12.dp),enabled=!live.busy) { live.beginFace() }
            PolicyRow(state,R.string.privacy_policy,BuildConfig.PRIVACY_POLICY_URL)
            SettingRow(stringResource(R.string.audience_privacy_deletion),icon=Glyph.SHIELD,modifier=Modifier.padding(top=12.dp)) { state.navigate(44) }
            if(live.weakRegisteredSession)SettingRow(stringResource(R.string.copy_account_security_fb84c56c),icon=Glyph.LOCK,modifier=Modifier.padding(top=8.dp)) { state.navigate(46) }
            SettingRow(stringResource(R.string.copy_help_center_bbf4ae03),icon=Glyph.HELP,modifier=Modifier.padding(top=8.dp)) { state.navigate(45) }
            if(live.repository.credentials!=null)OutlineButton(stringResource(R.string.copy_sign_out_61fd08ff),Modifier.padding(top=12.dp),enabled=!live.busy) { live.logout() }
            Spacer(Modifier.height(18.dp))
        }
    }
}

@Composable
private fun GuardianRequestSummary(request: GuardianRequest) {
    SectionTitle(stringResource(R.string.audience_request_heading))
    val status=if(request.expires<=System.currentTimeMillis())R.string.copy_expired_bca9f3d2 else when(request.state) {
        "pending"->R.string.audience_request_waiting
        "under_review"->R.string.copy_under_review_07000a6f
        "approved"->R.string.copy_approved_c699109a
        "rejected"->R.string.copy_request_rejected_8ccc55ac
        "withdrawn"->R.string.copy_withdrawn_a579599b
        else->R.string.copy_expired_bca9f3d2
    }
    BodyText(stringResource(status),Modifier.padding(top=10.dp).semantics { liveRegion=LiveRegionMode.Polite },center=false)
    androidx.compose.foundation.text.selection.SelectionContainer {
        Text(stringResource(R.string.audience_request_reference_value,request.id,request.revision),color=Color.White,fontSize=14.sp,modifier=Modifier.fillMaxWidth().padding(vertical=12.dp))
    }
    listOf("face_authentication" to R.string.audience_purpose_auth,"photo_matching" to R.string.audience_purpose_matching,"photo_processing" to R.string.audience_purpose_processing).forEach { (purpose,label) ->
        val active=request.state=="approved" && request.expires>System.currentTimeMillis() && request.purposes[purpose]==true
        BodyText(stringResource(R.string.audience_purpose_status,stringResource(label),stringResource(if(active)R.string.copy_approved_c699109a else R.string.audience_not_approved)),Modifier.padding(bottom=8.dp),center=false,size=13)
    }
    BodyText(stringResource(R.string.audience_request_share),center=false,size=13)
    BodyText(stringResource(R.string.audience_claim_limit),Modifier.padding(top=10.dp),center=false,size=12)
}

@Composable
private fun LiveCapture(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val live=state.live
    val captureContext=live.captureContext()
    var shutter by remember(captureContext) { mutableStateOf<(() -> Unit)?>(null) }
    val poses=(live.faceChallenge?.get("poses") as? List<*>)?.mapNotNull { it as? String } ?: emptyList()
    val pose=poses.getOrNull(live.captureCount) ?: "front"
    val ready=live.cameraForUpload || live.faceChallenge!=null
    Column(Modifier.fillMaxSize().padding(horizontal=18.dp),horizontalAlignment=Alignment.CenterHorizontally) {
        ScreenHeader(if(live.cameraForUpload)uiContext.getString(R.string.copy_take_a_photo_8b458ff5) else if(live.faceChallenge?.get("purpose")=="login")uiContext.getString(R.string.copy_welcome_back_48e13026)
            else when(live.repository.faceLifecycle?.intent?.action) { "replace"->uiContext.getString(R.string.copy_replace_your_face_profile_4310dffa);"restore_authentication"->uiContext.getString(R.string.copy_restore_face_sign_in_5364a734);"enroll"->uiContext.getString(R.string.copy_set_up_your_face_8b4da1f4);
                else->if(live.hasAccountRecovery)uiContext.getString(R.string.copy_recover_your_account_86fc8c3d) else uiContext.getString(R.string.copy_set_up_your_face_8b4da1f4) },onBack={live.cancelFace()})
        Text(if(live.cameraForUpload)uiContext.getString(R.string.copy_capture_a_memory_ea1a2bed) else when(pose){"left"->uiContext.getString(R.string.copy_turn_slightly_to_your_left_b867edb7);"right"->uiContext.getString(R.string.copy_turn_slightly_to_your_right_daf941a8);else->uiContext.getString(R.string.copy_look_straight_at_the_camera_ffa9c481)},
            color=Color.White,fontSize=18.sp,modifier=Modifier.padding(top=14.dp,bottom=10.dp))
        BodyText(if(live.cameraForUpload)uiContext.getString(R.string.copy_review_this_photo_before_uploading_ddc1112d) else uiContext.getString(R.string.copy_keep_your_face_inside_the_frame_cf529b50),size=13)
        Box(Modifier.weight(1f).padding(top=22.dp,bottom=20.dp).fillMaxWidth().clip(RoundedCornerShape(24.dp)).background(Panel)) {
            if(live.reviewingCapture && live.reviewPreview!=null)androidx.compose.foundation.Image(live.reviewPreview!!.asImageBitmap(),
                contentDescription=if(live.cameraForUpload)uiContext.getString(R.string.copy_unsent_photo_preview_c002e430) else uiContext.getString(R.string.copy_unsent_selfie_preview_3c3da050),modifier=Modifier.fillMaxSize(),contentScale=androidx.compose.ui.layout.ContentScale.Fit)
            else if(ready && captureContext!=null)NativeCameraPane(Modifier.fillMaxSize(),front=!live.cameraForUpload,active=live.foregroundActive,
                captureContext=captureContext,onShutter=live::shutterContext,
                onReady={owner,action->if(owner==live.captureContext()) { shutter=action;live.cameraReady=action!=null }},
                onPhoto=live::capture,onError=live::cameraError,onStatus=live::cameraState,authorizePersonal=live::authorizePersonalCollection)
            else Box(Modifier.fillMaxSize(),contentAlignment=Alignment.Center) { CircularProgressIndicator(color=Pink,modifier=Modifier.semantics { contentDescription=uiContext.getString(R.string.a11y_camera_loading) }) }
            if(ready && !live.cameraForUpload && !live.reviewingCapture)Box(Modifier.align(Alignment.Center).fillMaxWidth(.78f).fillMaxHeight(.66f)
                .border(2.dp,Pink,RoundedCornerShape(55.dp)))
            if(live.busy)Box(Modifier.fillMaxSize().background(Ink.copy(alpha=.62f)),contentAlignment=Alignment.Center) { CircularProgressIndicator(color=Pink,modifier=Modifier.semantics { contentDescription=uiContext.getString(R.string.a11y_camera_loading) }) }
        }
        live.error?.let { BodyText(readableError(it.code, uiContext),Modifier.padding(bottom=12.dp),size=13) }
        if(live.reviewingCapture) {
            BodyText(if(live.cameraForUpload)uiContext.getString(R.string.copy_review_your_photo_71d1318e) else uiContext.getString(R.string.copy_review_this_selfie_face_quality_will_521c4dfc),Modifier.padding(bottom=12.dp),size=13)
            PinkButton(if(live.cameraForUpload)uiContext.getString(R.string.copy_use_this_photo_ea9cb38c) else uiContext.getString(R.string.copy_use_this_selfie_3beb5dec),enabled=!live.busy,onClick=live::approveCapture)
            OutlineButton(stringResource(R.string.copy_retake_16457335),Modifier.padding(top=10.dp,bottom=12.dp),enabled=!live.busy,onClick=live::retakeCapture)
        }
        if(live.error?.code in setOf("camera_image_invalid","capture_too_large","camera_review_expired","capture_context_changed") && ready)
            OutlineButton(stringResource(R.string.copy_retake_16457335),Modifier.padding(bottom=12.dp),enabled=!live.busy,onClick=live::retakeCapture)
        if(live.error!=null && !ready)OutlineButton(if(live.error?.code in setOf("enrollment_in_flight","account_recovery_in_flight","face_profile_in_flight","face_login_in_flight"))uiContext.getString(R.string.copy_check_setup_status_a667adcc) else if(isFaceCaptureRejection(live.error?.code.orEmpty()))uiContext.getString(R.string.copy_retake_selfies_8dfea8d6) else uiContext.getString(R.string.copy_try_again_213e90fa)) { live.beginFace() }
        if(live.hasAccountRecovery && live.error!=null)TextButton(onClick={
            state.confirm(uiContext.getString(R.string.copy_use_another_recovery_key_095a4d22),uiContext.getString(R.string.copy_your_previous_request_will_stay_save_8ef24849),uiContext.getString(R.string.copy_use_another_key_f93e8abc)) { live.showAccountRecoveryImport(true) }
        },enabled=!live.busy) { Text(stringResource(R.string.copy_use_another_recovery_key_99e60eca),color=Pink) }
        if(!live.cameraForUpload)Row(horizontalArrangement=Arrangement.spacedBy(12.dp),modifier=Modifier.padding(bottom=15.dp)) {
            repeat(if(poses.isEmpty())3 else poses.size) { index -> Box(Modifier.size(9.dp).clip(CircleShape).background(if(index<live.captureCount)Pink else Hairline)) }
        }
        if(!live.reviewingCapture)Box(Modifier.padding(bottom=18.dp).size(72.dp).border(3.dp,Color.White,CircleShape).padding(7.dp).clip(CircleShape)
            .background(if(shutter!=null && !live.busy)Color.White else Hairline)
            .clickable(enabled=shutter!=null && !live.busy,role=Role.Button){shutter?.invoke()}
            .semantics { contentDescription=if(live.cameraForUpload)uiContext.getString(R.string.copy_capture_photo_2265ce8d) else when(pose) { "left" -> uiContext.getString(R.string.copy_capture_left_selfie_07580492); "right" -> uiContext.getString(R.string.copy_capture_right_selfie_429ff19d); else -> uiContext.getString(R.string.copy_capture_front_selfie_64a040fa) } })
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
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val live=state.live;val record=live.uploadRecovery
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),horizontalAlignment=Alignment.CenterHorizontally) {
        Spacer(Modifier.height(56.dp));SourceHero("upload-hero.png",.68f,184f/101f)
        Text(when { record?.cancelled==true->uiContext.getString(R.string.copy_uploads_cancelled_e5964596);record?.finished==true->uiContext.getString(R.string.copy_upload_complete_38fda4db);live.busy->uiContext.getString(R.string.copy_uploading_your_photos_8c4581b8);else->uiContext.getString(R.string.copy_upload_paused_a3ddf64e) },
            color=Color.White,fontSize=23.sp,modifier=Modifier.padding(top=24.dp,bottom=12.dp))
        BodyText(live.error?.let { readableError(it.code, uiContext) } ?: live.uploadStatus)
        if(record!=null && !record.finished && !record.cancelled)LiveToggle(uiContext.getString(R.string.copy_continue_with_background_scheduling_552c020e),uiContext.getString(R.string.copy_android_may_defer_work_each_accepted_44065179),live.backgroundUploads) { live.configureBackgroundUploads(!live.backgroundUploads) }
        if(record!=null && record.files.all { it.sha256!=null } && record.bytesTotal>0) {
            LinearProgressIndicator(progress=(record.bytesAcknowledged.toDouble()/record.bytesTotal).toFloat(),color=Pink,backgroundColor=Hairline,
                modifier=Modifier.fillMaxWidth().padding(top=24.dp).semantics { contentDescription=uiContext.getString(R.string.copy_1_s_of_2_s_photo_bytes_saved_c04a54b3, record.bytesAcknowledged, record.bytesTotal) })
            BodyText(uiContext.getString(R.string.copy_1_s_saved_1fcf155b, (record.bytesAcknowledged*100/record.bytesTotal)),Modifier.padding(top=10.dp),size=13)
        } else if(live.busy)CircularProgressIndicator(color=Pink,modifier=Modifier.padding(top=24.dp).size(28.dp))
        Spacer(Modifier.height(28.dp))
        if(record?.finished==true)PinkButton(stringResource(R.string.copy_view_matches_731444f2),enabled=!live.busy) { live.reviewPhotos(batch=record.batch) }
        else if(record?.cancelled!=true) {
            if(live.busy)OutlineButton(stringResource(R.string.copy_pause_781961bc),onClick=live::pauseUploads)
            else PinkButton(if(record?.cancelling==true)uiContext.getString(R.string.copy_finish_cancellation_1b0d976d) else if(live.error!=null || record?.error!=null)uiContext.getString(R.string.copy_retry_8036af59) else uiContext.getString(R.string.copy_resume_454d1d8a),enabled=live.registered) { live.resumeUploads(retryFailed=true) }
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
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val live=state.live
    if(state.route==12) { LiveViewer(state);return }
    if(state.route==16) {
        LivePage(state,uiContext.getString(R.string.filters)) {
            BodyText(stringResource(R.string.copy_photo_source_dfe0371b),center=false,modifier=Modifier.padding(vertical=18.dp))
            Segments(listOf("All","Contributed","Received"),state.category,onSelect=live::updateSource)
            BodyText(stringResource(R.string.copy_newest_first_search_and_photo_sourc_8b7617ee),Modifier.padding(top=16.dp),center=false,size=13)
            Spacer(Modifier.weight(1f));PinkButton(stringResource(R.string.copy_apply_filters_6b2a78a8)) { state.navigate(13) };Spacer(Modifier.height(18.dp))
        };return
    }
    if(state.route==11 && state.category!="Received") {
        LivePage(state,uiContext.getString(R.string.copy_matches_a7d4102e),back=false,bottom=11) {
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
    val title=when { received->uiContext.getString(R.string.copy_matches_a7d4102e);state.route==10->uiContext.getString(R.string.copy_your_memories_ef9aa575);state.route==14->uiContext.getString(R.string.copy_favorites_7c2c53ba);state.route==15->uiContext.getString(R.string.copy_search_c646a2c9);else->uiContext.getString(R.string.copy_all_photos_343464c9) }
    val rows=live.photos.filter { photo -> state.route!=14 || photo.id in live.favorites }
    LivePage(state,title,back=state.route==15,bottom=when { received->11;state.route==10->10;state.route==14->14;else->13 }) {
        if(received) {
            LiveMatchesNavigation(state,received=true)
            BodyText(uiContext.getString(R.string.copy_photos_you_can_access_as_a_recipient_f7e2fb5f),Modifier.padding(top=12.dp),center=false,size=13)
        }
        SearchInput(live.search,stringResource(R.string.search_photos),Modifier.padding(top=8.dp,bottom=12.dp),onValue={live.updateSearch(it);if(state.route!=15)state.navigate(15)},onFilter={state.navigate(16)})
        Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween,verticalAlignment=Alignment.CenterVertically) {
            Text(if(live.libraryCursor!=null)stringResource(R.string.loaded_photo_count,photoCount(rows.size)) else photoCount(rows.size),color=Muted,fontSize=13.sp)
            TextButton(onClick={state.navigate(19)}) { Text(stringResource(R.string.add_photos),color=Pink,fontSize=13.sp) }
        }
        if(rows.isEmpty())Box(Modifier.weight(1f).fillMaxWidth(),contentAlignment=Alignment.Center) { BodyText(if(live.libraryLoading)uiContext.getString(R.string.copy_searching_2713de23) else if(state.route==14)uiContext.getString(R.string.copy_your_favorite_photos_will_appear_her_d57e4158) else uiContext.getString(R.string.copy_no_photos_match_this_search_cbcdf970)) }
        else LivePhotoGrid(live,rows,Modifier.weight(1f),columns=if(state.route==10)4 else 3,route=state.route,onClick={live.openPhoto(it,rows)})
        live.libraryError?.let { BodyText(readableError(it.code, uiContext),Modifier.semantics { liveRegion=LiveRegionMode.Polite },size=13) }
        if(live.libraryCursor!=null)OutlineButton(if(live.libraryLoading)uiContext.getString(R.string.copy_loading_2e7e4ae3) else uiContext.getString(R.string.copy_load_more_photos_1969bbc3),enabled=!live.libraryLoading && !live.busy) { live.loadMorePhotos() }
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
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val live=state.live
    val rows=live.viewerRows.toList().ifEmpty { listOfNotNull(live.selectedPhoto) }
    if(rows.isEmpty()) { LivePage(state,uiContext.getString(R.string.copy_photo_53219983)) { BodyText(stringResource(R.string.copy_this_photo_is_unavailable_return_to_9a6755dc));OutlineButton(stringResource(R.string.copy_back_to_photos_b080279d)) { state.navigate(13) } };return }
    val pager=rememberPagerState(initialPage=rows.indexOfFirst { it.id==live.selectedPhoto?.id }.coerceAtLeast(0),pageCount={rows.size})
    var chrome by remember { mutableStateOf(true) }
    var zoomed by remember { mutableStateOf(false) }
    val context=LocalContext.current
    val savePermission=rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted->
        if(granted)live.selectedPhoto?.let { live.original(it) }
        else state.info(uiContext.getString(R.string.copy_allow_photo_saving_b73adb30),uiContext.getString(R.string.copy_open_android_settings_and_allow_stor_a8cc21b8))
    }
    LaunchedEffect(live.shareIntent) { live.shareIntent?.let { intent->
        try { context.startActivity(android.content.Intent.createChooser(intent,uiContext.getString(R.string.copy_share_photo_58c755ac)));live.clearShareIntent() }
        catch(_: android.content.ActivityNotFoundException) { live.clearShareIntent();state.info(uiContext.getString(R.string.copy_share_unavailable_9fa6cce2),uiContext.getString(R.string.copy_no_installed_app_can_share_this_phot_6764d270)) }
    } }
    val scope=rememberCoroutineScope()
    LaunchedEffect(pager.settledPage) {
        live.selectedPhoto=rows.getOrNull(pager.settledPage);live.persistNavigation();zoomed=false
    }
    val photo=rows.getOrNull(pager.currentPage) ?: rows.first()
    Column(Modifier.fillMaxSize()) {
        if(chrome)ScreenHeader(displayedPhotoTitle(photo,uiContext.getString(R.string.copy_photo_53219983)),onBack=state::back,right={Overflow(state)})
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
                contentDescription=displayedPhotoTitle(rows[page],uiContext.getString(R.string.copy_photo_53219983));stateDescription=pageDescription
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
                IconAction(Glyph.HEART,if(photo.id in live.favorites)uiContext.getString(R.string.copy_remove_favorite_95ed8147) else uiContext.getString(R.string.copy_add_favorite_5f2be110),color=if(photo.id in live.favorites)Pink else Color.White) { live.toggleFavorite(photo.id) }
                if(photo.source=="contributions")IconAction(Glyph.PEOPLE,uiContext.getString(R.string.copy_matched_people_8307585e)) { live.selectedPhotoMatches() }
                IconAction(Glyph.HELP,uiContext.getString(R.string.copy_report_4681fa0b)) { state.navigate(36) }
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
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val live=state.live;val isNotification=state.route==18
    LivePage(state,if(isNotification)uiContext.getString(R.string.copy_notifications_753a22b2) else uiContext.getString(R.string.copy_activity_9e75940c),bottom=10) {
        Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween) {
            TextButton(onClick={state.navigate(17)}) { Text(uiContext.resources.getQuantityString(R.plurals.copy_request_heading_count, live.inbox.size, live.inbox.size),color=if(!isNotification)Pink else Muted) }
            TextButton(onClick={state.navigate(18)}) { Text(stringResource(R.string.copy_notifications_753a22b2),color=if(isNotification)Pink else Muted) }
        }
        if(isNotification)LazyColumn(verticalArrangement=Arrangement.spacedBy(9.dp)) {
            items(live.notifications,key={it["id"] as String}) { row -> SettingRow(row["title"] as? String ?: uiContext.getString(R.string.copy_notification_146a2866),subtitle=row["kind"] as? String,
                icon=Glyph.BELL,trailing=if(row["read_at"]!=null)uiContext.getString(R.string.copy_read_4f0befe5) else uiContext.getString(R.string.copy_new_8b242db1)) { live.readNotification(row) } }
        } else if(live.inbox.isEmpty())Box(Modifier.fillMaxSize(),contentAlignment=Alignment.Center) { BodyText(stringResource(R.string.copy_photo_requests_will_appear_here_375f2958)) }
        else LazyColumn(verticalArrangement=Arrangement.spacedBy(9.dp)) {
            items(live.inbox,key={it["id"] as String}) { row ->
                val person=row["person"] as? Map<*,*>;val count=(row["photo_count"] as? Number)?.toInt() ?: 0
                SettingRow(person?.get("name") as? String ?: uiContext.getString(R.string.copy_photo_request_1f865c7e),subtitle=stringResource(R.string.photo_status,photoCount(count),receiptLabel(row["status"] as? String, uiContext)),icon=Glyph.PEOPLE) { live.openReceipt(row) }
            }
        }
    }
}

@Composable
private fun LiveUploadEntry(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    LivePage(state,uiContext.getString(R.string.add_photos)) {
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
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
        ScreenHeader(stringResource(R.string.copy_choose_source_8bc9b333), onBack = state::back, leading = Glyph.CLOSE)
        UploadSourceList(Modifier.weight(1f)) { source ->
            when(source) {
                UploadSourceChoice.DEVICE, UploadSourceChoice.ALBUMS -> choose()
                UploadSourceChoice.FILES -> files()
                UploadSourceChoice.CAMERA -> state.live.cameraUpload()
                UploadSourceChoice.GOOGLE_PHOTOS -> state.confirm("Google Photos",
                    uiContext.getString(R.string.copy_in_the_android_photo_picker_choose_1_5119a3c3, "Google Photos"),
                    uiContext.getString(R.string.copy_open_photos_080b49e2), choose)
                UploadSourceChoice.GOOGLE_DRIVE, UploadSourceChoice.DROPBOX, UploadSourceChoice.ONEDRIVE ->
                    state.confirm(source.title,
                        uiContext.getString(R.string.copy_in_the_android_file_picker_open_brow_ec2fd73d, source.title),
                        uiContext.getString(R.string.copy_open_files_dcbec6c2), files)
            }
        }
    }
}

@Composable
private fun LiveUploadReview(state: PreviewState,choose: ()->Unit) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val live=state.live
    LivePage(state,if(state.route==22)uiContext.getString(R.string.copy_review_upload_da9297a6) else uiContext.getString(R.string.copy_select_photos_e7fbdbd6)) {
        SectionTitle(uiContext.getString(R.string.copy_1_s_selected_35eec3bf, live.selectedUploads.size),trailing=uiContext.getString(R.string.copy_add_more_5d2a8a05),onTrailing=choose)
        LazyVerticalStaggeredGrid(columns=StaggeredGridCells.Fixed(3),modifier=Modifier.weight(1f),horizontalArrangement=Arrangement.spacedBy(6.dp),verticalItemSpacing=6.dp) {
            items(live.picked,key={it.toString()}) { uri ->
                Box(Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(10.dp))
                    .toggleable(uri in live.selectedUploads,role=Role.Checkbox,onValueChange={live.toggleUpload(uri)})
                    .semantics { contentDescription=if(uri in live.selectedUploads)uiContext.getString(R.string.copy_upload_photo_selected_5353a6ed) else uiContext.getString(R.string.copy_upload_photo_not_selected_d4d32cde) }) {
                    LocalPhotoImage(uri,Modifier.fillMaxSize(),live.foregroundActive);SelectionMark(uri in live.selectedUploads,Modifier.align(Alignment.TopEnd).padding(6.dp))
                }
            }
        }
        if(state.route==22) {
            OutlinedTextField(value=live.caption,onValueChange=live::uploadCaption,label={Text(stringResource(R.string.copy_photo_title_optional_029237d2))},modifier=Modifier.fillMaxWidth().padding(vertical=12.dp),
                colors=TextFieldDefaults.outlinedTextFieldColors(textColor=Color.White,focusedBorderColor=Pink,unfocusedBorderColor=Hairline,cursorColor=Pink))
            if(!live.processingConsent)SettingRow(stringResource(R.string.copy_enable_photo_processing_5ba32687),subtitle=uiContext.getString(R.string.copy_save_this_choice_before_uploading_fc2f3491),icon=Glyph.SHIELD) { state.navigate(40) }
            PinkButton(stringResource(R.string.copy_upload_photo_count,photoCount(live.selectedUploads.size)),enabled=live.selectedUploads.isNotEmpty() && live.processingConsent && !live.busy) { live.upload() }
        } else PinkButton(stringResource(R.string.copy_continue_2e026239),enabled=live.selectedUploads.isNotEmpty()) { state.navigate(22) }
        Spacer(Modifier.height(18.dp))
    }
}

@Composable
private fun LiveUploadComplete(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val live=state.live
    LivePage(state,uiContext.getString(R.string.copy_upload_complete_38fda4db),back=false) {
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
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val live=state.live;val snap=live.snapshot
    LivePage(state,uiContext.getString(R.string.copy_matches_found_270ad966)) {
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
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val live=state.live;val snap=live.snapshot
    LivePage(state,if(state.route==26)uiContext.getString(R.string.copy_matched_photos_d2c8fc60) else uiContext.getString(R.string.copy_select_photos_to_share_52f9b7e4)) {
        if(snap==null) { BodyText(stringResource(R.string.copy_open_a_photo_review_from_your_galle_7b747039));return@LivePage }
        SectionTitle(uiContext.resources.getQuantityString(R.plurals.copy_photo_heading_count, live.draft.photos.size, live.draft.photos.size),trailing=if(live.draft.photos.isEmpty())uiContext.getString(R.string.copy_select_all_6af21072) else uiContext.getString(R.string.copy_deselect_all_4547f79d),onTrailing={
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
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val live=state.live;val snap=live.snapshot
    val photo=live.selectedPhoto?.let { selected -> snap?.photos?.firstOrNull { it.id==selected.id } } ?: snap?.photos?.firstOrNull()
    LivePage(state,uiContext.getString(R.string.copy_people_in_this_photo_c3d0005b)) {
        if(snap==null || photo==null) { BodyText(stringResource(R.string.copy_open_a_photo_to_review_its_matches_cd430a24));return@LivePage }
        LivePhotoImage(live,photo,Modifier.fillMaxWidth().height(230.dp).clip(RoundedCornerShape(18.dp)))
        SectionTitle(stringResource(R.string.copy_matched_people_27323e24))
        LazyColumn(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(8.dp)) {
            items(snap.people.filter { person -> snap.pairs.any { it.photo==photo.id && it.person==person.id } },key={it.id}) { person ->
                val selected=live.effective.any { it.photo==photo.id && it.person==person.id }
                LivePersonRow(person,if(person.id !in live.draft.people)uiContext.getString(R.string.copy_excluded_from_all_photos_f276f04f) else uiContext.getString(R.string.copy_this_photo_only_fd5e4779),selected,
                    onCheck={live.togglePair(photo.id,person.id)},onOpen={live.openPerson(person.id)})
            }
        }
        BodyText(stringResource(R.string.copy_uncheck_a_person_to_exclude_this_ph_897f2a03),Modifier.padding(vertical=12.dp),size=12)
        PinkButton(stringResource(R.string.copy_select_photos_to_share_52f9b7e4),enabled=live.effective.isNotEmpty()) { state.navigate(29) };Spacer(Modifier.height(18.dp))
    }
}

@Composable
private fun LivePersonPhotos(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val live=state.live;val snap=live.snapshot
    val person=snap?.people?.firstOrNull { it.id==live.focusedPerson } ?: snap?.people?.firstOrNull()
    LivePage(state,person?.name ?: uiContext.getString(R.string.copy_matched_person_687f11b0)) {
        if(snap==null || person==null) { BodyText(stringResource(R.string.copy_select_a_matched_person_first_ba1e7627));return@LivePage }
        InitialAvatar(person.name,Modifier.align(Alignment.CenterHorizontally).padding(vertical=16.dp).size(76.dp))
        val rows=snap.photos.filter { photo -> snap.pairs.any { it.photo==photo.id && it.person==person.id } }
        val selected=live.effective.filter { it.person==person.id }.map { it.photo }.toSet()
        SectionTitle(uiContext.resources.getQuantityString(R.plurals.copy_photo_heading_count, selected.size, selected.size))
        LivePhotoGrid(live,rows,Modifier.weight(1f),selections=selected,onClick={live.togglePair(it.id,person.id)})
        BodyText(if(person.id !in live.draft.people)uiContext.getString(R.string.copy_this_person_is_excluded_from_all_sha_22e6fc93) else uiContext.getString(R.string.copy_only_checked_photos_will_be_included_44fd6a86, person.name),Modifier.padding(vertical=12.dp),size=12)
        OutlineButton(if(person.id in live.draft.people)uiContext.getString(R.string.copy_exclude_this_person_globally_5b824bb4) else uiContext.getString(R.string.copy_include_this_person_globally_b3ee2ea6)) { live.togglePerson(person.id) }
        PinkButton(stringResource(R.string.copy_continue_2e026239),Modifier.padding(top=12.dp),enabled=live.effective.isNotEmpty()) { state.navigate(31) };Spacer(Modifier.height(18.dp))
    }
}

@Composable
private fun LiveSelectPeople(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val live=state.live;val snap=live.snapshot
    LivePage(state,uiContext.getString(R.string.copy_select_people_to_share_with_f00ebe36)) {
        if(snap==null) { BodyText(stringResource(R.string.copy_open_a_photo_review_first_e2f30cd2));return@LivePage }
        SectionTitle(uiContext.resources.getQuantityString(R.plurals.copy_people_heading_count, live.draft.people.size, live.draft.people.size))
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
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val live=state.live;val snap=live.snapshot;val view=live.preview
    LivePage(state,uiContext.getString(R.string.copy_review_share_023d8493)) {
        if(snap==null || view==null) { BodyText(stringResource(R.string.copy_review_your_current_selection_befor_b592a97e));PinkButton(stringResource(R.string.copy_review_selection_04dd6243)) { live.prepareShare() };return@LivePage }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            ReviewHeading(uiContext.resources.getQuantityString(R.plurals.copy_photo_heading_count, view.pairs.map { it.photo }.toSet().size, view.pairs.map { it.photo }.toSet().size)) { state.navigate(29) }
            Row(Modifier.fillMaxWidth().height(155.dp),horizontalArrangement=Arrangement.spacedBy(5.dp)) {
                snap.photos.filter { photo -> view.pairs.any { it.photo==photo.id } }.take(6).forEach { photo ->
                    LivePhotoImage(live,photo,Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(9.dp)))
                }
            }
            ReviewHeading(uiContext.resources.getQuantityString(R.plurals.copy_people_heading_count, view.pairs.map { it.person }.toSet().size, view.pairs.map { it.person }.toSet().size)) { state.navigate(31) }
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
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val live=state.live;val receipt=live.focusedReceipt
    LivePage(state,if(receipt!=null)uiContext.getString(R.string.copy_photo_request_7c286e1e) else uiContext.getString(R.string.copy_shared_history_966f258c)) {
        if(receipt!=null) {
            val person=receipt["person"] as? Map<*,*>;val status=receipt["status"] as? String
            InitialAvatar(person?.get("name") as? String ?: uiContext.getString(R.string.copy_person_c36eeba0),Modifier.align(Alignment.CenterHorizontally).padding(top=24.dp).size(78.dp))
            Text(person?.get("name") as? String ?: uiContext.getString(R.string.copy_photo_request_1f865c7e),color=Color.White,fontSize=24.sp,modifier=Modifier.align(Alignment.CenterHorizontally).padding(vertical=16.dp))
            BodyText(stringResource(R.string.photo_status,photoCount(receipt["photo_count"]),receiptLabel(status, uiContext)))
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
                    SettingRow(person?.get("name") as? String ?: uiContext.getString(R.string.copy_photo_request_1f865c7e),subtitle=stringResource(R.string.photo_status,photoCount(row["photo_count"]),receiptLabel(row["status"] as? String, uiContext)),icon=Glyph.PEOPLE) { live.openReceipt(row) }
                }
            }
            OutlineButton(stringResource(R.string.copy_refresh_history_5ffdb33d),enabled=!live.busy) { live.refreshHistory() };return@LivePage
        }
        BodyText(when(result["status"]){"pending_acceptance"->uiContext.getString(R.string.copy_your_requests_are_saved_access_start_7f3d2fb7);"access_available"->uiContext.getString(R.string.copy_all_approved_photos_are_available_to_de39c160);"partial"->uiContext.getString(R.string.copy_some_approved_photos_are_available_c_08ef81e8);else->uiContext.getString(R.string.copy_no_photos_are_currently_available_fr_673b8129)},Modifier.padding(vertical=20.dp))
        LazyColumn(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(9.dp)) {
            items(NativeProtocol.rows(result["recipients"] ?: emptyList<WireObject>()),key={it["recipient_id"] as String}) { row ->
                val person=live.snapshot?.people?.firstOrNull { it.id==row["recipient_id"] }
                SettingRow(person?.name ?: uiContext.getString(R.string.copy_recipient_da952418),subtitle=stringResource(R.string.photo_status,photoCount(row["photo_count"]),receiptLabel(row["status"] as? String, uiContext)),
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
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val live=state.live
    LivePage(state,uiContext.getString(R.string.copy_report_incorrect_match_cd851491)) {
        live.selectedPhoto?.let { LivePhotoImage(live,it,Modifier.fillMaxWidth().height(210.dp).clip(RoundedCornerShape(18.dp))) }
        SectionTitle(stringResource(R.string.copy_tell_us_what_s_wrong_08e99516))
        var reason by remember { mutableStateOf("This isn’t me") }
        listOf("This isn’t me","Wrong person","Other").forEach { option ->
            Row(Modifier.fillMaxWidth().toggleable(reason==option,role=Role.RadioButton,onValueChange={reason=option}).padding(vertical=15.dp),verticalAlignment=Alignment.CenterVertically) {
                RadioButton(selected=reason==option,onClick=null,colors=RadioButtonDefaults.colors(selectedColor=Pink,unselectedColor=Muted));Text(choiceLabel(uiContext,option),color=Color.White,fontSize=15.sp)
            }
        }
        Spacer(Modifier.weight(1f));PinkButton(stringResource(R.string.copy_submit_report_1ca00033),enabled=live.selectedPhoto!=null && !live.busy) { live.report(reason) };Spacer(Modifier.height(18.dp))
    }
}

@Composable
private fun LiveAccount(state: PreviewState,choose: ()->Unit) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val live=state.live
    when(state.route) {
        37 -> LivePage(state,uiContext.getString(R.string.copy_profile_cd17328e),back=false,bottom=37) {
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                InitialAvatar(live.name,Modifier.align(Alignment.CenterHorizontally).padding(top=18.dp).size(80.dp))
                Text(live.name,color=Color.White,fontSize=26.sp,modifier=Modifier.align(Alignment.CenterHorizontally).padding(top=14.dp))
                Text(photoCount(live.photos.size),color=Muted,fontSize=14.sp,modifier=Modifier.align(Alignment.CenterHorizontally).padding(vertical=12.dp))
                var editing by remember { mutableStateOf(false) };var name by remember(live.name) { mutableStateOf(live.name) }
                OutlineButton(stringResource(R.string.copy_edit_profile_cd280a41)) { editing=true }
                if(editing)AlertDialog(onDismissRequest={editing=false},backgroundColor=Panel,title={Text(stringResource(R.string.copy_edit_profile_cd280a41),color=Color.White)},text={TextField(name,{name=it.take(80)},label={Text(stringResource(R.string.copy_name_709a2322))})},
                    confirmButton={TextButton(onClick={editing=false;live.rename(name)},enabled=name.isNotBlank()){Text(stringResource(R.string.copy_save_efc007a3),color=Pink)}},dismissButton={TextButton(onClick={editing=false}){Text(stringResource(R.string.copy_cancel_77dfd213),color=Muted)}})
                Spacer(Modifier.height(18.dp))
                listOf(Triple(uiContext.getString(R.string.copy_manage_your_face_990044ce),Glyph.FACE,38),Triple(uiContext.getString(R.string.copy_manage_people_a3539654),Glyph.PEOPLE,39),Triple(uiContext.getString(R.string.copy_privacy_sharing_576d0d35),Glyph.SHIELD,40),Triple(uiContext.getString(R.string.copy_photo_access_7b04cc07),Glyph.PHOTO,41),
                    Triple(uiContext.getString(R.string.copy_notifications_753a22b2),Glyph.BELL,42),Triple(uiContext.getString(R.string.copy_storage_34eddf06),Glyph.ANALYTICS,43),Triple(uiContext.getString(R.string.copy_export_your_data_726c5cda),Glyph.EXPORT,44),Triple(uiContext.getString(R.string.copy_account_security_fb84c56c),Glyph.LOCK,46),Triple(uiContext.getString(R.string.copy_help_center_bbf4ae03),Glyph.HELP,45)).forEach { (label,icon,route) ->
                    SettingRow(label,icon=icon,modifier=Modifier.padding(bottom=8.dp)) { state.navigate(route) }
                }
                SettingRow(stringResource(R.string.audience_title),icon=Glyph.SHIELD,modifier=Modifier.padding(bottom=8.dp)) { live.showAudience() }
                SettingRow(stringResource(R.string.copy_all_48_reference_screens_6b3d3425),subtitle=uiContext.getString(R.string.copy_explicit_screenshot_review_with_loca_f4ff7992),icon=Glyph.PHOTO) { state.enterReview() }
            }
        }
        38 -> LiveFaceProfile(state)
        39 -> LivePeopleSettings(state)
        40 -> LivePage(state,uiContext.getString(R.string.copy_privacy_sharing_576d0d35)) {
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                SectionTitle(stringResource(R.string.copy_your_preferences_41bc34e5))
                PolicyRow(state,R.string.privacy_policy,BuildConfig.PRIVACY_POLICY_URL)
                LiveToggle(uiContext.getString(R.string.copy_process_my_uploaded_photos_a1711fdd),uiContext.getString(R.string.copy_find_matches_in_the_photos_i_choose__a3884f90),live.processingConsent) { live.processingConsent=!live.processingConsent }
                LiveToggle(uiContext.getString(R.string.copy_use_my_face_for_photo_matching_96d31c57),uiContext.getString(R.string.copy_allow_my_registered_face_to_appear_a_6bcc6a60),live.matchingConsent) { live.matchingConsent=!live.matchingConsent }
                LiveToggle(uiContext.getString(R.string.copy_receive_matched_photos_b9710793),uiContext.getString(R.string.copy_requires_contributor_approval_and_my_f2cd514f),live.receiveMatches) { live.receiveMatches=!live.receiveMatches }
                BodyText(stringResource(R.string.copy_these_choices_are_separate_from_fac_234cd232),Modifier.padding(vertical=20.dp),center=false,size=12)
                SettingRow(stringResource(R.string.copy_manage_people_a3539654),icon=Glyph.PEOPLE) { state.navigate(39) }
            }
            PinkButton(stringResource(R.string.copy_save_preferences_e9fdd169),enabled=live.photoPolicy["policy_version"] is String && !live.busy) { live.savePhotoPreferences() };Spacer(Modifier.height(18.dp))
        }
        41 -> LivePage(state,uiContext.getString(R.string.copy_photo_access_7b04cc07)) {
            Spacer(Modifier.height(18.dp));SettingRow(stringResource(R.string.copy_choose_photos_155a4f76),subtitle=uiContext.getString(R.string.copy_android_grants_access_only_to_the_ph_18b59e49),icon=Glyph.PHOTO,onClick=choose)
            BodyText(stringResource(R.string.copy_lovelies_uses_the_system_photo_pick_a33bfeb7),Modifier.padding(top=22.dp),center=false)
            Spacer(Modifier.weight(1f));PinkButton(stringResource(R.string.copy_choose_photos_155a4f76),onClick=choose);Spacer(Modifier.height(18.dp))
        }
        42 -> LivePage(state,uiContext.getString(R.string.copy_notifications_753a22b2)) {
            val notificationPermission=rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted->if(granted)live.enablePush(true) else state.info(uiContext.getString(R.string.copy_notifications_are_off_bdb15edc),uiContext.getString(R.string.copy_you_can_allow_notifications_later_in_abf7623a)) }
            val context=LocalContext.current
            LiveToggle(uiContext.getString(R.string.copy_this_device_8fc5c8b9),null,PushConfiguration.optedIn(context) && PushConfiguration.permitted(context)) {
                if(PushConfiguration.optedIn(context))live.enablePush(false)
                else if(android.os.Build.VERSION.SDK_INT>=33 && !PushConfiguration.permitted(context))notificationPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
                else live.enablePush(true)
            }
            if(live.pushStatus.isNotBlank())BodyText(live.pushStatus,Modifier.semantics { liveRegion=LiveRegionMode.Polite },size=13)

            SectionTitle(stringResource(R.string.copy_notification_preferences_0ead6c12))
            listOf("match_alerts" to uiContext.getString(R.string.copy_new_matches_2c63d230),"support_alerts" to uiContext.getString(R.string.copy_support_updates_39e875be)).forEach { (key,title) ->
                LiveToggle(title,null,live.notificationSettings[key]==true) { live.saveNotification(key,live.notificationSettings[key]!=true) }
            }
            BodyText(stringResource(R.string.copy_these_preferences_are_saved_to_your_a848bd4b),Modifier.padding(top=18.dp),center=false,size=12)
        }
        43 -> LivePage(state,uiContext.getString(R.string.copy_storage_34eddf06)) {
            SectionTitle(stringResource(R.string.copy_private_photo_storage_d3b1cb7a))
            BodyText(stringResource(R.string.copy_protected_previews_are_held_in_memo_951bd453),Modifier.padding(vertical=18.dp),center=false)
            SettingRow(stringResource(R.string.copy_clear_previews_7c3c42fd),subtitle=uiContext.getString(R.string.copy_discard_currently_loaded_preview_ima_b99c82d2),icon=Glyph.ANALYTICS) { live.clearImages();state.info(uiContext.getString(R.string.copy_previews_cleared_5b33a690),uiContext.getString(R.string.copy_private_previews_will_be_loaded_agai_697b49ca)) }
        }
        44 -> if(live.accountDeletion!=null || live.repository.accountDeletion!=null)LiveAccountDeletion(state) else if(!live.weakRegisteredSession)LiveGuestDeletion(state) else LivePage(state,uiContext.getString(R.string.copy_export_your_data_726c5cda)) {
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
                SettingRow(row["request_type"] as? String ?: uiContext.getString(R.string.copy_request_82454152),subtitle=listOfNotNull(row["status"] as? String,row["failure_code"] as? String).joinToString(" · "),trailing=if(ready)uiContext.getString(R.string.copy_save_efc007a3) else uiContext.getString(R.string.copy_status_005ef20f),icon=Glyph.EXPORT,modifier=Modifier.padding(bottom=8.dp)) {
                    if(ready) { selectedExport=id;document.launch("lovelies-export-$id.json") }
                    else state.info(uiContext.getString(R.string.copy_request_status_2b321858),listOfNotNull(row["status"] as? String,row["reason"] as? String,row["failure_code"] as? String).joinToString("\n"))
                }
            }
            OutlineButton(stringResource(R.string.copy_refresh_requests_3dc3afd4),enabled=!live.busy) { live.refreshPrivacy() }
            live.error?.let { BodyText(readableError(it.code, uiContext),Modifier.padding(top=12.dp).semantics { liveRegion=LiveRegionMode.Polite },size=13) }
            Spacer(Modifier.weight(1f))
            if(live.privacyExportOperationPending)BodyText(stringResource(R.string.audience_privacy_export_pending),Modifier.padding(vertical=12.dp),center=false,size=13)
            PinkButton(stringResource(if(live.privacyExportOperationPending)R.string.audience_check_export_request else R.string.copy_request_export_cfe37002),enabled=!live.busy) { live.requestExport() }
            OutlineButton(stringResource(R.string.copy_request_account_deletion_faa6919a),Modifier.padding(top=12.dp)) { state.confirm(uiContext.getString(R.string.copy_request_account_deletion_a97861fe),uiContext.getString(R.string.copy_this_sends_your_account_deletion_req_cd4c70b8),uiContext.getString(R.string.copy_request_82454152)) { live.requestDeletion() } }
            Spacer(Modifier.height(18.dp))
        }
        45 -> LivePage(state,uiContext.getString(R.string.copy_help_center_bbf4ae03)) {
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            SectionTitle(stringResource(R.string.copy_how_lovelies_works_964ea584))
            BodyText(stringResource(R.string.copy_register_your_face_using_the_camera_5215d56a),Modifier.padding(vertical=18.dp),center=false)
            SettingRow(stringResource(R.string.copy_photo_preferences_d1ccbb74),icon=Glyph.SHIELD) { state.navigate(40) }
            PolicyRow(state,R.string.privacy_policy,BuildConfig.PRIVACY_POLICY_URL)
            PolicyRow(state,R.string.terms_of_use,BuildConfig.TERMS_URL)
            PolicyRow(state,R.string.account_deletion_help,BuildConfig.DELETION_URL)
            SettingRow(if(live.weakRegisteredSession)uiContext.getString(R.string.audience_privacy_deletion) else if(live.hasGuestDeletion)uiContext.getString(R.string.copy_guest_deletion_status_956e7f23) else uiContext.getString(R.string.copy_delete_guest_account_8e0f6d76),icon=Glyph.SHIELD,
                modifier=Modifier.padding(top=9.dp)) { state.navigate(44) }
            if(BuildConfig.REFERENCE_SCREENS)SettingRow(stringResource(R.string.copy_review_reference_screens_693e2915),subtitle=uiContext.getString(R.string.copy_local_screenshot_fixtures_10e65f7a),icon=Glyph.PHOTO,modifier=Modifier.padding(top=9.dp)) { state.enterReview() }
            if(live.registered) {
                OutlinedTextField(value=live.supportSubject,onValueChange={live.supportSubject=it.take(160);live.persistNavigation()},label={Text(stringResource(R.string.copy_subject_8d183dbd))},modifier=Modifier.fillMaxWidth().padding(top=12.dp),colors=liveFieldColors())
                OutlinedTextField(value=live.supportDetails,onValueChange={live.supportDetails=it.take(4000);live.persistNavigation()},label={Text(stringResource(R.string.copy_how_can_we_help_d9961547))},modifier=Modifier.fillMaxWidth().padding(top=8.dp),minLines=3,colors=liveFieldColors())
                PinkButton(stringResource(R.string.copy_send_support_request_5ebcb06b),Modifier.padding(top=12.dp),enabled=!live.busy && live.supportSubject.trim().length>=3 && live.supportDetails.trim().length>=5) { live.submitSupport() }
                live.supportSubmitted?.let { BodyText(stringResource(R.string.copy_your_support_request_is_saved_9fb2c9cf),Modifier.padding(top=10.dp).semantics { liveRegion=LiveRegionMode.Polite },size=13) }
                live.error?.let { BodyText(readableError(it.code, uiContext),Modifier.padding(top=8.dp),size=13) }
                SectionTitle(stringResource(R.string.copy_your_requests_91d672ff),trailing=uiContext.getString(R.string.copy_refresh_0815aad4),onTrailing=live::refreshSupport)
                Column {
                    live.supportRequests.forEach { row->SettingRow(row["subject"] as? String ?: uiContext.getString(R.string.copy_support_request_b40eff29),subtitle=receiptLabel(row["status"] as? String, uiContext),icon=Glyph.HELP,modifier=Modifier.padding(bottom=8.dp)) {
                        state.info(row["subject"] as? String ?: uiContext.getString(R.string.copy_support_request_b40eff29),listOfNotNull(row["status"] as? String,row["review_notes"] as? String).joinToString("\n"))
                    } }
                }
            }
            }
        }
        46 -> LivePage(state,uiContext.getString(R.string.copy_account_security_fb84c56c)) {
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                SectionTitle(stringResource(R.string.copy_sessions_e11e37a9))
                live.sessions.forEach { row -> SettingRow(if(row["current"]==true)uiContext.getString(R.string.copy_this_session_9a3715bd) else uiContext.getString(R.string.copy_session_2048cc97),subtitle=row["created_at"]?.toString(),trailing=uiContext.getString(R.string.copy_revoke_2219c453),icon=Glyph.LOCK,modifier=Modifier.padding(bottom=8.dp)) {
                    state.confirm(uiContext.getString(R.string.copy_revoke_session_4581739c),uiContext.getString(R.string.copy_the_session_will_lose_access_immedia_2f78f3ab),uiContext.getString(R.string.copy_revoke_2219c453)) { live.revoke(row,false) }
                } }
                if(live.registered) {
                SectionTitle(stringResource(R.string.copy_recovery_key_2e524a4f))
                BodyText(stringResource(R.string.copy_save_a_private_backup_key_to_recove_845d2912),Modifier.padding(vertical=10.dp),size=13)
                live.recoveryKeyMetadata?.let { BodyText(uiContext.getString(R.string.copy_backup_key_available_expires_1_s_eb8db8ed, java.text.DateFormat.getDateInstance(java.text.DateFormat.MEDIUM).format(java.util.Date(it.expiresAt))),size=12) }
                SettingRow(if(live.recoveryKeyMetadata==null)uiContext.getString(R.string.copy_create_recovery_key_97e14983) else uiContext.getString(R.string.copy_create_a_new_recovery_key_e6ba2d0c),icon=Glyph.LOCK,modifier=Modifier.padding(top=9.dp)) {
                    state.confirm(uiContext.getString(R.string.copy_create_recovery_key_d3a712f4),uiContext.getString(R.string.copy_this_replaces_any_previous_recovery__86a443b6),uiContext.getString(R.string.copy_create_990de47d)) { live.generateRecoveryKey(true) }
                }
                if(live.repository.recoveryKeyIntent?.receipt==null && live.repository.recoveryKeyIntent!=null)SettingRow(stringResource(R.string.copy_retry_saved_key_request_c8c5da9e),icon=Glyph.LOCK,modifier=Modifier.padding(top=9.dp)) { live.generateRecoveryKey() }
                if(live.recoveryKeyMetadata!=null) {
                    SettingRow(stringResource(R.string.copy_view_saved_backup_ff31fab2),icon=Glyph.LOCK,modifier=Modifier.padding(top=9.dp)) { live.showRecoveryBackup() }
                    SettingRow(stringResource(R.string.copy_revoke_recovery_key_f01a6d60),icon=Glyph.LOCK,modifier=Modifier.padding(top=9.dp,bottom=12.dp)) {
                        state.confirm(uiContext.getString(R.string.copy_revoke_recovery_key_e4028eee),uiContext.getString(R.string.copy_the_saved_backup_will_stop_working_ac4cfb3a),uiContext.getString(R.string.copy_revoke_2219c453)) { live.revokeRecoveryKey() }
                    }
                }
                }
                live.error?.let { BodyText(readableError(it.code, uiContext),Modifier.padding(vertical=8.dp),size=12) }
                SectionTitle(stringResource(R.string.copy_registered_devices_4faea88f))
                live.devices.forEach { row -> SettingRow(if(row["current"]==true)uiContext.getString(R.string.copy_this_device_8fc5c8b9) else uiContext.getString(R.string.copy_device_bdcbb413),subtitle=row["created_at"]?.toString(),trailing=uiContext.getString(R.string.copy_revoke_2219c453),icon=Glyph.PHONE,modifier=Modifier.padding(bottom=8.dp)) {
                    state.confirm(uiContext.getString(R.string.copy_revoke_device_75522348),uiContext.getString(R.string.copy_this_clears_the_revoked_device_s_aut_fb79e363),uiContext.getString(R.string.copy_revoke_2219c453)) { live.revoke(row,true) }
                } }
            }
            OutlineButton(stringResource(R.string.copy_refresh_status_28a0e95a),Modifier.padding(bottom=12.dp),enabled=!live.busy) { live.refreshOwnSecurity() }
            OutlineButton(stringResource(R.string.audience_title),Modifier.padding(bottom=12.dp),enabled=!live.busy) { live.showAudience() }
            PinkButton(stringResource(R.string.copy_sign_out_61fd08ff),enabled=!live.busy) { live.logout() }
            OutlineButton(stringResource(R.string.copy_sign_out_forget_this_device_82f2999b),Modifier.padding(top=12.dp)) { live.logout(true) };Spacer(Modifier.height(18.dp))
        }
    }
}

@Composable
private fun LiveFaceProfile(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val live=state.live;val meta=live.faceProfile ?: live.repository.faceLifecycle?.metadata;val record=live.repository.faceLifecycle
    LivePage(state,uiContext.getString(R.string.copy_manage_your_face_990044ce)) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()),horizontalAlignment=Alignment.CenterHorizontally) {
            GlowSymbol(Glyph.FACE,Modifier.padding(top=18.dp))
            Text(when { meta==null->uiContext.getString(R.string.copy_your_registered_face_6942c7bb);meta.removal=="completed"->uiContext.getString(R.string.copy_profile_removed_5319ff9e);!meta.authenticationEnabled->uiContext.getString(R.string.copy_face_sign_in_is_off_7110159c);
                meta.matchingPaused->uiContext.getString(R.string.copy_photo_matching_is_paused_9eb0ca28);else->uiContext.getString(R.string.copy_your_registered_face_6942c7bb) },color=Color.White,fontSize=22.sp,
                textAlign=TextAlign.Center,modifier=Modifier.fillMaxWidth().padding(top=20.dp,bottom=14.dp))
            BodyText(stringResource(R.string.copy_face_sign_in_photo_matching_and_upl_c6aedef1),size=13)
            if(meta!=null) {
                SectionTitle(stringResource(R.string.copy_current_status_3aa1d93d))
                BodyText(uiContext.getString(R.string.copy_face_sign_in_1_s_photo_matching_2_s__e3d4c57a, if(meta.authenticationEnabled)uiContext.getString(R.string.copy_on_60e47df0) else uiContext.getString(R.string.copy_off_0dc6b4aa), if(meta.matchingPaused)uiContext.getString(R.string.copy_paused_de281feb) else if(meta.matchingEnabled)uiContext.getString(R.string.copy_on_60e47df0) else uiContext.getString(R.string.copy_off_0dc6b4aa), if(meta.processingEnabled)uiContext.getString(R.string.copy_on_60e47df0) else uiContext.getString(R.string.copy_off_0dc6b4aa)),
                    Modifier.fillMaxWidth().padding(bottom=12.dp),center=false,size=13)
                if(meta.removal!="none")BodyText(when(meta.removal) {
                    "completed"->uiContext.getString(R.string.copy_the_server_verified_that_the_removed_7a755192)
                    "failed"->uiContext.getString(R.string.copy_reference_removal_failed_check_the_s_60c0819e)
                    "blocked"->uiContext.getString(R.string.copy_reference_removal_is_blocked_by_unre_e853cdb8)
                    else->uiContext.getString(R.string.copy_sign_in_and_matching_have_stopped_re_4bb2dc0b)
                },Modifier.fillMaxWidth().padding(bottom=15.dp).semantics { liveRegion=LiveRegionMode.Polite },center=false,size=13)
                if(meta.operation?.cleanup in setOf("pending","failed","blocked") && meta.removal=="none")
                    BodyText(uiContext.getString(R.string.copy_previous_reference_cleanup_1_s_your__cf7ae9bd, meta.operation?.cleanup),Modifier.padding(bottom=12.dp),size=12)
            }
            live.error?.let { BodyText(readableError(it.code, uiContext),Modifier.padding(vertical=12.dp).semantics { liveRegion=LiveRegionMode.Polite },size=13) }
            if(record?.intent!=null || record?.acknowledged==false || record?.loginKey!=null) {
                BodyText(when(record?.state) { "cancelled"->uiContext.getString(R.string.copy_this_change_was_cancelled_by_the_ser_ab7a1099)
                    "registered"->uiContext.getString(R.string.copy_the_profile_update_is_complete_verif_b9f32166)
                    "credentials_pending"->uiContext.getString(R.string.copy_the_server_response_is_saved_current_62fc5991)
                    "restart_required"->uiContext.getString(R.string.copy_fresh_captures_are_required_your_ori_5995322d)
                    "removal_pending"->uiContext.getString(R.string.copy_reference_cleanup_must_finish_before_2e865949)
                    "login_start","login_pending","login_capture_pending","login_completion_pending","login_credentials_pending"->uiContext.getString(R.string.copy_your_original_account_and_key_are_sa_c6917527)
                    else->uiContext.getString(R.string.copy_your_change_is_saved_on_this_device__13c25982) },Modifier.padding(bottom=14.dp),size=13)
                OutlineButton(stringResource(R.string.copy_check_profile_status_a4432f02),enabled=!live.busy) { live.checkFaceProfile() }
                if(record?.state=="cancel_pending")OutlineButton(stringResource(R.string.copy_retry_stop_f7cc0a3e),Modifier.padding(top=10.dp),enabled=!live.busy) { live.retryProfileCancellation() }
                if(record?.intent?.capture==true && record.state!="cancelled")OutlineButton(stringResource(R.string.copy_continue_face_setup_cf156d7e),Modifier.padding(top=10.dp),enabled=!live.busy) { state.navigate(6) }
                if(record?.loginKey!=null)OutlineButton(stringResource(R.string.copy_continue_face_sign_in_51a3763a),Modifier.padding(top=10.dp),enabled=!live.busy) { live.verifyFaceProfile() }
            } else if(meta!=null) {
                if(meta.profile!=null && meta.removal=="none") {
                    SettingRow(if(meta.matchingEnabled)uiContext.getString(R.string.copy_pause_photo_matching_d65803d4) else uiContext.getString(R.string.copy_resume_photo_matching_44bcce85),icon=Glyph.PEOPLE,modifier=Modifier.padding(top=10.dp)) {
                        live.confirmFaceProfile(if(meta.matchingEnabled)"pause" else "resume",if(meta.matchingEnabled)uiContext.getString(R.string.copy_pause_photo_matching_22865fb1) else uiContext.getString(R.string.copy_resume_photo_matching_6a9f7dce),
                            if(meta.matchingEnabled)uiContext.getString(R.string.copy_future_matching_and_receiving_stop_p_da4194ed)
                            else uiContext.getString(R.string.copy_allow_your_face_profile_to_produce_f_1621c5c5),if(meta.matchingEnabled)uiContext.getString(R.string.copy_pause_781961bc) else uiContext.getString(R.string.copy_resume_454d1d8a),meta.version)
                    }
                    if(meta.authenticationEnabled) {
                        SettingRow(stringResource(R.string.copy_replace_face_profile_2fd80a65),icon=Glyph.FACE,modifier=Modifier.padding(top=9.dp)) {
                            live.confirmFaceProfile("replace",uiContext.getString(R.string.copy_replace_your_face_profile_4724deff),uiContext.getString(R.string.copy_take_three_fresh_selfies_to_update_t_8a245ba4),uiContext.getString(R.string.copy_continue_2e026239),meta.version)
                        }
                        SettingRow(stringResource(R.string.copy_withdraw_face_sign_in_consent_b5af30ef),icon=Glyph.LOCK,modifier=Modifier.padding(top=9.dp)) {
                            live.confirmFaceProfile("withdraw_authentication",uiContext.getString(R.string.copy_turn_off_face_sign_in_1a3cd0e4),uiContext.getString(R.string.copy_face_sign_in_will_stop_if_photo_matc_2d06845a),uiContext.getString(R.string.copy_withdraw_1dba6cb7),meta.version)
                        }
                    } else SettingRow(stringResource(R.string.copy_restore_face_sign_in_5364a734),icon=Glyph.LOCK,modifier=Modifier.padding(top=9.dp)) {
                        live.confirmFaceProfile("restore_authentication",uiContext.getString(R.string.copy_restore_face_sign_in_25b662b6),uiContext.getString(R.string.copy_consent_to_use_your_retained_registe_86abc950),uiContext.getString(R.string.copy_continue_2e026239),meta.version)
                    }
                    SettingRow(stringResource(R.string.copy_remove_face_profile_1d28e692),icon=Glyph.SHIELD,modifier=Modifier.padding(top=9.dp)) {
                        live.confirmFaceProfile("remove",uiContext.getString(R.string.copy_remove_your_face_profile_3f840835),uiContext.getString(R.string.copy_face_sign_in_and_matching_stop_your__9ab01cf1),uiContext.getString(R.string.copy_remove_21a5901d),meta.version)
                    }
                }
                if(meta.removal=="completed" && meta.profile==null)SettingRow(stringResource(R.string.copy_set_up_a_new_face_profile_017b2a6f),icon=Glyph.FACE,modifier=Modifier.padding(top=9.dp)) {
                    live.confirmFaceProfile("enroll",uiContext.getString(R.string.copy_set_up_your_face_again_19ccbf4d),uiContext.getString(R.string.copy_consent_to_face_sign_in_using_a_new__e8a100e8),uiContext.getString(R.string.copy_continue_2e026239),meta.version)
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
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val live=state.live
    val record=live.guestDeletion
    val receipt=record?.receipt
    LivePage(state,uiContext.getString(R.string.copy_guest_account_deletion_16fa4c92),back=record==null) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            SectionTitle(if(record==null)uiContext.getString(R.string.copy_your_guest_account_38fc0d51) else uiContext.getString(R.string.copy_deletion_status_0d9813b7))
            val label=when {
                receipt?.completed==true -> deletionLabel(receipt, uiContext)
                record?.statusUnavailable==true -> if(receipt!=null && receipt.expiresAt<=System.currentTimeMillis())uiContext.getString(R.string.copy_status_receipt_expired_4ece7d9e) else uiContext.getString(R.string.copy_status_unavailable_a88256f1)
                receipt!=null -> deletionLabel(receipt, uiContext)
                record!=null -> uiContext.getString(R.string.copy_request_not_confirmed_67a30b5a)
                else -> uiContext.getString(R.string.copy_before_face_setup_8229d88a)
            }
            Text(label,color=Pink,fontSize=20.sp,fontWeight=FontWeight.SemiBold,
                modifier=Modifier.fillMaxWidth().padding(top=22.dp,bottom=14.dp).semantics {
                    contentDescription=uiContext.getString(R.string.copy_deletion_status_1_s_6f48fb52, label);liveRegion=LiveRegionMode.Polite
                })
            val explanation=when {
                receipt?.completed==true -> uiContext.getString(R.string.copy_the_server_has_confirmed_that_this_g_4cf99951)
                record?.statusUnavailable==true -> uiContext.getString(R.string.copy_we_can_t_retrieve_this_request_s_sta_771de513)
                receipt?.requestExpired==true -> uiContext.getString(R.string.copy_the_approval_window_has_ended_this_d_4f9e978d)
                receipt?.status=="rejected" -> uiContext.getString(R.string.copy_the_deletion_request_was_rejected_yo_bbc1ea13)
                receipt?.status=="cancelled" -> uiContext.getString(R.string.copy_the_deletion_request_was_cancelled_y_c140e516)
                receipt?.status=="failed" -> uiContext.getString(R.string.copy_deletion_could_not_finish_check_the__4d983adb)
                receipt?.status=="processing" -> uiContext.getString(R.string.copy_deletion_is_in_progress_completion_w_14c02189)
                receipt!=null -> uiContext.getString(R.string.copy_your_deletion_request_is_saved_for_r_de7a1f60)
                record!=null -> uiContext.getString(R.string.copy_we_couldn_t_confirm_whether_the_requ_62716374)
                else -> uiContext.getString(R.string.copy_request_deletion_of_this_guest_accou_e9092bdc)
            }
            BodyText(explanation,center=false)
            receipt?.let {
                val dateFormat=java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.MEDIUM,java.text.DateFormat.SHORT)
                BodyText(uiContext.getString(R.string.copy_requested_1_s_fb8b4eb6, dateFormat.format(java.util.Date(it.createdAt))),Modifier.padding(top=20.dp),center=false,size=12)
                if(!it.completed)BodyText(uiContext.getString(R.string.copy_approval_window_ends_1_s_614af83f, dateFormat.format(java.util.Date(it.requestExpiresAt))),Modifier.padding(top=10.dp),center=false,size=12)
            }
            live.error?.let { BodyText(when {
                it.code=="deletion_storage_unavailable" -> uiContext.getString(R.string.copy_we_couldn_t_save_this_change_on_your_4333fb07)
                it.code.startsWith("deletion_") -> uiContext.getString(R.string.copy_we_couldn_t_verify_this_account_or_i_7b66c80f)
                else -> readableError(it.code, uiContext)
            },Modifier.padding(top=20.dp),center=false,size=13) }
        }
        when {
            receipt?.completed==true -> PinkButton(stringResource(R.string.copy_start_again_b6fffc5a),enabled=!live.busy) { live.startAgainAfterDeletion() }
            record!=null -> {
                PinkButton(if(live.busy)uiContext.getString(R.string.copy_checking_status_0a0cf7c9) else uiContext.getString(R.string.copy_check_deletion_status_8ebabe97),enabled=!live.busy) { live.checkGuestDeletion() }
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
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val live=state.live
    val blockedIds=live.blocked.map { NativeProtocol.id(it["blocked_id"] ?: it["account_id"] ?: it["id"]) }.toSet()
    val candidates=live.snapshot?.people?.filter { it.id !in blockedIds }?.distinctBy { it.id } ?: emptyList()
    LivePage(state,uiContext.getString(R.string.copy_manage_people_a3539654)) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            BodyText(stringResource(R.string.copy_matched_people_are_allowed_by_defau_1cb367d3),
                Modifier.padding(top=8.dp,bottom=16.dp),center=false,size=12)
            SectionTitle(uiContext.getString(R.string.copy_blocked_1_s_1ca562ff, blockedIds.size))
            if(live.blocked.isEmpty())BodyText(stringResource(R.string.copy_no_blocked_people_dd602f71),Modifier.padding(vertical=22.dp))
            live.blocked.distinctBy { NativeProtocol.id(it["blocked_id"] ?: it["account_id"] ?: it["id"]) }.forEach { row ->
                val name=row["name"] as? String ?: uiContext.getString(R.string.copy_blocked_person_5a9da67c)
                SettingRow(name,trailing=uiContext.getString(R.string.copy_unblock_987c7d5f),icon=Glyph.PERSON,modifier=Modifier.padding(bottom=9.dp)) {
                    state.confirm(uiContext.getString(R.string.copy_unblock_1_s_c3b505af, name),uiContext.getString(R.string.copy_this_allows_future_matching_and_shar_c3e02010),uiContext.getString(R.string.copy_unblock_987c7d5f)) {
                        live.block(NativeProtocol.id(row["blocked_id"] ?: row["account_id"] ?: row["id"]),false)
                    }
                }
            }
            SectionTitle(uiContext.getString(R.string.copy_matched_in_current_review_1_s_9b0006f9, candidates.size))
            if(live.snapshot==null)BodyText(stringResource(R.string.copy_open_a_photo_review_to_see_its_matc_18b4a6ae),
                Modifier.padding(vertical=12.dp),center=false,size=12)
            candidates.forEach { person -> SettingRow(person.name,subtitle=uiContext.getString(R.string.copy_can_share_with_09eae50e),trailing=uiContext.getString(R.string.copy_block_bd074002),icon=Glyph.PERSON,modifier=Modifier.padding(bottom=9.dp)) {
                state.confirm(uiContext.getString(R.string.copy_block_1_s_b717d02e, person.name),uiContext.getString(R.string.copy_this_blocks_sharing_between_your_acc_40a49682),uiContext.getString(R.string.copy_block_bd074002)) { live.block(person.id,true) }
            } }
        }
    }
}

@Composable
private fun LiveEmpty(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    LivePage(state,"",back=false,bottom=10) {
        Spacer(Modifier.weight(1f));SourceHero("empty-hero.png",.598f,152f/144f)
        Text(if(state.live.photos.isEmpty())uiContext.getString(R.string.copy_your_memories_start_here_8fe02f19) else uiContext.getString(R.string.copy_no_matches_yet_f0a5aa4d),color=Color.White,fontSize=23.sp,modifier=Modifier.align(Alignment.CenterHorizontally).padding(top=25.dp))
        BodyText(if(state.live.photos.isEmpty())uiContext.getString(R.string.copy_add_photos_to_find_the_people_in_you_3a83dc90) else uiContext.getString(R.string.copy_only_currently_eligible_matches_appe_4ffd75fa),Modifier.padding(top=12.dp))
        Spacer(Modifier.weight(1f));PinkButton(stringResource(R.string.copy_add_photos_be917560)) { state.navigate(19) }
        OutlineButton(stringResource(R.string.copy_photo_preferences_d1ccbb74),Modifier.padding(top=12.dp)) { state.navigate(40) };Spacer(Modifier.height(18.dp))
    }
}

@Composable
private fun LiveError(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val live=state.live;val problem=live.error
    LivePage(state,uiContext.getString(R.string.copy_something_went_wrong_76fc465e)) {
        Spacer(Modifier.weight(1f));SourceHero("offline-hero.png",.504f,128f/93f)
        Text(stringResource(R.string.copy_let_s_try_again_c201e419),color=Color.White,fontSize=24.sp,modifier=Modifier.align(Alignment.CenterHorizontally).padding(top=25.dp))
        BodyText(readableError(problem?.code ?: "connection_unavailable", uiContext),Modifier.padding(top=15.dp))
        if(live.repository.pending!=null)BodyText(stringResource(R.string.copy_a_saved_operation_needs_reconciliat_f323e585),Modifier.padding(top=15.dp),size=12)
        Spacer(Modifier.weight(1f))
        if(live.repository.pending?.action=="sharing.commit") {
            PinkButton(stringResource(R.string.copy_check_share_status_9e34c4e7),enabled=!live.busy) { live.reconcileShare() }
            OutlineButton(stringResource(R.string.copy_retry_original_share_b4d52f73),Modifier.padding(top=12.dp),enabled=!live.busy) { live.retryPending() }
        } else PinkButton(stringResource(R.string.copy_try_again_cef2fe09),enabled=!live.busy) { live.retryPending() }
        if(problem?.code?.contains("consent")==true)OutlineButton(stringResource(R.string.copy_photo_preferences_d1ccbb74),Modifier.padding(top=12.dp)) { state.navigate(40) }
        else OutlineButton(if(live.registered)uiContext.getString(R.string.copy_back_to_photos_b080279d) else uiContext.getString(R.string.copy_back_to_setup_a1564152),Modifier.padding(top=12.dp)) { state.navigate(if(live.registered)13 else 5) }
        Spacer(Modifier.height(18.dp))
    }
}

@Composable
private fun LivePhotoGrid(live: LiveController,photos: List<LivePhoto>,modifier: Modifier,columns: Int=3,selections: Set<String>?=null,route: Int?=null,onClick: (LivePhoto)->Unit) {
    val fallbackTitle=stringResource(R.string.copy_photo_53219983)
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
                .semantics { contentDescription=displayedPhotoTitle(photo,fallbackTitle) }) {
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
    var lease by remember(photo.id,photo.version) { mutableStateOf<PrivatePreviewLease?>(null) }
    var producer by remember(photo.id,photo.version) { mutableStateOf<Any?>(null) }
    val generation=live.mediaGeneration;val active=live.foregroundActive;val registered=live.registered
    val scope=live.repository.currentScope();val actor=live.repository.credentials
    val audienceDeadline=minOf(live.audience?.nextReview ?: Long.MAX_VALUE,
        if(live.audience?.band=="13_17")live.audience?.request?.expires ?: 0 else Long.MAX_VALUE)
    LaunchedEffect(photo.id,photo.version,generation,active,registered,scope,actor?.token,audienceDeadline) {
        val owned=Any();producer=owned;bitmap=null;lease=null;failed=false
        if(active && registered)try {
            val permit=PrivatePreviewLease.create(scope,actor,System.currentTimeMillis(),android.os.SystemClock.elapsedRealtime(),audienceDeadline)
                ?: throw LiveFailure("session_expired")
            val decoded=withContext(Dispatchers.IO) {
                val bytes=live.repository.preview(photo)
                try {
                    live.repository.fence.assert(scope)
                    if(permit.remaining(live.repository.currentScope(),live.repository.credentials,System.currentTimeMillis(),android.os.SystemClock.elapsedRealtime())<=0)
                        throw LiveFailure("session_expired")
                    decodePhoto(bytes)
                } finally { bytes.fill(0) }
            }
            live.repository.fence.assert(scope)
            if(producer===owned && live.foregroundActive && live.registered && generation==live.mediaGeneration &&
                permit.remaining(live.repository.currentScope(),live.repository.credentials,System.currentTimeMillis(),android.os.SystemClock.elapsedRealtime())>0) {
                lease=permit;bitmap=decoded
                awaitPrivatePreviewExpiry(permit,live.repository::currentScope,{live.repository.credentials},System::currentTimeMillis,android.os.SystemClock::elapsedRealtime)
                if(producer===owned) { bitmap=null;lease=null }
            }
        } catch(problem: kotlinx.coroutines.CancellationException) { throw problem }
        catch(problem: Exception) { if(producer===owned)failed=true }
        finally { if(producer===owned) { bitmap=null;lease=null } }
    }
    DisposableEffect(photo.id,photo.version) { onDispose { producer=null;bitmap=null;lease=null } }
    Box(modifier.background(Panel),contentAlignment=Alignment.Center) {
        if(active && registered && bitmap!=null && lease?.remaining(live.repository.currentScope(),live.repository.credentials,
                System.currentTimeMillis(),android.os.SystemClock.elapsedRealtime())?.let { it>0 }==true)
            Image(bitmap!!.asImageBitmap(),contentDescription=null,modifier=Modifier.fillMaxSize(),contentScale=scale)
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
private fun LiveToggle(title: String,subtitle: String?,checked: Boolean,enabled: Boolean=true,onChange: ()->Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min=48.dp).toggleable(checked,enabled=enabled,role=Role.Switch,onValueChange={onChange()}).padding(vertical=17.dp),verticalAlignment=Alignment.CenterVertically) {
        Column(Modifier.weight(1f).padding(end=14.dp)) { Text(title,color=Color.White,fontSize=15.sp);if(subtitle!=null)Text(subtitle,color=Muted,fontSize=12.sp,modifier=Modifier.padding(top=6.dp)) }
        PinkToggle(checked,title,interactive=false,onToggle=onChange)
    }
    DividerLine()
}

/** Localize only parser-generated labels; provided titles remain user/provider text. */
internal fun displayedPhotoTitle(photo: LivePhoto,fallback: String): String = if(photo.titleDefaulted)fallback else photo.title

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
private fun receiptLabel(status: String?, context: android.content.Context)=when(status){"open"->context.getString(R.string.copy_open_538b10e9);"under_review"->context.getString(R.string.copy_under_review_07000a6f);"resolved"->context.getString(R.string.copy_resolved_503b5525);"closed"->context.getString(R.string.copy_closed_3201cae5);"requested"->context.getString(R.string.copy_awaiting_acceptance_383a8dc6);"accepted"->context.getString(R.string.copy_accepted_41d09a60);"declined"->context.getString(R.string.copy_declined_56d6cf67);"withdrawn"->context.getString(R.string.copy_withdrawn_a579599b);"revoked"->context.getString(R.string.copy_revoked_e58fe295);"expired"->context.getString(R.string.copy_expired_bca9f3d2);"failed"->context.getString(R.string.copy_failed_5579c3d4);else->context.getString(R.string.copy_unavailable_da4baaa9)}
internal fun readableError(code: String, context: android.content.Context)=when(code) {
    "database_schema_not_ready"->context.getString(R.string.service_temporarily_unavailable)
    "audience_required","audience_choice_required"->context.getString(R.string.audience_choose_age)
    "audience_status_required"->context.getString(R.string.audience_check_required)
    "age_not_supported"->context.getString(R.string.audience_under13_blocked)
    "guardian_approval_required"->context.getString(R.string.audience_guardian_pending)
    "audience_version_changed","guardian_revision_changed","audience_policy_changed","audience_age_review_required"->context.getString(R.string.audience_details_changed)
    "guardian_withdrawal_pending"->context.getString(R.string.audience_withdrawal_pending)
    "audience_operation_pending"->context.getString(R.string.audience_saved_change)
    "operation_key_conflict"->context.getString(R.string.audience_operation_conflict)
    "privacy_operation_scope_changed","weak_route_not_allowed","guardian_reference_scope_changed"->context.getString(R.string.audience_response_error)
    "audience_response_invalid","audience_operation_scope_changed","audience_authority_expired"->context.getString(R.string.audience_response_error)
    "guardian_request_unavailable"->context.getString(R.string.audience_request_unavailable)
    "guardian_request_active"->context.getString(R.string.audience_request_active)
    "guardian_adult_required","guardian_independent_review_required","guardian_evidence_required"->context.getString(R.string.audience_review_required)
    "face_capture_no_face","face_capture_multiple_faces","face_capture_quality_low","face_capture_invalid_image",
    "camera_permission_required","camera_initialization_timeout","camera_disconnected","camera_surface_replaced","camera_unavailable",
    "capture_failed","capture_timeout","camera_review_expired","capture_context_changed","camera_image_invalid","capture_too_large","capture_format_invalid"->cameraRecoveryMessage(code, context)
    "face_login_in_flight"->context.getString(R.string.copy_your_previous_sign_in_photo_may_stil_33f6b717)
    "face_login_requires_status","face_login_scope_changed","face_login_response_changed"->context.getString(R.string.copy_the_saved_sign_in_must_be_recovered__afb5a08a)
    "face_profile_in_flight"->context.getString(R.string.copy_a_capture_or_verification_is_still_i_50b0c48e)
    "face_profile_requires_status","face_profile_cancel_pending"->context.getString(R.string.copy_check_the_saved_profile_change_befor_c61cf3ee)
    "face_profile_control_requires_login"->context.getString(R.string.copy_verify_your_registered_face_to_finis_b36dcc32)
    "face_profile_control_unavailable"->context.getString(R.string.copy_profile_management_is_unavailable_if_1533cd6e)
    "face_profile_control_not_expired"->context.getString(R.string.copy_this_private_control_is_still_curren_39f6c865)
    "face_profile_login_pending"->context.getString(R.string.copy_continue_the_saved_fresh_face_sign_i_8d6d27e3)
    "face_profile_cleanup_pending"->context.getString(R.string.copy_reference_removal_has_not_been_verif_714074ee)
    "face_profile_reference_unavailable"->context.getString(R.string.copy_there_is_no_retained_active_referenc_c6c128a9)
    "face_profile_version_changed","face_profile_response_changed","face_profile_scope_changed","face_profile_capture_changed"->context.getString(R.string.copy_the_saved_profile_authority_changed__dddac648)
    "face_profile_storage_unavailable"->context.getString(R.string.copy_the_saved_profile_change_could_not_b_f00ca8a0)
    "api_endpoint_unconfigured"->context.getString(R.string.copy_configure_the_api_endpoint_for_this__4dab19dd)
    "connection_unavailable","server_unavailable"->context.getString(R.string.copy_the_service_could_not_be_reached_che_c5ec8359)
    "account_recovery_account_changed"->context.getString(R.string.copy_this_device_holds_setup_or_identity__847362bb)
    "account_recovery_sign_out_required"->context.getString(R.string.copy_sign_out_of_the_current_account_befo_76ba54b7)
    "account_recovery_history_full"->context.getString(R.string.copy_saved_recovery_history_is_full_no_pr_27b01244)
    "account_recovery_in_flight"->context.getString(R.string.copy_your_recovery_photo_is_still_being_c_4148bae5)
    "recovery_backup_invalid"->context.getString(R.string.copy_enter_the_full_saved_recovery_backup_74202c35)
    "recovery_backup_unavailable"->context.getString(R.string.copy_this_device_does_not_have_that_priva_e6e12835)
    "account_recovery_unavailable","recovery_key_unavailable"->context.getString(R.string.copy_that_recovery_key_is_unavailable_you_89655f7d)
    "account_recovery_storage_unavailable"->context.getString(R.string.copy_we_couldn_t_save_recovery_on_this_de_691c435b)
    "account_recovery_requires_status"->context.getString(R.string.copy_check_the_saved_account_recovery_req_4fb7039d)
    "account_recovery_response_changed","account_recovery_scope_changed","account_recovery_capture_changed","recovery_key_response_changed"->context.getString(R.string.copy_the_recovery_response_did_not_match__abd1becc)
    "enrollment_in_flight"->context.getString(R.string.copy_your_previous_photo_is_still_being_c_91d76a07)
    "enrollment_storage_unavailable"->context.getString(R.string.copy_we_couldn_t_save_your_setup_on_this__1353ab13)
    "device_key_unavailable"->context.getString(R.string.copy_the_original_device_key_is_unavailab_1cfb970c)
    "enrollment_recovery_unavailable","enrollment_account_unavailable"->context.getString(R.string.copy_we_couldn_t_recover_this_account_s_s_defba5a8)
    "enrollment_response_changed","enrollment_capture_changed","enrollment_scope_changed","capture_acknowledgement_changed"->context.getString(R.string.copy_your_saved_setup_no_longer_matches_t_e2db2d73)
    "enrollment_requires_recovery"->context.getString(R.string.copy_recover_your_existing_face_setup_bef_7327a774)
    "face_verifier_unavailable","face_authentication_unavailable"->context.getString(R.string.copy_face_verification_is_unavailable_try_9c586f7d)
    "processing_consent_required"->context.getString(R.string.copy_enable_photo_processing_in_photo_pre_92d160cc)
    "session_changed","registered_face_required","authentication_required"->context.getString(R.string.copy_your_session_changed_verify_your_fac_f11c472f)
    "face_comparison_failed","face_registration_mismatch"->context.getString(R.string.copy_the_face_could_not_be_verified_retak_b10f4fff)
    "review_changed","review_expired","eligibility_changed_review_required"->context.getString(R.string.copy_matches_or_permissions_changed_open__6586ed5d)
    "upload_storage_full","upload_storage_unavailable"->context.getString(R.string.copy_your_upload_is_saved_free_device_sto_0bcbaa85)
    "upload_source_changed","upload_source_unavailable"->context.getString(R.string.copy_the_saved_photo_is_unavailable_or_ch_c66a0797)
    "upload_account_changed","upload_scope_changed","upload_progress_changed"->context.getString(R.string.copy_this_upload_does_not_match_your_curr_4e4a5549)
    "upload_expired"->context.getString(R.string.copy_this_unfinished_upload_expired_cance_4c696053)
    "upload_finalizing"->context.getString(R.string.copy_your_photo_bytes_are_saved_resume_to_5977ef4c)
    "upload_paused"->context.getString(R.string.copy_upload_paused_resume_when_you_are_re_40f62dd7)
    "image_too_large"->context.getString(R.string.copy_choose_a_photo_smaller_than_20_mb_2ab694a3)
    "processing_pending"->context.getString(R.string.copy_processing_is_still_pending_check_yo_fbeccb6c)
    else->code.replace('_',' ').replaceFirstChar { it.uppercase() }
}

@Composable private fun liveFieldColors()=TextFieldDefaults.outlinedTextFieldColors(textColor=Color.White,focusedBorderColor=Pink,unfocusedBorderColor=Hairline,cursorColor=Pink)

@Composable private fun PurchaseDialog(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val live=state.live
    if(!live.purchaseVisible)return
    val context=LocalContext.current
    val activity=remember(context) { generateSequence(context) { (it as? android.content.ContextWrapper)?.baseContext }.filterIsInstance<android.app.Activity>().firstOrNull() }
    val billing=live.purchases
    AlertDialog(onDismissRequest=live::dismissPurchases,backgroundColor=Panel,shape=RoundedCornerShape(24.dp),
        title={Text(stringResource(R.string.copy_original_photo_access_fe8275e8),color=Color.White)},text={Column(Modifier.verticalScroll(rememberScrollState())) {
            BodyText(stringResource(R.string.copy_a_verified_subscription_is_required_6773aca5),center=false,size=13)
            billing.plans.forEach { plan->OutlineButton(uiContext.getString(R.string.photo_status, plan.title, plan.terms),Modifier.padding(top=12.dp),enabled=!billing.busy && activity!=null) { activity?.let { billing.purchase(it,plan.token) } } }
            if(billing.status.isNotBlank())BodyText(billing.status,Modifier.padding(top=14.dp).semantics { liveRegion=LiveRegionMode.Polite },center=false,size=12)
        }},confirmButton={TextButton(enabled=!billing.busy,onClick=billing::restore) { Text(stringResource(R.string.copy_restore_purchases_2d557413),color=Pink) }},dismissButton={TextButton(onClick=live::dismissPurchases) { Text(stringResource(R.string.copy_close_bbfa773e),color=Muted) }})
}

@Composable private fun LiveAccountDeletion(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val live=state.live;val record=live.accountDeletion ?: live.repository.accountDeletion;val receipt=record?.receipt
    LivePage(state,uiContext.getString(R.string.copy_account_deletion_060c2086),back=false) {
        Text(receipt?.let { deletionLabel(it, uiContext) } ?: uiContext.getString(R.string.copy_checking_your_original_deletion_requ_640a6e02),color=Pink,fontSize=22.sp,modifier=Modifier.padding(vertical=22.dp).semantics { liveRegion=LiveRegionMode.Polite })
        BodyText(if(receipt?.completed==true)uiContext.getString(R.string.copy_the_server_confirmed_account_cleanup_3edcd640)
            else uiContext.getString(R.string.copy_your_original_deletion_request_is_sa_c2bdda20),center=false)
        receipt?.failureCode?.let { BodyText(readableError(it, uiContext),Modifier.padding(top=12.dp),center=false) }
        live.error?.let { BodyText(readableError(it.code, uiContext),Modifier.padding(top=12.dp),center=false) }
        Spacer(Modifier.weight(1f))
        PinkButton(stringResource(R.string.copy_check_status_99f3765b),enabled=!live.busy) { live.checkAccountDeletion() }
        if(receipt?.completed==true)OutlineButton(stringResource(R.string.copy_start_again_1721c828),Modifier.padding(top=12.dp),enabled=!live.busy) { live.restartAfterAccountDeletion() }
        else if(receipt?.requestExpired==true || receipt?.status in setOf("rejected","cancelled"))OutlineButton(stringResource(R.string.copy_return_to_my_account_1e0b386e),Modifier.padding(top=12.dp),enabled=!live.busy) { live.resumeAfterAccountDeletion() }
        Spacer(Modifier.height(18.dp))
    }
}

private fun deletionLabel(receipt: GuestDeletionReceipt, context: android.content.Context): String = if(receipt.requestExpired) context.getString(R.string.copy_request_expired_ffac6bd7) else when(receipt.status) {
    "pending_approval" -> context.getString(R.string.copy_awaiting_review_631e79b5)
    "approved" -> context.getString(R.string.copy_approved_c699109a)
    "queued" -> context.getString(R.string.copy_deletion_queued_33b2465c)
    "processing" -> context.getString(R.string.copy_deleting_account_6750fcb2)
    "completed" -> context.getString(R.string.copy_account_deleted_9c9a92a1)
    "rejected" -> context.getString(R.string.copy_request_rejected_8ccc55ac)
    "failed" -> context.getString(R.string.copy_deletion_could_not_finish_1435333a)
    else -> context.getString(R.string.copy_request_cancelled_166d7001)
}
