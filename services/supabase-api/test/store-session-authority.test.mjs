/** One synthetic subject, in-process journal and provider fixtures only. */
import assert from 'node:assert/strict';
import {after,test as nodeTest} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createApp,createHandler} from '../src/index.ts';
import {restoreOperationID} from '../src/restore-transaction.ts';
import {stable} from '../src/types.ts';
import {assertStoreAuthorityFresh} from '../src/store-authority.ts';
import {fixture} from './restore-database-fixture.mjs';
import {enroll,faceVerifierFixture,sha256} from './runtime-harness.mjs';

// The full PostgreSQL lane skips these PGlite-only fixtures. Their dedicated
// CI step removes TEST_DATABASE_URL and installs the offline regression guard.
const test=process.env.TEST_DATABASE_URL === undefined ? nodeTest : nodeTest.skip;
const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw Error('external_fetch_prohibited');};
after(()=>{globalThis.fetch=originalFetch;});
const vars={APPLE_BUNDLE_ID:'com.lovelies.memories',APPLE_APP_ID:'987654321',
 APPLE_SUBSCRIPTION_PRODUCT_ID:'com.lovelies.memories.pro.monthly',GOOGLE_PLAY_PACKAGE_NAME:'com.lovelies.memories',
 GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID:'com.lovelies.memories.pro.monthly'};
const digest=async value=>sha256(new TextEncoder().encode(value));

