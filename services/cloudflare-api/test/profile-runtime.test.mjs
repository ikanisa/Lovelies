import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startHarness, faceVerifierFixture, enroll } from './runtime-harness.mjs';
test('profile name editing uses current face authority and durable operation replay without role changes', async t => {
  const h = await startHarness({ faceVerifier: faceVerifierFixture }); t.after(() => h.close());
  const anonymous = await h.anonymous();
  await h.json('/me/profile', { token: anonymous.access_token }, 403);
  const user = await enroll(h), body = { name: '  Aline  ', operation_key: 'profile-name-edit-01' };
  const first = await h.json('/me/profile', { method: 'PATCH', token: user.token, body });
  assert.equal(first.name, 'Aline');
  assert.deepEqual(await h.json('/me/profile', { method: 'PATCH', token: user.token, body }), first);
  assert.equal((await h.json('/me', { token: user.token })).name, 'Aline');
  await h.json('/me/profile', { method: 'PATCH', token: user.token, body: { ...body, name: 'Eric' } }, 409);
  await h.json('/me/profile', { method: 'PATCH', token: user.token, body: { ...body, roles: ['admin'] } }, 400);
  await h.json('/me/profile', { method: 'PATCH', token: user.token, body: { ...body, name: 'bad\u0000name' } }, 400);
  await h.json('/auth/logout', { token: user.token, body: {} });
  await h.json('/me/profile', { token: user.token }, 401);
});
