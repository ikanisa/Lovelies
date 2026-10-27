import { accountRoles, assertRefreshActor, assertPrivacyActor, base64url, decodeBase64url, insertPreparedSession, prepareSession, revokeSessionAuthority,
    type AccountRow, type SessionRow } from './auth.ts';
import { ApiError, digest, ok, stable, type Actor, type AppContext } from './types.ts';
import { sessionRetirementScope } from './session-retirement.ts';
import { unusedPendingConsents } from './face-profile.ts';
import { restoreOperationID } from './restore-transaction.ts';

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
type CancellationFact = { kind: 'session-retired' | 'consent-withdrawn'; scope: Record<string, string> };
const journalUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
async function activePeers(session: SessionRow, ctx: AppContext) {
    return session.device_id === null ? [] : await ctx.db.all<{id:string;account_id:string;device_id:string;device_revision:string|null;auth_epoch:number;auth_method:string;revoked_at:number|null;refresh_consumed_at:number|null;created_at:number}>(`SELECT id,account_id,device_id,device_revision,auth_epoch,auth_method,revoked_at,refresh_consumed_at,created_at FROM sessions
        WHERE account_id=? AND device_id=? AND id<>? AND revoked_at IS NULL ORDER BY id`,session.account_id,session.device_id,session.id);
}
/** Snapshot every unrevoked peer, including foreign-generation peers, before
 * deciding whether device-scoped push cleanup belongs to this exact session. */
async function retirementSelection(session: SessionRow, account: AccountRow, ctx: AppContext) {
    const scope = await sessionRetirementScope(ctx, session);
    const peers = await activePeers(session,ctx);
    const exactDevice = session.auth_method === 'registered_face' && session.device_id !== null && session.device_revision !== null &&
        session.revoked_at === null && session.refresh_consumed_at === null && account.disabled_at === null &&
        account.auth_epoch === session.auth_epoch && account.identity_state === session.auth_method &&
        scope.device !== null && scope.device.status === 'active' && scope.device.revision === session.device_revision;
    const pending = scope.cancelDeviceLifecycle && session.device_id !== null ? await unusedPendingConsents(account.id,ctx,session.device_id) : [];
    return {scope,peers,pending:[...pending].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),clearDevicePush:exactDevice && peers.length===0};
}
async function retireRefreshSession(session: SessionRow, account: AccountRow, selected: Awaited<ReturnType<typeof retirementSelection>>, ctx: AppContext): Promise<void> {
    await revokeSessionAuthority(session.id, account.id, ctx, {...selected.scope,clearDevicePush:selected.clearDevicePush});
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
/** Build a complete read-only selection. Recompute it after asynchronous fact
 * collection: uncertain or changed authority never authorizes broader cleanup. */
async function cancellationSelection(request: Input, hash: string, ctx: AppContext) {
    const old=await ctx.db.one<SessionRow>('SELECT * FROM sessions WHERE refresh_hash=?',hash);
    const account=old&&await ctx.db.one<AccountRow>('SELECT * FROM accounts WHERE id=?',old.account_id);
    if(!old||!account)invalid();
    const prior=await ctx.db.one<Receipt>('SELECT * FROM refresh_delivery_receipts WHERE original_session_id=?',old.id);
    if(prior && (prior.original_session_id!==old.id||prior.account_id!==account.id||prior.rotation_key!==request.rotation_key||prior.secret_hash!==request.secretHash))invalid();
    if(prior?.state==='cancelled')return {old,account,prior,next:null,retirement:null,facts:[] as CancellationFact[],mode:'already-cancelled' as const};
    if(!journalUUID.test(old.id))throw new ApiError(409,'refresh_cancel_metadata_invalid');
    let next:SessionRow|null=null,retirement:Awaited<ReturnType<typeof retirementSelection>>|null=null;
    let mode:'pre-dispatch'|'delivered';
    if(prior){
        if(prior.state!=='active'||!prior.successor_session_id||!journalUUID.test(prior.successor_session_id)||prior.successor_session_id===old.id||
            old.revoked_at===null||old.refresh_consumed_at===null||!prior.ciphertext||!prior.iv)throw new ApiError(409,'refresh_cancel_metadata_invalid');
        next=await ctx.db.one<SessionRow>('SELECT * FROM sessions WHERE id=? AND account_id=?',prior.successor_session_id,account.id);
        if(!next||next.created_at!==prior.created_at||next.account_id!==old.account_id||
            next.auth_method!==old.auth_method||next.auth_epoch!==old.auth_epoch||next.device_id!==old.device_id||next.device_revision!==old.device_revision||
            next.face_profile_revision!==old.face_profile_revision||next.face_profile_epoch!==old.face_profile_epoch||next.face_consent_id!==old.face_consent_id)
            throw new ApiError(409,'refresh_cancel_metadata_invalid');
        if(next.revoked_at===null&&next.refresh_consumed_at===null)retirement=await retirementSelection(next,account,ctx);
        mode='delivered';
    }else{
        if(old.refresh_consumed_at!==null||await ctx.db.one('SELECT original_session_id FROM refresh_delivery_receipts WHERE rotation_key=?',request.rotation_key))invalid();
        await assertPrivacyActor(actor(old,account),ctx,true);
        retirement=await retirementSelection(old,account,ctx);mode='pre-dispatch';
    }
    const facts:CancellationFact[]=[{kind:'session-retired',scope:{account_id:account.id,session_id:old.id}},
        ...(next?[{kind:'session-retired' as const,scope:{account_id:account.id,session_id:next.id}}]:[]),
        ...(retirement?.pending??[]).filter(row=>row.status!=='revoked').map<CancellationFact>(row=>({kind:'consent-withdrawn',scope:{account_id:row.account_id,consent_id:row.id,purpose:row.purpose}}))];
    return {old,account,prior,next,retirement,mode,facts:[...new Map(facts.map(fact=>[stable(fact),fact])).entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,fact])=>fact)};
}
/** Validate original actor/receipt and the intended terminal writes without
 * authenticating a session that this same transaction just retired. No product
 * authority or new credentials are released by this operation. */
