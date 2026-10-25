import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  startHarness, enroll, faceVerifierFixture, captureProofs, fixturePng,
  deviceEnvelope, sign, sha256, encode, stable,
} from './runtime-harness.mjs';

// Embedded PostgreSQL with private-memory Storage and durable job rows. The verifier
// below is explicitly synthetic: these cases establish protocol/authority and
// recovery behavior, never camera-sensor, model, liveness or civil identity.
const POLICY = 'face-policy-fixture-v1';
const PROTOCOL = 'lovelies-account-recovery-v1';
const DEVICE_PROTOCOL = 'lovelies-account-recovery-device-v1';
const randomSecret = prefix => prefix + encode(crypto.getRandomValues(new Uint8Array(32)));
const operation = () => crypto.randomUUID();
const count = async (h, table, where = '', ...bindings) =>
  (await h.storage.exec(`SELECT count(*) n FROM ${table} ${where}`, ...bindings))[0].n;

async function harness(t, options = {}) {
  const h = await startHarness({ faceVerifier: faceVerifierFixture, consumeQueue: false, ...options });
  t.after(() => h.close()); return h;
}
async function freshLogin(h, person) {
  const challenge = await h.json('/auth/face/challenge', {
    body: { face_handle: person.faceHandle, device_id: person.deviceId },
  }, 201);
  const body = await captureProofs(h, challenge, person.keys.privateKey);
  return h.json('/auth/face/complete', { body });
}
async function issue(h, person, { key = randomSecret('lfr_'), op = operation() } = {}) {
  const body = { operation_key: op, recovery_key: key };
  const metadata = await h.json('/auth/face/recovery/key', { token: person.token, body }, 201);
  assert.equal(metadata.protocol, PROTOCOL); assert.equal(metadata.state, 'ready');
  assert.equal(metadata.account_id, person.accountId); assert.equal(metadata.operation_key, op);
  assert.equal(typeof metadata.key_id, 'string'); assert(Date.parse(metadata.expires_at) > Date.now());
  assertMetadata(metadata, [key]);
  return { key, op, metadata, body };
}
async function intent(person, capability) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  return { keys, jwk, capability, base: {
    account_id: person.accountId, recovery_key: capability.key,
    recovery_request_id: crypto.randomUUID(), face_handle: randomSecret('lfh_'),
    device_public_jwk: jwk, policy_version: POLICY,
  } };
}
async function signed(i, step, fields = {}, signer = i.keys.privateKey) {
  const body = { ...i.base, ...fields };
  return { ...body, device_signature: await sign(signer, { protocol: DEVICE_PROTOCOL, step, ...body }) };
}
async function start(h, i, expected = 201) {
  const result = await h.json('/auth/face/recovery/challenge', { body: await signed(i, 'start') }, expected);
  if (expected === 201) {
    assert.equal(result.protocol, 'lovelies-face-auth-v1'); assert.equal(result.purpose, 'login');
    assert.equal(result.account_id, i.base.account_id); assert.equal(result.recovery_request_id, i.base.recovery_request_id);
    assert.equal(result.recovery_generation, 1); assert.equal(result.required_captures, 1);
    assert.deepEqual(result.poses, ['front']); i.challenge = result;
  }
  return result;
}
async function setup(h) {
  const person = await enroll(h), capability = await issue(h, person), i = await intent(person, capability);
  await start(h, i); return { person, capability, i };
}
function deadline(fields = {}) {
  return { request_nonce: crypto.randomUUID(), request_expires_at: Date.now() + 45_000, ...fields };
}
function assertMetadata(value, secrets = []) {
  const raw = JSON.stringify(value);
  for (const forbidden of ['access_token', 'refresh_token', 'recovery_key', 'face_handle',
    'device_public_jwk', 'public_jwk', 'template_key', 'template_digest', 'reference_digest', 'object_key']) {
    assert(!raw.includes(`"${forbidden}"`), `private field ${forbidden} in metadata`);
  }
  for (const secret of secrets) assert(!raw.includes(secret), 'private capability/handle leaked in metadata');
}
async function status(h, i, expected = 200, fields = {}) {
  const body = await signed(i, 'status', deadline(fields));
  const value = await h.json('/auth/face/recovery/status', { body }, expected);
  if (expected === 200) {
    assert.equal(value.protocol, PROTOCOL); assert.equal(value.authenticated, false);
    assert.equal(value.account_id, i.base.account_id); assert.equal(value.recovery_request_id, i.base.recovery_request_id);
    assert.equal(value.request_nonce, body.request_nonce); assert.equal(value.policy_version, POLICY);
    assert.equal(value.public_key_digest, await sha256(new TextEncoder().encode(stable(i.jwk))));
    if (i.challenge) {
      assert.equal(value.device_id, i.challenge.device_id); assert.equal(value.device_revision, i.challenge.device_revision);
    }
    assert(Date.parse(value.expires_at) > Date.now());
    assertMetadata(value, [i.base.recovery_key, i.base.face_handle]);
    if (value.state === 'registered') { assert.equal(value.challenge, null); assert.deepEqual(value.captures, []); }
  }
  return value;
}
function successor(i, extra = {}) {
  return { resume_key: crypto.randomUUID(), expected_generation: i.challenge.recovery_generation,
    expected_challenge_id: i.challenge.challenge_id, ...extra };
}
async function resume(h, i, fields, expected = 201) {
  return h.json('/auth/face/recovery/resume', { body: await signed(i, 'resume', deadline(fields)) }, expected);
}
async function capture(h, i, { bytes = fixturePng(crypto.randomUUID()), signer = i.keys.privateKey } = {}) {
  const hash = await sha256(bytes), mime = 'image/png';
  const manifest = { index: 0, sha256: hash, mime, byte_size: bytes.byteLength };
  const signature = await sign(signer, { ...deviceEnvelope(i.challenge), step: 'capture', capture_index: 0,
    capture_sha256: hash, mime, byte_size: bytes.byteLength });
  const response = await h.request(`/auth/face/proof/${i.challenge.challenge_id}/0`, {
    method: 'PUT', raw: bytes, headers: { 'content-type': mime, 'x-lovelies-capture-sha256': hash,
      'x-lovelies-capture-bytes': String(bytes.byteLength), 'x-lovelies-device-signature': signature },
  });
  return { response, manifest };
}
async function completion(i, manifest) {
  return { challenge_id: i.challenge.challenge_id, device_signature: await sign(i.keys.privateKey,
    { ...deviceEnvelope(i.challenge), step: 'complete', capture_manifest: [manifest] }) };
}
async function finish(h, i) {
  const proof = await capture(h, i); assert.equal(proof.response.status, 200); await proof.response.arrayBuffer();
  const body = await completion(i, proof.manifest), result = await h.json('/auth/face/complete', { body });
  return { result, body, manifest: proof.manifest };
}
async function assertNoNewAuthority(h, account, sessions, device) {
  assert.equal(await count(h, 'sessions', 'WHERE account_id=?', account), sessions);
  if (device) assert.notEqual((await h.storage.exec('SELECT status FROM auth_devices WHERE id=?', device))[0].status, 'active');
}
// Explicit application SQL authority: every table in the private PostgreSQL
// schema is scanned, including the durable job queue. Unexpected tables fail.
const APPLICATION_TABLES = new Set([
  'face_profile_controls', 'face_profile_states', 'face_profile_operations', 'face_profile_retirements',
  'account_preferences', 'accounts', 'asset_retention', 'assets', 'audit_events',
  'auth_capture_proofs', 'auth_challenges', 'auth_devices', 'blocks', 'candidates',
  'cleanup_intents', 'consents', 'download_records', 'download_tickets',
  'face_enrollment_intents', 'face_profiles', 'face_recovery_intents', 'face_recovery_keys',
  'financial_records', 'match_origins', 'media_grants', 'media_tickets', 'media_write_intents',
  'moderation_holds', 'notification_deliveries', 'notification_jobs', 'notification_settings',
  'notifications', 'operation_subjects', 'operations', 'outbox', 'photo_job_outbox',
  'job_queue', 'privacy_deletion_status_receipts', 'privacy_export_grants',
  'privacy_exports', 'privacy_redaction_context', 'privacy_requests', 'processing_attempts',
  'push_devices', 'renditions', 'request_limits', 'retention_jobs', 'retention_objects',
  'retention_settings', 'retention_scan_cursors', 'safety_reports', 'schema_versions', 'sessions', 'sharing_approvals',
  'sharing_previews', 'sharing_requests', 'sharing_snapshots', 'store_notifications',
  'store_subscriptions', 'store_transactions', 'support_requests',
  'upload_transfers', 'upload_chunks', 'refresh_delivery_receipts',
  'account_audience', 'guardian_requests', 'guardian_purpose_approvals', 'audience_adult_reviews',
]);
async function assertSecretNotStored(h, secret) {
  const tables = await h.storage.exec("SELECT table_name AS name FROM information_schema.tables WHERE table_schema='lovelies_private' AND table_type='BASE TABLE'");
  const scanned = new Set();
  for (const { name } of tables) {
    assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
    assert(APPLICATION_TABLES.has(name), `unexpected table ${name} needs an explicit authority review`);
    assert(!JSON.stringify(await h.storage.exec(`SELECT * FROM "${name}"`)).includes(secret), `${name} stored plaintext capability`);
    scanned.add(name);
  }
  assert.deepEqual([...scanned].sort(), [...APPLICATION_TABLES].sort(), 'all application tables must be scanned');
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function arrived(signal) {
  let timer;
  try { await Promise.race([signal.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('private verifier not reached')), 6000); })]); }
  finally { clearTimeout(timer); }
}

