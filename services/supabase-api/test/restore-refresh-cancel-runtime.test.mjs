/** Prepared root-owned actual-PG qualification: synthetic tokens/face fixtures,
 * independent in-memory journal. Not hosted recovery or provider evidence. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createApp,createHandler} from '../src/index.ts';
import {restoreOperationID} from '../src/restore-transaction.ts';
import {enroll,encode,faceVerifierFixture,stable,captureProofs} from './runtime-harness.mjs';
import {fixture,unavailable} from './restore-database-fixture.mjs';
const protocol='lovelies-refresh-delivery-v1';
const id=token=>JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString()).jti;
const intent=person=>({protocol,rotation_key:randomUUID(),delivery_secret:encode(crypto.getRandomValues(new Uint8Array(32))),refresh_token:person.refresh_token});
const sessionFact=(account,id)=>({kind:'session-retired',scope:{account_id:account,session_id:id}});
const sorted=facts=>[...facts].sort((a,b)=>stable(a)<stable(b)?-1:stable(a)>stable(b)?1:0);
async function setup(t,{registered=false,delivered=false}={}){
 const f=await fixture(t),h=f.h;h.env.FACE_AUTH_VERIFIER={fetch:async request=>{const form=await request.formData();return Response.json(await faceVerifierFixture(JSON.parse(String(form.get('envelope'))),form));}};
 const person=registered?await enroll(h):await h.anonymous({adult:true});
 const account=person.accountId??person.account_id,oldID=id(person.access_token??person.token),request=intent(person);
 const next=delivered?await h.json('/auth/session/refresh',{body:request}):null;
 let clock=h.app.now();const handler=createHandler(createApp(f.db,h.env,()=>clock));
 const send=async(body=request)=>{const response=await handler(new Request('https://api.invalid/auth/session/refresh/cancel',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));const bodyValue=await response.json();return {status:response.status,body:bodyValue};};
 const operation=()=>restoreOperationID(account,'auth.refresh-cancel-v1','refresh.cancel:'+oldID);
 // PGlite is a single engine: both invocations use one fenced adapter queue.
 // Native PostgreSQL retains the original independent-pool race.
 const refresh=body=>h.databaseUrl?h.request('/auth/session/refresh',{body}):handler(new Request('https://api.invalid/auth/session/refresh',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
 return {...f,person,account,oldID,request,next,nextID:next?id(next.access_token):null,send,refresh,operation,setClock:value=>{clock=value;}};
}
async function domain(f){const result={};for(const table of ['accounts','sessions','refresh_delivery_receipts','auth_devices','face_profile_operations','auth_challenges','consents','push_devices','notification_deliveries']){
 const order=table==='refresh_delivery_receipts'?'original_session_id':table==='face_profile_operations'?'account_id,operation_key':'id';result[table]=await f.h.db.all('SELECT * FROM '+table+' ORDER BY '+order);}return result;}
async function expectedPlan(f,extra=[]){const saved=await f.journal.lookup(await f.operation());assert(saved&&saved.status==='committed');assert.deepEqual(saved.plan.allocations,{});
 const facts=[sessionFact(f.account,f.oldID),...(f.nextID?[sessionFact(f.account,f.nextID)]:[]),...extra];
 assert.deepEqual(saved.plan.events.map(({kind,scope})=>({kind,scope})),sorted(facts));
 const raw=JSON.stringify(saved.plan);for(const value of [f.request.refresh_token,f.request.delivery_secret,f.next?.refresh_token].filter(Boolean))assert(!raw.includes(value));
 for(const field of ['refresh_hash','secret_hash','delivery_secret','refresh_token','ciphertext','iv','token_value'])assert(!raw.includes('"'+field+'"'));
 return saved;}
async function answer(f){const response=await f.send();assert.equal(response.status,200,response.body?.error?.code);assert.deepEqual(response.body,{protocol,rotation_key:f.request.rotation_key,account_id:f.account,status:'cancelled'});}
for(const registered of [false,true])for(const delivered of [false,true])test(`cancel journals exact original${delivered?' and named successor':''} for ${registered?'registered':'anonymous'} authority`,async t=>{
 const f=await setup(t,{registered,delivered});await answer(f);const saved=await expectedPlan(f);
 const old=await f.h.db.one('SELECT * FROM sessions WHERE id=?',f.oldID);assert(old.revoked_at!==null&&old.refresh_consumed_at!==null);
 if(f.nextID){const next=await f.h.db.one('SELECT * FROM sessions WHERE id=?',f.nextID);assert(next.revoked_at!==null&&next.refresh_consumed_at!==null);}
 const terminal=await domain(f);await answer(f);assert.deepEqual(await domain(f),terminal);assert.deepEqual(await f.journal.lookup(await f.operation()),saved);
});
test('consumed named successor and independent next session remain untouched while O and N are journaled',async t=>{
 const f=await setup(t,{registered:true,delivered:true}),nextRequest=intent(f.next);const second=await f.h.json('/auth/session/refresh',{body:nextRequest}),before=await domain(f);
 const secondID=id(second.access_token),secondBefore=before.sessions.find(row=>row.id===secondID),consumedBefore=before.sessions.find(row=>row.id===f.nextID);
 assert(consumedBefore.revoked_at!==null&&consumedBefore.refresh_consumed_at!==null);assert.equal(secondBefore.revoked_at,null);
 await answer(f);await expectedPlan(f);const after=await domain(f);
 assert.deepEqual(after.sessions,before.sessions);assert.deepEqual(after.sessions.find(row=>row.id===secondID),secondBefore);
 await f.h.json('/me',{token:second.access_token});
});
test('incorrect delivery capability never registers journal restrictions or mutates data',async t=>{
 const f=await setup(t,{delivered:true}),before=await domain(f),head=(await f.journal.control()).marker.cursor;
 const bad={...f.request,delivery_secret:encode(crypto.getRandomValues(new Uint8Array(32)))};assert.equal((await f.send(bad)).status,401);
 assert.deepEqual(await domain(f),before);assert.equal(await f.journal.lookup(await f.operation()),null);assert.deepEqual((await f.journal.control()).marker.cursor,head);
});
test('inconsistent successor generation fails closed before domain mutation',async t=>{
 const f=await setup(t,{registered:true,delivered:true});await f.h.db.run('UPDATE sessions SET auth_epoch=auth_epoch+1 WHERE id=?',f.nextID);
 const before=await domain(f),head=(await f.journal.control()).marker.cursor;const response=await f.send();assert.equal(response.status,409);assert.equal(response.body.error.code,'refresh_cancel_metadata_invalid');
 assert.deepEqual(await domain(f),before);assert.equal(await f.journal.lookup(await f.operation()),null);assert.deepEqual((await f.journal.control()).marker.cursor,head);
});
test('changed named session after fact registration rolls back tentative changes',async t=>{
 const f=await setup(t,{delivered:true}),before=await domain(f),original=f.db.one.bind(f.db);let calls=0;
 f.db.one=async(sql,...args)=>{const row=await original(sql,...args);if(sql==='SELECT * FROM sessions WHERE id=? AND account_id=?'&&args[0]===f.nextID&&++calls===2)return {...row,refresh_hash:'f'.repeat(64)};return row;};
 const response=await f.send();assert.equal(response.status,409);assert.equal(response.body.error.code,'refresh_cancel_authority_changed');assert.equal(calls,2);
 assert.deepEqual(await domain(f),before);assert.equal(await f.journal.lookup(await f.operation()),null);
});
for(const mode of ['outage','prepare-before','prepare-after','commit-result-loss','ack-before','ack-after'])test('refresh cancellation '+mode+' preserves its actual commit and independent journal boundary',async t=>{
 const f=await setup(t,{delivered:true}),before=await domain(f),operation=await f.operation();let atCommit;
 if(mode==='outage')f.faults.control=true;else if(mode.startsWith('prepare-'))f.faults.reply={path:'/v1/operations/prepare',stage:mode.slice(8)};
 else if(mode==='commit-result-loss'){const prepare=f.journal.prepare.bind(f.journal);f.journal.prepare=async value=>{const saved=await prepare(value);if(value.operation_id===operation){f.faults.commitReply=true;f.faults.afterCommit=async()=>{delete f.faults.afterCommit;atCommit=await f.journal.lookup(operation);};}return saved;};}
 else f.faults.reply={path:'/v1/operations/'+operation+'/acknowledge',stage:mode.slice(4)};
 const response=await f.send();assert(response.status>=500&&response.status<=599);const saved=await f.journal.lookup(operation);
 if(mode==='outage'||mode==='prepare-before'){assert.deepEqual(await domain(f),before);assert.equal(saved,null);f.faults.control=false;await answer(f);await expectedPlan(f);return;}
 if(mode==='prepare-after'){assert.deepEqual(await domain(f),before);assert.equal(saved.status,'pending');await assert.rejects(()=>f.db.one('SELECT id FROM accounts LIMIT 1'),unavailable);return;}
 assert.equal((await f.h.db.one('SELECT state FROM refresh_delivery_receipts WHERE original_session_id=?',f.oldID)).state,'cancelled');
 if(mode==='commit-result-loss'){assert.equal(atCommit.status,'pending');assert.equal(saved.status,'committed');}else assert.equal(saved.status,mode==='ack-before'?'pending':'committed');
 const terminal=await domain(f);await answer(f);assert.deepEqual(await domain(f),terminal);assert.equal((await f.journal.lookup(operation)).status,'committed');
});
async function seedPending(f,count,{duplicate=false}={}){
 const old=await f.h.db.one('SELECT * FROM sessions WHERE id=?',f.oldID),device=await f.h.db.one('SELECT * FROM auth_devices WHERE id=?',old.device_id),ids=[];
 for(let i=0;i<count;i++){const consent=randomUUID(),op=randomUUID();ids.push(consent);
  await f.h.db.run("INSERT INTO consents(id,account_id,purpose,policy_version,status,created_at,profile_revision) VALUES(?,?,'face_authentication','face-policy-fixture-v1','granted',?,?)",consent,f.account,f.h.app.now(),old.face_profile_revision);
  await f.h.db.run("INSERT INTO face_profile_operations(account_id,operation_key,action,input_hash,expected_version,control_device_id,control_revision,state,auth_epoch,consent_id,generation,created_at,expires_at) VALUES(?,?,'replace',?,1,?,?,'pending',?,?,0,?,?)",f.account,op,'a'.repeat(64),device.id,device.revision,old.auth_epoch,consent,f.h.app.now(),f.h.app.now()+86400000);
 }
 if(duplicate&&ids.length)await f.h.db.run("INSERT INTO face_profile_operations(account_id,operation_key,action,input_hash,expected_version,control_device_id,control_revision,state,auth_epoch,consent_id,generation,created_at,expires_at) VALUES(?,?,'replace',?,1,?,?,'pending',?,?,0,?,?)",f.account,randomUUID(),'a'.repeat(64),device.id,device.revision,old.auth_epoch,ids[0],f.h.app.now(),f.h.app.now()+86400000);
 return ids;
}
for(const count of [31,32])test(`pre-dispatch cancellation ${count===31?'accepts exact 32-fact limit with deduplicated consent':'rejects 33 facts before effects'}`,async t=>{
 const f=await setup(t,{registered:true}),ids=await seedPending(f,count,{duplicate:count===31}),before=await domain(f);
 if(count===32){const response=await f.send();assert.equal(response.status,503);assert.equal(response.body.error.code,'refresh_cancel_restriction_capacity');assert.deepEqual(await domain(f),before);assert.equal(await f.journal.lookup(await f.operation()),null);return;}
 await answer(f);await expectedPlan(f,ids.map(consent=>({kind:'consent-withdrawn',scope:{account_id:f.account,consent_id:consent,purpose:'face_authentication'}})));
 const rows=await f.h.db.all("SELECT id,status FROM consents WHERE account_id=? AND purpose='face_authentication' ORDER BY id",f.account);
 for(const consent of ids)assert.equal(rows.find(row=>row.id===consent).status,'revoked');
});
test('SQL commit rejected after journal acceptance keeps plan pending and fences unsafe callback replay',async t=>{
 const f=await setup(t,{delivered:true}),before=await domain(f),operation=await f.operation(),prepare=f.journal.prepare.bind(f.journal);let armed=true;
 f.journal.prepare=async value=>{const saved=await prepare(value);if(armed&&value.operation_id===operation){armed=false;f.faults.beforeCommit=true;}return saved;};
 const response=await f.send();assert(response.status>=500&&response.status<=599);assert.equal(armed,false);assert.deepEqual(await domain(f),before);
 assert.equal((await f.journal.lookup(operation)).status,'pending');await assert.rejects(()=>f.db.one('SELECT id FROM accounts LIMIT 1'),unavailable);
});

for(const mode of ['pre-dispatch','delivered'])for(const field of ['account','original','receipt',...(mode==='delivered'?['successor']:[])])test(`terminal ${mode} detects ${field} drift after tentative writes and rolls back`,async t=>{
 const f=await setup(t,{registered:true,delivered:mode==='delivered'}),before=await domain(f),run=f.db.run.bind(f.db);let injected=false;
 f.db.run=async(sql,...args)=>{await run(sql,...args);
  const trigger=mode==='pre-dispatch'?sql.includes('INSERT INTO refresh_delivery_receipts'):sql.includes("UPDATE refresh_delivery_receipts SET state='cancelled'");
  if(!injected&&trigger){injected=true;
   if(field==='account')await run("UPDATE accounts SET roles_json='[\"admin\",\"user\"]' WHERE id=?",f.account);
   else if(field==='original')await run('UPDATE sessions SET refresh_hash=? WHERE id=?','a'.repeat(64),f.oldID);
   else if(field==='successor')await run('UPDATE sessions SET refresh_hash=? WHERE id=?','b'.repeat(64),f.nextID);
   else await run('UPDATE refresh_delivery_receipts SET rotation_key=? WHERE original_session_id=?',randomUUID(),f.oldID);
  }
 };
 const response=await f.send();assert(injected);assert.equal(response.status,409);assert.equal(response.body.error.code,'refresh_cancel_authority_changed');
 assert.deepEqual(await domain(f),before);assert.equal(await f.journal.lookup(await f.operation()),null);
});
test('pre-dispatch refresh expiry immediately after tentative writes rolls back even when access expiry was allowed',async t=>{
 const f=await setup(t,{registered:true}),old=await f.h.db.one('SELECT * FROM sessions WHERE id=?',f.oldID),before=await domain(f),run=f.db.run.bind(f.db);let injected=false;
 f.setClock(old.expires_at);assert(old.refresh_expires_at>old.expires_at);
 f.db.run=async(sql,...args)=>{await run(sql,...args);if(!injected&&sql.includes('INSERT INTO refresh_delivery_receipts')){injected=true;f.setClock(old.refresh_expires_at);}};
 const response=await f.send();assert(injected);assert.equal(response.status,401);assert.deepEqual(await domain(f),before);assert.equal(await f.journal.lookup(await f.operation()),null);
});
async function loginPeer(f){
 const challenge=await f.h.json('/auth/face/challenge',{body:{face_handle:f.person.faceHandle,device_id:f.person.deviceId}},201);
 return f.h.json('/auth/face/complete',{body:await captureProofs(f.h,challenge,f.person.keys.privateKey)});
}
test('multiple same-device peers are fully compared when lifecycle work is absent',async t=>{
 const f=await setup(t,{registered:true,delivered:true}),p1=await loginPeer(f),p2=await loginPeer(f),before=await domain(f),all=f.db.all.bind(f.db);let calls=0;
 const peers=[id(p1.access_token),id(p2.access_token)].sort();
 f.db.all=async(sql,...args)=>{const rows=await all(sql,...args);if(sql.includes('id<>? AND revoked_at IS NULL ORDER BY id')&&args[2]===f.nextID){calls++;
  if(calls===2){assert(peers.every(peer=>rows.some(row=>row.id===peer)));return rows.map(row=>row.id===peers[0]?{...row,device_revision:randomUUID()}:row);}}
  return rows;};
 const response=await f.send();assert.equal(calls,2);assert.equal(response.status,409);assert.equal(response.body.error.code,'refresh_cancel_authority_changed');
 assert.deepEqual(await domain(f),before);assert.equal(await f.journal.lookup(await f.operation()),null);
});
for(const count of [30,31])test(`delivered cancellation preserves ${count} pending consents owned by historical same-device peers`,async t=>{
 const f=await setup(t,{registered:true,delivered:true}),ids=await seedPending(f,count),before=await domain(f);
 await answer(f);await expectedPlan(f);const after=await domain(f);
 for(const consent of ids)assert.deepEqual(after.consents.find(row=>row.id===consent),before.consents.find(row=>row.id===consent));
 assert.deepEqual(after.face_profile_operations,before.face_profile_operations);
});
test('concurrent first-dispatch cancel and refresh have one consistent winner',async t=>{
 const f=await setup(t,{registered:true});const [cancel,refresh]=await Promise.all([f.send(),f.refresh(f.request)]);
 const result=await refresh.json();assert.equal(cancel.status,200);assert([200,401].includes(refresh.status));
 const receipt=await f.h.db.one('SELECT * FROM refresh_delivery_receipts WHERE original_session_id=?',f.oldID);assert.equal(receipt.state,'cancelled');
 if(refresh.status===200){f.nextID=id(result.access_token);assert.equal(receipt.successor_session_id,f.nextID);}else assert.equal(receipt.successor_session_id,null);
 await expectedPlan(f);
});
test('concurrent delivered cancellation and next refresh preserves independent later session when issued',async t=>{
 const f=await setup(t,{registered:true,delivered:true}),nextRequest=intent(f.next);
 const [cancel,refresh]=await Promise.all([f.send(),f.refresh(nextRequest)]);const result=await refresh.json();
 assert.equal(cancel.status,200);assert([200,401].includes(refresh.status));await expectedPlan(f);
 if(refresh.status===200){const later=await f.h.db.one('SELECT * FROM sessions WHERE id=?',id(result.access_token));assert(later&&later.revoked_at===null&&later.refresh_consumed_at===null);}
});
test('a same-device peer changed after tentative writes causes complete rollback',async t=>{
 const f=await setup(t,{registered:true,delivered:true}),peer=await loginPeer(f),peerID=id(peer.access_token),before=await domain(f),run=f.db.run.bind(f.db);let injected=false;
 f.db.run=async(sql,...args)=>{await run(sql,...args);if(!injected&&sql.includes("UPDATE refresh_delivery_receipts SET state='cancelled'")){
   injected=true;await run('UPDATE sessions SET device_revision=? WHERE id=?',randomUUID(),peerID);
 }};
 const response=await f.send();assert(injected);assert.equal(response.status,409);assert.equal(response.body.error.code,'refresh_cancel_authority_changed');
 assert.deepEqual(await domain(f),before);assert.equal(await f.journal.lookup(await f.operation()),null);
});
test('pre-dispatch cancellation permits expired access while refresh remains current',async t=>{
 const f=await setup(t,{registered:true}),old=await f.h.db.one('SELECT * FROM sessions WHERE id=?',f.oldID);
 assert(old.refresh_expires_at>old.expires_at);f.setClock(old.expires_at);await answer(f);await expectedPlan(f);
});
test('already delivered capability cancellation does not require a current refresh session',async t=>{
 const f=await setup(t,{registered:true,delivered:true}),old=await f.h.db.one('SELECT * FROM sessions WHERE id=?',f.oldID);
 f.setClock(old.refresh_expires_at+1);await answer(f);await expectedPlan(f);
});