async function terminalCancellation(selected: Awaited<ReturnType<typeof cancellationSelection>>, request: Input,
    retiredAt: number, ctx: AppContext): Promise<void> {
    const {old,account,prior,next,retirement,mode}=selected;
    const currentAccount=await ctx.db.one<AccountRow>('SELECT * FROM accounts WHERE id=?',account.id);
    const original=await ctx.db.one<SessionRow>('SELECT * FROM sessions WHERE id=? AND account_id=?',old.id,account.id);
    const named=next?await ctx.db.one<SessionRow>('SELECT * FROM sessions WHERE id=? AND account_id=?',next.id,account.id):null;
    const receipt=await ctx.db.one<Receipt>('SELECT * FROM refresh_delivery_receipts WHERE original_session_id=?',old.id);
    const expectedOld=mode==='pre-dispatch'?{...old,revoked_at:retiredAt,refresh_consumed_at:retiredAt}:old;
    const expectedNext=next&&retirement?{...next,revoked_at:retiredAt,refresh_consumed_at:retiredAt}:next;
    const expectedReceipt=mode==='pre-dispatch'?{original_session_id:old.id,account_id:account.id,rotation_key:request.rotation_key,
        secret_hash:request.secretHash,successor_session_id:null,state:'cancelled',ciphertext:null,iv:null,
        created_at:retiredAt,expires_at:Math.min(retiredAt+DELIVERY_MS,old.refresh_expires_at)}:
        prior?{...prior,state:'cancelled',ciphertext:null,iv:null}:null;
    if(!currentAccount||stable(currentAccount)!==stable(account)||!original||stable(original)!==stable(expectedOld)||
        stable(named)!==stable(expectedNext)||stable(receipt)!==stable(expectedReceipt))
        throw new ApiError(409,'refresh_cancel_authority_changed');
    if(retirement){
        const target=mode==='pre-dispatch'?old:next!;
        if(stable(await activePeers(target,ctx))!==stable(retirement.peers))throw new ApiError(409,'refresh_cancel_authority_changed');
        const device=target.device_id===null?null:await ctx.db.one('SELECT id,account_id,revision,status FROM auth_devices WHERE id=? AND account_id=?',target.device_id,account.id);
        if(stable(device)!==stable(retirement.scope.device))throw new ApiError(409,'refresh_cancel_authority_changed');
        if(retirement.scope.cancelDeviceLifecycle){
            for(const control of retirement.scope.controls){
                const row=await ctx.db.one('SELECT operation_key,control_device_id,control_revision,auth_epoch,consent_id,challenge_id,generation,created_at,state FROM face_profile_operations WHERE account_id=? AND operation_key=?',account.id,control.operation_key);
                if(stable(row)!==stable({...control,state:'cancelled'}))throw new ApiError(409,'refresh_cancel_authority_changed');
            }
            for(const consent of retirement.pending){
                const row=await ctx.db.one<{account_id:string;id:string;purpose:string;status:string;revoked_at:number|null}>('SELECT account_id,id,purpose,status,revoked_at FROM consents WHERE id=?',consent.id);
                if(!row||row.account_id!==consent.account_id||row.id!==consent.id||row.purpose!==consent.purpose||row.status!=='revoked'||
                    (consent.status!=='revoked'&&row.revoked_at!==retiredAt))throw new ApiError(409,'refresh_cancel_authority_changed');
            }
        }
        const changedChallenges=[...(retirement.scope.cancelSessionChallenges?retirement.scope.challenges:[]),
            ...(retirement.scope.cancelDeviceLifecycle?retirement.scope.linked:[])];
        const uniqueChallenges=[...new Map(changedChallenges.map(row=>[row.id,row])).values()];
        for(const challenge of uniqueChallenges){
            const row=await ctx.db.one('SELECT id,account_id,device_id,device_revision,auth_epoch,purpose,status,consent_id,profile_id,profile_revision,expires_at,session_id,used_at FROM auth_challenges WHERE id=?',challenge.id);
            if(stable(row)!==stable({...challenge,status:'cancelled',used_at:retiredAt}))throw new ApiError(409,'refresh_cancel_authority_changed');
        }
    }
    // Access expiry is deliberately allowed by the endpoint. Refresh expiry is
    // sampled after every final read only for the original pre-dispatch actor;
    // an already delivered secret-bound capability needs no current session.
    if(mode==='pre-dispatch'&&old.refresh_expires_at<=ctx.now())throw new ApiError(401,'session_invalid');
}
/** A saved delivery capability cancels one exact exchange. Independently
 * accepted restrictions suppress its original and named successor on recovery;
 * no session descendant or separate device is selected by this operation. */
