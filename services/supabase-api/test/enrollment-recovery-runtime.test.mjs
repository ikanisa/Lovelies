import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startHarness, faceVerifierFixture, captureProofs, fixturePng, deviceEnvelope,
  sign, sha256, encode, stable, enroll } from './runtime-harness.mjs';

// Embedded PostgreSQL and in-memory Storage; synthetic verdicts prove protocol,
// never hosted acceptance, camera behavior or identity.
const policy = 'face-policy-fixture-v1', protocol = 'lovelies-face-enrollment-device-v1';
async function harness(t, options = {}) {
  const h = await startHarness({ faceVerifier: faceVerifierFixture, consumeQueue: false, ...options });
  t.after(() => h.close()); return h;
}
async function intent(h) {
  const anonymous = await h.anonymous(), keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign','verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey), handle = 'lfh_' + encode(crypto.getRandomValues(new Uint8Array(32)));
  const saved = { account_id: anonymous.account_id, enrollment_key: crypto.randomUUID(), face_handle: handle };
  const body = { ...saved, device_public_jwk: jwk, consent: { purpose: 'face_authentication', policy_version: policy, granted: true } };
  body.device_signature = await sign(keys.privateKey, { protocol, step: 'start', ...saved, policy_version: policy, device_public_jwk: jwk });
  return { anonymous, keys, jwk, saved, body };
}
async function started(h) {
  const i = await intent(h); i.challenge = await h.json('/auth/face/registration/challenge', { token: i.anonymous.access_token, body: i.body }, 201); return i;
}
async function recoveryBody(i, step = 'status', fields = {}) {
  const body = { ...i.saved, request_nonce: crypto.randomUUID(), request_expires_at: Date.now() + 45_000, ...fields };
  return { ...body, device_signature: await sign(i.keys.privateKey, { protocol, step, ...body }) };
}
async function status(h, i, expected = 200, token = i.anonymous.access_token) {
  const body = await recoveryBody(i), response = await h.json('/auth/face/registration/recovery', { token, body }, expected);
  if (expected === 200) {
    assert.equal(response.request_nonce, body.request_nonce); assert.equal(response.account_id, i.saved.account_id);
    assert.equal(response.enrollment_key, i.saved.enrollment_key); assert.equal(response.authenticated, false);
    assert.equal(response.public_key_digest, await sha256(new TextEncoder().encode(stable(i.jwk))));
    if (i.challenge) { assert.equal(response.device_id, i.challenge.device_id); assert.equal(response.device_revision, i.challenge.device_revision); }
    const raw = JSON.stringify(response);
    for (const denied of ['access_token','refresh_token','template','object_key','reference_digest','public_jwk',i.saved.face_handle]) assert(!raw.includes(denied), denied);
  }
  return response;
}
function successor(i, overrides = {}) {
  return { resume_key: crypto.randomUUID(), expected_generation: i.challenge.enrollment_generation,
    expected_challenge_id: i.challenge.challenge_id, ...overrides };
}
async function resume(h, i, fields, expected = 201, token = i.anonymous.access_token) {
  return h.json('/auth/face/registration/resume', { token, body: await recoveryBody(i, 'resume', fields) }, expected);
}
async function capture(h, i, index, bytes = fixturePng(crypto.randomUUID())) {
  const hash = await sha256(bytes), mime = 'image/png';
  const body = { ...deviceEnvelope(i.challenge), step: 'capture', capture_index: index, capture_sha256: hash, mime, byte_size: bytes.length };
  const response = await h.request(`/auth/face/proof/${i.challenge.challenge_id}/${index}`, { token: i.anonymous.access_token, method: 'PUT', raw: bytes,
    headers: { 'content-type': mime, 'x-lovelies-capture-sha256': hash, 'x-lovelies-capture-bytes': String(bytes.length),
      'x-lovelies-device-signature': await sign(i.keys.privateKey, body) } });
  return { response, manifest: { index, sha256: hash, mime, byte_size: bytes.length } };
}
async function finish(h, i) {
  const completion = await captureProofs(h, i.challenge, i.keys.privateKey, { token: i.anonymous.access_token });
  const result = await h.json('/auth/face/registration/complete', { token: i.anonymous.access_token, body: completion });
  return { result, completion };
}

