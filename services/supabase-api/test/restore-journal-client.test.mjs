import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  RESTORE_PROJECT_ID as project, RESTORE_JOURNAL_PROTOCOL as protocol, RESTORE_RESPONSE_BYTES,
  RestoreJournalClient, validateRestoreMarker, validateRestoreOperationInput, validateRestoreOperationRecord,
} from '../src/restore-journal.ts';
import { ApiError } from '../src/types.ts';
import { handleOperationRequest } from '../../restore-journal/src/operations.mjs';
import { MemoryStorage, env as journalEnv } from '../../restore-journal/test/fixtures.mjs';

const token = 'synthetic-independent-restoration-secret-32';
const zero = '0'.repeat(64);
const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' :
  '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
const clone = value => structuredClone(value);
const marker = () => ({ database_id: randomUUID(), incarnation_id: randomUUID(), checkpoint: { revision: 0, hash: hash('bootstrap') }, cursor: { sequence: 0, hash: zero } });
const event = () => ({ version: 1, project_id: project, operation_id: randomUUID(), kind: 'consent-withdrawn',
  scope: { account_id: randomUUID(), consent_id: randomUUID(), purpose: 'photo_matching' } });
function fixture(events = [event()]) {
  const input = { version: 1, project_id: project, operation_id: randomUUID(), input_hash: hash('intent'), expected: marker(), allocations: { id_0: randomUUID() }, events };
  let sequence = input.expected.cursor.sequence, previous = input.expected.cursor.hash;
  const receipts = events.map(event => {
    const receipt = { sequence: ++sequence, previous_hash: previous, payload_hash: hash(event), recorded_at: 100, event };
    receipt.hash = hash({ protocol, project_id: project, sequence, previous_hash: previous, payload_hash: receipt.payload_hash, recorded_at: receipt.recorded_at });
    previous = receipt.hash; return receipt;
  });
  const cursor = { sequence, hash: previous }, next = { ...clone(input.expected), checkpoint: { revision: 1,
    hash: hash({ protocol, kind: 'database-checkpoint-v1', project_id: project, operation_id: input.operation_id, input_hash: input.input_hash,
      expected: input.expected, allocations: input.allocations, events: input.events, cursor }) }, cursor };
  const plan = { ...input, next, prepared_at: 100, receipts };
  const operation = { plan, plan_hash: hash(plan), status: 'pending', committed_at: null };
  const control = { state: 'pending', marker: clone(input.expected), pending_operation_id: input.operation_id, recovery_generation_id: null };
  return { input, operation, control };
}
const envelope = (control, operation) => ({ protocol, project_id: project, control, ...(operation ? { operation } : {}) });
const serving = marker => ({ state: 'serving', marker, pending_operation_id: null, recovery_generation_id: null });
const failure = error => error instanceof ApiError && error.status === 503 && error.code === 'restore_journal_unavailable' && error.message === error.code;
const client = fetcher => new RestoreJournalClient('https://journal.invalid/', token, { fetcher });

