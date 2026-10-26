package com.lovelies.frontend.preview

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.AlertDialog
import androidx.compose.material.Text
import androidx.compose.material.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun AccountScreen(state: PreviewState) {
    when(state.route) {
        37 -> Profile(state)
        38 -> FaceManagement(state)
        39 -> ManagePeople(state)
        40 -> Privacy(state)
        41 -> PhotoAccess(state)
        42 -> NotificationSettings(state)
        43 -> Storage(state)
        44 -> Export(state)
        45 -> HelpCenter(state)
        46 -> AccountSecurity(state)
        47 -> NoMatches(state)
        48 -> Offline(state)
    }
}

@Composable
private fun Profile(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    var editVisible by remember { mutableStateOf(false) }
    Box(Modifier.fillMaxSize()) {
        Glow(strong = true)
        Column(Modifier.fillMaxSize().padding(horizontal = 15.dp),horizontalAlignment = Alignment.CenterHorizontally) {
            Box(Modifier.fillMaxWidth().height(48.dp)) { Box(Modifier.align(Alignment.CenterEnd)) { Overflow(state) } }
            Box(Modifier.size(157.dp)) {
                Avatar(0,Modifier.align(Alignment.Center),size = 153.dp,selected = false,onClick = { state.navigate(38) },label=uiContext.getString(R.string.copy_manage_your_face_f49f3b4e))
                Box(Modifier.align(Alignment.BottomEnd).size(48.dp).clip(CircleShape).background(Pink)
                    .clickable(role = Role.Button) { editVisible = true }.semantics { contentDescription = uiContext.getString(R.string.copy_edit_profile_6c31e08c) },contentAlignment = Alignment.Center) {
                    AppIcon(Glyph.EDIT,Modifier.size(23.dp),Ink)
                }
            }
            Text(state.name,color = Color.White,fontSize = 24.sp,fontWeight = FontWeight.Medium,modifier = Modifier.padding(top = 10.dp))
            BodyText("Here for the good photos\nand great company ✨",Modifier.padding(top = 4.dp),size = 14)
            Row(Modifier.fillMaxWidth().padding(vertical = 19.dp),horizontalArrangement = Arrangement.SpaceEvenly) {
                listOf(Triple("248",uiContext.getString(R.string.copy_photos_cde554d0),13),Triple("36",uiContext.getString(R.string.copy_matches_a7d4102e),11),Triple("12",uiContext.getString(R.string.copy_people_8390060e),39)).forEach { (number,title,destination) ->
                    Column(Modifier.weight(1f).heightIn(min=48.dp).clickable(role = Role.Button) { state.navigate(destination) }
                        .semantics { contentDescription = uiContext.getString(R.string.copy_1_s_2_s_6841b794, number, title) },horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(number,color = Color.White,fontSize = 19.sp,fontWeight = FontWeight.Medium,modifier = Modifier.clearAndSetSemantics { })
                        Text(title,color = Muted,fontSize = 13.sp,modifier = Modifier.padding(top = 4.dp).clearAndSetSemantics { })
                    }
                }
            }
            PinkButton(uiContext.getString(R.string.copy_edit_profile_cd280a41)) { editVisible = true }
            Row(Modifier.fillMaxWidth().height(62.dp).padding(top = 7.dp,bottom = 7.dp),horizontalArrangement = Arrangement.SpaceEvenly) {
                listOf(Glyph.GRID,Glyph.HEART,Glyph.PERSON).forEachIndexed { index,icon ->
                    Box(Modifier.weight(1f).fillMaxHeight().padding(horizontal = 7.dp).clip(CircleShape)
                        .background(if(state.profileTab == index)Panel else Color.Transparent)
                        .clickable(role = Role.Tab) { state.profileTab = index }.semantics {
                            contentDescription=listOf(uiContext.getString(R.string.a11y_profile_photos),uiContext.getString(R.string.a11y_profile_favorites),uiContext.getString(R.string.a11y_profile_people))[index]
                            selected=state.profileTab==index
                        },contentAlignment = Alignment.Center) {
                        AppIcon(icon,Modifier.size(23.dp),if(state.profileTab == index)Pink else Color.White)
                    }
                }
            }
            if(state.profileTab == 2) {
                Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                    PeopleNames.forEachIndexed { index,name ->
                        Row(Modifier.fillMaxWidth().heightIn(min=70.dp).clickable(role = Role.Button) { state.openPerson(index) },verticalAlignment = Alignment.CenterVertically) {
                            Avatar(index,size = 47.dp);Text(name,color = Color.White,modifier = Modifier.padding(start = 15.dp));Spacer(Modifier.weight(1f))
                            AppIcon(Glyph.BACK,Modifier.size(18.dp).graphicsLayer { rotationZ = 180f },Muted)
                        }
                    }
                }
            } else if(state.profileTab == 0 && state.referenceGrids.containsKey(37))SourcePhotoGrid(state,37,Modifier.weight(1f))
            else PhotoGrid(state,Modifier.weight(1f),photos = if(state.profileTab == 1)state.favorites.toList() else listOf(0,3,6,4,7,2,10,5,1,9,15,11),favorites = state.profileTab == 1)
            BottomBar(state,37,Modifier.padding(bottom = 4.dp),profile = true)
        }
        if(editVisible) EditFieldDialog(uiContext.getString(R.string.copy_edit_profile_cd280a41),uiContext.getString(R.string.copy_display_name_4e167b8c),state.name,onDismiss = { editVisible = false }) {
            state.rename(it);editVisible = false
        }
    }
}

