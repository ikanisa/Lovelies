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
    private val context=context.applicationContext
    private val scope=CoroutineScope(SupervisorJob()+Dispatchers.Main.immediate)
    private val verification=Mutex()
    private var sheetInFlight=false
    private val client=BillingClient.newBuilder(context.applicationContext)
        .setListener { result,purchases ->
            sheetInFlight=false
            when(result.responseCode) {
                BillingClient.BillingResponseCode.OK -> scope.launch { verify(purchases.orEmpty()) }
                BillingClient.BillingResponseCode.USER_CANCELED -> status=context.getString(R.string.controller_bb1d294c8d56)
                else -> status=billingMessage(result.responseCode,context)
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
                override fun onBillingServiceDisconnected() { status=context.getString(R.string.controller_311651867b2f) }
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
        owner=account;busy=true;status=context.getString(R.string.controller_b7dd6131b8f4)
        scope.launch {
            try {
                val product=product() ?: throw LiveFailure("store_product_unavailable")
                if(owner!=account || repository.credentials?.account!=account)return@launch
                plans.clear();plans.addAll(product.subscriptionOfferDetails.orEmpty().map { offer -> Plan(offer.offerToken,product.name,
                    offer.pricingPhases.pricingPhaseList.joinToString(context.getString(R.string.controller_43a45b864afc)) { phase -> "${phase.formattedPrice} / ${phase.billingPeriod}"+(if(phase.billingCycleCount>0)" × ${phase.billingCycleCount}" else "") }) })
                status=if(plans.isEmpty())context.getString(R.string.controller_2d3b500866f8) else context.getString(R.string.controller_c5dd9ec980ef)
            } catch(problem: LiveFailure) { status=readableError(problem.code,context) }
            finally { busy=false }
        }
    }
    fun purchase(activity: Activity,token: String) {
        if(busy || sheetInFlight)return
        val account=repository.credentials?.takeIf { it.method=="registered_face" }?.account ?: return
        owner=account;busy=true
        scope.launch {
            try {
                // Reconcile the original store operation before opening another provider sheet.
                if(repository.recoverGooglePurchase()!=null)verified()
                if(repository.credentials?.account!=account || owner!=account)throw LiveFailure("session_changed")
                if(!connection())throw LiveFailure("store_unavailable")
                val existing=existingPurchases().filter { BuildConfig.PLAY_SUBSCRIPTION_PRODUCT in it.products }
                if(repository.credentials?.account!=account || owner!=account)throw LiveFailure("session_changed")
                if(existing.isNotEmpty()) { verify(existing);return@launch }
                val product=product() ?: throw LiveFailure("store_product_unavailable")
                if(repository.credentials?.account!=account || owner!=account)throw LiveFailure("session_changed")
                if(product.subscriptionOfferDetails.orEmpty().none { it.offerToken==token })throw LiveFailure("store_offer_changed")
                val flow=BillingFlowParams.newBuilder().setProductDetailsParamsList(listOf(BillingFlowParams.ProductDetailsParams.newBuilder()
                    .setProductDetails(product).setOfferToken(token).build())).setObfuscatedAccountId(NativeProtocol.sha256(account.toByteArray())).build()
                val result=client.launchBillingFlow(activity,flow)
                sheetInFlight=result.responseCode==BillingClient.BillingResponseCode.OK
                status=if(result.responseCode==BillingClient.BillingResponseCode.OK)context.getString(R.string.controller_0d9613931369) else billingMessage(result.responseCode,context)
            } catch(problem: LiveFailure) { status=readableError(problem.code,context) }
            finally { busy=false }
        }
    }
    private suspend fun existingPurchases(): List<Purchase> = suspendCancellableCoroutine { continuation->
        client.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.SUBS).build()) { result,rows ->
            if(continuation.isActive) {
                if(result.responseCode==BillingClient.BillingResponseCode.OK)continuation.resume(rows)
                else continuation.resumeWithException(LiveFailure("store_unavailable"))
            }
        }
    }
    fun restore() {
        if(busy)return
        val account=repository.credentials?.takeIf { it.method=="registered_face" }?.account ?: return
        owner=account;busy=true;status=context.getString(R.string.controller_ca350dda4dc7)
        scope.launch {
            try {
                val recovered=repository.recoverGooglePurchase()
                if(account!=repository.credentials?.account || owner!=account)throw LiveFailure("session_changed")
                if(recovered!=null)verified()
                if(!connection())throw LiveFailure("store_unavailable")
                val purchases=existingPurchases()
                if(account!=repository.credentials?.account || owner!=account)throw LiveFailure("session_changed")
                if(purchases.isEmpty()) { verified();status=context.getString(R.string.controller_7bc8522e0cb4) }
                else verify(purchases)
            } catch(problem: LiveFailure) { status=readableError(problem.code,context) }
            finally { busy=false }
        }
    }
    private suspend fun verify(rows: List<Purchase>)=verification.withLock {
        val account=owner ?: return@withLock
        for(purchase in rows) {
            if(repository.credentials?.account!=account || repository.credentials?.method!="registered_face") { status=context.getString(R.string.controller_4f6eed6a9fe6);return@withLock }
            if(BuildConfig.PLAY_SUBSCRIPTION_PRODUCT !in purchase.products)continue
            if(purchase.purchaseState==Purchase.PurchaseState.PENDING) { status=context.getString(R.string.controller_04a714d06d40);continue }
            if(purchase.purchaseState!=Purchase.PurchaseState.PURCHASED)continue
            if(purchase.accountIdentifiers?.obfuscatedAccountId!=NativeProtocol.sha256(account.toByteArray())) { status=context.getString(R.string.controller_04cb36080a3e);continue }
            status=context.getString(R.string.controller_e5581cbfef39)
            try {
                val result=repository.verifyGooglePurchase(BuildConfig.PLAY_SUBSCRIPTION_PRODUCT,purchase.purchaseToken)
                if(repository.credentials?.account!=account)throw LiveFailure("session_changed")
                verified()
                status=if(result["billing_environment"]=="sandbox")context.getString(R.string.controller_7baa8299b4a7) else context.getString(R.string.controller_846e2c78f9fc)
            } catch(problem: LiveFailure) { status=readableError(problem.code,context)+context.getString(R.string.controller_d5bc59f2366c) }
        }
    }
    fun clearAccount() { sheetInFlight=false;owner=null;plans.clear();status="" }
    fun dispose() { sheetInFlight=false;owner=null;scope.cancel();client.endConnection() }
}
internal fun billingMessage(code: Int,context: Context)=when(code) {
    BillingClient.BillingResponseCode.USER_CANCELED->context.getString(R.string.controller_acc527e9244f)
    BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED->context.getString(R.string.controller_ec3bb17ddb0a)
    BillingClient.BillingResponseCode.ITEM_UNAVAILABLE->context.getString(R.string.controller_4161e060779d)
    BillingClient.BillingResponseCode.BILLING_UNAVAILABLE->context.getString(R.string.controller_0f2a4fcc93e6)
    BillingClient.BillingResponseCode.NETWORK_ERROR,BillingClient.BillingResponseCode.SERVICE_UNAVAILABLE,BillingClient.BillingResponseCode.SERVICE_DISCONNECTED->context.getString(R.string.controller_f81e04a747c2)
    else->context.getString(R.string.controller_47fb027a47f9)
}
