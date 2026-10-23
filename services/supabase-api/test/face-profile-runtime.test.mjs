import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  startHarness, enroll, faceVerifierFixture, captureProofs, fixturePng,
  deviceEnvelope, sign, sha256, encode, stable,
} from './runtime-harness.mjs';

// Embedded PostgreSQL (PGlite), in-memory private Storage and durable jobs.
// Synthetic verifier verdicts establish protocol and authorization, never hosted
// Storage, distributed locking, model qualification or camera/civil identity.
const AUTH_POLICY = 'face-policy-fixture-v1';
const PHOTO_POLICY = 'photo-policy-fixture-v1';
const PROTOCOL = 'lovelies-face-profile-v1';
const DEVICE_PROTOCOL = 'lovelies-face-profile-device-v1';
const uuid = () => crypto.randomUUID();
const secret = prefix => prefix + encode(crypto.getRandomValues(new Uint8Array(32)));
const count = async (h, table, where = '', ...bindings) =>
  (await h.storage.exec('SELECT count(*) n FROM ' + table + ' ' + where, ...bindings))[0].n;
const profile = async (h, person) =>
  (await h.storage.exec('SELECT * FROM face_profiles WHERE account_id=?', person.accountId))[0];
const activeConsents = (h, person) => h.storage.exec(
  "SELECT id,purpose,policy_version,profile_revision FROM consents WHERE account_id=? AND status='granted' AND revoked_at IS NULL ORDER BY purpose,id",
  person.accountId,
);
function deferred() {
  let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve };
}
async function arrived(signal) {
  let timer;
  try {
    await Promise.race([signal.promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('private fixture was not reached')), 6000);
    })]);
  } finally { clearTimeout(timer); }
}
async function replacementVerifier(envelope, form) {
  const verdict = await faceVerifierFixture(envelope, form);
  if (envelope.reference_mode !== 'replace_reference') return verdict;
  assert.equal(envelope.required_captures, 3);
  assert.deepEqual(envelope.poses, ['front', 'left', 'right']);
  assert.equal(envelope.capture_manifest.length, 3);
  assert.equal(new Set(envelope.capture_manifest.map(capture => capture.sha256)).size, 3);
  assert.equal(verdict.reference_match, true); // All bytes and old reference were checked above.
  const bytes = new TextEncoder().encode('synthetic-replacement:' + envelope.account_id + ':' + envelope.challenge_id);
  return { ...verdict, enrollment_verified: true,
    pose_evidence: envelope.capture_manifest.map((capture, index) => ({ index: capture.index,
      pose: envelope.poses[index], capture_sha256: capture.sha256, verified: true })),
    registered_reference: { revision: uuid(), model_id: 'face-model-fixture-v1',
      template_sha256: await sha256(bytes), template_base64: encode(bytes) } };
}
async function harness(t, options = {}) {
  const h = await startHarness({ faceVerifier: replacementVerifier, consumeQueue: false,
    ...options, vars: { PHOTO_CONSENT_POLICY_VERSION: PHOTO_POLICY, ...options.vars } });
  t.after(() => h.close()); return h;
}
async function signed(control, step, fields = {}, { nonce = true, signer = control.person.keys.privateKey } = {}) {
  const body = JSON.parse(JSON.stringify({ account_id: control.person.accountId, device_id: control.person.deviceId,
    control_key: control.key,
    ...(nonce ? { request_nonce: uuid(), request_expires_at: Date.now() + 45_000 } : {}), ...fields }));
  return { ...body, device_signature: await sign(signer, { protocol: DEVICE_PROTOCOL, step, ...body }) };
}
function assertMetadata(value, control) {
  assert.equal(value.protocol, PROTOCOL); assert.equal(value.authenticated, false);
  assert.equal(value.account_id, control.person.accountId); assert.equal(value.device_id, control.person.deviceId);
  assert.equal(value.device_revision, control.deviceRevision);
  assert.equal(value.public_key_digest, control.publicKeyDigest);
  assert(Number.isSafeInteger(value.version) && value.version > 0);
  assert.equal(value.auth_policy_version, AUTH_POLICY); assert.equal(value.photo_policy_version, PHOTO_POLICY);
  const raw = JSON.stringify(value);
  for (const forbidden of ['access_token', 'refresh_token', 'face_handle', 'device_public_jwk',
    'public_jwk', 'template_key', 'template_digest', 'reference_digest', 'object_key', 'control_key'])
    assert(!raw.includes('"' + forbidden + '"'), 'private metadata field: ' + forbidden);
  for (const privateValue of [control.key, control.person.faceHandle]) assert(!raw.includes(privateValue));
  if (value.operation && ['applied', 'completed'].includes(value.operation.state)) {
    assert.equal(value.operation.challenge, null); assert.deepEqual(value.operation.captures, []);
  }
}
async function controlIntent(h, person) {
  const row = (await h.storage.exec('SELECT revision,public_jwk FROM auth_devices WHERE id=?', person.deviceId))[0];
  return { person, key: secret('lfl_'), creationKey: uuid(), deviceRevision: row.revision,
    publicKeyDigest: await sha256(new TextEncoder().encode(stable(JSON.parse(row.public_jwk)))) };
}
async function createControl(h, person) {
  const control = await controlIntent(h, person);
  control.body = await signed(control, 'control', { control_operation_key: control.creationKey }, { nonce: false });
  control.metadata = await h.json('/auth/face/profile/control', { token: person.token, body: control.body }, 201);
  assertMetadata(control.metadata, control); return control;
}
async function status(h, control, operationKey, expected = 200, fields = {}) {
  const body = await signed(control, 'status', { ...(operationKey ? { operation_key: operationKey } : {}), ...fields });
  const value = await h.json('/auth/face/profile/status', { body }, expected);
  if (expected === 200) { assertMetadata(value, control); assert.equal(value.request_nonce, body.request_nonce); }
  return value;
}
async function action(h, control, name, { expectedVersion, operationKey = uuid(), fields = {}, expected = 200 } = {}) {
  const version = expectedVersion ?? (await status(h, control)).version;
  const intent = { operation_key: operationKey, action: name, expected_version: version,
    ...(name === 'resume' ? { consent: { purpose: 'photo_matching', policy_version: PHOTO_POLICY, granted: true } } : {}), ...fields };
  const value = await h.json('/auth/face/profile/action', { body: await signed(control, 'action', intent) }, expected);
  if (expected === 200) { assertMetadata(value, control); assert.equal(value.operation.operation_key, operationKey); }
  return { value, intent };
}
async function challenge(h, control, name, { operationKey = uuid(), expectedVersion, expected = 201, fields = {} } = {}) {
  const intent = { operation_key: operationKey, action: name,
    expected_version: expectedVersion ?? (await status(h, control)).version,
    consent: { purpose: 'face_authentication', policy_version: AUTH_POLICY, granted: true }, ...fields };
  const value = await h.json('/auth/face/profile/challenge', { body: await signed(control, 'challenge', intent) }, expected);
  if (expected === 201) {
    assert.equal(value.protocol, 'lovelies-face-auth-v1'); assert.equal(value.account_id, control.person.accountId);
    assert.equal(value.device_id, control.person.deviceId); assert.equal(value.device_revision, control.deviceRevision);
    assert.equal(value.lifecycle_operation_key, operationKey); assert.equal(value.lifecycle_generation, 1);
    assert.equal(value.required_captures, name === 'restore_authentication' ? 1 : 3);
    assert.equal(value.purpose, name === 'replace' ? 'replacement' : 'registration');
    assert.deepEqual(value.poses, name === 'restore_authentication' ? ['front'] : ['front', 'left', 'right']);
  }
  return { control, intent, challenge: value };
}
async function complete(h, pending, { expected = 200, completion } = {}) {
  const body = completion ?? await captureProofs(h, pending.challenge, pending.control.person.keys.privateKey);
  const value = await h.json('/auth/face/profile/complete', { body }, expected);
  if (expected === 200) {
    assert.equal(value.account_id, pending.control.person.accountId); assert.equal(value.device_id, pending.control.person.deviceId);
    assert.equal(value.auth_method, 'registered_face');
    assert.equal((await h.json('/me', { token: value.access_token })).user_id, value.account_id);
    const devices = await h.json('/me/devices', { token: value.access_token });
    const current = devices.items.filter(device => device.id === value.device_id && device.status === 'active' && device.current);
    assert.equal(current.length, 1);
  }
  return { value, body };
}