async function setup(t){
 const f=await fixture(t),h=f.h,initial=Date.now();let clock=initial,account,calls=0,googleCalls=0,googleAcks=0,revokeAfterGoogleAck=false;
 const signed='synthetic-store.payload.signature',googleToken='synthetic-google-token-'+randomUUID();
 h.env.FACE_AUTH_VERIFIER={fetch:async request=>{
  const form=await request.formData();return Response.json(await faceVerifierFixture(JSON.parse(String(form.get('envelope'))),form));
 }};
 Object.assign(h.env,vars);
 h.env.STORE_VERIFIER={fetch:async(input,init)=>{
  const request=input instanceof Request?input:new Request(input,init),envelope=await request.json(),path=new URL(request.url).pathname;
  assert.equal(envelope.protocol,'lovelies-store-verifier-v1');assert.equal(envelope.input_hash,await digest(stable(envelope.input)));
  if(path==='/apple/transaction'){
   calls++;assert.equal(envelope.input.signed_payload,signed);
   return Response.json({...envelope,verified:true,payload:{bundleId:vars.APPLE_BUNDLE_ID,
    productId:vars.APPLE_SUBSCRIPTION_PRODUCT_ID,type:'Auto-Renewable Subscription',inAppOwnershipType:'PURCHASED',
    appAccountToken:account,environment:'Production',purchaseDate:initial-1000,expiresDate:initial+86400000,
    signedDate:initial,originalTransactionId:'synthetic-original',transactionId:'synthetic-transaction'}});
  }
  if(path==='/google/subscription'){
   googleCalls++;assert.equal(envelope.input.packageName,vars.GOOGLE_PLAY_PACKAGE_NAME);assert.equal(envelope.input.purchaseToken,googleToken);
   return Response.json({...envelope,verified:true,payload:{kind:'androidpublisher#subscriptionPurchaseV2',
    subscriptionState:'SUBSCRIPTION_STATE_ACTIVE',acknowledgementState:'ACKNOWLEDGEMENT_STATE_PENDING',
    startTime:new Date(initial-1000).toISOString(),externalAccountIdentifiers:{obfuscatedExternalAccountId:await digest(account)},
    lineItems:[{productId:vars.GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID,expiryTime:new Date(initial+86400000).toISOString(),latestSuccessfulOrderId:'synthetic-google-order'}]}});
  }
  if(path==='/google/acknowledge'){
   googleAcks++;assert.equal(envelope.input.packageName,vars.GOOGLE_PLAY_PACKAGE_NAME);
   assert.equal(envelope.input.productId,vars.GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID);assert.equal(envelope.input.purchaseToken,googleToken);
   assert.equal(envelope.input.obfuscatedAccountId,await digest(account));
   if(revokeAfterGoogleAck){
    // Same-subject local database change after the fake provider has accepted
    // acknowledgement; no external provider or other account is involved.
    await h.db.transaction(()=>h.db.run("UPDATE consents SET status='revoked',revoked_at=? WHERE id=? AND account_id=?",clock,consentID,account));
   }
   return Response.json({...envelope,verified:true,payload:{}});
  }
  throw Error('unexpected_synthetic_verifier_call');
 }};
 const owner=await enroll(h);account=owner.accountId;
 const actor=await h.app.authenticate(new Request('https://api.invalid/me',{headers:{authorization:'Bearer '+owner.token}}));
 const currentSession=await h.db.one('SELECT face_consent_id FROM sessions WHERE id=? AND account_id=?',actor.sessionId,owner.accountId);
 assert(currentSession?.face_consent_id);const consentID=currentSession.face_consent_id;
 clock=Date.now();const liveClock=clock;
 const context=createApp(f.db,h.env,()=>clock),handler=createHandler(context);
 const request=(path,{body,method=body===undefined?'GET':'POST'}={})=>handler(new Request('https://api.invalid'+path,{method,
  headers:{authorization:'Bearer '+owner.token,...(body===undefined?{}:{'content-type':'application/json'})},
  ...(body===undefined?{}:{body:JSON.stringify(body)})}));
 const purchase=key=>request('/subscriptions/apple/transactions',{body:{operation_key:key,product_id:vars.APPLE_SUBSCRIPTION_PRODUCT_ID,signed_transaction:signed}});
 const googlePurchase=key=>request('/subscriptions/google/transactions',{body:{operation_key:key,product_id:vars.GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID,purchase_token:googleToken}});
 const lookup=key=>request('/me/store-operations',{body:{operation_key:key}});
 const row=key=>h.db.one("SELECT action,payload_hash,payload_json,response_json FROM operations WHERE actor_id=? AND source='store' AND operation_key=?",account,key);
 const subscriptions=()=>h.db.all('SELECT transaction_id,active FROM store_subscriptions WHERE account_id=?',account);
 const transactionRows=()=>h.db.all('SELECT transaction_id FROM store_transactions WHERE account_id=?',account);
 const id=key=>restoreOperationID(account,'store',key);
 return {...f,owner,actor,consentID,context,signed,googleToken,purchase,googlePurchase,lookup,row,subscriptions,transactionRows,id,request,
  now(){return clock;},advance(value){clock=value;},expire(){clock=actor.expiresAt+1;},restoreClock(){clock=liveClock;},
  revokeOnGoogleAcknowledgement(){revokeAfterGoogleAck=true;},get calls(){return calls;},get googleCalls(){return googleCalls;},get googleAcks(){return googleAcks;}};
}
async function expectedHash(f,key){
 const payload={protocol:'lovelies-store-operation-input-v1',operation_key:key,
  product_id:vars.APPLE_SUBSCRIPTION_PRODUCT_ID,credential_sha256:await digest(f.signed)};
 return digest(stable({action:'store.apple',source:'store',payload}));
}
async function assertUnresolved(response,secrets=[]){
 assert.equal(response.status,503);const text=await response.text();
 assert.equal(JSON.parse(text).error.code,'store_operation_outcome_unresolved');
 assert(!text.includes('synthetic-transaction'));assert(!text.includes('synthetic-store.payload.signature'));
 for(const secret of secrets)assert(!text.includes(secret));
}
async function assertCommittedRow(f,key){
 const row=await f.row(key);assert(row);const value=JSON.parse(row.response_json);
 assert.equal(value.transaction_id,'synthetic-transaction');assert.equal(row.payload_hash,await expectedHash(f,key));
 assert(!row.payload_json.includes(f.signed));assert(!row.response_json.includes(f.signed));
 assert.equal((await f.subscriptions()).length,1);assert.equal((await f.transactionRows()).length,1);return {row,value};
}

test('store authority survives a normal mutation and historical read without extra provider calls',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID();let r=await f.purchase(key);assert.equal(r.status,200);const result=await r.json();
 assert.equal(result.transaction_id,'synthetic-transaction');const saved=await assertCommittedRow(f,key);
 const id=await f.id(key),plan=await f.journal.lookup(id);assert.equal(plan.status,'committed');assert.equal(plan.plan.input_hash,saved.row.payload_hash);
 r=await f.lookup(key);assert.equal(r.status,200);const receipt=await r.json();assert.equal(receipt.status,'committed');assert.deepEqual(receipt.result,result);
 r=await f.lookup(randomUUID());assert.equal(r.status,200);assert.equal((await r.json()).status,'unknown');assert.equal(f.calls,1);
});