test('A04 rejected capture set keeps exact A01 account/key/consent for signed successor and fresh enrollment',async t=>{
 let reject=true;
 const h=await harness(t,{faceVerifier:async(e,f)=>{const value=await faceVerifierFixture(e,f);
  if(!reject)return value;delete value.registered_reference;delete value.pose_evidence;
  return {...value,identity_verified:false,enrollment_verified:false,capture_rejection:{code:'no_face',capture_index:1}};
 }}),i=await started(h),old=i.challenge;
 const completion=await captureProofs(h,old,i.keys.privateKey,{token:i.anonymous.access_token});
 const failed=await h.json('/auth/face/registration/complete',{token:i.anonymous.access_token,body:completion},422);
 assert.deepEqual(failed,{error:{code:'face_capture_no_face'}});
 const state=await status(h,i);assert.equal(state.state,'restart_required');assert.equal(state.challenge,null);
 assert.deepEqual(state.captures,[]);assert.equal(state.device_id,old.device_id);
 assert.equal((await h.json('/me',{token:i.anonymous.access_token})).user_id,i.saved.account_id);
 assert.equal((await capture(h,i,0)).response.status,409);
 const next=await resume(h,i,successor(i));assert.equal(next.enrollment_generation,2);
 assert.equal(next.device_id,old.device_id);assert.equal(next.device_revision,old.device_revision);
 assert.equal((await h.storage.exec('SELECT count(*) n FROM auth_devices'))[0].n,1);
 assert.equal((await h.storage.exec('SELECT count(*) n FROM consents'))[0].n,1);
 assert.equal((await h.storage.exec('SELECT count(*) n FROM auth_capture_proofs WHERE challenge_id=?',old.challenge_id))[0].n,0);
 reject=false;i.challenge=next;const confirmed=(await finish(h,i)).result;
 assert.equal(confirmed.account_id,i.saved.account_id);assert.equal(confirmed.device_id,old.device_id);
 assert.equal(confirmed.auth_method,'registered_face');
});

test('lost initial reply reconciles and replays the same account/device/consent without storing handle plaintext', async t => {
  const h = await harness(t), i = await intent(h);
  const response = await h.request('/auth/face/registration/challenge', { token: i.anonymous.access_token, body: i.body });
  assert.equal(response.status, 201); await response.arrayBuffer(); // Discard the real reply.
  const recovered = await status(h, i); assert.equal(recovered.state, 'pending'); assert.deepEqual(recovered.captures, []);
  i.challenge = recovered.challenge;
  const replay = await h.json('/auth/face/registration/challenge', { token: i.anonymous.access_token, body: i.body }, 201);
  assert.equal(replay.challenge_id, i.challenge.challenge_id); assert.equal(replay.device_id, i.challenge.device_id);
  for (const table of ['auth_devices','consents','auth_challenges','face_enrollment_intents']) {
    const rows = await h.storage.exec(`SELECT * FROM ${table}`); assert.equal(rows.length, 1);
    assert(!JSON.stringify(rows).includes(i.saved.face_handle), table);
  }
  assert.equal((await h.json('/me', { token: i.anonymous.access_token })).authenticated, false);
});

test('authoritative absent start needs current same-account anonymous authority and never grants credentials', async t => {
  const h = await harness(t), i = await intent(h), other = await h.anonymous();
  assert.equal((await status(h, i, 404)).error.code, 'enrollment_not_found');
  const body = await recoveryBody(i);
  assert.equal((await h.json('/auth/face/registration/recovery', { body }, 404)).error.code, 'enrollment_recovery_unavailable');
  assert.equal((await status(h, i, 404, other.access_token)).error.code, 'enrollment_recovery_unavailable');
  const challenge = await h.json('/auth/face/registration/challenge', { token: i.anonymous.access_token, body: i.body }, 201);
  assert.equal(challenge.account_id, i.saved.account_id);
});

