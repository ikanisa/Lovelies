import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { startHarness, enroll, captureProofs, faceVerifierFixture, closeHarnesses } from './runtime-harness.mjs';
import { digest, stable } from '../src/types.ts';

after(closeHarnesses);
async function administrator(h) {
  const person = await enroll(h);
  await h.storage.exec('UPDATE accounts SET roles_json=? WHERE id=?', '["user","admin"]', person.accountId);
  const challenge = await h.json('/auth/face/challenge', { body: { face_handle: person.faceHandle, device_id: person.deviceId } }, 201);
  const credentials = await h.json('/auth/face/complete', { body: await captureProofs(h, challenge, person.keys.privateKey) });
  return { ...person, ...credentials, token: credentials.access_token };
}
async function insertMany(h, table, columns, rows) {
  const size = Math.floor(100 / columns.length);
  for (let offset = 0; offset < rows.length; offset += size) {
    const batch = rows.slice(offset, offset + size);
    await h.storage.exec(`INSERT INTO ${table}(${columns.join(',')}) VALUES ${batch.map(row => '(' + row.map(() => '?').join(',') + ')').join(',')}`, ...batch.flat());
  }
}
async function allPages(h, path, key, token, query = {}) {
  const result = [];
  let cursor, pages = 0;
  do {
    const value = await h.json(path + '?' + new URLSearchParams({ limit: '37', ...query, ...(cursor ? { cursor } : {}) }), { token });
    assert.equal(value[key].length <= 37, true);
    assert.equal(value.page.has_more, value.page.next_cursor !== null);
    result.push(...value[key]); cursor = value.page.next_cursor;
    assert(++pages < 10, 'bounded fixture must reach its final page');
  } while (cursor);
  return result;
}

test('account continuations expose older active sessions and every case/history page with account-bound cursors', async () => {
  const h = await startHarness({ faceVerifier: faceVerifierFixture, consumeQueue: false });
  try {
    const admin = await administrator(h), user = await enroll(h), other = await enroll(h);
    const activeSession = JSON.parse(Buffer.from(user.token.split('.')[1], 'base64url').toString()).jti;
    const timestamp = Date.now();
    const existing = (await h.storage.exec('SELECT * FROM sessions WHERE id=?', activeSession))[0];
    const baselineSessions = (await h.storage.exec('SELECT count(*) n FROM sessions WHERE account_id=?', user.accountId))[0].n;
    const expiredIds = Array.from({ length: 55 }, () => crypto.randomUUID());
    for (const [index, id] of expiredIds.entries()) await h.storage.exec(`INSERT INTO sessions(id,account_id,auth_method,auth_epoch,refresh_hash,expires_at,refresh_expires_at,created_at,revoked_at,face_profile_revision,face_consent_id,device_id,face_profile_epoch,device_revision)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, user.accountId, 'registered_face', existing.auth_epoch, 'fixture-hash-' + id, timestamp + 60000, timestamp + 600000, timestamp + index + 1, timestamp, existing.face_profile_revision, existing.face_consent_id, existing.device_id, existing.face_profile_epoch, existing.device_revision);
    await insertMany(h, 'support_requests', ['id','account_id','subject','details','status','created_at','updated_at'],
      Array.from({ length: 52 }, (_, i) => [crypto.randomUUID(), user.accountId, 'Case ' + i, 'private details not projected', 'open', timestamp - i, timestamp - i]));
    await insertMany(h, 'audit_events', ['id','actor_id','subject_id','action','entity_id','details_json','created_at'],
      Array.from({ length: 71 }, (_, i) => [crypto.randomUUID(), admin.accountId, user.accountId, 'fixture.account.event', user.accountId, '{"private":"not projected"}', timestamp - i]));
    const detail = await h.json(`/admin/users/${user.accountId}`, { token: admin.token });
    assert.equal(detail.sessions[0].id, activeSession); assert.equal(detail.sessions[0].status, 'active');
    assert.equal(detail.sessions.length, 50); assert.equal(detail.pages.sessions.total, baselineSessions + 55);
    assert(detail.pages.sessions.next_cursor); assert(detail.pages.support.next_cursor); assert(detail.pages.history.next_cursor);
    for (const kind of ['sessions','support','safety','privacy','history']) {
      const records = await allPages(h, `/admin/users/${user.accountId}/${kind}`, 'items', admin.token);
      assert.equal(new Set(records.map(row => row.id)).size, records.length, kind);
      assert(!JSON.stringify(records).includes('not projected'));
      if (kind === 'sessions') { assert.equal(records.length, baselineSessions + 55); assert.equal(records[0].id, activeSession); }
      if (kind === 'support') assert.equal(records.length, 52);
      if (kind === 'history') assert(records.filter(row => row.action === 'fixture.account.event').length === 71);
      await h.json(`/admin/users/${user.accountId}/${kind}`, { token: user.token }, 403);
    }
    await h.json(`/admin/users/${other.accountId}/sessions?` + new URLSearchParams({ limit: '50', cursor: detail.pages.sessions.next_cursor }), { token: admin.token }, 400);
    await h.json(`/admin/users/${user.accountId}/sessions/revoke`, { token: admin.token, body: {
      session_id: activeSession, reason: 'Exact old active session containment', operation_key: 'admin-page-' + crypto.randomUUID(),
    } });
    assert.equal((await h.storage.exec('SELECT revoked_at FROM sessions WHERE id=?', activeSession))[0].revoked_at !== null, true);
    assert.equal((await h.storage.exec("SELECT count(*) n FROM audit_events WHERE action='admin.user.session.revoke' AND entity_id=?", activeSession))[0].n, 1);
    await h.json('/me', { token: other.token });
  } finally { await h.close(); }
});

