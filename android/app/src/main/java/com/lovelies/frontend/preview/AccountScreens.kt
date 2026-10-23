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
    var editVisible by remember { mutableStateOf(false) }
    Box(Modifier.fillMaxSize()) {
        Glow(strong = true)
        Column(Modifier.fillMaxSize().padding(horizontal = 15.dp),horizontalAlignment = Alignment.CenterHorizontally) {
            Box(Modifier.fillMaxWidth().height(48.dp)) { Box(Modifier.align(Alignment.CenterEnd)) { Overflow(state) } }
            Box(Modifier.size(157.dp)) {
                Avatar(0,Modifier.align(Alignment.Center),size = 153.dp,selected = false,onClick = { state.navigate(38) },label="Manage your face")
                Box(Modifier.align(Alignment.BottomEnd).size(48.dp).clip(CircleShape).background(Pink)
                    .clickable(role = Role.Button) { editVisible = true }.semantics { contentDescription = "Edit profile" },contentAlignment = Alignment.Center) {
                    AppIcon(Glyph.EDIT,Modifier.size(23.dp),Ink)
                }
            }
            Text(state.name,color = Color.White,fontSize = 24.sp,fontWeight = FontWeight.Medium,modifier = Modifier.padding(top = 10.dp))
            BodyText("Here for the good photos\nand great company ✨",Modifier.padding(top = 4.dp),size = 14)
            Row(Modifier.fillMaxWidth().padding(vertical = 19.dp),horizontalArrangement = Arrangement.SpaceEvenly) {
                listOf(Triple("248","Photos",13),Triple("36","Matches",11),Triple("12","People",39)).forEach { (number,title,destination) ->
                    Column(Modifier.weight(1f).heightIn(min=48.dp).clickable(role = Role.Button) { state.navigate(destination) },horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(number,color = Color.White,fontSize = 19.sp,fontWeight = FontWeight.Medium)
                        Text(title,color = Muted,fontSize = 13.sp,modifier = Modifier.padding(top = 4.dp))
                    }
                }
            }
            PinkButton("Edit Profile") { editVisible = true }
            Row(Modifier.fillMaxWidth().height(62.dp).padding(top = 7.dp,bottom = 7.dp),horizontalArrangement = Arrangement.SpaceEvenly) {
                listOf(Glyph.GRID,Glyph.HEART,Glyph.PERSON).forEachIndexed { index,icon ->
                    Box(Modifier.weight(1f).fillMaxHeight().padding(horizontal = 7.dp).clip(CircleShape)
                        .background(if(state.profileTab == index)Panel else Color.Transparent)
                        .clickable(role = Role.Tab) { state.profileTab = index }.semantics {
                            contentDescription=listOf("Profile photos","Profile favorites","Profile people")[index]
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
        if(editVisible) EditFieldDialog("Edit Profile","Display name",state.name,onDismiss = { editVisible = false }) {
            state.rename(it);editVisible = false
        }
    }
}

@Composable
private fun FaceManagement(state: PreviewState) {
    Column(Modifier.fillMaxSize().padding(horizontal = 18.dp),horizontalAlignment = Alignment.CenterHorizontally) {
        ScreenHeader("Manage Your Face",onBack = state::back)
        BodyText("Help Lovelies find you in photos\nacross your matches.",Modifier.padding(top = 4.dp,bottom = 18.dp),size = 15)
        Asset(state.referenceGrids[38]?.cameraAsset ?: "portrait.jpg",Modifier.fillMaxWidth(.80f).weight(1f).clip(RoundedCornerShape(24.dp)),"Your face preview")
        Row(Modifier.fillMaxWidth().padding(top = 17.dp,bottom = 22.dp),horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            repeat(4) { index ->
                Asset(state.referenceGrids[38]?.tiles?.getOrNull(index)?.asset ?: "person01.jpg",Modifier.weight(1f).aspectRatio(1f).clip(RoundedCornerShape(18.dp))
                    .border(if(index == 0)2.dp else 1.dp,if(index == 0)Pink else Hairline,RoundedCornerShape(18.dp))
                    .clickable(role = Role.Button) { state.toast("Face preview ${index+1} selected") },"Face preview ${index+1}")
            }
        }
        PinkButton("Replace Face") { state.selfieCount = 0;state.navigate(6) }
        SettingRow("Tips for best results",icon = Glyph.BULB,modifier = Modifier.padding(top = 15.dp,bottom = 17.dp)) {
            state.info("Tips for best results","Face the camera in even light. Keep your eyes visible, hold the phone steady, and capture three different angles. Face capture is simulated in this preview.")
        }
    }
}

@Composable
private fun ManagePeople(state: PreviewState) {
    val blocked = state.blockedPeople.distinct()
    val allowed = state.allowedPeople
    val allowedLabel = "Allowed (${allowed.size})"
    val blockedLabel = "Blocked (${blocked.size})"
    val viewingBlocked = state.peopleTab.startsWith("Blocked")
    Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
        ScreenHeader("Manage People",onBack = state::back)
        BodyText("Matched people are allowed by default unless blocked. You still review and approve photos before sharing.",
            Modifier.padding(top = 4.dp, bottom = 14.dp), center = false, size = 12)
        Segments(listOf(allowedLabel,blockedLabel),if(viewingBlocked)blockedLabel else allowedLabel) { state.peopleTab = it }
        Spacer(Modifier.height(10.dp))
        val entries = if(viewingBlocked)blocked else allowed
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            if(entries.isEmpty())BodyText(if(viewingBlocked)"No blocked people." else "No allowed matched people.",
                Modifier.padding(vertical = 22.dp), center = false)
            entries.forEach { index ->
                val name = PeopleNames.getOrNull(index) ?: state.historicalPeople[index] ?: "Blocked person"
                val sharingStatus = if(viewingBlocked)"Blocked" else"Can share with"
                Row(Modifier.fillMaxWidth().heightIn(min = 73.dp).clickable(role = Role.Button) {
                    state.confirm(name,if(viewingBlocked)"Allow future matching and sharing with this person? Previous access and excluded photos are not restored."
                        else "Block sharing with this matched person? They will also be removed from the current sample share.",
                        if(viewingBlocked)"Unblock person" else"Block person") {
                        state.setPersonBlocked(index, !viewingBlocked)
                    }
                }.semantics { contentDescription = "$name, $sharingStatus" },verticalAlignment = Alignment.CenterVertically) {
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
    var choosingDiscoverability by remember { mutableStateOf(false) }
    if(choosingDiscoverability)AlertDialog(onDismissRequest = { choosingDiscoverability = false },
        backgroundColor = Panel, shape = RoundedCornerShape(24.dp),
        title = { Text("Who can find you", color = Color.White) },
        text = { Column {
            BodyText("Choose who can find you through matching. Photos still need sharing approval.", center = false, size = 12)
            listOf("Anyone", "Matched people only", "Allowed people only").forEach { choice ->
                val selected = state.discoverability == choice
                Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).selectable(selected = selected, role = Role.RadioButton) {
                    state.chooseDiscoverability(choice); choosingDiscoverability = false
                }.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(choice, color = Color.White, fontSize = 14.sp, modifier = Modifier.weight(1f))
                    SelectionMark(selected)
                }
            }
        } }, confirmButton = { TextButton(onClick = { choosingDiscoverability = false }) { Text("Done", color = Pink) } })
    Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
        ScreenHeader("Privacy & Sharing",onBack = state::back)
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(17.dp)).background(Panel)) {
                SettingRow("Who can find you",state.discoverability,Glyph.PERSON) {
                    choosingDiscoverability = true
                }
                DividerLine(Modifier.padding(horizontal = 15.dp))
                SettingRow("Photo visibility",state.visibility,Glyph.PHOTO) {
                    state.confirm("Photo visibility","Photo access requires your approval for each matched recipient. Blocked people are excluded.","Approved recipients") {
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
                ToggleRow(state,"Analytics","Help us improve Lovelies",Glyph.ANALYTICS)
            }
            Row(Modifier.padding(top = 17.dp).fillMaxWidth().clip(RoundedCornerShape(17.dp))
                .background(Color(0xFF251E22)).border(1.dp,SoftPink.copy(alpha = .45f),RoundedCornerShape(17.dp))
                .padding(horizontal = 16.dp,vertical = 18.dp),verticalAlignment = Alignment.CenterVertically) {
                AppIcon(Glyph.SHIELD,Modifier.size(45.dp),Pink);Spacer(Modifier.width(17.dp))
                Column {
                    Text("Your privacy matters",color = SoftPink,fontSize = 16.sp)
                    Text("You choose each photo and recipient\nbefore sharing.",color = Muted,fontSize = 13.sp,
                        lineHeight = 18.sp,modifier = Modifier.padding(top = 6.dp))
                }
            }
        }
    }
}

@Composable
private fun PhotoAccess(state: PreviewState) {
    Column(Modifier.fillMaxSize().padding(horizontal = 18.dp),horizontalAlignment = Alignment.CenterHorizontally) {
        ScreenHeader("Photo Access",onBack = state::back)
        Spacer(Modifier.weight(.25f))
        Asset("photo-heart.png",Modifier.size(180.dp),scale = ContentScale.Fit)
        BodyText("Lovelies needs access to your\nphotos to find people in them.",Modifier.padding(top = 11.dp,bottom = 22.dp))
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(19.dp)).background(Panel)) {
            listOf(Triple("All Photos","Access to your entire library",Glyph.PHOTO),
                Triple("Selected Albums","Choose specific albums",Glyph.ALBUM),
                Triple("Limited Access","Allow only certain photos",Glyph.LOCK)).forEach { (title,subtitle,icon) ->
                val selected = state.photoAccess == title
                Row(Modifier.fillMaxWidth().heightIn(min=82.dp).border(if(selected)1.dp else 0.dp,if(selected)SoftPink else Color.Transparent,RoundedCornerShape(15.dp))
                    .selectable(selected=selected,role = Role.RadioButton,onClick={ state.setAccess(title) })
                    .semantics { contentDescription = "$title, $subtitle" }.padding(horizontal = 15.dp,vertical=12.dp),verticalAlignment = Alignment.CenterVertically) {
                    if(selected)SelectionMark(true) else AppIcon(icon,Modifier.size(27.dp))
                    Spacer(Modifier.width(17.dp))
                    Column(Modifier.weight(1f).clearAndSetSemantics { }) {
                        Text(title,color = Color.White,fontSize = 15.sp)
                        Text(subtitle,color = Muted,fontSize = 12.sp,modifier = Modifier.padding(top = 4.dp))
                    }
                    Box(Modifier.size(25.dp).clip(CircleShape).border(if(selected)5.dp else 1.dp,if(selected)Pink else Muted,CircleShape))
                }
            }
        }
        PinkButton("Continue",Modifier.padding(top = 18.dp)) { state.toast("Photo access preference saved in the preview");state.navigate(37) }
        Spacer(Modifier.weight(.25f))
    }
}

