/** One synthetic subject, in-process journal and provider fixtures only. */
import assert from 'node:assert/strict';
import {after,test as nodeTest} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createApp,createHandler} from '../src/index.ts';
import {restoreOperationID} from '../src/restore-transaction.ts';
import {stable} from '../src/types.ts';
import {assertStoreAuthorityFresh} from '../src/store-authority.ts';
import {executeOperation,prepareOperation} from '../src/operations.ts';
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

// This lane exercises only a single synthetic account and the in-process
// verifier/journal. The trace excludes credentials and proves which side of the
// independent admission/prepare boundary each result actually used.
const storeRowSql="SELECT action,payload_hash,payload_json,response_json FROM operations WHERE actor_id=? AND source='store' AND operation_key=?";
function assertNoPreparedCheckpoint(trace,{allowAcknowledgement=false}={}){
 assert(trace.some(item=>item.kind==='sql'&&item.sql==='SET TRANSACTION READ ONLY'));
 assert(trace.some(item=>item.kind==='journal_ok'&&item.path==='/v1/admission'));
 assert(!trace.some(item=>item.kind==='journal'&&item.path==='/v1/operations/prepare'));
 assert(!trace.some(item=>item.kind==='sql'&&/^(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/i.test(item.sql)));
 if(!allowAcknowledgement)assert(!trace.some(item=>item.kind==='journal'&&/\/acknowledge$/.test(item.path)));
}
function sameSubjectStoreRead(sql,bindings,f,key){
 return sql===storeRowSql&&bindings.length===2&&bindings[0]===f.owner.accountId&&bindings[1]===key;
}
async function assertPrivateFailure(response,code,secret){
 assert.equal(response.status,503);const text=await response.text();assert.equal(JSON.parse(text).error.code,code);
 assert(!text.includes(secret));assert(!text.includes('synthetic-transaction'));
}

test('absent and committed store reads do not prepare a checkpoint; a new purchase prepares once',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID();let before=await f.journal.control();
 f.trace.length=0;let r=await f.request('/me/entitlements');assert.equal(r.status,200);assert.equal((await r.json()).pro_active,false);
 let trace=f.trace.slice();assertNoPreparedCheckpoint(trace);let after=await f.journal.control();assert.deepEqual(after.marker,before.marker);
 f.trace.length=0;r=await f.lookup(key);assert.equal(r.status,200);assert.equal((await r.json()).status,'unknown');
 trace=f.trace.slice();assertNoPreparedCheckpoint(trace);after=await f.journal.control();assert.deepEqual(after.marker,before.marker);
 const fake=f.h.env.STORE_VERIFIER.fetch;let beforeVerification;
 f.h.env.STORE_VERIFIER.fetch=async(...args)=>{beforeVerification=f.trace.slice();return fake(...args);};
 f.trace.length=0;r=await f.purchase(key);assert.equal(r.status,200);const receipt=await r.json();assert(beforeVerification);
 assertNoPreparedCheckpoint(beforeVerification);
 trace=f.trace.slice();assert.equal(trace.filter(item=>item.kind==='journal'&&item.path==='/v1/operations/prepare').length,1);
 assert.equal(trace.filter(item=>item.kind==='sql'&&item.sql.startsWith('UPDATE restore_control SET')).length,1);
 assert.equal(trace.filter(item=>item.kind==='journal'&&/\/acknowledge$/.test(item.path)).length,1);
 after=await f.journal.control();assert.equal(after.marker.checkpoint.revision,before.marker.checkpoint.revision+1);before=after;
 f.trace.length=0;r=await f.purchase(key);assert.equal(r.status,200);assert.deepEqual(await r.json(),receipt);assert.equal(f.calls,1);
 trace=f.trace.slice();assertNoPreparedCheckpoint(trace);after=await f.journal.control();assert.deepEqual(after.marker,before.marker);
 f.trace.length=0;r=await f.request('/me/entitlements');assert.equal(r.status,200);assert.equal((await r.json()).pro_active,true);
 trace=f.trace.slice();assertNoPreparedCheckpoint(trace);after=await f.journal.control();assert.deepEqual(after.marker,before.marker);
});

