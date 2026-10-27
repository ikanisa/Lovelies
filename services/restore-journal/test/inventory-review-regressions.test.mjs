import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, MemoryStorage, id, hash, v2, json, expectedError, putInput, cutInput, PROJECT_ID, canonical, sha256 } from './inventory-fixtures.mjs';
import { readInventoryControl, admitInventory, lookupInventoryOperation, readInventoryProgress } from '../src/inventory.mjs';
import { LIMITS, bounded, validateDescriptor, validateLink } from '../src/inventory-values.mjs';

for (const damage of ['deleted-receipt', 'deleted-archive', 'changed-receipt', 'changed-archive', 'changed-upgrade-id', 'changed-receipt-anchor']) {
  test(`ordinary control/admission fail closed on exact upgrade origin ${damage}`, async () => {
    const f = await fixture(), key = 'inventory:upgrade:' + f.upgrade.upgrade_id, archive = 'control-archive:' + f.upgrade.upgrade_id;
    if (damage === 'deleted-receipt') f.storage.rows.delete(key);
    else if (damage === 'deleted-archive') f.storage.rows.delete(archive);
    else if (damage === 'changed-receipt') f.storage.rows.get(key).input_hash = 'c'.repeat(64);
    else if (damage === 'changed-archive') f.storage.rows.get(archive).marker.checkpoint.hash = 'c'.repeat(64);
    else if (damage === 'changed-upgrade-id') f.storage.rows.get('control:v1').upgrade_id = id();
    else f.storage.rows.get('control:v1').upgrade_receipt_hash = 'c'.repeat(64);
    const before = structuredClone(f.storage.rows);
    await assert.rejects(() => readInventoryControl(f.storage, f.options), expectedError(503));
    await assert.rejects(() => admitInventory(f.storage, v2({ marker: f.control.marker, writer_generation_id: f.control.writer_generation_id,
      operation_version: 2, inventory_protocol: 1 }), f.options), expectedError(503));
    assert.deepEqual(f.storage.rows, before);
  });
}
test('ordinary origin checks use exact authenticated keys without listing archive or upgrade history', async () => {
  const f = await fixture(), original = f.storage.transaction.bind(f.storage), seen = [];
  f.storage.transaction = callback => original(tx => callback({ ...tx, list: async options => {
    seen.push(options.prefix); assert.notEqual(options.prefix, 'control-archive:'); assert.notEqual(options.prefix, 'inventory:upgrade:'); return tx.list(options);
  } }));
  const current = await readInventoryControl(f.storage, f.options);
  assert.equal(current.control.upgrade_id, f.upgrade.upgrade_id); assert.equal(current.control.upgrade_receipt_hash, f.upgraded.upgrade.hash);
  assert.equal(current.control.upgrade_control_hash, f.upgrade.expected_control_hash); assert(seen.length > 0);
});

/** A request fault is armed only after all fixture setup. Before-commit holds a
 * draft write; after-commit holds delivery after super.transaction committed.
 * No production headers, providers or database fixture are involved. */
