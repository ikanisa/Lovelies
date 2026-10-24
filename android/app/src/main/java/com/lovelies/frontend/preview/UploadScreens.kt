package com.lovelies.frontend.preview

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay

/** Provider names are choices in the system pickers, not linked Lovelies accounts. */
enum class UploadSourceChoice(val title: String, val subtitleRes: Int, val icon: Glyph) {
    DEVICE("From This Device", R.string.copy_browse_your_photos_3024642f, Glyph.PHONE),
    ALBUMS("From Albums", R.string.copy_choose_specific_albums_7962fd6c, Glyph.ALBUM),
    FILES("From Files", R.string.copy_import_from_your_files_bb2cf050, Glyph.FILE),
    CAMERA("Take a Photo", R.string.copy_use_your_camera_85d6413e, Glyph.CAMERA),
    GOOGLE_PHOTOS("Google Photos", R.string.copy_choose_with_android_photo_picker_de2596e3, Glyph.PHOTO),
    GOOGLE_DRIVE("Google Drive", R.string.copy_browse_with_android_file_picker_6901b2e2, Glyph.FILE),
    DROPBOX("Dropbox", R.string.copy_browse_with_android_file_picker_6901b2e2, Glyph.FILE),
    ONEDRIVE("OneDrive", R.string.copy_browse_with_android_file_picker_6901b2e2, Glyph.FILE)
}

@Composable
fun UploadSourceList(modifier: Modifier = Modifier, preview: Boolean = false,
    onChoose: (UploadSourceChoice) -> Unit) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Column(modifier.verticalScroll(rememberScrollState()).padding(top = 4.dp, bottom = 20.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        val groups = listOf(
            uiContext.getString(R.string.copy_photo_libraries_752e4b70) to listOf(UploadSourceChoice.DEVICE, UploadSourceChoice.GOOGLE_PHOTOS),
            uiContext.getString(R.string.copy_cloud_storage_f4a5935f) to listOf(UploadSourceChoice.GOOGLE_DRIVE, UploadSourceChoice.DROPBOX, UploadSourceChoice.ONEDRIVE),
            uiContext.getString(R.string.copy_more_ways_f284b5a4) to listOf(UploadSourceChoice.ALBUMS, UploadSourceChoice.FILES, UploadSourceChoice.CAMERA))
        groups.forEachIndexed { index, (title, sources) ->
            Text(title, color = Muted, fontSize = 11.sp, fontWeight = FontWeight.Medium,
                modifier = Modifier.padding(top = if(index == 0)4.dp else 12.dp, bottom = 3.dp))
            sources.forEach { source -> UploadSourceRow(source) { onChoose(source) } }
        }
        Text(if(preview)uiContext.getString(R.string.copy_preview_choices_use_local_sample_pho_70fe2982)
            else uiContext.getString(R.string.copy_cloud_sources_appear_when_available__ee422ac0),
            color = Muted, fontSize = 12.sp, lineHeight = 17.sp,
            modifier = Modifier.padding(top = 3.dp))
    }
}

@Composable
private fun UploadSourceRow(source: UploadSourceChoice, onChoose: () -> Unit) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val title=choiceLabel(uiContext,source.title)
    val subtitle=uiContext.getString(source.subtitleRes)
    Row(Modifier.fillMaxWidth().heightIn(min = 60.dp).clip(RoundedCornerShape(13.dp))
        .background(Panel).clickable(role = Role.Button, onClick = onChoose)
        .semantics { contentDescription=uiContext.getString(R.string.copy_1_s_2_s_70b33c0c, title, subtitle) }
        .padding(horizontal = 15.dp, vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
        AppIcon(source.icon, Modifier.size(24.dp))
        Spacer(Modifier.width(16.dp))
        Column(Modifier.weight(1f).clearAndSetSemantics { }) {
            Text(title, color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Medium)
            Text(subtitle, color = Muted, fontSize = 12.sp, modifier = Modifier.padding(top = 3.dp))
        }
        AppIcon(Glyph.BACK, Modifier.padding(start = 6.dp).size(16.dp)
            .graphicsLayer { rotationZ = 180f }, Muted)
    }
}

