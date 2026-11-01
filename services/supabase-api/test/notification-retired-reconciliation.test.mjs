import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { startHarness, enroll, faceVerifierFixture } from './runtime-harness.mjs';
import { createApp } from '../src/index.ts';
import { enqueueNotification, processNotificationJob } from '../src/notifications.ts';
import { pushReceipt, dispatchHash } from './notification-receipt-fixture.mjs';

const originalFetch = globalThis.fetch;
if (process.env.TEST_DATABASE_URL === undefined) {
  globalThis.fetch = async () => { throw Error('network_denied_by_fixture'); };
  after(() => { globalThis.fetch = originalFetch; });
}
const key=()=>crypto.randomUUID(), unconfirmed=error=>error?.code==='push_reconciliation_required';
async function fixture(t) {
  const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});t.after(()=>h.close());
  const actor=await enroll(h),token='synthetic-token-'+key();
  const device=await h.json('/me/push-devices',{token:actor.token,body:{platform:'android',push_token:token,operation_key:key()}});
  const note=await h.db.transaction(()=>enqueueNotification(h.app,actor.accountId,'support',key(),'Your support request was reviewed'));
  return {h,actor,device,token,note,process:()=>processNotificationJob({notification_id:note},h.app)};
}

for(const revoked of ['opt_out','device_removed','account_switch'])test('bound historical acceptance is recovered with GET only after '+revoked,{timeout:30000},async t=>{
  const f=await fixture(t),calls=[];let input;
  f.h.env.PUSH_SERVICE={fetch:async(_url,init)=>{
    calls.push(init?.method??'GET');
    if(init?.method==='POST'){input=JSON.parse(init.body);return Response.json(pushReceipt(input,{status:'ambiguous'}));}
    return Response.json(pushReceipt(input,{status:'accepted',provider_message_id:'synthetic-retired-acceptance'}));
  }};
  await assert.rejects(f.process,unconfirmed);
  if(revoked==='opt_out')await f.h.db.run('INSERT INTO notification_settings(account_id,support_alerts,updated_at) VALUES(?,0,?)',f.actor.accountId,Date.now());
  else {
    await f.h.json('/me/push-devices/'+f.device.id,{token:f.actor.token,method:'DELETE',body:{operation_key:key()}});
    if(revoked==='account_switch'){
      const next=await enroll(f.h);
      await f.h.json('/me/push-devices',{token:next.token,body:{platform:'android',push_token:f.token,operation_key:key()}});
    }
  }
  // The legacy adapter settles this exact immutable historical receipt.
  // Production roster-v2 separately requires its independent complete plan.
  await f.process();await f.process();
  assert.deepEqual(calls,['POST','GET']);
  assert.deepEqual(await f.h.db.one('SELECT status,provider_receipt,request_sha256 FROM notification_deliveries WHERE notification_id=?',f.note),
    {status:'accepted',provider_receipt:'synthetic-retired-acceptance',request_sha256:dispatchHash(input)});
  assert.notEqual((await f.h.db.one('SELECT status FROM notification_jobs WHERE notification_id=?',f.note)).status,'cancelled');
});

test('a mismatched historical receipt cannot be accepted after token retirement',{timeout:30000},async t=>{
  const f=await fixture(t),calls=[];let input;
  f.h.env.PUSH_SERVICE={fetch:async(_url,init)=>{
    calls.push(init?.method??'GET');
    if(init?.method==='POST'){input=JSON.parse(init.body);return Response.json(pushReceipt(input,{status:'ambiguous'}));}
    return Response.json(pushReceipt({...input,token:'substituted-token-which-was-not-dispatched'},{status:'accepted',provider_message_id:'must-not-persist'}));
  }};
  await assert.rejects(f.process,unconfirmed);
  await f.h.json('/me/push-devices/'+f.device.id,{token:f.actor.token,method:'DELETE',body:{operation_key:key()}});
  await assert.rejects(f.process,error=>error?.code==='push_receipt_unbound');
  assert.deepEqual(calls,['POST','GET']);
  assert.deepEqual(await f.h.db.one('SELECT status,provider_receipt FROM notification_deliveries WHERE notification_id=?',f.note),{status:'ambiguous',provider_receipt:null});
});