test('A04 replacement quality failure retains the A03 control/reference/device for an exact signed successor',async t=>{
 let reject=false;
 const h=await harness(t,{faceVerifier:async(e,f)=>{const value=await replacementVerifier(e,f);
  if(!reject)return value;delete value.registered_reference;delete value.pose_evidence;
  return {...value,identity_verified:false,reference_match:false,enrollment_verified:false,capture_rejection:{code:'multiple_faces',capture_index:2}};
 }});
 const person=await enroll(h),control=await createControl(h,person),pending=await challenge(h,control,'replace');
 const before=await profile(h,person),consents=await activeConsents(h,person);reject=true;
 const result=await complete(h,pending,{expected:422});assert.deepEqual(result.value,{error:{code:'face_capture_multiple_faces'}});
 assert.deepEqual(await profile(h,person),before);assert.deepEqual(await activeConsents(h,person),consents);
 assert.equal((await h.json('/me',{token:person.token})).user_id,person.accountId);
 const state=await status(h,control,pending.intent.operation_key);assert.equal(state.operation.state,'failed');
 assert.equal(state.operation.challenge,null);assert.deepEqual(state.operation.captures,[]);
 assert.equal(await count(h,'auth_capture_proofs','WHERE challenge_id=?',pending.challenge.challenge_id),0);
 const fields={operation_key:pending.intent.operation_key,resume_key:uuid(),expected_challenge_id:pending.challenge.challenge_id,expected_generation:1};
 const next=await h.json('/auth/face/profile/resume',{body:await signed(control,'resume',fields)},201);
 assert.equal(next.device_id,person.deviceId);assert.equal(next.device_revision,control.deviceRevision);
 assert.equal(next.profile_id,before.id);assert.equal(next.profile_revision,before.revision);assert.equal(next.lifecycle_generation,2);
 reject=false;const confirmed=await complete(h,{...pending,challenge:next});
 assert.equal(confirmed.value.account_id,person.accountId);assert.equal((await profile(h,person)).id,before.id);
 assert.notEqual((await profile(h,person)).revision,before.revision);
});
async function login(h, person) {
  const next = await h.json('/auth/face/challenge', { body: { face_handle: person.faceHandle, device_id: person.deviceId } }, 201);
  const value = await h.json('/auth/face/complete', { body: await captureProofs(h, next, person.keys.privateKey) });
  assert.equal(value.account_id, person.accountId); assert.equal(value.device_id, person.deviceId); return value;
}
async function capture(h, pending, index, { bytes = fixturePng(uuid()), signer = pending.control.person.keys.privateKey,
  hash, challenge: target = pending.challenge } = {}) {
  const digest = hash ?? await sha256(bytes), mime = 'image/png';
  const manifest = { index, sha256: digest, mime, byte_size: bytes.byteLength };
  const signature = await sign(signer, { ...deviceEnvelope(target), step: 'capture', capture_index: index,
    capture_sha256: digest, mime, byte_size: bytes.byteLength });
  const response = await h.request('/auth/face/proof/' + target.challenge_id + '/' + index, {
    method: 'PUT', raw: bytes, headers: { 'content-type': mime,
      'x-lovelies-capture-sha256': digest, 'x-lovelies-capture-bytes': String(bytes.byteLength),
      'x-lovelies-device-signature': signature } });
  return { response, manifest };
}
async function assertNoPlaintextControl(h, control) {
  const tables = await h.storage.exec("SELECT table_name AS name FROM information_schema.tables WHERE table_schema='lovelies_private' AND table_type='BASE TABLE'");
  const seen = new Set();
  for (const { name } of tables) {
    assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
    if (name === '_cf_METADATA') {
      // Runtime-owned metadata is outside application read authority. Do not
      // bypass SQLITE_AUTH or make a plaintext-content claim for that table.
      await assert.rejects(() => h.storage.exec('SELECT * FROM "' + name + '"'), /SQLITE_AUTH/); continue;
    }
    const rows = await h.storage.exec('SELECT * FROM "' + name + '"');
    assert(!JSON.stringify(rows).includes(control.key), name + ' contains a plaintext lifecycle capability'); seen.add(name);
  }
  for (const name of ['face_profile_controls', 'face_profile_states', 'face_profile_operations', 'face_profile_retirements'])
    assert(seen.has(name), 'missing lifecycle application table ' + name);
}
async function preferences(h, person, extra = {}) {
  return h.json('/me/photo-preferences', { token: person.token, body: { receive_matches: true,
    photo_matching_consent: true, processing_consent: true, policy_version: PHOTO_POLICY, operation_key: uuid(), ...extra } });
}
function processorResult(envelope) {
  return { attempt_id: envelope.attempt_id, nonce: envelope.nonce, asset_id: envelope.asset_id,
    source_version: envelope.source_version, source_checksum_sha256: envelope.source_checksum_sha256,
    model_version: envelope.model_version,
    preview: { bytes_base64: Buffer.from(fixturePng(envelope.asset_id)).toString('base64'), content_type: 'image/png', width: 1, height: 1 },
    matches: envelope.profiles.map(person => ({ recipient_id: person.account_id,
      profile_id: person.profile_id, profile_version: person.revision, model_version: person.model_id })) };
}
async function uploaded(h, owner) {
  const bytes = fixturePng(uuid());
  const item = await h.json('/uploads/session', { token: owner.token, body: { content_type: 'image/png',
    byte_size: bytes.byteLength, source: 'personal', title: 'Synthetic authority fixture', operation_key: uuid() } }, 201);
  await h.json(item.upload_url, { token: owner.token, method: 'PUT', raw: bytes, headers: { 'content-type': 'image/png' } });
  await h.json(item.complete_url, { token: owner.token, body: { operation_key: uuid() } }, 202);
  const attempt = (await h.storage.exec('SELECT id,profiles_json FROM processing_attempts WHERE asset_id=?', item.asset_id))[0];
  return { ...item, attempt };
}
async function deliverPhoto(h, attemptId) {
  // Trusted in-process fixture invokes the actual processing handler. The public
  // maintenance route still requires its deployment secret.
  const {processPhotoJob}=await import('../src/processing.ts');
  await processPhotoJob({attempt_id:attemptId},h.app);
}
async function accepted(h, owner, recipient, photo) {
  const snapshot = (await h.community(owner.token, 'sharing.snapshot', { asset_ids: [photo.asset_id], operation_key: uuid() })).snapshot;
  const preview = (await h.community(owner.token, 'sharing.preview', { snapshot_id: snapshot.id,
    snapshot_version: snapshot.version, draft_version: 1, selected_asset_ids: [photo.asset_id],
    selected_recipient_ids: [recipient.accountId], excluded_pairs: [], operation_key: uuid() })).preview;
  assert(preview); assert.deepEqual(preview.totals, { photos: 1, recipients: 1, pairs: 1 });
  const result = await h.community(owner.token, 'sharing.commit', { preview_id: preview.id,
    preview_version: preview.version, draft_version: 1, operation_key: uuid() });
  const request = result.recipients.find(person => person.recipient_id === recipient.accountId);
  await h.community(recipient.token, 'request.decide', { request_id: request.request_id, decision: 'accept', operation_key: uuid() });
  assert.equal((await h.request('/community/media/' + photo.asset_id + '/preview', { token: recipient.token })).status, 200);
  return request;
}
async function writer(h, person, objectKey) {
  const id = uuid(); await h.storage.exec(
    "INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at) VALUES(?,?,'PHOTOS',?,'pending',?)",
    id, person.accountId, objectKey, Date.now()); return id;
}
const settleWriter = (h, id) => h.storage.exec("UPDATE media_write_intents SET status='settled',settled_at=? WHERE id=?", Date.now(), id);

test('A03 original registered device creates one hash-only lifecycle control; status is not a media/session grant', async t => {
  const h = await harness(t), person = await enroll(h), initial = await controlIntent(h, person);
  const firstGet = await h.json('/me/face-profile', { token: person.token });
  assertMetadata(firstGet, initial); assert.equal(firstGet.public_key_digest, initial.publicKeyDigest);
  assert.equal(firstGet.profile.id, person.profile_id); assert.equal(firstGet.profile.revision, person.profile_revision);
  assert.equal(firstGet.operation, null); assert.equal(await count(h, 'face_profile_controls'), 0);
  const control = await createControl(h, person);
  assert.equal(await count(h, 'accounts'), 1); assert.equal(await count(h, 'auth_devices'), 1);
  const rows = await h.storage.exec('SELECT * FROM face_profile_controls WHERE account_id=?', person.accountId);
  assert.equal(rows.length, 1); assert.equal(rows[0].control_hash, await sha256(new TextEncoder().encode(control.key)));
  assert.equal(rows[0].device_id, person.deviceId); assert.equal(rows[0].public_key_digest, control.publicKeyDigest);
  const again = await h.json('/auth/face/profile/control', { token: person.token, body: control.body }, 201);
  assert.deepEqual(again, control.metadata); assert.equal(await count(h, 'face_profile_controls'), 1);
  const metadata = await status(h, control); assert.equal(metadata.authentication_enabled, true);
  assert.equal(metadata.matching_enabled, false); assert.equal(metadata.processing_enabled, false);
  const bearerMetadata = await h.json('/me/face-profile', { token: person.token }); assertMetadata(bearerMetadata, control);
  for (const route of ['/me', '/me/gallery', '/me/devices', '/privacy/center']) await h.json(route, { token: control.key }, 401);
  await h.json('/privacy/export', { token: control.key, body: { operation_key: uuid() } }, 401);
  await h.json('/previews/sign', { token: control.key, body: { asset_id: uuid() } }, 401);
  assert.equal(await count(h, 'sessions', "WHERE revoked_at IS NULL AND auth_method='registered_face'"), 1);
  await assertNoPlaintextControl(h, control);
});

test('A03 creation requires the current original device and rejects anonymous, foreign, unsigned or conflicting controls', async t => {
  const h = await harness(t), person = await enroll(h), other = await enroll(h), guest = await h.anonymous();
  const control = await controlIntent(h, person);
  const body = await signed(control, 'control', { control_operation_key: control.creationKey }, { nonce: false });
  await h.json('/auth/face/profile/control', { token: guest.access_token, body }, 403);
  await h.json('/auth/face/profile/control', { token: other.token, body }, 403);
  await h.json('/auth/face/profile/control', { body }, 401);
  await h.json('/auth/face/profile/control', { token: person.token, body: { ...body, device_signature: encode(new Uint8Array(64)) } }, 401);
  assert.equal(await count(h, 'face_profile_controls'), 0);
  await h.json('/auth/face/profile/control', { token: person.token, body }, 201);
  const conflict = await signed(control, 'control', { control_key: secret('lfl_'), control_operation_key: uuid() }, { nonce: false });
  await h.json('/auth/face/profile/control', { token: person.token, body: conflict }, 409);
  assert.equal(await count(h, 'face_profile_controls'), 1); assert.equal(await count(h, 'accounts'), 3);
});

test('A03 lost control/action replies recover read-only current metadata and never reapply an exact operation', async t => {
  const h = await harness(t), person = await enroll(h), control = await controlIntent(h, person);
  const createBody = await signed(control, 'control', { control_operation_key: control.creationKey }, { nonce: false });
  const initial = await h.request('/auth/face/profile/control', { token: person.token, body: createBody });
  assert.equal(initial.status, 201); await initial.arrayBuffer(); // Deliberately discard the actual acknowledgement.
  const before = await status(h, control), op = uuid();
  const intent = { operation_key: op, action: 'pause', expected_version: before.version };
  const reply = await h.request('/auth/face/profile/action', { body: await signed(control, 'action', intent) });
  assert.equal(reply.status, 200); await reply.arrayBuffer();
  const recovered = await status(h, control, op); assert.equal(recovered.operation.state, 'applied');
  const consents = await activeConsents(h, person);
  const replay = await h.json('/auth/face/profile/action', { body: await signed(control, 'action', intent) });
  assert.equal(replay.version, recovered.version); assert.equal(await count(h, 'face_profile_operations'), 1);
  assert.deepEqual(await activeConsents(h, person), consents);
  await h.json('/auth/face/profile/action', { body: await signed(control, 'action', { ...intent, action: 'remove' }) }, 409);
  const unknown = await status(h, control, uuid(), 404); assert.equal(unknown.error.code, 'face_profile_operation_not_found');
  assert.equal((await h.json('/me', { token: person.token })).authenticated, true);
});

