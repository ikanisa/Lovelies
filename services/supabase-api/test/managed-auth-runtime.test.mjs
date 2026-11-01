import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startHarness,enroll,faceVerifierFixture} from './runtime-harness.mjs';
import {maintainManagedAuth,assertManagedAccountRetired,retireManagedAccount,prepareManagedSession} from '../src/managed-auth.ts';
import {collectPrivacyExport} from '../src/privacy.ts';
import {ApiError} from '../src/types.ts';

/** Synthetic GoTrue port with real PostgreSQL semantics for its read-only
 * session predicate. This is not qualification of a running GoTrue server. */
async function fixture(t){
 const h=await startHarness({consumeQueue:false,faceVerifier:faceVerifierFixture});t.after(()=>h.close());
 await h.engine.exec(`CREATE SCHEMA auth;
  CREATE TABLE auth.users(id uuid PRIMARY KEY,is_anonymous boolean NOT NULL,deleted_at timestamptz,banned_until timestamptz,created_at timestamptz NOT NULL,raw_user_meta_data jsonb);
  CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,not_after timestamptz,created_at timestamptz NOT NULL);`);
 await h.db.run("INSERT INTO restore_control(singleton,project_id,database_id,incarnation_id,checkpoint_revision,checkpoint_hash,journal_sequence,journal_hash) VALUES(1,'ltqfplqevxztlswlzexn',?,?,0,?,0,?)",crypto.randomUUID(),crypto.randomUUID(),'a'.repeat(64),'0'.repeat(64));
 // Only this fixture opts into the trigger capture protocol without a remote
 // journal. Existing restore-fence tests separately qualify that protocol.
 await h.engine.exec("SET lovelies.writer_protocol='2'");
 const tokens=new Map(),trace=[],faults={};
 const boundary=name=>{assert.equal(h.db.inTransaction(),false,name+' must run outside the global app transaction');trace.push(name);};
 const provider={
  async signUp(marker){boundary('signup');const user_id=crypto.randomUUID(),session_id=crypto.randomUUID();
   await h.engine.query('INSERT INTO auth.users(id,is_anonymous,created_at,raw_user_meta_data) VALUES($1,true,$2,$3)',[user_id,new Date(h.app.now()),JSON.stringify({lovelies_creation_marker:marker})]);
   await h.engine.query('INSERT INTO auth.sessions(id,user_id,created_at) VALUES($1,$2,$3)',[session_id,user_id,new Date(h.app.now())]);
   const value={access_token:'managed-access-'+crypto.randomUUID(),refresh_token:'managed-refresh-'+crypto.randomUUID(),user_id,session_id,expires_at:h.app.now()+3600000};tokens.set(value.refresh_token,value);
   if(faults.signupLost)throw new ApiError(503,'managed_auth_transport_unresolved');return value;
  },
  async refresh(refreshToken){boundary('refresh');const old=tokens.get(refreshToken);assert(old);tokens.delete(refreshToken);
   const value={...old,access_token:'managed-access-'+crypto.randomUUID(),refresh_token:'managed-refresh-'+crypto.randomUUID(),expires_at:h.app.now()+3600000};tokens.set(value.refresh_token,value);
   if(faults.refreshLost)throw new ApiError(503,'managed_auth_transport_unresolved');return value;
  },
  async signOut(access){boundary('logout');if(faults.wrongProvider)return;const value=[...tokens.values()].find(row=>row.access_token===access);if(value)await h.engine.query('DELETE FROM auth.sessions WHERE id=$1',[value.session_id]);},
  async deleteUser(id){boundary('delete');if(faults.deleteLost)throw new ApiError(503,'managed_auth_delete_unresolved');if(faults.wrongProvider)return;await h.engine.query('DELETE FROM auth.users WHERE id=$1',[id]);},
  async userExists(id){boundary('get-user');if(faults.wrongProvider)return false;if(faults.falsePresence)return true;return (await h.engine.query('SELECT id FROM auth.users WHERE id=$1',[id])).rows.length===1;},
  async signupCandidates(marker,createdAt,page){boundary('list-users');assert.equal(page,1);const rows=(await h.engine.query("SELECT id FROM auth.users WHERE is_anonymous=true AND raw_user_meta_data->>'lovelies_creation_marker'=$1 AND created_at>=$2 AND created_at<=$3",[marker,new Date(createdAt-5000),new Date(createdAt+60000)])).rows;
   return {userIds:rows.map(row=>row.id),nextPage:1};},
  async ready(){boundary('ready');return true;}
 };
 Object.assign(h.env,{MANAGED_AUTH:provider,MANAGED_AUTH_ENCRYPTION_KEY:Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')});
 return {h,provider,tokens,trace,faults};
}
const sid=credentials=>JSON.parse(Buffer.from(credentials.access_token.split('.')[1],'base64url')).jti;
const refreshBody=credentials=>({protocol:'lovelies-refresh-delivery-v1',rotation_key:crypto.randomUUID(),delivery_secret:Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),refresh_token:credentials.refresh_token});

test('managed anonymous session is encrypted behind the unchanged canonical app capability and rotates once',async t=>{
 const {h,trace,tokens}=await fixture(t),guest=await h.anonymous();
 assert.equal(guest.expires_in,900);assert.equal(guest.auth_method,'anonymous');assert(!JSON.stringify(guest).includes('managed-'));
 const first=await h.db.one('SELECT * FROM managed_auth_bindings WHERE local_session_id=?',sid(guest));
 assert.equal(first.account_id,guest.account_id);assert.equal(first.state,'bound');assert.notEqual(first.auth_user_id,guest.account_id);
 const serialized=JSON.stringify(first);for(const value of tokens.values())for(const key of ['access_token','refresh_token'])assert(!serialized.includes(value[key]));
 const output=JSON.stringify(await collectPrivacyExport(h.app,guest.account_id));
 for(const forbidden of [first.creation_marker,first.ciphertext,first.iv,first.auth_user_id,first.auth_session_id])assert(!output.includes(forbidden));
 const body=refreshBody(guest),next=await h.json('/auth/session/refresh',{body});
 assert.deepEqual(await h.json('/auth/session/refresh',{body}),next);assert.equal(trace.filter(name=>name==='refresh').length,1);
 assert.equal(next.account_id,guest.account_id);await h.json('/me',{token:guest.access_token},401);await h.json('/me',{token:next.access_token});
 const rows=await h.db.all('SELECT state,ciphertext FROM managed_auth_bindings ORDER BY created_at,id');
 assert.equal(rows.filter(row=>row.state==='bound').length,1);assert.equal(rows.find(row=>row.state==='superseded').ciphertext,null);
 await h.json('/auth/logout',{token:next.access_token,body:{}});assert(trace.includes('logout'));assert(trace.includes('delete'));
 await assertManagedAccountRetired(h.app,guest.account_id);await h.json('/me',{token:next.access_token},401);
});

test('external managed logout, deletion, ban, expiry and restore incarnation deny an otherwise valid app JWT',async t=>{
 const {h}=await fixture(t);
 for(const [name,change] of [
  ['logout',row=>h.engine.query('DELETE FROM auth.sessions WHERE id=$1',[row.auth_session_id])],
  ['deleted user',row=>h.engine.query('DELETE FROM auth.users WHERE id=$1',[row.auth_user_id])],
  ['banned user',row=>h.engine.query('UPDATE auth.users SET banned_until=$1 WHERE id=$2',[new Date(Date.now()+3600000),row.auth_user_id])],
  ['session deadline',row=>h.engine.query('UPDATE auth.sessions SET not_after=$1 WHERE id=$2',[new Date(Date.now()-1),row.auth_session_id])],
  ['restore incarnation',()=>h.db.run('UPDATE restore_control SET incarnation_id=? WHERE singleton=1',crypto.randomUUID())]
 ])await t.test(name,async()=>{const guest=await h.anonymous(),row=await h.db.one('SELECT * FROM managed_auth_bindings WHERE local_session_id=?',sid(guest));await change(row);
  const result=await h.json('/me',{token:guest.access_token},401);assert.equal(result.error.code,'managed_auth_session_invalid');});
});

test('backend face verification preserves the canonical account while mapping separate anonymous managed identities',async t=>{
 const {h}=await fixture(t),face=await enroll(h);
 assert.equal(face.account_id,face.anonymous.account_id);assert.equal(face.auth_method,'registered_face');
 const rows=await h.db.all('SELECT account_id,auth_user_id FROM managed_auth_bindings WHERE account_id=?',face.account_id);
 assert.equal(rows.length,2);assert.equal(new Set(rows.map(row=>row.auth_user_id)).size,2);
 assert((await h.engine.query('SELECT is_anonymous FROM auth.users')).rows.every(row=>row.is_anonymous));
 await h.json('/me',{token:face.token});await h.json('/me',{token:face.anonymous.access_token},401);
 await h.db.run("UPDATE auth_devices SET status='revoked' WHERE id=?",face.deviceId);await h.json('/me',{token:face.token},401);
});

test('uncertain signup creates no account/session and compensation never fabricates positive authority',async t=>{
 const {h,faults,trace}=await fixture(t);faults.signupLost=true;
 await h.json('/auth/anonymous',{body:{}},503);
 assert.equal((await h.db.one('SELECT count(*) n FROM accounts')).n,0);assert.equal((await h.db.one('SELECT count(*) n FROM sessions')).n,0);
 const row=await h.db.one('SELECT * FROM managed_auth_bindings');assert.equal(row.state,'ambiguous');assert.equal(row.auth_user_id,null);
 const tick=Date.now()+61000;h.app.now=()=>tick;
 await assert.rejects(()=>assertManagedAccountRetired(h.app,row.account_id),{code:'managed_auth_account_cleanup_required'});
 assert.deepEqual(await maintainManagedAuth(h.app),{retired:1,unresolved:0});
 assert(trace.includes('list-users'));assert(trace.includes('delete'));assert.equal(trace.filter(name=>name==='signup').length,1);
 await assertManagedAccountRetired(h.app,row.account_id);assert.equal((await h.db.one('SELECT count(*) n FROM sessions')).n,0);
});

test('uncertain refresh is durable, never replays consumed provider tokens, and failed cleanup blocks account erasure',async t=>{
 const {h,faults,trace}=await fixture(t),guest=await h.anonymous(),body=refreshBody(guest);faults.refreshLost=true;
 await h.json('/auth/session/refresh',{body},503);await h.json('/auth/session/refresh',{body},503);
 assert.equal(trace.filter(name=>name==='refresh').length,1);assert.equal((await h.db.one('SELECT count(*) n FROM sessions')).n,1);
 faults.deleteLost=true;
 await assert.rejects(()=>retireManagedAccount(h.app,guest.account_id,async()=>{}),{code:'managed_auth_account_cleanup_required'});
 await h.json('/me',{token:guest.access_token},401);assert.equal((await h.db.one('SELECT disabled_at FROM accounts WHERE id=?',guest.account_id)).disabled_at!==null,true);
 faults.deleteLost=false;await retireManagedAccount(h.app,guest.account_id,async()=>{});await assertManagedAccountRetired(h.app,guest.account_id);
});

test('provider absence cannot retire an existing local Auth user with no current session',async t=>{
 const {h,faults}=await fixture(t);
 for(const [name,change] of [
  ['no sessions',row=>h.engine.query('DELETE FROM auth.sessions WHERE user_id=$1',[row.auth_user_id])],
  ['banned user',row=>h.engine.query('UPDATE auth.users SET banned_until=$1 WHERE id=$2',[new Date(Date.now()+3600000),row.auth_user_id])],
  ['soft-deleted user',row=>h.engine.query('UPDATE auth.users SET deleted_at=$1 WHERE id=$2',[new Date(),row.auth_user_id])]
 ])await t.test(name,async()=>{
  const guest=await h.anonymous(),before=await h.db.one('SELECT * FROM managed_auth_bindings WHERE local_session_id=?',sid(guest));await change(before);
  assert.equal((await h.db.one('SELECT managed_auth_session_current(?,?,?) AS current',before.auth_user_id,before.auth_session_id,h.app.now())).current,false);
  assert.equal((await h.db.one('SELECT managed_auth_user_absent(?) AS absent',before.auth_user_id)).absent,false);
  faults.wrongProvider=true;
  await assert.rejects(()=>retireManagedAccount(h.app,guest.account_id,async()=>{}),{code:'managed_auth_account_cleanup_required'});
  const held=await h.db.one('SELECT * FROM managed_auth_bindings WHERE id=?',before.id);
  assert.equal(held.state,'retiring');assert.equal(held.user_deleted_at,null);assert.equal(held.ciphertext,before.ciphertext);assert.equal(held.iv,before.iv);
  assert.equal((await h.engine.query('SELECT id FROM auth.users WHERE id=$1',[before.auth_user_id])).rows.length,1);
  faults.wrongProvider=false;await retireManagedAccount(h.app,guest.account_id,async()=>{});await assertManagedAccountRetired(h.app,guest.account_id);
  const retired=await h.db.one('SELECT state,ciphertext,iv,user_deleted_at FROM managed_auth_bindings WHERE id=?',before.id);
  assert.equal(retired.state,'retired');assert.equal(retired.ciphertext,null);assert.equal(retired.iv,null);assert.ok(retired.user_deleted_at>0);
  assert.equal((await h.db.one('SELECT managed_auth_user_absent(?) AS absent',before.auth_user_id)).absent,true);
 });
});

test('local physical deletion alone cannot clear custody before provider absence is confirmed',async t=>{
 const {h,faults}=await fixture(t),guest=await h.anonymous(),before=await h.db.one('SELECT * FROM managed_auth_bindings WHERE local_session_id=?',sid(guest));
 faults.falsePresence=true;await assert.rejects(()=>retireManagedAccount(h.app,guest.account_id,async()=>{}),{code:'managed_auth_account_cleanup_required'});
 assert.equal((await h.db.one('SELECT managed_auth_user_absent(?) AS absent',before.auth_user_id)).absent,true);
 const held=await h.db.one('SELECT ciphertext,iv,user_deleted_at FROM managed_auth_bindings WHERE id=?',before.id);
 assert.deepEqual(held,{ciphertext:before.ciphertext,iv:before.iv,user_deleted_at:null});
 faults.falsePresence=false;await retireManagedAccount(h.app,guest.account_id,async()=>{});await assertManagedAccountRetired(h.app,guest.account_id);
});

test('managed Auth readiness requires both restricted predicates and no direct Auth table or column grants',async t=>{
 const {h}=await fixture(t);h.env.MODEL_SERVICE_READINESS=async()=>true;h.env.PHOTO_PROCESSOR={fetch:async()=>assert.fail('readiness must not process images')};
 assert.equal((await h.json('/ready')).managed_auth_ready,true);
 const signature='lovelies_private.managed_auth_user_absent(text)';
 for(const predicate of [signature,'lovelies_private.managed_auth_session_current(text,text,bigint)']){
  for(const role of ['PUBLIC','anon','authenticated']){
   await h.engine.exec('GRANT EXECUTE ON FUNCTION '+predicate+' TO '+role);
   assert.equal((await h.json('/ready',{},503)).managed_auth_ready,false);
   await h.engine.exec('REVOKE EXECUTE ON FUNCTION '+predicate+' FROM '+role);
  }
  await h.engine.exec('ALTER FUNCTION '+predicate+' SECURITY INVOKER');
  assert.equal((await h.json('/ready',{},503)).managed_auth_ready,false);
  await h.engine.exec('ALTER FUNCTION '+predicate+' SECURITY DEFINER');
 }
 for(const table of ['auth.users','auth.sessions']){
  await h.engine.exec('GRANT SELECT ON '+table+' TO lovelies_api');
  assert.equal((await h.json('/ready',{},503)).managed_auth_ready,false);
  await h.engine.exec('REVOKE SELECT ON '+table+' FROM lovelies_api');
  await h.engine.exec('GRANT SELECT(id) ON '+table+' TO lovelies_api');
  assert.equal((await h.json('/ready',{},503)).managed_auth_ready,false);
  await h.engine.exec('REVOKE SELECT(id) ON '+table+' FROM lovelies_api');
 }
 await h.engine.exec('ALTER FUNCTION '+signature+' RENAME TO managed_auth_user_absent_removed');
 assert.equal((await h.json('/ready',{},503)).managed_auth_ready,false);
 await h.engine.exec('ALTER FUNCTION lovelies_private.managed_auth_user_absent_removed(text) RENAME TO managed_auth_user_absent');
 assert.equal((await h.json('/ready')).managed_auth_ready,true);
});

test('managed Auth rejects network work within a local transaction and equivalent encryption/signing keys',async t=>{
 const {h,trace}=await fixture(t),spec={accountId:crypto.randomUUID(),authMethod:'anonymous'};
 await assert.rejects(()=>h.db.transaction(()=>prepareManagedSession(spec,Date.now()+900000,Date.now()+86400000,h.app)),{code:'managed_auth_transaction_boundary'});
 h.env.AUTH_SIGNING_SECRET='a'.repeat(32);h.env.MANAGED_AUTH_ENCRYPTION_KEY=Buffer.from(h.env.AUTH_SIGNING_SECRET).toString('base64url');
 await assert.rejects(()=>prepareManagedSession(spec,Date.now()+900000,Date.now()+86400000,h.app),{code:'managed_auth_encryption_configuration'});
 assert.deepEqual(trace,[]);
});
