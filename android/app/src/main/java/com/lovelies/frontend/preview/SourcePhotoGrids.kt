package com.lovelies.frontend.preview

import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.Bitmap
import androidx.compose.foundation.Image
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
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import kotlin.math.ceil
import kotlin.math.floor

data class SourcePhotoTile(
    val id: Int, val asset: String, val x: Float, val y: Float, val width: Float, val height: Float,
    val sourceSelected: Boolean?, val peopleBadge: Boolean, val badgeKind: String?,
    val controlBounds: List<Float>?, val peopleBounds: List<Float>?, val controlBaked: Boolean,
    val badgeX: Float? = null, val badgeY: Float? = null, val badgeSize: Float? = null
)

data class SourcePhotoLayout(val tiles: List<SourcePhotoTile>, val heightToWidthRatio: Float = .44f,
    val recentAssets: List<String> = emptyList(), val cameraAsset: String? = null)

internal data class SourcePhotoCrop(val left: Float=0f,val top: Float=0f,val right: Float=1f,val bottom: Float=1f) {
    val width get()=right-left
    val height get()=bottom-top
}

/** Keep the largest photographic rectangle of the same source asset, excluding
 * its reference UI markers and two source pixels of padding. No replacement art. */
internal fun sourceReflowCrop(tile: SourcePhotoTile,width: Int,height: Int,additionalMarkers: List<List<Float>> = emptyList()): SourcePhotoCrop {
    val unit=SourcePhotoCrop()
    if(width<=0 || height<=0)return unit
    val markers=(listOfNotNull(tile.controlBounds,tile.peopleBounds)+additionalMarkers).distinct().mapNotNull { bounds ->
        if(bounds.size!=4 || bounds.any { !it.isFinite() } || bounds[2]<=0 || bounds[3]<=0)null
        else SourcePhotoCrop((bounds[0]-2f/width).coerceIn(0f,1f),(bounds[1]-2f/height).coerceIn(0f,1f),
            (bounds[0]+bounds[2]+2f/width).coerceIn(0f,1f),(bounds[1]+bounds[3]+2f/height).coerceIn(0f,1f))
            .takeIf { it.width>0 && it.height>0 }
    }
    if(markers.isEmpty())return unit
    val xs=(listOf(0f,1f)+markers.flatMap { listOf(it.left,it.right) }).distinct().sorted()
    val ys=(listOf(0f,1f)+markers.flatMap { listOf(it.top,it.bottom) }).distinct().sorted()
    var best: SourcePhotoCrop?=null
    for(left in xs)for(right in xs.filter { it>left })for(top in ys)for(bottom in ys.filter { it>top }) {
        val candidate=SourcePhotoCrop(left,top,right,bottom)
        if(markers.none { left<it.right && right>it.left && top<it.bottom && bottom>it.top } &&
            candidate.width*candidate.height>(best?.let { it.width*it.height } ?: 0f))best=candidate
    }
    return best ?: unit
}
/** Identical image bytes can appear under a latent photo's different filename.
 * Only their baked-marker geometry is shared; photo/action identity stays local. */
internal fun sourceMarkerAliases(tiles: List<SourcePhotoTile>,digests: Map<String,String>): Map<String,List<List<Float>>> {
    val known=mutableMapOf<String,MutableList<List<Float>>>()
    for(tile in tiles) {
        val hash=digests[tile.asset]?.takeIf { it.matches(Regex("[0-9a-f]{64}")) } ?: continue
        known.getOrPut(hash) { mutableListOf() }.addAll(listOfNotNull(tile.controlBounds,tile.peopleBounds))
    }
    return digests.mapNotNull { (asset,hash) -> known[hash]?.let { asset to it.distinct() } }.toMap()
}
private data class ReflowSourceImage(val bitmap: ImageBitmap,val ratio: Float)
private fun reflowSourceImage(context: Context,tile: SourcePhotoTile): ReflowSourceImage?=runCatching {
    val source=context.assets.open(tile.asset).use(BitmapFactory::decodeStream) ?: return@runCatching null
    val crop=sourceReflowCrop(tile,source.width,source.height,SourcePhotoRepository.reflowMarkers(context,tile.asset))
    val left=ceil(crop.left*source.width).toInt().coerceIn(0,source.width-1)
    val top=ceil(crop.top*source.height).toInt().coerceIn(0,source.height-1)
    val right=floor(crop.right*source.width).toInt().coerceIn(left+1,source.width)
    val bottom=floor(crop.bottom*source.height).toInt().coerceIn(top+1,source.height)
    val image=Bitmap.createBitmap(source,left,top,right-left,bottom-top)
    ReflowSourceImage(image.asImageBitmap(),image.height.toFloat()/image.width)
}.getOrNull()

/** Screenshot-edge fragments need usable geometry before they become actual photo controls. */
internal fun accessibleSourceTiles(tiles: List<SourcePhotoTile>,width: Float,height: Float,ratios: Map<String,Float> = emptyMap()): List<SourcePhotoTile> {
    if(width<=0f || height<=0f || tiles.none { it.width*width<48f || it.height*height<48f })return tiles
    val columns=when { width>=330f -> 3; width>=198f -> 2; else -> 1 }
    val gap=6f
    val tileWidth=(width-gap*(columns-1))/columns
    val bottoms=FloatArray(columns)
    return tiles.map { tile ->
        val column=bottoms.indices.minByOrNull { bottoms[it] } ?: 0
        val imageRatio=(ratios[tile.asset] ?: ((tile.height*height)/(tile.width*width).coerceAtLeast(.1f))).coerceIn(.55f,2f)
        val tileHeight=maxOf(96f,tileWidth*imageRatio)
        val top=bottoms[column]
        bottoms[column]=top+tileHeight+gap
        // Asset, identity, selected state and image-relative badge/crop metadata stay intact.
        tile.copy(x=column*(tileWidth+gap)/width,y=top/height,width=tileWidth/width,height=tileHeight/height)
    }
}