for(const change of ['missing','hash','response'])test(`replay with a same-subject ${change} row change releases neither version`,{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID();let r=await f.purchase(key);assert.equal(r.status,200);await r.body?.cancel();
 const original=await f.row(key),one=f.db.one;let reads=0;
 f.db.one=async function(sql,...bindings){
  const row=await one.call(this,sql,...bindings);
  if(sameSubjectStoreRead(sql,bindings,f,key)&&++reads===2){
   if(change==='missing')return null;
   if(change==='hash')return {...row,payload_hash:'0'.repeat(64)};
   const result=JSON.parse(row.response_json);result.transaction_id='synthetic-changed-transaction';
   return {...row,response_json:stable(result)};
  }
  return row;
 };
 t.after(()=>{f.db.one=one;});f.trace.length=0;r=await f.purchase(key);
 await assertPrivateFailure(r,'store_operation_receipt_unavailable',f.signed);assert.equal(reads,3);
 assertNoPreparedCheckpoint(f.trace.slice());assert.deepEqual(await f.row(key),original);assert.equal(f.calls,1);
 // The narrow substituted row models READ COMMITTED drift without bypassing
 // this database schema or claiming a multi-connection PGlite race.
});

test('same-subject receipt retirement between read and final admission suppresses replay',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID();let r=await f.purchase(key);assert.equal(r.status,200);await r.body?.cancel();
 const one=f.db.one,admit=f.journal.admission.bind(f.journal);let seen=false,scheduled=false,changed=false;
 f.db.one=async function(sql,...bindings){const row=await one.call(this,sql,...bindings);
  if(sameSubjectStoreRead(sql,bindings,f,key))seen=true;return row;};
 f.journal.admission=async(...args)=>{const result=await admit(...args);
  // The next admission after receipt selection is the post-read authority
  // check. Change the same subject's row after that read commits, before the
  // invocation's final independent admission. No external provider is used.
  if(seen&&!scheduled){scheduled=true;f.faults.afterCommit=async()=>{delete f.faults.afterCommit;
   const retired=stable({protocol:'lovelies-operation-retired-v1',status:'retired'});
   await f.h.db.transaction(()=>f.h.db.run("UPDATE operations SET payload_json='null',response_json=? WHERE actor_id=? AND source='store' AND operation_key=?",retired,f.owner.accountId,key));changed=true;};}
  return result;};
 t.after(()=>{f.db.one=one;});f.trace.length=0;r=await f.purchase(key);
 await assertPrivateFailure(r,'store_operation_receipt_unavailable',f.signed);assert(seen&&scheduled&&changed);
 assertNoPreparedCheckpoint(f.trace.slice());assert.equal((await f.row(key)).payload_json,'null');assert.equal(f.calls,1);
});

for(const mode of ['replay','entitlement'])test(`session expiry during read-only ${mode} never releases the response or prepares a plan`,{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID();let r=await f.purchase(key);assert.equal(r.status,200);await r.body?.cancel();
 const one=f.db.one;let reads=0,expired=false;
 f.db.one=async function(sql,...bindings){const row=await one.call(this,sql,...bindings);
  if(mode==='replay'&&sameSubjectStoreRead(sql,bindings,f,key)&&++reads===2){expired=true;f.expire();}
  if(mode==='entitlement'&&sql.startsWith('SELECT id,provider,product_id,starts_at,expires_at,version FROM store_subscriptions')&&!expired){expired=true;f.expire();}
  return row;};
 t.after(()=>{f.db.one=one;});f.trace.length=0;r=mode==='replay'?await f.purchase(key):await f.request('/me/entitlements');
 assert(expired);assert.equal(r.status,401);const text=await r.text();assert.equal(JSON.parse(text).error.code,'session_invalid');
 assert(!text.includes(f.signed));assert(!text.includes('synthetic-transaction'));assertNoPreparedCheckpoint(f.trace.slice());assert.equal(f.calls,1);
});

