import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { handle } from '../src/worker.mjs';

const inputs = new URL('../../../docs/release/website-associations/', import.meta.url);
const cases = [
  ['/.well-known/assetlinks.json', 'assetlinks.json'],
  ['/.well-known/apple-app-site-association', 'apple-app-site-association'],
];

for (const [path, filename] of cases) {
  test(`GET ${path} serves the reviewed association and does not call origin`, async () => {
    const expected = JSON.parse(await readFile(new URL(filename, inputs), 'utf8'));
    const response = await handle(new Request(`https://lovelies.ikanisa.com${path}?review=1`), () => {
      throw new Error('origin must not be called for an association');
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=300');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(await response.json(), expected);
  });

  test(`HEAD ${path} has association headers and no body`, async () => {
    const response = await handle(new Request(`https://lovelies.ikanisa.com${path}`, { method: 'HEAD' }), () => {
      throw new Error('origin must not be called for an association');
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=300');
    assert.equal(await response.text(), '');
  });
}

for (const [label, url, init] of [
  ['unrelated path', 'https://lovelies.ikanisa.com/privacy/', {}],
  ['route-prefix suffix', 'https://lovelies.ikanisa.com/.well-known/assetlinks.json-extra', {}],
  ['other host', 'https://lovelies.admin.ikanisa.com/.well-known/assetlinks.json', {}],
  ['alternate port', 'https://lovelies.ikanisa.com:8443/.well-known/assetlinks.json', {}],
  ['non-HTTPS', 'http://lovelies.ikanisa.com/.well-known/assetlinks.json', {}],
  ['other method', 'https://lovelies.ikanisa.com/.well-known/assetlinks.json', { method: 'POST', body: 'original body' }],
]) {
  test(`${label} passes the original request and origin response through`, async () => {
    const request = new Request(url, init);
    const origin = new Response('origin response', { status: 418, headers: { 'x-origin': 'preserved' } });
    let calls = 0;
    const result = await handle(request, async received => {
      calls++;
      assert.equal(received, request);
      if (init.method === 'POST') assert.equal(await received.text(), 'original body');
      return origin;
    });
    assert.equal(calls, 1);
    assert.equal(result, origin);
    assert.equal(result.status, 418);
    assert.equal(result.headers.get('x-origin'), 'preserved');
  });
}
