import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {startHarness} from './runtime-harness.mjs';
import {createApp,createHandler} from '../src/index.ts';
import {PostgresJobQueue,drainJobs} from '../src/jobs.ts';

const pgliteTest=process.env.TEST_DATABASE_URL===undefined?test:test.skip;
const originalFetch=globalThis.fetch;
if(process.env.TEST_DATABASE_URL===undefined){globalThis.fetch=async()=>{throw Error('network_denied_by_fixture');};after(()=>{globalThis.fetch=originalFetch;});}
const subject='00000000-0000-4000-8000-000000000001',notification='00000000-0000-4000-8000-000000000002';
const defer=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve};};
async function fixture(t,{invalid=false}={}){
 const h=await startHarness({consumeQueue:false});t.after(()=>h.close());let now=1700000000000;
 await h.db.run('INSERT INTO accounts(id,name,created_at) VALUES(?,?,?)',subject,'Synthetic subject',now);
 await h.db.run('INSERT INTO notifications(id,account_id,kind,entity_id,title,created_at) VALUES(?,?,?,?,?,?)',notification,subject,'support','synthetic','Synthetic',now);
 await h.db.run("INSERT INTO notification_jobs(notification_id,account_id,auth_epoch,status,created_at) VALUES(?,?,1,'cancelled',?)",notification,subject,now);
 await new PostgresJobQueue(h.db,()=>now).send({category:'notification',payload:{notification_id:invalid?'invalid':notification}});
 const queue=()=>h.db.one('SELECT id,state,attempts,lease_token,lease_until,completed_at,error_code FROM job_queue');
 return {h,queue,clock:()=>now,advance:()=>{now+=180001;}};
}

pgliteTest('ordinary already-cancelled notification job is acknowledged exactly once', {timeout:30000}, async t=>{
 const f=await fixture(t),ctx=createApp(f.h.db,f.h.env,f.clock);
 assert.deepEqual(await drainJobs(ctx,1),{processed:1,failed:0});const row=await f.queue();
 assert.equal(row.state,'completed');assert.equal(row.attempts,1);assert.equal(row.lease_token,null);assert.notEqual(row.completed_at,null);
});

pgliteTest('a superseded worker cannot report the successor completion as its own', {timeout:30000}, async t=>{
 const f=await fixture(t),entered=defer(),release=defer();t.after(()=>release.resolve());let armed=true;
 const db=new Proxy(f.h.db,{get(target,property){
  if(property==='one')return async(sql,...bindings)=>{
   const result=await target.one(sql,...bindings);
   if(armed&&sql.startsWith('SELECT j.*,n.kind,n.title,n.entity_id FROM notification_jobs')){armed=false;entered.resolve();await release.promise;}
   return result;
  };
  const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
 }});
 const old=drainJobs(createApp(db,f.h.env,f.clock),1);void old.catch(()=>{});
 await Promise.race([entered.promise,old.then(()=>{throw Error('old_worker_did_not_wait');})]);
 const claimed=await f.queue();assert.equal(claimed.state,'processing');assert.equal(claimed.attempts,1);assert(claimed.lease_token);
 f.advance();assert.deepEqual(await drainJobs(createApp(f.h.db,f.h.env,f.clock),1),{processed:1,failed:0});
 const successor=await f.queue();assert.equal(successor.state,'completed');assert.equal(successor.attempts,2);assert.equal(successor.lease_token,null);
 release.resolve();assert.deepEqual(await old,{processed:0,failed:1});assert.deepEqual(await f.queue(),successor);
});


pgliteTest('a failed handler retains the existing bounded retry semantics', {timeout:30000}, async t=>{
 const f=await fixture(t,{invalid:true}),ctx=createApp(f.h.db,f.h.env,f.clock);
 assert.deepEqual(await drainJobs(ctx,1),{processed:0,failed:1});const saved=await f.queue();
 assert.equal(saved.state,'pending');assert.equal(saved.attempts,1);assert.equal(saved.lease_token,null);assert.equal(saved.error_code,'invalid_id');
});

pgliteTest('a changed job state is preserved even if its former token is still present', {timeout:30000}, async t=>{
 const f=await fixture(t),entered=defer(),release=defer();t.after(()=>release.resolve());let armed=true;
 const db=new Proxy(f.h.db,{get(target,property){
  if(property==='one')return async(sql,...bindings)=>{
   const result=await target.one(sql,...bindings);
   if(armed&&sql.startsWith('SELECT j.*,n.kind,n.title,n.entity_id FROM notification_jobs')){armed=false;entered.resolve();await release.promise;}
   return result;
  };
  const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
 }});
 const old=drainJobs(createApp(db,f.h.env,f.clock),1);void old.catch(()=>{});
 await Promise.race([entered.promise,old.then(()=>{throw Error('old_worker_did_not_wait');})]);
 const claimed=await f.queue();assert.equal(claimed.state,'processing');assert(claimed.lease_token);
 await f.h.db.run("UPDATE job_queue SET state='failed',error_code='synthetic_hold' WHERE id=?",claimed.id);
 const preserved=await f.queue();release.resolve();
 assert.deepEqual(await old,{processed:0,failed:1});assert.deepEqual(await f.queue(),preserved);
});

