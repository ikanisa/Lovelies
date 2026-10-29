/** Same-subject, offline independent-journal tests. Never contact providers or an external database. */
import assert from 'node:assert/strict';
import {after,test as nodeTest} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createApp,createHandler} from '../src/index.ts';
import {restoreOperationID} from '../src/restore-transaction.ts';
import {stable} from '../src/types.ts';
import {fixture} from './restore-database-fixture.mjs';
import {enroll,faceVerifierFixture,sha256} from './runtime-harness.mjs';

// The full PostgreSQL lane skips these PGlite-only fixtures. Their dedicated
// CI step removes TEST_DATABASE_URL and installs the offline regression guard.
const test=process.env.TEST_DATABASE_URL === undefined ? nodeTest : nodeTest.skip;
const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw Error('external_fetch_prohibited');};
after(()=>{globalThis.fetch=originalFetch;});
const vars={APPLE_BUNDLE_ID:'com.lovelies.memories',APPLE_APP_ID:'987654321',
 APPLE_SUBSCRIPTION_PRODUCT_ID:'com.lovelies.memories.pro.monthly'};
const digest=async value=>sha256(new TextEncoder().encode(value));

async function setup(t){
 const f=await fixture(t),h=f.h,now=Date.now();let account,calls=0;
 const newer='synthetic-new.payload.signature',old='synthetic-old.payload.signature';
 const transactions=new Map([[newer,{id:'synthetic-newer',signedDate:now}],
  [old,{id:'synthetic-older',signedDate:now-60000}]]);
 h.env.FACE_AUTH_VERIFIER={fetch:async request=>{
  const form=await request.formData();return Response.json(await faceVerifierFixture(JSON.parse(String(form.get('envelope'))),form));
 }};
 Object.assign(h.env,vars);
 h.env.STORE_VERIFIER={fetch:async(input,init)=>{
  const request=input instanceof Request?input:new Request(input,init),envelope=await request.json();calls++;
  assert.equal(new URL(request.url).pathname,'/apple/transaction');assert.equal(envelope.protocol,'lovelies-store-verifier-v1');
  assert.equal(envelope.input_hash,await digest(stable(envelope.input)));
  const tx=transactions.get(envelope.input.signed_payload);assert(tx,'unexpected synthetic JWS');
  return Response.json({...envelope,verified:true,payload:{bundleId:vars.APPLE_BUNDLE_ID,
   productId:vars.APPLE_SUBSCRIPTION_PRODUCT_ID,type:'Auto-Renewable Subscription',inAppOwnershipType:'PURCHASED',
   appAccountToken:account,environment:'Production',purchaseDate:now-120000,expiresDate:now+86400000,
   signedDate:tx.signedDate,originalTransactionId:'synthetic-original',transactionId:tx.id}});
 }};
 // Exactly one subject is enrolled before guarded request handling.
 const owner=await enroll(h);account=owner.accountId;
 const handler=createHandler(createApp(f.db,h.env,h.app.now));
 const request=(path,body)=>handler(new Request('https://api.invalid'+path,{method:'POST',headers:{
  authorization:'Bearer '+owner.token,'content-type':'application/json'},body:JSON.stringify(body)}));
 const body=(key,signed)=>({operation_key:key,product_id:vars.APPLE_SUBSCRIPTION_PRODUCT_ID,signed_transaction:signed});
 const purchase=(key,signed)=>request('/subscriptions/apple/transactions',body(key,signed));
 const lookup=key=>request('/me/store-operations',{operation_key:key});
 const row=key=>h.db.one("SELECT action,payload_hash,payload_json,response_json FROM operations WHERE actor_id=? AND source='store' AND operation_key=?",account,key);
 const snapshot=async()=>({
  subscriptions:await h.db.all('SELECT transaction_id,original_id,billing_environment,product_id,active,version FROM store_subscriptions WHERE account_id=? ORDER BY id',account),
  transactions:await h.db.all('SELECT transaction_id,billing_environment,product_id FROM store_transactions WHERE account_id=? ORDER BY transaction_id',account),
  notifications:await h.db.all("SELECT kind,entity_id FROM notifications WHERE account_id=? AND kind='payment' ORDER BY entity_id",account),
 });
 const id=key=>restoreOperationID(account,'store',key);
 return {...f,owner,newer,old,request,body,purchase,lookup,row,snapshot,id,get calls(){return calls;}};
}

