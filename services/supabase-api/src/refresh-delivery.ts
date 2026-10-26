import { accountRoles, assertRefreshActor, assertPrivacyActor, base64url, decodeBase64url, insertPreparedSession, prepareSession, revokeSessionAuthority,
    type AccountRow, type SessionRow } from './auth.ts';
import { ApiError, digest, ok, stable, type Actor, type AppContext } from './types.ts';
import { sessionRetirementScope } from './session-retirement.ts';

export const REFRESH_DELIVERY_PROTOCOL = 'lovelies-refresh-delivery-v1';
const DELIVERY_MS = 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();
export const refreshDeliverySchemaStatements: readonly string[] = [
    `CREATE TABLE IF NOT EXISTS refresh_delivery_receipts(
    original_session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    rotation_key TEXT NOT NULL UNIQUE, secret_hash TEXT NOT NULL CHECK(length(secret_hash)=64),
    successor_session_id TEXT UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK(state IN('active','cancelled')), ciphertext TEXT, iv TEXT,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
    CHECK(original_session_id<>successor_session_id),
    CHECK((state='active' AND successor_session_id IS NOT NULL AND ciphertext IS NOT NULL
      AND length(ciphertext) BETWEEN 22 AND 16384 AND iv IS NOT NULL AND length(iv)=16)
      OR (state='cancelled' AND ciphertext IS NULL AND iv IS NULL))
  )`,
    `CREATE INDEX IF NOT EXISTS refresh_delivery_expiry ON refresh_delivery_receipts(expires_at,original_session_id)`,
];
type Receipt = {
    original_session_id: string; account_id: string; rotation_key: string; secret_hash: string;
    successor_session_id: string|null; state: 'active'|'cancelled'; ciphertext: string|null; iv: string|null; created_at: number; expires_at: number;
};
type Input = { refresh_token: string; rotation_key: string; secretHash: string };
function invalid(): never { throw new ApiError(401, 'refresh_invalid'); }
function actor(session: SessionRow, account: AccountRow, roles = accountRoles(account.roles_json)): Actor {
    return {accountId:account.id,sessionId:session.id,roles,expiresAt:session.expires_at,authEpoch:session.auth_epoch,authMethod:session.auth_method};
}
/** The capability retires one exchange, not an independently active device or
 * another session's push registration. Push is device-scoped, so an unrevoked
 * peer or an unknown device/account generation prevents that broader cleanup. */
