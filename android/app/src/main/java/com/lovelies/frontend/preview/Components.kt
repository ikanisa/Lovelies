package com.lovelies.frontend.preview

import android.graphics.BitmapFactory
import androidx.compose.foundation.Canvas
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.staggeredgrid.LazyVerticalStaggeredGrid
import androidx.compose.foundation.lazy.staggeredgrid.StaggeredGridCells
import androidx.compose.foundation.lazy.staggeredgrid.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.*
import kotlin.math.*

val Ink = Color(0xFF09090B)
val Panel = Color(0xFF1A1B1D)
val Pink = Color(0xFFFF90B5)
val SoftPink = Color(0xFFE8ADC2)
val Muted = Color(0xFFB7B4BA)
val Hairline = Color(0xFF343438)
val Violet = Color(0xFFB890F5)

enum class Glyph { BACK, CLOSE, CHECK, ADD, ARROW, HEART, HOME, PERSON, PEOPLE,
    PHOTO, GRID, SEARCH, FILTER, BELL, SHARE, MORE, FACE, CAMERA, ALBUM, FILE,
    LOCK, LOCATION, CALENDAR, VIDEO, LIVE, MESSAGE, LINK, STAR, SHIELD, ANALYTICS,
    BULB, PHONE, MAIL, DEVICE, EXPORT, TRASH, LOGOUT, CLOUD_OFF, HELP, EDIT, APPLE, GOOGLE, SEND }