for (const fault of ['secret', 'signature', 'account', 'device', 'expired-deadline', 'future-deadline', 'nonce', 'unsigned-mutation'])
  test('A03 signed management rejects ' + fault + ' without lifecycle effects', async t => {
    const h = await harness(t), person = await enroll(h), control = await createControl(h, person);
    const before = await profile(h, person); const fields = { operation_key: uuid(), action: 'pause', expected_version: control.metadata.version };
    if (fault === 'secret') fields.control_key = secret('lfl_');
    if (fault === 'account') fields.account_id = uuid();
    if (fault === 'device') fields.device_id = uuid();
    if (fault === 'expired-deadline') fields.request_expires_at = Date.now() - 1;
    if (fault === 'future-deadline') fields.request_expires_at = Date.now() + 120_000;
    if (fault === 'nonce') fields.request_nonce = 'not-a-uuid';
    const body = await signed(control, 'action', fields);
    if (fault === 'signature') body.device_signature = encode(new Uint8Array(64));
    if (fault === 'unsigned-mutation') body.action = 'remove';
    const response = await h.request('/auth/face/profile/action', { body });
    assert((['account', 'device'].includes(fault) ? [401, 404] : [400, 401]).includes(response.status), fault + ': ' + response.status);
    await response.arrayBuffer();
    assert.equal(await count(h, 'face_profile_operations'), 0); assert.deepEqual(await profile(h, person), before);
    assert.equal((await h.json('/me', { token: person.token })).authenticated, true);
  });

test('A03 pause revokes only recipient matching and resume creates a new episode without resurrecting accepted grants', async t => {
  const h = await harness(t, { photoProcessor: processorResult }), owner = await enroll(h), person = await enroll(h), other = await enroll(h);
  for (const user of [owner, person, other]) await preferences(h, user);
  const control = await createControl(h, person), photo = await uploaded(h, owner);
  await deliverPhoto(h, photo.attempt.id); await accepted(h, owner, person, photo); await accepted(h, owner, other, photo);
  const before = await profile(h, person), consents = await activeConsents(h, person);
  const oldEpisode = before.consent_id, independent = consents.filter(row => row.purpose !== 'photo_matching');
  const ticket = await h.json('/previews/sign', { token: person.token, body: { asset_id: photo.asset_id } });
  const paused = (await action(h, control, 'pause')).value;
  assert.equal(paused.matching_enabled, false); assert.equal(paused.matching_paused, true); assert.equal(paused.receive_matches, false);
  assert.equal(paused.authentication_enabled, true); assert.equal(paused.processing_enabled, true);
  const after = await profile(h, person);
  for (const field of ['id', 'revision', 'model_id', 'template_key', 'template_digest', 'auth_enabled', 'auth_epoch', 'auth_consent_id'])
    assert.equal(after[field], before[field], field);
  assert.deepEqual(await activeConsents(h, person), independent);
  assert.equal((await h.json('/me', { token: person.token })).authenticated, true);
  await h.json(new URL(ticket.preview_url).pathname, {}, 403);
  await h.json('/community/media/' + photo.asset_id + '/preview', { token: person.token }, 403);
  assert.equal((await h.request('/community/media/' + photo.asset_id + '/preview', { token: other.token })).status, 200);
  const resumed = (await action(h, control, 'resume')).value;
  assert.equal(resumed.matching_enabled, true); assert.equal(resumed.matching_paused, false); assert.equal(resumed.receive_matches, true);
  assert.notEqual((await profile(h, person)).consent_id, oldEpisode);
  assert.deepEqual((await activeConsents(h, person)).filter(row => row.purpose !== 'photo_matching'), independent);
  assert.equal(await count(h, 'media_grants', 'WHERE recipient_id=? AND active=1', person.accountId), 0);
  assert.equal(await count(h, 'media_grants', 'WHERE recipient_id=? AND active=1', other.accountId), 1);
  const renewed = (await h.community(owner.token, 'sharing.snapshot', { asset_ids: [photo.asset_id], operation_key: uuid() })).snapshot;
  assert.deepEqual(renewed.pairs.map(pair => pair.recipient_id), [other.accountId]);
  assert.deepEqual((await h.json('/me/gallery', { token: person.token })).gallery_items, []);
});

test('A03 queued jobs filter revoked original participation before inference and never expand to later consented people', async t => {
  const calls = [], h = await harness(t, { photoProcessor: envelope => { calls.push(envelope); return processorResult(envelope); } });
  const owner = await enroll(h), person = await enroll(h), other = await enroll(h);
  for (const user of [owner, person, other]) await preferences(h, user);
  const control = await createControl(h, person), photo = await uploaded(h, owner);
  const captured = JSON.parse(photo.attempt.profiles_json);
  assert.deepEqual(new Set(captured.map(row => row.account_id)), new Set([person.accountId, other.accountId]));
  const oldTemplate = captured.find(row => row.account_id === person.accountId).template_key;
  await action(h, control, 'pause'); await action(h, control, 'resume');
  const newcomer = await enroll(h); await preferences(h, newcomer);
  await deliverPhoto(h, photo.attempt.id);
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].profiles.map(row => row.account_id), [other.accountId]);
  assert(!JSON.stringify(calls[0]).includes(oldTemplate), 'withdrawn reference reached the private model');
  assert(!calls[0].profiles.some(row => row.account_id === newcomer.accountId), 'queued scope expanded after capture');
  const candidates = await h.storage.exec("SELECT recipient_id FROM candidates WHERE asset_id=? AND status='eligible'", photo.asset_id);
  assert.deepEqual(candidates.map(row => row.recipient_id), [other.accountId]); assert.equal(await count(h, 'media_grants'), 0);
  assert.equal((await h.storage.exec('SELECT status FROM assets WHERE id=?', photo.asset_id))[0].status, 'ready');
  const publicJob = await h.json('/_internal/queue', { body: { category: 'photo', payload: { attempt_id: photo.attempt.id } },
    headers: { 'x-lovelies-internal': 'queue' } }, 404);
  assert.equal(publicJob.error.code, 'route_not_found');
});

test('A03 current policy/version gate resume and a receive flag cannot silently regrant paused matching', async t => {
  const h = await harness(t), person = await enroll(h); await preferences(h, person);
  const control = await createControl(h, person), paused = (await action(h, control, 'pause')).value;
  const before = await activeConsents(h, person);
  for (const consent of [undefined, { purpose: 'photo_processing', policy_version: PHOTO_POLICY, granted: true },
    { purpose: 'photo_matching', policy_version: 'old-photo-policy', granted: true },
    { purpose: 'photo_matching', policy_version: PHOTO_POLICY, granted: false }]) {
    await action(h, control, 'resume', { expectedVersion: paused.version, expected: 400, fields: { consent } });
  }
  await h.json('/me/photo-preferences', { token: person.token, body: { receive_matches: true,
    photo_matching_consent: true, policy_version: 'old-photo-policy', operation_key: uuid() } }, 400);
  await h.json('/me/photo-preferences', { token: person.token, body: { receive_matches: true,
    policy_version: PHOTO_POLICY, operation_key: uuid() } }, 403);
  await action(h, control, 'resume', { expectedVersion: Math.max(1, paused.version - 1), expected: 409 });
  assert.deepEqual(await activeConsents(h, person), before); assert.equal((await status(h, control)).matching_enabled, false);
  assert.equal(await count(h, 'face_profile_operations'), 1);
  await action(h, control, 'resume', { expectedVersion: paused.version });
  assert.equal((await status(h, control)).matching_enabled, true);
});

test('A03 authentication withdrawal preserves matching/processing/reference but revokes sessions and saved-backup authority', async t => {
  const h = await harness(t, { photoProcessor: processorResult }), owner = await enroll(h), person = await enroll(h);
  await preferences(h, owner); await preferences(h, person);
  const control = await createControl(h, person), before = await profile(h, person), consents = await activeConsents(h, person);
  const photo = await uploaded(h, owner); await deliverPhoto(h, photo.attempt.id); await accepted(h, owner, person, photo);
  const backup = secret('lfr_');
  await h.json('/auth/face/recovery/key', { token: person.token, body: { operation_key: uuid(), recovery_key: backup } }, 201);
  const withdrawal = await action(h, control, 'withdraw_authentication');
  assert.equal(withdrawal.value.authentication_enabled, false); assert.equal(withdrawal.value.matching_enabled, true);
  assert.equal(withdrawal.value.processing_enabled, true); assert.equal(withdrawal.value.receive_matches, true);
  assert.equal(withdrawal.value.removal_state, 'none');
  const after = await profile(h, person);
  for (const field of ['id', 'revision', 'model_id', 'template_key', 'template_digest', 'consent_id']) assert.equal(after[field], before[field], field);
  assert.equal(after.auth_enabled, 0); assert(after.auth_epoch > before.auth_epoch);
  assert.deepEqual(await activeConsents(h, person), consents.filter(row => row.purpose !== 'face_authentication'));
  assert(await (await h.mf.getR2Bucket('PHOTOS')).head(before.template_key));
  assert.equal(await count(h, 'media_grants', 'WHERE recipient_id=? AND active=1', person.accountId), 1);
  assert.equal(await count(h, 'sessions', 'WHERE account_id=? AND revoked_at IS NULL', person.accountId), 0);
  assert.equal(await count(h, 'face_recovery_keys', 'WHERE account_id=? AND revoked_at IS NULL', person.accountId), 0);
  await h.json('/me', { token: person.token }, 401);
  await h.json('/auth/session/refresh', { body: { refresh_token: person.refresh_token } }, 401);
  await h.json('/auth/face/challenge', { body: { face_handle: person.faceHandle, device_id: person.deviceId } }, 401);
  const recoveryKeys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const recoveryBody = { account_id: person.accountId, recovery_key: backup, recovery_request_id: uuid(),
    face_handle: secret('lfh_'), device_public_jwk: await crypto.subtle.exportKey('jwk', recoveryKeys.publicKey), policy_version: AUTH_POLICY };
  await h.json('/auth/face/recovery/challenge', { body: { ...recoveryBody, device_signature: await sign(recoveryKeys.privateKey,
    { protocol: 'lovelies-account-recovery-device-v1', step: 'start', ...recoveryBody }) } }, 401);
  const pending = await challenge(h, control, 'restore_authentication');
  assert.equal(pending.challenge.profile_id, before.id); assert.equal(pending.challenge.profile_revision, before.revision);
  const result = (await complete(h, pending)).value;
  assert.equal(result.profile_id, before.id); assert.equal(result.profile_revision, before.revision);
  assert.deepEqual((await activeConsents(h, person)).filter(row => row.purpose !== 'face_authentication'),
    consents.filter(row => row.purpose !== 'face_authentication'));
  const final = await status(h, control, pending.intent.operation_key);
  assert.equal(final.operation.state, 'completed'); assert.equal(final.authentication_enabled, true);
  assert.equal(final.matching_enabled, true); assert.equal(final.processing_enabled, true);
  assert.equal(await count(h, 'accounts'), 2); await assertNoPlaintextControl(h, control);
});

