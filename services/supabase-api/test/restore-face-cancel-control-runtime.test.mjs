import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createApp, createHandler } from '../src/index.ts';
import { restoreOperationID } from '../src/restore-transaction.ts';
import { enroll, faceVerifierFixture, sign, encode, stable } from './runtime-harness.mjs';
import { fixture, digest, unavailable } from './restore-database-fixture.mjs';

const DEVICE_PROTOCOL = 'lovelies-face-profile-device-v1';
const AUTH_POLICY = 'face-policy-fixture-v1';
const PHOTO_POLICY = 'photo-policy-fixture-v1';
const controlIntent = () => ({ key: 'lfl_' + encode(crypto.getRandomValues(new Uint8Array(32))), operationKey: randomUUID() });
const fact = (account, id) => ({ kind: 'consent-withdrawn', scope: { account_id: account, consent_id: id, purpose: 'face_authentication' } });
const exactFacts = plan => plan.plan.events.map(({ kind, scope }) => ({ kind, scope }));
const intentHash = body => { const { device_signature, request_nonce, request_expires_at, ...durable } = body; return digest(stable(durable)); };

async function cancellationFixture(t, { initialControl = true } = {}) {
  const f = await fixture(t), h = f.h;
  h.env.FACE_AUTH_VERIFIER = { fetch: async request => {
    const form = await request.formData();
    return Response.json(await faceVerifierFixture(JSON.parse(String(form.get('envelope'))), form));
  } };
  const person = await enroll(h), control = controlIntent();
  await h.json('/me/photo-preferences', { token: person.token, body: { receive_matches: true,
    photo_matching_consent: true, processing_consent: true, policy_version: PHOTO_POLICY, operation_key: randomUUID() } });
  const signed = async (step, fields, selected = control, creation = false) => {
    const body = { account_id: person.accountId, device_id: person.deviceId, control_key: selected.key,
      ...(!creation ? { request_nonce: randomUUID(), request_expires_at: Date.now() + 45_000 } : {}), ...fields };
    return { ...body, device_signature: await sign(person.keys.privateKey, { protocol: DEVICE_PROTOCOL, step, ...body }) };
  };
  const controlBody = (selected = control, fields = {}) => signed('control', { control_operation_key: selected.operationKey, ...fields }, selected, true);
  if (initialControl) await h.json('/auth/face/profile/control', { token: person.token, body: await controlBody() }, 201);
  const before = await h.db.one('SELECT * FROM face_profiles WHERE account_id=?', person.accountId);
  const device = await h.db.one('SELECT revision FROM auth_devices WHERE id=?', person.deviceId);
  const context = createApp(f.db, h.env, h.app.now), handler = createHandler(context);
  const request = (path, body, token) => handler(new Request('https://api.invalid' + path, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) }));
  const json = async (path, body, token, expected) => {
    const response = await request(path, body, token), value = await response.json();
    assert.equal(response.status, expected, value?.error?.code ?? 'unexpected_response'); return value;
  };
  const cancelBody = key => signed('cancel', { operation_key: key });
  const cancel = async (key, expected = 200) => json('/auth/face/profile/cancel', await cancelBody(key), undefined, expected);
  const renewBody = async (selected = controlIntent()) => ({ selected, body: await controlBody(selected,
    { renew: true, previous_control_operation_key: control.operationKey }) });
  const renew = (intent, expected = 201) => json('/auth/face/profile/control', intent.body, person.token, expected);
  const uncertain = async (path, body, token) => {
    const response = await request(path, body, token); assert(response.status >= 500 && response.status <= 599);
    await response.body?.cancel();
  };
  const expire = () => h.db.run('UPDATE face_profile_controls SET expires_at=? WHERE account_id=? AND device_id=?', h.app.now() - 1, person.accountId, person.deviceId);
  const pending = async ({ consentID = randomUUID(), status = 'granted', purpose = 'face_authentication',
    consentOwner = person.accountId, deviceID = person.deviceId } = {}) => {
    if (!await h.db.one('SELECT id FROM consents WHERE id=?', consentID))
      await h.db.run('INSERT INTO consents(id,account_id,purpose,policy_version,status,revoked_at,created_at,profile_revision) VALUES(?,?,?,?,?,?,?,?)',
        consentID, consentOwner, purpose, purpose === 'face_authentication' ? AUTH_POLICY : PHOTO_POLICY, status,
        status === 'revoked' ? h.app.now() : null, 1, before.revision);
    const operationKey = randomUUID();
    await h.db.run(`INSERT INTO face_profile_operations(account_id,operation_key,action,input_hash,expected_version,control_device_id,
      control_revision,state,auth_epoch,consent_id,generation,created_at,expires_at)
      VALUES(?,?,'replace',?,1,?,?,'pending',?,?,0,1,?)`,
      person.accountId, operationKey, 'a'.repeat(64), deviceID, device.revision, before.auth_epoch, consentID, h.app.now() + 86400000);
    return { consentID, operationKey };
  };
  const realPending = async () => {
    const state = await h.db.one('SELECT version FROM face_profile_states WHERE account_id=?', person.accountId);
    const intent = { operation_key: randomUUID(), action: 'replace', expected_version: state.version,
      consent: { purpose: 'face_authentication', policy_version: AUTH_POLICY, granted: true } };
    await h.json('/auth/face/profile/challenge', { body: await signed('challenge', intent) }, 201);
    return h.db.one('SELECT * FROM face_profile_operations WHERE account_id=? AND operation_key=?', person.accountId, intent.operation_key);
  };
  const otherDevice = async () => {
    const id = randomUUID();
    await h.db.run(`INSERT INTO auth_devices(id,account_id,public_jwk,revision,status,face_handle,created_at)
      SELECT ?,account_id,public_jwk,revision,'active',?,created_at FROM auth_devices WHERE id=?`,
      id, 'synthetic-other-device-' + randomUUID(), person.deviceId);
    return id;
  };
  return { ...f, context, person, control, before, signed, controlBody, request, json, cancelBody, cancel,
    renewBody, renew, uncertain, expire, pending, realPending, otherDevice };
}