test('an unmatched pending journal plan fences known, unknown and entitlement reads without a new prepare',{timeout:30000},async t=>{
 const f=await setup(t),known=randomUUID(),pendingKey=randomUUID(),pendingID=await f.id(pendingKey);
 let r=await f.purchase(known);assert.equal(r.status,200);await r.body?.cancel();
 const prepare=f.journal.prepare.bind(f.journal);let changed=false;
 f.journal.prepare=async input=>{const saved=await prepare(input);if(input.operation_id===pendingID&&!changed){changed=true;f.expire();}return saved;};
 r=await f.purchase(pendingKey);await assertUnresolved(r);assert(changed);f.restoreClock();
 const pending=await f.journal.lookup(pendingID);assert.equal(pending.status,'pending');assert.equal(await f.row(pendingKey),null);
 const calls=f.calls;
 for(const invoke of [()=>f.purchase(known),()=>f.lookup(randomUUID()),()=>f.request('/me/entitlements'),()=>f.purchase(pendingKey)]){
  f.trace.length=0;r=await invoke();assert.equal(r.status,503);await r.body?.cancel();const trace=f.trace.slice();
  assert(trace.some(item=>item.kind==='journal_denied'&&item.path==='/v1/admission'));
  assert(!trace.some(item=>item.kind==='journal'&&item.path==='/v1/operations/prepare'));
  assert(!trace.some(item=>item.kind==='sql'&&item.sql.startsWith('UPDATE restore_control SET')));
  assert.equal(f.calls,calls);assert.deepEqual(await f.journal.lookup(pendingID),pending);
 }
 assert.equal((await f.journal.control()).state,'pending');assert.equal(await f.row(pendingKey),null);
});

test('a read reconciles only the exact committed pending marker, without preparing another plan',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID(),id=await f.id(key),prepare=f.journal.prepare.bind(f.journal);let armed=true;
 f.journal.prepare=async input=>{const saved=await prepare(input);if(armed&&input.operation_id===id){armed=false;f.faults.commitReply=true;}return saved;};
 let r=await f.purchase(key);await assertUnresolved(r);const row=await f.row(key),pending=await f.journal.lookup(id);
 assert(row);assert.equal(pending.status,'pending');f.trace.length=0;r=await f.purchase(key);
 assert.equal(r.status,200);assert.deepEqual(await r.json(),JSON.parse(row.response_json));const trace=f.trace.slice();
 assertNoPreparedCheckpoint(trace,{allowAcknowledgement:true});
 assert.equal(trace.filter(item=>item.kind==='journal'&&item.path==='/v1/operations/'+id+'/acknowledge').length,1);
 const after=await f.journal.lookup(id);assert.equal(after.status,'committed');assert.deepEqual(after.plan,pending.plan);
 assert.deepEqual(await f.row(key),row);assert.equal(f.calls,1);
});

test('read-only replay keeps genuine conflict and conservatively handles retired receipts',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID(),other='synthetic-other.payload.signature';let r=await f.purchase(key);
 assert.equal(r.status,200);await r.body?.cancel();
 const different=()=>f.request('/subscriptions/apple/transactions',{body:{operation_key:key,product_id:vars.APPLE_SUBSCRIPTION_PRODUCT_ID,signed_transaction:other}});
 f.trace.length=0;r=await different();assert.equal(r.status,409);assert.equal((await r.json()).error.code,'operation_key_conflict');assertNoPreparedCheckpoint(f.trace.slice());
 const retired=stable({protocol:'lovelies-operation-retired-v1',status:'retired'});
 await f.h.db.transaction(()=>f.h.db.run("UPDATE operations SET payload_json='null',response_json=? WHERE actor_id=? AND source='store' AND operation_key=?",retired,f.owner.accountId,key));
 f.trace.length=0;r=await f.purchase(key);assert.equal(r.status,410);assert.equal((await r.json()).error.code,'operation_receipt_retired');assertNoPreparedCheckpoint(f.trace.slice());
 f.trace.length=0;r=await different();await assertPrivateFailure(r,'store_operation_receipt_unavailable',other);assertNoPreparedCheckpoint(f.trace.slice());assert.equal(f.calls,1);
});