@Composable
fun AppIcon(glyph: Glyph, modifier: Modifier = Modifier, color: Color = Color.White, filled: Boolean = false) {
    Canvas(modifier.size(25.dp)) {
        scale(size.width / 24f, size.height / 24f, pivot = Offset.Zero) {
            val line = 1.55f
            fun segment(a: Float, b: Float, c: Float, d: Float) = drawLine(color, Offset(a,b), Offset(c,d), line, StrokeCap.Round)
            fun box(x: Float, y: Float, w: Float, h: Float, r: Float = 2f) = drawRoundRect(color, Offset(x,y), Size(w,h), CornerRadius(r,r), style = Stroke(line))
            fun circle(x: Float, y: Float, r: Float) = drawCircle(color, r, Offset(x,y), style = Stroke(line))
            fun path(vararg points: Float) {
                val p = Path(); p.moveTo(points[0],points[1]); for(i in 2 until points.size step 2) p.lineTo(points[i],points[i+1])
                drawPath(p,color,style = Stroke(line,cap = StrokeCap.Round,join = StrokeJoin.Round))
            }
            when (glyph) {
                Glyph.BACK -> path(15f,4f,7f,12f,15f,20f)
                Glyph.CLOSE -> { segment(5f,5f,19f,19f); segment(5f,19f,19f,5f) }
                Glyph.CHECK -> path(5f,12f,10f,17f,19f,7f)
                Glyph.ADD -> { segment(12f,5f,12f,19f); segment(5f,12f,19f,12f) }
                Glyph.ARROW -> { segment(4f,12f,20f,12f); path(13f,5f,20f,12f,13f,19f) }
                Glyph.HEART -> {
                    val p=Path().apply { moveTo(12f,21f); cubicTo(9f,18f,2f,13f,2f,8f); cubicTo(2f,2f,9f,1f,12f,6f); cubicTo(15f,1f,22f,2f,22f,8f); cubicTo(22f,13f,15f,18f,12f,21f); close() }
                    drawPath(p,color,style=if(filled) Fill else Stroke(line))
                }
                Glyph.HOME -> {
                    if(filled) {
                        val p=Path().apply { moveTo(3f,10f);lineTo(12f,3f);lineTo(21f,10f);lineTo(21f,21f)
                            lineTo(15f,21f);lineTo(15f,14f);lineTo(9f,14f);lineTo(9f,21f);lineTo(3f,21f);close() }
                        drawPath(p,color)
                    } else path(3f,10f,12f,3f,21f,10f,21f,21f,15f,21f,15f,14f,9f,14f,9f,21f,3f,21f,3f,10f)
                }
                Glyph.PERSON, Glyph.FACE -> {
                    circle(12f,7f,3.3f)
                    val p=Path().apply { moveTo(5f,21f); lineTo(5f,18f); cubicTo(5f,11f,19f,11f,19f,18f); lineTo(19f,21f); close() }
                    drawPath(p,color,style=Stroke(line)); if(glyph == Glyph.FACE) circle(12f,12f,11f)
                }
                Glyph.PEOPLE -> {
                    circle(9f,7f,3f); circle(18f,8f,2.5f)
                    val p=Path().apply { moveTo(2f,21f); lineTo(2f,18f); cubicTo(2f,11f,16f,11f,16f,18f); lineTo(16f,21f); close() }
                    drawPath(p,color,style=Stroke(line)); path(17f,13f,21f,15f,22f,20f,18f,20f)
                }
                Glyph.PHOTO, Glyph.ALBUM -> { box(3f,3f,18f,18f); circle(8f,8f,1.4f); path(4f,19f,10f,12f,13f,15f,17f,10f,20f,14f); if(glyph == Glyph.ALBUM) path(6f,1f,22f,1f,23f,18f) }
                Glyph.GRID -> { box(3f,3f,7f,7f,1f); box(14f,3f,7f,7f,1f); box(3f,14f,7f,7f,1f); box(14f,14f,7f,7f,1f) }
                Glyph.SEARCH -> { circle(10f,10f,6f); segment(15f,15f,21f,21f) }
                Glyph.FILTER -> { segment(3f,5f,21f,5f); segment(3f,12f,21f,12f); segment(3f,19f,21f,19f); circle(16f,5f,2f); circle(8f,12f,2f); circle(16f,19f,2f) }
                Glyph.BELL -> { val p=Path().apply { moveTo(4f,18f); lineTo(6f,15f); lineTo(6f,9f); cubicTo(6f,1f,18f,1f,18f,9f); lineTo(18f,15f); lineTo(20f,18f); close() }; drawPath(p,color,style=Stroke(line)); segment(9f,21f,15f,21f) }
                Glyph.SHARE -> { path(7f,8f,3f,8f,3f,22f,21f,22f,21f,8f,17f,8f); segment(12f,16f,12f,2f); path(7f,7f,12f,2f,17f,7f) }
                Glyph.SEND -> { val p=Path().apply { moveTo(2f,10f);lineTo(23f,1f);lineTo(15f,23f);lineTo(10f,14f);lineTo(2f,10f);close() };drawPath(p,color);segment(10f,14f,23f,1f) }
                Glyph.MORE -> { for(x in listOf(5f,12f,19f)) drawCircle(color,1.4f,Offset(x,12f)) }
                Glyph.CAMERA -> { box(2f,6f,20f,15f); path(6f,6f,8f,3f,16f,3f,18f,6f); circle(12f,13f,4f) }
                Glyph.FILE, Glyph.EXPORT -> { path(5f,2f,14f,2f,20f,8f,20f,22f,5f,22f,5f,2f); path(14f,2f,14f,8f,20f,8f); if(glyph==Glyph.EXPORT){segment(12f,10f,12f,19f);path(8f,15f,12f,19f,16f,15f)}else{segment(8f,12f,16f,12f);segment(8f,16f,16f,16f)} }
                Glyph.LOCK -> { box(4f,10f,16f,12f); val p=Path().apply { moveTo(7f,10f); lineTo(7f,6f); cubicTo(7f,0f,17f,0f,17f,6f); lineTo(17f,10f) }; drawPath(p,color,style=Stroke(line)); circle(12f,15f,1f);segment(12f,16f,12f,19f) }
                Glyph.LOCATION -> { val p=Path().apply { moveTo(12f,23f); cubicTo(10f,20f,4f,12f,4f,8f); cubicTo(4f,-1f,20f,-1f,20f,8f); cubicTo(20f,12f,14f,20f,12f,23f); close() }; drawPath(p,color,style=Stroke(line));circle(12f,8f,2.6f) }
                Glyph.CALENDAR -> { box(3f,5f,18f,17f); segment(3f,10f,21f,10f);segment(7f,2f,7f,7f);segment(17f,2f,17f,7f); for(x in listOf(7f,12f,17f)) for(y in listOf(14f,18f)) drawCircle(color,.6f,Offset(x,y)) }
                Glyph.VIDEO -> { box(2f,5f,14f,14f);path(16f,9f,22f,5f,22f,19f,16f,15f) }
                Glyph.LIVE -> { circle(12f,12f,4f);circle(12f,12f,8f);drawArc(color,20f,65f,false,Offset(1f,1f),Size(22f,22f),style=Stroke(line));drawArc(color,200f,65f,false,Offset(1f,1f),Size(22f,22f),style=Stroke(line)) }
                Glyph.MESSAGE -> { path(2f,3f,22f,3f,22f,17f,9f,17f,4f,22f,4f,17f,2f,17f,2f,3f);segment(6f,8f,18f,8f);segment(6f,12f,14f,12f) }
                Glyph.LINK -> { circle(8f,12f,6f);circle(16f,12f,6f) }
                Glyph.STAR -> { val p=Path(); for(i in 0..9){val a=(i*36.0-90)*PI/180;val r=if(i%2==0)11f else 5f;val x=12f+cos(a).toFloat()*r;val y=12f+sin(a).toFloat()*r;if(i==0)p.moveTo(x,y)else p.lineTo(x,y)};p.close();drawPath(p,color,style=if(filled)Fill else Stroke(line)) }
                Glyph.SHIELD -> { path(12f,2f,22f,6f,20f,16f,12f,23f,4f,16f,2f,6f,12f,2f);path(7f,12f,11f,16f,17f,9f) }
                Glyph.ANALYTICS -> { segment(4f,22f,4f,14f);segment(9f,22f,9f,8f);segment(14f,22f,14f,12f);segment(19f,22f,19f,2f) }
                Glyph.BULB -> { circle(12f,8f,6f);path(8f,13f,9f,19f,15f,19f,16f,13f);segment(10f,22f,14f,22f) }
                Glyph.PHONE -> { box(6f,1f,12f,22f);segment(10f,4f,14f,4f);drawCircle(color,.8f,Offset(12f,20f)) }
                Glyph.MAIL -> { box(2f,4f,20f,16f);path(3f,5f,12f,13f,21f,5f) }
                Glyph.DEVICE -> { box(3f,3f,18f,14f);path(1f,20f,23f,20f,20f,17f,4f,17f,1f,20f) }
                Glyph.TRASH -> { box(6f,6f,12f,16f,1f);segment(3f,6f,21f,6f);box(9f,2f,6f,4f,1f);segment(10f,10f,10f,19f);segment(14f,10f,14f,19f) }
                Glyph.LOGOUT -> { path(12f,3f,3f,3f,3f,21f,12f,21f);segment(8f,12f,23f,12f);path(18f,7f,23f,12f,18f,17f) }
                Glyph.CLOUD_OFF -> { val p=Path().apply { moveTo(7f,19f);cubicTo(-1f,18f,1f,10f,7f,10f);cubicTo(7f,0f,19f,0f,20f,10f);cubicTo(27f,10f,28f,20f,20f,20f);lineTo(13f,20f) };drawPath(p,color,style=Stroke(line));segment(5f,24f,20f,6f) }
                Glyph.HELP -> { circle(12f,12f,10f);val p=Path().apply{moveTo(8f,8f);cubicTo(8f,3f,18f,3f,16f,9f);lineTo(12f,13f);lineTo(12f,15f)};drawPath(p,color,style=Stroke(line));drawCircle(color,.9f,Offset(12f,19f)) }
                Glyph.EDIT -> { path(4f,18f,3f,22f,7f,21f,21f,7f,17f,3f,4f,18f);segment(14f,6f,18f,10f) }
                Glyph.APPLE -> { drawOval(color,Offset(5f,6f),Size(14f,16f));drawOval(color,Offset(12f,1f),Size(5f,5f));drawCircle(Ink,3f,Offset(20f,11f)) }
                Glyph.GOOGLE -> { drawArc(Color(0xFF4285F4),-45f,90f,false,Offset(3f,3f),Size(18f,18f),style=Stroke(3f));drawArc(Color(0xFF34A853),45f,90f,false,Offset(3f,3f),Size(18f,18f),style=Stroke(3f));drawArc(Color(0xFFFBBC05),135f,90f,false,Offset(3f,3f),Size(18f,18f),style=Stroke(3f));drawArc(Color(0xFFEA4335),225f,70f,false,Offset(3f,3f),Size(18f,18f),style=Stroke(3f));drawLine(Color(0xFF4285F4),Offset(12f,12f),Offset(21f,12f),3f) }
            }
        }
    }
}

