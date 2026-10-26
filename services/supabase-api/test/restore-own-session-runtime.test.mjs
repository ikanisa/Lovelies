import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createApp, createHandler } from '../src/index.ts';
import { restoreOperationID } from '../src/restore-transaction.ts';
import { insertPreparedSession, prepareSession } from '../src/auth.ts';
import { sessionRetirementScope } from '../src/session-retirement.ts';
import { addConsentReference, assertIsolatedReference, assertSurvivingSecuritySession, historicalRevokedNull, referenceRows } from './restore-consent-reference-fixtures.mjs';
import { enroll, captureProofs, faceVerifierFixture, sign, encode, stable } from './runtime-harness.mjs';
import { fixture, digest, unavailable } from './restore-database-fixture.mjs';

const POLICY = 'face-policy-fixture-v1', DEVICE_PROTOCOL = 'lovelies-face-profile-device-v1';
const sessionID = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).jti;
const ordered = facts => [...new Map(facts.map(fact => [stable(fact), fact])).entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, fact]) => fact);
const sessionFact = f => ({ kind: 'session-retired', scope: { account_id: f.person.accountId, session_id: f.targetID } });
const consentFact = (f, id) => ({ kind: 'consent-withdrawn', scope: { account_id: f.person.accountId, consent_id: id, purpose: 'face_authentication' } });
const operationID = f => restoreOperationID(f.person.accountId, 'identity.session-revoke-v1', 'session.revoke:' + f.targetID);
const target = f => f.h.db.one('SELECT * FROM sessions WHERE id=?', f.targetID);
const cursor = async f => (await f.journal.control()).marker.cursor.sequence;
const auditRows = f => f.h.db.all("SELECT * FROM audit_events WHERE action='session.revoke' ORDER BY id");
async function login(h, person) {
  const challenge = await h.json('/auth/face/challenge', { body: { face_handle: person.faceHandle, device_id: person.deviceId } }, 201);
  const credentials = await h.json('/auth/face/complete', { body: await captureProofs(h, challenge, person.keys.privateKey) });
  return { ...person, ...credentials, token: credentials.access_token };
}
async function ownFixture(t, { registered = true } = {}) {
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
  let clock = h.app.now(); const handler = createHandler(createApp(f.db, h.env, () => clock));
  const request = ({ token = person.token, body = { session_id: targetID } } = {}) => handler(new Request('https://api.invalid/auth/session/revoke', {
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
  return { ...f, person, peer, foreign, targetID, original, profile, request, call, uncertain, pending, otherDevice, independentCaller, ensureControl, realPending, seedPush, now: () => clock, setClock: value => { clock = value; } };
}
async function exclusiveScope(f, expectedCancellation) {
  const scope = await sessionRetirementScope(f.h.app, await target(f));
  assert.equal(scope.peers.length, 0, 'Same-device peers must not mask the intended cancellation/generation predicate');
  if (expectedCancellation !== undefined) {
    assert.equal(scope.cancelDeviceLifecycle, expectedCancellation);
    assert.equal(scope.cancelSessionChallenges, expectedCancellation);
  }
  return scope;
}
async function snapshot(f) {
  const tables = ['sessions', 'consents', 'auth_devices', 'auth_challenges', 'face_profile_operations', 'face_profiles', 'push_devices', 'notification_deliveries', 'audit_events', 'operations', 'operation_subjects']; const result = {};
  for (const table of tables) { const order = table === 'face_profile_operations' ? 'account_id,operation_key' : table === 'face_profiles' ? 'account_id' :
    ['operations', 'operation_subjects'].includes(table) ? 'actor_id,source,operation_key' + (table === 'operation_subjects' ? ',subject_id' : '') : 'id';
    result[table] = await f.h.db.all('SELECT * FROM ' + table + ' ORDER BY ' + order);
  } return result;
}
async function assertPlan(f, facts, status = 'committed') {
  const saved = await f.journal.lookup(await operationID(f)); assert(saved); assert.equal(saved.status, status); assert.deepEqual(saved.plan.allocations, {});
  assert.equal(saved.plan.input_hash, digest(stable({ protocol: 'lovelies-own-session-revoke-v1', account_id: f.person.accountId, session_id: f.targetID, auth_method: f.original.auth_method, auth_epoch: f.original.auth_epoch, created_at: f.original.created_at,
    device_id: f.original.device_id, device_revision: f.original.device_revision })));
  assert.deepEqual(saved.plan.events.map(({ kind, scope }) => ({ kind, scope })), ordered(facts));
  assert.equal(new Set(saved.plan.events.map(row => row.operation_id)).size, ordered(facts).length);
  const encoded = JSON.stringify(saved.plan);
  for (const field of ['access_token', 'refresh_token', 'refresh_hash', 'public_jwk', 'template_key', 'template_digest', 'control_key', 'token_value']) assert(!encoded.includes('"' + field + '"'));
  for (const value of [f.person.token, f.person.refresh_token, f.person.faceHandle, f.peer?.token, f.profile?.template_key, f.profile?.template_digest].filter(Boolean)) assert(!encoded.includes(value)); return saved;
}

// Prepared for root-owned native PostgreSQL execution; no pass is claimed here.
test('anonymous self-retirement accepts the native keyless request and records only its session', async t => {
  const f = await ownFixture(t, { registered: false }), unrelated = await f.pending({ deviceID: await f.otherDevice() }), before = await snapshot(f);
  assert.deepEqual(await f.call(), { status: 'revoked', current_session_revoked: true, clear_device_identity: false }); await assertPlan(f, [sessionFact(f)]);
  const after = await snapshot(f); for (const table of ['consents', 'auth_devices', 'auth_challenges', 'face_profile_operations', 'face_profiles', 'push_devices', 'notification_deliveries', 'operations', 'operation_subjects']) assert.deepEqual(after[table], before[table]);
  assert.equal(after.face_profile_operations.find(row => row.operation_key === unrelated.operationKey).state, 'pending'); assert.notEqual((await target(f)).revoked_at, null);
  await f.call(401); assert.equal((await auditRows(f)).length, 1); assert.equal(await cursor(f), 1);
});

test('an expired caller denial alone is not a receipt proving target retirement', async t => {
  const f = await ownFixture(t), before = await snapshot(f), now = f.now(); f.setClock(f.original.expires_at + 1);
  await f.call(401); f.setClock(now); assert.deepEqual(await snapshot(f), before); assert.equal((await target(f)).revoked_at, null);
  assert.equal(await f.journal.lookup(await operationID(f)), null); assert.equal((await auditRows(f)).length, 0);
});

test('exclusive self-retirement cancels an actual pending challenge and retains profile, device, other-device caller and push behavior', async t => {
  const f = await ownFixture(t), pending = await f.realPending(), push = await f.seedPush(), before = await snapshot(f);
  await exclusiveScope(f, true);
  assert.equal((await f.call()).current_session_revoked, true); await assertPlan(f, [sessionFact(f), consentFact(f, pending.consent_id)]);
  assert.equal((await f.h.db.one('SELECT state FROM face_profile_operations WHERE operation_key=?', pending.operation_key)).state, 'cancelled');
  assert.equal((await f.h.db.one('SELECT status FROM auth_challenges WHERE id=?', pending.challenge_id)).status, 'cancelled');
  assert.equal((await f.h.db.one('SELECT status FROM consents WHERE id=?', pending.consent_id)).status, 'revoked');
  const after = await snapshot(f); for (const table of ['auth_devices', 'face_profiles', 'push_devices', 'notification_deliveries', 'operations', 'operation_subjects']) assert.deepEqual(after[table], before[table]);
  assert.deepEqual(after.sessions.filter(row => row.id !== f.targetID), before.sessions.filter(row => row.id !== f.targetID));
  await f.call(401); await f.h.json('/auth/session/refresh', { body: { refresh_token: f.person.refresh_token } }, 401);
  assert.deepEqual(await f.call(200, { token: f.peer.token }), { status: 'revoked', current_session_revoked: false, clear_device_identity: false });
  assert(!JSON.stringify((await f.journal.lookup(await operationID(f))).plan).includes(push.token)); assert.equal((await auditRows(f)).length, 1);
});

test('surviving same-account caller retires another session and remains current', async t => {
  const f = await ownFixture(t); const before = await snapshot(f); assert.deepEqual(await f.call(200, { token: f.peer.token }), { status: 'revoked', current_session_revoked: false, clear_device_identity: false });
  await assertPlan(f, [sessionFact(f)]); assert.deepEqual(await f.h.db.one('SELECT * FROM sessions WHERE id=?', sessionID(f.peer.token)), before.sessions.find(row => row.id === sessionID(f.peer.token)));
});

test('later valid sign-in and newer same-device pending work survive the original target retry with a fresh caller flag', async t => {
  const f = await ownFixture(t), first = await f.realPending(); await f.call(); const saved = await assertPlan(f, [sessionFact(f), consentFact(f, first.consent_id)]);
  const fresh = await login(f.h, f.person), replacement = await f.realPending(fresh.token), before = await snapshot(f);
  assert.deepEqual(await f.call(200, { token: fresh.token }), { status: 'revoked', current_session_revoked: false, clear_device_identity: false });
  assert.deepEqual(await snapshot(f), before); assert.deepEqual(await f.journal.lookup(await operationID(f)), saved);
  assert.equal(before.face_profile_operations.find(row => row.operation_key === replacement.operation_key).state, 'pending'); await f.call(401);
});

test('formerly ignored optional operation keys neither become authority nor split one terminal target identity', async t => {
  const f = await ownFixture(t); await f.ensureControl(); await exclusiveScope(f, true); await f.call(200, { token: f.peer.token, body: { session_id: f.targetID, operation_key: { legacy: 'ignored' } } });
  const saved = await assertPlan(f, [sessionFact(f)]), newer = await f.pending(), before = await snapshot(f);
  for (const operation_key of ['short', null, 123, randomUUID()]) {
    assert.equal((await f.call(200, { token: f.peer.token, body: { session_id: f.targetID, operation_key } })).current_session_revoked, false); assert.deepEqual(await snapshot(f), before);
  }
  assert.equal((await f.h.db.one('SELECT state FROM face_profile_operations WHERE operation_key=?', newer.operationKey)).state, 'pending'); assert.deepEqual(await f.journal.lookup(await operationID(f)), saved); assert.equal((await auditRows(f)).length, 1);
});

test('already-retired target is an effect-free no-op and preserves newer work without manufacturing a receipt or new fact', async t => {
  const f = await ownFixture(t); await f.ensureControl(); await f.h.db.run('UPDATE sessions SET revoked_at=?,refresh_consumed_at=? WHERE id=?', f.now(), f.now(), f.targetID); await f.pending();
  const before = await snapshot(f); assert.equal((await f.call(200, { token: f.peer.token })).current_session_revoked, false); assert.deepEqual(await snapshot(f), before);
  assert.equal(await f.journal.lookup(await operationID(f)), null); assert.equal(await cursor(f), 0); assert.equal((await auditRows(f)).length, 0);
});

test('exact selected consent episodes deduplicate and preserve profile-bound, revoked, other-device and foreign rows', async t => {
  const f = await ownFixture(t), first = await f.pending(), expired = await f.pending({ status: 'expired' }); await f.pending({ consentID: first.consentID }); await f.pending({ consentID: f.profile.auth_consent_id });
  const revoked = await f.pending({ status: 'revoked' }), peer = await f.pending({ deviceID: await f.otherDevice() }), before = await snapshot(f);
  await f.call(); await assertPlan(f, [sessionFact(f), consentFact(f, first.consentID), consentFact(f, expired.consentID)]); const after = await snapshot(f);
  for (const id of [first.consentID, expired.consentID, revoked.consentID]) assert.equal(after.consents.find(row => row.id === id).status, 'revoked');
  for (const id of [f.profile.auth_consent_id, peer.consentID]) assert.deepEqual(after.consents.find(row => row.id === id), before.consents.find(row => row.id === id));
  assert.deepEqual(after.sessions.filter(row => row.account_id === f.foreign.account_id), before.sessions.filter(row => row.account_id === f.foreign.account_id));
});

// These deliberately model preserved legacy/restore inconsistencies. They do
// not demonstrate that current normal routes produce a stale unrevoked target.
for (const mismatch of ['target-device', 'control-revision', 'operation-revision', 'target-epoch', 'operation-epoch']) test('historical ' + mismatch + ' target retires alone and preserves newer or unknown lifecycle work', async t => {
  const f = await ownFixture(t), pending = await f.realPending(); await exclusiveScope(f, true); let caller = f.peer.token;
  const futureRevision = randomUUID();
  if (mismatch === 'target-device') {
    await f.h.db.run('UPDATE auth_devices SET revision=? WHERE id=?', futureRevision, f.person.deviceId);
    await f.h.db.run('UPDATE face_profile_controls SET device_revision=? WHERE account_id=? AND device_id=?', futureRevision, f.person.accountId, f.person.deviceId);
    await f.h.db.run('UPDATE face_profile_operations SET control_revision=? WHERE account_id=? AND operation_key=?', futureRevision, f.person.accountId, pending.operation_key);
    await f.h.db.run('UPDATE auth_challenges SET device_revision=? WHERE id=?', futureRevision, pending.challenge_id);
    caller = (await f.independentCaller()).token;
  } else if (mismatch === 'control-revision') {
    await f.h.db.run('UPDATE face_profile_controls SET device_revision=? WHERE account_id=? AND device_id=?', futureRevision, f.person.accountId, f.person.deviceId);
    await f.h.db.run('UPDATE face_profile_operations SET control_revision=? WHERE account_id=? AND operation_key=?', futureRevision, f.person.accountId, pending.operation_key);
  } else if (mismatch === 'operation-revision') {
    await f.h.db.run('UPDATE face_profile_operations SET control_revision=? WHERE account_id=? AND operation_key=?', futureRevision, f.person.accountId, pending.operation_key);
  } else if (mismatch === 'target-epoch') {
    await f.h.db.run('UPDATE accounts SET auth_epoch=auth_epoch+1 WHERE id=?', f.person.accountId);
    await f.h.db.run('UPDATE face_profile_operations SET auth_epoch=? WHERE account_id=? AND operation_key=?', f.original.auth_epoch + 1, f.person.accountId, pending.operation_key);
    await f.h.db.run('UPDATE auth_challenges SET auth_epoch=? WHERE id=?', f.original.auth_epoch + 1, pending.challenge_id);
    caller = (await f.independentCaller()).token;
  } else if (mismatch === 'operation-epoch') {
    await f.h.db.run('UPDATE face_profile_operations SET auth_epoch=? WHERE account_id=? AND operation_key=?', f.original.auth_epoch + 1, f.person.accountId, pending.operation_key);
  }
  // Even an inconsistent historical session reference may not indirectly let
  // the generic session-challenge UPDATE cancel the preserved newer lifecycle.
  await f.h.db.run('UPDATE auth_challenges SET session_id=? WHERE id=?', f.targetID, pending.challenge_id);
  await exclusiveScope(f, false);
  const before = await snapshot(f), controlBefore = await f.h.db.all('SELECT * FROM face_profile_controls ORDER BY account_id,device_id');
  assert.equal((await f.call(200, { token: caller, body: { session_id: f.targetID, operation_key: 'original-legacy-key' } })).current_session_revoked, false);
  const saved = await assertPlan(f, [sessionFact(f)]), after = await snapshot(f); assert.equal(await cursor(f), 1);
  for (const table of Object.keys(before).filter(table => !['sessions', 'audit_events'].includes(table))) assert.deepEqual(after[table], before[table]);
  assert.deepEqual(after.sessions.filter(row => row.id !== f.targetID), before.sessions.filter(row => row.id !== f.targetID));
  assert.deepEqual(await f.h.db.all('SELECT * FROM face_profile_controls ORDER BY account_id,device_id'), controlBefore);
  assert.notEqual((await target(f)).revoked_at, null); assert.notEqual((await target(f)).refresh_consumed_at, null);
  assert.equal(after.face_profile_operations.find(row => row.operation_key === pending.operation_key).state, 'pending');
  assert.equal(after.auth_challenges.find(row => row.id === pending.challenge_id).status, 'pending');
  const terminal = await snapshot(f); await f.call(200, { token: caller, body: { session_id: f.targetID, operation_key: 'different-ignored-key' } });
  assert.deepEqual(await snapshot(f), terminal); assert.deepEqual(await f.journal.lookup(await operationID(f)), saved);
});

test('a real later same-device session starts new control work that an earlier session cannot retire', async t => {
  const f = await ownFixture(t); await new Promise(resolve => setTimeout(resolve, 2)); const later = await login(f.h, f.person);
  const laterSession = await f.h.db.one('SELECT * FROM sessions WHERE id=?', sessionID(later.token)); assert(laterSession.created_at > f.original.created_at);
  const pending = await f.realPending(later.token), before = await snapshot(f);
  assert((await sessionRetirementScope(f.h.app, await target(f))).peers.some(row => row.id === sessionID(later.token)));
  assert.equal((await f.call()).current_session_revoked, true); await assertPlan(f, [sessionFact(f)]); const after = await snapshot(f);
  for (const table of ['consents', 'face_profile_operations', 'auth_challenges', 'auth_devices', 'face_profiles', 'push_devices', 'notification_deliveries']) assert.deepEqual(after[table], before[table]);
  assert.deepEqual(after.sessions.filter(row => row.id !== f.targetID), before.sessions.filter(row => row.id !== f.targetID));
  assert.equal(after.face_profile_operations.find(row => row.operation_key === pending.operation_key).state, 'pending');
  const terminal = await snapshot(f); await f.call(401); assert.equal((await f.call(200, { token: later.token })).current_session_revoked, false); assert.deepEqual(await snapshot(f), terminal);
});

for (const mismatch of ['linked-revision', 'linked-epoch', 'linked-account']) test('an unbound lifecycle challenge at ' + mismatch + ' is preserved with its pending operation', async t => {
  const f = await ownFixture(t), pending = await f.realPending(); await exclusiveScope(f, true);
  assert.equal((await f.h.db.one('SELECT session_id FROM auth_challenges WHERE id=?', pending.challenge_id)).session_id, null);
  if (mismatch === 'linked-revision') await f.h.db.run('UPDATE auth_challenges SET device_revision=? WHERE id=?', randomUUID(), pending.challenge_id);
  if (mismatch === 'linked-epoch') await f.h.db.run('UPDATE auth_challenges SET auth_epoch=auth_epoch+1 WHERE id=?', pending.challenge_id);
  if (mismatch === 'linked-account') await f.h.db.run('UPDATE auth_challenges SET account_id=? WHERE id=?', f.foreign.account_id, pending.challenge_id);
  await exclusiveScope(f, false);
  const before = await snapshot(f); await f.call(200, { token: f.peer.token }); await assertPlan(f, [sessionFact(f)]); const after = await snapshot(f);
  for (const table of ['consents', 'face_profile_operations', 'auth_challenges', 'auth_devices', 'face_profiles']) assert.deepEqual(after[table], before[table]);
});

test('mixed current and future pending tuples preserve the entire device lifecycle while the exact old session retires', async t => {
  const f = await ownFixture(t), current = await f.pending(), future = await f.pending(); await exclusiveScope(f, true);
  await f.h.db.run('UPDATE face_profile_operations SET auth_epoch=auth_epoch+1 WHERE account_id=? AND operation_key=?', f.person.accountId, future.operationKey);
  await exclusiveScope(f, false);
  const before = await snapshot(f); await f.call(200, { token: f.peer.token }); await assertPlan(f, [sessionFact(f)]); const after = await snapshot(f);
  for (const table of ['consents', 'face_profile_operations', 'auth_challenges', 'auth_devices', 'face_profiles']) assert.deepEqual(after[table], before[table]);
  for (const row of [current, future]) assert.equal(after.face_profile_operations.find(op => op.operation_key === row.operationKey).state, 'pending');
});

for (const transition of ['revision', 'epoch']) test('the original key after unaccepted rollback cannot acquire newer ' + transition + ' work', async t => {
  const f = await ownFixture(t), pending = await f.realPending(), run = f.db.run.bind(f.db), options = { token: f.peer.token, body: { session_id: f.targetID, operation_key: 'original-preserved-key' } }; let consumed = false; await exclusiveScope(f, true);
  f.db.run = async (sql, ...bindings) => { await run(sql, ...bindings); if (!consumed && sql.startsWith('UPDATE sessions SET revoked_at=COALESCE(')) { consumed = true; throw Error('synthetic_unaccepted_original_retirement'); } };
  await f.uncertain(options); assert.equal(consumed, true); assert.equal(await f.journal.lookup(await operationID(f)), null); assert.equal((await target(f)).revoked_at, null);
  f.db.run = run;
  if (transition === 'revision') {
    const revision = randomUUID(); await f.h.db.run('UPDATE auth_devices SET revision=? WHERE id=?', revision, f.person.deviceId);
    await f.h.db.run('UPDATE face_profile_controls SET device_revision=? WHERE account_id=? AND device_id=?', revision, f.person.accountId, f.person.deviceId);
    await f.h.db.run('UPDATE face_profile_operations SET control_revision=? WHERE account_id=? AND operation_key=?', revision, f.person.accountId, pending.operation_key);
    await f.h.db.run('UPDATE auth_challenges SET device_revision=? WHERE id=?', revision, pending.challenge_id);
  } else {
    await f.h.db.run('UPDATE accounts SET auth_epoch=auth_epoch+1 WHERE id=?', f.person.accountId);
    await f.h.db.run('UPDATE face_profile_operations SET auth_epoch=auth_epoch+1 WHERE account_id=? AND operation_key=?', f.person.accountId, pending.operation_key);
    await f.h.db.run('UPDATE auth_challenges SET auth_epoch=auth_epoch+1 WHERE id=?', pending.challenge_id);
  }
  const caller = await f.independentCaller(); await exclusiveScope(f, false); const before = await snapshot(f); await f.call(200, { ...options, token: caller.token }); await assertPlan(f, [sessionFact(f)]); const after = await snapshot(f);
  for (const table of ['consents', 'face_profile_operations', 'auth_challenges', 'auth_devices', 'face_profiles', 'operations', 'operation_subjects']) assert.deepEqual(after[table], before[table]);
  assert.equal((await auditRows(f)).length, 1); assert.equal(await cursor(f), 1);
});

test('foreign, missing, malformed and extra-field targets fail before any retirement', async t => {
  const f = await ownFixture(t), before = await snapshot(f);
  assert.equal((await f.call(404, { body: { session_id: sessionID(f.foreign.access_token) } })).error.code, 'session_unavailable');
  assert.equal((await f.call(404, { body: { session_id: randomUUID() } })).error.code, 'session_unavailable');
  await f.call(400, { body: { session_id: 'bad' } }); await f.call(400, { body: { session_id: f.targetID, account_id: f.foreign.account_id } }); await f.call(401, { token: null });
  assert.deepEqual(await snapshot(f), before); assert.equal(await f.journal.lookup(await operationID(f)), null);
});

for (const invalid of ['session-revoked', 'account-disabled', 'epoch-changed', 'roles-changed', 'device-revoked', 'device-revision']) test('own retirement requires fresh privacy authority after ' + invalid, async t => {
  const f = await ownFixture(t); await f.pending();
  if (invalid === 'session-revoked') await f.h.db.run('UPDATE sessions SET revoked_at=? WHERE id=?', f.now(), f.targetID);
  if (invalid === 'account-disabled') await f.h.db.run('UPDATE accounts SET disabled_at=? WHERE id=?', f.now(), f.person.accountId);
  if (invalid === 'epoch-changed') await f.h.db.run('UPDATE accounts SET auth_epoch=auth_epoch+1 WHERE id=?', f.person.accountId);
  if (invalid === 'roles-changed') await f.h.db.run('UPDATE accounts SET roles_json=? WHERE id=?', '["user","admin"]', f.person.accountId);
  if (invalid === 'device-revoked') await f.h.db.run("UPDATE auth_devices SET status='revoked' WHERE id=?", f.person.deviceId);
  if (invalid === 'device-revision') await f.h.db.run('UPDATE auth_devices SET revision=? WHERE id=?', randomUUID(), f.person.deviceId);
  const before = await snapshot(f); await f.call(401); assert.deepEqual(await snapshot(f), before); assert.equal(await f.journal.lookup(await operationID(f)), null);
});

for (const restriction of ['authentication-consent', 'disabled-profile', 'audience-suspension']) test('own retirement preserves weak privacy authority after ' + restriction, async t => {
  const f = await ownFixture(t);
  if (restriction === 'authentication-consent') await f.h.db.run("UPDATE consents SET status='revoked',revoked_at=? WHERE id=?", f.now(), f.profile.auth_consent_id);
  if (restriction === 'disabled-profile') await f.h.db.run("UPDATE face_profiles SET status='disabled' WHERE account_id=?", f.person.accountId);
  if (restriction === 'audience-suspension') await f.h.db.run("UPDATE account_audience SET status='suspended',version=version+1 WHERE account_id=?", f.person.accountId);
  const before = await snapshot(f); await f.call(); await assertPlan(f, [sessionFact(f)]); const after = await snapshot(f);
  for (const table of Object.keys(before).filter(table => !['sessions', 'audit_events'].includes(table))) assert.deepEqual(after[table], before[table]);
});

test('expiry after fact collection denies before any domain effect', async t => {
  const f = await ownFixture(t); await f.pending(); const before = await snapshot(f), transaction = f.db.transaction.bind(f.db), now = f.now(); let observed = false;
  f.db.transaction = (callback, intent) => transaction(restore => callback({ operation: value => restore.operation(value), restrict: async (kind, scope) => {
    await restore.restrict(kind, scope); if (kind === 'session-retired') { observed = true; f.setClock(f.original.expires_at + 1); }
  } }), intent);
  await f.call(401); f.setClock(now); assert.equal(observed, true); assert.deepEqual(await snapshot(f), before); assert.equal(await f.journal.lookup(await operationID(f)), null);
});

for (const changed of ['session-device', 'pending-consent']) test('selected ' + changed + ' drift is detected before target retirement', async t => {
  const f = await ownFixture(t), pending = await f.pending(), other = await f.otherDevice(), before = await snapshot(f), transaction = f.db.transaction.bind(f.db); let observed = false;
  // Same-transaction injection rolls back with the denial; no cross-connection
  // write is attempted from a recursive read holding the advisory lock.
  f.db.transaction = (callback, intent) => transaction(restore => callback({ operation: value => restore.operation(value), restrict: async (kind, scope) => {
    await restore.restrict(kind, scope); if (kind === 'session-retired' && !observed) { observed = true;
      if (changed === 'session-device') await f.db.run('UPDATE sessions SET device_id=? WHERE id=?', other, f.targetID);
      else await f.db.run("UPDATE consents SET status='revoked',revoked_at=? WHERE id=?", f.now(), pending.consentID);
    }
  } }), intent);
  assert.equal((await f.call(409, { token: f.peer.token })).error.code, 'session_revoke_authority_changed'); assert.equal(observed, true);
  assert.deepEqual(await snapshot(f), before); assert.equal(await f.journal.lookup(await operationID(f)), null);
});

for (const pendingCount of [31, 32]) test((pendingCount + 1) + ' own-session facts atomically commit or refuse before writes', async t => {
  const f = await ownFixture(t), pending = []; await f.seedPush(); for (let i = 0; i < pendingCount; i++) pending.push(await f.pending()); await exclusiveScope(f, true); const before = await snapshot(f); f.trace.length = 0;
  if (pendingCount === 31) { await f.call(); await assertPlan(f, [sessionFact(f), ...pending.map(row => consentFact(f, row.consentID))]); assert.equal(await cursor(f), 32); }
  else { assert.equal((await f.call(503)).error.code, 'session_revoke_restriction_capacity'); assert.deepEqual(await snapshot(f), before); assert.equal(await f.journal.lookup(await operationID(f)), null);
    assert(!f.trace.some(value => value.kind === 'sql' && /^(INSERT|UPDATE|DELETE) /.test(value.sql) && !value.sql.startsWith('UPDATE restore_control '))); }
});

for (const malformed of ['cross-account', 'other-purpose']) test('malformed pending ' + malformed + ' preserves every domain row', async t => {
  const f = await ownFixture(t); await f.pending({ consentOwner: malformed === 'cross-account' ? f.foreign.account_id : f.person.accountId, purpose: malformed === 'other-purpose' ? 'photo_matching' : 'face_authentication' }); const before = await snapshot(f);
  assert.equal((await f.call(409)).error.code, 'face_profile_pending_consent_invalid'); assert.deepEqual(await snapshot(f), before); assert.equal(await f.journal.lookup(await operationID(f)), null);
});

for (const failure of ['callback', 'surviving-caller']) test(failure + ' failure rolls back target and pending work before journal acceptance', async t => {
  const f = await ownFixture(t); await f.pending(); const before = await snapshot(f), run = f.db.run.bind(f.db); let consumed = false;
  f.db.run = async (sql, ...bindings) => { await run(sql, ...bindings); if (consumed) return;
    if (failure === 'callback' && sql.startsWith('UPDATE sessions SET revoked_at=COALESCE(')) { consumed = true; throw Error('synthetic_own_session_callback_failure'); }
    if (failure === 'surviving-caller' && sql.startsWith('INSERT INTO audit_events(')) { consumed = true; await run('UPDATE sessions SET revoked_at=? WHERE id=?', f.now(), sessionID(f.peer.token)); }
  };
  if (failure === 'callback') await f.uncertain(); else await f.call(401, { token: f.peer.token });
  assert.equal(consumed, true); assert.deepEqual(await snapshot(f), before); assert.equal(await f.journal.lookup(await operationID(f)), null);
});

for (const self of [true, false]) test('concurrent ' + (self ? 'self' : 'surviving-caller') + ' requests retire the target once', async t => {
  const f = await ownFixture(t), options = self ? {} : { token: f.peer.token }, responses = await Promise.all([f.request(options), f.request(options)]);
  assert.deepEqual(responses.map(row => row.status).sort(), self ? [200, 401] : [200, 200]); for (const response of responses) await response.body?.cancel();
  await assertPlan(f, [sessionFact(f)]); assert.equal((await auditRows(f)).length, 1); assert.equal(await cursor(f), 1);
});

test('accepted plan followed by rejected SQL COMMIT preserves pending exact facts and refuses callback replay', async t => {
  const f = await ownFixture(t), pending = await f.pending(), before = await snapshot(f), id = await operationID(f), prepare = f.journal.prepare.bind(f.journal); let armed = true;
  f.journal.prepare = async value => { const saved = await prepare(value); if (armed && value.operation_id === id) { armed = false; f.faults.beforeCommit = true; } return saved; };
  await f.uncertain(); assert.equal(armed, false); assert.equal(f.faults.beforeCommit, false); assert.deepEqual(await snapshot(f), before); const saved = await assertPlan(f, [sessionFact(f), consentFact(f, pending.consentID)], 'pending');
  await assert.rejects(() => f.db.one('SELECT id FROM accounts LIMIT 1'), unavailable); await f.uncertain(); assert.deepEqual(await snapshot(f), before); assert.deepEqual(await f.journal.lookup(id), saved);
});

for (const mode of ['outage', 'prepare-before', 'prepare-after', 'commit-result-loss', 'ack-before', 'ack-after']) test('own-session ' + mode + ' distinguishes response loss from restored authority', async t => {
  const f = await ownFixture(t), pending = await f.pending(), before = await snapshot(f), id = await operationID(f), facts = [sessionFact(f), consentFact(f, pending.consentID)]; let boundary;
  if (mode === 'outage') f.faults.control = true;
  else if (mode.startsWith('prepare-')) f.faults.reply = { path: '/v1/operations/prepare', stage: mode.slice(8) };
  else if (mode === 'commit-result-loss') { const prepare = f.journal.prepare.bind(f.journal); let armed = true;
    f.journal.prepare = async value => { const saved = await prepare(value); if (armed && value.operation_id === id) { armed = false; f.faults.commitReply = true;
      f.faults.afterCommit = async () => { delete f.faults.afterCommit; boundary = { journal: await f.journal.lookup(id), session: await target(f), consent: await f.h.db.one('SELECT * FROM consents WHERE id=?', pending.consentID), audit: await auditRows(f) }; };
    } return saved; };
  } else f.faults.reply = { path: '/v1/operations/' + id + '/acknowledge', stage: mode.slice(4) };
  await f.uncertain(); const saved = await f.journal.lookup(id);
  if (mode === 'outage' || mode === 'prepare-before') { assert.deepEqual(await snapshot(f), before); assert.equal(saved, null); f.faults.control = false;
    if (mode === 'prepare-before') assert.equal(f.faults.reply, undefined); await f.call(); await assertPlan(f, facts); return; }
  if (mode === 'prepare-after') { assert.equal(f.faults.reply, undefined); assert.deepEqual(await snapshot(f), before); await assertPlan(f, facts, 'pending');
    await assert.rejects(() => f.db.one('SELECT id FROM accounts LIMIT 1'), unavailable); await f.uncertain(); assert.deepEqual(await snapshot(f), before); assert.deepEqual(await f.journal.lookup(id), saved); return; }
  assert.notEqual((await target(f)).revoked_at, null); assert.equal((await f.h.db.one('SELECT status FROM consents WHERE id=?', pending.consentID)).status, 'revoked');
  if (mode === 'commit-result-loss') { assert(boundary); assert.equal(boundary.journal.status, 'pending'); assert.notEqual(boundary.session.revoked_at, null); assert.equal(boundary.consent.status, 'revoked'); assert.equal(boundary.audit.length, 1);
    assert.equal(f.faults.afterCommit, undefined); assert.equal(f.faults.commitReply, false); assert.equal(saved.status, 'committed'); assert.equal(saved.plan_hash, boundary.journal.plan_hash); }
  else { assert.equal(f.faults.reply, undefined); assert.equal(saved.status, mode === 'ack-before' ? 'pending' : 'committed'); }
  await f.call(401); const newer = await f.pending(), committedState = await snapshot(f);
  assert.deepEqual(await f.call(200, { token: f.peer.token }), { status: 'revoked', current_session_revoked: false, clear_device_identity: false });
  assert.deepEqual(await snapshot(f), committedState); assert.equal(committedState.face_profile_operations.find(row => row.operation_key === newer.operationKey).state, 'pending');
  assert.equal((await assertPlan(f, facts)).plan_hash, saved.plan_hash); assert.equal((await auditRows(f)).length, 1); assert.equal(await cursor(f), facts.length);
});


// Additional v4 requirements for the finalized shared helper. None has run.
for (const binding of ['owned', 'foreign', 'missing', 'revision', 'active-device']) test('guest own-session retirement checks the ' + binding + ' enrollment challenge device', async t => {
  const f = await ownFixture(t, { registered: false });
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const challenge = await f.h.json('/auth/face/registration/challenge', { token: f.person.token, body: {
    device_public_jwk: await crypto.subtle.exportKey('jwk', keys.publicKey),
    consent: { purpose: 'face_authentication', granted: true, policy_version: POLICY } } }, 201);
  const id = challenge.challenge_id, deviceID = challenge.device_id;
  assert.equal((await f.h.db.one('SELECT session_id FROM auth_challenges WHERE id=?', id)).session_id, f.targetID);
  if (binding === 'foreign') await f.h.db.run('UPDATE auth_devices SET account_id=? WHERE id=?', f.foreign.account_id, deviceID);
  if (binding === 'missing') await f.h.db.run('UPDATE auth_challenges SET device_id=? WHERE id=?', randomUUID(), id);
  if (binding === 'revision') await f.h.db.run('UPDATE auth_devices SET revision=? WHERE id=?', randomUUID(), deviceID);
  if (binding === 'active-device') await f.h.db.run("UPDATE auth_devices SET status='active' WHERE id=?", deviceID);
  const scope = await sessionRetirementScope(f.h.app, await target(f));
  assert.equal(scope.cancelDeviceLifecycle, false); assert.equal(scope.cancelSessionChallenges, binding === 'owned');
  const before = await snapshot(f), referencesBefore = await referenceRows(f);
  assert.equal((await f.call()).current_session_revoked, true); await assertPlan(f, [sessionFact(f)]);
  const after = await snapshot(f), currentChallenge = after.auth_challenges.find(row => row.id === id);
  if (binding === 'owned') { assert.equal(currentChallenge.status, 'cancelled'); assert.notEqual(currentChallenge.used_at, null); }
  else assert.deepEqual(after.auth_challenges, before.auth_challenges, 'Unknown device bindings preserve every challenge byte');
  for (const table of ['consents', 'auth_devices', 'face_profile_operations', 'face_profiles', 'push_devices', 'notification_deliveries', 'operations', 'operation_subjects'])
    assert.deepEqual(after[table], before[table]);
  assert.deepEqual(await referenceRows(f), referencesBefore);
  assert.deepEqual(after.sessions.filter(row => row.id !== f.targetID), before.sessions.filter(row => row.id !== f.targetID));
});

for (const kind of ['enrollment', 'recovery', 'session']) for (const status of ['granted', 'historical-revoked-null'])
  test('own-session retirement preserves the isolated ' + kind + ' consent reference with ' + status + ' consent', async t => {
    const f = await ownFixture(t), pending = await f.pending({ status: status === 'granted' ? 'granted' : 'revoked' });
    const reference = await addConsentReference(f, kind, pending.consentID);
    if (status === 'historical-revoked-null') await historicalRevokedNull(f, pending.consentID);
    await assertIsolatedReference(f, reference); await exclusiveScope(f, false); await assertSurvivingSecuritySession(f, reference);
    const before = await snapshot(f), referencesBefore = await referenceRows(f);
    assert.equal((await f.call()).current_session_revoked, true); const saved = await assertPlan(f, [sessionFact(f)]), after = await snapshot(f);
    for (const table of ['consents', 'auth_devices', 'auth_challenges', 'face_profile_operations', 'face_profiles', 'push_devices', 'notification_deliveries', 'operations', 'operation_subjects'])
      assert.deepEqual(after[table], before[table]);
    assert.deepEqual(await referenceRows(f), referencesBefore);
    assert.deepEqual(after.sessions.filter(row => row.id !== f.targetID), before.sessions.filter(row => row.id !== f.targetID));
    assert.equal(after.face_profile_operations.find(row => row.operation_key === pending.operationKey).state, 'pending');
    if (status === 'historical-revoked-null') assert.equal(after.consents.find(row => row.id === pending.consentID).revoked_at, null);
    await assertSurvivingSecuritySession(f, reference);
    assert.equal((await f.call(200, { token: f.peer.token })).current_session_revoked, false);
    assert.deepEqual(await snapshot(f), after); assert.deepEqual(await f.journal.lookup(await operationID(f)), saved);
  });

for (const kind of ['enrollment', 'recovery', 'session']) test('own-session cleanup still runs when the isolated ' + kind + ' reference is revoked', async t => {
  const f = await ownFixture(t), pending = await f.pending(), reference = await addConsentReference(f, kind, pending.consentID, { revoked: true });
  await assertIsolatedReference(f, reference); await exclusiveScope(f, true);
  const before = await snapshot(f), referencesBefore = await referenceRows(f);
  await f.call(); await assertPlan(f, [sessionFact(f), consentFact(f, pending.consentID)]); const after = await snapshot(f);
  assert.equal(after.consents.find(row => row.id === pending.consentID).status, 'revoked');
  assert.notEqual(after.consents.find(row => row.id === pending.consentID).revoked_at, null);
  assert.equal(after.face_profile_operations.find(row => row.operation_key === pending.operationKey).state, 'cancelled');
  assert.deepEqual(await referenceRows(f), referencesBefore);
  assert.deepEqual(after.sessions.filter(row => row.id !== f.targetID), before.sessions.filter(row => row.id !== f.targetID));
  for (const table of ['auth_devices', 'face_profiles', 'push_devices', 'notification_deliveries', 'operations', 'operation_subjects']) assert.deepEqual(after[table], before[table]);
});

for (const kind of ['operation', 'enrollment', 'recovery']) test('a linked challenge shared with another ' + kind + ' preserves its exclusive target lifecycle', async t => {
  const f = await ownFixture(t), pending = await f.realPending();
  await exclusiveScope(f, true);
  let id;
  const otherConsentID = randomUUID();
  await f.h.db.run("INSERT INTO consents(id,account_id,purpose,policy_version,status,created_at) VALUES(?,?,'face_authentication',?,'granted',?)",
    otherConsentID, f.person.accountId, POLICY, f.now());
  if (kind === 'operation') {
    const other = await f.pending({ deviceID: await f.otherDevice(), consentID: otherConsentID }); id = other.operationKey;
    await f.h.db.run('UPDATE face_profile_operations SET challenge_id=?,generation=1 WHERE account_id=? AND operation_key=?', pending.challenge_id, f.person.accountId, id);
  } else if (kind === 'enrollment') {
    const other = await addConsentReference(f, 'enrollment', otherConsentID); id = other.id;
    await f.h.db.run('UPDATE face_enrollment_intents SET challenge_id=? WHERE account_id=? AND enrollment_key=?', pending.challenge_id, f.person.accountId, id);
  } else {
    const key = await addConsentReference(f, 'recovery', otherConsentID), deviceID = await f.otherDevice();
    const device = await f.h.db.one('SELECT * FROM auth_devices WHERE id=?', deviceID); id = randomUUID();
    await f.h.db.run(`INSERT INTO face_recovery_intents(account_id,recovery_request_id,key_id,device_id,device_revision,
      public_key_digest,public_jwk,handle_hash,start_hash,challenge_id,generation,created_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?)`, f.person.accountId, id, key.id, deviceID, device.revision,
      digest(device.public_jwk), device.public_jwk, digest('shared-handle-' + id), digest('shared-start-' + id), pending.challenge_id, f.now(), f.now() + 86400000);
  }
  const scope = await exclusiveScope(f, false);
  assert.deepEqual(scope.shared, []); assert.deepEqual(scope.otherConsentReferences, []);
  assert.deepEqual(scope.otherChallengeReferences, [{ kind, id, challenge_id: pending.challenge_id }], 'Only the intended shared-challenge class may fence this selection');
  const before = await snapshot(f), referencesBefore = { ...await referenceRows(f), recoveryIntents: await f.h.db.all('SELECT * FROM face_recovery_intents ORDER BY account_id,recovery_request_id') };
  await f.call(); await assertPlan(f, [sessionFact(f)]); const after = await snapshot(f);
  for (const table of ['consents', 'auth_devices', 'auth_challenges', 'face_profile_operations', 'face_profiles', 'push_devices', 'notification_deliveries', 'operations', 'operation_subjects'])
    assert.deepEqual(after[table], before[table]);
  assert.deepEqual({ ...await referenceRows(f), recoveryIntents: await f.h.db.all('SELECT * FROM face_recovery_intents ORDER BY account_id,recovery_request_id') }, referencesBefore);
  assert.deepEqual(after.sessions.filter(row => row.id !== f.targetID), before.sessions.filter(row => row.id !== f.targetID));
});

test('a previously retired same-device peer still prevents ownership inference for new pending work', async t => {
  const f = await ownFixture(t), retired = await login(f.h, f.person), retiredID = sessionID(retired.token);
  await f.h.json('/auth/logout', { token: retired.token, body: {} });
  assert.notEqual((await f.h.db.one('SELECT revoked_at FROM sessions WHERE id=?', retiredID)).revoked_at, null);
  const pending = await f.realPending(), scope = await sessionRetirementScope(f.h.app, await target(f));
  assert(scope.peers.some(row => row.id === retiredID)); assert.equal(scope.cancelDeviceLifecycle, false); assert.equal(scope.cancelSessionChallenges, false);
  const before = await snapshot(f); await f.call(); await assertPlan(f, [sessionFact(f)]); const after = await snapshot(f);
  for (const table of ['consents', 'auth_devices', 'auth_challenges', 'face_profile_operations', 'face_profiles', 'push_devices', 'notification_deliveries']) assert.deepEqual(after[table], before[table]);
  assert.equal(after.face_profile_operations.find(row => row.operation_key === pending.operation_key).state, 'pending');
  assert.deepEqual(after.sessions.filter(row => row.id !== f.targetID), before.sessions.filter(row => row.id !== f.targetID));
});
