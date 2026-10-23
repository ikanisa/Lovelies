import { afterEach, describe, expect, it } from 'vitest';
import { schemaFixture } from './schema-fixture';
import { digest, stable, type Actor } from '../src/types';
import { handleEntitlements, persistVerifiedPurchase, entitlementSummary, entitlementPrivacyRows } from '../src/entitlements';
import { handleOperators, eraseOperatorSubject, operatorPrivacyRows } from '../src/operators';
import { handleNotifications, enqueueNotification, flushNotificationOutbox, processNotificationJob, notificationPrivacyRows, eraseNotificationSubject } from '../src/notifications';
import { handleRetention, runRetention, nextRetentionAt, retentionPrivateKeys, eraseRetentionSubject } from '../src/retention';
import { beginMediaWrite, settleMediaWrite } from '../src/operations';
import { collectPrivacyExport, createPrivacyRequest, reviewPrivacyRequest, processPrivacyRequest } from '../src/privacy';

const fixtures:ReturnType<typeof schemaFixture>[]=[];
const fixture=()=>{const value=schemaFixture();fixtures.push(value);return value;};
afterEach(()=>{for(const f of fixtures.splice(0))f.close();});
const key=(name:string)=>name+'-'+crypto.randomUUID();
const request=(path:string,body?:unknown,method=body===undefined?'GET':'POST')=>new Request('https://app.lovelies.test'+path,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
type StoreReply = { active:boolean; financial_eligible:boolean };
type DownloadReply = { download_url:string };
type SupportCreatedReply = { id:string };
type SupportListReply = { support_requests:unknown[] };
type SupportReviewedReply = { support_request:{ status:string } };
type BlockReply = { blocked:boolean; access_restored:boolean };
type ItemsReply = { items:unknown[] };
type ReportReply = { id:string };
type ReportReviewedReply = { revision:number; access_restored:boolean };
type RetentionReply = { policy:{ version:number; raw_days:number } };
const json=async<T=unknown>(value:Response|null):Promise<T>=>{if(!value)throw new Error('route not handled');return value.json() as Promise<T>;};
function configured(f:ReturnType<typeof fixture>){Object.assign(f.ctx.env,{APPLE_BUNDLE_ID:'app.lovelies.ios',APPLE_APP_ID:'987654321',APPLE_SUBSCRIPTION_PRODUCT_ID:'app.lovelies.pro.monthly',GOOGLE_PLAY_PACKAGE_NAME:'app.lovelies.android',GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID:'app.lovelies.pro.monthly'});}
function purchase(f:ReturnType<typeof fixture>,actor:Actor,extra:Record<string,unknown>={}) {
  configured(f);return {provider:'apple' as const,app:f.ctx.env.APPLE_BUNDLE_ID!+':'+f.ctx.env.APPLE_APP_ID!,account:actor.accountId,original:key('original'),transaction:key('transaction'),product:f.ctx.env.APPLE_SUBSCRIPTION_PRODUCT_ID!,environment:'production' as const,starts:f.ctx.now()-1000,expires:f.ctx.now()+86400000,observed:f.ctx.now(),active:true,hash:'a'.repeat(64),acknowledged:true,...extra};
}
function apple(f:ReturnType<typeof fixture>,actor:Actor,extra:Record<string,unknown>={}){return {bundleId:f.ctx.env.APPLE_BUNDLE_ID,productId:f.ctx.env.APPLE_SUBSCRIPTION_PRODUCT_ID,type:'Auto-Renewable Subscription',inAppOwnershipType:'PURCHASED',appAccountToken:actor.accountId,environment:'Production',purchaseDate:f.ctx.now()-1000,expiresDate:f.ctx.now()+86400000,signedDate:f.ctx.now(),originalTransactionId:key('original'),transactionId:key('transaction'),...extra};}
function privateStore(f:ReturnType<typeof fixture>,verify:(path:string,input:any)=>Promise<any>|any){
  f.ctx.env.STORE_VERIFIER={fetch:async(input:RequestInfo,init?:RequestInit)=>{const req=new Request(input,init),envelope=await req.json() as any;expect(envelope.input_hash).toBe(await digest(stable(envelope.input)));const payload=await verify(new URL(req.url).pathname,envelope.input);return Response.json({protocol:envelope.protocol,input_hash:envelope.input_hash,verified:true,payload});}} as unknown as Fetcher;
}
async function asset(f:ReturnType<typeof fixture>,actor:Actor,{old=false}={}){
  const id=crypto.randomUUID(),version=crypto.randomUUID(),sourceKey='quarantine/'+id,previewKey='preview/'+id,bytes=new TextEncoder().encode('synthetic-original:'+id),checksum=await digest(bytes);
  f.db.run("INSERT INTO consents(id,account_id,purpose,policy_version,status,created_at) VALUES(?,?,'photo_processing','fixture','granted',?)",crypto.randomUUID(),actor.accountId,f.ctx.now());
  f.db.run("INSERT INTO assets(id,owner_id,source,status,object_key,content_type,byte_size,checksum_sha256,version,width,height,created_at) VALUES(?,?,'personal','ready',?,'image/jpeg',?,?,?,?,?,?)",id,actor.accountId,sourceKey,bytes.byteLength,checksum,version,100,150,f.ctx.now()-(old?61*86400000:0));
  f.db.run("INSERT INTO renditions(id,asset_id,object_key,content_type,byte_size,checksum_sha256,source_checksum_sha256,version,width,height,verified_at,status,source_version,kind) VALUES(?,?,?,'image/jpeg',1,?,?,?,100,150,?,'ready',?,'preview')",crypto.randomUUID(),id,previewKey,'b'.repeat(64),checksum,crypto.randomUUID(),f.ctx.now(),version);
  f.quarantine.values.set(sourceKey,bytes);f.photos.values.set(previewKey,new Uint8Array([1]));return {id,version,sourceKey,previewKey,bytes,checksum};
}
function downloadBucket(f:ReturnType<typeof fixture>,photo:Awaited<ReturnType<typeof asset>>){
  const originalGet=f.quarantine.get.bind(f.quarantine),originalHead=f.quarantine.head.bind(f.quarantine);
  const metadata={etag:'verified-source-etag',httpMetadata:{contentType:'image/jpeg'},customMetadata:{source_version:photo.version,source_checksum_sha256:photo.checksum}};
  f.quarantine.get=async name=>{const object=await originalGet(name);return object?{...(object as object),...metadata}:null;};f.quarantine.head=async name=>{const object=await originalHead(name);return object?{...(object as object),...metadata}:null;};
}
async function pushDevice(f:ReturnType<typeof fixture>,actor:Actor){f.setActor(actor);return json<{id:string}>(await handleNotifications(request('/me/push-devices',{platform:'ios',push_token:key('private-token'),operation_key:key('device')}),f.ctx));}
async function callOperators<T=unknown>(f:ReturnType<typeof fixture>,actor:Actor,path:string,body?:unknown,method?:string){f.setActor(actor);return json<T>(await handleOperators(request(path,body,method),f.ctx));}

describe('verified native-store entitlement and exact original-download authority',()=>{
  it('requires explicit provider configuration and does not silently assume donor app identities',async()=>{
    const f=fixture(),owner=f.actor();f.setActor(owner);
    await expect(handleEntitlements(request('/subscriptions/apple/transactions',{product_id:'com.lovelies.memories.pro.monthly',signed_transaction:'a.b.c',operation_key:key('store')}),f.ctx)).rejects.toThrow('apple_verifier_unconfigured');
    await expect(handleEntitlements(request('/subscriptions/google/transactions',{product_id:'anything',purchase_token:key('token'),operation_key:key('store')}),f.ctx)).rejects.toThrow('google_play_verifier_unconfigured');
    expect(f.db.one('SELECT count(*) n FROM store_subscriptions')).toEqual({n:0});
  });
  it('verifies configured app/product and binds the private proof envelope before persisting',async()=>{
    const f=fixture(),owner=f.actor();configured(f);f.setActor(owner);const tx=apple(f,owner);
    privateStore(f,(path,input)=>{expect(path).toBe('/apple/transaction');expect(input.bundle_id).toBe('app.lovelies.ios');expect(input.app_id).toBe(987654321);expect(input.product_id).toBe('app.lovelies.pro.monthly');return tx;});
    const body={product_id:f.ctx.env.APPLE_SUBSCRIPTION_PRODUCT_ID,signed_transaction:'signed.proof.payload',operation_key:key('store')};
    const first=await json<StoreReply>(await handleEntitlements(request('/subscriptions/apple/transactions',body),f.ctx));expect(first.active).toBe(true);expect(first.financial_eligible).toBe(true);
    expect(await json<StoreReply>(await handleEntitlements(request('/subscriptions/apple/transactions',body),f.ctx))).toEqual(first);
    expect(f.db.one('SELECT count(*) n FROM store_transactions')).toEqual({n:1});expect(entitlementSummary(f.ctx,owner).pro_active).toBe(true);
    f.ctx.env.APPLE_BUNDLE_ID='different.lovelies.app';expect(entitlementSummary(f.ctx,owner).pro_active).toBe(false);
  });
  it('rejects forged/unbound verifier output and an authentically verified foreign account receipt',async()=>{
    const f=fixture(),owner=f.actor(),peer=f.actor();configured(f);f.setActor(owner);
    f.ctx.env.STORE_VERIFIER={fetch:async()=>Response.json({protocol:'lovelies-store-verifier-v1',input_hash:'wrong',verified:true,payload:apple(f,owner)})} as unknown as Fetcher;
    const body={product_id:f.ctx.env.APPLE_SUBSCRIPTION_PRODUCT_ID,signed_transaction:'a.b.c',operation_key:key('store')};
    await expect(handleEntitlements(request('/subscriptions/apple/transactions',body),f.ctx)).rejects.toThrow('store_verification_unbound');
    privateStore(f,()=>apple(f,peer));await expect(handleEntitlements(request('/subscriptions/apple/transactions',{...body,operation_key:key('store')}),f.ctx)).rejects.toThrow('apple_account_mismatch');
    expect(f.db.one('SELECT count(*) n FROM store_transactions')).toEqual({n:0});
  });
  it('fences revocation while provider verification is awaiting and never saves a late entitlement',async()=>{
    const f=fixture(),owner=f.actor();configured(f);f.setActor(owner);
    privateStore(f,()=>{f.db.run('UPDATE sessions SET revoked_at=? WHERE id=?',f.ctx.now(),owner.sessionId);return apple(f,owner);});
    await expect(handleEntitlements(request('/subscriptions/apple/transactions',{product_id:f.ctx.env.APPLE_SUBSCRIPTION_PRODUCT_ID,signed_transaction:'a.b.c',operation_key:key('store')}),f.ctx)).rejects.toThrow();
    expect(f.db.one('SELECT count(*) n FROM store_subscriptions')).toEqual({n:0});
  });
  it('keeps sandbox financially ineligible and prevents same-original cross-account ownership',()=>{
    const f=fixture(),owner=f.actor(),peer=f.actor(),value=purchase(f,owner,{environment:'sandbox'});
    const result=f.db.transaction(()=>persistVerifiedPurchase(f.ctx,value));expect(result.active).toBe(true);expect(result.financial_eligible).toBe(false);expect(entitlementSummary(f.ctx,owner).pro_active).toBe(false);
    expect(()=>f.db.transaction(()=>persistVerifiedPurchase(f.ctx,{...value,account:peer.accountId}))).toThrow('store_original_owner_conflict');
  });
  it('a stale receipt cannot reactivate a newer refund and a newer real period can renew',()=>{
    const f=fixture(),owner=f.actor(),value=purchase(f,owner);f.db.transaction(()=>persistVerifiedPurchase(f.ctx,value));
    f.advance(100);f.db.transaction(()=>persistVerifiedPurchase(f.ctx,{...value,active:false,observed:f.ctx.now()}));
    expect(f.db.transaction(()=>persistVerifiedPurchase(f.ctx,value)).stale).toBe(true);expect(entitlementSummary(f.ctx,owner).pro_active).toBe(false);
    f.advance(100);f.db.transaction(()=>persistVerifiedPurchase(f.ctx,{...value,transaction:key('renewal'),observed:f.ctx.now(),expires:f.ctx.now()+86400000}));expect(entitlementSummary(f.ctx,owner).pro_active).toBe(true);
  });
  it('uses current Publisher facts, account hash and acknowledgment rather than client subscription flags',async()=>{
    const f=fixture(),owner=f.actor();configured(f);f.setActor(owner);let acknowledges=0,observedInput:any;
    const raw={kind:'androidpublisher#subscriptionPurchaseV2',subscriptionState:'SUBSCRIPTION_STATE_ACTIVE',acknowledgementState:'ACKNOWLEDGEMENT_STATE_PENDING',startTime:new Date(f.ctx.now()-1000).toISOString(),externalAccountIdentifiers:{obfuscatedExternalAccountId:await digest(owner.accountId)},lineItems:[{productId:f.ctx.env.GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID,expiryTime:new Date(f.ctx.now()+86400000).toISOString(),latestSuccessfulOrderId:key('order')}]};
    privateStore(f,(path,input)=>{if(path==='/google/acknowledge'){acknowledges++;expect(input.obfuscatedAccountId).toBe(raw.externalAccountIdentifiers.obfuscatedExternalAccountId);return {acknowledged:true};}expect(path).toBe('/google/subscription');observedInput=input;return raw;});
    const result=await json<StoreReply>(await handleEntitlements(request('/subscriptions/google/transactions',{product_id:f.ctx.env.GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID,purchase_token:key('publisher-token'),operation_key:key('google')}),f.ctx));expect(result.active).toBe(true);expect(acknowledges).toBe(1);expect(observedInput.packageName).toBe('app.lovelies.android');expect(entitlementSummary(f.ctx,owner).pro_active).toBe(true);
  });
  it('does not grant a Publisher on-hold state, sandbox test purchase or contradictory account binding',async()=>{
    for(const variant of ['on_hold','sandbox','foreign']){
      const f=fixture(),owner=f.actor();configured(f);f.setActor(owner);
      const raw={kind:'androidpublisher#subscriptionPurchaseV2',subscriptionState:variant==='on_hold'?'SUBSCRIPTION_STATE_ON_HOLD':'SUBSCRIPTION_STATE_ACTIVE',acknowledgementState:'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',startTime:new Date(f.ctx.now()-1000).toISOString(),externalAccountIdentifiers:{obfuscatedExternalAccountId:variant==='foreign'?'foreign-account':await digest(owner.accountId)},lineItems:[{productId:f.ctx.env.GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID,expiryTime:new Date(f.ctx.now()+86400000).toISOString(),latestSuccessfulOrderId:key('order')}],...(variant==='sandbox'?{testPurchase:{}}:{})};
      privateStore(f,()=>raw);const response=handleEntitlements(request('/subscriptions/google/transactions',{product_id:f.ctx.env.GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID,purchase_token:key('publisher-token'),operation_key:key('google')}),f.ctx);
      if(variant==='foreign')await expect(response).rejects.toThrow('google_account_mismatch');else {const result=await json<StoreReply>(await response);expect(result.financial_eligible).toBe(variant!=='sandbox');}
      expect(entitlementSummary(f.ctx,owner).pro_active).toBe(false);
    }
  });
  it('rejects unsigned Google notifications and leaves unsupported payment routes absent',async()=>{
    const f=fixture(),owner=f.actor();configured(f);f.setActor(owner);
    await expect(handleEntitlements(request('/subscriptions/google/notifications',{}),f.ctx)).rejects.toThrow('google_notification_auth_unconfigured');
    for(const path of ['/subscriptions/momo-ussd-requests','/admin/momo-providers','/creator-revenue/payout-batches'])expect(await handleEntitlements(request(path,{}),f.ctx)).toBeNull();
    expect(f.db.one('SELECT count(*) n FROM store_subscriptions')).toEqual({n:0});
  });
  it('releases actual digest-verified source bytes only under current production entitlement and access',async()=>{
    const f=fixture(),owner=f.actor(),photo=await asset(f,owner);downloadBucket(f,photo);f.setActor(owner);
    await expect(handleEntitlements(request('/downloads/sign',{asset_id:photo.id,operation_key:key('download')}),f.ctx)).rejects.toThrow('missing_entitlement');
    f.db.transaction(()=>persistVerifiedPurchase(f.ctx,purchase(f,owner)));
    const signed=await json<DownloadReply>(await handleEntitlements(request('/downloads/sign',{asset_id:photo.id,operation_key:key('download')}),f.ctx));expect(signed.download_url).not.toContain(photo.sourceKey);
    const response=await handleEntitlements(new Request(signed.download_url),f.ctx);expect(response?.headers.get('Cache-Control')).toBe('no-store, private');expect(new Uint8Array(await response!.arrayBuffer())).toEqual(photo.bytes);
    expect(f.db.one('SELECT count(*) n FROM download_records')).toEqual({n:1});
  });
  it('rechecks refund, hold, source and credential changes after R2 awaits',async()=>{
    for(const drift of ['refund','hold','source','session']){
      const f=fixture(),owner=f.actor(),photo=await asset(f,owner);downloadBucket(f,photo);f.setActor(owner);f.db.transaction(()=>persistVerifiedPurchase(f.ctx,purchase(f,owner)));
      const signed=await json<DownloadReply>(await handleEntitlements(request('/downloads/sign',{asset_id:photo.id,operation_key:key('download')}),f.ctx));
      f.quarantine.onGet=()=>{if(drift==='refund')f.db.run('UPDATE store_subscriptions SET active=0,version=version+1 WHERE account_id=?',owner.accountId);if(drift==='hold')f.db.run('INSERT INTO moderation_holds(id,asset_id,active,created_at,reason) VALUES(?,?,1,?,?)',crypto.randomUUID(),photo.id,f.ctx.now(),'Reviewed hold');if(drift==='source')f.db.run('UPDATE assets SET version=? WHERE id=?',crypto.randomUUID(),photo.id);if(drift==='session')f.db.run('UPDATE sessions SET revoked_at=? WHERE id=?',f.ctx.now(),owner.sessionId);};
      await expect(handleEntitlements(new Request(signed.download_url),f.ctx)).rejects.toThrow();expect(f.db.one('SELECT count(*) n FROM download_records')).toEqual({n:0});
    }
  });
});

describe('operator, safety and subject-erasure boundaries',()=>{
  it('support creation and reads remain account-bound; foreign reads and native users cannot administer',async()=>{
    const f=fixture(),owner=f.actor(),peer=f.actor();const row=await callOperators<SupportCreatedReply>(f,owner,'/support/requests',{subject:'Upload help',details:'My upload needs review',operation_key:key('support')});
    expect((await callOperators<SupportListReply>(f,owner,'/support/requests')).support_requests).toHaveLength(1);
    expect((await callOperators<SupportListReply>(f,peer,'/support/requests')).support_requests).toHaveLength(0);
    await expect(callOperators(f,peer,'/support/requests/'+row.id)).rejects.toThrow('support_request_not_found');
    await expect(callOperators(f,owner,'/admin/support-requests')).rejects.toThrow('admin_required');
  });
  it('support review is revision-bound and generates one private inbox notification',async()=>{
    const f=fixture(),owner=f.actor(),admin=f.actor(['user','admin']);const row=await callOperators<SupportCreatedReply>(f,owner,'/support/requests',{subject:'Library help',details:'Please inspect my library',operation_key:key('support')});
    const reviewed=await callOperators<SupportReviewedReply>(f,admin,'/admin/support-requests/'+row.id+'/approve',{expected_revision:1,review_notes:'Resolved through current account',operation_key:key('review')});expect(reviewed.support_request.status).toBe('resolved');
    await expect(callOperators(f,admin,'/admin/support-requests/'+row.id+'/approve',{expected_revision:1,operation_key:key('review')})).rejects.toThrow('support_revision_changed');
    expect(f.db.one('SELECT count(*) n FROM notifications WHERE account_id=?',owner.accountId)).toEqual({n:1});
  });
  it('retired photographer routes do not create requests or alter roles',async()=>{
    const f=fixture(),owner=f.actor(),admin=f.actor(['user','admin']);
    for(const actor of [owner,admin])for(const path of ['/me/photographer-request','/me/photographer-access/activate','/admin/photographer-requests',`/admin/photographer-requests/${crypto.randomUUID()}/approve`,`/admin/photographer-requests/${crypto.randomUUID()}/reject`]) {
      f.setActor(actor);expect(await handleOperators(request(path),f.ctx)).toBeNull();
      expect(await handleOperators(request(path,{operation_key:key('retired')}),f.ctx)).toBeNull();
    }
    expect(f.db.one('SELECT count(*) n FROM photographer_requests')).toEqual({n:0});
    expect(f.db.one('SELECT roles_json FROM accounts WHERE id=?',owner.accountId)).toEqual({roles_json:'["user"]'});
  });
  it('block, list and removal retain bilateral revocation without restoring approvals',async()=>{
    const f=fixture(),owner=f.actor(),peer=f.actor();const body={operation_key:key('block')};
    expect((await callOperators<BlockReply>(f,owner,'/me/blocks/'+peer.accountId,body)).blocked).toBe(true);expect((await callOperators<ItemsReply>(f,owner,'/me/blocks')).items).toHaveLength(1);
    const removed=await callOperators<BlockReply>(f,owner,'/me/blocks/'+peer.accountId,{operation_key:key('unblock')},'DELETE');expect(removed.blocked).toBe(false);expect(removed.access_restored).toBe(false);expect((await callOperators<ItemsReply>(f,owner,'/me/blocks')).items).toHaveLength(0);
    await expect(callOperators(f,owner,'/me/blocks/'+owner.accountId,{operation_key:key('self-block')})).rejects.toThrow('self_block_invalid');
  });
  it('operator holds require an independently reviewed exact report and release never restores access',async()=>{
    const f=fixture(),owner=f.actor(),peer=f.actor(),admin=f.actor(['user','admin']),photo=await asset(f,owner);
    const report=await callOperators<ReportReply>(f,owner,'/safety/reports',{subject_id:peer.accountId,asset_id:photo.id,reason:'Please review this actual photograph',operation_key:key('report')});
    const path='/admin/safety/reports/'+report.id+'/resolve';await expect(callOperators(f,owner,path,{action:'hold',expected_revision:1,reason:'Review hold',operation_key:key('hold')})).rejects.toThrow('admin_required');
    const held=await callOperators<ReportReviewedReply>(f,admin,path,{action:'hold',expected_revision:1,reason:'Review hold',operation_key:key('hold')});expect(held.revision).toBe(2);expect(f.db.one('SELECT count(*) n FROM moderation_holds WHERE active=1')).toEqual({n:1});
    const cleared=await callOperators<ReportReviewedReply>(f,admin,path,{action:'release',expected_revision:2,reason:'Review completed',operation_key:key('release')});expect(cleared.access_restored).toBe(false);expect(f.db.one('SELECT count(*) n FROM moderation_holds WHERE active=1')).toEqual({n:0});
  });
  it('clears erased-owner asset/report/hold foreign keys before actual asset deletion',async()=>{
    const f=fixture(),owner=f.actor(),peer=f.actor(),photo=await asset(f,owner),report=crypto.randomUUID();
    f.db.run("INSERT INTO safety_reports(id,reporter_id,subject_id,asset_id,reason,status,created_at) VALUES(?,?,?,?,'Private text','open',?)",report,peer.accountId,owner.accountId,photo.id,f.ctx.now());
    f.db.run("INSERT INTO moderation_holds(id,asset_id,report_id,active,created_at,reason) VALUES(?,?,?,1,?,'Held asset')",crypto.randomUUID(),photo.id,report,f.ctx.now());
    f.db.transaction(()=>{eraseOperatorSubject(f.db,owner.accountId,f.ctx.now());f.db.run('DELETE FROM renditions WHERE asset_id=?',photo.id);f.db.run('DELETE FROM assets WHERE id=?',photo.id);});
    expect(f.db.one('SELECT asset_id,reason FROM safety_reports WHERE id=?',report)).toEqual({asset_id:null,reason:'Erased personal content'});expect(f.db.one('SELECT count(*) n FROM moderation_holds')).toEqual({n:0});expect(f.db.all('PRAGMA foreign_key_check')).toEqual([]);
  });
});

describe('durable notification preferences and provider ambiguity',()=>{
  it('partial preference changes preserve existing mutes and never queue opted-out work',async()=>{
    const f=fixture(),owner=f.actor();f.setActor(owner);
    await handleNotifications(request('/me/notification-settings',{match_alerts:false,operation_key:key('mute')},'PATCH'),f.ctx);
    const updated=await json(await handleNotifications(request('/me/notification-settings',{support_alerts:false,operation_key:key('mute')},'PATCH'),f.ctx));expect(updated).toMatchObject({match_alerts:false,payment_alerts:true,support_alerts:false});
    expect(enqueueNotification(f.ctx,owner.accountId,'match',key('request'),'A photo request is waiting')).toBeNull();expect(f.db.one('SELECT count(*) n FROM notification_jobs')).toEqual({n:0});
  });
  it('keeps the inbox private and calls a no-device job inbox-only without fabricated delivery',async()=>{
    const f=fixture(),owner=f.actor(),peer=f.actor(),id=enqueueNotification(f.ctx,owner.accountId,'support',key('entity'),'Your support request was reviewed')!;
    await flushNotificationOutbox(f.ctx);expect(f.sent).toEqual([{category:'notification',payload:{notification_id:id}}]);await processNotificationJob({notification_id:id},f.ctx);
    expect(f.db.one('SELECT status FROM notification_jobs WHERE notification_id=?',id)).toEqual({status:'inbox_only'});expect(f.db.one('SELECT count(*) n FROM notification_deliveries')).toEqual({n:0});
    f.setActor(peer);expect((await json<ItemsReply>(await handleNotifications(request('/me/notifications'),f.ctx))).items).toHaveLength(0);
  });
  it('does not manufacture acceptance when the provider is absent or receipt binding is wrong',async()=>{
    const f=fixture(),owner=f.actor();await pushDevice(f,owner);const id=enqueueNotification(f.ctx,owner.accountId,'support',key('entity'),'Your support request was reviewed')!;
    await expect(processNotificationJob({notification_id:id},f.ctx)).rejects.toThrow('push_provider_unavailable');
    f.ctx.env.PUSH_SERVICE={fetch:async()=>Response.json({status:'accepted',operation_key:'wrong',provider_message_id:'provider-id'})} as unknown as Fetcher;
    await expect(processNotificationJob({notification_id:id},f.ctx)).rejects.toThrow('push_delivery_unconfirmed');expect(f.db.one('SELECT status FROM notification_jobs WHERE notification_id=?',id)).toEqual({status:'ambiguous'});
  });
  it('reconciles the original private operation key after timeout and never resends an unknown outcome',async()=>{
    const f=fixture(),owner=f.actor();await pushDevice(f,owner);let sends=0,queries=0,operation='';
    f.ctx.env.PUSH_SERVICE={fetch:async(input:RequestInfo,init?:RequestInit)=>{const req=new Request(input,init);if(req.method==='POST'){sends++;operation=(await req.json() as any).operation_key;throw new Error('simulated ambiguous timeout');}queries++;return Response.json({status:'unknown',operation_key:operation});}} as unknown as Fetcher;
    const id=enqueueNotification(f.ctx,owner.accountId,'support',key('entity'),'Your support request was reviewed')!;
    await expect(processNotificationJob({notification_id:id},f.ctx)).rejects.toThrow('simulated ambiguous timeout');await expect(processNotificationJob({notification_id:id},f.ctx)).rejects.toThrow('push_reconciliation_required');expect({sends,queries}).toEqual({sends:1,queries:1});
    f.ctx.env.PUSH_SERVICE={fetch:async(input:RequestInfo)=>{expect(new URL(String(input)).pathname).toContain('/operations/');return Response.json({status:'accepted',operation_key:operation,provider_message_id:'accepted-private-id'});}} as unknown as Fetcher;
    await processNotificationJob({notification_id:id},f.ctx);expect(f.db.one('SELECT status,operation_key FROM notification_deliveries')).toEqual({status:'accepted',operation_key:operation});expect(sends).toBe(1);
  });
  it('fences provider acceptance when the account or current authenticated device is revoked during await',async()=>{
    for(const drift of ['account','device']){
      const f=fixture(),owner=f.actor();await pushDevice(f,owner);
      f.ctx.env.PUSH_SERVICE={fetch:async(input:RequestInfo,init?:RequestInit)=>{const body=await new Request(input,init).json() as any;if(drift==='account')f.db.run('UPDATE accounts SET auth_epoch=auth_epoch+1 WHERE id=?',owner.accountId);else f.db.run("UPDATE auth_devices SET status='revoked' WHERE account_id=?",owner.accountId);return Response.json({status:'accepted',operation_key:body.operation_key,provider_message_id:'accepted-id'});}} as unknown as Fetcher;
      const id=enqueueNotification(f.ctx,owner.accountId,'match',key('entity'),'A photo request is waiting')!;await expect(processNotificationJob({notification_id:id},f.ctx)).rejects.toThrow('notification_authority_changed');expect(f.db.one("SELECT count(*) n FROM notification_deliveries WHERE status='accepted'")).toEqual({n:0});
    }
  });
  it('does not export push credentials and erases child delivery/device rows before auth-device removal',async()=>{
    const f=fixture(),owner=f.actor(),device=await pushDevice(f,owner);const exported=JSON.stringify(notificationPrivacyRows(f.ctx,owner.accountId));expect(exported).not.toContain('private-token');expect(exported).not.toContain('token_hash');
    eraseNotificationSubject(f.db,owner.accountId);f.db.run('DELETE FROM sessions WHERE account_id=?',owner.accountId);f.db.run('DELETE FROM auth_devices WHERE account_id=?',owner.accountId);expect(f.db.one('SELECT id FROM push_devices WHERE id=?',device.id)).toBeNull();expect(f.db.all('PRAGMA foreign_key_check')).toEqual([]);
  });
});

describe('bounded purpose-aware retention and erasure integration',()=>{
  it('retains an unexpired library and computes its future maintenance horizon',async()=>{
    const f=fixture(),owner=f.actor(),photo=await asset(f,owner);const deadline=nextRetentionAt(f.ctx);expect(deadline).toBe(f.ctx.now()+60*86400000);
    expect(await runRetention(f.ctx)).toEqual({verified:0,pending:0,failed:0});expect(f.quarantine.values.has(photo.sourceKey)).toBe(true);
  });
  it('expires exact old source/preview keys only after metadata access retirement and absent HEAD',async()=>{
    const f=fixture(),owner=f.actor(),photo=await asset(f,owner,{old:true});
    f.quarantine.onDelete=()=>{expect(f.db.one('SELECT status,deleted_at FROM assets WHERE id=?',photo.id)).toEqual({status:'expired',deleted_at:f.ctx.now()});expect(f.db.one('SELECT status FROM renditions WHERE asset_id=?',photo.id)).toEqual({status:'retired'});};
    expect(await runRetention(f.ctx)).toEqual({verified:1,pending:0,failed:0});expect(f.quarantine.values.has(photo.sourceKey)).toBe(false);expect(f.photos.values.has(photo.previewKey)).toBe(false);expect(f.db.one('SELECT status FROM retention_jobs')).toEqual({status:'verified'});
    expect(f.db.one('SELECT id FROM assets WHERE id=?',photo.id)).not.toBeNull();
  });
  it('honors legal/moderation holds and blocks exact cleanup while an external media writer is unresolved',async()=>{
    const f=fixture(),owner=f.actor(),photo=await asset(f,owner,{old:true}),writer=beginMediaWrite(f.ctx,owner,'QUARANTINE',photo.sourceKey);
    expect((await runRetention(f.ctx)).verified).toBe(0);expect(f.db.one('SELECT count(*) n FROM retention_jobs')).toEqual({n:0});settleMediaWrite(f.ctx,writer);
    f.db.run("INSERT INTO moderation_holds(id,asset_id,active,created_at,reason) VALUES(?,?,1,?,'Current hold')",crypto.randomUUID(),photo.id,f.ctx.now());expect((await runRetention(f.ctx)).verified).toBe(0);expect(f.quarantine.values.has(photo.sourceKey)).toBe(true);
    f.db.run('UPDATE moderation_holds SET active=0');expect((await runRetention(f.ctx)).verified).toBe(1);
  });
  it('does not claim completion for an unconfirmed DELETE and resumes exact durable keys',async()=>{
    const f=fixture(),owner=f.actor(),photo=await asset(f,owner,{old:true});f.quarantine.refuseDelete=true;
    expect((await runRetention(f.ctx)).verified).toBe(0);expect(f.db.one('SELECT status,error_code FROM retention_jobs')).toEqual({status:'failed',error_code:'retention_delete_unconfirmed'});expect(f.quarantine.values.has(photo.sourceKey)).toBe(true);
    f.quarantine.refuseDelete=false;expect((await runRetention(f.ctx)).verified).toBe(1);expect(f.db.one('SELECT status FROM retention_jobs')).toEqual({status:'verified'});
  });
  it('fails closed if the source binding changes while physical cleanup is awaiting',async()=>{
    const f=fixture(),owner=f.actor(),photo=await asset(f,owner,{old:true});f.quarantine.onDelete=()=>{f.db.run('UPDATE assets SET version=? WHERE id=?',crypto.randomUUID(),photo.id);};
    expect((await runRetention(f.ctx)).verified).toBe(0);expect(f.db.one('SELECT status,error_code FROM retention_jobs')).toEqual({status:'blocked',error_code:'retention_source_changed'});expect(f.db.one("SELECT count(*) n FROM retention_objects WHERE bucket='QUARANTINE' AND status='verified'")).toEqual({n:0});
  });
  it('purges a template only after both separate legitimate purposes have expired or been withdrawn',async()=>{
    const f=fixture(),owner=f.actor();const profile=f.db.one<any>('SELECT * FROM face_profiles WHERE account_id=?',owner.accountId)!;
    f.db.run("INSERT INTO consents(id,account_id,purpose,policy_version,status,created_at) VALUES(?,?,'photo_matching','fixture','granted',?)",crypto.randomUUID(),owner.accountId,f.ctx.now());f.db.run("UPDATE consents SET status='revoked',revoked_at=? WHERE account_id=? AND purpose='face_authentication'",f.ctx.now(),owner.accountId);
    expect((await runRetention(f.ctx)).verified).toBe(0);expect(f.photos.values.has(profile.template_key)).toBe(true);
    f.db.run("UPDATE consents SET status='revoked',revoked_at=? WHERE account_id=?",f.ctx.now(),owner.accountId);expect((await runRetention(f.ctx)).verified).toBe(1);expect(f.photos.values.has(profile.template_key)).toBe(false);expect(f.db.one('SELECT id FROM face_profiles WHERE account_id=?',owner.accountId)).toBeNull();
  });
  it('limits one maintenance pass and retains all unfinished work instead of claiming global cleanup',async()=>{
    const f=fixture(),owner=f.actor();await asset(f,owner,{old:true});await asset(f,owner,{old:true});await asset(f,owner,{old:true});
    const first=await runRetention(f.ctx,1);expect(first.verified).toBe(1);expect(f.db.one('SELECT count(*) n FROM assets WHERE deleted_at IS NULL')).toEqual({n:2});expect((await runRetention(f.ctx,1)).verified).toBe(1);
    await expect(runRetention(f.ctx,201)).rejects.toThrow('retention_limit_invalid');
  });
  it('binds retention policy edits to fresh independent operator authority and explicit expected version',async()=>{
    const f=fixture(),owner=f.actor(),admin=f.actor(['user','admin']);f.setActor(owner);await expect(handleRetention(request('/admin/retention'),f.ctx)).rejects.toThrow('admin_required');f.setActor(admin);
    const p=(await json<RetentionReply>(await handleRetention(request('/admin/retention'),f.ctx))).policy;
    const result=await json<RetentionReply>(await handleRetention(request('/admin/retention',{expected_version:p.version,raw_days:90,operation_key:key('policy')},'PATCH'),f.ctx));expect(result.policy.raw_days).toBe(90);
    await expect(handleRetention(request('/admin/retention',{expected_version:p.version,raw_days:30,operation_key:key('policy')},'PATCH'),f.ctx)).rejects.toThrow('retention_version_changed');
    await expect(handleRetention(request('/admin/retention',{expected_version:result.policy.version,audit_days:1,operation_key:key('policy')},'PATCH'),f.ctx)).rejects.toThrow('invalid_retention_days');
  });
  it('projects owned remaining data without foreign graph names/credentials and integrates request-authorized erasure',async()=>{
    const f=fixture(),owner=f.actor(),admin=f.actor(['user','admin']),photo=await asset(f,owner);f.setActor(owner);await pushDevice(f,owner);f.db.transaction(()=>persistVerifiedPurchase(f.ctx,purchase(f,owner)));
    await callOperators(f,owner,'/support/requests',{subject:'Privacy help',details:'Please remove my own account',operation_key:key('support')});const exported=JSON.stringify(collectPrivacyExport(f.ctx,owner.accountId));expect(exported).not.toContain(photo.sourceKey);expect(exported).not.toContain('private-token');expect(exported).toContain('Privacy help');expect(operatorPrivacyRows(f.ctx,owner.accountId)).toHaveProperty('support_requests');expect(entitlementPrivacyRows(f.ctx,owner.accountId)).toHaveProperty('subscriptions');
    const reply=await createPrivacyRequest(f.ctx,owner,'delete',{operation_key:key('erasure')});const id=(reply.privacy_request as {id:string}).id;await reviewPrivacyRequest(f.ctx,admin,id,'approve',{operation_key:key('review')});await processPrivacyRequest(f.ctx,admin,id);
    expect(f.db.one('SELECT count(*) n FROM push_devices')).toEqual({n:0});expect(f.db.one('SELECT count(*) n FROM support_requests')).toEqual({n:0});expect(f.db.one('SELECT active FROM store_subscriptions WHERE account_id=?',owner.accountId)).toEqual({active:0});expect(f.db.one('SELECT count(*) n FROM store_transactions')).toEqual({n:1});expect(f.db.all('PRAGMA foreign_key_check')).toEqual([]);
  });
  it('captures unfinished exact retention keys before erasure deletes their foreign-key metadata',async()=>{
    const f=fixture(),owner=f.actor(),photo=await asset(f,owner,{old:true});f.quarantine.refuseDelete=true;await runRetention(f.ctx);
    const retained=retentionPrivateKeys(f.db,owner.accountId);expect(retained).toContainEqual({bucket:'QUARANTINE',object_key:photo.sourceKey});eraseRetentionSubject(f.db,owner.accountId);expect(f.db.one('SELECT count(*) n FROM retention_objects')).toEqual({n:0});
  });
});
