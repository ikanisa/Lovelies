package com.lovelies.frontend.preview

import android.Manifest
import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.os.Bundle
import android.view.TextureView
import android.widget.FrameLayout
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Real Camera2/TextureView callbacks on a review-only Activity. No account or default vault is loaded. */
internal class CameraNativeJourney(private val instrumentation: Instrumentation,private val arguments: Bundle) {
    private val checks=mutableListOf<WireObject>()
    private fun pass(name: String,details: WireObject=emptyMap()) { checks.add(mapOf("name" to name,"status" to "passed","details" to details)) }
    fun run() {
        var activity: Activity?=null;val opened=mutableListOf<NativeCamera>();var failure: String?=null
        try {
            val context=instrumentation.targetContext
            val screen=instrumentation.startActivitySync(Intent(context,MainActivity::class.java).putExtra("review",true).putExtra("screen",6).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            activity=screen
            val granted=ContextCompat.checkSelfPermission(context,Manifest.permission.CAMERA)==PackageManager.PERMISSION_GRANTED
            arguments.getString("camera_permission_expected")?.let { check(it==if(granted)"granted" else "denied") }
            val rationale=ActivityCompat.shouldShowRequestPermissionRationale(screen,Manifest.permission.CAMERA)
            pass("Actual Android camera permission is re-read before camera initialization",mapOf("granted" to granted,"should_show_rationale" to rationale))
            val root=FrameLayout(screen)
            instrumentation.runOnMainSync { screen.setContentView(root) }
            val owner=NativeCaptureContext(1,SessionScope(1,UUID.randomUUID().toString()),"http://10.0.2.2:18887",CameraCaptureMode.FACE,
                "face_authentication",UUID.randomUUID().toString(),"declared-camera-probe",0,"front")
            fun producer(binding: NativeCaptureContext): Triple<NativeCamera,CountDownLatch,AtomicReference<String?>> {
                val ready=CountDownLatch(1);val error=AtomicReference<String?>(null);val action=AtomicReference<(() -> Unit)?>(null)
                val photo=CountDownLatch(1);val bytes=AtomicReference<ByteArray?>(null)
                val camera=NativeCamera(screen,true,binding,{it.takeIf { value->value==binding }},{action.set(it);if(it!=null)ready.countDown()},
                    {data,captured->check(captured==binding);bytes.set(data);photo.countDown()}, {error.set(it);ready.countDown();photo.countDown()})
                opened.add(camera)
                val texture=TextureView(screen)
                instrumentation.runOnMainSync { root.addView(texture,FrameLayout.LayoutParams(480,640));camera.attach(texture) }
                check(ready.await(20,TimeUnit.SECONDS)) { "Camera initialization callback timed out" }
                if(!granted) {
                    check(error.get()=="camera_permission_required" && action.get()==null)
                    pass("Denied camera never publishes a shutter or a JPEG",mapOf("error" to error.get()))
                    return Triple(camera,photo,error)
                }
                check(error.get()==null && action.get()!=null) { "Camera2 preview did not become ready: ${error.get()}" }
                pass("Real front Camera2 preview initializes with a current TextureView surface",mapOf("epoch" to binding.uiEpoch))
                val shutter=action.get()!!
                instrumentation.runOnMainSync { shutter() }
                check(photo.await(15,TimeUnit.SECONDS)) { "Actual Camera2 JPEG callback timed out" }
                check(error.get()==null)
                val actual=bytes.getAndSet(null) ?: error("No Camera2 JPEG arrived")
                try {
                    val preview=decodeCameraReview(actual)
                    check(preview.width in 1..1280 && preview.height in 1..1280)
                    pass("Real Camera2 JPEG is bounded and locally decoded for unsent review",mapOf("bytes" to actual.size,"sha256" to NativeProtocol.sha256(actual),
                        "preview_width" to preview.width,"preview_height" to preview.height,"face_quality_checked" to false,"upload_dispatched" to false))
                    if(preview.isMutable)preview.eraseColor(0)
                } finally { actual.fill(0) }
                instrumentation.runOnMainSync { camera.close();root.removeView(texture);shutter() }
                instrumentation.waitForIdleSync()
                check(action.get()==null && bytes.get()==null)
                pass("Closed camera and stale shutter cannot publish another frame",mapOf("epoch" to binding.uiEpoch))
                return Triple(camera,photo,error)
            }
            producer(owner)
            if(granted) {
                // New surface and lease model the platform recreation boundary without a fixture JPEG.
                producer(owner.copy(uiEpoch=2))
                pass("A fresh camera producer recovers after release and surface replacement")
            }
        } catch(problem: Throwable) { failure="${problem.javaClass.simpleName}: ${problem.message}" }
        finally {
            instrumentation.runOnMainSync { opened.forEach { it.close() };activity?.finish() }
        }
        val report=mapOf("status" to if(failure==null)"passed" else "failed","passed" to checks.size,"checks" to checks,"failure" to failure,
            "scenario" to "camera-native","actual_camera2_callbacks" to true,"camera_sensor_attestation" to false,"face_authenticated" to false,
            "backend_contacted" to false,"physical_device_qualification" to false,"activity" to "MainActivity review=true, isolated Camera2 surface")
        instrumentation.finish(if(failure==null)Activity.RESULT_OK else Activity.RESULT_CANCELED,Bundle().apply {
            putString("native_camera_journey",NativeProtocol.canonical(report));putString("stream","\nCamera2 recovery ${report["status"]}: ${checks.size} checks${failure?.let { "; $it" } ?: ""}\n")
        })
    }
}
