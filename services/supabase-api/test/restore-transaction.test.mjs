import {planEvents} from './restore-plan-fixture.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { RestoreTransactionCollector, restoreOperationID } from '../src/restore-transaction.ts';
import { ApiError } from '../src/types.ts';
import { fixture, intent, insertAccount, rowCount, controlRow, digest, unavailable } from './restore-database-fixture.mjs';

const invalid = error => error instanceof ApiError && error.code === 'restore_operation_invalid';
const identity = () => ({ operation_id: randomUUID(), input_hash: digest('bounded logical operation'), allocations: {} });
const scope = () => ({ sender_id: randomUUID(), recipient_id: randomUUID(), request_id: randomUUID() });

test('nested callbacks share one immutable collector and caller mutation cannot alter the committed restriction/allocation', async t => {
  const f = await fixture(t), id = randomUUID(), operation = identity(), originalAllocation = randomUUID(), originalScope = scope();
  operation.allocations.id_0 = originalAllocation;
  let escaped;
  await f.db.transaction(async restore => {
    escaped = restore; assert.equal(Object.isFrozen(restore), true);
    assert.equal(restore.seal, undefined); assert.equal(restore.close, undefined);
    restore.operation(operation);
    const eventScope = { ...originalScope };
    const pending = restore.restrict('sharing-request-retired', eventScope);
    eventScope.request_id = randomUUID(); operation.allocations.id_0 = randomUUID();
    await f.db.transaction(async nested => { assert.equal(nested, restore); await insertAccount(f.db, id); });
    await pending;
  });
  const saved = await f.journal.lookup(operation.operation_id);
  assert.equal(saved.status, 'committed'); assert.deepEqual(saved.plan.allocations, { id_0: originalAllocation });
  assert.equal(saved.plan.events.length, 1); assert.deepEqual(saved.plan.events[0].scope, originalScope);
  assert.equal(saved.plan.receipts[0].event.operation_id, saved.plan.events[0].operation_id);
  assert.equal((await controlRow(f.h)).journal_sequence, 1);
  assert.throws(() => escaped.operation(identity()), invalid);
  assert.throws(() => escaped.restrict('sharing-request-retired', scope()), invalid);
});

test('unawaited bounded identifier work is sealed before prepare; callback failure never appends an independent fact', async t => {
  const f = await fixture(t), operation = identity();
  await f.db.transaction(restore => { restore.operation(operation); void restore.restrict('sharing-request-retired', scope()); });
  assert.equal((await f.journal.lookup(operation.operation_id)).plan.events.length, 1);
  const failed = identity(), id = randomUUID(); let escaped;
  await assert.rejects(() => f.db.transaction(async restore => {
    escaped = restore; restore.operation(failed); await restore.restrict('sharing-request-retired', scope());
    await insertAccount(f.db, id); throw Error('controlled_callback_failure');
  }), /controlled_callback_failure/);
  assert.equal(await f.journal.lookup(failed.operation_id), null); assert.equal(await rowCount(f.h, 'accounts'), 0);
  assert.throws(() => escaped.operation(identity()), invalid);
});

test('invalid or mixed registration poisons the SQL transaction even when application code catches the immediate error', async t => {
  const f = await fixture(t);
  for (const malformed of [
    restore => restore.restrict('sharing-request-retired', scope()),
    restore => { restore.operation(identity()); restore.operation(identity()); },
    restore => { restore.operation(identity()); return restore.restrict('sharing-request-retired', { ...scope(), extra: 'not allowed' }); },
    restore => restore.operation({ ...identity(), allocations: { id_32: randomUUID() } }),
  ]) {
    const id = randomUUID();
    await assert.rejects(() => f.db.transaction(async restore => {
      try { await malformed(restore); } catch {}
      await insertAccount(f.db, id);
    }), invalid);
  }
  await assert.rejects(() => f.db.transaction(async restore => {
    try { restore.operation(identity()); } catch {}
    await insertAccount(f.db, randomUUID());
  }, intent()), invalid);
  assert.equal(await rowCount(f.h, 'accounts'), 0); assert.equal((await controlRow(f.h)).checkpoint_revision, 0);
  assert.equal(f.trace.filter(value => value.kind === 'journal' && value.path === '/v1/operations/prepare').length, 0);
  const readOnly = new RestoreTransactionCollector(true);
  assert.throws(() => readOnly.operation(identity()), error => error instanceof ApiError && error.code === 'read_only_transaction');
  await assert.rejects(() => readOnly.seal(), invalid);
});

for(const count of [32,33,97])test(count+' exact restrictions commit atomically with a complete immutable manifest',async t=>{
 const f=await fixture(t),operation=identity(),id=randomUUID(),expected=[];
 await f.db.transaction(async restore=>{
  restore.operation(operation);
  for(let index=0;index<count;index++){const selected=scope();expected.push(selected);await restore.restrict('sharing-request-retired',selected);}
  await insertAccount(f.db,id);
 });
 const saved=await f.journal.lookup(operation.operation_id),events=await planEvents(f,saved);
 assert.equal(saved.status,'committed');assert.equal(saved.plan.version,count>32?2:1);
 assert.equal(events.length,count);assert.equal(new Set(events.map(event=>event.operation_id)).size,count);
 assert.deepEqual(events.map(event=>event.scope),expected);
 assert.equal((await controlRow(f.h)).journal_sequence,count);assert.equal(await rowCount(f.h,'accounts'),1);
});

test('logical key identity is stable across payload changes and independent changed-input reuse rolls back SQL', async t => {
  const f = await fixture(t), actor = randomUUID(), key = 'sharing-retirement-' + randomUUID();
  const id = await restoreOperationID(actor, 'personal', key);
  assert.equal(await restoreOperationID(actor, 'personal', key), id);
  assert.notEqual(await restoreOperationID(randomUUID(), 'personal', key), id);
  assert.notEqual(await restoreOperationID(actor, 'other', key), id);
  const first = { operation_id: id, input_hash: digest('first reviewed request'), allocations: {} };
  await f.db.transaction(restore => { restore.operation(first); });
  await assert.rejects(() => f.db.transaction(async restore => {
    restore.operation({ ...first, input_hash: digest('altered reviewed request') });
    await insertAccount(f.db, randomUUID());
  }), unavailable);
  assert.equal(await rowCount(f.h, 'accounts'), 0);
  assert.equal((await f.journal.lookup(id)).plan.input_hash, first.input_hash);
});
