import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {startHarness,closeHarnesses,enroll,faceVerifierFixture} from './runtime-harness.mjs';
import {enqueueNotification,processNotificationJob} from '../src/notifications.ts';
after(closeHarnesses);
const key=()=>crypto.randomUUID();
async function fixture(provider){
 const h=await startHarness({faceVerifier:faceVerifierFixture,pushService:provider,consumeQueue:false}),owner=await enroll(h);
 const device=await h.json('/me/push-devices',{token:owner.token,body:{platform:'ios',push_token:'synthetic-token-'+key(),operation_key:key()}});
 const notification=await h.db.transaction(()=>enqueueNotification(h.app,owner.accountId,'support',key(),'Your support request was reviewed'));
 return {h,owner,device,notification,process:()=>processNotificationJob({notification_id:notification},h.app)};
}

for(const invalid of [false,true])test('definitive gateway rejection is inbox-only; token retirement is explicit '+invalid,async()=>{
 let sends=0;
 const f=await fixture(async request=>{assert.equal(request.method,'POST');sends++;const input=await request.json();return {operation_key:input.operation_key,status:'rejected',provider_code:invalid?'apns.Unregistered':'apns.TooManyRequests',retryable:!invalid,token_invalid:invalid};});
 await f.process();await f.process();assert.equal(sends,1);
 assert.equal((await f.h.db.one('SELECT status FROM notification_jobs WHERE notification_id=?',f.notification)).status,'inbox_only');
 const delivery=await f.h.db.one('SELECT status,provider_receipt FROM notification_deliveries WHERE notification_id=?',f.notification);assert.equal(delivery.status,'cancelled');assert.equal(delivery.provider_receipt,null);
 assert.equal((await f.h.db.one('SELECT active FROM push_devices WHERE id=?',f.device.id)).active,invalid?0:1);
});

test('durable preflight non-dispatch permits one identical bound retry after fresh authority checks',async()=>{
 const calls=[],payloads=[];let operation;
 const f=await fixture(async request=>{
  calls.push(request.method);
  if(request.method==='GET')return {operation_key:operation,status:'not_dispatched'};
  const input=await request.json();operation=input.operation_key;payloads.push(input);
  return payloads.length===1?Response.json({operation_key:operation,status:'not_dispatched'},{status:503}):{operation_key:operation,status:'accepted',provider_message_id:'synthetic-provider-receipt'};
 });
 await assert.rejects(f.process,/push_reconciliation_required/);await f.process();await f.process();
 assert.deepEqual(calls,['POST','GET','POST']);assert.deepEqual(payloads[0],payloads[1]);
 assert.equal((await f.h.db.one('SELECT status,provider_receipt FROM notification_deliveries WHERE notification_id=?',f.notification)).status,'accepted');
});

test('logout during preflight reconciliation cancels the lease and prevents a safe-retry send',async()=>{
 const calls=[];let operation,f;
 f=await fixture(async request=>{
  calls.push(request.method);
  if(request.method==='POST'){operation=(await request.json()).operation_key;return Response.json({operation_key:operation,status:'not_dispatched'},{status:503});}
  await f.h.json('/auth/logout',{token:f.owner.token,body:{}});return {operation_key:operation,status:'not_dispatched'};
 });
 await assert.rejects(f.process,/push_reconciliation_required/);await f.process();
 assert.deepEqual(calls,['POST','GET']);
 assert.equal((await f.h.db.one('SELECT status FROM notification_deliveries WHERE notification_id=?',f.notification)).status,'cancelled');
 assert.equal((await f.h.db.one('SELECT status FROM notification_jobs WHERE notification_id=?',f.notification)).status,'inbox_only');
});

for(const status of ['preparing','dispatching','ambiguous','unknown'])test('gateway '+status+' remains a reconciliation hold without another provider send',async()=>{
 const calls=[];let operation;
 const f=await fixture(async request=>{
  calls.push(request.method);
  if(request.method==='POST'){operation=(await request.json()).operation_key;return {operation_key:operation,status:'ambiguous'};}
  return {operation_key:operation,status};
 });
 await assert.rejects(f.process,/push_reconciliation_required/);await assert.rejects(f.process,/push_reconciliation_required/);
 assert.deepEqual(calls,['POST','GET']);
 const row=await f.h.db.one('SELECT status,provider_receipt FROM notification_deliveries WHERE notification_id=?',f.notification);assert.equal(row.status,'ambiguous');assert.equal(row.provider_receipt,null);
});

test('safe preflight retries stop at the durable attempt bound without claiming acceptance',async()=>{
 let operation,sends=0;
 const f=await fixture(async request=>{if(request.method==='POST'){sends++;operation=(await request.json()).operation_key;}return {operation_key:operation,status:'not_dispatched'};});
 await assert.rejects(f.process,/push_reconciliation_required/);
 await f.h.db.run('UPDATE notification_deliveries SET attempts=5 WHERE notification_id=?',f.notification);await f.process();assert.equal(sends,1);
 assert.equal((await f.h.db.one('SELECT status FROM notification_jobs WHERE notification_id=?',f.notification)).status,'inbox_only');
});
