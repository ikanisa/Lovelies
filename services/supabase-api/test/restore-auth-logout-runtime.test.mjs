import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createApp, createHandler } from '../src/index.ts';
import { restoreOperationID } from '../src/restore-transaction.ts';
import { enroll, captureProofs, faceVerifierFixture, sign, encode, stable } from './runtime-harness.mjs';
import { fixture, digest, unavailable } from './restore-database-fixture.mjs';

const AUTH_POLICY = 'face-policy-fixture-v1';
const PHOTO_POLICY = 'photo-policy-fixture-v1';
const DEVICE_PROTOCOL = 'lovelies-face-profile-device-v1';
const sessionFact = f => ({ kind: 'session-retired', scope: { account_id: f.person.accountId, session_id: f.sessionID } });
const consentFact = (f, id) => ({ kind: 'consent-withdrawn', scope: { account_id: f.person.accountId, consent_id: id, purpose: 'face_authentication' } });
const ordered = facts => [...new Map(facts.map(fact => [stable(fact), fact])).entries()]
  .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, fact]) => fact);
const logoutID = f => restoreOperationID(f.person.accountId, 'auth.logout-v1', 'session.logout:' + f.sessionID);
const cursor = async f => (await f.journal.control()).marker.cursor.sequence;
const session = f => f.h.db.one('SELECT * FROM sessions WHERE id=?', f.sessionID);
const sessionID = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).jti;