test('A02 key management requires its own registered-face account, persists only a hash, and never returns the key', async t => {
  const h = await harness(t), anonymous = await h.anonymous({adult:true}), person = await enroll(h), other = await enroll(h);
  await h.json('/auth/face/recovery/key', { token: anonymous.access_token, body: { operation_key: operation(), recovery_key: randomSecret('lfr_') } }, 403);
  await h.json('/auth/face/recovery/key', { body: { operation_key: operation(), recovery_key: randomSecret('lfr_') } }, 401);
  const unavailable = await h.json('/auth/face/recovery/key', { token: person.token }); assert.equal(unavailable.state, 'unavailable');
  const capability = await issue(h, person), rows = await h.storage.exec('SELECT * FROM face_recovery_keys WHERE account_id=?', person.accountId);
  assert.equal(rows.length, 1); assert.equal(rows[0].token_hash, await sha256(new TextEncoder().encode(capability.key)));
  assert.equal(rows[0].revoked_at, null); assert.equal(rows[0].consumed_at, null);
  assert(Date.parse(capability.metadata.expires_at) >= Date.now() + 364 * 86_400_000);
  await assertSecretNotStored(h, capability.key);
  const visible = await h.json('/auth/face/recovery/key', { token: person.token }); assert.equal(visible.key_id, rows[0].id);
  assertMetadata(visible, [capability.key]);
  assert.equal((await h.json('/auth/face/recovery/key', { token: other.token })).state, 'unavailable');
  await h.json('/auth/face/recovery/key', { token: person.token, body: { ...capability.body, account_id: other.accountId } }, 400);
  assert.equal(await count(h, 'face_recovery_keys'), 1);
});

