package com.lovelies.frontend.preview

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp

/** A direct screen intent has no navigation history; keep its exit deterministic. */
internal fun fallbackBackRoute(route: Int): Int? = when(route) {
    1,10 -> null
    in 2..9 -> route-1
    11,12,13,14,15,17,18,19,37,47,48 -> 10
    16 -> 15
    20 -> 19
    21 -> 20
    22,23 -> route-1
    24 -> 19
    25 -> 11
    26 -> 25
    27 -> 26
    28 -> 27
    29 -> 26
    30 -> 29
    31 -> 29
    32,33 -> 31
    34 -> 33
    35 -> 37
    36 -> 27
    in 38..46 -> 37
    else -> null
}

internal fun referenceNeedsExit(route: Int) = route in setOf(2,3,4,6,8,9,13,15,17,18,24,25,34,47,48)

/** Keep nested grids finite while providing an outer escape from short/enlarged layouts. */
@Composable
internal fun AdaptiveRouteHost(routeKey: String, reduceMotion: Boolean, referenceRoute: Int?=null, content: @Composable () -> Unit) {
    val fontScale=LocalDensity.current.fontScale
    val scroll=remember(routeKey) { ScrollState(0) }
    val opacity=remember { Animatable(1f) }
    LaunchedEffect(routeKey,reduceMotion) {
        opacity.snapTo(if(reduceMotion)1f else .88f)
        if(!reduceMotion)opacity.animateTo(1f,tween(140))
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val enlarged=fontScale>1.25f || maxHeight<600.dp
        val minimumHeight=maxOf(640.dp,minOf(maxWidth,720.dp)*1.4f)*fontScale.coerceAtLeast(1f)
        val pageHeight=when {
            referenceRoute==1 -> maxHeight
            maxHeight<600.dp && (referenceRoute==3 || referenceRoute==4) -> maxOf(maxHeight,640.dp*fontScale.coerceAtLeast(1f))
            enlarged -> maxOf(maxHeight,minimumHeight)
            else -> maxHeight
        }
        Box(Modifier.fillMaxSize().verticalScroll(scroll,enabled=enlarged)) {
            Box(Modifier.align(Alignment.TopCenter).widthIn(max=720.dp).fillMaxWidth().height(pageHeight)
                .graphicsLayer { alpha=opacity.value }) { content() }
        }
    }
}