async function logoutFixture(t, { registered = false } = {}) {
  const f = await fixture(t), h = f.h;
  h.env.FACE_AUTH_VERIFIER = { fetch: async request => {
    const form = await request.formData();
    return Response.json(await faceVerifierFixture(JSON.parse(String(form.get('envelope'))), form));
  } };
  const guest = registered ? null : await h.anonymous({ adult: true });
  const person = registered ? await enroll(h) : { ...guest, accountId: guest.account_id, token: guest.access_token, deviceId: null };
  const original = await h.db.one('SELECT * FROM sessions WHERE id=?', sessionID(person.token));
  const beforeProfile = await h.db.one('SELECT * FROM face_profiles WHERE account_id=?', person.accountId);
  let clock = h.app.now();
  const context = createApp(f.db, h.env, () => clock), handler = createHandler(context);
  const request = (path = '/auth/logout', { body = {}, token = person.token } = {}) => handler(new Request('https://api.invalid' + path,
    { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) }));
  const json = async (path, options, expected = 200) => {
    const response = await request(path, options), body = await response.json();
    assert.equal(response.status, expected, body?.error?.code ?? 'unexpected_response'); return body;
  };
  const logout = (expected = 200, options) => json('/auth/logout', options, expected);
  const uncertain = async () => { const response = await request(); assert(response.status >= 500 && response.status <= 599); await response.body?.cancel(); };
  const otherDevice = async () => {
    const id = randomUUID(), revision = randomUUID();
    let publicJWK;
    if (person.deviceId) publicJWK = (await h.db.one('SELECT public_jwk FROM auth_devices WHERE id=?', person.deviceId)).public_jwk;
    else {
      const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      publicJWK = JSON.stringify(await crypto.subtle.exportKey('jwk', keys.publicKey));
    }
    await h.db.run("INSERT INTO auth_devices(id,account_id,public_jwk,revision,status,face_handle,created_at) VALUES(?,?,?,?,'active',?,?)",
      id, person.accountId, publicJWK, revision, 'synthetic-other-device-' + id, h.app.now());
    return id;
  };
  const pending = async ({ consentID = randomUUID(), consentOwner = person.accountId, purpose = 'face_authentication', status = 'granted', deviceID = person.deviceId } = {}) => {
    assert(deviceID, 'A pending lifecycle fixture needs an exact owned device');
    const device = await h.db.one('SELECT revision FROM auth_devices WHERE id=?', deviceID);
    if (!await h.db.one('SELECT id FROM consents WHERE id=?', consentID)) await h.db.run(`INSERT INTO consents(id,account_id,purpose,policy_version,status,revoked_at,created_at,profile_revision)
      VALUES(?,?,?,?,?,?,?,?)`, consentID, consentOwner, purpose, purpose === 'face_authentication' ? AUTH_POLICY : PHOTO_POLICY,
      status, status === 'revoked' ? h.app.now() : null, h.app.now(), beforeProfile?.revision ?? randomUUID());
    const operationKey = randomUUID();
    await h.db.run(`INSERT INTO face_profile_operations(account_id,operation_key,action,input_hash,expected_version,control_device_id,
      control_revision,state,auth_epoch,consent_id,generation,created_at,expires_at)
      VALUES(?,?,'replace',?,1,?,?,'pending',?,?,0,?,?)`, person.accountId, operationKey, 'a'.repeat(64), deviceID,
      device.revision, original.auth_epoch, consentID, h.app.now(), h.app.now() + 86400000);
    return { consentID, operationKey, deviceID };
  };
  let control;
  const realPending = async () => {
    assert(registered);
    control ??= { key: 'lfl_' + encode(crypto.getRandomValues(new Uint8Array(32))), operationKey: randomUUID() };
    const signed = async (step, fields, creation = false) => {
      const body = { account_id: person.accountId, device_id: person.deviceId, control_key: control.key,
        ...(!creation ? { request_nonce: randomUUID(), request_expires_at: Date.now() + 45000 } : {}), ...fields };
      return { ...body, device_signature: await sign(person.keys.privateKey, { protocol: DEVICE_PROTOCOL, step, ...body }) };
    };
    await h.json('/auth/face/profile/control', { token: person.token, body: await signed('control', { control_operation_key: control.operationKey }, true) }, 201);
    const state = await h.db.one('SELECT version FROM face_profile_states WHERE account_id=?', person.accountId);
    const key = randomUUID();
    await h.json('/auth/face/profile/challenge', { body: await signed('challenge', { operation_key: key, action: 'replace', expected_version: state.version,
      consent: { purpose: 'face_authentication', policy_version: AUTH_POLICY, granted: true } }) }, 201);
    return h.db.one('SELECT * FROM face_profile_operations WHERE account_id=? AND operation_key=?', person.accountId, key);
  };
  const seedPush = async () => {
    assert(person.deviceId);
    const id = randomUUID(), value = 'synthetic-private-push-' + randomUUID(), hash = digest(value);
    await h.db.run("INSERT INTO push_devices(id,account_id,auth_device_id,platform,token_hash,token_value,active,created_at,updated_at) VALUES(?,?,?,'ios',?,?,1,?,?)",
      id, person.accountId, person.deviceId, hash, value, h.app.now(), h.app.now());
    const deliveries = [];
    for (const status of ['queued', 'accepted']) {
      const notification = randomUUID(), delivery = randomUUID(); deliveries.push({ id: delivery, status });
      await h.db.run("INSERT INTO notifications(id,account_id,kind,entity_id,title,created_at) VALUES(?,?,'support',?,'Synthetic logout fixture',?)", notification, person.accountId, randomUUID(), h.app.now());
      await h.db.run(`INSERT INTO notification_deliveries(id,notification_id,device_id,operation_key,status,token_hash,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?)`, delivery, notification, id, randomUUID(), status, hash, h.app.now(), h.app.now());
    }
    return { id, value, deliveries };
  };
  return { ...f, context, person, sessionID: original.id, original, beforeProfile, request, json, logout, uncertain,
    otherDevice, pending, realPending, seedPush, now: () => clock, setClock: value => { clock = value; } };
}

async function snapshot(f) {
  const tables = ['sessions', 'consents', 'auth_devices', 'auth_challenges', 'face_profile_operations', 'face_profiles', 'push_devices', 'notification_deliveries'];
  const result = {};
  for (const table of tables) result[table] = await f.h.db.all('SELECT * FROM ' + table + (table === 'face_profile_operations' ? ' ORDER BY account_id,operation_key' : ' ORDER BY ' + (table === 'face_profiles' ? 'account_id' : 'id')));
  return result;
}
async function assertPlan(f, facts, { committed = true } = {}) {
  const saved = await f.journal.lookup(await logoutID(f)); assert(saved);
  if (committed) assert.equal(saved.status, 'committed');
  assert.deepEqual(saved.plan.allocations, {});
  assert.equal(saved.plan.input_hash, digest(stable({ protocol: 'lovelies-auth-logout-v1', account_id: f.person.accountId,
    session_id: f.sessionID, device_id: f.original.device_id, device_revision: f.original.device_revision })));
  assert.deepEqual(saved.plan.events.map(({ kind, scope }) => ({ kind, scope })), ordered(facts));
  assert.equal(new Set(saved.plan.events.map(value => value.operation_id)).size, facts.length);
  const encoded = JSON.stringify(saved.plan);
  for (const field of ['access_token', 'refresh_token', 'refresh_hash', 'public_jwk', 'template_key', 'template_digest', 'control_key', 'token_value'])
    assert(!encoded.includes('"' + field + '"'), 'Logout plans contain no credential, device key, private media reference or push token');
  for (const value of [f.person.token, f.person.refresh_token, f.person.faceHandle, f.beforeProfile?.template_key, f.beforeProfile?.template_digest].filter(Boolean)) assert(!encoded.includes(value));
  return saved;
}


