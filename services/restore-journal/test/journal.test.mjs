import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import worker from '../src/worker.mjs';
import { appendEvent, readHead, readEvents, handleRequest, HEAD_KEY, GENESIS_HASH, PROTOCOL, PROJECT_ID, canonical, sha256, eventKey, MAX_BODY_BYTES } from '../src/journal.mjs';
import { env, ids, event, request, MemoryStorage } from './fixtures.mjs';

const json = async (storage, input, status = 200, bindings = env) => {
  const response = await handleRequest(input, bindings, storage);
  assert.equal(response.status, status);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  return response.json();
};

test('outer and durable handlers authenticate before reading a body or accessing storage/namespace', async () => {
  let reads = 0, lookups = 0;
  const input = { url: 'https://journal.invalid/v1/events', method: 'POST', headers: new Headers(), get body() { reads++; throw new Error('body accessed'); } };
  const storage = new MemoryStorage();
  assert.deepEqual(await json(storage, input, 401), { error: 'journal_authentication_required' });
  const response = await worker.fetch(input, { ...env, get RESTORE_JOURNAL() { lookups++; throw new Error('namespace accessed'); } });
  assert.equal(response.status, 401);
  assert.equal(storage.calls, 0); assert.equal(reads, 0); assert.equal(lookups, 0);
  for (const secret of ['', 'short', '\n' + env.RESTORE_JOURNAL_TOKEN]) {
    assert.equal((await json(storage, request('/v1/head'), 503, { ...env, RESTORE_JOURNAL_TOKEN: secret })).error, 'journal_configuration_invalid');
  }
  await json(storage, request('/v1/head'), 503, { ...env, SUPABASE_PROJECT_ID: 'other-project' });
  await json(storage, request('/v1/head', undefined, { authorization: 'Bearer ' + 'x'.repeat(5000) }), 401);
  assert.equal(storage.calls, 0);
});

test('first event is atomically bound to project, canonical payload and genesis; exact retry survives restart', async () => {
  const storage = new MemoryStorage(), input = event();
  const first = (await json(storage, request('/v1/events', input))).receipt;
  assert.equal(first.sequence, 1); assert.equal(first.previous_hash, GENESIS_HASH);
  assert.equal(first.payload_hash, await sha256(canonical(input)));
  assert.equal(first.hash, await sha256(canonical({ protocol: PROTOCOL, project_id: PROJECT_ID, sequence: 1, previous_hash: GENESIS_HASH, payload_hash: first.payload_hash, recorded_at: first.recorded_at })));
  assert.equal(storage.rows.size, 3);
  const restarted = new MemoryStorage(storage.rows);
  const reordered = { scope: { purpose: 'photo_matching', consent_id: ids.consent, account_id: ids.account }, kind: input.kind, operation_id: input.operation_id, project_id: input.project_id, version: 1 };
  assert.deepEqual((await json(restarted, request('/v1/events', reordered))).receipt, first);
  assert.deepEqual(await readHead(restarted), { sequence: 1, hash: first.hash });
  assert.equal(restarted.rows.size, 3);
});

test('concurrent exact retries append once; conflicting reuse cannot overwrite the prior restriction', async () => {
  const storage = new MemoryStorage(), input = event();
  const receipts = await Promise.all(Array.from({ length: 20 }, () => appendEvent(storage, input)));
  assert(receipts.every(value => value.sequence === 1 && value.hash === receipts[0].hash));
  const conflict = { ...input, scope: { ...input.scope, consent_id: randomUUID() } };
  await json(storage, request('/v1/events', conflict), 409);
  assert.equal((await readHead(storage)).sequence, 1);
  assert.deepEqual((await readEvents(storage, 0, 100)).events, [receipts[0]]);
});

test('independent concurrent operations form one gapless append-only chain with bounded coherent pagination', async () => {
  const storage = new MemoryStorage();
  await Promise.all(Array.from({ length: 27 }, () => appendEvent(storage, event())));
  let after = 0, previous = GENESIS_HASH, count = 0;
  do {
    const page = await readEvents(storage, after, 7);
    assert.equal(page.head.sequence, 27); assert(page.events.length <= 7);
    for (const receipt of page.events) { count++; assert.equal(receipt.sequence, count); assert.equal(receipt.previous_hash, previous); previous = receipt.hash; }
    assert.equal(page.next_after, count); assert.equal(page.has_more, count < 27); after = page.next_after;
  } while (after < 27);
  assert.equal(previous, (await readHead(storage)).hash);
  assert.deepEqual((await readEvents(storage, 27, 7)).events, []);
  await json(storage, request('/v1/events?after=28'), 409);
});

