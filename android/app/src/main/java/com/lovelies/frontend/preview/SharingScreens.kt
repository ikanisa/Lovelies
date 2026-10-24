package com.lovelies.frontend.preview

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay

@Composable
fun SharingScreen(state: PreviewState) {
    when(state.route) {
        25 -> MatchSummary(state)
        26 -> MatchedGallery(state)
        27 -> PhotoToPeople(state)
        28 -> PersonToPhotos(state)
        29,30 -> SelectSharePhotos(state)
        31,32 -> SelectRecipients(state)
        33 -> ReviewShare(state)
        34 -> ShareProgress(state)
        35 -> ShareHistory(state)
        36 -> ReportMatch(state)
    }
}

@Composable
private fun MatchSummary(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Box(Modifier.fillMaxSize()) {
        Glow(strong = true)
        Column(Modifier.fillMaxSize().padding(horizontal = 21.dp,vertical = 20.dp),horizontalAlignment = Alignment.CenterHorizontally) {
            Spacer(Modifier.weight(.45f))
            SourceHero("matches-hero.png",.531f,127f/106f)
            Spacer(Modifier.height(20.dp))
            Text("12",color = Color.White,fontSize = 31.sp,fontWeight = FontWeight.Medium)
            Text(uiContext.getString(R.string.copy_photos_matched_baab8348),color = Color.White,fontSize = 19.sp,modifier = Modifier.padding(top = 2.dp))
            Text("8",color = Color.White,fontSize = 31.sp,fontWeight = FontWeight.Medium,modifier = Modifier.padding(top = 13.dp))
            Text(uiContext.getString(R.string.copy_people_found_9d711006),color = Color.White,fontSize = 19.sp,modifier = Modifier.padding(top = 2.dp))
            Row(Modifier.fillMaxWidth().padding(top = 23.dp).horizontalScroll(rememberScrollState()),horizontalArrangement = Arrangement.Center) {
                listOf(0,2,4,6,1).forEach { Avatar(it,size = 49.dp,selected = true,onClick = { state.openPerson(it) }) }
                Box(Modifier.size(48.dp).clip(CircleShape).background(Panel).clickable(role = Role.Button) { state.navigate(39) }
                    .semantics { contentDescription=uiContext.getString(R.string.a11y_more_matched_people) },contentAlignment = Alignment.Center) {
                    Text("+4",color = Color.White,fontSize = 14.sp,modifier=Modifier.clearAndSetSemantics { })
                }
            }
            BodyText(uiContext.getString(R.string.copy_great_matches_your_photos_found_peop_4bdf9c68),Modifier.padding(top = 16.dp))
            Spacer(Modifier.weight(.45f))
            PinkButton(uiContext.getString(R.string.copy_view_matches_731444f2)) { state.navigate(26) }
        }
    }
}

@Composable
private fun MatchedGallery(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Column(Modifier.fillMaxSize().padding(horizontal = 13.dp)) {
        ScreenHeader(uiContext.getString(R.string.copy_matched_photos_d2c8fc60),onBack = state::back,subtitle = uiContext.resources.getQuantityString(R.plurals.photo_count, 12, 12),right = { Overflow(state) })
        if(state.referenceGrids.containsKey(26))SourcePhotoGrid(state,26,Modifier.weight(1f),showPeople = true,
            onPhotoClick = { index,asset -> state.openPhoto(index,27,asset) })
        else PhotoGrid(state,Modifier.weight(1f),photos = listOf(0,1,9,3,4,2,5,6,7,10,8,15),showPeople = true,columns = 2,
            onPhotoClick = { state.openPhoto(it,27) })
    }
}

