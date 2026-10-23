package com.lovelies.frontend.preview

import android.app.Activity
import android.content.Context
import androidx.compose.runtime.*
import com.android.billingclient.api.*
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Play supplies purchase state; only the backend supplies entitlement and acknowledgement. */
class PlayPurchases(context: Context,private val repository: CloudflareRepository,private val verified: suspend ()->Unit) {
    private val scope=CoroutineScope(SupervisorJob()+Dispatchers.Main.immediate)
    private val verification=Mutex()
    private val client=BillingClient.newBuilder(context.applicationContext)
        .setListener { result,purchases ->
            when(result.responseCode) {
                BillingClient.BillingResponseCode.OK -> scope.launch { verify(purchases.orEmpty()) }
                BillingClient.BillingResponseCode.USER_CANCELED -> status="Purchase cancelled. You have not been charged by this action."
                else -> status=billingMessage(result.responseCode)
            }
        }.enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().enablePrepaidPlans().build())
        .enableAutoServiceReconnection().build()
    data class Plan(val token: String,val title: String,val terms: String)
    val plans=mutableStateListOf<Plan>()
    var busy by mutableStateOf(false);private set
    var status by mutableStateOf("");private set
    private var owner: String?=null
    private suspend fun connection(): Boolean {
        if(client.isReady)return true
        return suspendCancellableCoroutine { continuation ->
            client.startConnection(object: BillingClientStateListener {
                override fun onBillingSetupFinished(result: BillingResult) { if(continuation.isActive)continuation.resume(result.responseCode==BillingClient.BillingResponseCode.OK) }
                override fun onBillingServiceDisconnected() { status="Google Play disconnected. Retry when it is available." }
            })
        }
    }
    private suspend fun product(): ProductDetails? {
        if(BuildConfig.PLAY_SUBSCRIPTION_PRODUCT.isBlank())throw LiveFailure("store_product_unconfigured")
        if(!connection())throw LiveFailure("store_unavailable")
        val params=QueryProductDetailsParams.newBuilder().setProductList(listOf(QueryProductDetailsParams.Product.newBuilder()
            .setProductId(BuildConfig.PLAY_SUBSCRIPTION_PRODUCT).setProductType(BillingClient.ProductType.SUBS).build())).build()
        return suspendCancellableCoroutine { continuation->client.queryProductDetailsAsync(params) { result,query->
            if(continuation.isActive) {
                if(result.responseCode==BillingClient.BillingResponseCode.OK)continuation.resume(query.productDetailsList.singleOrNull { it.productId==BuildConfig.PLAY_SUBSCRIPTION_PRODUCT })
                else continuation.resume(null)
            }
        } }
    }
    fun load() {
        if(busy)return
        val account=repository.credentials?.takeIf { it.method=="registered_face" }?.account ?: return
        owner=account;busy=true;status="Loading Google Play…"
        scope.launch {
            try {
                val product=product() ?: throw LiveFailure("store_product_unavailable")
                if(owner!=account || repository.credentials?.account!=account)return@launch
                plans.clear();plans.addAll(product.subscriptionOfferDetails.orEmpty().map { offer -> Plan(offer.offerToken,product.name,
                    offer.pricingPhases.pricingPhaseList.joinToString("; then ") { phase -> "${phase.formattedPrice} / ${phase.billingPeriod}"+(if(phase.billingCycleCount>0)" × ${phase.billingCycleCount}" else "") }) })
                status=if(plans.isEmpty())"No eligible subscription plan is available from Google Play." else "Choose a plan. Google Play shows its complete terms before you confirm."
            } catch(problem: LiveFailure) { status=readableError(problem.code) }
            finally { busy=false }
        }
    }
    fun purchase(activity: Activity,token: String) {
        if(busy)return
        val account=repository.credentials?.takeIf { it.method=="registered_face" }?.account ?: return
        owner=account;busy=true
        scope.launch {
            try {
                val product=product() ?: throw LiveFailure("store_product_unavailable")
                if(repository.credentials?.account!=account || owner!=account)throw LiveFailure("session_changed")
                if(product.subscriptionOfferDetails.orEmpty().none { it.offerToken==token })throw LiveFailure("store_offer_changed")
                val flow=BillingFlowParams.newBuilder().setProductDetailsParamsList(listOf(BillingFlowParams.ProductDetailsParams.newBuilder()
                    .setProductDetails(product).setOfferToken(token).build())).setObfuscatedAccountId(NativeProtocol.sha256(account.toByteArray())).build()
                val result=client.launchBillingFlow(activity,flow)
                status=if(result.responseCode==BillingClient.BillingResponseCode.OK)"Complete your purchase in Google Play." else billingMessage(result.responseCode)
            } catch(problem: LiveFailure) { status=readableError(problem.code) }
            finally { busy=false }
        }
    }
    fun restore() {
        if(busy)return
        val account=repository.credentials?.takeIf { it.method=="registered_face" }?.account ?: return
        owner=account;busy=true;status="Checking Google Play purchases…"
        scope.launch {
            try {
                if(!connection())throw LiveFailure("store_unavailable")
                val purchases=suspendCancellableCoroutine<List<Purchase>> { continuation->client.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.SUBS).build()) { result,rows ->
                    if(continuation.isActive) { if(result.responseCode==BillingClient.BillingResponseCode.OK)continuation.resume(rows) else continuation.resumeWithException(LiveFailure("store_unavailable")) }
                } }
                if(account!=repository.credentials?.account || owner!=account)throw LiveFailure("session_changed")
                if(purchases.isEmpty()) { verified();status="No active Google Play subscription was found for this Play account." }
                else verify(purchases)
            } catch(problem: LiveFailure) { status=readableError(problem.code) }
            finally { busy=false }
        }
    }
    private suspend fun verify(rows: List<Purchase>)=verification.withLock {
        val account=owner ?: return@withLock
        for(purchase in rows) {
            if(repository.credentials?.account!=account || repository.credentials?.method!="registered_face") { status="Sign in to the account used for this purchase, then restore.";return@withLock }
            if(BuildConfig.PLAY_SUBSCRIPTION_PRODUCT !in purchase.products)continue
            if(purchase.purchaseState==Purchase.PurchaseState.PENDING) { status="Payment is pending in Google Play. Photo access will update after verified payment.";continue }
            if(purchase.purchaseState!=Purchase.PurchaseState.PURCHASED)continue
            if(purchase.accountIdentifiers?.obfuscatedAccountId!=NativeProtocol.sha256(account.toByteArray())) { status="This purchase belongs to another Lovelies account.";continue }
            status="Verifying your purchase…"
            try {
                val result=repository.mutate("store.google",mapOf("product_id" to BuildConfig.PLAY_SUBSCRIPTION_PRODUCT,"purchase_token" to purchase.purchaseToken),"store",path="/subscriptions/google/transactions")
                if(repository.credentials?.account!=account)throw LiveFailure("session_changed")
                verified()
                status=if(result["billing_environment"]=="sandbox")"Test purchase verified. Production original access remains restricted." else "Purchase verified. Your current access is confirmed by the server."
            } catch(problem: LiveFailure) { status=readableError(problem.code)+" Restore to retry verification." }
        }
    }
    fun clearAccount() { owner=null;plans.clear();status="" }
    fun dispose() { owner=null;scope.cancel();client.endConnection() }
}
internal fun billingMessage(code: Int)=when(code) {
    BillingClient.BillingResponseCode.USER_CANCELED->"Purchase cancelled."
    BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED->"You already own this subscription. Restore purchases to verify it."
    BillingClient.BillingResponseCode.ITEM_UNAVAILABLE->"This subscription is unavailable for your Play account or region."
    BillingClient.BillingResponseCode.BILLING_UNAVAILABLE->"Google Play purchases are unavailable on this device."
    BillingClient.BillingResponseCode.NETWORK_ERROR,BillingClient.BillingResponseCode.SERVICE_UNAVAILABLE,BillingClient.BillingResponseCode.SERVICE_DISCONNECTED->"Google Play could not be reached. Check your connection and retry."
    else->"Google Play could not complete this action. Retry or restore purchases."
}
