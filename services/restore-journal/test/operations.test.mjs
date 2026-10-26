import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import worker from '../src/worker.mjs';
import { appendEvent, readHead, readEvents, canonical, sha256, PROJECT_ID, PROTOCOL, GENESIS_HASH, HEAD_KEY, eventKey } from '../src/journal.mjs';
import {
  bootstrapControl, prepareOperation, lookupOperation, acknowledgeOperation, admitDatabase, beginRecovery,
  readControl, handleOperationRequest, MAX_OPERATION_BYTES, MAX_RESPONSE_BYTES, CONTROL_KEY, BINDING_KEY,
  planKey, prepareKey, commitKey, recoveryKey, checkpointHash,
} from '../src/operations.mjs';
import { env, event, ids, request, MemoryStorage } from './fixtures.mjs';

const input = fields => ({ version: 1, project_id: PROJECT_ID, ...fields });
const now = () => 1_000;
const json = async (storage, target, status = 200) => {
  const response = await handleOperationRequest(target, env, storage, { now });
  const body = await response.json(); assert.equal(response.status, status, JSON.stringify(body));
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  return body;
};
async function bootstrap(storage = new MemoryStorage()) {
  const binding = input({ database_id: randomUUID(), bootstrap_id: randomUUID() });
  const result = await bootstrapControl(storage, binding, now);
  return { storage, binding, marker: result.control.marker, result };
}
function mutation(marker, events = [], allocations = { id_0: randomUUID() }) {
  return input({ operation_id: randomUUID(), input_hash: 'a'.repeat(64), expected: marker, events, allocations });
}
const ack = operation => input({ plan_hash: operation.plan_hash, marker: operation.plan.next });
const admission = marker => input({ marker });

test('all operation routes authenticate before body, storage and namespace access', async () => {
  let bodies = 0, namespaces = 0;
  const storage = new MemoryStorage();
  for (const path of ['/v1/control/bootstrap', '/v1/admission', '/v1/operations/prepare', '/v1/recovery/begin', '/v1/operations/' + randomUUID() + '/acknowledge']) {
    const target = { url: 'https://journal.invalid' + path, method: 'POST', headers: new Headers(),
      get body() { bodies++; throw new Error('private body must not be accessed'); } };
    assert.deepEqual(await json(storage, target, 401), { error: 'journal_authentication_required' });
    const outer = await worker.fetch(target, { ...env, get RESTORE_JOURNAL() { namespaces++; throw new Error('namespace accessed'); } });
    assert.equal(outer.status, 401);
  }
  assert.equal(storage.calls, 0); assert.equal(bodies, 0); assert.equal(namespaces, 0);
});

test('one-time fixed database binding allocates an independent incarnation and survives exact retry/restart', async () => {
  const { storage, binding, marker, result } = await bootstrap();
  assert.notEqual(marker.incarnation_id, binding.database_id); assert.equal(marker.checkpoint.revision, 0);
  assert.deepEqual(marker.cursor, { sequence: 0, hash: GENESIS_HASH });
  assert.deepEqual(await bootstrapControl(new MemoryStorage(storage.rows), binding, () => 5_000), result);
  const { binding_hash, ...content } = result.binding;
  assert.equal(binding_hash, await sha256(canonical(content)));
  const before = structuredClone(storage.rows);
  await assert.rejects(bootstrapControl(storage, { ...binding, database_id: randomUUID() }, now), /database_already_bound/);
  await assert.rejects(bootstrapControl(storage, { ...binding, bootstrap_id: randomUUID() }, now), /database_already_bound/);
  assert.deepEqual(storage.rows, before);
  assert.equal((await admitDatabase(storage, admission(marker), now)).admitted, true);
});