@Composable
private fun PhotoToPeople(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Column(Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxWidth().weight(1f)) {
            Asset(state.selectedPhotoAsset ?: photoAsset(state.selectedPhoto),Modifier.fillMaxSize(),uiContext.getString(R.string.copy_photo_1_s_b27fd7d6, state.selectedPhoto+1))
            Row(Modifier.fillMaxWidth().padding(8.dp),verticalAlignment = Alignment.CenterVertically) {
                IconAction(Glyph.BACK,uiContext.getString(R.string.back),onClick = state::back)
                Spacer(Modifier.weight(1f))
                Box(Modifier.clip(CircleShape).background(Ink.copy(alpha = .46f)).padding(horizontal = 11.dp,vertical = 6.dp)) {
                    Text("${state.selectedPhoto%12+1}/12",color = Color.White,fontSize = 14.sp)
                }
            }
        }
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(topStart = 26.dp,topEnd = 26.dp))
            .background(Ink).padding(horizontal = 13.dp,vertical = 6.dp)) {
            ScreenHeader(uiContext.getString(R.string.copy_people_in_this_photo_c3d0005b),onBack = state::back,right = { Overflow(state) })
            val labels=List(8) { index -> if(index==7)"+2" else PeopleNames[index] }
            AdaptiveChoices(labels,Modifier.padding(bottom=15.dp),labelSize=12.sp,minimumItemWidth=72.dp,spacing=15.dp) { index,itemModifier ->
                val openPerson = { state.openPerson(index) }
                Column(itemModifier.then(if(index<7)Modifier.clickable(role=Role.Button,onClick=openPerson)
                    .clearAndSetSemantics {
                        contentDescription=PeopleNames[index]
                        role=Role.Button
                        selected=index==0
                        onClick { openPerson();true }
                    } else Modifier),
                    horizontalAlignment=Alignment.CenterHorizontally) {
                    if(index==7)Box(Modifier.size(60.dp).clip(CircleShape).background(Panel)
                        .clickable(role=Role.Button) { state.navigate(39) }
                        .semantics { contentDescription=uiContext.getString(R.string.a11y_more_matched_people) },contentAlignment=Alignment.Center) {
                        Text("+2",color=Color.White,fontSize=16.sp,modifier=Modifier.clearAndSetSemantics { })
                    } else {
                        Avatar(index,size=60.dp,selected=index==0)
                        Text(PeopleNames[index],color=Color.White,fontSize=12.sp,
                            modifier=Modifier.padding(top=6.dp).clearAndSetSemantics { })
                    }
                }
            }
        }
    }
}

@Composable
private fun PersonToPhotos(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Column(Modifier.fillMaxSize().padding(horizontal = 15.dp),horizontalAlignment = Alignment.CenterHorizontally) {
        Row(Modifier.fillMaxWidth().height(53.dp),verticalAlignment = Alignment.CenterVertically) {
            IconAction(Glyph.BACK,uiContext.getString(R.string.back),onClick = state::back);Spacer(Modifier.weight(1f));Overflow(state)
        }
        Avatar(state.selectedPerson,size = 121.dp,selected = true)
        Text(PeopleNames[state.selectedPerson],color = Color.White,fontSize = 23.sp,fontWeight = FontWeight.Medium,
            modifier = Modifier.padding(top = 7.dp))
        Text(uiContext.resources.getQuantityString(R.plurals.copy_matched_photo_count, PeopleCounts[state.selectedPerson], PeopleCounts[state.selectedPerson]),color = Color.White,fontSize = 17.sp,
            modifier = Modifier.padding(top = 4.dp,bottom = 13.dp))
        if(state.selectedPerson == 0 && state.referenceGrids.containsKey(28))SourcePhotoGrid(state,28,Modifier.weight(1f),
            tilesOverride=state.referenceGrids[28]?.tiles?.take(PeopleCounts[state.selectedPerson]),onPhotoClick = { index,asset -> state.openPhoto(index,27,asset) })
        else PhotoGrid(state,Modifier.weight(1f),photos = listOf(0,1,3,5,15,6,16,12,8).take(PeopleCounts[state.selectedPerson]),onPhotoClick = { state.openPhoto(it,27) })
    }
}

