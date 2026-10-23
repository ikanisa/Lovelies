package com.lovelies.frontend.preview

import android.content.Context
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.unit.dp
import androidx.compose.ui.Alignment

class MainActivity : ComponentActivity() {
    private var activeState: PreviewState?=null
    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent);setIntent(intent);dispatchLink(intent)
    }
    private fun dispatchLink(intent: android.content.Intent) {
        val target=intent.dataString?.let { AppLink.parse(it) } ?: intent.getStringExtra("notification_id")?.let { runCatching { AppLink("notifications",NativeProtocol.id(it)) }.getOrNull() }
        if(target!=null)activeState?.live?.receiveLink(target)
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.BLACK)
        )
        setContent {
            // Scope fixture font variants to Compose; Activity resources may already be read
            // before onCreate, so applyOverrideConfiguration is unsafe here.
            val inheritedDensity=androidx.compose.ui.platform.LocalDensity.current
            val inheritedConfiguration=androidx.compose.ui.platform.LocalConfiguration.current
            val requestedScale=if(BuildConfig.REFERENCE_SCREENS && intent.getBooleanExtra("review",false))
                intent.getFloatExtra("reviewFontScale",0f) else 0f
            val reviewScale=requestedScale.takeIf { it in .85f..3f } ?: inheritedDensity.fontScale
            val reviewConfiguration=remember(inheritedConfiguration,reviewScale) {
                android.content.res.Configuration(inheritedConfiguration).apply { fontScale=reviewScale }
            }
            CompositionLocalProvider(
                androidx.compose.ui.platform.LocalDensity provides androidx.compose.ui.unit.Density(inheritedDensity.density,reviewScale),
                androidx.compose.ui.platform.LocalConfiguration provides reviewConfiguration
            ) {
            val context = LocalContext.current
            val state = remember { PreviewState(context, if(BuildConfig.REFERENCE_SCREENS)intent.getIntExtra("screen", 1) else 1, BuildConfig.REFERENCE_SCREENS && intent.getBooleanExtra("review", false)) }
            activeState=state
            LaunchedEffect(state) { dispatchLink(intent) }
            LaunchedEffect(state.reviewMode) { if(!state.reviewMode)state.live.start() }
            DisposableEffect(state) {
                val observer=androidx.lifecycle.LifecycleEventObserver { _,event ->
                    if(event==androidx.lifecycle.Lifecycle.Event.ON_RESUME)state.reduceMotion=!android.animation.ValueAnimator.areAnimatorsEnabled()
                    if(!state.reviewMode)when(event) {
                        androidx.lifecycle.Lifecycle.Event.ON_RESUME -> state.live.foreground()
                        androidx.lifecycle.Lifecycle.Event.ON_PAUSE -> state.live.background()
                        else -> Unit
                    }
                }
                lifecycle.addObserver(observer)
                onDispose { lifecycle.removeObserver(observer);state.live.dispose() }
            }
            MaterialTheme(colors = darkColors(primary = Pink, background = Ink, surface = Panel,
                onPrimary = Ink, onBackground = Color.White, onSurface = Color.White)) {
                BackHandler(enabled = state.canGoBack) { state.back() }
                Box(Modifier.fillMaxSize().background(Ink).windowInsetsPadding(WindowInsets.safeDrawing).imePadding()
                    .semantics { isTraversalGroup=true;paneTitle = if(state.catalogVisible)"All 48 screens" else
                        "Screen ${state.route.toString().padStart(2,'0')}: ${if(!state.reviewMode && state.route==38)"Manage your face" else if(!state.reviewMode && state.route==6 && state.live.hasLifecycle)"Face profile verification" else if(!state.reviewMode && state.route==6 && state.live.hasAccountRecovery)"Account recovery" else if(!state.reviewMode && state.route==44 && !state.live.registered)"Guest account deletion" else ScreenNames[state.route-1]}" }) {
                    AdaptiveRouteHost("${state.reviewMode}:${state.catalogVisible}:${state.route}",state.reduceMotion) {
                        Column(Modifier.fillMaxSize()) {
                            if(state.reviewMode && !state.catalogVisible && referenceNeedsExit(state.route)) {
                                Row(Modifier.fillMaxWidth().heightIn(min=48.dp),verticalAlignment=Alignment.CenterVertically) {
                                    IconAction(Glyph.BACK,context.getString(R.string.back),onClick=state::back)
                                }
                            }
                            Box(Modifier.weight(1f)) {
                                if (state.catalogVisible) ScreenCatalog(state)
                                else if(!state.reviewMode)LiveScreen(state)
                                else when (state.route) {
                                    in 1..9 -> OnboardingScreen(state)
                                    in 10..18 -> GalleryScreen(state)
                                    in 19..24 -> UploadScreen(state)
                                    in 25..36 -> SharingScreen(state)
                                    in 37..48 -> AccountScreen(state)
                                }
                            }
                        }
                    }
                    state.dialog?.let { dialog ->
                        AlertDialog(
                            onDismissRequest = { state.dialog = null },
                            backgroundColor = Panel,
                            shape = RoundedCornerShape(24.dp),
                            title = { Text(dialog.title, color = Color.White) },
                            text = { Text(dialog.message, color = Muted) },
                            confirmButton = {
                                TextButton(onClick = { state.dialog = null; dialog.action?.invoke() }) {
                                    Text(dialog.actionTitle, color = Pink)
                                }
                            },
                            dismissButton = if (dialog.action != null) {
                                { TextButton(onClick = { state.dialog = null }) { Text("Cancel", color = Muted) } }
                            } else null
                        )
                    }
                }
            }
            }
        }
    }
}

