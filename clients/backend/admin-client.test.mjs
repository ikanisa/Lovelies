import test from 'node:test';
import assert from 'node:assert/strict';
import { LoveliesBackendClient } from './client.mjs';

// Controlled Fetch protocol fixtures only: these do not establish hosted access,
// a browser camera/device key, real biometrics or a production admin account.
const NOW = Date.parse('2030-01-01T12:00:00Z');
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACCOUNT = id(1), SUBJECT = id(2), SESSION = id(3), DEVICE = id(4), PROFILE = id(5), CHALLENGE = id(6);
const HANDLE = `lfh_${'H'.repeat(43)}`, REVISION = 'a'.repeat(64), KEY = 'admin-revoke-fixture-1';
const user = (overrides = {}) => ({ id: SUBJECT, name: 'Aline', identity_state: 'registered_face', status: 'active', matching_status: 'active', roles: ['user'],
  created_at: NOW - 86400000, active_sessions: 1, open_support: 1, open_reports: 1, pending_privacy: 1, ...overrides });
const detail = () => ({ user: user(), sessions: [{ id: SESSION, auth_method: 'registered_face', created_at: NOW, expires_at: NOW + 900000, status: 'active' }],
  cases: { support: [{ id: id(11), subject: 'Cannot see my photo', status: 'open', category: 'general_support', created_at: NOW, updated_at: NOW }],
    safety: [{ id: id(12), status: 'under_review', outcome: null, created_at: NOW, reviewed_at: null, relation: 'reporter' }],
    privacy: [{ id: id(13), request_type: 'export', status: 'queued', created_at: NOW, reviewed_at: NOW, completed_at: null, failure_code: null }] },
  history: [{ id: id(14), action: 'support.created', created_at: NOW }], limits: { sessions: 50, cases_per_kind: 20, history: 30 },
  has_more: { sessions: false, support: false, safety: false, privacy: false, history: false } });
const revoke = () => ({ account_id: SUBJECT, session_id: SESSION, status: 'revoked', sessions_revoked: 1, account_disabled: false });
function fixture({ adminRoles = ['user', 'admin'], handler, now = () => NOW } = {}) {
  const calls = [];
  const credentials = (method = 'registered_face') => ({ access_token: `fixture.${btoa(JSON.stringify({ sub: ACCOUNT, auth_method: method, exp: NOW / 1000 + 900 }))}.signature`,
    refresh_token: 'fixture-refresh', account_id: ACCOUNT, auth_method: method, expires_in: 900, roles: method === 'anonymous' ? ['user'] : adminRoles });
  const fetch = async (raw, init) => {
    const url = new URL(raw), path = url.pathname, body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ url, path, body, init });
    if (path === '/auth/anonymous') return Response.json(credentials('anonymous'));
    if (path === '/auth/face/challenge') return Response.json({ protocol: 'lovelies-face-auth-v1', challenge_id: CHALLENGE, account_id: ACCOUNT,
      device_id: DEVICE, device_revision: REVISION, nonce: `lfn_${'N'.repeat(43)}`, purpose: 'login', profile_id: PROFILE, profile_revision: REVISION,
      model_id: 'fixture-model', policy_version: 'fixture-policy', required_captures: 1, poses: ['front'], expires_at: new Date(NOW + 120000).toISOString(), maximum_capture_bytes: 8388608 });
    if (path.startsWith('/auth/face/proof/')) return Response.json({ protocol: 'lovelies-face-auth-v1', status: 'capture_received', challenge_id: CHALLENGE,
      capture_index: 0, capture_sha256: init.headers['x-lovelies-capture-sha256'], byte_size: Number(init.headers['x-lovelies-capture-bytes']) });
    if (path === '/auth/face/complete') return Response.json({ ...credentials(), protocol: 'lovelies-face-auth-v1', status: 'authenticated',
      device_id: DEVICE, profile_id: PROFILE, profile_revision: REVISION, model_id: 'fixture-model' });
    if (path === '/auth/logout') return Response.json({ status: 'logged_out' });
    if (handler) return handler({ url, path, body, init, calls });
    if (path === '/admin/users') return Response.json({ users: [user()], page: { limit: Number(url.searchParams.get('limit')), has_more: false, next_cursor: null } });
    if (path === `/admin/users/${SUBJECT}`) return Response.json(detail());
    if (path === `/admin/users/${SUBJECT}/sessions/revoke`) return Response.json(revoke());
    throw new Error('Unexpected fixture route');
  };
  return { calls, client: new LoveliesBackendClient({ baseUrl: 'https://fixture.invalid', fetch, now }) };
}
async function login(client) {
  const sign = async () => new Uint8Array(64); // Signature shape only; backend tests verify actual P256.
  const challenge = await client.startFaceLogin({ faceHandle: HANDLE, deviceId: DEVICE, accountId: ACCOUNT });
  await client.uploadFaceCapture(challenge, { bytes: new Uint8Array([255, 216, 255, 224]), mime: 'image/jpeg', index: 0, sign });
  await client.completeFaceLogin(challenge, { sign });
}

