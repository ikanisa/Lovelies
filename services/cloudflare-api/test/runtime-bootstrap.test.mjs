import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startHarness, closeHarnesses } from './runtime-harness.mjs';

let app;
before(async () => { app = await startHarness(); });
after(async () => { await closeHarnesses(); });

test('health probes the actual SQLite authority; readiness records absent private verifiers', async () => {
  const health = await app.json('/health');
  assert.equal(health.database_ready, true);
  assert.equal(health.database, 'cloudflare_durable_object_sqlite');
  const ready = await app.json('/ready', {}, 503);
  assert.deepEqual(ready.missing.sort(), ['FACE_AUTH_VERIFIER', 'PHOTO_PROCESSOR']);
  const tables = await app.storage.exec("SELECT name FROM sqlite_master WHERE type='table'");
  assert(tables.some(table => table.name === 'media_grants'));
  assert(!tables.some(table => table.name === 'otp_challenges'));
});
test('anonymous bootstrap has limited credentials and cannot access photos, sharing or admin', async () => {
  const session = await app.anonymous();
  assert.equal(session.auth_method, 'anonymous'); assert.deepEqual(session.roles, ['user']);
  const me = await app.json('/me', { token: session.access_token });
  assert.equal(me.authenticated, false); assert.equal(me.profile_scope, 'anonymous_enrollment');
  for (const path of ['/me/gallery', '/admin/privacy-requests']) {
    const body = await app.json(path, { token: session.access_token }, 403);
    assert.equal(body.error.code, 'registered_face_required');
  }
  await app.community(session.access_token, 'sharing.snapshot', { source: 'personal', operation_key: 'anonymous-denied-key' }, 403);
  await app.json('/auth/anonymous', { body: { roles: ['admin'] } }, 400);
});
test('there is no active OTP route, public seed path or internal queue capability', async () => {
  for (const path of ['/auth/otp/start', '/auth/otp/verify', '/_internal/queue', '/test/seed']) {
    await app.json(path, { body: {}, headers: { 'x-lovelies-internal': 'queue' } }, 404);
  }
});
test('refresh is single use under concurrent requests; logout revokes tokens', async () => {
  const session = await app.anonymous();
  const responses = await Promise.all([0,1].map(() => app.request('/auth/session/refresh', { body: { refresh_token: session.refresh_token } })));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 401]);
  const refreshed = await responses.find(response => response.status === 200).json();
  await app.json('/me', { token: session.access_token }, 401);
  await app.json('/auth/logout', { token: refreshed.access_token, body: {} });
  await app.json('/me', { token: refreshed.access_token }, 401);
});
test('CORS allows only the configured review origin', async () => {
  await app.json('/health', { headers: { origin: 'https://untrusted.example' } }, 403);
  const response = await app.request('/health', { headers: { origin: 'http://127.0.0.1:8765' } });
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://127.0.0.1:8765');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