@Composable
private fun FaceManagement(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Column(Modifier.fillMaxSize().padding(horizontal = 18.dp),horizontalAlignment = Alignment.CenterHorizontally) {
        ScreenHeader(uiContext.getString(R.string.copy_manage_your_face_990044ce),onBack = state::back)
        BodyText(uiContext.getString(R.string.copy_help_lovelies_find_you_in_photos_acr_d37fb142),Modifier.padding(top = 4.dp,bottom = 18.dp),size = 15)
        Asset(state.referenceGrids[38]?.cameraAsset ?: "portrait.jpg",Modifier.fillMaxWidth(.80f).weight(1f).clip(RoundedCornerShape(24.dp)),uiContext.getString(R.string.copy_your_face_preview_6eb1d3b7))
        Row(Modifier.fillMaxWidth().padding(top = 17.dp,bottom = 22.dp),horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            repeat(4) { index ->
                Asset(state.referenceGrids[38]?.tiles?.getOrNull(index)?.asset ?: "person01.jpg",Modifier.weight(1f).aspectRatio(1f).clip(RoundedCornerShape(18.dp))
                    .border(if(index == 0)2.dp else 1.dp,if(index == 0)Pink else Hairline,RoundedCornerShape(18.dp))
                    .clickable(role = Role.Button) { state.toast(uiContext.getString(R.string.copy_face_preview_1_s_selected_d1a49280, (index+1).toString())) },uiContext.getString(R.string.copy_face_preview_1_s_e5db5a2b, (index+1).toString()))
            }
        }
        PinkButton(uiContext.getString(R.string.copy_replace_face_ff6be360)) { state.selfieCount = 0;state.navigate(6) }
        SettingRow(uiContext.getString(R.string.copy_tips_for_best_results_5155833c),icon = Glyph.BULB,modifier = Modifier.padding(top = 15.dp,bottom = 17.dp)) {
            state.info(uiContext.getString(R.string.copy_tips_for_best_results_5155833c),uiContext.getString(R.string.copy_face_the_camera_in_even_light_keep_y_a4c180ab))
        }
    }
}