test('nonzero prebinding facts are preserved in quarantine and cannot be adopted as a serving checkpoint', async () => {
  const storage = new MemoryStorage(), fact = event(), receipt = await appendEvent(storage, fact, now);
  const { marker, binding, result } = await bootstrap(storage);
  assert.equal(result.control.state, 'quarantined');
  assert.deepEqual(marker.cursor, { sequence: receipt.sequence, hash: receipt.hash });
  assert.deepEqual(await bootstrapControl(new MemoryStorage(storage.rows), binding, now), result);
  await assert.rejects(admitDatabase(storage, admission(marker), now), /serving_quarantined/);
  await assert.rejects(prepareOperation(storage, mutation(marker), now), /serving_quarantined/);
  assert.deepEqual(await appendEvent(storage, fact, now), receipt);
  await assert.rejects(appendEvent(storage, event(), now), /control_requires_operation/);
  assert.deepEqual((await readEvents(storage, 0, 100)).events, [receipt]);
  const recovered = await beginRecovery(storage, input({ recovery_id: randomUUID(), expected: marker }), now);
  assert.equal(recovered.recovery.reason, 'preexisting_restrictions');
  assert.equal(recovered.control.state, 'quarantined');
  const forged = new MemoryStorage(storage.rows), control = forged.rows.get(CONTROL_KEY);
  forged.rows.set(CONTROL_KEY, { ...control, state: 'serving', quarantine: null, recovery_generation_id: null });
  await json(forged, request('/v1/control'), 503);
});

test('atomic bounded manifest retains immutable allocated IDs, ordered event receipts and successor checkpoint', async () => {
  const { storage, marker } = await bootstrap();
  const raw = mutation(marker, [event(), event('session-retired', { account_id: ids.account, session_id: ids.session })]);
  const prepared = await prepareOperation(storage, raw, now), operation = prepared.operation;
  assert.equal(prepared.control.state, 'pending'); assert.equal(prepared.control.pending_operation_id, raw.operation_id);
  assert.equal(operation.status, 'pending'); assert.equal(operation.committed_at, null);
  assert.equal(operation.plan_hash, await sha256(canonical(operation.plan)));
  assert.deepEqual(operation.plan.allocations, raw.allocations); assert.deepEqual(operation.plan.events, raw.events);
  assert.equal(operation.plan.next.checkpoint.revision, 1);
  assert.equal(operation.plan.next.checkpoint.hash, await checkpointHash(raw, operation.plan.next.cursor));
  assert.equal(operation.plan.receipts.length, 2); assert.deepEqual(operation.plan.next.cursor, await readHead(storage));
  for (let index = 0; index < 2; index++) {
    assert.equal(operation.plan.receipts[index].sequence, index + 1);
    assert.equal(operation.plan.receipts[index].recorded_at, operation.plan.prepared_at);
  }
  raw.allocations.id_0 = randomUUID(); raw.events[0].scope.purpose = 'photo_processing';
  assert.deepEqual((await lookupOperation(storage, operation.plan.operation_id)).operation, operation);
});

test('concurrent exact prepares allocate and append once; conflicting input or allocation cannot overwrite a plan', async () => {
  const { storage, marker } = await bootstrap(), raw = mutation(marker, [event()]);
  const results = await Promise.all(Array.from({ length: 12 }, () => prepareOperation(storage, raw, now)));
  assert(results.every(result => equalOperation(result.operation, results[0].operation)));
  assert.equal((await readHead(storage)).sequence, 1);
  for (const conflict of [{ ...raw, input_hash: 'b'.repeat(64) }, { ...raw, allocations: { id_0: randomUUID() } }, { ...raw, events: [] }]) {
    await assert.rejects(prepareOperation(storage, conflict, now), /operation_conflict/);
  }
  assert.deepEqual((await lookupOperation(storage, raw.operation_id)).operation, results[0].operation);
});
const equalOperation = (a, b) => canonical(a) === canonical(b);

test('pending fences both pre-commit and post-commit reads without falsely quarantining a known successor', async () => {
  const { storage, marker } = await bootstrap(), raw = mutation(marker), prepared = await prepareOperation(storage, raw, now);
  for (const known of [marker, prepared.operation.plan.next]) {
    await assert.rejects(admitDatabase(storage, admission(known), now), /operation_pending/);
    await assert.rejects(prepareOperation(storage, mutation(known), now), /operation_pending/);
    assert.equal((await readControl(storage)).control.state, 'pending');
  }
  const unrelated = structuredClone(marker); unrelated.checkpoint.hash = 'f'.repeat(64);
  await assert.rejects(admitDatabase(storage, admission(unrelated), now), /serving_quarantined/);
  assert.equal((await readControl(storage)).control.state, 'quarantined');
});