@Composable
fun Asset(name: String, modifier: Modifier = Modifier, description: String? = null,
    scale: ContentScale = ContentScale.Crop) {
    val context = LocalContext.current
    val bitmap = remember(name) { runCatching { context.assets.open(name).use(BitmapFactory::decodeStream).asImageBitmap() }.getOrNull() }
    if (bitmap != null) Image(bitmap, description, modifier, contentScale = scale)
    else Box(modifier.background(Panel), contentAlignment = Alignment.Center) { AppIcon(Glyph.PHOTO, color = Muted) }
}

@Composable
fun SourceHero(name: String, widthFraction: Float, aspectRatio: Float, modifier: Modifier = Modifier) {
    BoxWithConstraints(modifier.fillMaxWidth(widthFraction)) {
        Asset(name,Modifier.fillMaxWidth().aspectRatio(aspectRatio),scale = ContentScale.Fit)
    }
}
fun photoAsset(index: Int) = "photo${(index % 18 + 1).toString().padStart(2,'0')}.jpg"
fun personAsset(index: Int) = "person${(index % 8 + 1).toString().padStart(2,'0')}.jpg"

@Composable
fun IconAction(glyph: Glyph, label: String, modifier: Modifier = Modifier, color: Color = Color.White,
    tonal: Boolean = false, onClick: () -> Unit) {
    Box(modifier.sizeIn(minWidth=48.dp,minHeight=48.dp).clip(CircleShape).then(if(tonal) Modifier.background(Panel) else Modifier)
        .clickable(role = Role.Button, onClick = onClick).semantics { contentDescription = label }, contentAlignment = Alignment.Center) {
        AppIcon(glyph, color = color)
    }
}

@Composable
fun PinkButton(text: String, modifier: Modifier = Modifier, enabled: Boolean = true,
    icon: Glyph? = null, onClick: () -> Unit) {
    Row(modifier.fillMaxWidth().heightIn(min=50.dp).clip(CircleShape).background(if(enabled)Pink else Pink.copy(alpha=.32f))
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick).semantics { contentDescription=text }.padding(horizontal=20.dp,vertical=14.dp),
        horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        if(icon!=null){ AppIcon(icon,Modifier.size(21.dp),Ink);Spacer(Modifier.width(10.dp)) }
        Text(text,color=if(enabled)Ink else Muted,fontSize=15.sp,fontWeight=FontWeight.SemiBold,textAlign=TextAlign.Center,modifier=Modifier.weight(1f).clearAndSetSemantics { })
    }
}

