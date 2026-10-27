import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import worker, { RestoreJournal } from '../src/worker.mjs';
import { handleRequest } from '../src/journal.mjs';
import { env, event, MemoryStorage } from './fixtures.mjs';

const encoder = new TextEncoder();
function input(body, signal, path = '/v1/events') {
  return { url: 'https://journal.invalid' + path, method: 'POST',
    headers: new Headers({ authorization: 'Bearer ' + env.RESTORE_JOURNAL_TOKEN, 'content-type': 'application/json' }), body, signal };
}
async function dispatch(request, storage, throughWorker) {
  if (!throughWorker) return handleRequest(request, env, storage);
  const durable = new RestoreJournal({ storage }, env);
  return worker.fetch(request, { ...env, RESTORE_JOURNAL: { jurisdiction: () => ({ idFromName: () => 'owned', get: () => durable }) } });
}

for (const throughWorker of [false, true]) {
  const route = throughWorker ? 'Worker and durable handler' : 'durable handler';
  test(`${route} binds a restriction to the bytes actually read`, async () => {
    const original = event(), altered = { ...original, operation_id: randomUUID() };
    const text = JSON.stringify(original), changed = JSON.stringify(altered);
    const split = text.indexOf(original.operation_id) + original.operation_id.length;
    const first = encoder.encode(text.slice(0, split)), replacement = encoder.encode(changed.slice(0, split)), rest = encoder.encode(text.slice(split));
    assert.equal(first.length, replacement.length);
    let reads = 0;
    const body = new ReadableStream({ pull(controller) {
      if (reads++ === 0) { controller.enqueue(first); return; }
      return new Promise(resolve => setTimeout(() => { first.set(replacement); controller.enqueue(rest); controller.close(); resolve(); }, 0));
    } }, { highWaterMark: 0 });
    const storage = new MemoryStorage(), response = await dispatch(input(body), storage, throughWorker);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).receipt.event, original);
  });

  test(`${route} rejects excessive empty fragments before recording a restriction`, async () => {
    const original = event(); let reads = 0, cancelled = false;
    const body = new ReadableStream({ pull(controller) {
      if (reads++ < 4097) controller.enqueue(new Uint8Array());
      else { controller.enqueue(encoder.encode(JSON.stringify(original))); controller.close(); }
    }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const storage = new MemoryStorage(), response = await dispatch(input(body), storage, throughWorker);
    assert.equal(response.status, 413); assert.equal(storage.rows.size, 0); assert.equal(storage.calls, 0); assert.equal(cancelled, true);
  });
}

test('an aborted stalled legacy request returns without awaiting an uncooperative stream cancellation', async () => {
  const controller = new AbortController(), storage = new MemoryStorage(); let cancelled = false;
  const body = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; return new Promise(() => {}); } }, { highWaterMark: 0 });
  const pending = dispatch(input(body, controller.signal), storage, false);
  setTimeout(() => controller.abort(), 10);
  const response = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve(null), 500))]);
  assert(response, 'aborted body read must return promptly');
  assert.equal(response.status, 503); assert.equal((await response.json()).error, 'event_read_aborted');
  assert.equal(cancelled, true); assert.equal(storage.rows.size, 0); assert.equal(storage.calls, 0);
});

test('a stalled legacy body reaches a deadline without recording a restriction', { timeout: 8000 }, async () => {
  const storage = new MemoryStorage(); let cancelled = false;
  const body = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const response = await dispatch(input(body), storage, false);
  assert.equal(response.status, 503); assert.equal((await response.json()).error, 'event_read_timeout');
  assert.equal(cancelled, true); assert.equal(storage.rows.size, 0); assert.equal(storage.calls, 0);
});

test('the legacy operation endpoint accepts a normally fragmented control request', async () => {
  const storage = new MemoryStorage(), durable = new RestoreJournal({ storage }, env);
  const payload = { version: 1, project_id: env.SUPABASE_PROJECT_ID, database_id: randomUUID(), bootstrap_id: randomUUID() };
  const bytes = encoder.encode(JSON.stringify(payload)); let offset = 0;
  const body = new ReadableStream({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    const end = Math.min(offset + 13, bytes.length); controller.enqueue(bytes.slice(offset, end)); offset = end;
  } }, { highWaterMark: 0 });
  const response = await durable.fetch(input(body, undefined, '/v1/control/bootstrap'));
  assert.equal(response.status, 200); assert.equal((await response.json()).control.marker.database_id, payload.database_id);
  assert(storage.calls > 0);
});

test('an aborted legacy operation body cannot start its control transaction', async () => {
  const controller = new AbortController(), storage = new MemoryStorage(), durable = new RestoreJournal({ storage }, env); let cancelled = false;
  const body = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const pending = durable.fetch(input(body, controller.signal, '/v1/control/bootstrap'));
  setTimeout(() => controller.abort(), 10);
  const response = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve(null), 500))]);
  assert(response, 'aborted operation body must return promptly');
  assert.equal(response.status, 503); assert.equal((await response.json()).error, 'operation_read_aborted');
  assert.equal(cancelled, true); assert.equal(storage.calls, 0); assert.equal(storage.rows.size, 0);
});
