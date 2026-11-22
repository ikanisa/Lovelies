/** One synthetic subject; pending schedules must be present in their export.
 * No native/hosted database, provider or second-account scenario is selected. */
import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import { randomUUID } from 'node:crypto';
import { startHarness } from './runtime-harness.mjs';
import { retentionPrivacyRows } from '../src/retention.ts';

const test = process.env.TEST_DATABASE_URL === undefined ? nodeTest : nodeTest.skip;

test('pending retention plans export the sole subject and operator view before any job exists', async t => {
  assert.equal(process.env.TEST_DATABASE_URL, undefined);
  const h = await startHarness({ consumeQueue: false });
  t.after(() => h.close());
  const actor = await h.anonymous({ adult: true }), subject = actor.account_id;
  const asset = randomUUID(), command = randomUUID(), version = randomUUID(), operation = 'retention-export-' + randomUUID();
  const now = h.app.now(), snapshotHash = 'a'.repeat(64), planHash = 'b'.repeat(64);
  await h.db.run(`INSERT INTO assets(id,owner_id,source,status,object_key,content_type,byte_size,version,created_at)
    VALUES(?,?,'personal','ready',?,'image/png',3,?,?)`, asset, subject, 'synthetic/' + asset, version, now);
  await h.db.run(`INSERT INTO operations(actor_id,source,operation_key,action,payload_hash,payload_json,response_json,created_at)
    VALUES(?,'retention',?,'retention.schedule',?,'{}','{}',?)`, subject, operation, 'c'.repeat(64), now);
  await h.db.run(`INSERT INTO retention_schedule_commands(id,actor_id,source,operation_key,payload_hash,policy_json,limit_count,planned_count,next_position,plan_hash,created_at)
    VALUES(?,?,'retention',?,?,'{}',2,1,0,?,?)`, command, subject, operation, 'c'.repeat(64), planHash, now);
  await h.db.run(`INSERT INTO retention_schedule_items(command_id,position,asset_id,owner_id,source_version,snapshot_hash,outcome)
    VALUES(?,0,?,?,?,?, 'pending')`, command, asset, subject, version, snapshotHash);
  assert.equal((await h.db.one('SELECT count(*) n FROM retention_jobs')).n, 0);
  const result = await h.db.read(() => retentionPrivacyRows(h.app, subject));
  assert.deepEqual(result.retention_schedule_items, [{ asset_id: asset, source_version: version, outcome: 'pending', created_at: now }]);
  assert.deepEqual(result.retention_schedule_commands, [{ operation_key: operation, limit_count: 2, planned_count: 1, next_position: 0, created_at: now }]);
  assert.deepEqual(result.asset_retention, []);
  assert.deepEqual(result.retention_jobs, []);
  const encoded = JSON.stringify(result);
  for (const forbidden of [snapshotHash, planHash, command, subject, actor.access_token, 'snapshot_hash', 'plan_hash', 'actor_id', 'session_id'])
    assert(!encoded.includes(forbidden), 'internal schedule authority must not appear in the subject projection');
  // No second account is created. An unrelated identifier cannot select the
  // sole subject's assets or their operator command.
  const unrelated = await h.db.read(() => retentionPrivacyRows(h.app, randomUUID()));
  assert.deepEqual(unrelated.retention_schedule_items, []);
  assert.deepEqual(unrelated.retention_schedule_commands, []);
});

for (const collection of ['retention_schedule_items', 'retention_schedule_commands']) {
  test(`oversized ${collection} export fails before a partial projection is returned`, async () => {
    const db = { all: async sql => sql.includes('FROM ' + collection + ' ') ? Array.from({ length: 25001 }, () => ({})) : [] };
    await assert.rejects(retentionPrivacyRows({ db }, randomUUID()), error => error.status === 413 && error.code === 'privacy_export_too_large');
  });
}