test('a same-subject legacy commit during fake verification replays inside the later write transaction',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID(),input={operation_key:key,product_id:vars.APPLE_SUBSCRIPTION_PRODUCT_ID,signed_transaction:f.signed};
 const legacy=await prepareOperation('store.apple',input,'store');
 const flat={active:true,provider:'apple_app_store',product_id:input.product_id,transaction_id:'synthetic-race-transaction',
  original_transaction_id:'synthetic-race-original',expires_at:new Date(f.now()+60000).toISOString(),billing_environment:'production',financial_eligible:true,stale:true};
 const fake=f.h.env.STORE_VERIFIER.fetch,prepare=f.journal.prepare.bind(f.journal),requested=[];let inserted=false;
 f.journal.prepare=async input=>{requested.push(input.operation_id);return prepare(input);};
 f.h.env.STORE_VERIFIER.fetch=async(...args)=>{const response=await fake(...args);if(!inserted){inserted=true;
  // A separate fenced same-subject commit is interleaved after the initial
  // absent read and before the purchase enters its later transaction.
  await executeOperation(f.context,f.actor,legacy,()=>flat);
 }return response;};
 f.trace.length=0;const r=await f.purchase(key);assert(inserted);assert.equal(r.status,200);assert.deepEqual(await r.json(),flat);
 const id=await f.id(key),row=await f.row(key),plan=await f.journal.lookup(id);assert.equal(plan.status,'committed');
 assert.equal(row.payload_hash,legacy.hash);assert.equal(row.payload_json,legacy.payloadJson);assert.equal(requested.filter(value=>value===id).length,1);
 // The later existing write transaction still prepares its generic checkpoint;
 // it does not re-run or re-prepare the logical store operation.
 assert.equal(requested.length,2);assert.equal(f.calls,1);assert.equal((await f.subscriptions()).length,0);
});

test('Google committed purchase replay stays read-only and does not acknowledge again',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID();let r=await f.googlePurchase(key);assert.equal(r.status,200);const original=await r.json();
 const before=await f.journal.control();f.trace.length=0;r=await f.googlePurchase(key);assert.equal(r.status,200);
 assert.deepEqual(await r.json(),original);assertNoPreparedCheckpoint(f.trace.slice());
 assert.deepEqual((await f.journal.control()).marker,before.marker);assert.equal(f.googleCalls,1);assert.equal(f.googleAcks,1);assert.equal(f.calls,0);
});

test('session expiry after the post-read entitlement admission suppresses the response without a checkpoint',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID();let r=await f.purchase(key);assert.equal(r.status,200);await r.body?.cancel();
 const one=f.db.one,admit=f.journal.admission.bind(f.journal);let selected=false,scheduled=false,expired=false;
 f.db.one=async function(sql,...bindings){const row=await one.call(this,sql,...bindings);
  if(sql.startsWith('SELECT id,provider,product_id,starts_at,expires_at,version FROM store_subscriptions'))selected=true;return row;};
 f.journal.admission=async(...args)=>{const result=await admit(...args);if(selected&&!scheduled){scheduled=true;
  f.faults.afterCommit=async()=>{delete f.faults.afterCommit;expired=true;f.expire();};}return result;};
 t.after(()=>{f.db.one=one;});f.trace.length=0;r=await f.request('/me/entitlements');assert(selected&&scheduled&&expired);
 assert.equal(r.status,401);const text=await r.text();assert.equal(JSON.parse(text).error.code,'session_invalid');assert(!text.includes('synthetic-transaction'));
 assertNoPreparedCheckpoint(f.trace.slice());assert.equal(f.calls,1);
});

test('a damaged non-retired action returns unavailable for lookup and replay without losing the receipt',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID();let r=await f.purchase(key);assert.equal(r.status,200);await r.body?.cancel();
 const original=await f.row(key);await f.h.db.transaction(()=>f.h.db.run("UPDATE operations SET action='store.damaged' WHERE actor_id=? AND source='store' AND operation_key=?",f.owner.accountId,key));
 const damaged=await f.row(key);assert.equal(damaged.action,'store.damaged');assert.equal(damaged.payload_hash,original.payload_hash);
 const different=()=>f.request('/subscriptions/apple/transactions',{body:{operation_key:key,product_id:vars.APPLE_SUBSCRIPTION_PRODUCT_ID,signed_transaction:'synthetic-other.payload.signature'}});
 for(const invoke of [()=>f.lookup(key),()=>f.purchase(key),different]){
  f.trace.length=0;r=await invoke();await assertPrivateFailure(r,'store_operation_receipt_unavailable',f.signed);
  assertNoPreparedCheckpoint(f.trace.slice());assert.deepEqual(await f.row(key),damaged);assert.equal(f.calls,1);
 }
});

