import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { LoveliesBackendClient, effectiveSelection } from './client.mjs';

// Synthetic Fetch/HTTP fixtures only. No hosted service, real account or grants.
const NOW = Date.parse('2030-01-01T12:00:00Z');
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACCOUNT = ID(1), A = ID(11), B = ID(12), C = ID(13), ALINE = ID(21), ERIC = ID(22), SNAP = ID(31), PREVIEW = ID(32), REQUEST = ID(41);
const revision = 'a'.repeat(64), expires = new Date(NOW + 300000).toISOString();
const key = (name) => `synthetic-operation-${name}`;
const clone = (value) => structuredClone(value);
const token = (subject = ACCOUNT, method = 'registered_face') => `${btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${btoa(JSON.stringify({ sub: subject, auth_method: method, exp: NOW / 1000 + 900 }))}.synthetic`;
const auth = (subject = ACCOUNT, method = 'registered_face') => ({ access_token: token(subject, method), refresh_token: 'synthetic-refresh-vector', expires_in: 900, roles: ['user'], account_id: subject, auth_method: method });
const DEVICE = ID(71), PROFILE = ID(81), CHALLENGE = ID(61), FACE_HANDLE = `lfh_${'H'.repeat(43)}`;
const faceChallenge = (purpose = 'login') => ({ protocol: 'lovelies-face-auth-v1', challenge_id: CHALLENGE,
  account_id: ACCOUNT, device_id: DEVICE, device_revision: revision, nonce: `lfn_${'N'.repeat(43)}`,
  purpose, profile_id: purpose === 'registration' ? null : PROFILE,
  profile_revision: purpose === 'registration' ? null : revision, model_id: purpose === 'registration' ? null : 'synthetic-model-v1',
  policy_version: 'synthetic-policy-v1', required_captures: purpose === 'registration' ? 3 : 1,
  poses: purpose === 'registration' ? ['front', 'left', 'right'] : ['front'],
  expires_at: new Date(NOW + 120000).toISOString(), maximum_capture_bytes: 8388608,
  ...(purpose === 'registration' ? { face_handle: FACE_HANDLE } : {}) });
const completed = () => ({ ...auth(), protocol: 'lovelies-face-auth-v1', status: 'authenticated', device_id: DEVICE,
  profile_id: PROFILE, profile_revision: revision, model_id: 'synthetic-model-v1' });
const syntheticSign = async () => new Uint8Array(64); // Wire fixture only; real runtime tests verify P256.
const jpeg = (index = 0) => new Uint8Array([255,216,255,224,index]);
const graph = {
  id: SNAP, source: 'personal', version: revision, expires_at: expires,
  assets: [A, B, C].map((id) => ({ id, version: revision })),
  recipients: [{ id: ALINE, name: 'Aline' }, { id: ERIC, name: 'Eric' }],
  pairs: [[A, ALINE], [B, ALINE], [B, ERIC], [C, ERIC]].map(([asset_id, recipient_id]) => ({ asset_id, recipient_id, version: revision })),
  scope: { asset_limit: 100, recipient_limit: 100, pair_limit: 1000, has_more: false, selection_limited: false },
};
const draft = { version: 2, selectedAssetIds: [A, B], selectedRecipientIds: [ALINE, ERIC], excludedPairs: [{ asset_id: B, recipient_id: ERIC }] };
const view = {
  id: PREVIEW, source: 'personal', version: revision, draft_version: 2, expires_at: expires,
  pairs: [{ asset_id: A, recipient_id: ALINE }, { asset_id: B, recipient_id: ALINE }],
  recipients: [{ recipient_id: ALINE, asset_ids: [A, B], photo_count: 2 }],
  totals: { photos: 2, recipients: 1, pairs: 2 },
};
const outcome = (operation_key) => ({ protocol: 'reviewed-sharing-v1', source: 'personal', status: 'pending_acceptance', operation_key, preview_id: PREVIEW, totals: clone(view.totals), grants_created: 0,
  recipients: [{ recipient_id: ALINE, request_id: REQUEST, asset_ids: [A, B], photo_count: 2, status: 'requested', available_count: 0 }] });