test('storage failure rolls back event, operation index and head; an acknowledged append survives a lost client response', async () => {
  const storage = new MemoryStorage(), input = event(); storage.failPut = true;
  const failed = await json(storage, request('/v1/events', input), 503);
  assert.deepEqual(failed, { error: 'journal_unavailable' }); assert.equal(storage.rows.size, 0);
  storage.failPut = false;
  const receipt = await appendEvent(storage, input);
  // The caller drops the returned response; the durable fact remains independent.
  const restarted = new MemoryStorage(storage.rows);
  assert.deepEqual(await appendEvent(restarted, input), receipt);
});

test('restriction schemas retain exact old episodes, independent review and pair-block termination without granting access', async () => {
  const storage = new MemoryStorage();
  const cases = [
    event('account-deletion-requested', { account_id: ids.account, deletion_request_id: ids.request }),
    event('account-deletion-reviewed', { account_id: ids.account, deletion_request_id: ids.request, reviewer_id: ids.other, decision: 'rejected' }),
    event('account-erased', { account_id: ids.account, deletion_request_id: ids.request }),
    event('profile-retired', { account_id: ids.account, profile_id: ids.profile, profile_revision: 'reference_revision-1' }),
    event('guardian-approval-retired', { child_account_id: ids.account, guardian_request_id: ids.guardian, guardian_approval_id: ids.approval, purpose: 'photo_matching' }),
    event('sharing-request-retired', { sender_id: ids.account, recipient_id: ids.other, request_id: ids.request }),
    event('session-retired', { account_id: ids.account, session_id: ids.session }),
    event('device-retired', { account_id: ids.account, device_id: ids.device, device_revision: 'revision-1' }),
    event('asset-retired', { owner_id: ids.account, asset_id: ids.asset, asset_version: 'a'.repeat(64) }),
    event('pair-blocked', { blocker_id: ids.account, blocked_id: ids.other, block_operation_id: ids.block }),
    event('pair-block-ended', { blocker_id: ids.account, blocked_id: ids.other, block_operation_id: ids.block }),
  ];
  for (const input of cases) assert.deepEqual((await appendEvent(storage, input)).event, input);
  const page = await readEvents(storage, 0, 100); assert.equal(page.events.length, cases.length);
  assert.deepEqual(page.events.map(value => value.event), cases);
  const nextConsent = event('consent-withdrawn', { account_id: ids.account, consent_id: randomUUID(), purpose: 'photo_matching' });
  assert.notEqual(nextConsent.scope.consent_id, ids.consent);
  assert.equal(Object.hasOwn(page, 'allowed'), false); assert.equal(Object.hasOwn(page, 'erasure_approved'), false);
  assert.equal(Object.hasOwn(page, 'restore_cleared'), false);
});

test('unknown/personal fields, wrong project, malformed IDs, widened scopes and self-review are rejected before writes', async () => {
  const base = event(), storage = new MemoryStorage();
  const invalid = [
    { ...base, project_id: 'other-project' }, { ...base, version: 2 }, { ...base, operation_id: 'unknown' },
    { ...base, email: 'must-not-be-retained@example.invalid' }, { ...base, kind: '__proto__' },
    { ...base, scope: { ...base.scope, account_id: 'not-a-uuid' } }, { ...base, scope: { ...base.scope, consent_id: 'not-a-uuid' } },
    { ...base, scope: { ...base.scope, purpose: 'all' } }, { ...base, scope: { ...base.scope, private_url: 'https://private.invalid/photo' } },
    { ...base, scope: { account_id: ids.account, purpose: 'photo_matching' } }, { ...base, scope: null },
    event('profile-retired', { account_id: ids.account, profile_id: ids.profile, profile_revision: '../path' }),
    event('pair-blocked', { blocker_id: ids.account, blocked_id: ids.other }),
    event('pair-blocked', { blocker_id: ids.account, blocked_id: ids.account, block_operation_id: ids.block }),
    event('account-deletion-reviewed', { account_id: ids.account, deletion_request_id: ids.request, reviewer_id: ids.account, decision: 'approved' }),
    event('account-deletion-reviewed', { account_id: ids.account, deletion_request_id: ids.request, reviewer_id: ids.other, decision: 'cancelled' }),
  ];
  for (const input of invalid) await json(storage, request('/v1/events', input), 400);
  assert.equal(storage.calls, 0); assert.equal(storage.rows.size, 0);
});