test('A03 retained-reference auth restoration preserves the matching episode and never grants processing', async t => {
  const h = await harness(t), person = await enroll(h);
  await preferences(h, person, { processing_consent: false });
  const control = await createControl(h, person), before = await profile(h, person);
  await action(h, control, 'withdraw_authentication');
  await h.alarm(); // Independently granted matching still authorizes this retained exact reference.
  assert.equal((await profile(h, person)).template_key, before.template_key);
  await challenge(h, control, 'restore_authentication', { expected: 400,
    fields: { consent: { purpose: 'face_authentication', policy_version: 'old-auth-policy', granted: true } } });
  const pending = await challenge(h, control, 'restore_authentication'), result = await complete(h, pending);
  assert.equal(result.value.profile_id, before.id); assert.equal((await profile(h, person)).template_digest, before.template_digest);
  assert.deepEqual((await activeConsents(h, person)).map(row => row.purpose), ['face_authentication', 'photo_matching']);
  assert.equal((await profile(h, person)).consent_id, before.consent_id);
  const final = await status(h, control, pending.intent.operation_key);
  assert.equal(final.matching_enabled, true); assert.equal(final.processing_enabled, false); assert.equal(final.receive_matches, true);
  await complete(h, pending, { expected: 409, completion: result.body });
  assert.equal(await count(h, 'accounts'), 1); assert.equal(await count(h, 'auth_devices'), 1);
});

test('A03 auth-only withdrawal retires the unauthorized reference; only verified cleanup permits explicit same-account three-pose enrollment', async t => {
  const h = await harness(t), person = await enroll(h), control = await createControl(h, person), before = await profile(h, person);
  const write = await writer(h, person, before.template_key), withdrawn = await action(h, control, 'withdraw_authentication');
  assert.equal(withdrawn.value.authentication_enabled, false); assert.equal(withdrawn.value.matching_enabled, false);
  assert.equal(withdrawn.value.processing_enabled, false); assert.equal(withdrawn.value.removal_state, 'pending');
  assert.equal(withdrawn.value.operation.cleanup_state, 'pending');
  await h.alarm();
  const held = await status(h, control, withdrawn.intent.operation_key);
  assert(['pending', 'failed'].includes(held.removal_state)); assert(await (await h.mf.getR2Bucket('PHOTOS')).head(before.template_key));
  await challenge(h, control, 'restore_authentication', { expected: 409 }); await challenge(h, control, 'enroll', { expected: 409 });
  await settleWriter(h, write); await h.alarm();
  const erased = await status(h, control, withdrawn.intent.operation_key);
  assert.equal(erased.removal_state, 'completed'); assert.equal(erased.operation.cleanup_state, 'completed');
  assert.equal(await (await h.mf.getR2Bucket('PHOTOS')).head(before.template_key), null); assert.equal(await profile(h, person), undefined);
  const pending = await challenge(h, control, 'enroll'); assert.equal(pending.challenge.required_captures, 3);
  const result = (await complete(h, pending)).value; assert.equal(result.account_id, person.accountId);
  assert.deepEqual((await activeConsents(h, person)).map(row => row.purpose), ['face_authentication']);
  assert.equal(await count(h, 'accounts'), 1); assert.equal(await count(h, 'auth_devices'), 1);
});

test('A03 removal stops auth/matching immediately but waits for settled writers and absent R2 before same-account three-pose enrollment', async t => {
  const h = await harness(t, { photoProcessor: processorResult }), person = await enroll(h), recipient = await enroll(h);
  await preferences(h, person); await preferences(h, recipient);
  const control = await createControl(h, person), before = await profile(h, person);
  const device = (await h.storage.exec('SELECT * FROM auth_devices WHERE id=?', person.deviceId))[0];
  const photo = await uploaded(h, person); await deliverPhoto(h, photo.attempt.id); await accepted(h, person, recipient, photo);
  await h.storage.exec('INSERT INTO financial_records(id,account_id,record_type,data_json,created_at) VALUES(?,?,?,?,?)',
    uuid(), person.accountId, 'fixture-retained-invoice', JSON.stringify({ amount: 125, currency: 'USD' }), Date.now());
  const uploads = await h.storage.exec('SELECT * FROM assets WHERE owner_id=?', person.accountId);
  const ledger = await h.storage.exec('SELECT * FROM financial_records WHERE account_id=?', person.accountId);
  const independent = (await activeConsents(h, person)).filter(row => row.purpose === 'photo_processing');
  const write = await writer(h, person, before.template_key), removed = await action(h, control, 'remove');
  assert.equal(removed.value.removal_state, 'pending'); assert.equal(removed.value.operation.cleanup_state, 'pending');
  assert.equal(removed.value.authentication_enabled, false); assert.equal(removed.value.matching_enabled, false);
  assert.equal(removed.value.processing_enabled, true); assert.equal(removed.value.receive_matches, false);
  assert.equal(removed.value.profile, null); assert.equal(removed.value.operation.challenge, null);
  await h.json('/me', { token: person.token }, 401);
  const held = await status(h, control, removed.intent.operation_key);
  assert(['pending', 'failed'].includes(held.removal_state));
  assert(await (await h.mf.getR2Bucket('PHOTOS')).head(before.template_key));
  await challenge(h, control, 'enroll', { expected: 409 });
  assert.equal(await count(h, 'auth_challenges', "WHERE account_id=? AND status='pending'", person.accountId), 0);
  assert.deepEqual(await h.storage.exec('SELECT * FROM assets WHERE owner_id=?', person.accountId), uploads);
  assert.deepEqual(await h.storage.exec('SELECT * FROM financial_records WHERE account_id=?', person.accountId), ledger);
  assert.deepEqual(await activeConsents(h, person), independent);
  assert.equal((await h.request('/community/media/' + photo.asset_id + '/preview', { token: recipient.token })).status, 200);
  await settleWriter(h, write);
  const cleared = await status(h, control, removed.intent.operation_key);
  assert.equal(cleared.removal_state, 'completed'); assert.equal(cleared.operation.cleanup_state, 'completed');
  const retirement = (await h.storage.exec('SELECT * FROM face_profile_retirements WHERE account_id=?', person.accountId))[0];
  assert.equal(retirement.profile_id, before.id); assert.equal(retirement.profile_revision, before.revision);
  assert.equal(retirement.template_key, before.template_key); assert.equal(retirement.template_digest, before.template_digest);
  assert.equal((await h.storage.exec('SELECT status,verified_at FROM cleanup_intents WHERE id=?', retirement.cleanup_id))[0].status, 'verified');
  assert.equal(await (await h.mf.getR2Bucket('PHOTOS')).head(before.template_key), null);
  assert.equal(await profile(h, person), undefined);
  const pending = await challenge(h, control, 'enroll');
  assert.equal(pending.challenge.profile_id, null); assert.equal(pending.challenge.profile_revision, null);
  const result = (await complete(h, pending)).value;
  assert.equal(result.account_id, person.accountId); assert.notEqual(result.profile_id, before.id);
  const current = await profile(h, person); assert.notEqual(current.template_key, before.template_key);
  assert(await (await h.mf.getR2Bucket('PHOTOS')).head(current.template_key));
  const currentDevice = (await h.storage.exec('SELECT * FROM auth_devices WHERE id=?', person.deviceId))[0];
  for (const field of ['id', 'public_jwk', 'revision', 'face_handle']) assert.equal(currentDevice[field], device[field], field);
  const final = await status(h, control, pending.intent.operation_key);
  assert.equal(final.authentication_enabled, true); assert.equal(final.matching_enabled, false);
  assert.equal(final.processing_enabled, true); assert.equal(final.receive_matches, false);
  assert.equal(await count(h, 'accounts'), 2); assert.equal(await count(h, 'auth_devices', 'WHERE account_id=?', person.accountId), 1);
  assert.deepEqual(await h.storage.exec('SELECT * FROM financial_records WHERE account_id=?', person.accountId), ledger);
  const ownPhotos = await h.community(result.access_token, 'photos', { source: 'contributions', limit: 100 });
  assert.deepEqual(ownPhotos.items.map(item => item.id), [photo.asset_id]);
  const ownPreview = await h.request('/community/media/' + photo.asset_id + '/preview', { token: result.access_token });
  assert.equal(ownPreview.status, 200); assert.deepEqual(new Uint8Array(await ownPreview.arrayBuffer()), fixturePng(photo.asset_id));
});

test('A03 legal moderation hold reports blocked removal rather than physical deletion or replacement authority', async t => {
  const h = await harness(t), person = await enroll(h), control = await createControl(h, person), before = await profile(h, person);
  const hold = uuid();
  await h.storage.exec('INSERT INTO moderation_holds(id,subject_id,active,created_at,reason) VALUES(?,?,1,?,?)',
    hold, person.accountId, Date.now(), 'test-only reference retention hold');
  const removed = await action(h, control, 'remove');
  const blocked = await status(h, control, removed.intent.operation_key);
  assert.equal(blocked.removal_state, 'blocked'); assert.equal(blocked.operation.cleanup_state, 'blocked');
  assert(await (await h.mf.getR2Bucket('PHOTOS')).head(before.template_key));
  await challenge(h, control, 'enroll', { expected: 409 });
  assert.equal((await profile(h, person)).status, 'revoked');
  await h.storage.exec('UPDATE moderation_holds SET active=0,cleared_at=? WHERE id=?', Date.now(), hold);
  const completed = await status(h, control, removed.intent.operation_key);
  assert.equal(completed.removal_state, 'completed');
  assert.equal(await (await h.mf.getR2Bucket('PHOTOS')).head(before.template_key), null);
  assert.equal(await count(h, 'accounts'), 1);
});

test('A03 persisted cleanup failure is not advertised complete until a real subsequent DELETE and absent HEAD', async t => {
  const h = await harness(t), person = await enroll(h), control = await createControl(h, person), before = await profile(h, person);
  const write = await writer(h, person, before.template_key), removed = await action(h, control, 'remove');
  const retirement = (await h.storage.exec('SELECT cleanup_id FROM face_profile_retirements WHERE account_id=?', person.accountId))[0];
  // Seed a durable prior storage-failure receipt. This does not claim an R2
  // provider fault was injected; actual recovery deletion/HEAD is exercised.
  await h.storage.exec("UPDATE cleanup_intents SET status='failed',attempts=1 WHERE id=?", retirement.cleanup_id);
  const failed = await status(h, control, removed.intent.operation_key);
  assert.equal(failed.removal_state, 'failed'); assert.equal(failed.operation.cleanup_state, 'failed');
  assert(await (await h.mf.getR2Bucket('PHOTOS')).head(before.template_key));
  await challenge(h, control, 'enroll', { expected: 409 });
  await settleWriter(h, write);
  const final = await status(h, control, removed.intent.operation_key); assert.equal(final.removal_state, 'completed');
  const receipt = (await h.storage.exec('SELECT status,verified_at,attempts FROM cleanup_intents WHERE id=?', retirement.cleanup_id))[0];
  assert.equal(receipt.status, 'verified'); assert(Number.isSafeInteger(receipt.verified_at)); assert(receipt.attempts >= 2);
  assert.equal(await (await h.mf.getR2Bucket('PHOTOS')).head(before.template_key), null);
});

