/** Unexecuted owned PGlite/Memory-transport candidate; no network or provider. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { SupabasePrivateBucket } from '../src/storage.ts';
import { flushPrivacyCleanup } from '../src/privacy.ts';
import { startHarness, closeHarnesses } from './runtime-harness.mjs';

const pgliteTest=process.env.TEST_DATABASE_URL===undefined?test:test.skip;
after(closeHarnesses);
const origin = 'http://127.0.0.1:1', secret = 'synthetic-cleanup-fixture', key = 'owned-only/status-fixture';
const missing = { statusCode: '404', error: 'not_found', message: 'Object not found', code: 'NoSuchKey' };
const id = () => crypto.randomUUID();

async function setup(t, deleteResponse, headResponse) {
  assert.equal(process.env.TEST_DATABASE_URL, undefined, 'external PostgreSQL is outside this fixture');
  const h = await startHarness({ consumeQueue: false });
  t.after(() => h.close());
  const owner = await h.anonymous(), cleanup = id(), calls = [];
  await h.db.transaction(async () => {
    await h.db.run("INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at,settled_at) VALUES(?,?,'QUARANTINE',?,'settled',?,?)", id(), owner.account_id, key, Date.now(), Date.now());
    await h.db.run("INSERT INTO cleanup_intents(id,subject_id,bucket,object_key,status,created_at) VALUES(?,?,'QUARANTINE',?,'pending',?)", cleanup, owner.account_id, key, Date.now());
  });
  const transport = async (input, init = {}) => {
    const url = new URL(String(input)), method = (init.method ?? 'GET').toUpperCase();
    assert.equal(url.origin, origin); assert.equal(url.search, '');
    const headers = new Headers(init.headers); assert.equal(headers.get('apikey'), secret); assert.equal(headers.get('authorization'), null);
    let response;
    if (method === 'DELETE' && url.pathname === '/storage/v1/object/lovelies-quarantine') {
      assert.deepEqual(JSON.parse(String(init.body)), { prefixes: [key] }); response=deleteResponse();
    } else if (method === 'GET' && url.pathname === '/storage/v1/object/info/lovelies-quarantine/' + key) {
      response=headResponse();
    } else throw Error('unexpected synthetic storage request');
    assert(response instanceof Response, 'fixture must construct the response before recording the call');
    calls.push({ method, path: url.pathname, status: response.status });
    return response;
  };
  h.env.QUARANTINE = new SupabasePrivateBucket(origin, secret, 'lovelies-quarantine', transport);
  return { h, cleanup, calls };
}
async function run(f) {
  await f.h.db.invocation(() => flushPrivacyCleanup(f.h.app));
  const result = await f.h.db.one('SELECT status,verified_at FROM cleanup_intents WHERE id=?', f.cleanup);
  assert(result); return result;
}

pgliteTest('an unknown DELETE 404 never yields a verified cleanup receipt', { timeout: 60000 }, async t => {
  const f = await setup(t, () => new Response(null, { status: 404 }), () => Response.json(missing, { status: 400 }));
  const result = await run(f);
  assert.notEqual(result.status, 'verified'); assert.equal(result.verified_at, null);
  assert.deepEqual(f.calls, [{method:'DELETE',path:'/storage/v1/object/lovelies-quarantine',status:404}]);
});

pgliteTest('an unknown info 404 after synthetic DELETE 200 never yields a verified cleanup receipt', { timeout: 60000 }, async t => {
  const f = await setup(t, () => Response.json([], { status: 200 }), () => new Response(null, { status: 404 }));
  const result = await run(f);
  assert.notEqual(result.status, 'verified'); assert.equal(result.verified_at, null);
  assert.deepEqual(f.calls, [{method:'DELETE',path:'/storage/v1/object/lovelies-quarantine',status:200},{method:'GET',path:'/storage/v1/object/info/lovelies-quarantine/'+key,status:404}]);
});

pgliteTest('the modeled DELETE 200 and exact observed NoSuchKey response retain the local bookkeeping control', { timeout: 60000 }, async t => {
  const f = await setup(t, () => Response.json([], { status: 200 }), () => Response.json(missing, { status: 400 }));
  const result = await run(f);
  assert.equal(result.status, 'verified'); assert.notEqual(result.verified_at, null);
  assert.deepEqual(f.calls, [{method:'DELETE',path:'/storage/v1/object/lovelies-quarantine',status:200},{method:'GET',path:'/storage/v1/object/info/lovelies-quarantine/'+key,status:400}]);
  // This assertion concerns application bookkeeping in a stub only; it does not
  // establish provider completion, true absence or backing-blob deletion.
});