test('A02 same key-management operation replays once; conflicts and stale operation retries cannot undo rotation', async t => {
  const h = await harness(t), person = await enroll(h), first = await issue(h, person);
  assert.deepEqual(await h.json('/auth/face/recovery/key', { token: person.token, body: first.body }, 201), first.metadata);
  await h.json('/auth/face/recovery/key', { token: person.token, body: { ...first.body, recovery_key: randomSecret('lfr_') } }, 409);
  assert.equal(await count(h, 'face_recovery_keys'), 1);
  const i = await intent(person, first); await start(h, i);
  const second = await issue(h, person); assert.notEqual(second.metadata.key_id, first.metadata.key_id);
  const keys = await h.storage.exec('SELECT id,revoked_at FROM face_recovery_keys WHERE account_id=?', person.accountId);
  assert(keys.find(row => row.id === first.metadata.key_id).revoked_at !== null);
  assert.equal(keys.find(row => row.id === second.metadata.key_id).revoked_at, null);
  assert.equal((await h.storage.exec('SELECT status FROM auth_challenges WHERE id=?', i.challenge.challenge_id))[0].status, 'cancelled');
  assert.equal((await status(h, i, 401)).error.code, 'account_recovery_unavailable');
  const unavailable = await h.json('/auth/face/recovery/key', { token: person.token, body: first.body }, 401);
  assert.equal(unavailable.error.code, 'account_recovery_unavailable');
  assert.equal(await count(h, 'face_recovery_keys'), 2);
  assert.equal((await h.json('/auth/face/recovery/key', { token: person.token })).key_id, second.metadata.key_id);
  await assertSecretNotStored(h, first.key); await assertSecretNotStored(h, second.key);
});

test('A02 the bounded key-rotation limit preserves the last valid key and permits its exact retry', async t => {
  const h = await harness(t), person = await enroll(h); let current;
  for (let index = 0; index < 10; index++) current = await issue(h, person);
  const replay = await h.json('/auth/face/recovery/key', { token: person.token, body: current.body }, 201);
  assert.deepEqual(replay, current.metadata); assert.equal(await count(h, 'face_recovery_keys'), 10);
  const limited = await h.json('/auth/face/recovery/key', { token: person.token,
    body: { operation_key: operation(), recovery_key: randomSecret('lfr_') } }, 429);
  assert.equal(limited.error.code, 'account_recovery_key_limit');
  assert.equal((await h.json('/auth/face/recovery/key', { token: person.token })).key_id, current.metadata.key_id);
  assert.equal(await count(h, 'face_recovery_keys'), 10);
  assert.equal(await count(h, 'face_recovery_keys', 'WHERE revoked_at IS NULL AND consumed_at IS NULL'), 1);
});

test('A02 key revocation and expiry remove only recovery authority, preserving the account and independent consents', async t => {
  const h = await harness(t), { person, capability, i } = await setup(h);
  const before = await h.storage.exec('SELECT * FROM face_profiles WHERE account_id=?', person.accountId);
  const consents = await h.storage.exec('SELECT * FROM consents WHERE account_id=? ORDER BY id', person.accountId);
  const revoked = await h.json('/auth/face/recovery/key', { token: person.token, method: 'DELETE' });
  assert.equal(revoked.state, 'revoked'); assertMetadata(revoked, [capability.key]);
  await status(h, i, 401); assert.equal((await h.json('/me', { token: person.token })).authenticated, true);
  assert.deepEqual(await h.storage.exec('SELECT * FROM face_profiles WHERE account_id=?', person.accountId), before);
  assert.deepEqual(await h.storage.exec('SELECT * FROM consents WHERE account_id=? ORDER BY id', person.accountId), consents);
  const fresh = await issue(h, person), next = await intent(person, fresh);
  await h.storage.exec('UPDATE face_recovery_keys SET expires_at=created_at+1 WHERE id=?', fresh.metadata.key_id);
  assert.equal((await h.json('/auth/face/recovery/key', { token: person.token })).state, 'unavailable');
  await start(h, next, 401); assert.equal(await count(h, 'accounts'), 1);
});

test('A02 genuine old-key loss creates only a pending new key on the original account and cannot authenticate by itself', async t => {
  const h = await harness(t), { person, capability, i } = await setup(h);
  // All recovery requests/captures use i.keys only; person.keys is never supplied.
  assert.notDeepEqual(i.jwk, await crypto.subtle.exportKey('jwk', person.keys.publicKey));
  const device = (await h.storage.exec('SELECT * FROM auth_devices WHERE id=?', i.challenge.device_id))[0];
  assert.equal(device.account_id, person.accountId); assert.equal(device.status, 'pending');
  assert.notEqual(device.id, person.deviceId); assert.equal(await count(h, 'accounts'), 1);
  const sessions = await count(h, 'sessions', 'WHERE account_id=?', person.accountId);
  const recovered = await status(h, i); assert.equal(recovered.state, 'pending');
  await h.json('/me', { token: capability.key }, 401);
  await h.json('/me/gallery', { token: capability.key }, 401);
  await h.json('/auth/face/challenge', { body: { face_handle: i.base.face_handle, device_id: i.challenge.device_id } }, 401);
  await assertNoNewAuthority(h, person.accountId, sessions, i.challenge.device_id);
});

test('A02 lost start and capture replies reconcile exact immutable metadata without new records or secrets', async t => {
  const h = await harness(t), person = await enroll(h), capability = await issue(h, person), i = await intent(person, capability);
  const lost = await h.request('/auth/face/recovery/challenge', { body: await signed(i, 'start') });
  assert.equal(lost.status, 201); await lost.arrayBuffer(); // Discard the actual successful reply.
  const recovered = await status(h, i); i.challenge = recovered.challenge;
  const replay = await h.json('/auth/face/recovery/challenge', { body: await signed(i, 'start') }, 201);
  assert.equal(replay.challenge_id, recovered.challenge_id); assert.equal(replay.device_id, recovered.device_id);
  assert.equal(await count(h, 'face_recovery_intents'), 1); assert.equal(await count(h, 'auth_devices'), 2);
  const captured = await capture(h, i); assert.equal(captured.response.status, 200); await captured.response.arrayBuffer();
  assert.deepEqual((await status(h, i)).captures, [captured.manifest]);
  const duplicate = await capture(h, i);
  assert.equal(duplicate.response.status, 409); await duplicate.response.arrayBuffer();
  await assertSecretNotStored(h, capability.key);
  assert.equal(await count(h, 'sessions', 'WHERE account_id=?', person.accountId), 2); // Initial anonymous and enrolled sessions only.
});

