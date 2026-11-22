package com.lovelies.frontend.preview

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.ObjectInputStream
import java.io.ObjectOutputStream
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.PosixFilePermissions
import java.util.Properties
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec

/** Explicit local-handler lane. Ordinary JVM tests skip it. Requires real
 * org.json at runtime; no mock transport, live store or native Photos effect. */
class DownloadRepositoryHttpTest {
    private class ScratchVault: RepositoryVault,AutoCloseable {
        private val root=Files.createTempDirectory("lovelies-download-http-",PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")))
        private val key=KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        private val owned=mutableSetOf<Path>()
        private fun path(name: String)=root.resolve(name).also { owned.add(it) }
        private fun write(name: String,aad: String,plain: ByteArray) {
            val cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key);cipher.updateAAD(aad.toByteArray())
            val sealed=cipher.iv+cipher.doFinal(plain);val target=path(name);val temporary=path("$name.tmp")
            try {
                Files.write(temporary,sealed);Files.setPosixFilePermissions(temporary,PosixFilePermissions.fromString("rw-------"))
                Files.move(temporary,target,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING)
            } finally { sealed.fill(0) }
        }
        private fun read(name: String,aad: String): ByteArray {
            val sealed=Files.readAllBytes(path(name))
            try {
                val cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key,GCMParameterSpec(128,sealed.copyOfRange(0,12)))
                cipher.updateAAD(aad.toByteArray());return cipher.doFinal(sealed.copyOfRange(12,sealed.size))
            } finally { sealed.fill(0) }
        }
        override fun load(): WireObject {
            if(!Files.exists(path("session")))return emptyMap()
            val plain=read("session","session")
            return try { ObjectInputStream(ByteArrayInputStream(plain)).use { NativeProtocol.obj(it.readObject()) } } finally { plain.fill(0) }
        }
        override fun save(value: WireObject) {
            val output=ByteArrayOutputStream();ObjectOutputStream(output).use { it.writeObject(value.toMap()) }
            val plain=output.toByteArray();try { write("session","session",plain) } finally { plain.fill(0);output.reset() }
        }
        override fun stageOriginal(account: String,session: String,id: String,bytes: ByteArray)=write("${NativeProtocol.id(id)}.original","$account:$session:$id",bytes)
        override fun stagedOriginal(account: String,session: String,id: String)=read("${NativeProtocol.id(id)}.original","$account:$session:$id")
        override fun removeStagedOriginal(id: String) { Files.deleteIfExists(path("${NativeProtocol.id(id)}.original")) }
        override fun close() { owned.forEach { Files.deleteIfExists(it) };Files.deleteIfExists(root) }
    }
    @Test fun actualRepositoryUsesCanonicalV2AgainstOwnedLocalHandlerAndKeepsInterruptedEffectUnresolved()=runBlocking {
        val configPath=System.getProperty("lovelies.download.http.config") ?: System.getenv("LOVELIES_DOWNLOAD_HTTP_CONFIG")
        assumeTrue("Explicit owned local download fixture configuration is absent",!configPath.isNullOrBlank())
        val config=Properties().apply { Files.newInputStream(Path.of(configPath!!)).use(::load) }
        fun required(name: String)=config.getProperty(name)?.takeIf(String::isNotBlank) ?: error("Missing private HTTP fixture field: $name")
        val origin=required("api_origin")
        val uri=java.net.URI(origin)
        require(uri.host in setOf("localhost","127.0.0.1")) { "HTTP qualification requires an owned loopback handler" }
        val account=NativeProtocol.id(required("account_id"));val session=NativeProtocol.id(required("session_id"));val device=NativeProtocol.id(required("device_id"))
        val actor=LiveCredentials(account,required("access_token"),required("refresh_token"),"registered_face",required("session_expires_ms").toLong(),emptyMap())
        val asset=NativeProtocol.id(required("asset_id"));val version=required("source_version")
        val photo=LivePhoto(asset,version,"received","personal","Owned HTTP fixture",1,1)
        ScratchVault().use { vault ->
            vault.save(mapOf("device" to mapOf("account" to account,"alias" to "owned-http-fixture","handle" to "owned-http-fixture","device" to device)))
            fun repository()=CloudflareRepository(origin,RepositoryBoundary(vault,{_,_,_,_,_,_->error("Mock HTTP boundary was called")},
                initialStorage=vault.load(),initialSession=actor,useNetwork=true))
            val first=repository();first.bootstrap();val staged=first.original(photo)
            assertEquals(session,staged.session);assertEquals("staged",staged.phase)
            assertEquals(required("sha256"),staged.checksum);assertEquals(required("content_type"),staged.mime);assertEquals(required("content_length").toLong(),staged.length)
            val restarted=repository();restarted.bootstrap();val recovered=restarted.original(photo)
            assertEquals(staged.key,recovered.key);assertTrue(staged.capability==recovered.capability)
            assertEquals(staged.createdAt,recovered.createdAt);assertEquals(staged.expiresAt,recovered.expiresAt)
            assertEquals(staged.key,restarted.recoverOriginalIssuance()!!.key)
            var syntheticEffects=0
            try {
                restarted.performOriginalEffect(recovered.key) { bytes ->
                    assertEquals(required("sha256"),NativeProtocol.sha256(bytes));assertEquals("effect_started",NativeProtocol.obj(vault.load()["download_operation"])["phase"])
                    syntheticEffects++;throw java.io.IOException("Owned synthetic effect interruption; no native save/share was called")
                }
                fail("Expected the owned synthetic external-effect interruption")
            } catch(_: java.io.IOException) {}
            assertEquals(1,syntheticEffects)
            val afterLoss=repository();afterLoss.bootstrap()
            try { afterLoss.original(photo);fail("Ambiguous external effect was repeated") }
            catch(problem: LiveFailure) { assertEquals("download_external_outcome_unresolved",problem.code) }
            assertEquals("effect_started",NativeProtocol.obj(vault.load()["download_operation"])["phase"])
            assertEquals(1,syntheticEffects)
        }
    }
}
