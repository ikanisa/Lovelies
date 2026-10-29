import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startHarness} from './runtime-harness.mjs';
import {AuthenticatedService} from '../src/service-fetcher.ts';
import {createApp} from '../src/index.ts';
import {processNotificationJob} from '../src/notifications.ts';
const localTest=process.env.TEST_DATABASE_URL===undefined?test:test.skip;
const now=1700000000000,account='00000000-0000-4000-8000-000000000001',note='00000000-0000-4000-8000-000000000002';
const auth='00000000-0000-4000-8000-000000000003',device='00000000-0000-4000-8000-000000000004',delivery='00000000-0000-4000-8000-000000000005';
for(const state of ['queued','ambiguous'])localTest(`actual push consumer keeps a redirected ${state} operation ambiguous`,{timeout:30000},async t=>{
 assert.equal(process.env.TEST_DATABASE_URL,undefined);const h=await startHarness({consumeQueue:false});t.after(()=>h.close());
 await h.db.run("INSERT INTO accounts(id,name,created_at,identity_state) VALUES(?,'Synthetic',?,'registered_face')",account,now);
 await h.db.run("INSERT INTO notifications(id,account_id,kind,entity_id,title,created_at) VALUES(?,?,'support','synthetic','Synthetic',?)",note,account,now);
 await h.db.run("INSERT INTO notification_jobs(notification_id,account_id,auth_epoch,status,created_at) VALUES(?,?,1,?,?)",note,account,state,now);
 await h.db.run("INSERT INTO auth_devices(id,account_id,public_jwk,revision,status,created_at) VALUES(?,?,?,'synthetic','active',?)",auth,account,'{}',now);
 await h.db.run("INSERT INTO push_devices(id,account_id,auth_device_id,platform,token_hash,token_value,active,created_at,updated_at) VALUES(?,?,?,'android',?,'synthetic-token-0001',1,?,?)",device,account,auth,'a'.repeat(64),now,now);
 await h.db.run('INSERT INTO notification_deliveries(id,notification_id,device_id,operation_key,status,token_hash,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)',delivery,note,device,'notification:'+note+':'+device,state,'a'.repeat(64),now,now);
 let calls=0,cancels=0,method;
 h.env.PUSH_SERVICE=new AuthenticatedService('https://private.invalid','synthetic-private-service-secret-32-characters',async request=>{
  calls++;method=request.method;assert.equal(request.redirect,'manual');const body=new ReadableStream({});
  Object.defineProperty(body,'cancel',{value:()=>{cancels++;throw Error('synthetic-cancel-throw');}});
  return new Response(body,{status:302,headers:{location:'https://untrusted.invalid'}});
 },1000);
 await assert.rejects(()=>processNotificationJob({notification_id:note},createApp(h.db,h.env,()=>now)),e=>e?.status===503&&e?.code==='private_service_redirect_denied');
 assert.equal(calls,1);assert.equal(cancels,1);assert.equal(method,state==='queued'?'POST':'GET');
 assert.equal((await h.db.one('SELECT status FROM notification_jobs WHERE notification_id=?',note)).status,'ambiguous');
 assert.deepEqual(await h.db.one('SELECT status,provider_receipt,lease_token FROM notification_deliveries WHERE id=?',delivery),{status:'ambiguous',provider_receipt:null,lease_token:null});
});