async function retireRefreshSession(session: SessionRow, account: AccountRow, ctx: AppContext): Promise<void> {
    const scope = await sessionRetirementScope(ctx, session);
    const peer = session.device_id === null ? null : await ctx.db.one<{id:string}>(`SELECT id FROM sessions
        WHERE account_id=? AND device_id=? AND id<>? AND revoked_at IS NULL LIMIT 1`, session.account_id, session.device_id, session.id);
    const exactDevice = session.auth_method === 'registered_face' && session.device_id !== null && session.device_revision !== null &&
        session.revoked_at === null && session.refresh_consumed_at === null && account.disabled_at === null &&
        account.auth_epoch === session.auth_epoch && account.identity_state === session.auth_method &&
        scope.device !== null && scope.device.status === 'active' && scope.device.revision === session.device_revision;
    await revokeSessionAuthority(session.id, account.id, ctx, { ...scope, clearDevicePush: exactDevice && peer === null });
}
async function input(body: Record<string, unknown>): Promise<Input> {
    if(body.protocol!==REFRESH_DELIVERY_PROTOCOL || Object.keys(body).length!==4 ||
        Object.keys(body).some(key=>!['protocol','refresh_token','rotation_key','delivery_secret'].includes(key)) ||
        typeof body.refresh_token!=='string' || !/^lvs_[A-Za-z0-9_-]{43}$/.test(body.refresh_token) ||
        typeof body.rotation_key!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.rotation_key) ||
        typeof body.delivery_secret!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(body.delivery_secret))invalid();
    let bytes: Uint8Array;
    try {bytes=decodeBase64url(body.delivery_secret,32);} catch {return invalid();}
    if(bytes.length!==32)invalid();bytes.fill(0);
    return {refresh_token:body.refresh_token,rotation_key:body.rotation_key,secretHash:await digest(body.delivery_secret)};
}
async function encryptionKey(ctx: AppContext): Promise<CryptoKey> {
    const secret=ctx.env.AUTH_SIGNING_SECRET;
    if(typeof secret!=='string'||encoder.encode(secret).length<32)throw new ApiError(503,'refresh_delivery_unavailable');
    const bytes=encoder.encode(secret);
    try {
        const material=await crypto.subtle.importKey('raw',bytes,'HKDF',false,['deriveKey']);
        return await crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:encoder.encode('lovelies-supabase/refresh-delivery/v1'),
            info:encoder.encode('credential-result/AES-256-GCM')},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    } finally {bytes.fill(0);}
}
function aad(row: Omit<Receipt,'ciphertext'|'iv'|'state'>): Uint8Array<ArrayBuffer> {
    return encoder.encode(stable({protocol:REFRESH_DELIVERY_PROTOCOL,original_session_id:row.original_session_id,
        account_id:row.account_id,rotation_key:row.rotation_key,secret_hash:row.secret_hash,
        successor_session_id:row.successor_session_id,created_at:row.created_at,expires_at:row.expires_at}));
}
async function replay(row: Receipt, old: SessionRow, account: AccountRow, request: Input, key: CryptoKey, ctx: AppContext): Promise<Response> {
    if(row.original_session_id!==old.id || row.account_id!==old.account_id || row.account_id!==account.id ||
        row.rotation_key!==request.rotation_key || row.secret_hash!==request.secretHash || old.refresh_consumed_at===null ||
        row.state!=='active'||!row.successor_session_id||!row.iv||!row.ciphertext)invalid();
    const next=await ctx.db.one<SessionRow>('SELECT * FROM sessions WHERE id=? AND account_id=?',row.successor_session_id,row.account_id);
    if(!next || next.refresh_consumed_at!==null)invalid();
    // Expired access is permissible for delivery only; the successor refresh,
    // account, epoch and exact device must remain current. Reference/consent
    // are additionally required unless audience restriction limits this session
    // to weak own status/privacy controls; no product guard is bypassed.
    await assertRefreshActor(actor(next,account),ctx,true);
    if(row.expires_at<=ctx.now())throw new ApiError(410,'refresh_delivery_expired');
    let plain: Uint8Array;
    try {plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(decodeBase64url(row.iv,12)).buffer,additionalData:aad(row)},key,new Uint8Array(decodeBase64url(row.ciphertext,12288)).buffer));}
    catch {throw new ApiError(503,'refresh_delivery_unavailable');}
    let value;
    try {value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain));}
    catch {throw new ApiError(503,'refresh_delivery_unavailable');}
    finally {plain.fill(0);}
    const fields=['access_token','refresh_token','expires_in','token_type','roles','auth_method','account_id','protocol','rotation_key',
        'access_expires_at','refresh_expires_at','delivery_expires_at'];
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||
        Object.keys(value).some(name=>!fields.includes(name))||typeof value.access_token!=='string'||value.access_token.length>8192||
        value.token_type!=='Bearer'||value.expires_in!==900)throw new ApiError(503,'refresh_delivery_unavailable');
    if(value.protocol!==REFRESH_DELIVERY_PROTOCOL || value.rotation_key!==row.rotation_key || value.account_id!==account.id ||
        value.auth_method!==next.auth_method || !Array.isArray(value.roles) ||
        stable([...value.roles].sort())!==stable(accountRoles(account.roles_json).sort()) ||
        value.access_expires_at!==new Date(next.expires_at).toISOString() ||
        value.refresh_expires_at!==new Date(next.refresh_expires_at).toISOString() ||
        value.delivery_expires_at!==new Date(row.expires_at).toISOString() ||
        typeof value.refresh_token!=='string' || await digest(value.refresh_token)!==next.refresh_hash)invalid();
    await assertRefreshActor(actor(next,account,value.roles),ctx,true);
    return ok(value);
}
/** Delivery reconciliation never consumes an old token twice or authenticates
 * from a face-device key. Only the first valid original refresh exchange can
 * establish this secret-bound receipt and its one exact successor. */