function fixture(overrides = {}, options = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const path = new URL(url).pathname, body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    const action = body?.action, payload = body?.payload;
    calls.push({ path, method: init.method, body, headers: init.headers, signal: init.signal, cache: init.cache, credentials: init.credentials, redirect: init.redirect });
    if (overrides[action ?? path]) return overrides[action ?? path]({ path, body, payload, init, calls });
    if (path === '/auth/anonymous') return Response.json(auth(ACCOUNT, 'anonymous'));
    if (path === '/auth/face/challenge') return Response.json(faceChallenge());
    if (path === '/auth/face/registration/challenge') return Response.json(faceChallenge('registration'));
    if (path.startsWith('/auth/face/proof/')) return Response.json({ protocol: 'lovelies-face-auth-v1', status: 'capture_received', challenge_id: CHALLENGE,
      capture_index: Number(path.split('/').at(-1)), capture_sha256: init.headers['x-lovelies-capture-sha256'], byte_size: Number(init.headers['x-lovelies-capture-bytes']) });
    if (path === '/auth/face/complete' || path === '/auth/face/registration/complete') return Response.json(completed());
    if (path === '/auth/session/refresh') return Response.json(auth());
    if (path === '/auth/logout') return Response.json({ status: 'logged_out' });
    if (path === '/me') {
      const anonymous = init.headers.authorization === `Bearer ${token(ACCOUNT, 'anonymous')}`;
      return Response.json({ user_id: ACCOUNT, roles: ['user'], auth_method: anonymous ? 'anonymous' : 'registered_face', authenticated: !anonymous, profile_scope: anonymous ? 'anonymous_enrollment' : 'registered_face_profile' });
    }
    if (action === 'sharing.snapshot') return Response.json({ protocol: 'reviewed-sharing-v1', status: 'ready', snapshot: clone(graph) });
    if (action === 'sharing.preview') return Response.json({ protocol: 'reviewed-sharing-v1', status: 'ready', preview: clone(view) });
    if (action === 'sharing.commit') return Response.json(outcome(payload.operation_key));
    if (action === 'operation') return Response.json({ status: 'unknown' });
    throw new Error('Unhandled synthetic route');
  };
  return { calls, client: new LoveliesBackendClient({ baseUrl: 'https://lovelies.api.ikanisa.com', fetch, now: () => NOW, ...options }) };
}
const login = async (client) => {
  const challenge = await client.startFaceLogin({ faceHandle: FACE_HANDLE, deviceId: DEVICE, accountId: ACCOUNT });
  await client.uploadFaceCapture(challenge, { bytes: jpeg(), mime: 'image/jpeg', index: 0, sign: syntheticSign });
  return client.completeFaceLogin(challenge, { sign: syntheticSign });
};
test('Supabase Edge API retains its exact function prefix for anonymous authentication', async () => {
  const calls = [];
  const client = new LoveliesBackendClient({
    baseUrl: 'https://ltqfplqevxztlswlzexn.supabase.co/functions/v1/lovelies-api/', now: () => NOW,
    fetch: async (url, init) => { calls.push({url,init}); return Response.json(auth(ACCOUNT,'anonymous')); },
  });
  assert.equal((await client.startAnonymous()).accountId, ACCOUNT);
  assert.equal(calls[0].url,'https://ltqfplqevxztlswlzexn.supabase.co/functions/v1/lovelies-api/auth/anonymous');
  assert.equal(calls[0].init.redirect,'error');
  assert.equal(calls[0].init.credentials,'omit');
});
test('API location rejects credentials, queries, fragments and arbitrary function paths', () => {
  for (const url of ['https://u:p@example.com/functions/v1/lovelies-api','https://example.com/functions/v1/lovelies-api?key=value',
    'https://example.com/functions/v1/lovelies-api#path','https://example.com/functions/v1/other','https://example.com/functions/v1/lovelies-api/escape',
    'https://example.com/functions/v1/%6covelies-api','http://example.com/functions/v1/lovelies-api']) {
    assert.throws(()=>new LoveliesBackendClient({baseUrl:url}),{code:'invalid_api_origin'});
  }
});
async function review(client) {
  await login(client);
  const snapshot = await client.snapshot({ assetIds: [A, B, C], operationKey: key('snapshot') });
  const preview = await client.preparePreview(snapshot, draft, { operationKey: key('preview') });
  return { snapshot, preview };
}

