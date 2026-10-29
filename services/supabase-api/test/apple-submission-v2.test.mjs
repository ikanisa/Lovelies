/** Offline, same-subject contract checks. Never use an external database or provider. */
import assert from 'node:assert/strict';
import {after,test as nodeTest} from 'node:test';
import {randomUUID} from 'node:crypto';
import {prepareOperation,executeOperation} from '../src/operations.ts';
import {stable} from '../src/types.ts';
import {startHarness,enroll,faceVerifierFixture,sha256} from './runtime-harness.mjs';

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
 let account,calls=0;const now=Date.now();
 const old='synthetic-old.payload.signature',newer='synthetic-new.payload.signature',sandbox='synthetic-sandbox.payload.signature',wrong='synthetic-wrong.payload.signature';
 const playToken='synthetic-play-token-'+randomUUID();
 const transactions=new Map([[old,{id:'synthetic-older',signedDate:now-60000}],
  [newer,{id:'synthetic-newer',signedDate:now}],[sandbox,{id:'synthetic-sandbox',signedDate:now,environment:'Sandbox'}],
  [wrong,{id:'synthetic-wrong',signedDate:now,productId:'synthetic.wrong.product'}]]);
 const verifier=async(envelope,path)=>{
  calls++;assert.equal(envelope.protocol,'lovelies-store-verifier-v1');assert.equal(envelope.input_hash,await digest(stable(envelope.input)));
  let payload;
  if(path==='/apple/transaction'){
   const tx=transactions.get(envelope.input.signed_payload);assert(tx,'unexpected synthetic JWS');
   payload={bundleId:vars.APPLE_BUNDLE_ID,productId:tx.productId??vars.APPLE_SUBSCRIPTION_PRODUCT_ID,
    type:'Auto-Renewable Subscription',inAppOwnershipType:'PURCHASED',appAccountToken:account,
    environment:tx.environment??'Production',purchaseDate:now-120000,expiresDate:now+86400000,
    signedDate:tx.signedDate,originalTransactionId:'synthetic-original',transactionId:tx.id};
  }else if(path==='/google/subscription'){
   assert.equal(envelope.input.purchaseToken,playToken);
   payload={kind:'androidpublisher#subscriptionPurchaseV2',subscriptionState:'SUBSCRIPTION_STATE_ACTIVE',
    acknowledgementState:'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',startTime:new Date(now-1000).toISOString(),
    externalAccountIdentifiers:{obfuscatedExternalAccountId:await digest(account)},
    lineItems:[{productId:vars.GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID,expiryTime:new Date(now+86400000).toISOString(),latestSuccessfulOrderId:'synthetic-order'}]};
  }else throw Error('unexpected synthetic provider call');
  return {...envelope,verified:true,payload};
 };
 const h=await startHarness({faceVerifier:faceVerifierFixture,storeVerifier:verifier,vars,consumeQueue:false});
 t.after(()=>h.close());const owner=await enroll(h);account=owner.accountId;
 const purchase=(provider,key,credential)=>h.request(`/subscriptions/${provider}/transactions`,{token:owner.token,body:{
  operation_key:key,product_id:vars.APPLE_SUBSCRIPTION_PRODUCT_ID,[provider==='apple'?'signed_transaction':'purchase_token']:credential}});
 const lookup=key=>h.request('/me/store-operations',{token:owner.token,body:{operation_key:key}});
 const row=key=>h.db.one("SELECT action,payload_hash,payload_json,response_json FROM operations WHERE actor_id=? AND source='store' AND operation_key=?",account,key);
 return {h,owner,old,newer,sandbox,wrong,playToken,purchase,lookup,row,get calls(){return calls;}};
}

async function binding(signed,id,environment='production'){
 return {protocol:'lovelies-apple-submission-v2',product_id:vars.APPLE_SUBSCRIPTION_PRODUCT_ID,
  transaction_id:id,original_transaction_id:'synthetic-original',billing_environment:environment,credential_sha256:await digest(signed)};
}

