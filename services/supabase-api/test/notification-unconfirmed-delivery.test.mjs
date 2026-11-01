import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {startHarness} from './runtime-harness.mjs';
import {createApp} from '../src/index.ts';
import {processNotificationJob,flushNotificationOutbox} from '../src/notifications.ts';
import {PostgresJobQueue,drainJobs} from '../src/jobs.ts';
const pgliteTest=process.env.TEST_DATABASE_URL===undefined?test:test.skip;
const originalFetch=globalThis.fetch;
if(process.env.TEST_DATABASE_URL===undefined){globalThis.fetch=async()=>{throw Error('network_denied_by_fixture');};after(()=>{globalThis.fetch=originalFetch;});}
const account='00000000-0000-4000-8000-000000000001',notification='00000000-0000-4000-8000-000000000002',now=1700000000000;
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve};};
async function setup(t){
 const h=await startHarness({consumeQueue:false});t.after(()=>h.close());
 await h.db.run("INSERT INTO accounts(id,name,created_at,identity_state) VALUES(?,?,?,'registered_face')",account,'Synthetic subject',now);
 await h.db.run("INSERT INTO notifications(id,account_id,kind,entity_id,title,created_at) VALUES(?,?,'support','synthetic','Synthetic',?)",notification,account,now);
 await h.db.run("INSERT INTO notification_jobs(notification_id,account_id,auth_epoch,status,created_at) VALUES(?,?,1,'queued',?)",notification,account,now);
 assert.equal(h.env.PUSH_SERVICE,undefined);
 let providerCalls=0;h.env.PUSH_SERVICE={fetch:async()=>{providerCalls++;throw Error('unexpected_provider_call');}};
 return {h,calls:()=>providerCalls,job:()=>h.db.one('SELECT status,dispatched_at FROM notification_jobs WHERE notification_id=?',notification)};
}
function pausedDb(db,entered,released){let armed=true;return new Proxy(db,{get(target,key){
 if(key==='all')return async(sql,...values)=>{const result=await target.all(sql,...values);
  if(armed&&sql.startsWith('SELECT p.* FROM push_devices')){armed=false;entered.resolve();await released.promise;}return result;};
 const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});}


const authDevice='00000000-0000-4000-8000-000000000003',pushDevice='00000000-0000-4000-8000-000000000004',delivery='00000000-0000-4000-8000-000000000005';
async function existingDelivery(f,jobState,deliveryState){
 await f.h.db.run('UPDATE notification_jobs SET status=? WHERE notification_id=?',jobState,notification);
 await f.h.db.run("INSERT INTO auth_devices(id,account_id,public_jwk,revision,status,created_at) VALUES(?,?,?,'synthetic','active',?)",authDevice,account,'{}',now);
 await f.h.db.run("INSERT INTO push_devices(id,account_id,auth_device_id,platform,token_hash,token_value,active,created_at,updated_at) VALUES(?,?,?,'android',?,'',0,?,?)",pushDevice,account,authDevice,'a'.repeat(64),now,now);
 await f.h.db.run('INSERT INTO notification_deliveries(id,notification_id,device_id,operation_key,status,token_hash,provider_receipt,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',delivery,notification,pushDevice,'notification:'+notification+':'+pushDevice,deliveryState,'a'.repeat(64),'synthetic-retained-receipt',1,now,now);
}
const savedDelivery=f=>f.h.db.one('SELECT * FROM notification_deliveries WHERE id=?',delivery);
const unconfirmed=e=>e?.status===503&&e.code==='push_reconciliation_required';
const unbound=e=>e?.status===503&&e.code==='push_delivery_binding_unavailable';
function assertExaminedHistory(actual,before){
 assert(Number.isSafeInteger(actual.updated_at)&&actual.updated_at>before.updated_at);
 assert.deepEqual({...actual,updated_at:before.updated_at},before);
}

for(const jobState of ['queued','dispatched'])for(const deliveryState of ['accepted','ambiguous','dispatching'])pgliteTest(`no devices with ${jobState} job preserves ${deliveryState} history and its durable disposition`,{timeout:30000},async t=>{
 const f=await setup(t);await existingDelivery(f,jobState,deliveryState);const jobBefore=await f.job(),receiptBefore=await savedDelivery(f);
 const process=()=>processNotificationJob({notification_id:notification},createApp(f.h.db,f.h.env,()=>now));
 if(deliveryState==='accepted')await process();else await assert.rejects(process,unbound);
 assert.deepEqual(await f.job(),{...jobBefore,status:deliveryState==='accepted'?'accepted':'ambiguous'});
 if(deliveryState==='accepted')assert.deepEqual(await savedDelivery(f),receiptBefore);else assertExaminedHistory(await savedDelivery(f),receiptBefore);
 assert.equal(f.calls(),0);
});

pgliteTest('an already-ambiguous job and delivery remain unconfirmed with no active devices',{timeout:30000},async t=>{
 const f=await setup(t);await existingDelivery(f,'ambiguous','ambiguous');const jobBefore=await f.job(),receiptBefore=await savedDelivery(f);
 await assert.rejects(()=>processNotificationJob({notification_id:notification},createApp(f.h.db,f.h.env,()=>now)),unbound);
 assert.deepEqual(await f.job(),jobBefore);assertExaminedHistory(await savedDelivery(f),receiptBefore);assert.equal(f.calls(),0);
});

pgliteTest('an already-ambiguous job without local delivery evidence stays unconfirmed',{timeout:30000},async t=>{
 const f=await setup(t);await f.h.db.run("UPDATE notification_jobs SET status='ambiguous' WHERE notification_id=?",notification);const before=await f.job();
 await assert.rejects(()=>processNotificationJob({notification_id:notification},createApp(f.h.db,f.h.env,()=>now)),unconfirmed);assert.deepEqual(await f.job(),before);assert.equal(f.calls(),0);
});

pgliteTest('missing ambiguous history cannot authorize a new delivery to a currently active device',{timeout:30000},async t=>{
 const f=await setup(t);await f.h.db.run("UPDATE notification_jobs SET status='ambiguous' WHERE notification_id=?",notification);const before=await f.job();
 await f.h.db.run("INSERT INTO auth_devices(id,account_id,public_jwk,revision,status,created_at) VALUES(?,?,?,'synthetic','active',?)",authDevice,account,'{}',now);
 await f.h.db.run("INSERT INTO push_devices(id,account_id,auth_device_id,platform,token_hash,token_value,active,created_at,updated_at) VALUES(?,?,?,'android',?,'synthetic-active-token',1,?,?)",pushDevice,account,authDevice,'a'.repeat(64),now,now);
 await assert.rejects(()=>processNotificationJob({notification_id:notification},createApp(f.h.db,f.h.env,()=>now)),unconfirmed);
 assert.deepEqual(await f.job(),before);assert.deepEqual(await f.h.db.all('SELECT * FROM notification_deliveries WHERE notification_id=?',notification),[]);assert.equal(f.calls(),0);
});

pgliteTest('delivery allocation rechecks ambiguity that appears after device enumeration',{timeout:30000},async t=>{
 const f=await setup(t),entered=deferred(),released=deferred();t.after(()=>released.resolve());
 await f.h.db.run("INSERT INTO auth_devices(id,account_id,public_jwk,revision,status,created_at) VALUES(?,?,?,'synthetic','active',?)",authDevice,account,'{}',now);
 await f.h.db.run("INSERT INTO push_devices(id,account_id,auth_device_id,platform,token_hash,token_value,active,created_at,updated_at) VALUES(?,?,?,'android',?,'synthetic-active-token',1,?,?)",pushDevice,account,authDevice,'a'.repeat(64),now,now);
 const pending=processNotificationJob({notification_id:notification},createApp(pausedDb(f.h.db,entered,released),f.h.env,()=>now));void pending.catch(()=>{});
 await Promise.race([entered.promise,pending.then(()=>{throw Error('device_read_did_not_pause');})]);
 await f.h.db.run("UPDATE notification_jobs SET status='ambiguous' WHERE notification_id=?",notification);
 released.resolve();await assert.rejects(pending,unconfirmed);
 assert.equal((await f.job()).status,'ambiguous');assert.deepEqual(await f.h.db.all('SELECT * FROM notification_deliveries WHERE notification_id=?',notification),[]);assert.equal(f.calls(),0);
});

pgliteTest('outbox opt-out cannot erase an ambiguous job whose delivery inventory is absent',{timeout:30000},async t=>{
 const f=await setup(t);await f.h.db.run("UPDATE notification_jobs SET status='ambiguous' WHERE notification_id=?",notification);
 await f.h.db.run('INSERT INTO notification_settings(account_id,support_alerts,updated_at) VALUES(?,0,?)',account,now);
 f.h.env.PHOTO_JOBS=new PostgresJobQueue(f.h.db,()=>now);
 const ctx=createApp(f.h.db,f.h.env,()=>now);await flushNotificationOutbox(ctx);
 assert.equal((await f.job()).status,'ambiguous');
 assert.deepEqual(await drainJobs(ctx,1),{processed:0,failed:1});
 assert.deepEqual(await f.h.db.one('SELECT state,error_code FROM job_queue'),{state:'pending',error_code:'push_reconciliation_required'});
 assert.equal((await f.job()).status,'ambiguous');assert.equal(f.calls(),0);
});


for(const jobState of ['queued','dispatched'])pgliteTest(`a retained queued delivery under ${jobState} is not certified inbox-only`,{timeout:30000},async t=>{
 const f=await setup(t);await existingDelivery(f,jobState,'queued');const before=await f.job(),receipt=await savedDelivery(f);
 await assert.rejects(()=>processNotificationJob({notification_id:notification},createApp(f.h.db,f.h.env,()=>now)),unbound);
 assert.deepEqual(await f.job(),{...before,status:'ambiguous'});assertExaminedHistory(await savedDelivery(f),receipt);assert.equal(f.calls(),0);
});

for(const jobState of ['queued','dispatched'])pgliteTest(`a ${jobState} job with no active devices or retained deliveries remains inbox-only`,{timeout:30000},async t=>{
 const f=await setup(t);await f.h.db.run('UPDATE notification_jobs SET status=? WHERE notification_id=?',jobState,notification);
 await processNotificationJob({notification_id:notification},createApp(f.h.db,f.h.env,()=>now));assert.equal((await f.job()).status,'inbox_only');
});

pgliteTest('a cancelled-only retained delivery is left intact when an eligible job becomes inbox-only',{timeout:30000},async t=>{
 const f=await setup(t);await existingDelivery(f,'queued','cancelled');const receipt=await savedDelivery(f);
 await processNotificationJob({notification_id:notification},createApp(f.h.db,f.h.env,()=>now));assert.equal((await f.job()).status,'inbox_only');assert.deepEqual(await savedDelivery(f),receipt);
});

for(const [jobState,deliveryState] of [['ambiguous','ambiguous'],['queued','accepted']])pgliteTest(`the real queue preserves ${jobState}/${deliveryState} evidence and completes only known acceptance`,{timeout:30000},async t=>{
 const f=await setup(t);await existingDelivery(f,jobState,deliveryState);const jobBefore=await f.job(),receiptBefore=await savedDelivery(f);
 await new PostgresJobQueue(f.h.db,()=>now).send({category:'notification',payload:{notification_id:notification}});
 const accepted=deliveryState==='accepted',result=await drainJobs(createApp(f.h.db,f.h.env,()=>now),1);
 assert.deepEqual(result,accepted?{processed:1,failed:0}:{processed:0,failed:1});
 const queued=await f.h.db.one('SELECT state,attempts,lease_token,error_code FROM job_queue');
 assert.equal(queued.state,accepted?'completed':'pending');assert.equal(queued.attempts,1);assert.equal(queued.lease_token,null);assert.equal(queued.error_code,accepted?null:'push_delivery_binding_unavailable');
 assert.deepEqual(await f.job(),{...jobBefore,status:accepted?'accepted':'ambiguous'});
 if(accepted)assert.deepEqual(await savedDelivery(f),receiptBefore);else assertExaminedHistory(await savedDelivery(f),receiptBefore);
 assert.equal(f.calls(),0);
});
