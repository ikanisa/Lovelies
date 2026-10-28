/** Local, same-account checks of the actual API handler. No real store,
 * external network, cross-account simulation or production data is used. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createApp,createHandler} from '../src/index.ts';
import {executeOperation,prepareOperation} from '../src/operations.ts';
import {stable} from '../src/types.ts';
import {fixture as journalFixture} from './restore-database-fixture.mjs';
import {startHarness,enroll,faceVerifierFixture,sha256} from './runtime-harness.mjs';

const localTest=process.env.TEST_DATABASE_URL===undefined?test:test.skip;
if(process.env.TEST_DATABASE_URL===undefined)globalThis.fetch=async()=>{throw Error('external_fetch_prohibited');};
const vars={APPLE_BUNDLE_ID:'com.lovelies.memories',APPLE_APP_ID:'987654321',
 APPLE_SUBSCRIPTION_PRODUCT_ID:'com.lovelies.memories.pro.monthly',GOOGLE_PLAY_PACKAGE_NAME:'com.lovelies.memories',
 GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID:'com.lovelies.memories.pro.monthly'};
const digest=async value=>sha256(new TextEncoder().encode(value));

async function setup(t,options={}){
 let account, calls=0;
 const signed='synthetic-store-transaction.payload.signature', token='synthetic-play-token-'+randomUUID();
 const verifier=async(envelope,path)=>{
  calls++;assert.equal(envelope.protocol,'lovelies-store-verifier-v1');
  assert.equal(envelope.input_hash,await digest(stable(envelope.input)));
  let payload;
  if(path==='/apple/transaction'){
   assert.equal(envelope.input.signed_payload,signed);
   payload={bundleId:vars.APPLE_BUNDLE_ID,productId:vars.APPLE_SUBSCRIPTION_PRODUCT_ID,type:'Auto-Renewable Subscription',
    inAppOwnershipType:'PURCHASED',appAccountToken:account,environment:'Production',purchaseDate:Date.now()-1000,
    expiresDate:Date.now()+86400000,signedDate:Date.now(),originalTransactionId:'synthetic-original',transactionId:options.transactionId??'synthetic-transaction'};
  }else if(path==='/google/subscription'){
   assert.equal(envelope.input.purchaseToken,token);
   payload={kind:'androidpublisher#subscriptionPurchaseV2',subscriptionState:'SUBSCRIPTION_STATE_ACTIVE',
    acknowledgementState:'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',startTime:new Date(Date.now()-1000).toISOString(),
    externalAccountIdentifiers:{obfuscatedExternalAccountId:await digest(account)},
    lineItems:[{productId:vars.GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID,expiryTime:new Date(Date.now()+86400000).toISOString(),latestSuccessfulOrderId:'synthetic-order'}]};
  }else throw Error('unexpected synthetic provider call');
  return {...envelope,verified:true,payload};
 };
 const h=await startHarness({faceVerifier:faceVerifierFixture,storeVerifier:verifier,vars,consumeQueue:false});
 t.after(()=>h.close());const owner=await enroll(h);account=owner.accountId;
 const lookup=(key,options={})=>h.request('/me/store-operations',{token:owner.token,method:'POST',body:{operation_key:key},...options});
 const purchase=(provider,key,credential=provider==='apple'?signed:token)=>h.request(`/subscriptions/${provider}/transactions`,{token:owner.token,
  body:{product_id:vars.APPLE_SUBSCRIPTION_PRODUCT_ID,[provider==='apple'?'signed_transaction':'purchase_token']:credential,operation_key:key}});
 const row=key=>h.db.one("SELECT action,payload_hash,payload_json,response_json FROM operations WHERE actor_id=? AND source='store' AND operation_key=?",owner.accountId,key);
 return {h,owner,signed,token,lookup,purchase,row,get calls(){return calls;}};
}

for(const provider of ['apple','google']) localTest(`${provider}: new operation stores only a credential digest and replays without another provider call`,{timeout:30000},async t=>{
 const f=await setup(t),key=(provider==='apple'?'': 'android-')+randomUUID(),credential=provider==='apple'?f.signed:f.token;
 const unknown=await f.lookup(key);assert.equal(unknown.status,200);assert.deepEqual(await unknown.json(),{
  protocol:'lovelies-store-operation-receipt-v1',actor_id:f.owner.accountId,operation_key:key,status:'unknown'});
 const first=await f.purchase(provider,key);assert.equal(first.status,200);const recorded=await first.json();assert.equal(f.calls,1);
 const saved=await f.row(key),payload=JSON.parse(saved.payload_json);
 assert.deepEqual(payload,{credential_sha256:await digest(credential),operation_key:key,product_id:vars.APPLE_SUBSCRIPTION_PRODUCT_ID,protocol:'lovelies-store-operation-input-v1'});
 assert(!saved.payload_json.includes(credential));assert.equal(saved.payload_hash,await digest(stable({action:'store.'+provider,source:'store',payload})));
 const replay=await f.purchase(provider,key);assert.equal(replay.status,200);assert.deepEqual(await replay.json(),recorded);assert.equal(f.calls,1);
 const changed=await f.purchase(provider,key,credential+'-changed');assert.equal(changed.status,409);assert.equal(f.calls,1);
 const response=await f.lookup(key);assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/);
 const receipt=await response.json();assert.equal(receipt.actor_id,f.owner.accountId);assert.equal(receipt.operation_key,key);
 assert.equal(receipt.action,'store.'+provider);assert.equal(receipt.source,'store');assert.equal(receipt.status,'committed');
 assert.equal(receipt.input_scheme,'digest-v1');assert.equal(receipt.credential_sha256,await digest(credential));
 assert.equal(receipt.payload_hash,saved.payload_hash);assert.equal(receipt.receipt_scope,'historical');assert.deepEqual(receipt.result,recorded);
 assert(!JSON.stringify(receipt).includes(credential));
 await f.h.db.transaction(()=>f.h.db.run("UPDATE store_subscriptions SET active=0 WHERE account_id=?",f.owner.accountId));
 assert.equal((await f.h.json('/me/entitlements',{token:f.owner.token})).pro_active,false);
 const after=await f.lookup(key);assert.equal(after.status,200);assert.equal((await after.json()).result.active,true);
});

localTest('legacy raw-input operation replays exactly and its receipt never returns the signed input',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID(),body={product_id:vars.APPLE_SUBSCRIPTION_PRODUCT_ID,signed_transaction:f.signed,operation_key:key};
 const actor=await f.h.app.authenticate(new Request('https://api.invalid/me',{headers:{authorization:'Bearer '+f.owner.token}}));
 const intent=await prepareOperation('store.apple',body,'store'),value={active:true,provider:'apple_app_store',product_id:body.product_id,
  transaction_id:'synthetic-transaction',original_transaction_id:'synthetic-original',expires_at:new Date(Date.now()+60000).toISOString(),
  billing_environment:'production',financial_eligible:true,stale:false};
 await executeOperation(f.h.app,actor,intent,()=>value);
 const replay=await f.purchase('apple',key);assert.equal(replay.status,200);assert.deepEqual(await replay.json(),value);assert.equal(f.calls,0);
 const r=await f.lookup(key);assert.equal(r.status,200);const receipt=await r.json();assert.equal(receipt.input_scheme,'legacy-raw-v0');
 assert.equal(receipt.payload_hash,intent.hash);assert.equal(receipt.credential_sha256,await digest(f.signed));assert(!JSON.stringify(receipt).includes(f.signed));
});

localTest('corrupt and retired receipts fail closed without reflecting sensitive data',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID(),first=await f.purchase('apple',key);assert.equal(first.status,200);const value=await first.json();
 const update=async(sql,...args)=>f.h.db.transaction(()=>f.h.db.run(sql,...args));
 await update("UPDATE operations SET response_json=? WHERE actor_id=? AND source='store' AND operation_key=?",stable({...value,unexpected:f.signed}),f.owner.accountId,key);
 let r=await f.lookup(key);assert.equal(r.status,503);assert(!await r.text().then(text=>text.includes(f.signed)));
 await update("UPDATE operations SET response_json=?,payload_hash=? WHERE actor_id=? AND source='store' AND operation_key=?",stable(value),'0'.repeat(64),f.owner.accountId,key);
 r=await f.lookup(key);assert.equal(r.status,503);assert(!await r.text().then(text=>text.includes(f.signed)));
 await update("UPDATE operations SET payload_json='null',response_json=? WHERE actor_id=? AND source='store' AND operation_key=?",stable({protocol:'lovelies-operation-retired-v1',status:'retired'}),f.owner.accountId,key);
 r=await f.lookup(key);assert.equal(r.status,410);assert.equal((await r.json()).error.code,'operation_receipt_retired');
});

localTest('a retired operation cannot be replayed into a new provider call',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID();assert.equal((await f.purchase('apple',key)).status,200);assert.equal(f.calls,1);
 await f.h.db.transaction(()=>f.h.db.run("UPDATE operations SET payload_json='null',response_json=? WHERE actor_id=? AND source='store' AND operation_key=?",stable({protocol:'lovelies-operation-retired-v1',status:'retired'}),f.owner.accountId,key));
 const replay=await f.purchase('apple',key);assert.equal(replay.status,410);assert.equal(f.calls,1);
});

localTest('provider values containing the credential cannot be stored or replayed as a receipt',{timeout:30000},async t=>{
 const signed='synthetic-store-transaction.payload.signature',f=await setup(t,{transactionId:signed}),key=randomUUID();
 const response=await f.purchase('apple',key);assert.equal(response.status,503);assert(!JSON.stringify(await response.json()).includes(signed));
 assert.equal(await f.row(key),null);assert.equal((await f.h.db.one('SELECT COUNT(*) AS n FROM store_subscriptions WHERE account_id=?',f.owner.accountId)).n,0);
 const actor=await f.h.app.authenticate(new Request('https://api.invalid/me',{headers:{authorization:'Bearer '+f.owner.token}}));
 const body={product_id:vars.APPLE_SUBSCRIPTION_PRODUCT_ID,signed_transaction:signed,operation_key:randomUUID()};
 const intent=await prepareOperation('store.apple',body,'store');
 await executeOperation(f.h.app,actor,intent,()=>({active:true,provider:'apple_app_store',product_id:body.product_id,
  transaction_id:signed,original_transaction_id:'synthetic-original',expires_at:new Date(Date.now()+60000).toISOString(),
  billing_environment:'production',financial_eligible:true,stale:false}));
 const legacy=await f.purchase('apple',body.operation_key);assert.equal(legacy.status,503);assert(!JSON.stringify(await legacy.json()).includes(signed));
 const receipt=await f.lookup(body.operation_key);assert.equal(receipt.status,503);assert(!JSON.stringify(await receipt.json()).includes(signed));
});

localTest('a stale committed receipt describes newer stored state, not the submitted transaction',{timeout:30000},async t=>{
 const f=await setup(t),firstKey=randomUUID();assert.equal((await f.purchase('apple',firstKey)).status,200);
 await f.h.db.transaction(()=>f.h.db.run("UPDATE store_subscriptions SET observed_at=?,transaction_id=?,active=0 WHERE account_id=?",Date.now()+60000,'synthetic-newer-transaction',f.owner.accountId));
 const key=randomUUID(),response=await f.purchase('apple',key);assert.equal(response.status,200);const stale=await response.json();
 assert.equal(stale.stale,true);assert.equal(stale.active,false);assert.equal(stale.transaction_id,'synthetic-newer-transaction');
 const receipt=await f.lookup(key);assert.equal(receipt.status,200);assert.equal((await receipt.json()).result.transaction_id,'synthetic-newer-transaction');
});

localTest('store receipt accepts only an authenticated body-bound lookup',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID();
 assert.equal((await f.lookup(key,{method:'GET',body:undefined})).status,405);
 assert.equal((await f.h.request('/me/store-operations?key=not-allowed',{token:f.owner.token,body:{operation_key:key}})).status,400);
 assert.equal((await f.lookup(key,{body:{operation_key:key,extra:'synthetic'}})).status,400);
 assert.equal((await f.lookup('short')).status,400);
 assert.equal((await f.h.request('/me/store-operations',{body:{operation_key:key}})).status,401);
 assert.equal((await f.h.request('/me/store-operations/'+key,{token:f.owner.token})).status,404);
 const badKey=f.signed+'-key';const r=await f.purchase('apple',badKey);assert.equal(r.status,400);assert.equal((await r.json()).error.code,'store_credential_in_operation_key');assert.equal(f.calls,0);
});

localTest('session expiry after the receipt query suppresses the operation-specific result',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID(),first=await f.purchase('apple',key);assert.equal(first.status,200);
 const actor=await f.h.app.authenticate(new Request('https://api.invalid/me',{headers:{authorization:'Bearer '+f.owner.token}}));
 const originalNow=f.h.app.now,originalOne=f.h.db.one.bind(f.h.db);let expired=false,hits=0;
 f.h.app.now=()=>expired?actor.expiresAt+1000:originalNow();
 f.h.db.one=async(sql,...args)=>{const value=await originalOne(sql,...args);if(sql.startsWith('SELECT action,payload_hash,payload_json,response_json FROM operations')){hits++;expired=true;}return value;};
 t.after(()=>{f.h.app.now=originalNow;f.h.db.one=originalOne;});
 const r=await f.lookup(key);assert.equal(hits,1);assert.equal(r.status,401);assert.equal((await r.json()).error.code,'session_invalid');
});

localTest('session expiry while the receipt hash is calculated suppresses the result',{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID();assert.equal((await f.purchase('apple',key)).status,200);const row=await f.row(key);
 const target=stable({action:row.action,source:'store',payload:JSON.parse(row.payload_json)});
 const actor=await f.h.app.authenticate(new Request('https://api.invalid/me',{headers:{authorization:'Bearer '+f.owner.token}}));
 const originalNow=f.h.app.now,originalDigest=crypto.subtle.digest.bind(crypto.subtle),originalDescriptor=Object.getOwnPropertyDescriptor(crypto.subtle,'digest');let expired=false,hits=0;
 f.h.app.now=()=>expired?actor.expiresAt+1000:originalNow();
 crypto.subtle.digest=async(algorithm,data)=>{const value=await originalDigest(algorithm,data);if(new TextDecoder().decode(data)===target){hits++;expired=true;}return value;};
 t.after(()=>{f.h.app.now=originalNow;if(originalDescriptor)Object.defineProperty(crypto.subtle,'digest',originalDescriptor);else delete crypto.subtle.digest;});
 const r=await f.lookup(key);assert.equal(hits,1);assert.equal(r.status,401);assert.equal((await r.json()).error.code,'session_invalid');
});

localTest('known and unknown receipts use the read-only journal admission path',{timeout:30000},async t=>{
 const j=await journalFixture(t),h=j.h;h.env.FACE_AUTH_VERIFIER={fetch:async request=>{const form=await request.formData();return Response.json(await faceVerifierFixture(JSON.parse(String(form.get('envelope'))),form));}};
 Object.assign(h.env,vars);let account;h.env.STORE_VERIFIER={fetch:async(input,init)=>{const request=input instanceof Request?input:new Request(input,init),envelope=await request.json();return Response.json({...envelope,verified:true,payload:{bundleId:vars.APPLE_BUNDLE_ID,productId:vars.APPLE_SUBSCRIPTION_PRODUCT_ID,
  type:'Auto-Renewable Subscription',inAppOwnershipType:'PURCHASED',appAccountToken:account,environment:'Production',purchaseDate:Date.now()-1000,
  expiresDate:Date.now()+60000,signedDate:Date.now(),originalTransactionId:'synthetic-original',transactionId:'synthetic-transaction'}});}};
 const owner=await enroll(h);account=owner.accountId;const handler=createHandler(createApp(j.db,h.env,h.app.now));
 const request=(path,body)=>handler(new Request('https://api.invalid'+path,{method:'POST',headers:{authorization:'Bearer '+owner.token,'content-type':'application/json'},body:JSON.stringify(body)}));
 const key=randomUUID(),first=await request('/subscriptions/apple/transactions',{product_id:vars.APPLE_SUBSCRIPTION_PRODUCT_ID,signed_transaction:'synthetic.store.signature',operation_key:key});assert.equal(first.status,200);await first.body?.cancel();
 const markerSql='SELECT journal_sequence,journal_hash,last_operation_id,last_plan_hash FROM restore_control WHERE singleton=1',before=await h.db.one(markerSql);j.trace.length=0;
 const known=await request('/me/store-operations',{operation_key:key});assert.equal(known.status,200);assert.equal((await known.json()).status,'committed');
 const unknown=await request('/me/store-operations',{operation_key:randomUUID()});assert.equal(unknown.status,200);assert.equal((await unknown.json()).status,'unknown');
 assert(j.trace.some(x=>x.kind==='sql'&&x.sql==='SET TRANSACTION READ ONLY'));assert(j.trace.some(x=>x.kind==='journal'));
 assert(!j.trace.some(x=>x.kind==='journal'&&x.path==='/v1/operations/prepare'));
 assert(!j.trace.some(x=>x.kind==='sql'&&x.sql.startsWith('UPDATE restore_control SET')));assert.deepEqual(await h.db.one(markerSql),before);
});