test('Apple current and stale operations bind the verified submission independently of current state',{timeout:30000},async t=>{
 const f=await setup(t),newKey=randomUUID(),oldKey=randomUUID();
 let r=await f.purchase('apple',newKey,f.newer);assert.equal(r.status,200);const current=await r.json();
 assert.deepEqual(current.verified_submission,await binding(f.newer,'synthetic-newer'));assert.equal(current.stale,false);
 r=await f.purchase('apple',oldKey,f.old);assert.equal(r.status,200);const stale=await r.json();
 assert.equal(stale.stale,true);assert.equal(stale.transaction_id,'synthetic-newer');
 assert.deepEqual(stale.verified_submission,await binding(f.old,'synthetic-older'));
 const saved=await f.row(oldKey),payload=JSON.parse(saved.payload_json);
 assert.equal(payload.credential_sha256,await digest(f.old));assert.equal(saved.payload_hash,await digest(stable({action:'store.apple',source:'store',payload})));
 assert(!saved.payload_json.includes(f.old));assert(!saved.response_json.includes(f.old));
 r=await f.lookup(oldKey);assert.equal(r.status,200);const receipt=await r.json();
 assert.equal(receipt.protocol,'lovelies-store-operation-receipt-v1');assert.equal(receipt.status,'committed');
 assert.equal(receipt.actor_id,f.owner.accountId);assert.equal(receipt.operation_key,oldKey);assert.equal(receipt.action,'store.apple');
 assert.equal(receipt.source,'store');assert.equal(receipt.receipt_scope,'historical');assert.equal(receipt.input_scheme,'digest-v1');
 assert.equal(receipt.payload_hash,saved.payload_hash);assert.equal(receipt.credential_sha256,await digest(f.old));assert.deepEqual(receipt.result,stale);
 assert(!JSON.stringify(receipt).includes(f.old));
 await f.h.db.transaction(()=>f.h.db.run('UPDATE store_subscriptions SET active=0 WHERE account_id=?',f.owner.accountId));
 assert.equal((await f.h.json('/me/entitlements',{token:f.owner.token})).pro_active,false);
 r=await f.lookup(oldKey);assert.equal(r.status,200);assert.deepEqual((await r.json()).result,stale);
 r=await f.purchase('apple',oldKey,f.old);assert.equal(r.status,200);assert.deepEqual(await r.json(),stale);assert.equal(f.calls,2);
 r=await f.purchase('apple',oldKey,f.newer);assert.equal(r.status,409);assert.equal(f.calls,2);
});

test('sandbox binding reflects the verified environment and rejects an unverified product',{timeout:30000},async t=>{
 const f=await setup(t),badKey=randomUUID();let r=await f.purchase('apple',badKey,f.wrong);
 assert.equal(r.status,422);assert.equal((await r.json()).error.code,'apple_product_mismatch');assert.equal(await f.row(badKey),null);
 const key=randomUUID();r=await f.purchase('apple',key,f.sandbox);assert.equal(r.status,200);const value=await r.json();
 assert.equal(value.billing_environment,'sandbox');assert.equal(value.financial_eligible,false);
 assert.deepEqual(value.verified_submission,await binding(f.sandbox,'synthetic-sandbox','sandbox'));
 r=await f.lookup(key);assert.equal(r.status,200);assert.deepEqual((await r.json()).result,value);
});

test('legacy raw and digest input receipts replay exactly without new verification',{timeout:30000},async t=>{
 const f=await setup(t),actor=await f.h.app.authenticate(new Request('https://api.invalid/me',{headers:{authorization:'Bearer '+f.owner.token}}));
 for(const scheme of ['raw','digest']){
  const key=randomUUID(),input={operation_key:key,product_id:vars.APPLE_SUBSCRIPTION_PRODUCT_ID,signed_transaction:f.old};
  const operationInput=scheme==='raw'?input:{protocol:'lovelies-store-operation-input-v1',operation_key:key,
   product_id:input.product_id,credential_sha256:await digest(f.old)};
  const flat={active:true,provider:'apple_app_store',product_id:input.product_id,transaction_id:'synthetic-newer',
   original_transaction_id:'synthetic-original',expires_at:new Date(Date.now()+60000).toISOString(),billing_environment:'production',financial_eligible:true,stale:true};
  const intent=await prepareOperation('store.apple',operationInput,'store');await executeOperation(f.h.app,actor,intent,()=>flat);
  const before=await f.row(key);let r=await f.purchase('apple',key,f.old);assert.equal(r.status,200);assert.deepEqual(await r.json(),flat);
  r=await f.lookup(key);assert.equal(r.status,200);const receipt=await r.json();assert.deepEqual(receipt.result,flat);
  assert.equal(receipt.input_scheme,scheme==='raw'?'legacy-raw-v0':'digest-v1');assert.equal(receipt.credential_sha256,await digest(f.old));
  assert(!JSON.stringify(receipt).includes(f.old));assert.deepEqual(await f.row(key),before);
 }
 assert.equal(f.calls,0);
});

