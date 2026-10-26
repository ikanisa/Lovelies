import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createApp, createHandler } from '../src/index.ts';
import { restoreOperationID } from '../src/restore-transaction.ts';
import { enroll, captureProofs, faceVerifierFixture, sign, encode, stable } from './runtime-harness.mjs';
import { fixture, digest, unavailable } from './restore-database-fixture.mjs';
import { addConsentReference, assertIsolatedReference, assertSurvivingSecuritySession, historicalRevokedNull, referenceRows } from './restore-consent-reference-fixtures.mjs';

const AUTH_POLICY = 'face-policy-fixture-v1';
const DEVICE_PROTOCOL = 'lovelies-face-profile-device-v1';
const key = () => 'admin-session-' + randomUUID();
const sessionID = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).jti;
const ordered = facts => [...new Map(facts.map(fact => [stable(fact), fact])).entries()]
  .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, fact]) => fact);
const sessionFact = f => ({ kind: 'session-retired', scope: { account_id: f.person.accountId, session_id: f.targetID } });
const consentFact = (f, id) => ({ kind: 'consent-withdrawn', scope: { account_id: f.person.accountId, consent_id: id, purpose: 'face_authentication' } });
const operationID = (f, body = f.body) => restoreOperationID(f.admin.accountId, 'admin_users', body.operation_key);
const cursor = async f => (await f.journal.control()).marker.cursor.sequence;
const target = f => f.h.db.one('SELECT * FROM sessions WHERE id=?', f.targetID);
const receipt = (f, body = f.body) => f.h.db.one('SELECT * FROM operations WHERE actor_id=? AND source=? AND operation_key=?', f.admin.accountId, 'admin_users', body.operation_key);
const auditRows = f => f.h.db.all("SELECT * FROM audit_events WHERE action='admin.user.session.revoke' ORDER BY id");

