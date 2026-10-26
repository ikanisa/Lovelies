import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { env, event } from './fixtures.mjs';
import { PROJECT_ID, GENESIS_HASH } from '../src/journal.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
const { Miniflare } = require('miniflare');
const { build } = require('esbuild');
const input = fields => ({ version: 1, project_id: PROJECT_ID, ...fields });
const ack = operation => input({ plan_hash: operation.plan_hash, marker: operation.plan.next });
const prepare = (marker, events = []) => input({ operation_id: randomUUID(), input_hash: 'b'.repeat(64), expected: marker,
  allocations: { id_0: randomUUID(), id_1: randomUUID() }, events });

test('actual Worker/SQLite DO preserves operation allocations, pending/commit fences and immutable recovery across HTTP loss, faults and restarts', { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lovelies-operation-journal-'));
  // These two seams exist only in this generated local test entrypoint:
  // workerd lacks EU jurisdiction selection, and SQLite writes need a controlled
  // exception to qualify real rollback. No production route/header enables it.
  const bundle = await build({ stdin: { contents: `
    import production, {RestoreJournal} from './src/worker.mjs';
    export class FixtureJournal extends RestoreJournal {
      constructor(ctx,env){
        const fault={at:0};
        const storage={transaction(callback){return ctx.storage.transaction(async txn=>{
          let writes=0;
          return callback({get:(...args)=>txn.get(...args),list:(...args)=>txn.list(...args),
            put:async values=>{await txn.put(values);if(++writes===fault.at)throw new Error('synthetic SQLite transaction fault');}});
        });}};
        super({storage},env);this.fixtureFault=fault;
      }
      async fetch(request){
        this.fixtureFault.at=Number(request.headers.get('x-fixture-put-fault')??'0');
        try{return await super.fetch(request);}finally{this.fixtureFault.at=0;}
      }
    }
    export default {fetch(request,env){return production.fetch(request,{...env,
      RESTORE_JOURNAL:{jurisdiction(region){if(region!=='eu')throw new Error('wrong jurisdiction');return env.RESTORE_JOURNAL;}}});}};
  `, resolveDir: new URL('../', import.meta.url).pathname, sourcefile: 'local-operation-fault-fixture.mjs' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent' });
  const options = { name: 'lovelies-operation-journal-qualification', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-07-21', durableObjects: { RESTORE_JOURNAL: { className: 'FixtureJournal', useSQLite: true } },
    durableObjectsPersist: directory, bindings: env };
  let mf;
  try {
    const open = async () => { mf = new Miniflare(options); await mf.ready; };
    const restart = async () => { await mf.dispose(); mf = undefined; await open(); };
    const send = async (pathname, body, status = 200, headers = {}) => {
      const response = await mf.dispatchFetch('https://journal.invalid' + pathname, { method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: 'Bearer ' + env.RESTORE_JOURNAL_TOKEN, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value));
      assert.match(response.headers.get('cache-control'), /no-store/); return value;
    };
    await open();
    await send('/v1/control/bootstrap', input({ database_id: randomUUID(), bootstrap_id: randomUUID() }), 401, { authorization: 'Bearer incorrect-secret' });
    await send('/v1/control', undefined, 409);
    const bootstrap = input({ database_id: randomUUID(), bootstrap_id: randomUUID() });
    const bound = await send('/v1/control/bootstrap', bootstrap), initial = bound.control.marker;
    assert.deepEqual(initial.cursor, { sequence: 0, hash: GENESIS_HASH });
    await restart();
    assert.deepEqual(await send('/v1/control/bootstrap', bootstrap), bound);
    await send('/v1/admission', input({ marker: initial }));

    // A real SQLite transaction writes one receipt, then faults during the next
    // write. No plan, event, prepare index or pending fence may survive.
    const failed = prepare(initial, [event(), event()]);
    await send('/v1/operations/prepare', failed, 503, { 'x-fixture-put-fault': '2' });
    assert.deepEqual((await send('/v1/head')).head, initial.cursor);
    assert.deepEqual((await send('/v1/control')).control, bound.control);
    await send('/v1/operations/' + failed.operation_id, undefined, 404);
    await restart();
    assert.deepEqual((await send('/v1/head')).head, initial.cursor);

    const raw = prepare(initial, [event(), event()]);
    // Drop a successful prepare response. The durable lookup retains all IDs.
    await send('/v1/operations/prepare', raw);
    await restart();
    const recovered = await send('/v1/operations/' + raw.operation_id), operation = recovered.operation;
    assert.equal(operation.status, 'pending'); assert.deepEqual(operation.plan.allocations, raw.allocations);
    assert.deepEqual(operation.plan.events, raw.events); assert.equal(operation.plan.receipts.length, 2);
    assert.equal((await send('/v1/head')).head.sequence, 2);
    const duplicates = await Promise.all(Array.from({ length: 6 }, () => send('/v1/operations/prepare', raw)));
    assert(duplicates.every(value => value.operation.plan_hash === operation.plan_hash));
    await send('/v1/operations/prepare', { ...raw, allocations: { ...raw.allocations, id_0: randomUUID() } }, 409);
    for (const marker of [initial, operation.plan.next]) {
      assert.deepEqual(await send('/v1/admission', input({ marker }), 409), { error: 'operation_pending' });
    }
    assert.equal((await send('/v1/control')).control.state, 'pending');

    // An actual SQLite failure after writing the commit record cannot expose a
    // serving checkpoint; replay the exact acknowledgement after restart.
    await send('/v1/operations/' + raw.operation_id + '/acknowledge', ack(operation), 503, { 'x-fixture-put-fault': '1' });
    await restart();
    assert.equal((await send('/v1/operations/' + raw.operation_id)).operation.status, 'pending');
    const committed = await send('/v1/operations/' + raw.operation_id + '/acknowledge', ack(operation));
    await restart();
    assert.deepEqual(await send('/v1/operations/' + raw.operation_id + '/acknowledge', ack(operation)), committed);
    await send('/v1/admission', input({ marker: operation.plan.next }));

    const noEvent = prepare(operation.plan.next), empty = (await send('/v1/operations/prepare', noEvent)).operation;
    assert.deepEqual(empty.plan.next.cursor, operation.plan.next.cursor); assert.deepEqual(empty.plan.receipts, []);
    assert.equal(empty.plan.next.checkpoint.revision, 2);
    await send('/v1/operations/' + noEvent.operation_id + '/acknowledge', ack(empty));
    await restart();
    await send('/v1/admission', input({ marker: empty.plan.next }));

    // A same-schema database rollback is represented by the old marker. Its
    // quarantine survives DO restart, bootstrap and a historical commit retry.
    await send('/v1/admission', input({ marker: initial }), 409);
    await restart();
    assert.equal((await send('/v1/control')).control.state, 'quarantined');
    assert.equal((await send('/v1/control/bootstrap', bootstrap)).control.state, 'quarantined');
    assert.equal((await send('/v1/operations/' + raw.operation_id + '/acknowledge', ack(operation))).control.state, 'quarantined');
    await send('/v1/admission', input({ marker: empty.plan.next }), 409);

    const recoveryInput = input({ recovery_id: randomUUID(), expected: empty.plan.next });
    const recovery = await send('/v1/recovery/begin', recoveryInput);
    assert.equal(recovery.recovery.reason, 'marker_mismatch');
    assert.notEqual(recovery.recovery.incarnation_id, initial.incarnation_id);
    await restart();
    assert.deepEqual(await send('/v1/recovery/begin', recoveryInput), recovery);
    await send('/v1/recovery/begin', { ...recoveryInput, recovery_id: randomUUID() }, 409);
    await send('/v1/recovery/complete', { approved: true }, 404);
    assert.equal((await send('/v1/events?after=0&limit=100')).events.length, 2);

    // A separate real SQLite journal starts in event-only mode. Binding its
    // nonzero head must preserve its facts and never certify PostgreSQL replay.
    await mf.dispose(); mf = undefined;
    options.durableObjectsPersist = path.join(directory, 'prebinding-facts');
    await open();
    const prior = event(), priorReceipt = (await send('/v1/events', prior)).receipt;
    const nonzeroBootstrap = input({ database_id: randomUUID(), bootstrap_id: randomUUID() });
    const nonzero = await send('/v1/control/bootstrap', nonzeroBootstrap);
    assert.equal(nonzero.control.state, 'quarantined');
    assert.deepEqual(nonzero.control.marker.cursor, { sequence: priorReceipt.sequence, hash: priorReceipt.hash });
    await restart();
    assert.deepEqual(await send('/v1/control/bootstrap', nonzeroBootstrap), nonzero);
    await send('/v1/admission', input({ marker: nonzero.control.marker }), 409);
    await send('/v1/operations/prepare', prepare(nonzero.control.marker), 409);
    assert.deepEqual((await send('/v1/events', prior)).receipt, priorReceipt);
    assert.deepEqual((await send('/v1/events?after=0&limit=100')).events, [priorReceipt]);
    const nonzeroRecovery = await send('/v1/recovery/begin', input({ recovery_id: randomUUID(), expected: nonzero.control.marker }));
    assert.equal(nonzeroRecovery.recovery.reason, 'preexisting_restrictions');
    assert.equal(nonzeroRecovery.control.state, 'quarantined');
  } finally { await mf?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