test('malformed or unbound Apple v2 receipt data fails closed',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID();let r=await f.purchase('apple',key,f.old);assert.equal(r.status,200);
 const valid=await r.json();assert.equal(valid.stale,false);const mutations=[
  value=>{value.verified_submission=null;},value=>{value.verified_submission=[];},
  value=>{value.verified_submission.protocol='other';},value=>{value.verified_submission.product_id='other';},
  value=>{value.verified_submission.credential_sha256='0'.repeat(64);},value=>{value.verified_submission.transaction_id='synthetic-substituted-id';},
  value=>{value.verified_submission.transaction_id='';},
  value=>{value.verified_submission.transaction_id='bad id';},value=>{value.verified_submission.transaction_id='x'.repeat(161);},
  value=>{value.verified_submission.original_transaction_id='other';},value=>{value.verified_submission.billing_environment='sandbox';},
  value=>{value.verified_submission.extra='other';},value=>{delete value.verified_submission.transaction_id;}
 ];
 for(const mutate of mutations){
  const corrupt=structuredClone(valid);mutate(corrupt);
  await f.h.db.transaction(()=>f.h.db.run("UPDATE operations SET response_json=? WHERE actor_id=? AND source='store' AND operation_key=?",stable(corrupt),f.owner.accountId,key));
  r=await f.lookup(key);assert.equal(r.status,503);let body=await r.text();assert(!body.includes(f.old));
  assert.equal(JSON.parse(body).error.code,'store_operation_receipt_unavailable');
  r=await f.purchase('apple',key,f.old);assert.equal(r.status,503);body=await r.text();assert(!body.includes(f.old));
  assert.equal(JSON.parse(body).error.code,'store_operation_receipt_unavailable');assert.equal(f.calls,1);
 }
 // Valid JSON values of the wrong shape pass the schema constraint but
 // remain unavailable through both routes.
 for(const raw of ['null','[]','"synthetic"']){
  await f.h.db.transaction(()=>f.h.db.run("UPDATE operations SET response_json=? WHERE actor_id=? AND source='store' AND operation_key=?",raw,f.owner.accountId,key));
  for(const call of [()=>f.lookup(key),()=>f.purchase('apple',key,f.old)]){
   r=await call();assert.equal(r.status,503);const text=await r.text();assert(!text.includes(f.old));
   assert.equal(JSON.parse(text).error.code,'store_operation_receipt_unavailable');
  }
 }
 assert.equal(f.calls,1);
 await f.h.db.transaction(()=>f.h.db.run("UPDATE operations SET response_json=? WHERE actor_id=? AND source='store' AND operation_key=?",stable(valid),f.owner.accountId,key));
 r=await f.lookup(key);assert.equal(r.status,200);assert.deepEqual((await r.json()).result,valid);
});

test('Google operation and receipt keep their flat v1 shape',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID();let r=await f.purchase('google',key,f.playToken);assert.equal(r.status,200);
 const value=await r.json();assert.equal(value.provider,'google_play');assert(!Object.hasOwn(value,'verified_submission'));
 r=await f.lookup(key);assert.equal(r.status,200);const receipt=await r.json();assert.deepEqual(receipt.result,value);
 r=await f.purchase('google',key,f.playToken);assert.equal(r.status,200);assert.deepEqual(await r.json(),value);assert.equal(f.calls,1);
 const corrupt={...value,verified_submission:await binding(f.old,'synthetic-older')};
 await f.h.db.transaction(()=>f.h.db.run("UPDATE operations SET response_json=? WHERE actor_id=? AND source='store' AND operation_key=?",stable(corrupt),f.owner.accountId,key));
 r=await f.lookup(key);assert.equal(r.status,503);
 r=await f.purchase('google',key,f.playToken);assert.equal(r.status,503);assert.equal(f.calls,1);
});