test('strict immutable marker and operation inputs reject foreign and personal/unbounded fields before HTTP', async () => {
  const f = fixture(), parsed = validateRestoreOperationInput(f.input);
  f.input.allocations.id_0 = randomUUID(); f.input.events[0].scope.purpose = 'photo_processing';
  assert.notEqual(parsed.allocations.id_0, f.input.allocations.id_0);
  assert.equal(parsed.events[0].scope.purpose, 'photo_matching');
  assert(Object.isFrozen(parsed) && Object.isFrozen(parsed.expected.checkpoint) && Object.isFrozen(parsed.events[0].scope));
  for (const bad of [
    { ...fixture().input, project_id: 'foreign-project' },
    { ...fixture().input, allocations: { account_email: 'somebody@example.invalid' } },
    { ...fixture().input, allocations: { id_32: randomUUID() } },
    { ...fixture().input, events: Array.from({ length: 33 }, event) },
    { ...fixture().input, events: [{ ...event(), scope: { ...event().scope, reason: 'personal free text' } }] },
    { ...fixture().input, events: [{ ...event(), kind: 'account-deletion-reviewed', scope: { account_id: 'not-a-uuid', deletion_request_id: randomUUID(), reviewer_id: randomUUID(), decision: 'approved' } }] },
  ]) assert.throws(() => validateRestoreOperationInput(bad), failure);
  const repeated = event(); assert.throws(() => validateRestoreOperationInput({ ...fixture().input, events: [repeated, repeated] }), failure);
  for (const bad of [{ ...marker(), cursor: { sequence: 0, hash: hash('not-genesis') } },
    { ...marker(), checkpoint: { revision: Number.MAX_SAFE_INTEGER + 1, hash: zero } }, { ...marker(), database_id: '../escape' },
    { ...marker(), extra: true }]) assert.throws(() => validateRestoreMarker(bad), failure);
  let calls = 0;
  await assert.rejects(() => client(async () => { calls++; throw Error('not reached'); }).prepare({ ...fixture().input, input_hash: 'bad' }), failure);
  assert.equal(calls, 0);
});

test('client pins HTTPS root, credentials and bounds and never accepts a configurable cross-host path', () => {
  for (const url of ['http://journal.invalid', 'http://127.0.0.1:9999', 'https://user:pass@journal.invalid', 'https://journal.invalid/?token=secret',
    'https://journal.invalid/#fragment', 'https://journal.invalid/arbitrary-prefix']) assert.throws(() => new RestoreJournalClient(url, token), failure);
  for (const secret of ['', 'too-short', 'x'.repeat(257), 'x'.repeat(32) + '\n']) assert.throws(() => new RestoreJournalClient('https://journal.invalid', secret), failure);
  for (const timeoutMs of [0, 55_001, 1.5, Infinity]) assert.throws(() => new RestoreJournalClient('https://journal.invalid', token, { timeoutMs }), failure);
  const c = new RestoreJournalClient('https://journal.invalid', token);
  assert.equal(Object.values(c).some(value => value === token), false);
  assert.equal(JSON.stringify(c).includes(token), false);
});

test('actual HTTP Request/Response paths preserve original allocation and plan across prepare, lookup and commit', async () => {
  const f = fixture(), calls = []; let committed = false;
  const c = client(async (url, init) => {
    const request = new Request(url, init); calls.push({ path: new URL(request.url).pathname, method: request.method, auth: request.headers.get('Authorization'), redirect: request.redirect });
    const path = new URL(request.url).pathname;
    if (path === '/v1/control') return Response.json(envelope(serving(f.input.expected)));
    if (path === '/v1/admission') { assert.deepEqual(await request.json(), { version: 1, project_id: project, marker: f.input.expected }); return Response.json({ ...envelope(serving(f.input.expected)), admitted: true }); }
    if (path === '/v1/operations/prepare') { assert.deepEqual(await request.json(), f.input); return Response.json(envelope(f.control, f.operation)); }
    if (path.endsWith('/acknowledge')) {
      assert.deepEqual(await request.json(), { version: 1, project_id: project, plan_hash: f.operation.plan_hash, marker: f.operation.plan.next });
      committed = true; return Response.json(envelope(serving(f.operation.plan.next), { ...f.operation, status: 'committed', committed_at: 101 }));
    }
    assert.equal(path, '/v1/operations/' + f.input.operation_id);
    return Response.json(envelope(committed ? serving(f.operation.plan.next) : f.control, committed ? { ...f.operation, status: 'committed', committed_at: 101 } : f.operation));
  });
  assert.equal((await c.control()).state, 'serving');
  assert.deepEqual((await c.admission(f.input.expected)).marker, f.input.expected);
  const prepared = await c.prepare(f.input), recovered = await c.lookup(f.input.operation_id);
  assert.deepEqual(prepared, recovered); assert.equal(prepared.plan.allocations.id_0, f.input.allocations.id_0);
  assert(Object.isFrozen(prepared.plan) && Object.isFrozen(prepared.plan.receipts[0].event.scope));
  assert.equal((await c.acknowledge(f.input.operation_id, prepared.plan_hash, prepared.plan.next)).status, 'committed');
  assert.equal((await c.lookup(f.input.operation_id)).status, 'committed');
  assert.equal(calls.length, 6); assert(calls.every(call => call.auth === 'Bearer ' + token && call.redirect === 'manual'));
  assert.deepEqual(calls.map(call => call.method), ['GET', 'POST', 'POST', 'GET', 'POST', 'GET']);
});

