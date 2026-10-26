import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { env, bootstrapID, envelope, input, request, fixture, MemoryStorage } from './independent-ledger-fixture.mjs';
import { handleLedgerRequest, PUSH_LEDGER_BINDING, PREFLIGHT_LEASE_MS, AMBIGUOUS_AFTER_MS } from '../src/durable-ledger.mjs';
import worker from '../src/ledger-worker.mjs';
import { LedgerConflict } from '../src/ledger.mjs';
import { requestHash, createGateway } from '../src/gateway.mjs';
import { RemoteDispatchLedger } from '../src/remote-ledger.mjs';

test('ordinary authentication precedes storage and EU namespace; no implicit initialization', async () => {
  const storage = new MemoryStorage(); let selections = 0;
  const bad = request('/v1/operations/reserve', envelope({ token: 'private' }), 'wrong');
  assert.equal((await handleLedgerRequest(bad, env, storage)).status, 401); assert.equal(storage.calls, 0);
  const namespace = { jurisdiction() { selections++; throw new Error('must not reach namespace'); } };
  assert.equal((await worker.fetch(request('/v1/control', undefined, 'wrong'), { ...env, PUSH_DISPATCH_LEDGER: namespace })).status, 401);
  assert.equal(selections, 0);
  assert.equal((await handleLedgerRequest(request('/v1/control'), env, storage)).status, 503); assert.equal(storage.rows.size, 0);
  assert.equal((await handleLedgerRequest(request('/v1/bootstrap', envelope({ bootstrap_id: bootstrapID })), env, storage)).status, 401);
  assert.equal(storage.rows.size, 0);
});

test('Worker bounds authenticated body duration/size and cancels incomplete input before storage', async context => {
  const storage = new MemoryStorage(); let cancelled = false, started;
  const reading = new Promise(resolve => { started = resolve; });
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const slow = { url: 'https://ledger.invalid/v1/operations/reserve', method: 'POST', headers: new Headers({
    authorization: 'Bearer ' + env.PUSH_LEDGER_TOKEN, 'content-type': 'application/json' }), body: { getReader() { return {
      read() { started(); return new Promise(() => {}); }, cancel() { cancelled = true; return Promise.resolve(); }, releaseLock() {},
    }; } } };
  const response = handleLedgerRequest(slow, env, storage); await reading; context.mock.timers.tick(10_000);
  assert.equal((await response).status, 408); assert.equal(cancelled, true); assert.equal(storage.calls, 0);
  context.mock.timers.reset();
  const large = request('/v1/operations/reserve', { excess: 'x'.repeat(4096) });
  assert.equal((await handleLedgerRequest(large, env, storage)).status, 413); assert.equal(storage.calls, 0);
});

test('operator initialization exact retries, immutable binding, nonempty refusal and sticky quarantine', async () => {
  const f = await fixture();
  assert.equal((await f.send('/v1/bootstrap', envelope({ bootstrap_id: bootstrapID }), env.PUSH_LEDGER_BOOTSTRAP_TOKEN)).status, 200);
  assert.equal((await f.send('/v1/bootstrap', envelope({ bootstrap_id: randomUUID() }), env.PUSH_LEDGER_BOOTSTRAP_TOKEN)).status, 409);
  const previous = structuredClone(f.storage.rows);
  assert.equal((await handleLedgerRequest(request('/v1/control'), { ...env, PUSH_LEDGER_ID: randomUUID() }, f.storage)).status, 503);
  assert.deepEqual(f.storage.rows, previous);
  const orphan = new MemoryStorage(new Map([['orphan', {}]]));
  assert.equal((await handleLedgerRequest(request('/v1/bootstrap', envelope({ bootstrap_id: bootstrapID }), env.PUSH_LEDGER_BOOTSTRAP_TOKEN), env, orphan)).status, 503);
  const internal = new MemoryStorage(); internal.database.exec('CREATE TABLE __cf_kv(key TEXT PRIMARY KEY,value BLOB)');
  assert.equal((await handleLedgerRequest(request('/v1/bootstrap', envelope({ bootstrap_id: bootstrapID }), env.PUSH_LEDGER_BOOTSTRAP_TOKEN), env, internal)).status, 200);
  const item = input(), held = await f.client.reserve(item, requestHash(item));
  const quarantine = await f.send('/v1/quarantine', envelope({ reason: 'ledger_recovery_required' })); assert.equal(quarantine.status, 200);
  assert.equal((await f.client.control()).state, 'quarantined');
  await assert.rejects(f.client.reserve(input(), 'a'.repeat(64)), /provider_ledger_unavailable/);
  await assert.rejects(f.client.startDispatch(item.operation_key, held.claim), /provider_ledger_unavailable/);
  assert.equal((await f.client.lookup(item.operation_key)).status, 'prepared');
  const retry = await f.send('/v1/bootstrap', envelope({ bootstrap_id: bootstrapID }), env.PUSH_LEDGER_BOOTSTRAP_TOKEN);
  assert.equal((await retry.json()).control.state, 'quarantined');
  assert.equal((await f.send('/v1/quarantine', envelope({ reason: 'serving' }))).status, 400);
});