test('no-event mutations advance independent checkpoints and exact commit acknowledgement opens only their successor', async () => {
  const { storage, marker } = await bootstrap(), head = await readHead(storage), raw = mutation(marker);
  const prepared = await prepareOperation(storage, raw, now), operation = prepared.operation;
  assert.deepEqual(operation.plan.receipts, []); assert.deepEqual(operation.plan.next.cursor, head);
  assert.notEqual(operation.plan.next.checkpoint.hash, marker.checkpoint.hash);
  const committed = await acknowledgeOperation(storage, raw.operation_id, ack(operation), () => 2_000);
  assert.equal(committed.control.state, 'serving'); assert.equal(committed.operation.status, 'committed');
  assert.equal(committed.operation.committed_at, 2_000); assert.deepEqual(committed.control.marker, operation.plan.next);
  assert.deepEqual(await readHead(storage), head);
  assert.equal((await admitDatabase(storage, admission(operation.plan.next), now)).admitted, true);
  assert.deepEqual(await acknowledgeOperation(new MemoryStorage(storage.rows), raw.operation_id, ack(operation), () => 3_000), committed);
});

test('lost prepare response and PostgreSQL rollback retain the original IDs and restrictions without permitting ordinary serving', async () => {
  const { storage, marker } = await bootstrap(), raw = mutation(marker, [event()]);
  await prepareOperation(storage, raw, now); // Drop response; PostgreSQL never commits.
  const restarted = new MemoryStorage(storage.rows), recovered = (await lookupOperation(restarted, raw.operation_id)).operation;
  assert.deepEqual(recovered.plan.allocations, raw.allocations); assert.deepEqual(recovered.plan.events, raw.events);
  assert.equal(recovered.status, 'pending');
  await assert.rejects(admitDatabase(restarted, admission(marker), now), /operation_pending/);
  assert.deepEqual((await prepareOperation(restarted, raw, now)).operation, recovered);
  assert.equal((await readHead(restarted)).sequence, 1);
  // A rolled-back DB cannot acknowledge the old marker as if it were committed.
  await assert.rejects(acknowledgeOperation(restarted, raw.operation_id, { ...ack(recovered), marker }, now), /serving_quarantined/);
  assert.equal((await readControl(restarted)).control.state, 'quarantined');
});

test('historical exact retries return immutable receipts and never rewind newer checkpoints or clear quarantine', async () => {
  const { storage, marker } = await bootstrap(), firstInput = mutation(marker), first = (await prepareOperation(storage, firstInput, now)).operation;
  const firstCommitted = await acknowledgeOperation(storage, firstInput.operation_id, ack(first), now);
  const secondInput = mutation(first.plan.next), second = (await prepareOperation(storage, secondInput, () => 2_000)).operation;
  await acknowledgeOperation(storage, secondInput.operation_id, ack(second), () => 3_000);
  const historical = await prepareOperation(storage, firstInput, now);
  assert.deepEqual(historical.operation, firstCommitted.operation); assert.deepEqual(historical.control.marker, second.plan.next);
  assert.deepEqual((await acknowledgeOperation(storage, firstInput.operation_id, ack(first), now)).control.marker, second.plan.next);
  await assert.rejects(admitDatabase(storage, admission(marker), now), /serving_quarantined/);
  assert.equal((await acknowledgeOperation(storage, firstInput.operation_id, ack(first), now)).control.state, 'quarantined');
  assert.equal((await readControl(storage)).control.state, 'quarantined');
});

test('same-schema rollback, divergent checkpoint and wrong database/incarnation all persist an independent serving fence', async () => {
  const { storage, binding, marker } = await bootstrap(), raw = mutation(marker), operation = (await prepareOperation(storage, raw, now)).operation;
  await acknowledgeOperation(storage, raw.operation_id, ack(operation), now);
  for (const observed of [marker,
    { ...operation.plan.next, database_id: randomUUID() }, { ...operation.plan.next, incarnation_id: randomUUID() },
    { ...operation.plan.next, checkpoint: { revision: 9, hash: 'e'.repeat(64) } },
    { ...operation.plan.next, cursor: { sequence: 1, hash: 'f'.repeat(64) } }]) {
    const copy = new MemoryStorage(storage.rows);
    await assert.rejects(admitDatabase(copy, admission(observed), now), /serving_quarantined/);
    assert.equal((await readControl(new MemoryStorage(copy.rows))).control.state, 'quarantined');
    assert.equal((await bootstrapControl(copy, binding, now)).control.state, 'quarantined');
    await assert.rejects(admitDatabase(copy, admission(operation.plan.next), now), /serving_quarantined/);
  }
});