test('lost first start then expiry supplies the exact predecessor and resumes the original key without another start', async t => {
  const h = await harness(t), i = await intent(h);
  const reply = await h.request('/auth/face/registration/challenge', { token: i.anonymous.access_token, body: i.body });
  assert.equal(reply.status, 201); await reply.arrayBuffer();
  const original = (await h.storage.exec('SELECT challenge_id,device_id,device_revision FROM face_enrollment_intents WHERE account_id=?', i.saved.account_id))[0];
  await h.storage.exec('UPDATE auth_challenges SET expires_at=created_at+1 WHERE id=?', original.challenge_id);
  const recovered = await status(h, i); assert.equal(recovered.state, 'restart_required'); assert.equal(recovered.challenge, null);
  assert.equal(recovered.challenge_id, original.challenge_id); assert.equal(recovered.device_id, original.device_id);
  const next = await resume(h, i, { resume_key: crypto.randomUUID(), expected_generation: recovered.enrollment_generation, expected_challenge_id: recovered.challenge_id });
  assert.equal(next.enrollment_generation, 2); assert.equal(next.device_id, original.device_id); assert.equal(next.device_revision, original.device_revision);
  assert.equal((await h.storage.exec('SELECT count(*) n FROM consents'))[0].n, 1);
  assert.equal((await h.storage.exec('SELECT count(*) n FROM auth_devices'))[0].n, 1);
  i.challenge = next; assert.equal((await finish(h, i)).result.account_id, i.saved.account_id);
});