@Composable
private fun NotificationSettings(state: PreviewState) {
    Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
        ScreenHeader("Notifications",onBack = state::back)
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(Panel).verticalScroll(rememberScrollState())) {
            listOf(
                Triple("New Matches","When you're matched in photos",Glyph.HEART),
                Triple("Messages","When you receive a message",Glyph.MESSAGE),
                Triple("Mentions","When someone mentions you",Glyph.LINK),
                Triple("Tips & Features","Product updates and tips",Glyph.BULB),
                Triple("Reminders","Friendly nudges",Glyph.PHONE),
                Triple("Marketing","Special offers (optional)",Glyph.SHARE)).forEachIndexed { index,(title,subtitle,icon) ->
                ToggleRow(state,title,subtitle,icon)
                if(index < 5)DividerLine(Modifier.padding(horizontal = 15.dp))
            }
        }
    }
}

@Composable
private fun Storage(state: PreviewState) {
    val fontScale=androidx.compose.ui.platform.LocalDensity.current.fontScale
    Column(Modifier.fillMaxSize().padding(horizontal = 21.dp),horizontalAlignment = Alignment.CenterHorizontally) {
        ScreenHeader("Storage",onBack = state::back)
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
                Text(if(state.storageCacheMB == 0)"2.2 GB" else"2.4 GB",color = Color.White,fontSize = 27.sp)
                Text("of 5 GB used",color = Muted,fontSize = 15.sp,modifier = Modifier.padding(top = 6.dp))
            }
        }
        }
        Spacer(Modifier.height(20.dp))
        listOf(Triple("Photos","1.8 GB",Pink),Triple("Matches","420 MB",Violet),
            Triple("Cache","${state.storageCacheMB} MB",Color(0xFFE9E2CF)),Triple("Other","60 MB",Color(0xFFE9E2CF))).forEach { (label,value,color) ->
            Row(Modifier.fillMaxWidth().heightIn(min=36.dp).padding(vertical=4.dp),verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(18.dp).clip(CircleShape).background(color))
                Text(label,color = Color.White,fontSize = 15.sp,modifier = Modifier.padding(start = 15.dp).weight(1f))
                Text(value,color = Muted,fontSize = 14.sp)
            }
        }
        Spacer(Modifier.weight(.4f))
        PinkButton("Manage Storage",Modifier.padding(bottom = 20.dp)) {
            state.confirm("Manage Storage","Clear ${state.storageCacheMB} MB of sample cache? Your photos and matches will stay in this preview.","Clear cache") { state.clearCache() }
        }
    }
}