async function login(h, person) {
  const challenge = await h.json('/auth/face/challenge', { body: { face_handle: person.faceHandle, device_id: person.deviceId } }, 201);
  const credentials = await h.json('/auth/face/complete', { body: await captureProofs(h, challenge, person.keys.privateKey) });
  return { ...person, ...credentials, token: credentials.access_token };
}
async function administrator(h) {
  const person = await enroll(h);
  await h.db.run('UPDATE accounts SET roles_json=? WHERE id=?', '["user","admin"]', person.accountId);
  return login(h, person);
}
async function adminFixture(t, { registered = true } = {}) {
  const f = await fixture(t), h = f.h;
  h.env.FACE_AUTH_VERIFIER = { fetch: async request => {
    const form = await request.formData();
    return Response.json(await faceVerifierFixture(JSON.parse(String(form.get('envelope'))), form));
  } };
  const admin = await administrator(h), guest = registered ? null : await h.anonymous({ adult: true });
  const person = registered ? await enroll(h) : { ...guest, accountId: guest.account_id, token: guest.access_token, deviceId: null };
  const targetID = sessionID(person.token), original = await h.db.one('SELECT * FROM sessions WHERE id=?', targetID);
  const profile = await h.db.one('SELECT * FROM face_profiles WHERE account_id=?', person.accountId);
  const body = { session_id: targetID, reason: 'Reported lost session', operation_key: key() };
  let clock = h.app.now();
  const handler = createHandler(createApp(f.db, h.env, () => clock));
  const request = (payload = body, { token = admin.token, account = person.accountId } = {}) => handler(new Request('https://api.invalid/admin/users/' + account + '/sessions/revoke', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(payload),
  }));
  const json = async (payload = body, expected = 200, options) => {
    const response = await request(payload, options), value = await response.json();
    assert.equal(response.status, expected, value?.error?.code ?? 'unexpected_response'); return value;
  };
  const uncertain = async () => { const response = await request(); assert(response.status >= 500 && response.status <= 599); await response.body?.cancel(); };
  const otherDevice = async () => {
    const id = randomUUID(), revision = randomUUID();
    let publicJWK;
    if (person.deviceId) publicJWK = (await h.db.one('SELECT public_jwk FROM auth_devices WHERE id=?', person.deviceId)).public_jwk;
    else {
      const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      publicJWK = JSON.stringify(await crypto.subtle.exportKey('jwk', keys.publicKey));
    }
    await h.db.run("INSERT INTO auth_devices(id,account_id,public_jwk,revision,status,face_handle,created_at) VALUES(?,?,?,?,'active',?,?)", id, person.accountId, publicJWK, revision, 'synthetic-other-device-' + id, h.app.now());
    return id;
  };
  const pending = async ({ consentID = randomUUID(), consentOwner = person.accountId, purpose = 'face_authentication', status = 'granted', deviceID = person.deviceId } = {}) => {
    assert(deviceID);
    const device = await h.db.one('SELECT revision FROM auth_devices WHERE id=?', deviceID);
    if (!await h.db.one('SELECT id FROM consents WHERE id=?', consentID)) await h.db.run(`INSERT INTO consents(id,account_id,purpose,policy_version,status,revoked_at,created_at,profile_revision)
      VALUES(?,?,?,?,?,?,?,?)`, consentID, consentOwner, purpose, purpose === 'face_authentication' ? AUTH_POLICY : 'photo-policy-fixture-v1', status,
      status === 'revoked' ? h.app.now() : null, h.app.now(), profile?.revision ?? randomUUID());
    const operationKey = randomUUID();
    await h.db.run(`INSERT INTO face_profile_operations(account_id,operation_key,action,input_hash,expected_version,control_device_id,
      control_revision,state,auth_epoch,consent_id,generation,created_at,expires_at)
      VALUES(?,?,'replace',?,1,?,?,'pending',?,?,0,?,?)`, person.accountId, operationKey, 'a'.repeat(64), deviceID, device.revision,
      original.auth_epoch, consentID, h.app.now(), h.app.now() + 86400000);
    return { consentID, operationKey, deviceID };
  };
  let control;
  const realPending = async (token = person.token) => {
    assert(registered);
    control ??= { key: 'lfl_' + encode(crypto.getRandomValues(new Uint8Array(32))), operationKey: randomUUID() };
    const signed = async (step, fields, creation = false) => {
      const value = { account_id: person.accountId, device_id: person.deviceId, control_key: control.key,
        ...(!creation ? { request_nonce: randomUUID(), request_expires_at: Date.now() + 45000 } : {}), ...fields };
      return { ...value, device_signature: await sign(person.keys.privateKey, { protocol: DEVICE_PROTOCOL, step, ...value }) };
    };
    await h.json('/auth/face/profile/control', { token, body: await signed('control', { control_operation_key: control.operationKey }, true) }, 201);
    const state = await h.db.one('SELECT version FROM face_profile_states WHERE account_id=?', person.accountId), operationKey = randomUUID();
    await h.json('/auth/face/profile/challenge', { body: await signed('challenge', { operation_key: operationKey, action: 'replace', expected_version: state.version,
      consent: { purpose: 'face_authentication', policy_version: AUTH_POLICY, granted: true } }) }, 201);
    return h.db.one('SELECT * FROM face_profile_operations WHERE account_id=? AND operation_key=?', person.accountId, operationKey);
  };
  const seedPush = async () => {
    assert(person.deviceId);
    const id = randomUUID(), value = 'synthetic-private-admin-push-' + randomUUID(), hash = digest(value);
    await h.db.run("INSERT INTO push_devices(id,account_id,auth_device_id,platform,token_hash,token_value,active,created_at,updated_at) VALUES(?,?,?,'ios',?,?,1,?,?)", id, person.accountId, person.deviceId, hash, value, h.app.now(), h.app.now());
    for (const status of ['queued', 'accepted']) {
      const notification = randomUUID();
      await h.db.run("INSERT INTO notifications(id,account_id,kind,entity_id,title,created_at) VALUES(?,?,'support',?,'Synthetic admin retirement fixture',?)", notification, person.accountId, randomUUID(), h.app.now());
      await h.db.run(`INSERT INTO notification_deliveries(id,notification_id,device_id,operation_key,status,token_hash,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?)`, randomUUID(), notification, id, randomUUID(), status, hash, h.app.now(), h.app.now());
    }
    return { id, value };
  };
  return { ...f, admin, person, targetID, original, profile, body, request, json, uncertain, pending, otherDevice, realPending, seedPush,
    now: () => clock, setClock: value => { clock = value; } };
}
async function snapshot(f) {
  const tables = ['sessions', 'consents', 'auth_devices', 'auth_challenges', 'face_profile_operations', 'face_profiles', 'push_devices',
    'notification_deliveries', 'operations', 'operation_subjects', 'audit_events'];
  const result = {};
  for (const table of tables) {
    const order = table === 'face_profile_operations' ? 'account_id,operation_key' : table === 'face_profiles' ? 'account_id' :
      ['operations', 'operation_subjects'].includes(table) ? 'actor_id,source,operation_key' + (table === 'operation_subjects' ? ',subject_id' : '') : 'id';
    result[table] = await f.h.db.all('SELECT * FROM ' + table + ' ORDER BY ' + order);
  }
  return result;
}
async function assertPlan(f, facts, { committed = true, body = f.body } = {}) {
  const saved = await f.journal.lookup(await operationID(f, body)); assert(saved);
  if (committed) assert.equal(saved.status, 'committed');
  assert.deepEqual(saved.plan.allocations, {});
  assert.equal(saved.plan.input_hash, digest(stable({ action: 'admin.user.session.revoke', source: 'admin_users', payload: {
    account_id: f.person.accountId, session_id: body.session_id, reason: body.reason.trim(), operation_key: body.operation_key } })));
  assert.deepEqual(saved.plan.events.map(({ kind, scope }) => ({ kind, scope })), ordered(facts));
  assert.equal(new Set(saved.plan.events.map(value => value.operation_id)).size, ordered(facts).length);
  const encoded = JSON.stringify(saved.plan);
  for (const field of ['access_token', 'refresh_token', 'refresh_hash', 'public_jwk', 'template_key', 'template_digest', 'control_key', 'token_value', 'reason']) assert(!encoded.includes('"' + field + '"'));
  for (const value of [f.admin.token, f.admin.refresh_token, f.person.token, f.person.refresh_token, f.person.faceHandle, f.profile?.template_key,
    f.profile?.template_digest, body.reason].filter(Boolean)) assert(!encoded.includes(value));
  return saved;
}