@Composable
private fun ManagePeople(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val blocked = state.blockedPeople.distinct()
    val allowed = state.allowedPeople
    val allowedLabel = uiContext.getString(R.string.copy_allowed_1_s_7b45c22f, allowed.size.toString())
    val blockedLabel = uiContext.getString(R.string.copy_blocked_1_s_1ca562ff, blocked.size.toString())
    val viewingBlocked = state.peopleTab == "Blocked"
    Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
        ScreenHeader(uiContext.getString(R.string.copy_manage_people_a3539654),onBack = state::back)
        BodyText(uiContext.getString(R.string.copy_matched_people_are_allowed_by_defaul_bf260d7b),
            Modifier.padding(top = 4.dp, bottom = 14.dp), center = false, size = 12)
        Segments(listOf(allowedLabel,blockedLabel),if(viewingBlocked)blockedLabel else allowedLabel) { state.peopleTab = if(it==blockedLabel)"Blocked" else "Allowed" }
        Spacer(Modifier.height(10.dp))
        val entries = if(viewingBlocked)blocked else allowed
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            if(entries.isEmpty())BodyText(if(viewingBlocked)uiContext.getString(R.string.copy_no_blocked_people_dd602f71) else uiContext.getString(R.string.copy_no_allowed_matched_people_8082d695),
                Modifier.padding(vertical = 22.dp), center = false)
            entries.forEach { index ->
                val name = PeopleNames.getOrNull(index) ?: state.historicalPeople[index] ?: uiContext.getString(R.string.copy_blocked_person_5a9da67c)
                val sharingStatus = if(viewingBlocked)uiContext.getString(R.string.copy_blocked_e378ac53) else uiContext.getString(R.string.copy_can_share_with_09eae50e)
                Row(Modifier.fillMaxWidth().heightIn(min = 73.dp).clickable(role = Role.Button) {
                    state.confirm(name,if(viewingBlocked)uiContext.getString(R.string.copy_allow_future_matching_and_sharing_wi_5fb8c2a3)
                        else uiContext.getString(R.string.copy_block_sharing_with_this_matched_pers_41bc017d),
                        if(viewingBlocked)uiContext.getString(R.string.copy_unblock_person_198649c8) else uiContext.getString(R.string.copy_block_person_daaab12b)) {
                        state.setPersonBlocked(index, !viewingBlocked)
                    }
                }.semantics { contentDescription = uiContext.getString(R.string.copy_1_s_2_s_70b33c0c, name, sharingStatus) },verticalAlignment = Alignment.CenterVertically) {
                    if(index in state.matchedPeople)Avatar(index,size = 45.dp)
                    else Box(Modifier.size(45.dp).clip(CircleShape).background(Panel).clearAndSetSemantics { }, contentAlignment = Alignment.Center) {
                        Text(name.take(1), color = Color.White, fontSize = 17.sp)
                    }
                    Text(name,color = Color.White,fontSize = 14.sp,modifier = Modifier.padding(start = 13.dp).weight(1f).clearAndSetSemantics { })
                    Text(sharingStatus,color = Muted,fontSize = 12.sp,modifier = Modifier.clearAndSetSemantics { })
                    AppIcon(Glyph.BACK,Modifier.padding(start = 12.dp).size(16.dp).graphicsLayer { rotationZ = 180f },Muted)
                }
                DividerLine()
            }
        }
    }
}

