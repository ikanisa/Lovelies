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
    Box(Modifier.fillMaxSize()) {
        Glow(strong = true)
        Column(Modifier.fillMaxSize().padding(horizontal = 21.dp,vertical = 20.dp),horizontalAlignment = Alignment.CenterHorizontally) {
            Spacer(Modifier.weight(.45f))
            SourceHero("matches-hero.png",.531f,127f/106f)
            Spacer(Modifier.height(20.dp))
            Text("12",color = Color.White,fontSize = 31.sp,fontWeight = FontWeight.Medium)
            Text("Photos Matched",color = Color.White,fontSize = 19.sp,modifier = Modifier.padding(top = 2.dp))
            Text("8",color = Color.White,fontSize = 31.sp,fontWeight = FontWeight.Medium,modifier = Modifier.padding(top = 13.dp))
            Text("People Found",color = Color.White,fontSize = 19.sp,modifier = Modifier.padding(top = 2.dp))
            Row(Modifier.fillMaxWidth().padding(top = 23.dp).horizontalScroll(rememberScrollState()),horizontalArrangement = Arrangement.Center) {
                listOf(0,2,4,6,1).forEach { Avatar(it,size = 49.dp,selected = true,onClick = { state.openPerson(it) }) }
                Box(Modifier.size(48.dp).clip(CircleShape).background(Panel).clickable(role = Role.Button) { state.navigate(39) }
                    .semantics { contentDescription="More matched people" },contentAlignment = Alignment.Center) {
                    Text("+4",color = Color.White,fontSize = 14.sp,modifier=Modifier.clearAndSetSemantics { })
                }
            }
            BodyText("Great matches!\nYour photos found people\nin your memories.",Modifier.padding(top = 16.dp))
            Spacer(Modifier.weight(.45f))
            PinkButton("View Matches") { state.navigate(26) }
        }
    }
}

@Composable
private fun MatchedGallery(state: PreviewState) {
    Column(Modifier.fillMaxSize().padding(horizontal = 13.dp)) {
        ScreenHeader("Matched Photos",onBack = state::back,subtitle = "12 photos",right = { Overflow(state) })
        if(state.referenceGrids.containsKey(26))SourcePhotoGrid(state,26,Modifier.weight(1f),showPeople = true,
            onPhotoClick = { index,asset -> state.openPhoto(index,27,asset) })
        else PhotoGrid(state,Modifier.weight(1f),photos = listOf(0,1,9,3,4,2,5,6,7,10,8,15),showPeople = true,columns = 2,
            onPhotoClick = { state.openPhoto(it,27) })
    }
}

