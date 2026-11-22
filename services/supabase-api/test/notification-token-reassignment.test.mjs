import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {startHarness,enroll,faceVerifierFixture} from './runtime-harness.mjs';
import {enqueueNotification,processNotificationJob} from '../src/notifications.ts';

const localTest=process.env.TEST_DATABASE_URL===undefined?test:test.skip;
const originalFetch=globalThis.fetch;
if(process.env.TEST_DATABASE_URL===undefined){globalThis.fetch=async()=>{throw Error('network_denied_by_fixture');};after(()=>{globalThis.fetch=originalFetch;});}
const key=()=>crypto.randomUUID();
async function fixture(t){
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});t.after(()=>h.close());
 const prior=await enroll(h),next=await enroll(h),token='synthetic-reassigned-token-'+key();
 const device=await h.json('/me/push-devices',{token:prior.token,body:{platform:'android',push_token:token,operation_key:key()}});
 const notification=await h.db.transaction(()=>enqueueNotification(h.app,prior.accountId,'support',key(),'Synthetic notice'));
 const push=await h.db.one('SELECT token_hash FROM push_devices WHERE id=?',device.id);
 return {h,prior,next,token,device,notification,push};
}
const cases=[
 {name:'untouched queued',status:'queued',attempts:0,preserve:false},
 {name:'queued with prior attempt',status:'queued',attempts:1,preserve:true},
 {name:'queued with receipt',status:'queued',attempts:0,receipt:'synthetic-receipt',preserve:true},
 {name:'queued with empty receipt',status:'queued',attempts:0,receipt:'',preserve:true},
 {name:'queued with lease',status:'queued',attempts:0,lease:true,preserve:true},
 {name:'queued with token only',status:'queued',attempts:0,tokenOnly:true,preserve:true},
 {name:'queued with deadline only',status:'queued',attempts:0,deadlineOnly:true,preserve:true},
 {name:'dispatching',status:'dispatching',attempts:1,lease:true,preserve:true},
 {name:'ambiguous',status:'ambiguous',attempts:1,preserve:true},
 {name:'accepted',status:'accepted',attempts:1,receipt:'synthetic-receipt',preserve:true},
 {name:'already cancelled',status:'cancelled',attempts:1,preserve:true},
];
for(const item of cases)localTest(`inactive token reassignment preserves ${item.name} evidence`,{timeout:30000},async t=>{
 const f=await fixture(t),id=key(),now=Date.now();
 await f.h.db.run('INSERT INTO notification_deliveries(id,notification_id,device_id,operation_key,status,token_hash,provider_receipt,lease_token,lease_until,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
  id,f.notification,f.device.id,'notification:'+f.notification+':'+f.device.id,item.status,f.push.token_hash,item.receipt??null,item.lease||item.tokenOnly?key():null,item.lease||item.deadlineOnly?now+60000:null,item.attempts,now,now);
 await f.h.db.run("UPDATE push_devices SET active=0,token_value='' WHERE id=?",f.device.id);
 const before=await f.h.db.one('SELECT * FROM notification_deliveries WHERE id=?',id);
 const operation=key(),body={platform:'android',push_token:f.token,operation_key:operation};
 const registered=await f.h.json('/me/push-devices',{token:f.next.token,body});
 assert.equal(registered.active,true);assert.notEqual(registered.id,f.device.id);
 assert.deepEqual(await f.h.json('/me/push-devices',{token:f.next.token,body}),registered);
 const current=await f.h.db.one('SELECT * FROM notification_deliveries WHERE id=?',id);
 if(item.preserve)assert.deepEqual(current,before);else {assert.equal(current.status,'cancelled');assert.deepEqual({...current,status:before.status,updated_at:before.updated_at},before);}
 const retired=await f.h.db.one('SELECT account_id,active,token_value,token_hash FROM push_devices WHERE id=?',f.device.id);
 assert.equal(retired.account_id,f.prior.accountId);assert.equal(retired.active,0);assert.equal(retired.token_value,'');assert.notEqual(retired.token_hash,f.push.token_hash);
 assert.deepEqual(await f.h.db.one('SELECT account_id,active,token_hash FROM push_devices WHERE id=?',registered.id),{account_id:f.next.accountId,active:1,token_hash:f.push.token_hash});
 assert.equal(f.h.env.PUSH_SERVICE,undefined);
 if(item.preserve&&!['accepted','cancelled'].includes(item.status)){
  await assert.rejects(()=>processNotificationJob({notification_id:f.notification},f.h.app),e=>e?.status===503&&e.code==='push_reconciliation_required');
  assert.deepEqual(await f.h.db.one('SELECT * FROM notification_deliveries WHERE id=?',id),before);
 }
});

localTest('active token ownership rejects reassignment without changing prior history',{timeout:30000},async t=>{
 const f=await fixture(t),id=key(),now=Date.now();
 await f.h.db.run("INSERT INTO notification_deliveries(id,notification_id,device_id,operation_key,status,token_hash,attempts,created_at,updated_at) VALUES(?,?,?,?,'ambiguous',?,1,?,?)",id,f.notification,f.device.id,'notification:'+f.notification+':'+f.device.id,f.push.token_hash,now,now);
 const before=await f.h.db.one('SELECT * FROM notification_deliveries WHERE id=?',id),device=await f.h.db.one('SELECT * FROM push_devices WHERE id=?',f.device.id);
 const response=await f.h.request('/me/push-devices',{token:f.next.token,body:{platform:'android',push_token:f.token,operation_key:key()}});
 assert.equal(response.status,403);assert.equal((await response.json()).error.code,'push_token_owner_conflict');
 assert.deepEqual(await f.h.db.one('SELECT * FROM notification_deliveries WHERE id=?',id),before);
 assert.deepEqual(await f.h.db.one('SELECT * FROM push_devices WHERE id=?',f.device.id),device);
 assert.equal((await f.h.db.one('SELECT count(*) n FROM push_devices WHERE account_id=?',f.next.accountId)).n,0);
});