test('fresh-face/current/refresh/logout use actual routes and expose no credentials or requested role authority', async () => {
  const { client, calls } = fixture();
  const { session } = await login(client);
  assert.deepEqual(session.roles, ['user']);
  assert.equal(session.accountId, ACCOUNT);
  assert.ok(!JSON.stringify(session).includes('synthetic-refresh'));
  assert.equal(await client.current().then((r) => r.user_id), ACCOUNT);
  await client.refresh(); await client.logout();
  assert.equal(client.session, null);
  assert.deepEqual(calls.map((c) => c.path), ['/auth/face/challenge', `/auth/face/proof/${CHALLENGE}/0`, '/auth/face/complete', '/me', '/auth/session/refresh', '/auth/logout']);
  assert.deepEqual(calls[0].body, { face_handle: FACE_HANDLE, device_id: DEVICE });
  assert.deepEqual(calls[4].body, { refresh_token: 'synthetic-refresh-vector' });
  assert.equal(calls[3].headers.authorization, `Bearer ${token()}`);
  assert.ok(calls.every((c) => c.credentials === 'omit' && c.cache === 'no-store' && c.redirect === 'error'));
});

test('wrong current account and changed refresh subject are refused', async () => {
  const f = fixture({ '/me': () => Response.json({ user_id: ID(2), roles: ['user'], profile_scope: 'registered_face_profile' }), '/auth/session/refresh': () => Response.json(auth(ID(2))) });
  await login(f.client);
  await assert.rejects(f.client.current(), { code: 'account_scope_invalid' });
  await assert.rejects(f.client.refresh(), { code: 'account_scope_invalid' });
  assert.equal(f.client.session, null);
});

test('late anonymous bootstrap after logout cannot repopulate a session', async () => {
  let release;
  const f = fixture({ '/auth/anonymous': () => new Promise((resolve) => { release = resolve; }) });
  const running = f.client.startAnonymous(); f.client.clearSession(); release(Response.json(auth(ACCOUNT, 'anonymous')));
  await assert.rejects(running, { code: 'session_changed' }); assert.equal(f.client.session, null);
});

test('gallery metadata response after account/logout change is fenced', async () => {
  let release;
  const f = fixture({ '/me/gallery': () => new Promise((resolve) => { release = resolve; }) });
  await login(f.client); const running = f.client.gallery(); f.client.clearSession();
  release(Response.json({ capabilities: { view_matched_photos: true, download_photos: false }, gallery_items: [] }));
  await assert.rejects(running, { code: 'session_changed' });
});

test('exact sparse graph preview/commit never creates photo-person Cartesian pairs', async () => {
  const f = fixture(), { snapshot, preview } = await review(f.client);
  assert.deepEqual(effectiveSelection(snapshot, draft), view.pairs);
  const result = await f.client.commit(preview, { draft, operationKey: key('commit') });
  assert.equal(result.status, 'pending_acceptance'); assert.equal(result.grants_created, 0);
  assert.deepEqual(result.recipients[0].asset_ids, [A, B]);
  const writes = f.calls.filter((c) => c.body?.action === 'sharing.preview' || c.body?.action === 'sharing.commit');
  assert.deepEqual(writes[0].body.payload, { snapshot_id: SNAP, snapshot_version: revision, draft_version: 2, selected_asset_ids: [A, B], selected_recipient_ids: [ALINE, ERIC], excluded_pairs: [{ asset_id: B, recipient_id: ERIC }], operation_key: key('preview') });
  assert.deepEqual(writes[1].body.payload, { preview_id: PREVIEW, preview_version: revision, draft_version: 2, operation_key: key('commit') });
  assert.equal(f.client.pendingOperations.length, 0);
});

test('retired sources and preview modes are rejected before network or operation preparation', async () => {
  const f = fixture();
  await login(f.client);
  const before = f.calls.length;
  await assert.rejects(f.client.snapshot({ source: 'professional', uploadBatchId: ID(51), operationKey: key('retired-snapshot') }), { code: 'invalid_source' });
  await assert.rejects(f.client.preview(A, { professional: true }), { code: 'invalid_source' });
  await assert.rejects(f.client.receipt(REQUEST, { source: 'professional' }), { code: 'invalid_source' });
  await assert.rejects(f.client.decideRequest(REQUEST, 'accept', { source: 'professional', operationKey: key('retired-decision') }), { code: 'invalid_source' });
  await assert.rejects(f.client.operation(key('retired-lookup'), { source: 'professional' }), { code: 'invalid_source' });
  assert.equal(f.calls.length, before);
  assert.equal(f.client.pendingOperations.length, 0);
});