export async function cancelRefreshDelivery(body: Record<string, unknown>, ctx: AppContext): Promise<Response> {
    const request=await input(body),hash=await digest(request.refresh_token);
    return ctx.db.transaction(async restore=>{
        const selected=await cancellationSelection(request,hash,ctx),{old,account,prior,next,retirement,mode}=selected;
        if(mode!=='already-cancelled'){
            if(selected.facts.length>32)throw new ApiError(503,'refresh_cancel_restriction_capacity');
            const capability=await digest(stable({protocol:'lovelies-refresh-cancel-capability-v1',rotation_key:request.rotation_key,secret_hash:request.secretHash}));
            restore.operation({operation_id:await restoreOperationID(account.id,'auth.refresh-cancel-v1','refresh.cancel:'+old.id),
                input_hash:await digest(stable({protocol:'lovelies-refresh-cancel-v1',account_id:account.id,original_session_id:old.id,
                    successor_session_id:next?.id??null,mode,capability})),allocations:{}});
            for(const fact of selected.facts)await restore.restrict(fact.kind,fact.scope);
            if(stable(await cancellationSelection(request,hash,ctx))!==stable(selected))throw new ApiError(409,'refresh_cancel_authority_changed');
            const retiredAt=ctx.now(),effectCtx:AppContext={...ctx,now:()=>retiredAt};
            if(mode==='pre-dispatch'){
                await assertPrivacyActor(actor(old,account),ctx,true);
                await retireRefreshSession(old,account,retirement!,effectCtx);
                await ctx.db.run(`INSERT INTO refresh_delivery_receipts(original_session_id,account_id,rotation_key,secret_hash,state,created_at,expires_at)
                    VALUES(?,?,?,?,'cancelled',?,?)`,old.id,account.id,request.rotation_key,request.secretHash,retiredAt,Math.min(retiredAt+DELIVERY_MS,old.refresh_expires_at));
            }else{
                if(next&&retirement)await retireRefreshSession(next,account,retirement,effectCtx);
                await ctx.db.run("UPDATE refresh_delivery_receipts SET state='cancelled',ciphertext=NULL,iv=NULL WHERE original_session_id=? AND account_id=? AND rotation_key=? AND secret_hash=? AND state='active'",old.id,account.id,request.rotation_key,request.secretHash);
            }
            await terminalCancellation(selected,request,retiredAt,ctx);
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