// These are PostgreSQL-capable tests prepared for the root-owned execution lane.
// This file's presence does not establish a test pass or application deployment.
test('anonymous target retirement records exactly its session and preserves other-device pending work', async t => {
  const f = await adminFixture(t, { registered: false }), unrelated = await f.pending({ deviceID: await f.otherDevice() }), before = await snapshot(f);
  assert.equal(f.original.device_id, null);
  assert.deepEqual(await f.json(), { account_id: f.person.accountId, session_id: f.targetID, status: 'revoked', sessions_revoked: 1, account_disabled: false });
  await assertPlan(f, [sessionFact(f)]); assert.equal(await cursor(f), 1);
  const after = await snapshot(f);
  for (const table of ['consents', 'auth_devices', 'auth_challenges', 'face_profile_operations', 'face_profiles', 'push_devices', 'notification_deliveries']) assert.deepEqual(after[table], before[table]);
  assert.equal(after.face_profile_operations.find(row => row.operation_key === unrelated.operationKey).state, 'pending');
  assert.notEqual((await target(f)).revoked_at, null); assert.notEqual((await target(f)).refresh_consumed_at, null);
});

test('actual pending challenge consent is journaled while profile, device and push registrations survive', async t => {
  const f = await adminFixture(t), pending = await f.realPending(), push = await f.seedPush(), before = await snapshot(f);
  await f.json(); await assertPlan(f, [sessionFact(f), consentFact(f, pending.consent_id)]);
  assert.equal((await f.h.db.one('SELECT state FROM face_profile_operations WHERE operation_key=?', pending.operation_key)).state, 'cancelled');
  assert.equal((await f.h.db.one('SELECT status FROM auth_challenges WHERE id=?', pending.challenge_id)).status, 'cancelled');
  assert.equal((await f.h.db.one('SELECT status FROM consents WHERE id=?', pending.consent_id)).status, 'revoked');
  const after = await snapshot(f);
  for (const table of ['face_profiles', 'auth_devices', 'push_devices', 'notification_deliveries']) assert.deepEqual(after[table], before[table]);
  assert.deepEqual(after.sessions.filter(row => row.id !== f.targetID), before.sessions.filter(row => row.id !== f.targetID));
  const sibling = await login(f.h, f.person); assert.equal((await f.h.json('/me', { token: sibling.token })).authenticated, true);
  await f.h.json('/me', { token: f.person.token }, 401); await f.h.json('/auth/session/refresh', { body: { refresh_token: f.person.refresh_token } }, 401);
  assert(!JSON.stringify((await f.journal.lookup(await operationID(f))).plan).includes(push.value));
  assert.equal((await auditRows(f)).length, 1); assert(await receipt(f));
});

test('exact pending consent episodes deduplicate and preserve profile-bound, revoked, other-device and other-account rows', async t => {
  const f = await adminFixture(t), first = await f.pending(), expired = await f.pending({ status: 'expired' });
  await f.pending({ consentID: first.consentID }); await f.pending({ consentID: f.profile.auth_consent_id });
  const revoked = await f.pending({ status: 'revoked' }), peer = await f.pending({ deviceID: await f.otherDevice() }), foreign = await enroll(f.h), before = await snapshot(f);
  await f.json(); await assertPlan(f, [sessionFact(f), consentFact(f, first.consentID), consentFact(f, expired.consentID)]);
  const after = await snapshot(f);
  for (const id of [first.consentID, expired.consentID, revoked.consentID]) assert.equal(after.consents.find(row => row.id === id).status, 'revoked');
  for (const id of [f.profile.auth_consent_id, peer.consentID]) assert.deepEqual(after.consents.find(row => row.id === id), before.consents.find(row => row.id === id));
  assert.deepEqual(after.sessions.filter(row => row.account_id === foreign.accountId), before.sessions.filter(row => row.account_id === foreign.accountId));
  assert.equal(after.face_profile_operations.find(row => row.operation_key === peer.operationKey).state, 'pending');
});