@Composable
private fun Export(state: PreviewState) {
    Column(Modifier.fillMaxSize().padding(horizontal = 20.dp),horizontalAlignment = Alignment.CenterHorizontally) {
        ScreenHeader("Export Your Data",onBack = state::back)
        Spacer(Modifier.weight(.25f))
        Box(Modifier.size(137.dp),contentAlignment = Alignment.Center) {
            GlowSymbol(Glyph.EXPORT,Modifier.size(133.dp),ring = false)
            AppIcon(Glyph.EXPORT,Modifier.size(89.dp),Pink)
        }
        BodyText("Download a copy of your\nphotos, matches and profile data.",Modifier.padding(top = 14.dp,bottom = 20.dp))
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(17.dp)).background(Panel).padding(20.dp),verticalAlignment = Alignment.Top) {
            AppIcon(Glyph.BULB,Modifier.size(27.dp));Spacer(Modifier.width(17.dp))
            Column {
                Text("Your data, your choice",color = Color.White,fontSize = 16.sp)
                listOf("Photos you've shared","Your matches and messages","Profile information","Settings and preferences").forEach { title ->
                    Row(Modifier.padding(top = 11.dp),verticalAlignment = Alignment.CenterVertically) {
                        AppIcon(Glyph.CHECK,Modifier.size(17.dp),Muted)
                        Text(title,color = Muted,fontSize = 13.sp,modifier = Modifier.padding(start = 9.dp))
                    }
                }
            }
        }
        Spacer(Modifier.weight(.35f))
        PinkButton(if(state.exportRequested)"View Export Summary" else"Request Export",Modifier.padding(bottom = 20.dp)) {
            state.exportRequested = true
            state.info("Preview export summary","Profile: ${state.name}\nSample library: 18 photos\nMatches: 12\nSharing preferences: included\n\nThis is a local front-end preview. No download or external request was made.")
        }
    }
}

