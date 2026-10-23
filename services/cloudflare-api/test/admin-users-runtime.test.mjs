import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { startHarness, enroll, captureProofs, faceVerifierFixture, closeHarnesses } from './runtime-harness.mjs';

after(closeHarnesses);
const operationKey = () => `admin-users-${crypto.randomUUID()}`;
const sessionId = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).jti;
async function login(h, person) {
  const challenge = await h.json('/auth/face/challenge', { body: { face_handle: person.faceHandle, device_id: person.deviceId } }, 201);
  const body = await captureProofs(h, challenge, person.keys.privateKey);
  const credentials = await h.json('/auth/face/complete', { body });
  return { ...person, ...credentials, token: credentials.access_token };
}
async function administrator(h) {
  const person = await enroll(h);
  await h.storage.exec('UPDATE accounts SET roles_json=? WHERE id=?', '["user","admin"]', person.accountId);
  return login(h, person);
}
const revoke = (h, admin, account, session, extra = {}, expected = 200) => h.json(`/admin/users/${account}/sessions/revoke`, {
  token: admin.token, body: { session_id: session, reason: 'Reported lost session', operation_key: operationKey(), ...extra },
}, expected);

test('user management requires current registered-face administrator authority for every route', async () => {
  const h = await startHarness({ faceVerifier: faceVerifierFixture, consumeQueue: false });
  try {
    const anonymous = await h.anonymous(), person = await enroll(h), admin = await administrator(h);
    const paths = ['/admin/users', `/admin/users/${person.accountId}`];
    for (const path of paths) {
      assert.equal((await h.json(path, {}, 401)).error.code, 'authentication_required');
      assert.equal((await h.json(path, { token: anonymous.access_token }, 403)).error.code, 'registered_face_required');
      assert.equal((await h.json(path, { token: person.token }, 403)).error.code, 'admin_required');
      await h.json(path, { token: admin.token });
    }
    await revoke(h, person, admin.accountId, sessionId(admin.token), {}, 403);
    await h.storage.exec('UPDATE accounts SET roles_json=? WHERE id=?', '["user"]', admin.accountId);
    await h.json('/admin/users', { token: admin.token }, 401);
    await h.json(`/admin/users/${person.accountId}`, { token: admin.token }, 401);
    await revoke(h, admin, person.accountId, sessionId(person.token), {}, 401);
    assert.equal((await h.storage.exec("SELECT count(*) n FROM audit_events WHERE action='admin.user.session.revoke'"))[0].n, 0);
  } finally { await h.close(); }
});

test('account search uses literal text and deterministic filter-bound pagination including deleted tombstones', async () => {
  const h = await startHarness({ faceVerifier: faceVerifierFixture, consumeQueue: false });
  try {
    const admin = await administrator(h), ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()].sort();
    for (const [index, id] of ids.entries()) await h.storage.exec(
      'INSERT INTO accounts(id,name,roles_json,identity_state,created_at) VALUES(?,?,?,?,?)',
      id, `Fixture ${index}`, '["user"]', 'anonymous', 1000);
    const deletedId = crypto.randomUUID(), literalId = crypto.randomUUID();
    await h.storage.exec("INSERT INTO accounts(id,name,roles_json,identity_state,created_at,disabled_at) VALUES(?,?,'[]','registered_face',900,1000)", deletedId, 'Erased private display name');
    await h.storage.exec("INSERT INTO accounts(id,name,roles_json,identity_state,created_at) VALUES(?,?,'[\"user\"]','anonymous',1000)", literalId, 'Literal %_\\ fixture');
    const first = await h.json('/admin/users?q=Fixture%20&status=anonymous&limit=2', { token: admin.token });
    // Trimming/case-insensitive matching also includes the literal fixture.
    assert.equal(first.users.length, 2); assert(first.page.has_more); assert(first.page.next_cursor);
    const second = await h.json(`/admin/users?q=Fixture&status=anonymous&limit=2&cursor=${first.page.next_cursor}`, { token: admin.token });
    assert.equal(second.users.length, 2); assert.equal(second.page.has_more, false); assert.equal(second.page.next_cursor, null);
    assert.equal(new Set([...first.users, ...second.users].map(row => row.id)).size, 4);
    assert.deepEqual([...first.users, ...second.users].map(row => row.id), [...ids, literalId].sort());
    const literal = await h.json('/admin/users?q=%25_', { token: admin.token });
    assert.deepEqual(literal.users.map(row => row.id), [literalId]);
    assert.equal((await h.json('/admin/users?q=Erased', { token: admin.token })).users.length, 0);
    const deleted = await h.json('/admin/users?status=deleted', { token: admin.token });
    assert.deepEqual(deleted.users.map(row => [row.id, row.name, row.roles, row.status, row.active_sessions]), [[deletedId, '', [], 'deleted', 0]]);
    assert((await h.json('/admin/users', { token: admin.token })).users.some(row => row.id === deletedId));
    const detail = await h.json(`/admin/users/${deletedId}`, { token: admin.token });
    assert.equal(detail.user.status, 'deleted'); assert.deepEqual(detail.user.roles, []);
    assert.deepEqual(detail.sessions, []);
    for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'status=suspended', 'q=a&q=b', 'unknown=x', `q=${'a'.repeat(101)}`, 'cursor=bad']) {
      await h.json(`/admin/users?${query}`, { token: admin.token }, 400);
    }
    await h.json(`/admin/users?q=Different&status=anonymous&limit=2&cursor=${first.page.next_cursor}`, { token: admin.token }, 400);
    await h.json(`/admin/users?q=Fixture&status=all&limit=2&cursor=${first.page.next_cursor}`, { token: admin.token }, 400);
    await h.json(`/admin/users?q=Fixture&status=anonymous&limit=1&cursor=${first.page.next_cursor}`, { token: admin.token }, 400);
  } finally { await h.close(); }
});