test('A03 replacement retains old sign-in while pending, atomically rotates one reference and never revives old recipient grants', async t => {
  const h = await harness(t, { photoProcessor: processorResult }), owner = await enroll(h), person = await enroll(h), peer = await enroll(h);
  for (const user of [owner, person, peer]) await preferences(h, user);
  const control = await createControl(h, person), before = await profile(h, person);
  const independent = await activeConsents(h, person), account = (await h.storage.exec('SELECT * FROM accounts WHERE id=?', person.accountId))[0];
  const photo = await uploaded(h, owner); await deliverPhoto(h, photo.attempt.id);
  await accepted(h, owner, person, photo); await accepted(h, owner, peer, photo);
  await h.json('/auth/face/recovery/key', { token: person.token, body: { operation_key: uuid(), recovery_key: secret('lfr_') } }, 201);
  const pending = await challenge(h, control, 'replace');
  assert.equal(pending.challenge.profile_id, before.id); assert.equal(pending.challenge.profile_revision, before.revision);
  assert.equal((await h.json('/me', { token: person.token })).authenticated, true);
  const concurrentLogin = await login(h, person);
  assert.equal(concurrentLogin.profile_revision, before.revision);
  assert.equal((await profile(h, person)).template_key, before.template_key);
  await challenge(h, control, 'replace', { expected: 409 });
  const result = await complete(h, pending);
  const current = await profile(h, person), currentAccount = (await h.storage.exec('SELECT * FROM accounts WHERE id=?', person.accountId))[0];
  assert.equal(current.id, before.id); assert.notEqual(current.revision, before.revision);
  assert.notEqual(current.template_key, before.template_key); assert.notEqual(current.template_digest, before.template_digest);
  assert.equal(current.model_id, before.model_id); assert.equal(current.consent_id, before.consent_id);
  assert(current.auth_epoch > before.auth_epoch); assert(currentAccount.auth_epoch > account.auth_epoch);
  assert.equal(currentAccount.roles_json, account.roles_json); assert.equal(currentAccount.identity_state, 'registered_face');
  assert.deepEqual((await activeConsents(h, person)).filter(row => row.purpose === 'photo_processing'),
    independent.filter(row => row.purpose === 'photo_processing'));
  const matching = (await activeConsents(h, person)).find(row => row.purpose === 'photo_matching');
  assert.equal(matching.id, before.consent_id); assert.equal(matching.profile_revision, current.revision);
  await h.json('/me', { token: person.token }, 401); await h.json('/me', { token: concurrentLogin.access_token }, 401);
  assert.equal(await count(h, 'face_recovery_keys', 'WHERE account_id=? AND revoked_at IS NULL', person.accountId), 0);
  assert.equal(await count(h, 'media_grants', 'WHERE recipient_id=? AND active=1', person.accountId), 0);
  assert.equal((await h.request('/community/media/' + photo.asset_id + '/preview', { token: peer.token })).status, 200);
  const final = await status(h, control, pending.intent.operation_key);
  assert.equal(final.operation.state, 'completed'); assert.equal(final.operation.challenge, null);
  assert.deepEqual(final.profile, { id: current.id, revision: current.revision, model_id: current.model_id });
  assert.equal(final.operation.cleanup_state, 'completed');
  assert.equal(await (await h.mf.getR2Bucket('PHOTOS')).head(before.template_key), null);
  const newObject = await (await h.mf.getR2Bucket('PHOTOS')).get(current.template_key);
  assert(newObject); assert.equal(await sha256(await newObject.arrayBuffer()), current.template_digest);
  await complete(h, pending, { expected: 409, completion: result.body });
  assert.equal(await count(h, 'accounts'), 3);
});

test('A03 lost replacement/capture replies disclose only accepted metadata and require a fresh login after commit', async t => {
  const h = await harness(t), person = await enroll(h), control = await createControl(h, person);
  const intent = { operation_key: uuid(), action: 'replace', expected_version: control.metadata.version,
    consent: { purpose: 'face_authentication', policy_version: AUTH_POLICY, granted: true } };
  const reply = await h.request('/auth/face/profile/challenge', { body: await signed(control, 'challenge', intent) });
  assert.equal(reply.status, 201); await reply.arrayBuffer();
  const recovered = await status(h, control, intent.operation_key);
  const pending = { control, intent, challenge: recovered.operation.challenge };
  assert.equal(recovered.operation.state, 'pending'); assert.equal(pending.challenge.lifecycle_operation_key, intent.operation_key);
  const first = await capture(h, pending, 0); assert.equal(first.response.status, 200); await first.response.arrayBuffer();
  const acknowledgement = await status(h, control, intent.operation_key);
  assert.equal(acknowledgement.operation.state, 'pending'); assert.deepEqual(acknowledgement.operation.captures, [first.manifest]);
  // Persist an authoritative unresolved writer; this does not simulate an R2
  // provider fault. The account fence must block further capture until settled.
  const unresolved = await writer(h, person, 'private/test-awaiting-capture/' + uuid());
  const awaiting = await status(h, control, intent.operation_key);
  assert.equal(awaiting.operation.state, 'capture_pending'); assert.deepEqual(awaiting.operation.captures, [first.manifest]);
  const blocked = await capture(h, pending, 1); assert.equal(blocked.response.status, 409); await blocked.response.arrayBuffer();
  await settleWriter(h, unresolved);
  const settled = await status(h, control, intent.operation_key);
  assert.equal(settled.operation.state, 'pending'); assert.deepEqual(settled.operation.captures, [first.manifest]);
  const manifests = [first.manifest];
  for (const index of [1, 2]) {
    const proof = await capture(h, pending, index); assert.equal(proof.response.status, 200); await proof.response.arrayBuffer(); manifests.push(proof.manifest);
  }
  const completion = { challenge_id: pending.challenge.challenge_id, device_signature: await sign(person.keys.privateKey,
    { ...deviceEnvelope(pending.challenge), step: 'complete', capture_manifest: manifests }) };
  const committed = await h.request('/auth/face/profile/complete', { body: completion });
  assert.equal(committed.status, 200); await committed.arrayBuffer(); // Credentials were never adopted.
  const final = await status(h, control, intent.operation_key); assert.equal(final.operation.state, 'completed');
  assert.equal(final.operation.challenge, null); assert.deepEqual(final.operation.captures, []);
  await h.json('/me', { token: person.token }, 401);
  await h.json('/auth/face/profile/complete', { body: completion }, 409);
  const fresh = await login(h, person); assert.equal(fresh.profile_id, final.profile.id); assert.equal(fresh.profile_revision, final.profile.revision);
  assert.equal(await count(h, 'accounts'), 1); assert.equal(await count(h, 'auth_devices'), 1);
  await assertNoPlaintextControl(h, control);
});

test('A03 replacement requires three distinct ordered captures with exact nonce/version/signatures before private verification', async t => {
  let replacements = 0;
  const h = await harness(t, { faceVerifier: async (envelope, form) => {
    if (envelope.reference_mode === 'replace_reference') replacements++;
    return replacementVerifier(envelope, form);
  } });
  const person = await enroll(h), control = await createControl(h, person), before = await profile(h, person);
  const pending = await challenge(h, control, 'replace'), bytes = fixturePng(uuid());
  const outOfOrder = await capture(h, pending, 1);
  assert.equal(outOfOrder.response.status, 409); await outOfOrder.response.arrayBuffer();
  const foreignKeys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const wrongSigner = await capture(h, pending, 0, { signer: foreignKeys.privateKey });
  assert.equal(wrongSigner.response.status, 401); await wrongSigner.response.arrayBuffer();
  const stale = await capture(h, pending, 0, { challenge: { ...pending.challenge, nonce: secret('lfn_') } });
  assert.equal(stale.response.status, 401); await stale.response.arrayBuffer();
  const driftedVersion = await capture(h, pending, 0, { challenge: { ...pending.challenge, profile_revision: uuid() } });
  assert.equal(driftedVersion.response.status, 401); await driftedVersion.response.arrayBuffer();
  const wrongHash = await capture(h, pending, 0, { hash: '0'.repeat(64) });
  assert.equal(wrongHash.response.status, 400); await wrongHash.response.arrayBuffer();
  const first = await capture(h, pending, 0, { bytes }); assert.equal(first.response.status, 200); await first.response.arrayBuffer();
  const repeatedBytes = await capture(h, pending, 1, { bytes });
  assert.equal(repeatedBytes.response.status, 409); await repeatedBytes.response.arrayBuffer();
  const second = await capture(h, pending, 1); assert.equal(second.response.status, 200); await second.response.arrayBuffer();
  const completion = { challenge_id: pending.challenge.challenge_id, device_signature: await sign(person.keys.privateKey,
    { ...deviceEnvelope(pending.challenge), step: 'complete', capture_manifest: [first.manifest, second.manifest] }) };
  await h.json('/auth/face/profile/complete', { body: completion }, 409);
  assert.equal(replacements, 0); assert.deepEqual(await profile(h, person), before);
  const third = await capture(h, pending, 2); assert.equal(third.response.status, 200); await third.response.arrayBuffer();
  const full = { challenge_id: pending.challenge.challenge_id, device_signature: await sign(person.keys.privateKey,
    { ...deviceEnvelope(pending.challenge), step: 'complete', capture_manifest: [first.manifest, second.manifest, third.manifest] }) };
  await h.json('/auth/face/registration/complete', { body: full }, 400);
  await h.json('/auth/face/complete', { body: full }, 400);
  await complete(h, pending, { completion: full }); assert.equal(replacements, 1);
});

