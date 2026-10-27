/** One synthetic account, local PGlite and real handler only. No provider service. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {startHarness,enroll,faceVerifierFixture} from './runtime-harness.mjs';
// Defined, even when empty, means this PGlite-only suite is not selected.
const localTest = process.env.TEST_DATABASE_URL === undefined ? test : test.skip;
if (process.env.TEST_DATABASE_URL === undefined) globalThis.fetch = async () => { throw Error('external_fetch_prohibited'); };
const key=prefix=>prefix+'-'+randomUUID(),token=()=>key('synthetic-push-token'),digest=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t){
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});t.after(()=>h.close());
 const owner=await enroll(h);assert(owner.deviceId&&owner.accountId);
 assert.equal(h.env.PUSH_SERVICE,undefined);
 const register=(body)=>h.request('/me/push-devices',{token:owner.token,body});
 const count=async()=>(await h.db.one('SELECT count(*) n FROM push_devices WHERE account_id=? AND active=1',owner.accountId)).n;
 const rows=async()=>h.db.all('SELECT id,auth_device_id,platform,token_hash,token_value,active FROM push_devices WHERE account_id=? ORDER BY id',owner.accountId);
 const seed=async n=>{for(let i=0;i<n;i++){
  const device=randomUUID(),id=randomUUID(),value=token(),now=h.app.now();
  await h.db.run("INSERT INTO auth_devices(id,account_id,public_jwk,revision,status,created_at) VALUES(?,?,?,?,'active',?)",device,owner.accountId,'{}',randomUUID(),now);
  await h.db.run("INSERT INTO push_devices(id,account_id,auth_device_id,platform,token_hash,token_value,active,created_at,updated_at) VALUES(?,?,?,'ios',?,?,1,?,?)",id,owner.accountId,device,digest(value),value,now,now);
 }};
 const add=async(value=token(),operation=key('operation'),platform='ios')=>{const response=await register({platform,push_token:value,operation_key:operation});const result=await response.json();return {response,result,value,operation,platform};};
 const deactivate=async id=>{const response=await h.request('/me/push-devices/'+id,{method:'DELETE',token:owner.token,body:{operation_key:key('remove')}});assert.equal(response.status,200);};
 return {h,owner,register,count,rows,seed,add,deactivate};
}

localTest('baseline rotation at ten replaces the current device token and remains at ten',{timeout:30000},async t=>{
 const f=await fixture(t),old=await f.add();assert.equal(old.response.status,200);await f.seed(9);assert.equal(await f.count(),10);
 const request={platform:'ios',push_token:token(),operation_key:key('rotate')},response=await f.register(request);assert.equal(response.status,200,'same-device rotation must not consume an extra active slot');
 const first=await response.json(),now=await f.rows();assert.equal(now.filter(r=>r.active===1).length,10);
 const previous=now.find(r=>r.id===old.result.id),replacement=now.find(r=>r.id===first.id);assert.equal(previous.active,0);assert.equal(previous.token_value,'');assert.equal(replacement.active,1);assert.equal(replacement.auth_device_id,f.owner.deviceId);
 const retry=await f.register(request);assert.equal(retry.status,200);assert.deepEqual(await retry.json(),first);assert.equal(await f.count(),10);assert.equal((await f.rows()).length,now.length);
});

localTest('baseline reactivating an inactive token cannot exceed ten active rows',{timeout:30000},async t=>{
 const f=await fixture(t),old=await f.add();assert.equal(old.response.status,200);await f.deactivate(old.result.id);await f.seed(10);assert.equal(await f.count(),10);
 const before=await f.rows(),result=await f.add(old.value,key('reactivate')),afterCount=await f.count();t.diagnostic('reactivation HTTP status '+result.response.status+'; active rows '+afterCount);assert.equal(result.response.status,409,'reactivation must honor prospective active count');assert.equal(result.result.error.code,'push_device_limit');
 assert.deepEqual(await f.rows(),before);assert.equal(await f.count(),10);
});

localTest('reactivation without a displaced row succeeds when nine active rows exist',{timeout:30000},async t=>{
 const f=await fixture(t),old=await f.add();assert.equal(old.response.status,200);await f.deactivate(old.result.id);await f.seed(9);assert.equal(await f.count(),9);
 const result=await f.add(old.value,key('reactivate'));assert.equal(result.response.status,200);assert.equal(result.result.id,old.result.id);assert.equal(await f.count(),10);
});

localTest('a different platform cannot consume an eleventh slot',{timeout:30000},async t=>{
 const f=await fixture(t),old=await f.add();assert.equal(old.response.status,200);await f.seed(9);const before=await f.rows();
 const result=await f.add(token(),key('new-platform'),'android');assert.equal(result.response.status,409);assert.equal(result.result.error.code,'push_device_limit');assert.deepEqual(await f.rows(),before);assert.equal(await f.count(),10);
});

localTest('a fresh operation re-registering an active token keeps the same row at the limit',{timeout:30000},async t=>{
 const f=await fixture(t),old=await f.add();assert.equal(old.response.status,200);await f.seed(9);const before=await f.rows();
 const result=await f.add(old.value,key('existing'));assert.equal(result.response.status,200);assert.equal(result.result.id,old.result.id);assert.equal(await f.count(),10);assert.equal((await f.rows()).length,before.length);
});

localTest('an inactive token can replace the current device token at the limit',{timeout:30000},async t=>{
 const f=await fixture(t),old=await f.add();assert.equal(old.response.status,200);await f.deactivate(old.result.id);
 const current=await f.add();assert.equal(current.response.status,200);await f.seed(9);assert.equal(await f.count(),10);
 const restored=await f.add(old.value,key('replace'));assert.equal(restored.response.status,200);assert.equal(restored.result.id,old.result.id);
 const after=await f.rows();assert.equal(after.find(row=>row.id===current.result.id).active,0);assert.equal(after.find(row=>row.id===old.result.id).active,1);assert.equal(await f.count(),10);
});

localTest('existing over-limit rows are preserved and registration cannot increase the count',{timeout:30000},async t=>{
 const f=await fixture(t),old=await f.add();assert.equal(old.response.status,200);await f.seed(10);assert.equal(await f.count(),11);
 const updated=await f.add();assert.equal(updated.response.status,200);assert.equal(await f.count(),11);
 const before=await f.rows(),additional=await f.add(token(),key('extra'),'android');assert.equal(additional.response.status,409);assert.equal(additional.result.error.code,'push_device_limit');
 assert.deepEqual(await f.rows(),before);assert.equal(await f.count(),11);
});

localTest('moving an active token to another platform displaces that platform registration',{timeout:30000},async t=>{
 const f=await fixture(t),ios=await f.add(),android=await f.add(token(),key('android'),'android');
 assert.equal(ios.response.status,200);assert.equal(android.response.status,200);await f.seed(8);assert.equal(await f.count(),10);
 const moved=await f.add(ios.value,key('move'),'android');assert.equal(moved.response.status,200);assert.equal(moved.result.id,ios.result.id);
 const rows=await f.rows();assert.equal(rows.find(row=>row.id===ios.result.id).platform,'android');
 assert.equal(rows.find(row=>row.id===ios.result.id).active,1);assert.equal(rows.find(row=>row.id===android.result.id).active,0);assert.equal(await f.count(),9);
});

localTest('rotation retires multiple existing rows for the same device and platform',{timeout:30000},async t=>{
 const f=await fixture(t),old=await f.add();assert.equal(old.response.status,200);
 const duplicate=randomUUID(),value=token(),now=f.h.app.now();
 await f.h.db.run("INSERT INTO push_devices(id,account_id,auth_device_id,platform,token_hash,token_value,active,created_at,updated_at) VALUES(?,?,?,'ios',?,?,1,?,?)",duplicate,f.owner.accountId,f.owner.deviceId,digest(value),value,now,now);
 await f.seed(8);assert.equal(await f.count(),10);
 const rotated=await f.add();assert.equal(rotated.response.status,200);const rows=await f.rows();
 assert.equal(rows.find(row=>row.id===old.result.id).active,0);assert.equal(rows.find(row=>row.id===duplicate).active,0);
 assert.equal(rows.find(row=>row.id===rotated.result.id).active,1);assert.equal(await f.count(),9);
});
