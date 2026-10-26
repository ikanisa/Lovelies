import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { env, ids, event } from './fixtures.mjs';
import { GENESIS_HASH, canonical, sha256 } from '../src/journal.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
const { Miniflare } = require('miniflare');
const { build } = require('esbuild');

test('actual Worker/SQLite DO with explicit local EU-selector seam preserves concurrent append and restart replay', { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lovelies-independent-journal-'));
  // workerd explicitly does not implement jurisdiction restrictions. Only this
  // test entrypoint substitutes that selector; the actual Worker, DO class and
  // SQLite persistence remain production code. This cannot prove EU placement.
  const bundle = await build({ stdin: { contents: `
    import production, {RestoreJournal} from './src/worker.mjs';
    export {RestoreJournal};
    const selected=[];
    export default {fetch(request,env){
      if(new URL(request.url).pathname==='/_fixture/selected-jurisdictions')return Response.json(selected);
      return production.fetch(request,{...env,RESTORE_JOURNAL:{jurisdiction(region){
        if(region!=='eu')throw new Error('wrong jurisdiction');
        selected.push(region);return env.RESTORE_JOURNAL;
      }}});
    }};
  `, resolveDir: new URL('../', import.meta.url).pathname, sourcefile: 'local-jurisdiction-fixture.mjs' }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent' });
  const options = { name: 'lovelies-journal-qualification', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-07-21', durableObjects: { RESTORE_JOURNAL: { className: 'RestoreJournal', useSQLite: true } },
    durableObjectsPersist: directory, bindings: env };
  let mf;
  try {
    const open = async () => { mf = new Miniflare(options); await mf.ready; };
    const send = async (pathname, input, authorization = env.RESTORE_JOURNAL_TOKEN, expected = 200) => {
      const response = await mf.dispatchFetch('https://journal.invalid' + pathname, { method: input === undefined ? 'GET' : 'POST',
        headers: { authorization: 'Bearer ' + authorization, ...(input === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value));
      assert.match(response.headers.get('cache-control'), /no-store/); return value;
    };
    await open();
    await send('/v1/events', event(), 'wrong-service-secret', 401);
    assert.deepEqual(await (await mf.dispatchFetch('https://journal.invalid/_fixture/selected-jurisdictions')).json(), []);
    assert.deepEqual((await send('/v1/head')).head, { sequence: 0, hash: GENESIS_HASH });
    const input = event(), duplicates = await Promise.all(Array.from({ length: 12 }, () => send('/v1/events', input)));
    assert(duplicates.every(value => value.receipt.hash === duplicates[0].receipt.hash && value.receipt.sequence === 1));
    await send('/v1/events', { ...input, scope: { ...input.scope, purpose: 'photo_processing' } }, env.RESTORE_JOURNAL_TOKEN, 409);
    await Promise.all(Array.from({ length: 8 }, () => send('/v1/events', event('session-retired', { account_id: ids.account, session_id: crypto.randomUUID() }))));
    let after = 0, previous = GENESIS_HASH, count = 0, lastHead;
    do {
      const page = await send('/v1/events?after=' + after + '&limit=3'); lastHead = page.head;
      for (const receipt of page.events) {
        count++; assert.equal(receipt.sequence, count); assert.equal(receipt.previous_hash, previous);
        assert.equal(receipt.payload_hash, await sha256(canonical(receipt.event))); previous = receipt.hash;
      }
      after = page.next_after;
    } while (after < lastHead.sequence);
    assert.equal(count, 9); assert.equal(previous, lastHead.hash);
    const original = duplicates[0].receipt;
    await mf.dispose(); mf = undefined; await open();
    assert.deepEqual((await send('/v1/head')).head, lastHead);
    assert.deepEqual((await send('/v1/events', input)).receipt, original);
    assert.equal((await send('/v1/head')).head.sequence, 9);
    const independentFacts = await send('/v1/events?after=0&limit=100');
    assert.equal(independentFacts.events.length, 9); assert.equal(Object.hasOwn(independentFacts, 'restore_cleared'), false);
    const selections = await (await mf.dispatchFetch('https://journal.invalid/_fixture/selected-jurisdictions')).json();
    assert(selections.length >= 4 && selections.every(region => region === 'eu'));
  } finally { await mf?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
