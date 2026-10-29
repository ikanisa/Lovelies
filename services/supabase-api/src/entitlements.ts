import { accountRoles } from './auth.ts';
import { ApiError, digest, jsonBody, ok, record, stable, uuid, type Actor, type AppContext, type Database } from './types.ts';
import { assertOperationReceiptAvailable, assertRegisteredActor, executeOperation, prepareOperation, retiredOperationInput, retiredOperationResponse, type PreparedOperation } from './operations.ts';
import { parseMediaAuthority, protectedRendition, type Asset, type MediaAuthority } from './gallery.ts';
import { mediaHeld } from './operators.ts';
import { enqueueNotification } from './notifications.ts';
import { assertStoreAuthorityFresh, storeAuthorityDeadlines, type StoreAuthorityDeadlines } from './store-authority.ts';
// Pure provider cryptography/API helpers only; no historical router or database adapter.
import { Buffer } from 'node:buffer';
import type { GooglePlayServiceAccountCredentials, GooglePlaySubscriptionVerifier } from './google-play-types.ts';
// Exact published Apple root bytes borrowed from api-worker/src/apple_store.ts;
// product and app identity are explicit deployment configuration, never donor defaults.
const appleRootCertificates = [
    {
        sha256: "B0:B1:73:0E:CB:C7:FF:45:05:14:2C:49:F1:29:5E:6E:DA:6B:CA:ED:7E:2C:68:C5:BE:91:B5:A1:10:01:F0:24",
        der: "MIIEuzCCA6OgAwIBAgIBAjANBgkqhkiG9w0BAQUFADBiMQswCQYDVQQGEwJVUzETMBEGA1UEChMKQXBwbGUgSW5jLjEmMCQGA1UECxMdQXBwbGUgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkxFjAUBgNVBAMTDUFwcGxlIFJvb3QgQ0EwHhcNMDYwNDI1MjE0MDM2WhcNMzUwMjA5MjE0MDM2WjBiMQswCQYDVQQGEwJVUzETMBEGA1UEChMKQXBwbGUgSW5jLjEmMCQGA1UECxMdQXBwbGUgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkxFjAUBgNVBAMTDUFwcGxlIFJvb3QgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDkkakJH5HbHkdQ6wXtXnmELes2oldMVeyLGYne+Uts9QerIjAC6Bg++FAJ039BqJj50cpmnCRrEdCju+QbKsMflZ56DKRHi1vUFjczy8QPTc4UadHJGXL1XQ7Vf1+b8iUDulWPTV0N8WQ1IxVLFVkds5T39pyez1C6wVhQZ48ItCD3y6wsIG9wtj8BMIy3Q88PnT3zK0koGsj+zrW5DtleHNbLPbU6rfQPDgCSC7EhFi501TwN22IWq6NxkkdTVcGvL0Gz+PvjcM3mo0xFfh9Ma1CWQYnEdGILEINBhzOKgbEwWOxaBDKMaLOPHd5lc/9nXmW8Sdh2nzMUZaF3lMktAgMBAAGjggF6MIIBdjAOBgNVHQ8BAf8EBAMCAQYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUK9BpR5R2Cf70a40uQKb3R01/CF4wHwYDVR0jBBgwFoAUK9BpR5R2Cf70a40uQKb3R01/CF4wggERBgNVHSAEggEIMIIBBDCCAQAGCSqGSIb3Y2QFATCB8jAqBggrBgEFBQcCARYeaHR0cHM6Ly93d3cuYXBwbGUuY29tL2FwcGxlY2EvMIHDBggrBgEFBQcCAjCBthqBs1JlbGlhbmNlIG9uIHRoaXMgY2VydGlmaWNhdGUgYnkgYW55IHBhcnR5IGFzc3VtZXMgYWNjZXB0YW5jZSBvZiB0aGUgdGhlbiBhcHBsaWNhYmxlIHN0YW5kYXJkIHRlcm1zIGFuZCBjb25kaXRpb25zIG9mIHVzZSwgY2VydGlmaWNhdGUgcG9saWN5IGFuZCBjZXJ0aWZpY2F0aW9uIHByYWN0aWNlIHN0YXRlbWVudHMuMA0GCSqGSIb3DQEBBQUAA4IBAQBcNplMLXi37Yyb3PN3m/J20ncwT8EfhYOFG5k9RzfyqZtAjizUsZAS2L70c5vu0mQPy3lPNNiiPvl4/2vIB+x9OYOLUyDTOMSxv5pPCmv/K/xZpwUJfBdAVhEedNO3iyM7R6PVbyTi69G3cN8PReEnyvFteO3ntRcXqNx+IjXKJdXZD9Zr1KIkIxH3oayPc4FgxhtbCS+SsvhESPBgOJ4V9T0mZyCKM2r3DYLP3uujL/lTaltkwGMzd/c6ByxW69oPIQ7aunMZT7XZNn/Bh1XZp5m5MkL72NVxnn6hUrcbvZNCJBIqxw8dtk2cXmPIS4AXUKqK1drk/NAJBzewdXUh",
    },
    {
        sha256: "C2:B9:B0:42:DD:57:83:0E:7D:11:7D:AC:55:AC:8A:E1:94:07:D3:8E:41:D8:8F:32:15:BC:3A:89:04:44:A0:50",
        der: "MIIFkjCCA3qgAwIBAgIIAeDltYNno+AwDQYJKoZIhvcNAQEMBQAwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEcyMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMwMTgxMDA5WhcNMzkwNDMwMTgxMDA5WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzIxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBANgREkhI2imKScUcx+xuM23+TfvgHN6sXuI2pyT5f1BrTM65MFQn5bPW7SXmMLYFN14UIhHF6Kob0vuy0gmVOKTvKkmMXT5xZgM4+xb1hYjkWpIMBDLyyED7Ul+f9sDx47pFoFDVEovy3d6RhiPw9bZyLgHaC/YuOQhfGaFjQQscp5TBhsRTL3b2CtcM0YM/GlMZ81fVJ3/8E7j4ko380yhDPLVoACVdJ2LT3VXdRCCQgzWTxb+4Gftr49wIQuavbfqeQMpOhYV4SbHXw8EwOTKrfl+q04tvny0aIWhwZ7Oj8ZhBbZF8+NfbqOdfIRqMM78xdLe40fTgIvS/cjTf94FNcX1RoeKz8NMoFnNvzcytN31O661A4T+B/fc9Cj6i8b0xlilZ3MIZgIxbdMYs0xBTJh0UT8TUgWY8h2czJxQI6bR3hDRSj4n4aJgXv8O7qhOTH11UL6jHfPsNFL4VPSQ08prcdUFmIrQB1guvkJ4M6mL4m1k8COKWNORj3rw31OsMiANDC1CvoDTdUE0V+1ok2Az6DGOeHwOx4e7hqkP0ZmUoNwIx7wHHHtHMn23KVDpA287PT0aLSmWaasZobNfMmRtHsHLDd4/E92GcdB/O/WuhwpyUgquUoue9G7q5cDmVF8Up8zlYNPXEpMZ7YLlmQ1A/bmH8DvmGqmAMQ0uVAgMBAAGjQjBAMB0GA1UdDgQWBBTEmRNsGAPCe8CjoA1/coB6HHcmjTAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjANBgkqhkiG9w0BAQwFAAOCAgEAUabz4vS4PZO/Lc4Pu1vhVRROTtHlznldgX/+tvCHM/jvlOV+3Gp5pxy+8JS3ptEwnMgNCnWefZKVfhidfsJxaXwU6s+DDuQUQp50DhDNqxq6EWGBeNjxtUVAeKuowM77fWM3aPbn+6/Gw0vsHzYmE1SGlHKy6gLti23kDKaQwFd1z4xCfVzmMX3zybKSaUYOiPjjLUKyOKimGY3xn83uamW8GrAlvacp/fQ+onVJv57byfenHmOZ4VxG/5IFjPoeIPmGlFYl5bRXOJ3riGQUIUkhOb9iZqmxospvPyFgxYnURTbImHy99v6ZSYA7LNKmp4gDBDEZt7Y6YUX6yfIjyGNzv1aJMbDZfGKnexWoiIqrOEDCzBL/FePwN983csvMmOa/orz6JopxVtfnJBtIRD6e/J/JzBrsQzwBvDR4yGn1xuZW7AYJNpDrFEobXsmII9oDMJELuDY++ee1KG++P+w8j2Ud5cAeh6Squpj9kuNsJnfdBrRkBof0Tta6SqoWqPQFZ2aWuuJVecMsXUmPgEkrihLHdoBR37q9ZV0+N0djMenl9MU/S60EinpxLK8JQzcPqOMyT/RFtm2XNuyE9QoB6he7hY1Ck3DDUOUUi78/w0EP3SIEIwiKum1xRKtzCTrJ+VKACd+66eYWyi4uTLLT3OUEVLLUNIAytbwPF+E=",
    },
    {
        sha256: "63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79",
        der: "MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtfTjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySrMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM6BgD56KyKA==",
    },
] as const;
export const entitlementsSchemaStatements: readonly string[] = [
    `CREATE TABLE IF NOT EXISTS store_subscriptions(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),provider TEXT NOT NULL CHECK(provider IN('apple','google')),app_identity TEXT NOT NULL,original_id TEXT NOT NULL,product_id TEXT NOT NULL,billing_environment TEXT NOT NULL CHECK(billing_environment IN('production','sandbox')),active INTEGER NOT NULL CHECK(active IN(0,1)),starts_at INTEGER NOT NULL,expires_at INTEGER NOT NULL CHECK(expires_at>starts_at),observed_at INTEGER NOT NULL,transaction_id TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,acknowledged INTEGER NOT NULL DEFAULT 1 CHECK(acknowledged IN(0,1)),UNIQUE(provider,billing_environment,original_id))`,
    `CREATE TABLE IF NOT EXISTS store_transactions(id TEXT PRIMARY KEY,subscription_id TEXT NOT NULL REFERENCES store_subscriptions(id),account_id TEXT NOT NULL REFERENCES accounts(id),provider TEXT NOT NULL,transaction_id TEXT NOT NULL,billing_environment TEXT NOT NULL,product_id TEXT NOT NULL,starts_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,observed_at INTEGER NOT NULL,payload_hash TEXT NOT NULL,active INTEGER NOT NULL,financial_eligible INTEGER NOT NULL CHECK(financial_eligible IN(0,1)),UNIQUE(provider,billing_environment,transaction_id))`,
    `CREATE TABLE IF NOT EXISTS store_notifications(provider TEXT NOT NULL,event_id TEXT NOT NULL,payload_hash TEXT NOT NULL,account_id TEXT REFERENCES accounts(id),status TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(provider,event_id))`,
    `CREATE TABLE IF NOT EXISTS download_tickets(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),session_id TEXT NOT NULL REFERENCES sessions(id),asset_id TEXT NOT NULL REFERENCES assets(id),asset_version TEXT NOT NULL,source_checksum TEXT NOT NULL,subscription_id TEXT NOT NULL REFERENCES store_subscriptions(id),subscription_version INTEGER NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,authority_json TEXT CHECK(authority_json IS NULL OR (json_valid(authority_json) AND json_type(authority_json)='object')))`,
    `CREATE TABLE IF NOT EXISTS download_records(id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL UNIQUE,account_id TEXT NOT NULL REFERENCES accounts(id),asset_id TEXT NOT NULL REFERENCES assets(id),subscription_id TEXT NOT NULL REFERENCES store_subscriptions(id),created_at INTEGER NOT NULL,financial_eligible INTEGER NOT NULL CHECK(financial_eligible IN(0,1)))`,
    `CREATE INDEX IF NOT EXISTS store_account ON store_subscriptions(account_id,active,expires_at)`,
];
export async function initEntitlementsSchema(db: Database): Promise<void> { for (const sql of entitlementsSchemaStatements)
    (await db.run(sql)); }
