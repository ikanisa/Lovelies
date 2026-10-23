package com.lovelies.frontend.preview

import android.content.Context
import androidx.work.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import java.util.concurrent.TimeUnit

/** One in-process vault owner and one foreground/background transfer lease. */
internal object BackgroundTransfers {
    val lease=Mutex()
    @Volatile var running=false;private set
    fun started() { running=true }
    fun finished() { running=false }
    @Volatile private var shared: CloudflareRepository?=null
    @Synchronized fun repository(context: Context): CloudflareRepository=shared ?: CloudflareRepository(context.applicationContext).also { shared=it }
    private fun name(account: String,batch: String)="lovelies-upload-${NativeProtocol.id(account)}-${NativeProtocol.id(batch)}"
    fun schedule(context: Context,record: PhotoUploadBatch) {
        if(record.finished || record.cancelled)return
        val request=OneTimeWorkRequestBuilder<PhotoTransferWorker>()
            .setInputData(workDataOf("account" to record.account,"device" to record.device,"batch" to record.batch))
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).setRequiresStorageNotLow(true).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL,30,TimeUnit.SECONDS).addTag("lovelies-private-uploads").build()
        WorkManager.getInstance(context).enqueueUniqueWork(name(record.account,record.batch),ExistingWorkPolicy.KEEP,request)
    }
    fun cancel(context: Context) { WorkManager.getInstance(context).cancelAllWorkByTag("lovelies-private-uploads") }
    fun permitted(value: Any?,account: String,device: String,batch: String): Boolean {
        val row=value as? Map<*,*> ?: return false
        return row["enabled"]==true && row["account"]==account && row["device"]==device && row["batch"]==batch
    }
}
class PhotoTransferWorker(context: Context,parameters: WorkerParameters): CoroutineWorker(context,parameters) {
    override suspend fun doWork(): Result=BackgroundTransfers.lease.withLock {
        val account=inputData.getString("account") ?: return@withLock Result.failure()
        val device=inputData.getString("device") ?: return@withLock Result.failure()
        val batch=inputData.getString("batch") ?: return@withLock Result.failure()
        val repository=BackgroundTransfers.repository(applicationContext)
        try {
            BackgroundTransfers.started()
            // A background job cannot create an anonymous account or replace an unresolved authentication journal.
            if(repository.credentials==null) {
                if(!repository.canRestoreBackground(account,device,batch))return@withLock Result.success()
                repository.bootstrap()
            }
            if(repository.credentials?.account!=account || repository.credentials?.method!="registered_face" || repository.identity?.device!=device
                || !BackgroundTransfers.permitted(repository.saved("background_upload"),account,device,batch))return@withLock Result.success()
            val record=repository.photoUploads() ?: return@withLock Result.success()
            record.assertOwner(repository.baseUrl,account,device)
            if(record.batch!=batch || record.finished || record.cancelled)return@withLock Result.success()
            val preferences=repository.photoPreferences()
            if(preferences["processing_consent"]!=true && preferences["processing_enabled"]!=true && !record.cancelling)return@withLock Result.failure()
            // Bounded ordinary work. The OS may stop it; each accepted chunk remains in the encrypted journal.
            withTimeout(8*60*1000L) {
                repository.resumePhotoUploads(retryFailed=false) { progress ->
                    setProgress(workDataOf("acknowledged" to progress.bytesAcknowledged,"total" to progress.bytesTotal))
                }
                val current=repository.refreshPhotoUploads()
                if(current.finished || current.cancelled)Result.success() else Result.retry()
            }
        } catch(problem: kotlinx.coroutines.TimeoutCancellationException) { if(runAttemptCount<5)Result.retry() else Result.failure(workDataOf("error" to "upload_worker_time_limit")) }
        catch(problem: CancellationException) { throw problem }
        catch(problem: LiveFailure) {
            if(runAttemptCount<5 && (problem.status==0 || problem.status>=500 || problem.code in setOf("processing_pending","upload_finalizing")))Result.retry() else Result.failure(workDataOf("error" to problem.code))
        } finally { BackgroundTransfers.finished() }
    }
}
