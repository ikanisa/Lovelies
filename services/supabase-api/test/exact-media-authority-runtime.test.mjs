import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMediaAuthority } from '../src/gallery.ts';
import { stable } from '../src/types.ts';
import { startHarness, enroll, faceVerifierFixture, fixturePng, sha256 } from './runtime-harness.mjs';

const key = name => name + '-' + crypto.randomUUID();
const vars = { APPLE_BUNDLE_ID: 'app.lovelies.ios', APPLE_APP_ID: '987654321',
  APPLE_SUBSCRIPTION_PRODUCT_ID: 'app.lovelies.pro.monthly' };
const protocol = 'lovelies-media-authority-v1';
const pathOf = value => new URL(value).pathname;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), 10000); })]); }
  finally { clearTimeout(timer); }
}
async function until(read, predicate) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await read(); if (predicate(value)) return value;
    if (Date.now() >= deadline) throw Error('photo processing did not finish: ' + JSON.stringify(value));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
function processor(envelope, recipients) {
  return { attempt_id: envelope.attempt_id, nonce: envelope.nonce, asset_id: envelope.asset_id,
    source_version: envelope.source_version, source_checksum_sha256: envelope.source_checksum_sha256,
    model_version: envelope.model_version, engine_identity: envelope.engine_identity,
    preview: { bytes_base64: Buffer.from(fixturePng(envelope.asset_id)).toString('base64'),
      content_type: 'image/png', width: 1, height: 1 },
    matches: envelope.profiles.filter(profile => recipients.includes(profile.account_id)).map(profile => ({
      recipient_id: profile.account_id, profile_id: profile.profile_id, profile_version: profile.revision, model_version: profile.model_id })) };
}
async function preferences(h, person) {
  await h.json('/me/photo-preferences', { token: person.token, body: { receive_matches: true,
    photo_matching_consent: true, processing_consent: true, policy_version: 'photo-policy-fixture-v1', operation_key: key('preferences') } });
}
async function share(f) {
  const { h, owner, recipient, asset } = f;
  const snapshot = (await h.community(owner.token, 'sharing.snapshot', { asset_ids: [asset], operation_key: key('snapshot') })).snapshot;
  assert.equal(snapshot.pairs.length, 1);
  const preview = (await h.community(owner.token, 'sharing.preview', { snapshot_id: snapshot.id,
    snapshot_version: snapshot.version, draft_version: 1, selected_asset_ids: [asset],
    selected_recipient_ids: [recipient.accountId], excluded_pairs: [], operation_key: key('preview') })).preview;
  const committed = await h.community(owner.token, 'sharing.commit', { preview_id: preview.id,
    preview_version: preview.version, draft_version: 1, operation_key: key('commit') });
  const request = committed.recipients[0].request_id;
  assert.equal(committed.grants_created, 0, 'Matching and sender review alone must not issue photo access');
  await h.community(recipient.token, 'request.decide', { request_id: request, decision: 'accept', operation_key: key('accept') });
  const rows = await h.storage.exec('SELECT * FROM media_grants WHERE request_id=?', request);
  assert.equal(rows.length, 1); assert.equal(rows[0].active, 1); assert(rows[0].approval_id);
  return rows[0];
}
const tuple = f => f.h.storage.exec(`SELECT a.id,a.version,a.checksum_sha256,r.id rendition_id,
  r.version rendition_version,r.checksum_sha256 rendition_checksum FROM assets a JOIN renditions r ON r.asset_id=a.id
  WHERE a.id=? AND r.kind='preview'`, f.asset);
const consentBinding = row => ({ processing_consent_id: row.id, processing_consent_policy_version: row.policy_version,
  processing_consent_created_at: row.created_at, processing_consent_expires_at: row.expires_at });
const grantAuthority = (f, row) => ({ protocol, origin: 'reviewed_grant', grant_id: row.id, request_id: row.request_id,
  approval_id: row.approval_id, owner_id: row.owner_id, recipient_id: row.recipient_id, asset_id: row.asset_id, ...f.processingConsent });
const ownerAuthority = f => ({ protocol, origin: 'owner', owner_id: f.owner.accountId, asset_id: f.asset, ...f.processingConsent });

/** Every sharing decision, ticket and byte read below goes through the active
 * HTTP handlers. Enrollment, model matching and store cryptography are explicit
 * local fixtures; no provider/device/store acceptance is claimed. The harness
 * applies the canonical migration chain to a disposable local database. */
