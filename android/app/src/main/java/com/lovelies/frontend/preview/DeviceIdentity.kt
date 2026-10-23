package com.lovelies.frontend.preview

/** Device identity metadata is independent of HTTP transport and never contains the private key. */
data class DeviceIdentity(val account: String,val alias: String,val handle: String,val device: String) {
    fun wire(): WireObject=mapOf("account" to account,"alias" to alias,"handle" to handle,"device" to device)
}
