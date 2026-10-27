import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, MemoryStorage, putInput, cutInput } from './inventory-fixtures.mjs';
import { lookupInventoryOperation, readInventoryProgress } from '../src/inventory.mjs';

/** The production callback has returned its fully checked result, but this
 * synthetic engine has not committed its draft. There is no callback left to
 * check cancellation. A gate-raced HTTP failure cannot cancel engine commit. */
class CommitGapStorage extends MemoryStorage {
  arm() {
    const entered = Promise.withResolvers(), release = Promise.withResolvers(), completed = Promise.withResolvers();
    const gap = { entered, release, completed, consumed: false, committed: false };
    this.gap = gap; return gap;
  }
  async transaction(callback) {
    const gap = this.gap; this.gap = undefined;
    try {
      const result = await super.transaction(async tx => {
        const value = await callback(tx); // Every production in-callback check is finished.
        if (gap) { gap.consumed = true; gap.entered.resolve(); await gap.release.promise; }
        return value; // Simulated engine commits after this separate scheduling gap.
      });
      if (gap) gap.committed = true; return result;
    } finally { gap?.completed.resolve(); }
  }
}
async function setup(kind) {
  const storage = new CommitGapStorage(), f = await fixture({ storage });
  if (kind === 'prepare') return { storage, f, body: putInput(f), path: '/v2/operations/prepare' };
  await f.put(); const recovery = await f.begin();
  if (kind === 'progress') {
    const page = await f.page(recovery);
    return { storage, f, recovery, body: page.input, path: `/v2/recovery/${recovery.input.recovery_id}/enumeration-progress` };
  }
  return { storage, f, recovery, body: await cutInput(f, recovery), path: `/v2/recovery/${recovery.input.recovery_id}/cuts` };
}
for (const kind of ['prepare', 'progress', 'cut']) for (const mode of ['abort', 'deadline']) {
  test(`${kind} cancellation in final-callback-to-engine-commit gap is unknown, then reconciles complete durable state (${mode})`, { timeout: 12000 }, async () => {
    const { storage, f, recovery, body, path } = await setup(kind), before = structuredClone(storage.rows);
    const gap = storage.arm(), controller = new AbortController(), watchdog = setTimeout(() => gap.release.resolve(), 6000);
    try {
      const pending = f.http(path, body, { status: 503, signal: controller.signal, deadlineMs: mode === 'deadline' ? 1000 : 5000 });
      await Promise.race([gap.entered.promise, pending.then(() => { if (!gap.consumed) assert.fail('Request failed before the final callback/commit gap'); })]);
      assert.equal(gap.consumed, true); assert.equal(gap.committed, false);
      if (mode === 'abort') controller.abort();
      const failed = await pending; assert.match(failed.value.error, mode === 'deadline' ? /deadline/ : /aborted/);
      // Failure arrived while engine commit is still held. This current
      // absence is expressly not evidence that the transition cannot land.
      assert.equal(gap.committed, false); assert.deepEqual(storage.rows, before);
      gap.release.resolve(); await gap.completed.promise; assert.equal(gap.committed, true);
      if (kind === 'prepare') {
        const current = await lookupInventoryOperation(storage, body.operation_id, f.options);
        assert.equal(current.operation.status, 'pending'); assert.deepEqual(current.operation.plan.resources, body.resources);
      } else {
        const current = await readInventoryProgress(storage, recovery.input.recovery_id, 'registrations', f.options);
        if (kind === 'progress') assert.equal(current.progress.state.cursor.sequence, 1);
        else assert.equal(current.active_cut.cut_id, body.cut_id);
        assert.equal(current.clearance_available, false);
      }
    } finally {
      clearTimeout(watchdog); gap.release.resolve(); if (gap.consumed) await gap.completed.promise;
    }
  });
}