test('wrong acknowledgement quarantines without advancing; a later exact acknowledgement cannot reopen pending quarantine', async () => {
  const { storage, marker } = await bootstrap(), raw = mutation(marker), operation = (await prepareOperation(storage, raw, now)).operation;
  await assert.rejects(acknowledgeOperation(storage, raw.operation_id, { ...ack(operation), plan_hash: 'e'.repeat(64) }, now), /serving_quarantined/);
  const control = (await readControl(storage)).control;
  assert.equal(control.state, 'quarantined'); assert.deepEqual(control.marker, marker);
  assert.equal(control.pending_operation_id, raw.operation_id);
  await assert.rejects(acknowledgeOperation(storage, raw.operation_id, ack(operation), now), /serving_quarantined/);
  assert.equal((await lookupOperation(storage, raw.operation_id)).operation.status, 'pending');
});

test('planned and detected recovery create one immutable generation, preserve pending facts and expose no manual clear endpoint', async () => {
  const { storage, marker } = await bootstrap(), raw = mutation(marker, [event()]), prepared = await prepareOperation(storage, raw, now);
  const recoveryInput = input({ recovery_id: randomUUID(), expected: marker });
  const result = await beginRecovery(storage, recoveryInput, now);
  assert.equal(result.control.state, 'quarantined'); assert.equal(result.control.pending_operation_id, raw.operation_id);
  assert.equal(result.control.recovery_generation_id, recoveryInput.recovery_id);
  assert.equal(result.recovery.generation, 1); assert.notEqual(result.recovery.incarnation_id, marker.incarnation_id);
  assert.equal(result.recovery.reason, 'planned_restore'); assert.deepEqual(result.recovery.journal_head, prepared.operation.plan.next.cursor);
  assert.deepEqual(await beginRecovery(new MemoryStorage(storage.rows), recoveryInput, () => 9_000), result);
  await assert.rejects(beginRecovery(storage, { ...recoveryInput, recovery_id: randomUUID() }, now), /recovery_in_progress/);
  await assert.rejects(beginRecovery(storage, { ...recoveryInput, expected: prepared.operation.plan.next }, now), /recovery_conflict/);
  await assert.rejects(admitDatabase(storage, admission(marker), now), /serving_quarantined/);
  for (const path of ['/v1/recovery/clear', '/v1/recovery/complete', '/v1/control/clear']) await json(storage, request(path, { approved: true }), 404);
  const detected = await bootstrap();
  await assert.rejects(admitDatabase(detected.storage, admission({ ...detected.marker, incarnation_id: randomUUID() }), now), /serving_quarantined/);
  const next = await beginRecovery(detected.storage, input({ recovery_id: randomUUID(), expected: detected.marker }), now);
  assert.equal(next.recovery.reason, 'marker_mismatch');
});

test('storage failures atomically roll back an entire multi-event plan and never report a committed checkpoint', async () => {
  const { storage, marker } = await bootstrap(), before = structuredClone(storage.rows), raw = mutation(marker, [event(), event()]);
  const transaction = storage.transaction.bind(storage);
  storage.transaction = callback => transaction(txn => {
    const put = txn.put; let puts = 0;
    txn.put = async value => { await put(value); if (++puts === 2) throw new Error('synthetic fault after second write'); };
    return callback(txn);
  });
  await json(storage, request('/v1/operations/prepare', raw), 503);
  assert.deepEqual(storage.rows, before);
  storage.transaction = transaction;
  const prepared = await prepareOperation(storage, raw, now);
  const pendingRows = structuredClone(storage.rows); storage.failPut = true;
  await json(storage, request('/v1/operations/' + raw.operation_id + '/acknowledge', ack(prepared.operation)), 503);
  assert.deepEqual(storage.rows, pendingRows); storage.failPut = false;
  assert.equal((await lookupOperation(storage, raw.operation_id)).operation.status, 'pending');
  assert.equal((await acknowledgeOperation(storage, raw.operation_id, ack(prepared.operation), now)).operation.status, 'committed');
});