test('already-retired target emits no facts and cannot cancel newer same-device pending work', async t => {
  const f = await adminFixture(t); await f.h.db.run('UPDATE sessions SET revoked_at=?,refresh_consumed_at=? WHERE id=?', f.now(), f.now(), f.targetID);
  const pending = await f.pending(), before = await snapshot(f), result = await f.json();
  assert.equal(result.sessions_revoked, 0); await assertPlan(f, []); assert.equal(await cursor(f), 0);
  const after = await snapshot(f); for (const table of Object.keys(before).filter(table => !['operations', 'operation_subjects', 'audit_events'].includes(table))) assert.deepEqual(after[table], before[table]);
  assert.equal(after.face_profile_operations.find(row => row.operation_key === pending.operationKey).state, 'pending');
});

for (const drift of ['device', 'account-epoch', 'future-control', 'future-epoch', 'linked-device', 'linked-epoch', 'linked-owner', 'later-session']) test('admin retires the target session without cancelling ' + drift + ' lifecycle work', async t => {
  const f = await adminFixture(t);
  const peer = drift === 'later-session' ? await login(f.h, f.person) : null;
  const pending = await f.realPending(peer?.token);
  const newerRevision = randomUUID(), newerEpoch = Number(f.original.auth_epoch) + 1;
  if (drift === 'device') {
    await f.h.db.run('UPDATE auth_devices SET revision=? WHERE id=?', newerRevision, f.person.deviceId);
    await f.h.db.run('UPDATE face_profile_operations SET control_revision=? WHERE account_id=? AND operation_key=?', newerRevision, f.person.accountId, pending.operation_key);
    await f.h.db.run('UPDATE auth_challenges SET device_revision=? WHERE id=?', newerRevision, pending.challenge_id);
  } else if (drift === 'account-epoch') {
    await f.h.db.run('UPDATE accounts SET auth_epoch=? WHERE id=?', newerEpoch, f.person.accountId);
    await f.h.db.run('UPDATE face_profile_operations SET auth_epoch=? WHERE account_id=? AND operation_key=?', newerEpoch, f.person.accountId, pending.operation_key);
    await f.h.db.run('UPDATE auth_challenges SET auth_epoch=? WHERE id=?', newerEpoch, pending.challenge_id);
  } else if (drift === 'future-control') {
    await f.h.db.run('UPDATE face_profile_operations SET control_revision=? WHERE account_id=? AND operation_key=?', newerRevision, f.person.accountId, pending.operation_key);
    await f.h.db.run('UPDATE auth_challenges SET device_revision=? WHERE id=?', newerRevision, pending.challenge_id);
  } else if (drift === 'future-epoch') {
    await f.h.db.run('UPDATE face_profile_operations SET auth_epoch=? WHERE account_id=? AND operation_key=?', newerEpoch, f.person.accountId, pending.operation_key);
    await f.h.db.run('UPDATE auth_challenges SET auth_epoch=? WHERE id=?', newerEpoch, pending.challenge_id);
  } else if (drift === 'linked-device') {
    await f.h.db.run('UPDATE auth_challenges SET device_revision=? WHERE id=?', newerRevision, pending.challenge_id);
  } else if (drift === 'linked-epoch') {
    await f.h.db.run('UPDATE auth_challenges SET auth_epoch=? WHERE id=?', newerEpoch, pending.challenge_id);
  } else if (drift === 'linked-owner') {
    const foreign = await f.h.anonymous({ adult: true });
    await f.h.db.run('UPDATE auth_challenges SET account_id=? WHERE id=?', foreign.account_id, pending.challenge_id);
  }
  // An inconsistent historical row may still point at the old session; a
  // broad session-ID challenge update must not cancel the newer episode.
  if (['device', 'account-epoch', 'future-control', 'future-epoch'].includes(drift))
    await f.h.db.run('UPDATE auth_challenges SET session_id=? WHERE id=?', f.targetID, pending.challenge_id);
  const before = await snapshot(f), result = await f.json();
  assert.equal(result.sessions_revoked, 1);
  const after = await snapshot(f);
  for (const table of ['consents', 'auth_devices', 'auth_challenges', 'face_profile_operations', 'face_profiles', 'push_devices', 'notification_deliveries'])
    assert.deepEqual(after[table], before[table], table + ' must preserve the other lifecycle episode');
  assert.notEqual((await target(f)).revoked_at, null);
  const plan = await assertPlan(f, [sessionFact(f)]);
  assert.deepEqual(await f.json(), result); assert.deepEqual(await snapshot(f), after);
  assert.deepEqual(await f.journal.lookup(await operationID(f)), plan);
  if (peer) assert.equal((await f.h.json('/me', { token: peer.token })).authenticated, true);
});

