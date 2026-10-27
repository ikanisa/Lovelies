import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { env, id, v2, putInput, operationInput, linkInput, deleteInput, PROJECT_ID, canonical, sha256 } from './inventory-fixtures.mjs';
import { event } from './fixtures.mjs';
import { legacySources, legacySha256 } from './inventory-v1-worker.fixture.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
const { Miniflare } = require('miniflare'), { build } = require('esbuild');
const input = fields => ({ version: 1, project_id: PROJECT_ID, ...fields });

test('actual Worker SQLite DO preserves inventory across actual old-worker rollback, faults and restarts', { timeout: 120000 }, async () => {
  // Local-only generated wrapper: EU selection shim plus native transaction and
  // after-commit response faults. Production imports expose none of these headers.
  const bundle = await build({ stdin: { contents: `
    import production, {RestoreJournal} from './src/worker.mjs';
    export class InventoryFixture extends RestoreJournal {
      constructor(ctx,env){
        const fault={at:0,gap:false,abort:null,release:null,transaction:null};
        const storage={transaction(callback){const pending=ctx.storage.transaction(async txn=>{
          let writes=0;const result=await callback({get:(...args)=>txn.get(...args),list:(...args)=>txn.list(...args),
            put:async values=>{await txn.put(values);if(++writes===fault.at)throw new Error('synthetic inventory SQLite rollback');}});
          if(fault.gap&&writes>0){
            fault.gap=false;
            const gap=new Promise(resolve=>{fault.release=resolve;});
            // The complete production callback and its final gate check have
            // returned; the wrapper still holds the actual native callback.
            fault.abort();await gap;
          }
          return result;
        });fault.transaction=pending;pending.catch(()=>{});return pending;}};
        super({storage},env);this.fixtureFault=fault;
      }
      async fetch(request){
        const fault=this.fixtureFault;fault.at=Number(request.headers.get('x-fixture-put-fault')??'0');
        const gap=request.headers.get('x-fixture-final-check-commit-gap')==='yes';
        let productionRequest=request;
        if(gap){const controller=new AbortController();fault.gap=true;fault.abort=()=>controller.abort();
          productionRequest=new Request(request,{signal:controller.signal});}
        try{
          const reply=await super.fetch(productionRequest);
          if(gap){
            if(!fault.release)throw new Error('Native commit gap was not reached');
            // Production returned a cancellation error without being able to
            // cancel the native commit. Release only now, then require commit.
            const failed=reply.status!==200;fault.release();await fault.transaction;
            return new Response(JSON.stringify({...await reply.json(),fixture_gap_reached:true,
              fixture_production_failed_before_native_commit:failed,fixture_native_commit_completed:true}),{status:reply.status});
          }
          if(reply.status===200&&request.headers.get('x-fixture-drop-reply')==='yes')
            return new Response(JSON.stringify({error:'synthetic_reply_lost_after_commit'}),{status:503});return reply;
        }finally{fault.at=0;fault.gap=false;fault.abort=null;fault.release?.();fault.release=null;fault.transaction=null;}
      }
    }
    export default {fetch(request,env){return production.fetch(request,{...env,
      RESTORE_JOURNAL:{jurisdiction(region){if(region!=='eu')throw new Error('wrong jurisdiction');return env.RESTORE_JOURNAL;}}});}};
  `, resolveDir: new URL('../', import.meta.url).pathname, sourcefile: 'local-inventory-native-fault.mjs' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent' });
  for (const [name, source] of Object.entries(legacySources)) assert.equal(await sha256(source), legacySha256[name], name);
  const legacyBundle = await build({ stdin: { contents: `
    import original, {RestoreJournal} from 'legacy:worker.mjs';
    export {RestoreJournal as InventoryFixture};
    export default {fetch(request,env){return original.fetch(request,{...env,
      RESTORE_JOURNAL:{jurisdiction(region){if(region!=='eu')throw new Error('wrong jurisdiction');return env.RESTORE_JOURNAL;}}});}};
  `, sourcefile: 'actual-unmodified-v1-worker-rollback.mjs' },
    plugins: [{ name: 'exact-pre-inventory-source', setup(builder) {
      builder.onResolve({ filter: /^legacy:/ }, args => ({ path: args.path.slice(7), namespace: 'frozen-v1' }));
      builder.onResolve({ filter: /^\.\//, namespace: 'frozen-v1' }, args => ({ path: args.path.slice(2), namespace: 'frozen-v1' }));
      builder.onLoad({ filter: /.*/, namespace: 'frozen-v1' }, args => {
        if (!Object.hasOwn(legacySources, args.path)) throw Error('Unexpected legacy source dependency');
        return { contents: legacySources[args.path], loader: 'js' };
      });
    } }], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent' });
  const directory = await mkdtemp(path.join(tmpdir(), 'lovelies-inventory-journal-'));
  const config = { name: 'lovelies-write-inventory-local-qualification', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-07-21', durableObjects: { RESTORE_JOURNAL: { className: 'InventoryFixture', useSQLite: true } },
    durableObjectsPersist: directory, bindings: { ...env, RESTORE_INVENTORY_PAGE_LIMIT: '32' } };
  let mf;
  const open = async (script = config.script) => { mf = new Miniflare({ ...config, script }); await mf.ready; };
  const restart = async (script = config.script) => { await mf.dispose(); mf = undefined; await open(script); };
  const send = async (pathname, value, status = 200, headers = {}) => {
    const reply = await mf.dispatchFetch('https://journal.invalid' + pathname, { method: value === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer ' + env.RESTORE_JOURNAL_TOKEN, ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(value === undefined ? {} : { body: pathname.startsWith('/v2/') ? canonical(value) : JSON.stringify(value) }) });
    const result = await reply.json(); assert.equal(reply.status, status, JSON.stringify(result)); return result;
  };
  const state = { control: null };
  const prepare = async (raw, headers = {}, status = 200) => send('/v2/operations/prepare', raw, status, headers);
  const commit = async operation => { const r = await send(`/v2/operations/${operation.plan.operation_id}/acknowledge`, v2({ marker: operation.plan.next,
    plan_hash: operation.plan_hash, writer_generation_id: operation.plan.writer_generation_id })); state.control = r.control; return r; };
  try {
    await open();
    const bound = await send('/v1/control/bootstrap', input({ database_id: id(), bootstrap_id: id() }));
    // Hash exactly the stored v1 control shape, not the deliberately smaller v1 HTTP view.
    const old = { version: 1, project_id: PROJECT_ID, binding_hash: bound.binding.binding_hash, state: 'serving', marker: bound.control.marker,
      pending_operation_id: null, recovery_generation_id: null, quarantine: null };
    const upgrade = v2({ upgrade_id: id(), expected: old.marker, expected_control_hash: await sha256(canonical(old)), coverage_anchor_hash: 'b'.repeat(64) });
    state.control = (await send('/v2/control/upgrade', upgrade)).control; await restart();
    // Controlled real SQLite case: the production callback's final check has
    // returned, cancellation makes production return503, then the wrapper lets
    // the native callback finish and its complete transaction really commit.
    const gapInput=putInput(state);
    const gapReply=await prepare(gapInput,{'x-fixture-final-check-commit-gap':'yes'},503);
    assert.equal(gapReply.fixture_gap_reached,true);assert.equal(gapReply.fixture_production_failed_before_native_commit,true);
    assert.equal(gapReply.fixture_native_commit_completed,true);await restart();
    const gapOperation=(await send('/v2/operations/'+gapInput.operation_id)).operation;
    assert.equal(gapOperation.status,'pending');assert.deepEqual(gapOperation.plan.resources,gapInput.resources);await commit(gapOperation);
    const beforeRollback = structuredClone((await send('/v2/control')).control);
    // Same worker name, DO export name/binding, object name and persistence
    // directory; only the script is the exact original v1 Worker/class bundle.
    await restart(legacyBundle.outputFiles[0].text);
    await send('/v1/control', undefined, 503);
    await send('/v1/admission', input({ marker: state.control.marker }), 503);
    await send('/v1/control/bootstrap', input({ database_id: id(), bootstrap_id: id() }), 503);
    await send('/v1/operations/prepare', input({ operation_id: id(), input_hash: 'd'.repeat(64), expected: state.control.marker, allocations: {}, events: [] }), 503);
    await send('/v1/recovery/begin', input({ recovery_id: id(), expected: state.control.marker }), 503);
    await send('/v1/events', event(), 409);
    await restart(); assert.deepEqual((await send('/v2/control')).control, beforeRollback);
    await send('/v1/admission', input({ marker: state.control.marker }), 409);
    const beforeFaultSequence=state.control.registration_head.sequence;
    const raw = putInput(state); raw.events = [event(), event()];
    await prepare(raw, { 'x-fixture-put-fault': '2' }, 503); await restart();
    assert.equal((await send('/v2/control')).control.registration_head.sequence, beforeFaultSequence);
    await send('/v2/operations/' + raw.operation_id, undefined, 404);

    // Drop the response after actual SQLite commit; lookup must retain the
    // complete pending plan/record/IDs, with no callback reconstruction.
    await prepare(raw, { 'x-fixture-drop-reply': 'yes' }, 503); await restart();
    const first = (await send('/v2/operations/' + raw.operation_id)).operation;
    assert.equal(first.status, 'pending'); assert.equal(first.plan.inventory_receipts.length, 1); assert.equal(first.plan.resources[0].write_id, raw.allocations.id_0);
    assert.equal((await prepare(raw)).operation.plan_hash, first.plan_hash);
    await send(`/v2/operations/${raw.operation_id}/acknowledge`, v2({ marker: first.plan.next, plan_hash: first.plan_hash,
      writer_generation_id: first.plan.writer_generation_id }), 503, { 'x-fixture-put-fault': '1' });
    await restart(); assert.equal((await send('/v2/operations/' + raw.operation_id)).operation.status, 'pending'); await commit(first);

    const target = { item: raw.resources[0], operation: first }, publishInput = await linkInput(state, target);
    const publication = (await prepare(publishInput)).operation; await commit(publication);
    const observation = v2({ observation_id: id(), write_id: target.item.write_id, registration_hash: first.plan.inventory_receipts[0].hash,
      plan_hash: first.plan_hash, kind: 'publication', result: { publication_operation_id: publication.plan.operation_id, publication_plan_hash: publication.plan_hash } });
    const observed = await send('/v2/inventory/observations', observation); state.control = observed.control;
    const pendingInput = operationInput(state), pending = (await prepare(pendingInput)).operation;
    const late = { ...observation, observation_id: id(), kind: 'put-reply', result: { outcome: 'unknown', http_status: null, evidence_hash: 'c'.repeat(64) } };
    const latest = await send('/v2/inventory/observations', late); await commit(pending);
    assert.deepEqual(state.control.observation_head, latest.control.observation_head); await restart();

    const disposableInput = putInput(state), disposable = (await prepare(disposableInput)).operation; await commit(disposable);
    const disposableTarget = { item: disposableInput.resources[0], operation: disposable }, removal = await deleteInput(state, disposableTarget);
    await prepare(removal, { 'x-fixture-drop-reply': 'yes' }, 503); await restart();
    const retired = (await send('/v2/operations/' + removal.operation_id)).operation;
    assert.equal(retired.status, 'pending'); await commit(retired);
    await prepare(await linkInput(state, disposableTarget), {}, 409);
    const deniedDispatch = v2({ marker: state.control.marker, writer_generation_id: state.control.writer_generation_id,
      write_id: disposableTarget.item.write_id, descriptor_hash: await sha256(canonical(disposableTarget.item)), plan_hash: disposable.plan_hash });
    await send('/v2/inventory/dispatch-admission', deniedDispatch, 409); await restart();

    const recover = v2({ recovery_id: id(), cut_id: id(), expected: state.control.marker, writer_generation_id: state.control.writer_generation_id });
    const begun = await send('/v2/recovery/begin', recover); state.control = begun.control; await restart();
    const progressPath = `/v2/recovery/${recover.recovery_id}/enumeration-progress`;
    const select = async chain => {
      const progress = await send(progressPath + '?chain=' + chain);
      const q = new URLSearchParams({ cut_id: progress.active_cut.cut_id, after_sequence: String(progress.progress.state.cursor.sequence), after_hash: progress.progress.state.cursor.hash, limit: '1' });
      const page = await send(`/v2/recovery/${recover.recovery_id}/inventory/${chain}?` + q);
      return v2({ recovery_id: recover.recovery_id, recovery_generation_id: page.recovery_generation_id, chain, cut_id: page.cut_id, cut_hash: page.cut_hash,
        expected_state_hash: progress.progress.state_hash, after: page.after, limit: 1, page_hash: page.page_hash, next: page.next });
    };
    const a = await select('observations');
    await send(progressPath, a, 503, { 'x-fixture-put-fault': '1' }); await restart();
    assert.equal((await send(progressPath + '?chain=observations')).progress.state.cursor.sequence, 0);
    await send(progressPath, a, 503, { 'x-fixture-drop-reply': 'yes' }); await restart();
    assert.equal((await send(progressPath + '?chain=observations')).progress.state.cursor.sequence, 1);
    await send(progressPath, a); const b = await select('observations'); const accepted = await send(progressPath, b); await restart();
    await send(progressPath, a, 409); assert.equal((await send(progressPath + '?chain=observations')).progress.state_hash, accepted.progress.state_hash);

    const r = await send(progressPath + '?chain=registrations'), o = await send(progressPath + '?chain=observations');
    const cutInput = v2({ recovery_id: recover.recovery_id, cut_id: id(), expected_parent_cut_id: r.active_cut.cut_id, expected_parent_cut_hash: r.active_cut.cut_hash,
      expected_progress: { registrations: r.progress.state_hash, observations: o.progress.state_hash }, carry_prefix: { registrations: true, observations: true } });
    await send(`/v2/recovery/${recover.recovery_id}/cuts`, cutInput, 503, { 'x-fixture-drop-reply': 'yes' }); await restart();
    const carried = await send(`/v2/recovery/${recover.recovery_id}/cuts`, cutInput); assert.equal(carried.immutable_evidence_only, true);
    assert.equal((await send(progressPath + '?chain=observations')).progress.state.cursor.sequence, 2); await send(progressPath, b, 409);
    const final = await send('/v2/control'); assert.equal(final.control.state, 'quarantined'); assert.equal(final.clearance_available, false);
    await send('/v2/clear', v2({}), 404); await send('/v2/control/upgrade', upgrade); assert.equal((await send('/v2/control')).control.state, 'quarantined');
  } finally { if (mf) await mf.dispose(); await rm(directory, { recursive: true, force: true }); }
});
