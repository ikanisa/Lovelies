/** Source proposal only: native disposable PostgreSQL, two cooperative pools,
 * one synthetic registered operator who is also the sole subject, and an
 * in-memory journal. Never connect to hosted data or simulate another account.
 * Synthetic SQL authority mutations below are ordering probes, not route tests. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PostgresDatabase } from '../src/database.ts';
import { RestoreDatabaseFence } from '../src/restore-database.ts';
import { createApp, createHandler } from '../src/index.ts';
import { restoreOperationID } from '../src/restore-transaction.ts';
import { enroll, captureProofs, faceVerifierFixture } from './runtime-harness.mjs';
import { fixture, databaseConnection, controlRow, intent, unavailable } from './restore-database-fixture.mjs';

const native = { skip: process.env.TEST_DATABASE_URL ? false : 'Disposable local PostgreSQL required; PGlite cannot qualify backend ordering', timeout: 60_000 };
const DAY = 86400000;
const sessionID = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).jti;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(read, predicate) {
  const end = Date.now() + 10000;
  for (;;) {
    const value = await read(); if (predicate(value)) return value;
    if (Date.now() >= end) throw Error('synthetic_native_lock_wait_not_observed');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function setup(t) {
  // fixture -> startHarness -> isolatedPostgres validates loopback and creates a
  // new disposable database; it must not attach to any existing project.
  const f = await fixture(t), h = f.h;
  assert(h.databaseUrl, 'native test cannot use embedded fallback');
  h.env.FACE_AUTH_VERIFIER = { fetch: async request => {
    const form = await request.formData(); return Response.json(await faceVerifierFixture(JSON.parse(String(form.get('envelope'))), form));
  } };
  const actor = await enroll(h);
  await h.db.run('UPDATE accounts SET roles_json=? WHERE id=?', '["user","admin"]', actor.accountId);
  const challenge = await h.json('/auth/face/challenge', { body: { face_handle: actor.faceHandle, device_id: actor.deviceId } }, 201);
  const credentials = await h.json('/auth/face/complete', { body: await captureProofs(h, challenge, actor.keys.privateKey) });
  assert(credentials.roles.includes('admin'));
  const token = credentials.access_token, session = sessionID(token), now = h.app.now();
  const owned = await h.db.one('SELECT face_consent_id FROM sessions WHERE id=? AND account_id=?', session, actor.accountId);
  assert(owned?.face_consent_id);
  const id = randomUUID(), version = randomUUID(), key = `synthetic/${actor.accountId}/asset/${id}`;
  await h.db.run(`INSERT INTO assets(id,owner_id,source,status,object_key,content_type,byte_size,version,title,created_at)
    VALUES(?,?,'personal','ready',?,'image/png',3,?,'Single subject native fixture',?)`, id, actor.accountId, key, version, now - 80 * DAY);
  await h.db.run('INSERT INTO asset_retention(asset_id,raw_expires_at,preview_expires_at,legal_hold,version,updated_at) VALUES(?,?,?,?,?,?)',
    id, now - DAY, now + DAY, 0, 1, now);
  await h.env.QUARANTINE.put(key, new Uint8Array([1, 2, 3]));
  const other = new PostgresDatabase(databaseConnection(h, [], {}), new RestoreDatabaseFence(f.journal));
  const handler = createHandler(createApp(f.db, h.env, h.app.now));
  const body = { limit: 1, operation_key: 'native-authority-' + randomUUID() };
  const reservation = await restoreOperationID(actor.accountId, 'retention', body.operation_key);
  const schedule = async () => {
    const response = await handler(new Request('https://api.invalid/admin/retention/run', { method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  const operation = intent();
  let entered = false;
  const revoke = kind => other.transaction(async () => {
    entered = true;
    if (kind === 'session') await other.run('UPDATE sessions SET revoked_at=? WHERE id=? AND account_id=?', now, session, actor.accountId);
    if (kind === 'consent') await other.run("UPDATE consents SET status='revoked',revoked_at=? WHERE id=? AND account_id=?", now, owned.face_consent_id, actor.accountId);
    if (kind === 'role') await other.run('UPDATE accounts SET roles_json=? WHERE id=?', '["user"]', actor.accountId);
  }, operation);
  const state = async kind => {
    if (kind === 'session') return (await h.db.one('SELECT revoked_at FROM sessions WHERE id=?', session)).revoked_at !== null;
    if (kind === 'consent') return (await h.db.one('SELECT status FROM consents WHERE id=?', owned.face_consent_id)).status === 'revoked';
    return (await h.db.one('SELECT roles_json FROM accounts WHERE id=?', actor.accountId)).roles_json === '["user"]';
  };
  const waitForLock = () => until(async () => Number((await h.engine.query(`SELECT count(*) AS n FROM pg_locks
    WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`)).rows[0].n), value => value >= 1);
  return { ...f, h, other, actor, id, key, body, reservation, operation, schedule, revoke, state, waitForLock, wasEntered: () => entered };
}

for (const kind of ['session', 'consent', 'role']) {
  test(`native same-subject ${kind} revocation committed before admission prevents scheduling`, native, async t => {
    const f = await setup(t);
    try {
      await f.revoke(kind);
      assert(f.wasEntered()); assert(await f.state(kind)); assert.equal((await f.journal.lookup(f.operation.operation_id)).status, 'committed');
      const result = await f.schedule(); assert([401, 403].includes(result.status));
      assert.equal(await f.journal.lookup(f.reservation), null);
      assert.equal((await f.h.db.one('SELECT status FROM assets WHERE id=?', f.id)).status, 'ready');
      assert.equal(await f.h.db.one('SELECT id FROM retention_jobs WHERE asset_id=?', f.id), null); assert(await f.h.env.QUARANTINE.head(f.key));
    } finally { await f.other.close(); }
  });

  test(`native same-subject ${kind} revocation waits for accepted prepare, then wins after the guarded commit`, native, async t => {
    const f = await setup(t), enteredPrepare = deferred(), resumePrepare = deferred(), committed = deferred(), resumeOriginal = deferred();
    const prepare = f.journal.prepare.bind(f.journal); let schedule, mutation;
    f.journal.prepare = async (input, ...args) => {
      const value = await prepare(input, ...args);
      if (input.operation_id === f.reservation) {
        f.faults.afterCommit = async () => { delete f.faults.afterCommit; committed.resolve(); await resumeOriginal.promise; };
        enteredPrepare.resolve(); await resumePrepare.promise;
      }
      return value;
    };
    try {
      schedule = f.schedule(); await Promise.race([enteredPrepare.promise, schedule.then(() => { throw Error('prepare_not_reached'); })]);
      const before = await controlRow(f.h); assert.notEqual(before.last_operation_id, f.reservation);
      assert.equal((await f.journal.lookup(f.reservation)).status, 'pending');
      mutation = f.revoke(kind); await f.waitForLock(); assert.equal(f.wasEntered(), false);
      resumePrepare.resolve(); await Promise.race([committed.promise, schedule.then(() => { throw Error('commit_not_observed'); })]);
      await mutation; assert(f.wasEntered()); assert(await f.state(kind));
      assert.equal((await f.journal.lookup(f.reservation)).status, 'committed', 'second pool must reconcile exact committed reservation');
      assert.equal((await f.journal.lookup(f.operation.operation_id)).status, 'committed');
      const marker = await controlRow(f.h); assert.equal(marker.last_operation_id, f.operation.operation_id);
      resumeOriginal.resolve(); const result = await schedule; assert([401, 403].includes(result.status));
      assert.equal((await f.h.db.one('SELECT status FROM assets WHERE id=?', f.id)).status, 'ready');
      assert.equal(await f.h.db.one('SELECT id FROM retention_jobs WHERE asset_id=?', f.id), null); assert(await f.h.env.QUARANTINE.head(f.key));
    } finally {
      resumePrepare.resolve(); resumeOriginal.resolve(); if (mutation) await mutation.catch(() => {}); if (schedule) await schedule.catch(() => {}); await f.other.close();
    }
  });

  test(`native same-subject ${kind} revocation remains fenced after accepted prepare and rejected SQL commit`, native, async t => {
    const f = await setup(t), enteredPrepare = deferred(), resumePrepare = deferred(), prepare = f.journal.prepare.bind(f.journal);
    let schedule, mutation, mutationOutcome;
    f.journal.prepare = async (input, ...args) => {
      const value = await prepare(input, ...args);
      if (input.operation_id === f.reservation) { f.faults.beforeCommit = true; enteredPrepare.resolve(); await resumePrepare.promise; }
      return value;
    };
    try {
      schedule = f.schedule(); await Promise.race([enteredPrepare.promise, schedule.then(() => { throw Error('prepare_not_reached'); })]);
      const before = await controlRow(f.h); assert.notEqual(before.last_operation_id, f.reservation);
      mutation = f.revoke(kind); mutationOutcome = assert.rejects(mutation, unavailable);
      await f.waitForLock(); assert.equal(f.wasEntered(), false); resumePrepare.resolve();
      const result = await schedule; assert(result.status >= 500); await mutationOutcome;
      assert.equal(f.wasEntered(), false); assert.equal(await f.state(kind), false);
      assert.deepEqual(await controlRow(f.h), before); assert.equal((await f.journal.lookup(f.reservation)).status, 'pending');
      assert.equal(await f.journal.lookup(f.operation.operation_id), null);
      assert.equal((await f.h.db.one('SELECT status FROM assets WHERE id=?', f.id)).status, 'ready');
      assert.equal(await f.h.db.one('SELECT id FROM retention_jobs WHERE asset_id=?', f.id), null); assert(await f.h.env.QUARANTINE.head(f.key));
      assert.equal((await f.schedule()).status, 503, 'unmatched accepted prepare is not treated as a safe rollback');
    } finally {
      resumePrepare.resolve(); if (mutationOutcome) await mutationOutcome.catch(() => {}); if (schedule) await schedule.catch(() => {}); await f.other.close();
    }
  });
}