const profile = f => f.h.db.one('SELECT * FROM face_profiles WHERE account_id=?', f.person.accountId);
const control = f => f.h.db.one('SELECT * FROM face_profile_controls WHERE account_id=? AND device_id=?', f.person.accountId, f.person.deviceId);
const consents = f => f.h.db.all('SELECT * FROM consents ORDER BY id');
const operations = f => f.h.db.all('SELECT * FROM face_profile_operations WHERE account_id=? ORDER BY operation_key', f.person.accountId);
const cursor = async f => (await f.journal.control()).marker.cursor.sequence;
const cancelID = (f, key) => restoreOperationID(f.person.accountId, 'face-profile.cancel-v1', key);
const renewalID = (f, intent) => restoreOperationID(f.person.accountId, 'face-profile.control-renew-v1', intent.selected.operationKey);
async function assertPlan(f, id, facts, { committed = true, hash } = {}) {
  const saved = await f.journal.lookup(id); assert(saved);
  if (committed) assert.equal(saved.status, 'committed');
  assert.deepEqual(saved.plan.allocations, {});
  if (hash) assert.equal(saved.plan.input_hash, hash);
  const ordered = [...facts].sort((a, b) => a.scope.consent_id < b.scope.consent_id ? -1 : 1);
  assert.deepEqual(exactFacts(saved), ordered);
  const text = JSON.stringify(saved.plan);
  for (const value of [f.control.key, f.person.faceHandle, f.before.template_key, f.before.template_digest])
    assert(!text.includes(value), 'Restriction facts contain no private control/reference material');
  return saved;
}

test('signed cancel journals only its actual pending consent and cancels the real challenge', async t => {
  const f = await cancellationFixture(t), target = await f.realPending(), unrelated = await f.pending();
  const beforeProfile = await profile(f), oldControl = await control(f), beforeConsents = await consents(f);
  const reply = await f.cancel(target.operation_key);
  assert.equal(reply.operation.state, 'cancelled'); assert.equal(reply.operation.challenge, null);
  const saved = await assertPlan(f, await cancelID(f, target.operation_key), [fact(f.person.accountId, target.consent_id)]);
  assert.equal(await cursor(f), 1);
  assert.equal((await f.h.db.one('SELECT status FROM auth_challenges WHERE id=?', target.challenge_id)).status, 'cancelled');
  const after = await consents(f);
  assert.equal(after.find(row => row.id === target.consent_id).status, 'revoked');
  assert.deepEqual(after.filter(row => row.id !== target.consent_id), beforeConsents.filter(row => row.id !== target.consent_id));
  assert.equal((await f.h.db.one('SELECT state FROM face_profile_operations WHERE operation_key=?', unrelated.operationKey)).state, 'pending');
  assert.deepEqual(await profile(f), beforeProfile); assert.deepEqual(await control(f), oldControl);
  await f.cancel(target.operation_key); assert.deepEqual(await f.journal.lookup(await cancelID(f, target.operation_key)), saved);
});

