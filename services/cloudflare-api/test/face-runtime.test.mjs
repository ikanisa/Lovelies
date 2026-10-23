import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startHarness, faceVerifierFixture, prepareEnrollment, enroll, captureProofs,
  fixturePng, deviceEnvelope, sign, sha256, encode } from './runtime-harness.mjs';
import { LoveliesBackendClient } from '../../../clients/backend/client.mjs';

// Actual Worker + SQLite DO + R2; private fixture verdicts are explicitly synthetic.
// These cases establish wire/authorization behavior, never biometric qualification.
const POLICY = 'face-policy-fixture-v1';
const count = async (h, table, where = '') => (await h.storage.exec(`SELECT COUNT(*) n FROM ${table} ${where}`))[0].n;
const harness = async (t, options = {}) => {
  const h = await startHarness({ faceVerifier: faceVerifierFixture, ...options });
  t.after(() => h.close()); return h;
};
async function registration(h, token) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const challenge = await h.json('/auth/face/registration/challenge', { token, body: {
    device_public_jwk: await crypto.subtle.exportKey('jwk', keys.publicKey),
    consent: { purpose: 'face_authentication', policy_version: POLICY, granted: true },
  } }, 201);
  return { keys, challenge };
}
async function upload(h, challenge, privateKey, token, index, bytes, suppliedHash) {
  const captureHash = suppliedHash ?? await sha256(bytes);
  const payload = { ...deviceEnvelope(challenge), step: 'capture', capture_index: index,
    capture_sha256: captureHash, mime: 'image/png', byte_size: bytes.length };
  return h.request(`/auth/face/proof/${challenge.challenge_id}/${index}`, { token, method: 'PUT', raw: bytes,
    headers: { 'content-type': 'image/png', 'x-lovelies-capture-sha256': captureHash,
      'x-lovelies-capture-bytes': String(bytes.length), 'x-lovelies-device-signature': await sign(privateKey, payload) } });
}

test('first registration uses three actual distinct pose captures and automatically authenticates the same account', async t => {
  const h = await harness(t), user = await enroll(h);
  assert.equal(user.challenge.required_captures, 3);
  assert.deepEqual(user.challenge.poses, ['front', 'left', 'right']);
  assert.equal(user.accountId, user.anonymous.account_id);
  const me = await h.json('/me', { token: user.token });
  assert.equal(me.authenticated, true); assert.equal(me.auth_method, 'registered_face');
  await h.json('/me', { token: user.anonymous.access_token }, 401);
  const profiles = await h.storage.exec('SELECT * FROM face_profiles WHERE account_id=?', user.accountId);
  assert.equal(profiles.length, 1); assert.equal(profiles[0].auth_enabled, 1);
  assert.equal(profiles[0].consent_id, null); // Matching consent has never been silently granted.
  const consents = await h.storage.exec('SELECT purpose FROM consents WHERE account_id=?', user.accountId);
  assert.deepEqual(consents.map(value => value.purpose), ['face_authentication']);
  assert.equal(await count(h, 'auth_capture_proofs'), 0);
  const quarantine = await h.mf.getR2Bucket('QUARANTINE'); assert.equal((await quarantine.list()).objects.length, 0);
  assert.equal(await count(h, 'sessions', "WHERE auth_method='registered_face' AND revoked_at IS NULL"), 1);
});

test('missing trusted face binding cannot create a profile, device or upgraded session', async t => {
  const h = await harness(t, { faceVerifier: undefined }), anonymous = await h.anonymous();
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const response = await h.json('/auth/face/registration/challenge', { token: anonymous.access_token, body: {
    device_public_jwk: await crypto.subtle.exportKey('jwk', keys.publicKey),
    consent: { purpose: 'face_authentication', policy_version: POLICY, granted: true },
  } }, 503);
  assert.equal(response.error.code, 'face_authentication_unavailable');
  assert.equal(await count(h, 'face_profiles'), 0); assert.equal(await count(h, 'auth_devices'), 0);
  assert.equal(await count(h, 'sessions', "WHERE auth_method='registered_face'"), 0);
});

