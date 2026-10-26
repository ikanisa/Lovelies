import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredLedger, createNodeServer, start } from '../src/server.mjs';
import { createGateway } from '../src/gateway.mjs';
import { handleLedgerRequest } from '../src/durable-ledger.mjs';
import { fixture, env as ledgerEnv, envelope, input } from './independent-ledger-fixture.mjs';

const serviceSecret = 'synthetic-gateway-service-secret-not-ledger-secret';
const configuration = () => ({ PUSH_LEDGER_URL: 'https://ledger.invalid',
  PUSH_LEDGER_TOKEN: ledgerEnv.PUSH_LEDGER_TOKEN, PUSH_LEDGER_ID: ledgerEnv.PUSH_LEDGER_ID });

test('configured startup requires the independent serving binding and never falls back to PostgreSQL', async () => {
  let calls = 0;
  await assert.rejects(configuredLedger({ PUSH_DATABASE_URL: 'postgres://unused.invalid/unused' },
    { fetcher: async () => { calls++; throw new Error('must not access network'); } }), /provider_ledger_unavailable/);
  assert.equal(calls, 0);
  const f = await fixture();
  const fetcher = (url, init) => handleLedgerRequest(new Request(url, init), ledgerEnv, f.storage, { now: () => f.now });
  const ledger = await configuredLedger(configuration(), { fetcher });
  assert.equal((await ledger.control()).state, 'serving');
  const held = await f.send('/v1/quarantine', envelope({ reason: 'ledger_recovery_required' }));
  assert.equal(held.status, 200);
  await assert.rejects(configuredLedger(configuration(), { fetcher }), /provider_ledger_unavailable/);
});

test('missing ledger configuration rejects process startup before provider key access or listening', async () => {
  const env = { PORT: '8091', PUSH_SERVICE_SECRET: serviceSecret, PUSH_PROVIDER_SEND_ENABLED: 'true' };
  Object.defineProperty(env, 'APNS_PRIVATE_KEY_FILE', { get() { assert.fail('provider keys read before ledger admission'); } });
  await assert.rejects(start(env), /provider_ledger_unavailable/);
});

test('configured independent ledger works through Node HTTP and holds a quarantined retry without another send', async t => {
  const f = await fixture();
  const fetcher = (url, init) => handleLedgerRequest(new Request(url, init), ledgerEnv, f.storage, { now: () => f.now });
  const ledger = await configuredLedger(configuration(), { fetcher });
  let sends = 0;
  const gateway = createGateway({ ledger, secret: serviceSecret, now: () => f.now,
    providers: { android: { prepare: async value => value, send: async () => {
      sends++; return { status: 'accepted', provider_message_id: 'projects/controlled/messages/original' };
    } } } });
  const server = createNodeServer(gateway);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = 'http://127.0.0.1:' + server.address().port, value = input();
  const send = () => fetch(url + '/send', { method: 'POST', headers: { authorization: 'Bearer ' + serviceSecret,
    'content-type': 'application/json' }, body: JSON.stringify(value) });
  const first = await send(); assert.equal(first.status, 200);
  const original = await first.json(); assert.equal(original.status, 'accepted'); assert.equal(sends, 1);
  assert.deepEqual(await (await send()).json(), original); assert.equal(sends, 1);
  await f.send('/v1/quarantine', envelope({ reason: 'storage_integrity_unconfirmed' }));
  assert.equal((await send()).status, 503); assert.equal(sends, 1);
  const saved = await fetch(url + '/operations/' + encodeURIComponent(value.operation_key),
    { headers: { authorization: 'Bearer ' + serviceSecret } });
  assert.equal(saved.status, 200); assert.deepEqual(await saved.json(), original);
});