data class PreviewDialog(val title: String, val message: String,
    val actionTitle: String = "Got it", val action: (() -> Unit)? = null)

class PreviewState(private val context: Context, initialRoute: Int, reviewMode: Boolean = false) {
    var reviewMode by mutableStateOf(BuildConfig.REFERENCE_SCREENS && reviewMode);private set
    private val preferences = context.getSharedPreferences("lovelies_frontend_preview", Context.MODE_PRIVATE)
    val referenceGrids = if(BuildConfig.REFERENCE_SCREENS)SourcePhotoRepository.load(context) else emptyMap()
    var route by mutableIntStateOf(initialRoute.coerceIn(1, 48))
    private val history = mutableStateListOf<Int>()
    var catalogVisible by mutableStateOf(false)
    var reduceMotion by mutableStateOf(!android.animation.ValueAnimator.areAnimatorsEnabled())
    val canGoBack get()=catalogVisible || history.isNotEmpty() || fallbackBackRoute(route)!=null
    var dialog by mutableStateOf<PreviewDialog?>(null)
    var search by mutableStateOf("")
    var helpSearch by mutableStateOf("")
    var category by mutableStateOf("All")
    var activityCategory by mutableStateOf("All")
    var notificationCategory by mutableStateOf("All")
    var selectedPhoto by mutableIntStateOf(0)
    var selectedPhotoAsset by mutableStateOf<String?>(null)
    var referenceReview33 by mutableStateOf(initialRoute == 33)
    var selectedPerson by mutableIntStateOf(0)
    var photoAccess by mutableStateOf(preferences.getString("photoAccess", "All Photos") ?: "All Photos")
    var filterCategory by mutableStateOf("People")
    var filterMedia by mutableStateOf("Photos")
    var filterDate by mutableStateOf("Any date")
    var filterLocation by mutableStateOf("Any location")
    var peopleTab by mutableStateOf("Allowed")
    var profileTab by mutableIntStateOf(0)
    var selfieCount by mutableIntStateOf(0)
    var caption by mutableStateOf("")
    var uploadSource by mutableStateOf("From This Device")
    var uploadAlbum by mutableStateOf("Travels 2024")
    var visibility by mutableStateOf("Matched people only")
    var reportReason by mutableStateOf("This isn't me")
    var name by mutableStateOf(preferences.getString("profileName", "Jasmine") ?: "Jasmine")
    var email by mutableStateOf("jasmine@lovelies.app")
    var phone by mutableStateOf("+1 (555) 123-4567")
    var deviceCount by mutableIntStateOf(3)
    var discoverability by mutableStateOf(preferences.getString("discoverability", "Anyone") ?: "Anyone")
    var storageCacheMB by mutableIntStateOf(preferences.getInt("storageCacheMB", 180))
    var exportRequested by mutableStateOf(false)
    val historicalPeople = mapOf(12 to "Sam", 13 to "Jamie", 14 to "Robin")
    val blockedPeople = mutableStateListOf<Int>().apply { addAll(historicalPeople.keys) }
    val matchedPeople get() = PeopleNames.indices.toList()
    val allowedPeople get() = matchedPeople.filter { it !in blockedPeople }
    var selectedUpload = mutableStateListOf<Int>().apply { addAll((0..11).toList()) }
    var selectedSharePhotos = mutableStateListOf<Int>().apply { addAll(listOf(0, 1, 3, 4, 6, 7, 9, 11)) }
    var selectedRecipients = mutableStateListOf<Int>().apply { addAll(listOf(0, 1, 2, 4, 6)) }
    val eligibleSelectedRecipients get() = selectedRecipients.filter { it in allowedPeople }
    val favorites = mutableStateListOf<Int>().apply {
        val sourceFavorites = referenceGrids[14]?.tiles?.filter { it.sourceSelected == true && it.badgeKind == "favorite" }?.map { it.id }
        val defaults = sourceFavorites?.takeIf { it.isNotEmpty() } ?: listOf(2,5,8,10)
        addAll(preferences.getStringSet("favorites", defaults.map(Int::toString).toSet())!!.mapNotNull(String::toIntOrNull))
    }
    val savedPhotos = mutableStateListOf<Int>().apply {
        val defaults = referenceGrids[14]?.tiles?.filter { it.sourceSelected == true && it.badgeKind != "favorite" }?.map { it.id } ?: emptyList()
        addAll(preferences.getStringSet("savedPhotos",defaults.map(Int::toString).toSet())!!.mapNotNull(String::toIntOrNull))
    }
    val sourceSavedSelections = mutableStateMapOf<String,Boolean>().apply {
        referenceGrids.forEach { (route,layout) -> layout.tiles.forEach { tile ->
            this["$route:${tile.id}"] = preferences.getBoolean("sourceSaved:$route:${tile.id}",tile.sourceSelected == true)
        } }
    }
    val toggles = mutableStateMapOf<String, Boolean>().apply {
        mapOf("Allow others to save" to true, "Show location info" to false,
            "Show in suggestions" to true, "Analytics" to false, "New Matches" to true,
            "Messages" to true, "Mentions" to true, "Tips & Features" to true,
            "Reminders" to false, "Marketing" to false, "Two-Factor Authentication" to false)
            .forEach { (key, default) -> this[key] = preferences.getBoolean(key, default) }
    }

