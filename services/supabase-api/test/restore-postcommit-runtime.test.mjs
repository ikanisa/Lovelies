import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PostgresDatabase } from '../src/database.ts';
import { RestoreDatabaseFence } from '../src/restore-database.ts';
import {
  fixture, databaseConnection, controlRow, intent, insertAccount, unavailable,
  seedAccount, privateRows, asBackend,
} from './restore-database-fixture.mjs';

// These schedules require independent PostgreSQL backends and their actual
// advisory locks. The embedded single-backend fallback cannot qualify them.
const actualPostgres = {
  skip: process.env.TEST_DATABASE_URL ? false : 'Actual PostgreSQL TEST_DATABASE_URL required; no embedded fallback',
  timeout: 60_000,
};
const ackPath = operation => '/v1/operations/' + operation.operation_id + '/acknowledge';
const ackCalls = (trace, operation) => trace.filter(entry => entry.kind === 'journal' && entry.path === ackPath(operation)).length;

test('actual PostgreSQL second pool can acknowledge and advance before the original pool resumes without callback replay or false failure', actualPostgres, async t => {
  const f = await fixture(t), first = intent(), second = intent(), id = randomUUID();
  const held = Promise.withResolvers(), resume = Promise.withResolvers();
  const otherTrace = [], otherFaults = {};
  const other = new PostgresDatabase(databaseConnection(f.h, otherTrace, otherFaults), new RestoreDatabaseFence(f.journal));
  let firstCallbacks = 0, secondCallbacks = 0, firstPending;
  const outcome = { account_id: id, outcome: 'original_first_result' };
  f.faults.afterCommit = async () => {
    // Stop only the originating mutation after its REAL COMMIT, before its
    // independent post-commit reconciliation transaction can acquire the lock.
    delete f.faults.afterCommit;
    held.resolve();
    await resume.promise;
  };
  try {
    firstPending = f.db.transaction(async () => {
      firstCallbacks++;
      await insertAccount(f.db, id, 'First committed value');
      return outcome;
    }, first);
    // Observe a premature rejection while waiting instead of leaving a blocked
    // fixture behind when an earlier admission/prepare stage fails.
    await Promise.race([held.promise, firstPending.then(() => {
      throw Error('originating_commit_was_not_held');
    })]);
    const firstRow = await controlRow(f.h);
    assert.equal(firstRow.checkpoint_revision, 1);
    assert.equal(firstRow.last_operation_id, first.operation_id);
    assert.equal((await f.journal.control()).state, 'pending');

    const secondResult = await other.transaction(async () => {
      secondCallbacks++;
      assert.equal((await other.one('SELECT name FROM accounts WHERE id=?', id)).name, 'First committed value');
      await other.run('UPDATE accounts SET name=? WHERE id=?', 'Second committed value', id);
      return { outcome: 'second_result' };
    }, second);
    assert.deepEqual(secondResult, { outcome: 'second_result' });
    const advanced = await controlRow(f.h);
    assert.equal(advanced.checkpoint_revision, 2);
    assert.equal(advanced.last_operation_id, second.operation_id);
    assert.equal((await f.journal.lookup(first.operation_id)).status, 'committed');
    assert.equal((await f.journal.lookup(second.operation_id)).status, 'committed');
    assert.equal(ackCalls(f.trace, first), 1, 'the second pool must reconcile the exact first commit');

    resume.resolve();
    assert.deepEqual(await firstPending, outcome, 'the original result survives benign acknowledgement takeover');
    assert.equal(firstCallbacks, 1);
    assert.equal(secondCallbacks, 1);
    assert.deepEqual(await controlRow(f.h), advanced, 'the original pool must not rewind or allocate another checkpoint');
    assert.equal(ackCalls(f.trace, first), 1, 'the original pool must not acknowledge its stale cached marker');
    const current = await f.journal.control();
    assert.equal(current.state, 'serving');
    assert.equal(current.marker.checkpoint.revision, 2);
    assert.equal((await other.one('SELECT name FROM accounts WHERE id=?', id)).name, 'Second committed value');
    assert(otherTrace.some(entry => entry.kind === 'sql' && entry.sql.startsWith('SELECT pg_advisory_xact_lock(')));
  } finally {
    resume.resolve();
    if (firstPending) await firstPending.catch(() => {});
    // Close the extra native pool before fixture teardown drops its disposable
    // database; no real project or hosted data is involved.
    await other.close();
  }
});