type VerifiedPurchase = {
    provider: 'apple' | 'google';
    app: string;
    account: string;
    original: string;
    transaction: string;
    product: string;
    environment: 'production' | 'sandbox';
    starts: number;
    expires: number;
    observed: number;
    active: boolean;
    hash: string;
    acknowledged: boolean;
};
function exact(body: Record<string, unknown>, keys: string[]): void { if (Object.keys(body).some(key => !keys.includes(key)))
    throw new ApiError(400, 'invalid_store_input'); }
function sourceString(value: unknown, max = 160): string { if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u0020]/.test(value))
    throw new ApiError(422, 'store_receipt_incomplete'); return value; }
async function accountCurrent(ctx: AppContext, id: string): Promise<void> { if (!(await ctx.db.one("SELECT id FROM accounts WHERE id=? AND identity_state='registered_face' AND disabled_at IS NULL", id)))
    throw new ApiError(403, 'store_account_unavailable'); }
async function privateVerifier(ctx: AppContext, kind: string, input: Record<string, unknown>): Promise<any> {
    const inputHash = await digest(stable(input));
    let response: Response;
    try { response = await ctx.env.STORE_VERIFIER!.fetch('https://store-verifier.internal/' + kind, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: stable({ protocol: 'lovelies-store-verifier-v1', input_hash: inputHash, input }) }); }
    catch (error) {
        if (error instanceof ApiError && error.status >= 500) throw error;
        // No response is not proof that verification/acknowledgement was not
        // dispatched. Report availability without claiming retry safety.
        throw new ApiError(503, 'store_verifier_unavailable');
    }
    if (response.redirected || response.status >= 300 && response.status < 400)
        throw new ApiError(503, 'store_provider_redirect_denied');
    if (!response.ok)
        throw new ApiError(response.status >= 500 ? 503 : 422, 'store_verification_failed');
    let receipt: Record<string, any>;
    try { receipt = await jsonBody(response, 131072); }
    catch (error) {
        if (error instanceof ApiError && error.status >= 500) throw error;
        throw new ApiError(503, 'store_verifier_receipt_unavailable');
    }
    if (receipt.protocol !== 'lovelies-store-verifier-v1' || receipt.input_hash !== inputHash || receipt.verified !== true || !receipt.payload)
        throw new ApiError(422, 'store_verification_unbound');
    return record(receipt.payload);
}
function appleConfigured(ctx: AppContext): {
    bundleId: string;
    appId: number;
    productId: string;
} {
    const bundleId = ctx.env.APPLE_BUNDLE_ID, productId = ctx.env.APPLE_SUBSCRIPTION_PRODUCT_ID, appId = Number(ctx.env.APPLE_APP_ID);
    if (typeof bundleId !== 'string' || !/^[-A-Za-z0-9.]{3,160}$/.test(bundleId) || typeof productId !== 'string' || !/^[-A-Za-z0-9._]{3,160}$/.test(productId) || !/^\d+$/.test(ctx.env.APPLE_APP_ID ?? '') || !Number.isSafeInteger(appId) || appId <= 0)
        throw new ApiError(503, 'apple_verifier_unconfigured');
    return { bundleId, appId, productId };
}
async function configuredAppleDecode(ctx: AppContext, kind: 'transaction' | 'notification' | 'renewal', signed: string): Promise<any> {
    const configured = appleConfigured(ctx);
    // Lazy import avoids the package's module-time random initialization outside a request.
    const { Environment, SignedDataVerifier } = await import('@apple/app-store-server-library');
    const roots = appleRootCertificates.map(certificate => Buffer.from(certificate.der, 'base64'));
    const production = new SignedDataVerifier(roots, true, Environment.PRODUCTION, configured.bundleId, configured.appId);
    const sandbox = new SignedDataVerifier(roots, true, Environment.SANDBOX, configured.bundleId);
    const decode = (verifier: InstanceType<typeof SignedDataVerifier>) => kind === 'transaction' ? verifier.verifyAndDecodeTransaction(signed) : kind === 'notification' ? verifier.verifyAndDecodeNotification(signed) : verifier.verifyAndDecodeRenewalInfo(signed);
    try {
        return await decode(production);
    }
    catch (productionError) {
        try {
            return await decode(sandbox);
        }
        catch {
            throw productionError;
        }
    }
}
function googleVerifier(ctx: AppContext) {
    if (!/^[-A-Za-z0-9.]{3,160}$/.test(ctx.env.GOOGLE_PLAY_PACKAGE_NAME ?? '') || !/^[-A-Za-z0-9._]{3,160}$/.test(ctx.env.GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID ?? ''))
        throw new ApiError(503, 'google_play_verifier_unconfigured');
    if (ctx.env.STORE_VERIFIER)
        return { getSubscription: async (input: any) => privateVerifier(ctx, 'google/subscription', input), acknowledge: async (input: any) => { await privateVerifier(ctx, 'google/acknowledge', input); } };
    if (!ctx.env.GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL || !ctx.env.GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY)
        throw new ApiError(503, 'google_play_verifier_unconfigured');
    const verifier = configuredGoogleVerifier({ clientEmail: ctx.env.GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL, privateKey: ctx.env.GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY, privateKeyId: ctx.env.GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY_ID });
    const checked = async <T>(call: () => Promise<T>): Promise<T> => { try {
        return await call();
    }
    catch (error) {
        if (error instanceof ApiError)
            throw error;
        const status = (error as {
            status?: number;
        }).status;
        throw new ApiError(status && status >= 400 && status < 500 ? 422 : 503, 'google_play_verification_unavailable');
    } };
    return { getSubscription: (input: Parameters<GooglePlaySubscriptionVerifier['getSubscription']>[0]) => checked(() => verifier.getSubscription(input)), acknowledge: (input: Parameters<GooglePlaySubscriptionVerifier['acknowledge']>[0]) => checked(() => verifier.acknowledge(input)) };
}
async function appleDecode(ctx: AppContext, kind: 'transaction' | 'notification' | 'renewal', signed: string): Promise<any> {
    const configured = appleConfigured(ctx);
    if (signed.length > 65536 || signed.split('.').length !== 3)
        throw new ApiError(422, 'invalid_apple_signed_payload');
    try {
        if (ctx.env.STORE_VERIFIER)
            return await privateVerifier(ctx, 'apple/' + kind, { signed_payload: signed, bundle_id: configured.bundleId, app_id: configured.appId, product_id: configured.productId });
        return await configuredAppleDecode(ctx, kind, signed);
    }
    catch (error) {
        if (error instanceof ApiError)
            throw error;
        throw new ApiError(422, 'invalid_apple_signed_payload');
    }
}
async function applePurchase(ctx: AppContext, tx: any, hash: string, account: string, observed?: number, grace?: number): Promise<VerifiedPurchase> {
    const configured = appleConfigured(ctx);
    if (tx.bundleId !== configured.bundleId || tx.productId !== configured.productId || tx.type !== 'Auto-Renewable Subscription' || tx.inAppOwnershipType !== 'PURCHASED')
        throw new ApiError(422, 'apple_product_mismatch');
    if (uuid(tx.appAccountToken) !== account)
        throw new ApiError(403, 'apple_account_mismatch');
    if (!['Production', 'Sandbox'].includes(tx.environment) || !Number.isSafeInteger(tx.purchaseDate) || !Number.isSafeInteger(tx.expiresDate) || tx.expiresDate <= tx.purchaseDate)
        throw new ApiError(422, 'apple_period_invalid');
    const seen = observed ?? tx.signedDate ?? tx.purchaseDate;
    if (!Number.isSafeInteger(seen) || seen > ctx.now() + 300000)
        throw new ApiError(422, 'store_observation_invalid');
    const expires = Math.max(tx.expiresDate, grace ?? 0);
    return { provider: 'apple', app: configured.bundleId + ':' + configured.appId, account, original: sourceString(tx.originalTransactionId), transaction: sourceString(tx.transactionId), product: tx.productId, environment: tx.environment === 'Production' ? 'production' : 'sandbox', starts: tx.purchaseDate, expires, observed: seen, active: expires > ctx.now() && tx.revocationDate == null && tx.isUpgraded !== true, hash, acknowledged: true };
}
async function googlePurchase(ctx: AppContext, purchase: any, token: string, account: string, observed: number): Promise<VerifiedPurchase> {
    if (purchase.kind !== 'androidpublisher#subscriptionPurchaseV2')
        throw new ApiError(422, 'google_environment_ambiguous');
    if (Object.hasOwn(purchase, 'testPurchase') && (!purchase.testPurchase || typeof purchase.testPurchase !== 'object' || Array.isArray(purchase.testPurchase)))
        throw new ApiError(422, 'google_environment_ambiguous');
    const states = ['SUBSCRIPTION_STATE_UNSPECIFIED', 'SUBSCRIPTION_STATE_PENDING', 'SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_PAUSED', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'SUBSCRIPTION_STATE_ON_HOLD', 'SUBSCRIPTION_STATE_CANCELED', 'SUBSCRIPTION_STATE_EXPIRED', 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED'];
    if (!states.includes(purchase.subscriptionState))
        throw new ApiError(422, 'google_state_unsupported');
    const item = purchase.lineItems?.find((item: any) => item.productId === ctx.env.GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID);
    if (!item)
        throw new ApiError(422, 'google_product_mismatch');
    const expected = await digest(account), current = purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId, previous = purchase.outOfAppPurchaseContext?.expiredExternalAccountIdentifiers?.obfuscatedExternalAccountId;
    if (current != null && current !== expected || previous != null && previous !== expected)
        throw new ApiError(403, 'google_account_mismatch');
    if (current !== expected) {
        const old = purchase.outOfAppPurchaseContext?.expiredPurchaseToken;
        if (typeof old !== 'string')
            throw new ApiError(403, 'google_account_mismatch');
        const oldHash = await digest(old);
        if (!(await ctx.db.one("SELECT id FROM store_subscriptions WHERE provider='google' AND original_id=? AND account_id=?", oldHash, account)))
            throw new ApiError(403, 'google_account_mismatch');
    }
    const starts = Date.parse(purchase.startTime), expires = Date.parse(item.expiryTime);
    if (!Number.isFinite(starts) || !Number.isFinite(expires) || expires <= starts)
        throw new ApiError(422, 'google_period_invalid');
    const hash = await digest(token);
    return { provider: 'google', app: ctx.env.GOOGLE_PLAY_PACKAGE_NAME!, account, original: hash, transaction: sourceString(item.latestSuccessfulOrderId ?? purchase.latestOrderId ?? hash), product: ctx.env.GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID!, environment: Object.hasOwn(purchase, 'testPurchase') ? 'sandbox' : 'production', starts, expires, observed, active: expires > ctx.now() && ['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'SUBSCRIPTION_STATE_CANCELED'].includes(purchase.subscriptionState), hash: await digest(stable(purchase)), acknowledged: purchase.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' };
}
/** Synchronous provider/account/lineage/ordering authority. An older receipt
 * never reactivates a revoked newer subscription or crosses account ownership. */
export async function persistVerifiedPurchase(ctx: AppContext, value: VerifiedPurchase): Promise<Record<string, unknown>> {
    (await accountCurrent(ctx, value.account));
    const prior = (await ctx.db.one<any>('SELECT * FROM store_subscriptions WHERE provider=? AND billing_environment=? AND original_id=?', value.provider, value.environment, value.original));
    if (prior && (prior.account_id !== value.account || prior.app_identity !== value.app || prior.product_id !== value.product))
        throw new ApiError(403, 'store_original_owner_conflict');
    const transaction = (await ctx.db.one<any>('SELECT account_id,subscription_id FROM store_transactions WHERE provider=? AND billing_environment=? AND transaction_id=?', value.provider, value.environment, value.transaction));
    if (transaction && (transaction.account_id !== value.account || transaction.subscription_id !== prior?.id))
        throw new ApiError(403, 'store_transaction_owner_conflict');
    const stale = !!prior && (value.observed < prior.observed_at || value.observed === prior.observed_at && prior.active === 0 && value.active);
    const id = prior?.id ?? crypto.randomUUID();
    if (!prior)
        (await ctx.db.run('INSERT INTO store_subscriptions(id,account_id,provider,app_identity,original_id,product_id,billing_environment,active,starts_at,expires_at,observed_at,transaction_id,acknowledged) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', id, value.account, value.provider, value.app, value.original, value.product, value.environment, value.active ? 1 : 0, value.starts, value.expires, value.observed, value.transaction, value.acknowledged ? 1 : 0));
    else if (!stale)
        (await ctx.db.run('UPDATE store_subscriptions SET active=?,starts_at=?,expires_at=?,observed_at=?,transaction_id=?,acknowledged=?,version=version+1 WHERE id=?', value.active ? 1 : 0, value.starts, value.expires, value.observed, value.transaction, value.acknowledged ? 1 : 0, id));
    if (!stale)
        (await ctx.db.run('INSERT INTO store_transactions(id,subscription_id,account_id,provider,transaction_id,billing_environment,product_id,starts_at,expires_at,observed_at,payload_hash,active,financial_eligible) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider,billing_environment,transaction_id) DO UPDATE SET expires_at=excluded.expires_at,observed_at=excluded.observed_at,payload_hash=excluded.payload_hash,active=excluded.active', crypto.randomUUID(), id, value.account, value.provider, value.transaction, value.environment, value.product, value.starts, value.expires, value.observed, value.hash, value.active ? 1 : 0, value.environment === 'production' ? 1 : 0));
    const row = (await ctx.db.one<any>('SELECT * FROM store_subscriptions WHERE id=?', id))!;
    return { active: row.active === 1 && row.expires_at > ctx.now(), provider: value.provider === 'apple' ? 'apple_app_store' : 'google_play', product_id: row.product_id, transaction_id: row.transaction_id, original_transaction_id: row.original_id, expires_at: new Date(row.expires_at).toISOString(), billing_environment: row.billing_environment, financial_eligible: row.billing_environment === 'production', stale };
}
export async function entitlementSummary(ctx: AppContext, actor: Actor): Promise<Record<string, unknown>> {
    (await assertRegisteredActor(ctx, actor));
    let appleIdentity = '';
    try {
        const configured = appleConfigured(ctx);
        appleIdentity = configured.bundleId + ':' + configured.appId;
    }
    catch (error) {
        if (!(error instanceof ApiError) || error.status !== 503)
            throw error;
    }
    const subscription = (await ctx.db.one<any>("SELECT id,provider,product_id,starts_at,expires_at,version FROM store_subscriptions WHERE account_id=? AND billing_environment='production' AND active=1 AND acknowledged=1 AND starts_at<=? AND expires_at>? AND ((provider='apple' AND app_identity=? AND product_id=?) OR (provider='google' AND app_identity=? AND product_id=?)) ORDER BY expires_at DESC,id LIMIT 1", actor.accountId, ctx.now(), ctx.now(), appleIdentity, ctx.env.APPLE_SUBSCRIPTION_PRODUCT_ID ?? '', ctx.env.GOOGLE_PLAY_PACKAGE_NAME ?? '', ctx.env.GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID ?? ''));
    return { pro_active: !!subscription, download_photos: !!subscription, high_res_access: !!subscription, source: subscription ? 'verified_store' : 'none', subscription: subscription ? { ...subscription, expires_at: new Date(subscription.expires_at).toISOString() } : null };
}
export async function originalDownloadAccess(ctx: AppContext, actor: Actor, assetId: string, expected?: MediaAuthority): Promise<{
    asset: Asset;
    subscription: any;
    authority: MediaAuthority;
}> {
    const access = (await protectedRendition(ctx, actor, assetId, expected));
    if ((await mediaHeld(ctx, actor.accountId, assetId)) || (await mediaHeld(ctx, access.asset.owner_id, assetId)))
        throw new ApiError(423, 'fraud_hold');
    const summary = (await entitlementSummary(ctx, actor));
    if (!summary.pro_active)
        throw new ApiError(403, 'missing_entitlement');
    const subscription = summary.subscription;
    if (!access.asset.checksum_sha256 || access.asset.byte_size <= 0 || access.asset.byte_size > 25 * 1024 * 1024)
        throw new ApiError(404, 'source_unverified');
    return { asset: access.asset, subscription, authority: access.authority };
}
type StoreOperationRow = {action:string;payload_hash:string;payload_json:string;response_json:string};
type StoreReplay = {result:Record<string,unknown>;row:StoreOperationRow};
type StoreRouteGuard = {check:()=>Promise<void>;fresh:()=>void;remember:(key:string,row:StoreOperationRow)=>void;
    markExternalEffect:()=>void;unresolved:(error:unknown)=>never};
type ValidatedStoreOperation = {action:string;payload_hash:string;result:Record<string,unknown>;input_scheme:string;credential_sha256:string};
function storeReceiptUnavailable(): never { throw new ApiError(503, 'store_operation_receipt_unavailable'); }
/** The lookup and every direct committed replay validate exactly the same
 * historical row. The caller controls session and transaction authority. */
async function validateStoreOperation(operation: StoreOperationRow, key: string): Promise<ValidatedStoreOperation> {
    // The lookup supplies only a key and cannot bind a retired input/hash to
    // the original request. Do not convert an unverifiable tombstone into a
    // definitive noncommit response. Direct replay checks its own input below.
    if (operation.payload_json === retiredOperationInput || operation.response_json === retiredOperationResponse)
        return storeReceiptUnavailable();
    const apple = operation.action === 'store.apple', google = operation.action === 'store.google';
    const unavailable = storeReceiptUnavailable;
    if (!apple && !google) return unavailable();
    if (typeof operation.payload_hash !== 'string' || !/^[0-9a-f]{64}$/.test(operation.payload_hash) ||
        typeof operation.payload_json !== 'string' || new TextEncoder().encode(operation.payload_json).byteLength > 40000 ||
        typeof operation.response_json !== 'string' || new TextEncoder().encode(operation.response_json).byteLength > 4096) unavailable();
    let parsedPayload: unknown, parsedResult: unknown;
    try { parsedPayload = JSON.parse(operation.payload_json); parsedResult = JSON.parse(operation.response_json); }
    catch { return unavailable(); }
    if (!parsedPayload || typeof parsedPayload !== 'object' || Array.isArray(parsedPayload) ||
        !parsedResult || typeof parsedResult !== 'object' || Array.isArray(parsedResult)) return unavailable();
    const payload = parsedPayload as Record<string,unknown>, value = parsedResult as Record<string,unknown>;
    const text = (candidate: unknown, max: number): candidate is string => typeof candidate === 'string' &&
        candidate.length > 0 && candidate.length <= max && !/[\u0000-\u0020]/.test(candidate);
    const fields = Object.keys(payload).sort().join(',');
    let credentialHash: string, inputScheme: string, legacyToken: string | undefined;
    if (fields === 'credential_sha256,operation_key,product_id,protocol' &&
        payload.protocol === 'lovelies-store-operation-input-v1' && typeof payload.credential_sha256 === 'string' &&
        /^[0-9a-f]{64}$/.test(payload.credential_sha256)) {
        credentialHash = payload.credential_sha256; inputScheme = 'digest-v1';
    } else if (fields === (apple ? 'operation_key,product_id,signed_transaction' : 'operation_key,product_id,purchase_token')) {
        const token = apple ? payload.signed_transaction : payload.purchase_token;
        if (!text(token,apple ? 32768 : 4096) || (google && token.length < 16) || key.includes(token)) return unavailable();
        legacyToken = token; credentialHash = await digest(token); inputScheme = 'legacy-raw-v0';
    } else return unavailable();
    if (payload.operation_key !== key || !text(payload.product_id,160)) return unavailable();
    const resultFields = Object.keys(value).sort().join(',');
    const flatFields = 'active,billing_environment,expires_at,financial_eligible,original_transaction_id,product_id,provider,stale,transaction_id';
    const hasSubmission = resultFields === flatFields + ',verified_submission';
    // Only newly-created, digest-input Apple operations have this
    // binding. Older flat receipts and Google receipts stay unchanged.
    if ((resultFields !== flatFields && !(apple && inputScheme === 'digest-v1' && hasSubmission)) ||
        value.provider !== (apple ? 'apple_app_store' : 'google_play') || value.product_id !== payload.product_id ||
        typeof value.active !== 'boolean' || typeof value.financial_eligible !== 'boolean' || typeof value.stale !== 'boolean' ||
        !['production','sandbox'].includes(value.billing_environment as string) ||
        value.financial_eligible !== (value.billing_environment === 'production') ||
        !text(value.transaction_id,160) || !text(value.original_transaction_id,160) || typeof value.expires_at !== 'string') return unavailable();
    try { if (new Date(value.expires_at).toISOString() !== value.expires_at) return unavailable(); }
    catch { return unavailable(); }
    if (hasSubmission) {
        const submitted = value.verified_submission;
        if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted)) return unavailable();
        const binding = submitted as Record<string, unknown>;
        if (Object.keys(binding).sort().join(',') !== 'billing_environment,credential_sha256,original_transaction_id,product_id,protocol,transaction_id' ||
            binding.protocol !== 'lovelies-apple-submission-v2' || binding.product_id !== payload.product_id ||
            binding.credential_sha256 !== credentialHash || !text(binding.transaction_id,160) ||
            // A non-stale operation just wrote its submitted ID as current;
            // stale operations may validly name an older submission.
            (value.stale === false && binding.transaction_id !== value.transaction_id) ||
            binding.original_transaction_id !== value.original_transaction_id ||
            binding.billing_environment !== value.billing_environment) return unavailable();
    }
    // Only validated receipt values reach canonicalization. Never reflect
    // a corrupt result that embeds the original sensitive input.
    if (stable(payload) !== operation.payload_json || stable(value) !== operation.response_json ||
        (legacyToken !== undefined && stable(value).includes(legacyToken)) ||
        await digest(stable({action:operation.action,source:'store',payload})) !== operation.payload_hash) return unavailable();
    return {action:operation.action, payload_hash:operation.payload_hash, result:value,
        input_scheme:inputScheme, credential_sha256:credentialHash};
}
async function storedStoreOperation(ctx: AppContext, actor: Actor, key: string): Promise<StoreOperationRow | null> {
    return await ctx.db.one<StoreOperationRow>(
        "SELECT action,payload_hash,payload_json,response_json FROM operations WHERE actor_id=? AND source='store' AND operation_key=?", actor.accountId, key);
}
function assertSameStoreOperation(row: StoreOperationRow | null, expected: StoreOperationRow): void {
    if (!row || row.action !== expected.action || row.payload_hash !== expected.payload_hash ||
        row.payload_json !== expected.payload_json || row.response_json !== expected.response_json) storeReceiptUnavailable();
}
function safeStoreResult(result: Record<string, unknown>, token: string): Record<string, unknown> {
    if (stable(result).includes(token)) return storeReceiptUnavailable();
    return result;
}
/** A non-retired row must prove its own stored input and receipt first;
 * only then can a different incoming request be called a key conflict. */
