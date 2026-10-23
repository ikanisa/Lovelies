package com.lovelies.frontend.preview

enum class CameraCaptureMode { FACE, UPLOAD }

/** Immutable ownership recorded at shutter; contains no JPEG, private key, handle or token. */
data class NativeCaptureContext(val uiEpoch: Long,val session: SessionScope,val origin: String,val mode: CameraCaptureMode,
    val source: String,val requestId: String,val challengeFingerprint: String?,val index: Int,val pose: String) {
    companion object {
        fun fingerprint(challenge: WireObject)=NativeProtocol.sha256(NativeProtocol.canonical(challenge).toByteArray(Charsets.UTF_8))
    }
}

/** One Activity's picker request; never persisted or recovered into another session. */
data class NativePhotoPickerOwner(val capture: NativeCaptureContext,val device: String)

internal class PhotoPickerOwnership {
    var opened: NativePhotoPickerOwner?=null;private set
    private var expected: NativePhotoPickerOwner?=null
    fun begin(owner: NativePhotoPickerOwner): Boolean {
        if(opened!=null)return false
        opened=owner;expected=owner;return true
    }
    /** Android's external picker pauses this Activity; keep the ordinary session invalidation. */
    fun background(before: NativePhotoPickerOwner?,after: NativePhotoPickerOwner?) {
        if(opened==null)return
        if(before==null || before!=expected || after==null ||
            after.capture.uiEpoch!=before.capture.uiEpoch+1 ||
            after.capture.session!=before.capture.session.copy(epoch=before.capture.session.epoch+1) ||
            after.copy(capture=after.capture.copy(uiEpoch=before.capture.uiEpoch,session=before.capture.session))!=before) {
            clear();return
        }
        expected=after
    }
    fun consume(owner: NativePhotoPickerOwner?,current: NativePhotoPickerOwner?): Boolean {
        if(owner==null || owner!=opened)return false
        val accepted=current!=null && current==expected
        clear();return accepted
    }
    fun cancel(owner: NativePhotoPickerOwner) { if(owner==opened)clear() }
    fun clear() { opened=null;expected=null }
}

internal fun acceptBoundCaptureFrame(bytes: ByteArray,owner: NativeCaptureContext,current: NativeCaptureContext?): Boolean {
    if(bytes.isEmpty() || current!=owner) { bytes.fill(0);return false }
    return true
}

internal fun dispatchBoundCaptureFrame(bytes: ByteArray,owner: NativeCaptureContext,current: ()->NativeCaptureContext?,
    face: (ByteArray,NativeCaptureContext)->Unit,upload: (ByteArray,NativeCaptureContext)->Unit): Boolean {
    if(!acceptBoundCaptureFrame(bytes,owner,current()))return false
    when(owner.mode) { CameraCaptureMode.FACE->face(bytes,owner);CameraCaptureMode.UPLOAD->upload(bytes,owner) }
    return true
}

internal fun assertFaceFrameBinding(owner: NativeCaptureContext,scope: SessionScope,origin: String,challenge: WireObject,
    requestId: String,index: Int) {
    val poses=challenge["poses"] as? List<*>
    if(owner.mode!=CameraCaptureMode.FACE || owner.source!="face_authentication" || owner.session!=scope || owner.origin!=origin ||
        owner.requestId!=requestId || owner.challengeFingerprint!=NativeCaptureContext.fingerprint(challenge) ||
        owner.index!=index || poses?.getOrNull(index)!=owner.pose)throw LiveFailure("capture_context_changed")
}
