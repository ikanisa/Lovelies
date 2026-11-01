/** Bounded immutable restriction manifests. Chunks are staged without serving
 * authority; only a complete root can acquire the pending transaction fence.
 * Once fenced, each continuation appends at most 32 authenticated facts. */
import { PROJECT_ID, PROTOCOL, GENESIS_HASH, canonical, sha256, exact, fail, validateEvent,
  loadHead, headView, appendEventTransaction, checkedReceipt } from './journal.mjs';
import { CONTROL_KEY, planKey, prepareKey, validateMarker, loadControl, checkedPlan, operationView } from './operations.mjs';

export const MANIFEST_CHUNK_SIZE = 32;
export const manifestKey = id => 'manifest:v2:' + id;
export const manifestChunkKey = (id, index) => 'manifest:v2:chunk:' + id + ':' + String(index).padStart(16, '0');
export const manifestProgressKey = id => 'manifest:v2:progress:' + id;
const eventIndex = (id, event) => 'manifest:v2:event:' + id + ':' + event;
const uuid = x => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
const hash = x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
const uint = x => Number.isSafeInteger(x) && x >= 0;
const equal = (a, b) => canonical(a) === canonical(b);
const corrupt = () => fail(503, 'journal_integrity_failed');
const envelope = control => ({ protocol: PROTOCOL, project_id: PROJECT_ID, control: {
  state: control.state, marker: control.marker, pending_operation_id: control.pending_operation_id,
  recovery_generation_id: control.recovery_generation_id } });
const headerFields = ['version', 'project_id', 'operation_id', 'input_hash', 'expected', 'allocations', 'event_manifest'];
export function validateManifestHeader(value) {
  if (!exact(value, headerFields) || value.version !== 2 || value.project_id !== PROJECT_ID || !uuid(value.operation_id) || !hash(value.input_hash) ||
    !value.allocations || typeof value.allocations !== 'object' || Array.isArray(value.allocations) || Object.keys(value.allocations).length > 32 ||
    Object.entries(value.allocations).some(([key, id]) => !/^id_(?:[0-9]|[12][0-9]|3[01])$/.test(key) || !uuid(id)) ||
    new Set(Object.values(value.allocations)).size !== Object.values(value.allocations).length ||
    !exact(value.event_manifest, ['count', 'chunks', 'root']) || !uint(value.event_manifest.count) ||
    !uint(value.event_manifest.chunks) || value.event_manifest.chunks !== Math.ceil(value.event_manifest.count / MANIFEST_CHUNK_SIZE) ||
    !hash(value.event_manifest.root) || value.event_manifest.count === 0 && value.event_manifest.root !== GENESIS_HASH) fail(400, 'manifest_invalid');
  const expected = validateMarker(value.expected);
  if (value.event_manifest.count > Number.MAX_SAFE_INTEGER - expected.cursor.sequence || expected.checkpoint.revision >= Number.MAX_SAFE_INTEGER) fail(503, 'journal_sequence_exhausted');
  return { ...value, expected, allocations: { ...value.allocations }, event_manifest: { ...value.event_manifest } };
}
export const manifestChunkHash = (operation_id, index, previous_hash, events) => sha256(canonical({
  protocol: PROTOCOL, kind: 'restriction-manifest-chunk-v2', project_id: PROJECT_ID, operation_id, index, previous_hash, events }));
export const manifestCheckpointHash = (header, cursor) => sha256(canonical({ protocol: PROTOCOL,
  kind: 'database-checkpoint-v2', project_id: PROJECT_ID, operation_id: header.operation_id, input_hash: header.input_hash,
  expected: header.expected, allocations: header.allocations, event_manifest: header.event_manifest, cursor }));
