package com.lovelies.frontend.preview

import androidx.compose.ui.res.stringResource

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay

@Composable
fun OnboardingScreen(state: PreviewState) {
    when (state.route) {
        1 -> Splash(state)
        2 -> Introduction(state)
        3 -> SignIn(state)
        4 -> PhotoPermissionPreview(state)
        5 -> AccessOptions(state)
        6 -> FaceEnrollment(state)
        7 -> FaceRetry(state)
        8 -> Processing(state)
        9 -> SetupComplete(state)
    }
}

@Composable
private fun Splash(state: PreviewState) {
    Box(Modifier.fillMaxSize()) {
        Asset("splash.jpg", Modifier.fillMaxSize())
        Column(Modifier.fillMaxWidth().align(Alignment.Center).padding(bottom = 15.dp),
            horizontalAlignment = Alignment.CenterHorizontally) {
            Asset("wordmark.png", Modifier.fillMaxWidth(.83f).height(150.dp), "Lovelies", ContentScale.Fit)
            Text(stringResource(R.string.copy_photos_bring_people_closer_63eca6c3), color = Color(0xFFECD4DE), fontSize = 13.sp,
                letterSpacing = 4.sp, lineHeight = 23.sp, textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 8.dp))
        }
        Box(Modifier.align(Alignment.BottomCenter).padding(bottom = 70.dp).size(82.dp)
            .clip(CircleShape).background(Pink).clickable(role = Role.Button) { state.navigate(2) }
            .semantics { contentDescription = "Get started" }, contentAlignment = Alignment.Center) {
            AppIcon(Glyph.ARROW, Modifier.size(37.dp), Ink)
        }
    }
}

@Composable
private fun Introduction(state: PreviewState) {
    Column(Modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 10.dp),
        horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.fillMaxWidth().weight(1.1f), contentAlignment = Alignment.Center) {
            SourceHero("intro-collage.png",.961f,220f/167f)
        }
        Text(stringResource(R.string.copy_your_photos_find_their_people_3168ba56), color = Color.White, fontSize = 23.sp,
            lineHeight = 30.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 12.dp, bottom = 25.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            IntroFeature(Glyph.FACE, "We match\nyour photos", Modifier.weight(1f))
            IntroFeature(Glyph.PEOPLE, "To the\nright people", Modifier.weight(1f))
            IntroFeature(Glyph.SHARE, "You choose\nwhat to share", Modifier.weight(1f))
        }
        Spacer(Modifier.height(25.dp))
        PinkButton(stringResource(R.string.copy_get_started_bd2cb051)) { state.navigate(3) }
        Row(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            repeat(3) { index -> Box(Modifier.size(7.dp).clip(CircleShape).background(if(index == 0) Color.White else Hairline)) }
        }
    }
}

@Composable
private fun IntroFeature(icon: Glyph, title: String, modifier: Modifier = Modifier) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(64.dp).clip(CircleShape).background(Pink.copy(alpha = .08f))
            .border(1.5.dp, Pink, CircleShape), contentAlignment = Alignment.Center) {
            AppIcon(icon, Modifier.size(36.dp))
        }
        Text(title, color = Color.White, fontSize = 13.sp, lineHeight = 17.sp,
            textAlign = TextAlign.Center, modifier = Modifier.padding(top = 9.dp))
    }
}

