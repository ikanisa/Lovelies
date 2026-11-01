package com.lovelies.frontend.preview

import android.content.Context
import org.json.JSONObject

object BuildConfig { const val API_BASE_URL="https://repository-fixture.invalid";const val DEBUG=true;const val FACE_TOKEN_ISSUER="lovelies-fixture";const val PLAY_SUBSCRIPTION_PRODUCT="lovelies.pro.monthly" }
object R { object string {
    const val camera_recovery_permission_required=1;const val camera_recovery_initialization_timeout=2
    const val camera_recovery_disconnected=3;const val camera_recovery_surface_replaced=4
    const val camera_recovery_unavailable=5;const val camera_recovery_capture_failed=6
    const val camera_recovery_review_expired=7;const val camera_recovery_image_invalid=8
    const val camera_recovery_capture_too_large=9;const val camera_recovery_no_face=10
    const val camera_recovery_multiple_faces=11;const val camera_recovery_quality_low=12;const val camera_recovery_cannot_continue=13
    const val controller_bb1d294c8d56=14;const val controller_311651867b2f=15;const val controller_b7dd6131b8f4=16
    const val controller_43a45b864afc=17;const val controller_2d3b500866f8=18;const val controller_c5dd9ec980ef=19
    const val controller_0d9613931369=20;const val controller_ca350dda4dc7=21;const val controller_7bc8522e0cb4=22
    const val controller_4f6eed6a9fe6=23;const val controller_04a714d06d40=24;const val controller_04cb36080a3e=25
    const val controller_e5581cbfef39=26;const val controller_7baa8299b4a7=27;const val controller_846e2c78f9fc=28
    const val controller_d5bc59f2366c=29;const val controller_acc527e9244f=30;const val controller_ec3bb17ddb0a=31
    const val controller_4161e060779d=32;const val controller_0f2a4fcc93e6=33;const val controller_f81e04a747c2=34
    const val controller_47fb027a47f9=35;const val store_verification_ended_restore=36
} }
internal object BackgroundTransfers { fun permitted(raw:Any?,account:String,device:String,batch:String):Boolean=error("Background OS worker unavailable") }
fun jsonMap(json:JSONObject):WireObject=error("Use the injected network boundary")
/** No fake secure-storage success. Production AndroidRepositoryVault is
 * compiled, but construction/use without an injected vault always fails. */
class SecureSession(context:Context,endpoint:String) {
    init { error("Android Keystore unavailable in host fixture") }
    val authorityKey:Any get()=error("unreachable")
    fun loadAuthority():WireObject?=error("unreachable")
    fun saveAuthority(value:WireObject):Unit=error("unreachable")
    fun load():WireObject=error("unreachable")
    fun save(value:WireObject):Unit=error("unreachable")
    fun createDevice(alias:String):WireObject=error("unreachable")
    fun deleteDevice(alias:String?):Unit=error("unreachable")
    fun enrollmentAlias(account:String):String=error("unreachable")
    fun existingDevice(alias:String):WireObject=error("unreachable")
    fun hasEnrollmentKeys():Boolean=error("unreachable")
    fun hasStagedPhoto(id:String):Boolean=error("unreachable")
    fun hasUnreferencedEnrollmentKeys(known:Set<String>):Boolean=error("unreachable")
    fun recoveryAlias():String=error("unreachable")
    fun removeStagedPhoto(id:String):Unit=error("unreachable")
    fun sign(alias:String,envelope:WireObject):String=error("unreachable")
    fun stagePhoto(account:String,batch:String,id:String,bytes:ByteArray):Unit=error("unreachable")
    fun stagedPhoto(account:String,batch:String,id:String):ByteArray=error("unreachable")
    fun stageExportPart(account:String,request:String,id:String,bytes:ByteArray):Unit=error("unreachable")
    fun exportPart(account:String,request:String,id:String):ByteArray=error("unreachable")
    fun removeExportPart(id:String):Unit=error("unreachable")
}