async function fixture(t, { downloads = false } = {}) {
  const recipients = [], proofs = new Map();
  const h = await startHarness({ faceVerifier: faceVerifierFixture, photoProcessor: envelope => processor(envelope, recipients), vars,
    storeVerifier: async envelope => {
      assert.equal(envelope.protocol, 'lovelies-store-verifier-v1');
      assert.equal(envelope.input_hash, await sha256(new TextEncoder().encode(stable(envelope.input))));
      const payload = proofs.get(envelope.input.signed_payload); assert(payload, 'Only an explicit fixture proof may verify');
      return { ...envelope, verified: true, payload };
    } });
  t.after(() => h.close());
  const owner = await enroll(h), recipient = await enroll(h);
  recipients.push(recipient.accountId);
  await preferences(h, owner); await preferences(h, recipient);
  if (downloads) for (const person of [owner, recipient]) {
    // The local verifier recognizes this synthetic three-part envelope. It is
    // not a real signed store transaction or proof of provider acceptance.
    const signed = 'fixture.' + key('transaction') + '.signature';
    proofs.set(signed, { bundleId: vars.APPLE_BUNDLE_ID, productId: vars.APPLE_SUBSCRIPTION_PRODUCT_ID,
      type: 'Auto-Renewable Subscription', inAppOwnershipType: 'PURCHASED', appAccountToken: person.accountId,
      environment: 'Production', purchaseDate: Date.now() - 1000, expiresDate: Date.now() + 86400000,
      signedDate: Date.now(), originalTransactionId: key('original'), transactionId: key('transaction') });
    await h.json('/subscriptions/apple/transactions', { token: person.token, body: { product_id: vars.APPLE_SUBSCRIPTION_PRODUCT_ID,
      signed_transaction: signed, operation_key: key('purchase') } });
  }
  const source = fixturePng(key('source'));
  const reserved = await h.json('/uploads/session', { token: owner.token, body: { content_type: 'image/png',
    byte_size: source.byteLength, upload_batch_id: crypto.randomUUID(), source: 'personal', operation_key: key('upload') } }, 201);
  await h.json(reserved.upload_url, { token: owner.token, raw: source, method: 'PUT', headers: { 'content-type': 'image/png' } });
  await h.json(reserved.complete_url, { token: owner.token, body: { operation_key: key('complete') } }, 202);
  const state = await until(() => h.json('/uploads/' + reserved.asset_id + '/status', { token: owner.token }),
    value => ['ready', 'failed'].includes(value.status));
  assert.equal(state.status, 'ready', state.error_code);
  const processingConsent = (await h.storage.exec(`SELECT * FROM consents WHERE account_id=? AND purpose='photo_processing'
    AND status='granted' AND revoked_at IS NULL ORDER BY created_at DESC,id LIMIT 1`, owner.accountId))[0];
  const f = { h, owner, recipient, asset: reserved.asset_id, source, processingConsentId: processingConsent.id, processingConsent: consentBinding(processingConsent) };
  f.first = await share(f);
  f.initialTuple = await tuple(f);
  f.sourceKey = (await h.storage.exec('SELECT object_key FROM assets WHERE id=?', f.asset))[0].object_key;
  f.previewKey = (await h.storage.exec("SELECT object_key FROM renditions WHERE asset_id=? AND kind='preview'", f.asset))[0].object_key;
  return f;
}
async function replace(f) {
  await f.h.community(f.recipient.token, 'request.decide', { request_id: f.first.request_id,
    decision: 'revoke', operation_key: key('revoke') });
  assert.equal((await f.h.storage.exec('SELECT active FROM media_grants WHERE id=?', f.first.id))[0].active, 0);
  await f.h.json(`/community/media/${f.asset}/preview`, { token: f.recipient.token }, 403);
  const replacement = await share(f);
  assert.notEqual(replacement.id, f.first.id); assert.notEqual(replacement.request_id, f.first.request_id);
  assert.notEqual(replacement.approval_id, f.first.approval_id);
  assert.deepEqual(await tuple(f), f.initialTuple, 'The source and rendition must remain unchanged throughout the real HTTP ABA');
  return replacement;
}
async function issue(f, kind, person = f.recipient) {
  const body = { asset_id: f.asset, ...(kind === 'download' ? { operation_key: key('download') } : {}) };
  const value = await f.h.json(kind === 'preview' ? '/previews/sign' : '/downloads/sign', { token: person.token, body });
  const path = pathOf(kind === 'preview' ? value.preview_url : value.download_url), id = path.split('/').at(-1);
  const table = kind === 'preview' ? 'media_tickets' : 'download_tickets';
  const row = (await f.h.storage.exec('SELECT * FROM ' + table + ' WHERE id=?', id))[0];
  const authority = JSON.parse(row.authority_json);
  assert.equal(row.asset_id, f.asset);
  return { id, path, row, authority, table, body, value };
}
async function assertBytes(f, response, kind = 'preview') {
  assert.equal(response.status, 200, `Expected ${kind} bytes, got ${response.status}`);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), kind === 'preview' ? fixturePng(f.asset) : f.source);
}
async function assertDenied(response) {
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('content-type'), 'application/json');
  const body = await response.json();
  assert(['photo_authority_changed', 'photo_forbidden'].includes(body.error.code), JSON.stringify(body));
}

/** Gate Storage outside a database transaction. Competing canonical decisions
 * therefore use another real PG connection without reentrant SQL/advisory-lock
 * hooks. Body gates retain the actual plaintext buffer to check failure erasure. */
function storageGate(f, phase) {
  const [bucketName, method, objectKey, ordinal, body] = phase === 'preview-source-head'
    ? ['QUARANTINE', 'head', f.sourceKey, 1, false]
    : phase === 'preview-get' ? ['PHOTOS', 'get', f.previewKey, 1, false]
    : phase === 'preview-body' ? ['PHOTOS', 'get', f.previewKey, 1, true]
    : phase === 'preview-final-head' ? ['PHOTOS', 'head', f.previewKey, 2, false]
    : phase === 'preview-final-source-head' ? ['QUARANTINE', 'head', f.sourceKey, 2, false]
    : phase === 'download-get' ? ['QUARANTINE', 'get', f.sourceKey, 1, false]
    : phase === 'download-body' ? ['QUARANTINE', 'get', f.sourceKey, 1, true]
    : phase === 'download-final-head' ? ['QUARANTINE', 'head', f.sourceKey, 2, false]
    : (() => { throw Error('unknown gate phase'); })();
  // MemoryBucket.get calls head once. The ordinal-2 cases intercept the later
  // explicit verification head, after the handler has read the full body.
  const bucket = f.h.env[bucketName], original = bucket[method], entered = deferred(), released = deferred();
  let hits = 0, consumed = 0, heldBytes;
  bucket[method] = async function (key) {
    const value = await original.call(this, key);
    if (key !== objectKey || ++hits !== ordinal) return value;
    consumed++;
    if (body) {
      assert(value);
      return { ...value, arrayBuffer: async () => {
        const bytes = await value.arrayBuffer(); heldBytes = new Uint8Array(bytes);
        entered.resolve(); await released.promise; return bytes;
      } };
    }
    entered.resolve(); await released.promise; return value;
  };
  return { entered: () => bounded(entered.promise, 'Exact Storage gate was not reached: ' + phase),
    release: released.resolve, close: () => { released.resolve(); bucket[method] = original; },
    assertConsumed: () => assert.equal(consumed, 1, 'The intended Storage await must be exercised exactly once'),
    assertErased: () => { assert(heldBytes?.length, 'The body gate must have retained actual bytes');
      assert(heldBytes.every(byte => byte === 0), 'Denied plaintext bytes must be erased'); } };
}