@Composable
fun UploadScreen(state: PreviewState) {
    when(state.route) {
        19 -> UploadEntry(state)
        20 -> UploadSources(state)
        21 -> UploadSelection(state)
        22 -> ReviewUpload(state)
        23 -> UploadProgress(state)
        24 -> UploadComplete(state)
    }
}

@Composable
private fun UploadEntry(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Column(Modifier.fillMaxSize().padding(horizontal = 21.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        ScreenHeader(uiContext.getString(R.string.add_photos), onBack = state::back, leading = Glyph.CLOSE)
        Spacer(Modifier.weight(.6f))
        Asset("photo-heart.png", Modifier.fillMaxWidth(.6f).height(216.dp), scale = ContentScale.Fit)
        Text(uiContext.getString(R.string.copy_add_your_photos_to_find_their_people_8adbcde5), color = Color.White, fontSize = 20.sp,
            lineHeight = 26.sp, textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            modifier = Modifier.padding(top = 20.dp))
        Spacer(Modifier.weight(.7f))
        Row(Modifier.fillMaxWidth().padding(bottom = 26.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            listOf(uiContext.getString(R.string.copy_device_bdcbb413) to Glyph.PHOTO, uiContext.getString(R.string.copy_albums_5c7535ed) to Glyph.ALBUM, uiContext.getString(R.string.copy_files_e71d1b30) to Glyph.FILE, uiContext.getString(R.string.copy_camera_e74c7b6e) to Glyph.CAMERA).forEachIndexed { index,(label,icon) ->
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Box(Modifier.size(63.dp).clip(CircleShape).background(if(index == 0)Pink else Panel)
                        .clickable(role = Role.Button) { state.navigate(20) }.semantics { contentDescription = label }, contentAlignment = Alignment.Center) {
                        AppIcon(icon,Modifier.size(27.dp),if(index == 0)Color.White else Muted)
                    }
                    Text(label,color = if(index == 0)SoftPink else Color.White,fontSize = 13.sp,modifier = Modifier.padding(top = 8.dp))
                }
            }
        }
    }
}

@Composable
private fun UploadSources(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
        ScreenHeader(uiContext.getString(R.string.copy_choose_source_8bc9b333), onBack = state::back, leading = Glyph.CLOSE)
        UploadSourceList(Modifier.weight(1f), preview = true) { source ->
            state.uploadSource = source.title
            state.navigate(21, seed = true)
        }
    }
}

@Composable
private fun UploadSelection(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Column(Modifier.fillMaxSize().padding(horizontal = 11.dp)) {
        Row(Modifier.fillMaxWidth().heightIn(min=61.dp),verticalAlignment = Alignment.CenterVertically) {
            Text(uiContext.getString(R.string.copy_cancel_77dfd213),color = SoftPink,fontSize = 14.sp,modifier = Modifier.heightIn(min=48.dp).clickable(role = Role.Button) { state.navigate(20) }.padding(12.dp))
            Text(uiContext.getString(R.string.copy_1_s_selected_35eec3bf, state.selectedUpload.size),color = Color.White,fontSize = 16.sp,fontWeight = FontWeight.Medium,textAlign=androidx.compose.ui.text.style.TextAlign.Center,modifier=Modifier.weight(1f).semantics { liveRegion=LiveRegionMode.Polite })
            Box(Modifier.heightIn(min=48.dp).clip(CircleShape).background(Panel).clickable(enabled = state.selectedUpload.isNotEmpty(),role = Role.Button) {
                state.navigate(22)
            }.padding(horizontal = 15.dp,vertical = 8.dp)) { Text(uiContext.getString(R.string.next),color = if(state.selectedUpload.isNotEmpty())SoftPink else Muted,fontSize = 14.sp) }
        }
        Text(uiContext.getString(R.string.copy_1_s_local_sample_photos_999ae3d3, choiceLabel(uiContext,state.uploadSource)), color = Muted, fontSize = 12.sp,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 7.dp))
        if(state.referenceGrids.containsKey(21))SourcePhotoGrid(state,21,Modifier.weight(1f),selectable = true,
            selections = state.selectedUpload,onPhotoClick = { index,_ -> state.toggleUpload(index) })
        else PhotoGrid(state,Modifier.weight(1f),photos = listOf(9,5,0,2,15,10,4,8,16,6,17,11,12,3,7,1,13,14),
            selectable = true,selections = state.selectedUpload,onPhotoClick = state::toggleUpload)
    }
}