@Composable
private fun HelpCenter(state: PreviewState) {
    Column(Modifier.fillMaxSize().padding(horizontal = 17.dp)) {
        ScreenHeader("Help Center",onBack = state::back)
        SearchInput(state.helpSearch,"Search for help...",onValue = { state.helpSearch = it })
        Spacer(Modifier.height(9.dp))
        val rows=listOf(
            Triple("Getting Started","Learn the basics",Glyph.SHIELD),
            Triple("Your Photos","Uploading, matching and more",Glyph.PHOTO),
            Triple("Privacy & Safety","Keeping your data safe",Glyph.SHIELD),
            Triple("Account & Settings","Manage your account",Glyph.GRID),
            Triple("Troubleshooting","Fix common issues",Glyph.HELP),
            Triple("Contact Support","We're here to help",Glyph.MESSAGE))
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            rows.filter { (it.first + it.second).contains(state.helpSearch,true) }.forEachIndexed { index,(title,subtitle,icon) ->
                SettingRow(title,subtitle,icon,modifier = Modifier.padding(bottom = 6.dp)) {
                    when(title) {
                        "Getting Started" -> state.info("Getting Started","Add photos, capture three preview selfies, explore your matches, and choose exactly which photos and people to share with. These actions use local sample data.")
                        "Your Photos" -> state.navigate(19)
                        "Privacy & Safety" -> state.navigate(40)
                        "Account & Settings" -> state.navigate(46)
                        "Troubleshooting" -> state.navigate(48)
                        else -> state.info("Contact Support","For this front-end preview, feedback stays on this device. No message has been sent. You can review every screen from the All 48 screens menu.")
                    }
                }
            }
            if(rows.none { (it.first + it.second).contains(state.helpSearch,true) })BodyText("No help articles found. Try “Photos” or “Privacy”.",Modifier.padding(top = 24.dp))
        }
    }
}