test('expiry after independent prepare rolls back SQL and leaves its accepted plan pending',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID(),id=await f.id(key),prepare=f.journal.prepare.bind(f.journal);let armed=true;
 f.journal.prepare=async input=>{const saved=await prepare(input);if(armed&&input.operation_id===id){armed=false;f.expire();}return saved;};
 const response=await f.purchase(key);await assertUnresolved(response);assert.equal(armed,false);
 const saved=await f.journal.lookup(id);assert(saved);assert.equal(saved.status,'pending');assert.equal(saved.plan.input_hash,await expectedHash(f,key));
 assert.equal((await f.journal.control()).state,'pending');assert.equal(await f.row(key),null);assert.equal((await f.subscriptions()).length,0);
 assert.equal((await f.transactionRows()).length,0);assert.equal(f.calls,1);
 // The fixture only rewinds its synthetic clock, not the independent journal.
 f.restoreClock();const retry=await f.purchase(key);assert.equal(retry.status,503);await retry.body?.cancel();
 assert.deepEqual(await f.journal.lookup(id),saved);assert.equal(await f.row(key),null);assert.equal(f.calls,1);
});

for(const mode of ['sql-commit','journal-ack'])test(`expiry during ${mode} returns unresolved while preserving the committed receipt`,{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID(),id=await f.id(key);let triggered=false;
 if(mode==='sql-commit'){
  const prepare=f.journal.prepare.bind(f.journal);
  f.journal.prepare=async input=>{
   const saved=await prepare(input);
   if(input.operation_id===id){f.faults.afterCommit=async()=>{delete f.faults.afterCommit;triggered=true;f.expire();};}
   return saved;
  };
 }else{
  const acknowledge=f.journal.acknowledge.bind(f.journal);
  f.journal.acknowledge=async(...args)=>{const saved=await acknowledge(...args);if(args[0]===id){triggered=true;f.expire();}return saved;};
 }
 const response=await f.purchase(key);await assertUnresolved(response);assert(triggered);
 const saved=await assertCommittedRow(f,key),plan=await f.journal.lookup(id);assert.equal(plan.status,'committed');
 assert.equal(plan.plan.input_hash,saved.row.payload_hash);assert.equal(f.calls,1);
 // Simulated same-session time restoration is a local fixture control, not a
 // claim that a real expired session has been refreshed.
 f.restoreClock();const receipt=await f.lookup(key);assert.equal(receipt.status,200);
 assert.deepEqual((await receipt.json()).result,saved.value);assert.equal(f.calls,1);
});

test('expiry during final admitted response returns unresolved after committed store mutation',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID(),id=await f.id(key),ack=f.journal.acknowledge.bind(f.journal),admit=f.journal.admission.bind(f.journal);
 let acknowledged=false,postAckAdmissions=0,triggered=false;
 f.journal.acknowledge=async(...args)=>{const saved=await ack(...args);if(args[0]===id)acknowledged=true;return saved;};
 f.journal.admission=async(...args)=>{
  const result=await admit(...args);
  // First admission after acknowledgement is the post-write authority read;
  // the next is the invocation's final response admission.
  if(acknowledged&&++postAckAdmissions===2){triggered=true;f.expire();}
  return result;
 };
 const response=await f.purchase(key);await assertUnresolved(response);assert(triggered);
 const saved=await assertCommittedRow(f,key),plan=await f.journal.lookup(id);assert.equal(plan.status,'committed');
 assert.equal(plan.plan.input_hash,saved.row.payload_hash);assert.equal(f.calls,1);
});

test('read-only receipt final admission suppresses an expired session without claiming a write',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID();let r=await f.purchase(key);assert.equal(r.status,200);await r.body?.cancel();
 const one=f.db.one.bind(f.db),admit=f.journal.admission.bind(f.journal);let seen=false,expired=false;
 f.db.one=async(sql,...bindings)=>{const row=await one(sql,...bindings);
  if(sql==="SELECT action,payload_hash,payload_json,response_json FROM operations WHERE actor_id=? AND source='store' AND operation_key=?"&&
   bindings[0]===f.owner.accountId&&bindings[1]===key)seen=true;
  return row;};
 f.journal.admission=async(...args)=>{const result=await admit(...args);if(seen&&!expired){expired=true;f.expire();}return result;};
 r=await f.lookup(key);assert(seen&&expired);assert.equal(r.status,401);const text=await r.text();
 assert.equal(JSON.parse(text).error.code,'session_invalid');assert(!text.includes('synthetic-transaction'));assert.equal(f.calls,1);
});

