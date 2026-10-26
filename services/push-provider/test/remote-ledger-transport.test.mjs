import assert from 'node:assert/strict';
import { test } from 'node:test';
import { env, input, fixture } from './independent-ledger-fixture.mjs';
import { RemoteDispatchLedger } from '../src/remote-ledger.mjs';
import { requestHash } from '../src/gateway.mjs';

const client = (fetcher, timeoutMs = 1000) => new RemoteDispatchLedger('https://ledger.invalid', env.PUSH_LEDGER_TOKEN,
  { ledgerID: env.PUSH_LEDGER_ID, fetcher, timeoutMs });
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });

test('strict endpoint, status, payload binding and malformed receipts fail closed', async () => {
  for (const url of ['http://ledger.invalid', 'https://secret@ledger.invalid', 'https://ledger.invalid/path', 'https://ledger.invalid/?a=1', 'https://ledger.invalid/#fragment']) {
    assert.throws(() => new RemoteDispatchLedger(url, env.PUSH_LEDGER_TOKEN, { ledgerID: env.PUSH_LEDGER_ID }), /provider_ledger_unavailable/);
  }
  const f = await fixture(), item = input(); await f.client.reserve(item, requestHash(item));
  const good = await (await f.send('/v1/operations/' + encodeURIComponent(item.operation_key))).json();
  const cases = [
    () => json({ ...good, project_id: 'wrong' }),
    () => json({ ...good, ledger_id: '00000000-0000-0000-0000-000000000000' }),
    () => json({ ...good, arbitrary: true }),
    () => json({ ...good, result: { row: { ...good.result.row, status: 'accepted' } } }),
    () => json({ ...good, result: { row: { ...good.result.row, token: item.token } } }),
    () => json({ ...good, result: { row: { ...good.result.row, operation_key: input().operation_key } } }),
    () => json({ error: 'route_unavailable' }, 404),
    () => json({ error: 'operation_not_found', extra: true }, 404),
    () => json({ error: 'private diagnostic' }, 503),
    () => json(good, 302, { location: 'https://other.invalid' }),
    () => json(good, 200, { 'content-encoding': 'gzip' }),
    () => json(good, 200, { 'content-length': '1' }),
    () => new Response('<html>private diagnostic</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
  ];
  for (const fetcher of cases) await assert.rejects(client(fetcher).lookup(item.operation_key), /^Error: provider_ledger_unavailable$/);
  assert.equal(await client(() => json({ error: 'operation_not_found' }, 404)).lookup(item.operation_key), null);
});

test('request redirect denial and header/body deadlines cancel without retry or private diagnostics', async () => {
  const item = input(); let calls = 0, signal, lateCancelled = false;
  const late = client(async (_url, init) => {
    calls++; assert.equal(init.redirect, 'error'); signal = init.signal;
    await new Promise(resolve => setTimeout(resolve, 70));
    return new Response(new ReadableStream({ cancel() { lateCancelled = true; } }), { headers: { 'content-type': 'application/json' } });
  }, 20);
  await assert.rejects(late.lookup(item.operation_key), /^Error: provider_ledger_unavailable$/);
  assert.equal(signal.aborted, true); assert.equal(calls, 1);
  await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(lateCancelled, true);
  let bodyCancelled = false;
  const hanging = client(async (_url, init) => {
    signal = init.signal;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { bodyCancelled = true; } }),
      { headers: { 'content-type': 'application/json' } });
  }, 20);
  await assert.rejects(hanging.lookup(item.operation_key), /provider_ledger_unavailable/);
  assert.equal(signal.aborted, true); assert.equal(bodyCancelled, true);
  let oversizeCancelled = false;
  const oversized = client(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8193)); }, cancel() { oversizeCancelled = true; } }),
    { headers: { 'content-type': 'application/json' } }));
  await assert.rejects(oversized.lookup(item.operation_key), /provider_ledger_unavailable/); assert.equal(oversizeCancelled, true);
});

test('ordinary gateway client cannot initialize, quarantine, reset, or serialize raw input', async () => {
  const f = await fixture(), item = input();
  const remote = client(async (url, init) => {
    assert.equal(new URL(url).pathname, '/v1/operations/reserve');
    const body = JSON.parse(init.body);
    assert.deepEqual(Object.keys(body).sort(), ['version', 'project_id', 'ledger_id', 'operation_key', 'request_sha256', 'platform', 'notification_id'].sort());
    return f.send('/v1/operations/reserve', body);
  });
  await remote.reserve(item, requestHash(item));
  for (const name of ['bootstrap', 'quarantine', 'reset', 'clear', 'delete']) assert.equal(remote[name], undefined);
});
