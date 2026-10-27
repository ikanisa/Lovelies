/** Synthetic same-account in-process handlers only; never contacts a provider. */
import assert from 'node:assert/strict';import {test} from 'node:test';import {randomUUID} from 'node:crypto';
import {startHarness,enroll,faceVerifierFixture} from './runtime-harness.mjs';
import {fixture as journalFixture,unavailable} from './restore-database-fixture.mjs';
import {createApp,createHandler} from '../src/index.ts';import {createApp as legacyApp,createHandler as legacyHandler} from './fixtures/push-receipt/index-legacy.ts';
import {prepareOperation,retiredOperationInput,retiredOperationResponse} from '../src/operations.ts';import {restoreOperationID} from '../src/restore-transaction.ts';import {digest} from '../src/types.ts';
const localTest=process.env.TEST_DATABASE_URL===undefined?test:test.skip;
if(process.env.TEST_DATABASE_URL===undefined)globalThis.fetch=async()=>{throw Error('external_fetch_prohibited');};
const key=label=>label+'-'+randomUUID(),value=()=>key('synthetic-registration-token');
const request=(handler,owner,body)=>handler(new Request('https://api.invalid/me/push-devices',{method:'POST',headers:{authorization:'Bearer '+owner.token,'content-type':'application/json'},body:JSON.stringify(body)}));
async function setup(t,{journal=false}={}){
 let h,db,j;
 if(journal){j=await journalFixture(t);h=j.h;db=j.db;h.env.FACE_AUTH_VERIFIER={fetch:async request=>{const form=await request.formData();return Response.json(await faceVerifierFixture(JSON.parse(String(form.get('envelope'))),form));}};}
 else{h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});t.after(()=>h.close());db=h.db;}
 const owner=await enroll(h);assert.equal(h.env.PUSH_SERVICE,undefined);
 const current=createHandler(createApp(db,h.env,h.app.now)),legacy=legacyHandler(legacyApp(db,h.env,h.app.now));
 const body=(v=value(),k=key('registration'))=>({platform:'ios',push_token:v,operation_key:k});
 const row=async b=>h.db.one("SELECT action,payload_hash,payload_json,response_json FROM operations WHERE actor_id=? AND source='notification' AND operation_key=?",owner.accountId,b.operation_key);
 return {h,db,j,owner,current,legacy,body,row,send:(which,b)=>request(which,owner,b)};
}
localTest('new registration stores a versioned token digest and exactly retries',{timeout:30000},async t=>{
 const f=await setup(t),body=f.body(),response=await f.send(f.current,body);assert.equal(response.status,200);const first=await response.json(),row=await f.row(body);
 assert(row);assert.equal(row.payload_json.includes(body.push_token),false);const payload=JSON.parse(row.payload_json);
 assert.deepEqual(payload,{operation_key:body.operation_key,platform:'ios',protocol:'lovelies-push-registration-receipt-v1',push_token_sha256:await digest(body.push_token)});
 const safe=await prepareOperation('notification./me/push-devices.POST',payload,'notification');assert.equal(row.payload_hash,safe.hash);
 const before=await f.h.db.all('SELECT id,active,token_hash,updated_at FROM push_devices WHERE account_id=? ORDER BY id',f.owner.accountId);
 const retry=await f.send(f.current,body);assert.equal(retry.status,200);assert.deepEqual(await retry.json(),first);assert.deepEqual(await f.h.db.all('SELECT id,active,token_hash,updated_at FROM push_devices WHERE account_id=? ORDER BY id',f.owner.accountId),before);
});
localTest('same operation key and a different token conflict without a new row',{timeout:30000},async t=>{
 const f=await setup(t),body=f.body(),first=await f.send(f.current,body);assert.equal(first.status,200);const before=await f.h.db.all('SELECT id,active,token_hash FROM push_devices WHERE account_id=? ORDER BY id',f.owner.accountId);
 const wrong=await f.send(f.current,{...body,push_token:value()});assert.equal(wrong.status,409);assert.equal((await wrong.json()).error.code,'operation_key_conflict');assert.deepEqual(await f.h.db.all('SELECT id,active,token_hash FROM push_devices WHERE account_id=? ORDER BY id',f.owner.accountId),before);
});
localTest('existing legacy SQL receipt replays without mutation or hash conversion',{timeout:30000},async t=>{
 const f=await setup(t),body=f.body(),first=await f.send(f.legacy,body);assert.equal(first.status,200);const result=await first.json(),before=await f.row(body);
 assert.equal(before.payload_json.includes(body.push_token),true);const retry=await f.send(f.current,body);assert.equal(retry.status,200);assert.deepEqual(await retry.json(),result);assert.deepEqual(await f.row(body),before);
});
localTest('existing retired legacy receipt keeps its 410 outcome',{timeout:30000},async t=>{
 const f=await setup(t),body=f.body(),first=await f.send(f.legacy,body);assert.equal(first.status,200);await first.body?.cancel();
 await f.h.db.run("UPDATE operations SET payload_json=?,response_json=? WHERE actor_id=? AND source='notification' AND operation_key=?",retiredOperationInput,retiredOperationResponse,f.owner.accountId,body.operation_key);
 const before=await f.row(body),retry=await f.send(f.current,body);assert.equal(retry.status,410);assert.equal((await retry.json()).error.code,'operation_receipt_retired');assert.deepEqual(await f.row(body),before);
});
localTest('new operation keys cannot themselves retain the token while old exact receipts still replay',{timeout:30000},async t=>{
 const f=await setup(t),oldToken=value(),old=f.body(oldToken,oldToken),first=await f.send(f.legacy,old);assert.equal(first.status,200);const result=await first.json();
 const retry=await f.send(f.current,old);assert.equal(retry.status,200);assert.deepEqual(await retry.json(),result);
 const freshToken=value(),fresh=f.body(freshToken,'prefix-'+freshToken),denied=await f.send(f.current,fresh);assert.equal(denied.status,400);assert.equal((await denied.json()).error.code,'push_token_in_operation_key');assert.equal(await f.row(fresh),null);
});
localTest('other notification operation payloads preserve their normal receipt format',{timeout:30000},async t=>{
 const f=await setup(t),operation=key('settings'),body={support_alerts:false,operation_key:operation};
 const response=await f.current(new Request('https://api.invalid/me/notification-settings',{method:'PATCH',headers:{authorization:'Bearer '+f.owner.token,'content-type':'application/json'},body:JSON.stringify(body)}));assert.equal(response.status,200);
 const row=await f.h.db.one("SELECT payload_json FROM operations WHERE actor_id=? AND source='notification' AND operation_key=?",f.owner.accountId,operation);assert.deepEqual(JSON.parse(row.payload_json),body);
});
localTest('an old server cannot replay a new-format receipt but does not register twice',{timeout:30000},async t=>{
 const f=await setup(t),body=f.body(),first=await f.send(f.current,body);assert.equal(first.status,200);await first.body?.cancel();
 const before=await f.row(body),retry=await f.send(f.legacy,body);assert.equal(retry.status,409);assert.equal((await retry.json()).error.code,'operation_key_conflict');
 assert.deepEqual(await f.row(body),before);assert.equal((await f.h.db.one('SELECT count(*) n FROM push_devices WHERE account_id=?',f.owner.accountId)).n,1);
});
localTest('lost legacy prepare remains fenced and retains its original journal input hash',{timeout:30000},async t=>{
 const f=await setup(t,{journal:true}),body=f.body(),operation=await restoreOperationID(f.owner.accountId,'notification',body.operation_key),legacy=await prepareOperation('notification./me/push-devices.POST',body,'notification');
 const prepare=f.j.journal.prepare.bind(f.j.journal);let armed=true;f.j.journal.prepare=async input=>{if(armed&&input.operation_id===operation){armed=false;f.j.faults.reply={path:'/v1/operations/prepare',stage:'after'};}return prepare(input);};
 const first=await f.send(f.legacy,body);assert(first.status>=500);await first.body?.cancel();const pending=await f.j.journal.lookup(operation);assert.equal(pending.status,'pending');assert.equal(pending.plan.input_hash,legacy.hash);assert.equal(await f.row(body),null);
 await assert.rejects(()=>f.db.one('SELECT id FROM accounts LIMIT 1'),unavailable);const retry=await f.send(f.current,body);assert(retry.status>=500);await retry.body?.cancel();assert.deepEqual(await f.j.journal.lookup(operation),pending);
});
localTest('lost new prepare stays fenced without persisting a raw token',{timeout:30000},async t=>{
 const f=await setup(t,{journal:true}),body=f.body(),operation=await restoreOperationID(f.owner.accountId,'notification',body.operation_key),prepare=f.j.journal.prepare.bind(f.j.journal);let armed=true;
 f.j.journal.prepare=async input=>{if(armed&&input.operation_id===operation){armed=false;f.j.faults.reply={path:'/v1/operations/prepare',stage:'after'};}return prepare(input);};
 const first=await f.send(f.current,body);assert(first.status>=500);await first.body?.cancel();const pending=await f.j.journal.lookup(operation);assert.equal(pending.status,'pending');assert.equal(await f.row(body),null);
 const payload={protocol:'lovelies-push-registration-receipt-v1',operation_key:body.operation_key,platform:body.platform,push_token_sha256:await digest(body.push_token)},safe=await prepareOperation('notification./me/push-devices.POST',payload,'notification');assert.equal(pending.plan.input_hash,safe.hash);
 const retry=await f.send(f.current,body);assert(retry.status>=500);await retry.body?.cancel();assert.deepEqual(await f.j.journal.lookup(operation),pending);
});
localTest('lost legacy commit reconciles before replaying the original legacy receipt',{timeout:30000},async t=>{
 const f=await setup(t,{journal:true}),body=f.body(),operation=await restoreOperationID(f.owner.accountId,'notification',body.operation_key),raw=await prepareOperation('notification./me/push-devices.POST',body,'notification'),prepare=f.j.journal.prepare.bind(f.j.journal);let armed=true;
 f.j.journal.prepare=async input=>{const result=await prepare(input);if(armed&&input.operation_id===operation){armed=false;f.j.faults.commitReply=true;}return result;};
 const first=await f.send(f.legacy,body);assert(first.status>=500);await first.body?.cancel();const pending=await f.j.journal.lookup(operation);assert(pending);assert.equal(pending.plan.input_hash,raw.hash);
 const retry=await f.send(f.current,body);assert.equal(retry.status,200);const saved=await f.j.journal.lookup(operation),row=await f.row(body);
 assert.equal(saved.status,'committed');assert.deepEqual(saved.plan,pending.plan);assert.equal(row.payload_hash,raw.hash);assert.equal(row.payload_json,raw.payloadJson);assert.equal((await f.h.db.one('SELECT count(*) n FROM push_devices WHERE account_id=?',f.owner.accountId)).n,1);
});
localTest('lost new commit reconciles the same safe journal plan without a second registration',{timeout:30000},async t=>{
 const f=await setup(t,{journal:true}),body=f.body(),operation=await restoreOperationID(f.owner.accountId,'notification',body.operation_key),prepare=f.j.journal.prepare.bind(f.j.journal);let armed=true;
 f.j.journal.prepare=async input=>{const result=await prepare(input);if(armed&&input.operation_id===operation){armed=false;f.j.faults.commitReply=true;}return result;};
 const first=await f.send(f.current,body);assert(first.status>=500);await first.body?.cancel();const plan=await f.j.journal.lookup(operation);assert(plan);const retry=await f.send(f.current,body);assert.equal(retry.status,200);
 const saved=await f.j.journal.lookup(operation),row=await f.row(body);assert.equal(saved.status,'committed');assert.deepEqual(saved.plan,plan.plan);assert.equal(row.payload_json.includes(body.push_token),false);
 const parsed=JSON.parse(row.payload_json),safe=await prepareOperation('notification./me/push-devices.POST',parsed,'notification');assert.equal(saved.plan.input_hash,safe.hash);assert.equal((await f.h.db.one('SELECT count(*) n FROM push_devices WHERE account_id=?',f.owner.accountId)).n,1);
});
