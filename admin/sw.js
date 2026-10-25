/* Only the public operator shell is available offline. Private API records and authentication replies are never cached.
 * Bump VERSION whenever any precached shell file changes. Keep the previous
 * worker active until the user explicitly accepts an update in the app.
 */
'use strict';

const VERSION = '20261024-7';
const CACHE_PREFIX = 'lovelies-admin-shell-';
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;
const SHELL_PATHS = [
  '/admin/',
  '/admin/index.html',
  '/admin/styles.css',
  '/admin/workspace.css',
  '/admin/collection-views.css',
  '/admin/detail-views.css',
  '/admin/app.js',
  '/admin/entry.mjs',
  '/admin/live-app.mjs',
  '/admin/live-workspace.css',
  '/admin/operator-session.mjs',
  '/admin/audience.mjs',
  '/admin/runtime-config.mjs',
  '/clients/backend/face-contracts.mjs',
  '/clients/backend/contracts.mjs',
  '/admin/collection-views.mjs',
  '/admin/detail-views.mjs',
  '/admin/demo-store.mjs',
  '/admin/view-model.mjs',
  '/admin/manifest.webmanifest',
  '/admin/icon.svg',
  '/admin/icon-192.png',
  '/admin/icon-512.png',
  '/admin/apple-touch-icon.png',
  '/shared/assets/wordmark.png',
];
const SHELL_URLS = new Set(SHELL_PATHS.map(path => new URL(path, self.location.origin).href));

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // This exact list contains no photographs, API responses or session data.
    await cache.addAll([...SHELL_URLS].map(url => new Request(url, {
      cache: 'reload',
      credentials: 'omit',
    })));
  })());
  // Deliberately no skipWaiting here: the app offers the waiting update.
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || request.headers.has('Authorization')) return;
  const url = new URL(request.url);
  // Hash routes select a client-side view of the same public shell. Ignore
  // only that fragment; real query strings and non-shell paths stay excluded.
  url.hash = '';
  // Never use a broad navigation fallback: private routes and APIs must reach
  // their normal authorization/error path and must not enter the cache.
  if (url.origin !== self.location.origin || url.search || !SHELL_URLS.has(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(url.href);
    // No runtime cache writes. Online misses use the normal network path.
    return cached || fetch(request);
  })());
});

self.addEventListener('message', event => {
  const sourceURL = event.source?.url && new URL(event.source.url);
  if (!sourceURL || sourceURL.origin !== self.location.origin || !sourceURL.pathname.startsWith('/admin/')) return;
  if (event.data?.type === 'ACTIVATE_UPDATE') {
    // The app sends this to registration.waiting only after explicit action.
    event.waitUntil(self.skipWaiting());
  } else if (event.data?.type === 'GET_STATUS') {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE_NAME);
      const ready = await Promise.all([...SHELL_URLS].map(url => cache.match(url)));
      const status = {
        type: 'ADMIN_SW_STATUS',
        version: VERSION,
        cacheName: CACHE_NAME,
        offlineReady: ready.every(Boolean),
      };
      (event.ports[0] || event.source).postMessage(status);
    })());
  }
});
