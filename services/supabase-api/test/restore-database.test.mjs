import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { PGlite } from '@electric-sql/pglite';
import { PostgresDatabase } from '../src/database.ts';
import { RestoreDatabaseFence } from '../src/restore-database.ts';
import { RestoreJournalClient, RESTORE_PROJECT_ID } from '../src/restore-journal.ts';
import { ApiError } from '../src/types.ts';
import { PostgresJobQueue, drainJobs, maintain } from '../src/jobs.ts';
import { startHarness } from './runtime-harness.mjs';
import { isolatedPostgres } from './postgres-harness.mjs';
import { handleOperationRequest } from '../../restore-journal/src/operations.mjs';
import { MemoryStorage, env as journalEnv, event as restriction } from '../../restore-journal/test/fixtures.mjs';

import { folder,migration,baselineNames,input,numberRows,digest,unavailable,readOnly,asBackend,rawRows,privateRows,rowCount,controlRow,installMarker,databaseConnection,fixture,intent,insertAccount,seedAccount,userSql } from './restore-database-fixture.mjs';

test('automatic all/one/read admit under the reserved lock before business SQL and do not advance a checkpoint', async t => {
  const f = await fixture(t), account = await seedAccount(f.h);
  assert.deepEqual(await f.db.all('SELECT id FROM accounts WHERE id=?', account), [{ id: account }]);
  assert.equal((await f.db.one('SELECT id FROM accounts WHERE id=?', account)).id, account);
  await f.db.read(async () => {
    assert.equal((await f.db.one('SELECT id FROM accounts WHERE id=?', account)).id, account);
    await f.db.read(() => f.db.all('SELECT id FROM accounts WHERE id=?', account));
  });
  const reads = f.trace.filter(value => value.kind === 'journal' && value.path === '/v1/admission');
  assert.equal(reads.length, 3); assert.equal(userSql(f.trace).length, 4);
  let admitted = false;
  for (const entry of f.trace) {
    if (entry.kind === 'begin') admitted = false;
    if (entry.kind === 'journal_ok' && entry.path === '/v1/admission') admitted = true;
    if (userSql([entry]).length) assert.equal(admitted, true, 'business SQL preceded independent admission');
  }
  const firstLocal = f.trace.findIndex(value => value.kind === 'sql' && value.sql.startsWith('SELECT project_id'));
  assert(f.trace.findIndex(value => value.kind === 'sql' && value.sql.startsWith('SELECT pg_advisory_xact_lock(')) < firstLocal);
  assert.equal((await controlRow(f.h)).checkpoint_revision, 0);
  assert.equal((await f.journal.control()).state, 'serving');
});

test('independent outage denies automatic reads/run/explicit transactions and direct jobs before their business SQL or effects', async t => {
  const f = await fixture(t), account = await seedAccount(f.h), callbacks = [], effects = [];
  for (const name of ['PHOTOS', 'QUARANTINE', 'PRIVACY_EXPORTS']) for (const method of ['put', 'get', 'head', 'delete', 'list']) {
    f.h.env[name][method] = async () => { effects.push(name + '.' + method); throw Error('unexpected_external_effect'); };
  }
  f.faults.offline = true;
  for (const operation of [
    () => f.db.all('SELECT id FROM accounts WHERE id=?', account), () => f.db.one('SELECT id FROM accounts WHERE id=?', account),
    () => insertAccount(f.db, randomUUID()), () => f.db.read(() => { callbacks.push('read'); }),
    () => f.db.transaction(() => { callbacks.push('write'); }),
    () => f.queue.send({ category: 'photo', payload: { asset_id: randomUUID() } }),
    () => drainJobs(f.context), () => maintain(f.context),
  ]) await assert.rejects(operation, unavailable);
  assert.deepEqual(callbacks, []); assert.deepEqual(effects, []); assert.deepEqual(userSql(f.trace), []);
  assert.equal(await rowCount(f.h, 'accounts'), 1); assert.equal(await rowCount(f.h, 'job_queue'), 0);
  assert.equal((await controlRow(f.h)).checkpoint_revision, 0);
});

