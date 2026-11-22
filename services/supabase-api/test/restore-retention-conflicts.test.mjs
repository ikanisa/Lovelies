/** Staged source-only tests: one synthetic subject, PGlite, in-memory Storage
 * and journal. No hosted database, provider, or other account is exercised. */
import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import { randomUUID } from 'node:crypto';
import { runRetention } from '../src/retention.ts';
import { createApp, createHandler } from '../src/index.ts';
import { restoreOperationID } from '../src/restore-transaction.ts';
import { stable } from '../src/types.ts';
import { fixture, digest, unavailable } from './restore-database-fixture.mjs';

// Never run PGlite callbacks when a database target is defined, even empty.
const test = process.env.TEST_DATABASE_URL === undefined ? nodeTest : nodeTest.skip;

const DAY = 86400000;
async function setup(t) {
  assert.equal(process.env.TEST_DATABASE_URL, undefined, 'external database forbidden');
  const f = await fixture(t), h = f.h, person = await h.anonymous({ adult: true });
  const owner = person.account_id, now = h.app.now();
  await h.db.run(`INSERT INTO retention_settings(id,version,raw_days,preview_days,face_crop_days,free_cache_days,audit_days,legal_hold,updated_at)
    VALUES('default',1,60,60,14,2,30,0,?) ON CONFLICT(id) DO NOTHING`, now);
  const result = { ...f, h, owner, now };
  result.first = await makeAsset(result, 80);
  result.trace.length = 0;
  return result;
}
async function makeAsset(f, days) {
  const id = randomUUID(), version = randomUUID(), key = `synthetic/${f.owner}/asset/${id}`;
  await f.h.db.run(`INSERT INTO assets(id,owner_id,source,status,object_key,content_type,byte_size,version,title,created_at)
    VALUES(?,?,'personal','ready',?,'image/png',3,?,'Synthetic fixture',?)`, id, f.owner, key, version, f.now - days * DAY);
  await f.h.db.run('INSERT INTO asset_retention(asset_id,raw_expires_at,preview_expires_at,legal_hold,version,updated_at) VALUES(?,?,?,?,?,?)',
    id, f.now - DAY, f.now + DAY, 0, 1, f.now);
  await f.h.env.QUARANTINE.put(key, new Uint8Array([1, 2, 3]));
  return { id, version, key };
}
async function addJob(db, f, a, { policy = 1, status = 'pending', kind = 'raw', lease = null, error = 'preserve_evidence', created = f.now - 100 * DAY } = {}) {
  const id = randomUUID(), object = randomUUID();
  const binding = stable({ object_key: a.key, checksum: null, retention_version: 1, deleted_at: null, evidence: 'preserve' });
  await db.run(`INSERT INTO retention_jobs(id,subject_id,asset_id,kind,binding_json,policy_version,object_version,status,lease_token,lease_until,created_at,error_code)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, id, f.owner, a.id, kind, binding, policy, a.version, status,
    lease ? 'preserved-lease' : null, lease, created, error);
  await db.run(`INSERT INTO retention_objects(id,job_id,bucket,object_key,status,attempts,created_at)
    VALUES(?,?,'QUARANTINE',?,'pending',7,?)`, object, id, a.key, created);
  return id;
}
const rows = (f, a) => f.h.db.all('SELECT * FROM retention_jobs WHERE asset_id=? ORDER BY id', a.id);
const objects = (f, a) => f.h.db.all('SELECT o.* FROM retention_objects o JOIN retention_jobs j ON j.id=o.job_id WHERE j.asset_id=? ORDER BY o.id', a.id);
const asset = (f, a) => f.h.db.one('SELECT * FROM assets WHERE id=?', a.id);
const op = (f, a) => restoreOperationID(f.owner, 'retention.raw-expiry-v1',
  'retention.raw:' + digest(stable({ asset_id: a.id, asset_version: a.version })));
const run = (f, limit) => f.db.invocation(() => runRetention(f.context, limit));
function watchDeletes(f) {
  const calls = [], bucket = f.h.env.QUARANTINE, remove = bucket.delete.bind(bucket);
  bucket.delete = async key => { calls.push(key); return remove(key); };
  return calls;
}
async function unchanged(f, a, priorRows, priorObjects, priorAsset) {
  assert.deepEqual(await rows(f, a), priorRows); assert.deepEqual(await objects(f, a), priorObjects);
  assert.deepEqual(await asset(f, a), priorAsset); assert(await f.h.env.QUARANTINE.head(a.key));
}

test('older conflicts exceeding the limit preserve evidence and cannot starve a later asset or cleanup', async t => {
  const f = await setup(t), second = await makeAsset(f, 79), third = await makeAsset(f, 78), good = await makeAsset(f, 70);
  await addJob(f.h.db, f, f.first, { status: 'pending' });
  await addJob(f.h.db, f, second, { status: 'failed' });
  await addJob(f.h.db, f, third, { status: 'processing', lease: f.now - 1 });
  const held = [f.first, second, third], before = await Promise.all(held.map(async a => [await rows(f, a), await objects(f, a), await asset(f, a)]));
  const calls = watchDeletes(f), outcome = await run(f, 1);
  assert.equal(outcome.failed, 1); assert(outcome.pending >= 3); assert.equal(outcome.verified, 1);
  assert.deepEqual(calls, [good.key]); assert.equal((await f.journal.lookup(await op(f, good))).status, 'committed');
  for (let i = 0; i < held.length; i++) await unchanged(f, held[i], ...before[i]);
  const again = await run(f, 1); assert.equal(again.failed, 1); assert.equal(again.verified, 0); assert.deepEqual(calls, [good.key]);
});

test('an older-policy raw job on a live source is not adopted or rewritten by the new policy', async t => {
  const f = await setup(t), good = await makeAsset(f, 70);
  await addJob(f.h.db, f, f.first, { policy: 1, status: 'failed', error: 'unknown_prior_result' });
  await f.h.db.run("UPDATE retention_settings SET version=2 WHERE id='default'");
  const before = [await rows(f, f.first), await objects(f, f.first), await asset(f, f.first)], calls = watchDeletes(f);
  const result = await run(f, 1); assert.equal(result.failed, 1); assert.equal(result.verified, 1);
  assert.deepEqual(calls, [good.key]); await unchanged(f, f.first, ...before);
});

test('duplicate old and current policy jobs on an expired episode remain unchanged along with overlapping jobs', async t => {
  const f = await setup(t), good = await makeAsset(f, 70);
  await f.h.db.run("UPDATE assets SET status='expired',deleted_at=? WHERE id=?", f.now, f.first.id);
  await addJob(f.h.db, f, f.first, { policy: 1, status: 'failed' });
  await addJob(f.h.db, f, f.first, { policy: 2, status: 'pending' });
  await addJob(f.h.db, f, f.first, { policy: 1, status: 'pending', kind: 'preview' });
  const before = [await rows(f, f.first), await objects(f, f.first), await asset(f, f.first)], calls = watchDeletes(f);
  const result = await run(f, 1); assert.equal(result.failed, 1); assert.equal(result.verified, 1);
  assert.deepEqual(calls, [good.key]); await unchanged(f, f.first, ...before);
});

test('a committed conflict appearing after scan is rolled back locally and later work advances', async t => {
  const f = await setup(t), good = await makeAsset(f, 70), calls = watchDeletes(f);
  const all = f.db.all.bind(f.db); let depth = 0, preserved;
  let fired = false;
  f.db.all = async (sql, ...args) => {
    depth++; let value;
    try { value = await all(sql, ...args); } finally { depth--; }
    if (!fired && depth === 0 && sql.startsWith('SELECT a.* FROM assets a LEFT JOIN asset_retention')) {
      fired = true; await addJob(f.db, f, f.first, { policy: 1 });
      preserved = [await f.db.all('SELECT * FROM retention_jobs WHERE asset_id=? ORDER BY id', f.first.id),
        await f.db.all('SELECT o.* FROM retention_objects o JOIN retention_jobs j ON j.id=o.job_id WHERE j.asset_id=? ORDER BY o.id', f.first.id),
        await f.db.one('SELECT * FROM assets WHERE id=?', f.first.id)];
    }
    return value;
  };
  const result = await run(f, 2);
  assert(fired); assert.equal(result.failed, 1); assert.equal(result.verified, 1);
  assert.deepEqual(calls, [good.key]); await unchanged(f, f.first, ...preserved);
  assert.equal(await f.journal.lookup(await op(f, f.first)), null);
});

test('a conflict exposed after fact collection aborts before prepare and later work advances', async t => {
  const f = await setup(t), good = await makeAsset(f, 70), before = await asset(f, f.first), calls = watchDeletes(f);
  const one = f.db.one.bind(f.db); let checks = 0, fired = false;
  f.db.one = async (sql, ...args) => {
    const value = await one(sql, ...args);
    if (sql === "SELECT id FROM retention_jobs WHERE asset_id=? AND object_version=? AND kind='raw' LIMIT 1" && args[0] === f.first.id && ++checks === 2) {
      fired = true; const id = await addJob(f.db, f, f.first, { policy: 1 }); return { id };
    }
    return value;
  };
  const result = await run(f, 2);
  assert(fired); assert.equal(result.failed, 1); assert.equal(result.verified, 1); assert.deepEqual(calls, [good.key]);
  assert.deepEqual(await asset(f, f.first), before); assert.deepEqual(await rows(f, f.first), []);
  assert.equal(await f.journal.lookup(await op(f, f.first)), null); assert(await f.h.env.QUARANTINE.head(f.first.key));
});

test('a late conflict with uncertain rollback aborts, without scheduling later work or dispatching Storage', async t => {
  const f = await setup(t), good = await makeAsset(f, 70), before = await asset(f, good), calls = watchDeletes(f);
  const one = f.db.one.bind(f.db), transaction = f.db.transaction.bind(f.db); let checks = 0, fired = false;
  f.db.one = async (sql, ...args) => {
    const value = await one(sql, ...args);
    if (sql === "SELECT id FROM retention_jobs WHERE asset_id=? AND object_version=? AND kind='raw' LIMIT 1" && args[0] === f.first.id && ++checks === 2) {
      fired = true; const id = await addJob(f.db, f, f.first, {}); return { id };
    }
    return value;
  };
  f.db.transaction = async (...args) => {
    try { return await transaction(...args); }
    catch (error) { if (error?.message === 'retention_preprepare_conflict') throw Error('synthetic_rollback_reply_unknown'); throw error; }
  };
  await assert.rejects(() => run(f, 2), /synthetic_rollback_reply_unknown/);
  assert(fired); assert.deepEqual(calls, []); assert.deepEqual(await asset(f, good), before);
  assert.equal(await f.journal.lookup(await op(f, good)), null);
});

test('a conflicted episode appearing after the claim scan leaves all its job evidence intact', async t => {
  const f = await setup(t), good = await makeAsset(f, 70);
  await f.h.db.run("UPDATE assets SET status='expired',deleted_at=? WHERE id=?", f.now, f.first.id);
  await addJob(f.h.db, f, f.first, { policy: 1 });
  const all = f.db.all.bind(f.db), calls = watchDeletes(f); let depth = 0, fired = false, preserved;
  f.db.all = async (sql, ...args) => {
    depth++; let value;
    try { value = await all(sql, ...args); } finally { depth--; }
    // Claim scan is outside an existing transaction; depth avoids its inner
    // automatically read-only call, so the injected write commits separately.
    if (!fired && depth === 0 && sql.startsWith('SELECT j.* FROM retention_jobs j')) {
      fired = true; await addJob(f.db, f, f.first, { policy: 2, status: 'failed' });
      preserved = [await rows(f, f.first), await objects(f, f.first), await asset(f, f.first)];
    }
    return value;
  };
  const result = await run(f, 2);
  assert(fired); assert.equal(result.failed, 1); assert.equal(result.verified, 1); assert.deepEqual(calls, [good.key]);
  await unchanged(f, f.first, ...preserved);
});

test('an accepted but unacknowledged prepare halts the run before later scheduling or cleanup', async t => {
  const f = await setup(t), good = await makeAsset(f, 70), before = await asset(f, good), calls = watchDeletes(f);
  const firstOp = await op(f, f.first), prepare = f.journal.prepare.bind(f.journal);
  f.journal.prepare = async (input, ...args) => {
    if (input.operation_id === firstOp) f.faults.reply = { path: '/v1/operations/prepare', stage: 'after' };
    return prepare(input, ...args);
  };
  await assert.rejects(() => run(f, 2), unavailable);
  assert.equal((await f.journal.lookup(firstOp)).status, 'pending'); assert.deepEqual(calls, []);
  assert.deepEqual(await asset(f, good), before); assert.equal(await f.journal.lookup(await op(f, good)), null);
  await assert.rejects(() => run(f, 2), unavailable); assert.deepEqual(calls, []);
});

test('an unknown claim COMMIT poisons the invocation and cannot trigger any DELETE', async t => {
  const f = await setup(t), good = await makeAsset(f, 70), calls = watchDeletes(f), write = f.db.run.bind(f.db);
  let injected = false;
  f.db.run = async (sql, ...args) => {
    await write(sql, ...args);
    if (!injected && sql.startsWith("UPDATE retention_jobs SET status='processing'")) {
      injected = true; f.faults.commitReply = true;
    }
  };
  await assert.rejects(() => run(f, 2), unavailable); assert(injected); assert.deepEqual(calls, []);
  assert(await f.h.env.QUARANTINE.head(f.first.key)); assert(await f.h.env.QUARANTINE.head(good.key));
  const jobs = [...await rows(f, f.first), ...await rows(f, good)];
  assert.equal(jobs.filter(row => row.status === 'processing').length, 1);
  assert.equal(jobs.filter(row => row.status === 'pending').length, 1);
  assert.equal((await f.journal.control()).state, 'pending');
});

test('a conflict discovered after claim but before DELETE preserves the claim and continues unrelated work', async t => {
  const f = await setup(t), other = await makeAsset(f, 70), all = f.db.all.bind(f.db), calls = watchDeletes(f);
  let depth = 0, fired = false, affected, preserved;
  f.db.all = async (sql, ...args) => {
    depth++; let value;
    try { value = await all(sql, ...args); } finally { depth--; }
    if (!fired && depth === 0 && sql.startsWith('SELECT * FROM retention_objects WHERE job_id=')) {
      fired = true;
      const claimed = await f.db.one('SELECT * FROM retention_jobs WHERE id=?', args[0]);
      affected = [f.first, other].find(a => a.id === claimed.asset_id); assert(affected);
      await addJob(f.db, f, affected, { policy: 2, status: 'failed' });
      preserved = [await rows(f, affected), await objects(f, affected), await asset(f, affected)];
    }
    return value;
  };
  const result = await run(f, 2); assert(fired); assert.equal(result.failed, 1); assert.equal(result.verified, 1);
  const unaffected = affected === f.first ? other : f.first;
  assert.deepEqual(calls, [unaffected.key]); await unchanged(f, affected, ...preserved);
});

test('a conflict detected after DELETE stops retention with its claim and object evidence untouched', async t => {
  const f = await setup(t), other = await makeAsset(f, 70), bucket = f.h.env.QUARANTINE, remove = bucket.delete.bind(bucket);
  const calls = []; let affected, preserved;
  bucket.delete = async key => {
    calls.push(key); await remove(key); affected = [f.first, other].find(a => a.key === key); assert(affected);
    await addJob(f.db, f, affected, { policy: 2, status: 'failed' });
    preserved = [await rows(f, affected), await objects(f, affected), await asset(f, affected)];
  };
  await assert.rejects(() => run(f, 2), error => error?.code === 'retention_conflict_after_dispatch');
  assert.equal(calls.length, 1); assert.deepEqual(await rows(f, affected), preserved[0]);
  assert.deepEqual(await objects(f, affected), preserved[1]); assert.deepEqual(await asset(f, affected), preserved[2]);
  assert.equal(await bucket.head(affected.key), null);
  assert(await bucket.head((affected === f.first ? other : f.first).key));
});

test('an uncertain rollback while checking a claimed conflict poisons the invocation before other work', async t => {
  const f = await setup(t), other = await makeAsset(f, 70), all = f.db.all.bind(f.db), calls = watchDeletes(f);
  const connection = f.db.connection, begin = connection.begin.bind(connection);
  connection.begin = async callback => {
    try { return await begin(callback); }
    catch (error) { if (error?.message === 'retention_claimed_episode_conflict') throw Error('synthetic_rollback_unknown'); throw error; }
  };
  let depth = 0, fired = false;
  f.db.all = async (sql, ...args) => {
    depth++; let value;
    try { value = await all(sql, ...args); } finally { depth--; }
    if (!fired && depth === 0 && sql.startsWith('SELECT * FROM retention_objects WHERE job_id=')) {
      fired = true;
      const claimed = await f.db.one('SELECT * FROM retention_jobs WHERE id=?', args[0]);
      const target = [f.first, other].find(a => a.id === claimed.asset_id); assert(target);
      await addJob(f.db, f, target, { policy: 2, status: 'failed' });
    }
    return value;
  };
  await assert.rejects(() => run(f, 2), unavailable); assert(fired); assert.deepEqual(calls, []);
  assert(await f.h.env.QUARANTINE.head(f.first.key)); assert(await f.h.env.QUARANTINE.head(other.key));
});

test('a caught lost COMMIT cannot reopen the same invocation; a new invocation may reconcile the exact marker', async t => {
  const f = await setup(t); let caught = false, reached = false;
  await assert.rejects(() => f.db.invocation(async () => {
    f.faults.commitReply = true;
    try { await f.db.transaction(() => f.db.run('UPDATE accounts SET name=? WHERE id=?', 'Synthetic updated name', f.owner)); }
    catch (error) { assert.match(error.message, /synthetic_commit_result_lost/); caught = true; }
    await f.db.one('SELECT id FROM accounts WHERE id=?', f.owner); reached = true;
  }), unavailable);
  assert(caught); assert.equal(reached, false);
  const control = await f.journal.control(); assert.equal(control.state, 'pending');
  await f.db.invocation(() => f.db.read(() => {}));
  assert.equal((await f.journal.lookup(control.pending_operation_id)).status, 'committed');
  assert.equal((await f.h.db.one('SELECT name FROM accounts WHERE id=?', f.owner)).name, 'Synthetic updated name');
});


test('trusted maintenance exposes a conflicting raw episode as HTTP 503 and a nonzero retention failure', async t => {
  const f = await setup(t); await addJob(f.h.db, f, f.first, { status: 'failed' });
  const before = [await rows(f, f.first), await objects(f, f.first), await asset(f, f.first)], calls = watchDeletes(f);
  const handler = createHandler(createApp(f.db, f.h.env, f.h.app.now));
  const response = await handler(new Request('https://api.invalid/_internal/maintenance', { method: 'POST',
    headers: { authorization: 'Bearer ' + f.h.env.INTERNAL_MAINTENANCE_SECRET } }));
  const value = await response.json(); assert.equal(response.status, 503);
  assert.equal(value.retention.status, 'observed'); assert(value.retention.failed > 0); assert(value.maintenance_errors > 0);
  assert.deepEqual(calls, []); await unchanged(f, f.first, ...before);
});

test('a verified preview-only oldest asset cannot starve a later raw expiry and returns when raw becomes due', async t => {
  const f = await setup(t), good = await makeAsset(f, 70);
  await f.h.db.run('UPDATE asset_retention SET raw_expires_at=?,preview_expires_at=? WHERE asset_id=?', f.now + DAY, f.now - DAY, f.first.id);
  const previewJob = await addJob(f.h.db, f, f.first, { kind: 'preview', status: 'verified' });
  await f.h.db.run("UPDATE retention_objects SET status='verified',verified_at=? WHERE job_id=?", f.now, previewJob);
  const before = [await rows(f, f.first), await objects(f, f.first), await asset(f, f.first)], calls = watchDeletes(f);
  const result = await run(f, 1); assert.equal(result.verified, 1); assert.equal(result.failed, 0); assert.deepEqual(calls, [good.key]);
  await unchanged(f, f.first, ...before);
  await f.h.db.run('UPDATE asset_retention SET raw_expires_at=? WHERE asset_id=?', f.now - DAY, f.first.id);
  await run(f, 1); assert.deepEqual(calls, [good.key, f.first.key]); assert.equal((await asset(f, f.first)).status, 'expired');
});

for (const blocker of ['asset-hold', 'moderation-hold', 'pending-writer']) test(`an oldest ${blocker} is excluded before the bounded scan without mutating its evidence`, async t => {
  const f = await setup(t), good = await makeAsset(f, 70);
  if (blocker === 'asset-hold') await f.h.db.run('UPDATE asset_retention SET legal_hold=1 WHERE asset_id=?', f.first.id);
  if (blocker === 'moderation-hold') await f.h.db.run('INSERT INTO moderation_holds(id,asset_id,active,created_at,reason) VALUES(?,?,1,?,?)', randomUUID(), f.first.id, f.now, 'synthetic retention hold');
  if (blocker === 'pending-writer') await f.h.db.run(`INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at)
    VALUES(?,?,'QUARANTINE',?,'pending',?)`, randomUUID(), f.owner, f.first.key, f.now);
  const blockerRows = async () => ({
    retention: await f.h.db.one('SELECT * FROM asset_retention WHERE asset_id=?', f.first.id),
    holds: await f.h.db.all('SELECT * FROM moderation_holds WHERE asset_id=? ORDER BY id', f.first.id),
    writers: await f.h.db.all("SELECT * FROM media_write_intents WHERE account_id=? AND bucket='QUARANTINE' AND object_key=? ORDER BY id", f.owner, f.first.key),
  });
  const blockerBefore = await blockerRows();
  const before = [await rows(f, f.first), await objects(f, f.first), await asset(f, f.first)], calls = watchDeletes(f);
  const result = await run(f, 1); assert.equal(result.verified, 1); assert.deepEqual(calls, [good.key]); await unchanged(f, f.first, ...before);
  assert.deepEqual(await blockerRows(), blockerBefore);
  if (blocker === 'pending-writer') {
    const handler = createHandler(createApp(f.db, f.h.env, f.h.app.now));
    const response = await handler(new Request('https://api.invalid/_internal/maintenance', { method: 'POST', headers: { authorization: 'Bearer ' + f.h.env.INTERNAL_MAINTENANCE_SECRET } }));
    const health = await response.json();
    assert.equal(health.privacy_health.status, 'observed'); assert(health.privacy_health.writers.unsettled > 0);
    const writer = await f.h.db.one("SELECT status,account_id,object_key FROM media_write_intents WHERE account_id=? AND bucket='QUARANTINE' AND object_key=?", f.owner, f.first.key);
    assert.deepEqual(writer, { status: 'pending', account_id: f.owner, object_key: f.first.key });
    assert.deepEqual(await blockerRows(), blockerBefore);
  }
});

test('a held old cleanup job does not occupy the limited claim page ahead of eligible work', async t => {
  const f = await setup(t), good = await makeAsset(f, 70);
  await f.h.db.run("UPDATE assets SET status='expired',deleted_at=? WHERE id=?", f.now, f.first.id);
  await f.h.db.run('UPDATE asset_retention SET legal_hold=1 WHERE asset_id=?', f.first.id);
  await addJob(f.h.db, f, f.first, { status: 'pending' });
  const before = [await rows(f, f.first), await objects(f, f.first), await asset(f, f.first)], calls = watchDeletes(f);
  const result = await run(f, 1); assert.equal(result.verified, 1); assert.deepEqual(calls, [good.key]); await unchanged(f, f.first, ...before);
});

test('unresolved raw and preview obligations for the same exact key cannot occupy the claim page or mutate each other', async t => {
  const f = await setup(t), good = await makeAsset(f, 70), shared = `synthetic/${f.owner}/preview/shared`;
  await f.h.db.run("UPDATE assets SET status='expired',deleted_at=? WHERE id=?", f.now, f.first.id);
  await addJob(f.h.db, f, f.first, { kind: 'raw', status: 'pending' });
  await addJob(f.h.db, f, f.first, { kind: 'preview', status: 'failed' });
  await f.h.db.run("UPDATE retention_objects SET bucket='PHOTOS',object_key=? WHERE job_id IN (SELECT id FROM retention_jobs WHERE asset_id=?)", shared, f.first.id);
  await f.h.env.PHOTOS.put(shared, new Uint8Array([7, 8, 9]));
  const before = [await rows(f, f.first), await objects(f, f.first), await asset(f, f.first)], calls = watchDeletes(f);
  const result = await run(f, 1); assert(result.failed > 0); assert.equal(result.verified, 1); assert.deepEqual(calls, [good.key]);
  await unchanged(f, f.first, ...before); assert(await f.h.env.PHOTOS.head(shared));
});

test('an unresolved writer for an older cleanup job does not starve the limited claim page', async t => {
  const f = await setup(t), good = await makeAsset(f, 70);
  await f.h.db.run("UPDATE assets SET status='expired',deleted_at=? WHERE id=?", f.now, f.first.id);
  await addJob(f.h.db, f, f.first, { status: 'pending' });
  await f.h.db.run(`INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at)
    VALUES(?,?,'QUARANTINE',?,'pending',?)`, randomUUID(), f.owner, f.first.key, f.now);
  const before = [await rows(f, f.first), await objects(f, f.first), await asset(f, f.first)], calls = watchDeletes(f);
  const result = await run(f, 1); assert.equal(result.verified, 1); assert.deepEqual(calls, [good.key]); await unchanged(f, f.first, ...before);
});

test('a new preview key after a verified preview job is visible as a conflict and is not silently retired', async t => {
  const f = await setup(t), good = await makeAsset(f, 70), preview = `synthetic/${f.owner}/preview/new`;
  await f.h.db.run('UPDATE asset_retention SET raw_expires_at=?,preview_expires_at=? WHERE asset_id=?', f.now + DAY, f.now - DAY, f.first.id);
  const job = await addJob(f.h.db, f, f.first, { kind: 'preview', status: 'verified' });
  await f.h.db.run("UPDATE retention_objects SET status='verified',verified_at=? WHERE job_id=?", f.now, job);
  await f.h.db.run(`INSERT INTO renditions(id,asset_id,object_key,content_type,byte_size,checksum_sha256,source_checksum_sha256,version,status)
    VALUES(?,?,?,'image/png',3,?,?,?,'ready')`, randomUUID(), f.first.id, preview, 'a'.repeat(64), 'b'.repeat(64), randomUUID());
  await f.h.env.PHOTOS.put(preview, new Uint8Array([1, 2, 3]));
  const before = [await rows(f, f.first), await objects(f, f.first), await asset(f, f.first)], calls = watchDeletes(f);
  const result = await run(f, 1); assert(result.failed > 0); assert.equal(result.verified, 1); assert.deepEqual(calls, [good.key]);
  await unchanged(f, f.first, ...before); assert.equal((await f.h.db.one('SELECT status FROM renditions WHERE object_key=?', preview)).status, 'ready');
  assert(await f.h.env.PHOTOS.head(preview));
});

// Source-only cases: all jobs, keys and the later asset belong to this one
// synthetic subject. Old-policy evidence is deliberately not repaired here.
test('an old-policy empty preview obligation cannot create a second job or starve later work', async t => {
  const f = await setup(t), good = await makeAsset(f, 70), calls = watchDeletes(f);
  await f.h.db.run('UPDATE asset_retention SET raw_expires_at=?,preview_expires_at=? WHERE asset_id=?', f.now + DAY, f.now - DAY, f.first.id);
  const id = await addJob(f.h.db, f, f.first, { kind: 'preview', status: 'pending', policy: 1 });
  await f.h.db.run('DELETE FROM retention_objects WHERE job_id=?', id);
  await f.h.db.run("UPDATE retention_settings SET version=2 WHERE id='default'");
  const before = [await rows(f, f.first), await objects(f, f.first), await asset(f, f.first)];
  for (let round = 0; round < 2; round++) {
    const result = await run(f, 1); assert(result.failed > 0); assert.equal(result.verified, round === 0 ? 1 : 0);
    assert.deepEqual(calls, [good.key]); await unchanged(f, f.first, ...before);
    assert.equal((await rows(f, f.first)).length, 1); assert.equal((await rows(f, f.first))[0].policy_version, 1);
  }
  // Its raw deadline cannot silently invalidate the unresolved empty preview.
  await f.h.db.run('UPDATE asset_retention SET raw_expires_at=? WHERE asset_id=?', f.now - DAY, f.first.id);
  const held = await run(f, 1); assert(held.failed > 0); assert.equal(held.verified, 0);
  await unchanged(f, f.first, ...before); assert.deepEqual(calls, [good.key]);
  assert.equal(await f.journal.lookup(await op(f, f.first)), null);
});

test('a verified older-policy preview suppresses rescheduling its already verified keys', async t => {
  const f = await setup(t), good = await makeAsset(f, 70), calls = watchDeletes(f), photos = [];
  const preview = `synthetic/${f.owner}/preview/verified`;
  const remove = f.h.env.PHOTOS.delete.bind(f.h.env.PHOTOS);
  f.h.env.PHOTOS.delete = async key => { photos.push(key); return remove(key); };
  await f.h.db.run('UPDATE asset_retention SET raw_expires_at=?,preview_expires_at=? WHERE asset_id=?', f.now + DAY, f.now - DAY, f.first.id);
  await f.h.db.run(`INSERT INTO renditions(id,asset_id,object_key,content_type,byte_size,checksum_sha256,source_checksum_sha256,version,status)
    VALUES(?,?,?,'image/png',3,?,?,?,'retired')`, randomUUID(), f.first.id, preview, 'a'.repeat(64), 'b'.repeat(64), randomUUID());
  const id = await addJob(f.h.db, f, f.first, { kind: 'preview', status: 'verified', policy: 1 });
  await f.h.db.run("UPDATE retention_objects SET bucket='PHOTOS',object_key=?,status='verified',verified_at=? WHERE job_id=?", preview, f.now, id);
  await f.h.db.run("UPDATE retention_settings SET version=2 WHERE id='default'");
  const before = [await rows(f, f.first), await objects(f, f.first), await asset(f, f.first)];
  const result = await run(f, 1); assert.equal(result.failed, 0); assert.equal(result.verified, 1);
  assert.deepEqual(calls, [good.key]); assert.deepEqual(photos, []); await unchanged(f, f.first, ...before);
  assert.equal((await rows(f, f.first)).length, 1); assert.equal((await rows(f, f.first))[0].policy_version, 1);
});

test('new keys after an older-policy verified preview raise health and remain available for reconciliation', async t => {
  const f = await setup(t), good = await makeAsset(f, 70), calls = watchDeletes(f), preview = `synthetic/${f.owner}/preview/later`;
  await f.h.db.run('UPDATE asset_retention SET raw_expires_at=?,preview_expires_at=? WHERE asset_id=?', f.now + DAY, f.now - DAY, f.first.id);
  const id = await addJob(f.h.db, f, f.first, { kind: 'preview', status: 'verified', policy: 1 });
  await f.h.db.run('DELETE FROM retention_objects WHERE job_id=?', id);
  await f.h.db.run(`INSERT INTO renditions(id,asset_id,object_key,content_type,byte_size,checksum_sha256,source_checksum_sha256,version,status)
    VALUES(?,?,?,'image/png',3,?,?,?,'ready')`, randomUUID(), f.first.id, preview, 'a'.repeat(64), 'b'.repeat(64), randomUUID());
  await f.h.env.PHOTOS.put(preview, new Uint8Array([1, 2, 3]));
  await f.h.db.run("UPDATE retention_settings SET version=2 WHERE id='default'");
  const before = [await rows(f, f.first), await objects(f, f.first), await asset(f, f.first)];
  const result = await run(f, 1); assert(result.failed > 0); assert.equal(result.verified, 1);
  assert.deepEqual(calls, [good.key]); await unchanged(f, f.first, ...before);
  assert.equal((await f.h.db.one('SELECT status FROM renditions WHERE object_key=?', preview)).status, 'ready');
  assert(await f.h.env.PHOTOS.head(preview)); assert.equal((await rows(f, f.first)).length, 1);
});

test('duplicate empty preview episodes across policies preserve both jobs and cannot starve the claim page', async t => {
  const f = await setup(t), good = await makeAsset(f, 70), calls = watchDeletes(f);
  await f.h.db.run('UPDATE asset_retention SET raw_expires_at=?,preview_expires_at=? WHERE asset_id=?', f.now + DAY, f.now - DAY, f.first.id);
  const first = await addJob(f.h.db, f, f.first, { kind: 'preview', status: 'pending', policy: 1 });
  const second = await addJob(f.h.db, f, f.first, { kind: 'preview', status: 'pending', policy: 2 });
  await f.h.db.run('DELETE FROM retention_objects WHERE job_id IN (?,?)', first, second);
  await f.h.db.run("UPDATE retention_settings SET version=2 WHERE id='default'");
  const before = [await rows(f, f.first), await objects(f, f.first), await asset(f, f.first)];
  for (let round = 0; round < 2; round++) {
    const result = await run(f, 1); assert(result.failed > 0); assert.equal(result.verified, round === 0 ? 1 : 0);
    assert.deepEqual(calls, [good.key]); await unchanged(f, f.first, ...before);
  }
});

test('a policy change after the claim page cannot relabel or overwrite the old preview', async t => {
  const f = await setup(t), good = await makeAsset(f, 70), calls = watchDeletes(f);
  await f.h.db.run('UPDATE asset_retention SET raw_expires_at=?,preview_expires_at=? WHERE asset_id=?', f.now + DAY, f.now - DAY, f.first.id);
  const id = await addJob(f.h.db, f, f.first, { kind: 'preview', status: 'pending', policy: 1 });
  await f.h.db.run('DELETE FROM retention_objects WHERE job_id=?', id);
  const before = [await rows(f, f.first), await objects(f, f.first), await asset(f, f.first)];
  const all = f.db.all.bind(f.db); let depth = 0, fired = false;
  f.db.all = async (sql, ...args) => {
    depth++; let result; try { result = await all(sql, ...args); } finally { depth--; }
    if (!fired && depth === 0 && sql.startsWith('SELECT j.* FROM retention_jobs j')) {
      fired = true; await f.db.run("UPDATE retention_settings SET version=2 WHERE id='default'");
    }
    return result;
  };
  const result = await run(f, 2); assert(fired); assert(result.failed > 0); assert.equal(result.verified, 1);
  assert.deepEqual(calls, [good.key]); await unchanged(f, f.first, ...before);
});

test('a late old-policy preview episode is rechecked before any selected source is changed', async t => {
  const f = await setup(t), good = await makeAsset(f, 70), calls = watchDeletes(f);
  await f.h.db.run('UPDATE asset_retention SET raw_expires_at=?,preview_expires_at=? WHERE asset_id=?', f.now + DAY, f.now - DAY, f.first.id);
  await f.h.db.run("UPDATE retention_settings SET version=2 WHERE id='default'");
  const all = f.db.all.bind(f.db); let depth = 0, fired = false, before;
  f.db.all = async (sql, ...args) => {
    depth++; let value; try { value = await all(sql, ...args); } finally { depth--; }
    if (!fired && depth === 0 && sql.startsWith('SELECT a.* FROM assets a LEFT JOIN asset_retention')) {
      fired = true; const id = await addJob(f.db, f, f.first, { kind: 'preview', status: 'pending', policy: 1 });
      await f.db.run('DELETE FROM retention_objects WHERE job_id=?', id);
      // This synthetic injection joins the scan transaction. Snapshot through
      // that same adapter; a second PGlite adapter could commit the shared
      // engine while the fenced transaction is still open.
      before = [
        await f.db.all('SELECT * FROM retention_jobs WHERE asset_id=? ORDER BY id', f.first.id),
        await f.db.all('SELECT o.* FROM retention_objects o JOIN retention_jobs j ON j.id=o.job_id WHERE j.asset_id=? ORDER BY o.id', f.first.id),
        await f.db.one('SELECT * FROM assets WHERE id=?', f.first.id),
      ];
    }
    return value;
  };
  const result = await run(f, 2); assert(fired); assert(result.failed > 0); assert.equal(result.verified, 1);
  assert.deepEqual(calls, [good.key]); await unchanged(f, f.first, ...before);
});

// Same synthetic subject throughout. These cases preserve both database rows
// and in-memory bytes; they do not certify provider terminality or restore.
async function seedVerifiedPreview(f, a) {
  const id = await addJob(f.h.db, f, a, { kind: 'preview', status: 'verified', policy: 1 });
  await f.h.db.run('DELETE FROM retention_objects WHERE job_id=?', id);
  await f.h.db.run("UPDATE retention_settings SET version=2 WHERE id='default'");
  return id;
}
async function addPreviewMismatch(f, a, jobID, kind, db = f.h.db) {
  const key = `synthetic/${f.owner}/preview/${randomUUID()}`, id = randomUUID();
  if (kind === 'attempt') {
    await db.run(`INSERT INTO processing_attempts(id,asset_id,source_version,source_checksum_sha256,model_version,status,captured_at,expires_at,owner_id,source,rendition_key)
      VALUES(?,?,?,?,?,'completed',?, ?,?,'personal',?)`, id, a.id, a.version, 'a'.repeat(64), 'synthetic-model', f.now, f.now + DAY, f.owner, key);
  } else {
    await db.run(`INSERT INTO renditions(id,asset_id,object_key,content_type,byte_size,checksum_sha256,source_checksum_sha256,version,status)
      VALUES(?,?,?,'image/png',3,?,?,?,'ready')`, id, a.id, key, 'a'.repeat(64), 'b'.repeat(64), randomUUID());
    if (kind === 'ready-recorded') await db.run(`INSERT INTO retention_objects(id,job_id,bucket,object_key,status,attempts,created_at,verified_at)
      VALUES(?,?,'PHOTOS',?,'verified',1,?,?)`, randomUUID(), jobID, key, f.now, f.now);
  }
  await f.h.env.PHOTOS.put(key, new Uint8Array([9, 8, 7]));
  return { id, key, table: kind === 'attempt' ? 'processing_attempts' : 'renditions' };
}
function watchPhotos(f) {
  const calls = [], remove = f.h.env.PHOTOS.delete.bind(f.h.env.PHOTOS);
  f.h.env.PHOTOS.delete = async key => { calls.push(key); return remove(key); };
  return calls;
}

for (const kind of ['rendition', 'ready-recorded', 'attempt']) test(`a raw-due asset with ${kind} preview inventory conflict is preserved before LIMIT`, async t => {
  const f = await setup(t), good = await makeAsset(f, 70), calls = watchDeletes(f), photos = watchPhotos(f);
  await f.h.db.run('UPDATE asset_retention SET raw_expires_at=?,preview_expires_at=? WHERE asset_id=?', f.now - DAY, f.now - DAY, f.first.id);
  const jobID = await seedVerifiedPreview(f, f.first), changed = await addPreviewMismatch(f, f.first, jobID, kind);
  const before = [await rows(f, f.first), await objects(f, f.first), await asset(f, f.first)];
  const changedBefore = await f.h.db.one('SELECT * FROM ' + changed.table + ' WHERE id=?', changed.id);
  for (let round = 0; round < 2; round++) {
    const result = await run(f, 1); assert(result.failed > 0); assert.equal(result.verified, round === 0 ? 1 : 0);
    assert.deepEqual(calls, [good.key]); assert.deepEqual(photos, []); await unchanged(f, f.first, ...before);
    assert.deepEqual(await f.h.db.one('SELECT * FROM ' + changed.table + ' WHERE id=?', changed.id), changedBefore);
    assert(await f.h.env.PHOTOS.head(changed.key)); assert.equal(await f.journal.lookup(await op(f, f.first)), null);
  }
});

test('a new attempt key stays quarantined as the raw deadline becomes due', async t => {
  const f = await setup(t), firstGood = await makeAsset(f, 70), calls = watchDeletes(f), photos = watchPhotos(f);
  await f.h.db.run('UPDATE asset_retention SET raw_expires_at=?,preview_expires_at=? WHERE asset_id=?', f.now + DAY, f.now - DAY, f.first.id);
  const jobID = await seedVerifiedPreview(f, f.first), changed = await addPreviewMismatch(f, f.first, jobID, 'attempt');
  const before = [await rows(f, f.first), await objects(f, f.first), await asset(f, f.first)];
  const attempt = await f.h.db.one('SELECT * FROM processing_attempts WHERE id=?', changed.id);
  const initial = await run(f, 1); assert(initial.failed > 0); assert.equal(initial.verified, 1);
  assert.deepEqual(calls, [firstGood.key]); assert.deepEqual(photos, []); await unchanged(f, f.first, ...before);
  await f.h.db.run('UPDATE asset_retention SET raw_expires_at=? WHERE asset_id=?', f.now - DAY, f.first.id);
  const secondGood = await makeAsset(f, 69), due = await run(f, 1);
  assert(due.failed > 0); assert.equal(due.verified, 1); assert.deepEqual(calls, [firstGood.key, secondGood.key]);
  assert.deepEqual(photos, []); await unchanged(f, f.first, ...before);
  assert.deepEqual(await f.h.db.one('SELECT * FROM processing_attempts WHERE id=?', changed.id), attempt);
  assert(await f.h.env.PHOTOS.head(changed.key)); assert.equal(await f.journal.lookup(await op(f, f.first)), null);
});

for (const kind of ['rendition', 'attempt']) test(`a committed ${kind} key after initial selection stops raw expiry before independent prepare`, async t => {
  const f = await setup(t), good = await makeAsset(f, 70), calls = watchDeletes(f), photos = watchPhotos(f);
  await f.h.db.run('UPDATE asset_retention SET raw_expires_at=?,preview_expires_at=? WHERE asset_id=?', f.now - DAY, f.now - DAY, f.first.id);
  const jobID = await seedVerifiedPreview(f, f.first), all = f.db.all.bind(f.db); let armed = false, inserted = false, changed, before, changedBefore;
  f.db.all = async (sql, ...args) => { const value = await all(sql, ...args); if (sql.startsWith('SELECT a.* FROM assets a LEFT JOIN asset_retention')) armed = true; return value; };
  // Synthetic fixture writer commits after the actual scan COMMIT. It is not a
  // claim that a production writer participates in independent replay.
  f.faults.afterCommit = async () => {
    if (armed && !inserted) {
      delete f.faults.afterCommit; inserted = true; changed = await addPreviewMismatch(f, f.first, jobID, kind);
      before = [await rows(f, f.first), await objects(f, f.first), await asset(f, f.first)];
      changedBefore = await f.h.db.one('SELECT * FROM ' + changed.table + ' WHERE id=?', changed.id);
    }
  };
  const result = await run(f, 2); assert(inserted); assert(result.failed > 0); assert.equal(result.verified, 1);
  assert.deepEqual(calls, [good.key]); assert.deepEqual(photos, []); await unchanged(f, f.first, ...before);
  assert.deepEqual(await f.h.db.one('SELECT * FROM ' + changed.table + ' WHERE id=?', changed.id), changedBefore);
  assert(await f.h.env.PHOTOS.head(changed.key)); assert.equal(await f.journal.lookup(await op(f, f.first)), null);
});

test('an inventory mismatch remains visible and blocks an already-retired raw job before claim', async t => {
  const f = await setup(t), good = await makeAsset(f, 70), calls = watchDeletes(f), photos = watchPhotos(f);
  const jobID = await seedVerifiedPreview(f, f.first);
  await f.h.db.run("UPDATE assets SET status='expired',deleted_at=? WHERE id=?", f.now, f.first.id);
  await addJob(f.h.db, f, f.first, { kind: 'raw', status: 'pending', policy: 2 });
  const changed = await addPreviewMismatch(f, f.first, jobID, 'attempt');
  const before = [await rows(f, f.first), await objects(f, f.first), await asset(f, f.first)];
  const attempt = await f.h.db.one('SELECT * FROM processing_attempts WHERE id=?', changed.id);
  const result = await run(f, 1); assert(result.failed > 0); assert.equal(result.verified, 1);
  assert.deepEqual(calls, [good.key]); assert.deepEqual(photos, []); await unchanged(f, f.first, ...before);
  assert.deepEqual(await f.h.db.one('SELECT * FROM processing_attempts WHERE id=?', changed.id), attempt);
  assert(await f.h.env.PHOTOS.head(changed.key));
});

test('a preview key appearing after a raw claim prevents its DELETE and preserves the claimed evidence', async t => {
  const f = await setup(t), good = await makeAsset(f, 70), calls = watchDeletes(f), photos = watchPhotos(f);
  const previewID = await seedVerifiedPreview(f, f.first);
  await f.h.db.run("UPDATE assets SET status='expired',deleted_at=? WHERE id=?", f.now, f.first.id);
  const rawID = await addJob(f.h.db, f, f.first, { kind: 'raw', status: 'pending', policy: 2 });
  await f.h.db.run('UPDATE retention_jobs SET binding_json=? WHERE id=?', stable({object_key:f.first.key,checksum:null,retention_version:1,deleted_at:f.now}), rawID);
  const all = f.db.all.bind(f.db); let depth = 0, fired = false, changed, before;
  f.db.all = async (sql, ...args) => {
    depth++; let value; try { value = await all(sql, ...args); } finally { depth--; }
    if (!fired && depth === 0 && sql.startsWith('SELECT * FROM retention_objects WHERE job_id=') && args[0] === rawID) {
      fired = true; changed = await addPreviewMismatch(f, f.first, previewID, 'rendition', f.db);
      before = [await rows(f, f.first), await objects(f, f.first), await asset(f, f.first)];
    }
    return value;
  };
  const result = await run(f, 2); assert(fired); assert(result.failed > 0); assert.equal(result.verified, 1);
  assert.deepEqual(calls, [good.key]); assert.deepEqual(photos, []); await unchanged(f, f.first, ...before);
  assert.equal((await f.h.db.one('SELECT status FROM renditions WHERE id=?', changed.id)).status, 'ready');
  assert(await f.h.env.PHOTOS.head(changed.key));
});

test('a raw deadline earlier than the preview deadline still reports and quarantines a new key', async t => {
  const f = await setup(t), good = await makeAsset(f, 70), calls = watchDeletes(f), photos = watchPhotos(f);
  await f.h.db.run('UPDATE asset_retention SET raw_expires_at=?,preview_expires_at=? WHERE asset_id=?', f.now - DAY, f.now + DAY, f.first.id);
  const jobID = await seedVerifiedPreview(f, f.first), changed = await addPreviewMismatch(f, f.first, jobID, 'attempt');
  const before = [await rows(f, f.first), await objects(f, f.first), await asset(f, f.first)];
  const attempt = await f.h.db.one('SELECT * FROM processing_attempts WHERE id=?', changed.id);
  const result = await run(f, 1); assert(result.failed > 0); assert.equal(result.verified, 1);
  assert.deepEqual(calls, [good.key]); assert.deepEqual(photos, []); await unchanged(f, f.first, ...before);
  assert.deepEqual(await f.h.db.one('SELECT * FROM processing_attempts WHERE id=?', changed.id), attempt);
  assert(await f.h.env.PHOTOS.head(changed.key)); assert.equal(await f.journal.lookup(await op(f, f.first)), null);
});