test('anonymous no-device logout journals exactly its current session and cannot acquire an all-device cancellation scope', async t => {
  const f = await logoutFixture(t), unrelated = await f.pending({ deviceID: await f.otherDevice() });
  const before = await snapshot(f); assert.equal(f.original.device_id, null);
  assert.deepEqual(await f.logout(), { status: 'logged_out' }); await assertPlan(f, [sessionFact(f)]);
  const after = await snapshot(f); assert.notEqual((await session(f)).revoked_at, null); assert.notEqual((await session(f)).refresh_consumed_at, null);
  for (const table of Object.keys(before).filter(table => table !== 'sessions')) assert.deepEqual(after[table], before[table]);
  assert.equal((await f.h.db.one('SELECT state FROM face_profile_operations WHERE operation_key=?', unrelated.operationKey)).state, 'pending');
  const saved = await f.journal.lookup(await logoutID(f)); await f.logout(401); assert.deepEqual(await f.journal.lookup(await logoutID(f)), saved);
  assert.equal(await cursor(f), 1);
});

test('registered logout journals the actual pending challenge consent while preserving the profile and active authentication device', async t => {
  const f = await logoutFixture(t, { registered: true }), pending = await f.realPending(), push = await f.seedPush();
  const peerChallenge = await f.h.json('/auth/face/challenge', { body: { face_handle: f.person.faceHandle, device_id: f.person.deviceId } }, 201);
  const peer = await f.h.json('/auth/face/complete', { body: await captureProofs(f.h, peerChallenge, f.person.keys.privateKey) });
  assert.notEqual(sessionID(peer.access_token), f.sessionID);
  const device = await f.h.db.one('SELECT * FROM auth_devices WHERE id=?', f.person.deviceId), before = await snapshot(f);
  await f.logout(); await assertPlan(f, [sessionFact(f), consentFact(f, pending.consent_id)]);
  assert.equal((await f.h.db.one('SELECT state FROM face_profile_operations WHERE operation_key=?', pending.operation_key)).state, 'cancelled');
  assert.equal((await f.h.db.one('SELECT status FROM auth_challenges WHERE id=?', pending.challenge_id)).status, 'cancelled');
  assert.equal((await f.h.db.one('SELECT status FROM consents WHERE id=?', pending.consent_id)).status, 'revoked');
  assert.deepEqual(await f.h.db.one('SELECT * FROM face_profiles WHERE account_id=?', f.person.accountId), f.beforeProfile);
  assert.deepEqual(await f.h.db.one('SELECT * FROM auth_devices WHERE id=?', f.person.deviceId), device);
  const afterPush = await f.h.db.one('SELECT * FROM push_devices WHERE id=?', push.id); assert.equal(afterPush.active, 0); assert.equal(afterPush.token_value, '');
  assert(!JSON.stringify((await f.journal.lookup(await logoutID(f))).plan).includes(push.value));
  for (const delivery of push.deliveries) assert.equal((await f.h.db.one('SELECT status FROM notification_deliveries WHERE id=?', delivery.id)).status, delivery.status === 'accepted' ? 'accepted' : 'cancelled');
  assert.deepEqual((await snapshot(f)).sessions.filter(row => row.id !== f.sessionID), before.sessions.filter(row => row.id !== f.sessionID));
  assert.equal((await f.h.json('/me', { token: peer.access_token })).authenticated, true);
  const challenge = await f.h.json('/auth/face/challenge', { body: { face_handle: f.person.faceHandle, device_id: f.person.deviceId } }, 201);
  const fresh = await f.h.json('/auth/face/complete', { body: await captureProofs(f.h, challenge, f.person.keys.privateKey) });
  assert.equal(fresh.account_id, f.person.accountId); assert.notEqual(sessionID(fresh.access_token), f.sessionID);
});

