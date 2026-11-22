/** Staged, unexecuted single-subject tests. The harness uses PGlite and an
 * in-memory journal and Storage; no hosted database or provider is contacted. */
import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import { randomUUID } from 'node:crypto';
import { runRetention, scheduleExpiredAsset } from '../src/retention.ts';
import { restoreAllocationID, restoreOperationID } from '../src/restore-transaction.ts';
import { stable } from '../src/types.ts';
import { fixture, digest, unavailable } from './restore-database-fixture.mjs';

// Never run PGlite callbacks when a database target is defined, even empty.
const test = process.env.TEST_DATABASE_URL === undefined ? nodeTest : nodeTest.skip;

const DAY = 86400000;
async function setup(t, { previewOnly = false } = {}) {
  assert.equal(process.env.TEST_DATABASE_URL, undefined, 'external database forbidden');
  const f = await fixture(t), h = f.h;
  const person = await h.anonymous({ adult: true }), owner = person.account_id;
  const now = h.app.now(), id = randomUUID(), version = randomUUID(), key = `synthetic/${owner}/asset/${id}`;
  await h.db.run(`INSERT INTO retention_settings(id,version,raw_days,preview_days,face_crop_days,free_cache_days,audit_days,legal_hold,updated_at)
    VALUES('default',1,60,60,14,2,30,0,?) ON CONFLICT(id) DO NOTHING`, now);
  await h.db.run(`INSERT INTO assets(id,owner_id,source,status,object_key,content_type,byte_size,version,title,created_at)
    VALUES(?,?,'personal','ready',?,'image/png',3,?,'Synthetic fixture',?)`, id, owner, key, version, now - 70 * DAY);
  await h.db.run('INSERT INTO asset_retention(asset_id,raw_expires_at,preview_expires_at,legal_hold,version,updated_at) VALUES(?,?,?,?,?,?)',
    id, previewOnly ? now + DAY : now - DAY, previewOnly ? now - DAY : now + DAY, 0, 1, now);
  await h.env.QUARANTINE.put(key, new Uint8Array([1, 2, 3]));
  const scanned = await h.db.one('SELECT * FROM assets WHERE id=?', id);
  const policy = await h.db.one("SELECT * FROM retention_settings WHERE id='default'");
  const operationID = await restoreOperationID(owner, 'retention.raw-expiry-v1',
    'retention.raw:' + digest(stable({ asset_id: id, asset_version: version })));
  const call = () => f.db.invocation(() => scheduleExpiredAsset(f.context, policy, scanned));
  f.trace.length = 0;
  return { ...f, h, owner, id, version, key, now, policy, scanned, operationID, call };
}
const asset = f => f.h.db.one('SELECT * FROM assets WHERE id=?', f.id);
const jobs = f => f.h.db.all('SELECT * FROM retention_jobs WHERE asset_id=? ORDER BY id', f.id);
const event = f => ({ kind: 'asset-retired', scope: { owner_id: f.owner, asset_id: f.id, asset_version: f.version } });
async function pending(f) {
  const saved = await f.journal.lookup(f.operationID); assert(saved); return saved;
}

test('raw expiry records one exact event and stable job allocation, without deleting bytes', async t => {
  const f = await setup(t); await f.call();
  const saved = await pending(f), rows = await jobs(f);
  assert.equal(saved.status, 'committed');
  assert.deepEqual(saved.plan.events.map(({ kind, scope }) => ({ kind, scope })), [event(f)]);
  assert.deepEqual(saved.plan.allocations, { id_0: await restoreAllocationID(f.operationID, 'id_0') });
  assert.equal(rows.length, 1); assert.equal(rows[0].id, saved.plan.allocations.id_0);
  assert.equal(rows[0].status, 'pending'); assert.equal((await asset(f)).status, 'expired');
  assert(await f.h.env.QUARANTINE.head(f.key));
  assert(!JSON.stringify(saved.plan).includes(f.key), 'object path must not enter the independent fact');
  await f.call();
  assert.deepEqual(await jobs(f), rows); assert.deepEqual(await pending(f), saved);
});