@Composable
private fun Privacy(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    var choosingDiscoverability by remember { mutableStateOf(false) }
    if(choosingDiscoverability)AlertDialog(onDismissRequest = { choosingDiscoverability = false },
        backgroundColor = Panel, shape = RoundedCornerShape(24.dp),
        title = { Text(uiContext.getString(R.string.copy_who_can_find_you_06124357), color = Color.White) },
        text = { Column {
            BodyText(uiContext.getString(R.string.copy_choose_who_can_find_you_through_matc_60fdf85a), center = false, size = 12)
            listOf("Anyone", "Matched people only", "Allowed people only").forEach { choice ->
                val selected = state.discoverability == choice
                Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).selectable(selected = selected, role = Role.RadioButton) {
                    state.chooseDiscoverability(choice); choosingDiscoverability = false
                }.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(choiceLabel(uiContext,choice), color = Color.White, fontSize = 14.sp, modifier = Modifier.weight(1f))
                    SelectionMark(selected)
                }
            }
        } }, confirmButton = { TextButton(onClick = { choosingDiscoverability = false }) { Text(uiContext.getString(R.string.copy_done_e9b450d1), color = Pink) } })
    Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
        ScreenHeader(uiContext.getString(R.string.copy_privacy_sharing_576d0d35),onBack = state::back)
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(17.dp)).background(Panel)) {
                SettingRow(uiContext.getString(R.string.copy_who_can_find_you_06124357),choiceLabel(uiContext,state.discoverability),Glyph.PERSON) {
                    choosingDiscoverability = true
                }
                DividerLine(Modifier.padding(horizontal = 15.dp))
                SettingRow(uiContext.getString(R.string.copy_photo_visibility_f5b20781),choiceLabel(uiContext,state.visibility),Glyph.PHOTO) {
                    state.confirm(uiContext.getString(R.string.copy_photo_visibility_f5b20781),uiContext.getString(R.string.copy_photo_access_requires_your_approval__25294c49),uiContext.getString(R.string.copy_approved_recipients_a3d21a9a)) {
                        state.visibility = "Approved recipients"
                    }
                }
                DividerLine(Modifier.padding(horizontal = 15.dp))
                ToggleRow(state,"Allow others to save",icon = Glyph.SHARE)
                DividerLine(Modifier.padding(horizontal = 15.dp))
                ToggleRow(state,"Show location info",icon = Glyph.LOCATION)
                DividerLine(Modifier.padding(horizontal = 15.dp))
                ToggleRow(state,"Show in suggestions",icon = Glyph.STAR)
                DividerLine(Modifier.padding(horizontal = 15.dp))
                ToggleRow(state,"Analytics",uiContext.getString(R.string.copy_help_us_improve_lovelies_6d700059),Glyph.ANALYTICS)
            }
            Row(Modifier.padding(top = 17.dp).fillMaxWidth().clip(RoundedCornerShape(17.dp))
                .background(Color(0xFF251E22)).border(1.dp,SoftPink.copy(alpha = .45f),RoundedCornerShape(17.dp))
                .padding(horizontal = 16.dp,vertical = 18.dp),verticalAlignment = Alignment.CenterVertically) {
                AppIcon(Glyph.SHIELD,Modifier.size(45.dp),Pink);Spacer(Modifier.width(17.dp))
                Column {
                    Text(uiContext.getString(R.string.copy_your_privacy_matters_7815d4b8),color = SoftPink,fontSize = 16.sp)
                    Text(uiContext.getString(R.string.copy_you_choose_each_photo_and_recipient__1dae5989),color = Muted,fontSize = 13.sp,
                        lineHeight = 18.sp,modifier = Modifier.padding(top = 6.dp))
                }
            }
        }
    }
}

@Composable
private fun PhotoAccess(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Column(Modifier.fillMaxSize().padding(horizontal = 18.dp),horizontalAlignment = Alignment.CenterHorizontally) {
        ScreenHeader(uiContext.getString(R.string.copy_photo_access_7b04cc07),onBack = state::back)
        Spacer(Modifier.weight(.25f))
        Asset("photo-heart.png",Modifier.size(180.dp),scale = ContentScale.Fit)
        BodyText(uiContext.getString(R.string.copy_lovelies_needs_access_to_your_photos_d9e6d764),Modifier.padding(top = 11.dp,bottom = 22.dp))
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(19.dp)).background(Panel)) {
            listOf(Triple("All Photos",uiContext.getString(R.string.copy_access_to_your_entire_library_0b62f053),Glyph.PHOTO),
                Triple("Selected Albums",uiContext.getString(R.string.copy_choose_specific_albums_7962fd6c),Glyph.ALBUM),
                Triple("Limited Access",uiContext.getString(R.string.copy_allow_only_certain_photos_ea3b282f),Glyph.LOCK)).forEach { (title,subtitle,icon) ->
                val displayTitle=choiceLabel(uiContext,title)
                val selected = state.photoAccess == title
                Row(Modifier.fillMaxWidth().heightIn(min=82.dp).border(if(selected)1.dp else 0.dp,if(selected)SoftPink else Color.Transparent,RoundedCornerShape(15.dp))
                    .selectable(selected=selected,role = Role.RadioButton,onClick={ state.setAccess(title) })
                    .semantics { contentDescription = uiContext.getString(R.string.copy_1_s_2_s_70b33c0c, displayTitle, subtitle) }.padding(horizontal = 15.dp,vertical=12.dp),verticalAlignment = Alignment.CenterVertically) {
                    if(selected)SelectionMark(true) else AppIcon(icon,Modifier.size(27.dp))
                    Spacer(Modifier.width(17.dp))
                    Column(Modifier.weight(1f).clearAndSetSemantics { }) {
                        Text(displayTitle,color = Color.White,fontSize = 15.sp)
                        Text(subtitle,color = Muted,fontSize = 12.sp,modifier = Modifier.padding(top = 4.dp))
                    }
                    Box(Modifier.size(25.dp).clip(CircleShape).border(if(selected)5.dp else 1.dp,if(selected)Pink else Muted,CircleShape))
                }
            }
        }
        PinkButton(uiContext.getString(R.string.copy_continue_2e026239),Modifier.padding(top = 18.dp)) { state.toast(uiContext.getString(R.string.copy_photo_access_preference_saved_in_the_4f6a7f25));state.navigate(37) }
        Spacer(Modifier.weight(.25f))
    }
}