test('logout deduplicates exact old pending episodes and preserves revoked, profile-bound, other-device and other-account authority', async t => {
  const f = await logoutFixture(t, { registered: true }), first = await f.pending(), expired = await f.pending({ status: 'expired' });
  await f.pending({ consentID: first.consentID }); await f.pending({ consentID: f.beforeProfile.auth_consent_id });
  const revoked = await f.pending({ status: 'revoked' }), peer = await f.pending({ deviceID: await f.otherDevice() });
  const foreign = await f.h.anonymous({ adult: true }), before = await snapshot(f);
  await f.logout(); await assertPlan(f, [sessionFact(f), consentFact(f, first.consentID), consentFact(f, expired.consentID)]);
  const after = await snapshot(f);
  for (const id of [first.consentID, expired.consentID, revoked.consentID]) assert.equal(after.consents.find(row => row.id === id).status, 'revoked');
  for (const id of [f.beforeProfile.auth_consent_id, peer.consentID]) assert.deepEqual(after.consents.find(row => row.id === id), before.consents.find(row => row.id === id));
  assert.deepEqual(after.sessions.filter(row => row.account_id === foreign.account_id), before.sessions.filter(row => row.account_id === foreign.account_id));
  assert.equal(after.face_profile_operations.find(row => row.operation_key === peer.operationKey).state, 'pending');
});

for (const malformed of ['cross-account', 'other-purpose']) test('malformed pending ' + malformed + ' fails closed before any logout effect', async t => {
  const f = await logoutFixture(t, { registered: true }); await f.seedPush();
  const foreign = malformed === 'cross-account' ? await f.h.anonymous({ adult: true }) : null;
  await f.pending({ consentOwner: foreign?.account_id ?? f.person.accountId, purpose: malformed === 'other-purpose' ? 'photo_matching' : 'face_authentication' });
  const before = await snapshot(f);
  assert.equal((await f.logout(409)).error.code, 'face_profile_pending_consent_invalid');
  assert.deepEqual(await snapshot(f), before); assert.equal(await f.journal.lookup(await logoutID(f)), null); assert.equal(await cursor(f), 0);
});

for (const pendingCount of [31, 32]) test((pendingCount + 1) + ' logout facts include the session and are atomic or refused before effects', async t => {
  const f = await logoutFixture(t, { registered: true }), selected = []; await f.seedPush();
  for (let index = 0; index < pendingCount; index++) selected.push(await f.pending());
  const before = await snapshot(f); f.trace.length = 0;
  if (pendingCount === 31) {
    await f.logout(); await assertPlan(f, [sessionFact(f), ...selected.map(row => consentFact(f, row.consentID))]); assert.equal(await cursor(f), 32);
  } else {
    assert.equal((await f.logout(503)).error.code, 'logout_restriction_capacity'); assert.deepEqual(await snapshot(f), before);
    assert.equal(await f.journal.lookup(await logoutID(f)), null); assert.equal(await cursor(f), 0);
    assert(!f.trace.some(value => value.kind === 'sql' && /^(INSERT|UPDATE|DELETE) /.test(value.sql) && !value.sql.startsWith('UPDATE restore_control ')));
  }
});

for (const invalid of ['session-revoked', 'account-disabled', 'epoch-changed', 'roles-changed', 'device-revoked', 'device-revision']) test('logout retains fresh privacy authority for ' + invalid, async t => {
  const f = await logoutFixture(t, { registered: true }); await f.pending(); await f.seedPush();
  if (invalid === 'session-revoked') await f.h.db.run('UPDATE sessions SET revoked_at=? WHERE id=?', f.now(), f.sessionID);
  if (invalid === 'account-disabled') await f.h.db.run('UPDATE accounts SET disabled_at=? WHERE id=?', f.now(), f.person.accountId);
  if (invalid === 'epoch-changed') await f.h.db.run('UPDATE accounts SET auth_epoch=auth_epoch+1 WHERE id=?', f.person.accountId);
  if (invalid === 'roles-changed') await f.h.db.run('UPDATE accounts SET roles_json=? WHERE id=?', '["user","admin"]', f.person.accountId);
  if (invalid === 'device-revoked') await f.h.db.run("UPDATE auth_devices SET status='revoked' WHERE id=?", f.person.deviceId);
  if (invalid === 'device-revision') await f.h.db.run('UPDATE auth_devices SET revision=? WHERE id=?', randomUUID(), f.person.deviceId);
  const before = await snapshot(f); await f.logout(401); assert.deepEqual(await snapshot(f), before); assert.equal(await f.journal.lookup(await logoutID(f)), null);
});