test('strict authority parser rejects legacy, unknown, extra and noncanonical bindings', () => {
  const owner = { protocol, origin: 'owner', owner_id: crypto.randomUUID(), asset_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', processing_consent_id: crypto.randomUUID(),
    processing_consent_policy_version: 'photo-policy-fixture-v1', processing_consent_created_at: 1, processing_consent_expires_at: null };
  assert.deepEqual(parseMediaAuthority(JSON.stringify(owner)), owner);
  for (const raw of [null, undefined, 12, '', 'null', '[]', '{', '{}', JSON.stringify({ ...owner, protocol: 'v0' }),
    JSON.stringify({ ...owner, extra: true }), JSON.stringify({ ...owner, owner_id: 'legacy-id' }),
    JSON.stringify({ ...owner, asset_id: owner.asset_id.toUpperCase() }),
    JSON.stringify({ protocol, origin: 'owner', owner_id: owner.owner_id, asset_id: owner.asset_id }),
    JSON.stringify({ ...owner, processing_consent_id: 'unknown-consent' }),
    JSON.stringify({ ...owner, processing_consent_created_at: 1.5 }), JSON.stringify({ ...owner, processing_consent_created_at: -1 }),
    JSON.stringify({ ...owner, processing_consent_expires_at: 'tomorrow' }), JSON.stringify({ ...owner, processing_consent_policy_version: 'bad policy' })])
    assert.throws(() => parseMediaAuthority(raw), error => error.status === 403 && error.code === 'photo_authority_changed');
});

for (const kind of ['preview', 'download']) test(`old ${kind} ticket cannot adopt R2/G2 for the unchanged source and rendition`, async t => {
  const f = await fixture(t, { downloads: kind === 'download' }), old = await issue(f, kind);
  assert.deepEqual(old.authority, grantAuthority(f, f.first));
  await assertBytes(f, await f.h.request(old.path), kind);
  const beforeRecords = (await f.h.storage.exec('SELECT * FROM download_records ORDER BY id'));
  const replacement = await replace(f);
  await assertDenied(await f.h.request(old.path));
  assert.deepEqual(await f.h.storage.exec('SELECT * FROM ' + old.table + ' WHERE id=?', old.id), [old.row]);
  assert.deepEqual(await f.h.storage.exec('SELECT * FROM download_records ORDER BY id'), beforeRecords);
  const fresh = await issue(f, kind);
  assert.deepEqual(fresh.authority, grantAuthority(f, replacement));
  await assertBytes(f, await f.h.request(fresh.path), kind);
  await assertBytes(f, await f.h.request(`/community/media/${f.asset}/preview`, { token: f.recipient.token }));
});

for (const route of ['direct', 'ticket']) for (const phase of ['preview-source-head', 'preview-get', 'preview-body', 'preview-final-head', 'preview-final-source-head'])
  test(`${route} preview read held at ${phase} keeps G1 and rejects replacement G2`, async t => {
    const f = await fixture(t), ticket = route === 'ticket' ? await issue(f, 'preview') : null;
    const gate = storageGate(f, phase);
    const pending = f.h.request(ticket?.path ?? `/community/media/${f.asset}/preview`, ticket ? {} : { token: f.recipient.token });
    try {
      await gate.entered(); const replacement = await replace(f); gate.release();
      await assertDenied(await pending); gate.assertConsumed();
      if (phase === 'preview-body') gate.assertErased();
      const fresh = await issue(f, 'preview'); assert.deepEqual(fresh.authority, grantAuthority(f, replacement));
      await assertBytes(f, await f.h.request(fresh.path));
    } finally { gate.close(); await pending; }
  });

for (const phase of ['download-get', 'download-body', 'download-final-head'])
  test(`original read held at ${phase} keeps G1, denies G2 substitution and records no download`, async t => {
    const f = await fixture(t, { downloads: true }), ticket = await issue(f, 'download'), gate = storageGate(f, phase);
    const pending = f.h.request(ticket.path);
    try {
      await gate.entered(); const replacement = await replace(f); gate.release();
      await assertDenied(await pending); gate.assertConsumed();
      if (phase === 'download-body') gate.assertErased();
      assert.equal((await f.h.storage.exec('SELECT COUNT(*) n FROM download_records WHERE ticket_id=?', ticket.id))[0].n, 0);
      const fresh = await issue(f, 'download'); assert.deepEqual(fresh.authority, grantAuthority(f, replacement));
      await assertBytes(f, await f.h.request(fresh.path), 'download');
    } finally { gate.close(); await pending; }
  });

for (const [route, phase] of [['direct', 'preview-get'], ['ticket', 'preview-body'], ['download', 'download-body']])
  test(`unchanged authority control: ${route} held at ${phase} still returns its bytes`, async t => {
    const f = await fixture(t, { downloads: route === 'download' }), kind = route === 'download' ? 'download' : 'preview';
    const ticket = route === 'direct' ? null : await issue(f, kind), gate = storageGate(f, phase);
    const pending = f.h.request(ticket?.path ?? `/community/media/${f.asset}/preview`, ticket ? {} : { token: f.recipient.token });
    try { await gate.entered(); gate.release(); await assertBytes(f, await pending, kind); gate.assertConsumed(); }
    finally { gate.close(); await pending; }
  });

