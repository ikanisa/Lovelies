package com.lovelies.frontend.preview

import androidx.compose.foundation.horizontalScroll

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONObject

private val LibraryOrder = listOf(1,0,2,3,4,5,8,6,7,9,10,11,12,13,14,15,16,17)

@Composable
fun GalleryScreen(state: PreviewState) {
    when(state.route) {
        10 -> HomeGallery(state)
        11 -> NewMatches(state)
        12 -> PhotoViewer(state)
        13 -> AllPhotos(state)
        14 -> Favorites(state)
        15 -> Search(state)
        16 -> Filters(state)
        17 -> Activity(state)
        18 -> Notifications(state)
    }
}

@Composable
private fun HomeGallery(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Column(Modifier.fillMaxSize().padding(horizontal = 9.dp)) {
        Row(Modifier.fillMaxWidth().height(68.dp), verticalAlignment = Alignment.CenterVertically) {
            Asset("wordmark.png", Modifier.width(153.dp).height(62.dp).clickable(role = Role.Button) { state.catalogVisible = true },
                uiContext.getString(R.string.copy_lovelies_open_all_screens_8e9266fc), ContentScale.Fit)
            Spacer(Modifier.weight(1f))
            IconAction(Glyph.SEARCH, uiContext.getString(R.string.copy_search_photos_8e006842), tonal = true, onClick = { state.navigate(15) })
            Spacer(Modifier.width(9.dp))
            IconAction(Glyph.BELL, uiContext.getString(R.string.copy_notifications_753a22b2), tonal = true, onClick = { state.navigate(18) })
        }
        HomePhotoCollage(state, Modifier.weight(1f))
        BottomBar(state, 10, Modifier.padding(bottom = 3.dp))
    }
}

private data class HomeTile(val id: Int, val asset: String, val x: Float, val y: Float, val width: Float, val height: Float)

@Composable
private fun HomePhotoCollage(state: PreviewState, modifier: Modifier = Modifier) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val context = LocalContext.current
    val tiles = remember {
        val source = context.assets.open("home-grid.json").bufferedReader().use { it.readText() }
        val array = JSONObject(source).getJSONArray("tiles")
        (0 until array.length()).map { index ->
            val item = array.getJSONObject(index)
            HomeTile(item.getInt("id"), item.getString("asset"), item.getDouble("x").toFloat(),
                item.getDouble("y").toFloat(), item.getDouble("width").toFloat(), item.getDouble("height").toFloat())
        }
    }
    BoxWithConstraints(modifier.fillMaxWidth()) {
        val width = maxWidth
        val height = maxHeight
        tiles.forEach { tile ->
            Asset(tile.asset, Modifier.offset(x = width * tile.x, y = height * tile.y)
                .width(width * tile.width).height(height * tile.height).clip(RoundedCornerShape(7.dp))
                .clickable(role = Role.Button) { state.openPhoto(tile.id - 1,asset = tile.asset) }
                .semantics { contentDescription = uiContext.getString(R.string.copy_open_home_photo_1_s_53fbb99f, tile.id.toString()) }, null)
        }
    }
}

