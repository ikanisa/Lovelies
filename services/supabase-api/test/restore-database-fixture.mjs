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

const folder = new URL('../../../supabase/migrations/', import.meta.url);
const migration = fs.readFileSync(new URL('20261026132612_restore_control.sql', folder), 'utf8');
const baselineNames = ['20261023162016_lovelies_private_core.sql', '20261023210000_refresh_delivery.sql',
  '20261024170000_audience_retention.sql', '20261024180000_inference_generation.sql', '20261024190000_retention_scan_cursors.sql'];
const input = value => ({ version: 1, project_id: RESTORE_PROJECT_ID, ...value });
const numberRows = rows => rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value])));
const digest = value => createHash('sha256').update(value).digest('hex');
const unavailable = error => error instanceof ApiError && error.status === 503 &&
  ['restore_reconciliation_required', 'restore_journal_unavailable'].includes(error.code) && error.message === error.code;
const readOnly = error => error?.code === '25006';
const asBackend = async (engine, callback) => {
  await engine.exec('SET ROLE lovelies_api');
  try { return await callback(); } finally { await engine.exec('RESET ROLE'); }
};
const rawRows = async (h, sql, values = []) => numberRows((await h.engine.query(sql, values)).rows);
const privateRows = (h, sql, values = []) => asBackend(h.engine, () => rawRows(h, sql, values));
const rowCount = async (h, table) => Number((await privateRows(h, 'SELECT count(*) AS n FROM lovelies_private.' + table))[0].n);
const controlRow = async h => (await privateRows(h, 'SELECT * FROM lovelies_private.restore_control WHERE singleton=1'))[0] ?? null;

async function installMarker(h, marker, operationId = null, planHash = null) {
  await asBackend(h.engine, () => h.engine.query(`INSERT INTO lovelies_private.restore_control
    (singleton,project_id,database_id,incarnation_id,checkpoint_revision,checkpoint_hash,journal_sequence,journal_hash,last_operation_id,last_plan_hash)
    VALUES(1,$1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT(singleton) DO UPDATE SET project_id=excluded.project_id,database_id=excluded.database_id,
      incarnation_id=excluded.incarnation_id,checkpoint_revision=excluded.checkpoint_revision,checkpoint_hash=excluded.checkpoint_hash,
      journal_sequence=excluded.journal_sequence,journal_hash=excluded.journal_hash,last_operation_id=excluded.last_operation_id,last_plan_hash=excluded.last_plan_hash`,
  [RESTORE_PROJECT_ID, marker.database_id, marker.incarnation_id, marker.checkpoint.revision, marker.checkpoint.hash,
    marker.cursor.sequence, marker.cursor.hash, operationId, planHash]));
}

/** Real PostgreSQL when the existing disposable test lane is selected. The
 * PGlite fallback serializes one backend and substitutes only its unsupported
 * advisory lock. No SQL result, URL, bindings or credentials are logged. */
function databaseConnection(h, trace, faults) {
  const native = h.databaseUrl ? postgres(h.databaseUrl, { prepare: false, max: 1, ssl: false, onnotice: () => {},
    types: { bigint: { to: 20, from: [20], serialize: String, parse: value => {
      const number = Number(value); if (!Number.isSafeInteger(number)) throw Error('unsafe_fixture_integer'); return number;
    } } } }) : null;
  let tail = Promise.resolve();
  const query = runner => async (sql, values) => {
    trace.push({ kind: 'sql', sql });
    if (faults.controlUpdate && /^UPDATE restore_control SET/.test(sql)) {
      faults.controlUpdate = false; throw Error('synthetic_control_update_failure');
    }
    if (!native && sql.startsWith('SELECT pg_advisory_xact_lock(')) return [];
    return numberRows(native ? Array.from(await runner.unsafe(sql, values)) : (await h.engine.query(sql, values)).rows);
  };
  const connection = { query: query(native), begin: callback => {
    const operation = tail.then(async () => {
      await faults.beforeBegin?.();
      trace.push({ kind: 'begin' });
      let result;
      if (native) {
        result = await native.begin(async reserved => {
          const value = await callback({ query: query(reserved), begin: () => { throw Error('nested_raw_fixture_transaction'); } });
          if (faults.beforeCommit) { faults.beforeCommit = false; throw Error('synthetic_commit_rejected'); }
          return value;
        });
      } else {
        let committed = false;
        await h.engine.exec('BEGIN');
        try {
          result = await callback({ query: query(null), begin: () => { throw Error('nested_raw_fixture_transaction'); } });
          if (faults.beforeCommit) { faults.beforeCommit = false; throw Error('synthetic_commit_rejected'); }
          await h.engine.exec('COMMIT'); committed = true;
        } catch (error) { if (!committed) await h.engine.exec('ROLLBACK'); throw error; }
      }
      trace.push({ kind: 'postgres_committed' });
      await faults.afterCommit?.();
      // This loss occurs AFTER the actual database COMMIT has returned. It does
      // not fake a successful commit or invoke ROLLBACK on committed data.
      if (faults.commitReply) { faults.commitReply = false; throw Error('synthetic_commit_result_lost'); }
      return result;
    });
    tail = operation.catch(() => {}); return operation;
  }, close: async () => { await tail; await native?.end({ timeout: 5 }); } };
  return connection;
}

