import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { startHarness, enroll, faceVerifierFixture } from './runtime-harness.mjs';
import { enqueueNotification, processNotificationJob } from '../src/notifications.ts';
import { pushReceipt, dispatchHash } from './notification-receipt-fixture.mjs';

const originalFetch = globalThis.fetch;
if (process.env.TEST_DATABASE_URL === undefined) {
  globalThis.fetch = async () => { throw Error('network_denied_by_fixture'); };
  after(() => { globalThis.fetch = originalFetch; });
}
const key = () => crypto.randomUUID();
async function fixture(t) {
  const h = await startHarness({ faceVerifier:faceVerifierFixture, consumeQueue:false }); t.after(() => h.close());
  const actor = await enroll(h), token = 'synthetic-token-' + key();
  const device = await h.json('/me/push-devices',{token:actor.token,body:{platform:'android',push_token:token,operation_key:key()}});
  const note = () => h.db.transaction(() => enqueueNotification(h.app,actor.accountId,'support',key(),'Your support request was reviewed'));
  return {h,actor,device,token,note,process:id=>processNotificationJob({notification_id:id},h.app)};
}

test('first send persists exact gateway request digest and acceptance needs the same versioned binding', {timeout:30000}, async t => {
  const f=await fixture(t), id=await f.note(); let input, sends=0;
  f.h.env.PUSH_SERVICE={fetch:async(_url,init)=>{
    sends++; input=JSON.parse(init.body);
    const before=await f.h.db.one('SELECT status,request_sha256 FROM notification_deliveries WHERE notification_id=?',id);
    assert.equal(before.status,'dispatching'); assert.equal(before.request_sha256,dispatchHash(input));
    return Response.json(pushReceipt(input,{status:'accepted',provider_message_id:'synthetic-provider-accepted'}));
  }};
  await f.process(id); await f.process(id); assert.equal(sends,1);
  const row=await f.h.db.one('SELECT status,request_sha256,provider_receipt FROM notification_deliveries WHERE notification_id=?',id);
  assert.deepEqual(row,{status:'accepted',request_sha256:dispatchHash(input),provider_receipt:'synthetic-provider-accepted'});
  assert.notEqual(dispatchHash({...input,token:input.token+'x'}),row.request_sha256);
  assert.notEqual(dispatchHash({...input,notification:{...input.notification,entity_id:key()}}),row.request_sha256);
});

test('missing, legacy, changed-token, changed-payload and mismatched-operation acceptance never becomes a local receipt', {timeout:30000}, async t => {
  const f=await fixture(t), mutations=[
    value=>{delete value.protocol;}, value=>{value.protocol='legacy';}, value=>{delete value.request_sha256;},
    value=>{value.request_sha256='f'.repeat(64);}, value=>{value.operation_key='notification:'+key()+':'+key();},
  ];
  for(const mutate of mutations){
    const id=await f.note(); let sends=0;
    f.h.env.PUSH_SERVICE={fetch:async(_url,init)=>{sends++;const input=JSON.parse(init.body),value=pushReceipt(input,{status:'accepted',provider_message_id:'must-not-persist'});mutate(value);return Response.json(value);}};
    await assert.rejects(()=>f.process(id),error=>error?.code==='push_receipt_unbound');
    assert.deepEqual(await f.h.db.one('SELECT status,provider_receipt FROM notification_deliveries WHERE notification_id=?',id),{status:'ambiguous',provider_receipt:null});
    assert.equal(sends,1);
  }
});

test('bound lookup recovers a lost accepted reply without a duplicate send', {timeout:30000}, async t => {
  const f=await fixture(t),id=await f.note(),calls=[];let input;
  f.h.env.PUSH_SERVICE={fetch:async(_url,init)=>{
    calls.push(init?.method??'GET');
    if(init?.method==='POST'){input=JSON.parse(init.body);throw Error('synthetic lost reply');}
    return Response.json(pushReceipt(input,{status:'accepted',provider_message_id:'synthetic-recovered-acceptance'}));
  }};
  await assert.rejects(()=>f.process(id),error=>error?.code==='push_provider_unavailable'); await f.process(id); await f.process(id);
  assert.deepEqual(calls,['POST','GET']);
  assert.deepEqual(await f.h.db.one('SELECT status,provider_receipt FROM notification_deliveries WHERE notification_id=?',id),{status:'accepted',provider_receipt:'synthetic-recovered-acceptance'});
});