@Composable
private fun SelectSharePhotos(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Column(Modifier.fillMaxSize().padding(horizontal = 12.dp)) {
        ScreenHeader(if(state.route == 29)uiContext.getString(R.string.copy_select_photos_to_share_52f9b7e4) else uiContext.getString(R.string.copy_deselect_photos_d46d783f),onBack = state::back,
            subtitle = uiContext.getString(R.string.copy_1_s_of_12_selected_6a4cdc17, state.selectedSharePhotos.size),right = { Overflow(state) })
        if(state.referenceGrids.containsKey(29))SourcePhotoGrid(state,state.route,Modifier.weight(1f),selectable = true,
            selections = state.selectedSharePhotos,dimUnselected = state.route == 30,onPhotoClick = { index,_ -> state.togglePhoto(index) })
        else PhotoGrid(state,Modifier.weight(1f),photos = listOf(0,1,4,9,2,3,5,6,7,8,10,11),selectable = true,
            selections = state.selectedSharePhotos,dimUnselected = state.route == 30,onPhotoClick = state::togglePhoto)
        Row(Modifier.fillMaxWidth().height(66.dp).clip(RoundedCornerShape(23.dp)).background(Panel)
            .padding(horizontal = 15.dp),verticalAlignment = Alignment.CenterVertically) {
            AppIcon(Glyph.SHARE,Modifier.size(27.dp))
            Text(uiContext.getString(R.string.copy_1_s_selected_35eec3bf, state.selectedSharePhotos.size),color = Color.White,fontSize = 15.sp,textAlign = TextAlign.Center,
                modifier = Modifier.weight(1f))
            Box(Modifier.size(49.dp).clip(CircleShape).background(if(state.selectedSharePhotos.isNotEmpty())Pink else Hairline)
                .clickable(enabled = state.selectedSharePhotos.isNotEmpty(),role = Role.Button) { state.navigate(31) }
                .semantics { contentDescription = uiContext.getString(R.string.copy_continue_with_selected_photos_663131ce) },contentAlignment = Alignment.Center) {
                AppIcon(Glyph.ARROW,Modifier.size(26.dp),Ink)
            }
        }
        Spacer(Modifier.height(8.dp))
    }
}

@Composable
private fun SelectRecipients(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        ScreenHeader(if(state.route == 31)uiContext.getString(R.string.copy_choose_people_to_share_with_9173d5ed) else uiContext.getString(R.string.copy_deselect_people_a3a304bd),onBack = state::back,
            subtitle = uiContext.getString(R.string.copy_1_s_of_2_s_selected_7695fb3c, state.eligibleSelectedRecipients.size, state.allowedPeople.size),right = { Overflow(state) })
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            state.allowedPeople.forEach { index ->
                val name = PeopleNames[index]
                val selected = index in state.eligibleSelectedRecipients
                val matchDescription=uiContext.resources.getQuantityString(R.plurals.copy_matched_in_photo_count, PeopleCounts[index], PeopleCounts[index])
                Row(Modifier.fillMaxWidth().heightIn(min=70.dp).clip(RoundedCornerShape(13.dp))
                    .background(if(state.route == 32 && selected)Panel else Color.Transparent)
                    .toggleable(value=selected,role=Role.Checkbox,onValueChange={state.toggleRecipient(index)})
                    .semantics { contentDescription=uiContext.getString(R.string.copy_1_s_2_s_70b33c0c, name, matchDescription) }.padding(horizontal = 6.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Avatar(index,size = 48.dp,selected = index == 0)
                    Spacer(Modifier.width(13.dp))
                    Column(Modifier.weight(1f).clearAndSetSemantics { }) {
                        Text(name,color = Color.White,fontSize = 15.sp,fontWeight = FontWeight.Medium)
                        Text(matchDescription,
                            color = Muted,fontSize = 12.sp,modifier = Modifier.padding(top = 4.dp))
                    }
                    SelectionMark(selected)
                }
                DividerLine(Modifier.padding(horizontal = 5.dp))
            }
        }
        PinkButton(uiContext.getString(R.string.copy_continue_2e026239),Modifier.padding(top = 10.dp,bottom = 14.dp),enabled = state.eligibleSelectedRecipients.isNotEmpty()) { state.navigate(33) }
    }
}