test('a private verifier redirect is rejected rather than followed to an external authority', async t => {
  let calls = 0;
  const h = await harness(t, { faceVerifier: async () => {
    calls++; return new Response(null, { status: 302, headers: { location: 'https://untrusted.invalid/face-verdict' } });
  } });
  const prepared = await prepareEnrollment(h);
  await h.json('/auth/face/registration/complete', { token: prepared.anonymous.access_token, body: prepared.completion }, 503);
  assert.equal(calls, 1); assert.equal(await count(h, 'face_profiles'), 0);
  assert.equal(await count(h, 'sessions', "WHERE auth_method='registered_face'"), 0);
});

for (const [field, mutate, expected] of [
  ['missing identity comparison', value => { delete value.identity_verified; }, 503],
  ['wrong account binding', value => { value.account_id = crypto.randomUUID(); }, 503],
  ['missing enrollment comparison', value => { delete value.enrollment_verified; }, 503],
  ['identity mismatch', value => { value.identity_verified = false; }, 401],
]) test(`${field} never creates authenticated authority`, async t => {
  const h = await harness(t, { faceVerifier: async (envelope, form) => {
    const value = await faceVerifierFixture(envelope, form); mutate(value); return value;
  } });
  const prepared = await prepareEnrollment(h);
  await h.json('/auth/face/registration/complete', { token: prepared.anonymous.access_token, body: prepared.completion }, expected);
  assert.equal(await count(h, 'face_profiles'), 0);
  assert.equal(await count(h, 'sessions', "WHERE auth_method='registered_face'"), 0);
  assert.equal((await h.json('/me', { token: prepared.anonymous.access_token })).authenticated, false);
  if (expected === 401) assert.equal(await count(h, 'auth_capture_proofs'), 0);
});

test('P256 capture signatures, actual capture digest, duplicate pose and aggregate ceiling reject before publication', async t => {
  const h = await harness(t), anonymous = await h.anonymous();
  const { challenge, keys } = await registration(h, anonymous.access_token);
  const bytes = fixturePng('first'), hash = await sha256(bytes);
  const badSignature = await h.request(`/auth/face/proof/${challenge.challenge_id}/0`, {
    token: anonymous.access_token, method: 'PUT', raw: bytes, headers: {
      'content-type': 'image/png', 'x-lovelies-capture-sha256': hash,
      'x-lovelies-capture-bytes': String(bytes.length), 'x-lovelies-device-signature': encode(new Uint8Array(64)),
    } });
  assert.equal(badSignature.status, 401);
  assert.equal((await upload(h, challenge, keys.privateKey, anonymous.access_token, 0, bytes, '0'.repeat(64))).status, 400);
  assert.equal(await count(h, 'auth_capture_proofs'), 0);
  assert.equal((await upload(h, challenge, keys.privateKey, anonymous.access_token, 0, bytes)).status, 200);
  assert.equal((await upload(h, challenge, keys.privateKey, anonymous.access_token, 1, bytes)).status, 409);
  const tooLarge = await h.request(`/auth/face/proof/${challenge.challenge_id}/2`, { token: anonymous.access_token,
    method: 'PUT', raw: bytes, headers: { 'content-type': 'image/png', 'x-lovelies-capture-bytes': '8388609',
      'x-lovelies-capture-sha256': hash, 'x-lovelies-device-signature': encode(new Uint8Array(64)) } });
  assert.equal(tooLarge.status, 413); assert.equal(await count(h, 'auth_capture_proofs'), 1);
});

test('two captures are insufficient, while an expired challenge cannot consume or authenticate', async t => {
  const h = await harness(t), anonymous = await h.anonymous();
  const { challenge, keys } = await registration(h, anonymous.access_token);
  const incomplete = await captureProofs(h, { ...challenge, required_captures: 2 }, keys.privateKey, { token: anonymous.access_token });
  await h.json('/auth/face/registration/complete', { token: anonymous.access_token, body: incomplete }, 409);
  await h.storage.exec('UPDATE auth_challenges SET expires_at=created_at+1 WHERE id=?', challenge.challenge_id);
  await h.json('/auth/face/registration/complete', { token: anonymous.access_token, body: incomplete }, 409);
  assert.equal(await count(h, 'face_profiles'), 0);
});