test('A02 authoritative absence requires both the current exact capability and the new-key signature', async t => {
  const h = await harness(t), person = await enroll(h), capability = await issue(h, person), i = await intent(person, capability);
  assert.equal((await status(h, i, 404)).error.code, 'account_recovery_not_found');
  const wrongSecret = { ...i, base: { ...i.base, recovery_key: randomSecret('lfr_') } };
  assert.equal((await status(h, wrongSecret, 401)).error.code, 'account_recovery_unavailable');
  const other = await enroll(h), wrongAccount = { ...i, base: { ...i.base, account_id: other.accountId } };
  assert.equal((await status(h, wrongAccount, 401)).error.code, 'account_recovery_unavailable');
  const forged = await signed(i, 'status', deadline()); forged.device_signature = encode(new Uint8Array(64));
  await h.json('/auth/face/recovery/status', { body: forged }, 401);
  assert.equal(await count(h, 'face_recovery_intents'), 0);
});

test('A02 saved request identity rejects new handle/key bindings and cannot be reused across accounts', async t => {
  const h = await harness(t), { person, capability, i } = await setup(h);
  for (const change of ['handle', 'key']) {
    const other = await intent(person, capability);
    other.base.recovery_request_id = i.base.recovery_request_id;
    if (change === 'handle') { other.keys = i.keys; other.jwk = i.jwk; other.base.device_public_jwk = i.jwk; }
    else other.base.face_handle = i.base.face_handle;
    await start(h, other, 409);
  }
  assert.equal(await count(h, 'face_recovery_intents'), 1); assert.equal(await count(h, 'auth_devices'), 2);
  const unknown = { ...i, base: { ...i.base, account_id: crypto.randomUUID() } };
  await start(h, unknown, 401);
});

test('A02 wrong fresh face cannot replace the registered reference, consume the key or activate the new device', async t => {
  let wrong = false;
  const h = await harness(t, { faceVerifier: async (envelope, form) => {
    const verdict = await faceVerifierFixture(envelope, form);
    return wrong && envelope.reference_mode === 'existing_reference' ? { ...verdict, reference_match: false } : verdict;
  } });
  const { person, capability, i } = await setup(h), before = await h.storage.exec('SELECT * FROM face_profiles WHERE account_id=?', person.accountId);
  const sessions = await count(h, 'sessions', 'WHERE account_id=?', person.accountId); wrong = true;
  const proof = await capture(h, i); assert.equal(proof.response.status, 200); await proof.response.arrayBuffer();
  await h.json('/auth/face/complete', { body: await completion(i, proof.manifest) }, 401);
  await assertNoNewAuthority(h, person.accountId, sessions, i.challenge.device_id);
  assert.equal((await h.storage.exec('SELECT consumed_at FROM face_recovery_keys WHERE id=?', capability.metadata.key_id))[0].consumed_at, null);
  assert.deepEqual(await h.storage.exec('SELECT * FROM face_profiles WHERE account_id=?', person.accountId), before);
  assert.equal((await status(h, i)).state, 'restart_required');
  wrong = false; i.challenge = await resume(h, i, successor(i));
  assert.equal((await finish(h, i)).result.account_id, person.accountId);
});

test('A04 quality rejection retains the A02 backup/reference and original new-device key for explicit successor',async t=>{
 let reject=false;
 const h=await harness(t,{faceVerifier:async(e,f)=>{const value=await faceVerifierFixture(e,f);
  return reject?{...value,identity_verified:false,reference_match:false,capture_rejection:{code:'quality_low',capture_index:0}}:value;
 }});
 const {person,capability,i}=await setup(h),before=await h.storage.exec('SELECT * FROM face_profiles WHERE account_id=?',person.accountId);
 const sessions=await count(h,'sessions','WHERE account_id=?',person.accountId),old=i.challenge;reject=true;
 const proof=await capture(h,i);assert.equal(proof.response.status,200);await proof.response.arrayBuffer();
 const result=await h.json('/auth/face/complete',{body:await completion(i,proof.manifest)},422);
 assert.deepEqual(result,{error:{code:'face_capture_quality_low'}});
 await assertNoNewAuthority(h,person.accountId,sessions,old.device_id);
 assert.equal((await h.storage.exec('SELECT consumed_at FROM face_recovery_keys WHERE id=?',capability.metadata.key_id))[0].consumed_at,null);
 assert.deepEqual(await h.storage.exec('SELECT * FROM face_profiles WHERE account_id=?',person.accountId),before);
 assert.equal((await status(h,i)).state,'restart_required');
 assert.equal((await capture(h,i)).response.status,409);
 reject=false;i.challenge=await resume(h,i,successor(i));
 assert.equal(i.challenge.device_id,old.device_id);assert.equal(i.challenge.device_revision,old.device_revision);
 assert.equal(i.challenge.recovery_generation,2);
 assert.equal((await finish(h,i)).result.account_id,person.accountId);
});

test('A02 capture and completion reject wrong signing keys without recording proof progress or issuing a session', async t => {
  const h = await harness(t), { person, i } = await setup(h), wrong = await intent(person, i.capability);
  const sessions = await count(h, 'sessions', 'WHERE account_id=?', person.accountId);
  const invalid = await capture(h, i, { signer: wrong.keys.privateKey }); assert.equal(invalid.response.status, 401);
  assert.equal(await count(h, 'auth_capture_proofs', 'WHERE challenge_id=?', i.challenge.challenge_id), 0);
  const valid = await capture(h, i); assert.equal(valid.response.status, 200); await valid.response.arrayBuffer();
  const bad = await completion(i, valid.manifest); bad.device_signature = encode(new Uint8Array(64));
  await h.json('/auth/face/complete', { body: bad }, 401);
  await assertNoNewAuthority(h, person.accountId, sessions, i.challenge.device_id);
});

