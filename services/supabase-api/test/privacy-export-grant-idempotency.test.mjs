/** Synthetic one-subject PGlite only. No real database, provider or network. */
import assert from 'node:assert/strict';
import {after,test as nodeTest} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createApp,createHandler} from '../src/index.ts';
import {restoreOperationID} from '../src/restore-transaction.ts';
import {pruneRetainedMetadata} from '../src/retention.ts';
import {stable} from '../src/types.ts';
import {startHarness,enroll,captureProofs,faceVerifierFixture,sha256} from './runtime-harness.mjs';
import {fixture as fencedFixture} from './restore-database-fixture.mjs';

// The PostgreSQL lane skips this synthetic PGlite-only suite. Its dedicated
// offline CI step removes TEST_DATABASE_URL and installs the network guard.
const test=process.env.TEST_DATABASE_URL===undefined?nodeTest:nodeTest.skip;
if(process.env.TEST_DATABASE_URL===undefined){
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async()=>{throw Error('external_fetch_prohibited');};
 after(()=>{globalThis.fetch=originalFetch;});
}
const DAY=86400000;
const requestBody=(key)=>({operation_key:key});

async function seedExport(h,owner,existingID){
 const id=existingID??randomUUID(),now=h.app.now(),key=`synthetic/${owner.accountId}/privacy/${id}`;
 const bytes=new TextEncoder().encode('{"synthetic":"private export"}'),hash=await sha256(bytes),expires=now+DAY;
 if(existingID)await h.db.run("UPDATE privacy_requests SET status='completed',completed_at=?,export_key=?,export_sha256=?,export_bytes=?,export_expires_at=? WHERE id=?",now,key,hash,bytes.length,expires,id);
 else await h.db.run("INSERT INTO privacy_requests(id,subject_id,requested_by,request_type,status,created_at,expires_at,completed_at,export_key,export_sha256,export_bytes,export_expires_at) VALUES(?,?,?,'export','completed',?,?,?,?,?,?,?)",id,owner.accountId,owner.accountId,now,expires,now,key,hash,bytes.length,expires);
 await h.db.run("INSERT INTO privacy_exports(id,request_id,subject_id,object_key,sha256,bytes,expires_at,status,created_at) VALUES(?,?,?,?,?,?,?,'published',?)",randomUUID(),id,owner.accountId,key,hash,bytes.length,expires,now);
 await h.env.PRIVACY_EXPORTS.put(key,bytes);
 return {id,key,bytes,expires};
}
async function setup(t){
 assert.equal(process.env.TEST_DATABASE_URL,undefined,'external database prohibited');
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});t.after(()=>h.close());
 const owner=await enroll(h),exp=await seedExport(h,owner),key=randomUUID();
 const grant=(request=exp.id,operation=key,token=owner.token)=>h.request(`/privacy-exports/${request}/grant`,{token,body:requestBody(operation)});
 const lookup=(operation=key,token=owner.token)=>h.request(`/privacy/operations/${operation}`,{token});
 const row=(operation=key)=>h.db.one("SELECT action,payload_hash,payload_json,response_json FROM operations WHERE actor_id=? AND source='privacy' AND operation_key=?",owner.accountId,operation);
 const grants=()=>h.db.all('SELECT * FROM privacy_export_grants WHERE subject_id=? ORDER BY id',owner.accountId);
 return {h,owner,exp,key,grant,lookup,row,grants};
}
async function body(response,status){const value=await response.json();assert.equal(response.status,status,'unexpected response status');return value;}
function tokenOf(value){const url=new URL(value.grant_path,'https://api.invalid');assert.equal(url.pathname,'/privacy-exports/retrieve');assert.equal([...url.searchParams.keys()].join(','),'grant');return url.searchParams.get('grant');}

// A successful result can be recovered without storing its bearer in operation JSON.
test('keyed grant and privacy lookup replay the same one-use result without plaintext persistence',{timeout:30000},async t=>{
 const f=await setup(t),first=await body(await f.grant(),200),token=tokenOf(first);assert(/^[A-Za-z0-9_-]{43}$/.test(token),'expected opaque grant token');
 assert.equal(first.request_id,f.exp.id);assert.equal(stable(await body(await f.lookup(),200))===stable(first),true);assert.equal(stable(await body(await f.grant(),200))===stable(first),true);
 const row=await f.row(),grants=await f.grants(),stored=JSON.stringify({row,grants});assert.equal(grants.length,1);
 assert.equal(row.action,'privacy.export.grant');assert(!stored.includes(token));assert(!stored.includes(first.grant_path));
 const receipt=JSON.parse(row.response_json);assert.equal(receipt.protocol,'lovelies-privacy-export-grant-v1');
 assert.equal(receipt.token_hash,await sha256(new TextEncoder().encode(token)));assert.equal(receipt.session_id,grants[0].session_id);
 assert.equal(receipt.request_id,f.exp.id);assert.equal(receipt.grant_id,grants[0].id);
});

test('a lost committed grant reply is recovered by original key without another grant',{timeout:30000},async t=>{
 const f=await setup(t),run=f.h.db.run,transaction=f.h.db.transaction;let marked=false,injected=false,depth=0;
 f.h.db.run=async function(sql,...args){const value=await run.call(this,sql,...args);if(sql.startsWith('INSERT INTO operations(')&&args[2]===f.key)marked=true;return value;};
 f.h.db.transaction=async function(callback,intent){depth++;let value;try{value=await transaction.call(this,callback,intent);}finally{depth--;}
  if(depth===0&&marked&&!injected){injected=true;throw Error('synthetic_committed_reply_lost');}return value;};
 try{const lost=await f.grant();assert(lost.status>=500);await lost.body?.cancel();assert(injected);}finally{f.h.db.run=run;f.h.db.transaction=transaction;}
 assert(await f.row());assert.equal((await f.grants()).length,1);
 const recovered=await body(await f.lookup(),200);assert.equal(stable(await body(await f.grant(),200))===stable(recovered),true);assert.equal((await f.grants()).length,1);
});