for (const [fault, mutate, expected] of [
  ['wrong old face', value => { value.reference_match = false; }, 401],
  ['missing old comparison', value => { delete value.reference_match; }, 503],
  ['missing mutual enrollment', value => { delete value.enrollment_verified; }, 503],
  ['missing derived reference', value => { delete value.registered_reference; }, 503],
  ['wrong nonce', value => { value.nonce = secret('lfn_'); }, 503],
  ['wrong manifest', value => { value.capture_manifest = value.capture_manifest.slice(0, 2); }, 503],
  ['wrong template digest', value => { value.registered_reference.template_sha256 = '0'.repeat(64); }, 503],
  ['wrong bound model', value => { value.model_id = 'wrong-bound-model'; }, 503],
  ['reused reference revision', value => { value.registered_reference.revision = value.profile_revision; }, 503],
]) test('A03 synthetic replacement verdict rejects ' + fault + ' without retiring the original reference', async t => {
  const h = await harness(t, { faceVerifier: async (envelope, form) => {
    const value = await replacementVerifier(envelope, form); if (envelope.reference_mode === 'replace_reference') mutate(value); return value;
  } });
  const person = await enroll(h), control = await createControl(h, person), before = await profile(h, person);
  const sessions = await count(h, 'sessions', 'WHERE account_id=?', person.accountId), pending = await challenge(h, control, 'replace');
  await complete(h, pending, { expected });
  assert.deepEqual(await profile(h, person), before); assert.equal(await count(h, 'sessions', 'WHERE account_id=?', person.accountId), sessions);
  assert.equal(await count(h, 'face_profile_retirements', 'WHERE account_id=?', person.accountId), 0);
  assert(await (await h.mf.getR2Bucket('PHOTOS')).head(before.template_key));
  assert.equal((await h.json('/me', { token: person.token })).authenticated, true);
});

test('A03 expired successor CAS keeps the original device and consent, starts fresh captures and replays no consumed generation', async t => {
  const h = await harness(t), person = await enroll(h), control = await createControl(h, person), pending = await challenge(h, control, 'replace');
  const first = await capture(h, pending, 0); assert.equal(first.response.status, 200); await first.response.arrayBuffer();
  const oldProof = (await h.storage.exec('SELECT object_key FROM auth_capture_proofs WHERE challenge_id=?', pending.challenge.challenge_id))[0];
  await h.storage.exec('UPDATE auth_challenges SET expires_at=created_at+1 WHERE id=?', pending.challenge.challenge_id);
  const expired = await status(h, control, pending.intent.operation_key);
  assert.equal(expired.operation.state, 'restart_required'); assert.equal(expired.operation.challenge, null);
  assert.deepEqual(expired.operation.captures, []); assert.equal(expired.operation.challenge_id, pending.challenge.challenge_id);
  const fields = { operation_key: pending.intent.operation_key, resume_key: uuid(),
    expected_challenge_id: pending.challenge.challenge_id, expected_generation: 1 };
  const write = await writer(h, person, 'private/test-unsettled/' + uuid());
  await h.json('/auth/face/profile/resume', { body: await signed(control, 'resume', fields) }, 409);
  await settleWriter(h, write);
  const next = await h.json('/auth/face/profile/resume', { body: await signed(control, 'resume', fields) }, 201);
  assert.equal(next.lifecycle_generation, 2); assert.equal(next.device_id, person.deviceId);
  assert.equal(next.device_revision, control.deviceRevision); assert.notEqual(next.challenge_id, pending.challenge.challenge_id);
  assert.equal(next.profile_id, pending.challenge.profile_id); assert.equal(next.profile_revision, pending.challenge.profile_revision);
  const replay = await h.json('/auth/face/profile/resume', { body: await signed(control, 'resume', fields) }, 201);
  assert.equal(replay.challenge_id, next.challenge_id); assert.equal(replay.lifecycle_generation, 2);
  assert.equal(await count(h, 'auth_devices'), 1);
  assert.equal(await count(h, 'consents', "WHERE account_id=? AND purpose='face_authentication'", person.accountId), 2);
  await h.alarm();
  assert.equal(await (await h.mf.getR2Bucket('QUARANTINE')).head(oldProof.object_key), null);
  assert.equal(await count(h, 'auth_capture_proofs', 'WHERE challenge_id=?', pending.challenge.challenge_id), 0);
  await h.json('/auth/face/profile/resume', { body: await signed(control, 'resume', { ...fields, resume_key: uuid() }) }, 409);
  await h.json('/auth/face/profile/resume', { body: await signed(control, 'resume', { ...fields, expected_generation: 2 }) }, 409);
  const oldCapture = await capture(h, pending, 1); assert.equal(oldCapture.response.status, 409); await oldCapture.response.arrayBuffer();
  const clean = await status(h, control, pending.intent.operation_key); assert.deepEqual(clean.operation.captures, []);
  const successor = { ...pending, challenge: next }, result = await complete(h, successor);
  await h.json('/auth/face/profile/resume', { body: await signed(control, 'resume', fields) }, 409);
  await complete(h, successor, { completion: result.body, expected: 409 });
  assert.equal(await count(h, 'accounts'), 1);
});

for (const fault of ['profile-revision', 'profile-model', 'profile-digest', 'profile-epoch', 'consent', 'device', 'account-epoch', 'disabled-account', 'deletion'])
  test('A03 ' + fault + ' drift during a real private verifier await prevents reference/session publication', async t => {
    const entered = deferred(), release = deferred(); t.after(() => release.resolve());
    const h = await harness(t, { faceVerifier: async (envelope, form) => {
      if (envelope.reference_mode === 'replace_reference') { entered.resolve(); await release.promise; }
      return replacementVerifier(envelope, form);
    } });
    const person = await enroll(h), control = await createControl(h, person), before = await profile(h, person);
    const pending = await challenge(h, control, 'replace'), completion = await captureProofs(h, pending.challenge, person.keys.privateKey);
    const sessions = await count(h, 'sessions', 'WHERE account_id=?', person.accountId);
    const request = h.request('/auth/face/profile/complete', { body: completion }); await arrived(entered);
    if (fault === 'profile-revision') await h.storage.exec('UPDATE face_profiles SET revision=? WHERE account_id=?', uuid(), person.accountId);
    if (fault === 'profile-model') await h.storage.exec('UPDATE face_profiles SET model_id=? WHERE account_id=?', 'different-current-model', person.accountId);
    if (fault === 'profile-digest') await h.storage.exec('UPDATE face_profiles SET template_digest=? WHERE account_id=?', 'a'.repeat(64), person.accountId);
    if (fault === 'profile-epoch') await h.storage.exec('UPDATE face_profiles SET auth_epoch=auth_epoch+1 WHERE account_id=?', person.accountId);
    if (fault === 'consent') await h.storage.exec("UPDATE consents SET status='revoked',revoked_at=? WHERE id=(SELECT consent_id FROM auth_challenges WHERE id=?)", Date.now(), pending.challenge.challenge_id);
    if (fault === 'device') await h.storage.exec('UPDATE auth_devices SET revision=? WHERE id=?', uuid(), person.deviceId);
    if (fault === 'account-epoch') await h.storage.exec('UPDATE accounts SET auth_epoch=auth_epoch+1 WHERE id=?', person.accountId);
    if (fault === 'disabled-account') await h.storage.exec('UPDATE accounts SET disabled_at=? WHERE id=?', Date.now(), person.accountId);
    if (fault === 'deletion') await h.json('/privacy/account-deletion', { token: person.token, body: { operation_key: uuid() } }, 201);
    release.resolve(); const response = await request;
    assert([401, 409].includes(response.status), fault + ' produced ' + response.status); await response.arrayBuffer();
    assert.equal(await count(h, 'sessions', 'WHERE account_id=?', person.accountId), sessions);
    assert.equal((await profile(h, person)).template_key, before.template_key);
    assert.equal(await count(h, 'face_profile_retirements', 'WHERE account_id=?', person.accountId), 0);
    assert(await (await h.mf.getR2Bucket('PHOTOS')).head(before.template_key));
  });

test('A03 a held actual verifier blocks expired resume and a signed withdrawal fences its late result', async t => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const h = await harness(t, { faceVerifier: async (envelope, form) => {
    if (envelope.reference_mode === 'replace_reference') { entered.resolve(); await release.promise; }
    return replacementVerifier(envelope, form);
  } });
  const person = await enroll(h); await preferences(h, person, { processing_consent: false });
  const control = await createControl(h, person), before = await profile(h, person);
  const pending = await challenge(h, control, 'replace'), completion = await captureProofs(h, pending.challenge, person.keys.privateKey);
  const request = h.request('/auth/face/profile/complete', { body: completion }); await arrived(entered);
  await h.storage.exec('UPDATE auth_challenges SET expires_at=created_at+1 WHERE id=?', pending.challenge.challenge_id);
  await h.json('/auth/face/profile/resume', { body: await signed(control, 'resume', { operation_key: pending.intent.operation_key,
    resume_key: uuid(), expected_challenge_id: pending.challenge.challenge_id, expected_generation: 1 }) }, 409);
  await action(h, control, 'withdraw_authentication');
  release.resolve(); const response = await request; assert([401, 409].includes(response.status)); await response.arrayBuffer();
  assert.equal((await profile(h, person)).template_key, before.template_key);
  assert.equal(await count(h, 'sessions', 'WHERE account_id=? AND revoked_at IS NULL', person.accountId), 0);
  assert.equal(await count(h, 'face_profile_retirements'), 0);
  const final = await status(h, control, pending.intent.operation_key); assert.equal(final.operation.state, 'cancelled');
  assert.equal(final.authentication_enabled, false); assert.equal(final.operation.challenge, null); assert.deepEqual(final.operation.captures, []);
});

test('A03 replacement revokes other actual registered devices while keeping the original control/key/handle current', async t => {
  const h = await harness(t), person = await enroll(h), control = await createControl(h, person);
  const otherKeys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const otherChallenge = await h.json('/auth/face/registration/challenge', { token: person.token, body: {
    device_public_jwk: await crypto.subtle.exportKey('jwk', otherKeys.publicKey),
    consent: { purpose: 'face_authentication', policy_version: AUTH_POLICY, granted: true } } }, 201);
  const otherCredentials = await h.json('/auth/face/registration/complete', { token: person.token,
    body: await captureProofs(h, otherChallenge, otherKeys.privateKey, { token: person.token }) });
  const other = { ...otherCredentials, token: otherCredentials.access_token, accountId: person.accountId,
    deviceId: otherChallenge.device_id, keys: otherKeys, faceHandle: otherChallenge.face_handle };
  const otherControl = await createControl(h, other);
  const original = await login(h, person); person.token = original.access_token;
  const device = (await h.storage.exec('SELECT * FROM auth_devices WHERE id=?', person.deviceId))[0];
  const pending = await challenge(h, control, 'replace'), result = (await complete(h, pending)).value;
  await h.json('/me', { token: other.token }, 401); await status(h, otherControl, undefined, 401);
  await h.json('/auth/face/challenge', { body: { face_handle: other.faceHandle, device_id: other.deviceId } }, 401);
  const retired = (await h.storage.exec('SELECT status,face_handle,revision FROM auth_devices WHERE id=?', other.deviceId))[0];
  assert.equal(retired.status, 'revoked'); assert.equal(retired.face_handle, null); assert.notEqual(retired.revision, otherChallenge.device_revision);
  const current = (await h.storage.exec('SELECT * FROM auth_devices WHERE id=?', person.deviceId))[0];
  for (const field of ['id', 'public_jwk', 'revision', 'face_handle']) assert.equal(current[field], device[field], field);
  const final = await status(h, control, pending.intent.operation_key); assert.equal(final.operation.state, 'completed');
  assert.equal(result.device_id, person.deviceId); assert.equal(await count(h, 'accounts'), 1);
  assert.equal(await count(h, 'auth_devices', "WHERE account_id=? AND status='active'", person.accountId), 1);
});