test('concurrent minimal reservations preserve one request UUID, conflict and expiring preflight fences', async () => {
  const f = await fixture(), item = input(), digest = requestHash(item);
  const reserved = await Promise.all(Array.from({ length: 12 }, () => f.client.reserve(item, digest)));
  assert.equal(reserved.filter(value => value.claim).length, 1);
  assert.equal(new Set(reserved.map(value => value.row.provider_request_id)).size, 1);
  const first = reserved.find(value => value.claim);
  assert.deepEqual(Object.keys(f.wire[0]).sort(), ['version', 'project_id', 'ledger_id', 'operation_key', 'request_sha256', 'platform', 'notification_id'].sort());
  for (const content of [JSON.stringify(f.wire), JSON.stringify([...f.storage.rows])]) {
    assert(!content.includes(item.token)); assert(!content.includes(item.notification.title)); assert(!content.includes(item.notification.entity_id));
  }
  await assert.rejects(f.client.reserve(item, 'b'.repeat(64)), LedgerConflict);
  f.advance(PREFLIGHT_LEASE_MS);
  const next = await f.client.reserve(item, digest);
  assert(next.claim); assert.notEqual(next.claim, first.claim); assert.equal(next.row.provider_request_id, first.row.provider_request_id);
  await f.client.preflightFailed(item.operation_key, first.claim);
  assert.equal(await f.client.startDispatch(item.operation_key, first.claim), null);
  assert.equal((await f.client.lookup(item.operation_key)).claim_id, next.claim);
  await f.client.preflightFailed(item.operation_key, next.claim);
  const again = await f.client.reserve(item, digest); assert(again.claim);
  const dispatched = await f.client.startDispatch(item.operation_key, again.claim); assert.equal(dispatched.status, 'dispatching');
  f.advance(AMBIGUOUS_AFTER_MS);
  assert.equal((await f.client.lookup(item.operation_key)).status, 'ambiguous');
  assert.equal((await f.client.reserve(item, digest)).claim, null);
  const accepted = await f.client.finish(item.operation_key, { status: 'accepted', provider_message_id: 'projects/easymoai/messages/0:123%abc' });
  assert.equal(accepted.status, 'accepted');
  await assert.rejects(f.client.finish(item.operation_key, { status: 'rejected' }), /provider_ledger_unavailable/);
  assert.equal((await f.client.reserve(item, digest)).claim, null);
  const restarted = new RemoteDispatchLedger('https://ledger.invalid', env.PUSH_LEDGER_TOKEN, { ledgerID: env.PUSH_LEDGER_ID,
    fetcher: (url, init) => handleLedgerRequest(new Request(url, init), env, f.storage, { now: () => f.now }) });
  assert.deepEqual(await restarted.lookup(item.operation_key), accepted);
});

test('strict schema, atomic fault rollback and incomplete storage fail closed', async () => {
  const f = await fixture(), item = input();
  const fields = { operation_key: item.operation_key, request_sha256: requestHash(item), platform: item.platform, notification_id: item.notification.id };
  for (const body of [envelope({ ...fields, token: item.token }), { ...envelope(fields), project_id: 'wrong' }, { ...envelope(fields), ledger_id: randomUUID() }]) {
    assert.equal((await f.send('/v1/operations/reserve', body)).status, 400);
  }
  const before = structuredClone(f.storage.rows); f.storage.failPut = true;
  await assert.rejects(f.client.reserve(item, requestHash(item)), /provider_ledger_unavailable/); assert.deepEqual(f.storage.rows, before);
  f.storage.failPut = false; const reserved = await f.client.reserve(item, requestHash(item));
  const snapshot = structuredClone(f.storage.rows);
  f.storage.rows.delete('operation:' + item.operation_key); await assert.rejects(f.client.lookup(item.operation_key), /provider_ledger_unavailable/);
  f.storage.rows = snapshot; f.storage.rows.delete(PUSH_LEDGER_BINDING);
  await assert.rejects(f.client.reserve(item, requestHash(item)), /provider_ledger_unavailable/);
  assert.equal((await f.send('/v1/bootstrap', envelope({ bootstrap_id: bootstrapID }), env.PUSH_LEDGER_BOOTSTRAP_TOKEN)).status, 503);
  assert.equal(reserved.row.status, 'prepared');
});

