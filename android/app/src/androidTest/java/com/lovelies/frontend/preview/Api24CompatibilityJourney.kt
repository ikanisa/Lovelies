package com.lovelies.frontend.preview

import android.Manifest
import android.app.Activity
import android.app.Instrumentation
import android.app.NotificationManager
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.system.Os
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption
import java.util.UUID

/** Opt-in Debug runner for the root-owned compatibility qualification.
 * Exercises installed desugared app calls on an explicitly owned API24/25 AVD.
 * Scoped test vault/key writes; no global AES-key deletion. This draft does not
 * measure before/after default-vault or global AES state. No face input,
 * provider credential or remote push send.
 */
class Api24CompatibilityJourney : Instrumentation() {
    private lateinit var args: Bundle
    private val checks=mutableListOf<WireObject>()
    private val owned=mutableListOf<File>()
    private val notificationTags=mutableListOf<String>()
    private var activity: Activity?=null
    private var keyAlias: String?=null
    private var vault: SecureSession?=null
    private var pushPreferences: String?=null
    private var mediaUri: android.net.Uri?=null
    private var cleanupFailure=false
    private fun pass(name: String)=checks.add(mapOf("name" to name,"status" to "passed"))
    private fun directory(parent: File,name: String): File = File(parent,name).also {
        check(!it.exists() && it.mkdir()) { "Owned probe namespace already exists or cannot be created" }
        owned.add(it)
    }
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments);args=arguments ?: Bundle();start() }
    override fun onStart() {
        var failure: String?=null
        try {
            check(args.getString("owned_disposable_runtime")=="true") { "Root must select its new disposable AVD explicitly" }
            val expected=args.getString("expected_api")?.toIntOrNull()
            check(expected in setOf(24,25) && Build.VERSION.SDK_INT==expected) { "Actual API24 or25 runtime required" }
            check(BuildConfig.DEBUG && BuildConfig.REFERENCE_SCREENS) { "Only the explicit Debug test artifact is supported" }
            val context=targetContext
            check(context.applicationInfo.minSdkVersion==24)
            val run=UUID.randomUUID().toString()
            val cache=directory(context.cacheDir,"api24-compatibility-$run")
            val privateRoot=directory(context.noBackupFilesDir,"api24-compatibility-$run")
            val isolated=object: ContextWrapper(context) {
                override fun getCacheDir()=cache
                override fun getNoBackupFilesDir()=privateRoot
            }

            val icon=context.packageManager.getApplicationIcon(context.packageName)
            val rendered=Bitmap.createBitmap(108,108,Bitmap.Config.ARGB_8888)
            icon.setBounds(0,0,108,108);icon.draw(Canvas(rendered));rendered.recycle()
            pass("Installed pre26 launcher resource resolves and renders")
            activity=startActivitySync(Intent(context,MainActivity::class.java)
                .putExtra("review",true).putExtra("screen",1).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            waitForIdleSync()
            check(activity?.isFinishing==false)
            pass("Actual MainActivity starts and resumes with the installed pre26 reduced-motion path")

            val fixed=byteArrayOf(0,1,2,3,(-1).toByte(),(-2).toByte())
            val encoded=NativeProtocol.base64(fixed)
            check(encoded=="AAECA__-")
            check(java.util.Base64.getUrlDecoder().decode(encoded).contentEquals(fixed))
            check(NativeProtocol.expiry("2026-10-26T00:00:00Z",0)==1792972800000L)
            val account=UUID.randomUUID().toString()
            val refresh="lvs_"+NativeProtocol.base64(ByteArray(32) { it.toByte() })
            val journal=RefreshDeliveryJournal.create("http://127.0.0.1:18887",account,"anonymous",refresh,null,null)
            val restored=RefreshDeliveryJournal.restore(journal.wire(),"http://127.0.0.1:18887")
            restored.assertOwner("http://127.0.0.1:18887",account,"anonymous",null,null)
            restored.assertOriginal(refresh)
            var invalidDenied=false
            try { RefreshDeliveryJournal.restore(journal.wire()+mapOf("delivery_secret" to (journal.wire()["delivery_secret"].toString()+"=")),"http://127.0.0.1:18887") }
            catch(_: LiveFailure) { invalidDenied=true }
            check(invalidDenied)
            pass("Installed desugared Instant/Base64 preserve actual protocol and refresh-journal roundtrip/denial")

            vault=SecureSession(isolated,"http://127.0.0.1:18887")
            val alias=vault!!.enrollmentAlias(account);keyAlias=alias
            val publicKey=vault!!.createDevice(alias)
            val envelope=mapOf("protocol" to "owned-api24-probe","account_id" to account)
            val signature=vault!!.sign(alias,envelope)
            check(java.util.Base64.getUrlDecoder().decode(signature).size==64)
            check(vault!!.existingDevice(alias)==publicKey)
            vault!!.save(mapOf("owned_probe" to run))
            check(SecureSession(isolated,"http://127.0.0.1:18887").load()==mapOf("owned_probe" to run))
            pass("Actual AndroidKeyStore P256 signing and AES/GCM atomic vault rehydration work")

            val jpeg=ByteArrayOutputStream().use { stream ->
                val bitmap=Bitmap.createBitmap(2,2,Bitmap.Config.ARGB_8888)
                try { check(bitmap.compress(Bitmap.CompressFormat.JPEG,90,stream));stream.toByteArray() }
                finally { bitmap.recycle() }
            }
            try {
                val now=System.currentTimeMillis()
                val name=UUID.randomUUID().toString()+".jpg"
                val source=PrivateTemporaryMedia.write(cache,PrivateTemporaryMedia.Kind.CAMERA,name,jpeg,now)
                owned.add(File(cache,"camera"));owned.add(source)
                check(source.readBytes().contentEquals(jpeg))
                var replaceDenied=false
                try { PrivateTemporaryMedia.write(cache,PrivateTemporaryMedia.Kind.CAMERA,name,byteArrayOf(9),now) }
                catch(_: Exception) { replaceDenied=true }
                check(replaceDenied && source.readBytes().contentEquals(jpeg))
                val unknown=File(cache,"camera/unknown-preserve.bin").also { check(it.createNewFile());it.writeBytes(byteArrayOf(7));owned.add(it) }
                val foreign=File(cache,"foreign-preserve.bin").also { check(it.createNewFile());it.writeBytes(byteArrayOf(8));owned.add(it) }
                val link=File(cache,"camera/${UUID.randomUUID()}.jpg");owned.add(link)
                Os.symlink(foreign.absolutePath,link.absolutePath)
                val result=PrivateTemporaryMedia.sweep(cache,PrivateTemporaryMedia.Kind.CAMERA,now+PrivateTemporaryMedia.CAMERA_AGE_MS)
                check(!result.failed && result.removed==setOf(name) && !source.exists())
                check(Files.isSymbolicLink(link.toPath()) && foreign.readBytes().contentEquals(byteArrayOf(8)) && unknown.readBytes().contentEquals(byteArrayOf(7)))
                pass("Installed desugared private NIO preserves create-new/NOFOLLOW_LINKS, timestamps, expiry and unknown/symlink targets")

                // Production FileProvider resolves targetContext.cacheDir. Refuse
                // every pre-existing path, including a dangling symbolic link.
                // Claim cleanup ownership only after create-new has succeeded.
                val sharing=File(context.cacheDir,"shared-originals")
                check(!Files.exists(sharing.toPath(),LinkOption.NOFOLLOW_LINKS)) { "Shared-media path already exists; preserve it" }
                Files.createDirectory(sharing.toPath())
                owned.add(sharing)
                val asset=UUID.randomUUID().toString()
                val sent=OriginalMedia.share(context,asset,jpeg) {}
                val uri=sent.getParcelableExtra<android.net.Uri>(Intent.EXTRA_STREAM) ?: error("Private share URI missing")
                val created=sharing.listFiles()?.singleOrNull { it.name.startsWith("lovelies-$asset-") } ?: error("Owned share artifact missing")
                owned.add(created)
                check(context.contentResolver.openInputStream(uri)?.use { it.readBytes() }?.contentEquals(jpeg)==true)
                check(sent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION!=0 && sent.clipData?.itemCount==1)
                pass("Actual production private share/FileProvider returns exact bytes with a temporary read grant")

                val writeExpected=args.getString("media_write_permission_expected") ?: "denied"
                check(writeExpected in setOf("denied","granted"))
                val permitted=context.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)==android.content.pm.PackageManager.PERMISSION_GRANTED
                check(permitted==(writeExpected=="granted")) { "Root must establish and record the exact legacy media permission state" }
                if(permitted) {
                    mediaUri=OriginalMedia.save(context,UUID.randomUUID().toString(),jpeg) {}
                    // API24/25 can grant WRITE without READ. Inspect only this
                    // new synthetic URI through the instrumentation shell; the
                    // application receives no broader library-read permission.
                    val returned=mediaUri!!.toString()
                    check(Regex("^content://media/external/images/media/[1-9][0-9]*$").matches(returned))
                    val descriptor=uiAutomation.executeShellCommand("content read --uri $returned")
                    val saved=ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.readBytes() }
                    try { check(saved.contentEquals(jpeg)) } finally { saved.fill(0) }
                    pass("Granted legacy MediaStore save preserves exact bytes by scoped OS-provider inspection")
                } else {
                    var denied=false
                    try { OriginalMedia.save(context,UUID.randomUUID().toString(),jpeg) {} }
                    catch(problem: LiveFailure) { denied=problem.code=="save_permission_required" }
                    check(denied)
                    pass("Denied legacy MediaStore save fails before creating media")
                }
            } finally { jpeg.fill(0) }

            // Standalone local service object: attach only this test context,
            // without starting Firebase, sending a message or changing opt-in.
            val preference="api24-compatibility-$run-push";pushPreferences=preference
            val notificationContext=object: ContextWrapper(context) {
                override fun getSharedPreferences(name: String,mode: Int)=super.getSharedPreferences(preference,mode)
            }
            PushConfiguration.setOptedIn(notificationContext,true)
            val service=LoveliesMessagingService()
            ContextWrapper::class.java.getDeclaredMethod("attachBaseContext",Context::class.java).apply { isAccessible=true }.invoke(service,notificationContext)
            val id=UUID.randomUUID().toString();val tag="lovelies-notification:$id"
            val manager=context.getSystemService(NotificationManager::class.java)
            check(manager.activeNotifications.none { it.tag==tag && it.id==0 }) { "Notification identity already exists; preserve it" }
            val tapIntent=Intent(context,MainActivity::class.java).setAction("${context.packageName}.notification.$id")
            check(android.app.PendingIntent.getActivity(context,0,tapIntent,android.app.PendingIntent.FLAG_NO_CREATE or android.app.PendingIntent.FLAG_IMMUTABLE)==null) { "Notification tap already exists; preserve it" }
            notificationTags.add(tag)
            service.onMessageReceived(RemoteMessage.Builder("owned-local-compatibility-probe").addData("id",id).build())
            val postedDeadline=android.os.SystemClock.uptimeMillis()+3000L
            var shown=manager.activeNotifications.singleOrNull { it.tag==tag && it.id==0 }
            while(shown==null && android.os.SystemClock.uptimeMillis()<postedDeadline) {
                android.os.SystemClock.sleep(25L)
                shown=manager.activeNotifications.singleOrNull { it.tag==tag && it.id==0 }
            }
            check(shown!=null) { "Owned local notification was not posted within the bounded observation window" }
            check(shown.notification.visibility==android.app.Notification.VISIBILITY_PRIVATE)
            check(shown.notification.contentIntent.creatorPackage==context.packageName)
            pass("Pre26 production messaging path posts a private local notification without NotificationChannel")
        } catch(problem: Throwable) { failure="${problem.javaClass.simpleName}: ${problem.message}" }
        finally {
            runCatching { activity?.let { runOnMainSync { it.finish() } } }.onFailure { cleanupFailure=true }
            runCatching {
                val manager=targetContext.getSystemService(NotificationManager::class.java)
                notificationTags.forEach { tag ->
                    manager.cancel(tag,0)
                    val id=tag.removePrefix("lovelies-notification:")
                    val tapIntent=Intent(targetContext,MainActivity::class.java).setAction("${targetContext.packageName}.notification.$id")
                    android.app.PendingIntent.getActivity(targetContext,0,tapIntent,android.app.PendingIntent.FLAG_NO_CREATE or android.app.PendingIntent.FLAG_IMMUTABLE)?.cancel()
                }
                val absentDeadline=android.os.SystemClock.uptimeMillis()+3000L
                while(manager.activeNotifications.any { it.id==0 && it.tag in notificationTags } && android.os.SystemClock.uptimeMillis()<absentDeadline)
                    android.os.SystemClock.sleep(25L)
                check(manager.activeNotifications.none { it.id==0 && it.tag in notificationTags })
            }.onFailure { cleanupFailure=true }
            mediaUri?.let { uri -> runCatching { check(targetContext.contentResolver.delete(uri,null,null)==1) }.onFailure { cleanupFailure=true } }
            pushPreferences?.let { name -> runCatching { check(targetContext.deleteSharedPreferences(name)) }.onFailure { cleanupFailure=true } }
            runCatching { vault?.let { it.deleteDevice(keyAlias);it.clear() } }.onFailure { cleanupFailure=true }
            // Explicit owned paths only, never recursive traversal through the
            // deliberate symlink or removal of the shared global AES key.
            owned.asReversed().forEach { file -> runCatching { if(file.exists() || Files.isSymbolicLink(file.toPath()))check(file.delete()) }.onFailure { cleanupFailure=true } }
        }
        if(cleanupFailure && failure==null)failure="Owned cleanup unconfirmed; retain and inspect the AVD"
        val report=mapOf("status" to if(failure==null)"passed" else "failed","api" to Build.VERSION.SDK_INT,
            "checks" to checks,"failure" to failure,"cleanup_unconfirmed" to cleanupFailure,
            "provider_request_sent" to false,"optical_capture_or_representative_recognition" to false,
            "actual_refresh_http_or_face_recovery" to false,"hosted_or_store_acceptance" to false)
        finish(if(failure==null)Activity.RESULT_OK else Activity.RESULT_CANCELED,Bundle().apply {
            putString("api24_compatibility",NativeProtocol.canonical(report));putString("stream","\nAPI24/25 compatibility ${report["status"]}: ${checks.size} checks\n")
        })
    }
}