@Composable
private fun NotificationSettings(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
        ScreenHeader(uiContext.getString(R.string.copy_notifications_753a22b2),onBack = state::back)
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(Panel).verticalScroll(rememberScrollState())) {
            listOf(
                Triple("New Matches",uiContext.getString(R.string.copy_when_you_re_matched_in_photos_405974ba),Glyph.HEART),
                Triple("Messages",uiContext.getString(R.string.copy_when_you_receive_a_message_7e98b957),Glyph.MESSAGE),
                Triple("Mentions",uiContext.getString(R.string.copy_when_someone_mentions_you_c096ccc7),Glyph.LINK),
                Triple("Tips & Features",uiContext.getString(R.string.copy_product_updates_and_tips_af871fe3),Glyph.BULB),
                Triple("Reminders",uiContext.getString(R.string.copy_friendly_nudges_a7c39f06),Glyph.PHONE),
                Triple("Marketing",uiContext.getString(R.string.copy_special_offers_optional_e703ea7a),Glyph.SHARE)).forEachIndexed { index,(title,subtitle,icon) ->
                ToggleRow(state,title,subtitle,icon)
                if(index < 5)DividerLine(Modifier.padding(horizontal = 15.dp))
            }
        }
    }
}

@Composable
private fun Storage(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val fontScale=androidx.compose.ui.platform.LocalDensity.current.fontScale
    Column(Modifier.fillMaxSize().padding(horizontal = 21.dp),horizontalAlignment = Alignment.CenterHorizontally) {
        ScreenHeader(uiContext.getString(R.string.copy_storage_34eddf06),onBack = state::back)
        Spacer(Modifier.weight(.3f))
        BoxWithConstraints(Modifier.fillMaxWidth(),contentAlignment=Alignment.Center) {
        Box(Modifier.size(minOf(maxWidth,170.dp*fontScale.coerceAtLeast(1f))),contentAlignment = Alignment.Center) {
            Canvas(Modifier.fillMaxSize()) {
                val rect=Offset(11.dp.toPx(),11.dp.toPx());val area=Size(size.width-22.dp.toPx(),size.height-22.dp.toPx())
                val colors=listOf(Pink,Violet,Color(0xFFE9E2CF),Hairline)
                val sweeps=if(state.storageCacheMB == 0)listOf(271f,65f,0f,24f) else listOf(258f,65f,22f,15f)
                var start=-90f
                sweeps.forEachIndexed { index,sweep ->
                    if(sweep > 0f)drawArc(colors[index],start,sweep-2f,false,rect,area,style = Stroke(22.dp.toPx()))
                    start+=sweep
                }
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(if(state.storageCacheMB == 0)uiContext.getString(R.string.copy_2_2_gb_6d383f72) else uiContext.getString(R.string.copy_2_4_gb_2b33a064),color = Color.White,fontSize = 27.sp)
                Text(uiContext.getString(R.string.copy_of_5_gb_used_2bd0fe41),color = Muted,fontSize = 15.sp,modifier = Modifier.padding(top = 6.dp))
            }
        }
        }
        Spacer(Modifier.height(20.dp))
        listOf(Triple(uiContext.getString(R.string.copy_photos_cde554d0),uiContext.getString(R.string.copy_1_8_gb_3c1f5f9b),Pink),Triple(uiContext.getString(R.string.copy_matches_a7d4102e),uiContext.getString(R.string.copy_420_mb_4af1f110),Violet),
            Triple(uiContext.getString(R.string.copy_cache_cc192185),uiContext.getString(R.string.copy_1_s_mb_ecb7b509, state.storageCacheMB.toString()),Color(0xFFE9E2CF)),Triple(uiContext.getString(R.string.copy_other_6e38ff95),uiContext.getString(R.string.copy_60_mb_544f6392),Color(0xFFE9E2CF))).forEach { (label,value,color) ->
            Row(Modifier.fillMaxWidth().heightIn(min=36.dp).padding(vertical=4.dp),verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(18.dp).clip(CircleShape).background(color))
                Text(label,color = Color.White,fontSize = 15.sp,modifier = Modifier.padding(start = 15.dp).weight(1f))
                Text(value,color = Muted,fontSize = 14.sp)
            }
        }
        Spacer(Modifier.weight(.4f))
        PinkButton(uiContext.getString(R.string.copy_manage_storage_86726f67),Modifier.padding(bottom = 20.dp)) {
            state.confirm(uiContext.getString(R.string.copy_manage_storage_86726f67),uiContext.getString(R.string.copy_clear_1_s_mb_of_sample_cache_your_ph_5c13d19e, state.storageCacheMB.toString()),uiContext.getString(R.string.copy_clear_cache_d8649644)) { state.clearCache() }
        }
    }
}