@Composable
private fun AccountSecurity(state: PreviewState) {
    var editing by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
        ScreenHeader("Account & Security",onBack = state::back)
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(17.dp)).background(Panel)) {
                SettingRow("Email",icon = Glyph.MAIL,trailing = state.email) { editing = "Email" }
                DividerLine(Modifier.padding(horizontal = 14.dp))
                SettingRow("Phone",icon = Glyph.PHONE,trailing = state.phone) { editing = "Phone" }
                DividerLine(Modifier.padding(horizontal = 14.dp))
                SettingRow("Password",icon = Glyph.LOCK,trailing = "•••••••••") {
                    state.info("Password","Authentication is simulated in this front-end preview. No real password is stored or changed.")
                }
                DividerLine(Modifier.padding(horizontal = 14.dp))
                SettingRow("Two-Factor Authentication",icon = Glyph.SHIELD,trailing = if(state.toggles["Two-Factor Authentication"] == true)"On" else"Off") {
                    state.toggle("Two-Factor Authentication")
                }
                DividerLine(Modifier.padding(horizontal = 14.dp))
                SettingRow("Active Devices",icon = Glyph.DEVICE,trailing = "${state.deviceCount} devices") {
                    state.confirm("Active Devices","Sample devices: iPhone 15, iPad and MacBook. Remove one sample device from this preview?","Remove sample") {
                        state.deviceCount = (state.deviceCount - 1).coerceAtLeast(1)
                    }
                }
            }
            Column(Modifier.padding(top = 16.dp).fillMaxWidth().clip(RoundedCornerShape(17.dp)).background(Panel)) {
                SettingRow("Sign Out",icon = Glyph.LOGOUT,accent = Color(0xFFFF7C9A)) {
                    state.confirm("Sign Out","Return to the local preview welcome screen?","Sign Out") { state.navigate(3) }
                }
                DividerLine(Modifier.padding(horizontal = 14.dp))
                SettingRow("Delete Account",icon = Glyph.TRASH,accent = Color(0xFFFF7C9A)) {
                    state.confirm("Reset preview account","This resets only sample profile preferences stored in this preview app. No real account exists or will be deleted.","Reset preview") {
                        state.resetPreview();state.navigate(3)
                    }
                }
            }
        }
    }
    editing?.let { field ->
        EditFieldDialog("Edit $field",field,if(field == "Email")state.email else state.phone,onDismiss = { editing = null }) { value ->
            if(field == "Email")state.email = value else state.phone = value
            editing = null
        }
    }
}

@Composable
private fun EditFieldDialog(title: String,label: String,currentValue: String,onDismiss: () -> Unit,onSave: (String) -> Unit) {
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
        },confirmButton = { TextButton(enabled = value.isNotBlank(),onClick = { onSave(value.trim()) }) { Text("Save",color = Pink) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel",color = Muted) } })
}

@Composable
private fun NoMatches(state: PreviewState) {
    Column(Modifier.fillMaxSize().padding(horizontal = 24.dp),horizontalAlignment = Alignment.CenterHorizontally) {
        Spacer(Modifier.weight(.55f))
        SourceHero("empty-hero.png",.598f,152f/144f)
        Text("No Matches Yet",color = Color.White,fontSize = 25.sp,fontWeight = FontWeight.Medium,
            modifier = Modifier.padding(top = 22.dp))
        BodyText("Your people are out there.\nKeep sharing your photos\nand we'll find them!",Modifier.padding(top = 15.dp),size = 16)
        Spacer(Modifier.weight(.6f))
        PinkButton("Keep Exploring",Modifier.padding(bottom = 31.dp)) { state.navigate(10) }
    }
}

@Composable
private fun Offline(state: PreviewState) {
    Column(Modifier.fillMaxSize().padding(horizontal = 27.dp),horizontalAlignment = Alignment.CenterHorizontally) {
        Spacer(Modifier.weight(.7f))
        SourceHero("offline-hero.png",.504f,128f/93f)
        Text("You're Offline",color = Color.White,fontSize = 25.sp,fontWeight = FontWeight.Medium,
            modifier = Modifier.padding(top = 18.dp))
        BodyText("Check your connection\nand try again.",Modifier.padding(top = 15.dp),size = 16)
        Spacer(Modifier.height(34.dp))
        PinkButton("Try Again") { state.toast("Preview connection restored");state.navigate(10) }
        Text("Go Back",color = Muted,fontSize = 14.sp,textDecoration = TextDecoration.Underline,
            modifier = Modifier.padding(top = 12.dp).sizeIn(minWidth=48.dp,minHeight=48.dp).clickable(role = Role.Button,onClick = state::back).padding(12.dp))
        Spacer(Modifier.weight(.4f))
    }
}
