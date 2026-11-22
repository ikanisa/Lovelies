/** Unexecuted synthetic one-subject migration checks; no hosted database. */
import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import { randomUUID } from 'node:crypto';
import { fixture } from './restore-database-fixture.mjs';

// Never run PGlite callbacks when a database target is defined, even empty.
const test = process.env.TEST_DATABASE_URL === undefined ? nodeTest : nodeTest.skip;

test('v14 creates private forced-RLS saga tables without seeding authority or business rows', async t => {
  assert.equal(process.env.TEST_DATABASE_URL, undefined, 'external database forbidden');
  const f = await fixture(t), h = f.h;
  for (const table of ['retention_schedule_commands', 'retention_schedule_items', 'retention_schedule_commit_guards']) {
    const security = (await h.engine.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass", ['lovelies_private.' + table])).rows[0];
    assert.deepEqual(security, { relrowsecurity: true, relforcerowsecurity: true });
    for (const role of ['anon', 'authenticated', 'lovelies_api']) for (const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) {
      const value = (await h.engine.query('SELECT has_table_privilege($1,$2,$3) permitted', [role, 'lovelies_private.' + table, privilege])).rows[0];
      assert.equal(value.permitted, role === 'lovelies_api' && ['SELECT','INSERT','UPDATE','DELETE'].includes(privilege), role + ':' + table + ':' + privilege);
    }
    const policy = (await h.engine.query("SELECT policyname,roles FROM pg_policies WHERE schemaname='lovelies_private' AND tablename=$1", [table])).rows;
    assert.equal(policy.length, 1); assert.equal(policy[0].policyname, 'backend_only'); assert.deepEqual([...policy[0].roles], ['lovelies_api']);
    assert.equal((await h.db.one('SELECT count(*) n FROM ' + table)).n, 0);
  }
  for (const role of ['anon','authenticated']) assert.equal((await h.engine.query('SELECT pg_has_role($1,$2,$3) member', [role, 'lovelies_api', 'MEMBER'])).rows[0].member, false);
  const trigger = (await h.engine.query(`SELECT t.tgdeferrable,t.tginitdeferred,t.tgenabled,t.tgtype FROM pg_trigger t
    WHERE t.tgrelid='lovelies_private.retention_schedule_commit_guards'::regclass AND t.tgname='retention_schedule_commit_guard'`)).rows[0];
  assert.deepEqual({...trigger,tgtype:Number(trigger.tgtype)}, {tgdeferrable:true,tginitdeferred:true,tgenabled:'O',tgtype:5});
  for (const role of ['anon','authenticated']) assert.equal((await h.engine.query("SELECT has_function_privilege($1,'lovelies_private.retention_schedule_check_commit_guard()','EXECUTE') permitted", [role])).rows[0].permitted, false);
  assert.equal((await h.db.one('SELECT max(version) version FROM schema_versions')).version, 15);
});

test('asset and operation erasure cascade the plan without manufacturing a receipt', async t => {
  assert.equal(process.env.TEST_DATABASE_URL, undefined, 'external database forbidden');
  const f = await fixture(t), h = f.h, actor = await h.anonymous({ adult: true }), now = h.app.now();
  const asset = randomUUID(), version = randomUUID(), key = 'synthetic/' + asset, command = randomUUID(), operation = 'saga-test-' + randomUUID();
  await h.db.run("INSERT INTO assets(id,owner_id,source,status,object_key,content_type,byte_size,version,created_at) VALUES(?,?,'personal','ready',?,'image/png',3,?,?)", asset, actor.account_id, key, version, now);
  await h.db.run("INSERT INTO operations(actor_id,source,operation_key,action,payload_hash,payload_json,response_json,created_at) VALUES(?,'retention',?,'retention.schedule',?,'{}','{}',?)", actor.account_id, operation, 'a'.repeat(64), now);
  await h.db.run("INSERT INTO retention_schedule_commands(id,actor_id,source,operation_key,payload_hash,policy_json,limit_count,planned_count,next_position,plan_hash,created_at) VALUES(?,?,'retention',?,?,'{}',1,1,0,?,?)", command, actor.account_id, operation, 'a'.repeat(64), 'b'.repeat(64), now);
  await h.db.run("INSERT INTO retention_schedule_items(command_id,position,asset_id,owner_id,source_version,snapshot_hash,outcome) VALUES(?,0,?,?,?,?,'pending')", command, asset, actor.account_id, version, 'c'.repeat(64));
  await h.db.run('DELETE FROM assets WHERE id=?', asset);
  assert.equal((await h.db.one('SELECT count(*) n FROM retention_schedule_items WHERE command_id=?', command)).n, 0);
  assert.equal((await h.db.one('SELECT planned_count FROM retention_schedule_commands WHERE id=?', command)).planned_count, 1);
  await h.db.run("DELETE FROM operations WHERE actor_id=? AND source='retention' AND operation_key=?", actor.account_id, operation);
  assert.equal(await h.db.one('SELECT id FROM retention_schedule_commands WHERE id=?', command), null);
});