test('cancel preserves a current-profile authentication reference and records no old-episode fact', async t => {
  const f = await cancellationFixture(t), pending = await f.pending({ consentID: f.before.auth_consent_id });
  await f.cancel(pending.operationKey);
  await assertPlan(f, await cancelID(f, pending.operationKey), []);
  assert.equal((await consents(f)).find(row => row.id === f.before.auth_consent_id).status, 'granted');
  assert.deepEqual(await profile(f), f.before); assert.equal(await cursor(f), 0);
});

test('control renewal deduplicates exact old unused consent episodes and preserves other-device/current-profile authority', async t => {
  const f = await cancellationFixture(t), pending = await f.pending(), expired = await f.pending({ status: 'expired' });
  await f.pending({ consentID: pending.consentID }); await f.pending({ consentID: f.before.auth_consent_id });
  const revoked = await f.pending({ status: 'revoked' }), peer = await f.pending({ deviceID: await f.otherDevice() });
  await f.expire(); const intent = await f.renewBody(), beforeConsents = await consents(f);
  const result = await f.renew(intent); assert.equal(result.authentication_enabled, true);
  const saved = await assertPlan(f, await renewalID(f, intent), [fact(f.person.accountId, pending.consentID), fact(f.person.accountId, expired.consentID)],
    { hash: intentHash(intent.body) });
  assert(!JSON.stringify(saved.plan).includes(intent.selected.key));
  assert.equal(await cursor(f), 2); assert.equal((await control(f)).control_operation_key, intent.selected.operationKey);
  const after = await consents(f);
  for (const id of [pending.consentID, expired.consentID, revoked.consentID]) assert.equal(after.find(row => row.id === id).status, 'revoked');
  for (const id of [f.before.auth_consent_id, f.before.consent_id, peer.consentID])
    assert.deepEqual(after.find(row => row.id === id), beforeConsents.find(row => row.id === id));
  assert.equal((await f.h.db.one('SELECT state FROM face_profile_operations WHERE operation_key=?', peer.operationKey)).state, 'pending');
  assert.deepEqual(await profile(f), f.before);
  await f.renew(intent); assert.deepEqual(await f.journal.lookup(await renewalID(f, intent)), saved);
});

test('initial control creation does not acquire an unrelated new cancellation behavior', async t => {
  const f = await cancellationFixture(t, { initialControl: false }), pending = await f.pending(), before = await consents(f);
  await f.json('/auth/face/profile/control', await f.controlBody(), f.person.token, 201);
  assert.equal((await f.h.db.one('SELECT state FROM face_profile_operations WHERE operation_key=?', pending.operationKey)).state, 'pending');
  assert.deepEqual(await consents(f), before); assert.equal(await cursor(f), 0);
  assert.equal(await f.journal.lookup(await restoreOperationID(f.person.accountId, 'face-profile.control-renew-v1', f.control.operationKey)), null);
});

test('renewal key conflicts and revoked fresh authority cannot append another cancellation plan', async t => {
  const f = await cancellationFixture(t); await f.pending(); await f.expire(); const intent = await f.renewBody();
  await f.renew(intent); const saved = await f.journal.lookup(await renewalID(f, intent)), current = await control(f);
  const altered = { ...intent, body: await f.controlBody(intent.selected, { renew: true, previous_control_operation_key: randomUUID() }) };
  assert.equal((await f.renew(altered, 409)).error.code, 'operation_key_conflict');
  assert.deepEqual(await control(f), current); assert.deepEqual(await f.journal.lookup(await renewalID(f, intent)), saved);
  await f.h.db.run('UPDATE sessions SET revoked_at=? WHERE account_id=?', f.h.app.now(), f.person.accountId);
  await f.renew(intent, 401); assert.deepEqual(await f.journal.lookup(await renewalID(f, intent)), saved);
});