test('personal upload batch remains bound through review without a source authority override', async () => {
  const f = fixture({ 'sharing.snapshot': () => Response.json({ protocol: 'reviewed-sharing-v1', status: 'ready', snapshot: { ...clone(graph), upload_batch_id: ID(51) } }) });
  await login(f.client);
  const snap = await f.client.snapshot({ uploadBatchId: ID(51), operationKey: key('batch-snapshot') });
  const pv = await f.client.preparePreview(snap, draft, { operationKey: key('batch-preview') });
  await f.client.commit(pv, { draft, operationKey: key('batch-commit') });
  assert.deepEqual(f.calls.find((c) => c.body?.action === 'sharing.snapshot').body.payload, { upload_batch_id: ID(51), operation_key: key('batch-snapshot') });
  assert.ok(!('source' in f.calls.find((c) => c.body?.action === 'sharing.commit').body.payload));
});

for (const [name, mutate] of [
  ['missing scope', (g) => { delete g.scope; }],
  ['missing source', (g) => { delete g.source; }],
  ['wrong source', (g) => { g.source = 'professional'; }],
  ['wrong asset source', (g) => { g.assets[0].media_source = 'professional'; }],
  ['wrong photo scope', (g) => { g.assets[0].id = ID(99); }],
  ['unknown edge', (g) => { g.pairs[0].recipient_id = ID(99); }],
  ['invalid bounded flag', (g) => { g.scope.has_more = 'false'; }],
]) test(`snapshot rejects ${name}, retaining uncertain write key`, async () => {
  const g = clone(graph); mutate(g);
  const f = fixture({ 'sharing.snapshot': () => Response.json({ protocol: 'reviewed-sharing-v1', status: 'ready', snapshot: g }) });
  await login(f.client); const op = key(name);
  await assert.rejects(f.client.snapshot({ assetIds: [A, B, C], operationKey: op }), (error) => error.ambiguous && error.operationKey === op);
  assert.equal(f.client.pendingOperations[0].operationKey, op);
});

test('personal upload snapshot rejects a missing or different batch', async () => {
  for (const variant of [{ ...clone(graph) }, { ...clone(graph), upload_batch_id: ID(52) }]) {
    const f = fixture({ 'sharing.snapshot': () => Response.json({ protocol: 'reviewed-sharing-v1', status: 'ready', snapshot: variant }) });
    await login(f.client);
    await assert.rejects(f.client.snapshot({ uploadBatchId: ID(51), operationKey: key('wrong-batch') }), { code: 'snapshot_scope_invalid', ambiguous: true });
  }
});

test('retired photographer credentials cannot install a session', async () => {
  const f = fixture({ '/auth/face/complete': () => Response.json({ ...completed(), roles: ['user', 'photographer'] }) });
  await assert.rejects(login(f.client), { code: 'auth_response_invalid' });
  assert.equal(f.client.session, null);
});

test('retired asset source in a photo response is not accepted as personal media', async () => {
  const f = fixture({ photos: () => Response.json({ items: [{ id: A, source: 'received', media_source: 'professional' }] }) });
  await login(f.client);
  await assert.rejects(f.client.photos(), { code: 'source_mismatch' });
});

for (const stage of ['sharing.preview', 'sharing.commit']) test(`personal review rejects a retired source returned by ${stage}`, async () => {
  const f = fixture({ [stage]: ({ payload }) => Response.json(stage === 'sharing.preview'
    ? { protocol: 'reviewed-sharing-v1', status: 'ready', preview: { ...clone(view), source: 'professional' } }
    : { ...outcome(payload.operation_key), source: 'professional' }) });
  await login(f.client);
  const snap = await f.client.snapshot({ operationKey: key('source-snapshot') });
  if (stage === 'sharing.preview') await assert.rejects(f.client.preparePreview(snap, draft, { operationKey: key('source-preview') }), { code: 'source_mismatch', ambiguous: true });
  else {
    const pv = await f.client.preparePreview(snap, draft, { operationKey: key('source-preview') });
    await assert.rejects(f.client.commit(pv, { draft, operationKey: key('source-commit') }), { code: 'source_mismatch', ambiguous: true });
  }
});

