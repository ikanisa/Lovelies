/** Unexecuted in-memory HTTP status regressions. No socket or provider access. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SupabasePrivateBucket } from '../src/storage.ts';

const origin = 'http://127.0.0.1:1';
const fixtureKey = 'owned-only/synthetic.png';
const fixtureSecret = 'synthetic-storage-fixture';
const missing = Object.freeze({ statusCode: '404', error: 'not_found', message: 'Object not found', code: 'NoSuchKey' });
const noBucket = Object.freeze({ statusCode: '404', error: 'Bucket not found', message: 'Bucket not found', code: 'NoSuchBucket' });
const missingResponse = () => Response.json(missing, { status: 400 });
const unavailable = async operation => assert.rejects(operation, error => error instanceof Error && error.status === 503);
const infoPath = '/storage/v1/object/info/lovelies-photos/' + fixtureKey;
const getPath = '/storage/v1/object/authenticated/lovelies-photos/' + fixtureKey;
const putPath = '/storage/v1/object/lovelies-photos/' + fixtureKey;
const deletePath = '/storage/v1/object/lovelies-photos';
const present = () => Response.json({ size: 3, etag: 'fixture-version', metadata: {} });

function fixture(steps) {
  const calls = [];
  const fetcher = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    assert.equal(url.origin, origin);
    assert.equal(url.search, '');
    assert.equal(url.hash, '');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('apikey'), fixtureSecret);
    assert.equal(headers.get('authorization'), null);
    const step = steps[calls.length];
    assert(step, 'unexpected synthetic request');
    assert.equal(method, step.method);
    assert.equal(url.pathname, step.path);
    if (method === 'DELETE') assert.deepEqual(JSON.parse(String(init.body)), { prefixes: [fixtureKey] });
    if (method === 'POST') assert.equal(headers.get('x-upsert'), 'false');
    calls.push({ method, path: url.pathname });
    return step.response();
  };
  const bucket = new SupabasePrivateBucket(origin, fixtureSecret, 'lovelies-photos', fetcher);
  return { bucket, calls, done: () => assert.equal(calls.length, steps.length) };
}
const step = (method, path, response) => ({ method, path, response });
const badNative404 = [
  ['empty', () => new Response(null, { status: 404 })],
  ['generic JSON', () => Response.json({ message: 'Not Found' }, { status: 404 })],
  ['HTML route error', () => new Response('<html>Not Found</html>', { status: 404, headers: { 'content-type': 'text/html' } })],
  ['NoSuchBucket', () => Response.json(noBucket, { status: 404 })],
  // Native 404 with this body is not among the observed hosted 400 cases.
  ['unqualified NoSuchKey status', () => Response.json(missing, { status: 404 })],
];

test('the observed info envelope and modeled authenticated-read envelope denote missing objects', async () => {
  const info = fixture([step('GET', infoPath, missingResponse)]);
  assert.equal(await info.bucket.head(fixtureKey), null); info.done();
  const initial = fixture([step('GET', infoPath, missingResponse)]);
  assert.equal(await initial.bucket.get(fixtureKey), null); initial.done();
  const raced = fixture([step('GET', infoPath, present), step('GET', getPath, missingResponse)]);
  assert.equal(await raced.bucket.get(fixtureKey), null); raced.done();
});

test('unknown native 404 on object info does not establish absence', async () => {
  for (const [label, response] of badNative404) {
    const f = fixture([step('GET', infoPath, response)]);
    await unavailable(() => f.bucket.head(fixtureKey)); f.done();
    assert.equal(f.calls.length, 1, label);
  }
});

test('unknown native 404 after a successful info read does not establish absence', async () => {
  for (const [label, response] of badNative404) {
    const f = fixture([step('GET', infoPath, present), step('GET', getPath, response)]);
    await unavailable(() => f.bucket.get(fixtureKey)); f.done();
    assert.equal(f.calls.length, 2, label);
  }
});

test('NoSuchBucket, authentication and mismatched errors never become object absence', async () => {
  const replies = [
    () => Response.json(noBucket, { status: 400 }),
    () => Response.json({ ...missing, code: 'InvalidJWT' }, { status: 400 }),
    () => Response.json(missing, { status: 401 }),
    () => Response.json(missing, { status: 403 }),
    () => Response.json(missing, { status: 500 }),
  ];
  for (const response of replies) {
    const f = fixture([step('GET', infoPath, response)]);
    await unavailable(() => f.bucket.head(fixtureKey)); f.done();
  }
});

test('all non-success POST statuses, including 404, fail rather than acknowledge a write', async () => {
  for (let status = 300; status <= 599; status++) {
    const f = fixture([step('POST', putPath, () => new Response(null, { status }))]);
    await unavailable(() => f.bucket.put(fixtureKey, new Uint8Array([1, 2, 3]))); f.done();
  }
});

test('all non-success DELETE statuses, including 404, fail rather than acknowledge deletion', async () => {
  for (let status = 300; status <= 599; status++) {
    const f = fixture([step('DELETE', deletePath, () => new Response(null, { status }))]);
    await unavailable(() => f.bucket.delete(fixtureKey)); f.done();
  }
  for (const [label, response] of badNative404) {
    const f = fixture([step('DELETE', deletePath, response)]);
    await unavailable(() => f.bucket.delete(fixtureKey)); f.done();
    assert.equal(f.calls.length, 1, label);
  }
});

test('the object-read missing envelope cannot acknowledge a write or delete', async () => {
  for (const [method, path, operation] of [
    ['POST', putPath, b => b.put(fixtureKey, new Uint8Array([1]))],
    ['DELETE', deletePath, b => b.delete(fixtureKey)],
  ]) {
    for (const status of [400, 404]) {
      const f = fixture([step(method, path, () => Response.json(missing, { status }))]);
      await unavailable(() => operation(f.bucket)); f.done();
    }
  }
});

test('successful info and authenticated read controls return the synthetic bytes', async () => {
  const f = fixture([
    step('GET', infoPath, present),
    step('GET', getPath, () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { etag: '"fixture-version"' } })),
  ]);
  const object = await f.bucket.get(fixtureKey);
  assert(object); assert.equal(object.size, 3); assert.deepEqual([...new Uint8Array(await object.arrayBuffer())], [1, 2, 3]); f.done();
});

test('successful write and delete responses retain the existing adapter control behavior', async () => {
  const f = fixture([
    step('POST', putPath, () => Response.json({ Key: 'lovelies-photos/' + fixtureKey }, { status: 200 })),
    step('DELETE', deletePath, () => Response.json([], { status: 200 })),
  ]);
  await f.bucket.put(fixtureKey, new Uint8Array([1, 2, 3]));
  await f.bucket.delete(fixtureKey); f.done();
  // This stub proves only local status handling. It has no physical Storage effect.
});

test('redirects and transport rejection cannot report missing or successful deletion', async () => {
  for (const [method, path, operation] of [
    ['GET', infoPath, b => b.head(fixtureKey)],
    ['POST', putPath, b => b.put(fixtureKey, new Uint8Array([1]))],
    ['DELETE', deletePath, b => b.delete(fixtureKey)],
  ]) {
    const redirected = fixture([step(method, path, () => new Response(null, { status: 302, headers: { location: 'https://example.invalid/' } }))]);
    await assert.rejects(() => operation(redirected.bucket), error => error?.status === 503 && error?.code === 'storage_redirect_denied');
    redirected.done();
    const failed = fixture([step(method, path, () => { throw Error('synthetic transport failure'); })]);
    await assert.rejects(() => operation(failed.bucket)); failed.done();
  }
});


test('error and redirect handling never waits for or trusts response cancellation', async () => {
  for (const mode of ['throw', 'reject', 'hang']) {
    for (const [method, path, operation, status, expected] of [
      ['GET', infoPath, b => b.head(fixtureKey), 404, 'private_storage_unavailable'],
      ['DELETE', deletePath, b => b.delete(fixtureKey), 404, 'private_storage_unavailable'],
      ['POST', putPath, b => b.put(fixtureKey, new Uint8Array([1])), 404, 'private_storage_write_failed'],
      ['GET', infoPath, b => b.head(fixtureKey), 302, 'storage_redirect_denied'],
    ]) {
      let cancelled=0,timer;
      const response=new Response(null,{status});
      Object.defineProperty(response,'body',{value:{cancel(){
        cancelled++;
        if(mode==='throw')throw Error('synthetic synchronous cancellation failure');
        if(mode==='reject')return Promise.reject(Error('synthetic cancellation rejection'));
        return new Promise(()=>{});
      }}});
      const f=fixture([step(method,path,()=>response)]);
      try {
        const outcome=await Promise.race([operation(f.bucket).then(()=>({success:true}),error=>({error})),
          new Promise(resolve=>{timer=setTimeout(()=>resolve({deadline:true}),1000);})]);
        assert.notEqual(outcome.deadline,true,mode+' cancellation must not delay failure');
        assert.equal(outcome.error?.status,503);assert.equal(outcome.error?.code,expected);
        assert.equal(cancelled,1);f.done();
      } finally { clearTimeout(timer); }
    }
  }
});
