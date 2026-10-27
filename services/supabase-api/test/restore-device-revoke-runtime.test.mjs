/** External, prepared and unexecuted. Root copies this file into the API test
 * folder only after candidate review/apply. Existing actual-PG restore/fault
 * harness is reused; no provider/recognition or serving recovery is claimed. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createApp,createHandler} from '../src/index.ts';
import {restoreOperationID,restoreAllocationID} from '../src/restore-transaction.ts';
import {insertPreparedSession,prepareSession} from '../src/auth.ts';
import {sessionRetirementScope} from '../src/session-retirement.ts';
import {enroll,prepareEnrollment,captureProofs,faceVerifierFixture,sign,encode,stable} from './runtime-harness.mjs';
import {fixture,digest,unavailable} from './restore-database-fixture.mjs';
const POLICY='face-policy-fixture-v1',DEVICE_PROTOCOL='lovelies-face-profile-device-v1';
const sessionID=token=>JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString()).jti;
const ordered=facts=>[...new Map(facts.map(fact=>[stable(fact),fact])).entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,fact])=>fact);
const sessionFact=(f,id=f.targetID)=>({kind:'session-retired',scope:{account_id:f.person.accountId,session_id:id}});
const deviceFact=f=>({kind:'device-retired',scope:{account_id:f.person.accountId,device_id:f.person.deviceId,device_revision:f.originalDevice.revision}});
const consentFact=(f,id)=>({kind:'consent-withdrawn',scope:{account_id:f.person.accountId,consent_id:id,purpose:'face_authentication'}});
const operationFor=(account,device)=>restoreOperationID(account,'identity.device-revoke-v1','device.revoke:'+digest(stable({device_id:device.id,device_revision:device.revision})));
const operationID=f=>operationFor(f.person.accountId,f.originalDevice);
const target=f=>f.h.db.one('SELECT id,account_id,revision,status,created_at,public_jwk,face_handle FROM auth_devices WHERE id=?',f.person.deviceId);
const targetSession=f=>f.h.db.one('SELECT * FROM sessions WHERE id=?',f.targetID);
const auditRows=f=>f.h.db.all("SELECT * FROM audit_events WHERE action='device.revoke' ORDER BY id");
const cursor=async f=>(await f.journal.control()).marker.cursor.sequence;
async function login(h, person) {
  const challenge = await h.json('/auth/face/challenge', { body: { face_handle: person.faceHandle, device_id: person.deviceId } }, 201);
  const credentials = await h.json('/auth/face/complete', { body: await captureProofs(h, challenge, person.keys.privateKey) });
  return { ...person, ...credentials, token: credentials.access_token };
}
async function deviceFixture(t, { registered = true } = {}) {
  const f = await fixture(t), h = f.h;
  h.env.FACE_AUTH_VERIFIER = { fetch: async request => {
    const form = await request.formData(); return Response.json(await faceVerifierFixture(JSON.parse(String(form.get('envelope'))), form));
  } };
  const guest = registered ? null : await h.anonymous({ adult: true });
  // Exactly one session has ever occupied the target device at admission.
  // Canonical enrollment supplies that session; no hidden same-device logins
  // may mask the guard under test or invalidate positive cancellation fixtures.
  const person = registered ? await enroll(h) : { ...guest, token: guest.access_token, accountId: guest.account_id, deviceId: null };
  let peer = null;
  const foreign = await h.anonymous({ adult: true });
  const targetID = sessionID(person.token), original = await h.db.one('SELECT * FROM sessions WHERE id=?', targetID);
  const profile = await h.db.one('SELECT * FROM face_profiles WHERE account_id=?', person.accountId);
  const originalDevice = person.deviceId ? await h.db.one('SELECT id,account_id,revision,status,created_at,public_jwk,face_handle FROM auth_devices WHERE id=?',person.deviceId) : null;
  let clock = h.app.now(); const handler = createHandler(createApp(f.db, h.env, () => clock));
  const request = ({ token = person.token, body = { device_id: person.deviceId } } = {}) => handler(new Request('https://api.invalid/auth/device/revoke', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body),
  }));
  const call = async (expected = 200, options) => {
    const response = await request(options), value = await response.json(); assert.equal(response.status, expected, value?.error?.code ?? 'unexpected_response'); return value;
  };
  const uncertain = async options => { const response = await request(options); assert(response.status >= 500 && response.status <= 599); await response.body?.cancel(); };
  const otherDevice = async () => {
    const id = randomUUID(), revision = randomUUID(); let publicJWK;
    if (person.deviceId) publicJWK = (await h.db.one('SELECT public_jwk FROM auth_devices WHERE id=?', person.deviceId)).public_jwk;
    else { const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']); publicJWK = JSON.stringify(await crypto.subtle.exportKey('jwk', keys.publicKey)); }
    await h.db.run("INSERT INTO auth_devices(id,account_id,public_jwk,revision,status,face_handle,created_at) VALUES(?,?,?,?,'active',?,?)", id, person.accountId, publicJWK, revision, 'synthetic-peer-device-' + id, h.app.now()); return id;
  };
  // The optional surviving caller is an explicit other-device stored fixture.
  // Canonical signing/insertion guards establish its own-security credential;
  // this does not claim another physical-device face-verification journey.
  const independentCaller = async () => {
    assert(registered);
    const deviceID = await otherDevice(), device = await h.db.one('SELECT * FROM auth_devices WHERE id=?', deviceID);
    const account = await h.db.one('SELECT auth_epoch FROM accounts WHERE id=?', person.accountId);
    const prepared = await prepareSession({ accountId: person.accountId, roles: ['user'], authEpoch: account.auth_epoch,
      authMethod: 'registered_face', profileRevision: profile.revision, profileEpoch: profile.auth_epoch,
      consentId: profile.auth_consent_id, deviceId: deviceID, deviceRevision: device.revision }, h.app);
    await h.db.transaction(() => insertPreparedSession(prepared, h.app, true));
    return { ...person, ...prepared.credentials, token: prepared.credentials.access_token, deviceId: deviceID };
  };
  if (registered) peer = await independentCaller();
  if (registered) assert.deepEqual(await h.db.all('SELECT id FROM sessions WHERE account_id=? AND device_id=? ORDER BY id', person.accountId, person.deviceId),
    [{ id: targetID }], 'The target device must have a genuinely exclusive session baseline');
  const pending = async ({ consentID = randomUUID(), consentOwner = person.accountId, purpose = 'face_authentication', status = 'granted', deviceID = person.deviceId } = {}) => {
    assert(deviceID); if (registered && deviceID === person.deviceId) await ensureControl();
    const device = await h.db.one('SELECT revision FROM auth_devices WHERE id=?', deviceID);
    if (!await h.db.one('SELECT id FROM consents WHERE id=?', consentID)) await h.db.run(`INSERT INTO consents(id,account_id,purpose,policy_version,status,revoked_at,created_at,profile_revision) VALUES(?,?,?,?,?,?,?,?)`,
      consentID, consentOwner, purpose, purpose === 'face_authentication' ? POLICY : 'photo-policy-fixture-v1', status, status === 'revoked' ? h.app.now() : null, h.app.now(), profile?.revision ?? randomUUID());
    const operationKey = randomUUID();
    await h.db.run(`INSERT INTO face_profile_operations(account_id,operation_key,action,input_hash,expected_version,control_device_id,control_revision,state,auth_epoch,consent_id,generation,created_at,expires_at)
      VALUES(?,?,'replace',?,1,?,?,'pending',?,?,0,?,?)`, person.accountId, operationKey, 'a'.repeat(64), deviceID, device.revision, original.auth_epoch, consentID, h.app.now(), h.app.now() + 86400000);
    return { consentID, operationKey };
  };
  let control, controlInstalled = false;
  const signedControl = async (step, fields, creation = false) => {
    control ??= { key: 'lfl_' + encode(crypto.getRandomValues(new Uint8Array(32))), operationKey: randomUUID() };
    const body = { account_id: person.accountId, device_id: person.deviceId, control_key: control.key,
      ...(!creation ? { request_nonce: randomUUID(), request_expires_at: Date.now() + 45000 } : {}), ...fields };
    return { ...body, device_signature: await sign(person.keys.privateKey, { protocol: DEVICE_PROTOCOL, step, ...body }) };
  };
  const ensureControl = async (token = person.token) => {
    assert(registered); if (controlInstalled) return;
    control ??= { key: 'lfl_' + encode(crypto.getRandomValues(new Uint8Array(32))), operationKey: randomUUID() };
    await h.json('/auth/face/profile/control', { token, body: await signedControl('control', { control_operation_key: control.operationKey }, true) }, 201);
    controlInstalled = true;
  };
  const realPending = async (token = person.token) => {
    assert(registered); await ensureControl(token);
    const state = await h.db.one('SELECT version FROM face_profile_states WHERE account_id=?', person.accountId), key = randomUUID();
    await h.json('/auth/face/profile/challenge', { body: await signedControl('challenge', { operation_key: key, action: 'replace', expected_version: state.version,
      consent: { purpose: 'face_authentication', policy_version: POLICY, granted: true } }) }, 201);
    return h.db.one('SELECT * FROM face_profile_operations WHERE account_id=? AND operation_key=?', person.accountId, key);
  };
  const seedPush = async () => {
    const id = randomUUID(), token = 'synthetic-private-session-push-' + randomUUID(), hash = digest(token); assert(person.deviceId);
    await h.db.run("INSERT INTO push_devices(id,account_id,auth_device_id,platform,token_hash,token_value,active,created_at,updated_at) VALUES(?,?,?,'ios',?,?,1,?,?)", id, person.accountId, person.deviceId, hash, token, h.app.now(), h.app.now());
    for (const status of ['queued', 'accepted']) { const notification = randomUUID();
      await h.db.run("INSERT INTO notifications(id,account_id,kind,entity_id,title,created_at) VALUES(?,?,'support',?,'Synthetic own-session fixture',?)", notification, person.accountId, randomUUID(), h.app.now());
      await h.db.run('INSERT INTO notification_deliveries(id,notification_id,device_id,operation_key,status,token_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', randomUUID(), notification, id, randomUUID(), status, hash, h.app.now(), h.app.now());
    } return { id, token };
  };
  return { ...f, person, peer, foreign, targetID, original, originalDevice, profile, request, call, uncertain, pending, otherDevice, independentCaller, ensureControl, realPending, signedControl, seedPush, now: () => clock, setClock: value => { clock = value; } };
}

async function snapshot(f){
  const tables=['accounts','sessions','consents','auth_devices','auth_challenges','face_profile_controls','face_profile_operations','face_profiles','push_devices','notification_deliveries','audit_events','operations','operation_subjects'];const result={};
  for(const table of tables){const order=table==='face_profile_operations'?'account_id,operation_key':table==='face_profile_controls'?'account_id,device_id':table==='face_profiles'?'account_id':['operations','operation_subjects'].includes(table)?'actor_id,source,operation_key'+(table==='operation_subjects'?',subject_id':''):'id';result[table]=await f.h.db.all('SELECT * FROM '+table+' ORDER BY '+order);}
  return result;
}
async function assertPlan(f,facts,status='committed'){
  const id=await operationID(f),saved=await f.journal.lookup(id);assert(saved);assert.equal(saved.status,status);
  assert.deepEqual(saved.plan.allocations,{id_0:await restoreAllocationID(id,'id_0')});
  assert.equal(saved.plan.input_hash,digest(stable({protocol:'lovelies-own-device-revoke-v1',account_id:f.person.accountId,device_id:f.person.deviceId,
    device_revision:f.originalDevice.revision,device_created_at:f.originalDevice.created_at,auth_epoch:f.original.auth_epoch,identity_state:f.original.auth_method})));
  assert.deepEqual(saved.plan.events.map(({kind,scope})=>({kind,scope})),ordered(facts));
  assert.equal(new Set(saved.plan.events.map(row=>row.operation_id)).size,ordered(facts).length);
  const raw=JSON.stringify(saved.plan);
  for(const field of ['access_token','refresh_token','refresh_hash','public_jwk','template_key','template_digest','control_key','token_value','face_handle'])assert(!raw.includes('"'+field+'"'));
  for(const value of [f.person.token,f.person.refresh_token,f.person.faceHandle,f.peer?.token,f.profile?.template_key,f.profile?.template_digest].filter(Boolean))assert(!raw.includes(value));
  return saved;
}
async function expectRetired(f,facts){
  const saved=await assertPlan(f,facts),device=await target(f);
  assert.deepEqual(device,{...f.originalDevice,status:'revoked',revision:saved.plan.allocations.id_0,face_handle:null});
  assert.equal((await auditRows(f)).length,1);return saved;
}
function peerCall(f,body={device_id:f.person.deviceId}){return {token:f.peer.token,body};}

test('native keyless self-device retirement journals the old revision and stable replacement allocation',async t=>{
  const f=await deviceFixture(t),before=await snapshot(f),reply=await f.call();
  assert.deepEqual(reply,{status:'revoked',current_session_revoked:true,clear_device_identity:true});
  await expectRetired(f,[deviceFact(f),sessionFact(f)]);assert.notEqual((await targetSession(f)).revoked_at,null);
  const after=await snapshot(f);for(const table of ['face_profiles','push_devices','notification_deliveries','face_profile_controls'])assert.deepEqual(after[table],before[table]);
  await f.call(401);await f.h.json('/me',{token:f.peer.token});
});
test('fresh other-device caller retires the exact device while preserving its own authority and current flags',async t=>{
  const f=await deviceFixture(t);assert.deepEqual(await f.call(200,peerCall(f)),{status:'revoked',current_session_revoked:false,clear_device_identity:false});
  await expectRetired(f,[deviceFact(f),sessionFact(f)]);await f.h.json('/me',{token:f.peer.token});
});
test('already-revoked retry ignores former optional keys and causes no revision, audit or fact churn',async t=>{
  const f=await deviceFixture(t);await f.call();const saved=await expectRetired(f,[deviceFact(f),sessionFact(f)]),before=await snapshot(f);
  for(const key of [undefined,'formerly-ignored-key-a','formerly-ignored-key-b']){
    await f.call(200,peerCall(f,{device_id:f.person.deviceId,...(key?{operation_key:key}:{})}));assert.deepEqual(await snapshot(f),before);
    assert.deepEqual(await f.journal.lookup(await operationID(f)),saved);
  }assert.equal(await cursor(f),2);
});
test('actual sole-session pending lifecycle is cancelled with exact consent facts; profile and push stay intact',async t=>{
  const f=await deviceFixture(t),pending=await f.realPending();await f.seedPush();const before=await snapshot(f);await f.call();
  await expectRetired(f,[deviceFact(f),sessionFact(f),consentFact(f,pending.consent_id)]);const after=await snapshot(f);
  assert.equal(after.face_profile_operations.find(row=>row.operation_key===pending.operation_key).state,'cancelled');
  assert.equal(after.auth_challenges.find(row=>row.id===pending.challenge_id).status,'cancelled');assert.equal(after.consents.find(row=>row.id===pending.consent_id).status,'revoked');
  for(const table of ['face_profiles','push_devices','notification_deliveries','face_profile_controls'])assert.deepEqual(after[table],before[table]);
});
test('two actual same-device sessions retire as a cohort while their ambiguous pending lifecycle survives',async t=>{
  const f=await deviceFixture(t),later=await login(f.h,f.person),pending=await f.realPending(later.token),before=await snapshot(f);await f.call();
  await expectRetired(f,[deviceFact(f),sessionFact(f),sessionFact(f,sessionID(later.token))]);const after=await snapshot(f);
  for(const table of ['consents','face_profile_operations','auth_challenges','face_profiles'])assert.deepEqual(after[table],before[table]);
  for(const id of [f.targetID,sessionID(later.token)])assert.notEqual(after.sessions.find(row=>row.id===id).revoked_at,null);
  assert.equal(after.face_profile_operations.find(row=>row.operation_key===pending.operation_key).state,'pending');
});
for(const drift of ['revision','epoch'])test('unknown '+drift+' session is preserved rather than acquired by a device-ID selector',async t=>{
  const f=await deviceFixture(t),later=await login(f.h,f.person),id=sessionID(later.token);
  if(drift==='revision')await f.h.db.run('UPDATE sessions SET device_revision=? WHERE id=?',randomUUID(),id);else await f.h.db.run('UPDATE sessions SET auth_epoch=auth_epoch+1 WHERE id=?',id);
  const preserved=await f.h.db.one('SELECT * FROM sessions WHERE id=?',id);await f.call();await expectRetired(f,[deviceFact(f),sessionFact(f)]);
  assert.deepEqual(await f.h.db.one('SELECT * FROM sessions WHERE id=?',id),preserved);
});
for(const drift of ['control-revision','control-epoch','linked-owner','linked-device','linked-epoch'])test('device fence preserves '+drift+' lifecycle metadata',async t=>{
  const f=await deviceFixture(t),pending=await f.realPending();
  if(drift==='control-revision')await f.h.db.run('UPDATE face_profile_operations SET control_revision=? WHERE account_id=? AND operation_key=?',randomUUID(),f.person.accountId,pending.operation_key);
  else if(drift==='control-epoch')await f.h.db.run('UPDATE face_profile_operations SET auth_epoch=auth_epoch+1 WHERE account_id=? AND operation_key=?',f.person.accountId,pending.operation_key);
  else if(drift==='linked-owner')await f.h.db.run('UPDATE auth_challenges SET account_id=? WHERE id=?',f.foreign.account_id,pending.challenge_id);
  else if(drift==='linked-device')await f.h.db.run('UPDATE auth_challenges SET device_id=? WHERE id=?',await f.otherDevice(),pending.challenge_id);
  else await f.h.db.run('UPDATE auth_challenges SET auth_epoch=auth_epoch+1 WHERE id=?',pending.challenge_id);
  const before=await snapshot(f);await f.call();await expectRetired(f,[deviceFact(f),sessionFact(f)]);const after=await snapshot(f);
  for(const table of ['consents','face_profile_operations','auth_challenges'])assert.deepEqual(after[table],before[table]);
});
test('a consent shared by another device preserves both pending episodes and the shared consent',async t=>{
  const f=await deviceFixture(t),pending=await f.realPending(),other=await f.otherDevice();await f.pending({consentID:pending.consent_id,deviceID:other});
  const before=await snapshot(f);await f.call();await expectRetired(f,[deviceFact(f),sessionFact(f)]);const after=await snapshot(f);
  for(const table of ['consents','face_profile_operations','auth_challenges'])assert.deepEqual(after[table],before[table]);
});
test('profile-bound and already-revoked pending consents are preserved without invented withdrawal facts',async t=>{
  const f=await deviceFixture(t);await f.pending({consentID:f.profile.auth_consent_id});await f.pending({status:'revoked'});const before=await f.h.db.all('SELECT * FROM consents ORDER BY id');
  await f.call();await expectRetired(f,[deviceFact(f),sessionFact(f)]);assert.deepEqual(await f.h.db.all('SELECT * FROM consents ORDER BY id'),before);
});
for(const count of [30,31])test((count+2)+' exact device/session/consent facts commit or refuse before every domain effect',async t=>{
  const f=await deviceFixture(t),pending=[];for(let i=0;i<count;i++)pending.push(await f.pending());const before=await snapshot(f);f.trace.length=0;
  if(count===30){await f.call();await expectRetired(f,[deviceFact(f),sessionFact(f),...pending.map(row=>consentFact(f,row.consentID))]);assert.equal(await cursor(f),32);}
  else{assert.equal((await f.call(503)).error.code,'device_revoke_restriction_capacity');assert.deepEqual(await snapshot(f),before);assert.equal(await f.journal.lookup(await operationID(f)),null);
    assert(!f.trace.some(row=>row.kind==='sql'&&/^(INSERT|UPDATE|DELETE) /.test(row.sql)&&!row.sql.startsWith('UPDATE restore_control ')));}
});
for(const malformed of ['cross-account','other-purpose'])test('malformed pending '+malformed+' rolls back before device retirement',async t=>{
  const f=await deviceFixture(t);await f.pending({consentOwner:malformed==='cross-account'?f.foreign.account_id:f.person.accountId,purpose:malformed==='other-purpose'?'photo_matching':'face_authentication'});const before=await snapshot(f);
  assert.equal((await f.call(409)).error.code,'face_profile_pending_consent_invalid');assert.deepEqual(await snapshot(f),before);assert.equal(await f.journal.lookup(await operationID(f)),null);
});
for(const invalid of ['missing','foreign','bad-field'])test(invalid+' device target cannot change any domain row or restriction',async t=>{
  const f=await deviceFixture(t),before=await snapshot(f);let body={device_id:randomUUID()},status=404;
  if(invalid==='foreign'){const person=await enroll(f.h);body={device_id:person.deviceId};}
  else if(invalid==='bad-field'){body={device_id:f.person.deviceId,account_id:f.foreign.account_id};status=400;}
  const selected=invalid==='foreign'?await snapshot(f):before;await f.call(status,{body});assert.deepEqual(await snapshot(f),selected);assert.equal(await f.journal.lookup(await operationID(f)),null);
});
for(const invalid of ['session-revoked','account-disabled','epoch-changed','roles-changed','device-revised'])test('fresh caller rejects '+invalid+' before retirement',async t=>{
  const f=await deviceFixture(t);
  if(invalid==='session-revoked')await f.h.db.run('UPDATE sessions SET revoked_at=? WHERE id=?',f.now(),f.targetID);
  else if(invalid==='account-disabled')await f.h.db.run('UPDATE accounts SET disabled_at=? WHERE id=?',f.now(),f.person.accountId);
  else if(invalid==='epoch-changed')await f.h.db.run('UPDATE accounts SET auth_epoch=auth_epoch+1 WHERE id=?',f.person.accountId);
  else if(invalid==='roles-changed')await f.h.db.run('UPDATE accounts SET roles_json=? WHERE id=?','["admin"]',f.person.accountId);
  else await f.h.db.run('UPDATE auth_devices SET revision=? WHERE id=?',randomUUID(),f.person.deviceId);
  const before=await snapshot(f);await f.call(401);assert.deepEqual(await snapshot(f),before);assert.equal(await f.journal.lookup(await operationID(f)),null);
});
test('weak own-security authority still permits revocation after profile authentication is disabled',async t=>{
  const f=await deviceFixture(t);await f.h.db.run("UPDATE face_profiles SET status='disabled',auth_enabled=0 WHERE account_id=?",f.person.accountId);await f.call();await expectRetired(f,[deviceFact(f),sessionFact(f)]);
});
test('expiry observed after facts rejects before any selected device/session change',async t=>{
  const f=await deviceFixture(t),before=await snapshot(f),transaction=f.db.transaction.bind(f.db);let changed=false;
  f.db.transaction=(callback,intent)=>transaction(restore=>callback({...restore,restrict:async(kind,scope)=>{await restore.restrict(kind,scope);if(!changed){changed=true;f.setClock(f.original.expires_at);}}}),intent);
  await f.call(401);assert(changed);assert.deepEqual(await snapshot(f),before);assert.equal(await f.journal.lookup(await operationID(f)),null);
});
for(const phase of ['second-selection','first-effect'])test('terminal self guard rolls back expiry at '+phase+' completion',async t=>{
  const f=await deviceFixture(t);await f.realPending();const before=await snapshot(f),all=f.db.all.bind(f.db),run=f.db.run.bind(f.db);let selections=0,expired=false,effects=0;
  // This is the last awaited read of the second deviceRetirement selection:
  // the sole-session helper has proven lifecycle cleanup and pending consents.
  // Hooks call only the saved raw delegate, so they do not recursively re-enter
  // the selected query or open a different transaction/fixture connection.
  f.db.all=async(sql,...bindings)=>{const rows=await all(sql,...bindings);
    if(sql.startsWith('SELECT c.account_id,c.id,c.purpose,c.status FROM consents c')&&++selections===2&&phase==='second-selection'){
      expired=true;f.setClock(f.original.expires_at);
    }return rows;
  };
  f.db.run=async(sql,...bindings)=>{await run(sql,...bindings);
    if(sql.startsWith("UPDATE consents SET status='revoked'")){effects++;if(phase==='first-effect'&&!expired){expired=true;f.setClock(f.original.expires_at);}}
    if(sql.startsWith("UPDATE auth_devices SET status='revoked'"))effects++;
  };
  assert.equal((await f.call(401)).error.code,'session_invalid');assert(expired);assert(effects>=2,'Tentative lifecycle and device writes occurred before the terminal guard rejected expiry');
  assert.deepEqual(await snapshot(f),before);assert.equal(await f.journal.lookup(await operationID(f)),null);assert.equal(await cursor(f),0);
});
for(const drift of ['disabled-account','account-roles','session-refresh-hash','equal-access-refresh-expiry'])test('terminal self guard rejects original actor drift after first device effect: '+drift,async t=>{
  const f=await deviceFixture(t);
  if(drift==='equal-access-refresh-expiry'){
    // The real sessions CHECK requires refresh_expires_at>=expires_at.
    // Equal expiry is a schema-valid simultaneous boundary, not independent
    // proof of a refresh-only expiry branch while access remains unexpired.
    await f.h.db.run('UPDATE sessions SET refresh_expires_at=? WHERE id=?',f.original.expires_at,f.targetID);
    f.original=await targetSession(f);assert.equal(f.original.refresh_expires_at,f.original.expires_at);assert(f.now()<f.original.expires_at);
  }
  const before=await snapshot(f),run=f.db.run.bind(f.db);let changed=false;
  f.db.run=async(sql,...bindings)=>{await run(sql,...bindings);if(!changed&&sql.startsWith("UPDATE auth_devices SET status='revoked'")){
    changed=true;
    if(drift==='disabled-account')await run('UPDATE accounts SET disabled_at=? WHERE id=?',f.now(),f.person.accountId);
    else if(drift==='account-roles')await run('UPDATE accounts SET roles_json=? WHERE id=?',JSON.stringify(['user','admin']),f.person.accountId);
    else if(drift==='session-refresh-hash')await run('UPDATE sessions SET refresh_hash=? WHERE id=?',digest('unexpected-after-first-effect'),f.targetID);
    else f.setClock(f.original.refresh_expires_at);
  }};
  assert.equal((await f.call(401)).error.code,'session_invalid');assert(changed);assert.deepEqual(await snapshot(f),before);
  assert.equal(await f.journal.lookup(await operationID(f)),null);assert.equal(await cursor(f),0);
});
for(const drift of ['device','consent'])test('selected '+drift+' changes after facts roll back without an accepted inaccurate plan',async t=>{
  const f=await deviceFixture(t),pending=await f.pending(),before=await snapshot(f),transaction=f.db.transaction.bind(f.db);let changed=false;
  f.db.transaction=(callback,intent)=>transaction(restore=>callback({...restore,restrict:async(kind,scope)=>{await restore.restrict(kind,scope);if(!changed){changed=true;
    if(drift==='device')await f.db.run('UPDATE auth_devices SET revision=? WHERE id=?',randomUUID(),f.person.deviceId);else await f.db.run("UPDATE consents SET status='revoked',revoked_at=? WHERE id=?",f.now(),pending.consentID);
  }}}),intent);
  assert.equal((await f.call(409,peerCall(f))).error.code,'device_revoke_authority_changed');assert(changed);assert.deepEqual(await snapshot(f),before);assert.equal(await f.journal.lookup(await operationID(f)),null);
});
test('callback failure after device SQL rolls device, sessions, lifecycle and audit back before journal acceptance',async t=>{
  const f=await deviceFixture(t);await f.pending();const before=await snapshot(f),run=f.db.run.bind(f.db);let changed=false;
  f.db.run=async(sql,...bindings)=>{await run(sql,...bindings);if(!changed&&sql.startsWith("UPDATE auth_devices SET status='revoked'")){changed=true;throw Error('synthetic_device_callback_failure');}};
  await f.uncertain();assert(changed);assert.deepEqual(await snapshot(f),before);assert.equal(await f.journal.lookup(await operationID(f)),null);
});
for(const self of [true,false])test('concurrent '+(self?'self':'other-device')+' requests retire one device episode only once',async t=>{
  const f=await deviceFixture(t),options=self?{}:peerCall(f),responses=await Promise.all([f.request(options),f.request(options)]);
  assert.deepEqual(responses.map(row=>row.status).sort(),self?[200,401]:[200,200]);for(const response of responses)await response.body?.cancel();await expectRetired(f,[deviceFact(f),sessionFact(f)]);assert.equal(await cursor(f),2);
});
test('accepted device plan followed by rejected SQL commit remains pending and cannot replay the callback',async t=>{
  const f=await deviceFixture(t),pending=await f.pending(),before=await snapshot(f),id=await operationID(f),prepare=f.journal.prepare.bind(f.journal);let armed=true;
  f.journal.prepare=async value=>{const saved=await prepare(value);if(armed&&value.operation_id===id){armed=false;f.faults.beforeCommit=true;}return saved;};
  await f.uncertain();assert.equal(armed,false);assert.equal(f.faults.beforeCommit,false);assert.deepEqual(await snapshot(f),before);
  const saved=await assertPlan(f,[deviceFact(f),sessionFact(f),consentFact(f,pending.consentID)],'pending');await assert.rejects(()=>f.db.one('SELECT id FROM accounts LIMIT 1'),unavailable);
  await f.uncertain();assert.deepEqual(await snapshot(f),before);assert.deepEqual(await f.journal.lookup(id),saved);
});
for(const mode of ['outage','prepare-before','prepare-after','commit-result-loss','ack-before','ack-after'])test('device retirement '+mode+' retains exact allocation and actual commit boundary',async t=>{
  const f=await deviceFixture(t),pending=await f.pending(),before=await snapshot(f),id=await operationID(f),facts=[deviceFact(f),sessionFact(f),consentFact(f,pending.consentID)];let boundary;
  if(mode==='outage')f.faults.control=true;else if(mode.startsWith('prepare-'))f.faults.reply={path:'/v1/operations/prepare',stage:mode.slice(8)};
  else if(mode==='commit-result-loss'){const prepare=f.journal.prepare.bind(f.journal);let armed=true;f.journal.prepare=async value=>{const saved=await prepare(value);if(armed&&value.operation_id===id){armed=false;f.faults.commitReply=true;
    f.faults.afterCommit=async()=>{delete f.faults.afterCommit;boundary={journal:await f.journal.lookup(id),device:await target(f),consent:await f.h.db.one('SELECT * FROM consents WHERE id=?',pending.consentID),audit:await auditRows(f)};};}return saved;};}
  else f.faults.reply={path:'/v1/operations/'+id+'/acknowledge',stage:mode.slice(4)};
  await f.uncertain();const saved=await f.journal.lookup(id);
  if(mode==='outage'||mode==='prepare-before'){assert.deepEqual(await snapshot(f),before);assert.equal(saved,null);f.faults.control=false;if(mode==='prepare-before')assert.equal(f.faults.reply,undefined);await f.call();await expectRetired(f,facts);return;}
  if(mode==='prepare-after'){assert.equal(f.faults.reply,undefined);assert.deepEqual(await snapshot(f),before);await assertPlan(f,facts,'pending');await assert.rejects(()=>f.db.one('SELECT id FROM accounts LIMIT 1'),unavailable);await f.uncertain();assert.deepEqual(await snapshot(f),before);return;}
  assert.equal((await target(f)).status,'revoked');assert.equal((await f.h.db.one('SELECT status FROM consents WHERE id=?',pending.consentID)).status,'revoked');
  if(mode==='commit-result-loss'){assert(boundary);assert.equal(boundary.journal.status,'pending');assert.equal(boundary.device.status,'revoked');assert.equal(boundary.consent.status,'revoked');assert.equal(boundary.audit.length,1);assert.equal(f.faults.commitReply,false);assert.equal(f.faults.afterCommit,undefined);assert.equal(saved.status,'committed');}
  else{assert.equal(f.faults.reply,undefined);assert.equal(saved.status,mode==='ack-before'?'pending':'committed');}
  await f.call(401);const terminal=await snapshot(f);await f.call(200,peerCall(f));assert.deepEqual(await snapshot(f),terminal);assert.equal((await assertPlan(f,facts)).plan_hash,saved.plan_hash);assert.equal(await cursor(f),facts.length);
});

test('a legitimate opaque legacy revision is journaled exactly rather than forced to a UUID',async t=>{
  const f=await deviceFixture(t),revision='legacy_revision-v1';
  await f.h.db.run('UPDATE auth_devices SET revision=? WHERE id=?',revision,f.person.deviceId);await f.h.db.run('UPDATE sessions SET device_revision=? WHERE id=?',revision,f.targetID);
  f.originalDevice=await target(f);f.original=await targetSession(f);await f.call();await expectRetired(f,[deviceFact(f),sessionFact(f)]);
});
test('an unknown selected session ID blocks before any retirement rather than losing an unjournalable row',async t=>{
  const f=await deviceFixture(t),row=await targetSession(f),id='unknown-test-session-preserve';
  // A registered session must retain its profile and consent references under
  // the actual PostgreSQL CHECK. Only its opaque session ID is malformed.
  assert.equal(row.auth_method,'registered_face');assert(row.face_profile_revision);assert(row.face_consent_id);
  assert(row.expires_at>f.now());assert(row.refresh_expires_at>=row.expires_at);
  await f.h.db.run(`INSERT INTO sessions(id,account_id,refresh_hash,expires_at,refresh_expires_at,auth_epoch,auth_method,face_profile_revision,face_consent_id,device_id,device_revision,created_at,face_profile_epoch) VALUES(?,?,?,?,?,?,'registered_face',?,?,?,?,?,?)`,id,f.person.accountId,digest(randomUUID()),row.expires_at,row.refresh_expires_at,row.auth_epoch,row.face_profile_revision,row.face_consent_id,f.person.deviceId,row.device_revision,f.now(),row.face_profile_epoch);
  const selected=await f.h.db.one('SELECT id,account_id,auth_method,device_id,device_revision,auth_epoch,revoked_at FROM sessions WHERE id=?',id);
  assert.deepEqual(selected,{id,account_id:f.person.accountId,auth_method:'registered_face',device_id:f.person.deviceId,device_revision:f.originalDevice.revision,auth_epoch:row.auth_epoch,revoked_at:null});
  const before=await snapshot(f),beforeCursor=await cursor(f);assert.equal((await f.call(409)).error.code,'device_revoke_metadata_invalid');assert.deepEqual(await snapshot(f),before);assert.equal(await f.journal.lookup(await operationID(f)),null);assert.equal(await cursor(f),beforeCursor);
});
test('a future control equal to the allocated fence revision remains inert across repeated device retirement',async t=>{
  const f=await deviceFixture(t),pending=await f.realPending(),allocated=await restoreAllocationID(await operationID(f),'id_0');
  await f.h.db.run('UPDATE face_profile_operations SET control_revision=? WHERE account_id=? AND operation_key=?',allocated,f.person.accountId,pending.operation_key);
  const before=await snapshot(f);await f.call();await expectRetired(f,[deviceFact(f),sessionFact(f)]);const retired=await snapshot(f);
  for(const table of ['consents','face_profile_operations','auth_challenges'])assert.deepEqual(retired[table],before[table]);
  await f.h.json('/auth/face/profile/status',{body:await f.signedControl('status')},401);
  await f.call(200,peerCall(f));assert.deepEqual(await snapshot(f),retired);assert.equal(await cursor(f),2);
});

test('unsupported live device metadata fails before changing that unknown row',async t=>{
  const f=await deviceFixture(t);await f.h.db.run('UPDATE auth_devices SET revision=? WHERE id=?','unknown.revision.preserve',f.person.deviceId);
  const before=await snapshot(f);assert.equal((await f.call(409,peerCall(f))).error.code,'device_revoke_metadata_invalid');assert.deepEqual(await snapshot(f),before);assert.equal(await f.journal.lookup(await operationID(f)),null);
});
test('anonymous owner can fence a pending registration device without inventing session or consent retirement',async t=>{
  const f=await fixture(t),h=f.h;
  h.env.FACE_AUTH_VERIFIER={fetch:async request=>{const form=await request.formData();return Response.json(await faceVerifierFixture(JSON.parse(String(form.get('envelope'))),form));}};
  const person=await prepareEnrollment(h),id=person.challenge.device_id,account=person.anonymous.account_id,old=await h.db.one('SELECT * FROM auth_devices WHERE id=?',id);
  const handler=createHandler(createApp(f.db,h.env)),reply=await handler(new Request('https://api.invalid/auth/device/revoke',{method:'POST',headers:{authorization:'Bearer '+person.anonymous.access_token,'content-type':'application/json'},body:JSON.stringify({device_id:id})}));
  assert.equal(reply.status,200);assert.deepEqual(await reply.json(),{status:'revoked',current_session_revoked:false,clear_device_identity:false});
  const saved=await f.journal.lookup(await operationFor(account,old));assert(saved&&saved.status==='committed');
  assert.deepEqual(saved.plan.events.map(({kind,scope})=>({kind,scope})),[{kind:'device-retired',scope:{account_id:account,device_id:id,device_revision:old.revision}}]);
  const retired=await h.db.one('SELECT * FROM auth_devices WHERE id=?',id);assert.equal(retired.status,'revoked');assert.equal(retired.revision,saved.plan.allocations.id_0);
  // The standalone challenge stays stored; its original device can no longer
  // pass the actual completion guard or create a profile/session.
  await h.json('/auth/face/registration/complete',{token:person.anonymous.access_token,body:person.completion},401);
  assert.equal(await h.db.one('SELECT id FROM face_profiles WHERE account_id=?',account),null);
  assert.equal((await h.db.one('SELECT count(*) n FROM sessions WHERE account_id=?',account)).n,1);
});
test('a held actual standalone completion path with a synthetic verifier cannot publish a session after exact device retirement',async t=>{
  let release,arrive;const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{arrive=resolve;});
  t.after(()=>release());const f=await deviceFixture(t);
  const challenge=await f.h.json('/auth/face/challenge',{body:{face_handle:f.person.faceHandle,device_id:f.person.deviceId}},201);
  const body=await captureProofs(f.h,challenge,f.person.keys.privateKey),before=await f.h.db.all('SELECT id FROM sessions ORDER BY id');
  f.h.env.FACE_AUTH_VERIFIER={fetch:async request=>{const form=await request.formData(),envelope=JSON.parse(String(form.get('envelope')));arrive();await gate;return Response.json(await faceVerifierFixture(envelope,form));}};
  const held=f.h.request('/auth/face/complete',{body});let timer;
  try{await Promise.race([entered,held.then(()=>{throw Error('verifier_not_reached');}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('held_verifier_deadline')),6000);})]);}
  finally{clearTimeout(timer);}
  try{await f.call();await expectRetired(f,[deviceFact(f),sessionFact(f)]);}finally{release();}
  const result=await held;assert([401,409].includes(result.status));await result.body?.cancel();
  assert.deepEqual(await f.h.db.all('SELECT id FROM sessions ORDER BY id'),before);assert.equal((await target(f)).status,'revoked');
});

test('a pre-existing legacy revoked device is a domain and restriction no-op with only a generic empty checkpoint',async t=>{
  const f=await deviceFixture(t);await f.realPending();await f.h.db.run("UPDATE auth_devices SET status='revoked',face_handle=NULL,revision=? WHERE id=?",randomUUID(),f.person.deviceId);
  const before=await snapshot(f),controlBefore=await f.journal.control();assert.deepEqual(await f.call(200,peerCall(f)),{status:'revoked',current_session_revoked:false,clear_device_identity:false});
  assert.deepEqual(await snapshot(f),before);assert.equal(await f.journal.lookup(await operationID(f)),null);assert.equal((await auditRows(f)).length,0);assert.equal(await cursor(f),0);
  const controlAfter=await f.journal.control();assert.deepEqual(controlAfter.marker.cursor,controlBefore.marker.cursor);
  assert.equal(controlAfter.marker.checkpoint.revision,controlBefore.marker.checkpoint.revision+1);
  const marker=await f.h.db.one('SELECT last_operation_id FROM restore_control WHERE singleton=1'),generic=await f.journal.lookup(marker.last_operation_id);
  assert(generic&&generic.status==='committed');assert.deepEqual(generic.plan.events,[]);assert.deepEqual(generic.plan.allocations,{});
});