test('changed request and same-account session reject the old key without creating another grant',{timeout:30000},async t=>{
 const f=await setup(t),first=await body(await f.grant(),200),second=await seedExport(f.h,f.owner);
 assert.equal((await body(await f.grant(second.id),409)).error.code,'operation_key_conflict');
 const challenge=await f.h.json('/auth/face/challenge',{body:{face_handle:f.owner.faceHandle,device_id:f.owner.deviceId}},201);
 const next=await f.h.json('/auth/face/complete',{body:await captureProofs(f.h,challenge,f.owner.keys.privateKey)});
 assert.equal(next.account_id,f.owner.accountId);assert.notEqual(next.access_token,f.owner.token);
 assert.equal((await body(await f.lookup(f.key,next.access_token),409)).error.code,'privacy_export_grant_session_changed');
 assert.equal((await body(await f.grant(f.exp.id,f.key,next.access_token),409)).error.code,'privacy_export_grant_session_changed');
 assert.equal((await f.grants()).length,1);assert.equal(stable(await body(await f.lookup(),200))===stable(first),true);
});

test('expired grants cannot be recovered or replayed as live',{timeout:30000},async t=>{
 const f=await setup(t),first=await body(await f.grant(),200);f.h.app.now=()=>Date.parse(first.expires_at)+1;
 const expired=await body(await f.lookup(),200);assert.equal(expired.protocol,'lovelies-privacy-export-grant-expired-v1');assert.equal(expired.status,'expired');assert.equal(expired.expires_at,first.expires_at);
 assert.equal((await body(await f.grant(),503)).error.code,'privacy_export_grant_reconciliation_required');assert.equal((await f.grants()).length,1);
});

test('consumed grants cannot be recovered and survive legacy cleanup until expiry',{timeout:30000},async t=>{
 const f=await setup(t),first=await body(await f.grant(),200);
 const response=await f.h.request(first.grant_path,{token:f.owner.token});assert.equal(response.status,200);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),f.exp.bytes);
 assert.equal((await body(await f.lookup(),410)).error.code,'privacy_export_grant_unavailable');
 assert.equal((await body(await f.grant(),410)).error.code,'privacy_export_grant_unavailable');
 const next=await seedExport(f.h,f.owner);assert.equal((await f.h.request(`/privacy-exports/${next.id}/grant`,{token:f.owner.token,body:{}})).status,200);
 const original=(await f.grants()).find(x=>x.request_id===f.exp.id);assert(original&&original.consumed_at!==null,'legacy cleanup retains consumed row until expiry');
});

test('missing, altered or corrupted stored grant data fails closed and never creates a replacement',{timeout:30000},async t=>{
 const f=await setup(t),first=await body(await f.grant(),200),token=tokenOf(first),saved=await f.row();
 const response=JSON.parse(saved.response_json),cipher=response.ciphertext;
 for(const change of [v=>{v.ciphertext=(cipher[0]==='A'?'B':'A')+cipher.slice(1);},v=>{v.token_hash='0'.repeat(64);},v=>{v.expires_at+=1;},v=>{v.iv='!'.repeat(16);},v=>{v.extra='unexpected';}]){
  const corrupt=structuredClone(response);change(corrupt);
  await f.h.db.run("UPDATE operations SET response_json=? WHERE actor_id=? AND source='privacy' AND operation_key=?",stable(corrupt),f.owner.accountId,f.key);
  for(const call of [()=>f.lookup(),()=>f.grant()]){const r=await call();const text=await r.text();assert.equal(r.status,503);assert(!text.includes(token));assert.equal(JSON.parse(text).error.code,'privacy_export_grant_reconciliation_required');}
  assert.equal((await f.grants()).length,1);
 }
 await f.h.db.run("UPDATE operations SET response_json=?,payload_hash=? WHERE actor_id=? AND source='privacy' AND operation_key=?",saved.response_json,'0'.repeat(64),f.owner.accountId,f.key);
 assert.equal((await body(await f.grant(),503)).error.code,'privacy_export_grant_reconciliation_required');
 await f.h.db.run("UPDATE operations SET payload_hash=? WHERE actor_id=? AND source='privacy' AND operation_key=?",saved.payload_hash,f.owner.accountId,f.key);
 const original=(await f.grants())[0];await f.h.db.run('DELETE FROM privacy_export_grants WHERE id=?',original.id);
 assert.equal((await body(await f.lookup(),503)).error.code,'privacy_export_grant_reconciliation_required');
 assert.equal((await body(await f.grant(),503)).error.code,'privacy_export_grant_reconciliation_required');assert.equal((await f.grants()).length,0);
});

test('legacy no-key grants remain usable and do not create a keyed operation',{timeout:30000},async t=>{
 const f=await setup(t),r=await f.h.request(`/privacy-exports/${f.exp.id}/grant`,{token:f.owner.token,body:{}}),value=await body(r,200);
 assert.deepEqual(Object.keys(value).sort(),['expires_at','grant_path','request_id']);assert.equal(value.request_id,f.exp.id);assert(tokenOf(value));assert.equal(await f.row(),null);
 const download=await f.h.request(value.grant_path,{token:f.owner.token});assert.equal(download.status,200);assert.deepEqual(new Uint8Array(await download.arrayBuffer()),f.exp.bytes);
});

