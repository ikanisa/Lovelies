import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createApp, createHandler } from '../src/index.ts';
import { executeAccountDeletionOperation, prepareOperation } from '../src/operations.ts';
import { restoreAllocationID, restoreOperationID } from '../src/restore-transaction.ts';
import { ApiError, stable } from '../src/types.ts';
import { enroll, faceVerifierFixture } from './runtime-harness.mjs';
import { fixture, controlRow, digest, installMarker, unavailable } from './restore-database-fixture.mjs';

const key = label => label + '-' + randomUUID();
const token = () => 'lvd_' + randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
const invalid = error => error instanceof ApiError && error.code === 'restore_operation_invalid';

async function deletionFixture(t, { registered = false } = {}) {
  const f = await fixture(t), h = f.h;
  h.env.FACE_AUTH_VERIFIER = { fetch: async request => {
    const form = await request.formData();
    return Response.json(await faceVerifierFixture(JSON.parse(String(form.get('envelope'))), form));
  } };
  // Baseline construction deliberately precedes guarded request handling.
  const person = registered ? await enroll(h) : await h.anonymous();
  const actor = { accountID: registered ? person.accountId : person.account_id,
    token: registered ? person.token : person.access_token };
  const other = await h.anonymous();
  const context = createApp(f.db, h.env, h.app.now), handler = createHandler(context);
  const insertIDs = [], run = f.db.run.bind(f.db);
  let failInsert = false;
  f.db.run = async (sql, ...bindings) => {
    const target = sql.startsWith('INSERT INTO privacy_requests(');
    if (target) insertIDs.push(bindings[0]);
    await run(sql, ...bindings);
    if (target && failInsert) { failInsert = false; throw Error('controlled_deletion_callback_failure'); }
  };
  const request = (path, { body, bearer = actor.token, method = body === undefined ? 'GET' : 'POST' } = {}) =>
    handler(new Request('https://api.invalid' + path, { method,
      headers: { ...(bearer ? { authorization: 'Bearer ' + bearer } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const json = async (path, options = {}, expected = 200) => {
    const response = await request(path, options), value = await response.json();
    assert.equal(response.status, expected, value?.error?.code ?? 'unexpected_response'); return value;
  };
  const create = (body, bearer = actor.token, expected = 201) => json('/privacy/account-deletion', { body, bearer }, expected);
  const failedCreate = async body => {
    const response = await request('/privacy/account-deletion', { body });
    assert(response.status >= 500 && response.status <= 599, 'An uncertain mutation must not return success');
    await response.body?.cancel();
  };
  const body = () => ({ operation_key: key('restore-deletion'), status_token: token(), reason: 'Private requested-stage fixture reason' });
  return { ...f, context, actor, other, request, json, create, failedCreate, body, insertIDs,
    failAfterNextInsert: () => { failInsert = true; } };
}
const logicalID = (f, body, account = f.actor.accountID) => restoreOperationID(account, 'privacy', body.operation_key);
const rows = f => f.h.db.all('SELECT id,subject_id,request_type,status,reason FROM privacy_requests ORDER BY id');
const facts = async f => (await f.journal.control()).marker.cursor.sequence;

async function assertRequestedPlan(f, body, expectedID, { committed = true, authorityFacts = [] } = {}) {
  const operationID = await logicalID(f, body), saved = await f.journal.lookup(operationID);
  assert(saved); if (committed) assert.equal(saved.status, 'committed');
  assert.deepEqual(saved.plan.allocations, { id_0: expectedID });
  assert.equal(saved.plan.events.length, 1 + authorityFacts.length);
  const event = saved.plan.events[0];
  assert.equal(event.kind, 'account-deletion-requested');
  assert.deepEqual(event.scope, { account_id: f.actor.accountID, deletion_request_id: expectedID });
  assert.notEqual(event.operation_id, expectedID, 'Event and allocation use distinct namespaces');
  assert.notEqual(event.operation_id, operationID);
  assert.deepEqual(saved.plan.events.slice(1).map(({ kind, scope }) => ({ kind, scope })), authorityFacts);
  const encoded = JSON.stringify(saved.plan);
  assert(!encoded.includes(body.status_token)); assert(!encoded.includes(body.reason));
  assert(!encoded.includes('status_token_hash')); assert(!encoded.includes('reason'));
  return saved;
}

test('request allocations are deterministic, distinct from logical operations and validate exact bounded slots', async () => {
  const id = await restoreOperationID(randomUUID(), 'privacy', key('allocation'));
  const first = await restoreAllocationID(id, 'id_0');
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(await restoreAllocationID(id, 'id_0'), first);
  assert.notEqual(first, id); assert.notEqual(await restoreAllocationID(id, 'id_1'), first);
  assert.notEqual(await restoreAllocationID(randomUUID(), 'id_0'), first);
  assert.match(await restoreAllocationID(id, 'id_31'), /^[0-9a-f-]{36}$/);
  for (const slot of ['id_32', 'id_00', 'id_-1', '', 'request', 0, null])
    await assert.rejects(() => restoreAllocationID(id, slot), invalid);
  await assert.rejects(() => restoreAllocationID('not-an-operation', 'id_0'), invalid);
});

for (const registered of [false, true]) test(`${registered ? 'registered' : 'guest'} deletion records one allocated request across plan, SQL, status and original receipt`, async t => {
  const f = await deletionFixture(t, { registered }), body = f.body();
  const consents = await f.h.db.all("SELECT id,purpose FROM consents WHERE account_id=? AND status='granted' AND purpose IN('face_authentication','photo_matching','photo_processing') ORDER BY id", f.actor.accountID);
  const profile = await f.h.db.one("SELECT id,revision,status FROM face_profiles WHERE account_id=?", f.actor.accountID);
  const rawFacts = consents.map(row => ({ kind: 'consent-withdrawn', scope: { account_id: f.actor.accountID, consent_id: row.id, purpose: row.purpose } }));
  if (profile?.status === 'active') rawFacts.push({ kind: 'profile-retired', scope: { account_id: f.actor.accountID, profile_id: profile.id, profile_revision: profile.revision } });
  const authorityFacts = [...new Map(rawFacts.map(fact => [stable(fact), fact])).entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, fact]) => fact);
  const expectedID = await restoreAllocationID(await logicalID(f, body), 'id_0');
  const result = await f.create(body), saved = await assertRequestedPlan(f, body, expectedID, { authorityFacts });
  assert.equal(result.privacy_request.id, expectedID); assert.equal(result.privacy_request.status, 'pending_approval');
  assert.equal(result.deletion_completed, false);
  assert.deepEqual((await rows(f)).map(row => ({ id: row.id, subject_id: row.subject_id, request_type: row.request_type, status: row.status })),
    [{ id: expectedID, subject_id: f.actor.accountID, request_type: 'delete', status: 'pending_approval' }]);
  const receipt = await f.h.db.one('SELECT request_id,token_hash,operation_key FROM privacy_deletion_status_receipts WHERE request_id=?', expectedID);
  assert.deepEqual(receipt, { request_id: expectedID, token_hash: digest(body.status_token), operation_key: body.operation_key });
  const sqlReceipt = await f.h.db.one('SELECT payload_hash,response_json FROM operations WHERE actor_id=? AND source=? AND operation_key=?', f.actor.accountID, 'privacy', body.operation_key);
  assert.equal(saved.plan.input_hash, sqlReceipt.payload_hash);
  assert.equal(JSON.parse(sqlReceipt.response_json).privacy_request.id, expectedID);
  const status = await f.json('/privacy/account-deletion/status', { body: { status_token: body.status_token }, bearer: null });
  assert.equal(status.privacy_request.id, expectedID); assert.equal(status.operation_key, body.operation_key);
  assert.deepEqual(await f.create(body), result); assert.equal(await facts(f), 1 + authorityFacts.length);
  assert.deepEqual(f.insertIDs, [expectedID]);
  assert.deepEqual(await f.journal.lookup(await logicalID(f, body)), saved);
});

test('prior SQL receipt skips allocation registration and callback, including an unchanged legacy v4 request ID', async t => {
  const f = await deletionFixture(t), operationKey = key('legacy-deletion-receipt');
  const intent = await prepareOperation('privacy.request.delete', { operation_key: operationKey, status_token_hash: digest(token()) }, 'privacy');
  const legacyID = randomUUID(), result = { privacy_request: { id: legacyID, request_type: 'delete', status: 'pending_approval' } };
  await f.h.db.run('INSERT INTO operations(actor_id,source,operation_key,action,payload_hash,payload_json,response_json,created_at) VALUES(?,?,?,?,?,?,?,?)',
    f.actor.accountID, intent.source, intent.key, intent.action, intent.hash, intent.payloadJson, JSON.stringify(result), f.h.app.now());
  let registrations = 0, callbacks = 0;
  const transaction = f.db.transaction.bind(f.db);
  f.db.transaction = (callback, explicit) => transaction(restore => callback(Object.freeze({
    operation: value => { registrations++; restore.operation(value); }, restrict: restore.restrict,
  })), explicit);
  const actor = await f.context.authenticate(new Request('https://api.invalid/me', { headers: { authorization: 'Bearer ' + f.actor.token } }));
  const replay = await executeAccountDeletionOperation(f.context, actor, intent, () => { callbacks++; assert.fail('Existing receipt cannot rerun callback'); });
  assert.deepEqual(replay, result); assert.equal(registrations, 0); assert.equal(callbacks, 0);
  assert.equal(await f.journal.lookup(await restoreOperationID(f.actor.accountID, 'privacy', operationKey)), null);
  assert.equal(await facts(f), 0);
});

test('changed payload or status secret and cross-account status-secret reuse roll back without another request fact', async t => {
  const f = await deletionFixture(t), body = f.body(), created = await f.create(body);
  for (const changed of [{ ...body, reason: 'Altered request' }, { ...body, status_token: token() }])
    assert.equal((await f.create(changed, f.actor.token, 409)).error.code, 'operation_key_conflict');
  const otherBody = { ...body, operation_key: key('other-token-reuse') };
  assert.equal((await f.create(otherBody, f.other.access_token, 409)).error.code, 'deletion_status_token_conflict');
  assert.equal((await rows(f)).length, 1); assert.equal((await rows(f))[0].id, created.privacy_request.id);
  assert.equal(await f.journal.lookup(await logicalID(f, otherBody, f.other.account_id)), null);
  assert.equal(await facts(f), 1);
});

test('callback failure after its first actual INSERT rolls back request and status rows without preparing a fact', async t => {
  const f = await deletionFixture(t), body = f.body(); f.failAfterNextInsert();
  await f.failedCreate(body);
  assert.equal((await rows(f)).length, 0);
  assert.equal((await f.h.db.all('SELECT request_id FROM privacy_deletion_status_receipts')).length, 0);
  assert.equal(await f.journal.lookup(await logicalID(f, body)), null); assert.equal(await facts(f), 0);
  const result = await f.create(body);
  const expectedID = await restoreAllocationID(await logicalID(f, body), 'id_0');
  assert.equal(result.privacy_request.id, expectedID); assert.deepEqual(f.insertIDs, [expectedID, expectedID]);
});

for (const stage of ['before', 'after']) test(`deletion prepare reply loss ${stage} service delivery preserves only the accepted allocation and fences a pending predecessor`, async t => {
  const f = await deletionFixture(t), body = f.body(), id = await logicalID(f, body);
  const expectedID = await restoreAllocationID(id, 'id_0'), prepare = f.journal.prepare.bind(f.journal); let armed = true;
  f.journal.prepare = async value => {
    if (armed && value.operation_id === id) { armed = false; f.faults.reply = { path: '/v1/operations/prepare', stage }; }
    return prepare(value);
  };
  await f.failedCreate(body); assert.equal((await rows(f)).length, 0);
  if (stage === 'before') {
    assert.equal(await f.journal.lookup(id), null); assert.equal(await facts(f), 0);
    assert.equal((await f.create(body)).privacy_request.id, expectedID);
    assert.deepEqual(f.insertIDs, [expectedID, expectedID]); await assertRequestedPlan(f, body, expectedID);
  } else {
    const saved = await assertRequestedPlan(f, body, expectedID, { committed: false }); assert.equal(saved.status, 'pending');
    await assert.rejects(() => f.db.one('SELECT id FROM accounts LIMIT 1'), unavailable);
    await f.failedCreate(body); assert.deepEqual(f.insertIDs, [expectedID]);
    assert.deepEqual(await f.journal.lookup(id), saved);
  }
});

test('accepted independent deletion plan plus rejected SQL commit retains original ID and refuses ordinary callback replay', async t => {
  const f = await deletionFixture(t), body = f.body(), id = await logicalID(f, body), prepare = f.journal.prepare.bind(f.journal); let armed = true;
  f.journal.prepare = async value => {
    const saved = await prepare(value);
    if (armed && value.operation_id === id) { armed = false; f.faults.beforeCommit = true; }
    return saved;
  };
  await f.failedCreate(body); assert.equal((await rows(f)).length, 0);
  const expectedID = await restoreAllocationID(id, 'id_0');
  const saved = await assertRequestedPlan(f, body, expectedID, { committed: false }); assert.equal(saved.status, 'pending');
  await f.failedCreate(body); assert.deepEqual(f.insertIDs, [expectedID]); assert.deepEqual(await f.journal.lookup(id), saved);
});

for (const mode of ['commit', 'ack-before', 'ack-after']) test(`deletion ${mode} result loss preserves committed request/receipt and never allocates or records it again`, async t => {
  const f = await deletionFixture(t), body = f.body(), id = await logicalID(f, body);
  if (mode === 'commit') {
    const prepare = f.journal.prepare.bind(f.journal); let armed = true;
    f.journal.prepare = async value => { const saved = await prepare(value); if (armed && value.operation_id === id) { armed = false; f.faults.commitReply = true; } return saved; };
  } else f.faults.reply = { path: '/v1/operations/' + id + '/acknowledge', stage: mode === 'ack-before' ? 'before' : 'after' };
  await f.failedCreate(body);
  const expectedID = await restoreAllocationID(id, 'id_0');
  assert.equal((await rows(f))[0].id, expectedID);
  const result = await f.create(body); assert.equal(result.privacy_request.id, expectedID);
  await assertRequestedPlan(f, body, expectedID); assert.equal(await facts(f), 1); assert.deepEqual(f.insertIDs, [expectedID]);
});

test('restoring pre-request rows and checkpoint cannot hide the independently accepted deletion request', async t => {
  const f = await deletionFixture(t), before = await controlRow(f.h), body = f.body();
  const created = await f.create(body), id = created.privacy_request.id;
  // Controlled corruption of only this fixture simulates restored SQL state;
  // it never acknowledges, clears or rewinds the independent journal.
  await f.h.db.transaction(async () => {
    await f.h.db.run('DELETE FROM operation_subjects WHERE actor_id=? AND source=? AND operation_key=?', f.actor.accountID, 'privacy', body.operation_key);
    await f.h.db.run('DELETE FROM operations WHERE actor_id=? AND source=? AND operation_key=?', f.actor.accountID, 'privacy', body.operation_key);
    await f.h.db.run('DELETE FROM privacy_deletion_status_receipts WHERE request_id=?', id);
    await f.h.db.run('DELETE FROM privacy_requests WHERE id=?', id);
  });
  await installMarker(f.h, { database_id: before.database_id, incarnation_id: before.incarnation_id,
    checkpoint: { revision: before.checkpoint_revision, hash: before.checkpoint_hash }, cursor: { sequence: before.journal_sequence, hash: before.journal_hash } },
    before.last_operation_id, before.last_plan_hash);
  await f.failedCreate(body);
  assert.equal((await f.journal.control()).state, 'quarantined'); assert.equal((await rows(f)).length, 0);
  await assertRequestedPlan(f, body, id); assert.deepEqual(f.insertIDs, [id]);
});

test('registered export keeps an empty allocation/restriction manifest and guest export remains forbidden', async t => {
  const f = await deletionFixture(t, { registered: true }), operationKey = key('unchanged-export');
  const result = await f.json('/privacy/export', { body: { operation_key: operationKey } }, 201);
  assert.equal(result.privacy_request.request_type, 'export'); assert.match(result.privacy_request.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const saved = await f.journal.lookup(await restoreOperationID(f.actor.accountID, 'privacy', operationKey));
  assert.deepEqual(saved.plan.allocations, {}); assert.deepEqual(saved.plan.events, []);
  assert.equal((await f.json('/privacy/export', { body: { operation_key: key('guest-export') }, bearer: f.other.access_token }, 403)).error.code, 'registered_face_required');
  assert.equal(await facts(f), 0);
});