test('successful challenge is consumed once; fresh login requires another signed live capture', async t => {
  const h = await harness(t), user = await enroll(h);
  await h.json('/auth/face/registration/complete', { token: user.anonymous.access_token, body: user.completion }, 409);
  const challenge = await h.json('/auth/face/challenge', { body: { face_handle: user.faceHandle, device_id: user.deviceId } }, 201);
  assert.equal(challenge.required_captures, 1); assert.equal(challenge.profile_id, user.profile_id);
  const completion = await captureProofs(h, challenge, user.keys.privateKey);
  const signedIn = await h.json('/auth/face/complete', { body: completion });
  assert.equal(signedIn.account_id, user.accountId); assert.equal(signedIn.auth_method, 'registered_face');
  assert.equal((await h.json('/me', { token: signedIn.access_token })).authenticated, true);
  await h.json('/auth/face/complete', { body: completion }, 409);
});

test('existing profile activation compares the exact private reference and does not replace it', async t => {
  const h = await harness(t), user = await enroll(h);
  const before = (await h.storage.exec('SELECT id,revision,model_id,template_key,template_digest FROM face_profiles WHERE account_id=?', user.accountId))[0];
  const next = await registration(h, user.token); assert.equal(next.challenge.required_captures, 1);
  assert.equal(next.challenge.profile_id, before.id);
  const completion = await captureProofs(h, next.challenge, next.keys.privateKey, { token: user.token });
  const result = await h.json('/auth/face/registration/complete', { token: user.token, body: completion });
  assert.equal(result.account_id, user.accountId);
  const after = (await h.storage.exec('SELECT id,revision,model_id,template_key,template_digest FROM face_profiles WHERE account_id=?', user.accountId))[0];
  assert.deepEqual(after, before);
  await h.json('/me', { token: user.token }, 401);
  assert.equal((await h.json('/me', { token: result.access_token })).authenticated, true);
});

test('a different fresh face cannot replace an existing account profile or activate its new device', async t => {
  const h = await harness(t, { faceVerifier: async (envelope, form) => {
    const value = await faceVerifierFixture(envelope, form);
    if (envelope.reference_mode === 'existing_reference') value.reference_match = false;
    return value;
  } });
  const user = await enroll(h);
  const before = (await h.storage.exec('SELECT id,revision,template_digest,auth_consent_id FROM face_profiles WHERE account_id=?', user.accountId))[0];
  const next = await registration(h, user.token);
  const completion = await captureProofs(h, next.challenge, next.keys.privateKey, { token: user.token });
  await h.json('/auth/face/registration/complete', { token: user.token, body: completion }, 401);
  const after = (await h.storage.exec('SELECT id,revision,template_digest,auth_consent_id FROM face_profiles WHERE account_id=?', user.accountId))[0];
  assert.deepEqual(after, before);
  assert.equal((await h.storage.exec('SELECT status FROM auth_devices WHERE id=?', next.challenge.device_id))[0].status, 'pending');
  assert.equal((await h.json('/me', { token: user.token })).authenticated, true);
});

for (const [name, sql] of [
  ['account epoch', 'UPDATE accounts SET auth_epoch=auth_epoch+1 WHERE id=?'],
  ['profile epoch', 'UPDATE face_profiles SET auth_epoch=auth_epoch+1 WHERE account_id=?'],
  ['device revocation', "UPDATE auth_devices SET status='revoked' WHERE account_id=?"],
  ['consent revocation', "UPDATE consents SET status='revoked',revoked_at=1 WHERE account_id=? AND purpose='face_authentication'"],
]) test(`${name} invalidates issued credentials and refresh authority`, async t => {
  const h = await harness(t), user = await enroll(h);
  await h.storage.exec(sql, user.accountId);
  await h.json('/me', { token: user.token }, 401);
  await h.json('/auth/session/refresh', { body: { refresh_token: user.refresh_token } }, 401);
});