test('user detail returns bounded metadata, related cases and safe history without credentials or private media', async () => {
  const h = await startHarness({ faceVerifier: faceVerifierFixture, consumeQueue: false });
  try {
    const admin = await administrator(h), person = await enroll(h), other = await enroll(h);
    await h.storage.exec('UPDATE accounts SET name=?,roles_json=? WHERE id=?', 'Account fixture', '["user","photographer"]', person.accountId);
    const base = Date.now();
    for (let index = 0; index < 22; index++) await h.storage.exec(
      "INSERT INTO support_requests(id,account_id,subject,details,status,created_at,updated_at,review_notes) VALUES(?,?,?,?, 'open',?,?,?)",
      crypto.randomUUID(), person.accountId, `Help ${index}`, 'private-support-detail', base + index, base + index, 'private-review-notes');
    const safetyId = crypto.randomUUID(), privacyId = crypto.randomUUID();
    await h.storage.exec("INSERT INTO safety_reports(id,reporter_id,subject_id,reason,status,created_at) VALUES(?,?,?,?,'open',?)",
      safetyId, other.accountId, person.accountId, 'private-safety-reason', base);
    await h.storage.exec("INSERT INTO privacy_requests(id,subject_id,requested_by,request_type,status,reason,created_at,expires_at,export_key,execution_token) VALUES(?,?,?,'export','pending_approval',?,?,?,?,?)",
      privacyId, person.accountId, person.accountId, 'private-privacy-reason', base, base + 60000, 'private-export-key', 'private-execution-token');
    for (let index = 0; index < 32; index++) await h.storage.exec(
      'INSERT INTO audit_events(id,actor_id,subject_id,action,entity_id,details_json,created_at) VALUES(?,?,?,?,?,?,?)',
      crypto.randomUUID(), admin.accountId, person.accountId, 'admin.test.event', person.accountId, '{"secret":"private-audit-detail"}', base + index);
    const value = await h.json(`/admin/users/${person.accountId}`, { token: admin.token });
    assert.deepEqual(value.user.roles, ['user']); assert.equal(value.user.active_sessions, 1);
    assert.equal(value.user.open_support, 22); assert.equal(value.user.open_reports, 1); assert.equal(value.user.pending_privacy, 1);
    assert.equal(value.cases.support.length, 20); assert(value.has_more.support);
    assert.equal(value.history.length, 30); assert(value.has_more.history);
    assert.equal(value.cases.safety[0].relation, 'subject'); assert.equal(value.cases.privacy[0].status, 'pending_approval');
    assert.deepEqual(value.limits, { sessions: 50, cases_per_kind: 20, history: 30 });
    assert.deepEqual(Object.keys(value.sessions[0]).sort(), ['auth_method', 'created_at', 'expires_at', 'id', 'status']);
    const serialized = JSON.stringify(value);
    for (const secret of ['private-support-detail', 'private-review-notes', 'private-safety-reason', 'private-privacy-reason',
      'private-export-key', 'private-execution-token', 'private-audit-detail', 'refresh_hash', 'template_key', 'face_handle', 'public_jwk', 'access_token', other.accountId]) assert(!serialized.includes(secret), secret);
    await h.storage.exec("UPDATE face_profiles SET auth_enabled=0 WHERE account_id=?", person.accountId);
    const invalidated = await h.json(`/admin/users/${person.accountId}`, { token: admin.token });
    assert.equal(invalidated.user.active_sessions, 0);
    assert(invalidated.sessions.every(row => row.status === 'revoked'));
    await h.json(`/admin/users/${crypto.randomUUID()}`, { token: admin.token }, 404);
  } finally { await h.close(); }
});