export async function refreshWithDelivery(body: Record<string, unknown>, ctx: AppContext): Promise<Response> {
    const request=await input(body),hash=await digest(request.refresh_token),key=await encryptionKey(ctx);
    return ctx.db.transaction(async()=>{
        const old=await ctx.db.one<SessionRow>('SELECT * FROM sessions WHERE refresh_hash=?',hash);
        const account=old&&await ctx.db.one<AccountRow>('SELECT * FROM accounts WHERE id=?',old.account_id);
        if(!old||!account)invalid();
        const prior=await ctx.db.one<Receipt>('SELECT * FROM refresh_delivery_receipts WHERE original_session_id=?',old.id);
        if(prior)return replay(prior,old,account,request,key,ctx);
        if(old.refresh_consumed_at!==null || await ctx.db.one('SELECT original_session_id FROM refresh_delivery_receipts WHERE rotation_key=?',request.rotation_key))invalid();
        const authority=actor(old,account);await assertRefreshActor(authority,ctx,true);
        const prepared=await prepareSession({accountId:account.id,roles:authority.roles,authEpoch:authority.authEpoch,authMethod:old.auth_method,
            profileRevision:old.face_profile_revision??undefined,profileEpoch:old.face_profile_epoch??undefined,
            consentId:old.face_consent_id??undefined,deviceId:old.device_id??undefined,deviceRevision:old.device_revision??undefined},ctx);
        const row={original_session_id:old.id,account_id:old.account_id,rotation_key:request.rotation_key,secret_hash:request.secretHash,
            successor_session_id:prepared.id,created_at:prepared.createdAt,expires_at:Math.min(prepared.createdAt+DELIVERY_MS,old.refresh_expires_at)};
        const value={...prepared.credentials,protocol:REFRESH_DELIVERY_PROTOCOL,rotation_key:request.rotation_key,
            access_expires_at:new Date(prepared.expiresAt).toISOString(),refresh_expires_at:new Date(prepared.refreshExpiresAt).toISOString(),
            delivery_expires_at:new Date(row.expires_at).toISOString()};
        const iv=crypto.getRandomValues(new Uint8Array(12)),plain=encoder.encode(JSON.stringify(value));let ciphertext;
        try {ciphertext=base64url(new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(row)},key,plain)));}
        finally {plain.fill(0);}
        await assertRefreshActor(authority,ctx,true);
        await ctx.db.run('UPDATE sessions SET revoked_at=?,refresh_consumed_at=? WHERE id=?',ctx.now(),ctx.now(),old.id);
        await insertPreparedSession(prepared,ctx,true);
        await ctx.db.run(`INSERT INTO refresh_delivery_receipts(original_session_id,account_id,rotation_key,secret_hash,successor_session_id,state,ciphertext,iv,created_at,expires_at)
            VALUES(?,?,?,?,?,'active',?,?,?,?)`,old.id,old.account_id,request.rotation_key,request.secretHash,prepared.id,ciphertext,base64url(iv),row.created_at,row.expires_at);
        return ok(value);
    });
}
/** A saved delivery capability can retire its exact exchange without receiving
 * credentials. Pre-dispatch cancellation consumes the original too, so pruning
 * the tombstone can never reopen authority for a delayed first request. */
export async function cancelRefreshDelivery(body: Record<string, unknown>, ctx: AppContext): Promise<Response> {
    const request=await input(body),hash=await digest(request.refresh_token);
    return ctx.db.transaction(async()=>{
        const old=await ctx.db.one<SessionRow>('SELECT * FROM sessions WHERE refresh_hash=?',hash);
        const account=old&&await ctx.db.one<AccountRow>('SELECT * FROM accounts WHERE id=?',old.account_id);
        if(!old||!account)invalid();
        const prior=await ctx.db.one<Receipt>('SELECT * FROM refresh_delivery_receipts WHERE original_session_id=?',old.id);
        if(prior){
            if(prior.account_id!==account.id||prior.rotation_key!==request.rotation_key||prior.secret_hash!==request.secretHash)invalid();
            if(prior.state==='active'){
                const next=prior.successor_session_id&&await ctx.db.one<SessionRow>('SELECT * FROM sessions WHERE id=? AND account_id=?',prior.successor_session_id,account.id);
                // A retired successor cannot authorize cleanup of a newer
                // session's same-device work or push registration.
                if(next&&next.revoked_at===null&&next.refresh_consumed_at===null)await retireRefreshSession(next,account,ctx);
                await ctx.db.run("UPDATE refresh_delivery_receipts SET state='cancelled',ciphertext=NULL,iv=NULL WHERE original_session_id=?",old.id);
            }
        }else{
            if(old.refresh_consumed_at!==null||await ctx.db.one('SELECT original_session_id FROM refresh_delivery_receipts WHERE rotation_key=?',request.rotation_key))invalid();
            await assertPrivacyActor(actor(old,account),ctx,true);
            await retireRefreshSession(old,account,ctx);
            await ctx.db.run(`INSERT INTO refresh_delivery_receipts(original_session_id,account_id,rotation_key,secret_hash,state,created_at,expires_at)
                VALUES(?,?,?,?,'cancelled',?,?)`,old.id,account.id,request.rotation_key,request.secretHash,ctx.now(),Math.min(ctx.now()+DELIVERY_MS,old.refresh_expires_at));
        }
        return ok({protocol:REFRESH_DELIVERY_PROTOCOL,rotation_key:request.rotation_key,account_id:account.id,status:'cancelled'});
    });
}
/** Bounded cleanup; account erasure also cascades through session foreign keys.
 * Pruned receipts fail closed as refresh_invalid, never create a new successor. */
export async function pruneRefreshDeliveries(ctx: AppContext): Promise<void> {
    await ctx.db.run(`DELETE FROM refresh_delivery_receipts WHERE original_session_id IN(
        SELECT original_session_id FROM refresh_delivery_receipts WHERE expires_at<=? ORDER BY expires_at,original_session_id LIMIT 100)`,ctx.now());
}
