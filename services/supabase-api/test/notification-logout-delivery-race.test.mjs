import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {startHarness,enroll,faceVerifierFixture} from './runtime-harness.mjs';
import {enqueueNotification,processNotificationJob} from '../src/notifications.ts';

const localTest=process.env.TEST_DATABASE_URL===undefined?test:test.skip;
const originalFetch=globalThis.fetch;
if(process.env.TEST_DATABASE_URL===undefined){globalThis.fetch=async()=>{throw Error('network_denied_by_fixture');};after(()=>{globalThis.fetch=originalFetch;});}
const key=()=>crypto.randomUUID();
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve};};
async function fixture(t){
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});t.after(()=>h.close());
 const actor=await enroll(h);
 const device=await h.json('/me/push-devices',{token:actor.token,body:{platform:'android',push_token:'synthetic-fcm-token-'+key(),operation_key:key()}});
 const note=await h.db.transaction(()=>enqueueNotification(h.app,actor.accountId,'support',key(),'Synthetic notice'));
 const push=await h.db.one('SELECT token_hash FROM push_devices WHERE id=?',device.id);
 return {h,actor,device,note,push};
}
async function logout(f){const response=await f.h.request('/auth/logout',{method:'POST',token:f.actor.token,body:{}});assert.equal(response.status,200);await response.body?.cancel();}

const cases=[
 {name:'untouched queued',status:'queued',attempts:0,preserve:false},
 {name:'queued with prior attempt',status:'queued',attempts:1,preserve:true},
 {name:'queued with receipt',status:'queued',attempts:0,receipt:'synthetic-receipt',preserve:true},
 {name:'queued with lease',status:'queued',attempts:0,lease:true,preserve:true},
 {name:'dispatching',status:'dispatching',attempts:1,lease:true,preserve:true},
 {name:'ambiguous',status:'ambiguous',attempts:1,preserve:true},
 {name:'accepted',status:'accepted',attempts:1,receipt:'synthetic-receipt',preserve:true},
];
for(const item of cases)localTest(`logout handles ${item.name} delivery`,{timeout:30000},async t=>{
 const f=await fixture(t),id=key(),now=Date.now(),operation='notification:'+f.note+':'+f.device.id;
 await f.h.db.run('INSERT INTO notification_deliveries(id,notification_id,device_id,operation_key,status,token_hash,provider_receipt,lease_token,lease_until,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
  id,f.note,f.device.id,operation,item.status,f.push.token_hash,item.receipt??null,item.lease?key():null,item.lease?now+60000:null,item.attempts,now,now);
 const before=await f.h.db.one('SELECT * FROM notification_deliveries WHERE id=?',id);await logout(f);
 assert.deepEqual(await f.h.db.one('SELECT active,token_value FROM push_devices WHERE id=?',f.device.id),{active:0,token_value:''});
 const current=await f.h.db.one('SELECT * FROM notification_deliveries WHERE id=?',id);
 if(item.preserve)assert.deepEqual(current,before);else {assert.equal(current.status,'cancelled');assert.deepEqual({...current,status:before.status,updated_at:before.updated_at},before);}
 assert.equal(f.h.env.PUSH_SERVICE,undefined);
});

localTest('logout during an in-flight send keeps a second worker from reporting inbox-only',{timeout:30000},async t=>{
 const f=await fixture(t),entered=deferred(),release=deferred();let sends=0;
 f.h.env.PUSH_SERVICE={fetch:async(_url,init)=>{assert.equal(init?.method,'POST');sends++;const body=JSON.parse(init.body);entered.resolve();await release.promise;
  return Response.json({operation_key:body.operation_key,status:'accepted',provider_message_id:'synthetic-receipt'});}};
 const first=processNotificationJob({notification_id:f.note},f.h.app);void first.catch(()=>{});
 try{
  await Promise.race([entered.promise,first.then(()=>{throw Error('synthetic_send_did_not_pause');})]);
  await logout(f);assert.deepEqual(await f.h.db.one('SELECT active,token_value FROM push_devices WHERE id=?',f.device.id),{active:0,token_value:''});
  const second=processNotificationJob({notification_id:f.note},f.h.app);
  await assert.rejects(second,e=>e?.status===503&&e.code==='push_reconciliation_required');
  assert.equal((await f.h.db.one('SELECT status FROM notification_jobs WHERE notification_id=?',f.note)).status,'queued');
  assert.equal((await f.h.db.one('SELECT status FROM notification_deliveries WHERE notification_id=?',f.note)).status,'dispatching');
  assert.equal(sends,1);
 }finally{release.resolve();await first.catch(()=>{});}
 const delivery=await f.h.db.one('SELECT status,provider_receipt FROM notification_deliveries WHERE notification_id=?',f.note);
 assert.deepEqual(delivery,{status:'ambiguous',provider_receipt:null});
 assert.equal((await f.h.db.one('SELECT status FROM notification_jobs WHERE notification_id=?',f.note)).status,'ambiguous');
 assert.equal(sends,1);
});