@Composable
fun OutlineButton(text: String, modifier: Modifier = Modifier, icon: Glyph? = null, light: Boolean = false,
    enabled: Boolean = true, onClick: () -> Unit) {
    Row(modifier.fillMaxWidth().heightIn(min=48.dp).clip(CircleShape).background(if(light)Color(0xFFF3EEF1) else Panel)
        .border(1.dp, Hairline, CircleShape).clickable(enabled=enabled,role = Role.Button, onClick = onClick).semantics { contentDescription=text }.padding(horizontal=20.dp,vertical=12.dp),
        horizontalArrangement=Arrangement.Center, verticalAlignment=Alignment.CenterVertically) {
        if(icon!=null){AppIcon(icon,Modifier.size(21.dp),if(light)Ink else Color.White);Spacer(Modifier.width(8.dp))}
        Text(text,color=if(light)Ink else Color.White,fontSize=15.sp,fontWeight=FontWeight.Medium,textAlign=TextAlign.Center,modifier=Modifier.weight(1f).clearAndSetSemantics { })
    }
}

@Composable
fun ScreenHeader(title: String, onBack: (() -> Unit)? = null, subtitle: String? = null,
    right: (@Composable () -> Unit)? = null, leading: Glyph = Glyph.BACK) {
    Row(Modifier.fillMaxWidth().heightIn(min=if(subtitle==null)58.dp else 72.dp),verticalAlignment=Alignment.CenterVertically) {
        Box(Modifier.width(48.dp),contentAlignment=Alignment.CenterStart) {
            if(onBack!=null) IconAction(leading,stringResource(if(leading==Glyph.CLOSE)R.string.a11y_close else R.string.back),onClick=onBack)
        }
        Column(Modifier.weight(1f).padding(vertical=10.dp,horizontal=4.dp),horizontalAlignment=Alignment.CenterHorizontally) {
            Text(title,color=Color.White,fontSize=18.sp,fontWeight=FontWeight.SemiBold,textAlign=TextAlign.Center,modifier=Modifier.semantics { heading() })
            if(subtitle!=null) Text(subtitle,color=Muted,fontSize=13.sp,modifier=Modifier.padding(top=4.dp).semantics { liveRegion=LiveRegionMode.Polite })
        }
        Box(Modifier.width(48.dp),contentAlignment=Alignment.CenterEnd) { if(right!=null)right() }
    }
}

@Composable
fun Overflow(state: PreviewState) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    var expanded by remember { mutableStateOf(false) }
    Box {
        IconAction(Glyph.MORE,uiContext.getString(R.string.copy_screen_actions_a1599566),tonal=true,onClick={expanded=true})
        androidx.compose.material.DropdownMenu(expanded=expanded,onDismissRequest={expanded=false},modifier=Modifier.background(Panel)) {
            val contextual=when(state.route) {
                29 -> listOf(uiContext.getString(R.string.copy_deselect_photos_d46d783f) to 30)
                31 -> listOf(uiContext.getString(R.string.copy_deselect_people_a3a304bd) to 32)
                26,27,28 -> listOf(uiContext.getString(R.string.copy_select_photos_to_share_52f9b7e4) to 29,uiContext.getString(R.string.copy_report_incorrect_match_cd851491) to 36)
                else -> emptyList()
            }
            val choices=contextual+(if(BuildConfig.REFERENCE_SCREENS)listOf(uiContext.getString(R.string.copy_all_48_screens_65cfa625) to 0) else emptyList())+listOf(uiContext.getString(R.string.copy_add_photos_12f5a599) to 19,uiContext.getString(R.string.copy_activity_9e75940c) to 17,uiContext.getString(R.string.copy_privacy_sharing_576d0d35) to 40,
                uiContext.getString(R.string.copy_manage_your_face_990044ce) to 38,uiContext.getString(R.string.copy_manage_people_a3539654) to 39,uiContext.getString(R.string.copy_photo_access_7b04cc07) to 41,uiContext.getString(R.string.copy_notifications_753a22b2) to 42,
                uiContext.getString(R.string.copy_storage_34eddf06) to 43,uiContext.getString(R.string.copy_export_your_data_726c5cda) to 44,uiContext.getString(R.string.copy_shared_history_966f258c) to 35,uiContext.getString(R.string.copy_account_security_fb84c56c) to 46,uiContext.getString(R.string.copy_help_center_bbf4ae03) to 45)
            choices.forEach{(label,id)-> androidx.compose.material.DropdownMenuItem(onClick={expanded=false;if(id==0)state.enterReview() else state.navigate(id)}){Text(label,color=Color.White)} }
        }
    }
}

@Composable
fun SectionTitle(title: String, modifier: Modifier = Modifier, trailing: String? = null,
    onTrailing: (() -> Unit)? = null) {
    Row(modifier.fillMaxWidth().padding(vertical=9.dp),verticalAlignment=Alignment.CenterVertically) {
        Text(title,color=Color.White,fontSize=16.sp,fontWeight=FontWeight.SemiBold,modifier=Modifier.weight(1f).semantics { heading() })
        if(trailing!=null) Text(trailing,color=Pink,fontSize=13.sp,modifier=Modifier.heightIn(min=48.dp).clickable(enabled=onTrailing!=null,role=Role.Button){onTrailing?.invoke()}.padding(12.dp))
    }
}