test('conflicting handle or key on the same start key creates no replacement records', async t => {
  const h = await harness(t), i = await started(h);
  for (const change of ['handle','key']) {
    const body = structuredClone(i.body), fields = { ...i.saved };
    let privateKey = i.keys.privateKey;
    if (change === 'handle') { fields.face_handle = 'lfh_' + encode(crypto.getRandomValues(new Uint8Array(32))); body.face_handle = fields.face_handle; }
    else { const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign','verify']); body.device_public_jwk = await crypto.subtle.exportKey('jwk', keys.publicKey); privateKey = keys.privateKey; }
    body.device_signature = await sign(privateKey, { protocol, step: 'start', ...fields, policy_version: policy, device_public_jwk: body.device_public_jwk });
    assert.equal((await h.json('/auth/face/registration/challenge', { token: i.anonymous.access_token, body }, 409)).error.code, 'enrollment_binding_conflict');
  }
  assert.equal((await h.storage.exec('SELECT count(*) n FROM auth_devices'))[0].n, 1);
  const forged = await recoveryBody(i); forged.device_signature = encode(new Uint8Array(64));
  await h.json('/auth/face/registration/recovery', { body: forged }, 401);
});

test('lost capture acknowledgement restores exact accepted metadata and enforces contiguous capture slots', async t => {
  const h = await harness(t), i = await started(h);
  assert.equal((await capture(h, i, 1)).response.status, 409);
  const first = await capture(h, i, 0); assert.equal(first.response.status, 200); await first.response.arrayBuffer();
  const recovered = await status(h, i); assert.equal(recovered.state, 'pending'); assert.deepEqual(recovered.captures, [first.manifest]);
  assert.equal((await capture(h, i, 0)).response.status, 409);
  assert.equal((await capture(h, i, 1)).response.status, 200);
  assert.equal((await status(h, i)).captures.length, 2);
  assert.equal((await h.json('/me', { token: i.anonymous.access_token })).authenticated, false);
});

test('lost completion reply recovers immutable registration and requires fresh selfie login on the same key/account', async t => {
  const h = await harness(t), i = await started(h);
  const completion = await captureProofs(h, i.challenge, i.keys.privateKey, { token: i.anonymous.access_token });
  const reply = await h.request('/auth/face/registration/complete', { token: i.anonymous.access_token, body: completion });
  assert.equal(reply.status, 200); await reply.arrayBuffer();
  const recovered = await status(h, i, 200, null); assert.equal(recovered.state, 'registered'); assert.equal(recovered.challenge, null); assert.deepEqual(recovered.captures, []);
  await h.json('/me', { token: i.anonymous.access_token }, 401);
  await h.json('/auth/face/registration/complete', { token: i.anonymous.access_token, body: completion }, 409);
  const challenge = await h.json('/auth/face/challenge', { body: { face_handle: i.saved.face_handle, device_id: recovered.device_id } }, 201);
  assert.equal(challenge.required_captures, 1); assert.equal(challenge.profile_id, recovered.profile.id);
  const login = await h.json('/auth/face/complete', { body: await captureProofs(h, challenge, i.keys.privateKey) });
  assert.equal(login.account_id, i.saved.account_id); assert.equal(login.device_id, i.challenge.device_id);
  assert.equal((await h.json('/me', { token: login.access_token })).authenticated, true);
  assert.equal((await h.storage.exec('SELECT count(*) n FROM accounts'))[0].n, 1);
  assert.equal((await h.storage.exec('SELECT count(*) n FROM auth_devices'))[0].n, 1);
});

test('expired challenge resumes once on the same key/consent; saved predecessor retries return one successor', async t => {
  const h = await harness(t), i = await started(h), first = await capture(h, i, 0); assert.equal(first.response.status, 200);
  await h.storage.exec('UPDATE auth_challenges SET expires_at=created_at+1 WHERE id=?', i.challenge.challenge_id);
  assert.equal((await status(h, i)).state, 'restart_required');
  await h.alarm();
  assert.deepEqual((await status(h, i)).captures, []); // Actual expired raw-proof cleanup does not destroy the predecessor binding.
  const fields = successor(i), next = await resume(h, i, fields), replay = await resume(h, i, fields);
  assert.equal(next.enrollment_generation, 2); assert.deepEqual(replay, next);
  assert.equal(next.device_id, i.challenge.device_id); assert.equal(next.device_revision, i.challenge.device_revision);
  assert.notEqual(next.nonce, i.challenge.nonce); assert.notEqual(next.challenge_id, i.challenge.challenge_id);
  await resume(h, i, successor(i), 409); // Stale predecessor cannot replace the successor.
  const old = i.challenge; i.challenge = next;
  assert.deepEqual((await status(h, i)).captures, []);
  assert.equal((await h.storage.exec('SELECT count(*) n FROM consents'))[0].n, 1);
  assert.equal((await h.storage.exec('SELECT count(*) n FROM auth_devices'))[0].n, 1);
  const oldProof = await sign(i.keys.privateKey, { ...deviceEnvelope(old), step: 'complete', capture_manifest: [first.manifest] });
  await h.json('/auth/face/registration/complete', { token: i.anonymous.access_token, body: { challenge_id: old.challenge_id, device_signature: oldProof } }, 409);
  const { result } = await finish(h, i); assert.equal(result.account_id, i.saved.account_id);
});

test('partially retired expired proofs remain metadata only and do not block same-device fresh successor', async t => {
  const h = await harness(t), i = await started(h), first = await capture(h, i, 0), second = await capture(h, i, 1);
  assert.equal(first.response.status, 200); assert.equal(second.response.status, 200);
  const proofs = await h.storage.exec('SELECT * FROM auth_capture_proofs WHERE challenge_id=? ORDER BY capture_index', i.challenge.challenge_id);
  const bucket = await h.mf.getR2Bucket('QUARANTINE');
  await h.storage.exec('UPDATE auth_challenges SET expires_at=created_at+1 WHERE id=?', i.challenge.challenge_id);
  // Reproduce the actual DELETE -> absent HEAD -> retire-row ordering for one
  // proof, while the other object's cleanup remains outstanding.
  await bucket.delete(proofs[0].object_key); assert.equal(await bucket.head(proofs[0].object_key), null);
  await h.storage.exec('DELETE FROM auth_capture_proofs WHERE challenge_id=? AND capture_index=0', i.challenge.challenge_id);
  assert(await bucket.head(proofs[1].object_key));
  const recovered = await status(h, i); assert.equal(recovered.state, 'restart_required'); assert.equal(recovered.challenge, null);
  assert.deepEqual(recovered.captures, [second.manifest]); assert.equal(recovered.challenge_id, i.challenge.challenge_id);
  const next = await resume(h, i, successor(i)); assert.equal(next.device_id, i.challenge.device_id); i.challenge = next;
  assert.deepEqual((await status(h, i)).captures, []);
  assert.equal((await finish(h, i)).result.account_id, i.saved.account_id);
});

test('rotated anonymous session requires same-device successor rather than a new anonymous account', async t => {
  const h = await harness(t), i = await started(h), original = i.challenge;
  const credentials = await h.json('/auth/session/refresh', { body: { refresh_token: i.anonymous.refresh_token } });
  assert.equal(credentials.account_id, i.saved.account_id); i.anonymous = credentials;
  assert.equal((await status(h, i)).state, 'restart_required');
  const next = await resume(h, i, successor(i)); assert.equal(next.enrollment_generation, 2);
  assert.equal(next.device_id, original.device_id); i.challenge = next;
  const { result } = await finish(h, i); assert.equal(result.account_id, credentials.account_id);
  assert.equal((await h.storage.exec('SELECT count(*) n FROM accounts'))[0].n, 1);
});

test('unresolved account writer exposes capture_pending and cannot replace the challenge or admit another capture', async t => {
  const h = await harness(t), i = await started(h), writer = crypto.randomUUID();
  await h.storage.exec("INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at) VALUES(?,?,'QUARANTINE',?,'pending',?)", writer, i.saved.account_id, 'private/unresolved', Date.now());
  assert.equal((await status(h, i)).state, 'capture_pending');
  await resume(h, i, successor(i), 409); assert.equal((await capture(h, i, 0)).response.status, 409);
  await h.storage.exec("UPDATE media_write_intents SET status='settled',settled_at=? WHERE id=?", Date.now(), writer);
  assert.equal((await status(h, i)).state, 'pending');
});

test('in-flight verification cannot be repeated or resumed and later reconciles the committed registration', async t => {
  let arrived, release; const reached = new Promise(resolve => { arrived = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const h = await harness(t, { faceVerifier: async (envelope, form) => { const result = await faceVerifierFixture(envelope, form); arrived(); await gate; return result; } });
  const i = await started(h), completion = await captureProofs(h, i.challenge, i.keys.privateKey, { token: i.anonymous.access_token });
  const running = h.request('/auth/face/registration/complete', { token: i.anonymous.access_token, body: completion }); await reached;
  assert.equal((await status(h, i)).state, 'verifying'); await resume(h, i, successor(i), 409);
  await h.json('/auth/face/registration/complete', { token: i.anonymous.access_token, body: completion }, 409);
  release(); assert.equal((await running).status, 200); assert.equal((await status(h, i, 200, null)).state, 'registered');
});

for (const [name, sql] of [
  ['revoked consent', "UPDATE consents SET status='revoked',revoked_at=1 WHERE account_id=?"],
  ['revoked device', "UPDATE auth_devices SET status='revoked' WHERE account_id=?"],
  ['disabled account', 'UPDATE accounts SET disabled_at=1 WHERE id=?'],
  ['account epoch change', 'UPDATE accounts SET auth_epoch=auth_epoch+1 WHERE id=?'],
  ['device revision change', "UPDATE auth_devices SET revision='changed' WHERE account_id=?"],
]) test(`${name} blocks signed recovery and same-device resume without replacement`, async t => {
  const h = await harness(t), i = await started(h); await h.storage.exec(sql, i.saved.account_id);
  assert.equal((await status(h, i, 404, null)).error.code, 'enrollment_recovery_unavailable');
  const response = await h.request('/auth/face/registration/resume', { token: i.anonymous.access_token, body: await recoveryBody(i, 'resume', successor(i)) });
  assert([401,404].includes(response.status)); assert.equal((await h.storage.exec('SELECT count(*) n FROM auth_devices'))[0].n, 1);
});

test('signed short deadline and nonce/action binding cannot be changed or used as session authority', async t => {
  const h = await harness(t), i = await started(h), expired = await recoveryBody(i, 'status', { request_expires_at: Date.now() - 1 });
  await h.json('/auth/face/registration/recovery', { body: expired }, 400);
  await h.json('/auth/face/registration/recovery', { body: await recoveryBody(i, 'status', { request_expires_at: Date.now() + 120_000 }) }, 400);
  const body = await recoveryBody(i); body.request_nonce = crypto.randomUUID(); await h.json('/auth/face/registration/recovery', { body }, 401);
  const forged = await recoveryBody(i, 'status', successor(i)); await h.json('/auth/face/registration/resume', { token: i.anonymous.access_token, body: forged }, 401);
  await h.json('/me', { token: (await recoveryBody(i)).device_signature }, 401);
});

for (const [name,sql] of [
  ['revision', "UPDATE face_profiles SET revision='changed' WHERE account_id=?"],
  ['reference digest', "UPDATE face_profiles SET template_digest='changed' WHERE account_id=?"],
]) test(`changed committed profile ${name} makes recovery unavailable even though the handle and signature remain valid`, async t => {
  const h = await harness(t), i = await started(h); await finish(h, i);
  await h.storage.exec(sql, i.saved.account_id);
  assert.equal((await status(h, i, 404, null)).error.code, 'enrollment_recovery_unavailable');
});

test('guest deletion cancels registration atomically and rejected deletion resumes the original device/consent', async t => {
  const h = await harness(t), i = await started(h);
  const deletion = await h.json('/privacy/account-deletion', { token: i.anonymous.access_token,
    body: { operation_key: 'delete-' + crypto.randomUUID(), status_token: 'lvd_' + 'b'.repeat(64) } }, 201);
  assert.equal((await h.storage.exec('SELECT status FROM auth_challenges WHERE id=?', i.challenge.challenge_id))[0].status, 'cancelled');
  assert.equal((await h.json('/auth/face/registration/challenge', { token: i.anonymous.access_token, body: i.body }, 409)).error.code, 'enrollment_deletion_pending');
  assert.equal((await resume(h, i, successor(i), 409)).error.code, 'enrollment_deletion_pending');
  await h.storage.exec("UPDATE privacy_requests SET status='rejected' WHERE id=?", deletion.privacy_request.id);
  const next = await resume(h, i, successor(i)); assert.equal(next.device_id, i.challenge.device_id); assert.equal(next.enrollment_generation, 2);
  i.challenge = next; assert.equal((await finish(h, i)).result.account_id, i.saved.account_id);
});

test('guest deletion created during verifier await prevents the final account/profile/session upgrade', async t => {
  let arrived, release; const reached = new Promise(resolve => { arrived = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const h = await harness(t, { faceVerifier: async (envelope, form) => { const result = await faceVerifierFixture(envelope, form); arrived(); await gate; return result; } });
  const i = await started(h), completion = await captureProofs(h, i.challenge, i.keys.privateKey, { token: i.anonymous.access_token });
  const running = h.request('/auth/face/registration/complete', { token: i.anonymous.access_token, body: completion }); await reached;
  await h.json('/privacy/account-deletion', { token: i.anonymous.access_token,
    body: { operation_key: 'delete-' + crypto.randomUUID(), status_token: 'lvd_' + 'c'.repeat(64) } }, 201);
  release(); assert.equal((await running).status, 409);
  assert.equal((await h.storage.exec('SELECT count(*) n FROM face_profiles'))[0].n, 0);
  assert.equal((await h.storage.exec("SELECT count(*) n FROM sessions WHERE auth_method='registered_face'"))[0].n, 0);
  assert.equal((await h.json('/me', { token: i.anonymous.access_token })).authenticated, false);
});

test('bounded receipt expiration retires only recovery metadata and preserves the active key/profile/session', async t => {
  const h = await harness(t), i = await started(h), { result } = await finish(h, i);
  await h.storage.exec('UPDATE face_enrollment_intents SET expires_at=created_at+1 WHERE account_id=?', i.saved.account_id);
  await h.alarm(); assert.equal((await h.storage.exec('SELECT count(*) n FROM face_enrollment_intents'))[0].n, 0);
  assert.equal((await h.storage.exec("SELECT count(*) n FROM auth_devices WHERE status='active'"))[0].n, 1);
  assert.equal((await h.storage.exec('SELECT count(*) n FROM face_profiles'))[0].n, 1);
  assert.equal((await h.json('/me', { token: result.access_token })).authenticated, true);
  assert.equal((await status(h, i, 404, null)).error.code, 'enrollment_recovery_unavailable');
});

test('account erasure removes enrollment metadata before device/challenge rows and leaves no foreign-key leak', async t => {
  const h = await harness(t), i = await started(h), admin = await enroll(h);
  await h.storage.exec('UPDATE accounts SET roles_json=? WHERE id=?', JSON.stringify(['user','admin']), admin.accountId);
  const challenge = await h.json('/auth/face/challenge', { body: { face_handle: admin.faceHandle, device_id: admin.deviceId } }, 201);
  const credentials = await h.json('/auth/face/complete', { body: await captureProofs(h, challenge, admin.keys.privateKey) });
  const deletion = await h.json('/privacy/account-deletion', { token: i.anonymous.access_token,
    body: { operation_key: 'delete-' + crypto.randomUUID(), status_token: 'lvd_' + 'd'.repeat(64) } }, 201);
  await h.json(`/privacy-requests/${deletion.privacy_request.id}/approve`, { token: credentials.access_token, body: { operation_key: 'review-' + crypto.randomUUID() } });
  await h.json(`/privacy-requests/${deletion.privacy_request.id}/process`, { token: credentials.access_token, body: {} });
  assert.equal((await h.storage.exec('SELECT count(*) n FROM face_enrollment_intents WHERE account_id=?', i.saved.account_id))[0].n, 0);
  assert.equal((await h.storage.exec('SELECT count(*) n FROM auth_devices WHERE account_id=?', i.saved.account_id))[0].n, 0);
  assert.deepEqual(await h.storage.exec('SELECT c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=\'lovelies_private\' AND c.contype=\'f\' AND NOT c.convalidated'), []);
});