test('original receipt precedes newer authority, and demotion cannot disclose the cached result through stale or current user credentials', async t => {
  const f = await adminFixture(t), first = await f.realPending(), result = await f.json(), originalPlan = await assertPlan(f, [sessionFact(f), consentFact(f, first.consent_id)]);
  const successor = await login(f.h, f.person), replacement = await f.realPending(successor.token), before = await snapshot(f), originalReceipt = await receipt(f);
  assert.deepEqual(await f.json(), result); assert.deepEqual(await snapshot(f), before); assert.deepEqual(await receipt(f), originalReceipt);
  assert.deepEqual(await f.journal.lookup(await operationID(f)), originalPlan); assert.equal(await cursor(f), 2);
  assert.equal((await f.h.db.one('SELECT state FROM face_profile_operations WHERE operation_key=?', replacement.operation_key)).state, 'pending');
  await f.h.db.run('UPDATE accounts SET roles_json=? WHERE id=?', '["user"]', f.admin.accountId);
  const demoted = await snapshot(f); assert.equal((await f.json(f.body, 401)).error.code, 'session_invalid'); assert.deepEqual(await snapshot(f), demoted);
  const ordinary = await login(f.h, f.admin), current = await snapshot(f); assert.deepEqual(ordinary.roles, ['user']);
  assert.equal((await f.json(f.body, 403, { token: ordinary.token })).error.code, 'admin_required'); assert.deepEqual(await snapshot(f), current);
  assert.deepEqual(await f.journal.lookup(await operationID(f)), originalPlan); assert.deepEqual(await receipt(f), originalReceipt);
});

test('altered reason, session or target with the original operation key conflicts before another retirement', async t => {
  const f = await adminFixture(t), sibling = await login(f.h, f.person), other = await enroll(f.h); await f.json();
  const before = await snapshot(f), plan = await f.journal.lookup(await operationID(f));
  for (const [body, options] of [[{ ...f.body, reason: 'Changed reason' }, undefined], [{ ...f.body, session_id: sessionID(sibling.token) }, undefined],
    [{ ...f.body, session_id: sessionID(other.token) }, { account: other.accountId }]]) {
    assert.equal((await f.json(body, 409, options)).error.code, 'operation_key_conflict'); assert.deepEqual(await snapshot(f), before);
  }
  assert.deepEqual(await f.journal.lookup(await operationID(f)), plan);
});

for (const invalid of ['foreign-session', 'missing-account', 'deleted-account']) test('invalid target ' + invalid + ' cannot create a receipt or restriction', async t => {
  const f = await adminFixture(t); await f.pending(); let body = f.body, options, code, status;
  if (invalid === 'foreign-session') { const other = await enroll(f.h); body = { ...body, session_id: sessionID(other.token) }; status = 404; code = 'session_not_found'; }
  if (invalid === 'missing-account') { options = { account: randomUUID() }; status = 404; code = 'account_not_found'; }
  if (invalid === 'deleted-account') { await f.h.db.run('UPDATE accounts SET disabled_at=? WHERE id=?', f.now(), f.person.accountId); status = 409; code = 'account_deleted'; }
  const before = await snapshot(f); assert.equal((await f.json(body, status, options)).error.code, code); assert.deepEqual(await snapshot(f), before);
  assert.equal(await f.journal.lookup(await operationID(f)), null); assert.equal(await receipt(f), null);
});

test('reason, input and operation-key validation plus anonymous or ordinary callers precede target mutation', async t => {
  const f = await adminFixture(t), before = await snapshot(f);
  for (const reason of ['', 'no', null, 'x'.repeat(1001), 'line\nbreak']) await f.json({ ...f.body, reason }, 400);
  await f.json({ ...f.body, unsupported: 'suspend' }, 400); await f.json({ ...f.body, operation_key: undefined }, 400);
  await f.json(f.body, 401, { token: null }); assert.equal((await f.json(f.body, 403, { token: f.person.token })).error.code, 'admin_required');
  assert.deepEqual(await snapshot(f), before); assert.equal(await f.journal.lookup(await operationID(f)), null);
});

for (const invalid of ['session-revoked', 'account-disabled', 'epoch-changed', 'roles-changed', 'device-revoked', 'device-revision']) test('fresh operator authority rejects ' + invalid + ' without facts or SQL effects', async t => {
  const f = await adminFixture(t); await f.pending();
  if (invalid === 'session-revoked') await f.h.db.run('UPDATE sessions SET revoked_at=? WHERE id=?', f.now(), sessionID(f.admin.token));
  if (invalid === 'account-disabled') await f.h.db.run('UPDATE accounts SET disabled_at=? WHERE id=?', f.now(), f.admin.accountId);
  if (invalid === 'epoch-changed') await f.h.db.run('UPDATE accounts SET auth_epoch=auth_epoch+1 WHERE id=?', f.admin.accountId);
  if (invalid === 'roles-changed') await f.h.db.run('UPDATE accounts SET roles_json=? WHERE id=?', '["user"]', f.admin.accountId);
  if (invalid === 'device-revoked') await f.h.db.run("UPDATE auth_devices SET status='revoked' WHERE id=?", f.admin.deviceId);
  if (invalid === 'device-revision') await f.h.db.run('UPDATE auth_devices SET revision=? WHERE id=?', randomUUID(), f.admin.deviceId);
  const before = await snapshot(f); await f.json(f.body, 401); assert.deepEqual(await snapshot(f), before);
  assert.equal(await f.journal.lookup(await operationID(f)), null); assert.equal(await receipt(f), null);
});