test('A03 device revocation and control expiry cannot authorize a lifecycle action or recreate an anonymous account', async t => {
  for (const fault of ['revoked-device', 'expired-control']) {
    const h = await harness(t), person = await enroll(h), control = await createControl(h, person), before = await profile(h, person);
    if (fault === 'revoked-device') await h.json('/auth/device/revoke', { token: person.token, body: { device_id: person.deviceId, operation_key: uuid() } });
    else await h.storage.exec('UPDATE face_profile_controls SET expires_at=created_at+1 WHERE account_id=? AND device_id=?', person.accountId, person.deviceId);
    await status(h, control, undefined, 401);
    await action(h, control, 'remove', { expectedVersion: control.metadata.version, expected: 401 });
    assert.equal(await count(h, 'face_profile_operations'), 0); assert.deepEqual(await profile(h, person), before);
    assert.equal(await count(h, 'accounts'), 1);
  }
});

test('A03 deletion holds fence existing capture and management without consuming a new action or upgrading a session', async t => {
  const h = await harness(t), person = await enroll(h), control = await createControl(h, person), pending = await challenge(h, control, 'replace');
  const completion = await captureProofs(h, pending.challenge, person.keys.privateKey), sessions = await count(h, 'sessions');
  await h.json('/privacy/account-deletion', { token: person.token, body: { operation_key: uuid() } }, 201);
  await status(h, control, pending.intent.operation_key, 409);
  await action(h, control, 'pause', { expectedVersion: control.metadata.version, expected: 409 });
  await complete(h, pending, { completion, expected: 409 });
  const proof = await capture(h, pending, 0); assert.equal(proof.response.status, 409); await proof.response.arrayBuffer();
  assert.equal(await count(h, 'face_profile_operations'), 1); assert.equal(await count(h, 'face_profile_retirements'), 0);
  assert.equal(await count(h, 'sessions'), sessions); assert.equal(await count(h, 'accounts'), 1);
});

test('A03 terminal authority invalidates completed A01 recovery metadata without replacing its original account', async t => {
  const h = await harness(t), anonymous = await h.anonymous();
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey), saved = { account_id: anonymous.account_id,
    enrollment_key: uuid(), face_handle: secret('lfh_') };
  const body = { ...saved, device_public_jwk: jwk,
    consent: { purpose: 'face_authentication', policy_version: AUTH_POLICY, granted: true },
    device_signature: await sign(keys.privateKey, { protocol: 'lovelies-face-enrollment-device-v1', step: 'start',
      ...saved, policy_version: AUTH_POLICY, device_public_jwk: jwk }) };
  const first = await h.json('/auth/face/registration/challenge', { token: anonymous.access_token, body }, 201);
  const credentials = await h.json('/auth/face/registration/complete', { token: anonymous.access_token,
    body: await captureProofs(h, first, keys.privateKey, { token: anonymous.access_token }) });
  const person = { ...credentials, keys, token: credentials.access_token, accountId: credentials.account_id,
    deviceId: first.device_id, faceHandle: saved.face_handle };
  await preferences(h, person); const control = await createControl(h, person);
  await action(h, control, 'withdraw_authentication');
  const fields = { ...saved, request_nonce: uuid(), request_expires_at: Date.now() + 45_000 };
  const response = await h.request('/auth/face/registration/recovery', { body: { ...fields,
    device_signature: await sign(keys.privateKey, { protocol: 'lovelies-face-enrollment-device-v1', step: 'status', ...fields }) } });
  assert([401, 404].includes(response.status)); await response.arrayBuffer();
  const receipt = (await h.storage.exec('SELECT revoked_at FROM face_enrollment_intents WHERE account_id=?', person.accountId))[0];
  assert(receipt.revoked_at !== null); assert.equal(await count(h, 'accounts'), 1);
  assert.equal((await status(h, control)).matching_enabled, true);
});

async function administrator(h) {
  const person = await enroll(h);
  // Private harness-only role provisioning, followed by a real signed face login.
  // No public request can self-assign the independent reviewer role.
  await h.storage.exec('UPDATE accounts SET roles_json=? WHERE id=?', JSON.stringify(['user', 'admin']), person.accountId);
  const credentials = await login(h, person); assert(credentials.roles.includes('admin'));
  return { ...person, token: credentials.access_token };
}

test('A03 independently approved account erasure clears lifecycle/retired/new references and waits for the actual retained writer', async t => {
  const h = await harness(t), person = await enroll(h), control = await createControl(h, person), before = await profile(h, person);
  const pending = await challenge(h, control, 'replace'), credentials = (await complete(h, pending)).value;
  const current = await profile(h, person), write = await writer(h, person, before.template_key);
  const held = await status(h, control, pending.intent.operation_key); assert(['pending', 'failed'].includes(held.operation.cleanup_state));
  assert(await (await h.mf.getR2Bucket('PHOTOS')).head(before.template_key));
  const admin = await administrator(h);
  const requested = (await h.json('/privacy/account-deletion', { token: credentials.access_token, body: { operation_key: uuid() } }, 201)).privacy_request;
  await h.json('/privacy-requests/' + requested.id + '/approve', { token: admin.token, body: { operation_key: uuid() } });
  const failed = await h.json('/privacy-requests/' + requested.id + '/process', { token: admin.token, body: {} }, 503);
  assert.equal(failed.error.code, 'privacy_writer_unresolved');
  await h.json('/me', { token: credentials.access_token }, 401);
  for (const table of ['face_profile_controls', 'face_profile_operations', 'face_profile_retirements', 'face_profile_states'])
    assert.equal(await count(h, table, 'WHERE account_id=?', person.accountId), 0, table);
  const unavailable = await h.request('/auth/face/profile/status', { body: await signed(control, 'status') });
  assert([401, 404].includes(unavailable.status)); await unavailable.arrayBuffer();
  await settleWriter(h, write);
  const completed = await h.json('/privacy-requests/' + requested.id + '/process', { token: admin.token, body: {} });
  assert.equal(completed.privacy_request.status, 'completed');
  const bucket = await h.mf.getR2Bucket('PHOTOS');
  assert.equal(await bucket.head(before.template_key), null); assert.equal(await bucket.head(current.template_key), null);
  assert.equal(await count(h, 'face_profiles', 'WHERE account_id=?', person.accountId), 0);
  assert.equal(await count(h, 'auth_devices', 'WHERE account_id=?', person.accountId), 0);
  assert.equal((await h.json('/me', { token: admin.token })).authenticated, true);
});

test('A03 public logout cancels a held replacement verdict before any reference or registered-session publication', async t => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const h = await harness(t, { faceVerifier: async (envelope, form) => {
    if (envelope.reference_mode === 'replace_reference') { entered.resolve(); await release.promise; }
    return replacementVerifier(envelope, form);
  } });
  const person = await enroll(h); await preferences(h, person, { processing_consent: false });
  const control = await createControl(h, person), before = await profile(h, person);
  const pending = await challenge(h, control, 'replace'), completion = await captureProofs(h, pending.challenge, person.keys.privateKey);
  const sessions = await count(h, 'sessions', 'WHERE account_id=?', person.accountId);
  const inflight = h.request('/auth/face/profile/complete', { body: completion }); await arrived(entered);
  const loggedOut = await h.json('/auth/logout', { token: person.token, body: {} }); assert.equal(loggedOut.status, 'logged_out');
  const cancelled = await status(h, control, pending.intent.operation_key);
  assert.equal(cancelled.operation.state, 'cancelled'); assert.equal(cancelled.operation.challenge, null);
  assert.deepEqual(cancelled.operation.captures, []); assert.equal(cancelled.authentication_enabled, true);
  release.resolve(); const response = await inflight; assert.equal(response.status, 409);
  const denied = await response.json(); assert(denied.error); assert(!('access_token' in denied)); assert(!('refresh_token' in denied));
  assert.deepEqual(await profile(h, person), before);
  assert.equal(await count(h, 'sessions', 'WHERE account_id=?', person.accountId), sessions);
  assert.equal(await count(h, 'sessions', 'WHERE account_id=? AND revoked_at IS NULL', person.accountId), 0);
  assert.equal(await count(h, 'face_profile_retirements', 'WHERE account_id=?', person.accountId), 0);
  await h.json('/me', { token: person.token }, 401);
  const fresh = await login(h, person); assert.equal(fresh.profile_id, before.id); assert.equal(fresh.profile_revision, before.revision);
  assert.equal(await count(h, 'accounts'), 1);
});

