package com.lovelies.frontend.preview

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.io.File

/** Reference fixtures only. Never signs in, opens a camera, calls a provider, or sends photos. */
class FrontendAccessibilityJourney : Instrumentation() {
    private var arguments=Bundle()
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments);this.arguments=arguments ?: Bundle();start() }
    private fun shell(command: String): String = android.os.ParcelFileDescriptor.AutoCloseInputStream(uiAutomation.executeShellCommand(command)).bufferedReader().use { it.readText().trim() }
    override fun onStart() {
        val output=File(targetContext.getExternalFilesDir(null),"frontend-accessibility/${arguments.getString("variant") ?: "default"}").apply { mkdirs() }
        val scale=arguments.getString("font_scale")?.toFloatOrNull() ?: 0f
        val reports=mutableListOf<Map<String,Any?>>()
        val rotation=arguments.getString("rotation")
        require(rotation==null || rotation in setOf("portrait","landscape"))
        val keyboard=arguments.getString("keyboard")=="true"
        val scanScroll=arguments.getString("scan_scroll")=="true"
        val resolver=targetContext.contentResolver
        val oldAuto=android.provider.Settings.System.getInt(resolver,android.provider.Settings.System.ACCELEROMETER_ROTATION,0)
        val oldUser=android.provider.Settings.System.getInt(resolver,android.provider.Settings.System.USER_ROTATION,0)
        val oldDisplay=(targetContext.getSystemService(android.content.Context.WINDOW_SERVICE) as android.view.WindowManager).defaultDisplay.rotation
        var restored=true
        val first=arguments.getString("first")?.toIntOrNull()?.coerceIn(1,48) ?: 1
        val last=arguments.getString("last")?.toIntOrNull()?.coerceIn(first,48) ?: 48
        val density=targetContext.resources.displayMetrics.density
        try {
            val service=uiAutomation.serviceInfo
            service.flags=service.flags or android.accessibilityservice.AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
            uiAutomation.serviceInfo=service
            if(rotation!=null) { check(uiAutomation.setRotation(if(rotation=="landscape")android.app.UiAutomation.ROTATION_FREEZE_90 else android.app.UiAutomation.ROTATION_FREEZE_0));Thread.sleep(300) }
            for(route in first..last) {
                var activity: Activity?=null
                val failures=mutableListOf<String>()
                val small=mutableListOf<Map<String,Any?>>()
                val partial=mutableListOf<Map<String,Any?>>()
                val unnamed=mutableListOf<Map<String,Any?>>()
                var nodes=emptyList<Map<String,Any?>>()
                var keyboardEvidence: Map<String,Any?>?=null
                var scrollEvidence: Map<String,Any?>?=null
                var backEvidence: Map<String,Any?>?=null
                try {
                    activity=startActivitySync(Intent(targetContext,MainActivity::class.java).putExtra("review",true)
                        .putExtra("screen",route).putExtra("reviewFontScale",scale).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    waitForIdleSync();Thread.sleep(220);waitForIdleSync()
                    val root=uiAutomation.rootInActiveWindow ?: error("No accessibility window")
                    val window=Rect();root.getBoundsInScreen(window)
                    val seen=mutableListOf<Map<String,Any?>>()
                    fun inspect(node: AccessibilityNodeInfo,scrollAncestors: List<Rect> = emptyList()): String {
                        val bounds=Rect();node.getBoundsInScreen(bounds)
                        val ancestorEdges=if(node.isScrollable)scrollAncestors+Rect(bounds) else scrollAncestors
                        val descendants=mutableListOf<String>()
                        for(i in 0 until node.childCount)node.getChild(i)?.let { child -> descendants.add(inspect(child,ancestorEdges));child.recycle() }
                        val own=listOfNotNull(node.text?.toString(),node.contentDescription?.toString()).filter { it.isNotBlank() }.distinct().joinToString(" · ")
                        val name=own.ifBlank { descendants.filter { it.isNotBlank() }.distinct().joinToString(" · ") }
                        val item=mapOf("name" to name,"class" to node.className?.toString(),"clickable" to node.isClickable,
                            "visible" to node.isVisibleToUser,"enabled" to node.isEnabled,"selected" to node.isSelected,
                            "checkable" to node.isCheckable,"checked" to node.isChecked,"scrollable" to node.isScrollable,"bounds_px" to listOf(bounds.left,bounds.top,bounds.right,bounds.bottom),
                            "pane" to if(Build.VERSION.SDK_INT>=28)node.paneTitle?.toString() else null)
                        seen.add(item)
                        if(node.isClickable && node.isEnabled && node.isVisibleToUser && !bounds.isEmpty) {
                            if(name.isBlank())unnamed.add(item)
                            val narrow=bounds.width()+1<48*density
                            val short=bounds.height()+1<48*density
                            if(window.contains(bounds) && (narrow || short)) {
                                // Android reports the visible clipped rect. Require a known scroll ancestor edge
                                // along the undersized dimension before treating it as a partial item.
                                val atScrollEdge=scrollAncestors.any { edge ->
                                    narrow && (bounds.left<=edge.left+1 || bounds.right>=edge.right-1) ||
                                        short && (bounds.top<=edge.top+1 || bounds.bottom>=edge.bottom-1)
                                }
                                if(atScrollEdge)partial.add(item+mapOf("reason" to "clipped_at_scroll_ancestor_edge")) else small.add(item)
                            }
                        }
                        return name
                    }
                    inspect(root);root.recycle();nodes=seen
                    if(Build.VERSION.SDK_INT>=28 && seen.none { it["pane"]?.toString()?.startsWith("Screen ${route.toString().padStart(2,'0')}:")==true })failures.add("Missing screen pane title")
                    if(unnamed.isNotEmpty())failures.add("${unnamed.size} unnamed visible actions")
                    if(small.isNotEmpty())failures.add("${small.size} fully visible actions below48dp")
                    val back=fallbackBackRoute(route)
                    if(back!=null && route !in setOf(11,37)) {
                        val exitNames=setOf(targetContext.getString(R.string.back),targetContext.getString(R.string.a11y_close),"Cancel","Cancel face capture","Back to gallery","Go Back")
                        if(seen.none { it["clickable"]==true && it["visible"]==true && exitNames.any { label -> it["name"]?.toString()==label } })failures.add("No visible Back, Close or Cancel exit")
                    }
                    uiAutomation.takeScreenshot()?.let { bitmap ->
                        File(output,"screen-${route.toString().padStart(2,'0')}.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) };bitmap.recycle()
                    }
                    if(scanScroll) {
                        val audit=runReferenceScrollAudit(this,output,route,density)
                        scrollEvidence=audit
                        (audit["failures"] as? List<*>)?.forEach { failures.add("scroll: $it") }
                    }
                    if(keyboard) {
                        fun findEditable(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
                            if(node.isEditable && node.isVisibleToUser)return AccessibilityNodeInfo.obtain(node)
                            for(i in 0 until node.childCount)node.getChild(i)?.let { child ->
                                val found=findEditable(child);child.recycle();if(found!=null)return found
                            };return null
                        }
                        val currentRoot=uiAutomation.rootInActiveWindow ?: error("Missing input window")
                        val field=findEditable(currentRoot);currentRoot.recycle()
                        check(field!=null) { "No visible editable field for keyboard variant" }
                        check(field.performAction(AccessibilityNodeInfo.ACTION_CLICK)) { "Input could not receive focus" }
                        waitForIdleSync();sendStringSync("review");waitForIdleSync();Thread.sleep(220)
                        val fieldBounds=Rect();field.refresh();field.getBoundsInScreen(fieldBounds);field.recycle()
                        val imeBounds=Rect()
                        uiAutomation.windows.firstOrNull { it.type==android.view.accessibility.AccessibilityWindowInfo.TYPE_INPUT_METHOD }?.getBoundsInScreen(imeBounds)
                        keyboardEvidence=mapOf("visible" to !imeBounds.isEmpty,"field_bounds" to listOf(fieldBounds.left,fieldBounds.top,fieldBounds.right,fieldBounds.bottom),
                            "ime_bounds" to listOf(imeBounds.left,imeBounds.top,imeBounds.right,imeBounds.bottom))
                        if(imeBounds.isEmpty)failures.add("Soft keyboard was not observed")
                        else if(Rect.intersects(fieldBounds,imeBounds))failures.add("Focused input is covered by the keyboard")
                        uiAutomation.takeScreenshot()?.let { bitmap ->
                            File(output,"screen-${route.toString().padStart(2,'0')}-keyboard.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) };bitmap.recycle()
                        }
                        if(!imeBounds.isEmpty) { sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);waitForIdleSync();Thread.sleep(180) }
                    }
                    if(back!=null) {
                        val started=android.os.SystemClock.elapsedRealtime()
                        sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);waitForIdleSync();Thread.sleep(180)
                        val expected="Screen ${back.toString().padStart(2,'0')}:"
                        var observed=emptyList<String>()
                        var activePackage: String?=null
                        var reached=false
                        fun panes(node: AccessibilityNodeInfo,result: MutableSet<String>) {
                            if(Build.VERSION.SDK_INT>=28)node.paneTitle?.toString()?.let(result::add)
                            for(i in 0 until node.childCount)node.getChild(i)?.let { child -> panes(child,result);child.recycle() }
                        }
                        do {
                            val returned=uiAutomation.rootInActiveWindow
                            activePackage=returned?.packageName?.toString()
                            val titles=linkedSetOf<String>()
                            if(returned!=null && activePackage==targetContext.packageName)panes(returned,titles)
                            returned?.recycle();observed=titles.toList();reached=observed.any { it.startsWith(expected) }
                            if(reached || Build.VERSION.SDK_INT<28)break
                            Thread.sleep(60);waitForIdleSync()
                        } while(android.os.SystemClock.elapsedRealtime()-started<2000)
                        backEvidence=mapOf("expected_screen" to back,"observed_panes" to observed,"active_package" to activePackage,
                            "settle_ms" to android.os.SystemClock.elapsedRealtime()-started,"pane_assertion_supported" to (Build.VERSION.SDK_INT>=28),"reached_expected" to reached)
                        if(Build.VERSION.SDK_INT>=28 && !reached) {
                            failures.add("Physical Back did not return to screen $back")
                            if(activePackage==targetContext.packageName)uiAutomation.takeScreenshot()?.let { bitmap ->
                                File(output,"screen-${route.toString().padStart(2,'0')}-back-failure.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) };bitmap.recycle()
                            }
                        }
                    }
                } catch(problem: Throwable) { failures.add("${problem.javaClass.simpleName}: ${problem.message}") }
                finally { activity?.let { owned -> runOnMainSync { owned.finish() } };waitForIdleSync() }
                reports.add(mapOf("screen" to route,"status" to if(failures.isEmpty())"passed" else "failed","failures" to failures,
                    "keyboard" to keyboardEvidence,"scroll_audit" to scrollEvidence,"back" to backEvidence,"small_targets" to small,"partial_scroll_items" to partial,"unnamed_actions" to unnamed,"nodes" to nodes))
            }
        } catch(problem: Throwable) { reports.add(mapOf("status" to "failed","failure" to "${problem.javaClass.simpleName}: ${problem.message}")) }
        finally {
            if(rotation!=null)try {
                check(uiAutomation.setRotation(if(oldAuto==1)android.app.UiAutomation.ROTATION_UNFREEZE else oldDisplay))
                shell("settings put system user_rotation $oldUser")
                shell("settings put system accelerometer_rotation $oldAuto")
                restored=android.provider.Settings.System.getInt(resolver,android.provider.Settings.System.ACCELEROMETER_ROTATION,-1)==oldAuto &&
                    android.provider.Settings.System.getInt(resolver,android.provider.Settings.System.USER_ROTATION,-1)==oldUser
                check(restored) { "Rotation preferences were not restored" }
            } catch(problem: Throwable) { restored=false;reports.add(mapOf("status" to "failed","failure" to "rotation_restore: ${problem.message}")) }
        }
        val failed=reports.count { it["status"]=="failed" }
        File(output,"report.json").writeText(NativeProtocol.canonical(mapOf("reference_only" to true,"font_scale_override" to scale,"scroll_scan_requested" to scanScroll,"rotation_variant" to rotation,"rotation_preferences_restored" to restored,
            "rotation_before" to mapOf("auto" to oldAuto,"user" to oldUser,"display" to oldDisplay),
            "screens" to reports,"failed" to failed,"spoken_screen_reader_verified" to false)))
        finish(if(failed==0)Activity.RESULT_OK else Activity.RESULT_CANCELED,Bundle().apply {
            putString("report",File(output,"report.json").absolutePath);putInt("screens",reports.size);putInt("failed",failed)
        })
    }
}