test('cancel rechecks signed control/device authority before returning an old cancelled result', async t => {
  const f = await cancellationFixture(t), pending = await f.pending(); await f.cancel(pending.operationKey);
  const saved = await f.journal.lookup(await cancelID(f, pending.operationKey));
  await f.h.db.run("UPDATE auth_devices SET status='revoked' WHERE id=?", f.person.deviceId);
  await f.cancel(pending.operationKey, 401); assert.deepEqual(await f.journal.lookup(await cancelID(f, pending.operationKey)), saved);
});

for (const caller of ['cancel', 'renew', 'action']) for (const invalid of ['other-purpose', 'cross-account'])
  test(caller + ' fails closed on unused pending ' + invalid + ' references without revoking unrelated authority', async t => {
    const f = await cancellationFixture(t);
    const peer = invalid === 'cross-account' ? await f.h.anonymous({ adult: true }) : null;
    const pending = await f.pending({ purpose: invalid === 'other-purpose' ? 'photo_matching' : 'face_authentication',
      consentOwner: peer?.account_id ?? f.person.accountId });
    if (caller === 'renew') await f.expire();
    const before = { consents: await consents(f), operations: await operations(f), profile: await profile(f), control: await control(f),
      state: await f.h.db.one('SELECT * FROM face_profile_states WHERE account_id=?', f.person.accountId) };
    let id;
    if (caller === 'cancel') {
      id = await cancelID(f, pending.operationKey);
      assert.equal((await f.cancel(pending.operationKey, 409)).error.code, 'face_profile_pending_consent_invalid');
    } else if (caller === 'renew') {
      const intent = await f.renewBody(); id = await renewalID(f, intent);
      assert.equal((await f.renew(intent, 409)).error.code, 'face_profile_pending_consent_invalid');
    } else {
      const key = randomUUID(); id = await restoreOperationID(f.person.accountId, 'face-profile.action-v1', key);
      const body = await f.signed('action', { operation_key: key, action: 'pause', expected_version: before.state.version });
      assert.equal((await f.json('/auth/face/profile/action', body, undefined, 409)).error.code, 'face_profile_pending_consent_invalid');
    }
    assert.deepEqual(await consents(f), before.consents); assert.deepEqual(await operations(f), before.operations);
    assert.deepEqual(await profile(f), before.profile); assert.deepEqual(await control(f), before.control);
    assert.deepEqual(await f.h.db.one('SELECT * FROM face_profile_states WHERE account_id=?', f.person.accountId), before.state);
    assert.equal(await f.journal.lookup(id), null); assert.equal(await cursor(f), 0);
  });

for (const count of [32, 33]) test('renewal handles ' + count + ' old consent facts atomically without a prefix truncation', async t => {
  const f = await cancellationFixture(t), selected = [];
  for (let n = 0; n < count; n++) selected.push(await f.pending());
  await f.expire(); const intent = await f.renewBody(), before = { consents: await consents(f), operations: await operations(f), control: await control(f) };
  f.trace.length = 0;
  if (count === 32) {
    await f.renew(intent); await assertPlan(f, await renewalID(f, intent), selected.map(row => fact(f.person.accountId, row.consentID)));
    assert.equal(await cursor(f), 32); assert((await operations(f)).every(row => row.state === 'cancelled'));
  } else {
    assert.equal((await f.renew(intent, 503)).error.code, 'face_profile_restriction_capacity');
    assert.deepEqual(await consents(f), before.consents); assert.deepEqual(await operations(f), before.operations); assert.deepEqual(await control(f), before.control);
    assert.equal(await f.journal.lookup(await renewalID(f, intent)), null); assert.equal(await cursor(f), 0);
    const writes = f.trace.filter(value => value.kind === 'sql' && /^(INSERT|UPDATE|DELETE) /.test(value.sql));
    const rate = value => value.sql.startsWith('DELETE FROM request_limits WHERE expires_at<') || value.sql.startsWith('INSERT INTO request_limits(key,hits,expires_at) VALUES(');
    assert.equal(writes.filter(rate).length, 2);
    assert(!writes.some(value => !rate(value) && !value.sql.startsWith('UPDATE restore_control ')));
  }
});

