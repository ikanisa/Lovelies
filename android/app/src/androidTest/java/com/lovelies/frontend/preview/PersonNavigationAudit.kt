package com.lovelies.frontend.preview

import android.app.Activity
import android.app.Instrumentation
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.io.File

/** Optional reference27 probe: verify each exposed person's gallery and return path. */
internal fun runPersonNavigationAudit(instrumentation: Instrumentation,activity: Activity,output: File,density: Float): Map<String,Any?> {
    val cases=listOf(
        Triple("James",3,setOf("Photo 1","Photo 2","Photo 4")),
        Triple("Sophie",6,setOf("Photo 1","Photo 4","Photo 7","Photo 9","Photo 5","Photo 3")),
        Triple("Mark",4,setOf("Photo 1","Photo 2","Photo 4","Photo 6")),
        Triple("Emma",3,setOf("Photo 1","Photo 2","Photo 4")),
        Triple("Olivia",2,setOf("Photo 1","Photo 2")),
        Triple("Daniel",2,setOf("Photo 1","Photo 2")),
        Triple("Maya",1,setOf("Photo 1")))
    val results=mutableListOf<Map<String,Any?>>()
    for((person,count,photos) in cases) {
        val folder=File(output,"person-${person.lowercase()}").apply { mkdirs() }
        val result=auditPersonNavigation(instrumentation,activity,folder,density,person,count,photos)
        results.add(result)
        if(result["status"]!="passed")break
    }
    val failures=results.flatMap { result -> (result["failures"] as List<*>).map { "${result["person"]}: $it" } }.toMutableList()
    if(results.size!=cases.size)failures.add("Only ${results.size} of ${cases.size} person journeys completed")
    return linkedMapOf<String,Any?>().apply {
        results.firstOrNull()?.let(::putAll)
        put("people",results);put("people_requested",cases.size);put("people_completed",results.size)
        put("forward_attempt_limit_per_person",4);put("forward_attempt_limit_total",4*cases.size)
        put("status",if(failures.isEmpty())"passed" else "failed");put("failures",failures)
    }
}