test('PostgreSQL READ ONLY rejects modifying CTEs and volatile-function DML independently of SQL spelling', async t => {
  const f = await fixture(t), cteId = randomUUID(), functionId = randomUUID();
  await f.h.engine.exec(`CREATE FUNCTION lovelies_private.restore_fixture_volatile_write() RETURNS integer
    LANGUAGE plpgsql VOLATILE AS $fixture$ BEGIN
      INSERT INTO lovelies_private.accounts(id,name,created_at) VALUES('${functionId}','Volatile fixture',1000);
      RETURN 1; END $fixture$;
    GRANT EXECUTE ON FUNCTION lovelies_private.restore_fixture_volatile_write() TO lovelies_api;`);
  await assert.rejects(() => f.db.all('WITH inserted AS (INSERT INTO accounts(id,name,created_at) VALUES(?,?,?) RETURNING id) SELECT id FROM inserted', cteId, 'CTE fixture', 1_000), readOnly);
  await assert.rejects(() => f.db.one('SELECT restore_fixture_volatile_write() AS written'), readOnly);
  await assert.rejects(() => f.db.read(() => f.db.all('UPDATE accounts SET name=? RETURNING id', 'Blocked update')), readOnly);
  assert.equal(await rowCount(f.h, 'accounts'), 0); assert.equal((await controlRow(f.h)).checkpoint_revision, 0);
  assert.equal((await f.journal.control()).state, 'serving');
  assert.equal(f.trace.filter(value => value.kind === 'journal' && value.path === '/v1/operations/prepare').length, 0);
});

test('nested write inside read and a different nested operation reject without SQL/checkpoint; joined writes checkpoint once', async t => {
  const f = await fixture(t), id = randomUUID(), nested = intent(); let callbacks = 0;
  for (const operation of [
    () => f.db.read(() => f.db.run('DELETE FROM accounts')),
    () => f.db.read(() => f.db.transaction(() => { callbacks++; })),
  ]) await assert.rejects(operation, error => error instanceof ApiError && error.code === 'read_only_transaction');
  await assert.rejects(() => f.db.transaction(async () => {
    await insertAccount(f.db, id);
    await f.db.transaction(() => { callbacks++; }, nested);
  }), error => error instanceof ApiError && error.code === 'nested_restore_operation');
  assert.equal(callbacks, 0); assert.equal(await rowCount(f.h, 'accounts'), 0);
  assert.equal((await controlRow(f.h)).checkpoint_revision, 0);
  await f.db.transaction(async () => {
    await insertAccount(f.db, id);
    await f.db.transaction(() => f.db.run('UPDATE accounts SET name=? WHERE id=?', 'Joined transaction', id));
  });
  assert.equal((await controlRow(f.h)).checkpoint_revision, 1);
  assert.equal((await f.db.one('SELECT name FROM accounts WHERE id=?', id)).name, 'Joined transaction');
});

test('automatic run and explicit/no-event mutation commit the exact checkpoint atomically with business data', async t => {
  const f = await fixture(t), id = randomUUID(), explicit = intent();
  await insertAccount(f.db, id);
  const first = await controlRow(f.h); assert.equal(first.checkpoint_revision, 1); assert.equal(first.journal_sequence, 0);
  assert(first.last_operation_id && first.last_plan_hash);
  await f.db.transaction(async () => {
    await f.db.run('UPDATE accounts SET name=? WHERE id=?', 'Explicit mutation', id);
    assert.equal((await f.db.one('SELECT name FROM accounts WHERE id=?', id)).name, 'Explicit mutation');
  }, explicit);
  const row = await controlRow(f.h), operation = await f.journal.lookup(explicit.operation_id);
  assert.equal(row.checkpoint_revision, 2); assert.equal(row.last_operation_id, explicit.operation_id); assert.equal(row.last_plan_hash, operation.plan_hash);
  assert.equal(row.checkpoint_hash, operation.plan.next.checkpoint.hash); assert.equal(row.journal_sequence, 0);
  assert.deepEqual(operation.plan.events, []); assert.deepEqual(operation.plan.receipts, []); assert.equal(operation.status, 'committed');
  await f.db.transaction(async () => {}, intent());
  assert.equal((await controlRow(f.h)).checkpoint_revision, 3, 'even an authoritative empty manifest advances the independent checkpoint');
  const prepareAt = f.trace.findIndex(value => value.kind === 'journal_ok' && value.path === '/v1/operations/prepare');
  const markerAt = f.trace.findIndex(value => value.kind === 'sql' && value.sql.startsWith('UPDATE restore_control SET'));
  const commitAt = f.trace.findIndex(value => value.kind === 'postgres_committed');
  const acknowledgeAt = f.trace.findIndex(value => value.kind === 'journal' && value.path.endsWith('/acknowledge'));
  assert(prepareAt < markerAt && markerAt < commitAt && commitAt < acknowledgeAt);
});