for (const caller of ['cancel', 'renew']) for (const mode of ['outage', 'prepare-after', 'commit-result-loss', 'ack-before', 'ack-after'])
  test(caller + ' ' + mode + ' retains exact cancellation facts and its real SQL boundary', async t => {
    const f = await cancellationFixture(t), pending = await f.pending();
    if (caller === 'renew') await f.expire();
    const intent = caller === 'renew' ? await f.renewBody() : null;
    const id = caller === 'renew' ? await renewalID(f, intent) : await cancelID(f, pending.operationKey);
    const sendUncertain = () => caller === 'renew' ? f.uncertain('/auth/face/profile/control', intent.body, f.person.token) :
      f.cancelBody(pending.operationKey).then(body => f.uncertain('/auth/face/profile/cancel', body));
    const send = () => caller === 'renew' ? f.renew(intent) : f.cancel(pending.operationKey);
    const before = { consents: await consents(f), operations: await operations(f), control: await control(f) };
    let committedBeforeReplyLoss;
    if (mode === 'outage') f.faults.control = true;
    else if (mode === 'prepare-after' || mode === 'commit-result-loss') {
      const prepare = f.journal.prepare.bind(f.journal); let armed = true;
      f.journal.prepare = async value => {
        if (armed && value.operation_id === id && mode === 'prepare-after')
          f.faults.reply = { path: '/v1/operations/prepare', stage: 'after' };
        const saved = await prepare(value);
        if (armed && value.operation_id === id) {
          armed = false;
          if (mode === 'commit-result-loss') {
            // This fixture hook runs after the real PostgreSQL COMMIT and
            // before its synthetic lost reply. Final HTTP admission may then
            // reconcile this pending journal plan without rerunning the action.
            f.faults.afterCommit = async () => {
              delete f.faults.afterCommit;
              committedBeforeReplyLoss = { journal: await f.journal.lookup(id),
                operation: await f.h.db.one('SELECT state FROM face_profile_operations WHERE operation_key=?', pending.operationKey),
                consent: (await consents(f)).find(row => row.id === pending.consentID), control: await control(f) };
            };
            f.faults.commitReply = true;
          }
        }
        return saved;
      };
    } else f.faults.reply = { path: '/v1/operations/' + id + '/acknowledge', stage: mode.slice(4) };
    await sendUncertain(); const saved = await f.journal.lookup(id);
    if (mode === 'outage' || mode === 'prepare-after') {
      assert.deepEqual(await consents(f), before.consents); assert.deepEqual(await operations(f), before.operations); assert.deepEqual(await control(f), before.control);
      if (mode === 'outage') { assert.equal(saved, null); f.faults.control = false; await send(); }
      else {
        assert.equal(saved.status, 'pending'); await assert.rejects(() => f.db.one('SELECT id FROM accounts LIMIT 1'), unavailable);
        await sendUncertain(); assert.deepEqual(await f.journal.lookup(id), saved); return;
      }
    } else {
      if (mode === 'commit-result-loss') {
        assert(committedBeforeReplyLoss, 'The exact intended transaction reached its post-COMMIT observation hook');
        assert.equal(committedBeforeReplyLoss.journal.status, 'pending');
        assert.equal(committedBeforeReplyLoss.operation.state, 'cancelled');
        assert.equal(committedBeforeReplyLoss.consent.status, 'revoked');
        assert.deepEqual(exactFacts(committedBeforeReplyLoss.journal), [fact(f.person.accountId, pending.consentID)]);
        if (caller === 'renew') assert.equal(committedBeforeReplyLoss.control.control_operation_key, intent.selected.operationKey);
        else assert.deepEqual(committedBeforeReplyLoss.control, before.control);
        assert.equal(f.faults.commitReply, false, 'The synthetic lost commit reply was consumed');
        assert.equal(f.faults.afterCommit, undefined, 'The post-COMMIT observation hook was consumed');
        assert.equal(saved.status, 'committed', 'Final HTTP admission reconciles the already-committed SQL marker');
        assert.equal(saved.plan_hash, committedBeforeReplyLoss.journal.plan_hash);
      } else assert.equal(saved.status, mode === 'ack-after' ? 'committed' : 'pending');
      assert.equal((await f.h.db.one('SELECT state FROM face_profile_operations WHERE operation_key=?', pending.operationKey)).state, 'cancelled');
      assert.equal((await consents(f)).find(row => row.id === pending.consentID).status, 'revoked');
      if (mode.startsWith('ack-')) assert.equal(f.faults.reply, undefined, 'The intended acknowledgement fault was consumed');
      await send();
    }
    const committed = await assertPlan(f, id, [fact(f.person.accountId, pending.consentID)]);
    assert.equal(await cursor(f), 1); if (saved) assert.equal(committed.plan_hash, saved.plan_hash);
  });
