import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MemoryStorage, env } from './fixtures.mjs';
import { PROJECT_ID, canonical, sha256 } from '../src/journal.mjs';
import { bootstrapControl, prepareOperation, acknowledgeOperation, CONTROL_KEY } from '../src/operations.mjs';
import { upgradeInventory, prepareInventory, acknowledgeInventory, observeInventory, beginInventoryRecovery,
  readInventoryProgress, readInventoryPage, acknowledgeInventoryPage, handleInventoryRequest } from '../src/inventory.mjs';

export { env, PROJECT_ID, canonical, sha256, MemoryStorage };
export const id = () => randomUUID();
export const hash = () => 'a'.repeat(64);
export const v2 = fields => ({ version: 2, project_id: PROJECT_ID, ...fields });
export const json = value => JSON.parse(JSON.stringify(value));
export const expectedError = (status, code) => error => error.status === status && (!code || error.code === code);

/** Every fixture owns a fresh rollback-capable in-memory ledger. No app DB,
 * provider or synthetic serving initializer is added to production. */
export async function fixture({ storage = new MemoryStorage(), history = false } = {}) {
  let tick = 1700000000000;
  const options = { now: () => ++tick, pageLimit: 32 };
  const initial = await bootstrapControl(storage, { version: 1, project_id: PROJECT_ID, database_id: id(), bootstrap_id: id() }, options.now);
  let oldMarker = initial.control.marker, historical;
  if (history) {
    historical = (await prepareOperation(storage, { version: 1, project_id: PROJECT_ID, operation_id: id(), input_hash: hash(),
      expected: oldMarker, allocations: {}, events: [] }, options.now)).operation;
    await acknowledgeOperation(storage, historical.plan.operation_id, { version: 1, project_id: PROJECT_ID,
      marker: historical.plan.next, plan_hash: historical.plan_hash }, options.now);
    oldMarker = historical.plan.next;
  }
  const oldRows = structuredClone(storage.rows), upgrade = v2({ upgrade_id: id(), expected: oldMarker,
    expected_control_hash: await sha256(canonical(storage.rows.get(CONTROL_KEY))), coverage_anchor_hash: 'b'.repeat(64) });
  const upgraded = await upgradeInventory(storage, upgrade, options);
  const f = { storage, options, control: upgraded.control, initial, upgrade, upgraded, historical, oldRows,
    async prepare(input) { const result = await prepareInventory(storage, input, options); f.control = result.control; return result.operation; },
    async commit(operation) {
      const result = await acknowledgeInventory(storage, operation.plan.operation_id, v2({ plan_hash: operation.plan_hash,
        marker: operation.plan.next, writer_generation_id: operation.plan.writer_generation_id }), options);
      f.control = result.control; return result.operation;
    },
    async put(fields = {}) { const input = putInput(f, fields); const operation = await f.prepare(input); await f.commit(operation); return { input, operation, item: input.resources[0] }; },
    async observation(target, fields = {}) {
      const input = v2({ observation_id: id(), write_id: target.item.write_id, registration_hash: target.operation.plan.inventory_receipts[0].hash,
        plan_hash: target.operation.plan_hash, kind: target.item.action === 'delete' ? 'delete-reply' : 'put-reply',
        result: { outcome: 'unknown', http_status: null, evidence_hash: hash() }, ...fields });
      const result = await observeInventory(storage, input, options); f.control = result.control; return { input, record: result.observation };
    },
    async begin() {
      const input = v2({ recovery_id: id(), cut_id: id(), expected: f.control.marker, writer_generation_id: f.control.writer_generation_id });
      const result = await beginInventoryRecovery(storage, input, options); f.control = result.control;
      return { input, ...result };
    },
    async page(recovery, chain = 'registrations', limit = 1) {
      const progress = await readInventoryProgress(storage, recovery.input.recovery_id, chain, options);
      const page = await readInventoryPage(storage, recovery.input.recovery_id, chain,
        { cut_id: progress.active_cut.cut_id, after: progress.progress.state.cursor, limit }, options);
      const input = v2({ recovery_id: recovery.input.recovery_id, recovery_generation_id: page.recovery_generation_id,
        chain, cut_id: page.cut_id, cut_hash: page.cut_hash, expected_state_hash: progress.progress.state_hash,
        after: page.after, limit, page_hash: page.page_hash, next: page.next });
      return { input, page, progress };
    },
    async advance(page) { return acknowledgeInventoryPage(storage, page.input.recovery_id, page.input, options); },
    async http(pathname, body, { status = 200, headers = {}, signal, deadlineMs } = {}) {
      const request = new Request('https://journal.invalid' + pathname, { method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: 'Bearer ' + env.RESTORE_JOURNAL_TOKEN, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: typeof body === 'string' ? body : canonical(body) }), ...(signal ? { signal } : {}) });
      const response = await handleInventoryRequest(request, { ...env, RESTORE_INVENTORY_PAGE_LIMIT: '32' }, storage, { now: options.now, ...(deadlineMs ? { deadlineMs } : {}) });
      const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return { response, value };
    } };
  return f;
}
export function operationInput(f, fields = {}) {
  return v2({ operation_id: id(), input_hash: hash(), expected: f.control.marker, writer_generation_id: f.control.writer_generation_id,
    allocations: {}, events: [], resources: [], links: [], ...fields });
}
export function putInput(f, fields = {}) {
  const operation_id = id(), write_id = id(), owner_id = id(), asset_id = id(), asset_version = id();
  const item = { version: 1, project_id: PROJECT_ID, operation_id, write_id,
    database_id: f.control.marker.database_id, incarnation_id: f.control.marker.incarnation_id,
    writer_generation_id: f.control.writer_generation_id, action: 'put', kind: 'direct-source', owner_id, asset_id, asset_version,
    bucket: 'QUARANTINE', object_key: `source/${owner_id}/${asset_id}/${asset_version}/${write_id}`,
    authority: { session_id: id(), auth_epoch: 1, purpose: 'photo_processing', consent_id: id(), policy_version: 'test-policy-v1', consent_created_at: 1, consent_expires_at: null },
    payload: { byte_size: 3, sha256: hash(), content_type: 'image/jpeg', source_byte_size: 3, offset_bytes: null, transfer_sha256: null }, ...fields };
  return operationInput(f, { operation_id, allocations: { id_0: write_id }, resources: [item] });
}
export async function linkInput(f, target) {
  const input = operationInput(f), item = target.item;
  input.links = [{ version: 1, project_id: PROJECT_ID, operation_id: input.operation_id, writer_generation_id: input.writer_generation_id,
    owner_id: item.owner_id, asset_id: item.asset_id, asset_version: item.asset_version, target_write_id: item.write_id,
    target_descriptor_hash: await sha256(canonical(item)), relation: item.kind === 'upload-chunk' ? 'upload-chunk' : 'asset-source', offset_bytes: item.payload.offset_bytes }];
  return input;
}
export async function deleteInput(f, target) {
  const input = operationInput(f, { allocations: { id_0: id() } }), old = target.item;
  input.resources = [{ version: 1, project_id: PROJECT_ID, operation_id: input.operation_id, write_id: input.allocations.id_0,
    database_id: input.expected.database_id, incarnation_id: input.expected.incarnation_id, writer_generation_id: input.writer_generation_id,
    action: 'delete', kind: 'retired-upload-delete', owner_id: old.owner_id, asset_id: old.asset_id, asset_version: old.asset_version,
    bucket: old.bucket, object_key: old.object_key, authority: { cleanup_intent_id: id(), deletion_request_id: null, cleanup_authority_hash: hash() },
    payload: { target_write_id: old.write_id, target_descriptor_hash: await sha256(canonical(old)), expected_sha256: old.payload.sha256,
      expected_byte_size: old.payload.byte_size, expected_etag: null } }];
  return input;
}
export async function cutInput(f, recovery, fields = {}) {
  const progress = {};
  for (const chain of ['registrations', 'observations']) progress[chain] = await readInventoryProgress(f.storage, recovery.input.recovery_id, chain, f.options);
  return v2({ recovery_id: recovery.input.recovery_id, cut_id: id(), expected_parent_cut_id: progress.registrations.active_cut.cut_id,
    expected_parent_cut_hash: progress.registrations.active_cut.cut_hash,
    expected_progress: Object.fromEntries(Object.entries(progress).map(([key, value]) => [key, value.progress.state_hash])),
    carry_prefix: { registrations: true, observations: true }, ...fields });
}
