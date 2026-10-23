import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { DispatchLedger, receipt } from '../src/ledger.mjs';
import { createGateway, requestHash } from '../src/gateway.mjs';
import { createNodeServer, configuredProviders } from '../src/server.mjs';
const secret = 'controlled-gateway-service-secret-123456789';
const makeInput = (platform = 'ios') => { const id = randomUUID(); return { operation_key: 'notification:' + id + ':' + randomUUID(), platform, token: 'a'.repeat(64), notification: { id, title: 'A photo sharing request is waiting', kind: 'match', entity_id: randomUUID() } }; };
const sendRequest = (input, auth = secret) => new Request('https://push.internal/send', { method: 'POST', headers: { authorization: 'Bearer ' + auth, 'content-type': 'application/json' }, body: JSON.stringify(input) });
const getRequest = key => new Request('https://push.internal/operations/' + encodeURIComponent(key), { headers: { authorization: 'Bearer ' + secret } });
async function fixture(t, provider) {
  const pg = new PGlite(); await pg.waitReady;
  const wrap = client => ({ exec: query => client.exec(query), query: async (query, values = []) => (await client.query(query, values)).rows, transaction: callback => client.transaction(inner => callback(wrap(inner))) });
  const db = wrap(pg); let time = Date.now();
  const ledger = new DispatchLedger(db, { now: () => time }); await ledger.migrate();
  t.after(() => pg.close());
  let sends = 0;
  const defaultProvider = { prepare: async input => input, send: async () => { sends++; return { status: 'accepted', provider_message_id: randomUUID() }; } };
  const gateway = createGateway({ ledger, providers: { ios: provider ?? defaultProvider, android: provider ?? defaultProvider }, secret, now: () => time });
  return { pg, db, ledger, gateway, count: () => sends, advance: ms => { time += ms; }, now: () => time };
}
test('authentication precedes all database/provider work and startup defaults disable sends', async t => {
  const f = await fixture(t); const input = makeInput();
  assert.equal((await f.gateway(sendRequest(input, 'wrong'))).status, 401);
  assert.equal((await f.db.query('SELECT * FROM push_provider.dispatches')).length, 0); assert.equal(f.count(), 0);
  assert.deepEqual(await configuredProviders({}), {});
});
test('accepted receipt survives duplicate requests and a new ledger instance without resending', async t => {
  const f = await fixture(t), input = makeInput();
  const first = await (await f.gateway(sendRequest(input))).json(); assert.equal(first.status, 'accepted');
  assert.deepEqual(await (await f.gateway(sendRequest(input))).json(), first);
  assert.deepEqual(await (await f.gateway(getRequest(input.operation_key))).json(), first);
  assert.equal(receipt(await new DispatchLedger(f.db).lookup(input.operation_key), input.operation_key).provider_message_id, first.provider_message_id);
  assert.equal(f.count(), 1);
  const stored = (await f.db.query('SELECT * FROM push_provider.dispatches'))[0];
  assert.ok(!JSON.stringify(stored).includes(input.token)); assert.ok(!JSON.stringify(stored).includes(secret));
});
test('same operation with a substituted token or notification conflicts and cannot send', async t => {
  const f = await fixture(t), input = makeInput(); await f.gateway(sendRequest(input));
  assert.equal((await f.gateway(sendRequest({ ...input, token: 'b'.repeat(64) }))).status, 409); assert.equal(f.count(), 1);
});
test('concurrent duplicate callers obtain only one external dispatch', async t => {
  let sends = 0, release; const gate = new Promise(resolve => { release = resolve; });
  const provider = { prepare: async input => input, send: async () => { sends++; await gate; return { status: 'accepted', provider_message_id: randomUUID() }; } };
  const f = await fixture(t, provider), input = makeInput(); const pending = f.gateway(sendRequest(input));
  while (!sends) await new Promise(resolve => setTimeout(resolve, 1));
  const duplicates = await Promise.all(Array.from({ length: 8 }, () => f.gateway(sendRequest(input))));
  for (const reply of duplicates) assert.equal((await reply.json()).status, 'dispatching');
  release(); assert.equal((await (await pending).json()).status, 'accepted'); assert.equal(sends, 1);
});
test('expired preflight claims are fenced before dispatch and a crash after dispatch stays ambiguous', async t => {
  const f = await fixture(t), input = makeInput(), hash = requestHash(input);
  const first = await f.ledger.reserve(input, hash); f.advance(31_000);
  const second = await f.ledger.reserve(input, hash);
  assert.notEqual(first.claim, second.claim); assert.equal(await f.ledger.startDispatch(input.operation_key, first.claim), null);
  assert.ok(await f.ledger.startDispatch(input.operation_key, second.claim)); f.advance(61_000);
  assert.equal((await (await f.gateway(getRequest(input.operation_key))).json()).status, 'ambiguous');
  assert.equal((await (await f.gateway(sendRequest(input))).json()).status, 'ambiguous'); assert.equal(f.count(), 0);
});
test('a lost provider reply never dispatches the same operation again', async t => {
  let sends = 0; const f = await fixture(t, { prepare: async x => x, send: async () => { sends++; throw new Error('socket closed after possible acceptance'); } }), input = makeInput();
  assert.equal((await (await f.gateway(sendRequest(input))).json()).status, 'ambiguous');
  assert.equal((await (await f.gateway(sendRequest(input))).json()).status, 'ambiguous'); assert.equal(sends, 1);
});
test('failure persisting an accepted provider reply remains ambiguous across lookup and retry', async t => {
  const f = await fixture(t), input = makeInput(); f.ledger.finish = async () => { throw new Error('controlled receipt-write outage'); };
  const result = await f.gateway(sendRequest(input)); assert.equal(result.status, 503); assert.equal((await result.json()).status, 'ambiguous');
  f.advance(61_000); assert.equal((await (await f.gateway(getRequest(input.operation_key))).json()).status, 'ambiguous');
  assert.equal((await (await f.gateway(sendRequest(input))).json()).status, 'ambiguous'); assert.equal(f.count(), 1);
});
test('preflight failure proves not_dispatched and permits one later same-key dispatch', async t => {
  let prepares = 0, sends = 0; const f = await fixture(t, { prepare: async x => { if (!prepares++) throw new Error('no OAuth token'); return x; }, send: async () => { sends++; return { status: 'accepted', provider_message_id: randomUUID() }; } }), input = makeInput();
  const first = await f.gateway(sendRequest(input)); assert.equal(first.status, 503); assert.equal((await first.json()).status, 'not_dispatched'); assert.equal(sends, 0);
  assert.equal((await (await f.gateway(sendRequest(input))).json()).status, 'accepted'); assert.equal(sends, 1);
});
test('definitive invalid-token rejection is durable terminal even when diagnostic retryable is true', async t => {
  let sends = 0; const f = await fixture(t, { prepare: async x => x, send: async () => { sends++; return { status: 'rejected', provider_code: 'apns.Unregistered', token_invalid: true, retryable: true }; } }), input = makeInput();
  const first = await (await f.gateway(sendRequest(input))).json(); assert.equal(first.status, 'rejected'); assert.equal(first.token_invalid, true);
  assert.deepEqual(await (await f.gateway(sendRequest(input))).json(), first); assert.equal(sends, 1);
});
test('operation binding, unknown fields, private title content, malformed paths and oversized bodies are rejected', async t => {
  const f = await fixture(t), input = makeInput();
  for (const bad of [{ ...input, unexpected: 1 }, { ...input, notification: { ...input.notification, title: 'Private person name' } }, { ...input, notification: { ...input.notification, id: randomUUID() } }, { ...input, token: 'x'.repeat(9000) }]) assert.equal((await f.gateway(sendRequest(bad))).status, 400);
  assert.equal((await f.gateway(new Request('https://push.internal/operations/%xx', { headers: { authorization: 'Bearer ' + secret } }))).status, 400);
  assert.equal(f.count(), 0);
});
test('actual local HTTP adapter preserves auth, operation receipt and bounded JSON body contract', async t => {
  const f = await fixture(t), server = createNodeServer(f.gateway); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const input = makeInput('android'), url = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(url + '/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })).status, 401);
  const result = await fetch(url + '/send', { method: 'POST', headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal((await result.json()).status, 'accepted'); assert.equal(f.count(), 1);
});