    val live=LiveController(this,context.applicationContext)
    init { if(reviewMode)seed(initialRoute) }

    fun enterReview() { if(!BuildConfig.REFERENCE_SCREENS)return;live.leaveForReview();reviewMode=true;catalogVisible=true }
    fun returnToLive() { catalogVisible=false;reviewMode=false;history.clear();route=2;live.foreground() }

    fun navigate(destination: Int, seed: Boolean = false) {
        val target=if(reviewMode)destination else live.route(destination)
        if (route != target) history.add(route)
        route = target
        if(destination == 33)referenceReview33 = seed
        if (seed) this.seed(destination)
        catalogVisible = false
        if(!reviewMode) { live.persistNavigation();live.onRoute(target) }
    }

    fun back() {
        if (catalogVisible) { catalogVisible = false; return }
        if(!reviewMode && route==6) { live.cancelFace();return }
        route = if (history.isNotEmpty()) history.removeAt(history.lastIndex) else fallbackBackRoute(route) ?: return
        if(!reviewMode) { route=live.route(route);live.persistNavigation();live.onRoute(route) }
    }

    private fun seed(id: Int) {
        when (id) {
            21, 22 -> { selectedUpload.clear(); selectedUpload.addAll(sourceSelection(21)?.takeIf { it.size == 12 } ?: (0..11).toList()) }
            29 -> { selectedSharePhotos.clear(); selectedSharePhotos.addAll(sourceSelection(29)?.takeIf { it.size == 8 } ?: listOf(0, 1, 3, 4, 6, 7, 9, 11)) }
            30 -> { selectedSharePhotos.clear(); selectedSharePhotos.addAll(sourceSelection(30)?.takeIf { it.size == 6 } ?: listOf(0, 3, 6, 7, 9, 11)) }
            31 -> { selectedRecipients.clear(); selectedRecipients.addAll(listOf(0, 1, 2, 4, 6)) }
            32 -> { selectedRecipients.clear(); selectedRecipients.addAll(listOf(0, 4, 6)) }
            33, 34, 35 -> {
                selectedSharePhotos.clear(); selectedSharePhotos.addAll(referenceGrids[33]?.tiles?.map { it.id }?.distinct()?.takeIf { it.size == 6 } ?: listOf(0, 3, 6, 7, 9, 11))
                selectedRecipients.clear(); selectedRecipients.addAll(listOf(0, 4, 6))
                referenceReview33 = id == 33
            }
        }
        selectedRecipients.removeAll { it !in allowedPeople }
    }
    private fun sourceSelection(id: Int) = referenceGrids[id]?.tiles?.filter { it.sourceSelected == true }?.map { it.id }?.distinct()