test('admin methods reject absent, anonymous, non-admin and expired sessions before transport', async () => {
  const f = fixture();
  const methods = () => [() => f.client.adminUsers(), () => f.client.adminUser(SUBJECT), () => f.client.revokeAdminUserSession(SUBJECT, SESSION, { reason: 'User reported a lost device', operationKey: KEY })];
  for (const method of methods()) await assert.rejects(method(), { code: 'authentication_required' });
  assert.equal(f.calls.length, 0);
  await f.client.startAnonymous(); const before = f.calls.length;
  for (const method of methods()) await assert.rejects(method(), { code: 'registered_face_required' });
  assert.equal(f.calls.length, before);
  const ordinary = fixture({ adminRoles: ['user'] }); await login(ordinary.client);
  await assert.rejects(ordinary.client.adminUsers(), { code: 'admin_required' }); assert.equal(ordinary.calls.length, 3);
  let now = NOW; const expired = fixture({ now: () => now }); await login(expired.client); now += 900001;
  await assert.rejects(expired.client.adminUsers(), { code: 'session_expired' }); assert.equal(expired.calls.length, 3);
});

test('users query and detail use authenticated bounded routes with immutable safe projections', async () => {
  const f = fixture(); await login(f.client);
  const list = await f.client.adminUsers({ query: 'Aline & photos', status: 'registered', limit: 10, cursor: 'opaque-cursor' });
  const call = f.calls.at(-1);
  assert.deepEqual(Object.fromEntries(call.url.searchParams), { q: 'Aline & photos', status: 'registered', limit: '10', cursor: 'opaque-cursor' });
  assert.equal(call.init.method, 'GET'); assert.match(call.init.headers.authorization, /^Bearer /);
  assert.equal(call.init.cache, 'no-store'); assert.equal(call.init.credentials, 'omit'); assert.equal(call.init.redirect, 'error');
  assert.ok(Object.isFrozen(list.users[0]));
  const result = await f.client.adminUser(SUBJECT);
  assert.deepEqual(result, detail()); assert.ok(Object.isFrozen(result.cases.support[0]));
  assert.equal(f.calls.at(-1).path, `/admin/users/${SUBJECT}`);
});

test('unknown private fields never pass through admin metadata projections', async () => {
  const data = detail(); data.user.face_handle = 'private'; data.sessions[0].refresh_hash = 'private'; data.cases.support[0].details = 'private'; data.history[0].details_json = 'private';
  data.cases.support[0].subject = 'First line\nSecond\tline';
  const f = fixture({ handler: ({ path }) => Response.json(path === '/admin/users' ? { users: [data.user], page: { limit: 25, has_more: false, next_cursor: null }, token: 'private' } : data) });
  await login(f.client);
  assert.ok(!JSON.stringify(await f.client.adminUsers()).includes('private'));
  const result = await f.client.adminUser(SUBJECT);
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.equal(result.cases.support[0].subject, data.cases.support[0].subject);
});