test('empty restriction manifest still requires the exact independent successor checkpoint hash', async () => {
  const f = fixture([]), parsed = await validateRestoreOperationRecord(f.operation);
  assert.equal(parsed.plan.next.checkpoint.revision, 1); assert.deepEqual(parsed.plan.next.cursor, f.input.expected.cursor);
  const invalid = clone(f.operation); invalid.plan.next.checkpoint.hash = zero; invalid.plan_hash = hash(invalid.plan);
  await assert.rejects(() => validateRestoreOperationRecord(invalid), failure);
});

test('nested corruption fails even when the outer operation hash is recomputed', async () => {
  const f = fixture([event(), event()]);
  const mutations = [
    value => { value.plan.receipts[0].payload_hash = zero; },
    value => { value.plan.receipts[0].hash = zero; },
    value => { value.plan.receipts[1].previous_hash = zero; },
    value => { value.plan.receipts[1].sequence++; },
    value => { value.plan.receipts.pop(); },
    value => { value.plan.receipts.reverse(); },
    value => { value.plan.next.incarnation_id = randomUUID(); },
    value => { value.plan.next.cursor.sequence++; },
    value => { value.plan.next.checkpoint.revision++; },
    value => { value.plan.events[0].scope.purpose = 'photo_processing'; },
    value => { value.plan.extra = true; },
    value => { value.plan.prepared_at = 99; },
    value => { value.status = 'committed'; value.committed_at = 99; },
    value => { value.committed_at = 101; },
  ];
  for (const mutate of mutations) {
    const value = clone(f.operation); mutate(value); value.plan_hash = hash(value.plan);
    await assert.rejects(() => validateRestoreOperationRecord(value), failure);
  }
  const invalid = clone(f.operation); invalid.plan_hash = zero; await assert.rejects(() => validateRestoreOperationRecord(invalid), failure);
});

test('control/admission reject cross-project, unknown fields, mismatch, pending and quarantine replies', async () => {
  const expected = marker(), valid = { ...envelope(serving(expected)), admitted: true };
  const values = [
    { ...valid, project_id: 'other' }, { ...valid, protocol: 'other' }, { ...valid, admitted: false }, { ...valid, extra: 'arbitrary' },
    { ...valid, control: serving(marker()) }, { ...valid, control: { ...serving(expected), pending_operation_id: randomUUID() } },
    { ...valid, control: { state: 'pending', marker: expected, pending_operation_id: randomUUID(), recovery_generation_id: null } },
    { ...valid, control: { state: 'quarantined', marker: expected, pending_operation_id: null, recovery_generation_id: randomUUID() } },
  ];
  for (const value of values) await assert.rejects(() => client(async () => Response.json(value)).admission(expected), failure);
  const c = client(async () => Response.json({ ...envelope(serving(expected)), approved: true }));
  await assert.rejects(() => c.control(), failure);
});