    fun togglePhoto(index: Int) {
        if (index in selectedSharePhotos) selectedSharePhotos.remove(index) else selectedSharePhotos.add(index)
    }
    fun toggleUpload(index: Int) {
        if (index in selectedUpload) selectedUpload.remove(index) else selectedUpload.add(index)
    }
    fun toggleRecipient(index: Int) {
        if(index !in allowedPeople)return
        if (index in selectedRecipients) selectedRecipients.remove(index) else selectedRecipients.add(index)
    }
    fun setPersonBlocked(index: Int, blocked: Boolean) {
        if(index !in matchedPeople && (blocked || index !in historicalPeople))return
        if(blocked) {
            if(index !in blockedPeople)blockedPeople.add(index)
            selectedRecipients.remove(index)
        } else blockedPeople.remove(index)
    }
    fun chooseDiscoverability(value: String) {
        if(value !in listOf("Anyone", "Matched people only", "Allowed people only"))return
        discoverability = value
        preferences.edit().putString("discoverability", value).apply()
    }
    fun toggleFavorite(index: Int) {
        if (index in favorites) favorites.remove(index) else favorites.add(index)
        preferences.edit().putStringSet("favorites", favorites.map(Int::toString).toSet()).apply()
    }
    fun toggleSaved(index: Int) {
        if(index in savedPhotos)savedPhotos.remove(index) else savedPhotos.add(index)
        preferences.edit().putStringSet("savedPhotos",savedPhotos.map(Int::toString).toSet()).apply()
    }
    fun toggleSourceSaved(route: Int,index: Int) {
        val key = "$route:$index"
        val checked = sourceSavedSelections[key] != true
        sourceSavedSelections[key] = checked
        if(checked && index !in savedPhotos)savedPhotos.add(index)
        else if(!checked)savedPhotos.remove(index)
        preferences.edit().putBoolean("sourceSaved:$key",checked).putStringSet("savedPhotos",savedPhotos.map(Int::toString).toSet()).apply()
    }
    fun toggle(key: String) {
        toggles[key] = !(toggles[key] ?: false)
        preferences.edit().putBoolean(key, toggles[key] == true).apply()
    }
    fun setAccess(value: String) {
        photoAccess = value
        preferences.edit().putString("photoAccess", value).apply()
    }
    fun rename(value: String) {
        name = value.trim().ifEmpty { "Jasmine" }
        preferences.edit().putString("profileName", name).apply()
    }
    fun clearCache() {
        storageCacheMB = 0
        preferences.edit().putInt("storageCacheMB", 0).apply()
    }
    fun resetPreview() {
        preferences.edit().clear().apply()
        name = "Jasmine"; email = "jasmine@lovelies.app"; phone = "+1 (555) 123-4567"
        photoAccess = "All Photos"; deviceCount = 3; storageCacheMB = 180; exportRequested = false
        uploadSource = "From This Device"
        blockedPeople.clear(); blockedPeople.addAll(historicalPeople.keys); peopleTab = "Allowed"
        discoverability = "Anyone"; favorites.clear()
        favorites.addAll(referenceGrids[14]?.tiles?.filter { it.sourceSelected == true && it.badgeKind == "favorite" }?.map { it.id } ?: listOf(2,5,8,10))
        savedPhotos.clear();savedPhotos.addAll(referenceGrids[14]?.tiles?.filter { it.sourceSelected == true && it.badgeKind != "favorite" }?.map { it.id } ?: emptyList())
        sourceSavedSelections.clear();referenceGrids.forEach { (route,layout) -> layout.tiles.forEach { tile -> sourceSavedSelections["$route:${tile.id}"] = tile.sourceSelected == true } }
        toggles.keys.toList().forEach { key -> toggles[key] = key in listOf("Allow others to save", "Show in suggestions", "New Matches", "Messages", "Mentions", "Tips & Features") }
    }
    fun toast(message: String) { Toast.makeText(context, message, Toast.LENGTH_SHORT).show() }
    fun info(title: String, text: String) { dialog = PreviewDialog(title, text) }
    fun confirm(title: String, text: String, actionTitle: String, action: () -> Unit) {
        dialog = PreviewDialog(title, text, actionTitle, action)
    }
    fun openPhoto(index: Int, destination: Int = 12, asset: String? = null) {
        selectedPhoto = index; selectedPhotoAsset = asset; navigate(destination)
    }
    fun openPerson(index: Int) { selectedPerson = index; navigate(28) }
}