test('actual PostgreSQL snapshot rollback after confirmed COMMIT is reread before acknowledgement and cannot certify the cached successor', actualPostgres, async t => {
  const f = await fixture(t), id = await seedAccount(f.h), operation = intent();
  const original = await controlRow(f.h);
  const schemaBefore = await privateRows(f.h, 'SELECT max(version) AS version FROM lovelies_private.schema_versions');
  let callbacks = 0, rollbackApplied = false;
  f.faults.afterCommit = async () => {
    delete f.faults.afterCommit;
    // First verify the real mutation and checkpoint reached committed storage.
    const committed = await controlRow(f.h);
    assert.equal(committed.checkpoint_revision, 1);
    assert.equal(committed.last_operation_id, operation.operation_id);
    assert.equal((await privateRows(f.h, 'SELECT name FROM lovelies_private.accounts WHERE id=$1', [id]))[0].name, 'Value after backup');
    assert.equal((await f.journal.lookup(operation.operation_id)).status, 'pending');

    // Reinstall only this disposable fixture's earlier data/control snapshot in
    // one actual PG transaction. The independently current journal is retained.
    // This models a same-schema rollback, not physical provider restore proof.
    await asBackend(f.h.engine, async () => {
      await f.h.engine.exec('BEGIN');
      try {
        await f.h.engine.query('UPDATE lovelies_private.accounts SET name=$1 WHERE id=$2', ['Preserved synthetic account', id]);
        await f.h.engine.query(`UPDATE lovelies_private.restore_control SET
          project_id=$1,database_id=$2,incarnation_id=$3,checkpoint_revision=$4,checkpoint_hash=$5,
          journal_sequence=$6,journal_hash=$7,last_operation_id=$8,last_plan_hash=$9 WHERE singleton=1`,
        [original.project_id, original.database_id, original.incarnation_id, original.checkpoint_revision, original.checkpoint_hash,
          original.journal_sequence, original.journal_hash, original.last_operation_id, original.last_plan_hash]);
        await f.h.engine.exec('COMMIT');
        rollbackApplied = true;
      } catch (error) {
        await f.h.engine.exec('ROLLBACK');
        throw error;
      }
    });
  };

  await assert.rejects(() => f.db.transaction(async () => {
    callbacks++;
    await f.db.run('UPDATE accounts SET name=? WHERE id=?', 'Value after backup', id);
    return { outcome: 'must_not_escape' };
  }, operation), unavailable);
  assert.equal(rollbackApplied, true);
  assert.equal(callbacks, 1);
  assert.equal(ackCalls(f.trace, operation), 0, 'a confirmed former commit is insufficient after the local marker rolled back');
  assert.deepEqual(await controlRow(f.h), original);
  assert.deepEqual(await privateRows(f.h, 'SELECT max(version) AS version FROM lovelies_private.schema_versions'), schemaBefore);
  assert.equal((await privateRows(f.h, 'SELECT name FROM lovelies_private.accounts WHERE id=$1', [id]))[0].name, 'Preserved synthetic account');
  assert.equal((await f.journal.lookup(operation.operation_id)).status, 'pending');
  // The known predecessor of a pending operation remains fenced, rather than
  // being inferred aborted or automatically replayed/acknowledged.
  assert.equal((await f.journal.control()).state, 'pending');
  await assert.rejects(() => f.db.one('SELECT name FROM accounts WHERE id=?', id), unavailable);
  assert.equal(callbacks, 1);
  assert.equal(ackCalls(f.trace, operation), 0);
});