for (const change of ['asset-replaced', 'request-hold', 'policy', 'pending-writer']) {
  test(`stale or held ${change} preserves the selected subject and records no expiry`, async t => {
    const f = await setup(t);
    if (change === 'asset-replaced') await f.h.db.run('UPDATE assets SET version=? WHERE id=?', randomUUID(), f.id);
    if (change === 'request-hold') await f.h.db.run(`INSERT INTO privacy_requests(id,subject_id,requested_by,request_type,status,created_at,expires_at,legal_hold)
      VALUES(?,?,?,'delete','pending_approval',?,?,1)`, randomUUID(), f.owner, f.owner, f.now, f.now + DAY);
    if (change === 'policy') await f.h.db.run("UPDATE retention_settings SET version=version+1 WHERE id='default'");
    if (change === 'pending-writer') await f.h.db.run(`INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at)
      VALUES(?,?,'QUARANTINE',?,'pending',?)`, randomUUID(), f.owner, f.key, f.now);
    const before = await asset(f); await f.call();
    assert.deepEqual(await asset(f), before); assert.deepEqual(await jobs(f), []);
    assert.equal(await f.journal.lookup(f.operationID), null); assert(await f.h.env.QUARANTINE.head(f.key));
  });
}

test('a hold becoming visible after fact registration rolls back before journal preparation', async t => {
  const f = await setup(t), request = randomUUID();
  await f.h.db.run(`INSERT INTO privacy_requests(id,subject_id,requested_by,request_type,status,created_at,expires_at,legal_hold)
    VALUES(?,?,?,'delete','pending_approval',?,?,0)`, request, f.owner, f.owner, f.now, f.now + DAY);
  const one = f.db.one.bind(f.db); let reads = 0, injected = false;
  f.db.one = async (sql, ...args) => {
    const value = await one(sql, ...args);
    if (sql === 'SELECT * FROM assets WHERE id=?' && ++reads === 2) {
      injected = true; await f.db.run('UPDATE privacy_requests SET legal_hold=1 WHERE id=?', request);
    }
    return value;
  };
  assert.equal(await f.call(), 'deferred_hold');
  assert(injected); assert.equal((await f.h.db.one('SELECT legal_hold FROM privacy_requests WHERE id=?', request)).legal_hold, 0);
  assert.deepEqual(await asset(f), f.scanned); assert.deepEqual(await jobs(f), []);
  assert.equal(await f.journal.lookup(f.operationID), null); assert(await f.h.env.QUARANTINE.head(f.key));
});

test('prepare not delivered rolls back and permits the original retry', async t => {
  const f = await setup(t); f.faults.reply = { path: '/v1/operations/prepare', stage: 'before' };
  await assert.rejects(f.call, unavailable); assert.deepEqual(await asset(f), f.scanned);
  assert.equal(await f.journal.lookup(f.operationID), null); await f.call();
  assert.equal((await pending(f)).status, 'committed');
});

for (const fault of ['prepare-reply-lost', 'sql-marker-update']) {
  test(`${fault} leaves a pending independent fact and refuses automatic replay after rollback`, async t => {
    const f = await setup(t);
    if (fault === 'prepare-reply-lost') f.faults.reply = { path: '/v1/operations/prepare', stage: 'after' };
    else f.faults.controlUpdate = true;
    if (fault === 'prepare-reply-lost') await assert.rejects(f.call, unavailable);
    else await assert.rejects(f.call, /synthetic_control_update_failure/);
    assert.deepEqual(await asset(f), f.scanned); assert.deepEqual(await jobs(f), []);
    const saved = await pending(f); assert.equal(saved.status, 'pending');
    assert.deepEqual(saved.plan.events.map(({ kind, scope }) => ({ kind, scope })), [event(f)]);
    await assert.rejects(f.call, unavailable); assert.deepEqual(await asset(f), f.scanned);
    assert(await f.h.env.QUARANTINE.head(f.key));
  });
}