test('a genuine not-dispatched receipt cannot authorize changed local notification content or token bytes', {timeout:30000}, async t => {
  const f=await fixture(t);
  for(const change of ['notification','token']){
    const id=await f.note(),calls=[];let input;
    f.h.env.PUSH_SERVICE={fetch:async(_url,init)=>{
      calls.push(init?.method??'GET'); if(init?.method==='POST')input=JSON.parse(init.body);
      return Response.json(pushReceipt(input,{status:'not_dispatched'}),{status:503});
    }};
    await assert.rejects(()=>f.process(id),error=>error?.code==='push_reconciliation_required');
    if(change==='notification')await f.h.db.run("UPDATE notifications SET title='Changed synthetic title' WHERE id=?",id);
    else await f.h.db.run('UPDATE push_devices SET token_value=? WHERE id=?',f.token+'changed',f.device.id);
    await assert.rejects(()=>f.process(id),error=>error?.code==='push_dispatch_binding_changed');
    assert.deepEqual(calls,['POST','GET']);
    assert.equal((await f.h.db.one('SELECT request_sha256 FROM notification_deliveries WHERE notification_id=?',id)).request_sha256,dispatchHash(input));
  }
});

test('legacy attempted deliveries without an immutable binding fail closed; a pristine legacy row binds before first send', {timeout:30000}, async t => {
  const f=await fixture(t),bound=await f.note();let input,sends=0;
  f.h.env.PUSH_SERVICE={fetch:async(_url,init)=>{sends++;input=JSON.parse(init.body);return Response.json(pushReceipt(input,{status:'ambiguous'}));}};
  await assert.rejects(()=>f.process(bound),error=>error?.code==='push_reconciliation_required');
  await assert.rejects(()=>f.h.db.run('UPDATE notification_deliveries SET request_sha256=NULL WHERE notification_id=?',bound),/notification_delivery_binding_immutable/);
  // Seed a genuinely legacy attempted row; never weaken the immutable trigger
  // to erase the binding from an operation produced by the current protocol.
  const old=await f.note(),legacyDevice=await f.h.db.one('SELECT token_hash FROM push_devices WHERE id=?',f.device.id);
  await f.h.db.run("INSERT INTO notification_deliveries(id,notification_id,device_id,operation_key,status,token_hash,attempts,created_at,updated_at) VALUES(?,?,?,?,'ambiguous',?,1,?,?)",key(),old,f.device.id,'notification:'+old+':'+f.device.id,legacyDevice.token_hash,Date.now(),Date.now());
  await assert.rejects(()=>f.process(old),error=>error?.code==='push_delivery_binding_unavailable'); assert.equal(sends,1);
  const fresh=await f.note(),device=await f.h.db.one('SELECT token_hash FROM push_devices WHERE id=?',f.device.id);
  await f.h.db.run("INSERT INTO notification_deliveries(id,notification_id,device_id,operation_key,status,token_hash,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?,?)",key(),fresh,f.device.id,'notification:'+fresh+':'+f.device.id,device.token_hash,Date.now(),Date.now());
  f.h.env.PUSH_SERVICE={fetch:async(_url,init)=>{sends++;input=JSON.parse(init.body);return Response.json(pushReceipt(input,{status:'accepted',provider_message_id:'synthetic-first-send'}));}};
  await f.process(fresh); assert.equal(sends,2);
  assert.equal((await f.h.db.one('SELECT request_sha256 FROM notification_deliveries WHERE notification_id=?',fresh)).request_sha256,dispatchHash(input));
});

test('a missing independent operation remains unknown and never grants resend permission', {timeout:30000}, async t => {
  const f=await fixture(t),id=await f.note(),calls=[];let input;
  f.h.env.PUSH_SERVICE={fetch:async(_url,init)=>{
    calls.push(init?.method??'GET');
    if(init?.method==='POST'){input=JSON.parse(init.body);return Response.json(pushReceipt(input,{status:'ambiguous'}));}
    return Response.json({protocol:'lovelies-push-dispatch-receipt-v1',operation_key:input.operation_key,request_sha256:null,status:'unknown'});
  }};
  await assert.rejects(()=>f.process(id),error=>error?.code==='push_reconciliation_required');
  await assert.rejects(()=>f.process(id),error=>error?.code==='push_reconciliation_required');
  assert.deepEqual(calls,['POST','GET']);
});