@Composable
private fun Export(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Column(Modifier.fillMaxSize().padding(horizontal = 20.dp),horizontalAlignment = Alignment.CenterHorizontally) {
        ScreenHeader(uiContext.getString(R.string.copy_export_your_data_726c5cda),onBack = state::back)
        Spacer(Modifier.weight(.25f))
        Box(Modifier.size(137.dp),contentAlignment = Alignment.Center) {
            GlowSymbol(Glyph.EXPORT,Modifier.size(133.dp),ring = false)
            AppIcon(Glyph.EXPORT,Modifier.size(89.dp),Pink)
        }
        BodyText(uiContext.getString(R.string.copy_download_a_copy_of_your_photos_match_31cc0c51),Modifier.padding(top = 14.dp,bottom = 20.dp))
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(17.dp)).background(Panel).padding(20.dp),verticalAlignment = Alignment.Top) {
            AppIcon(Glyph.BULB,Modifier.size(27.dp));Spacer(Modifier.width(17.dp))
            Column {
                Text(uiContext.getString(R.string.copy_your_data_your_choice_754597d4),color = Color.White,fontSize = 16.sp)
                listOf(uiContext.getString(R.string.copy_photos_you_ve_shared_21b56a22),uiContext.getString(R.string.copy_your_matches_and_messages_6be58806),uiContext.getString(R.string.copy_profile_information_6964213c),uiContext.getString(R.string.copy_settings_and_preferences_029306cf)).forEach { title ->
                    Row(Modifier.padding(top = 11.dp),verticalAlignment = Alignment.CenterVertically) {
                        AppIcon(Glyph.CHECK,Modifier.size(17.dp),Muted)
                        Text(title,color = Muted,fontSize = 13.sp,modifier = Modifier.padding(start = 9.dp))
                    }
                }
            }
        }
        Spacer(Modifier.weight(.35f))
        PinkButton(if(state.exportRequested)uiContext.getString(R.string.copy_view_export_summary_d5abf516) else uiContext.getString(R.string.copy_request_export_cfe37002),Modifier.padding(bottom = 20.dp)) {
            state.exportRequested = true
            state.info(uiContext.getString(R.string.copy_preview_export_summary_83c595f7),uiContext.getString(R.string.copy_profile_1_s_sample_library_18_photos_41f0baf9, state.name))
        }
    }
}

