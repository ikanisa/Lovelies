/** Prepared, unexecuted real harness/PG consumer cases. Root owns all DB runs. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startHarness,enroll,faceVerifierFixture,fixturePng} from './runtime-harness.mjs';
import {digest,stable,ApiError} from '../src/types.ts';
import {enqueueNotification,processNotificationJob} from '../src/notifications.ts';
import {processPhotoJob} from '../src/processing.ts';
const key=()=>crypto.randomUUID(),vars={GOOGLE_PLAY_PACKAGE_NAME:'com.lovelies.memories',GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID:'com.lovelies.pro.monthly',APPLE_BUNDLE_ID:'com.lovelies.memories',APPLE_APP_ID:'987654321',APPLE_SUBSCRIPTION_PRODUCT_ID:'com.lovelies.pro.monthly',GOOGLE_PLAY_RTDN_AUDIENCE:'https://api.invalid/subscriptions/google/notifications',GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL:'fixture@example.invalid'};
async function harness(t,options={}){const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false,vars,...options});t.after(()=>h.close());return h;}
function faultResponse(mode){const state={pulls:0,cancels:0};const body=new ReadableStream({pull(out){state.pulls++;if(mode==='stall')return;if(state.pulls<=64)out.enqueue(new Uint8Array(0));else if(state.pulls===65)out.enqueue(new TextEncoder().encode('{}'));else out.close();},cancel(){state.cancels++;return new Promise(()=>{});}},{highWaterMark:0});return {response:new Response(body,{headers:{'content-type':'application/json'}}),state};}
const purchase=async person=>({kind:'androidpublisher#subscriptionPurchaseV2',subscriptionState:'SUBSCRIPTION_STATE_ACTIVE',acknowledgementState:'ACKNOWLEDGEMENT_STATE_PENDING',startTime:new Date(Date.now()-60000).toISOString(),lineItems:[{productId:vars.GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID,expiryTime:new Date(Date.now()+86400000).toISOString(),latestSuccessfulOrderId:'synthetic-order-'+key()}],externalAccountIdentifiers:{obfuscatedExternalAccountId:await digest(person.accountId)}});
const receipt=(envelope,payload)=>({protocol:'lovelies-store-verifier-v1',input_hash:envelope.input_hash,verified:true,payload});
async function noPurchase(h,account){assert.equal((await h.db.one('SELECT COUNT(*) n FROM store_subscriptions WHERE account_id=?',account)).n,0);assert.equal((await h.db.one('SELECT COUNT(*) n FROM store_transactions WHERE account_id=?',account)).n,0);}
async function storeReadFailure(t,stage,mode){
 let person;const calls=[],fault=faultResponse(mode);const h=await harness(t,{storeVerifier:async(envelope,path)=>{calls.push(path);assert.equal(envelope.input_hash,await digest(stable(envelope.input)));if(path==='/google/'+stage)return fault.response;assert.equal(path,'/google/subscription');return receipt(envelope,await purchase(person));}});person=await enroll(h);
 const res=await h.request('/subscriptions/google/transactions',{token:person.token,body:{product_id:vars.GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID,purchase_token:'synthetic-purchase-token-'+key(),operation_key:key()}});
 assert.equal(res.status,503);assert.equal((await res.json()).error.code,mode==='stall'?'upstream_json_body_timeout':'upstream_json_body_fragment_limit');assert.deepEqual(calls,stage==='subscription'?['/google/subscription']:['/google/subscription','/google/acknowledge']);assert(fault.state.pulls>=1);assert.equal(fault.state.cancels,1);await noPurchase(h,person.accountId);
 // In acknowledgement cases a provider call DID occur. No assertion says the
 // provider did nothing, and this test does not replay the operation blindly.
}
for(const stage of ['subscription','acknowledge'])test(`private verifier ${stage} fragmentation is503 and never persists entitlement or silently resends`,async t=>storeReadFailure(t,stage,'fragment'));
test('independent pre- and post-acknowledgement stalled Responses use the real deadline concurrently',{concurrency:2,timeout:140000},async t=>{
 await Promise.all(['subscription','acknowledge'].map(stage=>t.test(stage,{timeout:130000},child=>storeReadFailure(child,stage,'stall'))));
});
test('malformed private push receipt stays ambiguous and reconciles by GET without a second send',async t=>{
 const calls=[],fault=faultResponse('fragment');let operation;
 const h=await harness(t,{pushService:async request=>{calls.push(request.method);if(request.method==='POST'){operation=(await request.json()).operation_key;return fault.response;}return {operation_key:operation,status:'ambiguous'};}}),person=await enroll(h);
 const device=await h.json('/me/push-devices',{token:person.token,body:{platform:'ios',push_token:'synthetic-push-'+key(),operation_key:key()}}),id=await h.db.transaction(()=>enqueueNotification(h.app,person.accountId,'support',key(),'Synthetic body boundary'));
 await assert.rejects(processNotificationJob({notification_id:id},h.app),e=>e instanceof ApiError&&e.status===503&&e.code==='upstream_json_body_fragment_limit');
 let row=await h.db.one('SELECT status,provider_receipt FROM notification_deliveries WHERE notification_id=?',id);assert.equal(row.status,'ambiguous');assert.equal(row.provider_receipt,null);assert.equal((await h.db.one('SELECT status FROM notification_jobs WHERE notification_id=?',id)).status,'ambiguous');
 await assert.rejects(processNotificationJob({notification_id:id},h.app),/push_reconciliation_required/);assert.deepEqual(calls,['POST','GET']);assert.equal((await h.db.one('SELECT active FROM push_devices WHERE id=?',device.id)).active,1);assert.equal(fault.state.cancels,1);
});
test('fragmented processor Response fails its attempt before any preview/candidate/grant publication',async t=>{
 const fault=faultResponse('fragment');let calls=0;const h=await harness(t,{photoProcessor:()=>assert.fail('synthetic setup processor must not dispatch before the targeted job')}),person=await enroll(h);
 await h.json('/me/photo-preferences',{token:person.token,body:{receive_matches:false,photo_matching_consent:false,processing_consent:true,policy_version:h.env.PHOTO_CONSENT_POLICY_VERSION,operation_key:key()}});
 const bytes=fixturePng(key()),reserved=await h.json('/uploads/session',{token:person.token,body:{source:'personal',content_type:'image/png',byte_size:bytes.length,title:'Synthetic reader boundary',operation_key:key()}},201);
 await h.json(reserved.upload_url,{method:'PUT',token:person.token,raw:bytes,headers:{'content-type':'image/png'}});const complete=await h.json(reserved.complete_url,{token:person.token,body:{operation_key:key()}},202);
 h.env.PHOTO_PROCESSOR={fetch:async()=>{calls++;return fault.response;}};
 await assert.rejects(processPhotoJob({attempt_id:complete.attempt_id},h.app),e=>e instanceof ApiError&&e.status===503&&e.code==='upstream_json_body_fragment_limit');assert.equal(calls,1);
 const attempt=await h.db.one('SELECT status,error_code FROM processing_attempts WHERE id=?',complete.attempt_id);assert.equal(attempt.status,'failed');assert.equal(attempt.error_code,'upstream_json_body_fragment_limit');
 for(const table of ['renditions','candidates','match_origins','media_grants'])assert.equal((await h.db.one(`SELECT COUNT(*) n FROM ${table} WHERE asset_id=?`,reserved.asset_id)).n,0,table);
 assert.equal([...h.env.PHOTOS.rows.keys()].some(k=>k.startsWith('preview/')&&k.includes('/'+reserved.asset_id+'/')),false);assert.equal(fault.state.cancels,1);
});
test('plain private Apple verifier transport failure remains503 instead of invalid signed payload422',async t=>{
 let calls=0;const h=await harness(t,{storeVerifier:async()=>{calls++;throw Error('synthetic transport unavailable');}}),person=await enroll(h),r=await h.request('/subscriptions/apple/transactions',{token:person.token,body:{product_id:vars.APPLE_SUBSCRIPTION_PRODUCT_ID,signed_transaction:'a.b.c',operation_key:key()}});assert.equal(r.status,503);assert.equal((await r.json()).error.code,'store_verifier_unavailable');assert.equal(calls,1);await noPurchase(h,person.accountId);
});
const oidcInput=()=>({token:'synthetic-oidc-token',body:{message:{messageId:key(),data:Buffer.from('{}').toString('base64')}}});
test('plain private OIDC verifier transport failure remains503 instead of token rejection401',async t=>{
 let calls=0;const h=await harness(t,{storeVerifier:async(_envelope,path)=>{calls++;assert.equal(path,'/google/oidc');throw Error('synthetic transport unavailable');}}),input=oidcInput(),r=await h.request('/subscriptions/google/notifications',{body:input.body,headers:{authorization:'Bearer '+input.token}});assert.equal(r.status,503);assert.equal((await r.json()).error.code,'store_verifier_unavailable');assert.equal(calls,1);
});
test('a genuine private OIDC HTTP rejection keeps unauthorized401',async t=>{
 const h=await harness(t,{storeVerifier:async()=>Response.json({error:'synthetic rejected token'},{status:401})}),input=oidcInput(),r=await h.request('/subscriptions/google/notifications',{body:input.body,headers:{authorization:'Bearer '+input.token}});assert.equal(r.status,401);assert.equal((await r.json()).error.code,'google_notification_unauthorized');
});
test('a genuine private Apple HTTP payload rejection keeps422',async t=>{
 const h=await harness(t,{storeVerifier:async()=>Response.json({error:'synthetic rejected payload'},{status:422})}),person=await enroll(h),r=await h.request('/subscriptions/apple/transactions',{token:person.token,body:{product_id:vars.APPLE_SUBSCRIPTION_PRODUCT_ID,signed_transaction:'a.b.c',operation_key:key()}});assert.equal(r.status,422);assert.equal((await r.json()).error.code,'store_verification_failed');
});
test('invalid Apple signed-payload shape still rejects before any verifier dispatch',async t=>{
 let calls=0;const h=await harness(t,{storeVerifier:async()=>{calls++;throw Error('must not dispatch');}}),person=await enroll(h),r=await h.request('/subscriptions/apple/transactions',{token:person.token,body:{product_id:vars.APPLE_SUBSCRIPTION_PRODUCT_ID,signed_transaction:'not-three-segments',operation_key:key()}});assert.equal(r.status,422);assert.equal((await r.json()).error.code,'invalid_apple_signed_payload');assert.equal(calls,0);
});