test('A03 signed sessionless cancellation is idempotent, fences a held auth-restoration result and never undoes a committed successor', async t => {
  const entered = deferred(), release = deferred(); let hold = true; t.after(() => release.resolve());
  const h = await harness(t, { faceVerifier: async (envelope, form) => {
    if (hold && envelope.purpose === 'registration' && envelope.reference_mode === 'existing_reference') {
      entered.resolve(); await release.promise;
    }
    return replacementVerifier(envelope, form);
  } });
  const person = await enroll(h); await preferences(h, person, { processing_consent: false });
  const control = await createControl(h, person), before = await profile(h, person);
  await action(h, control, 'withdraw_authentication'); await h.json('/me', { token: person.token }, 401);
  const pending = await challenge(h, control, 'restore_authentication');
  const completion = await captureProofs(h, pending.challenge, person.keys.privateKey);
  const sessions = await count(h, 'sessions', 'WHERE account_id=?', person.accountId);
  const inflight = h.request('/auth/face/profile/complete', { body: completion }); await arrived(entered);
  const fields = { operation_key: pending.intent.operation_key };
  const acknowledgement = await h.request('/auth/face/profile/cancel', { body: await signed(control, 'cancel', fields) });
  assert.equal(acknowledgement.status, 200); await acknowledgement.arrayBuffer(); // Deliberately lose the cancellation reply.
  const recovered = await status(h, control, pending.intent.operation_key); assert.equal(recovered.operation.state, 'cancelled');
  const replay = await h.json('/auth/face/profile/cancel', { body: await signed(control, 'cancel', fields) });
  assertMetadata(replay, control); assert.equal(replay.operation.state, 'cancelled'); assert.equal(replay.version, recovered.version);
  assert.equal(replay.authentication_enabled, false); assert.equal(replay.matching_enabled, true); assert.equal(replay.processing_enabled, false);
  assert.equal(replay.operation.challenge, null); assert.deepEqual(replay.operation.captures, []);
  const unknown = await h.json('/auth/face/profile/cancel', { body: await signed(control, 'cancel', { operation_key: uuid() }) }, 404);
  assert.equal(unknown.error.code, 'face_profile_operation_not_found');
  await h.json('/auth/face/profile/cancel', { body: await signed(control, 'cancel', { ...fields, control_key: secret('lfl_') }) }, 401);
  hold = false; release.resolve(); const response = await inflight; assert.equal(response.status, 409);
  const denied = await response.json(); assert(denied.error); assert(!('access_token' in denied)); assert(!('refresh_token' in denied));
  assert.equal(await count(h, 'sessions', 'WHERE account_id=?', person.accountId), sessions);
  assert.equal(await count(h, 'sessions', 'WHERE account_id=? AND revoked_at IS NULL', person.accountId), 0);
  const current = await profile(h, person); assert.equal(current.template_key, before.template_key); assert.equal(current.auth_enabled, 0);
  assert.equal(current.consent_id, before.consent_id); assert.equal(await count(h, 'face_profile_retirements'), 0);
  const successor = await challenge(h, control, 'restore_authentication'), credentials = (await complete(h, successor)).value;
  assert.equal(credentials.account_id, person.accountId); assert.equal(credentials.profile_id, before.id);
  const committed = await h.json('/auth/face/profile/cancel', { body: await signed(control, 'cancel', { operation_key: successor.intent.operation_key }) });
  assertMetadata(committed, control); assert.equal(committed.operation.state, 'completed'); assert.equal(committed.authentication_enabled, true);
  assert.equal((await h.json('/me', { token: credentials.access_token })).authenticated, true);
  assert.equal(await count(h, 'accounts'), 1); assert.equal(await count(h, 'auth_devices'), 1);
});

test('A03 explicit expired-control renewal uses a fresh original-device face session, cancels old work and reconciles a lost reply exactly', async t => {
  const h = await harness(t), person = await enroll(h), original = await createControl(h, person);
  const before = await profile(h, person), device = (await h.storage.exec('SELECT * FROM auth_devices WHERE id=?', person.deviceId))[0];
  const pending = await challenge(h, original, 'replace');
  await h.storage.exec('UPDATE face_profile_controls SET expires_at=created_at+1 WHERE account_id=? AND device_id=?', person.accountId, person.deviceId);
  await status(h, original, undefined, 401);
  const fresh = await login(h, person); assert.equal(fresh.account_id, person.accountId); assert.equal(fresh.device_id, person.deviceId);
  const sessions = await count(h, 'sessions', 'WHERE account_id=?', person.accountId), renewed = await controlIntent(h, person);
  renewed.body = await signed(renewed, 'control', { control_operation_key: renewed.creationKey,
    renew: true, previous_control_operation_key: original.creationKey }, { nonce: false });
  const acknowledgement = await h.request('/auth/face/profile/control', { token: fresh.access_token, body: renewed.body });
  assert.equal(acknowledgement.status, 201); await acknowledgement.arrayBuffer(); // The exact renewal intent was persisted before this lost reply.
  const recovered = await status(h, renewed); assert.equal(recovered.authentication_enabled, true);
  const current = (await h.storage.exec('SELECT * FROM face_profile_controls WHERE account_id=? AND device_id=?', person.accountId, person.deviceId))[0];
  assert.equal(current.control_operation_key, renewed.creationKey);
  assert.equal(current.control_hash, await sha256(new TextEncoder().encode(renewed.key)));
  assert.equal(current.public_key_digest, original.publicKeyDigest); assert.equal(current.public_jwk, device.public_jwk);
  assert.equal(current.device_revision, device.revision); assert(current.expires_at > Date.now());
  const replay = await h.json('/auth/face/profile/control', { token: fresh.access_token, body: renewed.body }, 201);
  assertMetadata(replay, renewed); assert.equal(replay.version, recovered.version); assert.deepEqual(replay.profile, recovered.profile);
  assert.deepEqual((await h.storage.exec('SELECT * FROM face_profile_controls WHERE account_id=? AND device_id=?', person.accountId, person.deviceId))[0], current);
  const collision = await signed(renewed, 'control', { control_operation_key: renewed.creationKey,
    renew: true, previous_control_operation_key: uuid() }, { nonce: false });
  await h.json('/auth/face/profile/control', { token: fresh.access_token, body: collision }, 409);
  await status(h, original, undefined, 401);
  const cancelled = await status(h, renewed, pending.intent.operation_key);
  assert.equal(cancelled.operation.state, 'cancelled'); assert.equal(cancelled.operation.challenge, null); assert.deepEqual(cancelled.operation.captures, []);
  const oldCapture = await capture(h, pending, 0); assert.equal(oldCapture.response.status, 409); await oldCapture.response.arrayBuffer();
  assert.equal((await h.storage.exec('SELECT status FROM consents WHERE id=(SELECT consent_id FROM auth_challenges WHERE id=?)', pending.challenge.challenge_id))[0].status, 'revoked');
  assert.deepEqual(await profile(h, person), before); assert.equal(await count(h, 'sessions', 'WHERE account_id=?', person.accountId), sessions);
  assert.equal(await count(h, 'face_profile_controls'), 1); assert.equal(await count(h, 'accounts'), 1); assert.equal(await count(h, 'auth_devices'), 1);
  const currentDevice = (await h.storage.exec('SELECT * FROM auth_devices WHERE id=?', person.deviceId))[0]; assert.deepEqual(currentDevice, device);
  const managed = (await action(h, renewed, 'pause')).value; assert.equal(managed.authentication_enabled, true);
  await assertNoPlaintextControl(h, original); await assertNoPlaintextControl(h, renewed);
});

test('A03 renewal rejects a current control, wrong predecessor/key/account or inactive authentication without replacing the saved scope', async t => {
  const h = await harness(t), person = await enroll(h), original = await createControl(h, person), replacement = await controlIntent(h, person);
  const fields = { control_operation_key: replacement.creationKey, renew: true, previous_control_operation_key: original.creationKey };
  const body = await signed(replacement, 'control', fields, { nonce: false });
  const initial = (await h.storage.exec('SELECT * FROM face_profile_controls WHERE account_id=? AND device_id=?', person.accountId, person.deviceId))[0];
  await h.json('/auth/face/profile/control', { token: person.token, body }, 409);
  assert.deepEqual((await h.storage.exec('SELECT * FROM face_profile_controls WHERE account_id=? AND device_id=?', person.accountId, person.deviceId))[0], initial);
  await h.storage.exec('UPDATE face_profile_controls SET expires_at=created_at+1 WHERE account_id=? AND device_id=?', person.accountId, person.deviceId);
  const expired = (await h.storage.exec('SELECT * FROM face_profile_controls WHERE account_id=? AND device_id=?', person.accountId, person.deviceId))[0];
  const wrongPredecessor = await signed(replacement, 'control', { ...fields, previous_control_operation_key: uuid() }, { nonce: false });
  await h.json('/auth/face/profile/control', { token: person.token, body: wrongPredecessor }, 409);
  for (const reused of [{ control_key: original.key }, { control_operation_key: original.creationKey }]) {
    const mixedReuse = await signed(replacement, 'control', { ...fields, ...reused }, { nonce: false });
    await h.json('/auth/face/profile/control', { token: person.token, body: mixedReuse }, 409);
    assert.deepEqual((await h.storage.exec('SELECT * FROM face_profile_controls WHERE account_id=? AND device_id=?', person.accountId, person.deviceId))[0], expired);
  }
  const foreignKeys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const wrongKey = await signed(replacement, 'control', fields, { nonce: false, signer: foreignKeys.privateKey });
  await h.json('/auth/face/profile/control', { token: person.token, body: wrongKey }, 401);
  await h.json('/auth/face/profile/control', { body }, 401);
  const other = await enroll(h); await h.json('/auth/face/profile/control', { token: other.token, body }, 403);
  assert.deepEqual((await h.storage.exec('SELECT * FROM face_profile_controls WHERE account_id=? AND device_id=?', person.accountId, person.deviceId))[0], expired);
  assert.equal(await count(h, 'face_profile_controls'), 1); assert.equal(await count(h, 'face_profile_operations'), 0);

  const withdrawnHarness = await harness(t), withdrawn = await enroll(withdrawnHarness);
  await preferences(withdrawnHarness, withdrawn, { processing_consent: false });
  const withdrawnControl = await createControl(withdrawnHarness, withdrawn);
  await action(withdrawnHarness, withdrawnControl, 'withdraw_authentication');
  await withdrawnHarness.storage.exec('UPDATE face_profile_controls SET expires_at=created_at+1 WHERE account_id=? AND device_id=?', withdrawn.accountId, withdrawn.deviceId);
  const disabledBefore = await profile(withdrawnHarness, withdrawn), disabledControl = await withdrawnHarness.storage.exec('SELECT * FROM face_profile_controls WHERE account_id=?', withdrawn.accountId);
  const attempted = await controlIntent(withdrawnHarness, withdrawn);
  const attempt = await signed(attempted, 'control', { control_operation_key: attempted.creationKey,
    renew: true, previous_control_operation_key: withdrawnControl.creationKey }, { nonce: false });
  await withdrawnHarness.json('/auth/face/profile/control', { token: withdrawn.token, body: attempt }, 401);
  assert.deepEqual(await withdrawnHarness.storage.exec('SELECT * FROM face_profile_controls WHERE account_id=?', withdrawn.accountId), disabledControl);
  assert.deepEqual(await profile(withdrawnHarness, withdrawn), disabledBefore);
  assert.equal(disabledBefore.auth_enabled, 0); assert.equal(await count(withdrawnHarness, 'accounts'), 1);
  assert.equal(await count(withdrawnHarness, 'sessions', 'WHERE account_id=? AND revoked_at IS NULL', withdrawn.accountId), 0);
});
