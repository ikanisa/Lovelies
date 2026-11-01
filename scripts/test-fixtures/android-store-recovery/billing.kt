package com.android.billingclient.api

/** Controlled SDK boundary for the actual PlayPurchases caller. It performs
 * no provider requests and makes no assertion about genuine purchase validity. */
object FakePlay {
    @Volatile var purchases:List<Purchase> = emptyList()
    @Volatile var listener:((BillingResult,List<Purchase>?)->Unit)?=null
    @Volatile var holdQueries=false
    @Volatile var queries=0;private set
    @Volatile var sheets=0;private set
    @Volatile var productQueries=0;private set
    private val heldQueries=ArrayDeque<(BillingResult,List<Purchase>)->Unit>()
    @Synchronized fun reset() { purchases=emptyList();listener=null;queries=0;sheets=0;productQueries=0;holdQueries=false;heldQueries.clear() }
    fun emit(rows:List<Purchase>) { listener!!(BillingResult(0),rows) }
    fun query(callback:(BillingResult,List<Purchase>)->Unit) {
        val delayed=synchronized(this) { queries++;if(holdQueries) { heldQueries.addLast(callback);true } else false }
        if(!delayed)callback(BillingResult(0),purchases)
    }
    @Synchronized fun pendingQueries()=heldQueries.size
    fun completeQuery(rows:List<Purchase> = purchases) {
        val callback=synchronized(this) { check(heldQueries.isNotEmpty());heldQueries.removeFirst() }
        callback(BillingResult(0),rows)
    }
    @Synchronized fun queriedProduct() { productQueries++ }
    @Synchronized fun openedSheet() { sheets++ }
}
data class BillingResult(val responseCode:Int)
data class AccountIdentifiers(val obfuscatedAccountId:String?)
data class Purchase(val purchaseToken:String,val products:List<String>,val purchaseState:Int,val accountIdentifiers:AccountIdentifiers?) {
    object PurchaseState { const val PURCHASED=1;const val PENDING=2 }
}
interface BillingClientStateListener { fun onBillingSetupFinished(result:BillingResult);fun onBillingServiceDisconnected() }
class PendingPurchasesParams {
    class Builder { fun enableOneTimeProducts()=this;fun enablePrepaidPlans()=this;fun build()=PendingPurchasesParams() }
    companion object { fun newBuilder()=Builder() }
}
class QueryPurchasesParams {
    class Builder { fun setProductType(type:String)=this;fun build()=QueryPurchasesParams() }
    companion object { fun newBuilder()=Builder() }
}
class QueryProductDetailsParams {
    class Product {
        class Builder { fun setProductId(id:String)=this;fun setProductType(type:String)=this;fun build()=Product() }
        companion object { fun newBuilder()=Builder() }
    }
    class Builder { fun setProductList(rows:List<Product>)=this;fun build()=QueryProductDetailsParams() }
    companion object { fun newBuilder()=Builder() }
}
class ProductDetails(val productId:String="lovelies.pro.monthly",val name:String="Synthetic subscription") {
    data class PricingPhase(val formattedPrice:String="Fixture",val billingPeriod:String="P1M",val billingCycleCount:Int=0)
    data class PricingPhases(val pricingPhaseList:List<PricingPhase> = listOf(PricingPhase()))
    data class SubscriptionOfferDetails(val offerToken:String="fixture-offer",val pricingPhases:PricingPhases=PricingPhases())
    val subscriptionOfferDetails:List<SubscriptionOfferDetails> = listOf(SubscriptionOfferDetails())
}
data class ProductQuery(val productDetailsList:List<ProductDetails>)
class BillingFlowParams {
    class ProductDetailsParams {
        class Builder { fun setProductDetails(value:ProductDetails)=this;fun setOfferToken(token:String)=this;fun build()=ProductDetailsParams() }
        companion object { fun newBuilder()=Builder() }
    }
    class Builder { fun setProductDetailsParamsList(rows:List<ProductDetailsParams>)=this;fun setObfuscatedAccountId(id:String)=this;fun build()=BillingFlowParams() }
    companion object { fun newBuilder()=Builder() }
}
class BillingClient {
    val isReady=true
    fun startConnection(listener:BillingClientStateListener) { listener.onBillingSetupFinished(BillingResult(0)) }
    fun queryProductDetailsAsync(params:QueryProductDetailsParams,callback:(BillingResult,ProductQuery)->Unit) { FakePlay.queriedProduct();callback(BillingResult(0),ProductQuery(listOf(ProductDetails()))) }
    fun queryPurchasesAsync(params:QueryPurchasesParams,callback:(BillingResult,List<Purchase>)->Unit) { FakePlay.query(callback) }
    fun launchBillingFlow(activity:android.app.Activity,params:BillingFlowParams):BillingResult { FakePlay.openedSheet();return BillingResult(0) }
    fun endConnection() {}
    class Builder {
        fun setListener(value:(BillingResult,List<Purchase>?)->Unit)=apply { FakePlay.listener=value }
        fun enablePendingPurchases(params:PendingPurchasesParams)=this
        fun enableAutoServiceReconnection()=this
        fun build()=BillingClient()
    }
    object ProductType { const val SUBS="subs" }
    object BillingResponseCode { const val OK=0;const val USER_CANCELED=1;const val ITEM_ALREADY_OWNED=7;const val ITEM_UNAVAILABLE=4
        const val BILLING_UNAVAILABLE=3;const val NETWORK_ERROR=12;const val SERVICE_UNAVAILABLE=2;const val SERVICE_DISCONNECTED=-1 }
    companion object { fun newBuilder(context:android.content.Context)=Builder() }
}
