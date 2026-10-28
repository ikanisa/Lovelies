/** Synthetic same-account sequences through the actual handler and PGlite only.
 * These demonstrate limitations of an unmodified server contract; local opt-out
 * is not asserted to be visible to the server and no provider is contacted. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {startHarness,enroll,faceVerifierFixture} from './runtime-harness.mjs';
const localTest=process.env.TEST_DATABASE_URL===undefined?test:test.skip;
if(process.env.TEST_DATABASE_URL===undefined)globalThis.fetch=async()=>{throw Error('external_fetch_prohibited');};
async function setup(t){
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});t.after(()=>h.close());
 const actor=await enroll(h);assert(actor.accountId&&actor.deviceId);assert.equal(h.env.PUSH_SERVICE,undefined);
 const register=async(body)=>{const r=await h.request('/me/push-devices',{token:actor.token,body});const value=await r.json();assert.equal(r.status,200,value?.error?.code);return value;};
 const remove=async(id)=>{const r=await h.request('/me/push-devices/'+id,{method:'DELETE',token:actor.token,body:{operation_key:'android-remove-'+randomUUID()}});const value=await r.json();assert.equal(r.status,200,value?.error?.code);return value;};
 const row=async(id)=>h.db.one('SELECT id,account_id,auth_device_id,platform,active FROM push_devices WHERE id=?',id);
 const body=()=>({platform:'android',push_token:'synthetic-fcm-token-'+randomUUID(),operation_key:'android-push-'+randomUUID()});
 return {h,actor,register,remove,row,body};
}
localTest('bound receipt separates the committed registration from current disabled state without revealing its token',{timeout:30000},async t=>{
 const f=await setup(t),body=f.body(),unknown=await f.h.json('/me/push-operations',{token:f.actor.token,method:'POST',body:{operation_key:body.operation_key}});
 assert.deepEqual(unknown,{protocol:'lovelies-push-operation-receipt-v1',operation_key:body.operation_key,status:'unknown'});
 const first=await f.register(body),before=await f.h.json('/me/push-operations',{token:f.actor.token,method:'POST',body:{operation_key:body.operation_key}});
 const stored=await f.h.db.one("SELECT action,payload_hash FROM operations WHERE actor_id=? AND source='notification' AND operation_key=?",f.actor.accountId,body.operation_key);
 assert.equal(before.status,'committed');assert.equal(before.operation_key,body.operation_key);assert.equal(before.action,stored.action);assert.equal(before.payload_hash,stored.payload_hash);
 assert.deepEqual(before.result,first);assert.equal(before.current.auth_device_id,f.actor.deviceId);assert.equal(before.current.active,1);
 assert(!JSON.stringify(before).includes(body.push_token));await f.remove(first.id);
 const after=await f.h.json('/me/push-operations',{token:f.actor.token,method:'POST',body:{operation_key:body.operation_key}});assert.equal(after.result.active,true);assert.equal(after.current.active,0);
});
localTest('bound receipt refuses an unrelated same-subject notification operation',{timeout:30000},async t=>{
 const f=await setup(t),key='android-settings-'+randomUUID();
 const updated=await f.h.request('/me/notification-settings',{token:f.actor.token,method:'PATCH',body:{operation_key:key,match_alerts:true}});assert.equal(updated.status,200);
 const lookup=await f.h.request('/me/push-operations',{token:f.actor.token,method:'POST',body:{operation_key:key}});assert.equal(lookup.status,409);
 const result=await lookup.json();assert.equal(result.error.code,'push_operation_scope_changed');
});
localTest('bound receipt for removal reports its original result and later reactivation separately',{timeout:30000},async t=>{
 const f=await setup(t),body=f.body(),old=await f.register(body),key='android-remove-'+randomUUID();
 const r=await f.h.request('/me/push-devices/'+old.id,{token:f.actor.token,method:'DELETE',body:{operation_key:key}});assert.equal(r.status,200);await r.json();
 const next=await f.register({...body,operation_key:'android-push-'+randomUUID()});assert.equal(next.id,old.id);
 const receipt=await f.h.json('/me/push-operations',{token:f.actor.token,method:'POST',body:{operation_key:key}});assert.equal(receipt.result.active,false);assert.equal(receipt.current.active,1);assert.equal(receipt.current.auth_device_id,f.actor.deviceId);
});
localTest('a malformed historical receipt is rejected without echoing extra fields',{timeout:30000},async t=>{
 const f=await setup(t),body=f.body(),first=await f.register(body),extra='synthetic-private-extra-not-for-response';
 await f.h.db.run("UPDATE operations SET response_json=? WHERE actor_id=? AND source='notification' AND operation_key=?",JSON.stringify({...first,unexpected:extra}),f.actor.accountId,body.operation_key);
 const lookup=await f.h.request('/me/push-operations',{token:f.actor.token,method:'POST',body:{operation_key:body.operation_key}});assert.equal(lookup.status,503);const text=await lookup.text();assert(!text.includes(extra));assert(!text.includes(body.push_token));
});
localTest('current audience restriction also blocks Android device removal',{timeout:30000},async t=>{
 const f=await setup(t),initial=f.body(),old=await f.register(initial);await f.h.db.run("UPDATE account_audience SET status='suspended' WHERE account_id=?",f.actor.accountId);
 const {assertPrivacyActor}=await import('../src/auth.ts');const actor=await f.h.app.authenticate(new Request('https://api.invalid/me',{headers:{authorization:'Bearer '+f.actor.token}}));await assertPrivacyActor(actor,f.h.app);
 const attempt=await f.h.request('/me/push-devices',{token:f.actor.token,body:f.body()});assert.equal(attempt.status,403);assert.equal((await f.row(old.id)).active,1);
 assert.equal((await f.h.request('/me/push-devices',{token:f.actor.token})).status,403);assert.equal((await f.h.request('/me/push-operations',{token:f.actor.token,method:'POST',body:{operation_key:initial.operation_key}})).status,403);
 const removed=await f.h.request('/me/push-devices/'+old.id,{method:'DELETE',token:f.actor.token,body:{operation_key:'android-remove-'+randomUUID()}});
 assert.equal(removed.status,403);assert.equal((await removed.json()).error.code,'audience_restricted');assert.equal((await f.row(old.id)).active,1);
});
localTest('an invalid identifier in a stored operation response fails closed as unavailable',{timeout:30000},async t=>{
 const f=await setup(t),body=f.body(),first=await f.register(body);
 await f.h.db.run("UPDATE operations SET response_json=? WHERE actor_id=? AND source='notification' AND operation_key=?",JSON.stringify({...first,id:'invalid-receipt-id'}),f.actor.accountId,body.operation_key);
 const lookup=await f.h.request('/me/push-operations',{token:f.actor.token,method:'POST',body:{operation_key:body.operation_key}});assert.equal(lookup.status,503);assert.equal((await lookup.json()).error.code,'push_operation_receipt_unavailable');
});
