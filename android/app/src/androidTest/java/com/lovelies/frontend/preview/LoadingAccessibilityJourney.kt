package com.lovelies.frontend.preview

import android.app.Activity
import android.app.Instrumentation
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat
import java.util.Locale

/**
 * Offline UI probe of the production spinner, not a camera/upload/provider journey.
 * Requires an owned disposable runtime: the synthetic debug Activity constructs its
 * usual PreviewState/LiveController. Only its composition changes locale; no global
 * locale setting is written. Node values do not establish spoken TalkBack use.
 */
class LoadingAccessibilityJourney : Instrumentation() {
    private var arguments=Bundle()
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments);this.arguments=arguments ?: Bundle();start() }

    private data class LocalizedContext(val configuration: Configuration,val context: Context)
    private data class Indicator(val label: String,val state: String?,val indeterminate: Boolean,val bounds: List<Int>)

    private fun localized(activity: Activity,language: String): LocalizedContext {
        val configuration=Configuration(activity.resources.configuration).apply { setLocale(Locale.forLanguageTag(language)) }
        return LocalizedContext(configuration,activity.createConfigurationContext(configuration))
    }

    private fun indicators(): List<Indicator> {
        val root=uiAutomation.rootInActiveWindow ?: return emptyList()
        val result=mutableListOf<Indicator>()
        fun inspect(node: AccessibilityNodeInfo) {
            if(node.className?.toString()=="android.widget.ProgressBar" && node.isVisibleToUser) {
                val bounds=Rect();node.getBoundsInScreen(bounds)
                result.add(Indicator(node.contentDescription?.toString().orEmpty(),
                    AccessibilityNodeInfoCompat.wrap(node).stateDescription?.toString(),
                    node.rangeInfo==null,listOf(bounds.left,bounds.top,bounds.right,bounds.bottom)))
            }
            for(index in 0 until node.childCount)node.getChild(index)?.let { child ->
                try { inspect(child) } finally { child.recycle() }
            }
        }
        try {
            if(root.packageName?.toString()!=targetContext.packageName)return emptyList()
            inspect(root)
        } finally { root.recycle() }
        return result
    }

    override fun onStart() {
        var activity: MainActivity?=null
        var failure: String?=null
        val steps=mutableListOf<Map<String,Any?>>()
        val labels=listOf("Lovelies default loading fixture","Lovelies compact loading fixture")
        try {
            check(arguments.getString("owned_disposable_runtime")=="true") { "Explicit owned_disposable_runtime=true is required" }
            check(BuildConfig.DEBUG && BuildConfig.REFERENCE_SCREENS) { "The offline probe requires the debug reference host" }
            val owned=startActivitySync(Intent(targetContext,MainActivity::class.java)
                .putExtra("review",true).putExtra("screen",1).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
            activity=owned
            val english=localized(owned,"en")
            val kinyarwanda=localized(owned,"rw")
            val englishLoading=english.context.getString(R.string.a11y_loading)
            val kinyarwandaLoading=kinyarwanda.context.getString(R.string.a11y_loading)
            check(englishLoading.isNotBlank() && kinyarwandaLoading.isNotBlank() && englishLoading!=kinyarwandaLoading) {
                "Both distinct app loading translations must be present"
            }
            val locale=mutableStateOf(english)
            runOnMainSync {
                owned.setContent {
                    val current=locale.value
                    CompositionLocalProvider(LocalContext provides current.context,LocalConfiguration provides current.configuration) {
                        Column(Modifier.fillMaxSize().padding(24.dp)) {
                            LiveLoadingIndicator(Modifier.semantics { contentDescription=labels[0] })
                            Spacer(Modifier.height(24.dp))
                            LiveLoadingIndicator(Modifier.size(28.dp).semantics { contentDescription=labels[1] })
                        }
                    }
                }
            }
            var initialBounds: Map<String,List<Int>>?=null
            for((language,current) in listOf("en" to english,"rw" to kinyarwanda,"en" to english)) {
                runOnMainSync { locale.value=current }
                val expected=current.context.getString(R.string.a11y_loading)
                val deadline=SystemClock.uptimeMillis()+15000L
                var observed: List<Indicator>
                do {
                    waitForIdleSync()
                    observed=indicators()
                    if(observed.size==2 && observed.map { it.label }.toSet()==labels.toSet() && observed.all { it.state==expected })break
                    SystemClock.sleep(100L)
                } while(SystemClock.uptimeMillis()<deadline)
                check(observed.size==2 && observed.map { it.label }.toSet()==labels.toSet()) { "Missing or changed contextual progress labels in $language" }
                check(observed.all { it.state==expected }) { "The progress state did not follow the $language configuration" }
                // The Compose accessibility delegate omits a numeric RangeInfo for
                // its indeterminate ProgressBarRangeInfo; no synthetic percentage.
                check(observed.all { it.indeterminate }) { "Indeterminate progress acquired a numeric range" }
                check(observed.all { it.bounds[2]>it.bounds[0] && it.bounds[3]>it.bounds[1] }) { "Progress bounds are empty" }
                val bounds=observed.associate { it.label to it.bounds }
                if(initialBounds==null)initialBounds=bounds else check(bounds==initialBounds) { "The locale transition changed indicator layout" }
                steps.add(mapOf("language" to language,"expected_state" to expected,"status" to "passed",
                    "indicators" to observed.map { mapOf("context_label" to it.label,"state_description" to it.state,
                        "class" to "android.widget.ProgressBar","indeterminate" to it.indeterminate,"bounds_px" to it.bounds) }))
            }
        } catch(problem: Throwable) {
            failure="${problem.javaClass.simpleName}: ${problem.message}"
        } finally {
            try { activity?.let { owned -> runOnMainSync { owned.finish() };waitForIdleSync() } }
            catch(problem: Throwable) { if(failure==null)failure="Owned Activity cleanup failed: ${problem.javaClass.simpleName}" }
        }
        val report=mapOf("status" to if(failure==null)"passed" else "failed","api" to Build.VERSION.SDK_INT,
            "owned_disposable_runtime_acknowledged" to (arguments.getString("owned_disposable_runtime")=="true"),
            "runtime_scope" to "synthetic debug Activity in an owned disposable runtime",
            "locale_transition" to "en -> rw -> en","locale_scope" to "owned Compose configuration/context; system locale unchanged",
            "production_component" to "LiveLoadingIndicator","stages" to steps,"failure" to failure,
            "provider_request_sent" to false,"camera_upload_journey_executed" to false,"spoken_screen_reader_verified" to false)
        finish(if(failure==null)Activity.RESULT_OK else Activity.RESULT_CANCELED,Bundle().apply {
            putString("loading_accessibility",NativeProtocol.canonical(report))
            putString("stream","\nLocalized loading accessibility ${report["status"]}: ${steps.size}/3 configuration stages\n")
        })
    }
}