for (const restriction of ['authentication-consent', 'disabled-profile', 'audience-suspension']) test('logout keeps own privacy authority after ' + restriction, async t => {
  const f = await logoutFixture(t, { registered: true });
  if (restriction === 'authentication-consent') await f.h.db.run("UPDATE consents SET status='revoked',revoked_at=? WHERE id=?", f.now(), f.beforeProfile.auth_consent_id);
  if (restriction === 'disabled-profile') await f.h.db.run("UPDATE face_profiles SET status='disabled' WHERE account_id=?", f.person.accountId);
  if (restriction === 'audience-suspension') await f.h.db.run("UPDATE account_audience SET status='suspended',version=version+1 WHERE account_id=?", f.person.accountId);
  const before = await snapshot(f); await f.logout(); await assertPlan(f, [sessionFact(f)]);
  const after = await snapshot(f); for (const table of Object.keys(before).filter(table => table !== 'sessions')) assert.deepEqual(after[table], before[table]);
});

test('logout rechecks expiration after fact collection and before any lifecycle, push or session write', async t => {
  const f = await logoutFixture(t, { registered: true }); await f.pending(); await f.seedPush();
  const before = await snapshot(f), transaction = f.db.transaction.bind(f.db), now = f.now(); let observed = false;
  f.db.transaction = (callback, intent) => transaction(restore => callback({ operation: value => restore.operation(value), restrict: async (kind, scope) => {
    await restore.restrict(kind, scope);
    if (kind === 'session-retired') { observed = true; f.setClock(f.original.expires_at + 1); }
  } }), intent);
  await f.logout(401); f.setClock(now); assert.equal(observed, true);
  assert.deepEqual(await snapshot(f), before); assert.equal(await f.journal.lookup(await logoutID(f)), null);
});

test('a completed refresh between initial authentication and the logout transaction preserves the successor and pending work', async t => {
  const f = await logoutFixture(t, { registered: true }), pending = await f.pending(), transaction = f.db.transaction.bind(f.db); let issued, injected = false;
  // This hook runs before entering the actual transaction, never from db.all
  // inside a READ ONLY transaction or while holding its advisory lock.
  f.db.transaction = async (callback, intent) => {
    if (!injected) { injected = true; issued = await f.h.json('/auth/session/refresh', { body: { refresh_token: f.person.refresh_token } }); }
    return transaction(callback, intent);
  };
  await f.logout(401); assert.equal(injected, true); assert(issued);
  assert.equal((await f.h.db.one('SELECT revoked_at FROM sessions WHERE id=?', sessionID(issued.access_token))).revoked_at, null);
  assert.equal((await f.h.db.one('SELECT state FROM face_profile_operations WHERE operation_key=?', pending.operationKey)).state, 'pending');
  assert.equal((await f.h.db.one('SELECT status FROM consents WHERE id=?', pending.consentID)).status, 'granted');
  assert.equal(await f.journal.lookup(await logoutID(f)), null);
});

test('two concurrent logout calls retire exactly one current session episode', async t => {
  const f = await logoutFixture(t), responses = await Promise.all([f.request(), f.request()]);
  assert.deepEqual(responses.map(row => row.status).sort(), [200, 401]); for (const response of responses) await response.body?.cancel();
  await assertPlan(f, [sessionFact(f)]); assert.equal(await cursor(f), 1);
});

test('incoming logout fields cannot select another session or account authority', async t => {
  const f = await logoutFixture(t), foreign = await f.h.anonymous({ adult: true }), foreignID = sessionID(foreign.access_token);
  const before = await f.h.db.one('SELECT * FROM sessions WHERE id=?', foreignID);
  await f.logout(200, { body: { session_id: foreignID, account_id: foreign.account_id, operation_key: randomUUID() } });
  await assertPlan(f, [sessionFact(f)]); assert.deepEqual(await f.h.db.one('SELECT * FROM sessions WHERE id=?', foreignID), before);
});

test('a callback error after the session SQL effect rolls every lifecycle and push change back before journal acceptance', async t => {
  const f = await logoutFixture(t, { registered: true }); await f.pending(); await f.seedPush();
  const before = await snapshot(f), run = f.db.run.bind(f.db); let consumed = false;
  f.db.run = async (sql, ...bindings) => { await run(sql, ...bindings); if (!consumed && sql.startsWith('UPDATE sessions SET revoked_at=coalesce(')) { consumed = true; throw Error('synthetic_logout_callback_failure'); } };
  await f.uncertain(); assert.equal(consumed, true); assert.deepEqual(await snapshot(f), before); assert.equal(await f.journal.lookup(await logoutID(f)), null);
});

