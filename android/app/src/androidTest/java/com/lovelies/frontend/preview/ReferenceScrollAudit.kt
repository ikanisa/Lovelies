package com.lovelies.frontend.preview

import android.app.Instrumentation
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/** Reference-only inspection. The only dispatched AX actions are scroll/show-on-screen. */
internal fun runReferenceScrollAudit(instrumentation: Instrumentation,output: File,route: Int,density: Float): Map<String,Any?> =
    ReferenceScrollAudit(instrumentation,output,route,density).run()

private class ReferenceScrollAudit(private val instrumentation: Instrumentation,private val output: File,
    private val route: Int,private val density: Float) {
    private data class Container(val key: String,val path: List<Int>,val parents: List<String>,val bounds: Rect,val actions: Set<Int>)
    private data class ScrollRegion(val key: String,val parents: List<String>,val bounds: Rect,val scrollable: Boolean)
    private data class Target(val key: String,val identity: String,val name: String,val ownName: String,val path: List<Int>,val bounds: Rect,val viewport: Rect,
        val full: Boolean,val reachable48: Boolean,val visibleBounds: Rect,val interiorSmall: Boolean,val partial: Boolean,val parents: List<String>,val regions: List<String>)
    private data class Snapshot(val targets: List<Target>,val containers: List<Container>,val regions: List<ScrollRegion>,val settled: Boolean=false)
    private data class Observation(val identity: String,val name: String,var full: Boolean=false,var reachable48: Boolean=false,var partial: Boolean=false,
        val interiorSmall: MutableList<List<Int>> = mutableListOf(),var samples: Int=0,
        val recoveredFragments: MutableList<List<Int>> = mutableListOf(),val ownNames: MutableSet<String> = linkedSetOf(),
        val geometry: MutableList<Map<String,Any?>> = mutableListOf())
    // AX child indexes change when Compose omits offscreen semantics. Android's public equals
    // compares source-node ID and window ID; keep an independent identity copy for this run.
    private data class Identity(val key: String,val window: Int,val unique: String?,val anchor: AccessibilityNodeInfo)
    private data class Move(val dispatched: Boolean,val attempted: Boolean=false)
    private data class Probe(val state: Snapshot,val freshReachable: Boolean)
    private val failures=mutableListOf<String>()
    private val observations=linkedMapOf<String,Observation>()
    private val identities=mutableListOf<Identity>()
    private val unnamed=linkedMapOf<String,Map<String,Any?>>()
    private val scans=mutableListOf<Map<String,Any?>>()
    private val screenshots=mutableListOf<String>()
    private val visited=mutableSetOf<String>()
    private val footerSeen=linkedSetOf<String>()
    private val fullFooterSeen=linkedSetOf<String>()
    private val probedTargets=mutableSetOf<String>()
    private val scrollPositions=mutableMapOf<String,Map<String,Int>>()
    private val scrollEvents=mutableListOf<Map<String,Any?>>()
    private val refreshSamples=mutableListOf<Map<String,Any?>>()
    private val directionChecks=mutableListOf<Map<String,Any?>>()
    private val probeSamples=mutableListOf<Map<String,Any?>>()
    private val alignmentSamples=mutableListOf<Map<String,Any?>>()
    private val alignedRegions=mutableSetOf<String>()
    private val alignmentResetParents=mutableSetOf<String>()
    private val startedAt=SystemClock.uptimeMillis()
    private val maxFreshChecks=3
    private var moves=0
    private var snapshots=0
    private var capped=false
    private val maxMoves=96
    private val maxContainerMoves=24
    private val maxDepth=6
    private fun label(id: Int)=instrumentation.targetContext.getString(id)
    private val expectedFooters=when(route) {
        1 -> listOf("Get started")
        2 -> listOf("Get Started")
        3 -> listOf("Create Account","Sign In")
        4 -> listOf("Not Now")
        5 -> listOf(label(R.string.copy_continue_2e026239))
        6 -> listOf("Capture simulated selfie 1 of 3")
        10,11,37 -> listOf("Home","Profile")
        31,32,41 -> listOf("Continue")
        7 -> listOf(label(R.string.copy_retake_16457335),label(R.string.copy_use_this_anyway_986e85ae))
        8,23,34 -> listOf(label(R.string.a11y_continue_preview))
        9 -> listOf(label(R.string.copy_let_s_go_0f0afeff))
        16 -> listOf("Show Results (342)")
        20 -> listOf("Take a Photo")
        21 -> listOf("Next")
        22 -> listOf("Start Upload")
        24 -> listOf("View in Library","Recent Uploads")
        25 -> listOf("View Matches")
        29,30 -> listOf("Continue with selected photos")
        33 -> listOf("Share Photos")
        36 -> listOf("Submit")
        38 -> listOf("Replace Face","Tips for best results")
        43 -> listOf("Manage Storage")
        44 -> listOf("Request Export")
        45 -> listOf("Contact Support")
        47 -> listOf("Keep Exploring")
        48 -> listOf("Try Again","Go Back")
        else -> emptyList()
    }

    private fun Rect.wire()=listOf(left,top,right,bottom)
    private fun normalize(value: String)=value.lowercase().replace('\u2019','\'').replace(Regex("\\s+")," ").trim()
    private fun matches(name: String,expected: String): Boolean {
        val wanted=normalize(expected)
        return name.split(" · ").any { val value=normalize(it);value==wanted || value.startsWith("$wanted, ") }
    }
    private fun viewport(window: Rect,ancestors: List<Rect>): Rect {
        val result=Rect(window)
        ancestors.forEach { if(!result.intersect(it))return Rect() }
        return result
    }

    private fun unique(node: AccessibilityNodeInfo)=if(Build.VERSION.SDK_INT>=33)node.uniqueId?.takeIf { it.isNotBlank() } else null
    private fun sameNode(identity: Identity,node: AccessibilityNodeInfo): Boolean =
        identity.window==node.windowId && if(identity.unique!=null)identity.unique==unique(node) else identity.anchor==node
    private fun identity(node: AccessibilityNodeInfo): String {
        identities.firstOrNull { sameNode(it,node) }?.let { return it.key }
        val key="ax:${node.windowId}:${node.hashCode()}:${identities.size}"
        identities.add(Identity(key,node.windowId,unique(node),AccessibilityNodeInfo.obtain(node)))
        return key
    }

    private fun readSnapshot(): Snapshot {
        instrumentation.waitForIdleSync()
        val root=instrumentation.uiAutomation.rootInActiveWindow ?: error("No reference accessibility window")
        try {
            check(root.packageName?.toString()==instrumentation.targetContext.packageName) { "Reference Activity is not the active window" }
            val window=Rect();root.getBoundsInScreen(window)
            val targets=mutableListOf<Target>();val containers=mutableListOf<Container>();val regions=mutableListOf<ScrollRegion>()
            fun visit(node: AccessibilityNodeInfo,path: List<Int>,parents: List<String>,scrollParents: List<String>,edges: List<Rect>): String {
                val bounds=Rect();node.getBoundsInScreen(bounds)
                val currentViewport=viewport(window,edges)
                val reachable=node.isVisibleToUser && !bounds.isEmpty && Rect.intersects(bounds,currentViewport)
                // Compose can retain ScrollBy semantics on a zero-range ScrollView while
                // isScrollable is false. SHOW still stops at that nearest semantic ancestor.
                val scrollRegion=(node.isScrollable || node.className?.toString() in setOf("android.widget.ScrollView","android.widget.HorizontalScrollView")) &&
                    node.windowId==root.windowId && node.packageName?.toString()==instrumentation.targetContext.packageName
                val key=if(node.isScrollable || scrollRegion || node.isClickable || node.isSelected)identity(node) else ""
                val ownContainer=node.isScrollable && reachable
                val nextParents=if(ownContainer)parents+key else parents
                val nextScrollParents=if(scrollRegion && reachable)scrollParents+key else scrollParents
                // Non-scroll semantics parents can also report a clipping boundary (for example
                // a toolbar partly obscured by the adaptive host). Include every represented edge.
                val nextEdges=if(bounds.isEmpty)edges else edges+Rect(bounds)
                if(ownContainer)containers.add(Container(key,path,parents,Rect(bounds),node.actionList.map { it.id }.toSet()))
                if(scrollRegion && reachable)regions.add(ScrollRegion(key,scrollParents,Rect(bounds),node.isScrollable))
                val children=mutableListOf<String>()
                for(i in 0 until node.childCount)node.getChild(i)?.let { child ->
                    children.add(visit(child,path+i,nextParents,nextScrollParents,nextEdges));child.recycle()
                }
                val own=listOfNotNull(node.text?.toString(),node.contentDescription?.toString()).filter { it.isNotBlank() }.distinct().joinToString(" · ")
                val name=own.ifBlank { children.filter { it.isNotBlank() }.distinct().joinToString(" · ") }
                // Compose exposes the current selected tab as non-clickable. It still needs a
                // visible, named, adequately sized location in required navigation coverage.
                if((node.isClickable || node.isSelected) && node.isEnabled && reachable) {
                    val widthOk=bounds.width()+1>=48*density;val heightOk=bounds.height()+1>=48*density
                    // AX child and ancestor edges can round in opposite directions by one
                    // raster pixel. Match the existing one-pixel minimum-size tolerance.
                    val contained=bounds.left>=currentViewport.left-1 && bounds.top>=currentViewport.top-1 &&
                        bounds.right<=currentViewport.right+1 && bounds.bottom<=currentViewport.bottom+1
                    val atWidthEdge=!widthOk && (bounds.left<=currentViewport.left+1 || bounds.right>=currentViewport.right-1)
                    val atHeightEdge=!heightOk && (bounds.top<=currentViewport.top+1 || bounds.bottom>=currentViewport.bottom-1)
                    val partial=!contained || atWidthEdge || atHeightEdge
                    val visibleBounds=Rect(bounds)
                    if(!visibleBounds.intersect(currentViewport))visibleBounds.setEmpty()
                    val reachable48=visibleBounds.width()+1>=48*density && visibleBounds.height()+1>=48*density
                    if(name.isBlank()) {
                        val unnamedKey="$key|${node.className}"
                        unnamed[unnamedKey]=mapOf("key" to unnamedKey,"bounds_px" to bounds.wire(),"viewport_px" to currentViewport.wire(),
                            "fully_bounded" to (contained && widthOk && heightOk),"partial" to partial,"scroll_ancestors" to parents,
                            "diagnostic_child_path" to path)
                    } else {
                        // Keep the name in the observation key: subtitle-only or missing names
                        // after clipping must not inherit a different label's successful observation.
                        val targetKey="$key|${node.className}|checkable=${node.isCheckable}|$name"
                        targets.add(Target(targetKey,key,name,own,path,Rect(bounds),currentViewport,contained && widthOk && heightOk,reachable48,visibleBounds,
                            contained && (!widthOk || !heightOk) && !partial,partial,parents,scrollParents))
                    }
                }
                // A nested action has its own audit/name. Do not append a Save/Favorite
                // checkbox label to its photo action's fallback when that child is visible.
                return if(node.isClickable || node.isSelected)"" else name
            }
            visit(root,emptyList(),emptyList(),emptyList(),emptyList())
            return Snapshot(targets,containers,regions)
        } finally { root.recycle() }
    }

    private fun signature(state: Snapshot)=state.targets.map { "${it.key}:${it.bounds.wire()}:${it.viewport.wire()}" }.sorted().joinToString(";")+
        state.containers.map { "${it.key}:${it.bounds.wire()}:${it.actions.sorted()}" }.sorted().joinToString(";")+
        state.regions.map { "${it.key}:${it.bounds.wire()}:${it.scrollable}" }.sorted().joinToString(";")

    private fun snapshot(record: Boolean=true): Snapshot {
        var state=readSnapshot();var stable=false
        for(attempt in 0 until 3) {
            Thread.sleep(80);val next=readSnapshot()
            if(signature(state)==signature(next)) { state=next;stable=true;break }
            state=next
        }
        if(!stable)failures.add("Accessibility geometry did not settle within 240ms")
        snapshots++
        val settled=state.copy(settled=stable)
        if(record)observe(settled)
        return settled
    }

    private fun observe(state: Snapshot,blockedProofKeys: Set<String> = emptySet()) {
        state.targets.forEach { target ->
            val stable=state.settled && target.key !in blockedProofKeys
            val observation=observations.getOrPut(target.key) { Observation(target.identity,target.name) }
            observation.samples++;observation.full=observation.full || (stable && target.full)
            observation.reachable48=observation.reachable48 || (stable && target.reachable48)
            observation.ownNames.add(target.ownName)
            val geometry=mapOf("bounds_px" to target.bounds.wire(),"viewport_px" to target.viewport.wire(),
                "visible_intersection_px" to target.visibleBounds.wire(),"fully_bounded" to target.full,"reachable_48dp" to target.reachable48)
            val firstReachableProof=target.reachable48 && observation.geometry.none { it["reachable_48dp"]==true }
            val firstFullProof=target.full && observation.geometry.none { it["fully_bounded"]==true }
            if(stable && geometry !in observation.geometry && (observation.geometry.size<24 || firstReachableProof || firstFullProof))observation.geometry.add(geometry)
            observation.partial=observation.partial || target.partial
            if(state.settled && target.interiorSmall && target.bounds.wire() !in observation.interiorSmall)observation.interiorSmall.add(target.bounds.wire())
            if(stable && target.reachable48)expectedFooters.filter { matches(target.name,it) }.forEach(footerSeen::add)
            if(stable && target.full)expectedFooters.filter { matches(target.name,it) }.forEach(fullFooterSeen::add)
        }
    }

    private fun nodeByIdentity(key: String): AccessibilityNodeInfo? {
        val expected=identities.firstOrNull { it.key==key } ?: return null
        val root=instrumentation.uiAutomation.rootInActiveWindow ?: return null
        try {
            if(root.packageName?.toString()!=instrumentation.targetContext.packageName)return null
            fun find(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
                if(sameNode(expected,node))return AccessibilityNodeInfo.obtain(node)
                for(i in 0 until node.childCount)node.getChild(i)?.let { child ->
                    val found=try { find(child) } finally { child.recycle() }
                    if(found!=null)return found
                }
                return null
            }
            return find(root)
        } finally { root.recycle() }
    }

    /** Refresh only a temporary query copy; the retained identity anchor is never mutated. */
    private fun freshNode(key: String,phase: String): AccessibilityNodeInfo? {
        val began=SystemClock.uptimeMillis()
        val sample=mutableMapOf<String,Any?>("identity" to key,"phase" to phase,"run_elapsed_ms" to (began-startedAt),
            "refresh_succeeded" to false,"identity_matched" to false)
        var node: AccessibilityNodeInfo?=null;var retained=false
        try {
            val expected=identities.firstOrNull { it.key==key } ?: return null
            val current=nodeByIdentity(key) ?: return null
            node=current
            val before=Rect();current.getBoundsInScreen(before)
            sample["bounds_before_px"]=before.wire();sample["actions_before"]=current.actionList.map { it.id }.sorted()
            val refreshed=current.refresh()
            sample["refresh_succeeded"]=refreshed
            if(!refreshed)return null
            val after=Rect();current.getBoundsInScreen(after)
            val matched=sameNode(expected,current) && current.packageName?.toString()==instrumentation.targetContext.packageName
            sample["identity_matched"]=matched;sample["window_id"]=current.windowId
            sample["bounds_after_px"]=after.wire();sample["actions_after"]=current.actionList.map { it.id }.sorted()
            sample["enabled"]=current.isEnabled;sample["visible"]=current.isVisibleToUser
            if(!matched)return null
            retained=true;return current
        } finally {
            sample["elapsed_ms"]=SystemClock.uptimeMillis()-began
            refreshSamples.add(sample)
            if(!retained)node?.recycle()
        }
    }

    /** Two consecutive fresh, unchanged observations establish an absent direction action. */
    private fun directionAbsentFresh(key: String,action: Int,phase: String): Boolean {
        val began=SystemClock.uptimeMillis()
        val sample=mutableMapOf<String,Any?>("identity" to key,"phase" to phase,"action" to action,
            "run_elapsed_ms" to (began-startedAt),"confirmed_absent" to false,"checks" to 0)
        var previous: String?=null
        try {
            for(attempt in 0 until maxFreshChecks) {
                if(capped)return false
                instrumentation.waitForIdleSync()
                if(attempt>0)Thread.sleep(80)
                sample["checks"]=attempt+1
                val node=freshNode(key,"$phase:check-$attempt")
                if(node==null) { previous=null;continue }
                try {
                    val bounds=Rect();node.getBoundsInScreen(bounds)
                    val actions=node.actionList.map { it.id }.sorted()
                    if(!node.isEnabled || !node.isVisibleToUser || bounds.isEmpty || action in actions) { previous=null;continue }
                    val current="${node.windowId}:${bounds.wire()}:$actions"
                    if(current==previous) { sample["confirmed_absent"]=true;return true }
                    previous=current
                } finally { node.recycle() }
            }
            return false
        } finally {
            sample["elapsed_ms"]=SystemClock.uptimeMillis()-began;directionChecks.add(sample)
        }
    }

    private fun move(key: String,action: Int,phase: String): Move {
        check(action in setOf(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD,AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD,
            AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id))
        val began=SystemClock.uptimeMillis()
        val telemetry=mutableMapOf<String,Any?>("container" to key,"phase" to phase,"action" to action,
            "run_elapsed_ms" to (began-startedAt),"attempted" to false,"dispatched" to false,"source_matched" to false)
        var queried: AccessibilityNodeInfo?=null
        try {
            if(moves>=maxMoves) { capped=true;telemetry["reason"]="move_cap";return Move(false) }
            val node=freshNode(key,"$phase:before-action") ?: run { telemetry["reason"]="fresh_node_unavailable";return Move(false) }
            queried=node
            val advertised=node.actionList.any { it.id==action }
            telemetry["action_advertised"]=advertised;telemetry["actions_before"]=node.actionList.map { it.id }.sorted()
            if(!node.isEnabled || !node.isVisibleToUser) { telemetry["reason"]="node_not_enabled_visible";return Move(false) }
            // Compose handles SHOW_ON_SCREEN without advertising it. Scroll directions
            // still require the provider's current advertised action.
            if(action!=AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id && !advertised) {
                telemetry["reason"]="scroll_action_absent";return Move(false)
            }
            moves++
            telemetry["attempted"]=true
            val dispatched=AtomicBoolean(false)
            val expected=identities.first { it.key==key }
            val event=try {
                instrumentation.uiAutomation.executeAndWaitForEvent({ dispatched.set(node.performAction(action)) },
                    { candidate ->
                        if(candidate.eventType!=AccessibilityEvent.TYPE_VIEW_SCROLLED || candidate.packageName?.toString()!=instrumentation.targetContext.packageName)false
                        else if(action==AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id)true
                        else candidate.source?.let { source -> try { sameNode(expected,source) } finally { source.recycle() } } ?: false
                    },900)
            } catch(_: java.util.concurrent.TimeoutException) { null }
            telemetry["dispatched"]=dispatched.get()
            telemetry["event_received"]=event!=null
            event?.let {
                val source=it.source
                val matched=try { source!=null && sameNode(expected,source) } finally { source?.recycle() }
                telemetry["source_matched"]=matched
                telemetry["event_geometry"]=mapOf("scroll_x" to it.scrollX,"scroll_y" to it.scrollY,"max_scroll_x" to it.maxScrollX,
                    "max_scroll_y" to it.maxScrollY,"from_index" to it.fromIndex,"to_index" to it.toIndex,"item_count" to it.itemCount)
                if(matched) {
                    val previous=scrollPositions[key].orEmpty()
                    val position=linkedMapOf<String,Int>()
                    // Android13 defaults X/Y to zero even when an axis was not supplied.
                    if(it.maxScrollX>0 || "x" in previous)position["x"]=it.scrollX
                    if(it.maxScrollY>0 || "y" in previous)position["y"]=it.scrollY
                    if(it.itemCount>0 && it.fromIndex>=0 && it.toIndex>=it.fromIndex) {
                        position["from"]=it.fromIndex;position["to"]=it.toIndex
                    }
                    if(position.isNotEmpty())scrollPositions[key]=position
                    telemetry["supported_position"]=position
                }
                it.recycle()
            }
            instrumentation.waitForIdleSync();Thread.sleep(100)
            return Move(dispatched.get(),true)
        } finally {
            queried?.recycle()
            telemetry["elapsed_ms"]=SystemClock.uptimeMillis()-began
            scrollEvents.add(telemetry)
        }
    }

    private fun measureProbe(target: Target,state: Snapshot,move: Move,phase: String,actionIdentity: String,began: Long): Boolean {
        val sample=mutableMapOf<String,Any?>("identity" to target.identity,"name" to target.name,"phase" to phase,
            "action_identity" to actionIdentity,
            "attempted" to move.attempted,"accepted" to move.dispatched,"settled" to state.settled,
            "fresh_result_reachable_48dp" to false,"bounds_before_px" to target.bounds.wire())
        val current=state.targets.firstOrNull { it.key==target.key }
        val fresh=freshNode(target.identity,"$phase:result")
        var freshReachable=false
        try {
            current?.let { sample["snapshot_bounds_px"]=it.bounds.wire();sample["viewport_px"]=it.viewport.wire() }
            if(fresh!=null) {
                val bounds=Rect();fresh.getBoundsInScreen(bounds);sample["fresh_bounds_px"]=bounds.wire()
                val visible=Rect(bounds)
                if(current==null || !visible.intersect(current.viewport))visible.setEmpty()
                sample["visible_intersection_px"]=visible.wire()
                // Acceptance alone is not visibility evidence: require the same named target,
                // fresh matching geometry and the unchanged minimum intersection criterion.
                val own=listOfNotNull(fresh.text?.toString(),fresh.contentDescription?.toString()).filter { it.isNotBlank() }.distinct().joinToString(" · ")
                sample["fresh_own_label"]=own
                freshReachable=move.attempted && state.settled && current!=null && own==current.ownName &&
                    bounds==current.bounds && fresh.isVisibleToUser && fresh.isEnabled &&
                    visible.width()+1>=48*density && visible.height()+1>=48*density
                sample["fresh_result_reachable_48dp"]=freshReachable
            }
        } finally {
            fresh?.recycle();sample["elapsed_ms"]=SystemClock.uptimeMillis()-began;probeSamples.add(sample)
        }
        return freshReachable
    }

    private fun showOnScreen(target: Target,phase: String): Probe {
        val began=SystemClock.uptimeMillis()
        val move=move(target.identity,AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id,phase)
        // Delay proof credit until the refreshed target agrees with this settled snapshot.
        val state=snapshot(record=false)
        val freshReachable=measureProbe(target,state,move,phase,target.identity,began)
        // Keep every other target's normal observations and all small-target failures.
        observe(state,if(freshReachable)emptySet() else setOf(target.key))
        return Probe(state,freshReachable)
    }

    /** One ancestor-self SHOW per inner region; acceptance never substitutes for target proof. */
    private fun alignInnerRegions(state: Snapshot,parent: String,depth: Int): Snapshot {
        var result=state
        state.regions.filter { it.parents.lastOrNull()==parent }.forEach { initial ->
            if(!alignedRegions.add(initial.key))return@forEach
            val phase="ancestor-align:$depth:$parent:${initial.key}"
            val began=SystemClock.uptimeMillis()
            val originals=result.targets.filter { initial.key in it.regions && observations[it.key]?.reachable48!=true }
            val sample=mutableMapOf<String,Any?>("identity" to initial.key,"parent" to parent,"phase" to phase,
                "run_elapsed_ms" to (began-startedAt),"scrollable" to initial.scrollable,"bounds_before_px" to initial.bounds.wire(),
                "original_targets" to originals.map { it.key },"attempted" to false,"accepted" to false,"parent_reset" to false)
            try {
                var region=result.regions.firstOrNull { it.key==initial.key } ?: run { sample["reason"]="region_unavailable";return@forEach }
                val outer=result.containers.firstOrNull { it.key==parent }
                // If discovered only after outer paging, its represented top can already be
                // clipped. A single bounded fresh top reset restores a useful leading edge.
                if(outer!=null && region.bounds.top<=outer.bounds.top+1 && alignmentResetParents.add(parent)) {
                    sample["parent_reset"]=true
                    if(!resetTop(parent,"$phase:reset-parent")) {
                        failures.add("Could not establish ancestor alignment start for $parent")
                        sample["reason"]="parent_start_unproved";return@forEach
                    }
                    result=snapshot()
                    region=result.regions.firstOrNull { it.key==initial.key } ?: run { sample["reason"]="region_unavailable_after_reset";return@forEach }
                }
                val action=move(region.key,AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id,phase)
                sample["attempted"]=action.attempted;sample["accepted"]=action.dispatched
                result=snapshot(record=false)
                sample["settled"]=result.settled
                sample["bounds_after_px"]=result.regions.firstOrNull { it.key==region.key }?.bounds?.wire()
                val proved=originals.filter { measureProbe(it,result,action,phase,region.key,began) }.map { it.key }.toSet()
                sample["fresh_reachable_targets"]=proved.toList()
                observe(result,originals.map { it.key }.toSet()-proved)
                sample["reason"]=if(action.attempted)"original_target_geometry_required" else "action_not_attempted"
            } finally {
                sample["elapsed_ms"]=SystemClock.uptimeMillis()-began;alignmentSamples.add(sample)
            }
        }
        return result
    }

    private fun fingerprint(state: Snapshot,container: String)=state.targets.filter { container in it.parents }
        .map { "${it.key}:${it.bounds.wire()}" }.sorted().joinToString(";")+"|source_scroll_position=${scrollPositions[container]}"

    private fun probeSmallVisibleTargets(state: Snapshot,container: String): Snapshot {
        var result=state
        state.targets.filter { it.parents.lastOrNull()==container && observations[it.key]?.reachable48!=true }.forEach { target ->
            val current=result.targets.firstOrNull { it.key==target.key && it.parents.lastOrNull()==container }
            if(current!=null && observations[current.key]?.reachable48!=true && probedTargets.add(current.key))
                result=showOnScreen(current,"sweep-probe:$container").state
        }
        return result
    }

    private fun resetTop(key: String,phase: String): Boolean {
        var previous="";var repeated=0
        for(step in 0 until maxContainerMoves) {
            val state=snapshot();val container=state.containers.firstOrNull { it.key==key } ?: return false
            if(directionAbsentFresh(key,AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD,"$phase:at-start-$step"))return true
            val current=fingerprint(state,key)
            repeated=if(current==previous)repeated+1 else 0;previous=current
            if(repeated>=2)return false
            val result=move(container.key,AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD,"$phase:backward-$step")
            if(!result.dispatched) {
                snapshot()
                return !capped && directionAbsentFresh(key,AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD,"$phase:after-rejection-$step")
            }
        }
        capped=true;return false
    }

    private fun saveBottom() {
        if(screenshots.size>=3)return
        val bitmap=instrumentation.uiAutomation.takeScreenshot() ?: return
        val file=File(output,"screen-${route.toString().padStart(2,'0')}-scroll-bottom-${screenshots.size+1}.png")
        try { file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG,100,it) };screenshots.add(file.absolutePath) }
        finally { bitmap.recycle() }
    }

    private fun sweep(key: String,depth: Int) {
        if(depth>maxDepth || moves>=maxMoves) { capped=true;return }
        if(!resetTop(key,"sweep-start:$depth")) { failures.add("Could not establish scroll start for $key");return }
        var previous="";var repeated=0;var terminal=false;var reason="move_limit"
        for(step in 0 until maxContainerMoves) {
            var state=alignInnerRegions(snapshot(),key,depth)
            state=probeSmallVisibleTargets(state,key);val container=state.containers.firstOrNull { it.key==key }
            if(container==null) { reason="container_not_visible";break }
            state.containers.filter { it.parents.lastOrNull()==key }.forEach { nested ->
                val visibleViewport=viewport(nested.bounds,listOf(container.bounds))
                val visit="${nested.key}:${nested.bounds.wire()}:${visibleViewport.wire()}:${fingerprint(state,nested.key)}"
                if(visited.add(visit))sweep(nested.key,depth+1)
            }
            state=snapshot()
            val currentContainer=state.containers.firstOrNull { it.key==key }
            if(currentContainer==null) { reason="container_disappeared";break }
            if(directionAbsentFresh(key,AccessibilityNodeInfo.ACTION_SCROLL_FORWARD,"sweep-end:$depth:$step")) { terminal=true;reason="no_forward_action";break }
            val current=fingerprint(state,key)
            repeated=if(current==previous)repeated+1 else 0;previous=current
            if(repeated>=2) { reason="no_observable_progress";break }
            val result=move(currentContainer.key,AccessibilityNodeInfo.ACTION_SCROLL_FORWARD,"sweep-forward:$depth:$step")
            if(!result.dispatched) {
                // Inspect the actual last viewport, including its inner scroll regions, next iteration.
                state=snapshot()
                state.containers.filter { it.parents.lastOrNull()==key }.forEach { nested ->
                    val visit="${nested.key}:${nested.bounds.wire()}:terminal:${fingerprint(state,nested.key)}"
                    if(visited.add(visit))sweep(nested.key,depth+1)
                }
                val remaining=state.containers.firstOrNull { it.key==key }
                terminal=!capped && remaining!=null && directionAbsentFresh(key,AccessibilityNodeInfo.ACTION_SCROLL_FORWARD,"sweep-rejected:$depth:$step")
                reason=if(terminal)"forward_rejected_at_terminal" else "forward_rejected_before_verified_end";break
            }
        }
        if(!terminal) { if(reason=="move_limit")capped=true;failures.add("Scroll coverage incomplete for $key: $reason") }
        if(terminal)saveBottom()
        scans.add(mapOf("container" to key,"depth" to depth,"terminal" to terminal,"reason" to reason,
            "diagnostic_child_path" to snapshot().containers.firstOrNull { it.key==key }?.path))
        if(!resetTop(key,"sweep-restore:$depth"))failures.add("Could not restore scroll start for $key")
    }

    fun run(): Map<String,Any?> {
        try {
            check(BuildConfig.REFERENCE_SCREENS) { "Reference fixtures are disabled" }
            output.mkdirs()
            var initial=snapshot()
            // Safe direct reachability probe when a footer node is already exposed but partly clipped.
            expectedFooters.filter { it !in footerSeen }.forEach { expected ->
                initial.targets.firstOrNull { matches(it.name,expected) }?.let { target ->
                    initial=showOnScreen(target,"required-control-probe").state
                }
            }
            initial.containers.filter { it.parents.isEmpty() }.forEach { container -> sweep(container.key,0) }
            snapshot()
            // A virtual node's AX bounds can be cropped without a represented clipping parent.
            // Resolve that case by explicitly showing the SAME source identity, then require a
            // settled full target with the SAME name and one unchanged dimension. A stable small
            // target, changed label, unavailable node or unsuccessful recovery remains a failure.
            observations.filterValues { it.interiorSmall.isNotEmpty() }.toList().forEach { (key,observation) ->
                val before=snapshot().targets.firstOrNull { it.key==key }
                val probe=before?.let { showOnScreen(it,"interior-size-probe") }
                val recovery=probe?.state
                val recovered=if(probe?.freshReachable==true && recovery!=null && recovery.settled)
                    recovery.targets.firstOrNull { it.key==key && it.full } else null
                if(recovered!=null)observation.interiorSmall.filter { small ->
                    val width=small[2]-small[0];val height=small[3]-small[1]
                    (width==recovered.bounds.width() && height<recovered.bounds.height()) ||
                        (height==recovered.bounds.height() && width<recovered.bounds.width())
                }.forEach { observation.recoveredFragments.add(it) }
            }
            // SHOW_ON_SCREEN probes may move a parent. Restore visible nested containers before
            // their outer parents, using identities rather than changing child indexes.
            snapshot().containers.sortedByDescending { it.parents.size }.forEach {
                if(!resetTop(it.key,"post-probe-restore"))failures.add("Could not restore scroll start after geometry probe for ${it.key}")
            }
        } catch(problem: Throwable) { failures.add("${problem.javaClass.simpleName}: ${problem.message}") }
        finally { identities.forEach { it.anchor.recycle() } }
        val genuinelySmall=observations.filterValues { it.interiorSmall.any { bounds -> bounds !in it.recoveredFragments } }
        val unresolved=observations.filterValues { !it.reachable48 }
        val unstableNames=observations.values.groupBy { it.identity }.filterValues { values -> values.map { it.name }.distinct().size>1 }
        if(genuinelySmall.isNotEmpty())failures.add("${genuinelySmall.size} named actions have an interior target below48dp")
        if(unresolved.isNotEmpty())failures.add("${unresolved.size} named controls never exposed a48dp AX-visible intersection")
        if(unstableNames.isNotEmpty())failures.add("${unstableNames.size} static controls changed accessible names while scrolling")
        val missingFooters=expectedFooters.filter { it !in footerSeen }
        if(unnamed.isNotEmpty())failures.add("${unnamed.size} visible enabled actions had no accessible name during scroll traversal")
        if(missingFooters.isNotEmpty())failures.add("Required controls never exposed a48dp AX-visible intersection: ${missingFooters.joinToString()}")
        if(capped)failures.add("Scroll traversal cap reached; coverage is incomplete")
        return mapOf("audit_schema" to 4,"status" to if(failures.isEmpty())"passed" else "failed","failures" to failures.distinct(),
            "target_metric" to "At least48dp in both dimensions of the AX bounding rectangle intersected with represented viewports; not a physical hit-test or proof of full text visibility.",
            "reference_only" to true,"actions_dispatched" to "scroll_and_show_on_screen_only","moves" to moves,"snapshots" to snapshots,
            "move_limit" to maxMoves,"container_move_limit" to maxContainerMoves,"capped" to capped,"containers" to scans,
            "expected_footers" to expectedFooters,"fully_observed_footers" to fullFooterSeen.toList(),"reachable_48dp_footers" to footerSeen.toList(),"missing_footers" to missingFooters,
            "targets" to observations.map { (key,value) -> mapOf("key" to key,"name" to value.name,"samples" to value.samples,
                "fully_observed" to value.full,"reachable_48dp" to value.reachable48,"partial_observed" to value.partial,"interior_small_bounds_px" to value.interiorSmall,
                "own_labels" to value.ownNames.filter { it.isNotBlank() },"descendant_derived_label" to ("" in value.ownNames),"geometry_samples" to value.geometry,
                "show_on_screen_recovered_fragment_bounds_px" to value.recoveredFragments) },
            "unresolved_clipped_targets" to unresolved.keys.toList(),"interior_small_targets" to genuinelySmall.keys.toList(),
            "unstable_names" to unstableNames.map { (key,values) -> mapOf("identity" to key,"names" to values.map { it.name }.distinct()) },
            "scroll_event_samples" to scrollEvents,
            "node_refresh_samples" to refreshSamples,"direction_absence_checks" to directionChecks,
            "show_on_screen_probes" to probeSamples,"fresh_check_limit" to maxFreshChecks,
            "ancestor_alignment_samples" to alignmentSamples,"ancestor_alignment_limit_per_region" to 1,"ancestor_parent_reset_limit_per_parent" to 1,
            "unnamed_visible_actions" to unnamed.values.toList(),
            "bottom_screenshots" to screenshots,"spoken_screen_reader_verified" to false)
    }
}
