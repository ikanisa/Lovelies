package com.lovelies.frontend.preview

import android.app.Instrumentation
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.io.File

/** Optional reference27 probe: follow James to28, verify the count, return to27. */
internal fun runPersonNavigationAudit(instrumentation: Instrumentation,output: File,density: Float): Map<String,Any?> {
    val evidence=linkedMapOf<String,Any?>("reference_only" to true,"person" to "James","expected_matched_photos" to 3)
    val failures=mutableListOf<String>()
    val automation=instrumentation.uiAutomation
    val targetPackage=instrumentation.targetContext.packageName
    fun ownNames(node: AccessibilityNodeInfo)=listOfNotNull(node.text?.toString(),node.contentDescription?.toString()).filter { it.isNotBlank() }.distinct()
    fun tree(): Map<String,Any?> {
        val root=automation.rootInActiveWindow ?: error("No active reference window")
        try {
            check(root.packageName?.toString()==targetPackage) { "Reference app is not active" }
            val names=linkedSetOf<String>();val panes=linkedSetOf<String>()
            fun visit(node: AccessibilityNodeInfo) {
                names.addAll(ownNames(node));node.paneTitle?.toString()?.let(panes::add)
                for(index in 0 until node.childCount)node.getChild(index)?.let { child -> try { visit(child) } finally { child.recycle() } }
            }
            visit(root)
            return mapOf("package" to targetPackage,"panes" to panes.toList(),"names" to names.toList())
        } finally { root.recycle() }
    }
    fun waitForPane(route: Int): Map<String,Any?> {
        val expected="Screen ${route.toString().padStart(2,'0')}:"
        val started=SystemClock.elapsedRealtime()
        var observed: Map<String,Any?>
        do {
            instrumentation.waitForIdleSync();observed=tree()
            if((observed["panes"] as List<*>).any { it.toString().startsWith(expected) })return observed
            Thread.sleep(60)
        } while(SystemClock.elapsedRealtime()-started<2000)
        error("Expected reference screen $route; observed ${observed["panes"]}")
    }
    fun find(root: AccessibilityNodeInfo,predicate: (AccessibilityNodeInfo)->Boolean): AccessibilityNodeInfo? {
        if(predicate(root))return AccessibilityNodeInfo.obtain(root)
        for(index in 0 until root.childCount)root.getChild(index)?.let { child ->
            val found=try { find(child,predicate) } finally { child.recycle() }
            if(found!=null)return found
        }
        return null
    }
    try {
        check(BuildConfig.REFERENCE_SCREENS) { "Reference fixtures are disabled" }
        check(Build.VERSION.SDK_INT>=28) { "Screen pane assertions require Android 9 or newer" }
        evidence["before"]=waitForPane(27)
        var searchMoves=0
        var clicked=false
        while(searchMoves<=4 && !clicked) {
            val root=automation.rootInActiveWindow ?: error("No person action window")
            try {
                check(root.packageName?.toString()==targetPackage) { "Reference app is not active before person action" }
                val window=Rect();root.getBoundsInScreen(window)
                fun reachable(node: AccessibilityNodeInfo): Boolean {
                    val visible=Rect();node.getBoundsInScreen(visible)
                    return node.isClickable && node.isEnabled && node.isVisibleToUser && visible.intersect(window) &&
                        visible.width()+1>=48*density && visible.height()+1>=48*density
                }
                val person=find(root) { ownNames(it).contains("James") && reachable(it) }
                if(person!=null)try {
                    val original=AccessibilityNodeInfo.obtain(person)
                    try {
                        check(person.refresh() && person==original && person.windowId==root.windowId &&
                            person.packageName?.toString()==targetPackage && ownNames(person).contains("James") && reachable(person)) {
                            "Named James action did not survive a fresh identity and bounds check"
                        }
                        val bounds=Rect();person.getBoundsInScreen(bounds)
                        evidence["action"]=mapOf("own_names" to ownNames(person),"selected" to person.isSelected,
                            "class" to person.className?.toString(),"window_id" to person.windowId,
                            "bounds_px" to listOf(bounds.left,bounds.top,bounds.right,bounds.bottom),"search_scrolls" to searchMoves,
                            "interaction" to "accessibility_action_click")
                        check(person.performAction(AccessibilityNodeInfo.ACTION_CLICK)) { "Named James action was rejected" }
                        clicked=true
                    } finally { original.recycle() }
                } finally { person.recycle() }
                else {
                    check(searchMoves<4) { "Named visible 48dp James action was not found within 4 reference scrolls" }
                    val scroller=find(root) { it.isScrollable && it.isVisibleToUser && it.isEnabled &&
                        it.actionList.any { action -> action.id==AccessibilityNodeInfo.ACTION_SCROLL_FORWARD } }
                    check(scroller!=null) { "James is not reachable and no reference forward scroll is available" }
                    try { check(scroller.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)) { "Reference forward scroll was rejected" } }
                    finally { scroller.recycle() }
                    searchMoves++
                }
            } finally { root.recycle() }
            instrumentation.waitForIdleSync();Thread.sleep(180)
        }
        val destination=waitForPane(28);evidence["destination"]=destination
        val names=destination["names"] as List<*>
        check("James" in names && "3 matched photos" in names) { "Person destination did not retain James and 3 matched photos" }
        automation.takeScreenshot()?.let { bitmap ->
            File(output,"person-link-james-screen-28.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG,100,it) };bitmap.recycle()
        }
        instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        evidence["returned"]=waitForPane(27)
    } catch(problem: Throwable) { failures.add("${problem.javaClass.simpleName}: ${problem.message}") }
    evidence["failures"]=failures;evidence["status"]=if(failures.isEmpty())"passed" else "failed"
    return evidence
}
