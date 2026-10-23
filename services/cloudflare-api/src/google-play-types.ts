/** Google Play provider response/credential types used by the active verifier.
 * Kept locally so the retired router is not a compile-time dependency. */
export interface GooglePlayMoney {
  units?: string;
  nanos?: number;
  currencyCode?: string;
}

export interface GooglePlaySubscriptionLineItem {
  productId?: string;
  expiryTime?: string;
  latestSuccessfulOrderId?: string;
  autoRenewingPlan?: {
    autoRenewEnabled?: boolean;
    recurringPrice?: GooglePlayMoney;
  };
  prepaidPlan?: Record<string, unknown>;
  offerDetails?: {
    basePlanId?: string;
    offerId?: string;
    offerTags?: string[];
  };
}

export interface GooglePlaySubscriptionPurchase {
  kind?: string;
  regionCode?: string;
  startTime?: string;
  subscriptionState?: string;
  latestOrderId?: string;
  linkedPurchaseToken?: string;
  acknowledgementState?: string;
  externalAccountIdentifiers?: {
    externalAccountId?: string;
    obfuscatedExternalAccountId?: string;
    obfuscatedExternalProfileId?: string;
  };
  outOfAppPurchaseContext?: {
    expiredPurchaseToken?: string;
    expiredExternalAccountIdentifiers?: {
      obfuscatedExternalAccountId?: string;
      obfuscatedExternalProfileId?: string;
    };
  };
  lineItems?: GooglePlaySubscriptionLineItem[];
  testPurchase?: Record<string, unknown>;
}

export interface GooglePlaySubscriptionVerifier {
  getSubscription(input: {
    packageName: string;
    purchaseToken: string;
  }): Promise<GooglePlaySubscriptionPurchase>;
  acknowledge(input: {
    packageName: string;
    productId: string;
    purchaseToken: string;
    obfuscatedAccountId?: string;
  }): Promise<void>;
}

export interface GooglePlayServiceAccountCredentials {
  clientEmail: string;
  privateKey: string;
  privateKeyId?: string;
}