for (const kind of ['preview', 'download']) test(`owner ${kind} ticket and held read retain owner origin while a recipient grant is replaced`, async t => {
  const f = await fixture(t, { downloads: kind === 'download' }), ticket = await issue(f, kind, f.owner);
  assert.deepEqual(ticket.authority, ownerAuthority(f));
  const gate = storageGate(f, kind === 'preview' ? 'preview-get' : 'download-get'), pending = f.h.request(ticket.path);
  try {
    await gate.entered(); await replace(f); gate.release();
    await assertBytes(f, await pending, kind); gate.assertConsumed();
    await assertBytes(f, await f.h.request(ticket.path), kind);
    assert.deepEqual(await f.h.storage.exec('SELECT * FROM ' + ticket.table + ' WHERE id=?', ticket.id), [ticket.row]);
  } finally { gate.close(); await pending; }
});

test('a later independent grant does not invalidate still-active G1 or replace its bound identity', async t => {
  const f = await fixture(t, { downloads: true });
  const tickets = [await issue(f, 'preview'), await issue(f, 'download')];
  const second = await share(f);
  assert.notEqual(second.id, f.first.id);
  for (const ticket of tickets) {
    assert.deepEqual(ticket.authority, grantAuthority(f, f.first));
    await assertBytes(f, await f.h.request(ticket.path), ticket.table === 'media_tickets' ? 'preview' : 'download');
  }
  await f.h.community(f.recipient.token, 'request.decide', { request_id: second.request_id, decision: 'revoke', operation_key: key('revoke-second') });
  for (const ticket of tickets) await assertBytes(f, await f.h.request(ticket.path), ticket.table === 'media_tickets' ? 'preview' : 'download');
  assert.deepEqual(await tuple(f), f.initialTuple);
});

for (const kind of ['preview', 'download']) test(`unknown, cross-account and mixed-episode ${kind} bindings fail closed before Storage and preserve every row`, async t => {
  const f = await fixture(t, { downloads: kind === 'download' }), ticket = await issue(f, kind), second = await share(f);
  const grant = grantAuthority(f, f.first), otherConsent = (await f.h.storage.exec(
    "SELECT id FROM consents WHERE account_id=? AND purpose='photo_processing' AND status='granted'", f.recipient.accountId))[0].id,
    wrongPurpose = (await f.h.storage.exec("SELECT id FROM consents WHERE account_id=? AND purpose='face_authentication' AND status='granted'", f.owner.accountId))[0].id,
    changes = [null, '{}', JSON.stringify({ ...grant, protocol: 'unknown-protocol' }),
    JSON.stringify({ ...grant, undocumented: 'preserve-unknown' }), JSON.stringify({ ...grant, grant_id: 'legacy-test-row' }),
    JSON.stringify({ ...grant, recipient_id: crypto.randomUUID() }), JSON.stringify({ ...grant, owner_id: crypto.randomUUID() }),
    JSON.stringify({ ...grant, asset_id: crypto.randomUUID() }),
    JSON.stringify({ ...grant, grant_id: second.id }), JSON.stringify({ ...grant, request_id: second.request_id }),
    JSON.stringify({ ...grant, approval_id: second.approval_id }), JSON.stringify({ ...ownerAuthority(f), owner_id: f.recipient.accountId }),
    JSON.stringify({ ...grant, processing_consent_id: crypto.randomUUID() }),
    JSON.stringify({ ...grant, processing_consent_id: otherConsent }), JSON.stringify({ ...grant, processing_consent_id: wrongPurpose }),
    JSON.stringify(Object.fromEntries(Object.entries(grant).filter(([name]) => name !== 'processing_consent_id')))];
  const calls = [], restore = [];
  for (const bucketName of ['PHOTOS', 'QUARANTINE']) for (const method of ['head', 'get']) {
    const bucket = f.h.env[bucketName], original = bucket[method];
    bucket[method] = function (...args) { calls.push([bucketName, method]); return original.apply(this, args); };
    restore.push(() => { bucket[method] = original; });
  }
  try {
    for (const raw of changes) {
      const id = crypto.randomUUID();
      if (kind === 'preview') await f.h.storage.exec(`INSERT INTO media_tickets
        (id,account_id,session_id,asset_id,rendition_id,asset_version,rendition_version,expires_at,authority_json)
        SELECT ?,account_id,session_id,asset_id,rendition_id,asset_version,rendition_version,expires_at,? FROM media_tickets WHERE id=?`, id, raw, ticket.id);
      else await f.h.storage.exec(`INSERT INTO download_tickets
        (id,account_id,session_id,asset_id,asset_version,source_checksum,subscription_id,subscription_version,expires_at,created_at,authority_json)
        SELECT ?,account_id,session_id,asset_id,asset_version,source_checksum,subscription_id,subscription_version,expires_at,created_at,? FROM download_tickets WHERE id=?`, id, raw, ticket.id);
      const before = await f.h.storage.exec('SELECT * FROM ' + ticket.table + ' WHERE id=?', id);
      await assertDenied(await f.h.request(ticket.path.slice(0, ticket.path.lastIndexOf('/') + 1) + id));
      assert.deepEqual(await f.h.storage.exec('SELECT * FROM ' + ticket.table + ' WHERE id=?', id), before);
    }
    assert.deepEqual(calls, [], 'Unknown or mismatched stored bindings may not initiate a private Storage read');
    assert.equal((await f.h.storage.exec('SELECT COUNT(*) n FROM download_records'))[0].n, 0);
  } finally { for (const reset of restore) reset(); }
  await assertBytes(f, await f.h.request(ticket.path), kind);
});