test('synchronous freshness catches expiry after the final admitted read commits',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID();let r=await f.purchase(key);assert.equal(r.status,200);await r.body?.cancel();
 const one=f.db.one.bind(f.db),admit=f.journal.admission.bind(f.journal);let seen=false,installed=false,expired=false;
 f.db.one=async(sql,...bindings)=>{const row=await one(sql,...bindings);
  if(sql==="SELECT action,payload_hash,payload_json,response_json FROM operations WHERE actor_id=? AND source='store' AND operation_key=?"&&
   bindings[0]===f.owner.accountId&&bindings[1]===key)seen=true;
  return row;};
 f.journal.admission=async(...args)=>{const result=await admit(...args);
  if(seen&&!installed){installed=true;f.faults.afterCommit=async()=>{delete f.faults.afterCommit;expired=true;f.expire();};}
  return result;};
 r=await f.lookup(key);assert(installed&&expired);assert.equal(r.status,401);const text=await r.text();
 assert.equal(JSON.parse(text).error.code,'session_invalid');assert(!text.includes('synthetic-transaction'));assert.equal(f.calls,1);
});

test('logout remains a terminal self-revocation and is not subject to the store postguard',{timeout:30000},async t=>{
 const f=await setup(t),r=await f.request('/auth/logout',{method:'POST'});assert.equal(r.status,200);assert.equal((await r.json()).status,'logged_out');
 const session=await f.h.db.one('SELECT revoked_at FROM sessions WHERE id=? AND account_id=?',f.actor.sessionId,f.owner.accountId);
 assert.notEqual(session.revoked_at,null);assert.equal(f.calls,0);
});

test('lost SQL COMMIT reply returns unresolved and same-key retry reconciles the exact pending plan',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID(),id=await f.id(key),prepare=f.journal.prepare.bind(f.journal);let armed=true;
 f.journal.prepare=async input=>{const saved=await prepare(input);if(armed&&input.operation_id===id){armed=false;f.faults.commitReply=true;}return saved;};
 const response=await f.purchase(key);await assertUnresolved(response);assert.equal(armed,false);
 const saved=await assertCommittedRow(f,key),pending=await f.journal.lookup(id);assert.equal(pending.status,'pending');
 assert.equal(pending.plan.input_hash,saved.row.payload_hash);assert.equal(f.calls,1);
 // Admission recognizes the atomic SQL marker; it acknowledges the same plan,
 // then replays the saved operation without redispatching the provider.
 const retry=await f.purchase(key);assert.equal(retry.status,200);assert.deepEqual(await retry.json(),saved.value);
 const committed=await f.journal.lookup(id);assert.equal(committed.status,'committed');assert.deepEqual(committed.plan,pending.plan);
 assert.deepEqual(await f.row(key),saved.row);assert.equal((await f.subscriptions()).length,1);assert.equal(f.calls,1);
});

test('same-subject consent revocation after prepare aborts SQL and preserves the independent pending plan',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID(),id=await f.id(key),prepare=f.journal.prepare.bind(f.journal);let changed=false;
 f.journal.prepare=async input=>{const saved=await prepare(input);if(input.operation_id===id){
  // This synthetic authority change joins the still-open local transaction;
  // it is rolled back together with the attempted store mutation.
  await f.db.run("UPDATE consents SET status='revoked',revoked_at=? WHERE id=? AND account_id=?",f.now(),f.consentID,f.owner.accountId);changed=true;
 }return saved;};
 const response=await f.purchase(key);await assertUnresolved(response);assert(changed);
 const plan=await f.journal.lookup(id);assert.equal(plan.status,'pending');assert.equal(plan.plan.input_hash,await expectedHash(f,key));
 assert.equal(await f.row(key),null);assert.equal((await f.subscriptions()).length,0);
 const consent=await f.h.db.one('SELECT status,revoked_at FROM consents WHERE id=? AND account_id=?',f.consentID,f.owner.accountId);
 assert.equal(consent.status,'granted');assert.equal(consent.revoked_at,null);assert.equal(f.calls,1);
});

test('same-subject consent revocation after acknowledgement suppresses the committed response',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID(),id=await f.id(key),ack=f.journal.acknowledge.bind(f.journal);let changed=false;
 f.journal.acknowledge=async(...args)=>{const saved=await ack(...args);if(args[0]===id){
  // The local test mutation runs after the acknowledgement transaction commits.
  f.faults.afterCommit=async()=>{delete f.faults.afterCommit;
   await f.h.db.transaction(()=>f.h.db.run("UPDATE consents SET status='revoked',revoked_at=? WHERE id=? AND account_id=?",f.now(),f.consentID,f.owner.accountId));changed=true;};
 }return saved;};
 const response=await f.purchase(key);await assertUnresolved(response);assert(changed);
 const saved=await assertCommittedRow(f,key),plan=await f.journal.lookup(id);assert.equal(plan.status,'committed');assert.equal(plan.plan.input_hash,saved.row.payload_hash);
 const consent=await f.h.db.one('SELECT status FROM consents WHERE id=? AND account_id=?',f.consentID,f.owner.accountId);assert.equal(consent.status,'revoked');assert.equal(f.calls,1);
});