test('privacy request operation receipt coexists while a reused key remains unresolved',{timeout:30000},async t=>{
 const f=await setup(t),createKey=randomUUID(),created=await f.h.json('/privacy/export',{token:f.owner.token,body:{operation_key:createKey}},201);
 const second=await seedExport(f.h,f.owner,created.privacy_request.id),before=await body(await f.lookup(createKey),200);
 assert.deepEqual(before,created);assert.equal((await body(await f.grant(second.id,createKey),503)).error.code,'privacy_export_grant_reconciliation_required');
 assert.deepEqual(await body(await f.lookup(createKey),200),before);assert.equal((await f.grants()).length,0);
 const value=await body(await f.grant(second.id),200);assert.equal(value.request_id,second.id);assert.equal(stable(await body(await f.lookup(),200))===stable(value),true);
});

test('expired grant receipt retention honors holds and verifies encrypted receipt binding',{timeout:30000},async t=>{
 const f=await setup(t);await body(await f.grant(),200);const before=await f.row(),now=f.h.app.now();
 await f.h.db.run("UPDATE privacy_requests SET completed_at=? WHERE id=?",now-366*DAY,f.exp.id);
 await f.h.db.run("UPDATE privacy_exports SET status='retired' WHERE request_id=?",f.exp.id);
 f.h.app.now=()=>now+301000;
 await f.h.db.run("INSERT INTO retention_settings(id,version,raw_days,preview_days,face_crop_days,free_cache_days,audit_days,legal_hold,updated_at) VALUES('default',1,60,60,14,2,30,1,?) ON CONFLICT(id) DO UPDATE SET legal_hold=1",now);
 await pruneRetainedMetadata(f.h.app);assert.deepEqual(await f.row(),before);
 await f.h.db.run("UPDATE retention_settings SET legal_hold=0 WHERE id='default'");
 const oldSecret=f.h.env.AUTH_SIGNING_SECRET;f.h.env.AUTH_SIGNING_SECRET='synthetic-rotated-auth-secret-more-than-32-characters';
 await pruneRetainedMetadata(f.h.app);assert.deepEqual(await f.row(),before,'unavailable old key preserves encrypted evidence');
 f.h.env.AUTH_SIGNING_SECRET=oldSecret;
 for(let attempt=0;attempt<3;attempt++)await pruneRetainedMetadata(f.h.app);
 const retired=await f.row();assert.equal(retired.payload_json,'null');assert.equal(JSON.parse(retired.response_json).status,'retired');
});

test('unknown privacy operation remains unknown without issuing a grant',{timeout:30000},async t=>{
 const f=await setup(t);assert.deepEqual(await body(await f.lookup(),200),{status:'unknown'});assert.equal((await f.grants()).length,0);
});