test('gallery rows are admitted by their own exact reviewed grant instead of borrowing another grant', async t => {
  const f = await fixture(t), second = await share(f);
  // The first request is retired through the normal HTTP route, then an explicit
  // corruption fixture leaves its grant incorrectly active. G2 remains valid.
  await f.h.community(f.recipient.token, 'request.decide', { request_id: f.first.request_id, decision: 'revoke', operation_key: key('revoke') });
  await f.h.storage.exec('UPDATE media_grants SET active=1,revoked_at=NULL,created_at=? WHERE id=?', f.h.app.now() + 1000, f.first.id);
  const before = await f.h.storage.exec('SELECT * FROM media_grants WHERE id=?', f.first.id);
  const gallery = await f.h.json('/me/gallery', { token: f.recipient.token });
  assert.equal(gallery.gallery_items.length, 1); assert.equal(gallery.gallery_items[0].id, second.id);
  assert.equal(gallery.gallery_items[0].media_asset_id, f.asset);
  assert.deepEqual(await f.h.storage.exec('SELECT * FROM media_grants WHERE id=?', f.first.id), before);
});


function spyStorage(f) {
  const calls = [], restores = [];
  for (const name of ['PHOTOS', 'QUARANTINE']) for (const method of ['head', 'get']) {
    const bucket = f.h.env[name], original = bucket[method];
    bucket[method] = function (...args) { calls.push([name, method]); return original.apply(this, args); };
    restores.push(() => { bucket[method] = original; });
  }
  return { calls, close: () => { for (const restore of restores) restore(); } };
}
async function processingABA(f, restoreReviewed = false) {
  const old = f.processingConsentId;
  const candidates = await f.h.storage.exec('SELECT * FROM candidates WHERE asset_id=? AND owner_id=?', f.asset, f.owner.accountId);
  const request = (await f.h.storage.exec('SELECT * FROM sharing_requests WHERE id=?', f.first.request_id))[0];
  const grant = (await f.h.storage.exec('SELECT * FROM media_grants WHERE id=?', f.first.id))[0];
  for (const processing_consent of [false, true]) await f.h.json('/me/photo-preferences', { token: f.owner.token,
    body: { processing_consent, policy_version: 'photo-policy-fixture-v1', operation_key: key('processing-episode') } });
  const prior = (await f.h.storage.exec('SELECT * FROM consents WHERE id=?', old))[0];
  assert.equal(prior.status, 'revoked'); assert(prior.revoked_at);
  const current = (await f.h.storage.exec(`SELECT * FROM consents WHERE account_id=? AND purpose='photo_processing'
    AND status='granted' AND revoked_at IS NULL ORDER BY created_at DESC,id LIMIT 1`, f.owner.accountId))[0];
  assert(current); assert.notEqual(current.id, old); f.processingConsentId = current.id; f.processingConsent = consentBinding(current);
  assert.equal((await f.h.storage.exec('SELECT active FROM media_grants WHERE id=?', f.first.id))[0].active, 0);
  if (restoreReviewed) {
    // Explicit partial-restore/corruption fixture, not a normal-route exploit:
    // canonical withdrawal retired G1/R1. Restore only those old rows and the
    // candidate status to independently prove that C2 cannot replace C1.
    for (const row of candidates) await f.h.storage.exec('UPDATE candidates SET status=? WHERE id=?', row.status, row.id);
    await f.h.storage.exec('UPDATE sharing_requests SET status=?,updated_at=? WHERE id=?', request.status, request.updated_at, request.id);
    await f.h.storage.exec('UPDATE media_grants SET active=?,revoked_at=? WHERE id=?', grant.active, grant.revoked_at, grant.id);
  }
  assert.deepEqual(await tuple(f), f.initialTuple);
  return old;
}

for (const origin of ['owner', 'reviewed']) for (const kind of ['preview', 'download'])
  test(`${origin} ${kind} ticket keeps C1 after processing withdrawal and C2 regrant`, async t => {
    const f = await fixture(t, { downloads: kind === 'download' }), person = origin === 'owner' ? f.owner : f.recipient;
    const old = await issue(f, kind, person), c1 = f.processingConsentId;
    assert.equal(old.authority.processing_consent_id, c1);
    await processingABA(f, origin === 'reviewed');
    const spy = spyStorage(f);
    try { await assertDenied(await f.h.request(old.path)); assert.deepEqual(spy.calls, []); }
    finally { spy.close(); }
    assert.deepEqual(await f.h.storage.exec('SELECT * FROM ' + old.table + ' WHERE id=?', old.id), [old.row]);
    const fresh = await issue(f, kind, person);
    assert.equal(fresh.authority.processing_consent_id, f.processingConsentId);
    assert.notEqual(fresh.authority.processing_consent_id, c1);
    if (origin === 'reviewed') assert.equal(fresh.authority.grant_id, f.first.id, 'Controlled restore keeps G1 to isolate the consent check');
    await assertBytes(f, await f.h.request(fresh.path), kind);
  });