test('retired or partial same-subject receipts release 410 only for a matching intact original request',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID();let r=await f.purchase(key);assert.equal(r.status,200);await r.body?.cancel();
 const original=await f.row(key),retired=stable({protocol:'lovelies-operation-retired-v1',status:'retired'});
 const update=(sql,...values)=>f.h.db.transaction(()=>f.h.db.run(sql,...values));
 await update("UPDATE operations SET payload_json='null',response_json=? WHERE actor_id=? AND source='store' AND operation_key=?",retired,f.owner.accountId,key);
 const different=()=>f.request('/subscriptions/apple/transactions',{body:{operation_key:key,product_id:vars.APPLE_SUBSCRIPTION_PRODUCT_ID,signed_transaction:'synthetic-other.payload.signature'}});
 f.trace.length=0;r=await f.purchase(key);assert.equal(r.status,410);assert.equal((await r.json()).error.code,'operation_receipt_retired');assertNoPreparedCheckpoint(f.trace.slice());
 for(const invoke of [()=>f.lookup(key),different]){f.trace.length=0;r=await invoke();await assertPrivateFailure(r,'store_operation_receipt_unavailable',f.signed);assertNoPreparedCheckpoint(f.trace.slice());}
 await update("UPDATE operations SET action='store.damaged' WHERE actor_id=? AND source='store' AND operation_key=?",f.owner.accountId,key);
 for(const invoke of [()=>f.purchase(key),()=>f.lookup(key)]){f.trace.length=0;r=await invoke();await assertPrivateFailure(r,'store_operation_receipt_unavailable',f.signed);assertNoPreparedCheckpoint(f.trace.slice());}
 await update("UPDATE operations SET action=?,payload_hash=? WHERE actor_id=? AND source='store' AND operation_key=?",original.action,'0'.repeat(64),f.owner.accountId,key);
 f.trace.length=0;r=await f.purchase(key);await assertPrivateFailure(r,'store_operation_receipt_unavailable',f.signed);assertNoPreparedCheckpoint(f.trace.slice());
 await update("UPDATE operations SET payload_hash=?,response_json=? WHERE actor_id=? AND source='store' AND operation_key=?",original.payload_hash,original.response_json,f.owner.accountId,key);
 f.trace.length=0;r=await f.purchase(key);await assertPrivateFailure(r,'operation_receipt_unavailable',f.signed);assertNoPreparedCheckpoint(f.trace.slice());
 f.trace.length=0;r=await f.lookup(key);await assertPrivateFailure(r,'store_operation_receipt_unavailable',f.signed);assertNoPreparedCheckpoint(f.trace.slice());assert.equal(f.calls,1);
});

test('a lost fake Google acknowledgement reply remains unresolved without preparing or dispatching a second attempt',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID(),id=await f.id(key),fake=f.h.env.STORE_VERIFIER.fetch;let lost=false;
 f.h.env.STORE_VERIFIER.fetch=async(input,init)=>{const path=new URL(input instanceof Request?input.url:String(input)).pathname;
  const response=await fake(input,init);if(path==='/google/acknowledge'){lost=true;await response.body?.cancel();throw Error('synthetic_acknowledgement_reply_lost');}return response;};
 f.trace.length=0;const r=await f.googlePurchase(key);await assertUnresolved(r,[f.googleToken,'synthetic-google-order']);
 assert(lost);assert.equal(f.googleCalls,1);assert.equal(f.googleAcks,1);assertNoPreparedCheckpoint(f.trace.slice());
 assert.equal(await f.row(key),null);assert.equal((await f.subscriptions()).length,0);assert.equal(await f.journal.lookup(id),null);
});

test('a late same-key conflict after fake Google acknowledgement remains unresolved',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID(),other='synthetic-other-google-token-'+randomUUID();
 const input={operation_key:key,product_id:vars.GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID,purchase_token:other};
 const legacy=await prepareOperation('store.google',input,'store');
 const flat={active:true,provider:'google_play',product_id:input.product_id,transaction_id:'synthetic-race-google-order',
  original_transaction_id:'synthetic-race-google-original',expires_at:new Date(f.now()+60000).toISOString(),billing_environment:'production',financial_eligible:true,stale:true};
 const fake=f.h.env.STORE_VERIFIER.fetch;let inserted=false;
 f.h.env.STORE_VERIFIER.fetch=async(input,init)=>{const path=new URL(input instanceof Request?input.url:String(input)).pathname;
  const response=await fake(input,init);if(path==='/google/acknowledge'&&!inserted){inserted=true;await executeOperation(f.context,f.actor,legacy,()=>flat);}return response;};
 const r=await f.googlePurchase(key);await assertUnresolved(r,[f.googleToken,other,'synthetic-google-order']);assert(inserted);
 assert.equal(f.googleCalls,1);assert.equal(f.googleAcks,1);assert.equal(f.calls,0);
 const row=await f.row(key),record=await f.journal.lookup(await f.id(key));assert(row);assert.equal(row.payload_hash,legacy.hash);
 assert.equal(record.status,'committed');assert.equal(record.plan.input_hash,legacy.hash);assert.equal((await f.subscriptions()).length,0);
});

