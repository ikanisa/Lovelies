import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { startHarness, enroll, faceVerifierFixture } from './runtime-harness.mjs';
import { createApp } from '../src/index.ts';
import { ApiError } from '../src/types.ts';
import { enqueueNotification, processNotificationJob } from '../src/notifications.ts';
import { pushReceipt, dispatchHash } from './notification-receipt-fixture.mjs';

const originalFetch=globalThis.fetch;
if(process.env.TEST_DATABASE_URL===undefined){
  globalThis.fetch=async()=>{throw Error('network_denied_by_fixture');};
  after(()=>{globalThis.fetch=originalFetch;});
}
const key=()=>crypto.randomUUID();
async function fixture(t){
  const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});t.after(()=>h.close());
  const actor=await enroll(h), devices=[];
  for(const [platform,token] of [['android','synthetic-android-token-'+key()],['ios','a'.repeat(64)]]){
    const device=await h.json('/me/push-devices',{token:actor.token,body:{platform,push_token:token,operation_key:key()}});
    devices.push(await h.db.one('SELECT * FROM push_devices WHERE id=?',device.id));
  }
  devices.sort((a,b)=>a.id.localeCompare(b.id));
  assert(devices.every(row=>row.active===1));
  const note=await h.db.transaction(()=>enqueueNotification(h.app,actor.accountId,'support',key(),'Your support request was reviewed'));
  const notification=await h.db.one('SELECT id,title,kind,entity_id FROM notifications WHERE id=?',note), plans=[];
  const seededAt=Date.now();
  for(const [index,device] of devices.entries()){
    const id=key(),operation='notification:'+note+':'+device.id;
    const input={operation_key:operation,platform:device.platform,token:device.token_value,notification};
    plans.push({id,operation,input});
    await h.db.run("INSERT INTO notification_deliveries(id,notification_id,device_id,operation_key,status,token_hash,request_sha256,platform,attempts,created_at,updated_at) VALUES(?,?,?,?,'ambiguous',?,?,?,1,?,?)",id,note,device.id,operation,device.token_hash,dispatchHash(input),device.platform,seededAt+index,seededAt+index);
  }
  await h.db.run("UPDATE notification_jobs SET status='ambiguous' WHERE notification_id=?",note);
  return {h,note,plans,process:ctx=>processNotificationJob({notification_id:note},ctx??h.app)};
}

for(const unknownIndex of [0,1])test(`active device${unknownIndex+1} remaining unknown cannot starve the other device's exact accepted lookup`,{timeout:30000},async t=>{
  const f=await fixture(t),calls=[];
  f.h.env.PUSH_SERVICE={fetch:async(url,init)=>{
    assert.equal(init?.method??'GET','GET');const operation=decodeURIComponent(new URL(url).pathname.slice('/operations/'.length));calls.push(operation);
    const index=f.plans.findIndex(plan=>plan.operation===operation);assert(index>=0);
    if(index===unknownIndex)return Response.json({protocol:'lovelies-push-dispatch-receipt-v1',operation_key:operation,request_sha256:null,status:'unknown'});
    return Response.json(pushReceipt(f.plans[index].input,{status:'accepted',provider_message_id:'synthetic-other-active-accepted'}));
  }};
  await assert.rejects(()=>f.process(),error=>error?.code==='push_reconciliation_required');
  assert.deepEqual(calls,f.plans.map(plan=>plan.operation));
  for(const [index,plan] of f.plans.entries())assert.deepEqual(await f.h.db.one('SELECT status,provider_receipt,lease_token FROM notification_deliveries WHERE id=?',plan.id),
    index===unknownIndex?{status:'ambiguous',provider_receipt:null,lease_token:null}:{status:'accepted',provider_receipt:'synthetic-other-active-accepted',lease_token:null});
  assert.equal((await f.h.db.one('SELECT status FROM notification_jobs WHERE notification_id=?',f.note)).status,'ambiguous');
});

test('an untyped external transport failure is scoped to its attempted device and cannot block another bound lookup',{timeout:30000},async t=>{
  const f=await fixture(t),calls=[];
  f.h.env.PUSH_SERVICE={fetch:async(url,init)=>{
    assert.equal(init?.method??'GET','GET');const operation=decodeURIComponent(new URL(url).pathname.slice('/operations/'.length));calls.push(operation);
    if(operation===f.plans[0].operation)throw 'synthetic transport loss';
    return Response.json(pushReceipt(f.plans[1].input,{status:'accepted',provider_message_id:'synthetic-after-transport-loss'}));
  }};
  await assert.rejects(()=>f.process(),error=>error instanceof ApiError&&error.status===503&&error.code==='push_provider_unavailable');
  assert.deepEqual(calls,f.plans.map(plan=>plan.operation));
  assert.deepEqual(await f.h.db.one('SELECT status,provider_receipt FROM notification_deliveries WHERE id=?',f.plans[0].id),{status:'ambiguous',provider_receipt:null});
  assert.deepEqual(await f.h.db.one('SELECT status,provider_receipt FROM notification_deliveries WHERE id=?',f.plans[1].id),{status:'accepted',provider_receipt:'synthetic-after-transport-loss'});
  assert.equal((await f.h.db.one('SELECT status FROM notification_jobs WHERE notification_id=?',f.note)).status,'ambiguous');
});

for(const kind of ['restore','unexpected_database'])test(`${kind} failure stops the active batch immediately instead of being treated as provider uncertainty`,{timeout:30000},async t=>{
  const f=await fixture(t),calls=[],fault=kind==='restore'?new ApiError(503,'restore_reconciliation_required'):new Error('synthetic database failure');
  f.h.env.PUSH_SERVICE={fetch:async(url,init)=>{
    assert.equal(init?.method??'GET','GET');const operation=decodeURIComponent(new URL(url).pathname.slice('/operations/'.length));calls.push(operation);
    const plan=f.plans.find(row=>row.operation===operation);assert(plan);
    return Response.json(pushReceipt(plan.input,{status:'accepted',provider_message_id:'synthetic-receipt-before-database-failure'}));
  }};
  const db=new Proxy(f.h.db,{get(target,name){
    if(name==='run')return async(sql,...values)=>{
      if(sql.startsWith("UPDATE notification_deliveries SET status='accepted'"))throw fault;
      return target.run(sql,...values);
    };
    const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;
  }});
  await assert.rejects(()=>f.process(createApp(db,f.h.env)),error=>error===fault);
  assert.deepEqual(calls,[f.plans[0].operation]);
  assert.deepEqual(await f.h.db.one('SELECT status,provider_receipt FROM notification_deliveries WHERE id=?',f.plans[1].id),{status:'ambiguous',provider_receipt:null});
  assert.equal((await f.h.db.one('SELECT status FROM notification_jobs WHERE notification_id=?',f.note)).status,'ambiguous');
});