for (const origin of ['owner', 'reviewed']) for (const [route, phase] of [
  ['direct', 'preview-body'], ['preview', 'preview-get'], ['preview', 'preview-body'],
  ['download', 'download-get'], ['download', 'download-body']])
  test(`${origin} ${route} held at ${phase} cannot adopt processing C2`, async t => {
    const f = await fixture(t, { downloads: route === 'download' }), person = origin === 'owner' ? f.owner : f.recipient;
    const kind = route === 'download' ? 'download' : 'preview', ticket = route === 'direct' ? null : await issue(f, kind, person);
    const gate = storageGate(f, phase), pending = f.h.request(ticket?.path ?? `/community/media/${f.asset}/preview`, ticket ? {} : { token: person.token });
    try {
      await gate.entered(); await processingABA(f, origin === 'reviewed'); gate.release();
      await assertDenied(await pending); gate.assertConsumed(); if (phase.endsWith('body')) gate.assertErased();
      if (ticket && kind === 'download') assert.equal((await f.h.storage.exec('SELECT COUNT(*) n FROM download_records WHERE ticket_id=?', ticket.id))[0].n, 0);
      const fresh = await issue(f, kind, person);
      assert.equal(fresh.authority.processing_consent_id, f.processingConsentId);
      await assertBytes(f, await f.h.request(fresh.path), kind);
    } finally { gate.close(); await pending; }
  });

for (const origin of ['owner', 'reviewed']) test(`${origin} existing tickets retain current C1 when an independent C2 is added`, async t => {
  const f = await fixture(t, { downloads: true }), person = origin === 'owner' ? f.owner : f.recipient;
  const tickets = [await issue(f, 'preview', person), await issue(f, 'download', person)], c2 = crypto.randomUUID();
  await f.h.storage.exec(`INSERT INTO consents(id,account_id,purpose,policy_version,status,created_at)
    VALUES(?,?,'photo_processing','photo-policy-fixture-v1','granted',?)`, c2, f.owner.accountId, f.h.app.now() + 1);
  for (const ticket of tickets) {
    assert.equal(ticket.authority.processing_consent_id, f.processingConsentId);
    await assertBytes(f, await f.h.request(ticket.path), ticket.table === 'media_tickets' ? 'preview' : 'download');
  }
  assert.equal((await issue(f, 'preview', person)).authority.processing_consent_id, c2, 'A fresh ticket selects the latest current episode');
});

async function authorityRows(f) {
  const approval = (await f.h.storage.exec('SELECT * FROM sharing_approvals WHERE id=?', f.first.approval_id))[0];
  const request = (await f.h.storage.exec('SELECT * FROM sharing_requests WHERE id=?', f.first.request_id))[0];
  return { approval, request };
}
async function unrelatedCandidate(f) {
  const id = crypto.randomUUID();
  // A schema-valid, deliberately inconsistent reverse-pair row supplies an
  // existing candidate FK. It cannot qualify for the original owner/recipient.
  await f.h.storage.exec(`INSERT INTO candidates(id,asset_id,owner_id,recipient_id,origin_id,status,version,created_at)
    SELECT ?,asset_id,recipient_id,owner_id,origin_id,status,version,created_at FROM candidates
    WHERE asset_id=? AND owner_id=? AND recipient_id=?`, id, f.asset, f.owner.accountId, f.recipient.accountId);
  return id;
}
/** Deliberate legacy/restore-corruption fixture only. The active schema has an
 * unconditional approval_immutable trigger, so ordinary API/backend writes may
 * not create these mismatches. The isolated migrator disables ONLY that named
 * trigger inside one atomic DO statement, writes the single selected row as the
 * backend, restores the migrator and re-enables the trigger before commit. Any
 * failure rolls the entire DO back. Never use this helper in application code. */