@Composable
private fun HelpCenter(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Column(Modifier.fillMaxSize().padding(horizontal = 17.dp)) {
        ScreenHeader(uiContext.getString(R.string.copy_help_center_bbf4ae03),onBack = state::back)
        SearchInput(state.helpSearch,uiContext.getString(R.string.copy_search_for_help_fc332e61),onValue = { state.helpSearch = it })
        Spacer(Modifier.height(9.dp))
        val rows=listOf(
            Triple("Getting Started",uiContext.getString(R.string.copy_learn_the_basics_aeb47c6d),Glyph.SHIELD),
            Triple("Your Photos",uiContext.getString(R.string.copy_uploading_matching_and_more_3c61d123),Glyph.PHOTO),
            Triple("Privacy & Safety",uiContext.getString(R.string.copy_keeping_your_data_safe_9b991aee),Glyph.SHIELD),
            Triple("Account & Settings",uiContext.getString(R.string.copy_manage_your_account_a672f6b2),Glyph.GRID),
            Triple("Troubleshooting",uiContext.getString(R.string.copy_fix_common_issues_dd60368b),Glyph.HELP),
            Triple("Contact Support",uiContext.getString(R.string.copy_we_re_here_to_help_ed14ad53),Glyph.MESSAGE))
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            rows.filter { (choiceLabel(uiContext,it.first) + it.second).contains(state.helpSearch,true) }.forEachIndexed { index,(title,subtitle,icon) ->
                SettingRow(choiceLabel(uiContext,title),subtitle,icon,modifier = Modifier.padding(bottom = 6.dp)) {
                    when(title) {
                        "Getting Started" -> state.info(uiContext.getString(R.string.copy_getting_started_d7ac78be),uiContext.getString(R.string.copy_add_photos_capture_three_preview_sel_d4805253))
                        "Your Photos" -> state.navigate(19)
                        "Privacy & Safety" -> state.navigate(40)
                        "Account & Settings" -> state.navigate(46)
                        "Troubleshooting" -> state.navigate(48)
                        else -> state.info(uiContext.getString(R.string.copy_contact_support_abccb14c),uiContext.getString(R.string.copy_for_this_front_end_preview_feedback__85be06a5))
                    }
                }
            }
            if(rows.none { (choiceLabel(uiContext,it.first) + it.second).contains(state.helpSearch,true) })BodyText(uiContext.getString(R.string.copy_no_help_articles_found_try_photos_or_bb2d8c05),Modifier.padding(top = 24.dp))
        }
    }
}

@Composable
private fun AccountSecurity(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    var editing by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
        ScreenHeader(uiContext.getString(R.string.copy_account_security_fb84c56c),onBack = state::back)
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(17.dp)).background(Panel)) {
                SettingRow(uiContext.getString(R.string.copy_email_43352167),icon = Glyph.MAIL,trailing = state.email) { editing = "Email" }
                DividerLine(Modifier.padding(horizontal = 14.dp))
                SettingRow(uiContext.getString(R.string.copy_phone_4930944f),icon = Glyph.PHONE,trailing = state.phone) { editing = "Phone" }
                DividerLine(Modifier.padding(horizontal = 14.dp))
                SettingRow(uiContext.getString(R.string.copy_password_2cc30838),icon = Glyph.LOCK,trailing = "•••••••••") {
                    state.info(uiContext.getString(R.string.copy_password_2cc30838),uiContext.getString(R.string.copy_authentication_is_simulated_in_this__92d530b1))
                }
                DividerLine(Modifier.padding(horizontal = 14.dp))
                SettingRow(uiContext.getString(R.string.copy_two_factor_authentication_1a856a41),icon = Glyph.SHIELD,trailing = if(state.toggles["Two-Factor Authentication"] == true)uiContext.getString(R.string.copy_on_60e47df0) else uiContext.getString(R.string.copy_off_0dc6b4aa)) {
                    state.toggle("Two-Factor Authentication")
                }
                DividerLine(Modifier.padding(horizontal = 14.dp))
                SettingRow(uiContext.getString(R.string.copy_active_devices_c1fb33b8),icon = Glyph.DEVICE,trailing = uiContext.resources.getQuantityString(R.plurals.copy_device_count, state.deviceCount, state.deviceCount)) {
                    state.confirm(uiContext.getString(R.string.copy_active_devices_c1fb33b8),uiContext.getString(R.string.copy_sample_devices_1_s_2_s_and_3_s_remov_22e51542, "iPhone 15", "iPad", "MacBook"),uiContext.getString(R.string.copy_remove_sample_dbc29df5)) {
                        state.deviceCount = (state.deviceCount - 1).coerceAtLeast(1)
                    }
                }
            }
            Column(Modifier.padding(top = 16.dp).fillMaxWidth().clip(RoundedCornerShape(17.dp)).background(Panel)) {
                SettingRow(uiContext.getString(R.string.copy_sign_out_61fd08ff),icon = Glyph.LOGOUT,accent = Color(0xFFFF7C9A)) {
                    state.confirm(uiContext.getString(R.string.copy_sign_out_61fd08ff),uiContext.getString(R.string.copy_return_to_the_local_preview_welcome__b98c3431),uiContext.getString(R.string.copy_sign_out_61fd08ff)) { state.navigate(3) }
                }
                DividerLine(Modifier.padding(horizontal = 14.dp))
                SettingRow(uiContext.getString(R.string.copy_delete_account_5f4a9a81),icon = Glyph.TRASH,accent = Color(0xFFFF7C9A)) {
                    state.confirm(uiContext.getString(R.string.copy_reset_preview_account_596bb443),uiContext.getString(R.string.copy_this_resets_only_sample_profile_pref_58c6bcb8),uiContext.getString(R.string.copy_reset_preview_d0a48484)) {
                        state.resetPreview();state.navigate(3)
                    }
                }
            }
        }
    }
    editing?.let { field ->
        EditFieldDialog(uiContext.getString(R.string.copy_edit_1_s_0e53531c, choiceLabel(uiContext,field)),choiceLabel(uiContext,field),if(field == "Email")state.email else state.phone,onDismiss = { editing = null }) { value ->
            if(field == "Email")state.email = value else state.phone = value
            editing = null
        }
    }
}

