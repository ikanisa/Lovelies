import assert from 'node:assert/strict';
import { test } from 'node:test';
import { event, request as oldRequest } from './fixtures.mjs';
import { fixture, MemoryStorage, id, hash, v2, json, expectedError, operationInput, putInput, linkInput, deleteInput, cutInput, PROJECT_ID, canonical, sha256, env } from './inventory-fixtures.mjs';
import { CONTROL_KEY, planKey, bootstrapControl, prepareOperation, beginRecovery as beginV1Recovery, handleOperationRequest } from '../src/operations.mjs';
import { handleInventoryRequest, upgradeInventory, prepareInventory, acknowledgeInventory, admitInventory, lookupInventoryOperation,
  dispatchInventory, observeInventory, beginInventoryRecovery, createInventoryCut, readInventoryControl,
  readInventoryPage, readInventoryProgress, acknowledgeInventoryPage } from '../src/inventory.mjs';
import { LIMITS, recordKey, writeKey, metaKey, progressKey, cutKey, keyHash, inertGate } from '../src/inventory-values.mjs';

const rows = f => structuredClone(f.storage.rows);
const dispatch = async (f, target) => dispatchInventory(f.storage, v2({ marker: f.control.marker, writer_generation_id: f.control.writer_generation_id,
  write_id: target.item.write_id, descriptor_hash: await sha256(canonical(target.item)), plan_hash: target.operation.plan_hash }), f.options);
const ack = operation => v2({ plan_hash: operation.plan_hash, marker: operation.plan.next, writer_generation_id: operation.plan.writer_generation_id });