async function checkedStoreOperation(ctx: AppContext, actor: Actor, raw: PreparedOperation, redacted: PreparedOperation, token: string, row: StoreOperationRow): Promise<{result:Record<string,unknown>;intent:PreparedOperation}> {
    try {
        // The retained action/hash can identify a matching original request,
        // but a mismatch is indistinguishable from tombstone corruption.
        if (row.payload_json === retiredOperationInput || row.response_json === retiredOperationResponse) {
            const rawMatch = row.action === raw.action && row.payload_hash === raw.hash;
            const digestMatch = row.action === redacted.action && row.payload_hash === redacted.hash;
            if (!rawMatch && !digestMatch) return storeReceiptUnavailable();
            assertOperationReceiptAvailable(row);
            return storeReceiptUnavailable();
        }
        const validated = await validateStoreOperation(row, raw.key);
        const intent = validated.input_scheme === 'legacy-raw-v0' ? raw : redacted;
        if (row.action !== intent.action || row.payload_hash !== intent.hash || row.payload_json !== intent.payloadJson)
            throw new ApiError(409, 'operation_key_conflict');
        const result = safeStoreResult(validated.result, token);
        await assertRegisteredActor(ctx, actor);
        return {result, intent};
    } catch (error) {
        await assertRegisteredActor(ctx, actor);
        throw error;
    }
}
/** Read the row and select raw versus digest input within this transaction. */
async function replayStoreOperation(ctx: AppContext, actor: Actor, raw: PreparedOperation, redacted: PreparedOperation, token: string, guard: StoreRouteGuard): Promise<StoreReplay | null> {
    await assertRegisteredActor(ctx, actor);
    try {
        const row = await storedStoreOperation(ctx, actor, raw.key);
        if (!row) { await assertRegisteredActor(ctx, actor); return null; }
        // Bind even a row classified as conflict or retired to final admission.
        guard.remember(raw.key, row);
        const checked = await checkedStoreOperation(ctx, actor, raw, redacted, token, row);
        // Re-read all receipt fields under the same admitted transaction. The
        // helper also runs inside the later write transaction after a race.
        assertSameStoreOperation(await storedStoreOperation(ctx, actor, raw.key), row);
        await assertRegisteredActor(ctx, actor);
        return {result:checked.result, row};
    } catch (error) {
        await assertRegisteredActor(ctx, actor);
        throw error;
    }
}
/** A historical operation receipt is not a current store entitlement. The
 * caller can bind it to the original request without receiving the JWS/token. */