@Composable
private fun ReviewUpload(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
        ScreenHeader(uiContext.getString(R.string.copy_review_upload_da9297a6),onBack = state::back)
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()),verticalArrangement = Arrangement.spacedBy(15.dp)) {
            Text(uiContext.getString(R.string.copy_1_s_local_sample_photos_999ae3d3, choiceLabel(uiContext,state.uploadSource)), color = Muted, fontSize = 12.sp)
            Row(Modifier.fillMaxWidth().height(89.dp),horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                state.selectedUpload.take(5).forEach { index ->
                    Asset(photoAsset(index),Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(8.dp))
                        .clickable(role = Role.Button) { state.navigate(21) },uiContext.getString(R.string.copy_selected_photo_1_s_aecbd2eb, index + 1))
                }
                if(state.selectedUpload.size > 5) Box(Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(8.dp)).background(Panel)
                    .clickable(role = Role.Button) { state.navigate(21) },contentAlignment = Alignment.Center) {
                    Text("+${state.selectedUpload.size - 5}",color = Color.White,fontSize = 16.sp)
                }
            }
            BasicTextField(value = state.caption,onValueChange = { state.caption = it },
                textStyle = TextStyle(color = Color.White,fontSize = 14.sp),cursorBrush = SolidColor(Pink),
                modifier = Modifier.fillMaxWidth().heightIn(min=57.dp).clip(RoundedCornerShape(14.dp)).background(Panel)
                    .padding(16.dp).semantics { contentDescription = uiContext.getString(R.string.copy_add_a_caption_optional_983ae84d) },
                decorationBox = { inner -> if(state.caption.isEmpty())Text(uiContext.getString(R.string.copy_add_a_caption_optional_e61d9040),color = Muted,fontSize = 14.sp);inner() })
            SettingRow(uiContext.getString(R.string.copy_add_to_album_080d1bb6),icon = Glyph.PHOTO,trailing = state.uploadAlbum) {
                state.confirm(uiContext.getString(R.string.copy_add_to_album_080d1bb6),uiContext.getString(R.string.copy_add_these_photos_to_your_1_s_album_fe53c7f6, "Summer Memories"),"Summer Memories") { state.uploadAlbum = "Summer Memories" }
            }
            SettingRow(uiContext.getString(R.string.copy_who_can_see_these_ca1980fe),icon = Glyph.LOCK,trailing = choiceLabel(uiContext,state.visibility)) {
                state.confirm(uiContext.getString(R.string.copy_photo_visibility_f5b20781),uiContext.getString(R.string.copy_photo_access_requires_your_approval__25294c49),uiContext.getString(R.string.copy_approved_recipients_a3d21a9a)) {
                    state.visibility = "Approved recipients"
                }
            }
            Text(uiContext.resources.getQuantityString(R.plurals.copy_upload_ready_count, state.selectedUpload.size, state.selectedUpload.size),color = Muted,fontSize = 12.sp,
                modifier = Modifier.padding(top = 2.dp))
        }
        PinkButton(uiContext.getString(R.string.copy_start_upload_ae78e1e4),Modifier.padding(top = 18.dp,bottom = 20.dp),enabled = state.selectedUpload.isNotEmpty()) { state.navigate(23) }
    }
}

