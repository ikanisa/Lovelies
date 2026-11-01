import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PostgresDatabase } from '../src/database.ts';
import { RestoreDatabaseFence } from '../src/restore-database.ts';
import { planEvents } from './restore-plan-fixture.mjs';
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

test('actual PostgreSQL snapshot rollback rejects cached acknowledgement then reconciles only exact restrictions', actualPostgres, async t => {
  const f = await fixture(t), id = await seedAccount(f.h), operation = intent();
  const original = await controlRow(f.h);
  const accountBefore = (await privateRows(f.h, 'SELECT * FROM lovelies_private.accounts WHERE id=$1', [id]))[0];
  const schemaBefore = await privateRows(f.h, 'SELECT max(version) AS version FROM lovelies_private.schema_versions');
  let callbacks = 0, rollbackApplied = false, unfencedRejected = false, accepted;
  f.faults.afterCommit = async () => {
    delete f.faults.afterCommit;
    // First verify the real mutation and checkpoint reached committed storage.
    const committed = await controlRow(f.h);
    assert.equal(committed.checkpoint_revision, 1);
    assert.equal(committed.last_operation_id, operation.operation_id);
    const committedAccount = (await privateRows(f.h, 'SELECT * FROM lovelies_private.accounts WHERE id=$1', [id]))[0];
    assert.equal(committedAccount.name, 'Value after backup');assert.equal(committedAccount.disabled_at, 1_000);
    accepted = await f.journal.lookup(operation.operation_id);assert.equal(accepted.status, 'pending');

    // A normal raw backend writer must still fail in this bound database. This
    // explicit rejection precedes the fixture's privileged snapshot restore.
    await asBackend(f.h.engine, async () => {
      const settings = (await f.h.engine.query("SELECT current_setting('lovelies.restore_replay',true) replay,current_setting('lovelies.writer_protocol',true) writer")).rows[0];
      assert.notEqual(settings.replay, 'on');assert.notEqual(settings.writer, '2');
      await assert.rejects(() => f.h.engine.query('UPDATE lovelies_private.accounts SET name=$1 WHERE id=$2', ['Unfenced writer must fail', id]),
        error => error.code === '55000' && error.message === 'restore_writer_fence_required');
      unfencedRejected = true;
    });
    assert.deepEqual((await privateRows(f.h, 'SELECT * FROM lovelies_private.accounts WHERE id=$1', [id]))[0], committedAccount);
    assert.deepEqual(await controlRow(f.h), committed);

    // Reinstall only this disposable fixture's earlier data/control snapshot in
    // one actual PG transaction. The independently current journal is retained.
    // This models a same-schema rollback, not physical provider restore proof.
    await asBackend(f.h.engine, async () => {
      await f.h.engine.exec('BEGIN');
      try {
        await f.h.engine.query("SELECT set_config('lovelies.restore_replay','on',true)");
        await f.h.engine.query('UPDATE lovelies_private.accounts SET name=$1,disabled_at=$2 WHERE id=$3', [accountBefore.name, accountBefore.disabled_at, id]);
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
      assert.notEqual((await f.h.engine.query("SELECT current_setting('lovelies.restore_replay',true) replay")).rows[0].replay, 'on', 'snapshot privilege must end with its transaction');
    });
  };

  const callback = async () => {
    callbacks++;
    // Commit a positive profile field and one exact restrictive fact together.
    // Recovery may preserve the restriction, never reconstruct the name edit.
    await f.db.run('UPDATE accounts SET name=?,disabled_at=? WHERE id=?', 'Value after backup', 1_000, id);
    return { outcome: 'must_not_escape' };
  };
  await assert.rejects(() => f.db.transaction(callback, operation), unavailable);
  assert.equal(rollbackApplied, true);
  assert.equal(unfencedRejected, true);
  assert.equal(callbacks, 1);
  assert.equal(ackCalls(f.trace, operation), 0, 'a confirmed former commit is insufficient after the local marker rolled back');
  assert.deepEqual(await controlRow(f.h), original);
  assert.deepEqual(await privateRows(f.h, 'SELECT max(version) AS version FROM lovelies_private.schema_versions'), schemaBefore);
  assert.deepEqual((await privateRows(f.h, 'SELECT * FROM lovelies_private.accounts WHERE id=$1', [id]))[0], accountBefore);
  assert.deepEqual(await f.journal.lookup(operation.operation_id), accepted);
  assert.equal((await f.journal.control()).state, 'pending');
  const events = await planEvents(f, accepted);
  assert.deepEqual(events.map(({kind,scope})=>({kind,scope})), [{kind:'account-authority-retired',scope:{account_id:id,auth_epoch:String(accountBefore.auth_epoch)}}]);
  assert.equal(accepted.plan.input_hash, operation.input_hash);assert.deepEqual(accepted.plan.allocations, operation.allocations);

  // A fresh admission now replays the independently accepted restriction and
  // records a terminal negative outcome. It cannot certify the lost positive
  // callback or use the originating pool's cached COMMIT marker as authority.
  const after = await f.db.one('SELECT * FROM accounts WHERE id=?', id);
  assert(Number.isSafeInteger(after.disabled_at) && after.disabled_at >= accepted.plan.prepared_at);
  assert.deepEqual(after, {...accountBefore,disabled_at:after.disabled_at});
  const recovered = await f.journal.lookup(operation.operation_id);
  assert.equal(recovered.status, 'recovered');assert.equal(recovered.plan_hash, accepted.plan_hash);assert.deepEqual(recovered.plan, accepted.plan);
  assert.deepEqual(await f.h.db.one('SELECT operation_id,input_hash,plan_hash,outcome FROM restore_recovered_operations WHERE operation_id=?',operation.operation_id),
    {operation_id:operation.operation_id,input_hash:operation.input_hash,plan_hash:accepted.plan_hash,outcome:'restricted-abort'});
  const receipts = await f.journal.restrictionPage(accepted.plan.expected.cursor,accepted.plan.next.cursor);
  const replayed = await privateRows(f.h,'SELECT sequence,hash,operation_id,kind,scope_json FROM lovelies_private.restore_replay_facts ORDER BY sequence');
  assert.deepEqual(replayed.map(row=>({...row,scope_json:JSON.parse(row.scope_json)})),receipts.map(row=>({sequence:row.sequence,hash:row.hash,operation_id:row.event.operation_id,kind:row.event.kind,scope_json:row.event.scope})));
  const next = accepted.plan.next;
  assert.deepEqual(await controlRow(f.h),{...original,checkpoint_revision:next.checkpoint.revision,checkpoint_hash:next.checkpoint.hash,
    journal_sequence:next.cursor.sequence,journal_hash:next.cursor.hash,last_operation_id:operation.operation_id,last_plan_hash:accepted.plan_hash});
  const serving = await f.journal.control();assert.equal(serving.state,'serving');assert.deepEqual(serving.marker,next);
  await assert.rejects(() => f.db.transaction(callback,operation),error=>error.status===410&&error.code==='operation_retired_by_recovery');
  await assert.rejects(() => f.db.transaction(callback,{...operation,input_hash:'f'.repeat(64)}),error=>error.status===409&&error.code==='operation_key_conflict');
  assert.equal(callbacks, 1);
  assert.equal(ackCalls(f.trace, operation), 0);
  assert.equal(f.trace.filter(entry=>entry.kind==='journal'&&entry.path==='/v1/operations/'+operation.operation_id+'/reconcile').length,1);
  assert.equal(f.trace.filter(entry=>entry.kind==='journal'&&entry.path==='/v1/operations/prepare').length,1);
  assert.deepEqual(await f.db.one('SELECT * FROM accounts WHERE id=?',id),after);
  assert.deepEqual(await f.journal.lookup(operation.operation_id),recovered);
});