test('upgrade preserves original v1 plans, commits, restriction bytes and historical hashes', async () => {
  const f = await fixture({ history: true });
  for (const [key, value] of f.oldRows) if (key !== CONTROL_KEY) assert.deepEqual(f.storage.rows.get(key), value, key);
  assert.deepEqual(f.storage.rows.get('control-archive:' + f.upgrade.upgrade_id), f.oldRows.get(CONTROL_KEY));
  const old = await lookupInventoryOperation(f.storage, f.historical.plan.operation_id, f.options);
  assert.equal(old.operation.plan_hash, await sha256(canonical(f.historical.plan))); assert.equal(old.operation.status, 'committed');
});
test('exact upgrade retry after later commit returns original evidence without rewinding', async () => {
  const f = await fixture(); await f.put(); const before = rows(f);
  const replay = await upgradeInventory(f.storage, f.upgrade, f.options);
  assert.deepEqual(replay.upgrade, f.upgraded.upgrade); assert.deepEqual(rows(f), before); assert.equal(replay.control.marker.checkpoint.revision, 1);
});
test('missing serving binding cannot be initialized by inventory upgrade', async () => {
  const f = await fixture(), empty = new MemoryStorage();
  await assert.rejects(() => upgradeInventory(empty, f.upgrade, f.options), expectedError(409, 'control_uninitialized')); assert.equal(empty.rows.size, 0);
});
test('unknown inventory state blocks upgrade and is preserved', async () => {
  const f = await fixture(), raw = new MemoryStorage(f.oldRows); raw.rows.set('inventory:unknown', { preserve: true }); const before = structuredClone(raw.rows);
  await assert.rejects(() => upgradeInventory(raw, f.upgrade, f.options), expectedError(503)); assert.deepEqual(raw.rows, before);
});
test('pending or quarantined v1 authority cannot be upgraded into serving v2', async () => {
  for (const kind of ['pending', 'quarantined']) {
    const f = await fixture(), storage = new MemoryStorage(f.oldRows), marker = storage.rows.get(CONTROL_KEY).marker;
    if (kind === 'pending') await prepareOperation(storage, { version: 1, project_id: PROJECT_ID, operation_id: id(), input_hash: hash(), expected: marker, allocations: {}, events: [] }, f.options.now);
    else await beginV1Recovery(storage, { version: 1, project_id: PROJECT_ID, recovery_id: id(), expected: marker }, f.options.now);
    const request = { ...f.upgrade, expected_control_hash: await sha256(canonical(storage.rows.get(CONTROL_KEY))) }, before = structuredClone(storage.rows);
    await assert.rejects(() => upgradeInventory(storage, request, f.options), expectedError(409, 'inventory_upgrade_not_serving')); assert.deepEqual(storage.rows, before);
  }
});
test('all old operation routes fail closed after version2 upgrade', async () => {
  const f = await fixture(), before = rows(f);
  for (const [route, body] of [['/v1/control'], ['/v1/admission', { marker: f.control.marker }],
    ['/v1/control/bootstrap', { database_id: id(), bootstrap_id: id() }],
    ['/v1/operations/prepare', { operation_id: id(), input_hash: hash(), expected: f.control.marker, allocations: {}, events: [] }],
    ['/v1/recovery/begin', { recovery_id: id(), expected: f.control.marker }]]) {
    const reply = await handleOperationRequest(oldRequest(route, body && { version: 1, project_id: PROJECT_ID, ...body }), env, f.storage);
    assert.equal(reply.status, 409); assert.equal((await reply.json()).error, 'protocol_version_unsupported');
  }
  assert.deepEqual(rows(f), before);
});
test('empty v2 operation advances checkpoint without inventing an inventory record', async () => {
  const f = await fixture(), initial = f.control.registration_head, operation = await f.prepare(operationInput(f));
  assert.equal(operation.plan.next.checkpoint.revision, 1); assert.deepEqual(operation.plan.inventory_receipts, []);
  assert.deepEqual(operation.plan.registration_before, initial); assert.deepEqual(operation.plan.registration_after, initial); await f.commit(operation);
});
test('actual accepted hash is acyclic and descriptor/receipt retain exact identities', async () => {
  const f = await fixture(), target = await f.put(), p = target.operation.plan, r = p.inventory_receipts[0];
  assert.equal(r.payload.item_hash, await sha256(canonical(target.item))); assert.equal(target.operation.plan_hash, await sha256(canonical(p)));
  assert.equal(Object.hasOwn(r, 'plan_hash'), false); assert.equal(Object.hasOwn(r.payload.item, 'plan_hash'), false);
  assert.equal(f.storage.rows.get(writeKey(target.item.write_id)).plan_hash, target.operation.plan_hash); assert.deepEqual(p.resources[0], target.item);
});
test('exact prepared/committed operation retries retain one original registration', async () => {
  const f = await fixture(), input = putInput(f), operation = await f.prepare(input);
  assert.equal((await f.prepare(input)).plan_hash, operation.plan_hash); await f.commit(operation); await f.put(); const before = rows(f);
  const replay = await prepareInventory(f.storage, input, f.options); assert.equal(replay.operation.status, 'committed'); assert.equal(replay.operation.plan_hash, operation.plan_hash);
  assert.deepEqual(rows(f), before);
});
test('changed-input and historical-v1 operation ID reuse cannot append a prefix', async () => {
  const f = await fixture({ history: true }), target = await f.put(), before = rows(f), changed = json(target.input); changed.resources[0].authority.consent_id = id();
  await assert.rejects(() => prepareInventory(f.storage, changed, f.options), expectedError(409, 'operation_conflict'));
  await assert.rejects(() => prepareInventory(f.storage, operationInput(f, { operation_id: f.historical.plan.operation_id }), f.options), expectedError(409, 'operation_version_conflict'));
  assert.deepEqual(rows(f), before);
});
test('two resource actions are rejected atomically before events or indexes', async () => {
  const f = await fixture(), input = putInput(f); input.resources.push(json(input.resources[0])); input.events = [event()]; const before = rows(f);
  await assert.rejects(() => f.prepare(input), expectedError(400)); assert.deepEqual(rows(f), before);
});
test('32 restrictions fit one operation; 33 fail before every effect', async () => {
  const f = await fixture(), valid = putInput(f); valid.events = Array.from({ length: 32 }, () => event());
  const operation = await f.prepare(valid); assert.equal(operation.plan.receipts.length, 32); await f.commit(operation);
  const invalid = putInput(f); invalid.events = Array.from({ length: 33 }, () => event()); const before = rows(f);
  await assert.rejects(() => f.prepare(invalid), expectedError(400)); assert.deepEqual(rows(f), before);
});
test('descriptor exact key, consent purpose and allocation bindings fail closed', async () => {
  const f = await fixture(), before = rows(f);
  for (const change of [x => { x.resources[0].object_key += '/wrong'; }, x => { x.resources[0].authority.purpose = 'photo_matching'; },
    x => { x.allocations.id_0 = id(); }, x => { x.resources[0].asset_version = 'v2'; }]) {
    const input = putInput(f); change(input); await assert.rejects(() => f.prepare(input), expectedError(400)); assert.deepEqual(rows(f), before);
  }
});
test('chunk and assembled descriptors retain exact offsets, version and checksum', async () => {
  const f = await fixture(), input = putInput(f), d = input.resources[0]; d.kind = 'upload-chunk';
  d.object_key = `upload-chunk/${d.owner_id}/${d.asset_id}/262144/${d.write_id}`;
  d.payload = { ...d.payload, byte_size: 6, source_byte_size: 262150, offset_bytes: 262144, transfer_sha256: hash() };
  const operation = await f.prepare(input); await f.commit(operation); assert.deepEqual(operation.plan.resources[0], d);
  const assembled = putInput(f); assembled.resources[0].kind = 'assembled-source'; assembled.resources[0].payload.transfer_sha256 = assembled.resources[0].payload.sha256;
  await f.commit(await f.prepare(assembled));
});
test('stale writer generation is a nonmutating denial rather than poisoning a newer control', async () => {
  const f = await fixture(), before = rows(f);
  await assert.rejects(() => admitInventory(f.storage, v2({ marker: f.control.marker, writer_generation_id: id(), operation_version: 2, inventory_protocol: 1 }), f.options), expectedError(409, 'writer_generation_stale'));
  assert.deepEqual(rows(f), before);
});
test('current-generation wrong marker creates an independent durable quarantine', async () => {
  const f = await fixture(), target = await f.put(), marker = json(f.control.marker); marker.checkpoint.hash = 'c'.repeat(64);
  await assert.rejects(() => admitInventory(f.storage, v2({ marker, writer_generation_id: f.control.writer_generation_id, operation_version: 2, inventory_protocol: 1 }), f.options), expectedError(409, 'serving_quarantined'));
  const control = (await readInventoryControl(f.storage, f.options)).control; assert.equal(control.state, 'quarantined');
  assert.equal((await acknowledgeInventory(f.storage, target.input.operation_id, ack(target.operation), f.options)).control.state, 'quarantined');
});
test('concurrent independent preparations admit exactly one global pending operation', async () => {
  const f = await fixture(), a = putInput(f), b = putInput(f);
  const results = await Promise.allSettled([prepareInventory(f.storage, a, f.options), prepareInventory(f.storage, b, f.options)]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1); const rejected = results.find(x => x.status === 'rejected').reason;
  assert.equal(rejected.code, 'operation_pending'); assert.equal(f.storage.rows.get(metaKey('registrations')).sequence, 1);
});
test('late observation during pending SQL acknowledgement is preserved by the commit', async () => {
  const f = await fixture(), first = await f.put(), pending = await f.prepare(operationInput(f));
  const observed = await f.observation(first); const head = observed.record.hash; await f.commit(pending);
  assert.equal(f.control.observation_head.hash, head); assert.equal(f.control.state, 'serving');
});
test('contradictory observations are separate immutable evidence; exact retry is effect-free', async () => {
  const f = await fixture(), target = await f.put(), a = await f.observation(target), before = rows(f);
  const replay = await observeInventory(f.storage, a.input, f.options); assert.deepEqual(replay.observation, a.record); assert.deepEqual(rows(f), before);
  const changed = json(a.input); changed.result.outcome = 'success';
  await assert.rejects(() => observeInventory(f.storage, changed, f.options), expectedError(409, 'inventory_observation_id_conflict'));
  const b = await f.observation(target, { result: { outcome: 'success', http_status: 200, evidence_hash: 'c'.repeat(64) } });
  assert.equal(b.record.sequence, a.record.sequence + 1); assert.deepEqual(f.storage.rows.get(recordKey('observations', a.record.sequence)), a.record);
});
test('wrong observation action and publication target cannot become evidence for another write', async () => {
  const f = await fixture(), target = await f.put(), other = await f.put(), link = await f.prepare(await linkInput(f, other)); await f.commit(link); const before = rows(f);
  await assert.rejects(() => f.observation(target, { kind: 'delete-reply' }), expectedError(409));
  await assert.rejects(() => f.observation(target, { kind: 'publication', result: { publication_operation_id: link.plan.operation_id, publication_plan_hash: link.plan_hash } }), expectedError(409));
  assert.deepEqual(rows(f), before);
});
test('unknown DELETE target and ownership/version conflicts preserve all records', async () => {
  const f = await fixture(), target = await f.put(), input = await deleteInput(f, target), before = rows(f);
  input.resources[0].payload.target_write_id = id(); await assert.rejects(() => f.prepare(input), expectedError(409, 'inventory_target_unknown'));
  const wrong = await deleteInput(f, target); wrong.resources[0].owner_id = id(); await assert.rejects(() => f.prepare(wrong), expectedError(409, 'inventory_target_conflict'));
  assert.deepEqual(rows(f), before);
});
test('accepted DELETE permanently retires the exact key before its SQL acknowledgement', async () => {
  const f = await fixture(), target = await f.put(), input = await deleteInput(f, target), operation = await f.prepare(input);
  const key = await keyHash(target.item, inertGate()), retired = f.storage.rows.get('inventory:key-retired:' + key);
  assert.equal(retired.delete_write_id, input.resources[0].write_id); assert.equal(retired.hash, operation.plan.inventory_receipts[0].hash);
  assert.equal(f.control.state, 'pending'); await f.commit(operation);
  const deniedLink = await linkInput(f, target), before = rows(f); await assert.rejects(() => f.prepare(deniedLink), expectedError(409, 'inventory_key_retired'));
  await assert.rejects(() => dispatch(f, target), expectedError(409, 'inventory_key_retired')); assert.deepEqual(rows(f), before);
});
test('DELETE dispatch is metadata admission only and retains remote/application barriers', async () => {
  const f = await fixture(), target = await f.put(), input = await deleteInput(f, target), operation = await f.prepare(input); await f.commit(operation);
  const result = await dispatch(f, { item: input.resources[0], operation });
  assert.equal(result.dispatch_admitted, true); assert.equal(result.remote_terminal_proof, false); assert.equal(result.application_authority_required, true); assert.equal(result.clearance_available, false);
});
test('write ID reuse and new publication after retirement cannot replace old exact authority', async () => {
  const f = await fixture(), target = await f.put(), input = json(target.input); input.operation_id = id(); input.expected = f.control.marker; input.resources[0].operation_id = input.operation_id;
  const before = rows(f); await assert.rejects(() => f.prepare(input), expectedError(409, 'inventory_write_id_conflict')); assert.deepEqual(rows(f), before);
});
test('quarantine records late original observations without changing R, marker or recovery generation', async () => {
  const f = await fixture(), target = await f.put(), recovery = await f.begin(), before = json(f.control);
  await f.observation(target); assert.equal(f.control.state, 'quarantined'); assert.deepEqual(f.control.marker, before.marker);
  assert.deepEqual(f.control.registration_head, before.registration_head); assert.equal(f.control.recovery_generation_id, recovery.input.recovery_id);
  await assert.rejects(() => dispatch(f, target), expectedError(409));
});
test('GET page returns exact immutable cut high water and does not acknowledge progress', async () => {
  const f = await fixture(), target = await f.put(), observed = await f.observation(target), recovery = await f.begin(); await f.observation(target);
  const before = rows(f), selected = await f.page(recovery, 'observations', 32);
  assert.equal(selected.page.records.length, 1); assert.equal(selected.page.records[0].hash, observed.record.hash); assert.equal(selected.page.head.sequence, 1);
  assert.equal(selected.page.enumeration_at_cut_end, true); assert.deepEqual(rows(f), before);
});
test('missing or unknown-version record fails closed without a progress prefix', async () => {
  for (const mode of ['missing', 'unknown']) {
    const f = await fixture(); await f.put(); await f.put(); const recovery = await f.begin(), selected = await f.page(recovery, 'registrations', 2);
    const key = recordKey('registrations', 1); if (mode === 'missing') f.storage.rows.delete(key); else f.storage.rows.get(key).version = 9;
    const before = rows(f); await assert.rejects(() => f.advance(selected), expectedError(503)); assert.deepEqual(rows(f), before);
  }
});
test('a later valid chain cursor cannot skip independently acknowledged prefix work', async () => {
  const f = await fixture(); await f.put(); await f.put(); const recovery = await f.begin(), selected = await f.page(recovery), next = json(selected.input);
  const second = f.storage.rows.get(recordKey('registrations', 2)); next.after = { sequence: 2, hash: second.hash }; next.next = next.after; const before = rows(f);
  await assert.rejects(() => acknowledgeInventoryPage(f.storage, recovery.input.recovery_id, next, f.options), expectedError(409, 'enumeration_progress_stale'));
  assert.deepEqual(rows(f), before);
});
test('latest exact progress acknowledgement retries without changing its timestamp or ordinal', async () => {
  const f = await fixture(); await f.put(); const recovery = await f.begin(), selected = await f.page(recovery), accepted = await f.advance(selected), before = rows(f);
  const replay = await f.advance(selected); assert.deepEqual(replay, accepted); assert.deepEqual(rows(f), before);
});
test('lost A-to-B reply followed by B-to-C makes reordered A-to-B a nonmutating stale conflict', async () => {
  const f = await fixture(); await f.put(); await f.put(); const recovery = await f.begin(), a = await f.page(recovery); await f.advance(a);
  const b = await f.page(recovery); const latest = await f.advance(b), before = rows(f);
  await assert.rejects(() => f.advance(a), expectedError(409, 'enumeration_progress_stale')); assert.deepEqual(rows(f), before);
  const checked = await readInventoryProgress(f.storage, recovery.input.recovery_id, 'registrations', f.options);
  assert.equal(checked.progress.state_hash, latest.progress.state_hash); assert.equal(checked.progress.state.cursor.sequence, 2); assert.equal(checked.clearance_available, false);
});
test('changed page hash or limit cannot overwrite current progress or last acknowledgement', async () => {
  const f = await fixture(); await f.put(); const recovery = await f.begin(), selected = await f.page(recovery), input = json(selected.input); input.page_hash = 'c'.repeat(64); const before = rows(f);
  await assert.rejects(() => acknowledgeInventoryPage(f.storage, recovery.input.recovery_id, input, f.options), expectedError(409, 'enumeration_page_conflict')); assert.deepEqual(rows(f), before);
});
test('terminal empty page does not replace the latest acknowledgement or increment progress', async () => {
  const f = await fixture(); await f.put(); const recovery = await f.begin(); await f.advance(await f.page(recovery)); const selected = await f.page(recovery), before = rows(f);
  assert.equal(selected.page.records.length, 0); const result = await f.advance(selected); assert.equal(result.acknowledgement, null); assert.deepEqual(rows(f), before);
});
test('new cut carries actual acknowledged prefix and explicitly resets only selected chain', async () => {
  const f = await fixture(), target = await f.put(); await f.observation(target); const recovery = await f.begin();
  await f.advance(await f.page(recovery)); await f.advance(await f.page(recovery, 'observations')); await f.observation(target);
  const input = await cutInput(f, recovery, { carry_prefix: { registrations: true, observations: false } });
  const next = await createInventoryCut(f.storage, recovery.input.recovery_id, input, f.options);
  const r = await readInventoryProgress(f.storage, recovery.input.recovery_id, 'registrations', f.options), o = await readInventoryProgress(f.storage, recovery.input.recovery_id, 'observations', f.options);
  assert.equal(r.progress.state.cursor.sequence, 1); assert.equal(o.progress.state.cursor.sequence, 0); assert.equal(o.head.sequence, 2);
  assert.equal(r.progress.last_ack, null); assert.equal(next.cut.parent_progress.registrations.state_hash, input.expected_progress.registrations);
});
test('uncommitted/lost page cannot be carried as a privately remembered future prefix', async () => {
  const f = await fixture(); await f.put(); const recovery = await f.begin(), notAccepted = await f.page(recovery), input = await cutInput(f, recovery);
  await createInventoryCut(f.storage, recovery.input.recovery_id, input, f.options);
  const current = await readInventoryProgress(f.storage, recovery.input.recovery_id, 'registrations', f.options); assert.equal(current.progress.state.cursor.sequence, 0);
  const before = rows(f); await assert.rejects(() => f.advance(notAccepted), expectedError(409, 'enumeration_cut_stale')); assert.deepEqual(rows(f), before);
});
test('racing parent progress invalidates the whole new-cut CAS', async () => {
  const f = await fixture(); await f.put(); const recovery = await f.begin(), input = await cutInput(f, recovery); await f.advance(await f.page(recovery)); const before = rows(f);
  await assert.rejects(() => createInventoryCut(f.storage, recovery.input.recovery_id, input, f.options), expectedError(409, 'enumeration_progress_stale')); assert.deepEqual(rows(f), before);
});
test('old cut retry after successor returns immutable evidence without backward active-head movement', async () => {
  const f = await fixture(); await f.put(); const recovery = await f.begin(), firstInput = await cutInput(f, recovery);
  const first = await createInventoryCut(f.storage, recovery.input.recovery_id, firstInput, f.options), secondInput = await cutInput(f, recovery);
  const second = await createInventoryCut(f.storage, recovery.input.recovery_id, secondInput, f.options), before = rows(f);
  const replay = await createInventoryCut(f.storage, recovery.input.recovery_id, firstInput, f.options);
  assert.equal(replay.cut.cut_hash, first.cut.cut_hash); assert.equal(replay.active_cut.cut_hash, second.cut.cut_hash); assert.deepEqual(rows(f), before);
  await assert.rejects(() => createInventoryCut(f.storage, recovery.input.recovery_id, { ...firstInput, carry_prefix: { registrations: false, observations: true } }, f.options), expectedError(409, 'inventory_cut_conflict'));
});
test('malformed owned progress fails closed and is never reset', async () => {
  const f = await fixture(); await f.put(); const recovery = await f.begin(), key = progressKey(recovery.input.recovery_id, 'registrations');
  f.storage.rows.get(key).state.cursor.sequence = 50; const before = rows(f);
  await assert.rejects(() => readInventoryProgress(f.storage, recovery.input.recovery_id, 'registrations', f.options), expectedError(503)); assert.deepEqual(rows(f), before);
});
test('a coherently hashed genesis progress cannot fabricate an acknowledged later prefix', async () => {
  const f = await fixture(); await f.put(); const recovery = await f.begin(), key = progressKey(recovery.input.recovery_id, 'registrations');
  const record = f.storage.rows.get(key); record.state.cursor = json(f.control.registration_head);
  record.state_hash = await sha256(canonical({ kind: 'inventory-enumeration-state-v1', state: record.state })); const before = rows(f);
  await assert.rejects(() => readInventoryProgress(f.storage, recovery.input.recovery_id, 'registrations', f.options), expectedError(503)); assert.deepEqual(rows(f), before);
});
test('damaged retained parent capsule blocks a child cut without replacing any state', async () => {
  const f = await fixture(); await f.put(); const recovery = await f.begin(), input = await cutInput(f, recovery);
  await createInventoryCut(f.storage, recovery.input.recovery_id, input, f.options);
  f.storage.rows.get(cutKey(recovery.input.recovery_id, input.cut_id)).parent_progress.registrations.state_hash = 'c'.repeat(64); const before = rows(f);
  await assert.rejects(() => readInventoryProgress(f.storage, recovery.input.recovery_id, 'registrations', f.options), expectedError(503)); assert.deepEqual(rows(f), before);
});
test('partial storage write failure rolls progress and acknowledgement back atomically', async () => {
  const f = await fixture(); await f.put(); const recovery = await f.begin(), selected = await f.page(recovery), before = rows(f); f.storage.failPut = true;
  await assert.rejects(() => f.advance(selected)); f.storage.failPut = false; assert.deepEqual(rows(f), before);
  assert.equal((await readInventoryProgress(f.storage, recovery.input.recovery_id, 'registrations', f.options)).progress.state.cursor.sequence, 0);
});
test('HTTP rejects duplicate/noncanonical input and oversized input without reading journal state', async () => {
  const f = await fixture(), before = rows(f), input = putInput(f);
  for (const raw of [canonical(input).replace('"version":2', '"version":2,"version":2'), canonical(input).replace('"auth_epoch":1', '"auth_epoch":1e0')]) await f.http('/v2/operations/prepare', raw, { status: 400 });
  await f.http('/v2/operations/prepare', ' '.repeat(LIMITS.operation + 1), { status: 413 }); assert.deepEqual(rows(f), before);
});
test('no clearance, resume, key-unretire, SQL bootstrap or remote execution route exists', async () => {
  const f = await fixture(), before = rows(f);
  for (const path of ['/v2/clear', '/v2/resume-serving', '/v2/unretire-key', '/v2/control/bootstrap', '/v2/inventory/delete']) await f.http(path, v2({}), { status: 404 });
  assert.deepEqual(rows(f), before);
});