@Composable
private fun SignIn(state: PreviewState) {
    Box(Modifier.fillMaxSize()) {
        Glow(strong = true)
        Column(Modifier.fillMaxSize().padding(horizontal = 22.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Spacer(Modifier.weight(.7f))
            Asset("wordmark.png", Modifier.fillMaxWidth(.76f).height(138.dp), "Lovelies", ContentScale.Fit)
            Text(stringResource(R.string.copy_welcome_ca4f9dcf), color = Color.White, fontSize = 27.sp, modifier = Modifier.padding(top = 14.dp))
            BodyText(stringResource(R.string.copy_same_photos_more_people_in_them_dee1a826), Modifier.padding(top = 8.dp, bottom = 25.dp), size = 17)
            OutlineButton(stringResource(R.string.copy_continue_with_apple_01ca4c21), icon = Glyph.APPLE, light = true) {
                state.toast("Preview sign-in: no account is created"); state.navigate(4)
            }
            Spacer(Modifier.height(12.dp))
            OutlineButton(stringResource(R.string.copy_continue_with_google_ccc5b0ed), icon = Glyph.GOOGLE) {
                state.toast("Preview sign-in: no account is created"); state.navigate(4)
            }
            Spacer(Modifier.height(12.dp))
            PinkButton(stringResource(R.string.copy_create_account_eff4fd86)) { state.navigate(4) }
            Text(stringResource(R.string.copy_sign_in_f8492cc1), color = SoftPink, fontSize = 14.sp,
                modifier = Modifier.padding(top = 22.dp).sizeIn(minWidth=48.dp,minHeight=48.dp).clickable(role = Role.Button) { state.navigate(4) })
            Spacer(Modifier.weight(.8f))
        }
    }
}

@Composable
private fun PhotoPermissionPreview(state: PreviewState) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Box(Modifier.fillMaxSize().clearAndSetSemantics { }) {
            PhotoGrid(state, Modifier.fillMaxSize().padding(6.dp), onPhotoClick = {})
        }
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = .48f)))
        Column(Modifier.fillMaxWidth(.81f).clip(RoundedCornerShape(23.dp)).background(Color(0xFFECE9EB))
            .padding(17.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Asset("photo-heart.png", Modifier.size(68.dp), scale = ContentScale.Fit)
            Text(stringResource(R.string.copy_lovelies_would_like_to_access_your__f64e9035), color = Ink, fontSize = 17.sp,
                lineHeight = 22.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 6.dp))
            Text(stringResource(R.string.copy_we_ll_match_your_photos_to_people_u_30220d04), color = Ink,
                fontSize = 13.sp, lineHeight = 18.sp, textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 9.dp, bottom = 16.dp))
            PinkButton(stringResource(R.string.copy_allow_full_access_ff2815e6)) { state.setAccess("All Photos"); state.navigate(5) }
            Box(Modifier.padding(top = 10.dp).fillMaxWidth().heightIn(min=48.dp).clip(CircleShape)
                .background(Color(0xFFF6CDD9)).clickable(role = Role.Button) { state.setAccess("Limited Access"); state.navigate(5) },
                contentAlignment = Alignment.Center) { Text(stringResource(R.string.copy_allow_limited_access_78262ff4), color = Ink, fontSize = 14.sp) }
            Text(stringResource(R.string.copy_not_now_b1e5359f), color = Ink, fontSize = 13.sp,
                modifier = Modifier.heightIn(min=48.dp).clickable(role = Role.Button) { state.navigate(6) }.padding(vertical=15.dp))
        }
    }
}

@Composable
private fun AccessOptions(state: PreviewState) {
    Column(Modifier.fillMaxSize().padding(horizontal = 21.dp)) {
        ScreenHeader("", onBack = state::back)
        Spacer(Modifier.weight(.4f))
        Text(stringResource(R.string.copy_choose_photo_access_5e644cf7), color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.align(Alignment.CenterHorizontally).padding(bottom = 25.dp))
        AccessOption(state, "All Photos", "Get the best matches\nacross your entire library", Glyph.PHOTO)
        Spacer(Modifier.height(12.dp))
        AccessOption(state, "Selected Albums", "Choose specific albums", Glyph.ALBUM)
        Spacer(Modifier.height(12.dp))
        AccessOption(state, "Limited Access", "Start with a few photos\n(you can change this anytime)", Glyph.LOCK)
        Spacer(Modifier.height(23.dp))
        PinkButton(stringResource(R.string.copy_continue_2e026239)) { state.navigate(6) }
        Spacer(Modifier.weight(.5f))
    }
}

@Composable
private fun AccessOption(state: PreviewState, title: String, text: String, icon: Glyph) {
    val selected = state.photoAccess == title
    Row(Modifier.fillMaxWidth().heightIn(min=111.dp).clip(RoundedCornerShape(21.dp)).background(Panel)
        .border(if(selected)1.6.dp else 1.dp, if(selected)Pink else Hairline, RoundedCornerShape(21.dp))
        .selectable(selected=selected,role = Role.RadioButton,onClick={ state.setAccess(title) }).padding(17.dp), verticalAlignment = Alignment.CenterVertically) {
        SelectionMark(selected);Spacer(Modifier.width(16.dp))
        AppIcon(icon, Modifier.size(29.dp));Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(title, color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.Medium)
            Text(text, color = Muted, fontSize = 13.sp, lineHeight = 18.sp, modifier = Modifier.padding(top = 5.dp))
        }
    }
}