test('callback failure before prepare rolls back data without creating an independent pending operation', async t => {
  const f = await fixture(t), before = await controlRow(f.h), id = randomUUID();
  await assert.rejects(() => f.db.transaction(async () => { await insertAccount(f.db, id); throw Error('synthetic_callback_failure'); }), /synthetic_callback_failure/);
  assert.equal(await rowCount(f.h, 'accounts'), 0); assert.deepEqual(await controlRow(f.h), before);
  assert.equal((await f.journal.control()).state, 'serving');
  assert.equal(f.trace.filter(value => value.kind === 'journal' && value.path === '/v1/operations/prepare').length, 0);
});

test('accepted prepare with lost reply rolls PostgreSQL back and retains original allocations/restrictions without automatic replay', async t => {
  const f = await fixture(t), id = randomUUID(), operation = intent([restriction()]), initial = await controlRow(f.h); let callbacks = 0;
  f.faults.reply = { path: '/v1/operations/prepare', stage: 'after' };
  const callback = async () => { callbacks++; await insertAccount(f.db, id); };
  await assert.rejects(() => f.db.transaction(callback, operation), unavailable);
  assert.equal(callbacks, 1); assert.equal(await rowCount(f.h, 'accounts'), 0); assert.deepEqual(await controlRow(f.h), initial);
  const retained = await f.journal.lookup(operation.operation_id);
  assert.equal(retained.status, 'pending'); assert.deepEqual(retained.plan.allocations, operation.allocations); assert.deepEqual(retained.plan.events, operation.events);
  await assert.rejects(() => f.db.transaction(callback, operation), unavailable);
  await assert.rejects(() => f.db.one('SELECT count(*) AS n FROM accounts'), unavailable);
  assert.equal(callbacks, 1); assert.equal((await f.journal.control()).state, 'pending');
  assert.equal(f.trace.filter(value => value.kind === 'journal' && value.path === '/v1/operations/prepare').length, 1);
  for (const marker of [f.marker, retained.plan.next]) await assert.rejects(() => f.journal.admission(marker), unavailable);
  assert.equal((await f.journal.control()).state, 'pending');
});

for (const mode of ['controlUpdate', 'beforeCommit']) test(`prepared manifest with ${mode} failure preserves both SQL data/control rollback and independent pending intent`, async t => {
  const f = await fixture(t), id = randomUUID(), operation = intent([restriction()]), before = await controlRow(f.h); let callbacks = 0;
  f.faults[mode] = true;
  await assert.rejects(() => f.db.transaction(async () => { callbacks++; await insertAccount(f.db, id); }, operation),
    new RegExp(mode === 'controlUpdate' ? 'synthetic_control_update_failure' : 'synthetic_commit_rejected'));
  assert.equal(callbacks, 1); assert.equal(await rowCount(f.h, 'accounts'), 0); assert.deepEqual(await controlRow(f.h), before);
  assert.equal((await f.journal.lookup(operation.operation_id)).status, 'pending');
  await assert.rejects(() => f.db.one('SELECT count(*) AS n FROM accounts'), unavailable);
});