test('a same-subject operation committed during verification is validated before POST replay',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID(),provider=f.h.env.STORE_VERIFIER.fetch.bind(f.h.env.STORE_VERIFIER);
 let release,entered,dispatches=0;
 const gate=new Promise(resolve=>{release=resolve;}),waiting=new Promise(resolve=>{entered=resolve;});
 f.h.env.STORE_VERIFIER.fetch=async(...args)=>{
  dispatches++;if(dispatches===1){entered();await gate;}return provider(...args);
 };
 const suspended=f.purchase('apple',key,f.old);t.after(async()=>{release();await suspended.catch(()=>{});});
 await waiting;
 try {
  // The first request has verified no response yet. The same subject commits
  // the same logical operation, then this local-only fixture corrupts its row.
  let r=await f.purchase('apple',key,f.old);assert.equal(r.status,200);const value=await r.json();assert.equal(value.stale,false);
  const corrupt=structuredClone(value);corrupt.verified_submission.transaction_id='synthetic-substituted-id';
  await f.h.db.transaction(()=>f.h.db.run("UPDATE operations SET response_json=? WHERE actor_id=? AND source='store' AND operation_key=?",stable(corrupt),f.owner.accountId,key));
  r=await f.lookup(key);assert.equal(r.status,503);
 } finally {release();}
 const r=await suspended;assert.equal(r.status,503);const body=await r.text();
 assert(!body.includes(f.old));assert.equal(JSON.parse(body).error.code,'store_operation_receipt_unavailable');assert.equal(f.calls,2);
 const saved=await f.row(key);assert.equal(JSON.parse(saved.response_json).verified_submission.transaction_id,'synthetic-substituted-id');
 assert.equal((await f.h.db.all('SELECT transaction_id FROM store_transactions WHERE account_id=?',f.owner.accountId)).length,1);
});

test('session expiry during direct replay validation suppresses the historical result',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID();assert.equal((await f.purchase('apple',key,f.old)).status,200);
 const saved=await f.row(key),target=stable({action:saved.action,source:'store',payload:JSON.parse(saved.payload_json)});
 const actor=await f.h.app.authenticate(new Request('https://api.invalid/me',{headers:{authorization:'Bearer '+f.owner.token}}));
 const originalNow=f.h.app.now,originalDigest=crypto.subtle.digest.bind(crypto.subtle),originalDescriptor=Object.getOwnPropertyDescriptor(crypto.subtle,'digest');
 let expired=false,hits=0;f.h.app.now=()=>expired?actor.expiresAt+1000:originalNow();
 crypto.subtle.digest=async(algorithm,data)=>{
  const result=await originalDigest(algorithm,data);
  // The first digest is the prepared redacted request; the second is the
  // shared stored-receipt validation inside the replay transaction.
  if(new TextDecoder().decode(data)===target&&++hits===2)expired=true;
  return result;
 };
 t.after(()=>{f.h.app.now=originalNow;if(originalDescriptor)Object.defineProperty(crypto.subtle,'digest',originalDescriptor);else delete crypto.subtle.digest;});
 const r=await f.purchase('apple',key,f.old);assert.equal(hits,2);assert.equal(r.status,401);
 const body=await r.text();assert(!body.includes(f.old));assert.equal(JSON.parse(body).error.code,'session_invalid');assert.equal(f.calls,1);
});

test('malformed JSON from a narrowly mocked same-subject row fails closed without bypassing the schema',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID();let r=await f.purchase('apple',key,f.old);assert.equal(r.status,200);await r.body?.cancel();
 const before=await f.row(key),original=f.h.db.one;let intercept=true,hits=0;
 f.h.db.one=async function(sql,...bindings){
  const row=await original.call(this,sql,...bindings);
  if(intercept&&row&&sql==="SELECT action,payload_hash,payload_json,response_json FROM operations WHERE actor_id=? AND source='store' AND operation_key=?"&&
   bindings.length===2&&bindings[0]===f.owner.accountId&&bindings[1]===key){hits++;return {...row,response_json:'{'};}
  return row;
 };
 t.after(()=>{f.h.db.one=original;});
 for(const call of [()=>f.lookup(key),()=>f.purchase('apple',key,f.old)]){
  r=await call();assert.equal(r.status,503);const text=await r.text();assert(!text.includes(f.old));
  assert.equal(JSON.parse(text).error.code,'store_operation_receipt_unavailable');
 }
 assert.equal(hits,2);assert.equal(f.calls,1);intercept=false;assert.deepEqual(await f.row(key),before);
});