test('an accepted logout plan with a rejected SQL commit preserves pending facts and refuses callback replay', async t => {
  const f = await logoutFixture(t, { registered: true }), pending = await f.pending(), before = await snapshot(f), id = await logoutID(f);
  const prepare = f.journal.prepare.bind(f.journal); let armed = true;
  f.journal.prepare = async value => { const saved = await prepare(value); if (armed && value.operation_id === id) { armed = false; f.faults.beforeCommit = true; } return saved; };
  await f.uncertain(); assert.equal(armed, false); assert.equal(f.faults.beforeCommit, false); assert.deepEqual(await snapshot(f), before);
  const saved = await assertPlan(f, [sessionFact(f), consentFact(f, pending.consentID)], { committed: false }); assert.equal(saved.status, 'pending');
  await assert.rejects(() => f.db.one('SELECT id FROM accounts LIMIT 1'), unavailable);
  await f.uncertain(); assert.deepEqual(await snapshot(f), before); assert.deepEqual(await f.journal.lookup(id), saved);
});

for (const mode of ['outage', 'prepare-before', 'prepare-after', 'commit-result-loss', 'ack-before', 'ack-after']) test('logout ' + mode + ' preserves the exact journal and actual SQL boundary without replaying authority', async t => {
  const f = await logoutFixture(t, { registered: true }), pending = await f.pending(), before = await snapshot(f), id = await logoutID(f);
  const facts = [sessionFact(f), consentFact(f, pending.consentID)]; let boundary;
  if (mode === 'outage') f.faults.control = true;
  else if (mode.startsWith('prepare-')) f.faults.reply = { path: '/v1/operations/prepare', stage: mode.slice(8) };
  else if (mode === 'commit-result-loss') {
    const prepare = f.journal.prepare.bind(f.journal); let armed = true;
    f.journal.prepare = async value => {
      const saved = await prepare(value);
      if (armed && value.operation_id === id) { armed = false; f.faults.commitReply = true;
        f.faults.afterCommit = async () => { delete f.faults.afterCommit; boundary = {
          journal: await f.journal.lookup(id), session: await session(f),
          consent: await f.h.db.one('SELECT * FROM consents WHERE id=?', pending.consentID) }; };
      }
      return saved;
    };
  } else f.faults.reply = { path: '/v1/operations/' + id + '/acknowledge', stage: mode.slice(4) };
  await f.uncertain(); const saved = await f.journal.lookup(id);
  if (mode === 'outage' || mode === 'prepare-before') {
    assert.deepEqual(await snapshot(f), before); assert.equal(saved, null); f.faults.control = false;
    if (mode === 'prepare-before') assert.equal(f.faults.reply, undefined);
    await f.logout(); await assertPlan(f, facts); return;
  }
  if (mode === 'prepare-after') {
    assert.equal(f.faults.reply, undefined); assert.deepEqual(await snapshot(f), before);
    await assertPlan(f, facts, { committed: false }); assert.equal(saved.status, 'pending');
    await assert.rejects(() => f.db.one('SELECT id FROM accounts LIMIT 1'), unavailable);
    await f.uncertain(); assert.deepEqual(await f.journal.lookup(id), saved); return;
  }
  assert.notEqual((await session(f)).revoked_at, null);
  assert.equal((await f.h.db.one('SELECT status FROM consents WHERE id=?', pending.consentID)).status, 'revoked');
  if (mode === 'commit-result-loss') {
    assert(boundary); assert.equal(boundary.journal.status, 'pending'); assert.notEqual(boundary.session.revoked_at, null); assert.equal(boundary.consent.status, 'revoked');
    assert.equal(f.faults.commitReply, false); assert.equal(f.faults.afterCommit, undefined);
    assert.equal(saved.status, 'committed'); assert.equal(saved.plan_hash, boundary.journal.plan_hash);
  } else { assert.equal(f.faults.reply, undefined); assert.equal(saved.status, mode === 'ack-after' ? 'committed' : 'pending'); }
  await f.logout(401); const committed = await assertPlan(f, facts); assert.equal(committed.plan_hash, saved.plan_hash);
  assert.equal(await cursor(f), facts.length);
});
