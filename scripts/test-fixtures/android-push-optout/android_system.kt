@file:Suppress("UNUSED_PARAMETER")

package android.system

import java.io.FileDescriptor

/** Compile-only platform boundary. Host media tests must explicitly provide
 * their real host directory sync; a missed injection must fail, never pass. */
object Os {
    fun open(path: String,flags: Int,mode: Int): FileDescriptor=throw AssertionError("Android Os.open is unavailable in this host fixture")
    fun fstat(descriptor: FileDescriptor): StructStat=throw AssertionError("Android Os.fstat is unavailable in this host fixture")
    fun fsync(descriptor: FileDescriptor): Unit=throw AssertionError("Android Os.fsync is unavailable in this host fixture")
    fun close(descriptor: FileDescriptor): Unit=throw AssertionError("Android Os.close is unavailable in this host fixture")
}

class StructStat(val st_mode: Int)

object OsConstants {
    const val O_RDONLY=0
    const val O_NOFOLLOW=0x20000
    const val O_NONBLOCK=0x800
    fun S_ISDIR(mode: Int): Boolean=throw AssertionError("Android S_ISDIR is unavailable in this host fixture")
}
