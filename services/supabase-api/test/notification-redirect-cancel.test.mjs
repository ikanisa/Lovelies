import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {startHarness} from './runtime-harness.mjs';
import {createApp} from '../src/index.ts';
import {processNotificationJob} from '../src/notifications.ts';
const pgliteTest=process.env.TEST_DATABASE_URL===undefined?test:test.skip;
const oldFetch=globalThis.fetch;
if(process.env.TEST_DATABASE_URL===undefined){globalThis.fetch=async()=>{throw Error('fixture_network_denied')};after(()=>{globalThis.fetch=oldFetch});}
const now=1700000000000,account='00000000-0000-4000-8000-000000000001',note='00000000-0000-4000-8000-000000000002';
const auth='00000000-0000-4000-8000-000000000003',device='00000000-0000-4000-8000-000000000004',delivery='00000000-0000-4000-8000-000000000005';
async function setup(t){
 const h=await startHarness({consumeQueue:false});t.after(()=>h.close());
 await h.db.run("INSERT INTO accounts(id,name,created_at,identity_state) VALUES(?,'Synthetic',?,'registered_face')",account,now);
 await h.db.run("INSERT INTO notifications(id,account_id,kind,entity_id,title,created_at) VALUES(?,?,'support','synthetic','Synthetic',?)",note,account,now);
 await h.db.run("INSERT INTO notification_jobs(notification_id,account_id,auth_epoch,status,created_at) VALUES(?,?,1,'ambiguous',?)",note,account,now);
 await h.db.run("INSERT INTO auth_devices(id,account_id,public_jwk,revision,status,created_at) VALUES(?,?,?,'synthetic','active',?)",auth,account,'{}',now);
 await h.db.run("INSERT INTO push_devices(id,account_id,auth_device_id,platform,token_hash,token_value,active,created_at,updated_at) VALUES(?,?,?,'android',?,'synthetic-token-0001',1,?,?)",device,account,auth,'a'.repeat(64),now,now);
 await h.db.run("INSERT INTO notification_deliveries(id,notification_id,device_id,operation_key,status,token_hash,attempts,created_at,updated_at) VALUES(?,?,?,?,'ambiguous',?,1,?,?)",delivery,note,device,'notification:'+note+':'+device,'a'.repeat(64),now,now);
 return h;
}
for(const variant of ['status302','redirected','cancel_rejects','cancel_never_resolves'])pgliteTest(`redirect response body is cancelled and denial preserved: ${variant}`,{timeout:30000},async t=>{
 const h=await setup(t);let cancellations=0,requests=0;
 h.env.PUSH_SERVICE={fetch:async(url,init)=>{
  requests++;assert.equal(init?.method??'GET','GET');assert(String(url).includes('/operations/'));
  const body=new ReadableStream({cancel(){cancellations++;if(variant==='cancel_rejects')return Promise.reject(Error('synthetic_cancel_failure'));if(variant==='cancel_never_resolves')return new Promise(()=>{});}});
  const response=new Response(body,{status:variant==='redirected'?200:302,headers:{location:'https://untrusted.invalid'}});
  if(variant==='redirected')Object.defineProperty(response,'redirected',{value:true});return response;
 }};
 const outcome=processNotificationJob({notification_id:note},createApp(h.db,h.env,()=>now));
 await assert.rejects(outcome,e=>e?.status===503&&e.code==='push_provider_redirect_denied');
 assert.equal(requests,1);assert.equal(cancellations,1);assert.equal((await h.db.one('SELECT status FROM notification_jobs WHERE notification_id=?',note)).status,'ambiguous');
 const row=await h.db.one('SELECT status,provider_receipt,lease_token FROM notification_deliveries WHERE id=?',delivery);
 assert.deepEqual(row,{status:'ambiguous',provider_receipt:null,lease_token:null});
});

pgliteTest('a redirect without a body still returns the existing denial',{timeout:30000},async t=>{
 const h=await setup(t);h.env.PUSH_SERVICE={fetch:async(_url,init)=>{assert.equal(init?.method??'GET','GET');return new Response(null,{status:302})}};
 await assert.rejects(()=>processNotificationJob({notification_id:note},createApp(h.db,h.env,()=>now)),e=>e?.status===503&&e.code==='push_provider_redirect_denied');
 assert.equal((await h.db.one('SELECT status FROM notification_jobs WHERE notification_id=?',note)).status,'ambiguous');
});

pgliteTest('a nonredirect ambiguous reply keeps its existing reconciliation result',{timeout:30000},async t=>{
 const h=await setup(t);h.env.PUSH_SERVICE={fetch:async(_url,init)=>{assert.equal(init?.method??'GET','GET');return Response.json({operation_key:'notification:'+note+':'+device,status:'ambiguous'})}};
 await assert.rejects(()=>processNotificationJob({notification_id:note},createApp(h.db,h.env,()=>now)),e=>e?.status===503&&e.code==='push_reconciliation_required');
 assert.equal((await h.db.one('SELECT status FROM notification_jobs WHERE notification_id=?',note)).status,'ambiguous');
});

pgliteTest('a locked redirected body does not replace the existing denial with a cancellation error',{timeout:30000},async t=>{
 const h=await setup(t);let reader;h.env.PUSH_SERVICE={fetch:async(_url,init)=>{
  assert.equal(init?.method??'GET','GET');const response=new Response(new ReadableStream({}),{status:302});reader=response.body.getReader();return response;
 }};
 await assert.rejects(()=>processNotificationJob({notification_id:note},createApp(h.db,h.env,()=>now)),e=>e?.status===503&&e.code==='push_provider_redirect_denied');
 await reader.cancel();reader.releaseLock();assert.equal((await h.db.one('SELECT status FROM notification_jobs WHERE notification_id=?',note)).status,'ambiguous');
});

pgliteTest('a synchronous cancellation throw cannot replace the redirect denial',{timeout:30000},async t=>{
 const h=await setup(t);let cancellations=0;
 h.env.PUSH_SERVICE={fetch:async(_url,init)=>{
  assert.equal(init?.method??'GET','GET');const body=new ReadableStream({});
  Object.defineProperty(body,'cancel',{value:()=>{cancellations++;throw Error('synthetic_sync_cancel_failure')}});
  return new Response(body,{status:302});
 }};
 await assert.rejects(()=>processNotificationJob({notification_id:note},createApp(h.db,h.env,()=>now)),e=>e?.status===503&&e.code==='push_provider_redirect_denied');
 assert.equal(cancellations,1);assert.equal((await h.db.one('SELECT status FROM notification_jobs WHERE notification_id=?',note)).status,'ambiguous');
});