async function storeOperationReceipt(request: Request, ctx: AppContext, actor: Actor, guard: StoreRouteGuard): Promise<Response> {
    if (request.method !== 'POST') throw new ApiError(405, 'method_not_allowed');
    if (new URL(request.url).search) throw new ApiError(400, 'invalid_store_input');
    const input = await jsonBody(request, 1024);
    await assertRegisteredActor(ctx, actor);
    if (Object.keys(input).join(',') !== 'operation_key' || typeof input.operation_key !== 'string' ||
        !/^[A-Za-z0-9._:-]{16,128}$/.test(input.operation_key)) throw new ApiError(400, 'invalid_store_input');
    const key = input.operation_key, protocol = 'lovelies-store-operation-receipt-v1';
    return ok(await ctx.db.read(async () => {
        await assertRegisteredActor(ctx, actor);
        try {
            const operation = await ctx.db.one<{action:string;payload_hash:string;payload_json:string;response_json:string}>(
                "SELECT action,payload_hash,payload_json,response_json FROM operations WHERE actor_id=? AND source='store' AND operation_key=?", actor.accountId, key);
            await assertRegisteredActor(ctx, actor);
            if (!operation) return {protocol, actor_id: actor.accountId, operation_key: key, status: 'unknown'};
            guard.remember(key, operation);
            const validated = await validateStoreOperation(operation, key);
            await assertRegisteredActor(ctx, actor);
            return {protocol, actor_id: actor.accountId, operation_key: key, status: 'committed',
                action: validated.action, source: 'store', payload_hash: validated.payload_hash, result: validated.result,
                input_scheme: validated.input_scheme, credential_sha256: validated.credential_sha256, receipt_scope: 'historical'};
        } catch (error) {
            await assertRegisteredActor(ctx, actor);
            throw error;
        }
    }));
}
// Keep the authority checks previously surrounding the write transaction,
// but admit both checks as read-only and never create a new journal plan.
async function guardedStoreRead<T>(ctx: AppContext, guard: StoreRouteGuard, callback:()=>Promise<T>): Promise<T> {
    const value = await ctx.db.read(async () => {
        const result = await callback();
        await guard.check(); guard.fresh();
        return result;
    });
    await ctx.db.read(guard.check);
    guard.fresh();
    return value;
}
async function verifyTransaction(request: Request, ctx: AppContext, actor: Actor, provider: 'apple' | 'google', guard: StoreRouteGuard): Promise<Response> {
    const body = await jsonBody(request, 98304);
    exact(body, provider === 'apple' ? ['product_id', 'signed_transaction', 'operation_key'] : ['product_id', 'purchase_token', 'operation_key']);
    const product = provider === 'apple' ? appleConfigured(ctx).productId : (googleVerifier(ctx), ctx.env.GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID);
    if (body.product_id !== product)
        throw new ApiError(400, 'unsupported_store_product');
    const token = sourceString(provider === 'apple' ? body.signed_transaction : body.purchase_token, provider === 'apple' ? 32768 : 4096);
    if (provider === 'google' && token.length < 16) throw new ApiError(400, 'invalid_purchase_token');
    const intent = await prepareOperation('store.' + provider, body, 'store');
    const redacted = await prepareOperation(intent.action, {protocol:'lovelies-store-operation-input-v1',
        operation_key:intent.key, product_id:body.product_id, credential_sha256:await digest(token)}, 'store');
    await assertRegisteredActor(ctx, actor);
    // The initial replay is read-only, including for an absent row. Select the
    // legacy/raw or digest intent from the row under independent admission.
    const previous = await guardedStoreRead(ctx, guard, async () => {
        return await replayStoreOperation(ctx, actor, intent, redacted, token, guard);
    });
    if (previous)
        return ok(previous.result);
    if (intent.key.includes(token)) throw new ApiError(400, 'store_credential_in_operation_key');
    try {
        let purchase: VerifiedPurchase;
        if (provider === 'apple') {
            purchase = await applePurchase(ctx, await appleDecode(ctx, 'transaction', token), await digest(token), actor.accountId);
        }
        else {
            const verifier = googleVerifier(ctx), observed = ctx.now(), raw = await verifier.getSubscription({ packageName: ctx.env.GOOGLE_PLAY_PACKAGE_NAME!, purchaseToken: token });
            (await assertRegisteredActor(ctx, actor));
            purchase = await googlePurchase(ctx, raw, token, actor.accountId, observed);
            if (purchase.active && !purchase.acknowledged) {
                const accountHash = await digest(actor.accountId);
                await ctx.db.read(guard.check); guard.fresh();
                // The provider may accept acknowledgement even if its reply or a
                // later local write is lost. Record ambiguity before dispatch.
                guard.markExternalEffect();
                await verifier.acknowledge({ packageName: ctx.env.GOOGLE_PLAY_PACKAGE_NAME!, productId: purchase.product, purchaseToken: token, obfuscatedAccountId: accountHash });
                purchase.acknowledged = true;
            }
        }
        return ok((await ctx.db.transaction(async () => {
            await assertRegisteredActor(ctx, actor);
            try {
                const row = await storedStoreOperation(ctx, actor, intent.key);
                if (row) {
                    const replayed = await replayStoreOperation(ctx, actor, intent, redacted, token, guard);
                    if (!replayed) return storeReceiptUnavailable();
                    return replayed.result;
                }
                const result = await executeOperation(ctx, actor, redacted, async () => {
                    const current = await persistVerifiedPurchase(ctx, purchase);
                    // The current entitlement can refer to a newer transaction. Bind
                    // the exact verified submission independently, and persist it in
                    // the same atomic operation receipt without retaining the JWS.
                    const accepted = safeStoreResult(provider === 'apple' ? { ...current, verified_submission: {
                        protocol: 'lovelies-apple-submission-v2', product_id: purchase.product,
                        transaction_id: purchase.transaction, original_transaction_id: purchase.original,
                        billing_environment: purchase.environment, credential_sha256: purchase.hash,
                    } } : current, token);
                    (await enqueueNotification(ctx, actor.accountId, 'payment', purchase.provider + ':' + purchase.transaction, 'Your subscription status was updated'));
                    return accepted;
                });
                const stored = await storedStoreOperation(ctx, actor, intent.key);
                if (!stored) return storeReceiptUnavailable();
                const checked = await checkedStoreOperation(ctx, actor, intent, redacted, token, stored);
                if (stable(result) !== stored.response_json) return storeReceiptUnavailable();
                await assertRegisteredActor(ctx, actor);
                guard.remember(intent.key, stored);
                return checked.result;
            } catch (error) {
                await assertRegisteredActor(ctx, actor);
                throw error;
            }
        })));
    } catch (error) { return guard.unresolved(error); }
}
async function storeNotification(request: Request, ctx: AppContext, provider: 'apple' | 'google'): Promise<Response> {
    const body = await jsonBody(request, 131072), payloadHash = await digest(stable(body));
    let event: string, account: string | null = null, purchase: VerifiedPurchase | null = null;
    if (provider === 'apple') {
        exact(body, ['signedPayload']);
        const notification = await appleDecode(ctx, 'notification', sourceString(body.signedPayload, 65536));
        event = sourceString(notification.notificationUUID);
        const configured = appleConfigured(ctx);
        if (notification.data?.bundleId !== configured.bundleId || !['Production', 'Sandbox'].includes(notification.data?.environment) || notification.data.appAppleId != null && notification.data.appAppleId !== configured.appId)
            throw new ApiError(422, 'apple_notification_app_mismatch');
        if (notification.data.signedTransactionInfo) {
            const tx = await appleDecode(ctx, 'transaction', notification.data.signedTransactionInfo);
            account = uuid(tx.appAccountToken);
            if (tx.environment !== notification.data.environment)
                throw new ApiError(422, 'apple_notification_environment_mismatch');
            let renewal: any, grace: number | undefined;
            if (notification.data.signedRenewalInfo) {
                renewal = await appleDecode(ctx, 'renewal', notification.data.signedRenewalInfo);
                if (renewal.originalTransactionId !== tx.originalTransactionId || renewal.productId !== tx.productId || renewal.environment !== tx.environment || renewal.appAccountToken != null && uuid(renewal.appAccountToken) !== account)
                    throw new ApiError(422, 'apple_renewal_binding_mismatch');
                if (notification.data.status === 4 && renewal.isInBillingRetryPeriod === true && Number.isSafeInteger(renewal.gracePeriodExpiresDate) && renewal.gracePeriodExpiresDate > ctx.now())
                    grace = renewal.gracePeriodExpiresDate;
            }
            purchase = await applePurchase(ctx, tx, await digest(notification.data.signedTransactionInfo), account, Math.max(tx.signedDate ?? tx.purchaseDate, notification.signedDate ?? 0, renewal?.signedDate ?? 0), grace);
        }
    }
    else {
        const audience = ctx.env.GOOGLE_PLAY_RTDN_AUDIENCE, email = ctx.env.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL;
        if (!audience || !email)
            throw new ApiError(503, 'google_notification_auth_unconfigured');
        const bearer = /^Bearer ([^\s]+)$/.exec(request.headers.get('Authorization') ?? '');
        if (!bearer)
            throw new ApiError(401, 'google_notification_unauthorized');
        try {
            if (ctx.env.STORE_VERIFIER)
                await privateVerifier(ctx, 'google/oidc', { token: bearer[1], audience, email });
            else
                await configuredGoogleOidc(bearer[1], { audience, email });
        }
        catch (error) {
            if (error instanceof ApiError && error.status >= 500) throw error;
            // Native verifier plain errors still require separate provider
            // classification; only checked private-boundary 5xx is preserved.
            throw new ApiError(401, 'google_notification_unauthorized');
        }
        event = sourceString(body.message?.messageId, 256);
        let notification: any;
        try {
            notification = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(sourceString(body.message?.data, 65536)), char => char.charCodeAt(0)))));
        }
        catch {
            throw new ApiError(400, 'invalid_google_notification');
        }
        if (notification.packageName !== ctx.env.GOOGLE_PLAY_PACKAGE_NAME)
            throw new ApiError(422, 'google_notification_package_mismatch');
        const token = notification.subscriptionNotification?.purchaseToken ?? notification.voidedPurchaseNotification?.purchaseToken;
        if (token) {
            sourceString(token, 4096);
            const hash = await digest(token), verifier = googleVerifier(ctx), observed = ctx.now(), raw = await verifier.getSubscription({ packageName: ctx.env.GOOGLE_PLAY_PACKAGE_NAME!, purchaseToken: token });
            let known = (await ctx.db.one<any>("SELECT account_id FROM store_subscriptions WHERE provider='google' AND original_id=?", hash));
            if (!known) {
                const previousToken = raw.outOfAppPurchaseContext?.expiredPurchaseToken ?? raw.linkedPurchaseToken;
                if (previousToken)
                    known = (await ctx.db.one<any>("SELECT account_id FROM store_subscriptions WHERE provider='google' AND original_id=?", await digest(previousToken)));
            }
            if (known) {
                account = known.account_id;
                purchase = await googlePurchase(ctx, raw, token, account!, observed);
                if (notification.voidedPurchaseNotification)
                    purchase.active = false;
                if (purchase.active && !purchase.acknowledged) {
                    await verifier.acknowledge({ packageName: ctx.env.GOOGLE_PLAY_PACKAGE_NAME!, productId: purchase.product, purchaseToken: token, obfuscatedAccountId: await digest(account!) });
                    purchase.acknowledged = true;
                }
            }
        }
    }
    return ok((await ctx.db.transaction(async () => {
        const previous = (await ctx.db.one<any>('SELECT payload_hash FROM store_notifications WHERE provider=? AND event_id=?', provider, event));
        if (previous) {
            if (previous.payload_hash !== payloadHash)
                throw new ApiError(409, 'store_notification_conflict');
            return { received: true, duplicate: true };
        }
        if (account)
            (await accountCurrent(ctx, account));
        if (purchase)
            (await persistVerifiedPurchase(ctx, purchase));
        (await ctx.db.run('INSERT INTO store_notifications(provider,event_id,payload_hash,account_id,status,created_at) VALUES(?,?,?,?,?,?)', provider, event, payloadHash, account, purchase ? 'processed' : account ? 'observed' : 'unlinked', ctx.now()));
        return { received: true, duplicate: false, linked: !!account };
    })));
}
async function originalBytes(ctx: AppContext, ticket: any): Promise<Response> {
    const authority = parseMediaAuthority(ticket.authority_json);
    const session = (await ctx.db.one<any>('SELECT s.*,a.roles_json FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.id=? AND s.account_id=?', ticket.session_id, ticket.account_id));
    if (!session)
        throw new ApiError(403, 'download_expired');
    const actor: Actor = { accountId: ticket.account_id, sessionId: session.id, roles: accountRoles(session.roles_json), expiresAt: session.expires_at, authEpoch: session.auth_epoch, authMethod: session.auth_method };
    const check = async () => { const access = (await originalDownloadAccess(ctx, actor, ticket.asset_id, authority)); if (ticket.expires_at <= ctx.now() || access.asset.version !== ticket.asset_version || access.asset.checksum_sha256 !== ticket.source_checksum || access.subscription.id !== ticket.subscription_id || access.subscription.version !== ticket.subscription_version)
        throw new ApiError(403, 'download_authority_changed'); return access; };
    const initial = (await ctx.db.transaction(check)), object = await ctx.env.QUARANTINE.get(initial.asset.object_key);
    let bytes: Uint8Array | undefined;
    try {
        (await ctx.db.transaction(check));
        if (!object || object.size !== initial.asset.byte_size || object.httpMetadata?.contentType !== initial.asset.content_type || object.customMetadata?.source_version !== initial.asset.version || object.customMetadata?.source_checksum_sha256 !== initial.asset.checksum_sha256)
            throw new ApiError(404, 'source_unverified');
        bytes = new Uint8Array(await object.arrayBuffer());
        const heldBytes = bytes;
        await ctx.db.transaction(check);
        const checksum = await digest(heldBytes);
        await ctx.db.transaction(check);
        const head = await ctx.env.QUARANTINE.head(initial.asset.object_key);
        (await ctx.db.transaction(async () => {
            const current = (await check());
            if (heldBytes.byteLength !== current.asset.byte_size || checksum !== current.asset.checksum_sha256 || !head || head.etag !== object.etag || head.customMetadata?.source_version !== current.asset.version || head.customMetadata?.source_checksum_sha256 !== checksum)
                throw new ApiError(403, 'download_source_changed');
            (await ctx.db.run('INSERT OR IGNORE INTO download_records(id,ticket_id,account_id,asset_id,subscription_id,created_at,financial_eligible) VALUES(?,?,?,?,?,?,1)', crypto.randomUUID(), ticket.id, actor.accountId, current.asset.id, current.subscription.id, ctx.now()));
            (await assertRegisteredActor(ctx, actor));
        }));
        return new Response(heldBytes.slice().buffer, { headers: { 'Content-Type': initial.asset.content_type, 'Content-Length': String(heldBytes.byteLength), 'Content-Disposition': 'attachment; filename="lovelies-' + initial.asset.id + '.' + (initial.asset.content_type === 'image/jpeg' ? 'jpg' : initial.asset.content_type.split('/')[1]) + '"', 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' } });
    }
    finally {
        bytes?.fill(0);
        if (object?.body && !object.body.locked)
            void object.body.cancel().catch(() => { });
    }
}
export async function handleEntitlements(request: Request, ctx: AppContext): Promise<Response | null> {
    const url = new URL(request.url), path = url.pathname, store = /^\/subscriptions\/(apple|google)\/(transactions|notifications)$/.exec(path), download = /^\/downloads\/([0-9a-f-]{36})$/i.exec(path);
    if (!store && !download && !['/downloads/sign', '/me/entitlements', '/me/store-operations'].includes(path))
        return null;
    if (store && request.method !== 'POST' || download && request.method !== 'GET')
        throw new ApiError(405, 'method_not_allowed');
    if (store?.[2] === 'notifications')
        return (await storeNotification(request, ctx, store[1] as 'apple' | 'google'));
    if (download) {
        const ticket = (await ctx.db.one<any>('SELECT * FROM download_tickets WHERE id=?', uuid(download[1])));
        if (!ticket)
            throw new ApiError(403, 'download_expired');
        return (await originalBytes(ctx, ticket));
    }
    const actor = await ctx.authenticate(request);
    (await assertRegisteredActor(ctx, actor));
    let guard: StoreRouteGuard | undefined;
    if (store || path === '/me/store-operations' || path === '/me/entitlements') {
        // Snapshot the authenticated actor and any validated replay. Every
        // independent admission before release rechecks the exact saved row.
        const bound = { ...actor, roles: [...actor.roles] };
        let deadlines: StoreAuthorityDeadlines | undefined;
        let receipt: {key:string;row:StoreOperationRow} | undefined;
        let externalEffectDispatched = false;
        const unresolved = (error:unknown):never => {
            if (externalEffectDispatched) throw new ApiError(503, 'store_operation_outcome_unresolved');
            throw error;
        };
        guard = {
            check: async () => {
                try {
                    deadlines = await storeAuthorityDeadlines(ctx, bound);
                    if (receipt) assertSameStoreOperation(await storedStoreOperation(ctx, bound, receipt.key), receipt.row);
                } catch (error) { unresolved(error); }
            },
            fresh: () => {
                try {
                    if (!deadlines) throw new ApiError(503, 'store_authority_unavailable');
                    assertStoreAuthorityFresh(deadlines, ctx.now());
                } catch (error) { unresolved(error); }
            },
            remember: (key, row) => {
                if (receipt) throw new ApiError(500, 'store_receipt_guard_invalid');
                receipt = {key, row:{...row}};
            },
            markExternalEffect: () => { externalEffectDispatched = true; },
            unresolved,
        };
        ctx.db.bindInvocationAuthority(guard.check, guard.fresh);
    }
    if (path === '/me/store-operations')
        return await storeOperationReceipt(request, ctx, actor, guard!);
    if (store)
        return (await verifyTransaction(request, ctx, actor, store[1] as 'apple' | 'google', guard!));
    if (path === '/me/entitlements') {
        if (request.method !== 'GET')
            throw new ApiError(405, 'method_not_allowed');
        return ok((await guardedStoreRead(ctx, guard!, async () => (await entitlementSummary(ctx, actor)))));
    }
    if (request.method !== 'POST')
        throw new ApiError(405, 'method_not_allowed');
    const body = await jsonBody(request, 16384);
    exact(body, ['asset_id', 'operation_key']);
    const asset = uuid(body.asset_id), intent = await prepareOperation('download.sign', body, 'media');
    return ok((await executeOperation(ctx, actor, intent, async () => {
        const access = (await originalDownloadAccess(ctx, actor, asset)), id = crypto.randomUUID(), expires = Math.min(ctx.now() + 120000, actor.expiresAt, Date.parse(access.subscription.expires_at));
        (await ctx.db.run('INSERT INTO download_tickets(id,account_id,session_id,asset_id,asset_version,source_checksum,subscription_id,subscription_version,expires_at,created_at,authority_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)', id, actor.accountId, actor.sessionId, asset, access.asset.version, access.asset.checksum_sha256, access.subscription.id, access.subscription.version, expires, ctx.now(), stable(access.authority)));
        return { method: 'GET', download_url: (ctx.env.PUBLIC_API_BASE_URL ?? url.origin) + '/downloads/' + id, expires_in: Math.max(0, Math.floor((expires - ctx.now()) / 1000)), source_version: access.asset.version };
    })));
}
export async function entitlementPrivacyRows(ctx: AppContext, subject: string): Promise<Record<string, unknown>> {
    const rows = { subscriptions: (await ctx.db.all('SELECT provider,product_id,billing_environment,active,starts_at,expires_at,observed_at FROM store_subscriptions WHERE account_id=? ORDER BY starts_at,id LIMIT 25001', subject)), store_transactions: (await ctx.db.all('SELECT provider,transaction_id,billing_environment,product_id,starts_at,expires_at,active,financial_eligible FROM store_transactions WHERE account_id=? ORDER BY starts_at,id LIMIT 25001', subject)), downloads: (await ctx.db.all('SELECT asset_id,created_at,financial_eligible FROM download_records WHERE account_id=? ORDER BY created_at,id LIMIT 25001', subject)) };
    if (Object.values(rows).some(items => items.length > 25000))
        throw new ApiError(413, 'privacy_export_too_large');
    return rows;
}
export async function eraseEntitlementSubject(db: Database, subject: string): Promise<void> {
    (await db.run('DELETE FROM download_tickets WHERE account_id=? OR asset_id IN(SELECT id FROM assets WHERE owner_id=?)', subject, subject));
    (await db.run('DELETE FROM download_records WHERE asset_id IN(SELECT id FROM assets WHERE owner_id=?)', subject));
    (await db.run('UPDATE store_subscriptions SET active=0,version=version+1 WHERE account_id=?', subject));
    // Verified financial transaction IDs/periods are retained under the existing
    // financial/audit policy; no raw purchase tokens or signed payloads are stored.
}
/** Provider HTTP adapter: explicit HTTPS origins, no redirect credential forwarding,
 * bounded bodies and request-scoped timeouts. No global fetch monkey-patching. */
async function providerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!['https://oauth2.googleapis.com', 'https://androidpublisher.googleapis.com', 'https://www.googleapis.com'].includes(url.origin) || url.username || url.password)
        throw new ApiError(503, 'store_provider_origin_denied');
    const response = await globalThis.fetch(input, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (response.redirected || response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => { });
        throw new ApiError(503, 'store_provider_redirect_denied');
    }
    const reader = response.body?.getReader();
    if (!reader)
        return new Response(null, { status: response.status, headers: response.headers });
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done)
                break;
            size += next.value.byteLength;
            if (size > 131072)
                throw new ApiError(503, 'store_provider_response_too_large');
            parts.push(next.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) {
            bytes.set(part, offset);
            offset += part.byteLength;
        }
        return new Response(bytes, { status: response.status, headers: { 'Content-Type': response.headers.get('Content-Type') ?? 'application/json' } });
    }
    finally {
        void reader.cancel().catch(() => { });
        reader.releaseLock();
        for (const part of parts)
            part.fill(0);
    }
}
// Adapted from the exact imported google_play_store.ts. Crypto/account protocols
// are retained; only the HTTP binding is local and redirect/body bounded.
function configuredGoogleVerifier(credentials: GooglePlayServiceAccountCredentials): GooglePlaySubscriptionVerifier {
    const fetch = providerFetch;
    const androidPublisherScope = "https://www.googleapis.com/auth/androidpublisher";
    const googleOauthTokenUrl = "https://oauth2.googleapis.com/token";
    const androidPublisherBaseUrl = "https://androidpublisher.googleapis.com/androidpublisher/v3";
    interface GooglePlayMoney {
        units?: string;
        nanos?: number;
        currencyCode?: string;
    }
    interface GooglePlaySubscriptionLineItem {
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
    interface GooglePlaySubscriptionPurchase {
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
    interface GooglePlaySubscriptionVerifier {
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
    interface GooglePlayServiceAccountCredentials {
        clientEmail: string;
        privateKey: string;
        privateKeyId?: string;
    }
    class GooglePlayApiError extends Error {
        constructor(message: string, readonly status: number) {
            super(message);
            this.name = "GooglePlayApiError";
        }
    }
    function createGooglePlaySubscriptionVerifier(credentials: GooglePlayServiceAccountCredentials): GooglePlaySubscriptionVerifier {
        return new GooglePlayApiSubscriptionVerifier(credentials);
    }
    class GooglePlayApiSubscriptionVerifier implements GooglePlaySubscriptionVerifier {
        private accessToken: string | null = null;
        constructor(private readonly credentials: GooglePlayServiceAccountCredentials) { }
        async getSubscription(input: {
            packageName: string;
            purchaseToken: string;
        }): Promise<GooglePlaySubscriptionPurchase> {
            const accessToken = await this.getAccessToken();
            const url = `${androidPublisherBaseUrl}/applications/${encodeURIComponent(input.packageName)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(input.purchaseToken)}`;
            const response = await fetch(url, {
                headers: {
                    accept: "application/json",
                    authorization: `Bearer ${accessToken}`,
                },
            });
            if (!response.ok) {
                throw new GooglePlayApiError("Google Play could not verify the subscription", response.status);
            }
            return await response.json() as GooglePlaySubscriptionPurchase;
        }
        async acknowledge(input: {
            packageName: string;
            productId: string;
            purchaseToken: string;
            obfuscatedAccountId?: string;
        }): Promise<void> {
            const accessToken = await this.getAccessToken();
            const url = `${androidPublisherBaseUrl}/applications/${encodeURIComponent(input.packageName)}/purchases/subscriptions/${encodeURIComponent(input.productId)}/tokens/${encodeURIComponent(input.purchaseToken)}:acknowledge`;
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    accept: "application/json",
                    authorization: `Bearer ${accessToken}`,
                    "content-type": "application/json",
                },
                body: JSON.stringify(input.obfuscatedAccountId
                    ? {
                        externalAccountIds: {
                            obfuscatedAccountId: input.obfuscatedAccountId,
                        },
                    }
                    : {}),
            });
            if (!response.ok) {
                throw new GooglePlayApiError("Google Play could not acknowledge the subscription", response.status);
            }
        }
        private async getAccessToken(): Promise<string> {
            if (this.accessToken)
                return this.accessToken;
            const assertion = await createServiceAccountAssertion(this.credentials);
            const body = new URLSearchParams({
                grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
                assertion,
            });
            const response = await fetch(googleOauthTokenUrl, {
                method: "POST",
                headers: {
                    accept: "application/json",
                    "content-type": "application/x-www-form-urlencoded",
                },
                body,
            });
            if (!response.ok) {
                throw new GooglePlayApiError("Google OAuth rejected the service account assertion", response.status);
            }
            const payload = await response.json() as { access_token?: string; token_type?: string };
            if (!payload.access_token ||
                payload.token_type?.toLowerCase() !== "bearer") {
                throw new GooglePlayApiError("Google OAuth returned an incomplete access token response", 502);
            }
            this.accessToken = payload.access_token;
            return payload.access_token;
        }
    }
    async function createServiceAccountAssertion(credentials: GooglePlayServiceAccountCredentials): Promise<string> {
        const issuedAt = Math.floor(Date.now() / 1000);
        const header = {
            alg: "RS256",
            typ: "JWT",
            ...(credentials.privateKeyId ? { kid: credentials.privateKeyId } : {}),
        };
        const claims = {
            iss: credentials.clientEmail,
            scope: androidPublisherScope,
            aud: googleOauthTokenUrl,
            iat: issuedAt,
            exp: issuedAt + 3600,
        };
        const encodedHeader = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
        const encodedClaims = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
        const unsignedAssertion = `${encodedHeader}.${encodedClaims}`;
        const signingKey = await crypto.subtle.importKey("pkcs8", decodePkcs8PrivateKey(credentials.privateKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
        const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, new TextEncoder().encode(unsignedAssertion));
        return `${unsignedAssertion}.${base64UrlEncode(new Uint8Array(signature))}`;
    }
    function decodePkcs8PrivateKey(value: string): Uint8Array<ArrayBuffer> {
        const normalized = value.replaceAll("\\n", "\n").trim();
        const encoded = normalized
            .replace("-----BEGIN PRIVATE KEY-----", "")
            .replace("-----END PRIVATE KEY-----", "")
            .replaceAll(/\s/g, "");
        if (!encoded) {
            throw new GooglePlayApiError("Google Play service account private key is invalid", 503);
        }
        try {
            const decoded = atob(encoded);
            const bytes = new Uint8Array(new ArrayBuffer(decoded.length));
            for (let index = 0; index < decoded.length; index += 1) {
                bytes[index] = decoded.charCodeAt(index);
            }
            return bytes;
        }
        catch {
            throw new GooglePlayApiError("Google Play service account private key is invalid", 503);
        }
    }
    function base64UrlEncode(value: Uint8Array): string {
        let binary = "";
        for (const byte of value)
            binary += String.fromCharCode(byte);
        return btoa(binary)
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replaceAll("=", "");
    }
    return createGooglePlaySubscriptionVerifier(credentials);
}
// Adapted from exact imported google_oidc.ts with the same local HTTP boundary.
async function configuredGoogleOidc(token: string, expected: {
    audience: string;
    email: string;
}): Promise<unknown> {
    const fetch = providerFetch;
    const googleOidcJwksUrl = "https://www.googleapis.com/oauth2/v3/certs";
    const acceptedGoogleIssuers = new Set([
        "accounts.google.com",
        "https://accounts.google.com",
    ]);
    interface GoogleOidcClaims {
        iss: string;
        aud: string;
        sub: string;
        email: string;
        email_verified: boolean;
        iat: number;
        exp: number;
    }
    interface GoogleOidcTokenVerifier {
        verify(token: string, expected: {
            audience: string;
            email: string;
        }): Promise<GoogleOidcClaims>;
    }
    const googleOidcTokenVerifier: GoogleOidcTokenVerifier = {
        async verify(token, expected) {
            if (token.length > 16384)
                throw new Error("OIDC token is too large");
            const segments = token.split(".");
            if (segments.length !== 3)
                throw new Error("OIDC token is malformed");
            const header = decodeJwtSegment<{
                alg?: string;
                kid?: string;
            }>(segments[0]);
            const claims = decodeJwtSegment<Partial<GoogleOidcClaims>>(segments[1]);
            if (header.alg !== "RS256" || !header.kid) {
                throw new Error("OIDC signing header is unsupported");
            }
            const now = Math.floor(Date.now() / 1000);
            if (!claims.iss ||
                !acceptedGoogleIssuers.has(claims.iss) ||
                claims.aud !== expected.audience ||
                claims.email !== expected.email ||
                claims.email_verified !== true ||
                typeof claims.sub !== "string" ||
                !claims.sub ||
                typeof claims.iat !== "number" ||
                typeof claims.exp !== "number" ||
                claims.iat > now + 300 ||
                claims.exp <= now) {
                throw new Error("OIDC claims do not match the Pub/Sub push identity");
            }
            const response = await fetch(googleOidcJwksUrl, {
                headers: { accept: "application/json" },
            });
            if (!response.ok)
                throw new Error("Google OIDC keys are unavailable");
            const jwks = await response.json() as {keys?: Array<JsonWebKey & {kid?:string;alg?:string;use?:string}>};
            const jwk = jwks.keys?.find((candidate) => candidate.kid === header.kid &&
                candidate.kty === "RSA" &&
                candidate.alg === "RS256" &&
                candidate.use === "sig");
            if (!jwk)
                throw new Error("Google OIDC signing key was not found");
            const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
            const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decodeBase64Url(segments[2]), new TextEncoder().encode(`${segments[0]}.${segments[1]}`));
            if (!valid)
                throw new Error("Google OIDC signature is invalid");
            return claims as GoogleOidcClaims;
        },
    };
    function decodeJwtSegment<T>(segment: string): T {
        try {
            return JSON.parse(new TextDecoder().decode(decodeBase64Url(segment))) as T;
        }
        catch {
            throw new Error("OIDC token JSON is malformed");
        }
    }
    function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
        const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
        const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
        try {
            const decoded = atob(padded);
            const bytes = new Uint8Array(new ArrayBuffer(decoded.length));
            for (let index = 0; index < decoded.length; index += 1) {
                bytes[index] = decoded.charCodeAt(index);
            }
            return bytes;
        }
        catch {
            throw new Error("OIDC token encoding is malformed");
        }
    }
    return googleOidcTokenVerifier.verify(token, expected);
}