test('revocation during an awaited verifier verdict cannot publish a reference or session', async t => {
  let arrived, release;
  const atVerifier = new Promise(resolve => { arrived = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const h = await harness(t, { faceVerifier: async (envelope, form) => {
    const verdict = await faceVerifierFixture(envelope, form); arrived(); await wait; return verdict;
  } });
  const prepared = await prepareEnrollment(h);
  const running = h.request('/auth/face/registration/complete', { token: prepared.anonymous.access_token, body: prepared.completion });
  await atVerifier;
  await h.storage.exec('UPDATE accounts SET disabled_at=? WHERE id=?', Date.now(), prepared.anonymous.account_id);
  release(); assert.equal((await running).status, 401);
  assert.equal(await count(h, 'face_profiles'), 0); assert.equal(await count(h, 'sessions', "WHERE auth_method='registered_face'"), 0);
  assert.equal((await (await h.mf.getR2Bucket('PHOTOS')).list()).objects.length, 0);
});

test('actual HS256 signature, role claims and expiry are checked, not token truthiness', async t => {
  const h = await harness(t), user = await enroll(h), parts = user.token.split('.');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString()), claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  assert.equal(header.alg, 'HS256'); assert.equal(header.typ, 'JWT');
  assert.equal(claims.sub, user.accountId); assert.deepEqual(claims.roles, ['user']);
  assert.equal(claims.exp - claims.iat, 900); assert.equal(claims.auth_method, 'registered_face');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('local-fixture-only-auth-key-32-characters'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  assert.equal(await crypto.subtle.verify('HMAC', key, Buffer.from(parts[2], 'base64url'), new TextEncoder().encode(`${parts[0]}.${parts[1]}`)), true);
  const forged = `${parts[0]}.${encode(new TextEncoder().encode(JSON.stringify({ ...claims, roles: ['admin'] })))}.${parts[2]}`;
  await h.json('/me', { token: forged }, 401);
});

test('the real Fetch SDK drives anonymous creation, three camera proofs, automatic upgrade and fresh login against this Worker', async t => {
  const h = await harness(t);
  const client = new LoveliesBackendClient({ baseUrl: 'http://localhost', fetch: async (url, init) => {
    const response = await h.mf.dispatchFetch(url, init);
    return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
  } });
  const anonymous = await client.startAnonymous(); assert.equal(anonymous.authenticated, false);
  await assert.rejects(client.gallery(), { code: 'registered_face_required' });
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const nativeSigningAdapter = async bytes => new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, bytes));
  const challenge = await client.startFaceRegistration({ devicePublicJwk: await crypto.subtle.exportKey('jwk', keys.publicKey), policyVersion: POLICY });
  for (let index = 0; index < 3; index++) await client.uploadFaceCapture(challenge, { bytes: fixturePng(index), mime: 'image/png', index, sign: nativeSigningAdapter });
  const upgraded = await client.completeFaceRegistration(challenge, { sign: nativeSigningAdapter });
  assert.equal(upgraded.session.accountId, anonymous.accountId); assert.equal(upgraded.session.authenticated, true);
  assert.equal((await client.current()).profile_scope, 'registered_face_profile');
  await client.logout(); assert.equal(client.session, null);
  const login = await client.startFaceLogin({ faceHandle: upgraded.registeredFace.faceHandle,
    deviceId: upgraded.registeredFace.deviceId, accountId: upgraded.registeredFace.accountId });
  await client.uploadFaceCapture(login, { bytes: fixturePng('fresh-login'), mime: 'image/png', index: 0, sign: nativeSigningAdapter });
  assert.equal((await client.completeFaceLogin(login, { sign: nativeSigningAdapter })).session.authenticated, true);
});