async function expectedInputHash(key,signed){
 const payload={protocol:'lovelies-store-operation-input-v1',operation_key:key,
  product_id:vars.APPLE_SUBSCRIPTION_PRODUCT_ID,credential_sha256:await digest(signed)};
 return {payload,hash:await digest(stable({action:'store.apple',source:'store',payload}))};
}
async function binding(signed,id){
 return {protocol:'lovelies-apple-submission-v2',product_id:vars.APPLE_SUBSCRIPTION_PRODUCT_ID,
  transaction_id:id,original_transaction_id:'synthetic-original',billing_environment:'production',credential_sha256:await digest(signed)};
}
async function plan(f,key,signed,status){
 const id=await f.id(key),record=await f.journal.lookup(id),expected=await expectedInputHash(key,signed);
 assert(record);if(status)assert.equal(record.status,status);
 assert.equal(record.plan.operation_id,id);assert.equal(record.plan.input_hash,expected.hash);
 assert.deepEqual(record.plan.allocations,{});assert.deepEqual(record.plan.events,[]);
 assert(!JSON.stringify(record.plan).includes(signed));
 return record;
}
function assertReadOnlyReceiptTrace(f){
 assert(f.trace.some(item=>item.kind==='sql'&&item.sql==='SET TRANSACTION READ ONLY'));
 assert(f.trace.some(item=>item.kind==='journal'));
 assert(!f.trace.some(item=>item.kind==='journal'&&item.path==='/v1/operations/prepare'));
 assert(!f.trace.some(item=>item.kind==='sql'&&item.sql.startsWith('UPDATE restore_control SET')));
}

test('fenced Apple v2 mutation and retry preserve the original logical plan and historical stale binding',{timeout:30000},async t=>{
 const f=await setup(t),firstKey=randomUUID(),staleKey=randomUUID();
 const requested=[],prepare=f.journal.prepare.bind(f.journal);
 f.journal.prepare=async value=>{requested.push(value.operation_id);return prepare(value);};
 let r=await f.purchase(firstKey,f.newer);assert.equal(r.status,200);const first=await r.json();
 assert.deepEqual(first.verified_submission,await binding(f.newer,'synthetic-newer'));assert.equal(first.stale,false);
 const firstPlan=await plan(f,firstKey,f.newer,'committed'),firstRow=await f.row(firstKey);
 assert.equal(firstRow.payload_hash,firstPlan.plan.input_hash);
 assert.deepEqual(JSON.parse(firstRow.payload_json),(await expectedInputHash(firstKey,f.newer)).payload);
 assert.deepEqual(JSON.parse(firstRow.response_json),first);
 assert(!firstRow.payload_json.includes(f.newer));assert(!firstRow.response_json.includes(f.newer));
 r=await f.purchase(staleKey,f.old);assert.equal(r.status,200);const stale=await r.json();
 assert.equal(stale.stale,true);assert.equal(stale.transaction_id,'synthetic-newer');
 assert.deepEqual(stale.verified_submission,await binding(f.old,'synthetic-older'));
 const stalePlan=await plan(f,staleKey,f.old,'committed'),staleRow=await f.row(staleKey);
 assert.equal(staleRow.payload_hash,stalePlan.plan.input_hash);
 assert.deepEqual(JSON.parse(staleRow.payload_json),(await expectedInputHash(staleKey,f.old)).payload);
 assert.deepEqual(JSON.parse(staleRow.response_json),stale);
 assert.equal(requested.filter(id=>id===firstPlan.plan.operation_id).length,1);
 assert.equal(requested.filter(id=>id===stalePlan.plan.operation_id).length,1);
 const snapshot=await f.snapshot();assert.equal(snapshot.subscriptions.length,1);assert.equal(snapshot.subscriptions[0].transaction_id,'synthetic-newer');
 f.trace.length=0;r=await f.lookup(staleKey);assert.equal(r.status,200);const known=await r.json();
 assertReadOnlyReceiptTrace(f);assert.equal(known.status,'committed');assert.deepEqual(known.result,stale);
 assert.equal(known.payload_hash,stalePlan.plan.input_hash);assert.equal(known.credential_sha256,await digest(f.old));
 f.trace.length=0;r=await f.lookup(randomUUID());assert.equal(r.status,200);assert.equal((await r.json()).status,'unknown');assertReadOnlyReceiptTrace(f);
 r=await f.purchase(staleKey,f.old);assert.equal(r.status,200);assert.deepEqual(await r.json(),stale);assert.equal(f.calls,2);
 assert.deepEqual(await f.snapshot(),snapshot);assert.deepEqual(await f.row(staleKey),staleRow);
 assert.deepEqual(await plan(f,staleKey,f.old,'committed'),stalePlan);
 // The existing replay helper may prepare a generic transaction; it must not
 // register or rerun the original domain operation.
 assert.equal(requested.filter(id=>id===stalePlan.plan.operation_id).length,1);
});