@Composable
private fun PhotoToPeople(state: PreviewState) {
    Column(Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxWidth().weight(1f)) {
            Asset(state.selectedPhotoAsset ?: photoAsset(state.selectedPhoto),Modifier.fillMaxSize(),"Photo ${state.selectedPhoto+1}")
            Row(Modifier.fillMaxWidth().padding(8.dp),verticalAlignment = Alignment.CenterVertically) {
                IconAction(Glyph.BACK,"Back",onClick = state::back)
                Spacer(Modifier.weight(1f))
                Box(Modifier.clip(CircleShape).background(Ink.copy(alpha = .46f)).padding(horizontal = 11.dp,vertical = 6.dp)) {
                    Text("${state.selectedPhoto%12+1}/12",color = Color.White,fontSize = 14.sp)
                }
            }
        }
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(topStart = 26.dp,topEnd = 26.dp))
            .background(Ink).padding(horizontal = 13.dp,vertical = 6.dp)) {
            ScreenHeader("People in this photo",onBack = state::back,right = { Overflow(state) })
            val labels=List(8) { index -> if(index==7)"+2" else PeopleNames[index] }
            AdaptiveChoices(labels,Modifier.padding(bottom=15.dp),labelSize=12.sp,minimumItemWidth=72.dp,spacing=15.dp) { index,itemModifier ->
                Column(itemModifier.then(if(index<7)Modifier.clickable(role=Role.Button) { state.openPerson(index) }
                    .semantics { contentDescription=PeopleNames[index];selected=index==0 } else Modifier),
                    horizontalAlignment=Alignment.CenterHorizontally) {
                    if(index==7)Box(Modifier.size(60.dp).clip(CircleShape).background(Panel)
                        .clickable(role=Role.Button) { state.navigate(39) }
                        .semantics { contentDescription="More matched people" },contentAlignment=Alignment.Center) {
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
    Column(Modifier.fillMaxSize().padding(horizontal = 15.dp),horizontalAlignment = Alignment.CenterHorizontally) {
        Row(Modifier.fillMaxWidth().height(53.dp),verticalAlignment = Alignment.CenterVertically) {
            IconAction(Glyph.BACK,"Back",onClick = state::back);Spacer(Modifier.weight(1f));Overflow(state)
        }
        Avatar(state.selectedPerson,size = 121.dp,selected = true)
        Text(PeopleNames[state.selectedPerson],color = Color.White,fontSize = 23.sp,fontWeight = FontWeight.Medium,
            modifier = Modifier.padding(top = 7.dp))
        Text("${PeopleCounts[state.selectedPerson]} matched photos",color = Color.White,fontSize = 17.sp,
            modifier = Modifier.padding(top = 4.dp,bottom = 13.dp))
        if(state.selectedPerson == 0 && state.referenceGrids.containsKey(28))SourcePhotoGrid(state,28,Modifier.weight(1f),
            onPhotoClick = { index,asset -> state.openPhoto(index,27,asset) })
        else PhotoGrid(state,Modifier.weight(1f),photos = listOf(0,1,3,5,15,6,16,12,8),onPhotoClick = { state.openPhoto(it,27) })
    }
}

@Composable
private fun SelectSharePhotos(state: PreviewState) {
    Column(Modifier.fillMaxSize().padding(horizontal = 12.dp)) {
        ScreenHeader(if(state.route == 29)"Select Photos to Share" else"Deselect Photos",onBack = state::back,
            subtitle = "${state.selectedSharePhotos.size} of 12 selected",right = { Overflow(state) })
        if(state.referenceGrids.containsKey(29))SourcePhotoGrid(state,state.route,Modifier.weight(1f),selectable = true,
            selections = state.selectedSharePhotos,dimUnselected = state.route == 30,onPhotoClick = { index,_ -> state.togglePhoto(index) })
        else PhotoGrid(state,Modifier.weight(1f),photos = listOf(0,1,4,9,2,3,5,6,7,8,10,11),selectable = true,
            selections = state.selectedSharePhotos,dimUnselected = state.route == 30,onPhotoClick = state::togglePhoto)
        Row(Modifier.fillMaxWidth().height(66.dp).clip(RoundedCornerShape(23.dp)).background(Panel)
            .padding(horizontal = 15.dp),verticalAlignment = Alignment.CenterVertically) {
            AppIcon(Glyph.SHARE,Modifier.size(27.dp))
            Text("${state.selectedSharePhotos.size} selected",color = Color.White,fontSize = 15.sp,textAlign = TextAlign.Center,
                modifier = Modifier.weight(1f))
            Box(Modifier.size(49.dp).clip(CircleShape).background(if(state.selectedSharePhotos.isNotEmpty())Pink else Hairline)
                .clickable(enabled = state.selectedSharePhotos.isNotEmpty(),role = Role.Button) { state.navigate(31) }
                .semantics { contentDescription = "Continue with selected photos" },contentAlignment = Alignment.Center) {
                AppIcon(Glyph.ARROW,Modifier.size(26.dp),Ink)
            }
        }
        Spacer(Modifier.height(8.dp))
    }
}

@Composable
private fun SelectRecipients(state: PreviewState) {
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        ScreenHeader(if(state.route == 31)"Choose People to Share With" else"Deselect People",onBack = state::back,
            subtitle = "${state.eligibleSelectedRecipients.size} of ${state.allowedPeople.size} selected",right = { Overflow(state) })
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            state.allowedPeople.forEach { index ->
                val name = PeopleNames[index]
                val selected = index in state.eligibleSelectedRecipients
                val matchDescription="Matched in ${PeopleCounts[index]} ${if(PeopleCounts[index] == 1)"photo" else"photos"}"
                Row(Modifier.fillMaxWidth().heightIn(min=70.dp).clip(RoundedCornerShape(13.dp))
                    .background(if(state.route == 32 && selected)Panel else Color.Transparent)
                    .toggleable(value=selected,role=Role.Checkbox,onValueChange={state.toggleRecipient(index)})
                    .semantics { contentDescription="$name, $matchDescription" }.padding(horizontal = 6.dp),
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
        PinkButton("Continue",Modifier.padding(top = 10.dp,bottom = 14.dp),enabled = state.eligibleSelectedRecipients.isNotEmpty()) { state.navigate(33) }
    }
}

@Composable
private fun ReviewShare(state: PreviewState) {
    Column(Modifier.fillMaxSize().padding(horizontal = 17.dp)) {
        ScreenHeader("Review & Share",onBack = state::back)
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            ShareSectionHeader("Photos (${state.selectedSharePhotos.size})", "Edit photos") { state.navigate(30) }
            val selected = state.selectedSharePhotos.toList()
            if(state.referenceGrids.containsKey(33))BoxWithConstraints(Modifier.fillMaxWidth()) {
                val height = maxWidth * state.referenceGrids[33]!!.heightToWidthRatio
                SourcePhotoGrid(state,33,Modifier.height(height),visibleIds = selected,tilesOverride = dynamicReviewTiles(state),
                    onPhotoClick = { index,asset -> state.openPhoto(index,asset = asset) })
            } else Row(Modifier.fillMaxWidth().height(155.dp),horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                selected.firstOrNull()?.let { index ->
                    Asset(photoAsset(index),Modifier.weight(.34f).fillMaxHeight().clip(RoundedCornerShape(8.dp))
                        .clickable(role = Role.Button) { state.openPhoto(index) },"Photo ${index+1}")
                }
                Column(Modifier.weight(.66f),verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    selected.drop(1).chunked(3).take(2).forEach { row ->
                        Row(Modifier.weight(1f),horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            row.forEach { index -> Asset(photoAsset(index),Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(8.dp))
                                .clickable(role = Role.Button) { state.openPhoto(index) },"Photo ${index+1}") }
                        }
                    }
                }
            }
            ShareSectionHeader("People (${state.eligibleSelectedRecipients.size})", "Edit people",Modifier.padding(top = 8.dp)) { state.navigate(32) }
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
            Text("You're about to share ${state.selectedSharePhotos.size} photos\nwith ${state.eligibleSelectedRecipients.size} people.",
                color = Color.White,fontSize = 14.sp,lineHeight = 20.sp,textAlign = TextAlign.Center)
        }
        PinkButton("Share Photos",Modifier.padding(top = 12.dp,bottom = 12.dp),
            enabled = state.selectedSharePhotos.isNotEmpty() && state.eligibleSelectedRecipients.isNotEmpty(),icon = Glyph.SHARE) { state.navigate(34) }
    }
}

@Composable
private fun ShareSectionHeader(title: String, editLabel: String, modifier: Modifier = Modifier, onEdit: () -> Unit) {
    Row(modifier.fillMaxWidth().heightIn(min=48.dp),verticalAlignment = Alignment.CenterVertically) {
        Text(title,color = Color.White,fontSize = 15.sp,fontWeight = FontWeight.Medium,modifier = Modifier.weight(1f))
        Box(Modifier.heightIn(min=48.dp).clip(CircleShape).background(Panel).border(1.dp,Hairline,CircleShape)
            .clickable(role = Role.Button,onClick = onEdit).semantics { contentDescription = editLabel }
            .padding(horizontal = 17.dp),contentAlignment = Alignment.Center) {
            Text("Edit",color = Color.White,fontSize = 12.sp)
        }
    }
}

@Composable
private fun ShareProgress(state: PreviewState) {
    LaunchedEffect(Unit) { if(!state.reviewMode) { delay(6500);if(state.route == 34)state.navigate(35) } }
    Box(Modifier.fillMaxSize()) {
        Glow(strong = true)
        Column(Modifier.fillMaxSize().padding(horizontal = 32.dp),horizontalAlignment = Alignment.CenterHorizontally) {
            Spacer(Modifier.weight(.4f))
            Text("Sharing Your Photos",color = Color.White,fontSize = 21.sp)
            Spacer(Modifier.height(18.dp))
            SourceHero("sharing-hero.png",.683f,168f/117f)
            Text("Sharing with ${state.eligibleSelectedRecipients.size} people...",color = Color.White,fontSize = 22.sp,
                modifier = Modifier.padding(top = 13.dp))
            BodyText("This won't take long",Modifier.padding(top = 10.dp))
            if(state.reviewMode)BodyText(stringResource(R.string.a11y_preview_paused),Modifier.padding(top=12.dp).semantics { liveRegion=LiveRegionMode.Polite },size=12)
            Spacer(Modifier.height(30.dp))
            listOf("Preparing photos","Finding your people","Sending...","Almost there!").forEachIndexed { index,title ->
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
    Column(Modifier.fillMaxSize().padding(horizontal = 17.dp)) {
        ScreenHeader("Shared with People",onBack = state::back,right = { Overflow(state) })
        Column(Modifier.verticalScroll(rememberScrollState())) {
            listOf(0,4,6,1,2,3).forEachIndexed { position,index ->
                if(position == 3)SectionTitle("Earlier",Modifier.padding(top = 6.dp))
                val photoCount=if(position<3)state.selectedSharePhotos.size else 3
                val time=listOf("Just now","2m ago","2m ago","1d ago","1d ago","2d ago")[position]
                val status=if(position<3)"● Delivered" else if(position<5)"✓ Viewed" else "● Sent"
                val statusLabel=status.removePrefix("● ").removePrefix("✓ ")
                Row(Modifier.fillMaxWidth().heightIn(min=95.dp).clickable(role = Role.Button) { state.openPerson(index) }
                    .semantics { contentDescription="${PeopleNames[index]}, $photoCount photos, $time, $statusLabel" },verticalAlignment = Alignment.CenterVertically) {
                    if(position < 3)Box(Modifier.width(78.dp).height(64.dp)) {
                        Asset(photoAsset(listOf(9,0,5)[position]),Modifier.width(43.dp).fillMaxHeight().clip(RoundedCornerShape(7.dp)))
                        Avatar(index,Modifier.align(Alignment.CenterEnd),size = 54.dp)
                    } else Avatar(index,size = 51.dp)
                    Spacer(Modifier.width(13.dp))
                    Column(Modifier.weight(1f).clearAndSetSemantics { }) {
                        Text(PeopleNames[index],color = Color.White,fontSize = 15.sp,fontWeight = FontWeight.Medium)
                        Text("$photoCount photos · $time",
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
    Column(Modifier.fillMaxSize().padding(horizontal = 18.dp),horizontalAlignment = Alignment.CenterHorizontally) {
        Row(Modifier.fillMaxWidth().height(57.dp),verticalAlignment = Alignment.CenterVertically) {
            IconAction(Glyph.BACK,"Back",onClick = state::back);Spacer(Modifier.weight(1f));Overflow(state)
        }
        Avatar(1,size = 100.dp)
        Text("Not this person?",color = Color.White,fontSize = 24.sp,fontWeight = FontWeight.Medium,
            modifier = Modifier.padding(top = 16.dp))
        BodyText("Help us improve by letting us know\nthis isn't the right match.",Modifier.padding(top = 9.dp,bottom = 21.dp))
        listOf("This isn't me" to Glyph.PERSON,"Wrong person" to Glyph.FACE,"Not in this photo" to Glyph.PHOTO,"Other issue" to Glyph.HELP).forEach { (label,icon) ->
            Row(Modifier.fillMaxWidth().padding(bottom = 7.dp).heightIn(min=55.dp).clip(RoundedCornerShape(13.dp)).background(Panel)
                .selectable(selected=state.reportReason==label,role = Role.RadioButton,onClick={ state.reportReason = label })
                .semantics { contentDescription=label }.padding(horizontal = 15.dp,vertical=10.dp),verticalAlignment = Alignment.CenterVertically) {
                AppIcon(icon,Modifier.size(23.dp),Muted);Spacer(Modifier.width(16.dp))
                Text(label,color = Color.White,fontSize = 14.sp,modifier = Modifier.weight(1f).clearAndSetSemantics { })
                SelectionMark(state.reportReason == label)
            }
        }
        Spacer(Modifier.weight(1f))
        PinkButton("Submit",Modifier.padding(bottom = 21.dp)) {
            state.confirm("Thanks for your feedback", "“${state.reportReason}” has been noted in this local preview. No report has been sent.", "Done") { state.navigate(26) }
        }
    }
}