test('sole administrator and self-management protection remain ahead of the callback', async t => {
  const f = await adminFixture(t), body = { ...f.body, session_id: sessionID(f.admin.token) }, options = { account: f.admin.accountId }, before = await snapshot(f);
  assert.equal((await f.json(body, 409, options)).error.code, 'last_admin_protected'); assert.deepEqual(await snapshot(f), before);
  await administrator(f.h); const withPeer = await snapshot(f);
  assert.equal((await f.json(body, 403, options)).error.code, 'self_management_forbidden'); assert.deepEqual(await snapshot(f), withPeer);
  assert.equal(await f.journal.lookup(await operationID(f)), null); assert.equal(await receipt(f), null);
});

test('fresh face proof is rechecked after fact collection and before lifecycle or session writes', async t => {
  const f = await adminFixture(t); await f.pending(); const before = await snapshot(f), transaction = f.db.transaction.bind(f.db), now = f.now(); let observed = false;
  f.db.transaction = (callback, intent) => transaction(restore => callback({ operation: value => restore.operation(value), restrict: async (kind, scope) => {
    await restore.restrict(kind, scope); if (kind === 'session-retired') { observed = true; f.setClock(now + 300001); }
  } }), intent);
  assert.equal((await f.json(f.body, 403)).error.code, 'fresh_face_authentication_required'); f.setClock(now); assert.equal(observed, true);
  assert.deepEqual(await snapshot(f), before); assert.equal(await f.journal.lookup(await operationID(f)), null);
});

for (const changed of ['session-device', 'pending-consent']) test('selected ' + changed + ' drift after facts rolls back rather than publishing an inexact plan', async t => {
  const f = await adminFixture(t), pending = await f.pending(), otherDevice = await f.otherDevice(), before = await snapshot(f), transaction = f.db.transaction.bind(f.db); let observed = false;
  // Deliberate same-transaction fault injection avoids cross-connection writes
  // while the advisory lock is held, and is rolled back by the required denial.
  f.db.transaction = (callback, intent) => transaction(restore => callback({ operation: value => restore.operation(value), restrict: async (kind, scope) => {
    await restore.restrict(kind, scope);
    if (kind === 'session-retired' && !observed) {
      observed = true;
      if (changed === 'session-device') await f.db.run('UPDATE sessions SET device_id=? WHERE id=?', otherDevice, f.targetID);
      else await f.db.run("UPDATE consents SET status='revoked',revoked_at=? WHERE id=?", f.now(), pending.consentID);
    }
  } }), intent);
  assert.equal((await f.json(f.body, 409)).error.code, 'admin_session_authority_changed'); assert.equal(observed, true);
  assert.deepEqual(await snapshot(f), before); assert.equal(await f.journal.lookup(await operationID(f)), null); assert.equal(await receipt(f), null);
});

test('linked challenge generation drift after fact collection rolls back the selected admin retirement', async t => {
  const f = await adminFixture(t), pending = await f.realPending(), before = await snapshot(f), transaction = f.db.transaction.bind(f.db); let observed = false;
  f.db.transaction = (callback, intent) => transaction(restore => callback({ operation: value => restore.operation(value), restrict: async (kind, scope) => {
    await restore.restrict(kind, scope);
    if (kind === 'session-retired' && !observed) { observed = true; await f.db.run('UPDATE auth_challenges SET device_revision=? WHERE id=?', randomUUID(), pending.challenge_id); }
  } }), intent);
  assert.equal((await f.json(f.body, 409)).error.code, 'admin_session_authority_changed'); assert.equal(observed, true);
  assert.deepEqual(await snapshot(f), before); assert.equal(await f.journal.lookup(await operationID(f)), null); assert.equal(await receipt(f), null);
});

for (const pendingCount of [31, 32]) test((pendingCount + 1) + ' admin retirement facts include the session and atomically commit or fail before writes', async t => {
  const f = await adminFixture(t), selected = []; await f.seedPush();
  for (let index = 0; index < pendingCount; index++) selected.push(await f.pending());
  const before = await snapshot(f); f.trace.length = 0;
  if (pendingCount === 31) { await f.json(); await assertPlan(f, [sessionFact(f), ...selected.map(row => consentFact(f, row.consentID))]); assert.equal(await cursor(f), 32); }
  else {
    assert.equal((await f.json(f.body, 503)).error.code, 'admin_session_restriction_capacity'); assert.deepEqual(await snapshot(f), before);
    assert.equal(await f.journal.lookup(await operationID(f)), null); assert.equal(await cursor(f), 0);
    assert(!f.trace.some(value => value.kind === 'sql' && /^(INSERT|UPDATE|DELETE) /.test(value.sql) && !value.sql.startsWith('UPDATE restore_control ')));
  }
});