test('prepare rejects a different original plan and cannot authorize through historical or quarantined control', async () => {
  const f = fixture();
  for (const value of [
    envelope({ ...f.control, pending_operation_id: randomUUID() }, f.operation),
    envelope({ ...f.control, marker: marker() }, f.operation),
    envelope({ ...f.control, state: 'quarantined' }, f.operation),
    envelope(serving(f.operation.plan.next), f.operation),
  ]) await assert.rejects(() => client(async () => Response.json(value)).prepare(f.input), failure);
  const alternate = fixture();
  await assert.rejects(() => client(async () => Response.json(envelope(alternate.control, alternate.operation))).prepare(f.input), failure);
  const committed = { ...f.operation, status: 'committed', committed_at: 110 };
  assert.equal((await client(async () => Response.json(envelope(serving(f.operation.plan.next), committed))).prepare(f.input)).status, 'committed');
  for(const control of [serving(marker()),f.control,{...f.control,pending_operation_id:randomUUID()}]){
    await assert.rejects(()=>client(async()=>Response.json(envelope(control,committed))).prepare(f.input),failure);
  }
});

test('lookup returns null only for the exact confirmed missing operation response', async () => {
  const id = randomUUID();
  assert.equal(await client(async () => Response.json({ error: 'operation_not_found' }, { status: 404 })).lookup(id), null);
  for (const [status, body] of [[401, { error: 'operation_not_found' }], [404, { error: 'different' }], [404, { error: 'operation_not_found', secret: 'hidden' }], [503, { error: 'operation_not_found' }]]) {
    await assert.rejects(() => client(async () => Response.json(body, { status })).lookup(id), failure);
  }
  const f = fixture(); await assert.rejects(() => client(async () => Response.json(envelope(f.control, f.operation))).lookup(id), failure);
});

test('commit acknowledgement cannot reopen quarantine or acknowledge a different current checkpoint', async () => {
  const f = fixture(), committed = { ...f.operation, status: 'committed', committed_at: 101 };
  for (const [control, operation] of [
    [{ ...serving(f.operation.plan.next), state: 'quarantined', recovery_generation_id: randomUUID() }, committed],
    [serving(marker()), committed], [f.control, f.operation],
    [serving(f.operation.plan.next), { ...committed, plan_hash: zero }],
  ]) await assert.rejects(() => client(async () => Response.json(envelope(control, operation))).acknowledge(f.input.operation_id, f.operation.plan_hash, f.operation.plan.next), failure);
});

test('transport failures are sanitized and never automatically resend accepted writes', async () => {
  const f = fixture(); let calls = 0;
  const c = client(async () => { calls++; throw new Error('private provider diagnostic ' + token); });
  await assert.rejects(() => c.prepare(f.input), failure); assert.equal(calls, 1);
  for (const response of [
    () => new Response(null, { status: 302, headers: { location: 'https://foreign.invalid' } }),
    () => new Response('denied ' + token, { status: 403 }),
    () => Response.json({ error: token }, { status: 503 }),
    () => new Response(new Uint8Array([255]), { headers: { 'content-type': 'application/json' } }),
    () => new Response('{', { headers: { 'content-type': 'application/json' } }),
    () => new Response('{}', { headers: { 'content-type': 'text/plain' } }),
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }),
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '3' } }),
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '-1' } }),
  ]) await assert.rejects(() => client(async () => response()).control(), failure);
});

test('claimed and streaming oversized responses are bounded and cancelled', async () => {
  let cancelled = 0;
  const make = headers => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(RESTORE_RESPONSE_BYTES + 1)); }, cancel() { cancelled++; } }),
    { headers: { 'content-type': 'application/json', ...headers } });
  await assert.rejects(() => client(async () => make({ 'content-length': String(RESTORE_RESPONSE_BYTES + 1) })).control(), failure);
  await assert.rejects(() => client(async () => make({})).control(), failure);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelled, 2);
});