@Composable
private fun EditFieldDialog(title: String,label: String,currentValue: String,onDismiss: () -> Unit,onSave: (String) -> Unit) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    var value by remember { mutableStateOf(currentValue) }
    AlertDialog(onDismissRequest = onDismiss,backgroundColor = Panel,shape = RoundedCornerShape(23.dp),
        title = { Text(title,color = Color.White) },
        text = {
            Column {
                Text(label,color = Muted,fontSize = 13.sp,modifier = Modifier.padding(bottom = 9.dp))
                BasicTextField(value = value,onValueChange = { value = it },singleLine = true,
                    textStyle = TextStyle(color = Color.White,fontSize = 17.sp),cursorBrush = SolidColor(Pink),
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Ink).padding(15.dp)
                        .semantics { contentDescription = label })
            }
        },confirmButton = { TextButton(enabled = value.isNotBlank(),onClick = { onSave(value.trim()) }) { Text(uiContext.getString(R.string.copy_save_efc007a3),color = Pink) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(uiContext.getString(R.string.copy_cancel_77dfd213),color = Muted) } })
}

@Composable
private fun NoMatches(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Column(Modifier.fillMaxSize().padding(horizontal = 24.dp),horizontalAlignment = Alignment.CenterHorizontally) {
        Spacer(Modifier.weight(.55f))
        SourceHero("empty-hero.png",.598f,152f/144f)
        Text(uiContext.getString(R.string.copy_no_matches_yet_f062edcd),color = Color.White,fontSize = 25.sp,fontWeight = FontWeight.Medium,
            modifier = Modifier.padding(top = 22.dp))
        BodyText(uiContext.getString(R.string.copy_your_people_are_out_there_keep_shari_a6a4e134),Modifier.padding(top = 15.dp),size = 16)
        Spacer(Modifier.weight(.6f))
        PinkButton(uiContext.getString(R.string.copy_keep_exploring_135f45b0),Modifier.padding(bottom = 31.dp)) { state.navigate(10) }
    }
}

@Composable
private fun Offline(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Column(Modifier.fillMaxSize().padding(horizontal = 27.dp),horizontalAlignment = Alignment.CenterHorizontally) {
        Spacer(Modifier.weight(.7f))
        SourceHero("offline-hero.png",.504f,128f/93f)
        Text(uiContext.getString(R.string.copy_you_re_offline_5f52c28b),color = Color.White,fontSize = 25.sp,fontWeight = FontWeight.Medium,
            modifier = Modifier.padding(top = 18.dp))
        BodyText(uiContext.getString(R.string.copy_check_your_connection_and_try_again_aa7ddbf2),Modifier.padding(top = 15.dp),size = 16)
        Spacer(Modifier.height(34.dp))
        PinkButton(uiContext.getString(R.string.copy_try_again_cef2fe09)) { state.toast(uiContext.getString(R.string.copy_preview_connection_restored_f0ddeead));state.navigate(10) }
        Text(uiContext.getString(R.string.copy_go_back_e2baa6be),color = Muted,fontSize = 14.sp,textDecoration = TextDecoration.Underline,
            modifier = Modifier.padding(top = 12.dp).sizeIn(minWidth=48.dp,minHeight=48.dp).clickable(role = Role.Button,onClick = state::back).padding(12.dp))
        Spacer(Modifier.weight(.4f))
    }
}