pgliteTest('a lost completion commit reply is counted unconfirmed without undoing the committed row', {timeout:30000}, async t=>{
 const f=await fixture(t);let completion=false,lose=true;
 const db=new Proxy(f.h.db,{get(target,property){
  if(property==='one')return async(sql,...bindings)=>{
   const value=await target.one(sql,...bindings);
   if(sql.startsWith("UPDATE job_queue SET state='completed'"))completion=true;
   return value;
  };
  if(property==='transaction')return async(callback,...args)=>{
   const result=await target.transaction(callback,...args);
   if(completion&&lose){lose=false;completion=false;throw Error('synthetic_lost_completion_commit_reply');}
   return result;
  };
  const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
 }});
 assert.deepEqual(await drainJobs(createApp(db,f.h.env,f.clock),1),{processed:0,failed:1});
 const saved=await f.queue();assert.equal(saved.state,'completed');assert.equal(saved.attempts,1);assert.equal(saved.lease_token,null);assert.notEqual(saved.completed_at,null);
});

for(const changedState of ['failed','completed'])pgliteTest(`handler error cannot overwrite a changed ${changedState} state retaining the old token`,{timeout:30000},async t=>{
 const f=await fixture(t),entered=defer(),release=defer();t.after(()=>release.resolve());let armed=true;
 const device='00000000-0000-4000-8000-000000000003',push='00000000-0000-4000-8000-000000000004';
 await f.h.db.run("UPDATE accounts SET identity_state='registered_face' WHERE id=?",subject);
 await f.h.db.run("UPDATE notification_jobs SET status='queued' WHERE notification_id=?",notification);
 await f.h.db.run("INSERT INTO auth_devices(id,account_id,public_jwk,revision,status,created_at) VALUES(?,?,?,'synthetic','active',?)",device,subject,'{}',f.clock());
 await f.h.db.run("INSERT INTO push_devices(id,account_id,auth_device_id,platform,token_hash,token_value,active,created_at,updated_at) VALUES(?,?,?,'android',?,?,1,?,?)",push,subject,device,'a'.repeat(64),'synthetic-token',f.clock(),f.clock());
 assert.equal(f.h.env.PUSH_SERVICE,undefined,'no provider is configured or called');
 const db=new Proxy(f.h.db,{get(target,property){
  if(property==='all')return async(sql,...bindings)=>{
   const result=await target.all(sql,...bindings);
   if(armed&&sql.startsWith('SELECT p.* FROM push_devices')){armed=false;entered.resolve();await release.promise;}
   return result;
  };
  const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
 }});
 const pending=drainJobs(createApp(db,f.h.env,f.clock),1);void pending.catch(()=>{});
 await Promise.race([entered.promise,pending.then(()=>{throw Error('handler_did_not_wait');})]);
 const claimed=await f.queue();assert.equal(claimed.state,'processing');assert(claimed.lease_token);
 await f.h.db.run('UPDATE job_queue SET state=?,completed_at=?,error_code=? WHERE id=?',changedState,changedState==='completed'?f.clock():null,'synthetic_terminal',claimed.id);
 const preserved=await f.queue();release.resolve();assert.deepEqual(await pending,{processed:0,failed:1});
 assert.deepEqual(await f.queue(),preserved);
});


pgliteTest('actual maintenance endpoint returns 503 and existing fields for an unconfirmed stale completion',{timeout:30000},async t=>{
 const f=await fixture(t),entered=defer(),release=defer();t.after(()=>release.resolve());let armed=true;
 const db=new Proxy(f.h.db,{get(target,property){
  if(property==='one')return async(sql,...bindings)=>{
   const value=await target.one(sql,...bindings);
   if(armed&&sql.startsWith('SELECT j.*,n.kind,n.title,n.entity_id FROM notification_jobs')){armed=false;entered.resolve();await release.promise;}
   return value;
  };
  const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
 }});
 const handler=createHandler(createApp(db,f.h.env,f.clock));
 const responsePromise=handler(new Request('http://localhost/_internal/maintenance',{method:'POST',headers:{authorization:'Bearer '+f.h.env.INTERNAL_MAINTENANCE_SECRET}}));
 void responsePromise.catch(()=>{});await Promise.race([entered.promise,responsePromise.then(()=>{throw Error('maintenance_did_not_wait');})]);
 const claimed=await f.queue();assert.equal(claimed.state,'processing');assert(claimed.lease_token);
 f.advance();assert.deepEqual(await drainJobs(createApp(f.h.db,f.h.env,f.clock),1),{processed:1,failed:0});
 const successor=await f.queue();release.resolve();const response=await responsePromise;assert.equal(response.status,503);
 const body=await response.json();assert.deepEqual(Object.keys(body).sort(),['failed','maintenance_errors','privacy_health','processed','retention']);
 assert.equal(body.processed,0);assert.equal(body.failed,1);assert(Number.isSafeInteger(body.maintenance_errors));
 assert.equal(typeof body.privacy_health.status,'string');assert.equal(typeof body.retention.status,'string');
 assert.deepEqual(await f.queue(),successor);
});