private fun auditPersonNavigation(instrumentation: Instrumentation,activity: Activity,output: File,density: Float,
    personName: String,expectedCount: Int,expectedPhotos: Set<String>): Map<String,Any?> {
    val evidence=linkedMapOf<String,Any?>("reference_only" to true,"person" to personName,"expected_matched_photos" to expectedCount)
    val failures=mutableListOf<String>()
    val caption="$expectedCount matched ${if(expectedCount==1)"photo" else"photos"}"
    val automation=instrumentation.uiAutomation
    val targetPackage=instrumentation.targetContext.packageName
    fun ownNames(node: AccessibilityNodeInfo)=listOfNotNull(node.text?.toString(),node.contentDescription?.toString()).filter { it.isNotBlank() }.distinct()
    fun tree(): Map<String,Any?> {
        val root=automation.rootInActiveWindow ?: error("No active reference window")
        try {
            check(root.packageName?.toString()==targetPackage) { "Reference app is not active" }
            val names=linkedSetOf<String>();val panes=linkedSetOf<String>();val actions=mutableListOf<Map<String,Any?>>()
            var fresh=true
            fun visit(node: AccessibilityNodeInfo) {
                if(!node.refresh() || node.windowId!=root.windowId || node.packageName?.toString()!=targetPackage) { fresh=false;return }
                if(node.isClickable || node.isScrollable) {
                    val bounds=Rect();node.getBoundsInScreen(bounds)
                    actions.add(mapOf("identity" to "${node.windowId}:${node.hashCode()}","names" to ownNames(node),
                        "bounds_px" to listOf(bounds.left,bounds.top,bounds.right,bounds.bottom),"visible" to node.isVisibleToUser,
                        "enabled" to node.isEnabled,"actions" to node.actionList.map { it.id }.sorted()))
                }
                names.addAll(ownNames(node));node.paneTitle?.toString()?.let(panes::add)
                for(index in 0 until node.childCount)node.getChild(index)?.let { child -> try { visit(child) } finally { child.recycle() } }
            }
            visit(root)
            return mapOf("package" to targetPackage,"window_id" to root.windowId,"panes" to panes.toList(),"names" to names.toList(),"actions" to actions,"fresh_complete" to fresh)
        } finally { root.recycle() }
    }
    fun waitForPane(route: Int): Map<String,Any?> {
        val expected=referencePaneTitle(activity,route)
        val started=SystemClock.elapsedRealtime()
        var observed: Map<String,Any?>
        var previous: Map<String,Any?>?=null
        do {
            instrumentation.waitForIdleSync();observed=tree()
            val names=observed["names"] as List<*>
            val body=if(route==27)(("Photo 1" in names && "1/12" in names) || "People in this photo" in names) && names.none { Regex("[0-9]+ matched photos?").matches(it.toString()) }
                else personName in names && caption in names && "1/12" !in names
            val ready=observed["fresh_complete"]==true && body && (observed["panes"] as List<*>).any { it.toString()==expected }
            if(ready && observed==previous)return observed
            previous=if(ready)observed else null
            Thread.sleep(80)
        } while(SystemClock.elapsedRealtime()-started<2000)
        error("Expected reference screen $route; observed ${observed["panes"]}")
    }
    fun find(root: AccessibilityNodeInfo,predicate: (AccessibilityNodeInfo)->Boolean): AccessibilityNodeInfo? {
        if(!root.refresh() || root.packageName?.toString()!=targetPackage)return null
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
        val scrollEvidence=mutableListOf<Map<String,Any?>>()
        evidence["search_scrolls"]=scrollEvidence
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
                val person=find(root) { ownNames(it).contains(personName) && reachable(it) }
                if(person!=null)try {
                    val original=AccessibilityNodeInfo.obtain(person)
                    try {
                        check(person.refresh() && person==original && person.windowId==root.windowId &&
                            person.packageName?.toString()==targetPackage && ownNames(person).contains(personName) && reachable(person)) {
                            "Named $personName action did not survive a fresh identity and bounds check"
                        }
                        val bounds=Rect();person.getBoundsInScreen(bounds)
                        evidence["action"]=mapOf("own_names" to ownNames(person),"selected" to person.isSelected,"checkable" to person.isCheckable,"checked" to person.isChecked,
                            "class" to person.className?.toString(),"window_id" to person.windowId,
                            "bounds_px" to listOf(bounds.left,bounds.top,bounds.right,bounds.bottom),"search_scrolls" to searchMoves,
                            "interaction" to "accessibility_action_click")
                        check(person.performAction(AccessibilityNodeInfo.ACTION_CLICK)) { "Named $personName action was rejected" }
                        clicked=true
                    } finally { original.recycle() }
                } finally { person.recycle() }
                else {
                    check(searchMoves<4) { "Named visible 48dp $personName action was not found within 4 reference scrolls" }
                    val scroller=find(root) { it.isScrollable && it.isVisibleToUser && it.isEnabled &&
                        it.actionList.any { action -> action.id==AccessibilityNodeInfo.ACTION_SCROLL_FORWARD } }
                    check(scroller!=null) { "${personName} is not reachable and no reference forward scroll is available" }
                    val anchor=AccessibilityNodeInfo.obtain(scroller)
                    try {
                        check(scroller.refresh() && scroller==anchor && scroller.windowId==root.windowId &&
                            scroller.packageName?.toString()==targetPackage && scroller.isEnabled && scroller.isVisibleToUser &&
                            scroller.actionList.any { it.id==AccessibilityNodeInfo.ACTION_SCROLL_FORWARD }) { "Reference forward scroller failed its fresh source/action check" }
                        val bounds=Rect();scroller.getBoundsInScreen(bounds);val visible=Rect(bounds)
                        check(visible.intersect(window) && visible.width()+1>=48*density && visible.height()+1>=48*density) { "Reference forward scroller has no visible 48dp viewport" }
                        val accepted=scroller.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)
                        scrollEvidence.add(mapOf("window_id" to scroller.windowId,"fresh_source_matched" to true,
                            "bounds_px" to listOf(bounds.left,bounds.top,bounds.right,bounds.bottom),"accepted" to accepted))
                        check(accepted) { "Reference forward scroll was rejected" }
                    } finally { anchor.recycle();scroller.recycle() }
                    searchMoves++
                }
            } finally { root.recycle() }
            instrumentation.waitForIdleSync();Thread.sleep(180)
        }
        val destination=waitForPane(28);evidence["destination"]=destination
        val names=destination["names"] as List<*>
        check(personName in names && caption in names) { "Person destination did not retain $personName and $caption" }
        val destinationAudit=runReferenceScrollAudit(instrumentation,output,28,density)
        evidence["destination_scroll_audit"]=destinationAudit
        check(destinationAudit["status"]=="passed") { "$personName gallery scroll audit failed: ${destinationAudit["failures"]}" }
        val photoActions=(destinationAudit["targets"] as List<*>).mapNotNull { (it as? Map<*,*>)?.get("name") as? String }
            .filter { Regex("Photo [0-9]+").matches(it) }
        val photos=photoActions.toSet()
        evidence["destination_photo_actions"]=photoActions.sorted()
        evidence["destination_photo_action_count"]=photoActions.size
        check(photoActions.size==expectedCount && photos==expectedPhotos) { "$personName gallery should contain exactly $expectedCount matched reference photos; observed $photoActions" }
        automation.takeScreenshot()?.let { bitmap ->
            File(output,"screen-28.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG,100,it) };bitmap.recycle()
        }
        instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        evidence["returned"]=waitForPane(27)
        val returned=automation.rootInActiveWindow ?: error("No returned reference window")
        try {
            val window=Rect();returned.getBoundsInScreen(window)
            val exit=find(returned) { node ->
                val bounds=Rect();node.getBoundsInScreen(bounds)
                ownNames(node).contains("Back") && node.isClickable && node.isEnabled && node.isVisibleToUser &&
                    bounds.intersect(window) && bounds.width()+1>=48*density && bounds.height()+1>=48*density
            }
            check(exit!=null) { "Returned27 has no named visible48dp Back action" }
            val anchor=AccessibilityNodeInfo.obtain(exit)
            try {
                check(exit.refresh() && exit==anchor && exit.windowId==returned.windowId && exit.packageName?.toString()==targetPackage &&
                    ownNames(exit).contains("Back") && exit.isClickable && exit.isEnabled && exit.isVisibleToUser) { "Returned27 Back action failed its fresh source/name check" }
                val bounds=Rect();exit.getBoundsInScreen(bounds);val visible=Rect(bounds)
                check(visible.intersect(window) && visible.width()+1>=48*density && visible.height()+1>=48*density) { "Returned27 Back action has no visible48dp bounds" }
                evidence["returned_exit_ready"]=mapOf("own_names" to ownNames(exit),"fresh_source_matched" to true,
                    "bounds_px" to listOf(bounds.left,bounds.top,bounds.right,bounds.bottom))
            } finally { anchor.recycle();exit.recycle() }
        } finally { returned.recycle() }
    } catch(problem: Throwable) { failures.add("${problem.javaClass.simpleName}: ${problem.message}") }
    evidence["failures"]=failures;evidence["status"]=if(failures.isEmpty())"passed" else "failed"
    return evidence
}