for (const stage of ['before', 'after']) test(`post-commit acknowledgement loss ${stage} service delivery reconciles only the exact durable PostgreSQL marker`, async t => {
  const f = await fixture(t), id = randomUUID(), operation = intent(); let callbacks = 0;
  f.faults.reply = { path: '/v1/operations/' + operation.operation_id + '/acknowledge', stage };
  await assert.rejects(() => f.db.transaction(async () => { callbacks++; await insertAccount(f.db, id); }, operation), unavailable);
  assert.equal(callbacks, 1); assert.equal(await rowCount(f.h, 'accounts'), 1);
  const committedRow = await controlRow(f.h), retained = await f.journal.lookup(operation.operation_id);
  assert.equal(committedRow.checkpoint_revision, 1); assert.equal(committedRow.last_plan_hash, retained.plan_hash);
  assert.equal(retained.status, stage === 'before' ? 'pending' : 'committed');
  assert.equal((await f.db.one('SELECT id FROM accounts WHERE id=?', id)).id, id);
  assert.deepEqual(await controlRow(f.h), committedRow); assert.equal(callbacks, 1);
  assert.equal((await f.journal.lookup(operation.operation_id)).status, 'committed'); assert.equal((await f.journal.control()).state, 'serving');
  assert.equal(f.trace.filter(value => value.kind === 'journal' && value.path.endsWith('/acknowledge')).length, stage === 'before' ? 2 : 1);
});

test('lost COMMIT result after a real database commit is reconciled by marker/hash without rerunning the callback', async t => {
  const f = await fixture(t), operation = intent(), id = randomUUID(); let callbacks = 0;
  f.faults.commitReply = true;
  await assert.rejects(() => f.db.transaction(async () => { callbacks++; await insertAccount(f.db, id); }, operation), /synthetic_commit_result_lost/);
  assert.equal(await rowCount(f.h, 'accounts'), 1); assert.equal((await controlRow(f.h)).last_operation_id, operation.operation_id);
  assert.equal((await f.journal.lookup(operation.operation_id)).status, 'pending');
  assert.equal(f.trace.filter(value => value.kind === 'journal' && value.path.endsWith('/acknowledge')).length, 0);
  assert.equal((await f.db.one('SELECT id FROM accounts WHERE id=?', id)).id, id);
  assert.equal(callbacks, 1); assert.equal((await f.journal.lookup(operation.operation_id)).status, 'committed');
});

test('a pending successor with corrupted operation receipt fields is never repaired or acknowledged automatically', async t => {
  const f = await fixture(t), operation = intent(), id = randomUUID();
  f.faults.reply = { path: '/v1/operations/' + operation.operation_id + '/acknowledge', stage: 'before' };
  await assert.rejects(() => f.db.transaction(() => insertAccount(f.db, id), operation), unavailable);
  await asBackend(f.h.engine, () => f.h.engine.query('UPDATE lovelies_private.restore_control SET last_plan_hash=$1 WHERE singleton=1', ['e'.repeat(64)]));
  const before = await controlRow(f.h); f.trace.length = 0;
  await assert.rejects(() => f.db.one('SELECT id FROM accounts WHERE id=?', id), unavailable);
  assert.deepEqual(await controlRow(f.h), before); assert.deepEqual(userSql(f.trace), []);
  assert.equal(f.trace.filter(value => value.kind === 'journal' && value.path.endsWith('/acknowledge')).length, 0);
  assert.equal((await f.journal.control()).state, 'pending');
});