test('manifest referencing an existing event fails atomically and cannot adopt another operation restriction', async () => {
  const { storage, marker } = await bootstrap(), old = event(), first = mutation(marker, [old]);
  const prepared = await prepareOperation(storage, first, now);
  await acknowledgeOperation(storage, first.operation_id, ack(prepared.operation), now);
  const before = structuredClone(storage.rows);
  await assert.rejects(prepareOperation(storage, mutation(prepared.operation.plan.next, [event(), old]), now), /event_already_recorded/);
  assert.deepEqual(storage.rows, before);
});

test('strict plans reject personal text, arbitrary allocation labels, duplicate IDs and oversized manifests before storage', async () => {
  const { marker } = await bootstrap(), storage = new MemoryStorage(), raw = mutation(marker, [event()]);
  const invalid = [
    { ...raw, email: 'private@example.invalid' }, { ...raw, project_id: 'other-project' }, { ...raw, version: 2 },
    { ...raw, operation_id: 'private text' }, { ...raw, input_hash: 'private input' },
    { ...raw, allocations: { person_name: randomUUID() } }, { ...raw, allocations: { id_32: randomUUID() } },
    { ...raw, allocations: { id_01: randomUUID() } }, { ...raw, allocations: { id_0: 'not-a-uuid' } },
    { ...raw, allocations: { id_0: ids.account, id_1: ids.account } }, { ...raw, events: Array.from({ length: 33 }, () => event()) },
    { ...raw, events: [raw.events[0], raw.events[0]] }, { ...raw, expected: { ...marker, allowed: true } },
    { ...raw, expected: { ...marker, checkpoint: { revision: -1, hash: 'a'.repeat(64) } } },
    { ...raw, expected: { ...marker, cursor: { sequence: 0, hash: 'a'.repeat(64) } } },
    { ...raw, events: [{ ...event(), reason: 'private content' }] },
  ];
  for (const value of invalid) await json(storage, request('/v1/operations/prepare', value), 400);
  assert.equal(storage.calls, 0);
});

test('operation transport/body/query bounds and fixed routes fail before storage or body effects', async () => {
  const storage = new MemoryStorage();
  for (const path of ['/v1/control?limit=1', '/v1/admission?x=1', '/v1/operations/prepare?x=1', '/v1/operations/' + randomUUID() + '?x=1']) {
    await json(storage, request(path, path.includes('admission') || path.includes('prepare') ? {} : undefined), 400);
  }
  await json(storage, request('/v1/operations/prepare'), 405);
  await json(storage, request('/v1/operations/not-a-uuid'), 404);
  await json(storage, request('/v1/operations/prepare', ' '.repeat(MAX_OPERATION_BYTES + 1)), 413);
  await json(storage, request('/v1/admission', {}, { 'content-length': String(MAX_OPERATION_BYTES + 1) }), 413);
  await json(storage, request('/v1/admission', {}, { 'content-type': 'text/plain' }), 415);
  await json(storage, request('/v1/admission', {}, { 'content-encoding': 'gzip' }), 415);
  await json(storage, request('/v1/admission', '{'), 400);
  await json(storage, request('/v1/admission', {}, { 'content-length': '1' }), 400);
  assert.equal(storage.calls, 0);
});

test('bounded maximum manifest is retrievable and HTTP response remains under its independent response cap', async () => {
  const { storage, marker } = await bootstrap(), raw = mutation(marker,
    Array.from({ length: 32 }, () => event()), Object.fromEntries(Array.from({ length: 32 }, (_, i) => ['id_' + i, randomUUID()])));
  const prepared = await json(storage, request('/v1/operations/prepare', raw));
  assert(encoderLength(prepared) < MAX_RESPONSE_BYTES);
  const fetched = await json(storage, request('/v1/operations/' + raw.operation_id));
  assert.deepEqual(prepared, fetched); assert.equal(fetched.operation.plan.receipts.length, 32);
});
const encoderLength = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;