test('immutable admission prevents older receipt loss from reopening an operation', async () => {
  const f = await fixture(), first = input(), second = input();
  const reserved = await f.client.reserve(first, requestHash(first));
  await f.client.startDispatch(first.operation_key, reserved.claim);
  await f.client.finish(first.operation_key, { status: 'accepted', provider_message_id: 'original-accepted' });
  await f.client.reserve(second, requestHash(second)); // The binding head now names another operation.
  f.storage.rows.delete('dispatch:' + first.operation_key); f.storage.rows.delete('operation:' + first.operation_key);
  await assert.rejects(f.client.reserve(first, requestHash(first)), /provider_ledger_unavailable/);
  await assert.rejects(f.client.lookup(first.operation_key), /provider_ledger_unavailable/);
  assert.throws(() => f.storage.database.exec('DELETE FROM push_dispatch_admissions_v1'), /immutable_admission/);
  assert.throws(() => f.storage.database.exec("UPDATE push_dispatch_admissions_v1 SET request_sha256='corrupt'"), /immutable_admission/);
});

test('immutable dispatch intent prevents an older prepared KV snapshot from authorizing another send', async () => {
  const f = await fixture(), first = input(), second = input(), digest = requestHash(first);
  const original = await f.client.reserve(first, digest);
  const snapshot = new Map(['dispatch:', 'operation:'].map(prefix => [prefix + first.operation_key, structuredClone(f.storage.rows.get(prefix + first.operation_key))]));
  await f.client.startDispatch(first.operation_key, original.claim);
  await f.client.finish(first.operation_key, { status: 'accepted', provider_message_id: 'original-dispatched' });
  await f.client.reserve(second, requestHash(second));
  for (const [key, value] of snapshot) f.storage.rows.set(key, value);
  f.advance(PREFLIGHT_LEASE_MS);
  await assert.rejects(f.client.reserve(first, digest), /provider_ledger_unavailable/);
  await assert.rejects(f.client.startDispatch(first.operation_key, original.claim), /provider_ledger_unavailable/);
  assert.throws(() => f.storage.database.exec('DELETE FROM push_dispatch_intents_v1'), /immutable_dispatch_intent/);
});

test('lost start prevents provider bytes; lost finish preserves receipt without provider replay', async () => {
  for (const failure of ['start', 'finish']) {
    const f = await fixture(); let lost = false, sends = 0;
    const remote = new RemoteDispatchLedger('https://ledger.invalid', env.PUSH_LEDGER_TOKEN, { ledgerID: env.PUSH_LEDGER_ID,
      fetcher: async (url, init) => {
        const response = await handleLedgerRequest(new Request(url, init), env, f.storage, { now: () => f.now });
        if (!lost && url.endsWith('/' + failure)) { lost = true; throw new Error('lost response containing private diagnostic'); } return response;
      } });
    const secret = 'synthetic-gateway-private-secret-32-characters';
    const gateway = createGateway({ ledger: remote, providers: { android: { async prepare() { return {}; }, async send() {
      const rows = [...f.storage.rows.values()].filter(row => row?.status === 'dispatching'); assert.equal(rows.length, 1);
      sends++; return { status: 'accepted', provider_message_id: 'projects/easymoai/messages/accepted' };
    } } }, secret, now: () => f.now });
    const item = input();
    const call = () => gateway(new Request('https://gateway.invalid/send', { method: 'POST', headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' }, body: JSON.stringify(item) }));
    assert.equal((await call()).status, 503);
    const second = await call(); assert.equal(second.status, 200);
    assert.equal((await second.json()).status, failure === 'start' ? 'dispatching' : 'accepted');
    assert.equal(sends, failure === 'start' ? 0 : 1);
  }
});