test('expiry after fake Google verification prevents acknowledgement and prepares no plan',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID(),id=await f.id(key),fake=f.h.env.STORE_VERIFIER.fetch;let expired=false;
 f.h.env.STORE_VERIFIER.fetch=async(input,init)=>{const path=new URL(input instanceof Request?input.url:String(input)).pathname;
  const response=await fake(input,init);if(path==='/google/subscription'){expired=true;f.expire();}return response;};
 f.trace.length=0;const r=await f.googlePurchase(key);assert(expired);assert.equal(r.status,401);
 const text=await r.text();assert.equal(JSON.parse(text).error.code,'session_invalid');assert(!text.includes(f.googleToken));
 assert.equal(f.googleCalls,1);assert.equal(f.googleAcks,0);assertNoPreparedCheckpoint(f.trace.slice());
 assert.equal(await f.row(key),null);assert.equal((await f.subscriptions()).length,0);assert.equal(await f.journal.lookup(id),null);
});

test('a conflicting store response is withheld if its exact row changes before final admission',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID();let r=await f.purchase(key);assert.equal(r.status,200);await r.body?.cancel();
 const one=f.db.one;let reads=0;
 f.db.one=async function(sql,...bindings){const row=await one.call(this,sql,...bindings);
  if(sameSubjectStoreRead(sql,bindings,f,key)&&++reads===2)return {...row,payload_hash:'0'.repeat(64)};return row;};
 t.after(()=>{f.db.one=one;});f.trace.length=0;
 r=await f.request('/subscriptions/apple/transactions',{body:{operation_key:key,product_id:vars.APPLE_SUBSCRIPTION_PRODUCT_ID,signed_transaction:'synthetic-other.payload.signature'}});
 await assertPrivateFailure(r,'store_operation_receipt_unavailable',f.signed);assert.equal(reads,2);assert.equal(f.calls,1);assertNoPreparedCheckpoint(f.trace.slice());
});

test('a retired store response is withheld if its exact row changes before final admission',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID();let r=await f.purchase(key);assert.equal(r.status,200);await r.body?.cancel();
 const retired=stable({protocol:'lovelies-operation-retired-v1',status:'retired'});
 await f.h.db.transaction(()=>f.h.db.run("UPDATE operations SET payload_json='null',response_json=? WHERE actor_id=? AND source='store' AND operation_key=?",retired,f.owner.accountId,key));
 const one=f.db.one;let reads=0;
 f.db.one=async function(sql,...bindings){const row=await one.call(this,sql,...bindings);
  if(sameSubjectStoreRead(sql,bindings,f,key)&&++reads===2)return null;return row;};
 t.after(()=>{f.db.one=one;});f.trace.length=0;r=await f.purchase(key);
 await assertPrivateFailure(r,'store_operation_receipt_unavailable',f.signed);assert.equal(reads,2);assert.equal(f.calls,1);assertNoPreparedCheckpoint(f.trace.slice());
});

test('a typed historical receipt is withheld if its exact row changes before final admission',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID();let r=await f.purchase(key);assert.equal(r.status,200);await r.body?.cancel();
 const one=f.db.one;let reads=0;
 f.db.one=async function(sql,...bindings){const row=await one.call(this,sql,...bindings);
  if(sameSubjectStoreRead(sql,bindings,f,key)&&++reads===2)return {...row,response_json:'{}'};return row;};
 t.after(()=>{f.db.one=one;});f.trace.length=0;r=await f.lookup(key);
 await assertPrivateFailure(r,'store_operation_receipt_unavailable',f.signed);assert.equal(reads,2);assert.equal(f.calls,1);assertNoPreparedCheckpoint(f.trace.slice());
});