async function fixture(t, { seed = true } = {}) {
  const h = await startHarness({ consumeQueue: false }), trace = [], faults = {}, storage = new MemoryStorage();
  let db;
  t.after(async () => { try { await db?.close(); } finally { await h.close(); } });
  const version = Number((await privateRows(h, 'SELECT max(version) AS n FROM lovelies_private.schema_versions'))[0].n);
  assert.equal(version, 13);
  assert.equal(await rowCount(h, 'restore_control'), 0, 'default harness must never seed serving admission');
  let tick = 1_000;
  const rawJournal = async (path, body) => handleOperationRequest(new Request('https://journal.invalid' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + journalEnv.RESTORE_JOURNAL_TOKEN,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), journalEnv, storage, { now: () => ++tick });
  const response = await rawJournal('/v1/control/bootstrap', input({ database_id: randomUUID(), bootstrap_id: randomUUID() }));
  assert.equal(response.status, 200);
  const bootstrap = await response.json(), marker = bootstrap.binding.initial_marker;
  assert.equal(bootstrap.control.state, 'serving'); assert.equal(marker.cursor.sequence, 0);
  if (seed) await installMarker(h, marker);
  const journal = new RestoreJournalClient('https://journal.invalid', journalEnv.RESTORE_JOURNAL_TOKEN, { fetcher: async (url, init) => {
    const request = new Request(url, init), path = new URL(request.url).pathname;
    trace.push({ kind: 'journal', path });
    if (faults.offline || faults.control && path === '/v1/control') throw Error('synthetic_journal_unavailable');
    const lost = faults.reply?.path === path ? faults.reply : null;
    if (lost) delete faults.reply;
    if (lost?.stage === 'before') throw Error('synthetic_journal_request_not_delivered');
    const result = await handleOperationRequest(request, journalEnv, storage, { now: () => ++tick });
    trace.push({ kind: result.status === 200 ? 'journal_ok' : 'journal_denied', path });
    if (lost?.stage === 'after') { await result.body?.cancel(); throw Error('synthetic_journal_reply_lost'); }
    return result;
  } });
  db = new PostgresDatabase(databaseConnection(h, trace, faults), new RestoreDatabaseFence(journal));
  const queue = new PostgresJobQueue(db, () => 10_000);
  h.env.PHOTO_JOBS = queue;
  const context = { ...h.app, db };
  trace.length = 0;
  return { h, db, journal, storage, marker, trace, faults, queue, context, rawJournal };
}

const intent = (events = []) => ({ operation_id: randomUUID(), input_hash: digest('synthetic-logical-operation'), allocations: { id_0: randomUUID() }, events });
const insertAccount = (db, id, name = 'Synthetic account') => db.run('INSERT INTO accounts(id,name,created_at) VALUES(?,?,?)', id, name, 1_000);
async function seedAccount(h, id = randomUUID()) {
  await asBackend(h.engine, () => h.engine.query('INSERT INTO lovelies_private.accounts(id,name,created_at) VALUES($1,$2,$3)', [id, 'Preserved synthetic account', 1_000]));
  return id;
}
const userSql = trace => trace.filter(value => value.kind === 'sql' && !/^(SET TRANSACTION READ ONLY|SELECT pg_advisory_xact_lock\(|SET LOCAL ROLE |SET LOCAL search_path |SELECT project_id,database_id,incarnation_id,checkpoint_revision,checkpoint_hash,journal_sequence,journal_hash,last_operation_id,last_plan_hash FROM restore_control WHERE singleton=1|UPDATE restore_control SET)/.test(value.sql));

export { folder,migration,baselineNames,input,numberRows,digest,unavailable,readOnly,asBackend,rawRows,privateRows,rowCount,controlRow,installMarker,databaseConnection,fixture,intent,insertAccount,seedAccount,userSql };