test('lost commit reply is reconciled only from the exact committed marker', async t => {
  const f = await setup(t); f.faults.commitReply = true;
  await assert.rejects(f.call, /synthetic_commit_result_lost/);
  assert.equal((await pending(f)).status, 'pending');
  assert.equal((await asset(f)).status, 'expired'); assert.equal((await jobs(f)).length, 1);
  await f.db.invocation(() => f.db.read(() => {}));
  const saved = await pending(f); assert.equal(saved.status, 'committed');
  await f.call(); assert.deepEqual(await pending(f), saved); assert.equal((await jobs(f)).length, 1);
});

test('lost acknowledgement is recovered from the already committed independent plan', async t => {
  const f = await setup(t);
  f.faults.reply = { path: '/v1/operations/' + f.operationID + '/acknowledge', stage: 'after' };
  await assert.rejects(f.call, unavailable);
  assert.equal((await asset(f)).status, 'expired'); assert.equal((await jobs(f)).length, 1);
  const saved = await pending(f); assert.equal(saved.status, 'committed');
  await f.db.invocation(() => f.db.read(() => {}));
  await f.call(); assert.deepEqual(await pending(f), saved); assert.equal((await jobs(f)).length, 1);
});

test('preview-only scheduling does not invent an asset-retired fact', async t => {
  const f = await setup(t, { previewOnly: true }); await f.call();
  assert.equal((await asset(f)).deleted_at, null); assert.equal((await jobs(f))[0].kind, 'preview');
  assert.equal(await f.journal.lookup(f.operationID), null); assert(await f.h.env.QUARANTINE.head(f.key));
});

for (const target of ['asset', 'maintenance']) {
  test(`${target} refuses a joined transaction before any scheduling or provider call`, async t => {
    const f = await setup(t), bucket = f.h.env.QUARANTINE, remove = bucket.delete.bind(bucket), calls = [];
    bucket.delete = async key => { calls.push(key); return remove(key); };
    const action = target === 'asset' ? () => scheduleExpiredAsset(f.context, f.policy, f.scanned) : () => runRetention(f.context, 1);
    await assert.rejects(() => f.db.invocation(() => f.db.transaction(action)), error => error?.code === 'database_transaction_scope_invalid');
    assert.deepEqual(await asset(f), f.scanned); assert.deepEqual(await jobs(f), []); assert.deepEqual(calls, []);
    assert.equal(await f.journal.lookup(f.operationID), null); assert(await f.h.env.QUARANTINE.head(f.key));
  });
}

test('maintenance schedules a raw expiry once before synthetic in-memory cleanup', async t => {
  const f = await setup(t), calls = [], bucket = f.h.env.QUARANTINE, original = bucket.delete.bind(bucket);
  bucket.delete = async key => { assert.equal(key, f.key); calls.push(key); return original(key); };
  const result = await f.db.invocation(() => runRetention(f.context, 1));
  assert.equal(result.verified, 1); assert.deepEqual(calls, [f.key]);
  const saved = await pending(f); assert.equal(saved.status, 'committed');
  const again = await f.db.invocation(() => runRetention(f.context, 1));
  assert.equal(again.verified, 0); assert.deepEqual(calls, [f.key]); assert.deepEqual(await pending(f), saved);
});