test('preview rejects fabricated per-recipient subsets and leaves no committable handle', async () => {
  const forged = { ...clone(view), recipients: [{ recipient_id: ERIC, asset_ids: [A, B], photo_count: 2 }] };
  const f = fixture({ 'sharing.preview': () => Response.json({ protocol: 'reviewed-sharing-v1', status: 'ready', preview: forged }) });
  await login(f.client); const snap = await f.client.snapshot({ operationKey: key('snapshot') });
  await assert.rejects(f.client.preparePreview(snap, draft, { operationKey: key('forged-preview') }), { code: 'manifest_invalid', ambiguous: true });
  await assert.rejects(f.client.commit(forged, { draft, operationKey: key('forged-commit') }), { code: 'review_handle_invalid' });
  assert.equal(f.calls.filter((c) => c.body?.action === 'sharing.commit').length, 0);
});

test('changed local selection or empty effective graph cannot commit an old preview', async () => {
  const f = fixture(), { preview } = await review(f.client);
  await assert.rejects(f.client.commit(preview, { draft: { ...draft, selectedAssetIds: [] }, operationKey: key('empty-commit') }), { code: 'review_selection_changed' });
  await assert.rejects(f.client.commit(preview, { draft: { ...draft, version: 3 }, operationKey: key('stale-commit') }), { code: 'review_selection_changed' });
  assert.equal(f.calls.filter((c) => c.body?.action === 'sharing.commit').length, 0);
});

test('timeout with abort-ignoring transport retains original key; retry reconciles then replays exact payload once', async () => {
  let attempt = 0;
  const f = fixture({ 'sharing.commit': ({ payload }) => ++attempt === 1 ? new Promise(() => {}) : Response.json(outcome(payload.operation_key)) }, { timeoutMs: 25 });
  const { preview } = await review(f.client), op = key('timeout');
  await assert.rejects(f.client.commit(preview, { draft, operationKey: op }), { code: 'request_timeout', operationKey: op, ambiguous: true });
  await assert.rejects(f.client.snapshot({ operationKey: key('replacement') }), { code: 'reconcile_required' });
  await f.client.retry(op);
  const writes = f.calls.filter((c) => c.body?.action === 'sharing.commit');
  assert.equal(writes.length, 2); assert.deepEqual(writes[0].body, writes[1].body);
  assert.equal(f.calls.at(-2).body.action, 'operation');
});

test('HTTP denial stays definite even if its error body is too large, and no automatic replay occurs', async () => {
  const f = fixture({ 'sharing.commit': () => new Response('x'.repeat(1000), { status: 403, headers: { 'content-length': '3000000' } }) });
  const { preview } = await review(f.client);
  await assert.rejects(f.client.commit(preview, { draft, operationKey: key('denied') }), { status: 403, ambiguous: false });
  assert.equal(f.client.pendingOperations.length, 0);
  assert.equal(f.calls.filter((c) => c.body?.action === 'sharing.commit').length, 1);
});

test('confirmed partial acceptance retry only re-queries, preserving approved subsets', async () => {
  const op = key('partial'), partial = { ...outcome(op), status: 'partial', recipients: [{ ...outcome(op).recipients[0], status: 'accepted', available_count: 1 }] };
  const f = fixture({ operation: () => Response.json(partial) });
  const { preview } = await review(f.client);
  await f.client.commit(preview, { draft, operationKey: op });
  assert.equal((await f.client.retry(op)).status, 'partial');
  assert.equal(f.calls.filter((c) => c.body?.action === 'sharing.commit').length, 1);
});

test('pre-dispatch durability callback failure sends no write and retains token-free intent', async () => {
  const intents = [], f = fixture({}, { onOperationPrepared: async (intent) => { intents.push(intent); throw new Error('Synthetic metadata write failed'); } });
  await login(f.client);
  await assert.rejects(f.client.snapshot({ operationKey: key('durability') }), { ambiguous: true });
  assert.equal(f.calls.filter((c) => c.path === '/community/action').length, 0);
  assert.equal(intents[0].accountId, ACCOUNT); assert.ok(!JSON.stringify(intents).includes('synthetic-refresh'));
});