async function syntheticApprovalRow(f, candidateId, pairVersion) {
  const engine = f.h.engine;
  if (f.h.databaseUrl) {
    const target = new URL(f.h.databaseUrl);
    assert(['localhost', '127.0.0.1', '[::1]', '::1'].includes(target.hostname)
      && /^\/lovelies_test_[0-9a-f]{32}$/.test(target.pathname), 'Only this owned isolated local test database may be altered');
  }
  const triggerState = async () => (await engine.query(`SELECT current_user AS role,t.tgenabled
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='lovelies_private' AND c.relname='sharing_approvals'
      AND t.tgname='approval_immutable' AND NOT t.tgisinternal`)).rows;
  const before = await triggerState();
  assert.equal(before.length, 1); assert.equal(before[0].tgenabled, 'O');
  // Fixture values are canonical UUIDs or bounded generated pair identifiers.
  // Excluding quotes/dollar delimiters before interpolation keeps the one DO
  // statement independent of driver support for parameters inside a DO body.
  const literal = value => {
    assert.equal(typeof value, 'string'); assert(/^[A-Za-z0-9._:-]{1,256}$/.test(value), 'Only bounded synthetic fixture identifiers are accepted');
    return "'" + value + "'";
  };
  const candidate = literal(candidateId), version = literal(pairVersion), approval = literal(f.first.approval_id);
  try {
    await engine.exec(`DO $media_authority_fixture$
      DECLARE migrator name:=current_user; changed integer;
      BEGIN
        ALTER TABLE lovelies_private.sharing_approvals DISABLE TRIGGER approval_immutable;
        EXECUTE 'SET LOCAL ROLE lovelies_api';
        UPDATE lovelies_private.sharing_approvals SET candidate_id=${candidate},pair_version=${version} WHERE id=${approval};
        GET DIAGNOSTICS changed=ROW_COUNT;
        IF changed<>1 THEN RAISE EXCEPTION 'synthetic_approval_row_not_unique'; END IF;
        EXECUTE format('SET LOCAL ROLE %I',migrator);
        ALTER TABLE lovelies_private.sharing_approvals ENABLE TRIGGER approval_immutable;
      END $media_authority_fixture$;`);
  } finally {
    assert.deepEqual(await triggerState(), before, 'The exact approval trigger must be enabled and migrator restored after success or rollback');
  }
  await assert.rejects(() => f.h.storage.exec('UPDATE sharing_approvals SET pair_version=pair_version WHERE id=?', f.first.approval_id),
    /sharing_approval_immutable/, 'The restored trigger must still reject a normal backend update');
}
async function corruptApproval(f, fault, other) {
  if (fault === 'candidate' || fault === 'pair') {
    const { approval } = await authorityRows(f);
    await syntheticApprovalRow(f, fault === 'candidate' ? other : approval.candidate_id,
      fault === 'pair' ? key('other-pair') : approval.pair_version);
  }
  else {
    const ids = fault === 'request-duplicate' ? [f.asset, f.asset] : fault === 'request-number' ? [7]
      : fault === 'request-noncanonical' ? ['not-a-uuid'] : [crypto.randomUUID()];
    await f.h.storage.exec('UPDATE sharing_requests SET asset_ids_json=? WHERE id=?', JSON.stringify(ids), f.first.request_id);
  }
}
for (const kind of ['direct', 'preview', 'download']) test(`${kind} rejects mismatched approval candidate/pair and request asset membership before Storage`, async t => {
  const f = await fixture(t, { downloads: kind === 'download' }), ticket = kind === 'direct' ? null : await issue(f, kind);
  const originals = await authorityRows(f), other = await unrelatedCandidate(f), spy = spyStorage(f);
  try {
    for (const fault of ['candidate', 'pair', 'request', 'request-duplicate', 'request-number', 'request-noncanonical']) {
      await corruptApproval(f, fault, other);
      const malformed = await authorityRows(f);
      await assertDenied(await f.h.request(ticket?.path ?? `/community/media/${f.asset}/preview`, ticket ? {} : { token: f.recipient.token }));
      assert.deepEqual(await authorityRows(f), malformed, 'A rejected read may not repair or rewrite unknown authority');
      if (fault === 'candidate' || fault === 'pair') await syntheticApprovalRow(f, originals.approval.candidate_id, originals.approval.pair_version);
      await f.h.storage.exec('UPDATE sharing_requests SET asset_ids_json=? WHERE id=?', originals.request.asset_ids_json, originals.request.id);
    }
    assert.deepEqual(spy.calls, []);
    assert.equal((await f.h.storage.exec('SELECT COUNT(*) n FROM download_records'))[0].n, 0);
  } finally { spy.close(); }
  await assertBytes(f, await f.h.request(ticket?.path ?? `/community/media/${f.asset}/preview`, ticket ? {} : { token: f.recipient.token }), kind === 'download' ? 'download' : 'preview');
});
for (const kind of ['preview', 'download']) for (const fault of ['candidate', 'pair', 'request'])
  test(`${kind} body held before a ${fault} authority mismatch fails without bytes`, async t => {
    const f = await fixture(t, { downloads: kind === 'download' }), ticket = await issue(f, kind), other = await unrelatedCandidate(f);
    const gate = storageGate(f, kind + '-body'), pending = f.h.request(ticket.path);
    try {
      await gate.entered(); await corruptApproval(f, fault, other); const malformed = await authorityRows(f); gate.release();
      await assertDenied(await pending); gate.assertConsumed(); gate.assertErased();
      assert.deepEqual(await authorityRows(f), malformed);
      assert.equal((await f.h.storage.exec('SELECT COUNT(*) n FROM download_records'))[0].n, 0);
    } finally { gate.close(); await pending; }
  });

for (const kind of ['preview', 'download']) test(`${kind} ticket expiry during actual body await fails at the expiry boundary`, async t => {
  const f = await fixture(t, { downloads: kind === 'download' }), originalNow = f.h.app.now;
  let now = originalNow(); f.h.app.now = () => now;
  const ticket = await issue(f, kind), gate = storageGate(f, kind + '-body'), pending = f.h.request(ticket.path);
  try {
    await gate.entered(); now = ticket.row.expires_at; gate.release();
    const response = await pending; assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, kind === 'preview' ? 'preview_changed' : 'download_authority_changed');
    gate.assertConsumed(); gate.assertErased();
    assert.deepEqual(await f.h.storage.exec('SELECT * FROM ' + ticket.table + ' WHERE id=?', ticket.id), [ticket.row]);
    assert.equal((await f.h.storage.exec('SELECT COUNT(*) n FROM download_records'))[0].n, 0);
  } finally { gate.close(); await pending; f.h.app.now = originalNow; }
});
for (const origin of ['owner', 'reviewed']) for (const kind of ['preview', 'download'])
  test(`${origin} ${kind} held read rejects its exact processing consent at expiry`, async t => {
    const f = await fixture(t, { downloads: kind === 'download' }), originalNow = f.h.app.now;
    let now = originalNow(); f.h.app.now = () => now;
    const expiry = now + 30000;
    await f.h.storage.exec('UPDATE consents SET expires_at=? WHERE id=?', expiry, f.processingConsentId);
    const alternate = crypto.randomUUID();
    // Schema-permitted simultaneous processing episode C2 stays valid. C1 is
    // newer, so admission binds C1; time alone must never substitute C2 after
    // C1 expires. No preference, grant, request or candidate row is retired.
    await f.h.storage.exec(`INSERT INTO consents(id,account_id,purpose,policy_version,status,created_at)
      VALUES(?,?,'photo_processing','photo-policy-fixture-v1','granted',?)`, alternate, f.owner.accountId,
      Math.max(0, f.processingConsent.processing_consent_created_at - 1));
    const person = origin === 'owner' ? f.owner : f.recipient, ticket = await issue(f, kind, person);
    const gate = storageGate(f, kind + '-body'), pending = f.h.request(ticket.path);
    try {
      await gate.entered(); now = expiry; gate.release(); await assertDenied(await pending); gate.assertConsumed(); gate.assertErased();
      assert.equal((await f.h.storage.exec('SELECT COUNT(*) n FROM download_records'))[0].n, 0);
      const consent = (await f.h.storage.exec('SELECT * FROM consents WHERE id=?', f.processingConsentId))[0];
      assert.equal(consent.status, 'granted'); assert.equal(consent.expires_at, expiry); assert.equal(consent.revoked_at, null);
      assert.equal((await f.h.storage.exec('SELECT active FROM media_grants WHERE id=?', f.first.id))[0].active, 1);
      const fresh = await issue(f, kind, person); assert.equal(fresh.authority.processing_consent_id, alternate);
      await assertBytes(f, await f.h.request(fresh.path), kind);
    } finally { gate.close(); await pending; f.h.app.now = originalNow; }
  });