val ScreenNames = listOf("Splash", "Introduction and how it works", "Sign in and join",
    "Photo access prompt", "Photo access options", "Face enrollment", "Face quality retry",
    "Processing", "Setup complete", "Home gallery", "New matches", "Photo viewer",
    "All photos", "Favorites and saved", "Search", "Filters", "Activity inbox", "Notifications",
    "Upload entry", "Upload source picker", "Select upload photos", "Review upload", "Upload progress",
    "Upload complete", "Match results summary", "Matched photos gallery", "Photo to people",
    "Person to photos", "Select photos to share", "Deselect photos", "Select people to share with",
    "Deselect people", "Review and share", "Sharing progress", "Shared history", "Report incorrect match",
    "Profile overview", "Face management", "Manage allowed recipients", "Privacy and sharing",
    "Photo access settings", "Notification settings", "Storage", "Data export", "Help center",
    "Account security and devices", "No matches", "Offline and error")

@Composable
private fun ScreenCatalog(state: PreviewState) {
    Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
        ScreenHeader("All 48 screens", onBack = { state.catalogVisible = false })
        Text("Native front-end preview · local sample data", color = Pink,
            style = MaterialTheme.typography.caption, modifier = Modifier.padding(bottom = 8.dp))
        Text("Sign-in, face capture, matching, upload and sharing are simulated. No photos or account data leave this app.",
            color = Muted, style = MaterialTheme.typography.body2, modifier = Modifier.padding(bottom = 14.dp))
        OutlineButton("Return to live app") { state.returnToLive() }
        LazyColumn(modifier=Modifier.weight(1f),verticalArrangement = Arrangement.spacedBy(4.dp)) {
            itemsIndexed(ScreenNames) { index, title ->
                SettingRow(title = title, subtitle = "Screen ${(index + 1).toString().padStart(2, '0')}",
                    icon = if (index < 9) Glyph.FACE else if (index < 36) Glyph.PHOTO else Glyph.PERSON,
                    onClick = { state.navigate(index + 1, seed = true) })
            }
        }
    }
}
