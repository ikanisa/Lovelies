/** Same-account synthetic PGlite handler tests only. No provider or network. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {startHarness,enroll,faceVerifierFixture} from './runtime-harness.mjs';
import {prepareSession,insertPreparedSession} from '../src/auth.ts';
import {ApiError,digest,stable} from '../src/types.ts';
import {fixture as journalFixture} from './restore-database-fixture.mjs';
import {createApp,createHandler} from '../src/index.ts';
import {retiredOperationInput,retiredOperationResponse} from '../src/operations.ts';
import {createApp as legacyApp,createHandler as legacyHandler} from './fixtures/push-receipt/index-legacy.ts';
const localTest=process.env.TEST_DATABASE_URL===undefined?test:test.skip;
if(process.env.TEST_DATABASE_URL===undefined)globalThis.fetch=async()=>{throw Error('external_fetch_prohibited');};
async function setup(t){
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});t.after(()=>h.close());
 const owner=await enroll(h);assert.equal(h.env.PUSH_SERVICE,undefined);
 const body=()=>({platform:'android',push_token:'synthetic-fcm-'+randomUUID(),operation_key:'android-push-'+randomUUID()});
 const register=async(b,token=owner.token)=>{const r=await h.request('/me/push-devices',{token,body:b});const v=await r.json();assert.equal(r.status,200,v?.error?.code);return v;};
 const lookup=async(key,token=owner.token)=>h.request('/me/push-operations',{token,method:'POST',body:{operation_key:key}});
 const row=async(key)=>h.db.one("SELECT action,payload_hash,payload_json,response_json FROM operations WHERE actor_id=? AND source='notification' AND operation_key=?",owner.accountId,key);
 const change=async(key,column,value)=>h.db.run(`UPDATE operations SET ${column}=? WHERE actor_id=? AND source='notification' AND operation_key=?`,value,owner.accountId,key);
 const peer=async()=>{
  const device=await h.db.one('SELECT public_jwk FROM auth_devices WHERE id=?',owner.deviceId),id=randomUUID(),revision=randomUUID();
  await h.db.run("INSERT INTO auth_devices(id,account_id,public_jwk,revision,status,face_handle,created_at) VALUES(?,?,?,?,'active',?,?)",id,owner.accountId,device.public_jwk,revision,'synthetic-peer-'+id,h.app.now());
  const account=await h.db.one('SELECT auth_epoch FROM accounts WHERE id=?',owner.accountId),profile=await h.db.one('SELECT * FROM face_profiles WHERE account_id=?',owner.accountId);
  const prepared=await prepareSession({accountId:owner.accountId,roles:['user'],authEpoch:account.auth_epoch,authMethod:'registered_face',profileRevision:profile.revision,profileEpoch:profile.auth_epoch,consentId:profile.auth_consent_id,deviceId:id,deviceRevision:revision},h.app);
  await h.db.transaction(()=>insertPreparedSession(prepared,h.app,true));
  return {deviceId:id,token:prepared.credentials.access_token};
 };
 return {h,owner,body,register,lookup,row,change,peer};
}
async function unavailable(f,key){const r=await f.lookup(key),v=await r.json();assert.equal(r.status,503,v?.error?.code);assert.equal(v.error.code,'push_operation_receipt_unavailable');return v;}
localTest('mismatched stored canonical payload and hash never produce a committed receipt',{timeout:30000},async t=>{
 const f=await setup(t),b=f.body();await f.register(b);const row=await f.row(b.operation_key),p=JSON.parse(row.payload_json);p.push_token_sha256='b'.repeat(64);
 assert.notEqual(await digest(stable({action:row.action,source:'notification',payload:p})),row.payload_hash);await f.change(b.operation_key,'payload_json',stable(p));
 const result=await unavailable(f,b.operation_key);assert(!JSON.stringify(result).includes(b.push_token));
});
localTest('noncanonical JSON fails closed even with its matching content hash',{timeout:30000},async t=>{
 const f=await setup(t),b=f.body();await f.register(b);const row=await f.row(b.operation_key),p=JSON.parse(row.payload_json);await f.change(b.operation_key,'payload_json',JSON.stringify(p,null,2));
 assert.equal(await digest(stable({action:row.action,source:'notification',payload:p})),row.payload_hash);await unavailable(f,b.operation_key);
});
localTest('unrecognized payload fields fail closed even if their digest is consistent',{timeout:30000},async t=>{
 const f=await setup(t),b=f.body();await f.register(b);const row=await f.row(b.operation_key),p={...JSON.parse(row.payload_json),unexpected:'synthetic-private-value'};
 await f.change(b.operation_key,'payload_json',stable(p));await f.change(b.operation_key,'payload_hash',await digest(stable({action:row.action,source:'notification',payload:p})));
 const v=await unavailable(f,b.operation_key);assert(!JSON.stringify(v).includes(p.unexpected));
});
localTest('response platform and token row must agree with the historical registration payload',{timeout:30000},async t=>{
 const f=await setup(t),b=f.body(),first=await f.register(b);await f.change(b.operation_key,'response_json',stable({...first,platform:'ios'}));await unavailable(f,b.operation_key);
 await f.change(b.operation_key,'response_json',stable(first));await f.h.db.run('UPDATE push_devices SET token_hash=? WHERE id=? AND account_id=?','c'.repeat(64),first.id,f.owner.accountId);
 await unavailable(f,b.operation_key);
});
localTest('a current session on another same-account device cannot read this current device row',{timeout:30000},async t=>{
 const f=await setup(t),b=f.body(),first=await f.register(b),other=await f.peer();
 const initial=await f.lookup(b.operation_key);assert.equal(initial.status,200);await initial.body?.cancel();
 const r=await f.lookup(b.operation_key,other.token);assert.equal(r.status,404);const v=await r.json();assert.equal(v.error.code,'push_operation_unavailable');
 assert.equal((await f.h.db.one('SELECT auth_device_id FROM push_devices WHERE id=?',first.id)).auth_device_id,f.owner.deviceId);
});
localTest('unknown result is withheld when its post-read authority check fails',{timeout:30000},async t=>{
 const f=await setup(t),key='android-missing-'+randomUUID(),one=f.h.db.one.bind(f.h.db),authority=f.h.app.assertActor.bind(f.h.app);let triggered=false;
 f.h.db.one=async(sql,...args)=>{const result=await one(sql,...args);if(!triggered&&sql.startsWith('SELECT action,payload_hash,payload_json,response_json FROM operations')&&args[1]===key){assert.equal(result,null);triggered=true;}return result;};
 f.h.app.assertActor=async actor=>{if(triggered)throw new ApiError(401,'session_invalid');return authority(actor);};
 t.after(()=>{f.h.db.one=one;f.h.app.assertActor=authority;});
 const r=await f.lookup(key);assert(triggered,'synthetic authority failure enabled after the missing lookup');assert.equal(r.status,401);assert.equal((await r.json()).error.code,'session_invalid');
});
localTest('legacy raw registration receipt is validated without echoing the token',{timeout:30000},async t=>{
 const f=await setup(t),b=f.body(),legacy=legacyHandler(legacyApp(f.h.db,f.h.env,f.h.app.now));
 const r=await legacy(new Request('https://api.invalid/me/push-devices',{method:'POST',headers:{authorization:'Bearer '+f.owner.token,'content-type':'application/json'},body:JSON.stringify(b)}));assert.equal(r.status,200);const first=await r.json();
 const saved=await f.row(b.operation_key);assert(saved.payload_json.includes(b.push_token));const receipt=await f.lookup(b.operation_key);assert.equal(receipt.status,200);const text=await receipt.text();assert(!text.includes(b.push_token));assert.deepEqual(JSON.parse(text).result,first);
});
localTest('retired and partially retired payloads retain 410 and 503 responses',{timeout:30000},async t=>{
 const f=await setup(t),b=f.body();await f.register(b);await f.change(b.operation_key,'payload_json',retiredOperationInput);
 let r=await f.lookup(b.operation_key);assert.equal(r.status,503);assert.equal((await r.json()).error.code,'operation_receipt_unavailable');
 await f.change(b.operation_key,'response_json',retiredOperationResponse);r=await f.lookup(b.operation_key);assert.equal(r.status,410);assert.equal((await r.json()).error.code,'operation_receipt_retired');
});
localTest('re-registration moves the current row; it does not attest original-device provenance',{timeout:30000},async t=>{
 const f=await setup(t),b=f.body(),first=await f.register(b),other=await f.peer(),next=await f.register({...b,operation_key:'android-moved-'+randomUUID()},other.token);
 assert.equal(next.id,first.id);const r=await f.lookup(b.operation_key,other.token);assert.equal(r.status,200);const receipt=await r.json();assert.equal(receipt.current.auth_device_id,other.deviceId);
 // Existing operation payloads contain no originating device/session fact.
 const saved=await f.row(b.operation_key),payload=JSON.parse(saved.payload_json);assert(!Object.hasOwn(payload,'device_id'));assert(!Object.hasOwn(payload,'session_id'));
});
localTest('legacy operation key containing its token is not echoed by the receipt',{timeout:30000},async t=>{
 const f=await setup(t),b=f.body();b.operation_key=b.push_token;const legacy=legacyHandler(legacyApp(f.h.db,f.h.env,f.h.app.now));
 const created=await legacy(new Request('https://api.invalid/me/push-devices',{method:'POST',headers:{authorization:'Bearer '+f.owner.token,'content-type':'application/json'},body:JSON.stringify(b)}));assert.equal(created.status,200);await created.body?.cancel();
 const r=await f.lookup(b.operation_key),text=await r.text();assert.equal(r.status,503);assert(!text.includes(b.push_token));
});
localTest('removal receipt must bind the path, payload, and response identifiers',{timeout:30000},async t=>{
 const f=await setup(t),b=f.body(),first=await f.register(b),key='android-remove-'+randomUUID();
 const d=await f.h.request('/me/push-devices/'+first.id,{method:'DELETE',token:f.owner.token,body:{operation_key:key}});assert.equal(d.status,200);await d.body?.cancel();
 const good=await f.lookup(key);assert.equal(good.status,200);assert.equal((await good.json()).result.id,first.id);
 const row=await f.row(key),p={...JSON.parse(row.payload_json),device_id:randomUUID()};await f.change(key,'payload_json',stable(p));await f.change(key,'payload_hash',await digest(stable({action:row.action,source:'notification',payload:p})));
 await unavailable(f,key);
});
localTest('committed result is withheld when its post-read authority check fails',{timeout:30000},async t=>{
 const f=await setup(t),b=f.body();await f.register(b);const one=f.h.db.one.bind(f.h.db),authority=f.h.app.assertActor.bind(f.h.app);let triggered=false;
 f.h.db.one=async(sql,...args)=>{const result=await one(sql,...args);if(!triggered&&sql.startsWith('SELECT id,auth_device_id,platform,active,token_hash FROM push_devices')){assert(result);triggered=true;}return result;};
 f.h.app.assertActor=async actor=>{if(triggered)throw new ApiError(401,'session_invalid');return authority(actor);};
 t.after(()=>{f.h.db.one=one;f.h.app.assertActor=authority;});
 const r=await f.lookup(b.operation_key);assert(triggered,'synthetic authority failure enabled after the current row read');assert.equal(r.status,401);assert.equal((await r.json()).error.code,'session_invalid');
});
localTest('a shape-valid response cannot substitute another same-device token row',{timeout:30000},async t=>{
 const f=await setup(t),firstBody=f.body(),first=await f.register(firstBody),otherBody=f.body(),other=await f.register(otherBody);
 assert.notEqual(first.id,other.id);await f.change(firstBody.operation_key,'response_json',stable({...first,id:other.id}));await unavailable(f,firstBody.operation_key);
});
localTest('a later current session on the same device can read an old receipt without proving original session',{timeout:30000},async t=>{
 const f=await setup(t),b=f.body();await f.register(b);
 const account=await f.h.db.one('SELECT auth_epoch FROM accounts WHERE id=?',f.owner.accountId),profile=await f.h.db.one('SELECT * FROM face_profiles WHERE account_id=?',f.owner.accountId),device=await f.h.db.one('SELECT revision FROM auth_devices WHERE id=?',f.owner.deviceId);
 const old=await f.h.app.authenticate(new Request('https://api.invalid/me',{headers:{authorization:'Bearer '+f.owner.token}}));
 const prepared=await prepareSession({accountId:f.owner.accountId,roles:['user'],authEpoch:account.auth_epoch,authMethod:'registered_face',profileRevision:profile.revision,profileEpoch:profile.auth_epoch,consentId:profile.auth_consent_id,deviceId:f.owner.deviceId,deviceRevision:device.revision},f.h.app);
 await f.h.db.transaction(()=>insertPreparedSession(prepared,f.h.app,true));assert.notEqual(prepared.id,old.sessionId);
 const r=await f.lookup(b.operation_key,prepared.credentials.access_token);assert.equal(r.status,200);const receipt=await r.json();assert.equal(receipt.current.auth_device_id,f.owner.deviceId);
 const payload=JSON.parse((await f.row(b.operation_key)).payload_json);assert(!Object.hasOwn(payload,'session_id'));
});
localTest('known and unknown receipt reads do not prepare restore-journal writes',{timeout:30000},async t=>{
 const j=await journalFixture(t),h=j.h;h.env.FACE_AUTH_VERIFIER={fetch:async request=>{const form=await request.formData();return Response.json(await faceVerifierFixture(JSON.parse(String(form.get('envelope'))),form));}};
 const owner=await enroll(h),handler=createHandler(createApp(j.db,h.env,h.app.now)),body={platform:'android',push_token:'synthetic-fcm-'+randomUUID(),operation_key:'android-push-'+randomUUID()};
 const request=(path,method='GET',value)=>handler(new Request('https://api.invalid'+path,{method,headers:{authorization:'Bearer '+owner.token,...(value?{'content-type':'application/json'}:{})},...(value?{body:JSON.stringify(value)}:{})}));
 const register=await request('/me/push-devices','POST',body);assert.equal(register.status,200);await register.body?.cancel();
 const markerSql='SELECT journal_sequence,journal_hash,last_operation_id,last_plan_hash FROM restore_control WHERE singleton=1',before=await h.db.one(markerSql);j.trace.length=0;
 const known=await request('/me/push-operations','POST',{operation_key:body.operation_key});assert.equal(known.status,200);assert.equal((await known.json()).status,'committed');
 const unknown=await request('/me/push-operations','POST',{operation_key:'android-missing-'+randomUUID()});assert.equal(unknown.status,200);assert.equal((await unknown.json()).status,'unknown');
 const after=await h.db.one(markerSql);
 assert(j.trace.some(x=>x.kind==='sql'&&x.sql==='SET TRANSACTION READ ONLY'),'real adapter selected read-only transaction');
 assert(j.trace.some(x=>x.kind==='journal'),'independent in-memory journal admission was actually reached');
 assert(!j.trace.some(x=>x.kind==='journal'&&x.path==='/v1/operations/prepare'),'read must not prepare a journal operation');
 assert(!j.trace.some(x=>x.kind==='sql'&&x.sql.startsWith('UPDATE restore_control SET')),'read must not advance the database restore marker');assert.deepEqual(after,before);
});
