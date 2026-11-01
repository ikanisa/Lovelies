package com.lovelies.frontend.preview

import java.io.File
import java.io.IOException
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking

private val fixtureAccount="00000000-0000-4000-8000-000000000081"
private val fixtureSession="00000000-0000-4000-8000-000000000082"
private val fixtureRequest="00000000-0000-4000-8000-000000000083"
private val fixtureDelivery="00000000-0000-4000-8000-000000000084"
// This fixture runs on the host filesystem. It must perform a real directory
// sync rather than invoking Android descriptor APIs or accepting a no-op.
private fun syncMediaDirectoryOnHost(path: Path) {
    FileChannel.open(path,StandardOpenOption.READ,LinkOption.NOFOLLOW_LINKS).use { it.force(true) }
}
private class ExportFixture {
    val payload="{\"account\":\"synthetic\",\"data\":[]}".toByteArray()
    var now=Instant.parse("2026-10-29T12:00:00Z").toEpochMilli();var elapsed=5_000L
    val initial=PrivacyExportIntent.create("https://fixture",fixtureAccount,fixtureSession,"1".repeat(64),now+60_000,fixtureRequest,now,elapsed)
    var durable=initial;var staged:ByteArray?=null;var delivered:ByteArray?=null;var acknowledged=false;var currentSession=fixtureSession
    var creates=0;var reads=0;var acks=0;var publishes=0;val createKeys=mutableListOf<String>();val ackKeys=mutableListOf<String>()
    var failCreate=false;var failRead=false;var failStage=false;var failJournal=false;var failAck=false;var failPublish=false;var corruptRead=false
    var afterAck:(()->Unit)?=null
    val deadline=now+60_000
    fun response(value:PrivacyExportIntent):WireObject=mapOf("protocol" to "lovelies-privacy-export-delivery-v2","operation_key" to value.createKey,"request_id" to value.request,
        "delivery_id" to fixtureDelivery,"account_id" to value.account,"session_id" to value.session,"state" to if(acknowledged)"acknowledged" else "available",
        "expires_at" to Instant.ofEpochMilli(deadline).toString(),"sha256" to NativeProtocol.sha256(payload),"bytes" to payload.size,
        "retrieve_path" to "/privacy-exports/deliveries/$fixtureDelivery","ack_path" to "/privacy-exports/deliveries/$fixtureDelivery/ack")
    fun engine()=PrivacyExportRecovery(
        persist={ value->durable=PrivacyExportIntent.restore(value.wire(),initial.origin);if(failJournal && value.staged) { failJournal=false;throw IOException("Lost stage journal acknowledgement") } },
        assertCurrent={ value->if(!value.owns(initial.origin,fixtureAccount,currentSession,initial.tokenHash))throw LiveFailure("privacy_export_session_changed")
            if(!value.live(now,elapsed))throw LiveFailure("privacy_export_delivery_expired") },
        create={ value->check(durable.createKey==value.createKey && durable.ackKey==value.ackKey);creates++;createKeys.add(value.createKey)
            if(failCreate) { failCreate=false;throw IOException("Lost create response") };response(value) },
        retrieve={ _->reads++;check(!acknowledged);if(failRead) { failRead=false;throw IOException("Lost GET response") };if(corruptRead)byteArrayOf(1,2,3) else payload.copyOf() },
        readStage={ staged?.copyOf() },writeStage={ _,bytes->staged=bytes.copyOf();if(failStage) { failStage=false;throw IOException("Lost staging acknowledgement") } },
        validateDocument={ check(it.firstOrNull()=='{'.code.toByte()) },
        ack={ value->check(durable.staged && staged!!.contentEquals(payload));check(value.ackKey!=value.createKey);acks++;ackKeys.add(value.ackKey);acknowledged=true
            if(failAck) { failAck=false;throw IOException("Lost ACK response") };afterAck?.invoke()
            mapOf("acknowledged" to true,"delivery_id" to fixtureDelivery,"request_id" to fixtureRequest) },
        publish={ bytes,current->current();if(failPublish) { failPublish=false;throw IOException("Document provider unavailable") };publishes++;delivered=bytes.copyOf() })
    fun attempt()=runCatching { runBlocking { engine().run(durable) } }
    fun success() { check(attempt().isSuccess);check(durable.completed);check(delivered!!.contentEquals(payload));check(publishes==1) }
}
private fun withCache(block:(File)->Unit) {
    val root=Files.createTempDirectory("lovelies-owned-media-")
    try { block(root.toFile()) } finally { Files.walk(root).use { stream->stream.sorted(Comparator.reverseOrder()).forEach(Files::deleteIfExists) } }
}
private fun storeJournal(account:String=fixtureAccount,key:String="android-store-host-operation-0001")=StorePurchaseJournal.create("https://fixture",account,"lovelies.pro.monthly","synthetic-private-purchase-token",key)
private fun completedStore(value:StorePurchaseJournal):StorePurchaseJournal {
    val result=mapOf("active" to true,"billing_environment" to "production","expires_at" to "2026-11-29T12:00:00.000Z","financial_eligible" to true,
        "original_transaction_id" to value.credentialSha256,"product_id" to value.product,"provider" to "google_play","stale" to false,"transaction_id" to "fixture-order")
    return value.copy(receipt=mapOf("protocol" to "lovelies-store-operation-receipt-v1","actor_id" to value.account,"operation_key" to value.key,"status" to "committed",
        "action" to "store.google","source" to "store","payload_hash" to value.inputHash("digest-v1"),"result" to result,"input_scheme" to "digest-v1","credential_sha256" to value.credentialSha256,"receipt_scope" to "historical"))
}