test('A02 status/resume signatures bind the action, nonce and short future deadline', async t => {
  const h = await harness(t), { i } = await setup(h);
  await h.json('/auth/face/recovery/status', { body: await signed(i, 'status', deadline({ request_expires_at: Date.now() - 1 })) }, 400);
  await h.json('/auth/face/recovery/status', { body: await signed(i, 'status', deadline({ request_expires_at: Date.now() + 120_000 })) }, 400);
  const nonce = await signed(i, 'status', deadline()); nonce.request_nonce = crypto.randomUUID();
  await h.json('/auth/face/recovery/status', { body: nonce }, 401);
  const wrongAction = await signed(i, 'status', deadline(successor(i)));
  await h.json('/auth/face/recovery/resume', { body: wrongAction }, 401);
  assert.equal(await count(h, 'face_recovery_intents'), 1);
});

test('A02 expired raw proofs are physically cleaned before metadata-only recovery and same-device successor replay', async t => {
  const h = await harness(t), { person, i } = await setup(h), old = i.challenge;
  const captured = await capture(h, i); assert.equal(captured.response.status, 200); await captured.response.arrayBuffer();
  const proof = (await h.storage.exec('SELECT object_key FROM auth_capture_proofs WHERE challenge_id=?', old.challenge_id))[0];
  const quarantine = await h.mf.getR2Bucket('QUARANTINE'); assert(await quarantine.head(proof.object_key));
  await h.storage.exec('UPDATE auth_challenges SET expires_at=created_at+1 WHERE id=?', old.challenge_id);
  await h.alarm(); assert.equal(await quarantine.head(proof.object_key), null);
  const recovered = await status(h, i); assert.equal(recovered.state, 'restart_required');
  assert.equal(recovered.challenge_id, old.challenge_id); assert.equal(recovered.challenge, null); assert.deepEqual(recovered.captures, []);
  const fields = successor(i), next = await resume(h, i, fields), replay = await resume(h, i, fields);
  assert.deepEqual(replay, next); assert.equal(next.recovery_generation, 2);
  assert.equal(next.device_id, old.device_id); assert.equal(next.device_revision, old.device_revision);
  assert.notEqual(next.challenge_id, old.challenge_id); assert.notEqual(next.nonce, old.nonce);
  await resume(h, i, successor(i), 409); assert.equal(await count(h, 'auth_devices'), 2);
  i.challenge = next; assert.deepEqual((await status(h, i)).captures, []);
  await h.json('/auth/face/complete', { body: { challenge_id: old.challenge_id, device_signature: encode(new Uint8Array(64)) } }, 409);
  assert.equal((await finish(h, i)).result.account_id, person.accountId);
});

test('A02 unresolved account writer prevents replacement and metadata grants no session before durable settlement', async t => {
  const h = await harness(t), { person, i } = await setup(h), writer = crypto.randomUUID();
  await h.storage.exec("INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at) VALUES(?,?,'QUARANTINE',?,'pending',?)",
    writer, person.accountId, 'synthetic/unresolved-account-recovery-write', Date.now());
  assert.equal((await status(h, i)).state, 'capture_pending');
  await resume(h, i, successor(i), 409);
  assert.equal(await count(h, 'auth_capture_proofs', 'WHERE challenge_id=?', i.challenge.challenge_id), 0);
  await assertNoNewAuthority(h, person.accountId, 2, i.challenge.device_id);
  await h.storage.exec("UPDATE media_write_intents SET status='settled',settled_at=? WHERE id=?", Date.now(), writer);
  assert.equal((await status(h, i)).state, 'pending');
  assert.equal((await finish(h, i)).result.account_id, person.accountId);
});

test('A02 an expired persisted verifying state without a live verifier can resume on the same pending device', async t => {
  const h = await harness(t), { person, i } = await setup(h), previous = i.challenge;
  const sessions = await count(h, 'sessions', 'WHERE account_id=?', person.accountId);
  // Test-only durable state represents an interrupted DO instance. No private
  // verifier promise was started in this live instance for this challenge.
  await h.storage.exec("UPDATE auth_challenges SET status='verifying',attempts=1,expires_at=created_at+1 WHERE id=?", previous.challenge_id);
  const metadata = await status(h, i); assert.equal(metadata.state, 'restart_required');
  assert.equal(metadata.challenge_id, previous.challenge_id); assert.equal(metadata.challenge, null);
  const fields = successor(i), next = await resume(h, i, fields);
  assert.equal(next.recovery_generation, 2); assert.equal(next.device_id, previous.device_id);
  assert.equal(next.device_revision, previous.device_revision); assert.notEqual(next.challenge_id, previous.challenge_id);
  assert.deepEqual(await resume(h, i, fields), next);
  await assertNoNewAuthority(h, person.accountId, sessions, previous.device_id);
  i.challenge = next; assert.equal((await finish(h, i)).result.account_id, person.accountId);
});

test('A02 an actually running verifier remains unresolved after expiry and only permits a successor after settlement', async t => {
  const reached = deferred(), gate = deferred(); let target;
  const h = await harness(t, { faceVerifier: async (envelope, form) => {
    const verdict = await faceVerifierFixture(envelope, form);
    if (envelope.challenge_id === target) { reached.resolve(); await gate.promise; }
    return verdict;
  } });
  const { person, i } = await setup(h); target = i.challenge.challenge_id;
  const sessions = await count(h, 'sessions', 'WHERE account_id=?', person.accountId);
  const proof = await capture(h, i); assert.equal(proof.response.status, 200); await proof.response.arrayBuffer();
  const running = h.request('/auth/face/complete', { body: await completion(i, proof.manifest) });
  try {
    await arrived(reached);
    await h.storage.exec('UPDATE auth_challenges SET expires_at=created_at+1 WHERE id=?', i.challenge.challenge_id);
    const metadata = await status(h, i); assert.equal(metadata.state, 'verifying'); assert.equal(metadata.challenge, null);
    await resume(h, i, successor(i), 409);
    await assertNoNewAuthority(h, person.accountId, sessions, i.challenge.device_id);
    gate.resolve(); const response = await running; assert.equal(response.status, 409); await response.arrayBuffer();
    assert.equal((await status(h, i)).state, 'restart_required');
    const previous = i.challenge, fields = successor(i); i.challenge = await resume(h, i, fields);
    assert.equal(i.challenge.device_id, previous.device_id); assert.equal(i.challenge.recovery_generation, 2);
    assert.equal((await finish(h, i)).result.account_id, person.accountId);
  } finally { gate.resolve(); await running.catch(() => {}); }
});