@Composable
private fun ReviewShare(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Column(Modifier.fillMaxSize().padding(horizontal = 17.dp)) {
        ScreenHeader(uiContext.getString(R.string.copy_review_share_023d8493),onBack = state::back)
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            ShareSectionHeader(uiContext.resources.getQuantityString(R.plurals.copy_photo_heading_count, state.selectedSharePhotos.size, state.selectedSharePhotos.size), uiContext.getString(R.string.copy_edit_photos_8e15d2ea)) { state.navigate(30) }
            val selected = state.selectedSharePhotos.toList()
            if(state.referenceGrids.containsKey(33))BoxWithConstraints(Modifier.fillMaxWidth()) {
                val height = maxWidth * state.referenceGrids[33]!!.heightToWidthRatio
                SourcePhotoGrid(state,33,Modifier.height(height),visibleIds = selected,tilesOverride = dynamicReviewTiles(state),
                    onPhotoClick = { index,asset -> state.openPhoto(index,asset = asset) })
            } else Row(Modifier.fillMaxWidth().height(155.dp),horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                selected.firstOrNull()?.let { index ->
                    Asset(photoAsset(index),Modifier.weight(.34f).fillMaxHeight().clip(RoundedCornerShape(8.dp))
                        .clickable(role = Role.Button) { state.openPhoto(index) },uiContext.getString(R.string.copy_photo_1_s_b27fd7d6, index+1))
                }
                Column(Modifier.weight(.66f),verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    selected.drop(1).chunked(3).take(2).forEach { row ->
                        Row(Modifier.weight(1f),horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            row.forEach { index -> Asset(photoAsset(index),Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(8.dp))
                                .clickable(role = Role.Button) { state.openPhoto(index) },uiContext.getString(R.string.copy_photo_1_s_b27fd7d6, index+1)) }
                        }
                    }
                }
            }
            ShareSectionHeader(uiContext.resources.getQuantityString(R.plurals.copy_people_heading_count, state.eligibleSelectedRecipients.size, state.eligibleSelectedRecipients.size), uiContext.getString(R.string.copy_edit_people_9b4593d8),Modifier.padding(top = 8.dp)) { state.navigate(32) }
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),horizontalArrangement = Arrangement.spacedBy(19.dp)) {
                state.eligibleSelectedRecipients.forEach { index ->
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Avatar(index,size = 65.dp,selected = true,onClick = { state.openPerson(index) })
                        Text(PeopleNames[index],color = Color.White,fontSize = 13.sp,modifier = Modifier.padding(top = 7.dp))
                    }
                }
            }
        }
        Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(17.dp)).background(Panel).border(1.dp,Hairline,RoundedCornerShape(17.dp))
            .padding(vertical = 16.dp,horizontal = 16.dp),contentAlignment = Alignment.Center) {
            Text(uiContext.resources.getQuantityString(R.plurals.copy_share_confirmation_count, state.selectedSharePhotos.size, state.selectedSharePhotos.size, uiContext.resources.getQuantityString(R.plurals.person_count, state.eligibleSelectedRecipients.size, state.eligibleSelectedRecipients.size)),
                color = Color.White,fontSize = 14.sp,lineHeight = 20.sp,textAlign = TextAlign.Center)
        }
        PinkButton(uiContext.getString(R.string.copy_share_photos_740568ed),Modifier.padding(top = 12.dp,bottom = 12.dp),
            enabled = state.selectedSharePhotos.isNotEmpty() && state.eligibleSelectedRecipients.isNotEmpty(),icon = Glyph.SHARE) { state.navigate(34) }
    }
}

@Composable
private fun ShareSectionHeader(title: String, editLabel: String, modifier: Modifier = Modifier, onEdit: () -> Unit) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Row(modifier.fillMaxWidth().heightIn(min=48.dp),verticalAlignment = Alignment.CenterVertically) {
        Text(title,color = Color.White,fontSize = 15.sp,fontWeight = FontWeight.Medium,modifier = Modifier.weight(1f))
        Box(Modifier.heightIn(min=48.dp).clip(CircleShape).background(Panel).border(1.dp,Hairline,CircleShape)
            .clickable(role = Role.Button,onClick = onEdit).semantics { contentDescription = editLabel }
            .padding(horizontal = 17.dp),contentAlignment = Alignment.Center) {
            Text(uiContext.getString(R.string.copy_edit_5301648d),color = Color.White,fontSize = 12.sp)
        }
    }
}