object SourcePhotoRepository {
    private var cached: Map<Int, SourcePhotoLayout>? = null
    private var markerAliases: Map<String,List<List<Float>>>? = null

    fun reflowMarkers(context: Context,asset: String): List<List<Float>> {
        markerAliases?.let { return it[asset].orEmpty() }
        val tiles=load(context).values.flatMap { it.tiles }
        val digests=tiles.map { it.asset }.distinct().mapNotNull { name -> runCatching {
            val digest=MessageDigest.getInstance("SHA-256")
            context.assets.open(name).use { input ->
                val buffer=ByteArray(8192)
                while(true) { val count=input.read(buffer);if(count<0)break;if(count>0)digest.update(buffer,0,count) }
            }
            name to digest.digest().joinToString("") { "%02x".format(it) }
        }.getOrNull() }.toMap()
        val resolved=sourceMarkerAliases(tiles,digests);markerAliases=resolved
        return resolved[asset].orEmpty()
    }

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
    val uiContext = androidx.compose.ui.platform.LocalContext.current
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
        val reflow=tiles.any { it.width*galleryWidth.value<48f || it.height*galleryHeight.value<48f }
        val images=remember(tiles,reflow,uiContext) {
            if(reflow)tiles.mapNotNull { tile -> reflowSourceImage(uiContext,tile)?.let { tile.asset to it } }.toMap() else emptyMap()
        }
        val displayedTiles=accessibleSourceTiles(tiles,galleryWidth.value,galleryHeight.value,images.mapValues { it.value.ratio })
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
                    contentDescription = uiContext.getString(R.string.copy_photo_1_s_b27fd7d6, (tile.id+1).toString())
                }) {
                val image=images[tile.asset]
                if(reflow && image!=null)Image(image.bitmap,null,Modifier.fillMaxSize(),contentScale=ContentScale.Fit)
                else Asset(tile.asset,Modifier.fillMaxSize(),null,ContentScale.Crop)
                if(dimUnselected && !selected)Box(Modifier.fillMaxSize().background(Ink.copy(alpha = .48f)))
                val photoWidth = maxWidth
                val photoHeight = maxHeight
                val fittedWidth=if(reflow && image!=null)minOf(photoWidth,photoHeight/image.ratio) else photoWidth
                val fittedHeight=if(reflow && image!=null)fittedWidth*image.ratio else photoHeight
                val imageX=(photoWidth-fittedWidth)/2
                val imageY=(photoHeight-fittedHeight)/2
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
                    val badgeModifier = if(reflow) {
                        Modifier.offset(x=imageX+fittedWidth-32.dp,y=imageY+5.dp).size(27.dp)
                    } else if(bounds != null && bounds.size >= 4) {
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
                            reflow -> imageX+fittedWidth-18.5.dp
                            bounds!=null && bounds.size>=4 -> paintedWidth*(bounds[0]+bounds[2]/2)-cropX
                            tile.badgeX!=null -> paintedWidth*tile.badgeX-cropX
                            else -> photoWidth-19.5.dp
                        }
                        val centerY=when {
                            reflow -> imageY+18.5.dp
                            bounds!=null && bounds.size>=4 -> paintedHeight*(bounds[1]+bounds[3]/2)-cropY
                            tile.badgeY!=null -> paintedHeight*tile.badgeY-cropY
                            else -> 19.5.dp
                        }
                        Box(Modifier.offset(x=(centerX-24.dp).coerceIn(0.dp,maxOf(0.dp,photoWidth-48.dp)),
                            y=(centerY-24.dp).coerceIn(0.dp,maxOf(0.dp,photoHeight-48.dp))).size(48.dp)
                            .toggleable(checked,role=Role.Checkbox,onValueChange={toggle()})
                            .semantics { contentDescription=if(kind=="favorite")uiContext.getString(R.string.copy_favorite_photo_1_d_42e527c9, tile.id+1) else uiContext.getString(R.string.copy_save_photo_1_d_fdf6ba96, tile.id+1) })
                    }
                }
                if(!reflow && !selectable && !favoriteBadges && tile.controlBaked && bounds != null && bounds.size >= 4) {
                    SourcePhotoBadge(false,false,Modifier.offset(x = paintedWidth*bounds[0]-cropX-1.dp,y = paintedHeight*bounds[1]-cropY-1.dp)
                        .width(paintedWidth*bounds[2]+2.dp).height(paintedHeight*bounds[3]+2.dp),null,tile.id)
                }
                if((showPeople || selectable) && tile.peopleBadge) {
                    val people = tile.peopleBounds
                    val badgeModifier = if(reflow)Modifier.offset(x=imageX+fittedWidth-30.dp,y=imageY+fittedHeight-30.dp).size(25.dp)
                        else if(people != null && people.size >= 4)Modifier
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
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val interaction = if(onToggle != null)Modifier.toggleable(value = checked,role = Role.Checkbox,onValueChange = { onToggle() })
        .semantics { contentDescription = if(favorite)uiContext.getString(R.string.copy_favorite_photo_1_d_42e527c9, photoId+1) else uiContext.getString(R.string.copy_save_photo_1_d_fdf6ba96, photoId+1) } else Modifier
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