test('same-version PostgreSQL snapshot rollback quarantines independently and denies reads, writes and jobs without changing restored rows', async t => {
  const f = await fixture(t), id = await seedAccount(f.h), version = (await privateRows(f.h, 'SELECT max(version) AS n FROM lovelies_private.schema_versions'))[0].n;
  await f.db.run('UPDATE accounts SET name=? WHERE id=?', 'Post-backup value', id);
  const independentlyCurrent = await f.journal.control(); assert.equal(independentlyCurrent.marker.checkpoint.revision, 1);
  // Explicit disposable-fixture restore of the old control and account snapshot.
  // The schema version is unchanged, exactly the condition the new gate detects.
  await installMarker(f.h, f.marker);
  await asBackend(f.h.engine, () => f.h.engine.query('UPDATE lovelies_private.accounts SET name=$1 WHERE id=$2', ['Preserved synthetic account', id]));
  const restored = await controlRow(f.h); f.trace.length = 0;
  await assert.rejects(() => f.db.one('SELECT name FROM accounts WHERE id=?', id), unavailable);
  assert.equal((await f.journal.control()).state, 'quarantined');
  for (const operation of [
    () => insertAccount(f.db, randomUUID()), () => f.db.transaction(() => { throw Error('callback_must_not_run'); }),
    () => f.queue.send({ category: 'photo', payload: { asset_id: randomUUID() } }), () => drainJobs(f.context), () => maintain(f.context),
  ]) await assert.rejects(operation, unavailable);
  assert.deepEqual(userSql(f.trace), []); assert.deepEqual(await controlRow(f.h), restored);
  assert.equal((await privateRows(f.h, 'SELECT name FROM lovelies_private.accounts WHERE id=$1', [id]))[0].name, 'Preserved synthetic account');
  assert.equal((await privateRows(f.h, 'SELECT max(version) AS n FROM lovelies_private.schema_versions'))[0].n, version);
  assert.equal(await rowCount(f.h, 'accounts'), 1); assert.equal(await rowCount(f.h, 'job_queue'), 0);
});

test('missing control row/table fail before journal or business SQL and never bootstrap or seed themselves', async t => {
  const f = await fixture(t, { seed: false });
  for (const operation of [() => f.db.one('SELECT count(*) AS n FROM accounts'), () => insertAccount(f.db, randomUUID()),
    () => f.queue.send({ category: 'photo', payload: { asset_id: randomUUID() } })]) await assert.rejects(operation, unavailable);
  assert.equal(await rowCount(f.h, 'restore_control'), 0); assert.equal(f.trace.filter(value => value.kind === 'journal').length, 0);
  assert.deepEqual(userSql(f.trace), []);
  await f.h.engine.exec('DROP TABLE lovelies_private.restore_control');
  await assert.rejects(() => f.db.one('SELECT count(*) AS n FROM accounts'), unavailable);
  assert.equal((await rawRows(f.h, "SELECT to_regclass('lovelies_private.restore_control') AS name"))[0].name, null);
  assert.equal((await f.journal.control()).marker.checkpoint.revision, 0);
});

async function migrationBaseline(t) {
  const local = process.env.TEST_DATABASE_URL ? await isolatedPostgres(process.env.TEST_DATABASE_URL) : null;
  const engine = local?.engine ?? await PGlite.create();
  t.after(() => engine.close());
  if (!local) await engine.exec('CREATE ROLE anon; CREATE ROLE authenticated;');
  for (const name of baselineNames) await engine.exec(fs.readFileSync(new URL(name, folder), 'utf8'));
  return { engine };
}
async function tableHashes(h) {
  const names = (await rawRows(h, "SELECT tablename FROM pg_tables WHERE schemaname='lovelies_private' ORDER BY tablename")).map(row => row.tablename);
  return asBackend(h.engine, async () => {
    const result = {};
    for (const name of names) {
      assert.match(name, /^[a-z_]+$/);
      result[name] = digest(JSON.stringify(await rawRows(h, `SELECT to_jsonb(t) AS row FROM lovelies_private."${name}" t ORDER BY to_jsonb(t)::text`)));
    }
    return result;
  });
}
const protection = h => rawRows(h, `SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c
  JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='lovelies_private' AND c.relkind='r' ORDER BY c.relname`);

