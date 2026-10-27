import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHandler } from '../src/index.ts';

function stalledRequest(path, origin) {
  let cancellations = 0;
  const body = new ReadableStream({ cancel() { cancellations++; return new Promise(() => {}); } });
  const request = new Request('https://api.invalid' + path, { method: 'POST', body, duplex: 'half',
    ...(origin ? { headers: { origin } } : {}) });
  return { request, cancellations: () => cancellations };
}
function context() {
  return { db: { invocation: async callback => callback() }, env: {}, now: Date.now };
}

for (const [path, origin, expected] of [['/_internal/missing', undefined, 404], ['/anything', 'https://untrusted.invalid', 403]]) {
  test(`uncooperative request-body cancellation cannot stall a ${expected} response`, async () => {
    const input = stalledRequest(path, origin), pending = createHandler(context())(input.request);
    const response = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve(null), 500))]);
    assert(response, 'API response must not depend on an unsettled cancellation promise');
    assert.equal(response.status, expected); assert.equal(input.cancellations(), 1);
    assert.equal(response.headers.get('cache-control'), 'no-store, private');
  });
}

test('final invocation failure returns its error without releasing a stale response or waiting for its cancellation', async () => {
  let cancellations = 0;
  const privateBody = new ReadableStream({ cancel() { cancellations++; return new Promise(() => {}); } });
  const ctx = context();
  ctx.db.invocation = async callback => {
    const response = await callback();
    Object.defineProperty(response, 'body', { value: privateBody });
    throw new Error('synthetic final admission failure');
  };
  const pending = createHandler(ctx)(new Request('https://api.invalid/_internal/missing'));
  const response = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve(null), 500))]);
  assert(response, 'error response must not wait for private-body cancellation');
  assert.equal(response.status, 500); assert.deepEqual(await response.json(), { error: { code: 'internal_error' } });
  assert.equal(cancellations, 1); assert.equal(response.headers.get('cache-control'), 'no-store, private');
});

for (const mode of ['locked', 'throws', 'rejects']) {
  test(`final invocation failure remains private when response cancellation ${mode}`, async () => {
    let cancellations = 0;
    const privateBody = new ReadableStream();
    const reader = mode === 'locked' ? privateBody.getReader() : null;
    if (mode !== 'locked') Object.defineProperty(privateBody, 'cancel', { value() {
      cancellations++;
      if (mode === 'throws') throw new Error('synthetic cancellation error');
      return Promise.reject(new Error('synthetic cancellation rejection'));
    } });
    const ctx = context();
    ctx.db.invocation = async callback => {
      const response = await callback(); Object.defineProperty(response, 'body', { value: privateBody });
      throw new Error('synthetic final admission failure');
    };
    try {
      const response = await createHandler(ctx)(new Request('https://api.invalid/_internal/missing'));
      assert.equal(response.status, 500); assert.deepEqual(await response.json(), { error: { code: 'internal_error' } });
      assert.equal(cancellations, mode === 'locked' ? 0 : 1);
      await new Promise(resolve => setImmediate(resolve));
    } finally { reader?.releaseLock(); }
  });
}
