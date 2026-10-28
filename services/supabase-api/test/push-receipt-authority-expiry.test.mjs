/** Real handler with synthetic same-account data and a controlled clock.
 * No live provider, external network, multi-backend or cross-account test. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {startHarness,enroll,faceVerifierFixture} from './runtime-harness.mjs';
import {prepareSession,insertPreparedSession} from '../src/auth.ts';
import {stable} from '../src/types.ts';
import {createApp as legacyApp,createHandler as legacyHandler} from './fixtures/push-receipt/index-legacy.ts';
const localTest=process.env.TEST_DATABASE_URL===undefined?test:test.skip;
if(process.env.TEST_DATABASE_URL===undefined)globalThis.fetch=async()=>{throw Error('external_fetch_prohibited');};
async function setup(t){
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});t.after(()=>h.close());const owner=await enroll(h);assert.equal(h.env.PUSH_SERVICE,undefined);
 const body=()=>({platform:'android',push_token:'synthetic-fcm-'+randomUUID(),operation_key:'android-push-'+randomUUID()});
 const register=async b=>{const r=await h.request('/me/push-devices',{token:owner.token,body:b});const v=await r.json();assert.equal(r.status,200,v?.error?.code);return v;};
 const lookup=(key,token=owner.token)=>h.request('/me/push-operations',{token,method:'POST',body:{operation_key:key}});
 const row=key=>h.db.one("SELECT action,payload_json FROM operations WHERE actor_id=? AND source='notification' AND operation_key=?",owner.accountId,key);
 const peer=async()=>{const old=await h.db.one('SELECT public_jwk FROM auth_devices WHERE id=?',owner.deviceId),id=randomUUID(),revision=randomUUID();
  await h.db.run("INSERT INTO auth_devices(id,account_id,public_jwk,revision,status,face_handle,created_at) VALUES(?,?,?,?,'active',?,?)",id,owner.accountId,old.public_jwk,revision,'synthetic-peer-'+id,h.app.now());
  const account=await h.db.one('SELECT auth_epoch FROM accounts WHERE id=?',owner.accountId),profile=await h.db.one('SELECT * FROM face_profiles WHERE account_id=?',owner.accountId);
  const p=await prepareSession({accountId:owner.accountId,roles:['user'],authEpoch:account.auth_epoch,authMethod:'registered_face',profileRevision:profile.revision,profileEpoch:profile.auth_epoch,consentId:profile.auth_consent_id,deviceId:id,deviceRevision:revision},h.app);await h.db.transaction(()=>insertPreparedSession(p,h.app,true));return p.credentials.access_token;};
 const actor=async token=>h.app.authenticate(new Request('https://api.invalid/me',{headers:{authorization:'Bearer '+token}}));
 return {h,owner,body,register,lookup,row,peer,actor};
}
function controlledExpiry(t,f,expiresAt){const old=f.h.app.now;let expired=false;f.h.app.now=()=>expired?expiresAt+1000:old();t.after(()=>{f.h.app.now=old;});return {expire:()=>{expired=true;},get triggered(){return expired;}};}
function afterDigest(t,needle,expire){const subtle=globalThis.crypto.subtle,own=Object.getOwnPropertyDescriptor(subtle,'digest'),original=subtle.digest.bind(subtle);let hits=0;
 Object.defineProperty(subtle,'digest',{configurable:true,writable:true,value:async(algorithm,input)=>{const result=await original(algorithm,input);const bytes=input instanceof ArrayBuffer?new Uint8Array(input):new Uint8Array(input.buffer,input.byteOffset,input.byteLength);
  if(new TextDecoder().decode(bytes)===needle){hits++;expire();}return result;}});
 t.after(()=>{if(own)Object.defineProperty(subtle,'digest',own);else delete subtle.digest;});return ()=>hits;
}
function afterQuery(t,f,prefix,expire){const one=f.h.db.one.bind(f.h.db);let hits=0;f.h.db.one=async(sql,...args)=>{const value=await one(sql,...args);if(sql.startsWith(prefix)){hits++;expire();}return value;};t.after(()=>{f.h.db.one=one;});return ()=>hits;}
async function status(f,key,token,expected){const r=await f.lookup(key,token);const value=await r.json();assert.equal(r.status,expected,value?.error?.code);return value;}
localTest('expiry after awaited payload hashing suppresses the mismatch error',{timeout:30000},async t=>{
 const f=await setup(t),b=f.body();await f.register(b);const row=await f.row(b.operation_key),payload=JSON.parse(row.payload_json);payload.push_token_sha256='c'.repeat(64);
 await f.h.db.run("UPDATE operations SET payload_json=? WHERE actor_id=? AND source='notification' AND operation_key=?",stable(payload),f.owner.accountId,b.operation_key);
 assert.equal((await status(f,b.operation_key,f.owner.token,503)).error.code,'push_operation_receipt_unavailable');
 const actor=await f.actor(f.owner.token),clock=controlledExpiry(t,f,actor.expiresAt),hits=afterDigest(t,stable({action:row.action,source:'notification',payload}),clock.expire);
 const r=await f.lookup(b.operation_key);assert.equal(hits(),1);assert(clock.triggered);assert.equal(r.status,401);assert.equal((await r.json()).error.code,'session_invalid');
});
localTest('expiry after awaited legacy token hashing suppresses a current-token mismatch',{timeout:30000},async t=>{
 const f=await setup(t),b=f.body(),legacy=legacyHandler(legacyApp(f.h.db,f.h.env,f.h.app.now));
 const response=await legacy(new Request('https://api.invalid/me/push-devices',{method:'POST',headers:{authorization:'Bearer '+f.owner.token,'content-type':'application/json'},body:JSON.stringify(b)}));assert.equal(response.status,200);const first=await response.json();
 await f.h.db.run('UPDATE push_devices SET token_hash=? WHERE id=? AND account_id=?','c'.repeat(64),first.id,f.owner.accountId);
 assert.equal((await status(f,b.operation_key,f.owner.token,503)).error.code,'push_operation_receipt_unavailable');
 const actor=await f.actor(f.owner.token),clock=controlledExpiry(t,f,actor.expiresAt),hits=afterDigest(t,b.push_token,clock.expire);
 const r=await f.lookup(b.operation_key);assert.equal(hits(),1);assert(clock.triggered);assert.equal(r.status,401);assert.equal((await r.json()).error.code,'session_invalid');
});
localTest('expiry after awaited current-row read suppresses its mismatch error',{timeout:30000},async t=>{
 const f=await setup(t),b=f.body(),first=await f.register(b);await f.h.db.run('UPDATE push_devices SET token_hash=? WHERE id=? AND account_id=?','c'.repeat(64),first.id,f.owner.accountId);
 assert.equal((await status(f,b.operation_key,f.owner.token,503)).error.code,'push_operation_receipt_unavailable');
 const actor=await f.actor(f.owner.token),clock=controlledExpiry(t,f,actor.expiresAt),hits=afterQuery(t,f,'SELECT id,auth_device_id,platform,active,token_hash FROM push_devices',clock.expire);
 const r=await f.lookup(b.operation_key);assert.equal(hits(),1);assert(clock.triggered);assert.equal(r.status,401);assert.equal((await r.json()).error.code,'session_invalid');
});
localTest('expiry after awaited session-device read suppresses another-device 404',{timeout:30000},async t=>{
 const f=await setup(t),b=f.body();await f.register(b);const token=await f.peer();assert.equal((await status(f,b.operation_key,token,404)).error.code,'push_operation_unavailable');
 const actor=await f.actor(token),clock=controlledExpiry(t,f,actor.expiresAt),hits=afterQuery(t,f,'SELECT device_id FROM sessions WHERE id=? AND account_id=?',clock.expire);
 const r=await f.lookup(b.operation_key,token);assert.equal(hits(),1);assert(clock.triggered);assert.equal(r.status,401);assert.equal((await r.json()).error.code,'session_invalid');
});
localTest('lookup uses a bounded JSON body and no-store response; key paths and queries are refused',{timeout:30000},async t=>{
 const f=await setup(t),b=f.body();await f.register(b);
 const r=await f.lookup(b.operation_key);assert.equal(r.status,200);assert.match(r.headers.get('cache-control'),/no-store/);const v=await r.json();assert.equal(v.status,'committed');assert.equal(v.operation_key,b.operation_key);
 const missing='android-missing-'+randomUUID(),unknown=await f.lookup(missing);assert.equal(unknown.status,200);assert.match(unknown.headers.get('cache-control'),/no-store/);assert.equal((await unknown.json()).status,'unknown');
 const old=await f.h.request('/me/push-operations/'+b.operation_key,{token:f.owner.token});assert.equal(old.status,404);assert.match(old.headers.get('cache-control'),/no-store/);assert(!JSON.stringify(await old.json()).includes(b.operation_key));
 const wrong=await f.h.request('/me/push-operations',{token:f.owner.token});assert.equal(wrong.status,405);
 const query=await f.h.request('/me/push-operations?key=synthetic-query',{token:f.owner.token,method:'POST',body:{operation_key:b.operation_key}});assert.equal(query.status,400);
 const extra=await f.h.request('/me/push-operations',{token:f.owner.token,method:'POST',body:{operation_key:b.operation_key,other:'extra'}});assert.equal(extra.status,400);assert(!JSON.stringify(await extra.json()).includes(b.operation_key));
});
localTest('audience review expiry after a current-row read suppresses its mismatch error',{timeout:30000},async t=>{
 const f=await setup(t),b=f.body(),first=await f.register(b),due=f.h.app.now()+2000;
 await f.h.db.run('UPDATE account_audience SET next_review_at=? WHERE account_id=?',due,f.owner.accountId);
 await f.h.db.run('UPDATE push_devices SET token_hash=? WHERE id=? AND account_id=?','c'.repeat(64),first.id,f.owner.accountId);
 assert.equal((await status(f,b.operation_key,f.owner.token,503)).error.code,'push_operation_receipt_unavailable');
 const actor=await f.actor(f.owner.token);assert(due+1000<actor.expiresAt,'audience review must expire while session is still valid');
 const clock=controlledExpiry(t,f,due),hits=afterQuery(t,f,'SELECT id,auth_device_id,platform,active,token_hash FROM push_devices',clock.expire);
 const r=await f.lookup(b.operation_key);assert.equal(hits(),1);assert(clock.triggered);assert.equal(r.status,403);assert.equal((await r.json()).error.code,'audience_restricted');
});