test('all includes deleted accounts while filtered lists retain their declared scope', async () => {
  const f = fixture({ handler: ({ url }) => Response.json({ users: [user({ status: 'deleted' })], page: { limit: Number(url.searchParams.get('limit')), has_more: false, next_cursor: null } }) });
  await login(f.client);
  assert.equal((await f.client.adminUsers()).users[0].status, 'deleted');
  assert.equal((await f.client.adminUsers({ status: 'deleted' })).users[0].status, 'deleted');
  await assert.rejects(f.client.adminUsers({ status: 'registered' }), { code: 'admin_response_invalid' });
});

test('erased account tombstones allow empty roles in lists and details, active accounts do not', async () => {
  for (const identity_state of ['anonymous', 'registered_face']) {
    const tombstone = user({ name: '', roles: [], status: 'deleted', identity_state, matching_status: 'absent', active_sessions: 0 });
    const value = { ...detail(), user: tombstone, sessions: [], cases: { support: [], safety: [], privacy: [] }, history: [] };
    const f = fixture({ handler: ({ path }) => Response.json(path === '/admin/users' ? { users: [tombstone], page: { limit: 25, has_more: false, next_cursor: null } } : value) });
    await login(f.client);
    assert.deepEqual((await f.client.adminUsers({ status: 'deleted' })).users[0].roles, []);
    assert.deepEqual((await f.client.adminUser(SUBJECT)).user.roles, []);
  }
  const f = fixture({ handler: () => Response.json({ users: [user({ roles: [] })], page: { limit: 25, has_more: false, next_cursor: null } }) });
  await login(f.client); await assert.rejects(f.client.adminUsers(), { code: 'auth_response_invalid' });
});

test('matching status preserves consent-aware states and never infers a missing or unknown value', async () => {
  for (const matching_status of ['active', 'paused', 'absent', null]) {
    const summary = user({ matching_status }), value = { ...detail(), user: summary };
    const f = fixture({ handler: ({ path }) => Response.json(path === '/admin/users' ? { users: [summary], page: { limit: 25, has_more: false, next_cursor: null } } : value) });
    await login(f.client);
    assert.equal((await f.client.adminUsers()).users[0].matching_status, matching_status);
    assert.equal((await f.client.adminUser(SUBJECT)).user.matching_status, matching_status);
  }
  for (const matching_status of [undefined, 'enabled']) {
    const f = fixture({ handler: () => Response.json({ users: [user({ matching_status })], page: { limit: 25, has_more: false, next_cursor: null } }) });
    await login(f.client); await assert.rejects(f.client.adminUsers(), { code: 'admin_response_invalid' });
  }
});

test('invalid user queries, IDs and revoke inputs cannot send an admin request', async () => {
  const f = fixture(); await login(f.client); const before = f.calls.length;
  for (const input of [{ query: 'a'.repeat(101) }, { status: 'photographer' }, { limit: 0 }, { limit: 101 }, { cursor: 'x'.repeat(2049) }]) await assert.rejects(f.client.adminUsers(input));
  await assert.rejects(f.client.adminUser('../private'), { code: 'invalid_id' });
  for (const input of [{ reason: 'ok', operationKey: KEY }, { reason: 'Valid reason', operationKey: 'short' }, { reason: 'Valid reason', operationKey: 'invalid operation key' }]) await assert.rejects(f.client.revokeAdminUserSession(SUBJECT, SESSION, input));
  assert.equal(f.calls.length, before);
});

test('users reject duplicate identities, retired roles and contradictory pagination', async () => {
  for (const value of [
    { users: [user(), user()], page: { limit: 25, has_more: false, next_cursor: null } },
    { users: [user({ roles: ['user', 'photographer'] })], page: { limit: 25, has_more: false, next_cursor: null } },
    { users: [user()], page: { limit: 25, has_more: true, next_cursor: null } },
    { users: [user()], page: { limit: 100, has_more: false, next_cursor: null } },
  ]) {
    const f = fixture({ handler: () => Response.json(value) }); await login(f.client); await assert.rejects(f.client.adminUsers());
  }
});

