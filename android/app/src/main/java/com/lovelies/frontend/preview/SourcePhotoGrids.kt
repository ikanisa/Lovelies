package com.lovelies.frontend.preview

import android.content.Context
import android.graphics.BitmapFactory
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject

data class SourcePhotoTile(
    val id: Int, val asset: String, val x: Float, val y: Float, val width: Float, val height: Float,
    val sourceSelected: Boolean?, val peopleBadge: Boolean, val badgeKind: String?,
    val controlBounds: List<Float>?, val peopleBounds: List<Float>?, val controlBaked: Boolean,
    val badgeX: Float? = null, val badgeY: Float? = null, val badgeSize: Float? = null
)

data class SourcePhotoLayout(val tiles: List<SourcePhotoTile>, val heightToWidthRatio: Float = .44f,
    val recentAssets: List<String> = emptyList(), val cameraAsset: String? = null)

/** Screenshot-edge fragments need usable geometry before they become actual photo controls. */
internal fun accessibleSourceTiles(tiles: List<SourcePhotoTile>,width: Float,height: Float): List<SourcePhotoTile> {
    if(width<=0f || height<=0f || tiles.none { it.width*width<48f || it.height*height<48f })return tiles
    val columns=when { width>=330f -> 3; width>=198f -> 2; else -> 1 }
    val gap=6f
    val tileWidth=(width-gap*(columns-1))/columns
    val bottoms=FloatArray(columns)
    return tiles.map { tile ->
        val column=bottoms.indices.minByOrNull { bottoms[it] } ?: 0
        val imageRatio=(tile.height*height)/(tile.width*width).coerceAtLeast(.1f)
        val tileHeight=maxOf(96f,tileWidth*imageRatio)
        val top=bottoms[column]
        bottoms[column]=top+tileHeight+gap
        // Asset, identity, selected state and image-relative badge/crop metadata stay intact.
        tile.copy(x=column*(tileWidth+gap)/width,y=top/height,width=tileWidth/width,height=tileHeight/height)
    }
}

object SourcePhotoRepository {
    private var cached: Map<Int, SourcePhotoLayout>? = null

    fun load(context: Context): Map<Int, SourcePhotoLayout> {
        cached?.let { return it }
        val parsed = runCatching {
            val text = context.assets.open("reference-grids.json").bufferedReader().use { it.readText() }
            val root = JSONObject(text)
            val routes = root.optJSONObject("layouts") ?: root.optJSONObject("routes") ?: root
            buildMap {
                routes.keys().forEach { key ->
                    val route = key.toIntOrNull() ?: return@forEach
                    val routeObject = routes.getJSONObject(key)
                    val array = routeObject.getJSONArray("tiles")
                    val tiles = (0 until array.length()).map { position ->
                        val tile = array.getJSONObject(position)
                        val control = tile.optJSONArray("controlBounds")?.floatValues()
                        SourcePhotoTile(tile.getInt("id") - 1, tile.getString("asset"),
                            tile.getDouble("x").toFloat(),tile.getDouble("y").toFloat(),
                            tile.getDouble("width").toFloat(),tile.getDouble("height").toFloat(),
                            if(tile.has("selected"))tile.getBoolean("selected") else null,
                            tile.optBoolean("peopleBadge",false),tile.optString("badgeKind").let { if(it == "heart")"favorite" else it }.ifEmpty { null },
                            control,tile.optJSONArray("peopleBadgeBounds")?.floatValues(),tile.optBoolean("controlBaked",false),
                            if(tile.has("badgeX"))tile.getDouble("badgeX").toFloat() else null,
                            if(tile.has("badgeY"))tile.getDouble("badgeY").toFloat() else null,
                            if(tile.has("badgeSize"))tile.getDouble("badgeSize").toFloat() else null)
                    }
                    val bounds = routeObject.optJSONArray("sourceBounds")
                    val aspect = if(bounds != null && bounds.length() == 4 && bounds.getDouble(2)>bounds.getDouble(0))
                        ((bounds.getDouble(3)-bounds.getDouble(1))/(bounds.getDouble(2)-bounds.getDouble(0))).toFloat() else .44f
                    val recent = routeObject.optJSONArray("recentAssets")?.let { list -> (0 until list.length()).map { list.getString(it) } } ?: emptyList()
                    put(route,SourcePhotoLayout(tiles,aspect,recent,routeObject.optString("cameraAsset").ifEmpty { null }))
                }
            }
        }.getOrDefault(emptyMap())
        cached = parsed
        return parsed
    }

    private fun JSONArray.floatValues() = (0 until length()).map { getDouble(it).toFloat() }
}