@Composable
fun BodyText(text: String, modifier: Modifier = Modifier, center: Boolean = true, size: Int = 15) {
    Text(text,color=Muted,fontSize=size.sp,lineHeight=(size+5).sp,
        textAlign=if(center)TextAlign.Center else TextAlign.Start,modifier=modifier)
}

@Composable
fun Avatar(index: Int, modifier: Modifier = Modifier, size: Dp = 56.dp, selected: Boolean = false,
    isPortrait: Boolean = false, onClick: (() -> Unit)? = null, label: String? = null) {
    Box(modifier.size(if(onClick!=null)maxOf(48.dp,size) else size)
        .then(if(onClick!=null)Modifier.clickable(role=Role.Button,onClick=onClick).semantics { this.selected=selected } else Modifier),contentAlignment=Alignment.Center) {
        Asset(if(isPortrait)"portrait.jpg" else personAsset(index),Modifier.size(size).clip(CircleShape)
            .border(if(selected)2.dp else 1.dp,if(selected)Pink else Muted.copy(alpha=.65f),CircleShape),
            if(onClick==null)null else label ?: if(isPortrait)"Jasmine" else PeopleNames[index%8])
    }
}

val PeopleNames = listOf("Sophie", "Mark", "Emma", "James", "Olivia", "Daniel", "Maya", "Lucas")
val PeopleCounts = listOf(6, 4, 3, 3, 2, 2, 1, 1)

@Composable
fun SelectionMark(selected: Boolean, modifier: Modifier = Modifier, favorite: Boolean = false) {
    Box(modifier.size(27.dp).clip(CircleShape).background(if(selected)Pink else Color.Black.copy(alpha=.18f))
        .border(1.5.dp,if(selected)Pink else Color.White.copy(alpha=.8f),CircleShape),contentAlignment=Alignment.Center) {
        if(selected) AppIcon(if(favorite)Glyph.HEART else Glyph.CHECK,Modifier.size(16.dp),Ink,filled=favorite)
    }
}

@Composable
fun PhotoGrid(state: PreviewState, modifier: Modifier = Modifier, photos: List<Int> = (0..17).toList(),
    selectable: Boolean = false, selections: List<Int> = emptyList(), favorites: Boolean = false,
    dimUnselected: Boolean = false, showPeople: Boolean = false, columns: Int = 3,
    onPhotoClick: (Int) -> Unit = {state.openPhoto(it)}) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val heights=listOf(180,236,136,185,146,186,144,179,212,146,210,178,168,212,146,174,146,212)
    LazyVerticalStaggeredGrid(columns=StaggeredGridCells.Fixed(columns),modifier=modifier,
        horizontalArrangement=Arrangement.spacedBy(6.dp),verticalItemSpacing=6.dp,
        contentPadding=PaddingValues(bottom=8.dp)) {
        itemsIndexed(photos,key={position,index->"$position-$index"}) { position,index ->
            val interactionModifier = if(selectable)Modifier.toggleable(
                value=index in selections,role=Role.Checkbox,onValueChange={onPhotoClick(index)})
                else Modifier.clickable(role=Role.Button){onPhotoClick(index)}
            Box(Modifier.fillMaxWidth().height((heights[position%heights.size] * when(columns){2->1.15f;4->.75f;else->1f}).dp)
                .clip(RoundedCornerShape(9.dp)).then(interactionModifier)
                .semantics { contentDescription = uiContext.getString(R.string.copy_photo_1_s_b27fd7d6, index+1) }) {
                Asset(photoAsset(index),Modifier.fillMaxSize())
                if(dimUnselected && index !in selections) Box(Modifier.fillMaxSize().background(Ink.copy(alpha=.5f)))
                if(selectable || (favorites && index in state.favorites)) SelectionMark(
                    if(selectable)index in selections else index in state.favorites,
                    Modifier.align(Alignment.TopEnd).padding(6.dp),favorite=favorites)
                if(showPeople && position%3==0) Box(Modifier.align(Alignment.BottomEnd).padding(6.dp).size(26.dp)
                    .clip(CircleShape).background(Ink.copy(alpha=.4f)),contentAlignment=Alignment.Center){AppIcon(Glyph.PEOPLE,Modifier.size(19.dp))}
            }
        }
    }
}