test('missing control never bootstraps automatically, and unknown operation lookup never manufactures an allocation', async () => {
  const empty = new MemoryStorage();
  await json(empty, request('/v1/control'), 409);
  assert.equal(empty.rows.size, 0);
  const { storage } = await bootstrap(), before = structuredClone(storage.rows);
  await json(storage, request('/v1/operations/' + randomUUID()), 404);
  assert.deepEqual(storage.rows, before);
});

test('binding/control/plan/index/commit corruption and missing genesis fail closed without auto-reinitialization', async () => {
  const { storage, marker } = await bootstrap(), raw = mutation(marker, [event()]), prepared = await prepareOperation(storage, raw, now);
  const variants = [
    rows => rows.delete(HEAD_KEY), rows => rows.delete(BINDING_KEY), rows => rows.delete(CONTROL_KEY),
    rows => { rows.get(BINDING_KEY).initial_marker.incarnation_id = randomUUID(); },
    rows => { rows.get(CONTROL_KEY).marker.checkpoint.hash = 'e'.repeat(64); },
    rows => rows.delete(planKey(raw.operation_id)), rows => { rows.get(planKey(raw.operation_id)).plan.allocations.id_0 = randomUUID(); },
    rows => rows.delete(prepareKey(1)), rows => rows.set(prepareKey(2), rows.get(prepareKey(1))),
    rows => rows.delete(commitKey(0)), rows => { rows.get(eventKey(1)).hash = 'e'.repeat(64); },
  ];
  for (const modify of variants) {
    const copy = new MemoryStorage(storage.rows); modify(copy.rows);
    assert.deepEqual(await json(copy, request('/v1/control'), 503), { error: 'journal_integrity_failed' });
  }
  await acknowledgeOperation(storage, raw.operation_id, ack(prepared.operation), now);
  const olderControl = new MemoryStorage(storage.rows); olderControl.rows.set(CONTROL_KEY,
    { ...olderControl.rows.get(CONTROL_KEY), state: 'serving', marker, pending_operation_id: null });
  await json(olderControl, request('/v1/control'), 503);
  const missingAck = new MemoryStorage(storage.rows); missingAck.rows.delete(commitKey(1));
  await json(missingAck, request('/v1/operations/' + raw.operation_id), 503);
});

test('recovery generation corruption is denied and no environment flag can override its fence', async () => {
  const { storage, marker } = await bootstrap(), recoveryInput = input({ recovery_id: randomUUID(), expected: marker });
  await beginRecovery(storage, recoveryInput, now);
  for (const modify of [rows => rows.delete(recoveryKey(recoveryInput.recovery_id)),
    rows => { rows.get(recoveryKey(recoveryInput.recovery_id)).incarnation_id = randomUUID(); },
    rows => { rows.get(CONTROL_KEY).state = 'serving'; }]) {
    const copy = new MemoryStorage(storage.rows); modify(copy.rows);
    await json(copy, request('/v1/control'), 503);
  }
  const response = await handleOperationRequest(request('/v1/admission', admission(marker)),
    { ...env, RESTORE_CLEARED: true, RECOVERY_APPROVED: true }, storage);
  assert.equal(response.status, 409); assert.deepEqual(await response.json(), { error: 'serving_quarantined' });
});

test('invalid clocks do not mutate state; backward clocks preserve preparation/acknowledgement monotonicity', async () => {
  const { storage, marker } = await bootstrap(), raw = mutation(marker, [event()]), before = structuredClone(storage.rows);
  for (const bad of [0, -1, NaN, Infinity, 1.5]) await assert.rejects(prepareOperation(storage, raw, () => bad), /journal_clock_invalid/);
  assert.deepEqual(storage.rows, before);
  const prepared = await prepareOperation(storage, raw, () => 900);
  assert.equal(prepared.operation.plan.prepared_at, 1_000);
  const committed = await acknowledgeOperation(storage, raw.operation_id, ack(prepared.operation), () => 800);
  assert.equal(committed.operation.committed_at, 1_000);
  assert.equal(PROTOCOL, 'lovelies-restriction-journal-v1');
});
