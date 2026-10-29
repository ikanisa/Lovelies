import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {startHarness} from './runtime-harness.mjs';
import {createApp} from '../src/index.ts';
import {processNotificationJob,flushNotificationOutbox} from '../src/notifications.ts';
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
 return {h,job:()=>h.db.one('SELECT status,dispatched_at FROM notification_jobs WHERE notification_id=?',notification)};
}
function pausedDb(db,entered,released){let armed=true;return new Proxy(db,{get(target,key){
 if(key==='all')return async(sql,...values)=>{const result=await target.all(sql,...values);
  if(armed&&sql.startsWith('SELECT p.* FROM push_devices')){armed=false;entered.resolve();await released.promise;}return result;};
 const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});}

pgliteTest('one queued notification with no devices becomes inbox-only',{timeout:30000},async t=>{
 const f=await setup(t);await processNotificationJob({notification_id:notification},createApp(f.h.db,f.h.env,()=>now));
 assert.equal((await f.job()).status,'inbox_only');
});

pgliteTest('a same-subject opt-out cancellation cannot be overwritten by a paused no-device worker',{timeout:30000},async t=>{
 const f=await setup(t),entered=deferred(),released=deferred();t.after(()=>released.resolve());
 const old=processNotificationJob({notification_id:notification},createApp(pausedDb(f.h.db,entered,released),f.h.env,()=>now));void old.catch(()=>{});
 await Promise.race([entered.promise,old.then(()=>{throw Error('worker_did_not_pause');})]);
 await f.h.db.run('INSERT INTO notification_settings(account_id,support_alerts,updated_at) VALUES(?,0,?)',account,now);
 await flushNotificationOutbox(createApp(f.h.db,f.h.env,()=>now));const prior=await f.job();assert.equal(prior.status,'cancelled');
 released.resolve();await old;assert.deepEqual(await f.job(),prior);
});

pgliteTest('a synthetic accepted terminal state cannot be downgraded by a paused no-device worker',{timeout:30000},async t=>{
 const f=await setup(t),entered=deferred(),released=deferred();t.after(()=>released.resolve());
 const old=processNotificationJob({notification_id:notification},createApp(pausedDb(f.h.db,entered,released),f.h.env,()=>now));void old.catch(()=>{});
 await Promise.race([entered.promise,old.then(()=>{throw Error('worker_did_not_pause');})]);
 await f.h.db.run("UPDATE notification_jobs SET status='accepted' WHERE notification_id=?",notification);
 const prior=await f.job();assert.equal(prior.status,'accepted');released.resolve();await old;assert.deepEqual(await f.job(),prior);
});


pgliteTest('a newly ambiguous state is not overwritten by a paused no-device worker',{timeout:30000},async t=>{
 const f=await setup(t),entered=deferred(),released=deferred();t.after(()=>released.resolve());
 const old=processNotificationJob({notification_id:notification},createApp(pausedDb(f.h.db,entered,released),f.h.env,()=>now));void old.catch(()=>{});
 await Promise.race([entered.promise,old.then(()=>{throw Error('worker_did_not_pause');})]);
 await f.h.db.run("UPDATE notification_jobs SET status='ambiguous' WHERE notification_id=?",notification);
 const prior=await f.job();released.resolve();await assert.rejects(old,e=>e?.status===503&&e.code==='push_reconciliation_required');assert.deepEqual(await f.job(),prior);
});

pgliteTest('outbox refresh preserves an already ambiguous job',{timeout:30000},async t=>{
 const f=await setup(t);await f.h.db.run("UPDATE notification_jobs SET status='ambiguous' WHERE notification_id=?",notification);
 await flushNotificationOutbox(createApp(f.h.db,f.h.env,()=>now));
 assert.deepEqual(await f.job(),{status:'ambiguous',dispatched_at:now});
 assert.equal((await f.h.db.one("SELECT count(*) n FROM job_queue WHERE category='notification'")).n,1);
});

for(const concurrent of ['ambiguous','accepted'])pgliteTest(`outbox refresh preserves a ${concurrent} state recorded during enqueue`,{timeout:30000},async t=>{
 const f=await setup(t),queue=f.h.env.PHOTO_JOBS,send=queue.send.bind(queue);
 queue.send=async message=>{await send(message);await f.h.db.run('UPDATE notification_jobs SET status=? WHERE notification_id=?',concurrent,notification);};
 await flushNotificationOutbox(createApp(f.h.db,f.h.env,()=>now));
 const row=await f.job();assert.equal(row.status,concurrent);
 assert.equal(row.dispatched_at,concurrent==='ambiguous'?now:null);
 assert.equal((await f.h.db.one("SELECT count(*) n FROM job_queue WHERE category='notification'")).n,1);
});

pgliteTest('outbox refresh still dispatches an ordinary queued job',{timeout:30000},async t=>{
 const f=await setup(t);await flushNotificationOutbox(createApp(f.h.db,f.h.env,()=>now));
 assert.deepEqual(await f.job(),{status:'dispatched',dispatched_at:now});
 assert.equal((await f.h.db.one("SELECT count(*) n FROM job_queue WHERE category='notification'")).n,1);
});
