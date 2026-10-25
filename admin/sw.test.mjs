import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('./sw.js', import.meta.url), 'utf8');
const origin = 'http://127.0.0.1:8765';

function workerHarness() {
  const handlers = new Map();
  const cached = new Map([
    [`${origin}/admin/`, new Response('Offline admin shell')],
    [`${origin}/admin/index.html`, new Response('Offline admin shell')],
    [`${origin}/admin/styles.css`, new Response('body { color: white; }')],
  ]);
  const cacheLookups = [];
  const messages = [];
  let networkCalls = 0;
  let skipWaitingCalls = 0;
  const cache = {
    async match(url) {
      cacheLookups.push(url);
      return cached.get(url)?.clone();
    },
    async addAll() {},
  };
  vm.runInNewContext(source, {
    URL, Request, Response, Set, Promise,
    self: {
      location: { origin },
      addEventListener: (name, callback) => handlers.set(name, callback),
      clients: { claim: async () => {} },
      skipWaiting: async () => { skipWaitingCalls += 1; },
    },
    caches: {
      open: async () => cache,
      keys: async () => [],
      delete: async () => true,
    },
    fetch: async () => {
      networkCalls += 1;
      throw new Error('Network is unavailable');
    },
  }, { filename: 'admin/sw.js' });

  return {
    cacheLookups,
    messages,
    get networkCalls() { return networkCalls; },
    get skipWaitingCalls() { return skipWaitingCalls; },
    async fetch(url, { method = 'GET', headers = {} } = {}) {
      let response;
      // Retain the navigation URL supplied by the browser, including its
      // fragment; this reproduces the observed offline hash-route failure.
      handlers.get('fetch')({
        request: { url, method, headers: new Headers(headers) },
        respondWith(value) { response = value; },
      });
      return response ? await response : undefined;
    },
    async lifecycle(name) {
      let pending;
      handlers.get(name)({ waitUntil(value) { pending = value; } });
      await pending;
    },
    async message(data, clientURL = `${origin}/admin/`) {
      let pending;
      handlers.get('message')({
        data,
        source: clientURL ? { url: clientURL, postMessage: value => messages.push(value) } : null,
        ports: [],
        waitUntil(value) { pending = value; },
      });
      await pending;
    },
  };
}

test('offline shell serves both the root and client-side hash routes', async () => {
  const worker = workerHarness();
  for (const path of [
    '/admin/',
    '/admin/#support?filter=attention&sort=oldest',
    '/admin/#privacy',
    '/admin/index.html#safety',
  ]) {
    const response = await worker.fetch(`${origin}${path}`);
    assert.equal(await response.text(), 'Offline admin shell', path);
  }
  assert.deepEqual(worker.cacheLookups, [
    `${origin}/admin/`, `${origin}/admin/`, `${origin}/admin/`, `${origin}/admin/index.html`,
  ]);
  assert.equal(worker.networkCalls, 0, 'Offline hash routes must not fall through to the network');
});

test('only exact public shell requests are intercepted; queries and private paths stay excluded', async () => {
  const worker = workerHarness();
  const excluded = [
    [`${origin}/admin/`, { headers: { Authorization: 'Bearer synthetic-test-value' } }],
    [`${origin}/admin/`, { method: 'POST' }],
    [`${origin}/api/admin/requests`],
    [`${origin}/admin/api/requests#overview`],
    [`${origin}/admin/private.json#overview`],
    [`${origin}/admin/.env#overview`],
    [`${origin}/admin/?filter=attention#support`],
    [`${origin}/admin/styles.css?v=3`],
    [`${origin}/services/cloudflare-api/wrangler.jsonc`],
    [`${origin}/shared/assets/person01.jpg`],
    [`${origin}/preview/`],
    ['https://another.example/admin/#overview'],
  ];
  for (const [url, options] of excluded) {
    assert.equal(await worker.fetch(url, options), undefined, url);
  }
  assert.deepEqual(worker.cacheLookups, [], 'Excluded requests must not read the shell cache');
  assert.equal(worker.networkCalls, 0, 'Excluded requests belong to the normal browser network path');
});

test('updates activate only after an explicit message from an admin client on the same origin', async () => {
  const worker = workerHarness();
  await worker.lifecycle('install');
  await worker.lifecycle('activate');
  await worker.message({ type: 'GET_STATUS' });
  await worker.message({ type: 'UNRECOGNIZED' });
  await worker.message({ type: 'ACTIVATE_UPDATE' }, null);
  await worker.message({ type: 'ACTIVATE_UPDATE' }, 'https://another.example/admin/');
  await worker.message({ type: 'ACTIVATE_UPDATE' }, `${origin}/preview/`);
  await worker.message({ type: 'ACTIVATE_UPDATE' }, `${origin}/administrator/`);
  assert.equal(worker.skipWaitingCalls, 0, 'Install, status reads and other clients cannot force activation');
  assert.equal(worker.messages[0].type, 'ADMIN_SW_STATUS');
  assert.equal(worker.messages[0].version, '20261024-7');

  await worker.message({ type: 'ACTIVATE_UPDATE' }, `${origin}/admin/#privacy`);
  assert.equal(worker.skipWaitingCalls, 1);
});