@Composable
private fun UploadProgress(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    var step by remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) {
        if(!state.reviewMode) {
            repeat(6) { delay(1000);step++ }
            if(state.route == 23)state.navigate(24)
        }
    }
    Column(Modifier.fillMaxSize().padding(horizontal = 17.dp)) {
        ScreenHeader(uiContext.getString(R.string.copy_uploading_dfcc9e32),onBack = { state.navigate(22) },leading = Glyph.CLOSE)
        if(state.reviewMode)BodyText(stringResource(R.string.a11y_preview_paused),Modifier.padding(vertical=8.dp).semantics { liveRegion=LiveRegionMode.Polite },size=12)
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            listOf(4,9,15,3,0).forEachIndexed { index,photo ->
                Row(Modifier.fillMaxWidth().heightIn(min=66.dp).padding(vertical=6.dp),verticalAlignment = Alignment.CenterVertically) {
                    Asset(photoAsset(photo),Modifier.width(47.dp).height(58.dp).clip(RoundedCornerShape(7.dp)))
                    Spacer(Modifier.width(13.dp))
                    Column(Modifier.weight(1f)) {
                        Text("IMG_${2931 + index}.${if(index == 2)"MOV" else"JPG"}",color = Color.White,fontSize = 14.sp)
                        val progress = listOf(.78f,.42f,.65f,0f,0f)[index]
                        Text(if(progress > 0f)if(index == 2)uiContext.getString(R.string.copy_processing_0b398004) else uiContext.getString(R.string.copy_uploading_1_s_5f44088f, (progress * 100).toInt()) else uiContext.getString(R.string.copy_waiting_0658762e),
                            color = Muted,fontSize = 12.sp,modifier = Modifier.padding(top = 5.dp))
                        Box(Modifier.padding(top = 9.dp).fillMaxWidth().height(5.dp).clip(CircleShape).background(Hairline)) {
                            if(progress > 0f)Box(Modifier.fillMaxWidth((progress + step*.025f).coerceAtMost(1f)).fillMaxHeight().background(Pink))
                        }
                    }
                    Spacer(Modifier.width(17.dp))
                    Box(Modifier.size(19.dp).clip(CircleShape).background(Color.Transparent)
                        .then(Modifier.border(2.dp,if(index < 3)Pink else Hairline,CircleShape)))
                }
                DividerLine()
            }
        }
        if(state.reviewMode)PinkButton(stringResource(R.string.a11y_continue_preview),Modifier.padding(top=12.dp,bottom=12.dp)) { state.navigate(24) }
    }
}

@Composable
private fun UploadComplete(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Column(Modifier.fillMaxSize().padding(horizontal = 20.dp),horizontalAlignment = Alignment.CenterHorizontally) {
        Spacer(Modifier.weight(.5f))
        SourceHero("upload-hero.png",.716f,184f/101f)
        Text(uiContext.getString(R.string.copy_upload_complete_0cbc966e),color = Color.White,fontSize = 24.sp,fontWeight = FontWeight.Medium,
            modifier = Modifier.padding(top = 15.dp))
        BodyText(uiContext.resources.getQuantityString(R.plurals.copy_library_added_count, state.selectedUpload.size, state.selectedUpload.size),Modifier.padding(top = 10.dp))
        Spacer(Modifier.height(26.dp))
        PinkButton(uiContext.getString(R.string.copy_view_in_library_c3973650)) { state.navigate(13) }
        Spacer(Modifier.weight(.35f))
        Row(Modifier.fillMaxWidth().heightIn(min=48.dp).clickable(role = Role.Button) { state.navigate(13) },verticalAlignment = Alignment.CenterVertically) {
            SectionTitle(uiContext.getString(R.string.copy_recent_uploads_60b190d4),Modifier.weight(1f))
            AppIcon(Glyph.BACK,Modifier.size(19.dp).graphicsLayer { rotationZ = 180f },Muted)
        }
        Row(Modifier.fillMaxWidth().height(76.dp).horizontalScroll(rememberScrollState()),horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            listOf(9,0,4,6,8,1).forEach { photo -> Asset(photoAsset(photo),Modifier.width(64.dp).fillMaxHeight().clip(RoundedCornerShape(6.dp))
                .clickable(role = Role.Button) { state.openPhoto(photo) },uiContext.getString(R.string.copy_photo_1_s_b27fd7d6, photo+1)) }
        }
        Text(uiContext.resources.getQuantityString(R.plurals.copy_just_now_photo_count, state.selectedUpload.size, state.selectedUpload.size),color = Muted,fontSize = 12.sp,modifier = Modifier.align(Alignment.Start).padding(top = 9.dp,bottom = 20.dp))
    }
}