test('content/transport/pagination limits fail closed without storage effects', async () => {
  const storage = new MemoryStorage();
  await json(storage, request('/v1/events', event(), { 'content-type': 'text/plain' }), 415);
  await json(storage, request('/v1/events', event(), { 'content-encoding': 'gzip' }), 415);
  await json(storage, request('/v1/events', ' '.repeat(MAX_BODY_BYTES + 1)), 413);
  await json(storage, request('/v1/events', '{'), 400);
  await json(storage, request('/v1/events', event(), { 'content-length': '1' }), 400);
  const badUtf8 = new Request('https://journal.invalid/v1/events', { method: 'POST', headers: { authorization: 'Bearer ' + env.RESTORE_JOURNAL_TOKEN, 'content-type': 'application/json' }, body: new Uint8Array([0xc3, 0x28]) });
  await json(storage, badUtf8, 400);
  for (const query of ['?limit=0', '?limit=101', '?after=-1', '?after=01', '?after=9007199254740992', '?limit=1&limit=2', '?after=1&after=2', '?unknown=1']) await json(storage, request('/v1/events' + query), 400);
  await json(storage, request('/v1/head?after=0'), 400);
  await json(storage, request('/v1/head', event()), 405);
  await json(storage, request('/v1/other'), 404);
  await json(storage, new Request('http://journal.invalid/v1/head', { headers: { authorization: 'Bearer ' + env.RESTORE_JOURNAL_TOKEN } }), 400);
  await json(storage, request('/v1/head', undefined, { Upgrade: 'websocket' }), 400);
  assert.equal(storage.calls, 0);
});

test('corrupt head, missing tail, orphan event and modified operation index are denied', async () => {
  const storage = new MemoryStorage(), input = event(); await appendEvent(storage, input);
  const variants = [
    rows => rows.delete(HEAD_KEY), rows => rows.set(HEAD_KEY, { ...rows.get(HEAD_KEY), hash: 'f'.repeat(64) }),
    rows => rows.delete(eventKey(1)), rows => rows.set(eventKey(2), rows.get(eventKey(1))),
    rows => rows.set('operation:' + input.operation_id, { sequence: 1, payload_hash: 'e'.repeat(64) }),
  ];
  for (const modify of variants) {
    const copy = new MemoryStorage(storage.rows); modify(copy.rows);
    assert.equal((await json(copy, request('/v1/head'), 503)).error, 'journal_integrity_failed');
    await json(copy, request('/v1/events', event()), 503);
  }
});

test('complete replay detects an earlier gap/corruption; a tail-only head is never restore-clearance evidence', async () => {
  const storage = new MemoryStorage(); await appendEvent(storage, event()); await appendEvent(storage, event());
  for (const modify of [rows => rows.delete(eventKey(1)), rows => { const receipt = rows.get(eventKey(1)); receipt.event.scope.purpose = 'photo_processing'; rows.set(eventKey(1), receipt); }]) {
    const copy = new MemoryStorage(storage.rows); modify(copy.rows);
    await json(copy, request('/v1/events?after=0&limit=100'), 503);
  }
});

test('invalid/exhausted sequence and invalid clocks never write or roll back an acknowledged event', async () => {
  const storage = new MemoryStorage();
  for (const value of [0, NaN, Infinity, -1, 1.5]) await assert.rejects(appendEvent(storage, event(), () => value), /journal_clock_invalid/);
  assert.equal(storage.rows.size, 0);
  const first = await appendEvent(storage, event(), () => 1000), next = await appendEvent(storage, event(), () => 900);
  assert.equal(first.recorded_at, next.recorded_at);
  const input = event(), payload_hash = await sha256(canonical(input)), sequence = Number.MAX_SAFE_INTEGER, recorded_at = 1000;
  const receipt = { sequence, previous_hash: GENESIS_HASH, payload_hash, recorded_at, event: input };
  receipt.hash = await sha256(canonical({ protocol: PROTOCOL, project_id: PROJECT_ID, sequence, previous_hash: GENESIS_HASH, payload_hash, recorded_at }));
  const exhausted = new MemoryStorage(new Map([
    [eventKey(sequence), receipt], ['operation:' + input.operation_id, { sequence, payload_hash }],
    [HEAD_KEY, { version: 1, project_id: PROJECT_ID, sequence, hash: receipt.hash, recorded_at }],
  ]));
  await assert.rejects(appendEvent(exhausted, event()), /journal_sequence_exhausted/);
  assert.deepEqual(await readHead(exhausted), { sequence, hash: receipt.hash });
});