for (const [name, sql] of [
  ['profile identifier', "UPDATE face_profiles SET id=? WHERE account_id=?"],
  ['profile revision', "UPDATE face_profiles SET revision=? WHERE account_id=?"],
  ['model binding', "UPDATE face_profiles SET model_id=? WHERE account_id=?"],
  ['exact reference digest', "UPDATE face_profiles SET template_digest=? WHERE account_id=?"],
  ['auth consent episode', "UPDATE face_profiles SET auth_consent_id=NULL WHERE account_id=?"],
  ['withdrawn auth consent', "UPDATE consents SET status='revoked',revoked_at=1 WHERE account_id=? AND purpose='face_authentication'"],
  ['consent policy', "UPDATE consents SET policy_version=? WHERE account_id=? AND purpose='face_authentication'"],
  ['disabled account', 'UPDATE accounts SET disabled_at=1 WHERE id=?'],
  ['account epoch', 'UPDATE accounts SET auth_epoch=auth_epoch+1 WHERE id=?'],
  ['profile epoch', 'UPDATE face_profiles SET auth_epoch=auth_epoch+1 WHERE account_id=?'],
  ['pending device revision', 'UPDATE auth_devices SET revision=? WHERE account_id=? AND status=\'pending\''],
]) test(`A02 ${name} drift blocks recovery and session issuance after the original start`, async t => {
  const h = await harness(t), { person, i } = await setup(h), sessions = await count(h, 'sessions', 'WHERE account_id=?', person.accountId);
  const bindings = (sql.match(/\?/g) ?? []).length;
  await h.storage.exec(sql, ...(bindings === 2 ? [crypto.randomUUID(), person.accountId] : [person.accountId]));
  const result = await status(h, i, 401); assert.equal(result.error.code, 'account_recovery_unavailable');
  await resume(h, i, successor(i), 401);
  const proof = await capture(h, i); assert([401, 409].includes(proof.response.status));
  await assertNoNewAuthority(h, person.accountId, sessions, i.challenge.device_id);
});

test('A02 public key revocation during private verification prevents final authentication and cannot be replayed', async t => {
  const reached = deferred(), gate = deferred(); let target;
  const h = await harness(t, { faceVerifier: async (envelope, form) => {
    const verdict = await faceVerifierFixture(envelope, form);
    if (envelope.challenge_id === target) { reached.resolve(); await gate.promise; }
    return verdict;
  } });
  const { person, i } = await setup(h); target = i.challenge.challenge_id;
  const captured = await capture(h, i); assert.equal(captured.response.status, 200); await captured.response.arrayBuffer();
  const body = await completion(i, captured.manifest), sessions = await count(h, 'sessions', 'WHERE account_id=?', person.accountId);
  const running = h.request('/auth/face/complete', { body });
  try {
    await arrived(reached); assert.equal((await status(h, i)).state, 'verifying');
    await resume(h, i, successor(i), 409); await h.json('/auth/face/complete', { body }, 409);
    await h.json('/auth/face/recovery/key', { token: person.token, method: 'DELETE' });
    gate.resolve(); const response = await running; assert([401, 409].includes(response.status)); await response.arrayBuffer();
    await assertNoNewAuthority(h, person.accountId, sessions, i.challenge.device_id);
    await status(h, i, 401);
  } finally { gate.resolve(); await running.catch(() => {}); }
});

test('A02 reference mutation during private verification cannot publish a new device or session', async t => {
  const reached = deferred(), gate = deferred(); let target;
  const h = await harness(t, { faceVerifier: async (envelope, form) => {
    const verdict = await faceVerifierFixture(envelope, form);
    if (envelope.challenge_id === target) { reached.resolve(); await gate.promise; }
    return verdict;
  } });
  const { person, i } = await setup(h); target = i.challenge.challenge_id;
  const proof = await capture(h, i); assert.equal(proof.response.status, 200); await proof.response.arrayBuffer();
  const sessions = await count(h, 'sessions', 'WHERE account_id=?', person.accountId);
  const running = h.request('/auth/face/complete', { body: await completion(i, proof.manifest) });
  try {
    await arrived(reached); await h.storage.exec("UPDATE face_profiles SET template_digest=? WHERE account_id=?", '0'.repeat(64), person.accountId);
    gate.resolve(); const response = await running; assert([401, 409].includes(response.status)); await response.arrayBuffer();
    await assertNoNewAuthority(h, person.accountId, sessions, i.challenge.device_id);
  } finally { gate.resolve(); await running.catch(() => {}); }
});

test('A02 a registered-account deletion hold created during inference has priority over final recovery', async t => {
  const reached = deferred(), gate = deferred(); let target;
  const h = await harness(t, { faceVerifier: async (envelope, form) => {
    const verdict = await faceVerifierFixture(envelope, form);
    if (envelope.challenge_id === target) { reached.resolve(); await gate.promise; }
    return verdict;
  } });
  const { person, i } = await setup(h); target = i.challenge.challenge_id;
  const proof = await capture(h, i); assert.equal(proof.response.status, 200); await proof.response.arrayBuffer();
  const sessions = await count(h, 'sessions', 'WHERE account_id=?', person.accountId);
  const running = h.request('/auth/face/complete', { body: await completion(i, proof.manifest) });
  try {
    await arrived(reached);
    await h.json('/privacy/account-deletion', { token: person.token,
      body: { operation_key: operation(), status_token: 'lvd_' + 'a'.repeat(64) } }, 201);
    gate.resolve(); const response = await running; assert([401, 409].includes(response.status)); await response.arrayBuffer();
    await assertNoNewAuthority(h, person.accountId, sessions, i.challenge.device_id);
    const held = await h.request('/auth/face/recovery/status', { body: await signed(i, 'status', deadline()) });
    assert([401, 409].includes(held.status)); await held.arrayBuffer();
  } finally { gate.resolve(); await running.catch(() => {}); }
});