@Composable
internal fun AdaptiveChoices(labels: List<String>, modifier: Modifier = Modifier, labelSize: TextUnit = 13.sp,
    minimumItemWidth: Dp = 48.dp, spacing: Dp = 7.dp, item: @Composable (index: Int, modifier: Modifier) -> Unit) {
    val measurer=androidx.compose.ui.text.rememberTextMeasurer()
    val density=androidx.compose.ui.platform.LocalDensity.current
    val wordWidth=labels.flatMap { it.split(Regex("\\s+")) }.maxOfOrNull {
        measurer.measure(it,style=TextStyle(fontSize=labelSize,fontWeight=FontWeight.Medium),softWrap=false).size.width
    } ?: 0
    val minimum=maxOf(minimumItemWidth,with(density) { wordWidth.toDp() }+16.dp)
    BoxWithConstraints(modifier.fillMaxWidth()) {
        val fitting=((maxWidth+spacing)/(minimum+spacing)).toInt().coerceIn(1,labels.size.coerceAtLeast(1))
        val columns=if(labels.size==4 && fitting==3)2 else fitting
        Column(verticalArrangement=Arrangement.spacedBy(spacing)) {
            labels.indices.toList().chunked(columns).forEach { row ->
                Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(spacing)) {
                    row.forEach { index -> item(index,Modifier.weight(1f)) }
                    repeat(columns-row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }
    }
}

@Composable
fun Segments(items: List<String>, selected: String, modifier: Modifier = Modifier, onSelect: (String) -> Unit) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val labels=items.map { choiceLabel(uiContext,it) }
    AdaptiveChoices(labels,modifier) { index,cell ->
        val item=items[index]
        val label=labels[index]
            Box(cell.heightIn(min=48.dp).clip(CircleShape).background(if(selected==item)Pink else Panel)
                .clickable(role=Role.Tab){onSelect(item)}.semantics { contentDescription=label;this.selected = selected == item }.padding(horizontal=8.dp,vertical=10.dp),contentAlignment=Alignment.Center) {
                Text(label,color=if(selected==item)Ink else Color.White,fontSize=13.sp,textAlign=TextAlign.Center,fontWeight=if(selected==item)FontWeight.Medium else FontWeight.Normal,modifier=Modifier.clearAndSetSemantics { })
            }
    }
}

@Composable
fun SearchInput(value: String, placeholder: String, modifier: Modifier = Modifier,
    onValue: (String) -> Unit, onFilter: (() -> Unit)? = null) {
    Row(modifier.fillMaxWidth().heightIn(min=49.dp).clip(RoundedCornerShape(14.dp)).background(Panel)
        .padding(horizontal=12.dp),verticalAlignment=Alignment.CenterVertically) {
        AppIcon(Glyph.SEARCH,Modifier.size(21.dp),Muted);Spacer(Modifier.width(9.dp))
        BasicTextField(value=value,onValueChange=onValue,textStyle=TextStyle(color=Color.White,fontSize=14.sp),
            cursorBrush=SolidColor(Pink),singleLine=true,modifier=Modifier.weight(1f).semantics { contentDescription=placeholder },
            decorationBox={inner->if(value.isEmpty())Text(placeholder,color=Muted,fontSize=14.sp);inner()})
        if(value.isNotEmpty())IconAction(Glyph.CLOSE,stringResource(R.string.clear_search),color=Muted,onClick={onValue("")})
        else if(onFilter!=null)IconAction(Glyph.FILTER,stringResource(R.string.filters),onClick=onFilter)
    }
}

@Composable
fun SettingRow(title: String, subtitle: String? = null, icon: Glyph? = null, trailing: String? = null,
    accent: Color = Color.White, chevron: Boolean = true, modifier: Modifier = Modifier,
    onClick: () -> Unit) {
    val stacked=androidx.compose.ui.platform.LocalDensity.current.fontScale>1.25f
    Row(modifier.fillMaxWidth().heightIn(min=if(subtitle==null)55.dp else 66.dp).clip(RoundedCornerShape(13.dp))
        .background(Panel).clickable(role=Role.Button,onClick=onClick)
        .semantics { contentDescription=listOfNotNull(title,subtitle,trailing).joinToString(", ") }.padding(horizontal=15.dp,vertical=11.dp),
        verticalAlignment=Alignment.CenterVertically) {
        if(icon!=null){AppIcon(icon,Modifier.size(24.dp),accent);Spacer(Modifier.width(16.dp))}
        Column(Modifier.weight(1f).clearAndSetSemantics { }) {
            Text(title,color=accent,fontSize=14.sp,fontWeight=FontWeight.Medium)
            if(subtitle!=null)Text(subtitle,color=Muted,fontSize=12.sp,modifier=Modifier.padding(top=3.dp))
            if(stacked && trailing!=null)Text(trailing,color=Muted,fontSize=12.sp,modifier=Modifier.padding(top=4.dp))
        }
        if(!stacked && trailing!=null)Text(trailing,color=Muted,fontSize=12.sp,textAlign=TextAlign.End,modifier=Modifier.weight(.6f).padding(start=8.dp).clearAndSetSemantics { })
        if(chevron)AppIcon(Glyph.BACK,Modifier.padding(start=6.dp).size(16.dp).graphicsLayer { rotationZ=180f },Muted)
    }
}

@Composable
fun BottomBar(state: PreviewState, active: Int, modifier: Modifier = Modifier, profile: Boolean = false) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    Row(modifier.fillMaxWidth().height(63.dp).clip(RoundedCornerShape(24.dp)).background(Ink.copy(alpha=.96f))
        .border(1.dp,Hairline.copy(alpha=.4f),RoundedCornerShape(24.dp)),
        horizontalArrangement=Arrangement.SpaceEvenly,verticalAlignment=Alignment.CenterVertically) {
        val links=if(profile)listOf(Glyph.HOME to 10,Glyph.SEARCH to 15,Glyph.HEART to 14,Glyph.PERSON to 37)
            else listOf(Glyph.HOME to 10,Glyph.PEOPLE to 11,Glyph.PHOTO to 13,Glyph.HEART to 14,Glyph.PERSON to 37)
        links.forEach{(icon,id)->
            Box(Modifier.weight(1f).height(54.dp).clickable(role=Role.Tab){state.navigate(id)}.semantics {
                contentDescription=when(id){10->uiContext.getString(R.string.copy_home_52f50eae);11->uiContext.getString(R.string.copy_new_matches_a3489490);13->uiContext.getString(R.string.copy_photos_cde554d0);14->uiContext.getString(R.string.copy_favorites_7c2c53ba);15->uiContext.getString(R.string.copy_search_c646a2c9);else->uiContext.getString(R.string.copy_profile_cd17328e)}
                selected=id==active
            },contentAlignment=Alignment.Center) {
                if(id==active)Canvas(Modifier.size(54.dp)){drawCircle(Brush.radialGradient(listOf(Pink.copy(alpha=.22f),Color.Transparent)),radius=size.width/2)}
                AppIcon(icon,Modifier.size(25.dp),if(id==active)Pink else Color.White,filled=id==active && icon in listOf(Glyph.HOME,Glyph.HEART))
            }
        }
    }
}