@Composable
private fun NewMatches(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Column(Modifier.fillMaxSize().padding(horizontal = 14.dp)) {
        Row(Modifier.fillMaxWidth().height(56.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(uiContext.getString(R.string.copy_new_matches_2c63d230), color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.heightIn(min=48.dp).clickable(role = Role.Button) { state.navigate(25) }.padding(vertical=10.dp))
            AppIcon(Glyph.BACK, Modifier.padding(start = 10.dp).size(21.dp).graphicsLayer { rotationZ = 180f })
            Spacer(Modifier.weight(1f))
            IconAction(Glyph.BACK, uiContext.getString(R.string.copy_match_results_03437ab8), Modifier.graphicsLayer { rotationZ = 180f }, onClick = { state.navigate(25) })
        }
        Row(Modifier.fillMaxWidth().padding(bottom = 13.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
            listOf(0,2,4,6).forEachIndexed { index, person ->
                Box(Modifier.height(94.dp)) {
                    Avatar(person, size = 71.dp, selected = index < 3, onClick = { state.openPerson(person) })
                    Box(Modifier.align(Alignment.BottomCenter).width(48.dp).height(48.dp).clip(CircleShape)
                        .background(if(index < 3)Pink else Panel).clickable(role = Role.Button) { state.openPerson(person) }.semantics { contentDescription=uiContext.getString(R.string.copy_open_1_s_matches_aa8773d9, PeopleNames[person]) },
                        contentAlignment = Alignment.Center) {
                        Text(listOf("24","18","12","+6")[index], color = if(index < 3)Ink else Color.White,
                            fontSize = 15.sp, fontWeight = FontWeight.Medium)
                    }
                }
            }
        }
        if(state.referenceGrids.containsKey(11))SourcePhotoGrid(state,11,Modifier.weight(1f),favoriteBadges = true,
            onPhotoClick = { index,asset -> state.openPhoto(index,27,asset) })
        else PhotoGrid(state, Modifier.weight(1f), photos = listOf(10,6,9,4,2,0,8,15,5,7,1,13),
            selectable = true, selections = listOf(10,6,4,0,15), onPhotoClick = { state.openPhoto(it,27) })
        BottomBar(state, 11, Modifier.padding(bottom = 3.dp))
    }
}

@Composable
private fun PhotoViewer(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Box(Modifier.fillMaxSize()) {
        Asset(state.selectedPhotoAsset ?: photoAsset(state.selectedPhoto), Modifier.fillMaxSize(), uiContext.getString(R.string.copy_photo_1_s_b27fd7d6, (state.selectedPhoto + 1).toString()))
        Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            IconAction(Glyph.BACK, uiContext.getString(R.string.copy_back_to_gallery_b196a021), onClick = state::back)
            Spacer(Modifier.weight(1f))
            Overflow(state)
        }
        Row(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(80.dp).background(Ink.copy(alpha = .82f))
            .padding(horizontal = 17.dp), verticalAlignment = Alignment.CenterVertically) {
            Avatar(0, size = 42.dp, selected = true, onClick = { state.navigate(27) })
            Avatar(2, size = 42.dp, selected = true, onClick = { state.navigate(27) })
            Box(Modifier.size(48.dp).clip(CircleShape).background(Panel).clickable(role = Role.Button) { state.navigate(27) },
                contentAlignment = Alignment.Center) { Text("+3", color = Color.White, fontSize = 14.sp,modifier=Modifier.semantics { contentDescription=uiContext.getString(R.string.a11y_more_matched_people) }) }
            Spacer(Modifier.weight(1f))
            Box(Modifier.size(48.dp).clip(CircleShape).background(Ink.copy(alpha = .55f))
                .clickable(role = Role.Button) { state.toggleFavorite(state.selectedPhoto) }
                .semantics { contentDescription = if(state.selectedPhoto in state.favorites)uiContext.getString(R.string.copy_remove_from_favorites_c23fbb86) else uiContext.getString(R.string.copy_add_to_favorites_09c13814) }, contentAlignment = Alignment.Center) {
                AppIcon(Glyph.HEART, Modifier.size(27.dp), if(state.selectedPhoto in state.favorites)Pink else Color.White,
                    filled = state.selectedPhoto in state.favorites)
            }
            Spacer(Modifier.width(12.dp))
            IconAction(Glyph.SHARE, uiContext.getString(R.string.copy_share_this_photo_d256ff28), tonal = true, onClick = { state.navigate(29, seed = true) })
        }
    }
}

@Composable
private fun AllPhotos(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    var columns by remember { mutableIntStateOf(3) }
    Column(Modifier.fillMaxSize().padding(horizontal = 14.dp)) {
        Row(Modifier.fillMaxWidth().heightIn(min=63.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(uiContext.getString(R.string.copy_photos_cde554d0), color = Color.White, fontSize = 25.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.weight(1f))
            IconAction(Glyph.GRID, uiContext.getString(R.string.copy_change_photo_grid_b5a5af97), onClick = { columns = if(columns == 3)2 else 3 })
        }
        Segments(listOf("All","People","Places","Videos"), state.category) { state.category = it }
        Spacer(Modifier.height(15.dp))
        val photos = when(state.category) {
            "People" -> LibraryOrder.filter { it in listOf(0,4,7,9,10,11,15,16,17) }
            "Places" -> LibraryOrder.filter { it in listOf(1,3,5,6,12,13,14) }
            "Videos" -> listOf(9,11,15)
            else -> LibraryOrder
        }
        if(state.category == "All" && columns == 3) SourceAllLibrary(state, Modifier.weight(1f))
        else PhotoGrid(state, Modifier.weight(1f), photos = photos, columns = columns)
    }
}

@Composable
private fun SourceAllLibrary(state: PreviewState, modifier: Modifier = Modifier) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val columns = listOf(listOf(1,3,8,9), listOf(0,5,6,10), listOf(2,4,7,11,13))
    val widths = listOf(70f,80f,69f)
    val ratios = listOf(listOf(1.32f,1.35f,.8f,1.5f), listOf(1.58f,1.05f,1.1f,1.02f),
        listOf(1f,1.1f,1.45f,1f,1.4f))
    Row(modifier.fillMaxWidth().verticalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        columns.forEachIndexed { column, photos ->
            Column(Modifier.weight(widths[column]), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                photos.forEachIndexed { position, index ->
                    Asset(photoAsset(index), Modifier.fillMaxWidth().aspectRatio(1f / ratios[column][position])
                        .clip(RoundedCornerShape(9.dp)).clickable(role = Role.Button) { state.openPhoto(index) }
                        .semantics { contentDescription = uiContext.getString(R.string.copy_open_photo_1_s_9b52d988, (index+1).toString()) }, null)
                }
            }
        }
    }
}

@Composable
private fun Favorites(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Column(Modifier.fillMaxSize().padding(horizontal = 14.dp)) {
        Row(Modifier.fillMaxWidth().height(70.dp), verticalAlignment = Alignment.CenterVertically) {
            IconAction(Glyph.BACK, uiContext.getString(R.string.back), onClick = state::back)
            AppIcon(Glyph.HEART, Modifier.size(32.dp), Pink, filled = true)
            Text(uiContext.getString(R.string.copy_favorites_7c2c53ba), color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(start = 13.dp))
            Spacer(Modifier.weight(1f))
            Overflow(state)
        }
        if(state.referenceGrids.containsKey(14))SourcePhotoGrid(state,14,Modifier.weight(1f),favoriteBadges = true)
        else PhotoGrid(state, Modifier.weight(1f), photos = (listOf(1,2,9,11,0,17,5,12,10,16,13,15) + state.favorites).distinct(),
            favorites = true, onPhotoClick = { state.openPhoto(it) })
    }
}

@Composable
private fun Search(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Row(Modifier.fillMaxWidth().height(60.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(uiContext.getString(R.string.copy_search_c646a2c9), color = Color.White, fontSize = 25.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.weight(1f));IconAction(Glyph.FILTER, uiContext.getString(R.string.filters), onClick = { state.navigate(16) })
        }
        SearchInput(state.search, uiContext.getString(R.string.copy_search_photos_people_places_17ddeeb5), onValue = { state.search = it }, onFilter = { state.navigate(16) })
        Spacer(Modifier.height(15.dp))
        CategoryButtons(listOf("People" to Glyph.PEOPLE, "Places" to Glyph.LOCATION, "Dates" to Glyph.CALENDAR, "Favorites" to Glyph.HEART)) {
            if(it == "Favorites") state.navigate(14) else { state.filterCategory = it; state.navigate(16) }
        }
        SectionTitle(uiContext.getString(R.string.copy_recent_50e888fe), Modifier.padding(top = 13.dp))
        val recent = listOf("Sunsets" to 9, "Travel" to 6, "Friends" to 10, "Food" to 7)
        AdaptiveChoices(recent.map { it.first },labelSize=12.sp,minimumItemWidth=74.dp,spacing=9.dp) { position,itemModifier ->
            val (label,index)=recent[position]
            Column(itemModifier.heightIn(min=48.dp).clickable(role = Role.Button) { state.search = label }
                .semantics { contentDescription=label }, horizontalAlignment = Alignment.CenterHorizontally) {
                Asset(state.referenceGrids[15]?.recentAssets?.getOrNull(position) ?: photoAsset(index), Modifier.widthIn(max=96.dp).fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(22.dp)), null)
                Text(label, color = Color.White, fontSize = 12.sp, modifier = Modifier.padding(top = 7.dp).clearAndSetSemantics { })
            }
        }
        SectionTitle(if(state.search.isBlank())uiContext.getString(R.string.copy_results_9cf82695) else uiContext.getString(R.string.copy_results_for_1_s_d750bbf8, state.search), Modifier.padding(top = 14.dp))
        val query = state.search.trim().lowercase()
        val results = when {
            query.isEmpty() -> listOf(9,6,10,0,16,5,15,7,2,1)
            query.contains("sun") -> listOf(0,9,15,10)
            query.contains("travel") || query.contains("place") -> listOf(1,3,6,12,13)
            query.contains("friend") || query.contains("people") -> listOf(4,10,11,7)
            query.contains("dog") || query.contains("pet") -> listOf(2,8)
            query.contains("sophie") || query.contains("jasmine") -> listOf(0,5,7,15)
            query.contains("food") -> listOf(7,11)
            else -> emptyList()
        }
        if(results.isEmpty()) {
            Column(Modifier.weight(1f).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                AppIcon(Glyph.SEARCH, Modifier.size(46.dp), Muted)
                Text(uiContext.getString(R.string.copy_no_photos_found_67280e97), color = Color.White, fontSize = 20.sp, modifier = Modifier.padding(top = 18.dp))
                BodyText(uiContext.getString(R.string.copy_try_a_person_a_place_or_sunsets_64c84221), Modifier.padding(top = 8.dp))
                Text(uiContext.getString(R.string.clear_search), color = Pink, modifier = Modifier.heightIn(min=48.dp).clickable(role=Role.Button) { state.search = "" }.padding(18.dp))
            }
        } else if(state.search.isBlank() && state.referenceGrids.containsKey(15))SourcePhotoGrid(state,15,Modifier.weight(1f),favoriteBadges = true)
        else PhotoGrid(state, Modifier.weight(1f), photos = results, favorites = true)
    }
}

