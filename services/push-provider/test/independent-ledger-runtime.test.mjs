import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { env, bootstrapID, envelope, input } from './independent-ledger-fixture.mjs';
import { RemoteDispatchLedger } from '../src/remote-ledger.mjs';
import { requestHash, createGateway } from '../src/gateway.mjs';
import { LedgerConflict } from '../src/ledger.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
const { Miniflare } = require('miniflare');
const { build } = require('esbuild');

test('actual HTTP Worker/SQLite DO preserves claims, SQL/KV rollback, receipt restart and loss holds', { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lovelies-independent-push-ledger-'));
  // These seams are generated only in this test. workerd lacks EU jurisdiction
  // placement; the selector records the exact requested region. Fault/corruption
  // controls are absent from production source, routes and deployment config.
  const bundle = await build({ stdin: { contents: `
    import production, {PushDispatchLedger} from './src/ledger-worker.mjs';
    export class FixturePushLedger extends PushDispatchLedger {
      constructor(ctx,env){
        const fault={at:0};
        const storage={sql:ctx.storage.sql,transaction(callback){return ctx.storage.transaction(async txn=>{
          let writes=0;
          return callback({get:(...args)=>txn.get(...args),list:(...args)=>txn.list(...args),
            put:async values=>{await txn.put(values);if(++writes===fault.at)throw new Error('synthetic SQLite transaction fault');}});
        });}};
        super({storage},env);this.fixtureStorage=ctx.storage;this.fixtureFault=fault;this.fixtureSnapshots=new Map();
      }
      async fetch(request){
        const lost=request.headers.get('x-fixture-drop-pair');
        if(lost)await this.fixtureStorage.transaction(async txn=>{await txn.delete('dispatch:'+lost);await txn.delete('operation:'+lost);});
        const snapshot=request.headers.get('x-fixture-snapshot-pair');
        if(snapshot)this.fixtureSnapshots.set(snapshot,await this.fixtureStorage.get(['dispatch:'+snapshot,'operation:'+snapshot]));
        const restore=request.headers.get('x-fixture-restore-pair');
        if(restore)await this.fixtureStorage.put(Object.fromEntries(this.fixtureSnapshots.get(restore)));
        this.fixtureFault.at=Number(request.headers.get('x-fixture-put-fault')??'0');
        try{return await super.fetch(request);}finally{this.fixtureFault.at=0;}
      }
    }
    const selected=[];
    export default {fetch(request,env){
      if(new URL(request.url).pathname==='/_fixture/selections')return Response.json(selected);
      return production.fetch(request,{...env,PUSH_DISPATCH_LEDGER:{jurisdiction(region){
        if(region!=='eu')throw new Error('wrong jurisdiction');selected.push(region);return env.PUSH_DISPATCH_LEDGER;
      }}});
    }};
  `, resolveDir: new URL('../', import.meta.url).pathname, sourcefile: 'local-push-ledger-fault-fixture.mjs' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent' });
  const options = { name: 'lovelies-push-ledger-qualification', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-07-21', durableObjects: { PUSH_DISPATCH_LEDGER: { className: 'FixturePushLedger', useSQLite: true } },
    durableObjectsPersist: directory, bindings: env };
  let mf;
  try {
    const open = async () => { mf = new Miniflare(options); await mf.ready; };
    const restart = async () => { await mf.dispose(); mf = undefined; await open(); };
    const send = async (pathname, body, status = 200, headers = {}) => {
      const response = await mf.dispatchFetch('https://ledger.invalid' + pathname, { method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: 'Bearer ' + env.PUSH_LEDGER_TOKEN, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value));
      assert.match(response.headers.get('cache-control'), /no-store/); return value;
    };
    const remote = () => new RemoteDispatchLedger('https://ledger.invalid', env.PUSH_LEDGER_TOKEN, {
      ledgerID: env.PUSH_LEDGER_ID, fetcher: (url, init) => mf.dispatchFetch(url, init) });
    await open();
    await send('/v1/control', undefined, 401, { authorization: 'Bearer wrong' });
    assert.deepEqual(await (await mf.dispatchFetch('https://ledger.invalid/_fixture/selections')).json(), []);
    await send('/v1/control', undefined, 503);
    await send('/v1/bootstrap', envelope({ bootstrap_id: bootstrapID }), 401);
    const initialized = await send('/v1/bootstrap', envelope({ bootstrap_id: bootstrapID }), 200, { authorization: 'Bearer ' + env.PUSH_LEDGER_BOOTSTRAP_TOKEN });
    assert.equal(initialized.control.records, 0);

    // Fault after an immutable admission SQL INSERT and KV writes. Both must
    // roll back together, including count and unique-provider constraints.
    const failed = input();
    await send('/v1/operations/reserve', envelope({ operation_key: failed.operation_key, request_sha256: requestHash(failed),
      platform: failed.platform, notification_id: failed.notification.id }), 503, { 'x-fixture-put-fault': '1' });
    assert.equal((await remote().control()).records, 0); assert.equal(await remote().lookup(failed.operation_key), null);
    await restart(); assert.equal((await remote().control()).records, 0);

    const item = input(), client = remote(), digest = requestHash(item);
    const duplicate = await Promise.all(Array.from({ length: 12 }, () => client.reserve(item, digest)));
    assert.equal(duplicate.filter(value => value.claim).length, 1);
    assert.equal(new Set(duplicate.map(value => value.row.provider_request_id)).size, 1);
    await assert.rejects(client.reserve(item, 'd'.repeat(64)), LedgerConflict);
    const claim = duplicate.find(value => value.claim);
    await client.startDispatch(item.operation_key, claim.claim);
    const accepted = await client.finish(item.operation_key, { status: 'accepted', provider_message_id: 'projects/easymoai/messages/0:123%fixed' });
    await restart(); assert.deepEqual(await remote().lookup(item.operation_key), accepted);
    assert.equal((await remote().reserve(item, digest)).claim, null);

    for (const failure of ['start', 'finish']) {
      let lost = false, sends = 0;
      const ledger = new RemoteDispatchLedger('https://ledger.invalid', env.PUSH_LEDGER_TOKEN, { ledgerID: env.PUSH_LEDGER_ID,
        fetcher: async (url, init) => { const response = await mf.dispatchFetch(url, init);
          if (!lost && url.endsWith('/' + failure)) { lost = true; await response.body?.cancel(); throw new Error('synthetic lost HTTP acknowledgement'); } return response; } });
      const secret = 'synthetic-gateway-private-secret-32-characters', payload = input();
      const gateway = createGateway({ ledger, secret, providers: { android: { async prepare() { return {}; }, async send() {
        assert.equal((await remote().lookup(payload.operation_key)).status, 'dispatching'); sends++;
        return { status: 'accepted', provider_message_id: 'projects/easymoai/messages/test-' + failure };
      } } } });
      const call = () => gateway(new Request('https://gateway.invalid/send', { method: 'POST', headers: {
        authorization: 'Bearer ' + secret, 'content-type': 'application/json' }, body: JSON.stringify(payload) }));
      assert.equal((await call()).status, 503); await restart();
      const recovered = await call(); assert.equal(recovered.status, 200);
      assert.equal((await recovered.json()).status, failure === 'start' ? 'dispatching' : 'accepted');
      assert.equal(sends, failure === 'start' ? 0 : 1);
    }

    const partial = input(), prepared = await remote().reserve(partial, requestHash(partial));
    await send('/v1/control', undefined, 200, { 'x-fixture-snapshot-pair': partial.operation_key });
    await remote().startDispatch(partial.operation_key, prepared.claim);
    await remote().finish(partial.operation_key, { status: 'accepted', provider_message_id: 'accepted-before-partial-rollback' });
    const other = input(); await remote().reserve(other, requestHash(other));
    await send('/v1/control', undefined, 200, { 'x-fixture-restore-pair': partial.operation_key });
    await assert.rejects(remote().reserve(partial, requestHash(partial)), /provider_ledger_unavailable/);
    await assert.rejects(remote().startDispatch(partial.operation_key, prepared.claim), /provider_ledger_unavailable/);
    await restart(); await assert.rejects(remote().reserve(partial, requestHash(partial)), /provider_ledger_unavailable/);

    // Losing both records for an older accepted key must not reopen it. The
    // immutable SQLite admission still binds its original provider request UUID.
    const newer = input(); await remote().reserve(newer, requestHash(newer));
    await send('/v1/control', undefined, 200, { 'x-fixture-drop-pair': item.operation_key });
    await assert.rejects(remote().reserve(item, digest), /provider_ledger_unavailable/);
    await restart(); await assert.rejects(remote().reserve(item, digest), /provider_ledger_unavailable/);
    await send('/v1/quarantine', envelope({ reason: 'storage_integrity_unconfirmed' }));
    assert.equal((await remote().control()).state, 'quarantined');
    await assert.rejects(remote().reserve(input(), 'b'.repeat(64)), /provider_ledger_unavailable/);
    await restart(); assert.equal((await remote().control()).state, 'quarantined');
    const retried = await send('/v1/bootstrap', envelope({ bootstrap_id: bootstrapID }), 200, { authorization: 'Bearer ' + env.PUSH_LEDGER_BOOTSTRAP_TOKEN });
    assert.equal(retried.control.state, 'quarantined');
    const selections = await (await mf.dispatchFetch('https://ledger.invalid/_fixture/selections')).json();
    assert(selections.length > 0 && selections.every(region => region === 'eu'));
  } finally { await mf?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