@Composable
private fun ShareProgress(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    LaunchedEffect(Unit) { if(!state.reviewMode) { delay(6500);if(state.route == 34)state.navigate(35) } }
    Box(Modifier.fillMaxSize()) {
        Glow(strong = true)
        Column(Modifier.fillMaxSize().padding(horizontal = 32.dp),horizontalAlignment = Alignment.CenterHorizontally) {
            Spacer(Modifier.weight(.4f))
            Text(uiContext.getString(R.string.copy_sharing_your_photos_d9d0dfb3),color = Color.White,fontSize = 21.sp)
            Spacer(Modifier.height(18.dp))
            SourceHero("sharing-hero.png",.683f,168f/117f)
            Text(uiContext.resources.getQuantityString(R.plurals.copy_share_people_progress_count, state.eligibleSelectedRecipients.size, state.eligibleSelectedRecipients.size),color = Color.White,fontSize = 22.sp,
                modifier = Modifier.padding(top = 13.dp))
            BodyText(uiContext.getString(R.string.copy_this_won_t_take_long_ef97ed1c),Modifier.padding(top = 10.dp))
            if(state.reviewMode)BodyText(stringResource(R.string.a11y_preview_paused),Modifier.padding(top=12.dp).semantics { liveRegion=LiveRegionMode.Polite },size=12)
            Spacer(Modifier.height(30.dp))
            listOf(uiContext.getString(R.string.copy_preparing_photos_54140bd8),uiContext.getString(R.string.copy_finding_your_people_2e5b5efc),uiContext.getString(R.string.copy_sending_09d26e8d),uiContext.getString(R.string.copy_almost_there_698b191c)).forEachIndexed { index,title ->
                Row(Modifier.fillMaxWidth().padding(vertical = 8.dp),verticalAlignment = Alignment.CenterVertically) {
                    if(index < 2)SelectionMark(true,Modifier.size(23.dp))
                    else Box(Modifier.size(23.dp).clip(CircleShape).border(2.dp,if(index == 2)Pink else Muted,CircleShape))
                    Text(title,color = Muted,fontSize = 14.sp,modifier = Modifier.padding(start = 16.dp))
                }
            }
            Spacer(Modifier.weight(.5f))
            if(state.reviewMode)PinkButton(stringResource(R.string.a11y_continue_preview)) { state.navigate(35) }
        }
    }
}