@Composable
fun CategoryButtons(items: List<Pair<String,Glyph>>, selected: String? = null, onClick: (String) -> Unit) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val labels=items.map { choiceLabel(uiContext,it.first) }
    AdaptiveChoices(labels,labelSize=12.sp,minimumItemWidth=64.dp,spacing=9.dp) { index,itemModifier ->
        val (label,icon)=items[index]
        val displayLabel=labels[index]
        Column(itemModifier.heightIn(min=78.dp).clip(RoundedCornerShape(19.dp))
            .background(if(selected == label)Pink else Panel).clickable(role = Role.Button) { onClick(label) }
            .semantics { contentDescription=displayLabel;if(selected!=null)this.selected=selected==label },
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            AppIcon(icon, Modifier.size(28.dp), if(selected == label)Ink else Color.White)
            Text(displayLabel, color = if(selected == label)Ink else Color.White, fontSize = 12.sp,
                modifier = Modifier.padding(top = 7.dp).clearAndSetSemantics { })
        }
    }
}

@Composable
private fun Filters(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val selectedPeople = remember { mutableStateListOf(0) }
    Column(Modifier.fillMaxSize().padding(horizontal = 17.dp)) {
        Row(Modifier.fillMaxWidth().heightIn(min=63.dp), verticalAlignment = Alignment.CenterVertically) {
            IconAction(Glyph.BACK, uiContext.getString(R.string.back), onClick = state::back)
            Text(uiContext.getString(R.string.filters), color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.weight(1f))
            Text(uiContext.getString(R.string.copy_reset_0ac8a560), color = SoftPink, fontSize = 14.sp, modifier = Modifier.clickable(role = Role.Button) {
                state.filterCategory = "People"; state.filterDate = "Any date"; state.filterLocation = "Any location"
                state.filterMedia = "Photos"; selectedPeople.clear(); selectedPeople.add(0)
            }.heightIn(min=48.dp).padding(12.dp))
        }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            CategoryButtons(listOf("People" to Glyph.PEOPLE,"Places" to Glyph.LOCATION,"Dates" to Glyph.CALENDAR,"Favorites" to Glyph.HEART),state.filterCategory) { state.filterCategory = it }
            SectionTitle(uiContext.getString(R.string.copy_people_8390060e), Modifier.padding(top = 13.dp))
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                listOf(0,1,2).forEach { index -> Avatar(index, size = 74.dp, selected = index in selectedPeople,
                    onClick = { if(index in selectedPeople)selectedPeople.remove(index) else selectedPeople.add(index) }) }
                IconAction(Glyph.ADD, uiContext.getString(R.string.copy_add_filter_person_7ed0e6a7), Modifier.size(74.dp).border(1.dp, Hairline, CircleShape), tonal = true,
                    onClick = { state.confirm(uiContext.getString(R.string.copy_more_people_9efd7b23), uiContext.getString(R.string.copy_include_1_s_in_your_photo_filters_ed309c00, "Olivia"), uiContext.getString(R.string.copy_add_1_s_91acf867, "Olivia")) { selectedPeople.add(4) } })
            }
            SectionTitle(uiContext.getString(R.string.copy_date_range_cab14770), Modifier.padding(top = 15.dp))
            SettingRow(choiceLabel(uiContext,state.filterDate), icon = Glyph.CALENDAR) {
                state.confirm(uiContext.getString(R.string.copy_date_range_24f5d5d0), uiContext.getString(R.string.copy_show_memories_from_the_last_30_days_24ee0352), uiContext.getString(R.string.copy_last_30_days_d0778b33)) { state.filterDate = "Last 30 days" }
            }
            SectionTitle(uiContext.getString(R.string.copy_location_5bc08dc6), Modifier.padding(top = 7.dp))
            SettingRow(if(state.filterLocation=="Any location")uiContext.getString(R.string.copy_any_location_12402400) else state.filterLocation, icon = Glyph.LOCATION) {
                state.confirm(uiContext.getString(R.string.copy_location_5bc08dc6), uiContext.getString(R.string.copy_choose_the_1_s_from_this_sample_libr_1356c953, "Amalfi Coast"), "Amalfi Coast") { state.filterLocation = "Amalfi Coast" }
            }
            SectionTitle(uiContext.getString(R.string.copy_media_type_74817611), Modifier.padding(top = 9.dp))
            CategoryButtons(listOf("Photos" to Glyph.PHOTO,"Videos" to Glyph.VIDEO,"Live Photos" to Glyph.LIVE),state.filterMedia) { state.filterMedia = it }
        }
        PinkButton(uiContext.getString(R.string.copy_show_results_342_f26e6d74), Modifier.padding(top = 17.dp, bottom = 16.dp)) {
            state.search = if(state.filterCategory == "Favorites")"" else if(state.filterLocation != "Any location")"Travel" else ""
            state.navigate(if(state.filterCategory == "Favorites")14 else 15)
        }
    }
}

