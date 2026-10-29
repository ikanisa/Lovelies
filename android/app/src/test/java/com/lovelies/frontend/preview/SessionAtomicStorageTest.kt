package com.lovelies.frontend.preview

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.*
import java.time.Instant

/** Actual session-file persistence with a real temporary filesystem and two source-bound AtomicFile models.
 * Models follow AOSP API24/29 backup rollback and API30/36 new-file rename recovery. Fault flags emulate
 * the platform's logged (nonthrowing) filesystem failures. No Keystore, flash durability or device claim. */
class SessionAtomicStorageTest {
    @get:Rule val directory=TemporaryFolder()
    private enum class Algorithm { BACKUP_ROLLBACK, NEW_RENAME }
    private class FileAtomic(override val baseFile: File,val algorithm: Algorithm): SessionAtomicFile {
        val backup=File(baseFile.path+".bak")
        val next=File(baseFile.path+".new")
        var recoveryRenameFails=false
        var finishDoesNotCommit=false
        var loseFinishAcknowledgement=false
        var readCount=0
        var writeCount=0
        private fun rename(source: File,target: File) {
            if(target.isDirectory)target.delete()
            source.renameTo(target) // AOSP logs rather than throws on failure.
        }
        override fun readFully(): ByteArray {
            readCount++
            if(backup.exists()) {
                if(algorithm==Algorithm.BACKUP_ROLLBACK)baseFile.delete()
                if(!recoveryRenameFails)rename(backup,baseFile)
            }
            if(algorithm==Algorithm.NEW_RENAME && next.exists() && baseFile.exists())next.delete()
            return FileInputStream(baseFile).use { it.readBytes() }
        }
        override fun startWrite(): FileOutputStream {
            writeCount++
            if(algorithm==Algorithm.BACKUP_ROLLBACK) {
                if(baseFile.exists()) { if(!backup.exists())baseFile.renameTo(backup) else baseFile.delete() }
                return FileOutputStream(baseFile)
            }
            if(backup.exists())rename(backup,baseFile)
            return FileOutputStream(next)
        }
        override fun finishWrite(stream: FileOutputStream) {
            stream.fd.sync();stream.close()
            if(!finishDoesNotCommit) {
                if(algorithm==Algorithm.BACKUP_ROLLBACK)backup.delete() else rename(next,baseFile)
            }
            if(loseFinishAcknowledgement)throw IOException("Synthetic lost finish acknowledgement")
        }
        override fun failWrite(stream: FileOutputStream) {
            runCatching { stream.fd.sync() };stream.close()
            if(algorithm==Algorithm.BACKUP_ROLLBACK) { baseFile.delete();backup.renameTo(baseFile) } else next.delete()
        }
        override fun delete() { baseFile.delete();backup.delete();if(algorithm==Algorithm.NEW_RENAME)next.delete() }
    }
    private fun atomic(algorithm: Algorithm)=FileAtomic(File(directory.newFolder(),"session.bin"),algorithm)
    private fun held(block: ()->Unit) {
        try { block();fail("An uncertain file must not become a fresh empty vault") }
        catch(problem: LiveFailure) { assertEquals("secure_storage_unavailable",problem.code);assertTrue(problem.ambiguous) }
    }
    @Test fun genuinelyMissingVaultCallsRecoveryBeforeReturningEmptyOnBothAlgorithms() {
        for(algorithm in Algorithm.entries) {
            val file=atomic(algorithm);assertNull(SessionAtomicStorage(file).read());assertEquals(1,file.readCount);assertEquals(0,file.writeCount)
        }
    }
    @Test fun backupOnlyRecoversTheExactSameSubjectStoreEvidenceThroughActualRepositoryCallers()=runBlocking {
        for(algorithm in Algorithm.entries) {
            val file=atomic(algorithm)
            val origin="https://ltqfplqevxztlswlzexn.supabase.co/functions/v1/lovelies-api"
            val account="00000000-0000-4000-8000-000000000001"
            val journal=StorePurchaseJournal.create(origin,account,"lovelies.pro.monthly","same-subject-file-backed-token-0001","same-subject-file-operation-0001")
            val legacy=PendingIntent(account,"store","store.google",journal.key,journal.request,"/subscriptions/google/transactions","POST")
            val intent=GuestDeletionRecord.create(origin,account);val time=Instant.parse("2026-10-29T00:00:00Z")
            val response: WireObject=mapOf("protocol" to "lovelies-account-deletion-v1","source" to "privacy","operation_key" to intent.operationKey,
                "privacy_request" to mapOf("id" to "00000000-0000-4000-8000-000000000011","request_type" to "delete","status" to "completed",
                    "created_at" to time.toString(),"reviewed_at" to time.plusSeconds(1).toString(),"completed_at" to time.plusSeconds(2).toString(),"failure_code" to null),
                "deletion_status" to mapOf("expires_at" to time.plusSeconds(2+30L*86400).toString()),"request_expires_at" to time.plusSeconds(30L*86400).toString(),
                "request_expired" to false,"deletion_completed" to true)
            val completed=intent.copy(receipt=GuestDeletionReceipt.parse(response,intent))
            val evidence: WireObject=mapOf("pending" to legacy.wire(),"google_store_operation" to journal.wire(),"guest_deletion" to completed.wire())
            val bytes=serialize(evidence);file.backup.writeBytes(bytes);assertFalse(file.baseFile.exists())
            val vault=FileVault(SessionAtomicStorage(file))
            // Prove byte-exact backup promotion BEFORE completed-guest bootstrap deliberately saves a new snapshot.
            assertEquals(evidence,vault.load());assertFalse(file.backup.exists());assertArrayEquals(bytes,file.baseFile.readBytes())
            assertEquals(0,file.writeCount);assertTrue(vault.savedValues.isEmpty())
            val repo=CloudflareRepository(origin,RepositoryBoundary(vault,{_,_,_,_,_,_->error("Backup recovery must not create a new account or call providers")}))
            assertTrue(repo.bootstrap().isEmpty());assertEquals(legacy,repo.pending);assertEquals(evidence,vault.load())
            assertEquals(1,file.writeCount);assertEquals(listOf(evidence),vault.savedValues)
            repo.restartAfterGuestDeletion();repo.logout(revokeIdentity=true)
            val retained=evidence-"guest_deletion"
            assertEquals(3,file.writeCount);assertEquals(listOf(evidence,retained,retained),vault.savedValues)
            assertEquals(legacy,repo.pending);assertEquals(retained,FileVault(SessionAtomicStorage(file)).load())
            assertEquals(journal.wire(),vault.load()["google_store_operation"])
        }
    }
    @Test fun legacyBackupWinsOverTheIncompleteBaseAsThePlatformSpecifies() {
        val file=atomic(Algorithm.BACKUP_ROLLBACK);file.backup.writeBytes(byteArrayOf(7,1));file.baseFile.writeBytes(byteArrayOf(9))
        assertArrayEquals(byteArrayOf(7,1),SessionAtomicStorage(file).read());assertFalse(file.backup.exists())
    }
    @Test fun currentLegacyBackupWinsOverBaseAndStaleNewFile() {
        val file=atomic(Algorithm.NEW_RENAME);file.backup.writeBytes(byteArrayOf(7,1));file.baseFile.writeBytes(byteArrayOf(9));file.next.writeBytes(byteArrayOf(10))
        assertArrayEquals(byteArrayOf(7,1),SessionAtomicStorage(file).read());assertFalse(file.backup.exists());assertFalse(file.next.exists())
    }
    @Test fun newOnlyFirstWriteCannotBecomeFreshEmptyOrBeOverwritten() {
        for(algorithm in Algorithm.entries) {
            val file=atomic(algorithm);val unknown=byteArrayOf(7,9,1);file.next.writeBytes(unknown);val storage=SessionAtomicStorage(file)
            held { storage.read() };held { storage.write(byteArrayOf(3)) };assertArrayEquals(unknown,file.next.readBytes());assertEquals(0,file.writeCount)
            held { SessionAtomicStorage(file).read() };assertFalse(file.baseFile.exists())
        }
    }
    @Test fun legacyUnrecognizedNewFileBesideBaseIsAlsoHeldWithoutDeletion() {
        val file=atomic(Algorithm.BACKUP_ROLLBACK);file.baseFile.writeBytes(byteArrayOf(1));file.next.writeBytes(byteArrayOf(2))
        held { SessionAtomicStorage(file).read() };assertArrayEquals(byteArrayOf(2),file.next.readBytes());assertArrayEquals(byteArrayOf(1),file.baseFile.readBytes())
    }
    @Test fun failedBackupRecoveryNeverLooksLikeAMissingVault() {
        for(algorithm in Algorithm.entries) {
            val file=atomic(algorithm);file.backup.writeBytes(byteArrayOf(1));file.recoveryRenameFails=true
            held { SessionAtomicStorage(file).read() };assertArrayEquals(byteArrayOf(1),file.backup.readBytes());assertEquals(0,file.writeCount)
        }
    }
    @Test fun failedCurrentBackupRenameCannotPublishTheUnrelatedBase() {
        val file=atomic(Algorithm.NEW_RENAME);file.backup.writeBytes(byteArrayOf(1));file.baseFile.writeBytes(byteArrayOf(2));file.recoveryRenameFails=true
        val storage=SessionAtomicStorage(file);held { storage.read() };held { storage.write(byteArrayOf(3)) }
        assertArrayEquals(byteArrayOf(1),file.backup.readBytes());assertArrayEquals(byteArrayOf(2),file.baseFile.readBytes())
    }
    @Test fun missingParentIsNotEvidenceOfAFreshReadableDirectory() {
        val base=File(File(directory.root,"missing-parent"),"session.bin");val file=FileAtomic(base,Algorithm.NEW_RENAME)
        held { SessionAtomicStorage(file).read() };assertEquals(0,file.readCount);assertFalse(base.parentFile!!.exists())
    }
    @Test fun silentCommitFailureIsDetectedByExactReadbackAndCannotBeRetriedInPlace() {
        for(algorithm in Algorithm.entries) {
            val file=atomic(algorithm);file.baseFile.writeBytes(byteArrayOf(1));file.finishDoesNotCommit=true
            val storage=SessionAtomicStorage(file);held { storage.write(byteArrayOf(2)) };assertArrayEquals(byteArrayOf(1),file.baseFile.readBytes())
            held { storage.write(byteArrayOf(3)) };assertEquals(1,file.writeCount)
            assertArrayEquals(byteArrayOf(1),SessionAtomicStorage(file).read())
        }
    }
    @Test fun lostFinishAcknowledgementPreservesTheCommittedBytesWithoutDestructiveRollback() {
        for(algorithm in Algorithm.entries) {
            val file=atomic(algorithm);file.baseFile.writeBytes(byteArrayOf(1));file.loseFinishAcknowledgement=true
            val storage=SessionAtomicStorage(file);held { storage.write(byteArrayOf(7,2)) }
            assertArrayEquals(byteArrayOf(7,2),file.baseFile.readBytes());assertArrayEquals(byteArrayOf(7,2),SessionAtomicStorage(file).read())
            held { storage.write(byteArrayOf(9)) };assertEquals(1,file.writeCount)
        }
    }
    @Test fun knownUncertaintyCannotTurnIntoEmptyAfterItsFilesDisappear() {
        val file=atomic(Algorithm.NEW_RENAME);file.next.writeBytes(byteArrayOf(1));val storage=SessionAtomicStorage(file)
        held { storage.read() };assertTrue(file.next.delete());held { storage.read() };held { storage.write(byteArrayOf(2)) }
        assertFalse(file.baseFile.exists());assertEquals(0,file.writeCount)
    }
    @Test fun rejectedCiphertextCannotBeReplacedByFreshEmptyWithinTheSameVault() {
        val file=atomic(Algorithm.NEW_RENAME);file.baseFile.writeBytes(byteArrayOf(1));val storage=SessionAtomicStorage(file)
        assertNotNull(storage.read());storage.hold() // SecureSession invokes this when AES/format/JSON validation rejects bytes.
        assertTrue(file.baseFile.delete());held { storage.read() };held { storage.write(byteArrayOf(2)) };assertEquals(0,file.writeCount)
    }
    private class FileVault(private val storage: SessionAtomicStorage): RepositoryVault {
        val savedValues=mutableListOf<WireObject>()
        override fun load(): WireObject=storage.read()?.let { bytes->try { ObjectInputStream(ByteArrayInputStream(bytes)).use { NativeProtocol.obj(it.readObject()) } } finally { bytes.fill(0) } } ?: emptyMap()
        override fun save(value: WireObject) { val bytes=serialize(value);try { storage.write(bytes);savedValues.add(value.toMap()) } finally { bytes.fill(0) } }
    }
    companion object {
        private fun serialize(value: WireObject): ByteArray=ByteArrayOutputStream().use { bytes->ObjectOutputStream(bytes).use { it.writeObject(value) };bytes.toByteArray() }
    }
}
