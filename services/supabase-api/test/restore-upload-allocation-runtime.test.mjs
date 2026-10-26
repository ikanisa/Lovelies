import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createApp, createHandler } from '../src/index.ts';
import { executeOperation, executeUploadReservationOperation, prepareOperation } from '../src/operations.ts';
import { restoreAllocationID, restoreOperationID } from '../src/restore-transaction.ts';
import { ApiError } from '../src/types.ts';
import { enroll, faceVerifierFixture } from './runtime-harness.mjs';
import { fixture, unavailable } from './restore-database-fixture.mjs';

const PHOTO_POLICY = 'photo-policy-fixture-v1';
const checksum = 'c'.repeat(64);
const assets = f => f.h.db.all('SELECT * FROM assets ORDER BY id');
const transfers = f => f.h.db.all('SELECT * FROM upload_transfers ORDER BY asset_id');
const snapshot = async f => ({ assets: await assets(f), transfers: await transfers(f) });
const logicalID = (f, body, account = f.person.accountId) => restoreOperationID(account, 'personal', body.operation_key);
const allocationsFor = async (f, body, account) => {
  const id = await logicalID(f, body, account);
  return { id_0: await restoreAllocationID(id, 'id_0'), id_1: await restoreAllocationID(id, 'id_1') };
};
const planFor = async (f, body, account) => f.journal.lookup(await logicalID(f, body, account));
const receiptFor = (f, body, account = f.person.accountId) => f.h.db.one(
  'SELECT action,payload_hash,payload_json,response_json FROM operations WHERE actor_id=? AND source=? AND operation_key=?',
  account, 'personal', body.operation_key);

/** The baseline uses canonical enrollment and consent routes before guarded
 * execution. After setup, any Storage call is recorded and rejected: reserving
 * metadata must not dispatch or claim a private object write. */