@Composable
fun SourcePhotoGrid(
    state: PreviewState, sourceRoute: Int, modifier: Modifier = Modifier,
    selectable: Boolean = false, selections: List<Int> = emptyList(),
    favoriteBadges: Boolean = false, dimUnselected: Boolean = false, showPeople: Boolean = false,
    visibleIds: List<Int>? = null, tilesOverride: List<SourcePhotoTile>? = null,
    onPhotoClick: ((Int,String) -> Unit)? = null
) {
    val original = state.referenceGrids[29]?.tiles?.associateBy { it.id } ?: emptyMap()
    val sourceTiles = state.referenceGrids[sourceRoute]?.tiles?.map { tile ->
        if(sourceRoute == 30)original[tile.id]?.let { bright -> tile.copy(asset = bright.asset,
            controlBounds = bright.controlBounds ?: tile.controlBounds,peopleBounds = bright.peopleBounds ?: tile.peopleBounds,
            controlBaked = bright.controlBaked,badgeX = bright.badgeX,badgeY = bright.badgeY,badgeSize = bright.badgeSize) } ?: tile
        else tile
    } ?: emptyList()
    val tiles = (tilesOverride ?: sourceTiles)
        .filter { visibleIds == null || it.id in visibleIds }
    if(tiles.isEmpty()) {
        PhotoGrid(state,modifier,photos = visibleIds ?: (0..17).toList(),selectable = selectable,
            selections = selections,favorites = favoriteBadges,dimUnselected = dimUnselected,showPeople = showPeople,
            onPhotoClick = { index -> if(onPhotoClick != null)onPhotoClick(index,photoAsset(index)) else state.openPhoto(index) })
        return
    }
    BoxWithConstraints(modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))) {
        val galleryWidth = maxWidth
        val galleryHeight = galleryWidth * (state.referenceGrids[sourceRoute]?.heightToWidthRatio ?: .44f)
        val displayedTiles=accessibleSourceTiles(tiles,galleryWidth.value,galleryHeight.value)
        val contentHeight = galleryHeight * maxOf(1f,displayedTiles.maxOf { it.y+it.height })
        Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
          Box(Modifier.width(galleryWidth).height(contentHeight)) {
        displayedTiles.forEach { tile ->
            val selected = if(selectable)tile.id in selections else tile.sourceSelected == true
            val click = { if(onPhotoClick != null)onPhotoClick(tile.id,tile.asset) else state.openPhoto(tile.id,asset = tile.asset) }
            val interaction = if(selectable)Modifier.toggleable(value = selected,role = Role.Checkbox,onValueChange = { click() })
                else Modifier.clickable(role = Role.Button,onClick = click)
            BoxWithConstraints(Modifier.offset(x = galleryWidth*tile.x,y = galleryHeight*tile.y)
                .width(galleryWidth*tile.width).height(galleryHeight*tile.height)
                .clip(RoundedCornerShape(8.dp)).then(interaction).semantics {
                    contentDescription = "Photo ${tile.id+1}"
                }) {
                Asset(tile.asset,Modifier.fillMaxSize(),null,ContentScale.Crop)
                if(dimUnselected && !selected)Box(Modifier.fillMaxSize().background(Ink.copy(alpha = .48f)))
                val photoWidth = maxWidth
                val photoHeight = maxHeight
                val context = LocalContext.current
                val imageAspect = remember(tile.asset) {
                    runCatching {
                        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                        context.assets.open(tile.asset).use { BitmapFactory.decodeStream(it,null,options) }
                        options.outWidth.toFloat()/options.outHeight.toFloat()
                    }.getOrDefault(1f)
                }
                val paintedWidth = maxOf(photoWidth,photoHeight*imageAspect)
                val paintedHeight = maxOf(photoHeight,photoWidth/imageAspect)
                val cropX = (paintedWidth-photoWidth)/2
                val cropY = (paintedHeight-photoHeight)/2
                val bounds = tile.controlBounds
                if(selectable || favoriteBadges && (bounds != null || tile.sourceSelected == true ||
                    state.sourceSavedSelections["$sourceRoute:${tile.id}"] == true || sourceRoute == 14 && tile.id in state.favorites)) {
                    val kind = tile.badgeKind ?: if(sourceRoute == 14)"favorite" else"selection"
                    val checked = when {
                        selectable -> selected
                        kind == "saved" || kind == "selection" -> state.sourceSavedSelections["$sourceRoute:${tile.id}"] == true
                        else -> tile.id in state.favorites
                    }
                    val badgeModifier = if(bounds != null && bounds.size >= 4) {
                        Modifier.offset(x = paintedWidth*bounds[0]-cropX-1.dp,y = paintedHeight*bounds[1]-cropY-1.dp)
                            .width(paintedWidth*bounds[2]+2.dp).height(paintedHeight*bounds[3]+2.dp)
                    } else if(tile.badgeX != null && tile.badgeY != null && tile.badgeSize != null) {
                        val size = minOf(photoWidth,photoHeight)*tile.badgeSize
                        Modifier.offset(x = paintedWidth*tile.badgeX-cropX-size/2,y = paintedHeight*tile.badgeY-cropY-size/2).size(size)
                    } else Modifier.align(Alignment.TopEnd).padding(6.dp).size(27.dp)
                    val toggle = if(selectable)null else {
                        { if(kind == "saved" || kind == "selection")state.toggleSourceSaved(sourceRoute,tile.id) else state.toggleFavorite(tile.id) }
                    }
                    SourcePhotoBadge(checked,kind == "favorite",badgeModifier,null,tile.id)
                    if(toggle!=null) {
                        val centerX=when {
                            bounds!=null && bounds.size>=4 -> paintedWidth*(bounds[0]+bounds[2]/2)-cropX
                            tile.badgeX!=null -> paintedWidth*tile.badgeX-cropX
                            else -> photoWidth-19.5.dp
                        }
                        val centerY=when {
                            bounds!=null && bounds.size>=4 -> paintedHeight*(bounds[1]+bounds[3]/2)-cropY
                            tile.badgeY!=null -> paintedHeight*tile.badgeY-cropY
                            else -> 19.5.dp
                        }
                        Box(Modifier.offset(x=(centerX-24.dp).coerceIn(0.dp,maxOf(0.dp,photoWidth-48.dp)),
                            y=(centerY-24.dp).coerceIn(0.dp,maxOf(0.dp,photoHeight-48.dp))).size(48.dp)
                            .toggleable(checked,role=Role.Checkbox,onValueChange={toggle()})
                            .semantics { contentDescription="${if(kind=="favorite")"Favorite" else "Save"} photo ${tile.id+1}" })
                    }
                }
                if(!selectable && !favoriteBadges && tile.controlBaked && bounds != null && bounds.size >= 4) {
                    SourcePhotoBadge(false,false,Modifier.offset(x = paintedWidth*bounds[0]-cropX-1.dp,y = paintedHeight*bounds[1]-cropY-1.dp)
                        .width(paintedWidth*bounds[2]+2.dp).height(paintedHeight*bounds[3]+2.dp),null,tile.id)
                }
                if((showPeople || selectable) && tile.peopleBadge) {
                    val people = tile.peopleBounds
                    val badgeModifier = if(people != null && people.size >= 4)Modifier
                        .offset(x = paintedWidth*people[0]-cropX-1.dp,y = paintedHeight*people[1]-cropY-1.dp)
                        .width(paintedWidth*people[2]+2.dp).height(paintedHeight*people[3]+2.dp)
                        else Modifier.align(Alignment.BottomEnd).padding(5.dp).size(25.dp)
                    Box(badgeModifier.clip(CircleShape).background(if(selectable && selected)Pink else Ink.copy(alpha = .97f)),contentAlignment = Alignment.Center) {
                        AppIcon(Glyph.PEOPLE,Modifier.fillMaxSize().padding(3.dp),if(selectable && selected)Ink else Color.White)
                    }
                }
            }
        }
          }
        }
    }
}