@Composable
private fun ShareHistory(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Column(Modifier.fillMaxSize().padding(horizontal = 17.dp)) {
        ScreenHeader(uiContext.getString(R.string.copy_shared_with_people_20391c7f),onBack = state::back,right = { Overflow(state) })
        Column(Modifier.verticalScroll(rememberScrollState())) {
            listOf(0,4,6,1,2,3).forEachIndexed { position,index ->
                if(position == 3)SectionTitle(uiContext.getString(R.string.copy_earlier_c50cd8bb),Modifier.padding(top = 6.dp))
                val photoCount=if(position<3)state.selectedSharePhotos.size else 3
                val time=listOf(uiContext.getString(R.string.copy_just_now_8440e32f),uiContext.getString(R.string.copy_2m_ago_e34617a1),uiContext.getString(R.string.copy_2m_ago_e34617a1),uiContext.getString(R.string.copy_1d_ago_6137e061),uiContext.getString(R.string.copy_1d_ago_6137e061),uiContext.getString(R.string.copy_2d_ago_d1231416))[position]
                val status=if(position<3)uiContext.getString(R.string.copy_delivered_fd31a0de) else if(position<5)uiContext.getString(R.string.copy_viewed_f63ddff6) else uiContext.getString(R.string.copy_sent_c7ea0ea8)
                val statusLabel=status.removePrefix("● ").removePrefix("✓ ")
                Row(Modifier.fillMaxWidth().heightIn(min=95.dp).clickable(role = Role.Button) { state.openPerson(index) }
                    .semantics { contentDescription=uiContext.getString(R.string.copy_1_s_2_s_3_s_4_s_f6ee7bc9, PeopleNames[index], uiContext.resources.getQuantityString(R.plurals.photo_count, photoCount, photoCount), time, statusLabel) },verticalAlignment = Alignment.CenterVertically) {
                    if(position < 3)Box(Modifier.width(78.dp).height(64.dp)) {
                        Asset(photoAsset(listOf(9,0,5)[position]),Modifier.width(43.dp).fillMaxHeight().clip(RoundedCornerShape(7.dp)))
                        Avatar(index,Modifier.align(Alignment.CenterEnd),size = 54.dp)
                    } else Avatar(index,size = 51.dp)
                    Spacer(Modifier.width(13.dp))
                    Column(Modifier.weight(1f).clearAndSetSemantics { }) {
                        Text(PeopleNames[index],color = Color.White,fontSize = 15.sp,fontWeight = FontWeight.Medium)
                        Text(uiContext.getString(R.string.photo_status, uiContext.resources.getQuantityString(R.plurals.photo_count, photoCount, photoCount), time),
                            color = Muted,fontSize = 12.sp,modifier = Modifier.padding(top = 5.dp))
                    }
                    Box(Modifier.clip(CircleShape).background(if(position < 3)Color(0xFF462731) else if(position < 5)Pink else Violet)
                        .padding(horizontal = 10.dp,vertical = 7.dp).clearAndSetSemantics { }) {
                        Text(status,color = if(position < 3)Pink else Ink,fontSize = 11.sp)
                    }
                }
                DividerLine()
            }
        }
    }
}

@Composable
private fun ReportMatch(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Column(Modifier.fillMaxSize().padding(horizontal = 18.dp),horizontalAlignment = Alignment.CenterHorizontally) {
        Row(Modifier.fillMaxWidth().height(57.dp),verticalAlignment = Alignment.CenterVertically) {
            IconAction(Glyph.BACK,uiContext.getString(R.string.back),onClick = state::back);Spacer(Modifier.weight(1f));Overflow(state)
        }
        Avatar(1,size = 100.dp)
        Text(uiContext.getString(R.string.copy_not_this_person_85cc6ca0),color = Color.White,fontSize = 24.sp,fontWeight = FontWeight.Medium,
            modifier = Modifier.padding(top = 16.dp))
        BodyText(uiContext.getString(R.string.copy_help_us_improve_by_letting_us_know_t_e07f1402),Modifier.padding(top = 9.dp,bottom = 21.dp))
        listOf("This isn't me" to Glyph.PERSON,"Wrong person" to Glyph.FACE,"Not in this photo" to Glyph.PHOTO,"Other issue" to Glyph.HELP).forEach { (label,icon) ->
            val displayLabel=choiceLabel(uiContext,label)
            Row(Modifier.fillMaxWidth().padding(bottom = 7.dp).heightIn(min=55.dp).clip(RoundedCornerShape(13.dp)).background(Panel)
                .selectable(selected=state.reportReason==label,role = Role.RadioButton,onClick={ state.reportReason = label })
                .semantics { contentDescription=displayLabel }.padding(horizontal = 15.dp,vertical=10.dp),verticalAlignment = Alignment.CenterVertically) {
                AppIcon(icon,Modifier.size(23.dp),Muted);Spacer(Modifier.width(16.dp))
                Text(displayLabel,color = Color.White,fontSize = 14.sp,modifier = Modifier.weight(1f).clearAndSetSemantics { })
                SelectionMark(state.reportReason == label)
            }
        }
        Spacer(Modifier.weight(1f))
        PinkButton(uiContext.getString(R.string.copy_submit_4078e545),Modifier.padding(bottom = 21.dp)) {
            state.confirm(uiContext.getString(R.string.copy_thanks_for_your_feedback_cc74444d), uiContext.getString(R.string.copy_1_s_has_been_noted_in_this_local_pre_2def1704, choiceLabel(uiContext,state.reportReason)), uiContext.getString(R.string.copy_done_e9b450d1)) { state.navigate(26) }
        }
    }
}