async function uploadFixture(t, { peer = false } = {}) {
  const f = await fixture(t), h = f.h;
  h.env.FACE_AUTH_VERIFIER = { fetch: async request => {
    const form = await request.formData();
    return Response.json(await faceVerifierFixture(JSON.parse(String(form.get('envelope'))), form));
  } };
  const person = await enroll(h), other = await h.anonymous({ adult: true });
  const second = peer ? await enroll(h) : null;
  for (const p of [person, second].filter(Boolean)) await h.json('/me/photo-preferences', { token: p.token,
    body: { processing_consent: true, policy_version: PHOTO_POLICY, operation_key: randomUUID() } });
  const storageCalls = [];
  for (const bucket of ['PHOTOS', 'QUARANTINE', 'PRIVACY_EXPORTS']) {
    h.env[bucket] = new Proxy(h.env[bucket], { get(target, property, receiver) {
      if (['put', 'get', 'head', 'delete', 'list'].includes(property)) return async () => {
        storageCalls.push({ bucket, method: property }); throw Error('unexpected_reservation_storage_call');
      };
      return Reflect.get(target, property, receiver);
    } });
  }
  t.after(() => assert.deepEqual(storageCalls, [], 'Reservation must perform no Storage action'));
  const context = createApp(f.db, h.env, h.app.now), handler = createHandler(context);
  const identities = [], insertions = [], events = [], transaction = f.db.transaction.bind(f.db), run = f.db.run.bind(f.db);
  let failAfter;
  f.db.transaction = (callback, explicit) => transaction(restore => callback(Object.freeze({
    operation: value => { identities.push(value); events.push({ kind: 'identity', value }); restore.operation(value); },
    restrict: restore.restrict,
  })), explicit);
  f.db.run = async (sql, ...bindings) => {
    const stage = sql.startsWith('INSERT INTO assets(') ? 'asset' : sql.startsWith('INSERT INTO upload_transfers(') ? 'transfer' : null;
    if (stage === 'asset') {
      const row = { id: bindings[0], version: bindings[7], object_key: bindings[4] };
      insertions.push(row); events.push({ kind: 'asset', row });
    }
    await run(sql, ...bindings);
    if (stage && failAfter === stage) { failAfter = undefined; throw Error('synthetic_reservation_callback_failure_' + stage); }
  };
  const request = (path, { body, bearer = person.token, method = body === undefined ? 'GET' : 'POST' } = {}) =>
    handler(new Request('https://api.invalid' + path, { method,
      headers: { ...(bearer ? { authorization: 'Bearer ' + bearer } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const json = async (path, options = {}, expected = 200) => {
    const response = await request(path, options), value = await response.json();
    assert.equal(response.status, expected, value?.error?.code ?? 'unexpected_response'); return value;
  };
  const body = (fields = {}) => ({ source: 'personal', content_type: 'image/png', byte_size: 3,
    upload_batch_id: randomUUID(), title: 'PRIVATE UPLOAD TITLE', captured_at: '2026-10-26T10:00:00.000Z',
    operation_key: randomUUID(), ...fields });
  const reserve = (input, expected = 201, bearer = person.token) => json('/uploads/session', { body: input, bearer }, expected);
  const uncertain = async input => { const response = await request('/uploads/session', { body: input });
    assert(response.status >= 500 && response.status <= 599, 'Ambiguous reservation must not return success'); await response.body?.cancel(); };
  return { ...f, context, person, other, peer: second, identities, insertions, events, storageCalls,
    request, json, body, reserve, uncertain, failAfterNext: stage => { failAfter = stage; } };
}
async function assertPlan(f, body, status = 'committed', account = f.person.accountId) {
  const saved = await planFor(f, body, account); assert(saved); assert.equal(saved.status, status);
  const expected = await allocationsFor(f, body, account);
  assert.deepEqual(saved.plan.allocations, expected); assert.deepEqual(saved.plan.events, []);
  assert.notEqual(expected.id_0, expected.id_1); assert.notEqual(expected.id_0, saved.plan.operation_id);
  assert.notEqual(expected.id_1, saved.plan.operation_id);
  assert.equal(saved.plan.next.cursor.sequence, saved.plan.expected.cursor.sequence);
  const receipt = await receiptFor(f, body, account);
  if (receipt) {
    assert.equal(receipt.action, 'photo.upload.reserve'); assert.equal(receipt.payload_hash, saved.plan.input_hash);
    const result = JSON.parse(receipt.response_json);
    assert.equal(result.asset_id, expected.id_0); assert.equal(result.version, expected.id_1);
  }
  const encoded = JSON.stringify(saved.plan);
  for (const value of [f.person.token, body.title, body.captured_at, body.checksum_sha256].filter(Boolean)) assert(!encoded.includes(value));
  for (const key of ['object_key', 'title', 'captured_at', 'checksum_sha256', 'access_token', 'payload_json']) assert(!encoded.includes('"' + key + '"'));
  return saved;
}
async function assertStored(f, body, result, account = f.person.accountId) {
  const expected = await allocationsFor(f, body, account), stored = (await assets(f)).find(row => row.id === expected.id_0);
  assert(stored); assert.equal(stored.owner_id, account); assert.equal(stored.version, expected.id_1);
  assert.equal(stored.object_key, 'source/' + account + '/' + expected.id_0 + '/' + expected.id_1);
  assert.equal(stored.source, 'personal'); assert.equal(stored.batch_id, body.upload_batch_id); assert.equal(stored.status, 'uploading');
  assert.equal(stored.content_type, body.content_type); assert.equal(stored.byte_size, body.byte_size); assert.equal(stored.title, body.title);
  assert.equal(result.asset_id, expected.id_0); assert.equal(result.version, expected.id_1);
  assert.equal(result.upload_url, '/uploads/' + expected.id_0); assert.equal(result.complete_url, '/uploads/' + expected.id_0 + '/complete');
  const transfer = (await transfers(f)).find(row => row.asset_id === expected.id_0);
  if (body.resumable === true) {
    assert(transfer); assert.equal(transfer.expected_sha256, checksum); assert.equal(transfer.state, 'uploading');
    assert.equal(transfer.bytes_received, 0); assert.equal(result.chunk_url, '/uploads/' + expected.id_0 + '/chunks');
    assert.equal(result.resumable, true); assert.equal(result.maximum_chunk_bytes, 262144);
  } else assert.equal(transfer, undefined);
  return expected;
}

for (const resumable of [false, true]) test((resumable ? 'resumable' : 'ordinary') + ' reservation records both immutable allocations before its first effect and keeps its original receipt', async t => {
  const f = await uploadFixture(t), body = f.body({ resumable, ...(resumable ? { checksum_sha256: checksum } : {}) });
  const result = await f.reserve(body), expected = await assertStored(f, body, result), saved = await assertPlan(f, body);
  assert.equal(f.events[0].kind, 'identity'); assert.equal(f.events[1].kind, 'asset');
  assert.equal(Object.isFrozen(f.identities[0].allocations), true); assert.deepEqual(f.identities[0].allocations, expected);
  assert.deepEqual(f.insertions, [{ id: expected.id_0, version: expected.id_1, object_key: 'source/' + f.person.accountId + '/' + expected.id_0 + '/' + expected.id_1 }]);
  assert.deepEqual(await f.reserve(body), result); assert.equal(f.identities.length, 1); assert.equal(f.insertions.length, 1);
  assert.deepEqual(await planFor(f, body), saved); assert.equal((await assets(f)).length, 1);
});

test('an unchanged legacy random-ID SQL receipt skips allocation and preserves its private prefix and unrelated test row', async t => {
  const f = await uploadFixture(t), body = f.body(), intent = await prepareOperation('photo.upload.reserve', body, 'personal');
  const legacyID = randomUUID(), legacyVersion = randomUUID(), unknownID = randomUUID(), unknownVersion = randomUUID();
  const legacy = { asset_id: legacyID, version: legacyVersion, source: 'personal', upload_batch_id: body.upload_batch_id,
    status: 'uploading', upload_url: '/uploads/' + legacyID, complete_url: '/uploads/' + legacyID + '/complete', maximum_bytes: 20 * 1024 * 1024 };
  for (const [id, version, owner] of [[legacyID, legacyVersion, f.person.accountId], [unknownID, unknownVersion, f.other.account_id]]) {
    await f.h.db.run(`INSERT INTO assets(id,owner_id,source,batch_id,status,object_key,content_type,byte_size,version,title,captured_at,created_at)
      VALUES(?,?,'personal',?,'uploading',?,'image/png',3,?,?,?,?)`, id, owner, body.upload_batch_id,
    'preserved-unknown-prefix/' + id + '/' + version, version, 'Existing fixture title', 1, 1);
  }
  await f.h.db.run('INSERT INTO operations(actor_id,source,operation_key,action,payload_hash,payload_json,response_json,created_at) VALUES(?,?,?,?,?,?,?,?)',
    f.person.accountId, intent.source, intent.key, intent.action, intent.hash, intent.payloadJson, JSON.stringify(legacy), f.h.app.now());
  const before = await snapshot(f); assert.deepEqual(await f.reserve(body), legacy);
  assert.deepEqual(await snapshot(f), before); assert.equal(f.identities.length, 0); assert.equal(f.insertions.length, 0);
  assert.equal(await planFor(f, body), null); assert.notEqual((await allocationsFor(f, body)).id_0, legacyID);
});

test('a committed original empty-allocation plan and legacy random-ID receipt are not re-prepared with new allocations', async t => {
  const f = await uploadFixture(t), body = f.body(), intent = await prepareOperation('photo.upload.reserve', body, 'personal');
  const actor = await f.context.authenticate(new Request('https://api.invalid/me', { headers: { authorization: 'Bearer ' + f.person.token } }));
  const legacyID = randomUUID(), legacyVersion = randomUUID(), legacy = { asset_id: legacyID, version: legacyVersion, source: 'personal',
    upload_batch_id: body.upload_batch_id, status: 'uploading', upload_url: '/uploads/' + legacyID,
    complete_url: '/uploads/' + legacyID + '/complete', maximum_bytes: 20 * 1024 * 1024 };
  // Controlled emulation of the former generic wrapper allocates its resource
  // inside the real SQL/journal transaction; no old binary or provider is run.
  await executeOperation(f.context, actor, intent, async () => {
    await f.db.run(`INSERT INTO assets(id,owner_id,source,batch_id,status,object_key,content_type,byte_size,version,title,captured_at,created_at)
      VALUES(?,?,'personal',?,'uploading',?,'image/png',3,?,?,?,?)`, legacyID, f.person.accountId, body.upload_batch_id,
      'source/' + f.person.accountId + '/' + legacyID + '/' + legacyVersion, legacyVersion, body.title, 1, 1);
    return legacy;
  });
  const saved = await planFor(f, body); assert.equal(saved.status, 'committed'); assert.deepEqual(saved.plan.allocations, {});
  const before = await snapshot(f), registrations = f.identities.length, inserts = f.insertions.length;
  assert.deepEqual(await f.reserve(body), legacy); assert.deepEqual(await snapshot(f), before);
  assert.equal(f.identities.length, registrations); assert.equal(f.insertions.length, inserts);
  assert.deepEqual(await planFor(f, body), saved);
});

test('an unknown row occupying a deterministic asset slot is preserved and never remapped, reused or overwritten', async t => {
  const f = await uploadFixture(t), body = f.body({ resumable: true, checksum_sha256: checksum });
  const expected = await allocationsFor(f, body), existingVersion = randomUUID();
  await f.h.db.run(`INSERT INTO assets(id,owner_id,source,status,object_key,content_type,byte_size,version,title,created_at)
    VALUES(?,?,'personal','ready',?,'image/png',3,?,'Unknown test data',1)`, expected.id_0, f.other.account_id,
    'preserved-unknown-slot/' + randomUUID(), existingVersion);
  const before = await snapshot(f); await f.uncertain(body); await f.uncertain(body);
  assert.deepEqual(await snapshot(f), before); assert.equal(await planFor(f, body), null); assert.equal(await receiptFor(f, body), null);
  assert.deepEqual(f.insertions.map(row => ({ id_0: row.id, id_1: row.version })), [expected, expected]);
});

test('changed-input reuse conflicts before allocation or a second reservation and keeps the original accepted scope', async t => {
  const f = await uploadFixture(t), body = f.body({ resumable: true, checksum_sha256: checksum });
  await f.reserve(body); const saved = await assertPlan(f, body), before = await snapshot(f);
  assert.equal((await f.reserve({ ...body, title: 'Changed title' }, 409)).error.code, 'operation_key_conflict');
  assert.deepEqual(await snapshot(f), before); assert.equal(f.identities.length, 1); assert.equal(f.insertions.length, 1);
  assert.deepEqual(await planFor(f, body), saved);
});

test('identical keys in two registered accounts allocate separate owner-bound resources; knowing another ID gives no upload authority', async t => {
  const f = await uploadFixture(t, { peer: true }), body = f.body({ resumable: true, checksum_sha256: checksum });
  const first = await f.reserve(body), second = await f.reserve(body, 201, f.peer.token);
  const a = await assertStored(f, body, first), b = await assertStored(f, body, second, f.peer.accountId);
  assert.notEqual(a.id_0, b.id_0); assert.notEqual(a.id_1, b.id_1);
  await assertPlan(f, body); await assertPlan(f, body, 'committed', f.peer.accountId);
  assert.equal((await f.json('/uploads/' + a.id_0 + '/status', { bearer: f.peer.token }, 404)).error.code, 'upload_unavailable');
});

for (const same of [true, false]) test('concurrent ' + (same ? 'same' : 'different') + ' keys preserve reservation identity and bounded allocation scope', async t => {
  const f = await uploadFixture(t), body = f.body({ resumable: true, checksum_sha256: checksum });
  const second = same ? body : { ...body, operation_key: randomUUID() };
  const [a, b] = await Promise.all([f.reserve(body), f.reserve(second)]);
  if (same) assert.deepEqual(a, b); else { assert.notEqual(a.asset_id, b.asset_id); assert.notEqual(a.version, b.version); }
  assert.equal(f.insertions.length, same ? 1 : 2); assert.equal(f.identities.length, same ? 1 : 2);
  assert.equal((await assets(f)).length, same ? 1 : 2); assert.equal((await transfers(f)).length, same ? 1 : 2);
  await assertPlan(f, body); if (!same) await assertPlan(f, second);
});

for (const stage of ['asset', 'transfer']) test('callback rollback after actual ' + stage + ' INSERT retries the original pair without an accepted plan', async t => {
  const f = await uploadFixture(t), body = f.body({ resumable: true, checksum_sha256: checksum }), before = await snapshot(f);
  const expected = await allocationsFor(f, body); f.failAfterNext(stage); await f.uncertain(body);
  assert.deepEqual(await snapshot(f), before); assert.equal(await receiptFor(f, body), null); assert.equal(await planFor(f, body), null);
  const result = await f.reserve(body); await assertStored(f, body, result); await assertPlan(f, body);
  assert.deepEqual(f.insertions.map(row => ({ id_0: row.id, id_1: row.version })), [expected, expected]);
});

for (const stage of ['before', 'after']) test('prepare reply loss ' + stage + ' preserves exactly accepted allocations and never guesses rollback clearance', async t => {
  const f = await uploadFixture(t), body = f.body({ resumable: true, checksum_sha256: checksum }), id = await logicalID(f, body);
  const before = await snapshot(f), expected = await allocationsFor(f, body), prepare = f.journal.prepare.bind(f.journal); let armed = true;
  f.journal.prepare = input => { if (armed && input.operation_id === id) { armed = false; f.faults.reply = { path: '/v1/operations/prepare', stage }; } return prepare(input); };
  await f.uncertain(body); assert.equal(armed, false); assert.equal(f.faults.reply, undefined);
  assert.deepEqual(await snapshot(f), before); assert.equal(await receiptFor(f, body), null);
  if (stage === 'before') {
    assert.equal(await planFor(f, body), null); const result = await f.reserve(body); await assertStored(f, body, result); await assertPlan(f, body);
    assert.deepEqual(f.insertions.map(row => ({ id_0: row.id, id_1: row.version })), [expected, expected]);
  } else {
    const saved = await assertPlan(f, body, 'pending');
    await assert.rejects(() => f.db.one('SELECT id FROM accounts LIMIT 1'), unavailable);
    await f.uncertain(body); await f.uncertain({ ...body, operation_key: randomUUID() });
    assert.equal(f.insertions.length, 1); assert.deepEqual(await snapshot(f), before); assert.deepEqual(await planFor(f, body), saved);
  }
});

test('accepted prepare with rejected SQL COMMIT retains the original allocation pair and fences ordinary callback replay', async t => {
  const f = await uploadFixture(t), body = f.body({ resumable: true, checksum_sha256: checksum }), id = await logicalID(f, body);
  const before = await snapshot(f), prepare = f.journal.prepare.bind(f.journal); let armed = true;
  f.journal.prepare = async input => { const result = await prepare(input);
    if (armed && input.operation_id === id) { armed = false; f.faults.beforeCommit = true; } return result; };
  await f.uncertain(body); assert.equal(armed, false); assert.equal(f.faults.beforeCommit, false);
  assert.deepEqual(await snapshot(f), before); assert.equal(await receiptFor(f, body), null);
  const saved = await assertPlan(f, body, 'pending'); await f.uncertain(body);
  assert.equal(f.insertions.length, 1); assert.deepEqual(await planFor(f, body), saved); assert.deepEqual(await snapshot(f), before);
});

for (const mode of ['commit', 'ack-before', 'ack-after']) test(mode + ' reply loss retains committed metadata/receipt and never reserves a second identity', async t => {
  const f = await uploadFixture(t), body = f.body({ resumable: true, checksum_sha256: checksum }), id = await logicalID(f, body);
  const expected = await allocationsFor(f, body), prepare = f.journal.prepare.bind(f.journal); let armed = true, boundary;
  f.journal.prepare = input => {
    if (armed && input.operation_id === id) {
      armed = false;
      if (mode === 'commit') {
        f.faults.commitReply = true;
        f.faults.afterCommit = async () => { delete f.faults.afterCommit;
          const stored = (await assets(f)).find(row => row.id === expected.id_0), receipt = await receiptFor(f, body);
          boundary = { journal: (await planFor(f, body)).status, asset: stored?.id, version: stored?.version,
            transfer: (await transfers(f)).find(row => row.asset_id === expected.id_0)?.asset_id,
            receipt: receipt ? JSON.parse(receipt.response_json).asset_id : null };
        };
      } else f.faults.reply = { path: '/v1/operations/' + id + '/acknowledge', stage: mode.slice(4) };
    }
    return prepare(input);
  };
  await f.uncertain(body); assert.equal(armed, false);
  // An actual COMMIT result loss is reconciled by the HTTP invocation's final
  // fresh admission. A failed acknowledgement instead poisons that invocation.
  const saved = await assertPlan(f, body, mode === 'ack-before' ? 'pending' : 'committed');
  if (mode === 'commit') {
    assert.deepEqual(boundary, { journal: 'pending', asset: expected.id_0, version: expected.id_1, transfer: expected.id_0, receipt: expected.id_0 });
    assert.equal(f.faults.commitReply, false);
  } else {
    const path = '/v1/operations/' + id + '/acknowledge'; assert.equal(f.faults.reply, undefined);
    assert(f.trace.some(item => item.kind === 'journal' && item.path === path));
    assert.equal(f.trace.some(item => item.kind === 'journal_ok' && item.path === path), mode === 'ack-after');
  }
  const result = await f.reserve(body); await assertStored(f, body, result);
  assert.equal((await assertPlan(f, body)).plan_hash, saved.plan_hash); assert.equal(f.insertions.length, 1); assert.equal(f.identities.length, 1);
});

for (const revoked of ['session', 'device', 'processing', 'audience']) test('current ' + revoked + ' revocation denies reservation without an accepted allocation or Storage action', async t => {
  const f = await uploadFixture(t), body = f.body({ resumable: true, checksum_sha256: checksum });
  if (revoked === 'session') await f.h.db.run('UPDATE sessions SET revoked_at=? WHERE account_id=?', f.h.app.now(), f.person.accountId);
  else if (revoked === 'device') await f.h.db.run("UPDATE auth_devices SET status='revoked' WHERE id=?", f.person.deviceId);
  else if (revoked === 'processing') await f.h.db.run("UPDATE consents SET status='revoked',revoked_at=? WHERE account_id=? AND purpose='photo_processing'", f.h.app.now(), f.person.accountId);
  else await f.h.db.run("UPDATE account_audience SET status='suspended' WHERE account_id=?", f.person.accountId);
  const before = await snapshot(f), response = await f.request('/uploads/session', { body }), result = await response.json();
  assert([401, 403].includes(response.status)); if (revoked === 'processing') assert.equal(result.error.code, 'processing_consent_required');
  assert.deepEqual(await snapshot(f), before); assert.equal(await planFor(f, body), null); assert.equal(await receiptFor(f, body), null);
  assert.equal(f.insertions.length, 0);
});

test('anonymous authentication never gains upload authority from the allocation wrapper', async t => {
  const f = await uploadFixture(t), body = f.body(), before = await snapshot(f);
  assert.equal((await f.reserve(body, 403, f.other.access_token)).error.code, 'registered_face_required');
  assert.deepEqual(await snapshot(f), before); assert.equal(await planFor(f, body, f.other.account_id), null);
  assert.equal(f.identities.length, 0); assert.equal(f.insertions.length, 0);
});

test('a cached accepted reservation still requires current session authority and cannot create replacement metadata after logout', async t => {
  const f = await uploadFixture(t), body = f.body(); await f.reserve(body);
  const saved = await assertPlan(f, body), before = await snapshot(f);
  await f.h.db.run('UPDATE sessions SET revoked_at=? WHERE account_id=?', f.h.app.now(), f.person.accountId);
  const response = await f.request('/uploads/session', { body }); assert.equal(response.status, 401); await response.body?.cancel();
  assert.deepEqual(await snapshot(f), before); assert.deepEqual(await planFor(f, body), saved);
  assert.equal(f.insertions.length, 1); assert.equal(f.identities.length, 1);
});

for (const [action, source] of [['download.sign', 'personal'], ['photo.upload.reserve', 'media']])
  test('upload allocation wrapper rejects foreign action/source ' + action + '/' + source + ' before registration or callback', async t => {
    const f = await uploadFixture(t), body = f.body(), intent = await prepareOperation(action, body, source);
    const actor = await f.context.authenticate(new Request('https://api.invalid/me', { headers: { authorization: 'Bearer ' + f.person.token } }));
    const before = await snapshot(f); let callbacks = 0;
    await assert.rejects(() => executeUploadReservationOperation(f.context, actor, intent, () => { callbacks++; return {}; }),
      error => error instanceof ApiError && error.status === 400 && error.code === 'operation_scope_invalid');
    assert.equal(callbacks, 0); assert.equal(f.identities.length, 0); assert.equal(f.insertions.length, 0);
    assert.deepEqual(await snapshot(f), before); assert.equal(await planFor(f, body), null);
  });

for (const [fields, code] of [[{ source: 'community' }, 'invalid_source'], [{ resumable: true }, 'upload_checksum_required'],
  [{ byte_size: 0 }, 'invalid_metadata'], [{ operation_key: 'short' }, 'operation_key_required']])
  test('invalid reservation ' + code + ' cannot allocate or create resource metadata', async t => {
    const f = await uploadFixture(t), body = f.body(fields), before = await snapshot(f);
    assert.equal((await f.reserve(body, 400)).error.code, code);
    assert.deepEqual(await snapshot(f), before); assert.equal(f.identities.length, 0); assert.equal(f.insertions.length, 0);
  });