@Composable
private fun Activity(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
        Row(Modifier.fillMaxWidth().height(64.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(uiContext.getString(R.string.copy_activity_9e75940c), color = Color.White, fontSize = 25.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.weight(1f));Overflow(state)
        }
        Segments(listOf("All","Matches","Shares","Mentions"), state.activityCategory) { state.activityCategory = it }
        Spacer(Modifier.height(14.dp))
        val entries = listOf(
            Triple(uiContext.getString(R.string.copy_1_s_matched_with_your_photos_7e7187b0, "Maya"), uiContext.getString(R.string.copy_2m_ago_e34617a1), "Matches"),
            Triple(uiContext.getString(R.string.copy_1_s_liked_3_of_your_photos_9c4314ed, "Alex"), uiContext.getString(R.string.copy_12m_ago_42c29158), "Mentions"),
            Triple(uiContext.getString(R.string.copy_you_and_1_s_matched_on_12_photos_e0888033, "Sam"), uiContext.getString(R.string.copy_1h_ago_2088d1f5), "Matches"),
            Triple(uiContext.getString(R.string.copy_1_s_shared_a_photo_with_you_ef353241, "Priya"), uiContext.getString(R.string.copy_3h_ago_b08b0a67), "Shares"),
            Triple(uiContext.getString(R.string.copy_new_people_found_in_your_photos_f2ee6649), uiContext.getString(R.string.copy_5h_ago_5e30b6a1), "Matches"))
        Column(Modifier.verticalScroll(rememberScrollState())) {
            entries.forEachIndexed { index,(title,time,category) ->
                if(state.activityCategory == "All" || state.activityCategory == category) {
                    Row(Modifier.fillMaxWidth().heightIn(min=113.dp).clickable(role = Role.Button) { state.navigate(if(category == "Shares")35 else 11) }
                        .semantics { contentDescription=uiContext.getString(R.string.copy_1_s_2_s_70b33c0c, title.replace('\n',' '), time) },
                        verticalAlignment = Alignment.CenterVertically) {
                        if(index in listOf(0,1,3))Avatar(listOf(6,2,4)[if(index == 3)2 else index],size = 57.dp,selected = index == 0)
                        else AppIcon(if(index == 2)Glyph.LINK else Glyph.PEOPLE, Modifier.size(53.dp), Pink)
                        Spacer(Modifier.width(16.dp))
                        Column(Modifier.weight(1f).clearAndSetSemantics { }) {
                            Text(title, color = Color.White, fontSize = 15.sp, lineHeight = 20.sp)
                            Text(time, color = Muted, fontSize = 12.sp, modifier = Modifier.padding(top = 5.dp))
                        }
                        Asset(photoAsset(listOf(4,9,10,15,6)[index]),Modifier.width(57.dp).height(76.dp).clip(RoundedCornerShape(7.dp)))
                        AppIcon(Glyph.BACK, Modifier.padding(start = 7.dp).size(16.dp).graphicsLayer { rotationZ = 180f })
                    }
                    DividerLine()
                }
            }
        }
    }
}