test('protected preview verifies actual IDs before media and never requests originals', async () => {
  const f = fixture({ 'photos.validate': ({ payload }) => { assert.deepEqual(payload, { asset_ids: [A] }); return Response.json({ authorized_ids: [A] }); }, [`/community/media/${A}/preview`]: () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } }) });
  await login(f.client); const value = await f.client.preview(A);
  assert.deepEqual(value.bytes, new Uint8Array([1, 2, 3]));
  assert.ok(f.calls.every((c) => !c.path.endsWith('/original')));
  assert.equal(f.calls.at(-1).headers.authorization, `Bearer ${token()}`);
});

test('unverified preview authorization refuses bytes and body streaming obeys size bound', async () => {
  const f = fixture({ 'photos.validate': () => Response.json({ authorized_ids: [] }) });
  await login(f.client); await assert.rejects(f.client.preview(A), { code: 'preview_access_unverified' });
  assert.ok(!f.calls.some((c) => c.path.startsWith('/community/media/')));
  const large = fixture({ '/me': () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(2049))); controller.close(); } }), { headers: { 'content-type': 'application/json' } }) }, { maxJsonBytes: 2048 });
  await login(large.client); await assert.rejects(large.client.current(), { code: 'response_too_large' });
});

test('recipient receipt keeps pending media empty; explicit decision uses server request ID and stable key', async () => {
  const receipt = { id: REQUEST, source: 'personal', sender: false, person: { id: ALINE, name: 'Aline' }, status: 'requested', photo_count: 2, available_count: 0, asset_ids: [] };
  const f = fixture({ receipt: () => Response.json(receipt), 'request.decide': ({ payload }) => Response.json({ source: 'personal', request_id: payload.request_id, status: 'accepted' }) });
  await login(f.client); assert.deepEqual((await f.client.receipt(REQUEST)).asset_ids, []);
  await f.client.decideRequest(REQUEST, 'accept', { operationKey: key('accept') });
  assert.deepEqual(f.calls.at(-1).body, { action: 'request.decide', payload: { request_id: REQUEST, decision: 'accept', operation_key: key('accept') } });
});

test('real Fetch over loopback HTTP preserves authorization and actual route contract', async (t) => {
  const seen = [];
  const server = createServer(async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk;
    seen.push({ path: req.url, authorization: req.headers.authorization, body: data ? JSON.parse(data) : null });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/auth/anonymous') res.end(JSON.stringify(auth(ACCOUNT, 'anonymous')));
    else if (req.url === '/me') res.end(JSON.stringify({ user_id: ACCOUNT, roles: ['user'], auth_method: 'anonymous', authenticated: false, profile_scope: 'anonymous_enrollment' }));
    else { res.statusCode = 404; res.end(JSON.stringify({ error: { code: 'synthetic_unavailable' } })); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const client = new LoveliesBackendClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, now: () => NOW });
  await client.startAnonymous(); await client.current();
  assert.equal(seen[1].authorization, `Bearer ${token(ACCOUNT, 'anonymous')}`);
  assert.deepEqual(seen[0].body, {});
});

test('anonymous account is enrollment-only; qualified completion automatically upgrades the same account', async () => {
  const f = fixture(), anonymous = await f.client.startAnonymous();
  assert.equal(anonymous.authenticated, false);
  assert.equal((await f.client.current()).profile_scope, 'anonymous_enrollment');
  await assert.rejects(f.client.gallery(), { code: 'registered_face_required' });
  await assert.rejects(f.client.snapshot({ operationKey: key('anonymous') }), { code: 'registered_face_required' });
  assert.equal(f.calls.filter(call => call.path === '/community/action').length, 0);
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const challenge = await f.client.startFaceRegistration({ devicePublicJwk: await crypto.subtle.exportKey('jwk', keys.publicKey), policyVersion: 'synthetic-policy-v1' });
  const signatures = [];
  const sign = async bytes => {
    signatures.push(new TextDecoder().decode(bytes));
    return new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, bytes));
  };
  for (let index = 0; index < 3; index++) await f.client.uploadFaceCapture(challenge, { bytes: jpeg(index), mime: 'image/jpeg', index, sign });
  const result = await f.client.completeFaceRegistration(challenge, { sign });
  assert.equal(result.session.authenticated, true); assert.equal(result.session.accountId, anonymous.accountId);
  assert.equal(result.registeredFace.faceHandle, FACE_HANDLE);
  assert.equal(JSON.parse(signatures[3]).capture_manifest.length, 3);
  for (let index = 0; index < 3; index++) assert.equal(JSON.parse(signatures[index]).capture_index, index);
  assert.deepEqual(f.calls.find(call => call.path === '/auth/face/registration/challenge').body.consent,
    { purpose: 'face_authentication', policy_version: 'synthetic-policy-v1', granted: true });
  assert.ok(f.calls.every(call => !call.path.includes('/otp/')));
  assert.equal(typeof f.client.verifyOtp, 'undefined'); assert.equal(typeof f.client.startOtp, 'undefined');
  assert.ok(!JSON.stringify(result).includes('synthetic-refresh'));
});