@Composable
fun Glow(modifier: Modifier = Modifier, strong: Boolean = false) {
    Canvas(modifier.fillMaxSize()) {
        drawRect(Ink)
        val a=if(strong).30f else.12f
        drawCircle(Brush.radialGradient(listOf(Pink.copy(alpha=a),Color.Transparent),center=Offset(size.width*.03f,size.height*.32f),radius=size.width*.65f),radius=size.width*.65f,center=Offset(size.width*.03f,size.height*.32f))
        drawCircle(Brush.radialGradient(listOf(Color(0xFFB96B65).copy(alpha=a),Color.Transparent),center=Offset(size.width*.9f,size.height*.72f),radius=size.width*.4f),radius=size.width*.4f,center=Offset(size.width*.9f,size.height*.72f))
    }
}

@Composable
fun GlowSymbol(glyph: Glyph, modifier: Modifier = Modifier, ring: Boolean = true, dotted: Boolean = false) {
    Box(modifier.size(160.dp),contentAlignment=Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val c=center;val r=size.minDimension*.30f
            drawCircle(Brush.radialGradient(listOf(Pink.copy(alpha=.34f),Pink.copy(alpha=.12f),Color.Transparent)),radius=size.minDimension*.50f)
            if(ring){drawCircle(Pink.copy(alpha=.14f),r+4.dp.toPx(),style=Stroke(12.dp.toPx()));drawCircle(Pink,r,style=Stroke(3.3.dp.toPx()))}
            if(dotted)for(i in 0..27){val a=i*2*PI/28;val rr=size.minDimension*.43f;drawCircle(Pink.copy(alpha=.7f),if(i%3==0)2.4.dp.toPx() else 1.5.dp.toPx(),Offset(c.x+cos(a).toFloat()*rr,c.y+sin(a).toFloat()*rr))}
        }
        AppIcon(glyph,Modifier.size(if(glyph==Glyph.CHECK)64.dp else 56.dp),Pink,filled=glyph==Glyph.HEART)
    }
}

@Composable
fun PinkToggle(checked: Boolean, label: String, interactive: Boolean = true, onToggle: () -> Unit) {
    val thumbOffset by animateDpAsState(if(checked)21.dp else 0.dp,
        animationSpec=tween(if(android.animation.ValueAnimator.areAnimatorsEnabled())120 else 0),label="Switch state")
    Box(Modifier.width(52.dp).height(48.dp)
        .then(if(interactive)Modifier.toggleable(value=checked,role=Role.Switch,onValueChange={onToggle()}).semantics { contentDescription=label }
            else Modifier.clearAndSetSemantics { }),contentAlignment=Alignment.Center) {
        Box(Modifier.width(52.dp).height(31.dp).clip(CircleShape).background(if(checked)Pink else Color(0xFF3B3B40))) {
            Box(Modifier.padding(4.dp).offset(x=thumbOffset).size(23.dp).align(Alignment.CenterStart)
                .clip(CircleShape).background(if(checked)Color.White else Muted))
        }
    }
}

@Composable
fun ToggleRow(state: PreviewState, title: String, subtitle: String? = null, icon: Glyph) {
    val uiContext = androidx.compose.ui.platform.LocalContext.current
    val displayTitle=choiceLabel(uiContext,title)
    Row(Modifier.fillMaxWidth().heightIn(min=73.dp).toggleable(state.toggles[title]==true,role=Role.Switch,onValueChange={state.toggle(title)})
        .semantics { contentDescription=listOfNotNull(displayTitle,subtitle).joinToString(", ") }
        .padding(horizontal=15.dp,vertical=10.dp),verticalAlignment=Alignment.CenterVertically) {
        AppIcon(icon,Modifier.size(26.dp));Spacer(Modifier.width(17.dp))
        Column(Modifier.weight(1f).clearAndSetSemantics { }) {
            Text(displayTitle,color=Color.White,fontSize=14.sp)
            if(subtitle!=null)Text(subtitle,color=Muted,fontSize=12.sp,modifier=Modifier.padding(top=4.dp))
        }
        PinkToggle(state.toggles[title]==true,displayTitle,interactive=false){state.toggle(title)}
    }
}