test('an early same-subject legacy raw commit is selected inside the replay transaction',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID(),actor=await f.h.app.authenticate(new Request('https://api.invalid/me',{headers:{authorization:'Bearer '+f.owner.token}}));
 const input={operation_key:key,product_id:vars.APPLE_SUBSCRIPTION_PRODUCT_ID,signed_transaction:f.old};
 const legacy=await prepareOperation('store.apple',input,'store');
 const flat={active:true,provider:'apple_app_store',product_id:input.product_id,transaction_id:'synthetic-newer',
  original_transaction_id:'synthetic-original',expires_at:new Date(Date.now()+60000).toISOString(),billing_environment:'production',financial_eligible:true,stale:true};
 const original=f.h.db.transaction;let armed=true,inserted=false;
 f.h.db.transaction=async function(callback,intent){
  if(armed){armed=false;await executeOperation(f.h.app,actor,legacy,()=>flat);inserted=true;}
  return original.call(this,callback,intent);
 };
 t.after(()=>{f.h.db.transaction=original;});
 const r=await f.purchase('apple',key,f.old);assert(inserted);assert.equal(r.status,200);assert.deepEqual(await r.json(),flat);
 assert.equal(f.calls,0);const stored=await f.row(key);assert.equal(stored.payload_hash,legacy.hash);assert.equal(stored.payload_json,legacy.payloadJson);
 const receipt=await f.lookup(key);assert.equal(receipt.status,200);assert.deepEqual((await receipt.json()).result,flat);
 const changed=await f.purchase('apple',key,f.newer);assert.equal(changed.status,409);
 assert.equal((await changed.json()).error.code,'operation_key_conflict');assert.deepEqual(await f.row(key),stored);assert.equal(f.calls,0);
});

test('corrupt stored input is unavailable before classifying a genuine different-input conflict',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID();let r=await f.purchase('apple',key,f.old);assert.equal(r.status,200);await r.body?.cancel();
 const original=await f.row(key),payload=JSON.parse(original.payload_json);
 const cases=[{hash:'0'.repeat(64),json:original.payload_json},
  {hash:original.payload_hash,json:stable({...payload,credential_sha256:'0'.repeat(64)})},
  {hash:original.payload_hash,json:stable({...payload,operation_key:randomUUID()})},
  {hash:original.payload_hash,json:'{}'}];
 for(const corrupt of cases){
  await f.h.db.transaction(()=>f.h.db.run("UPDATE operations SET payload_hash=?,payload_json=? WHERE actor_id=? AND source='store' AND operation_key=?",corrupt.hash,corrupt.json,f.owner.accountId,key));
  for(const call of [()=>f.lookup(key),()=>f.purchase('apple',key,f.old),()=>f.purchase('apple',key,f.newer)]){
   r=await call();assert.equal(r.status,503);const text=await r.text();assert(!text.includes(f.old));assert(!text.includes(f.newer));
   assert.equal(JSON.parse(text).error.code,'store_operation_receipt_unavailable');
  }
  assert.equal(f.calls,1);
 }
 await f.h.db.transaction(()=>f.h.db.run("UPDATE operations SET payload_hash=?,payload_json=? WHERE actor_id=? AND source='store' AND operation_key=?",original.payload_hash,original.payload_json,f.owner.accountId,key));
 r=await f.purchase('apple',key,f.newer);assert.equal(r.status,409);assert.equal((await r.json()).error.code,'operation_key_conflict');
 assert.deepEqual(await f.row(key),original);assert.equal(f.calls,1);
});

test('retired receipts preserve matching retirement and different-input conflict semantics',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID();let r=await f.purchase('apple',key,f.old);assert.equal(r.status,200);await r.body?.cancel();
 const original=await f.row(key),retired=stable({protocol:'lovelies-operation-retired-v1',status:'retired'});
 await f.h.db.transaction(()=>f.h.db.run("UPDATE operations SET payload_json='null',response_json=? WHERE actor_id=? AND source='store' AND operation_key=?",retired,f.owner.accountId,key));
 r=await f.lookup(key);assert.equal(r.status,410);assert.equal((await r.json()).error.code,'operation_receipt_retired');
 r=await f.purchase('apple',key,f.old);assert.equal(r.status,410);assert.equal((await r.json()).error.code,'operation_receipt_retired');
 r=await f.purchase('apple',key,f.newer);assert.equal(r.status,409);assert.equal((await r.json()).error.code,'operation_key_conflict');
 await f.h.db.transaction(()=>f.h.db.run("UPDATE operations SET response_json=? WHERE actor_id=? AND source='store' AND operation_key=?",original.response_json,f.owner.accountId,key));
 r=await f.purchase('apple',key,f.old);assert.equal(r.status,503);assert.equal((await r.json()).error.code,'operation_receipt_unavailable');
 r=await f.purchase('apple',key,f.newer);assert.equal(r.status,409);assert.equal((await r.json()).error.code,'operation_key_conflict');assert.equal(f.calls,1);
});