class FaultStorage extends MemoryStorage {
  constructor() { super(); this.loseReply = false; this.retry = null; this.trace = null; }
  async transaction(callback) {
    const run = tx => callback({ ...tx, get: async key => { this.trace?.(key); return tx.get(key); } });
    if (this.retry) {
      const change = this.retry; this.retry = null;
      const abandoned = new MemoryStorage(this.rows); await abandoned.transaction(run); await change(this);
    }
    const result = await super.transaction(run);
    if (this.loseReply) { this.loseReply = false; throw new Error('synthetic response lost after durable transaction commit'); }
    return result;
  }
}
test('prepare reply lost after commit retains one exact registration and pending fence', async () => {
  const storage = new FaultStorage(), f = await fixture({ storage }), input = putInput(f); storage.loseReply = true;
  await assert.rejects(() => f.prepare(input));
  const lookup = await lookupInventoryOperation(storage, input.operation_id, f.options);
  assert.equal(lookup.operation.status, 'pending'); assert.equal(lookup.operation.plan.resources[0].write_id, input.allocations.id_0);
  assert.equal(storage.rows.get(metaKey('registrations')).sequence, 1); await f.commit(lookup.operation);
});
test('DELETE registration reply loss retains the permanent key fence despite unknown SQL outcome', async () => {
  const storage = new FaultStorage(), f = await fixture({ storage }), target = await f.put(), input = await deleteInput(f, target); storage.loseReply = true;
  await assert.rejects(() => f.prepare(input)); const key = await keyHash(target.item, inertGate());
  assert.equal(storage.rows.get('inventory:key-retired:' + key).delete_write_id, input.allocations.id_0);
  assert.equal((await readInventoryControl(storage, f.options)).control.state, 'pending');
});
test('lost acknowledgement reply is reconciled as committed and preserves later exact evidence', async () => {
  const storage = new FaultStorage(), f = await fixture({ storage }), operation = await f.prepare(putInput(f)); storage.loseReply = true;
  await assert.rejects(() => f.commit(operation)); const before = rows(f);
  const lookup = await lookupInventoryOperation(storage, operation.plan.operation_id, f.options); assert.equal(lookup.operation.status, 'committed');
  const retry = await acknowledgeInventory(storage, operation.plan.operation_id, ack(operation), f.options);
  assert.equal(retry.operation.status, 'committed'); assert.deepEqual(rows(f), before);
});
test('progress reply lost after commit is fully durable and reconciled through checked GET', async () => {
  const storage = new FaultStorage(), f = await fixture({ storage }); await f.put(); const recovery = await f.begin(), selected = await f.page(recovery); storage.loseReply = true;
  await assert.rejects(() => f.advance(selected));
  const current = await readInventoryProgress(storage, recovery.input.recovery_id, 'registrations', f.options);
  assert.equal(current.progress.state.cursor.sequence, 1); const before = rows(f);
  const replay = await f.advance(selected); assert.equal(replay.acknowledgement.next_state_hash, current.progress.state_hash); assert.deepEqual(rows(f), before);
});
test('cut reply lost after commit returns the exact immutable cut without transferring twice', async () => {
  const storage = new FaultStorage(), f = await fixture({ storage }); await f.put(); const recovery = await f.begin(); await f.advance(await f.page(recovery));
  const input = await cutInput(f, recovery); storage.loseReply = true;
  await assert.rejects(() => createInventoryCut(storage, recovery.input.recovery_id, input, f.options)); const before = rows(f);
  const replay = await createInventoryCut(storage, recovery.input.recovery_id, input, f.options);
  assert.equal(replay.immutable_evidence_only, true); assert.equal(replay.cut.parent_progress.registrations.state.cursor.sequence, 1); assert.deepEqual(rows(f), before);
});
test('native-style transaction callback retry cannot reuse checked plans from an abandoned snapshot', async () => {
  const storage = new FaultStorage(), f = await fixture({ storage }), target = await f.put();
  storage.retry = async current => { current.rows.get(planKey(target.input.operation_id)).plan_hash = 'c'.repeat(64); };
  await assert.rejects(() => readInventoryControl(storage, f.options), expectedError(503));
});
test('missing original plan/index is not accepted through an otherwise matching inventory head', async () => {
  const f = await fixture(), target = await f.put(); f.storage.rows.delete(planKey(target.input.operation_id)); const before = rows(f);
  await assert.rejects(() => readInventoryControl(f.storage, f.options), expectedError(503)); assert.deepEqual(rows(f), before);
});
for (const mode of ['cancellation', 'deadline']) test(`late final progress-view hash ${mode} cannot return HTTP success`, async () => {
  const f = await fixture(); await f.put(); const recovery = await f.begin(), before = rows(f);
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), controller = new AbortController();
  // Keep this fixture alive while production's deadline timer is unref'd; if
  // the gate fails, releasing the hash yields a meaningful HTTP assertion.
  const watchdog = setTimeout(() => release.resolve(), 5000);
  const subtle = crypto.subtle, original = subtle.digest; let held = false, response;
  subtle.digest = function(algorithm, data) {
    const text = new TextDecoder().decode(data);
    if (!held && text.includes('"progress":') && text.includes('"clearance_available":false')) {
      held = true; entered.resolve(); return release.promise.then(() => original.call(this, algorithm, data));
    }
    return original.call(this, algorithm, data);
  };
  try {
    const pending = f.http(`/v2/recovery/${recovery.input.recovery_id}/enumeration-progress?chain=registrations`, undefined,
      { status: 503, signal: controller.signal, deadlineMs: mode === 'deadline' ? 1000 : 3000 });
    await Promise.race([entered.promise, pending.then(() => { if (!held) assert.fail('Request ended before the intended final hash fault'); })]);
    if (mode === 'cancellation') controller.abort(); response = await pending;
    assert.match(response.value.error, mode === 'deadline' ? /deadline/ : /aborted/); assert.equal(held, true); assert.deepEqual(rows(f), before);
  } finally { clearTimeout(watchdog); release.resolve(); subtle.digest = original; }
});
test('pre-aborted request reads no journal state and returns no success', async () => {
  const f = await fixture(), controller = new AbortController(), calls = f.storage.calls; controller.abort();
  await f.http('/v2/control', undefined, { status: 503, signal: controller.signal }); assert.equal(f.storage.calls, calls);
});
test('configured page limit rejects the whole request instead of silently returning a shorter prefix', async () => {
  const f = await fixture(); await f.put(); await f.put(); const recovery = await f.begin(), selected = await f.page(recovery, 'registrations', 2), before = rows(f);
  await assert.rejects(() => readInventoryPage(f.storage, recovery.input.recovery_id, 'registrations', { cut_id: selected.page.cut_id, after: selected.page.after, limit: 2 }, { ...f.options, pageLimit: 1 }), expectedError(400));
  assert.deepEqual(rows(f), before);
});
test('maximum 32 publication records verify 64 distinct original plans and all 2048 restriction facts', { timeout: 120000 }, async () => {
  const storage = new FaultStorage(), f = await fixture({ storage });
  for (let index = 0; index < 32; index++) {
    const input = putInput(f); input.events = Array.from({ length: 32 }, () => event());
    const operation = await f.prepare(input); await f.commit(operation); const target = { item: input.resources[0], operation };
    const link = await linkInput(f, target); link.events = Array.from({ length: 32 }, () => event());
    const publication = await f.prepare(link); await f.commit(publication);
    await f.observation(target, { kind: 'publication', result: { publication_operation_id: publication.plan.operation_id, publication_plan_hash: publication.plan_hash } });
  }
  const recovery = await f.begin(), uniquePlans = new Set(), uniqueRestrictions = new Set();
  storage.trace = key => { if (key.startsWith('plan:')) uniquePlans.add(key); if (/^event:[0-9]{16}$/.test(key)) uniqueRestrictions.add(key); };
  const selected = await f.page(recovery, 'observations', 32); storage.trace = null;
  assert.equal(selected.page.records.length, 32); assert.equal(uniquePlans.size, 64); assert.equal(uniqueRestrictions.size, 2048);
  assert.equal(selected.page.has_more, false); assert.equal(selected.page.next.hash, selected.page.head.hash);
  assert.equal((await readInventoryControl(storage, f.options)).clearance_available, false);
});
