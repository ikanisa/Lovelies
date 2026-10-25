package com.lovelies.frontend.preview

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.graphics.Rect
import android.os.Bundle
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.io.File
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import org.json.JSONObject

/** Actual connected age/guardian UI and production repository, against an owned
 * loopback fixture. No registered-face, guardian review, camera or media success
 * is fabricated. An existing endpoint vault is never replaced. */
class ConnectedAudienceJourney : Instrumentation() {
    private var arguments=Bundle()
    private val checks=mutableListOf<WireObject>()
    private val captures=mutableListOf<String>()
    private var output: File?=null
    private fun pass(name: String) {
        checks.add(mapOf("name" to name,"status" to "passed"))
        sendStatus(1,Bundle().apply { putString("stream","PASS $name\n") })
    }
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments);this.arguments=arguments ?: Bundle();start() }
    private fun label(id: Int)=targetContext.getString(id)
    private fun name(node: AccessibilityNodeInfo): String {
        val own=listOfNotNull(node.text?.toString(),node.contentDescription?.toString()).filter { it.isNotBlank() }.distinct()
        if(own.isNotEmpty())return own.joinToString(" · ")
        val children=mutableListOf<String>()
        for(i in 0 until node.childCount)node.getChild(i)?.let { child -> try { name(child).takeIf { it.isNotBlank() }?.let(children::add) } finally { child.recycle() } }
        return children.distinct().joinToString(" · ")
    }
    private fun nodes(predicate: (AccessibilityNodeInfo)->Boolean): List<AccessibilityNodeInfo> {
        val result=mutableListOf<AccessibilityNodeInfo>()
        val root=uiAutomation.rootInActiveWindow ?: return result
        fun visit(node: AccessibilityNodeInfo) {
            if(node.packageName?.toString()==targetContext.packageName && predicate(node))result.add(AccessibilityNodeInfo.obtain(node))
            for(i in 0 until node.childCount)node.getChild(i)?.let { child -> try { visit(child) } finally { child.recycle() } }
        }
        try { visit(root) } finally { root.recycle() }
        return result
    }
    private fun awaitVisible(text: String) {
        val until=SystemClock.uptimeMillis()+15_000
        while(SystemClock.uptimeMillis()<until) {
            val found=nodes { name(it)==text }
            val present=found.any { it.isVisibleToUser }
            if(!present)found.firstOrNull()?.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id)
            found.forEach { it.recycle() }
            if(present)return
            SystemClock.sleep(100)
        }
        error("Expected connected UI label is absent: $text")
    }
    private fun click(text: String) {
        val density=targetContext.resources.displayMetrics.density
        repeat(16) {
            val candidates=nodes { it.isVisibleToUser && it.isClickable && it.isEnabled && name(it)==text }
            try {
                check(candidates.size<=1) { "Ambiguous connected action: $text" }
                val target=candidates.singleOrNull()
                if(target!=null && target.refresh()) {
                    val bounds=Rect();target.getBoundsInScreen(bounds)
                    if(target.isVisibleToUser && target.isEnabled && target.isClickable && name(target)==text &&
                        bounds.width()+1>=48*density && bounds.height()+1>=48*density) {
                        check(target.performAction(AccessibilityNodeInfo.ACTION_CLICK)) { "Connected action was rejected: $text" }
                        waitForIdleSync();return
                    }
                    target.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id)
                }
            } finally { candidates.forEach { it.recycle() } }
            val scrollers=nodes { it.isVisibleToUser && it.isScrollable && it.actionList.any { action -> action.id==AccessibilityNodeInfo.ACTION_SCROLL_FORWARD } }
            try { scrollers.firstOrNull()?.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD) } finally { scrollers.forEach { it.recycle() } }
            SystemClock.sleep(120)
        }
        error("Connected action could not be reached at48dp: $text")
    }
    private fun capture(name: String) {
        val bitmap=checkNotNull(uiAutomation.takeScreenshot()) { "Connected capture unavailable" }
        try { File(checkNotNull(output),"$name.png").outputStream().use { check(bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)) } }
        finally { bitmap.recycle() }
        captures.add(name)
    }
    private suspend fun denied(repository: CloudflareRepository,codes: Set<String>,path: String) {
        try { repository.get(path);error("Protected path unexpectedly succeeded") }
        catch(problem: LiveFailure) { check(problem.code in codes) { "Unexpected protected-path denial ${problem.code}" } }
    }
    override fun onStart() {
        var activity: Activity?=null
        var repository: CloudflareRepository?=null
        var ownedAccount: String?=null
        var success=false
        var failure: String?=null
        var cleanupConfirmed=false
        try {
            check(BuildConfig.DEBUG && BuildConfig.REFERENCE_SCREENS)
            val base=NativeProtocol.baseUrl(BuildConfig.API_BASE_URL,true)
            val uri=URI(base)
            check(uri.scheme=="http" && uri.host in setOf("10.0.2.2","127.0.0.1","localhost") && uri.port in 1024..65535)
            check(arguments.getString("owned_local_fixture")=="true") { "Explicit owned-fixture assertion required" }
            val vaultFile=File(targetContext.noBackupFilesDir,"lovelies-session-v2-${NativeProtocol.sha256(base.toByteArray()).take(16)}.bin")
            check(listOf(File(vaultFile.path+".bak"),File(vaultFile.path+".new")).none { it.exists() }) { "Unresolved endpoint vault files preserved" }
            if(vaultFile.exists()) {
                val ownedEmptyHash=arguments.getString("owned_empty_vault_sha256")
                check(ownedEmptyHash?.matches(Regex("[a-f0-9]{64}"))==true && vaultFile.isFile &&
                    NativeProtocol.sha256(vaultFile.readBytes())==ownedEmptyHash && SecureSession(targetContext,base).load().isEmpty()) {
                    "Existing endpoint vault preserved; only an explicitly owned, exact-hash empty fixture journal can be reused"
                }
            }
            val variant=arguments.getString("variant") ?: error("Unique output variant required")
            check(variant.matches(Regex("[a-z0-9-]{1,80}")))
            output=File(targetContext.getExternalFilesDir(null),"connected-audience/$variant")
            check(checkNotNull(output).mkdirs()) { "Existing output must not be replaced" }
            val repo=BackgroundTransfers.repository(targetContext);repository=repo
            runBlocking { withTimeout(30_000) {
                val connection=URL("$base/health").openConnection() as HttpURLConnection
                val health=try {
                    connection.instanceFollowRedirects=false;connection.connectTimeout=10_000;connection.readTimeout=10_000
                    check(connection.responseCode==200)
                    val bytes=connection.inputStream.use { it.readNBytes(16_385) };check(bytes.size<=16_384)
                    jsonMap(JSONObject(bytes.toString(Charsets.UTF_8)))
                } finally { connection.disconnect() }
                check(health["service"]=="lovelies-supabase-api" && health["database"]=="supabase_postgresql" && health["database_ready"]==true)
                val me=repo.bootstrap();val actor=repo.credentials ?: error("Anonymous actor missing")
                check(actor.method=="anonymous" && me["authenticated"]==false)
                ownedAccount=actor.account
                val audience=repo.audienceStatus()
                check(audience.account==actor.account && audience.band=="unknown" && audience.version==0L && audience.capabilities.values.none { it })
            } }
            pass("Absent or exact-owned-empty endpoint vault and real Supabase anonymous unknown-age actor verified")
            activity=startActivitySync(Intent(targetContext,MainActivity::class.java).putExtra("review",false).putExtra("screen",5).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            waitForIdleSync();awaitVisible(label(R.string.audience_choose_age));capture("01-unknown")
            click(label(R.string.audience_13_17));click(label(R.string.audience_save_age))
            awaitVisible(label(R.string.audience_guardian_pending));capture("02-teen-gated")
            runBlocking { withTimeout(15_000) {
                val audience=repo.audienceStatus()
                check(audience.account==ownedAccount && audience.band=="13_17" && audience.request==null && audience.capabilities.values.none { it })
                check(repo.credentials?.account==ownedAccount && repo.credentials?.method=="anonymous")
                denied(repo,setOf("registered_face_required"),"/me/gallery")
            } }
            pass("Actual teen selection saves the same anonymous account and grants no purpose or gallery access")
            click(label(R.string.audience_create_request))
            val until=SystemClock.uptimeMillis()+15_000
            var request: GuardianRequest?=null
            while(SystemClock.uptimeMillis()<until && request==null) {
                request=runBlocking { withTimeout(10_000) { repo.audienceStatus().request } }
                if(request==null)SystemClock.sleep(100)
            }
            val pending=checkNotNull(request)
            check(pending.child==ownedAccount && pending.state=="pending" && pending.purposes.values.none { it })
            awaitVisible(label(R.string.audience_request_heading))
            capture("03-pending-request")
            pass("Actual guardian-request action produces pending independent review without purpose approval")
            click(label(R.string.audience_withdraw))
            awaitVisible(label(R.string.audience_withdraw_detail));capture("04-withdraw-confirmation")
            click(label(R.string.audience_withdraw))
            awaitVisible(label(R.string.audience_create_request))
            runBlocking { withTimeout(15_000) {
                val audience=repo.audienceStatus();val withdrawn=checkNotNull(audience.request)
                check(withdrawn.id==pending.id && withdrawn.state=="withdrawn" && withdrawn.revision>pending.revision)
                check(audience.capabilities.values.none { it } && repo.credentials?.account==ownedAccount)
                denied(repo,setOf("registered_face_required"),"/me/gallery")
            } }
            capture("05-withdrawn-gated")
            pass("Confirmed native withdrawal resolves the original request and keeps every purpose/gallery fenced")
            click(label(R.string.audience_privacy_deletion))
            awaitVisible(label(R.string.copy_guest_account_deletion_16fa4c92));capture("06-guest-privacy")
            pass("Gated anonymous user can reach the real privacy/deletion screen without face setup")
            success=true
        } catch(problem: Throwable) { failure=problem.javaClass.simpleName+": "+problem.message }
        finally {
            activity?.let { held -> runCatching { runOnMainSync { held.finish() };waitForIdleSync() } }
            val repo=repository
            if(ownedAccount!=null && repo!=null) {
                try { runBlocking { withTimeout(15_000) {
                    check(repo.credentials?.account==ownedAccount && repo.credentials?.method=="anonymous")
                    repo.logout();check(repo.credentials==null);cleanupConfirmed=true
                } } } catch(problem: Throwable) { success=false;failure=(failure?.plus("; ") ?: "")+"Owned logout unresolved: "+problem.javaClass.simpleName }
            }
            val report=mapOf("status" to if(success)"passed" else "failed","checks" to checks,"captures" to captures,"owned_session_logout_confirmed" to cleanupConfirmed,
                "unknown_endpoint_vault_overwritten" to false,"app_reset_or_uninstall" to false,"spoken_screen_reader_verified" to false,
                "scope" to "Connected production UI/Keystore/repository and actual loopback Supabase handler/PostgreSQL. No registered guardian, independent human review, face/camera/media, hosted or store acceptance.","failure" to failure)
            output?.takeIf { it.isDirectory }?.let { File(it,"report.json").writeText(NativeProtocol.canonical(report)) }
            finish(if(success)Activity.RESULT_OK else Activity.RESULT_CANCELED,Bundle().apply { putString("connected_audience_journey",NativeProtocol.canonical(report)) })
        }
    }
}