async function fenced(t){
 assert.equal(process.env.TEST_DATABASE_URL,undefined,'external database prohibited');
 const f=await fencedFixture(t),h=f.h;h.env.FACE_AUTH_VERIFIER={fetch:async request=>{const form=await request.formData();return Response.json(await faceVerifierFixture(JSON.parse(String(form.get('envelope'))),form));}};
 const owner=await enroll(h),exp=await seedExport(h,owner),key=randomUUID(),handler=createHandler(createApp(f.db,h.env,h.app.now));
 const request=(path,method,body)=>handler(new Request('https://api.invalid'+path,{method,headers:{authorization:'Bearer '+owner.token,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}));
 return {...f,h,owner,exp,key,grant:()=>request(`/privacy-exports/${exp.id}/grant`,'POST',{operation_key:key}),lookup:()=>request(`/privacy/operations/${key}`,'GET'),
  row:()=>h.db.one("SELECT action,payload_hash,payload_json,response_json FROM operations WHERE actor_id=? AND source='privacy' AND operation_key=?",owner.accountId,key),
  grants:()=>h.db.all('SELECT * FROM privacy_export_grants WHERE subject_id=?',owner.accountId)};
}

test('lost fenced COMMIT reply reconciles the exact grant without redispatch',{timeout:30000},async t=>{
 const f=await fenced(t),id=await restoreOperationID(f.owner.accountId,'privacy',f.key),prepare=f.journal.prepare.bind(f.journal);let injected=false;
 f.journal.prepare=async value=>{const result=await prepare(value);if(!injected&&value.operation_id===id){injected=true;f.faults.commitReply=true;}return result;};
 const lost=await f.grant();assert(lost.status>=500);await lost.body?.cancel();assert(injected);const row=await f.row();assert(row);assert.equal((await f.grants()).length,1);
 const recovered=await body(await f.lookup(),200);assert.equal(stable(await body(await f.grant(),200))===stable(recovered),true);assert.deepEqual(await f.row(),row);assert.equal((await f.grants()).length,1);
 assert.equal((await f.journal.lookup(id)).status,'committed');
});

test('lost independent prepare reply fences retries without issuing an additional grant',{timeout:30000},async t=>{
 const f=await fenced(t),id=await restoreOperationID(f.owner.accountId,'privacy',f.key),prepare=f.journal.prepare.bind(f.journal);let injected=false;
 f.journal.prepare=async value=>{if(!injected&&value.operation_id===id){injected=true;f.faults.reply={path:'/v1/operations/prepare',stage:'after'};}return prepare(value);};
 let r=await f.grant();assert(r.status>=500);await r.body?.cancel();assert(injected);assert.equal(await f.row(),null);assert.equal((await f.grants()).length,0);
 assert.equal((await f.journal.lookup(id)).status,'pending');r=await f.grant();assert(r.status>=500);await r.body?.cancel();
 assert.equal(await f.row(),null);assert.equal((await f.grants()).length,0);
});

test('partial grant tombstones fail before conflicts while intact retirement and genuine conflicts remain distinct',{timeout:30000},async t=>{
 const f=await setup(t);await body(await f.grant(),200);const saved=await f.row(),second=await seedExport(f.h,f.owner);
 const challenge=await f.h.json('/auth/face/challenge',{body:{face_handle:f.owner.faceHandle,device_id:f.owner.deviceId}},201);
 const next=await f.h.json('/auth/face/complete',{body:await captureProofs(f.h,challenge,f.owner.keys.privateKey)});
 assert.equal(next.account_id,f.owner.accountId);assert.notEqual(next.access_token,f.owner.token);
 const retired=stable({protocol:'lovelies-operation-retired-v1',status:'retired'});
 const update=async(payload,response)=>f.h.db.run("UPDATE operations SET payload_json=?,response_json=? WHERE actor_id=? AND source='privacy' AND operation_key=?",payload,response,f.owner.accountId,f.key);
 for(const [payload,response] of [['null',saved.response_json],[saved.payload_json,retired]]){
  await update(payload,response);
  for(const call of [()=>f.lookup(),()=>f.grant(),()=>f.grant(second.id),()=>f.grant(f.exp.id,f.key,next.access_token)]){
   assert.equal((await body(await call(),503)).error.code,'privacy_export_grant_reconciliation_required');
  }
  assert.equal((await f.grants()).length,1);
 }
 await update('null',retired);
 assert.equal((await body(await f.lookup(),503)).error.code,'privacy_export_grant_reconciliation_required');
 assert.equal((await body(await f.grant(),410)).error.code,'operation_receipt_retired');
 assert.equal((await body(await f.grant(second.id),503)).error.code,'privacy_export_grant_reconciliation_required');
 assert.equal((await body(await f.grant(f.exp.id,f.key,next.access_token),503)).error.code,'privacy_export_grant_reconciliation_required');
 await update(saved.payload_json,saved.response_json);
 assert.equal((await body(await f.grant(second.id),409)).error.code,'operation_key_conflict');
 assert.equal((await body(await f.grant(f.exp.id,f.key,next.access_token),409)).error.code,'privacy_export_grant_session_changed');
 assert.equal((await f.grants()).length,1);
});


test('a damaged prior action remains unresolved, including a recomputed unkeyed hash',{timeout:30000},async t=>{
 const f=await setup(t),first=await body(await f.grant(),200),token=tokenOf(first),saved=await f.row();
 for(const action of ['privacy.request.export','privacy.request.delete','privacy.review.approve','privacy.unknown']){
  for(const hash of [saved.payload_hash,await sha256(new TextEncoder().encode(stable({action,source:'privacy',payload:JSON.parse(saved.payload_json)})))]){
   await f.h.db.run("UPDATE operations SET action=?,payload_hash=? WHERE actor_id=? AND source='privacy' AND operation_key=?",action,hash,f.owner.accountId,f.key);
   for(const call of [()=>f.lookup(),()=>f.grant()]){
    const response=await call(),text=await response.text();assert.equal(response.status,503);assert.equal(JSON.parse(text).error.code,'privacy_export_grant_reconciliation_required');assert(!text.includes(token));assert(!text.includes('grant_path'));
   }
   assert.equal((await f.grants()).length,1);
  }
 }
 await f.h.db.run("UPDATE operations SET action=?,payload_hash=? WHERE actor_id=? AND source='privacy' AND operation_key=?",saved.action,saved.payload_hash,f.owner.accountId,f.key);
 assert.deepEqual(await body(await f.lookup(),200),first);
});

test('renewed session learns only a verified expired grant status and can issue a fresh key',{timeout:30000},async t=>{
 const f=await setup(t),first=await body(await f.grant(),200),token=tokenOf(first),saved=await f.row();
 const renewed=await f.h.json('/auth/session/refresh',{body:{refresh_token:f.owner.refresh_token}});
 assert.equal(renewed.account_id,f.owner.accountId);assert.notEqual(renewed.access_token,f.owner.token);
 let r=await f.lookup(f.key,renewed.access_token),text=await r.text();assert.equal(r.status,409);assert.equal(JSON.parse(text).error.code,'privacy_export_grant_session_changed');assert(!text.includes(token));
 f.h.app.now=()=>Date.parse(first.expires_at)+1;
 await f.h.db.run("UPDATE operations SET payload_hash=? WHERE actor_id=? AND source='privacy' AND operation_key=?",'0'.repeat(64),f.owner.accountId,f.key);
 r=await f.lookup(f.key,renewed.access_token);text=await r.text();assert.equal(r.status,503);assert.equal(JSON.parse(text).error.code,'privacy_export_grant_reconciliation_required');assert(!text.includes(token));
 await f.h.db.run("UPDATE operations SET payload_hash=? WHERE actor_id=? AND source='privacy' AND operation_key=?",saved.payload_hash,f.owner.accountId,f.key);
 const retired=stable({protocol:'lovelies-operation-retired-v1',status:'retired'});
 await f.h.db.run("UPDATE operations SET payload_json=?,response_json=? WHERE actor_id=? AND source='privacy' AND operation_key=?",'null',retired,f.owner.accountId,f.key);
 r=await f.lookup(f.key,renewed.access_token);text=await r.text();assert.equal(r.status,503);assert.equal(JSON.parse(text).error.code,'privacy_export_grant_reconciliation_required');assert(!text.includes(token));
 await f.h.db.run("UPDATE operations SET payload_json=?,response_json=? WHERE actor_id=? AND source='privacy' AND operation_key=?",saved.payload_json,saved.response_json,f.owner.accountId,f.key);
 r=await f.lookup(f.key,renewed.access_token);text=await r.text();assert.equal(r.status,200);assert(!text.includes(token));assert(!text.includes('grant_path'));
 const expired=JSON.parse(text),claims=JSON.parse(Buffer.from(f.owner.token.split('.')[1],'base64url').toString());
 assert.deepEqual(expired,{protocol:'lovelies-privacy-export-grant-expired-v1',status:'expired',account_id:f.owner.accountId,
  operation_key:f.key,request_id:f.exp.id,session_id:claims.jti,expires_at:first.expires_at});
 r=await f.grant(f.exp.id,f.key,renewed.access_token);text=await r.text();assert.equal(r.status,503);assert.equal(JSON.parse(text).error.code,'privacy_export_grant_reconciliation_required');assert(!text.includes(token));
 const freshKey=randomUUID(),fresh=await body(await f.grant(f.exp.id,freshKey,renewed.access_token),200);
 assert.notEqual(tokenOf(fresh),token);const remaining=await f.grants();assert.equal(remaining.length,2);assert(remaining.every(row=>row.request_id===f.exp.id));
 assert.deepEqual(await body(await f.lookup(f.key,renewed.access_token),200),expired);
});

async function authorityFixture(t){
 const f=await fenced(t),h=f.h,actor=await h.app.authenticate(new Request('https://api.invalid/me',{headers:{authorization:'Bearer '+f.owner.token}}));
 let clock=h.app.now();const initial=clock,context=createApp(f.db,h.env,()=>clock),handler=createHandler(context);
 const request=(path,{method='GET',body,token=f.owner.token}={})=>handler(new Request('https://api.invalid'+path,{method,
  headers:{authorization:'Bearer '+token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}));
 return {...f,actor,context,request,grant:()=>request(`/privacy-exports/${f.exp.id}/grant`,{method:'POST',body:{operation_key:f.key}}),
  lookup:()=>request(`/privacy/operations/${f.key}`),now:()=>clock,advance:value=>{clock=value;},expire:()=>{clock=actor.expiresAt+1;},restoreClock:()=>{clock=initial;}};
}
async function unresolvedGrant(response){
 const text=await response.text();assert.equal(response.status,503);assert.equal(JSON.parse(text).error.code,'privacy_export_grant_outcome_unresolved');assert(!text.includes('grant_path'));
}
async function exactGrantPlan(f){return restoreOperationID(f.owner.accountId,'privacy',f.key);}

test('privacy expiry after journal prepare leaves the accepted plan pending and no SQL grant',{timeout:30000},async t=>{
 const f=await authorityFixture(t),id=await exactGrantPlan(f),prepare=f.journal.prepare.bind(f.journal);let triggered=false;
 f.journal.prepare=async input=>{const saved=await prepare(input);if(input.operation_id===id){triggered=true;f.expire();}return saved;};
 await unresolvedGrant(await f.grant());assert(triggered);const plan=await f.journal.lookup(id);assert.equal(plan.status,'pending');assert.equal((await f.journal.control()).state,'pending');
 assert.equal(await f.row(),null);assert.equal((await f.grants()).length,0);f.restoreClock();
 const retry=await f.grant();assert.equal(retry.status,503);await retry.body?.cancel();assert.deepEqual(await f.journal.lookup(id),plan);assert.equal(await f.row(),null);
});

test('privacy session revocation after journal prepare rolls back SQL and leaves a pending plan',{timeout:30000},async t=>{
 const f=await authorityFixture(t),id=await exactGrantPlan(f),prepare=f.journal.prepare.bind(f.journal);let triggered=false;
 f.journal.prepare=async input=>{const saved=await prepare(input);if(input.operation_id===id){
  await f.db.run('UPDATE sessions SET revoked_at=? WHERE id=? AND account_id=?',f.now(),f.actor.sessionId,f.owner.accountId);triggered=true;
 }return saved;};
 await unresolvedGrant(await f.grant());assert(triggered);assert.equal((await f.journal.lookup(id)).status,'pending');assert.equal(await f.row(),null);assert.equal((await f.grants()).length,0);
 const row=await f.h.db.one('SELECT revoked_at FROM sessions WHERE id=? AND account_id=?',f.actor.sessionId,f.owner.accountId);assert.equal(row.revoked_at,null);
});

test('privacy expiry during SQL commit returns unresolved with a committed journal receipt',{timeout:30000},async t=>{
 const f=await authorityFixture(t),id=await exactGrantPlan(f),prepare=f.journal.prepare.bind(f.journal);let triggered=false;
 f.journal.prepare=async input=>{const saved=await prepare(input);if(input.operation_id===id){f.faults.afterCommit=async()=>{delete f.faults.afterCommit;triggered=true;f.expire();};}return saved;};
 await unresolvedGrant(await f.grant());assert(triggered);const row=await f.row(),plan=await f.journal.lookup(id);assert(row);assert.equal(plan.status,'committed');assert.equal(plan.plan.input_hash,row.payload_hash);assert.equal((await f.grants()).length,1);
 f.restoreClock();const value=await body(await f.lookup(),200);assert(tokenOf(value));assert.deepEqual(await f.row(),row);
});

test('privacy revocation after journal acknowledgement suppresses the committed grant',{timeout:30000},async t=>{
 const f=await authorityFixture(t),id=await exactGrantPlan(f),ack=f.journal.acknowledge.bind(f.journal);let triggered=false;
 f.journal.acknowledge=async(...args)=>{const saved=await ack(...args);if(args[0]===id){f.faults.afterCommit=async()=>{delete f.faults.afterCommit;
  await f.h.db.transaction(()=>f.h.db.run('UPDATE sessions SET revoked_at=? WHERE id=? AND account_id=?',f.now(),f.actor.sessionId,f.owner.accountId));triggered=true;
 };}return saved;};
 await unresolvedGrant(await f.grant());assert(triggered);const row=await f.row(),plan=await f.journal.lookup(id);assert(row);assert.equal(plan.status,'committed');assert.equal(plan.plan.input_hash,row.payload_hash);assert.equal((await f.grants()).length,1);
 const session=await f.h.db.one('SELECT revoked_at FROM sessions WHERE id=? AND account_id=?',f.actor.sessionId,f.owner.accountId);assert.notEqual(session.revoked_at,null);
});

test('privacy expiry during final admitted response suppresses an already committed grant',{timeout:30000},async t=>{
 const f=await authorityFixture(t),id=await exactGrantPlan(f),ack=f.journal.acknowledge.bind(f.journal),admit=f.journal.admission.bind(f.journal);
 let acknowledged=false,count=0,triggered=false;
 f.journal.acknowledge=async(...args)=>{const saved=await ack(...args);if(args[0]===id)acknowledged=true;return saved;};
 f.journal.admission=async(...args)=>{const saved=await admit(...args);if(acknowledged&&++count===3){triggered=true;f.expire();}return saved;};
 await unresolvedGrant(await f.grant());assert(triggered);const row=await f.row(),plan=await f.journal.lookup(id);assert(row);assert.equal(plan.status,'committed');assert.equal(plan.plan.input_hash,row.payload_hash);assert.equal((await f.grants()).length,1);
});

test('a read-only grant receipt suppresses final session expiry without claiming a write',{timeout:30000},async t=>{
 const f=await authorityFixture(t),first=await body(await f.grant(),200),token=tokenOf(first),one=f.db.one.bind(f.db),admit=f.journal.admission.bind(f.journal);let seen=false,triggered=false;
 f.db.one=async(sql,...bindings)=>{const row=await one(sql,...bindings);if(sql==="SELECT action,payload_hash,payload_json,response_json FROM operations WHERE actor_id=? AND source='privacy' AND operation_key=?"&&bindings[0]===f.owner.accountId&&bindings[1]===f.key)seen=true;return row;};
 f.journal.admission=async(...args)=>{const saved=await admit(...args);if(seen&&!triggered){triggered=true;f.expire();}return saved;};
 const r=await f.lookup(),text=await r.text();assert(seen&&triggered);assert.equal(r.status,401);assert.equal(JSON.parse(text).error.code,'session_invalid');assert(!text.includes(token));assert(!text.includes('grant_path'));
});

test('own privacy grant authority does not require active face consent or audience capability',{timeout:30000},async t=>{
 const f=await authorityFixture(t);
 await f.h.db.run("UPDATE consents SET status='revoked',revoked_at=? WHERE account_id=? AND purpose='face_authentication' AND status='granted'",f.now(),f.owner.accountId);
 await f.h.db.run("UPDATE account_audience SET status='suspended' WHERE account_id=?",f.owner.accountId);
 const first=await body(await f.grant(),200);assert(tokenOf(first));assert.deepEqual(await body(await f.lookup(),200),first);
});

test('logout remains terminal without installing privacy grant authority',{timeout:30000},async t=>{
 const f=await authorityFixture(t),r=await f.request('/auth/logout',{method:'POST'});assert.equal(r.status,200);assert.equal((await r.json()).status,'logged_out');
 const session=await f.h.db.one('SELECT revoked_at FROM sessions WHERE id=? AND account_id=?',f.actor.sessionId,f.owner.accountId);assert.notEqual(session.revoked_at,null);
});

test('anonymous own account deletion remains available without the grant postguard',{timeout:30000},async t=>{
 const f=await fencedFixture(t),h=f.h,anonymous=await h.anonymous(),key=randomUUID(),statusToken='lvd_'+randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','');
 const handler=createHandler(createApp(f.db,h.env,h.app.now));
 const r=await handler(new Request('https://api.invalid/privacy/account-deletion',{method:'POST',headers:{authorization:'Bearer '+anonymous.access_token,'content-type':'application/json'},body:JSON.stringify({operation_key:key,status_token:statusToken})}));
 const value=await body(r,201);assert.equal(value.privacy_request.subject_user_id,anonymous.account_id);assert.equal(value.deletion_completed,false);
 const plan=await f.journal.lookup(await restoreOperationID(anonymous.account_id,'privacy',key));assert.equal(plan.status,'committed');
});


test('postcommit session failure remains unresolved even if authority returns before final release',{timeout:30000},async t=>{
 const f=await authorityFixture(t),id=await exactGrantPlan(f),ack=f.journal.acknowledge.bind(f.journal),admit=f.journal.admission.bind(f.journal);
 let acknowledged=false,count=0,expired=false,restored=false;
 f.journal.acknowledge=async(...args)=>{const saved=await ack(...args);if(args[0]===id)acknowledged=true;return saved;};
 f.journal.admission=async(...args)=>{const saved=await admit(...args);
  if(acknowledged&&++count===2){expired=true;f.expire();}
  else if(acknowledged&&count===3){restored=true;f.restoreClock();}
  return saved;};
 await unresolvedGrant(await f.grant());assert(expired&&restored);const row=await f.row(),plan=await f.journal.lookup(id);assert(row);assert.equal(plan.status,'committed');assert.equal(plan.plan.input_hash,row.payload_hash);assert.equal((await f.grants()).length,1);
});


test('consumption is not expiry until the exact authenticated grant deadline has passed',{timeout:30000},async t=>{
 const f=await setup(t),first=await body(await f.grant(),200),token=tokenOf(first),download=await f.h.request(first.grant_path,{token:f.owner.token});
 assert.equal(download.status,200);await download.arrayBuffer();
 let response=await f.lookup(),text=await response.text();assert.equal(response.status,410);assert.equal(JSON.parse(text).error.code,'privacy_export_grant_unavailable');assert(!text.includes(token));
 const renewed=await f.h.json('/auth/session/refresh',{body:{refresh_token:f.owner.refresh_token}});
 response=await f.lookup(f.key,renewed.access_token);text=await response.text();assert.equal(response.status,409);assert(!text.includes(token));
 f.h.app.now=()=>Date.parse(first.expires_at)+1;
 response=await f.lookup(f.key,renewed.access_token);text=await response.text();assert.equal(response.status,200);assert.equal(JSON.parse(text).protocol,'lovelies-privacy-export-grant-expired-v1');assert(!text.includes(token));assert(!text.includes('grant_path'));
 const fresh=await f.h.json('/privacy/export',{token:renewed.access_token,body:{operation_key:randomUUID()}},201);assert.equal(fresh.privacy_request.subject_user_id,f.owner.accountId);
});

test('missing or corrupted expired grant rows and revoked request evidence do not assert exact expiry',{timeout:30000},async t=>{
 const f=await setup(t),first=await body(await f.grant(),200),token=tokenOf(first),row=(await f.grants())[0];f.h.app.now=()=>Date.parse(first.expires_at)+1;
 const check=async(expected,code)=>{const r=await f.lookup(),text=await r.text();assert.equal(r.status,expected);assert.equal(JSON.parse(text).error.code,code);assert(!text.includes(token));assert(!text.includes('grant_path'));};
 await f.h.db.run('UPDATE privacy_export_grants SET expires_at=? WHERE id=?',row.expires_at+1,row.id);await check(503,'privacy_export_grant_reconciliation_required');
 await f.h.db.run('UPDATE privacy_export_grants SET expires_at=?,consumed_at=? WHERE id=?',row.expires_at,row.created_at-1,row.id);await check(503,'privacy_export_grant_reconciliation_required');
 await f.h.db.run('UPDATE privacy_export_grants SET consumed_at=NULL WHERE id=?',row.id);
 await f.h.db.run("UPDATE privacy_requests SET status='cancelled' WHERE id=?",f.exp.id);await check(410,'privacy_export_grant_unavailable');
 await f.h.db.run("UPDATE privacy_requests SET status='completed' WHERE id=?",f.exp.id);
 await f.h.db.run('DELETE FROM privacy_export_grants WHERE id=?',row.id);await check(503,'privacy_export_grant_reconciliation_required');
});


test('damaged retired action or hash cannot produce a definitive grant outcome',{timeout:30000},async t=>{
 const f=await setup(t);await body(await f.grant(),200);const saved=await f.row(),retired=stable({protocol:'lovelies-operation-retired-v1',status:'retired'});
 await f.h.db.run("UPDATE operations SET payload_json=?,response_json=? WHERE actor_id=? AND source='privacy' AND operation_key=?",'null',retired,f.owner.accountId,f.key);
 assert.equal((await body(await f.lookup(),503)).error.code,'privacy_export_grant_reconciliation_required');
 assert.equal((await body(await f.grant(),410)).error.code,'operation_receipt_retired');
 for(const [action,hash] of [[saved.action,'0'.repeat(64)],['privacy.request.export',saved.payload_hash]]){
  await f.h.db.run("UPDATE operations SET action=?,payload_hash=? WHERE actor_id=? AND source='privacy' AND operation_key=?",action,hash,f.owner.accountId,f.key);
  for(const call of [()=>f.lookup(),()=>f.grant()])assert.equal((await body(await call(),503)).error.code,'privacy_export_grant_reconciliation_required');
 }
 assert.equal((await f.grants()).length,1);
});

test('damaged or missing receipt grant identifiers cannot cause expired row cleanup',{timeout:30000},async t=>{
 const f=await setup(t),first=await body(await f.grant(),200),stored=await f.row(),original=(await f.grants())[0];f.h.app.now=()=>Date.parse(first.expires_at)+1;
 for(const alter of [value=>{delete value.grant_id;},value=>{value.grant_id=randomUUID();}]){
  const value=JSON.parse(stored.response_json);alter(value);
  await f.h.db.run("UPDATE operations SET response_json=? WHERE actor_id=? AND source='privacy' AND operation_key=?",stable(value),f.owner.accountId,f.key);
  const r=await f.h.request(`/privacy-exports/${f.exp.id}/grant`,{token:f.owner.token,body:{}});assert.equal(r.status,200);await r.body?.cancel();
  assert((await f.grants()).some(row=>row.id===original.id),'ambiguous old grant row remains');
  assert.equal((await body(await f.lookup(),503)).error.code,'privacy_export_grant_reconciliation_required');
 }
});

test('final grant lookup admission detects consumption and suppresses the prior bearer',{timeout:30000},async t=>{
 const f=await authorityFixture(t),first=await body(await f.grant(),200),token=tokenOf(first),one=f.db.one.bind(f.db);let installed=false,changed=false;
 f.db.one=async(sql,...bindings)=>{const row=await one(sql,...bindings);
  if(!installed&&sql==="SELECT action,payload_hash,payload_json,response_json FROM operations WHERE actor_id=? AND source='privacy' AND operation_key=?"&&bindings[0]===f.owner.accountId&&bindings[1]===f.key){
   installed=true;f.faults.afterCommit=async()=>{delete f.faults.afterCommit;
    await f.h.db.run('UPDATE privacy_export_grants SET consumed_at=? WHERE subject_id=? AND request_id=?',f.now(),f.owner.accountId,f.exp.id);changed=true;};
  }return row;};
 const r=await f.lookup(),text=await r.text();assert(installed&&changed);assert.equal(r.status,503);assert.equal(JSON.parse(text).error.code,'privacy_export_grant_reconciliation_required');assert(!text.includes(token));assert(!text.includes('grant_path'));
 assert.equal((await f.journal.lookup(await exactGrantPlan(f))).status,'committed');
});

test('final expired-status admission detects a changed exact grant row',{timeout:30000},async t=>{
 const f=await authorityFixture(t),first=await body(await f.grant(),200),token=tokenOf(first),one=f.db.one.bind(f.db);f.advance(Date.parse(first.expires_at)+1);let installed=false,changed=false;
 f.db.one=async(sql,...bindings)=>{const row=await one(sql,...bindings);
  if(!installed&&sql==="SELECT action,payload_hash,payload_json,response_json FROM operations WHERE actor_id=? AND source='privacy' AND operation_key=?"&&bindings[0]===f.owner.accountId&&bindings[1]===f.key){
   installed=true;f.faults.afterCommit=async()=>{delete f.faults.afterCommit;
    await f.h.db.run('UPDATE privacy_export_grants SET token_hash=? WHERE subject_id=? AND request_id=?','0'.repeat(64),f.owner.accountId,f.exp.id);changed=true;};
  }return row;};
 const r=await f.lookup(),text=await r.text();assert(installed&&changed);assert.equal(r.status,503);assert.equal(JSON.parse(text).error.code,'privacy_export_grant_reconciliation_required');assert(!text.includes(token));assert(!text.includes('privacy_export_grant_expired'));
});

test('keyed grant consumption after acknowledgement suppresses its committed response',{timeout:30000},async t=>{
 const f=await authorityFixture(t),id=await exactGrantPlan(f),ack=f.journal.acknowledge.bind(f.journal);let changed=false;
 f.journal.acknowledge=async(...args)=>{const saved=await ack(...args);if(args[0]===id){f.faults.afterCommit=async()=>{delete f.faults.afterCommit;
  await f.h.db.run('UPDATE privacy_export_grants SET consumed_at=? WHERE subject_id=? AND request_id=?',f.now(),f.owner.accountId,f.exp.id);changed=true;};}return saved;};
 await unresolvedGrant(await f.grant());assert(changed);const row=await f.row(),plan=await f.journal.lookup(id);assert(row);assert.equal(plan.status,'committed');assert.equal(plan.plan.input_hash,row.payload_hash);assert.equal((await f.grants()).length,1);
});

test('legacy no-key grant keeps its shape and becomes unresolved on postcommit session expiry',{timeout:30000},async t=>{
 const f=await authorityFixture(t),run=f.db.run.bind(f.db);let installed=false,expired=false;
 f.db.run=async(sql,...bindings)=>{const result=await run(sql,...bindings);if(!installed&&sql.startsWith('INSERT INTO privacy_export_grants(')){
  installed=true;f.faults.afterCommit=async()=>{delete f.faults.afterCommit;expired=true;f.expire();};
 }return result;};
 const r=await f.request(`/privacy-exports/${f.exp.id}/grant`,{method:'POST',body:{}});await unresolvedGrant(r);assert(installed&&expired);assert.equal((await f.grants()).length,1);assert.equal(await f.row(),null);
});


test('final grant admission detects publication retirement before releasing a bearer',{timeout:30000},async t=>{
 const f=await authorityFixture(t),first=await body(await f.grant(),200),token=tokenOf(first),one=f.db.one.bind(f.db);let installed=false,changed=false;
 f.db.one=async(sql,...bindings)=>{const row=await one(sql,...bindings);
  if(!installed&&sql==="SELECT action,payload_hash,payload_json,response_json FROM operations WHERE actor_id=? AND source='privacy' AND operation_key=?"&&bindings[0]===f.owner.accountId&&bindings[1]===f.key){
   installed=true;f.faults.afterCommit=async()=>{delete f.faults.afterCommit;
    await f.h.db.run("UPDATE privacy_exports SET status='retired' WHERE request_id=? AND subject_id=?",f.exp.id,f.owner.accountId);changed=true;};
  }return row;};
 const r=await f.lookup(),text=await r.text();assert(installed&&changed);assert.equal(r.status,503);assert.equal(JSON.parse(text).error.code,'privacy_export_grant_reconciliation_required');assert(!text.includes(token));assert(!text.includes('grant_path'));
});


test('malformed bound expiry fields never produce a terminal disposition',{timeout:30000},async t=>{
 const f=await setup(t),first=await body(await f.grant(),200),token=tokenOf(first),saved=await f.row();
 const renewed=await f.h.json('/auth/session/refresh',{body:{refresh_token:f.owner.refresh_token}});f.h.app.now=()=>Date.parse(first.expires_at)+1;
 for(const change of [value=>{value.account_id='not-an-id';},value=>{value.request_id=randomUUID();},value=>{value.session_id='not-a-session';},value=>{value.operation_key='altered-operation-key';},value=>{value.expires_at='not-a-deadline';},value=>{value.unexpected=true;}]){
  const value=JSON.parse(saved.response_json);change(value);
  await f.h.db.run("UPDATE operations SET response_json=? WHERE actor_id=? AND source='privacy' AND operation_key=?",stable(value),f.owner.accountId,f.key);
  const response=await f.lookup(f.key,renewed.access_token),text=await response.text();assert.equal(response.status,503);assert.equal(JSON.parse(text).error.code,'privacy_export_grant_reconciliation_required');assert(!text.includes('lovelies-privacy-export-grant-expired-v1'));assert(!text.includes(token));assert(!text.includes('grant_path'));
 }
});