for (const malformed of ['cross-account', 'other-purpose']) test('malformed pending ' + malformed + ' fails before any admin retirement or audit', async t => {
  const f = await adminFixture(t), foreign = malformed === 'cross-account' ? await f.h.anonymous({ adult: true }) : null;
  await f.pending({ consentOwner: foreign?.account_id ?? f.person.accountId, purpose: malformed === 'other-purpose' ? 'photo_matching' : 'face_authentication' });
  const before = await snapshot(f); assert.equal((await f.json(f.body, 409)).error.code, 'face_profile_pending_consent_invalid'); assert.deepEqual(await snapshot(f), before);
  assert.equal(await f.journal.lookup(await operationID(f)), null); assert.equal(await receipt(f), null);
});

test('callback failure after session SQL rolls back pending cancellation, target, audit and operation receipt', async t => {
  const f = await adminFixture(t); await f.pending(); const before = await snapshot(f), run = f.db.run.bind(f.db); let consumed = false;
  f.db.run = async (sql, ...bindings) => { await run(sql, ...bindings); if (!consumed && sql.startsWith('UPDATE sessions SET revoked_at=?,refresh_consumed_at=coalesce(')) { consumed = true; throw Error('synthetic_admin_retirement_callback_failure'); } };
  await f.uncertain(); assert.equal(consumed, true); assert.deepEqual(await snapshot(f), before); assert.equal(await f.journal.lookup(await operationID(f)), null);
});

test('accepted admin plan with rejected SQL commit retains pending facts and blocks callback replay', async t => {
  const f = await adminFixture(t), pending = await f.pending(), before = await snapshot(f), id = await operationID(f), prepare = f.journal.prepare.bind(f.journal); let armed = true;
  f.journal.prepare = async value => { const saved = await prepare(value); if (armed && value.operation_id === id) { armed = false; f.faults.beforeCommit = true; } return saved; };
  await f.uncertain(); assert.equal(armed, false); assert.equal(f.faults.beforeCommit, false); assert.deepEqual(await snapshot(f), before);
  const saved = await assertPlan(f, [sessionFact(f), consentFact(f, pending.consentID)], { committed: false }); assert.equal(saved.status, 'pending');
  await assert.rejects(() => f.db.one('SELECT id FROM accounts LIMIT 1'), unavailable); await f.uncertain(); assert.deepEqual(await snapshot(f), before); assert.deepEqual(await f.journal.lookup(id), saved);
});

for (const mode of ['outage', 'prepare-before', 'prepare-after', 'commit-result-loss', 'ack-before', 'ack-after']) test('admin retirement ' + mode + ' preserves exact journal, SQL receipt and actual commit boundary', async t => {
  const f = await adminFixture(t), pending = await f.pending(), before = await snapshot(f), id = await operationID(f), facts = [sessionFact(f), consentFact(f, pending.consentID)]; let boundary;
  if (mode === 'outage') f.faults.control = true;
  else if (mode.startsWith('prepare-')) f.faults.reply = { path: '/v1/operations/prepare', stage: mode.slice(8) };
  else if (mode === 'commit-result-loss') {
    const prepare = f.journal.prepare.bind(f.journal); let armed = true;
    f.journal.prepare = async value => { const saved = await prepare(value); if (armed && value.operation_id === id) { armed = false; f.faults.commitReply = true;
      f.faults.afterCommit = async () => { delete f.faults.afterCommit; boundary = { journal: await f.journal.lookup(id), session: await target(f),
        consent: await f.h.db.one('SELECT * FROM consents WHERE id=?', pending.consentID), receipt: await receipt(f), audit: await auditRows(f) }; };
    } return saved; };
  } else f.faults.reply = { path: '/v1/operations/' + id + '/acknowledge', stage: mode.slice(4) };
  await f.uncertain(); const saved = await f.journal.lookup(id);
  if (mode === 'outage' || mode === 'prepare-before') {
    assert.deepEqual(await snapshot(f), before); assert.equal(saved, null); f.faults.control = false;
    if (mode === 'prepare-before') assert.equal(f.faults.reply, undefined);
    await f.json(); await assertPlan(f, facts); return;
  }
  if (mode === 'prepare-after') {
    assert.equal(f.faults.reply, undefined); assert.deepEqual(await snapshot(f), before); await assertPlan(f, facts, { committed: false }); assert.equal(saved.status, 'pending');
    await assert.rejects(() => f.db.one('SELECT id FROM accounts LIMIT 1'), unavailable); await f.uncertain(); assert.deepEqual(await snapshot(f), before); assert.deepEqual(await f.journal.lookup(id), saved); return;
  }
  assert.notEqual((await target(f)).revoked_at, null); assert.equal((await f.h.db.one('SELECT status FROM consents WHERE id=?', pending.consentID)).status, 'revoked');
  assert(await receipt(f)); assert.equal((await auditRows(f)).length, 1);
  if (mode === 'commit-result-loss') {
    assert(boundary); assert.equal(boundary.journal.status, 'pending'); assert.notEqual(boundary.session.revoked_at, null); assert.equal(boundary.consent.status, 'revoked');
    assert(boundary.receipt); assert.equal(boundary.audit.length, 1); assert.equal(f.faults.commitReply, false); assert.equal(f.faults.afterCommit, undefined);
    assert.equal(saved.status, 'committed'); assert.equal(saved.plan_hash, boundary.journal.plan_hash);
  } else { assert.equal(f.faults.reply, undefined); assert.equal(saved.status, mode === 'ack-after' ? 'committed' : 'pending'); }
  const committedState = await snapshot(f), originalReceipt = await receipt(f), response = await f.json();
  assert.deepEqual(response, JSON.parse(originalReceipt.response_json)); assert.deepEqual(await snapshot(f), committedState);
  const committed = await assertPlan(f, facts); assert.equal(committed.plan_hash, saved.plan_hash); assert.equal(await cursor(f), facts.length);
});