@Composable
private fun FaceEnrollment(state: PreviewState) {
    Column(Modifier.fillMaxSize().padding(horizontal = 9.dp, vertical = 9.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Asset("portrait.jpg", Modifier.fillMaxWidth().weight(1f).clip(RoundedCornerShape(22.dp)), "Preview face portrait")
        Box(Modifier.padding(top = 17.dp).size(65.dp).clip(CircleShape).border(3.dp, Color.White, CircleShape)
            .clickable(role = Role.Button) {
                state.selfieCount += 1
                if(state.selfieCount >= 3) { state.selfieCount = 0; state.navigate(8) }
                else state.toast("Selfie ${state.selfieCount} of 3 captured in this preview")
            }.semantics { contentDescription = "Capture simulated selfie ${state.selfieCount + 1} of 3" }, contentAlignment = Alignment.Center) {
            Box(Modifier.size(54.dp).clip(CircleShape).background(Color.White))
        }
        BodyText(stringResource(R.string.copy_position_your_face_in_the_frame_d8080d72), Modifier.padding(top = 14.dp, bottom = 14.dp), size = 14)
    }
}

@Composable
private fun FaceRetry(state: PreviewState) {
    Column(Modifier.fillMaxSize().padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        IconAction(Glyph.CLOSE, "Cancel face capture", Modifier.align(Alignment.Start), onClick = { state.navigate(5) })
        Asset("retry-portrait.jpg", Modifier.fillMaxWidth(.89f).weight(1f).clip(RoundedCornerShape(25.dp)), "Face quality preview")
        Box(Modifier.offset(y = (-13).dp).size(56.dp).clip(CircleShape).background(Ink).border(2.dp, Pink, CircleShape), contentAlignment = Alignment.Center) {
            Text(stringResource(R.string.copy__0ab8318a), color = Pink, fontSize = 36.sp, fontWeight = FontWeight.Medium)
        }
        Text(stringResource(R.string.copy_let_s_try_that_again_9eae938d), color = Color.White, fontSize = 22.sp, modifier = Modifier.padding(top = 3.dp))
        BodyText(stringResource(R.string.copy_make_sure_your_face_is_well_lit_in__e565e107), Modifier.padding(top = 10.dp, bottom = 19.dp))
        PinkButton(stringResource(R.string.copy_retake_16457335)) { state.navigate(6) }
        Spacer(Modifier.height(11.dp))
        OutlineButton(stringResource(R.string.copy_use_this_anyway_986e85ae)) { state.navigate(8) }
    }
}

@Composable
private fun Processing(state: PreviewState) {
    LaunchedEffect(Unit) { if(!state.reviewMode) { delay(3500); if(state.route == 8)state.navigate(9) } }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            SourceHero("processing-hero.png",.675f,154f/163f)
            Text(stringResource(R.string.copy_finding_your_photos_9e4eb363), color = Color.White, fontSize = 22.sp, modifier = Modifier.padding(top = 24.dp))
            BodyText(stringResource(R.string.copy_this_won_t_take_long_ef97ed1c), Modifier.padding(top = 12.dp))
            if(state.reviewMode) {
                BodyText(stringResource(R.string.a11y_preview_paused),Modifier.padding(top=18.dp).semantics { liveRegion=LiveRegionMode.Polite },size=12)
                PinkButton(stringResource(R.string.a11y_continue_preview),Modifier.padding(top=16.dp)) { state.navigate(9) }
            }
        }
    }
}

@Composable
private fun SetupComplete(state: PreviewState) {
    Box(Modifier.fillMaxSize()) {
        Glow()
        Column(Modifier.fillMaxSize().padding(22.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Spacer(Modifier.weight(.65f))
            SourceHero("setup-hero.png",.733f,173f/173f)
            Spacer(Modifier.height(31.dp))
            Text(stringResource(R.string.copy_you_re_all_set_058a8130), color = Color.White, fontSize = 25.sp)
            BodyText(stringResource(R.string.copy_we_ve_matched_your_photos_to_the_pe_604c75ed), Modifier.padding(top = 11.dp))
            Spacer(Modifier.weight(.5f))
            PinkButton(stringResource(R.string.copy_let_s_go_0f0afeff)) { state.navigate(10) }
            Spacer(Modifier.height(25.dp))
        }
    }
}
