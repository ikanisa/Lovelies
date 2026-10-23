package com.lovelies.frontend.preview

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.graphics.Matrix
import android.graphics.SurfaceTexture
import android.hardware.camera2.*
import android.media.ImageReader
import android.net.Uri
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.provider.Settings
import android.view.Surface
import android.view.TextureView
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** Bounded decoding and EXIF orientation are transport preparation, never face-quality proof. */
internal fun decodeCameraReview(bytes: ByteArray): android.graphics.Bitmap {
    if(bytes.size>CameraReviewBuffer.MAX_BYTES)throw LiveFailure("capture_too_large")
    if(bytes.size<4 || bytes[0]!=0xff.toByte() || bytes[1]!=0xd8.toByte())throw LiveFailure("camera_image_invalid")
    val bounds=android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds=true }
    android.graphics.BitmapFactory.decodeByteArray(bytes,0,bytes.size,bounds)
    if(bounds.outWidth<=0 || bounds.outHeight<=0 || bounds.outWidth.toLong()*bounds.outHeight>16000000L)throw LiveFailure("camera_image_invalid")
    var sample=1;while(maxOf(bounds.outWidth,bounds.outHeight)/sample>1280)sample*=2
    val image=android.graphics.BitmapFactory.decodeByteArray(bytes,0,bytes.size,
        android.graphics.BitmapFactory.Options().apply { inSampleSize=sample;inMutable=true }) ?: throw LiveFailure("camera_image_invalid")
    val orientation=runCatching { android.media.ExifInterface(java.io.ByteArrayInputStream(bytes)).getAttributeInt(
        android.media.ExifInterface.TAG_ORIENTATION,android.media.ExifInterface.ORIENTATION_NORMAL) }.getOrDefault(1)
    val matrix=Matrix().apply { when(orientation) {
        2->postScale(-1f,1f);3->postRotate(180f);4->postScale(1f,-1f)
        5->{postRotate(90f);postScale(-1f,1f)};6->postRotate(90f)
        7->{postRotate(270f);postScale(-1f,1f)};8->postRotate(270f)
    } }
    if(matrix.isIdentity)return image
    val rotated=android.graphics.Bitmap.createBitmap(image,0,0,image.width,image.height,matrix,true)
    if(rotated!==image && image.isMutable)image.eraseColor(0)
    return rotated
}

internal fun Context.cameraActivity(): Activity? = when(this) {
    is Activity -> this
    is ContextWrapper -> baseContext.takeIf { it!==this }?.cameraActivity()
    else -> null
}

