import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createApp, createHandler } from '../src/index.ts';
import { restoreOperationID } from '../src/restore-transaction.ts';
import { enroll, faceVerifierFixture, sign, encode, stable } from './runtime-harness.mjs';
import { fixture, unavailable } from './restore-database-fixture.mjs';

const AUTH_POLICY = 'face-policy-fixture-v1';
const PHOTO_POLICY = 'photo-policy-fixture-v1';
const DEVICE_PROTOCOL = 'lovelies-face-profile-device-v1';
const secret = () => 'lfl_' + encode(crypto.getRandomValues(new Uint8Array(32)));

async function faceProfileFixture(t, { matching = true } = {}) {
  const f = await fixture(t), h = f.h;
  h.env.FACE_AUTH_VERIFIER = { fetch: async request => {
    const form = await request.formData();
    return Response.json(await faceVerifierFixture(JSON.parse(String(form.get('envelope'))), form));
  } };
  // The ordinary fixture constructs a synthetic registered baseline. Guarded
  // requests below use the actual journal handler and fenced PostgreSQL client.
  const person = await enroll(h);
  if (matching) await h.json('/me/photo-preferences', { token: person.token, body: {
    receive_matches: true, photo_matching_consent: true, processing_consent: true,
    policy_version: PHOTO_POLICY, operation_key: randomUUID() } });
  const control = { key: secret(), operationKey: randomUUID() };
  const signed = async (step, fields, { nonce = true } = {}) => {
    const body = { account_id: person.accountId, device_id: person.deviceId, control_key: control.key,
      ...(nonce ? { request_nonce: randomUUID(), request_expires_at: Date.now() + 45_000 } : {}), ...fields };
    return { ...body, device_signature: await sign(person.keys.privateKey, { protocol: DEVICE_PROTOCOL, step, ...body }) };
  };
  const metadata = await h.json('/auth/face/profile/control', { token: person.token,
    body: await signed('control', { control_operation_key: control.operationKey }, { nonce: false }) }, 201);
  const before = await h.db.one('SELECT * FROM face_profiles WHERE account_id=?', person.accountId);
  const device = await h.db.one('SELECT revision FROM auth_devices WHERE id=?', person.deviceId);
  const context = createApp(f.db, h.env, h.app.now), handler = createHandler(context);
  const request = body => handler(new Request('https://api.invalid/auth/face/profile/action', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const apply = async (intent, expected = 200) => {
    const response = await request(await signed('action', intent)), value = await response.json();
    assert.equal(response.status, expected, value?.error?.code ?? 'unexpected_response'); return value;
  };
  const failedApply = async intent => {
    const response = await request(await signed('action', intent));
    assert(response.status >= 500 && response.status <= 599, 'An uncertain action must not return success');
    await response.body?.cancel();
  };
  const intent = (action, expectedVersion = metadata.version) => ({ operation_key: randomUUID(), action,
    expected_version: expectedVersion, ...(action === 'resume' ? {
      consent: { purpose: 'photo_matching', policy_version: PHOTO_POLICY, granted: true } } : {}) });
  const pending = async ({ consentID = randomUUID(), status = 'granted' } = {}) => {
    if (!await h.db.one('SELECT id FROM consents WHERE id=?', consentID))
      await h.db.run("INSERT INTO consents(id,account_id,purpose,policy_version,status,revoked_at,created_at,profile_revision) VALUES(?,?,'face_authentication',?,?,?,?,?)",
        consentID, person.accountId, AUTH_POLICY, status, status === 'revoked' ? h.app.now() : null, 1, before.revision);
    const operationKey = randomUUID();
    await h.db.run(`INSERT INTO face_profile_operations(account_id,operation_key,action,input_hash,expected_version,control_device_id,
      control_revision,state,auth_epoch,consent_id,generation,created_at,expires_at)
      VALUES(?,?,'replace',?,?,?,?, 'pending',?,?,0,1,?)`, person.accountId, operationKey, 'a'.repeat(64), metadata.version,
      person.deviceId, device.revision, before.auth_epoch, consentID, h.app.now() + 86_400_000);
    return { consentID, operationKey };
  };
  return { ...f, context, person, control, metadata, before, signed, request, apply, failedApply, intent, pending };
}

const logicalID = (f, intent) => restoreOperationID(f.person.accountId, 'face-profile.action-v1', intent.operation_key);
const planFor = async (f, intent) => f.journal.lookup(await logicalID(f, intent));
const cursor = async f => (await f.journal.control()).marker.cursor.sequence;
const profile = f => f.h.db.one('SELECT * FROM face_profiles WHERE account_id=?', f.person.accountId);
const consents = f => f.h.db.all('SELECT id,purpose,status,revoked_at,expires_at,profile_revision FROM consents WHERE account_id=? ORDER BY id', f.person.accountId);
const consentFact = (f, id, purpose) => ({ kind: 'consent-withdrawn', scope: { account_id: f.person.accountId, consent_id: id, purpose } });
const profileFact = f => ({ kind: 'profile-retired', scope: { account_id: f.person.accountId,
  profile_id: f.before.id, profile_revision: f.before.revision } });
const exactFacts = saved => saved.plan.events.map(({ kind, scope }) => ({ kind, scope }));
const ordered = facts => facts.sort((a, b) => stable(a) < stable(b) ? -1 : stable(a) > stable(b) ? 1 : 0);

async function assertPlan(f, intent, facts, { committed = true } = {}) {
  const saved = await planFor(f, intent); assert(saved);
  if (committed) assert.equal(saved.status, 'committed');
  assert.deepEqual(saved.plan.allocations, {}, 'This bounded slice does not qualify cleanup/reference allocations');
  assert.deepEqual(exactFacts(saved), ordered(facts));
  assert.equal(new Set(saved.plan.events.map(event => event.operation_id)).size, facts.length);
  const receipt = await f.h.db.one('SELECT input_hash FROM face_profile_operations WHERE account_id=? AND operation_key=?',
    f.person.accountId, intent.operation_key);
  if (receipt) assert.equal(saved.plan.input_hash, receipt.input_hash);
  const encoded = JSON.stringify(saved.plan);
  for (const value of [f.control.key, f.person.faceHandle, f.before.template_key, f.before.template_digest])
    assert(!encoded.includes(value), 'Independent facts contain no private control/reference material');
  for (const field of ['template_key', 'template_digest', 'face_handle', 'public_jwk', 'access_token', 'refresh_token', 'active'])
    assert(!encoded.includes('"' + field + '"'));
  return saved;
}

for (const action of ['pause', 'resume']) test(`signed ${action} journals only old matching consent and preserves independent purposes`, async t => {
  const f = await faceProfileFixture(t), intent = f.intent(action), before = await consents(f);
  const result = await f.apply(intent);
  await assertPlan(f, intent, [consentFact(f, f.before.consent_id, 'photo_matching')]);
  assert.equal(await cursor(f), 1);
  const after = await consents(f), current = await profile(f);
  assert.equal(after.find(row => row.id === f.before.consent_id).status, 'revoked');
  assert.deepEqual(after.filter(row => row.purpose !== 'photo_matching'), before.filter(row => row.purpose !== 'photo_matching'));
  assert.equal(current.status, 'active'); assert.equal(current.revision, f.before.revision);
  assert.equal(result.authentication_enabled, true);
  if (action === 'resume') {
    assert.notEqual(current.consent_id, f.before.consent_id);
    assert.equal(after.find(row => row.id === current.consent_id).status, 'granted');
    assert.equal(result.matching_enabled, true);
    assert(!exactFacts(await planFor(f, intent)).some(fact => fact.scope.consent_id === current.consent_id));
  } else {
    assert.equal(current.consent_id, null); assert.equal(result.matching_enabled, false);
    const resume = f.intent('resume', result.version), resumed = await f.apply(resume);
    await assertPlan(f, resume, []); assert.equal(await cursor(f), 1);
    assert.equal(resumed.matching_enabled, true);
    const renewed = await profile(f);
    assert.equal((await consents(f)).find(row => row.id === renewed.consent_id).status, 'granted');
    // A late transport retry of the original pause must return its old receipt
    // without withdrawing the matching episode created by the later resume.
    await f.apply(intent);
    assert.equal((await profile(f)).consent_id, renewed.consent_id);
    assert.equal((await consents(f)).find(row => row.id === renewed.consent_id).status, 'granted');
    assert.equal(await cursor(f), 1);
  }
});

test('pending cancellation records unused consent once and excludes the current profile authentication consent', async t => {
  const f = await faceProfileFixture(t), pending = await f.pending();
  await f.pending({ consentID: pending.consentID });
  await f.pending({ consentID: f.before.auth_consent_id });
  const alreadyRevoked = await f.pending({ status: 'revoked' }), expired = await f.pending({ status: 'expired' }), intent = f.intent('pause');
  await f.apply(intent);
  await assertPlan(f, intent, [consentFact(f, f.before.consent_id, 'photo_matching'),
    consentFact(f, pending.consentID, 'face_authentication'), consentFact(f, expired.consentID, 'face_authentication')]);
  const rows = await consents(f);
  assert.equal(rows.find(row => row.id === f.before.auth_consent_id).status, 'granted');
  assert.equal(rows.find(row => row.id === pending.consentID).status, 'revoked');
  assert.equal(rows.find(row => row.id === alreadyRevoked.consentID).status, 'revoked');
  assert.equal(rows.find(row => row.id === expired.consentID).status, 'revoked');
  assert.equal((await profile(f)).status, 'active'); assert.equal(await cursor(f), 3);
});

test('pause retirement excludes cancelled pending consent from its surviving authority calculation', async t => {
  const f = await faceProfileFixture(t), pending = await f.pending();
  await f.h.db.run("UPDATE consents SET status='revoked',revoked_at=? WHERE id=?", f.h.app.now(), f.before.auth_consent_id);
  await f.h.db.run('UPDATE face_profiles SET auth_enabled=0 WHERE account_id=?', f.person.accountId);
  const intent = f.intent('pause'); await f.apply(intent);
  await assertPlan(f, intent, [consentFact(f, f.before.consent_id, 'photo_matching'),
    consentFact(f, pending.consentID, 'face_authentication'), profileFact(f)]);
  assert.equal((await profile(f)).status, 'revoked');
  assert.equal((await f.h.db.all('SELECT cleanup_id FROM face_profile_retirements WHERE account_id=?', f.person.accountId)).length, 1);
});

test('authentication withdrawal journals exact authentication consent while matching consent and profile revision survive', async t => {
  const f = await faceProfileFixture(t), intent = f.intent('withdraw_authentication'), result = await f.apply(intent);
  await assertPlan(f, intent, [consentFact(f, f.before.auth_consent_id, 'face_authentication')]);
  const current = await profile(f), rows = await consents(f);
  assert.equal(current.id, f.before.id); assert.equal(current.revision, f.before.revision); assert.equal(current.status, 'active');
  assert.equal(current.auth_enabled, 0); assert.equal(current.consent_id, f.before.consent_id);
  assert.equal(rows.find(row => row.id === f.before.consent_id).status, 'granted');
  assert.equal(result.authentication_enabled, false); assert.equal(result.matching_enabled, true);
});

test('remove journals the exact old profile revision without reference bytes or access grants', async t => {
  const f = await faceProfileFixture(t), intent = f.intent('remove'); let reads = 0;
  f.h.env.PHOTOS.get = async () => { reads++; throw Error('A restriction fact cannot read a private reference'); };
  const grantsBefore = await f.h.db.all('SELECT * FROM media_grants');
  const result = await f.apply(intent);
  await assertPlan(f, intent, [consentFact(f, f.before.auth_consent_id, 'face_authentication'),
    consentFact(f, f.before.consent_id, 'photo_matching'), profileFact(f)]);
  assert.equal(result.profile, null); assert.equal(reads, 0);
  assert.deepEqual(await f.h.db.all('SELECT * FROM media_grants'), grantsBefore);
  assert.equal((await profile(f)).status, 'revoked');
  const retired = await f.h.db.one('SELECT profile_id,profile_revision FROM face_profile_retirements WHERE account_id=?', f.person.accountId);
  assert.deepEqual(retired, { profile_id: f.before.id, profile_revision: f.before.revision });
});

test('fresh authority and the original receipt precede registration on replay and altered-input conflict', async t => {
  const f = await faceProfileFixture(t), intent = f.intent('pause'), id = await logicalID(f, intent);
  const prepare = f.journal.prepare.bind(f.journal); let targetPreparations = 0;
  f.journal.prepare = value => { if (value.operation_id === id) targetPreparations++; return prepare(value); };
  const first = await f.apply(intent), firstPlan = await planFor(f, intent);
  const replay = await f.apply(intent);
  assert.equal(replay.version, first.version); assert.equal(replay.operation.operation_key, intent.operation_key);
  assert.equal(targetPreparations, 1); assert.equal(await cursor(f), 1);
  assert.deepEqual(await planFor(f, intent), firstPlan);
  assert.equal((await f.apply({ ...intent, action: 'remove' }, 409)).error.code, 'operation_key_conflict');
  const badAuthority = await f.request(await f.signed('action', { ...intent, control_key: secret() }));
  assert.equal(badAuthority.status, 401); await badAuthority.body?.cancel();
  const badVersion = f.intent('remove', first.version + 1);
  assert.equal((await f.apply(badVersion, 409)).error.code, 'face_profile_version_changed');
  assert.equal(await planFor(f, badVersion), null); assert.equal(targetPreparations, 1);
  assert.equal((await profile(f)).status, 'active');
  await f.h.db.run("UPDATE auth_devices SET status='revoked' WHERE id=?", f.person.deviceId);
  assert.equal((await f.apply(intent, 401)).error.code, 'face_profile_control_unavailable');
  assert.equal(targetPreparations, 1); assert.equal(await cursor(f), 1);
});

test('journal control outage denies a signed action before domain effects and a restored connection can retry', async t => {
  const f = await faceProfileFixture(t), intent = f.intent('pause'), before = await consents(f);
  f.faults.control = true; await f.failedApply(intent);
  assert.deepEqual(await consents(f), before); assert.equal(await planFor(f, intent), null);
  f.faults.control = false; await f.apply(intent);
  await assertPlan(f, intent, [consentFact(f, f.before.consent_id, 'photo_matching')]);
});

for (const stage of ['before', 'after']) test(`signed action prepare reply loss ${stage} delivery rolls back SQL without partial facts`, async t => {
  const f = await faceProfileFixture(t), intent = f.intent('pause'), id = await logicalID(f, intent), before = await consents(f);
  const prepare = f.journal.prepare.bind(f.journal); let armed = true;
  f.journal.prepare = value => {
    if (armed && value.operation_id === id) { armed = false; f.faults.reply = { path: '/v1/operations/prepare', stage }; }
    return prepare(value);
  };
  await f.failedApply(intent);
  assert.deepEqual(await consents(f), before); assert.deepEqual(await profile(f), f.before);
  assert.equal(await f.h.db.one('SELECT operation_key FROM face_profile_operations WHERE operation_key=?', intent.operation_key), null);
  if (stage === 'before') {
    assert.equal(await planFor(f, intent), null); await f.apply(intent);
    await assertPlan(f, intent, [consentFact(f, f.before.consent_id, 'photo_matching')]);
  } else {
    const saved = await assertPlan(f, intent, [consentFact(f, f.before.consent_id, 'photo_matching')], { committed: false });
    assert.equal(saved.status, 'pending');
    await assert.rejects(() => f.db.one('SELECT id FROM accounts LIMIT 1'), unavailable);
    await f.failedApply(intent); assert.deepEqual(await planFor(f, intent), saved);
  }
});

test('callback failure rolls back signed action changes before journal preparation', async t => {
  const f = await faceProfileFixture(t), intent = f.intent('pause'), before = await consents(f), run = f.db.run.bind(f.db);
  let armed = true;
  f.db.run = async (sql, ...bindings) => {
    const result = await run(sql, ...bindings);
    if (armed && sql.startsWith("UPDATE consents SET status='revoked',revoked_at=? WHERE account_id=? AND purpose='photo_matching'")) {
      armed = false; throw Error('controlled_face_action_callback_failure');
    }
    return result;
  };
  await f.failedApply(intent); assert.deepEqual(await consents(f), before); assert.deepEqual(await profile(f), f.before);
  assert.equal(await planFor(f, intent), null); await f.apply(intent);
  await assertPlan(f, intent, [consentFact(f, f.before.consent_id, 'photo_matching')]);
});

test('fresh retirement decision change rolls back rather than committing an unrecorded profile retirement', async t => {
  const f = await faceProfileFixture(t), intent = f.intent('pause'), before = await consents(f), run = f.db.run.bind(f.db);
  let armed = true;
  f.db.run = async (sql, ...bindings) => {
    const result = await run(sql, ...bindings);
    if (armed && sql.startsWith("UPDATE consents SET status='revoked',revoked_at=? WHERE account_id=? AND purpose='photo_matching'")) {
      armed = false;
      await run('UPDATE consents SET expires_at=? WHERE id=?', f.h.app.now() - 1, f.before.auth_consent_id);
    }
    return result;
  };
  assert.equal((await f.apply(intent, 409)).error.code, 'face_profile_operation_changed');
  assert.deepEqual(await consents(f), before); assert.deepEqual(await profile(f), f.before); assert.equal(await planFor(f, intent), null);
});

test('accepted independent action plan and rejected PostgreSQL commit preserve pending facts and prohibit callback replay', async t => {
  const f = await faceProfileFixture(t), intent = f.intent('remove'), id = await logicalID(f, intent), before = await consents(f);
  const prepare = f.journal.prepare.bind(f.journal); let armed = true;
  f.journal.prepare = async value => {
    const saved = await prepare(value);
    if (armed && value.operation_id === id) { armed = false; f.faults.beforeCommit = true; }
    return saved;
  };
  await f.failedApply(intent); assert.deepEqual(await consents(f), before); assert.deepEqual(await profile(f), f.before);
  const saved = await assertPlan(f, intent, [consentFact(f, f.before.auth_consent_id, 'face_authentication'),
    consentFact(f, f.before.consent_id, 'photo_matching'), profileFact(f)], { committed: false });
  assert.equal(saved.status, 'pending'); await f.failedApply(intent); assert.deepEqual(await planFor(f, intent), saved);
  assert.equal((await f.h.db.all('SELECT cleanup_id FROM face_profile_retirements WHERE account_id=?', f.person.accountId)).length, 0);
});

for (const mode of ['commit', 'ack-before', 'ack-after']) test(`signed action ${mode} result loss recovers its SQL receipt without a new withdrawal`, async t => {
  const f = await faceProfileFixture(t), intent = f.intent('pause'), id = await logicalID(f, intent);
  const run = f.db.run.bind(f.db); let matchingWithdrawals = 0;
  f.db.run = async (sql, ...bindings) => {
    if (sql === "UPDATE consents SET status='revoked',revoked_at=? WHERE account_id=? AND purpose='photo_matching' AND status='granted'")
      matchingWithdrawals++;
    return run(sql, ...bindings);
  };
  if (mode === 'commit') {
    const prepare = f.journal.prepare.bind(f.journal); let armed = true;
    f.journal.prepare = async value => {
      const saved = await prepare(value);
      if (armed && value.operation_id === id) { armed = false; f.faults.commitReply = true; }
      return saved;
    };
  } else f.faults.reply = { path: '/v1/operations/' + id + '/acknowledge', stage: mode === 'ack-before' ? 'before' : 'after' };
  await f.failedApply(intent);
  assert.equal((await consents(f)).find(row => row.id === f.before.consent_id).status, 'revoked');
  const recovered = await f.apply(intent); assert.equal(recovered.operation.state, 'applied');
  await assertPlan(f, intent, [consentFact(f, f.before.consent_id, 'photo_matching')]); assert.equal(await cursor(f), 1);
  assert.equal(matchingWithdrawals, 1, 'Receipt reconciliation must not execute another matching withdrawal');
});

for (const count of [32, 33]) test(`${count} mixed selected facts are ${count === 32 ? 'committed together' : 'rejected before any action mutation'}`, async t => {
  const f = await faceProfileFixture(t), pending = [];
  // These synthetic old pending episodes bypass neither current signed control
  // nor journal admission; old timestamps avoid the unrelated attempt-rate gate.
  for (let index = 0; index < count - 3; index++) pending.push(await f.pending());
  const intent = f.intent('remove'), before = await consents(f);
  f.trace.length = 0;
  if (count === 32) {
    await f.apply(intent);
    await assertPlan(f, intent, [consentFact(f, f.before.auth_consent_id, 'face_authentication'),
      consentFact(f, f.before.consent_id, 'photo_matching'), ...pending.map(row => consentFact(f, row.consentID, 'face_authentication')), profileFact(f)]);
    assert.equal(await cursor(f), 32); assert.equal((await profile(f)).status, 'revoked');
    assert((await consents(f)).filter(row => row.purpose === 'face_authentication').every(row => row.status === 'revoked'));
  } else {
    assert.equal((await f.apply(intent, 503)).error.code, 'face_profile_restriction_capacity');
    assert.equal(await planFor(f, intent), null); assert.equal(await cursor(f), 0);
    assert.deepEqual(await consents(f), before); assert.deepEqual(await profile(f), f.before);
    assert.equal(await f.h.db.one('SELECT operation_key FROM face_profile_operations WHERE operation_key=?', intent.operation_key), null);
    assert.equal((await f.h.db.all('SELECT cleanup_id FROM face_profile_retirements WHERE account_id=?', f.person.accountId)).length, 0);
    const writes = f.trace.filter(value => value.kind === 'sql' && /^(INSERT|UPDATE|DELETE) /.test(value.sql));
    const rateLimitWrite = value => value.sql.startsWith('DELETE FROM request_limits WHERE expires_at<') ||
      value.sql.startsWith('INSERT INTO request_limits(key,hits,expires_at) VALUES(');
    assert.equal(writes.filter(rateLimitWrite).length, 2, 'The existing pre-action rate-limit gate still runs');
    assert(!writes.some(value => !rateLimitWrite(value) && !value.sql.startsWith('UPDATE restore_control ')),
      'Capacity rejection precedes state/receipt/consent/cleanup mutations');
  }
});