@Composable
private fun Notifications(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
        Row(Modifier.fillMaxWidth().height(64.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(uiContext.getString(R.string.copy_notifications_753a22b2), color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.weight(1f));IconAction(Glyph.MORE,uiContext.getString(R.string.copy_notification_settings_c3b8f497),tonal = true,onClick = { state.navigate(42) })
        }
        Segments(listOf("All","People","System"), state.notificationCategory) { state.notificationCategory = it }
        Spacer(Modifier.height(15.dp))
        val entries = listOf(
            Notice(uiContext.getString(R.string.copy_you_have_5_new_matches_948ca579),uiContext.getString(R.string.copy_2m_ago_e34617a1),Glyph.HEART,11,"People"),
            Notice(uiContext.getString(R.string.copy_1_s_joined_lovelies_and_found_you_4fbde4da, "Emma"),uiContext.getString(R.string.copy_14m_ago_0b375f92),Glyph.PEOPLE,28,"People"),
            Notice(uiContext.getString(R.string.copy_1_s_commented_on_your_photo_f9b69e3c, "Taylor"),uiContext.getString(R.string.copy_1h_ago_2088d1f5),Glyph.MESSAGE,17,"People"),
            Notice(uiContext.getString(R.string.copy_1_s_shared_a_photo_with_you_f3efc85d, "Jordan"),uiContext.getString(R.string.copy_2h_ago_9f5fadfa),Glyph.SHARE,35,"People"),
            Notice(uiContext.getString(R.string.copy_your_upload_is_complete_765bb558),uiContext.getString(R.string.copy_3h_ago_b08b0a67),Glyph.BELL,24,"System"),
            Notice(uiContext.getString(R.string.copy_new_memories_ready_to_explore_3dead6d1),uiContext.getString(R.string.copy_5h_ago_5e30b6a1),Glyph.STAR,10,"System"))
        Column(Modifier.verticalScroll(rememberScrollState())) {
            entries.filter { state.notificationCategory == "All" || it.category == state.notificationCategory }.forEach { item ->
                Row(Modifier.fillMaxWidth().heightIn(min=98.dp).clickable(role = Role.Button) { state.navigate(item.destination) }
                    .semantics { contentDescription=uiContext.getString(R.string.copy_1_s_2_s_70b33c0c, item.title.replace('\n',' '), item.time) },verticalAlignment = Alignment.CenterVertically) {
                    AppIcon(item.icon,Modifier.size(37.dp),Pink,filled = item.icon in listOf(Glyph.HEART,Glyph.STAR))
                    Spacer(Modifier.width(22.dp))
                    Column(Modifier.weight(1f).clearAndSetSemantics { }) {
                        Text(item.title,color = Color.White,fontSize = 15.sp,lineHeight = 20.sp)
                        Text(item.time,color = Muted,fontSize = 12.sp,modifier = Modifier.padding(top = 5.dp))
                    }
                    AppIcon(Glyph.BACK,Modifier.size(18.dp).graphicsLayer { rotationZ = 180f },Muted)
                }
                DividerLine()
            }
        }
    }
}

private data class Notice(val title: String, val time: String, val icon: Glyph, val destination: Int, val category: String)