test('same-subject audience suspension before final admission suppresses the committed response',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID(),id=await f.id(key),ack=f.journal.acknowledge.bind(f.journal),admit=f.journal.admission.bind(f.journal);
 let acknowledged=false,installed=false,changed=false;
 f.journal.acknowledge=async(...args)=>{const saved=await ack(...args);if(args[0]===id)acknowledged=true;return saved;};
 f.journal.admission=async(...args)=>{const result=await admit(...args);
  if(acknowledged&&!installed){installed=true;f.faults.afterCommit=async()=>{delete f.faults.afterCommit;
   await f.h.db.transaction(()=>f.h.db.run("UPDATE account_audience SET status='suspended' WHERE account_id=?",f.owner.accountId));changed=true;};}
  return result;};
 const response=await f.purchase(key);await assertUnresolved(response);assert(installed&&changed);
 const saved=await assertCommittedRow(f,key),plan=await f.journal.lookup(id);assert.equal(plan.status,'committed');assert.equal(plan.plan.input_hash,saved.row.payload_hash);
 const audience=await f.h.db.one('SELECT status FROM account_audience WHERE account_id=?',f.owner.accountId);assert.equal(audience.status,'suspended');assert.equal(f.calls,1);
});

test('same-subject audience suspension between receipt read and final admission blocks the read',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID();let r=await f.purchase(key);assert.equal(r.status,200);await r.body?.cancel();
 const one=f.db.one.bind(f.db);let installed=false,changed=false;
 f.db.one=async(sql,...bindings)=>{const row=await one(sql,...bindings);
  if(!installed&&sql==="SELECT action,payload_hash,payload_json,response_json FROM operations WHERE actor_id=? AND source='store' AND operation_key=?"&&
   bindings[0]===f.owner.accountId&&bindings[1]===key){installed=true;f.faults.afterCommit=async()=>{delete f.faults.afterCommit;
    await f.h.db.transaction(()=>f.h.db.run("UPDATE account_audience SET status='suspended' WHERE account_id=?",f.owner.accountId));changed=true;};}
  return row;};
 r=await f.lookup(key);assert(installed&&changed);assert.equal(r.status,403);const text=await r.text();
 assert.equal(JSON.parse(text).error.code,'audience_restricted');assert(!text.includes('synthetic-transaction'));assert.equal(f.calls,1);
});

for(const source of ['face-consent','audience-review'])test(`${source} deadline is enforced after the final admitted read commits`,{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID();let r=await f.purchase(key);assert.equal(r.status,200);await r.body?.cancel();
 const deadline=f.now()+1000;assert(deadline<f.actor.expiresAt);
 await f.h.db.transaction(()=>source==='face-consent'
  ?f.h.db.run('UPDATE consents SET expires_at=? WHERE id=? AND account_id=?',deadline,f.consentID,f.owner.accountId)
  :f.h.db.run('UPDATE account_audience SET next_review_at=? WHERE account_id=?',deadline,f.owner.accountId));
 const one=f.db.one.bind(f.db),admit=f.journal.admission.bind(f.journal);let seen=false,installed=false,expired=false;
 f.db.one=async(sql,...bindings)=>{const row=await one(sql,...bindings);
  if(sql==="SELECT action,payload_hash,payload_json,response_json FROM operations WHERE actor_id=? AND source='store' AND operation_key=?"&&
   bindings[0]===f.owner.accountId&&bindings[1]===key)seen=true;
  return row;};
 f.journal.admission=async(...args)=>{const result=await admit(...args);
  if(seen&&!installed){installed=true;f.faults.afterCommit=async()=>{delete f.faults.afterCommit;expired=true;f.advance(deadline+1);};}
  return result;};
 r=await f.lookup(key);assert(installed&&expired);assert.equal(r.status,403);const text=await r.text();
 assert.equal(JSON.parse(text).error.code,'store_authority_expired');assert(!text.includes('synthetic-transaction'));assert.equal(f.calls,1);
});