test('retired delivery reconciliation advances past25 unknown outcomes with a bounded fair scan',{timeout:30000},async t=>{
  const h=await startHarness({consumeQueue:false});t.after(()=>h.close());
  const now=1700000000000,account=key(),auth=key(),note=key(),plans=new Map(),ctx=createApp(h.db,h.env,()=>now);
  await h.db.run("INSERT INTO accounts(id,name,created_at,identity_state) VALUES(?,'Synthetic subject',?,'registered_face')",account,now);
  await h.db.run("INSERT INTO auth_devices(id,account_id,public_jwk,revision,status,created_at) VALUES(?,?,'{}','r1','active',?)",auth,account,now);
  await h.db.run('INSERT INTO notification_settings(account_id,support_alerts,updated_at) VALUES(?,0,?)',account,now);
  await h.db.run("INSERT INTO notifications(id,account_id,kind,entity_id,title,created_at) VALUES(?,?,'support',?,'Your support request was reviewed',?)",note,account,key(),now);
  await h.db.run("INSERT INTO notification_jobs(notification_id,account_id,auth_epoch,status,created_at) VALUES(?,?,1,'ambiguous',?)",note,account,now);
  let target;
  for(let i=0;i<26;i++){
    const device=key(),id=key(),operation='notification:'+note+':'+device,input={operation_key:operation,platform:'android',token:'synthetic-token-'+device,notification:{id:note,title:'Your support request was reviewed',kind:'support',entity_id:key()}};
    plans.set(operation,input);if(i===25)target={id,operation};
    await h.db.run("INSERT INTO push_devices(id,account_id,auth_device_id,platform,token_hash,token_value,active,created_at,updated_at) VALUES(?,?,?,'android',?,'',0,?,?)",device,account,auth,device.replaceAll('-','').repeat(2),now,now);
    await h.db.run("INSERT INTO notification_deliveries(id,notification_id,device_id,operation_key,status,token_hash,request_sha256,platform,attempts,created_at,updated_at) VALUES(?,?,?,?,'ambiguous',?,?,'android',1,?,?)",id,note,device,operation,device.replaceAll('-','').repeat(2),dispatchHash(input),now-100,now-100+i);
  }
  const calls=[];
  h.env.PUSH_SERVICE={fetch:async(url,init)=>{
    assert.notEqual(init?.method,'POST');const operation=decodeURIComponent(new URL(url).pathname.slice('/operations/'.length));calls.push(operation);
    return Response.json(pushReceipt(plans.get(operation),operation===target.operation?{status:'accepted',provider_message_id:'synthetic-later-acceptance'}:{status:'ambiguous'}));
  }};
  await assert.rejects(()=>processNotificationJob({notification_id:note},ctx),unconfirmed);assert.equal(calls.length,25);assert(!calls.includes(target.operation));
  await assert.rejects(()=>processNotificationJob({notification_id:note},ctx),unconfirmed);
  assert.equal(calls[25],target.operation);
  assert.equal((await h.db.one('SELECT status FROM notification_deliveries WHERE id=?',target.id)).status,'accepted');
});

for (const unresolved of ['active', 'retired']) test(`an unresolved ${unresolved} attempt cannot starve the other device group's bound receipt`, {timeout:30000}, async t => {
  const f=await fixture(t), nextToken='synthetic-next-token-'+key();
  // Registering a replacement on the same platform retires the first device.
  // Both deliveries below represent already attempted immutable operations.
  const next=await f.h.json('/me/push-devices',{token:f.actor.token,body:{platform:'android',push_token:nextToken,operation_key:key()}});
  assert.equal((await f.h.db.one('SELECT active FROM push_devices WHERE id=?',f.device.id)).active,0);
  const note=await f.h.db.one('SELECT id,title,kind,entity_id FROM notifications WHERE id=?',f.note), plans=new Map(), deliveries={};
  const seededAt=Date.now();
  for(const [index,[group,device,token]] of [['retired',f.device.id,f.token],['active',next.id,nextToken]].entries()){
    const id=key(),operation='notification:'+f.note+':'+device;
    const input={operation_key:operation,platform:'android',token,notification:note};
    const push=await f.h.db.one('SELECT token_hash FROM push_devices WHERE id=?',device);
    plans.set(operation,{group,input});deliveries[group]={id,operation};
    await f.h.db.run("INSERT INTO notification_deliveries(id,notification_id,device_id,operation_key,status,token_hash,request_sha256,platform,attempts,created_at,updated_at) VALUES(?,?,?,?,'ambiguous',?,?,'android',1,?,?)",id,f.note,device,operation,push.token_hash,dispatchHash(input),seededAt+index,seededAt+index);
  }
  await f.h.db.run("UPDATE notification_jobs SET status='ambiguous' WHERE notification_id=?",f.note);
  const calls=[];
  f.h.env.PUSH_SERVICE={fetch:async(url,init)=>{
    assert.equal(init?.method??'GET','GET','historical reconciliation must never POST');
    const operation=decodeURIComponent(new URL(url).pathname.slice('/operations/'.length)),plan=plans.get(operation);
    assert(plan);calls.push(plan.group);
    return Response.json(pushReceipt(plan.input,plan.group===unresolved?{status:'ambiguous'}:{status:'accepted',provider_message_id:'synthetic-'+plan.group+'-accepted'}));
  }};
  await assert.rejects(f.process,unconfirmed);
  assert.deepEqual(calls,['retired','active']);
  const resolved=unresolved==='active'?'retired':'active';
  assert.deepEqual(await f.h.db.one('SELECT status,provider_receipt FROM notification_deliveries WHERE id=?',deliveries[resolved].id),
    {status:'accepted',provider_receipt:'synthetic-'+resolved+'-accepted'});
  assert.deepEqual(await f.h.db.one('SELECT status,provider_receipt FROM notification_deliveries WHERE id=?',deliveries[unresolved].id),
    {status:'ambiguous',provider_receipt:null});
  assert.equal((await f.h.db.one('SELECT status FROM notification_jobs WHERE notification_id=?',f.note)).status,'ambiguous');
});