class RequestStageStorage extends MemoryStorage {
  arm(kind, phase, prefix) {
    assert.equal(this.fault, undefined);
    const entered = Promise.withResolvers(), release = Promise.withResolvers(), done = Promise.withResolvers();
    const fault = { kind, phase, prefix, entered, done, consumed: false, released: false, transaction_done: false,
      release() { this.released = true; release.resolve(); }, wait: release.promise };
    this.fault = fault; return fault;
  }
  async transaction(callback) {
    const fault = this.fault; this.fault = undefined; let matched = false;
    const matches = values => fault?.kind === 'prepare' ? Object.keys(values).some(k => k.startsWith('plan:')) :
      fault?.kind === 'progress' ? Object.keys(values).some(k => k.startsWith('inventory:progress:')) :
      fault?.kind === 'cut' ? Object.keys(values).some(k => k.startsWith('inventory:cut:')) : false;
    try {
      const result = await super.transaction(tx => callback({ ...tx,
        list: async options => {
          if (fault?.kind === 'list' && !fault.consumed && options.prefix === fault.prefix) {
            fault.consumed = true; fault.entered.resolve(); await fault.wait;
          }
          return tx.list(options);
        },
        put: async values => {
          await tx.put(values);
          if (fault && !matched && matches(values)) {
            matched = true; fault.consumed = true;
            if (fault.phase === 'before') { fault.entered.resolve(); await fault.wait; }
          }
        } }));
      if (fault && matched && fault.phase === 'after') { fault.entered.resolve(); await fault.wait; }
      return result;
    } finally { if (fault) { fault.transaction_done = true; fault.done.resolve(); } }
  }
}
async function stageRequest(kind) {
  const storage = new RequestStageStorage(), f = await fixture({ storage });
  if (kind === 'prepare') { const body = putInput(f); return { storage, f, body, path: '/v2/operations/prepare' }; }
  await f.put(); const recovery = await f.begin();
  if (kind === 'progress') { const selected = await f.page(recovery); return { storage, f, recovery, selected, body: selected.input,
    path: `/v2/recovery/${recovery.input.recovery_id}/enumeration-progress` }; }
  const body = await cutInput(f, recovery); return { storage, f, recovery, body, path: `/v2/recovery/${recovery.input.recovery_id}/cuts` };
}
for (const kind of ['prepare', 'progress', 'cut']) for (const phase of ['before', 'after']) for (const mode of ['abort', 'deadline']) {
  test(`${kind} request ${mode} ${phase} independent commit preserves rollback versus durable unknown outcome`, { timeout: 12000 }, async () => {
    const setup = await stageRequest(kind), { f, storage, body, path } = setup, before = structuredClone(storage.rows);
    const fault = storage.arm(kind, phase), controller = new AbortController();
    const watchdog = setTimeout(() => fault.release(), 6000);
    try {
      const pending = f.http(path, body, { status: 503, signal: controller.signal, deadlineMs: mode === 'deadline' ? 1000 : 5000 });
      await Promise.race([fault.entered.promise, pending.then(() => { if (!fault.consumed) assert.fail('Request failed before intended mutation fault'); })]);
      assert.equal(fault.consumed, true); if (mode === 'abort') controller.abort();
      const response = await pending; assert.match(response.value.error, mode === 'deadline' ? /deadline/ : /aborted/);
      // The bounded failed reply must arrive while the deliberately stalled
      // commit/delivery is still held, rather than waiting for our watchdog.
      assert.equal(fault.released, false);
      if (phase === 'before') {
        await fault.done.promise; assert.equal(fault.released, false); assert.deepEqual(storage.rows, before);
      } else if (kind === 'prepare') {
        const lookup = await lookupInventoryOperation(storage, body.operation_id, f.options);
        assert.equal(lookup.operation.status, 'pending'); assert.deepEqual(lookup.operation.plan.resources, body.resources);
      } else {
        const current = await readInventoryProgress(storage, setup.recovery.input.recovery_id, 'registrations', f.options);
        if (kind === 'progress') { assert.equal(current.progress.state.cursor.sequence, 1); assert(current.progress.last_ack); }
        else { assert.equal(current.active_cut.cut_id, body.cut_id); assert.equal(current.progress.last_ack, null); }
        assert.equal(current.clearance_available, false);
      }
    } finally { clearTimeout(watchdog); fault.release(); if (fault.consumed || fault.transaction_done) await fault.done.promise; await new Promise(setImmediate); }
    if (phase === 'before') assert.deepEqual(storage.rows, before);
  });
}
for (const branch of ['prepare', 'upgrade', 'begin', 'unbound-control']) for (const mode of ['abort', 'deadline']) {
  test(`stalled noRecords list in ${branch} is bounded by request ${mode} and finishes rollback before release`, { timeout: 12000 }, async () => {
    const storage = new RequestStageStorage(), f = await fixture({ storage }); let path, body, prefix;
    if (branch === 'prepare') { path = '/v2/operations/prepare'; body = putInput(f); prefix = 'inventory:recovery:'; }
    else if (branch === 'upgrade') { storage.rows = structuredClone(f.oldRows); path = '/v2/control/upgrade'; body = f.upgrade; prefix = 'inventory:'; }
    else if (branch === 'begin') { body = v2({ recovery_id: id(), cut_id: id(), expected: f.control.marker, writer_generation_id: f.control.writer_generation_id });
      path = '/v2/recovery/begin'; prefix = 'inventory:progress:' + body.recovery_id + ':'; }
    else { storage.rows = new Map(); path = '/v2/control'; body = undefined; prefix = 'inventory:'; }
    const before = structuredClone(storage.rows), fault = storage.arm('list', 'before', prefix), controller = new AbortController();
    const watchdog = setTimeout(() => fault.release(), 6000);
    try {
      const pending = f.http(path, body, { status: 503, signal: controller.signal, deadlineMs: mode === 'deadline' ? 1000 : 5000 });
      await Promise.race([fault.entered.promise, pending.then(() => { if (!fault.consumed) assert.fail('Request failed before intended list fault'); })]);
      assert.equal(fault.consumed, true); if (mode === 'abort') controller.abort();
      const reply = await pending; assert.match(reply.value.error, mode === 'deadline' ? /deadline/ : /aborted/);
      await fault.done.promise; assert.equal(fault.released, false); assert.equal(fault.transaction_done, true); assert.deepEqual(storage.rows, before);
    } finally { clearTimeout(watchdog); fault.release(); if (fault.consumed || fault.transaction_done) await fault.done.promise; await new Promise(setImmediate); }
    assert.deepEqual(storage.rows, before);
  });
}