test('guardian authority deadline checks fail closed on each selected numeric deadline',{timeout:30000},async()=>{
 const now=1000,valid={session_expires_at:5000,refresh_expires_at:6000,face_consent_expires_at:4000,audience_review_at:4000,
  guardian_approval_expires_at:4000,guardian_request_expires_at:4000,guardian_audience_review_at:4000,guardian_face_consent_expires_at:4000};
 assert.doesNotThrow(()=>assertStoreAuthorityFresh(valid,now));
 for(const field of ['guardian_approval_expires_at','guardian_request_expires_at','guardian_audience_review_at','guardian_face_consent_expires_at'])
  assert.throws(()=>assertStoreAuthorityFresh({...valid,[field]:now},now),error=>error.status===403&&error.code==='store_authority_expired');
 assert.throws(()=>assertStoreAuthorityFresh({...valid,session_expires_at:now},now),error=>error.status===401&&error.code==='session_invalid');
 assert.throws(()=>assertStoreAuthorityFresh({...valid,guardian_request_expires_at:NaN},now),error=>error.status===503&&error.code==='store_authority_unavailable');
});

test('fake Google acknowledgement succeeds with current same-subject authority',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID();let response=await f.googlePurchase(key);assert.equal(response.status,200);
 const value=await response.json();assert.equal(value.provider,'google_play');assert.equal(value.transaction_id,'synthetic-google-order');
 assert.equal(f.googleCalls,1);assert.equal(f.googleAcks,1);assert.equal(f.calls,0);
 const row=await f.row(key);assert(row);assert.equal(row.action,'store.google');assert.equal(JSON.parse(row.payload_json).credential_sha256,await digest(f.googleToken));
 assert(!row.payload_json.includes(f.googleToken));assert(!row.response_json.includes(f.googleToken));assert.equal((await f.subscriptions()).length,1);
 response=await f.lookup(key);assert.equal(response.status,200);assert.deepEqual((await response.json()).result,value);
});

test('fake Google acknowledgement followed by same-subject authority loss returns unresolved',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID(),id=await f.id(key);f.revokeOnGoogleAcknowledgement();
 const response=await f.googlePurchase(key);await assertUnresolved(response,[f.googleToken,'synthetic-google-order']);
 assert.equal(f.googleCalls,1);assert.equal(f.googleAcks,1);assert.equal(f.calls,0);
 assert.equal(await f.row(key),null);assert.equal((await f.subscriptions()).length,0);assert.equal((await f.transactionRows()).length,0);
 const consent=await f.h.db.one('SELECT status,revoked_at FROM consents WHERE id=? AND account_id=?',f.consentID,f.owner.accountId);
 assert.equal(consent.status,'revoked');assert.notEqual(consent.revoked_at,null);assert.equal(await f.journal.lookup(id),null);
 // The simulated provider acknowledgement occurred even though this local
 // SQL fixture has no subscription. The 503 must not be read as noncommit.
});

for(const source of ['face-consent','audience-review'])test(`${source} deadline crossing after independent prepare blocks SQL commit`,{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID(),id=await f.id(key),deadline=f.now()+1000;assert(deadline<f.actor.expiresAt);
 await f.h.db.transaction(()=>source==='face-consent'
  ?f.h.db.run('UPDATE consents SET expires_at=? WHERE id=? AND account_id=?',deadline,f.consentID,f.owner.accountId)
  :f.h.db.run('UPDATE account_audience SET next_review_at=? WHERE account_id=?',deadline,f.owner.accountId));
 const prepare=f.journal.prepare.bind(f.journal);let crossed=false;
 f.journal.prepare=async input=>{const saved=await prepare(input);if(input.operation_id===id&&!crossed){crossed=true;f.advance(deadline+1);}return saved;};
 const response=await f.purchase(key);await assertUnresolved(response);assert(crossed);assert(f.now()<f.actor.expiresAt);
 const plan=await f.journal.lookup(id);assert(plan);assert.equal(plan.status,'pending');assert.equal(plan.plan.input_hash,await expectedHash(f,key));
 assert.equal((await f.journal.control()).state,'pending');assert.equal(await f.row(key),null);assert.equal((await f.subscriptions()).length,0);
 assert.equal((await f.transactionRows()).length,0);assert.equal(f.calls,1);
 // Only the local clock is reset; the independent pending plan is not cleared.
 f.restoreClock();const retry=await f.purchase(key);assert.equal(retry.status,503);await retry.body?.cancel();
 assert.deepEqual(await f.journal.lookup(id),plan);assert.equal(f.calls,1);
});