@Composable
private fun SourcePhotoBadge(checked: Boolean, favorite: Boolean, modifier: Modifier,
    onToggle: (() -> Unit)?, photoId: Int) {
    val interaction = if(onToggle != null)Modifier.toggleable(value = checked,role = Role.Checkbox,onValueChange = { onToggle() })
        .semantics { contentDescription = "${if(favorite)"Favorite" else"Save"} photo ${photoId+1}" } else Modifier
    Box(modifier.clip(CircleShape).background(if(checked)Pink else Color(0xFF303036))
        .border(1.dp,if(checked)Pink else Color.White.copy(alpha = .8f),CircleShape).then(interaction),contentAlignment = Alignment.Center) {
        if(checked)AppIcon(if(favorite)Glyph.HEART else Glyph.CHECK,Modifier.fillMaxSize().padding(5.dp),Ink,filled = favorite)
    }
}

fun dynamicReviewTiles(state: PreviewState): List<SourcePhotoTile> {
    val source = state.referenceGrids[33]?.tiles ?: return emptyList()
    val selected = state.selectedSharePhotos.toList()
    val canonical = state.referenceGrids[29]?.tiles?.associateBy { it.id } ?: emptyMap()
    if(selected.isEmpty())return emptyList()
    val slotIds = source.map { it.id }.distinct().sorted()
    if(state.referenceReview33)return source.filter { it.id in selected }
    if(selected.all { it in slotIds })return source.filter { it.id in selected }.map { slot ->
        val image = canonical[slot.id]
        slot.copy(asset = image?.asset ?: photoAsset(slot.id),sourceSelected = null,peopleBadge = false,
            controlBounds = image?.controlBounds,peopleBounds = null,controlBaked = image?.controlBaked == true,
            badgeX = image?.badgeX,badgeY = image?.badgeY,badgeSize = image?.badgeSize)
    }
    return selected.mapIndexed { position,id ->
        val columns = 4
        val rows = (selected.size+columns-1)/columns
        val image = canonical[id]
        SourcePhotoTile(id,image?.asset ?: photoAsset(id),position%columns/columns.toFloat(),
            position/columns/rows.toFloat(),.24f,.96f/rows,null,false,null,image?.controlBounds,null,image?.controlBaked == true)
    }
}