// Codec guard vectors deliberately isolate exact byte ceilings. They do not
// pretend an overlong unknown descriptor is a valid business writer or prove
// provider CPU. Typed maximum-shape and full HTTP tests follow separately.
for (const [kind, limit] of [['descriptor', LIMITS.descriptor], ['link', LIMITS.link], ['record', LIMITS.record], ['response', LIMITS.response]]) {
  test(`${kind} canonical codec byte guard accepts exact ceiling and refuses ceiling plus one`, () => {
    const exact = 'a'.repeat(limit - 2), oversized = exact + 'a';
    assert.equal(new TextEncoder().encode(canonical(exact)).byteLength, limit); assert.equal(bounded(exact, limit), exact);
    assert.throws(() => bounded(oversized, limit), expectedError(413));
  });
}
test('maximum typed descriptor and link forms stay bounded; overlong identity/key/policy cannot enter a plan', async () => {
  const f = await fixture(), input = putInput(f), d = input.resources[0];
  d.asset_version = 'v'.repeat(128); d.object_key = `source/${d.owner_id}/${d.asset_id}/${d.asset_version}/${d.write_id}`;
  d.authority.policy_version = 'p'.repeat(128); d.authority.auth_epoch = Number.MAX_SAFE_INTEGER;
  d.authority.consent_created_at = Number.MAX_SAFE_INTEGER - 1; d.authority.consent_expires_at = Number.MAX_SAFE_INTEGER;
  d.payload.byte_size = d.payload.source_byte_size = LIMITS.source;
  assert(new TextEncoder().encode(canonical(validateDescriptor(d, input))).byteLength <= LIMITS.descriptor);
  const link = { version: 1, project_id: PROJECT_ID, operation_id: id(), writer_generation_id: input.writer_generation_id,
    owner_id: d.owner_id, asset_id: d.asset_id, asset_version: d.asset_version, target_write_id: d.write_id,
    target_descriptor_hash: hash(), relation: 'asset-source', offset_bytes: null };
  assert(new TextEncoder().encode(canonical(validateLink(link))).byteLength <= LIMITS.link);
  const before = structuredClone(f.storage.rows);
  for (const mutate of [x => { x.resources[0].object_key = 'x'.repeat(513); }, x => { x.resources[0].authority.policy_version += 'x'; }, x => { x.resources[0].asset_version += 'x'; }]) {
    const invalid = json(input); mutate(invalid); await assert.rejects(() => f.prepare(invalid), expectedError(400)); assert.deepEqual(f.storage.rows, before);
  }
  assert.throws(() => validateLink({ ...link, asset_version: 'v'.repeat(129) }), expectedError(400));
});
test('HTTP body byte boundary is exact and neither malformed-at-limit nor over-limit reaches storage', async () => {
  const f = await fixture(), before = structuredClone(f.storage.rows), original = f.storage.calls;
  const atLimit = ' '.repeat(LIMITS.operation); await f.http('/v2/operations/prepare', atLimit, { status: 400 });
  await f.http('/v2/operations/prepare', atLimit + ' ', { status: 413 });
  assert.equal(f.storage.calls, original); assert.deepEqual(f.storage.rows, before);
});