test('additive v12 preserves all v11 data/protection and creates one empty forced-RLS backend-only constrained control table', async t => {
  const h = await migrationBaseline(t), id = await seedAccount(h), asset = randomUUID();
  await asBackend(h.engine, () => h.engine.query(`INSERT INTO lovelies_private.assets(id,owner_id,source,status,object_key,content_type,byte_size,version)
    VALUES($1,$2,'personal','ready','synthetic/preserved/photo','image/jpeg',123,'preserved-version')`, [asset, id]));
  const before = await tableHashes(h), beforeProtection = await protection(h);
  const history = await privateRows(h, 'SELECT version,applied_at FROM lovelies_private.schema_versions ORDER BY version');
  assert.equal(Object.keys(before).length, 68); assert.equal(Number(history.at(-1).version), 11);
  const migrator = (await rawRows(h, 'SELECT current_user AS role'))[0].role;
  await h.engine.exec(migration);
  assert.equal((await rawRows(h, 'SELECT current_user AS role'))[0].role, migrator);
  const after = await tableHashes(h), afterProtection = await protection(h);
  assert.equal(Object.keys(after).length, 69);
  for (const [name, hash] of Object.entries(before)) if (name !== 'schema_versions') assert.equal(after[name], hash, name + ' changed during additive migration');
  assert.deepEqual(afterProtection.filter(row => row.relname !== 'restore_control'), beforeProtection);
  assert.deepEqual(afterProtection.find(row => row.relname === 'restore_control'), { relname: 'restore_control', relrowsecurity: true, relforcerowsecurity: true });
  const afterHistory = await privateRows(h, 'SELECT version,applied_at FROM lovelies_private.schema_versions ORDER BY version');
  assert.deepEqual(afterHistory.slice(0, history.length), history); assert.equal(Number(afterHistory.at(-1).version), 12);
  assert.equal(await rowCount(h, 'restore_control'), 0);
  const policies = await rawRows(h, "SELECT policyname,roles,cmd FROM pg_policies WHERE schemaname='lovelies_private' AND tablename='restore_control'");
  assert.deepEqual(policies, [{ policyname: 'backend_only', roles: ['lovelies_api'], cmd: 'ALL' }]);
  for (const client of ['anon', 'authenticated']) {
    assert.equal((await rawRows(h, "SELECT has_table_privilege($1,'lovelies_private.restore_control','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS permitted", [client]))[0].permitted, false);
    await h.engine.exec('SET ROLE ' + client);
    try { await assert.rejects(() => h.engine.query('SELECT * FROM lovelies_private.restore_control'), error => error?.code === '42501'); }
    finally { await h.engine.exec('RESET ROLE'); }
  }
  const marker = { database_id: randomUUID(), incarnation_id: randomUUID(), checkpoint: { revision: 0, hash: 'a'.repeat(64) }, cursor: { sequence: 0, hash: '0'.repeat(64) } };
  await installMarker(h, marker); const initial = await controlRow(h);
  for (const [column, value] of [['singleton', 2], ['project_id', 'foreign-project'], ['database_id', 'not-a-uuid'], ['incarnation_id', 'not-a-uuid'],
    ['checkpoint_revision', -1], ['checkpoint_revision', 9007199254740992], ['checkpoint_hash', 'bad-hash'], ['journal_sequence', -1],
    ['journal_sequence', 9007199254740992], ['journal_hash', 'bad-hash'], ['last_operation_id', randomUUID()], ['last_plan_hash', 'b'.repeat(64)]]) {
    await asBackend(h.engine, () => assert.rejects(() => h.engine.query('UPDATE lovelies_private.restore_control SET ' + column + '=$1 WHERE singleton=1', [value]), error => error?.code === '23514'));
  }
  await asBackend(h.engine, () => assert.rejects(() => h.engine.query('UPDATE lovelies_private.restore_control SET checkpoint_revision=1 WHERE singleton=1'), error => error?.code === '23514'));
  await asBackend(h.engine, () => assert.rejects(() => h.engine.query('UPDATE lovelies_private.restore_control SET checkpoint_hash=NULL WHERE singleton=1'), error => error?.code === '23502'));
  assert.deepEqual(await controlRow(h), initial);
});

test('v12 refuses a non-v11 baseline and leaves no control table or v12 marker', async t => {
  const h = await migrationBaseline(t);
  await asBackend(h.engine, () => h.engine.exec('DELETE FROM lovelies_private.schema_versions WHERE version=11'));
  await assert.rejects(() => h.engine.exec(migration), /restore_control_requires_schema_v11/);
  assert.equal((await rawRows(h, "SELECT to_regclass('lovelies_private.restore_control') AS name"))[0].name, null);
  assert.equal(Number((await privateRows(h, 'SELECT max(version) AS n FROM lovelies_private.schema_versions'))[0].n), 10);
});