for (const origin of ['owner', 'reviewed']) test(`${origin} cached legacy download receipt stays original; a fresh key obtains bound authority`, async t => {
  const f = await fixture(t, { downloads: true }), person = origin === 'owner' ? f.owner : f.recipient, ticket = await issue(f, 'download', person);
  // Emulate a pre-column ticket alongside its already committed SQL receipt.
  // The new handler must neither adopt/backfill that ticket nor change its receipt.
  await f.h.storage.exec('UPDATE download_tickets SET authority_json=NULL WHERE id=?', ticket.id);
  const before = await f.h.storage.exec('SELECT * FROM download_tickets WHERE id=?', ticket.id);
  const receipt = await f.h.storage.exec('SELECT * FROM operations WHERE actor_id=? AND source=? AND operation_key=?', person.accountId, 'media', ticket.body.operation_key);
  assert.equal(receipt.length, 1);
  const replay = await f.h.json('/downloads/sign', { token: person.token, body: ticket.body });
  assert.deepEqual(replay, ticket.value);
  assert.deepEqual(await f.h.storage.exec('SELECT * FROM operations WHERE actor_id=? AND source=? AND operation_key=?', person.accountId, 'media', ticket.body.operation_key), receipt);
  assert.equal((await f.h.storage.exec('SELECT COUNT(*) n FROM download_tickets'))[0].n, 1);
  const spy = spyStorage(f);
  try { await assertDenied(await f.h.request(ticket.path)); assert.deepEqual(spy.calls, []); }
  finally { spy.close(); }
  assert.deepEqual(await f.h.storage.exec('SELECT * FROM download_tickets WHERE id=?', ticket.id), before);
  const fresh = await issue(f, 'download', person); assert.notEqual(fresh.id, ticket.id);
  assert.deepEqual(fresh.authority, origin === 'owner' ? ownerAuthority(f) : grantAuthority(f, f.first));
  await assertBytes(f, await f.h.request(fresh.path), 'download');
  assert.equal((await f.h.storage.exec('SELECT COUNT(*) n FROM download_records WHERE ticket_id=?', ticket.id))[0].n, 0);
  assert.deepEqual(await f.h.storage.exec('SELECT * FROM download_tickets WHERE id=?', ticket.id), before);
});
for (const origin of ['owner', 'reviewed']) test(`${origin} legacy preview ticket remains denied while a fresh sign request obtains authority`, async t => {
  const f = await fixture(t), person = origin === 'owner' ? f.owner : f.recipient, ticket = await issue(f, 'preview', person);
  await f.h.storage.exec('UPDATE media_tickets SET authority_json=NULL WHERE id=?', ticket.id);
  const before = await f.h.storage.exec('SELECT * FROM media_tickets WHERE id=?', ticket.id), spy = spyStorage(f);
  try { await assertDenied(await f.h.request(ticket.path)); assert.deepEqual(spy.calls, []); }
  finally { spy.close(); }
  const fresh = await issue(f, 'preview', person); assert.notEqual(fresh.id, ticket.id);
  assert.deepEqual(fresh.authority, origin === 'owner' ? ownerAuthority(f) : grantAuthority(f, f.first));
  await assertBytes(f, await f.h.request(fresh.path));
  assert.deepEqual(await f.h.storage.exec('SELECT * FROM media_tickets WHERE id=?', ticket.id), before);
});


for (const origin of ['owner', 'reviewed']) for (const kind of ['preview', 'download'])
  test(`${origin} ${kind} ticket retains the exact processing row timestamps`, async t => {
    const f = await fixture(t, { downloads: kind === 'download' }), person = origin === 'owner' ? f.owner : f.recipient;
    const ticket = await issue(f, kind, person), original = (await f.h.storage.exec('SELECT * FROM consents WHERE id=?', f.processingConsentId))[0];
    for (const change of [{ created_at: original.created_at + 1, expires_at: original.expires_at },
      { created_at: original.created_at, expires_at: f.h.app.now() + 600000 }]) {
      await f.h.storage.exec('UPDATE consents SET created_at=?,expires_at=? WHERE id=?', change.created_at, change.expires_at, original.id);
      const changed = (await f.h.storage.exec('SELECT * FROM consents WHERE id=?', original.id))[0], spy = spyStorage(f);
      try { await assertDenied(await f.h.request(ticket.path)); assert.deepEqual(spy.calls, []); }
      finally { spy.close(); }
      assert.deepEqual(await f.h.storage.exec('SELECT * FROM consents WHERE id=?', original.id), [changed]);
      const fresh = await issue(f, kind, person);
      assert.equal(fresh.authority.processing_consent_id, original.id);
      assert.equal(fresh.authority.processing_consent_created_at, change.created_at);
      assert.equal(fresh.authority.processing_consent_expires_at, change.expires_at);
      await assertBytes(f, await f.h.request(fresh.path), kind);
      await f.h.storage.exec('UPDATE consents SET created_at=?,expires_at=? WHERE id=?', original.created_at, original.expires_at, original.id);
    }
    assert.deepEqual(await f.h.storage.exec('SELECT * FROM ' + ticket.table + ' WHERE id=?', ticket.id), [ticket.row]);
  });