test('first-registration capture count, duplicate capture and private-device key are enforced before dispatch', async () => {
  const f = fixture(); await f.client.startAnonymous();
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicJwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  await assert.rejects(f.client.startFaceRegistration({ devicePublicJwk: { ...publicJwk, d: 'private' }, policyVersion: 'synthetic-policy-v1' }), { code: 'device_key_invalid' });
  const challenge = await f.client.startFaceRegistration({ devicePublicJwk: publicJwk, policyVersion: 'synthetic-policy-v1' });
  await f.client.uploadFaceCapture(challenge, { bytes: jpeg(), mime: 'image/jpeg', index: 0, sign: syntheticSign });
  await assert.rejects(f.client.uploadFaceCapture(challenge, { bytes: jpeg(), mime: 'image/jpeg', index: 1, sign: syntheticSign }), { code: 'face_capture_reused' });
  await assert.rejects(f.client.completeFaceRegistration(challenge, { sign: syntheticSign }), { code: 'face_captures_incomplete' });
  assert.equal(f.calls.filter(call => call.path === '/auth/face/registration/complete').length, 0);
});

test('late face-completion response after local logout cannot authenticate or recover credentials', async () => {
  let release;
  const f = fixture({ '/auth/face/complete': () => new Promise(resolve => { release = resolve; }) });
  const challenge = await f.client.startFaceLogin({ faceHandle: FACE_HANDLE, deviceId: DEVICE });
  await f.client.uploadFaceCapture(challenge, { bytes: jpeg(), mime: 'image/jpeg', index: 0, sign: syntheticSign });
  const running = f.client.completeFaceLogin(challenge, { sign: syntheticSign });
  await Promise.resolve(); f.client.clearSession(); release(Response.json(completed()));
  await assert.rejects(running, { code: 'session_changed' }); assert.equal(f.client.session, null);
});

test('logout while device signing fences capture bytes and sends no upload', async () => {
  let release;
  const f = fixture(); const challenge = await f.client.startFaceLogin({ faceHandle: FACE_HANDLE, deviceId: DEVICE });
  const reached = new Promise(resolve => {
    release = { resolve };
  });
  let resolveSignature;
  const running = f.client.uploadFaceCapture(challenge, { bytes: jpeg(), mime: 'image/jpeg', index: 0,
    sign: () => { release.resolve(); return new Promise(resolve => { resolveSignature = resolve; }); } });
  await reached; f.client.clearSession(); resolveSignature(new Uint8Array(64));
  await assert.rejects(running, { code: 'session_changed' });
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
});

test('face response cannot change the existing reference or account, and missing verifier remains unavailable', async () => {
  const f = fixture({ '/auth/face/complete': () => Response.json({ ...completed(), profile_id: ID(999) }) });
  await assert.rejects(login(f.client), { code: 'registered_reference_changed' }); assert.equal(f.client.session, null);
  const missing = fixture({ '/auth/face/registration/challenge': () => Response.json({ error: { code: 'face_authentication_unavailable' } }, { status: 503 }) });
  await missing.client.startAnonymous();
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  await assert.rejects(missing.client.startFaceRegistration({ devicePublicJwk: await crypto.subtle.exportKey('jwk', keys.publicKey), policyVersion: 'synthetic-policy-v1' }), { status: 503 });
  assert.equal(missing.client.session.authenticated, false);
});
