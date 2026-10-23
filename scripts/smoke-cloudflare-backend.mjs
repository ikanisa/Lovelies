import assert from 'node:assert/strict';
const base = process.env.LOVELIES_API_ORIGIN ?? 'http://127.0.0.1:8787';
const url = new URL(base);
assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname), 'Smoke is restricted to the local development API.');
let checks = 0;
async function check(path, status, predicate = () => true, options = {}) {
  const response = await fetch(new URL(path, base), { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, status, `${path} status`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert(predicate(body), `${path} contract`); checks++;
  return body;
}
await check('/health', 200, body => body.database_ready === true && body.database === 'cloudflare_durable_object_sqlite');
const readyResponse=await fetch(new URL('/ready',base),{signal:AbortSignal.timeout(10000)});
assert([200,503].includes(readyResponse.status));
const ready=await readyResponse.json();assert(ready.database_ready===true&&Array.isArray(ready.missing));checks++;
const faceAvailable=!ready.missing.includes('FACE_AUTH_VERIFIER')&&!ready.missing.includes('FACE_AUTH_POLICY_VERSION');
await check('/auth/face/policy',faceAvailable?200:503,body=>faceAvailable?body.required_captures===3:body.error.code==='face_authentication_unavailable');
await check('/me/gallery', 401);
const anonymous = await check('/auth/anonymous', 201, body => body.auth_method === 'anonymous' &&
  typeof body.access_token === 'string' && typeof body.refresh_token === 'string', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
});
const authHeaders = { authorization: `Bearer ${anonymous.access_token}` };
await check('/me', 200, body => body.authenticated === false && body.profile_scope === 'anonymous_enrollment', { headers: authHeaders });
await check('/me/gallery', 403, body => body.error?.code === 'registered_face_required', { headers: authHeaders });
await check('/auth/face/registration/challenge', faceAvailable?400:503, body => body.error?.code === (faceAvailable?'invalid_input':'face_authentication_unavailable'), {
  method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' }, body: '{}',
});
await check('/auth/logout', 200, body => body.status === 'logged_out', { method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' }, body: '{}' });
await check('/me', 401, undefined, { headers: authHeaders });
await check('/auth/otp/start', 404, undefined, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
await check('/_internal/queue', 404, undefined, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lovelies-internal': 'queue' }, body: '{}' });
await check('/health', 403, undefined, { headers: { origin: 'https://untrusted.example' } });
await check('/health', 200, undefined, { headers: { origin: 'http://127.0.0.1:8765' } });
await check('/route-does-not-exist', 404);
console.log(JSON.stringify({ status: 'passed', checks, database: 'cloudflare_durable_object_sqlite', hosted_acceptance: false }));