fun runRecoveryChecks(run:(String,()->Unit)->Unit) {
    run("export lost create reply recovers the same durable operation and delivery") {
        val fixture=ExportFixture();fixture.failCreate=true;check(fixture.attempt().isFailure);check(fixture.reads==0);fixture.success()
        check(fixture.createKeys.toSet()==setOf(fixture.initial.createKey) && fixture.acks==1)
    }
    run("export GET response loss can repeat the same delivery before ACK") {
        val fixture=ExportFixture();fixture.failRead=true;check(fixture.attempt().isFailure);check(!fixture.acknowledged);fixture.success();check(fixture.reads==2)
    }
    run("export lost staging acknowledgement recovers verified durable bytes without another GET") {
        val fixture=ExportFixture();fixture.failStage=true;check(fixture.attempt().isFailure);check(fixture.staged!=null && fixture.acks==0)
        fixture.success();check(fixture.reads==1)
    }
    run("export lost stage journal acknowledgement stops ACK until persistence is reconfirmed") {
        val fixture=ExportFixture();fixture.failJournal=true;check(fixture.attempt().isFailure);check(fixture.durable.staged && fixture.acks==0)
        fixture.success();check(fixture.reads==1)
    }
    run("export lost ACK response resumes with staged bytes and the distinct original ACK key") {
        val fixture=ExportFixture();fixture.failAck=true;check(fixture.attempt().isFailure);check(fixture.acknowledged && fixture.publishes==0)
        fixture.success();check(fixture.reads==1 && fixture.acks==2 && fixture.ackKeys.toSet()==setOf(fixture.initial.ackKey))
    }
    run("export document failure retains staged bytes and rechecks current server authority on retry") {
        val fixture=ExportFixture();fixture.failPublish=true;check(fixture.attempt().isFailure);check(!fixture.durable.completed)
        fixture.success();check(fixture.acks==2 && fixture.reads==1)
    }
    run("export altered bytes cannot be staged acknowledged or published") {
        val fixture=ExportFixture();fixture.corruptRead=true;check(fixture.attempt().isFailure);check(fixture.staged==null && fixture.acks==0 && fixture.publishes==0)
    }
    run("export session replacement after ACK prevents document publication") {
        val fixture=ExportFixture();fixture.afterAck={ fixture.currentSession=fixtureRequest }
        check((fixture.attempt().exceptionOrNull() as? LiveFailure)?.code=="privacy_export_session_changed");check(fixture.publishes==0)
    }
    run("export wall expiry and elapsed rollback both fail before requesting private bytes") {
        val expired=ExportFixture();expired.now=expired.deadline;check(expired.attempt().isFailure);check(expired.creates==0)
        val rollback=ExportFixture();rollback.elapsed--;check(rollback.attempt().isFailure);check(rollback.creates==0)
    }
    run("export response cannot change account path expiry or payload after first delivery") {
        val fixture=ExportFixture();val good=fixture.response(fixture.initial);val proof=PrivacyExportDelivery.response(good,fixture.initial)
        listOf(good+mapOf("account_id" to fixtureRequest),good+mapOf("retrieve_path" to "https://other/private"),good+mapOf("bytes" to fixture.payload.size+1),good+mapOf("expires_at" to Instant.ofEpochMilli(fixture.deadline+1).toString())).forEach {
            check(runCatching { PrivacyExportDelivery.response(it,fixture.initial.copy(delivery=proof)) }.isFailure)
        }
    }
    val name="lovelies-$fixtureRequest-$fixtureDelivery.jpg"
    run("owned temporary files retain durable proof and expire after restart-equivalent reread") {
        withCache { cache->val file=PrivateTemporaryMedia.write(cache,PrivateTemporaryMedia.Kind.SHARED,name,byteArrayOf(1,2,3),1_000,directorySync=::syncMediaDirectoryOnHost)
            check(PrivateTemporaryMedia.owned(cache,PrivateTemporaryMedia.Kind.SHARED,file)!=null)
            check(PrivateTemporaryMedia.sweep(cache,PrivateTemporaryMedia.Kind.SHARED,1_000+PrivateTemporaryMedia.SHARE_AGE_MS).removed==setOf(name));check(!file.exists()) }
    }
    run("matching unknown legacy filenames are preserved") {
        withCache { cache->val folder=File(cache,"shared-originals").apply { mkdir() };val file=File(folder,name).apply { writeBytes(byteArrayOf(9));setLastModified(1) }
            check(PrivateTemporaryMedia.sweep(cache,PrivateTemporaryMedia.Kind.SHARED,Long.MAX_VALUE,all=true).removed.isEmpty());check(file.exists()) }
    }
    run("stale file handles and sweep cannot delete a same-path replacement") {
        withCache { cache->val file=PrivateTemporaryMedia.write(cache,PrivateTemporaryMedia.Kind.SHARED,name,byteArrayOf(1,2,3),1_000,directorySync=::syncMediaDirectoryOnHost)
            val owner=PrivateTemporaryMedia.owned(cache,PrivateTemporaryMedia.Kind.SHARED,file)!!
            val replacement=File(file.parentFile,"other").apply { writeBytes(byteArrayOf(9,8,7)) }
            Files.move(replacement.toPath(),file.toPath(),StandardCopyOption.REPLACE_EXISTING)
            check(!PrivateTemporaryMedia.discard(cache,owner));check(PrivateTemporaryMedia.sweep(cache,PrivateTemporaryMedia.Kind.SHARED,Long.MAX_VALUE,all=true).removed.isEmpty())
            check(file.readBytes().contentEquals(byteArrayOf(9,8,7))) }
    }
    run("supported temporary writers serialize with cleanup and stale handles reject reused names") {
        withCache { cache->val file=PrivateTemporaryMedia.write(cache,PrivateTemporaryMedia.Kind.SHARED,name,byteArrayOf(1),1_000,directorySync=::syncMediaDirectoryOnHost)
            val owner=PrivateTemporaryMedia.owned(cache,PrivateTemporaryMedia.Kind.SHARED,file)!!
            val entered=CountDownLatch(1);val release=CountDownLatch(1);val writerDone=CountDownLatch(1);val pool=Executors.newFixedThreadPool(2)
            try {
                val clean=pool.submit { PrivateTemporaryMedia.sweep(cache,PrivateTemporaryMedia.Kind.SHARED,Long.MAX_VALUE,all=true,remove={ path->entered.countDown();check(release.await(3,TimeUnit.SECONDS));Files.deleteIfExists(path) }) }
                check(entered.await(3,TimeUnit.SECONDS))
                val writer=pool.submit { PrivateTemporaryMedia.write(cache,PrivateTemporaryMedia.Kind.SHARED,name,byteArrayOf(2),2_000,directorySync=::syncMediaDirectoryOnHost);writerDone.countDown() }
                check(!writerDone.await(100,TimeUnit.MILLISECONDS));release.countDown();clean.get(4,TimeUnit.SECONDS);writer.get(4,TimeUnit.SECONDS)
                check(!PrivateTemporaryMedia.discard(cache,owner));check(file.readBytes().contentEquals(byteArrayOf(2)))
            } finally { release.countDown();pool.shutdownNow();check(pool.awaitTermination(4,TimeUnit.SECONDS)) }
        }
    }
    run("completed store evidence is archived under its original account without becoming another account entitlement") {
        val original=completedStore(storeJournal());val history=StorePurchasePersistence.archive(emptyList(),original)
        check(history.single()==original);check(StorePurchaseJournal.restore(history.single().wire(),original.origin).account==fixtureAccount)
        check(StorePurchasePersistence.archived(history,original))
        check(StorePurchasePersistence.archived(StorePurchasePersistence.archive(history,original.observed("commit_confirmed")),original))
        check(runCatching { history.single().assertOwner(original.origin,fixtureRequest) }.isFailure)
    }
    run("unresolved store evidence cannot be archived as completed or merged across accounts") {
        val unresolved=storeJournal();check(runCatching { StorePurchasePersistence.archive(emptyList(),unresolved) }.isFailure)
        val other=completedStore(storeJournal(fixtureRequest))
        check(runCatching { StorePurchasePersistence.archive(listOf(other),completedStore(unresolved)) }.isFailure)
    }
    run("store history capacity preserves prior records and fails before new evidence is discarded") {
        val history=(0 until 64).map { completedStore(storeJournal(key="android-store-host-operation-${it.toString().padStart(4,'0')}")) }
        check(runCatching { StorePurchasePersistence.archive(history,completedStore(storeJournal(key="android-store-host-operation-next"))) }.isFailure)
        check(history.size==64)
    }
}