test('one-item scans retain asset ordering and the untouched later subject asset', async t => {
  const f = await setup(t), nextID = randomUUID(), nextVersion = randomUUID();
  const nextKey = `synthetic/${f.owner}/asset/${nextID}`;
  await f.h.db.run(`INSERT INTO assets(id,owner_id,source,status,object_key,content_type,byte_size,version,title,created_at)
    VALUES(?,?,'personal','ready',?,'image/png',3,?,'Later synthetic fixture',?)`, nextID, f.owner, nextKey, nextVersion, f.now - 69 * DAY);
  await f.h.db.run('INSERT INTO asset_retention(asset_id,raw_expires_at,preview_expires_at,legal_hold,version,updated_at) VALUES(?,?,?,?,?,?)',
    nextID, f.now - DAY, f.now + DAY, 0, 1, f.now);
  await f.h.env.QUARANTINE.put(nextKey, new Uint8Array([4, 5, 6]));
  const bucket = f.h.env.QUARANTINE, remove = bucket.delete.bind(bucket), calls = [];
  bucket.delete = async key => { assert([f.key, nextKey].includes(key)); calls.push(key); return remove(key); };
  await f.db.invocation(() => runRetention(f.context, 1));
  assert.deepEqual(calls, [f.key]); assert.equal((await f.h.db.one('SELECT status FROM assets WHERE id=?', nextID)).status, 'ready');
  assert(await f.h.env.QUARANTINE.head(nextKey));
  await f.db.invocation(() => runRetention(f.context, 1));
  assert.deepEqual(calls, [f.key, nextKey]);
  const nextOperation = await restoreOperationID(f.owner, 'retention.raw-expiry-v1',
    'retention.raw:' + digest(stable({ asset_id: nextID, asset_version: nextVersion })));
  assert.equal((await f.journal.lookup(nextOperation)).status, 'committed');
});

test('a later prepare failure preserves the earlier committed raw expiry and stops cleanup', async t => {
  const f = await setup(t), nextID = randomUUID(), nextVersion = randomUUID();
  const nextKey = `synthetic/${f.owner}/asset/${nextID}`;
  await f.h.db.run(`INSERT INTO assets(id,owner_id,source,status,object_key,content_type,byte_size,version,title,created_at)
    VALUES(?,?,'personal','ready',?,'image/png',3,?,'Later synthetic fixture',?)`, nextID, f.owner, nextKey, nextVersion, f.now - 69 * DAY);
  await f.h.db.run('INSERT INTO asset_retention(asset_id,raw_expires_at,preview_expires_at,legal_hold,version,updated_at) VALUES(?,?,?,?,?,?)',
    nextID, f.now - DAY, f.now + DAY, 0, 1, f.now);
  await f.h.env.QUARANTINE.put(nextKey, new Uint8Array([4, 5, 6]));
  const nextOperation = await restoreOperationID(f.owner, 'retention.raw-expiry-v1',
    'retention.raw:' + digest(stable({ asset_id: nextID, asset_version: nextVersion })));
  const prepare = f.journal.prepare.bind(f.journal), remove = f.h.env.QUARANTINE.delete.bind(f.h.env.QUARANTINE), calls = [];
  f.h.env.QUARANTINE.delete = async key => { calls.push(key); return remove(key); };
  f.journal.prepare = async (input, ...args) => {
    if (input.operation_id === nextOperation) throw Error('synthetic_later_prepare_failure');
    return prepare(input, ...args);
  };
  await assert.rejects(() => f.db.invocation(() => runRetention(f.context, 2)), /synthetic_later_prepare_failure/);
  assert.equal((await asset(f)).status, 'expired'); assert.equal((await jobs(f))[0].status, 'pending');
  assert.equal((await f.h.db.one('SELECT status FROM assets WHERE id=?', nextID)).status, 'ready');
  assert.deepEqual(calls, []); assert(await f.h.env.QUARANTINE.head(f.key)); assert(await f.h.env.QUARANTINE.head(nextKey));
  assert.equal((await pending(f)).status, 'committed'); assert.equal(await f.journal.lookup(nextOperation), null);
  f.journal.prepare = prepare;
  await f.db.invocation(() => runRetention(f.context, 2));
  assert.equal((await f.journal.lookup(nextOperation)).status, 'committed');
  assert.deepEqual(new Set(calls), new Set([f.key, nextKey]));
});