// These cases isolate each reference class from the same-device peer and
// profile-reference exclusions. No provider or shared database work is run here.
for (const kind of ['enrollment', 'recovery', 'session']) for (const consentStatus of ['granted', 'historical-revoked-null'])
  test(`admin session retirement preserves ${kind} consent reference with ${consentStatus} consent`, async t => {
    const f = await adminFixture(t), pending = await f.pending({ status: consentStatus === 'granted' ? 'granted' : 'revoked' });
    const reference = await addConsentReference(f, kind, pending.consentID);
    if (consentStatus === 'historical-revoked-null') await historicalRevokedNull(f, pending.consentID);
    await assertIsolatedReference(f, reference); await assertSurvivingSecuritySession(f, reference);
    await f.seedPush(); const before = await snapshot(f), referencesBefore = await referenceRows(f), result = await f.json();
    assert.equal(result.sessions_revoked, 1);
    const saved = await assertPlan(f, [sessionFact(f)]), after = await snapshot(f);
    for (const table of ['consents', 'auth_devices', 'auth_challenges', 'face_profile_operations', 'face_profiles', 'push_devices', 'notification_deliveries'])
      assert.deepEqual(after[table], before[table], table + ' preserves the independent reference');
    assert.deepEqual(await referenceRows(f), referencesBefore);
    assert.deepEqual(after.sessions.filter(row => row.id !== f.targetID), before.sessions.filter(row => row.id !== f.targetID));
    assert.notEqual((await target(f)).revoked_at, null); assert.notEqual((await target(f)).refresh_consumed_at, null);
    assert.equal(after.face_profile_operations.find(row => row.operation_key === pending.operationKey).state, 'pending');
    if (consentStatus === 'historical-revoked-null') assert.equal(after.consents.find(row => row.id === pending.consentID).revoked_at, null);
    await assertSurvivingSecuritySession(f, reference);
    assert.deepEqual(await f.json(), result); assert.deepEqual(await snapshot(f), after);
    assert.deepEqual(await f.journal.lookup(await operationID(f)), saved); assert.equal(await cursor(f), 1);
  });

for (const kind of ['enrollment', 'recovery', 'session']) test(`admin session retirement still cancels unshared work when the ${kind} reference was already revoked`, async t => {
  const f = await adminFixture(t), pending = await f.pending(), reference = await addConsentReference(f, kind, pending.consentID, { revoked: true });
  await assertIsolatedReference(f, reference);
  const before = await snapshot(f), referencesBefore = await referenceRows(f);
  assert.equal((await f.json()).sessions_revoked, 1); await assertPlan(f, [sessionFact(f), consentFact(f, pending.consentID)]);
  const after = await snapshot(f);
  assert.equal(after.consents.find(row => row.id === pending.consentID).status, 'revoked');
  assert.notEqual(after.consents.find(row => row.id === pending.consentID).revoked_at, null);
  assert.equal(after.face_profile_operations.find(row => row.operation_key === pending.operationKey).state, 'cancelled');
  assert.deepEqual(after.consents.filter(row => row.id !== pending.consentID), before.consents.filter(row => row.id !== pending.consentID));
  assert.deepEqual(await referenceRows(f), referencesBefore);
  assert.deepEqual(after.sessions.filter(row => row.id !== f.targetID), before.sessions.filter(row => row.id !== f.targetID));
  for (const table of ['auth_devices', 'face_profiles', 'push_devices', 'notification_deliveries']) assert.deepEqual(after[table], before[table]);
  assert.equal(await cursor(f), 2);
});