for(const mode of ['commit-reply','ack-before','ack-after']) test(`fenced Apple ${mode} loss reconciles the committed v2 receipt without reapplying it`,{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID(),operationID=await f.id(key),prepare=f.journal.prepare.bind(f.journal),requested=[];
 let armed=true;
 f.journal.prepare=async value=>{
  requested.push(value.operation_id);const saved=await prepare(value);
  if(mode==='commit-reply'&&armed&&value.operation_id===operationID){armed=false;f.faults.commitReply=true;}
  return saved;
 };
 if(mode!=='commit-reply')f.faults.reply={path:'/v1/operations/'+operationID+'/acknowledge',stage:mode==='ack-before'?'before':'after'};
 let r=await f.purchase(key,f.newer);assert(r.status>=500&&r.status<=599);await r.body?.cancel();
 const sql=await f.row(key);assert(sql,'the synthetic failure is after SQL COMMIT');
 const value=JSON.parse(sql.response_json),snapshot=await f.snapshot();
 assert.deepEqual(value.verified_submission,await binding(f.newer,'synthetic-newer'));assert.equal(value.transaction_id,'synthetic-newer');
 assert.equal(snapshot.subscriptions.length,1);assert.equal(snapshot.transactions.length,1);assert.equal(f.calls,1);
 const before=await plan(f,key,f.newer);assert(['pending','committed'].includes(before.status));
 // Receipt lookup can reconcile an exact pending COMMIT marker, but cannot
 // prepare a new mutation. The response is still the historical SQL receipt.
 f.trace.length=0;r=await f.lookup(key);assert.equal(r.status,200);const receipt=await r.json();assertReadOnlyReceiptTrace(f);
 assert.equal(receipt.status,'committed');assert.deepEqual(receipt.result,value);assert.equal(receipt.payload_hash,before.plan.input_hash);
 const reconciled=await plan(f,key,f.newer,'committed');assert.deepEqual(reconciled.plan,before.plan);
 r=await f.purchase(key,f.newer);assert.equal(r.status,200);assert.deepEqual(await r.json(),value);
 assert.deepEqual(await f.snapshot(),snapshot);assert.deepEqual(await f.row(key),sql);assert.equal(f.calls,1);
 assert.equal(requested.filter(id=>id===operationID).length,1);
});

for(const mode of ['prepare-reply','sql-before-commit']) test(`fenced Apple ${mode} loss leaves a pending independent plan and fences ordinary replay`,{timeout:30000},async t=>{
 const f=await setup(t),key=randomUUID(),operationID=await f.id(key),prepare=f.journal.prepare.bind(f.journal);let armed=true;
 f.journal.prepare=async value=>{
  if(armed&&value.operation_id===operationID&&mode==='prepare-reply'){
   armed=false;f.faults.reply={path:'/v1/operations/prepare',stage:'after'};
  }
  const saved=await prepare(value);
  if(armed&&value.operation_id===operationID&&mode==='sql-before-commit'){armed=false;f.faults.beforeCommit=true;}
  return saved;
 };
 let r=await f.purchase(key,f.newer);assert(r.status>=500&&r.status<=599);await r.body?.cancel();
 assert.equal(await f.row(key),null);const snapshot=await f.snapshot();assert.equal(snapshot.subscriptions.length,0);assert.equal(snapshot.transactions.length,0);
 const pending=await plan(f,key,f.newer,'pending');assert.equal(f.calls,1);
 r=await f.purchase(key,f.newer);assert(r.status>=500&&r.status<=599);await r.body?.cancel();
 assert.deepEqual(await plan(f,key,f.newer,'pending'),pending);assert.deepEqual(await f.snapshot(),snapshot);assert.equal(await f.row(key),null);
 assert.equal(f.calls,1,'pending independent plan must fence another provider dispatch');
});