test('single-session revocation is reasoned, audited and replay-safe without disabling the account or other sessions', async () => {
  const h = await startHarness({ faceVerifier: faceVerifierFixture, consumeQueue: false });
  try {
    const admin = await administrator(h), person = await enroll(h), anotherSession = await login(h, person);
    const targetSession = sessionId(person.token), key = operationKey(), body = { operation_key: key };
    const result = await revoke(h, admin, person.accountId, targetSession, body);
    assert.deepEqual(result, { account_id: person.accountId, session_id: targetSession, status: 'revoked', sessions_revoked: 1, account_disabled: false });
    assert.deepEqual(await revoke(h, admin, person.accountId, targetSession, body), result);
    assert.equal((await revoke(h, admin, person.accountId, targetSession, { ...body, reason: 'Changed reason' }, 409)).error.code, 'operation_key_conflict');
    assert.equal((await revoke(h, admin, person.accountId, sessionId(anotherSession.token), body, 409)).error.code, 'operation_key_conflict');
    await h.json('/me', { token: person.token }, 401);
    await h.json('/auth/session/refresh', { body: { refresh_token: person.refresh_token } }, 401);
    await h.json('/me', { token: anotherSession.token });
    const account = (await h.storage.exec('SELECT disabled_at,identity_state,roles_json FROM accounts WHERE id=?', person.accountId))[0];
    assert.deepEqual(account, { disabled_at: null, identity_state: 'registered_face', roles_json: '["user"]' });
    const events = await h.storage.exec("SELECT subject_id,entity_id,details_json FROM audit_events WHERE action='admin.user.session.revoke'");
    assert.equal(events.length, 1); assert.equal(events[0].subject_id, person.accountId); assert.equal(events[0].entity_id, targetSession);
    assert.deepEqual(JSON.parse(events[0].details_json), { reason: 'Reported lost session', sessions_revoked: 1 });
    const subjects = await h.storage.exec('SELECT subject_id FROM operation_subjects WHERE operation_key=?', key);
    assert(subjects.some(row => row.subject_id === person.accountId));
    assert.equal((await revoke(h, admin, person.accountId, targetSession)).sessions_revoked, 0);
  } finally { await h.close(); }
});

test('matching metadata distinguishes enabled, explicit pause, absent reference and authentication-only profile', async () => {
  const h = await startHarness({ faceVerifier: faceVerifierFixture, consumeQueue: false });
  try {
    const admin = await administrator(h), person = await enroll(h), anonymous = await h.anonymous();
    const detail = () => h.json(`/admin/users/${person.accountId}`, { token: admin.token });
    assert.equal((await detail()).user.matching_status, null);
    assert.equal((await h.json(`/admin/users/${anonymous.account_id}`, { token: admin.token })).user.matching_status, 'absent');
    await h.json('/me/photo-preferences', { token: person.token, body: {
      receive_matches: true, photo_matching_consent: true, processing_consent: true,
      policy_version: 'photo-policy-fixture-v1', operation_key: operationKey(),
    } });
    assert.equal((await detail()).user.matching_status, 'active');
    await h.storage.exec('INSERT INTO face_profile_states(account_id,version,matching_paused) VALUES(?,1,1) ON CONFLICT(account_id) DO UPDATE SET matching_paused=1', person.accountId);
    assert.equal((await detail()).user.matching_status, 'paused');
    await h.storage.exec('UPDATE face_profile_states SET matching_paused=0 WHERE account_id=?', person.accountId);
    await h.storage.exec("UPDATE consents SET expires_at=? WHERE account_id=? AND purpose='photo_matching'", Date.now() - 1, person.accountId);
    assert.equal((await detail()).user.matching_status, null);
    await h.storage.exec("UPDATE face_profiles SET status='disabled' WHERE account_id=?", person.accountId);
    assert.equal((await detail()).user.matching_status, 'absent');
    const list = await h.json(`/admin/users?q=${person.accountId}`, { token: admin.token });
    assert.equal(list.users[0].matching_status, 'absent');
    await h.storage.exec("UPDATE face_profiles SET status='active' WHERE account_id=?", person.accountId);
    await h.storage.exec('UPDATE accounts SET disabled_at=? WHERE id=?', Date.now(), person.accountId);
    assert.equal((await detail()).user.matching_status, 'absent');
  } finally { await h.close(); }
});