/** Camera2 owns this surface generation. Failed producers close before any explicit retry. */
internal class NativeCamera(
    private val context: Context,private val front: Boolean,
    private val captureContext: NativeCaptureContext,private val onShutter: (NativeCaptureContext)->NativeCaptureContext?,
    private val onReady: ((()->Unit)?)->Unit,private val onPhoto: (ByteArray,NativeCaptureContext)->Unit,
    private val onError: (String)->Unit,private val onStatus: (CameraStatus)->Unit={}
) : TextureView.SurfaceTextureListener {
    private val thread=HandlerThread("LoveliesCamera").apply { start() }
    private val handler=Handler(thread.looper)
    private val main=Handler(Looper.getMainLooper())
    private val closed=AtomicBoolean(false)
    private val disposed=AtomicBoolean(false)
    private val producer=CameraProducer(captureContext)
    private val pendingCapture=AtomicReference<NativeCaptureContext?>(null)
    private var generation=0L
    private var camera: CameraDevice?=null
    private var session: CameraCaptureSession?=null
    private var reader: ImageReader?=null
    private var view: TextureView?=null
    private var preview: Surface?=null
    private var sensor=0
    private var bufferSize=android.util.Size(640,480)
    private var displayRotation=-1
    private var opening=false
    private val initTimeout=Runnable { if(!closed.get())fail("camera_initialization_timeout") }
    private val captureTimeout=Runnable { if(pendingCapture.get()!=null)fail("capture_timeout") }
    private fun status(value: CameraStatus) { main.post { if(!disposed.get())onStatus(value) } }
    private fun releaseResources() {
        runCatching { session?.stopRepeating() };runCatching { session?.abortCaptures() }
        runCatching { session?.close() };runCatching { camera?.close() };runCatching { reader?.close() };runCatching { preview?.release() }
        session=null;camera=null;reader=null;preview=null
    }
    private fun fail(code: String) {
        if(!closed.compareAndSet(false,true))return
        producer.fail(generation);pendingCapture.set(null)
        main.removeCallbacks(initTimeout);main.removeCallbacks(captureTimeout)
        handler.post { releaseResources() }
        main.post { if(!disposed.get()) { onReady(null);onStatus(CameraStatus(CameraPhase.FAILED,code));onError(code) } }
    }
    fun attach(texture: TextureView) {
        view=texture;texture.surfaceTextureListener=this
        generation=producer.initialize();status(CameraStatus(CameraPhase.INITIALIZING));main.postDelayed(initTimeout,8000)
        if(texture.isAvailable)open(texture.width,texture.height)
    }
    private fun rotationDegrees()=when(view?.display?.rotation) {
        Surface.ROTATION_90->90;Surface.ROTATION_180->180;Surface.ROTATION_270->270;else->0
    }
    private fun transform(width: Int,height: Int) {
        if(width<=0 || height<=0)return
        val rotation=rotationDegrees();displayRotation=rotation
        val relative=cameraJpegOrientation(sensor,rotation,front)
        val rotated=relative%180!=0
        val sourceWidth=if(rotated)bufferSize.height.toFloat() else bufferSize.width.toFloat()
        val sourceHeight=if(rotated)bufferSize.width.toFloat() else bufferSize.height.toFloat()
        val scale=maxOf(width/sourceWidth,height/sourceHeight)
        // TextureView's default fill is counteracted before applying one uniform crop scale.
        val matrix=Matrix().apply {
            postTranslate(-width/2f,-height/2f)
            postScale(bufferSize.width.toFloat()/width,bufferSize.height.toFloat()/height)
            postRotate(relative.toFloat())
            postScale(scale*(if(front)-1f else 1f),scale)
            postTranslate(width/2f,height/2f)
        }
        view?.setTransform(matrix)
    }
    private fun open(width: Int,height: Int) {
        if(closed.get() || opening || width<=0 || height<=0)return
        opening=true
        try {
            if(ContextCompat.checkSelfPermission(context,Manifest.permission.CAMERA)!=PackageManager.PERMISSION_GRANTED)throw LiveFailure("camera_permission_required")
            val manager=context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
            val cameraId=manager.cameraIdList.firstOrNull { manager.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING)==
                if(front)CameraCharacteristics.LENS_FACING_FRONT else CameraCharacteristics.LENS_FACING_BACK } ?: throw LiveFailure("camera_unavailable")
            val characteristics=manager.getCameraCharacteristics(cameraId)
            val map=characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: throw LiveFailure("camera_unavailable")
            val sizes=map.getOutputSizes(ImageFormat.JPEG)?.toList() ?: emptyList()
            val size=sizes.filter { it.width<=1280 && it.height<=1280 }.maxByOrNull { it.width.toLong()*it.height }
                ?: sizes.minByOrNull { it.width.toLong()*it.height } ?: throw LiveFailure("camera_unavailable")
            bufferSize=map.getOutputSizes(SurfaceTexture::class.java)?.filter { it.width<=1920 && it.height<=1080 }
                ?.minByOrNull { kotlin.math.abs(it.width.toFloat()/it.height-size.width.toFloat()/size.height) }
                ?: throw LiveFailure("camera_unavailable")
            val texture=view?.surfaceTexture ?: throw LiveFailure("camera_surface_replaced")
            texture.setDefaultBufferSize(bufferSize.width,bufferSize.height);preview=Surface(texture)
            sensor=characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0;transform(width,height)
            reader=ImageReader.newInstance(size.width,size.height,ImageFormat.JPEG,2).apply {
                setOnImageAvailableListener({ imageReader ->
                    val image=runCatching { imageReader.acquireNextImage() }.getOrNull() ?: return@setOnImageAvailableListener
                    try {
                        val bytes=ByteArray(image.planes[0].buffer.remaining());image.planes[0].buffer.get(bytes)
                        val owner=pendingCapture.getAndSet(null)
                        main.removeCallbacks(captureTimeout)
                        if(closed.get() || owner==null || !producer.frame(generation,bytes))bytes.fill(0)
                        else main.post {
                            if(closed.get() || disposed.get())bytes.fill(0)
                            else { onReady(null);onStatus(CameraStatus(CameraPhase.REVIEW));onPhoto(bytes,owner) }
                        }
                    } finally { image.close() }
                },handler)
            }
            manager.openCamera(cameraId,object: CameraDevice.StateCallback() {
                override fun onOpened(device: CameraDevice) {
                    if(closed.get() || !producer.isCurrent(generation)) { device.close();return };camera=device
                    try {
                        @Suppress("DEPRECATION")
                        device.createCaptureSession(listOf(preview!!,reader!!.surface),object: CameraCaptureSession.StateCallback() {
                            override fun onConfigured(value: CameraCaptureSession) {
                                if(closed.get() || !producer.ready(generation)) { value.close();return };session=value
                                try {
                                    val request=device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                                        addTarget(preview!!);set(CaptureRequest.CONTROL_AF_MODE,CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
                                    }.build()
                                    value.setRepeatingRequest(request,null,handler);main.removeCallbacks(initTimeout)
                                    main.post { if(!closed.get() && !disposed.get()) { onStatus(CameraStatus(CameraPhase.READY));onReady { capture() } } }
                                } catch(problem: Exception) { fail("camera_unavailable") }
                            }
                            override fun onConfigureFailed(value: CameraCaptureSession) { value.close();fail("camera_unavailable") }
                        },handler)
                    } catch(problem: Exception) { fail("camera_unavailable") }
                }
                override fun onDisconnected(device: CameraDevice) { device.close();fail("camera_disconnected") }
                override fun onError(device: CameraDevice,code: Int) { device.close();fail("camera_unavailable") }
            },handler)
        } catch(problem: SecurityException) { fail("camera_permission_required") }
        catch(problem: Exception) { fail((problem as? LiveFailure)?.code ?: "camera_unavailable") }
    }
    private fun capture() {
        if(closed.get() || disposed.get())return
        if(ContextCompat.checkSelfPermission(context,Manifest.permission.CAMERA)!=PackageManager.PERMISSION_GRANTED) { fail("camera_permission_required");return }
        val owner=onShutter(captureContext) ?: return
        if(!producer.shutter(generation,owner))return
        pendingCapture.set(owner);onReady(null);onStatus(CameraStatus(CameraPhase.CAPTURING))
        val orientation=cameraJpegOrientation(sensor,rotationDegrees(),front)
        main.postDelayed(captureTimeout,7000)
        handler.post {
            if(closed.get())return@post
            try {
                val device=camera ?: throw LiveFailure("camera_unavailable")
                val request=device.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE).apply {
                    addTarget(reader!!.surface);set(CaptureRequest.JPEG_ORIENTATION,orientation);set(CaptureRequest.JPEG_QUALITY,90.toByte())
                    set(CaptureRequest.CONTROL_AF_MODE,CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
                }.build()
                session!!.capture(request,object: CameraCaptureSession.CaptureCallback() {
                    override fun onCaptureFailed(value: CameraCaptureSession,request: CaptureRequest,failure: CaptureFailure) {
                        if(pendingCapture.get()===owner)fail("capture_failed")
                    }
                },handler)
            } catch(problem: Exception) { fail("capture_failed") }
        }
    }
    fun close() {
        if(!disposed.compareAndSet(false,true))return
        closed.set(true);producer.interrupt();pendingCapture.set(null)
        main.removeCallbacks(initTimeout);main.removeCallbacks(captureTimeout);onReady(null)
        view?.surfaceTextureListener=null;view=null
        handler.post { releaseResources();thread.quitSafely() }
    }
    override fun onSurfaceTextureAvailable(texture: SurfaceTexture,width: Int,height: Int)=open(width,height)
    override fun onSurfaceTextureSizeChanged(texture: SurfaceTexture,width: Int,height: Int) { transform(width,height) }
    override fun onSurfaceTextureDestroyed(texture: SurfaceTexture): Boolean { fail("camera_surface_replaced");return true }
    override fun onSurfaceTextureUpdated(texture: SurfaceTexture) {
        if(!closed.get() && displayRotation!=rotationDegrees())view?.let { transform(it.width,it.height) }
    }
}

