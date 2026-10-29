import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {startHarness,enroll,faceVerifierFixture} from './runtime-harness.mjs';
import {enqueueNotification,processNotificationJob} from '../src/notifications.ts';
import {createApp} from '../src/index.ts';
import {PostgresJobQueue,drainJobs} from '../src/jobs.ts';

const localTest=process.env.TEST_DATABASE_URL===undefined?test:test.skip;
const originalFetch=globalThis.fetch;
if(process.env.TEST_DATABASE_URL===undefined){globalThis.fetch=async()=>{throw Error('network_denied_by_fixture');};after(()=>{globalThis.fetch=originalFetch;});}
const key=()=>crypto.randomUUID();
async function fixture(t){
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});t.after(()=>h.close());
 const actor=await enroll(h),token='synthetic-fcm-token-'+key();
 const device=await h.json('/me/push-devices',{token:actor.token,body:{platform:'android',push_token:token,operation_key:key()}});
 const note=await h.db.transaction(()=>enqueueNotification(h.app,actor.accountId,'support',key(),'Synthetic notice'));
 const push=await h.db.one('SELECT token_hash FROM push_devices WHERE id=?',device.id);
 return {h,actor,token,device,note,push};
}
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve};};
function pauseAfterDeviceRead(db,entered,released){let armed=true;return new Proxy(db,{get(target,key){
 if(key==='all')return async(sql,...values)=>{const result=await target.all(sql,...values);
  if(armed&&sql.startsWith('SELECT p.* FROM push_devices')){armed=false;entered.resolve();await released.promise;}return result;};
 const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});}

const cases=[
 {name:'untouched queued',status:'queued',attempts:0,preserve:false},
 {name:'queued with a prior attempt',status:'queued',attempts:1,preserve:true},
 {name:'queued with a receipt',status:'queued',attempts:0,receipt:'synthetic-receipt',preserve:true},
 {name:'queued with an empty receipt',status:'queued',attempts:0,receipt:'',preserve:true},
 {name:'queued with a lease',status:'queued',attempts:0,lease:true,preserve:true},
 {name:'queued with a token only',status:'queued',attempts:0,tokenOnly:true,preserve:true},
 {name:'queued with a deadline only',status:'queued',attempts:0,deadlineOnly:true,preserve:true},
 {name:'dispatching',status:'dispatching',attempts:1,lease:true,preserve:true},
 {name:'ambiguous',status:'ambiguous',attempts:1,preserve:true},
 {name:'accepted',status:'accepted',attempts:1,receipt:'synthetic-receipt',preserve:true},
];
for(const item of cases)localTest(`removing the current device handles ${item.name} delivery`,{timeout:30000},async t=>{
 const {h,actor,token,device,note,push}=await fixture(t);
 const id=key(),operation='notification:'+note+':'+device.id,now=Date.now();
 await h.db.run('INSERT INTO notification_deliveries(id,notification_id,device_id,operation_key,status,token_hash,provider_receipt,lease_token,lease_until,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
  id,note,device.id,operation,item.status,push.token_hash,item.receipt??null,item.lease||item.tokenOnly?key():null,item.lease||item.deadlineOnly?now+60000:null,item.attempts,now,now);
 const before=await h.db.one('SELECT * FROM notification_deliveries WHERE id=?',id);
 const response=await h.request('/me/push-devices/'+device.id,{method:'DELETE',token:actor.token,body:{operation_key:key()}});
 assert.equal(response.status,200);await response.body?.cancel();
 const inactive=await h.db.one('SELECT active,token_value FROM push_devices WHERE id=?',device.id);
 assert.deepEqual(inactive,{active:0,token_value:''});
 const after=await h.db.one('SELECT * FROM notification_deliveries WHERE id=?',id);
 if(item.preserve)assert.deepEqual(after,before);else {assert.equal(after.status,'cancelled');assert.deepEqual({...after,status:before.status,updated_at:before.updated_at},before);}
 assert.equal(h.env.PUSH_SERVICE,undefined);
 if(item.preserve)await assert.rejects(()=>processNotificationJob({notification_id:note},h.app),e=>e?.status===503&&e.code==='push_reconciliation_required');
 if(item.preserve&&item.status==='queued'){
  const restored=await h.json('/me/push-devices',{token:actor.token,body:{platform:'android',push_token:token,operation_key:key()}});assert.equal(restored.id,device.id);
  let sends=0;h.env.PUSH_SERVICE={fetch:async()=>{sends++;throw Error('synthetic_provider_must_not_be_called');}};
  await assert.rejects(()=>processNotificationJob({notification_id:note},h.app),e=>e?.status===503&&e.code==='push_reconciliation_required');
  assert.equal(sends,0);assert.deepEqual(await h.db.one('SELECT * FROM notification_deliveries WHERE id=?',id),before);
 }
});

localTest('removal after device enumeration preserves a stale worker’s ambiguous delivery',{timeout:30000},async t=>{
 const {h,actor,device,note,push}=await fixture(t),id=key(),now=Date.now(),operation='notification:'+note+':'+device.id;
 await h.db.run("INSERT INTO notification_deliveries(id,notification_id,device_id,operation_key,status,token_hash,attempts,created_at,updated_at) VALUES(?,?,?,?,'ambiguous',?,1,?,?)",id,note,device.id,operation,push.token_hash,now,now);
 const before=await h.db.one('SELECT * FROM notification_deliveries WHERE id=?',id),entered=deferred(),released=deferred();t.after(()=>released.resolve());
 let sends=0;h.env.PUSH_SERVICE={fetch:async()=>{sends++;throw Error('synthetic_provider_must_not_be_called');}};
 const pending=processNotificationJob({notification_id:note},createApp(pauseAfterDeviceRead(h.db,entered,released),h.env));void pending.catch(()=>{});
 await Promise.race([entered.promise,pending.then(()=>{throw Error('device_read_did_not_pause');})]);
 const response=await h.request('/me/push-devices/'+device.id,{method:'DELETE',token:actor.token,body:{operation_key:key()}});assert.equal(response.status,200);await response.body?.cancel();
 released.resolve();await assert.rejects(pending,e=>e?.status===503&&e.code==='push_reconciliation_required');
 assert.equal(sends,0);assert.deepEqual(await h.db.one('SELECT * FROM notification_deliveries WHERE id=?',id),before);
 assert.equal((await h.db.one('SELECT status FROM notification_jobs WHERE notification_id=?',note)).status,'queued');
});

localTest('a remaining device cannot make the queue complete while the removed device is ambiguous',{timeout:30000},async t=>{
 const {h,actor,device,note,push}=await fixture(t),id=key(),now=Date.now(),operation='notification:'+note+':'+device.id;
 const remaining=await h.json('/me/push-devices',{token:actor.token,body:{platform:'ios',push_token:'synthetic-apns-token-'+key(),operation_key:key()}});
 await h.db.run("INSERT INTO notification_deliveries(id,notification_id,device_id,operation_key,status,token_hash,attempts,created_at,updated_at) VALUES(?,?,?,?,'ambiguous',?,1,?,?)",id,note,device.id,operation,push.token_hash,now,now);
 const before=await h.db.one('SELECT * FROM notification_deliveries WHERE id=?',id);
 const response=await h.request('/me/push-devices/'+device.id,{method:'DELETE',token:actor.token,body:{operation_key:key()}});assert.equal(response.status,200);await response.body?.cancel();
 let sends=0;h.env.PUSH_SERVICE={fetch:async(_url,init)=>{assert.equal(init?.method,'POST');sends++;const body=JSON.parse(init.body);return Response.json({operation_key:body.operation_key,status:'accepted',provider_message_id:'synthetic-receipt'});}};
 await new PostgresJobQueue(h.db).send({category:'notification',payload:{notification_id:note}});
 assert.deepEqual(await drainJobs(h.app,1),{processed:0,failed:1});
 const job=await h.db.one('SELECT state,error_code FROM job_queue');assert.deepEqual(job,{state:'pending',error_code:'push_reconciliation_required'});
 assert.equal(sends,1);assert.deepEqual(await h.db.one('SELECT * FROM notification_deliveries WHERE id=?',id),before);
 assert.deepEqual(await h.db.one('SELECT status,provider_receipt FROM notification_deliveries WHERE notification_id=? AND device_id=?',note,remaining.id),{status:'accepted',provider_receipt:'synthetic-receipt'});
 assert.equal((await h.db.one('SELECT status FROM notification_jobs WHERE notification_id=?',note)).status,'queued');
});