test('one deadline covers response-body consumption, cancellation and a fetcher ignoring AbortSignal', async () => {
  let bodyCancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { bodyCancelled = true; } });
  const stalled = new RestoreJournalClient('https://journal.invalid', token, { timeoutMs: 20, fetcher: async () => new Response(body, { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(() => stalled.control(), failure);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(bodyCancelled, true);
  let lateCancelled = false;
  const late = new RestoreJournalClient('https://journal.invalid', token, { timeoutMs: 10, fetcher: async () => {
    await new Promise(resolve => setTimeout(resolve, 40));
    return new Response(new ReadableStream({ cancel() { lateCancelled = true; } }), { headers: { 'content-type': 'application/json' } });
  } });
  await assert.rejects(() => late.control(), failure);
  await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(lateCancelled, true);
});

test('pre-cancelled and mid-consumption calls do not return authority', async () => {
  const pre = new AbortController(); pre.abort(); let called = false;
  await assert.rejects(() => client(async () => { called = true; return Response.json(envelope(serving(marker()))); }).control(pre.signal), failure);
  assert.equal(called, false);
  const controller = new AbortController(); let cancelled = false;
  const c = client(async () => new Response(new ReadableStream({ start(output) { output.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; } }),
    { headers: { 'content-type': 'application/json' } }));
  const pending = c.control(controller.signal); controller.abort(); await assert.rejects(() => pending, failure);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelled, true);
});

test('client interoperates with actual journal HTTP handler through lost prepare/commit replies and independent quarantine', async () => {
  const storage = new MemoryStorage(); let now = 1000;
  const raw = (pathname, body) => handleOperationRequest(new Request('https://journal.invalid' + pathname, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + journalEnv.RESTORE_JOURNAL_TOKEN,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), journalEnv, storage, { now: () => ++now });
  const initial = await (await raw('/v1/control/bootstrap', { version: 1, project_id: project, database_id: randomUUID(), bootstrap_id: randomUUID() })).json();
  assert.equal(initial.control.state, 'serving');
  let losePrepare = true, loseCommit = true, calls = 0;
  const c = new RestoreJournalClient('https://journal.invalid', journalEnv.RESTORE_JOURNAL_TOKEN, { fetcher: async (url, init) => {
    calls++; const request = new Request(url, init), response = await handleOperationRequest(request, journalEnv, storage, { now: () => ++now });
    if (request.url.endsWith('/prepare') && losePrepare) { losePrepare = false; await response.body.cancel(); throw Error('synthetic lost prepare reply'); }
    if (request.url.endsWith('/acknowledge') && loseCommit) { loseCommit = false; await response.body.cancel(); throw Error('synthetic lost commit reply'); }
    return response;
  } });
  await c.admission(initial.control.marker);
  const f = fixture(); f.input.expected = initial.control.marker;
  await assert.rejects(() => c.prepare(f.input), failure); assert.equal(calls, 2);
  const pending = await c.lookup(f.input.operation_id);
  assert.equal(pending.status, 'pending'); assert.equal(pending.plan.allocations.id_0, f.input.allocations.id_0);
  assert.equal((await c.control()).state, 'pending');
  await assert.rejects(() => c.admission(initial.control.marker), failure);
  assert.equal((await c.control()).state, 'pending');
  const repeated = await c.prepare(f.input); assert.deepEqual(repeated, pending);
  await assert.rejects(() => c.acknowledge(f.input.operation_id, pending.plan_hash, pending.plan.next), failure);
  const committed = await c.lookup(f.input.operation_id); assert.equal(committed.status, 'committed');
  assert.deepEqual(committed.plan, pending.plan);
  await c.admission(committed.plan.next);
  assert.equal((await c.acknowledge(f.input.operation_id, pending.plan_hash, pending.plan.next)).status, 'committed');
  // A same-schema database restored behind the independently acknowledged
  // checkpoint cannot open serving by presenting its own old marker.
  await assert.rejects(() => c.admission(initial.control.marker), failure);
  assert.equal((await c.control()).state, 'quarantined');
  await assert.rejects(() => c.acknowledge(f.input.operation_id, pending.plan_hash, pending.plan.next), failure);
  assert.equal((await c.lookup(f.input.operation_id)).status, 'committed');
  assert.equal((await c.control()).state, 'quarantined');
  assert.equal((await c.lookup(randomUUID())), null);
});