test('revoke rejects missing reason, foreign sessions, self management, sole admin and deleted account writes', async () => {
  const h = await startHarness({ faceVerifier: faceVerifierFixture, consumeQueue: false });
  try {
    const admin = await administrator(h), person = await enroll(h), foreign = await enroll(h);
    assert.equal((await revoke(h, admin, admin.accountId, sessionId(admin.token), {}, 409)).error.code, 'last_admin_protected');
    const secondAdmin = await administrator(h);
    assert.equal((await revoke(h, admin, admin.accountId, sessionId(admin.token), {}, 403)).error.code, 'self_management_forbidden');
    for (const reason of ['', 'no', null, 'x'.repeat(1001), 'line\nbreak']) await revoke(h, admin, person.accountId, sessionId(person.token), { reason }, 400);
    await revoke(h, admin, person.accountId, sessionId(person.token), { unsupported: 'suspend' }, 400);
    await revoke(h, admin, person.accountId, sessionId(foreign.token), {}, 404);
    await revoke(h, admin, crypto.randomUUID(), sessionId(person.token), {}, 404);
    await h.storage.exec('UPDATE accounts SET disabled_at=? WHERE id=?', Date.now(), person.accountId);
    assert.equal((await revoke(h, admin, person.accountId, sessionId(person.token), {}, 409)).error.code, 'account_deleted');
    await h.json('/admin/users', { token: secondAdmin.token });
    // A separate administrator may sign in again; revoking one session neither
    // removes the role nor invents an account suspension.
    await revoke(h, admin, secondAdmin.accountId, sessionId(secondAdmin.token));
    assert.equal((await h.storage.exec('SELECT disabled_at FROM accounts WHERE id=?', secondAdmin.accountId))[0].disabled_at, null);
    const signedInAgain = await login(h, secondAdmin);
    await h.json('/admin/users', { token: signedInAgain.token });
  } finally { await h.close(); }
});

test('fresh face means actual current-session verification; refresh and a later login cannot refresh older proof', async () => {
  const h = await startHarness({ faceVerifier: faceVerifierFixture, consumeQueue: false });
  try {
    const admin = await administrator(h), person = await enroll(h), target = sessionId(person.token), key = operationKey();
    // Keep a valid access credential while making its actual face verification old.
    await h.storage.exec("UPDATE auth_challenges SET used_at=? WHERE account_id=? AND status='used'", Date.now() - 300001, admin.accountId);
    assert.equal((await revoke(h, admin, person.accountId, target, { operation_key: key }, 403)).error.code, 'fresh_face_authentication_required');
    const refreshed = await h.json('/auth/session/refresh', { body: { refresh_token: admin.refresh_token } });
    const refreshedAdmin = { ...admin, token: refreshed.access_token };
    assert.equal((await revoke(h, refreshedAdmin, person.accountId, target, { operation_key: key }, 403)).error.code, 'fresh_face_authentication_required');
    const fresh = await login(h, admin);
    assert.equal((await revoke(h, refreshedAdmin, person.accountId, target, { operation_key: key }, 403)).error.code, 'fresh_face_authentication_required');
    const result = await revoke(h, fresh, person.accountId, target, { operation_key: key });
    assert.equal(result.sessions_revoked, 1);
    await h.storage.exec("UPDATE auth_challenges SET used_at=? WHERE account_id=? AND status='used'", Date.now() - 300001, admin.accountId);
    assert.equal((await revoke(h, fresh, person.accountId, target, { operation_key: key }, 403)).error.code, 'fresh_face_authentication_required');
    assert.equal((await h.storage.exec("SELECT count(*) n FROM audit_events WHERE action='admin.user.session.revoke'"))[0].n, 1);
  } finally { await h.close(); }
});