async function loadManifest(txn, id) {
  const stored = await txn.get(manifestKey(id));
  if (stored === undefined) return undefined;
  if (!exact(stored, ['header', 'header_hash', 'prepared_at', 'uploaded_chunks', 'uploaded_count', 'uploaded_root', 'cursor']) || !hash(stored.header_hash) ||
    !uint(stored.uploaded_chunks) || !uint(stored.uploaded_count) || !hash(stored.uploaded_root) || !Number.isSafeInteger(stored.prepared_at) || stored.prepared_at < 1) corrupt();
  let header; try { header = validateManifestHeader(stored.header); } catch { corrupt(); }
  if (header.operation_id !== id || stored.header_hash !== await sha256(canonical(header)) ||
    stored.uploaded_chunks > header.event_manifest.chunks || stored.uploaded_count > header.event_manifest.count ||
    stored.uploaded_count !== Math.min(stored.uploaded_chunks * MANIFEST_CHUNK_SIZE, header.event_manifest.count) ||
    !exact(stored.cursor, ['sequence', 'hash']) || stored.cursor.sequence !== header.expected.cursor.sequence + stored.uploaded_count || !hash(stored.cursor.hash) ||
    stored.uploaded_chunks === 0 && (stored.uploaded_root !== GENESIS_HASH || !equal(stored.cursor, header.expected.cursor)) ||
    stored.uploaded_chunks === header.event_manifest.chunks && stored.uploaded_root !== header.event_manifest.root) corrupt();
  return stored;
}
async function loadChunk(txn, manifest, index) {
  const id = manifest.header.operation_id, value = await txn.get(manifestChunkKey(id, index));
  if (!exact(value, ['index', 'previous_hash', 'hash', 'events', 'receipts', 'before', 'after']) || value.index !== index || !hash(value.previous_hash) || !hash(value.hash) ||
    !Array.isArray(value.events) || value.events.length !== Math.min(MANIFEST_CHUNK_SIZE, manifest.header.event_manifest.count - index * MANIFEST_CHUNK_SIZE) ||
    !Array.isArray(value.receipts) || value.receipts.length !== value.events.length) corrupt();
  let events; try { events = value.events.map(validateEvent); } catch { corrupt(); }
  if (value.hash !== await manifestChunkHash(id, index, value.previous_hash, events)) corrupt();
  let cursor = index === 0 ? manifest.header.expected.cursor : (await txn.get(manifestChunkKey(id, index - 1)))?.after;
  const priorRoot = index === 0 ? GENESIS_HASH : (await txn.get(manifestChunkKey(id, index - 1)))?.hash;
  if (!cursor || !hash(cursor.hash) || !uint(cursor.sequence) || !equal(value.before, cursor) || priorRoot !== value.previous_hash) corrupt();
  for (let i = 0; i < events.length; i++) {
    const payload_hash = await sha256(canonical(events[i])), sequence = cursor.sequence + 1;
    const receipt = { sequence, previous_hash: cursor.hash, payload_hash, recorded_at: manifest.prepared_at, event: events[i] };
    receipt.hash = await sha256(canonical({ protocol: PROTOCOL, project_id: PROJECT_ID, sequence, previous_hash: cursor.hash, payload_hash, recorded_at: manifest.prepared_at }));
    if (!equal(receipt, value.receipts[i]) || await txn.get(eventIndex(id, events[i].operation_id)) !== index) corrupt();
    cursor = headView(receipt);
  }
  if (!equal(cursor, value.after)) corrupt();
  return value;
}
export async function beginManifest(storage, raw, now = Date.now) {
  const header = validateManifestHeader(raw), header_hash = await sha256(canonical(header));
  return storage.transaction(async txn => {
    const head = await loadHead(txn), control = await loadControl(txn);
    if (!control) fail(409, 'control_uninitialized');
    const existing = await loadManifest(txn, header.operation_id);
    if (existing) {
      if (existing.header_hash !== header_hash || !equal(existing.header, header)) fail(409, 'operation_conflict');
      return { ...envelope(control), manifest: existing };
    }
    if (control.state !== 'serving' || !equal(control.marker, header.expected) || !equal(headView(head), header.expected.cursor)) fail(409, 'manifest_admission_denied');
    if (await txn.get(planKey(header.operation_id)) !== undefined) fail(409, 'operation_conflict');
    const tick = now(); if (!Number.isSafeInteger(tick) || tick < 1) fail(503, 'journal_clock_invalid');
    const manifest = { header, header_hash, prepared_at: Math.max(tick, head.recorded_at), uploaded_chunks: 0, uploaded_count: 0,
      uploaded_root: GENESIS_HASH, cursor: header.expected.cursor };
    await txn.put({ [manifestKey(header.operation_id)]: manifest });
    return { ...envelope(control), manifest };
  });
}
export async function uploadManifestChunk(storage, id, raw) {
  if (!uuid(id) || !exact(raw, ['version', 'project_id', 'index', 'previous_hash', 'hash', 'events']) || raw.version !== 2 || raw.project_id !== PROJECT_ID ||
    !uint(raw.index) || !hash(raw.previous_hash) || !hash(raw.hash) || !Array.isArray(raw.events) || !raw.events.length || raw.events.length > MANIFEST_CHUNK_SIZE) fail(400, 'manifest_chunk_invalid');
  const events = raw.events.map(validateEvent);
  if (new Set(events.map(x => x.operation_id)).size !== events.length || raw.hash !== await manifestChunkHash(id, raw.index, raw.previous_hash, events)) fail(400, 'manifest_chunk_invalid');
  return storage.transaction(async txn => {
    await loadHead(txn); const control = await loadControl(txn), manifest = await loadManifest(txn, id);
    if (!control || !manifest) fail(404, 'manifest_not_found');
    if (raw.index < manifest.uploaded_chunks) {
      const stored = await loadChunk(txn, manifest, raw.index);
      if (stored.hash !== raw.hash || stored.previous_hash !== raw.previous_hash || !equal(stored.events, events)) fail(409, 'operation_conflict');
      return { ...envelope(control), manifest };
    }
    if (control.state !== 'serving' || !equal(control.marker, manifest.header.expected)) fail(409, 'manifest_admission_denied');
    if (raw.index !== manifest.uploaded_chunks || raw.index >= manifest.header.event_manifest.chunks || raw.previous_hash !== manifest.uploaded_root ||
      events.length !== Math.min(MANIFEST_CHUNK_SIZE, manifest.header.event_manifest.count - manifest.uploaded_count)) fail(409, 'manifest_chunk_order');
    const receipts = []; let cursor = manifest.cursor;
    for (const event of events) {
      if (await txn.get(eventIndex(id, event.operation_id)) !== undefined) fail(409, 'manifest_event_duplicate');
      const payload_hash = await sha256(canonical(event)), sequence = cursor.sequence + 1;
      const receipt = { sequence, previous_hash: cursor.hash, payload_hash, recorded_at: manifest.prepared_at, event };
      receipt.hash = await sha256(canonical({ protocol: PROTOCOL, project_id: PROJECT_ID, sequence, previous_hash: cursor.hash, payload_hash, recorded_at: manifest.prepared_at }));
      receipts.push(receipt); cursor = headView(receipt);
    }
    const next = { ...manifest, uploaded_chunks: raw.index + 1, uploaded_count: manifest.uploaded_count + events.length, uploaded_root: raw.hash, cursor };
    if (next.uploaded_chunks === next.header.event_manifest.chunks && next.uploaded_root !== next.header.event_manifest.root) fail(409, 'manifest_root_mismatch');
    const chunk = { index: raw.index, previous_hash: raw.previous_hash, hash: raw.hash, events, receipts, before: manifest.cursor, after: cursor };
    const updates = { [manifestKey(id)]: next, [manifestChunkKey(id, raw.index)]: chunk };
    for (const event of events) updates[eventIndex(id, event.operation_id)] = raw.index;
    await txn.put(updates); return { ...envelope(control), manifest: next };
  });
}
export async function checkedManifestPlan(txn, id, value) {
  if (!exact(value, ['plan', 'plan_hash']) || !hash(value.plan_hash) || !exact(value.plan, [...headerFields, 'next', 'prepared_at'])) corrupt();
  const header = Object.fromEntries(headerFields.map(key => [key, value.plan[key]]));
  try { validateManifestHeader(header); validateMarker(value.plan.next); } catch { corrupt(); }
  const manifest = await loadManifest(txn, id), indexed = await txn.get(prepareKey(value.plan.next.checkpoint.revision));
  if (!manifest || !equal(manifest.header, header) || manifest.uploaded_chunks !== header.event_manifest.chunks ||
    value.plan.prepared_at !== manifest.prepared_at || value.plan.next.database_id !== header.expected.database_id ||
    value.plan.next.incarnation_id !== header.expected.incarnation_id || value.plan.next.checkpoint.revision !== header.expected.checkpoint.revision + 1 ||
    !equal(value.plan.next.cursor, manifest.cursor) || value.plan.next.checkpoint.hash !== await manifestCheckpointHash(header, manifest.cursor) ||
    value.plan_hash !== await sha256(canonical(value.plan)) || !exact(indexed, ['operation_id', 'plan_hash']) || indexed.operation_id !== id || indexed.plan_hash !== value.plan_hash) corrupt();
  const progress = await txn.get(manifestProgressKey(id));
  if (!exact(progress, ['chunks', 'cursor']) || !uint(progress.chunks) || progress.chunks > header.event_manifest.chunks ||
    !equal(progress.cursor, progress.chunks === 0 ? header.expected.cursor : (await loadChunk(txn, manifest, progress.chunks - 1)).after)) corrupt();
  if (progress.cursor.sequence > 0 && (await checkedReceipt(txn, progress.cursor.sequence)).hash !== progress.cursor.hash) corrupt();
  return value;
}
export async function manifestPreparing(txn, operation) {
  if (operation.plan.version !== 2) return false;
  const progress = await txn.get(manifestProgressKey(operation.plan.operation_id));
  if (!progress || !uint(progress.chunks)) corrupt();
  return progress.chunks !== operation.plan.event_manifest.chunks;
}
export async function prepareManifest(storage, id, raw) {
  if (!uuid(id) || !exact(raw, ['version', 'project_id', 'header_hash']) || raw.version !== 2 || raw.project_id !== PROJECT_ID || !hash(raw.header_hash)) fail(400, 'manifest_invalid');
  return storage.transaction(async txn => {
    const head = await loadHead(txn), control = await loadControl(txn), manifest = await loadManifest(txn, id);
    if (!control || !manifest) fail(404, 'manifest_not_found');
    if (manifest.header_hash !== raw.header_hash) fail(409, 'operation_conflict');
    const old = await checkedPlan(txn, id);
    if (old) return { ...envelope(control), operation: await operationView(txn, old, control) };
    if (control.state !== 'serving' || !equal(control.marker, manifest.header.expected) || !equal(headView(head), manifest.header.expected.cursor)) fail(409, 'manifest_admission_denied');
    if (manifest.uploaded_chunks !== manifest.header.event_manifest.chunks || manifest.uploaded_root !== manifest.header.event_manifest.root) fail(409, 'manifest_incomplete');
    const next = { ...manifest.header.expected, checkpoint: { revision: manifest.header.expected.checkpoint.revision + 1,
      hash: await manifestCheckpointHash(manifest.header, manifest.cursor) }, cursor: manifest.cursor };
    const plan = { ...manifest.header, next, prepared_at: manifest.prepared_at }, operation = { plan, plan_hash: await sha256(canonical(plan)) };
    const pending = { ...control, state: 'pending', pending_operation_id: id };
    await txn.put({ [planKey(id)]: operation, [prepareKey(next.checkpoint.revision)]: { operation_id: id, plan_hash: operation.plan_hash },
      [manifestProgressKey(id)]: { chunks: 0, cursor: manifest.header.expected.cursor }, [CONTROL_KEY]: pending });
    return { ...envelope(pending), operation: { ...operation, status: manifest.header.event_manifest.chunks ? 'preparing' : 'pending', committed_at: null } };
  });
}
export async function continueManifest(storage, id, raw) {
  if (!uuid(id) || !exact(raw, ['version', 'project_id', 'plan_hash']) || raw.version !== 2 || raw.project_id !== PROJECT_ID || !hash(raw.plan_hash)) fail(400, 'manifest_invalid');
  return storage.transaction(async txn => {
    const head = await loadHead(txn), control = await loadControl(txn), manifest = await loadManifest(txn, id), operation = await checkedPlan(txn, id);
    if (!control || !manifest || !operation || operation.plan.version !== 2) fail(404, 'manifest_not_found');
    if (operation.plan_hash !== raw.plan_hash) fail(409, 'operation_conflict');
    const current = await operationView(txn, operation, control);
    if (current.status !== 'preparing') return { ...envelope(control), operation: current };
    if (control.pending_operation_id !== id || !['pending', 'quarantined'].includes(control.state)) fail(409, 'manifest_admission_denied');
    const progress = await txn.get(manifestProgressKey(id));
    if (!equal(progress.cursor, headView(head))) corrupt();
    const chunk = await loadChunk(txn, manifest, progress.chunks);
    for (let index = 0; index < chunk.events.length; index++) {
      const receipt = await appendEventTransaction(txn, chunk.events[index], chunk.receipts[index].payload_hash, () => manifest.prepared_at, { manifest: true });
      if (!equal(receipt, chunk.receipts[index])) corrupt();
    }
    const next = { chunks: progress.chunks + 1, cursor: chunk.after };
    await txn.put({ [manifestProgressKey(id)]: next });
    return { ...envelope(control), operation: { ...operation, status: next.chunks === manifest.header.event_manifest.chunks ? 'pending' : 'preparing', committed_at: null } };
  });
}