@Composable
fun NativeCameraPane(modifier: Modifier,front: Boolean,active: Boolean,captureContext: NativeCaptureContext,
    onShutter: (NativeCaptureContext)->NativeCaptureContext?,onReady: (NativeCaptureContext, (()->Unit)?)->Unit,
    onPhoto: (ByteArray,NativeCaptureContext)->Unit,onError: (NativeCaptureContext,String)->Unit,
    onStatus: (NativeCaptureContext,CameraStatus)->Unit) {
    val context=LocalContext.current
    val preferences=remember { context.getSharedPreferences("lovelies_camera_permission",Context.MODE_PRIVATE) }
    fun currentPermission(): CameraPermissionState {
        val granted=ContextCompat.checkSelfPermission(context,Manifest.permission.CAMERA)==PackageManager.PERMISSION_GRANTED
        if(granted)preferences.edit().putBoolean("granted_before",true).apply()
        return cameraPermission(granted,preferences.getBoolean("requested",false),context.cameraActivity()?.let {
            ActivityCompat.shouldShowRequestPermissionRationale(it,Manifest.permission.CAMERA)
        } ?: false,preferences.getBoolean("granted_before",false))
    }
    var permission by remember { mutableStateOf(currentPermission()) }
    var attempt by remember(captureContext) { mutableIntStateOf(0) }
    var status by remember(captureContext) { mutableStateOf(CameraStatus(CameraPhase.IDLE)) }
    val launcher=rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { permission=currentPermission();attempt++ }
    val settings=rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { permission=currentPermission();attempt++ }
    val ready by rememberUpdatedState(onReady);val photo by rememberUpdatedState(onPhoto);val error by rememberUpdatedState(onError)
    val report by rememberUpdatedState(onStatus);val shutter by rememberUpdatedState(onShutter)
    LaunchedEffect(active,captureContext) { permission=currentPermission();if(!active) { ready(captureContext,null);report(captureContext,CameraStatus(CameraPhase.INTERRUPTED)) } }
    if(permission!=CameraPermissionState.GRANTED)Box(modifier,contentAlignment=Alignment.Center) {
        Column(horizontalAlignment=Alignment.CenterHorizontally,modifier=Modifier.padding(18.dp)) {
            BodyText(when(permission) {
                CameraPermissionState.NOT_REQUESTED->"Use your camera to take a fresh photo."
                CameraPermissionState.REVOKED->"Camera access changed. Allow access to continue your saved setup."
                CameraPermissionState.DENIED->"Camera access was denied. You can allow it when you’re ready."
                else->"Camera access is disabled. Enable Camera in Lovelies settings."
            })
            if(permission!=CameraPermissionState.PERMANENTLY_DENIED)PinkButton("Allow camera",Modifier.padding(top=18.dp).fillMaxWidth(.8f),enabled=active) {
                preferences.edit().putBoolean("requested",true).apply();launcher.launch(Manifest.permission.CAMERA)
            }
            if(permission in setOf(CameraPermissionState.PERMANENTLY_DENIED,CameraPermissionState.REVOKED))OutlineButton("Open Settings",Modifier.padding(top=12.dp),enabled=active) {
                settings.launch(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:${context.packageName}")))
            }
        }
    } else if(active) {
        key(front,captureContext,attempt) {
            val alive=remember { AtomicBoolean(true) }
            val camera=remember { NativeCamera(context,front,captureContext,{shutter(it)},
                {if(alive.get())ready(captureContext,it)},
                {bytes,owner->if(alive.get())photo(bytes,owner) else bytes.fill(0)},
                {if(alive.get()) { error(captureContext,it);permission=currentPermission() }},
                {if(alive.get()) { status=it;report(captureContext,it) }}) }
            Box(modifier) {
                AndroidView(factory={TextureView(it).also(camera::attach)},modifier=Modifier.fillMaxSize())
                if(status.phase in setOf(CameraPhase.IDLE,CameraPhase.INITIALIZING))Box(Modifier.fillMaxSize(),contentAlignment=Alignment.Center) { BodyText("Starting camera…") }
                if(status.phase==CameraPhase.FAILED)Box(Modifier.fillMaxSize(),contentAlignment=Alignment.Center) {
                    Column(Modifier.padding(18.dp),horizontalAlignment=Alignment.CenterHorizontally) {
                        BodyText(cameraRecoveryMessage(status.code ?: "camera_unavailable"))
                        PinkButton("Retry camera",Modifier.padding(top=18.dp),enabled=active) { status=CameraStatus(CameraPhase.IDLE);attempt++ }
                    }
                }
            }
            DisposableEffect(camera) { onDispose { alive.set(false);camera.close() } }
        }
    } else Box(modifier,contentAlignment=Alignment.Center) { BodyText("Camera paused. Return to Lovelies to continue.") }
}