test('A02 lost committed response consumes the key once; signed receipt cannot authenticate or create another request', async t => {
  const h = await harness(t), { person, capability, i } = await setup(h), before = (await h.storage.exec('SELECT * FROM face_profiles WHERE account_id=?', person.accountId))[0];
  const proof = await capture(h, i); assert.equal(proof.response.status, 200); await proof.response.arrayBuffer();
  const body = await completion(i, proof.manifest), lost = await h.request('/auth/face/complete', { body });
  assert.equal(lost.status, 200); await lost.arrayBuffer(); // Client has no returned credentials.
  const registered = await status(h, i); assert.equal(registered.state, 'registered');
  assert.deepEqual(registered.profile, { id: before.id, revision: before.revision, model_id: before.model_id });
  assert.equal((await h.storage.exec('SELECT consumed_at FROM face_recovery_keys WHERE id=?', capability.metadata.key_id))[0].consumed_at !== null, true);
  await h.json('/auth/face/complete', { body }, 409);
  const replay = await start(h, i, 409); assert.equal(replay.error.code, 'account_recovery_registered');
  const another = await intent(person, capability); await start(h, another, 401);
  assert.equal(await count(h, 'face_recovery_intents'), 1);
  await h.json('/me', { token: capability.key }, 401);
  const fresh = { keys: i.keys, faceHandle: i.base.face_handle, deviceId: i.challenge.device_id };
  const credentials = await freshLogin(h, fresh);
  assert.equal(credentials.account_id, person.accountId); assert.equal(credentials.auth_method, 'registered_face');
  assert.equal((await h.json('/me', { token: credentials.access_token })).profile_id, before.id);
  await h.json('/me', { token: person.token }, 401);
  await h.json('/auth/session/refresh', { body: { refresh_token: person.refresh_token } }, 401);
});