@Composable
fun DividerLine(modifier: Modifier = Modifier) { Box(modifier.fillMaxWidth().height(1.dp).background(Hairline.copy(alpha=.45f))) }

/** Display labels for stable selection/preference keys; never apply to user or provider text. */
internal fun choiceLabel(context: android.content.Context, key: String): String = when(key) {
    "All Photos" -> context.getString(R.string.copy_all_photos_343464c9)
    "Selected Albums" -> context.getString(R.string.copy_selected_albums_17cc5138)
    "Limited Access" -> context.getString(R.string.copy_limited_access_f122f20d)
    "All" -> context.getString(R.string.copy_all_75afe364)
    "People" -> context.getString(R.string.copy_people_8390060e)
    "Places" -> context.getString(R.string.copy_places_a808d03d)
    "Videos" -> context.getString(R.string.copy_videos_63609fed)
    "Dates" -> context.getString(R.string.copy_dates_6ccb18be)
    "Favorites" -> context.getString(R.string.copy_favorites_7c2c53ba)
    "Photos" -> context.getString(R.string.copy_photos_cde554d0)
    "Live Photos" -> context.getString(R.string.copy_live_photos_f34b9b98)
    "Matches" -> context.getString(R.string.copy_matches_a7d4102e)
    "Shares" -> context.getString(R.string.copy_shares_da0ba431)
    "Mentions" -> context.getString(R.string.copy_mentions_43e4fe52)
    "System" -> context.getString(R.string.copy_system_8f3184bc)
    "Any date" -> context.getString(R.string.copy_any_date_77399ff3)
    "Any location" -> context.getString(R.string.copy_any_location_12402400)
    "Last 30 days" -> context.getString(R.string.copy_last_30_days_d0778b33)
    "Anyone" -> context.getString(R.string.copy_anyone_6202c187)
    "Matched people only" -> context.getString(R.string.copy_matched_people_only_18da4a7c)
    "Allowed people only" -> context.getString(R.string.copy_allowed_people_only_8a09f220)
    "Approved recipients" -> context.getString(R.string.copy_approved_recipients_a3d21a9a)
    "Allow others to save" -> context.getString(R.string.copy_allow_others_to_save_b85a095b)
    "Show location info" -> context.getString(R.string.copy_show_location_info_4e6e2781)
    "Show in suggestions" -> context.getString(R.string.copy_show_in_suggestions_7b1dc7e6)
    "Analytics" -> context.getString(R.string.copy_analytics_bcade02b)
    "New Matches" -> context.getString(R.string.copy_new_matches_2c63d230)
    "Messages" -> context.getString(R.string.copy_messages_f8611fd5)
    "Tips & Features" -> context.getString(R.string.copy_tips_features_1748bcf0)
    "Reminders" -> context.getString(R.string.copy_reminders_4841b654)
    "Marketing" -> context.getString(R.string.copy_marketing_54cb9b0f)
    "Two-Factor Authentication" -> context.getString(R.string.copy_two_factor_authentication_1a856a41)
    "Contributed" -> context.getString(R.string.copy_contributed_7ee59a7a)
    "Received" -> context.getString(R.string.copy_received_5cf817d2)
    "To review" -> context.getString(R.string.copy_to_review_efec5b50)
    "This isn’t me" -> context.getString(R.string.copy_this_isn_t_me_fadfca58)
    "Wrong person" -> context.getString(R.string.copy_wrong_person_781d726f)
    "Other" -> context.getString(R.string.copy_other_6e38ff95)
    "This isn't me" -> context.getString(R.string.copy_this_isn_t_me_05a96606)
    "Not in this photo" -> context.getString(R.string.copy_not_in_this_photo_ecdf616f)
    "Other issue" -> context.getString(R.string.copy_other_issue_8e041f9e)
    "Allowed" -> context.getString(R.string.copy_allowed_586f52e3)
    "Blocked" -> context.getString(R.string.copy_blocked_e378ac53)
    "From This Device" -> context.getString(R.string.copy_from_this_device_7e2db4db)
    "From Albums" -> context.getString(R.string.copy_from_albums_04f444df)
    "From Files" -> context.getString(R.string.copy_from_files_f5e9d896)
    "Take a Photo" -> context.getString(R.string.copy_take_a_photo_31010195)
    "Getting Started" -> context.getString(R.string.copy_getting_started_d7ac78be)
    "Your Photos" -> context.getString(R.string.copy_your_photos_337df2cf)
    "Privacy & Safety" -> context.getString(R.string.copy_privacy_safety_475ecedd)
    "Account & Settings" -> context.getString(R.string.copy_account_settings_eb2f3ea7)
    "Troubleshooting" -> context.getString(R.string.copy_troubleshooting_eacc4991)
    "Contact Support" -> context.getString(R.string.copy_contact_support_abccb14c)
    "Email" -> context.getString(R.string.copy_email_43352167)
    "Phone" -> context.getString(R.string.copy_phone_4930944f)
    else -> key
}