test('detail rejects wrong account, malformed statuses and undeclared truncation', async () => {
  for (const mutate of [(v) => { v.user.id = id(99); }, (v) => { v.sessions[0].status = 'approved'; }, (v) => { delete v.has_more.privacy; }, (v) => { v.limits.sessions = 500; }]) {
    const value = detail(); mutate(value);
    const f = fixture({ handler: () => Response.json(value) }); await login(f.client); await assert.rejects(f.client.adminUser(SUBJECT));
  }
});

test('late admin response cannot publish after session retirement', async () => {
  let release; const f = fixture({ handler: () => new Promise((resolve) => { release = resolve; }) }); await login(f.client);
  const waiting = f.client.adminUser(SUBJECT); f.client.clearSession(); release(Response.json(detail()));
  await assert.rejects(waiting, { code: 'session_changed' }); assert.equal(f.client.session, null);
});

test('late revoke result cannot cross a retired administrator session', async () => {
  let release; const f = fixture({ handler: () => new Promise((resolve) => { release = resolve; }) }); await login(f.client);
  const waiting = f.client.revokeAdminUserSession(SUBJECT, SESSION, { reason: 'Valid reason', operationKey: KEY });
  f.client.clearSession(); release(Response.json(revoke()));
  await assert.rejects(waiting, { code: 'session_changed' }); assert.equal(f.client.session, null);
});

test('revoke binds account/session/reason/key without claiming account disablement', async () => {
  const f = fixture(); await login(f.client);
  const result = await f.client.revokeAdminUserSession(SUBJECT, SESSION, { reason: '  User reported a lost device  ', operationKey: KEY });
  assert.deepEqual(result, revoke()); assert.ok(Object.isFrozen(result));
  assert.equal(f.calls.at(-1).path, `/admin/users/${SUBJECT}/sessions/revoke`);
  assert.equal(f.calls.at(-1).init.method, 'POST');
  assert.deepEqual(f.calls.at(-1).body, { session_id: SESSION, reason: 'User reported a lost device', operation_key: KEY });
});

test('ambiguous revoke retains operation key for explicit same-payload retry and never retries itself', async () => {
  let attempts = 0;
  const f = fixture({ handler: () => { if (++attempts === 1) throw new Error('lost reply'); return Response.json(revoke()); } }); await login(f.client);
  const input = { reason: 'User reported a lost device', operationKey: KEY };
  await assert.rejects(f.client.revokeAdminUserSession(SUBJECT, SESSION, input), { code: 'network_unavailable', ambiguous: true, operationKey: KEY });
  assert.equal(attempts, 1);
  await f.client.revokeAdminUserSession(SUBJECT, SESSION, input);
  assert.deepEqual(f.calls.at(-1).body, f.calls.at(-2).body);
});

test('authoritative revoke denials stay definite; mismatched success remains unconfirmed', async () => {
  for (const code of ['fresh_face_authentication_required', 'independent_review_required']) {
    const f = fixture({ handler: () => Response.json({ error: { code } }, { status: 403 }) }); await login(f.client);
    await assert.rejects(f.client.revokeAdminUserSession(SUBJECT, SESSION, { reason: 'Valid reason', operationKey: KEY }), { code, status: 403, ambiguous: false });
  }
  const f = fixture({ handler: () => Response.json({ ...revoke(), session_id: id(99) }) }); await login(f.client);
  await assert.rejects(f.client.revokeAdminUserSession(SUBJECT, SESSION, { reason: 'Valid reason', operationKey: KEY }), { code: 'admin_response_invalid', ambiguous: true, operationKey: KEY });
});

test('a 401 clears the current admin session and subsequent reads cannot dispatch', async () => {
  const f = fixture({ handler: () => Response.json({ error: { code: 'session_invalid' } }, { status: 401 }) }); await login(f.client);
  await assert.rejects(f.client.adminUsers(), { code: 'session_invalid', status: 401 }); assert.equal(f.client.session, null);
  const before = f.calls.length; await assert.rejects(f.client.adminUser(SUBJECT), { code: 'authentication_required' }); assert.equal(f.calls.length, before);
});