async function preferences(h, person) {
  return h.json('/me/photo-preferences', { token: person.token, body: {
    receive_matches: true, photo_matching_consent: true, processing_consent: true,
    policy_version: 'photo-policy-fixture-v1', operation_key: operation(),
  } });
}
async function waitFor(read, check) {
  const until = Date.now() + 8000;
  for (;;) {
    const value = await read(); if (check(value)) return value;
    if (Date.now() >= until) throw new Error('actual queued photo processing did not finish');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function graph(h) {
  const tables = ['sharing_snapshots', 'sharing_previews', 'sharing_requests', 'sharing_approvals',
    'media_grants', 'candidates', 'match_origins', 'assets', 'renditions'];
  const result = {};
  for (const table of tables) result[table] = await h.storage.exec(`SELECT * FROM ${table} ORDER BY id`);
  return result;
}
test('A02 restores exact account/profile/roles while revoking old devices/sessions and preserving real approved photo subsets', async t => {
  let recipientId;
  const h = await harness(t, { consumeQueue: true, photoProcessor: envelope => ({
    attempt_id: envelope.attempt_id, nonce: envelope.nonce, asset_id: envelope.asset_id,
    source_version: envelope.source_version, source_checksum_sha256: envelope.source_checksum_sha256, model_version: envelope.model_version, engine_identity: envelope.engine_identity,
    preview: { bytes_base64: Buffer.from(fixturePng(envelope.asset_id)).toString('base64'), content_type: 'image/png', width: 1, height: 1 },
    matches: envelope.profiles.filter(profile => profile.account_id === recipientId).map(profile => ({
      recipient_id: profile.account_id, profile_id: profile.profile_id, profile_version: profile.revision, model_version: profile.model_id,
    })),
  }) });
  const owner = await enroll(h), person = await enroll(h); recipientId = person.accountId;
  // A retired stored role must never be issued again. Fresh face login and
  // recovery retain the active user role without changing historical rows.
  await h.storage.exec('UPDATE accounts SET roles_json=? WHERE id=?', JSON.stringify(['user', 'photographer']), person.accountId);
  const roleCredentials = await freshLogin(h, person); person.token = roleCredentials.access_token;
  await preferences(h, owner); await preferences(h, person);
  const bytes = fixturePng(crypto.randomUUID()), uploaded = await h.json('/uploads/session', { token: owner.token, body: {
    content_type: 'image/png', byte_size: bytes.byteLength, upload_batch_id: crypto.randomUUID(), source: 'personal',
    title: 'Synthetic approved photo fixture', operation_key: operation(),
  } }, 201);
  await h.json(uploaded.upload_url, { token: owner.token, raw: bytes, method: 'PUT', headers: { 'content-type': 'image/png' } });
  await h.json(uploaded.complete_url, { token: owner.token, body: { operation_key: operation() } }, 202);
  const processed = await waitFor(() => h.json(`/uploads/${uploaded.asset_id}/status`, { token: owner.token }), value => ['ready', 'failed'].includes(value.status));
  assert.equal(processed.status, 'ready');
  const snapshot = (await h.community(owner.token, 'sharing.snapshot', { asset_ids: [uploaded.asset_id], operation_key: operation() })).snapshot;
  const preview = (await h.community(owner.token, 'sharing.preview', {
    snapshot_id: snapshot.id, snapshot_version: snapshot.version, draft_version: 1, selected_asset_ids: [uploaded.asset_id],
    selected_recipient_ids: [person.accountId], excluded_pairs: [], operation_key: operation(),
  })).preview;
  const committed = await h.community(owner.token, 'sharing.commit', { preview_id: preview.id, preview_version: preview.version, draft_version: 1, operation_key: operation() });
  const request = committed.recipients.find(row => row.recipient_id === person.accountId).request_id;
  await h.community(person.token, 'request.decide', { request_id: request, decision: 'accept', operation_key: operation() });
  const before = await graph(h), profile = await h.storage.exec('SELECT * FROM face_profiles WHERE account_id=?', person.accountId);
  const consents = await h.storage.exec('SELECT * FROM consents WHERE account_id=? ORDER BY id', person.accountId);
  const capability = await issue(h, person), i = await intent(person, capability); await start(h, i);
  const epoch = (await h.storage.exec('SELECT auth_epoch FROM accounts WHERE id=?', person.accountId))[0].auth_epoch;
  const { result } = await finish(h, i);
  assert.equal(result.account_id, person.accountId); assert.deepEqual(result.roles, ['user']);
  assert.equal(result.profile_id, profile[0].id); assert.equal(result.profile_revision, profile[0].revision); assert.equal(result.model_id, profile[0].model_id);
  assert.equal((await h.storage.exec('SELECT auth_epoch FROM accounts WHERE id=?', person.accountId))[0].auth_epoch, epoch + 1);
  assert.deepEqual(await h.storage.exec('SELECT * FROM face_profiles WHERE account_id=?', person.accountId), profile);
  assert.deepEqual(await h.storage.exec('SELECT * FROM consents WHERE account_id=? ORDER BY id', person.accountId), consents);
  assert.deepEqual(await graph(h), before);
  assert.equal(await count(h, 'auth_devices', "WHERE account_id=? AND status='active'", person.accountId), 1);
  assert.equal((await h.storage.exec('SELECT status FROM auth_devices WHERE id=?', person.deviceId))[0].status, 'revoked');
  assert.equal(await count(h, 'sessions', 'WHERE account_id=? AND revoked_at IS NULL', person.accountId), 1);
  await h.json('/me', { token: roleCredentials.access_token }, 401);
  const gallery = await h.json('/me/gallery', { token: result.access_token });
  assert.deepEqual(gallery.gallery_items.map(row => row.media_asset_id), [uploaded.asset_id]);
  assert.deepEqual((await h.community(result.access_token, 'photos.validate', { asset_ids: [uploaded.asset_id] })).authorized_ids, [uploaded.asset_id]);
  const photo = await h.request(`/community/media/${uploaded.asset_id}/preview`, { token: result.access_token });
  assert.equal(photo.status, 200); assert.deepEqual(new Uint8Array(await photo.arrayBuffer()), fixturePng(uploaded.asset_id));
});

test('A02 consumed receipt expiry denies only recovery metadata while the exact activated device can still fresh-login', async t => {
  const h = await harness(t), { person, capability, i } = await setup(h); await finish(h, i);
  await h.storage.exec('UPDATE face_recovery_intents SET expires_at=created_at+1 WHERE account_id=? AND recovery_request_id=?', person.accountId, i.base.recovery_request_id);
  assert.equal((await status(h, i, 401)).error.code, 'account_recovery_unavailable');
  await h.storage.exec('UPDATE face_recovery_keys SET created_at=? WHERE id=?', Date.now() - 8 * 86_400_000, capability.metadata.key_id);
  await h.alarm();
  assert.equal(await count(h, 'face_recovery_intents', 'WHERE account_id=?', person.accountId), 0);
  assert.equal(await count(h, 'face_recovery_keys', 'WHERE account_id=?', person.accountId), 0);
  const credentials = await freshLogin(h, { keys: i.keys, faceHandle: i.base.face_handle, deviceId: i.challenge.device_id });
  assert.equal(credentials.account_id, person.accountId); assert.equal(await count(h, 'accounts'), 1);
});

async function administrator(h) {
  const person = await enroll(h);
  await h.storage.exec('UPDATE accounts SET roles_json=? WHERE id=?', JSON.stringify(['user', 'admin']), person.accountId);
  const credential = await freshLogin(h, person); return { ...person, token: credential.access_token };
}
test('A02 independently approved account erasure removes recovery keys/receipts and verifies exact R2 proof cleanup', async t => {
  const h = await harness(t), { person, capability, i } = await setup(h), admin = await administrator(h);
  const proof = await capture(h, i); assert.equal(proof.response.status, 200); await proof.response.arrayBuffer();
  const reference = (await h.storage.exec('SELECT template_key FROM face_profiles WHERE account_id=?', person.accountId))[0].template_key;
  const raw = (await h.storage.exec('SELECT object_key FROM auth_capture_proofs WHERE challenge_id=?', i.challenge.challenge_id))[0].object_key;
  const deletion = (await h.json('/privacy/account-deletion', { token: person.token, body: {
    operation_key: operation(), status_token: 'lvd_' + 'd'.repeat(64),
  } }, 201)).privacy_request;
  await h.json(`/privacy-requests/${deletion.id}/approve`, { token: admin.token, body: { operation_key: operation() } });
  const processed = await h.json(`/privacy-requests/${deletion.id}/process`, { token: admin.token, body: {} });
  assert.equal(processed.privacy_request.status, 'completed');
  for (const table of ['face_recovery_intents', 'face_recovery_keys', 'auth_devices', 'face_profiles'])
    assert.equal(await count(h, table, 'WHERE account_id=?', person.accountId), 0, table);
  assert.equal(await (await h.mf.getR2Bucket('QUARANTINE')).head(raw), null);
  assert.equal(await (await h.mf.getR2Bucket('PHOTOS')).head(reference), null);
  assert.equal((await h.storage.exec('SELECT disabled_at FROM accounts WHERE id=?', person.accountId))[0].disabled_at !== null, true);
  assert.equal((await status(h, i, 401)).error.code, 'account_recovery_unavailable');
  assert((await h.storage.exec('SELECT verified_at FROM cleanup_intents WHERE request_id=?', deletion.id)).every(row => row.verified_at !== null));
  await assertSecretNotStored(h, capability.key);
});
