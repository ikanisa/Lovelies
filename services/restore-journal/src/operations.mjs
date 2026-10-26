/**
 * Independent database admission and write-ahead operation protocol.
 * This service never contacts PostgreSQL or certifies replay/object cleanup.
 * Only the trusted database adapter may acknowledge an exact committed marker.
 */
import {
  PROJECT_ID, PROTOCOL, GENESIS_HASH, HEAD_KEY, authenticate, canonical, sha256,
  exact, plain, fail, uuidPattern, hashPattern, validateEvent, readJson,
  loadHead, headView, checkedReceipt, appendEventTransaction, response, errorResponse,
} from './journal.mjs';

export const MAX_OPERATION_BYTES = 32_768;
export const MAX_RESPONSE_BYTES = 131_072;
export const MAX_MANIFEST_EVENTS = 32;
export const MAX_ALLOCATIONS = 32;
export const CONTROL_KEY = 'control:v1';
export const BINDING_KEY = 'binding:v1';
export const planKey = id => 'plan:' + id;
export const commitKey = revision => 'commit:' + String(revision).padStart(16, '0');
export const prepareKey = revision => 'prepare:' + String(revision).padStart(16, '0');
export const recoveryKey = id => 'recovery:' + id;

const encoder = new TextEncoder();
const equal = (a, b) => canonical(a) === canonical(b);
const unsigned = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const uuid = value => typeof value === 'string' && uuidPattern.test(value);
const digest = value => typeof value === 'string' && hashPattern.test(value);
const nullableUuid = value => value === null || uuid(value);
const reasons = new Set(['marker_mismatch', 'acknowledgement_mismatch', 'journal_advanced', 'planned_restore', 'preexisting_restrictions']);
const requireEnvelope = (value, fields, code) => {
  if (!exact(value, ['version', 'project_id', ...fields]) || value.version !== 1 || value.project_id !== PROJECT_ID) fail(400, code);
};

export function validateMarker(value) {
  if (!exact(value, ['database_id', 'incarnation_id', 'checkpoint', 'cursor']) || !uuid(value.database_id) || !uuid(value.incarnation_id) ||
      !exact(value.checkpoint, ['revision', 'hash']) || !unsigned(value.checkpoint.revision) || !digest(value.checkpoint.hash) ||
      !exact(value.cursor, ['sequence', 'hash']) || !unsigned(value.cursor.sequence) || !digest(value.cursor.hash) ||
      value.cursor.sequence === 0 && value.cursor.hash !== GENESIS_HASH) fail(400, 'marker_invalid');
  return { database_id: value.database_id, incarnation_id: value.incarnation_id,
    checkpoint: { revision: value.checkpoint.revision, hash: value.checkpoint.hash }, cursor: { ...value.cursor } };
}

export function validatePrepare(value) {
  requireEnvelope(value, ['operation_id', 'input_hash', 'expected', 'allocations', 'events'], 'operation_invalid');
  if (!uuid(value.operation_id) || !digest(value.input_hash) || !plain(value.allocations) || Object.keys(value.allocations).length > MAX_ALLOCATIONS ||
      Object.entries(value.allocations).some(([key, id]) => !/^id_(?:[0-9]|[12][0-9]|3[01])$/.test(key) || !uuid(id)) ||
      new Set(Object.values(value.allocations)).size !== Object.values(value.allocations).length ||
      !Array.isArray(value.events) || value.events.length > MAX_MANIFEST_EVENTS) fail(400, 'operation_invalid');
  const expected = validateMarker(value.expected), events = value.events.map(validateEvent);
  if (new Set(events.map(event => event.operation_id)).size !== events.length) fail(400, 'operation_invalid');
  const result = { version: 1, project_id: PROJECT_ID, operation_id: value.operation_id, input_hash: value.input_hash,
    expected, allocations: { ...value.allocations }, events };
  if (encoder.encode(canonical(result)).byteLength > MAX_OPERATION_BYTES) fail(413, 'operation_too_large');
  return result;
}

/** Every authoritative mutation advances this chain, even with zero events. */
export function checkpointHash(input, cursor) {
  return sha256(canonical({ protocol: PROTOCOL, kind: 'database-checkpoint-v1', project_id: PROJECT_ID,
    operation_id: input.operation_id, input_hash: input.input_hash, expected: input.expected,
    allocations: input.allocations, events: input.events, cursor }));
}

export function operationRoute(request) {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || request.headers.has('Upgrade')) fail(400, 'transport_invalid');
  const fixed = {
    '/v1/control': ['GET', 'control'],
    '/v1/control/bootstrap': ['POST', 'bootstrap'],
    '/v1/admission': ['POST', 'admission'],
    '/v1/operations/prepare': ['POST', 'prepare'],
    '/v1/recovery/begin': ['POST', 'recovery'],
  };
  let target;
  if (Object.hasOwn(fixed, url.pathname)) {
    const [method, kind] = fixed[url.pathname];
    if (request.method !== method) fail(405, 'method_unavailable');
    target = { kind };
  } else {
    const match = /^\/v1\/operations\/([^/]+)(\/acknowledge)?$/.exec(url.pathname);
    if (!match) return null;
    if (!uuid(match[1])) fail(404, 'route_unavailable');
    if (request.method !== (match[2] ? 'POST' : 'GET')) fail(405, 'method_unavailable');
    target = { kind: match[2] ? 'acknowledge' : 'lookup', operation_id: match[1] };
  }
  if (url.search) fail(400, 'query_invalid');
  return target;
}

function controlView(control) {
  return { state: control.state, marker: control.marker, pending_operation_id: control.pending_operation_id,
    recovery_generation_id: control.recovery_generation_id };
}
const envelope = control => ({ protocol: PROTOCOL, project_id: PROJECT_ID, control: controlView(control) });
function clock(now, minimum = 0) {
  const value = now();
  if (!positive(value)) fail(503, 'journal_clock_invalid');
  return Math.max(value, minimum);
}
function finish(value) {
  // Do not throw a quarantine rejection inside the storage transaction: that
  // would roll back the independent fence together with the rejected action.
  if (value.denied) fail(value.status, value.denied);
  return value;
}
async function noRecords(txn, prefixes) {
  for (const prefix of prefixes) if ((await txn.list({ prefix, limit: 1 })).size) fail(503, 'journal_integrity_failed');
}

async function checkedBinding(txn) {
  const value = await txn.get(BINDING_KEY);
  if (value === undefined) return undefined;
  if (!exact(value, ['version', 'project_id', 'database_id', 'bootstrap_id', 'initial_marker', 'created_at', 'binding_hash']) ||
      value.version !== 1 || value.project_id !== PROJECT_ID || !uuid(value.database_id) || !uuid(value.bootstrap_id) || !positive(value.created_at) || !digest(value.binding_hash)) fail(503, 'journal_integrity_failed');
  try { validateMarker(value.initial_marker); } catch { fail(503, 'journal_integrity_failed'); }
  if (value.initial_marker.database_id !== value.database_id || value.initial_marker.checkpoint.revision !== 0) fail(503, 'journal_integrity_failed');
  const { binding_hash, ...content } = value;
  if (binding_hash !== await sha256(canonical(content))) fail(503, 'journal_integrity_failed');
  return value;
}

async function checkedPlan(txn, id) {
  const value = await txn.get(planKey(id));
  if (value === undefined) return undefined;
  if (!exact(value, ['plan', 'plan_hash']) || !digest(value.plan_hash) ||
      !exact(value.plan, ['version', 'project_id', 'operation_id', 'input_hash', 'expected', 'allocations', 'events', 'next', 'prepared_at', 'receipts'])) fail(503, 'journal_integrity_failed');
  const plan = value.plan;
  let input, next;
  try {
    input = validatePrepare({ version: plan.version, project_id: plan.project_id, operation_id: plan.operation_id,
      input_hash: plan.input_hash, expected: plan.expected, allocations: plan.allocations, events: plan.events });
    next = validateMarker(plan.next);
  } catch { fail(503, 'journal_integrity_failed'); }
  if (plan.operation_id !== id || !positive(plan.prepared_at) || !Array.isArray(plan.receipts) || plan.receipts.length !== plan.events.length ||
      next.database_id !== input.expected.database_id || next.incarnation_id !== input.expected.incarnation_id ||
      next.checkpoint.revision !== input.expected.checkpoint.revision + 1 || !Number.isSafeInteger(next.checkpoint.revision) ||
      value.plan_hash !== await sha256(canonical(plan)) || encoder.encode(canonical(value)).byteLength > MAX_RESPONSE_BYTES) fail(503, 'journal_integrity_failed');
  const indexed = await txn.get(prepareKey(next.checkpoint.revision));
  if (!exact(indexed, ['operation_id', 'plan_hash']) || indexed.operation_id !== id || indexed.plan_hash !== value.plan_hash) fail(503, 'journal_integrity_failed');
  let cursor = input.expected.cursor;
  if (cursor.sequence > 0 && (await checkedReceipt(txn, cursor.sequence)).hash !== cursor.hash) fail(503, 'journal_integrity_failed');
  for (let index = 0; index < plan.receipts.length; index += 1) {
    const receipt = plan.receipts[index];
    if (!plain(receipt) || receipt.sequence !== cursor.sequence + 1 || receipt.previous_hash !== cursor.hash ||
        receipt.recorded_at !== plan.prepared_at || !equal(receipt.event, input.events[index])) fail(503, 'journal_integrity_failed');
    const stored = await checkedReceipt(txn, receipt.sequence);
    if (!equal(receipt, stored)) fail(503, 'journal_integrity_failed');
    cursor = headView(receipt);
  }
  if (!equal(next.cursor, cursor) || next.checkpoint.hash !== await checkpointHash(input, cursor)) fail(503, 'journal_integrity_failed');
  return value;
}

async function checkedCommit(txn, revision, binding) {
  const value = await txn.get(commitKey(revision));
  if (!exact(value, ['version', 'project_id', 'marker', 'operation_id', 'plan_hash', 'committed_at']) || value.version !== 1 ||
      value.project_id !== PROJECT_ID || !positive(value.committed_at)) fail(503, 'journal_integrity_failed');
  try { validateMarker(value.marker); } catch { fail(503, 'journal_integrity_failed'); }
  if (value.marker.checkpoint.revision !== revision) fail(503, 'journal_integrity_failed');
  if (revision === 0) {
    if (value.operation_id !== null || value.plan_hash !== null || !equal(value.marker, binding.initial_marker) || value.committed_at !== binding.created_at) fail(503, 'journal_integrity_failed');
  } else {
    if (!uuid(value.operation_id) || !digest(value.plan_hash)) fail(503, 'journal_integrity_failed');
    const operation = await checkedPlan(txn, value.operation_id);
    if (!operation || operation.plan_hash !== value.plan_hash || !equal(operation.plan.next, value.marker) || value.committed_at < operation.plan.prepared_at) fail(503, 'journal_integrity_failed');
  }
  return value;
}

async function checkedRecovery(txn, id) {
  const value = await txn.get(recoveryKey(id));
  if (!exact(value, ['version', 'project_id', 'recovery_id', 'generation', 'prior_marker', 'prior_pending_operation_id',
    'incarnation_id', 'journal_head', 'reason', 'created_at', 'generation_hash']) || value.version !== 1 || value.project_id !== PROJECT_ID ||
    value.recovery_id !== id || !uuid(id) || value.generation !== 1 || !nullableUuid(value.prior_pending_operation_id) ||
    !uuid(value.incarnation_id) || !positive(value.created_at) || !reasons.has(value.reason) || !digest(value.generation_hash) ||
    !exact(value.journal_head, ['sequence', 'hash']) || !unsigned(value.journal_head.sequence) || !digest(value.journal_head.hash) ||
    value.journal_head.sequence === 0 && value.journal_head.hash !== GENESIS_HASH) fail(503, 'journal_integrity_failed');
  try { validateMarker(value.prior_marker); } catch { fail(503, 'journal_integrity_failed'); }
  const { generation_hash, ...content } = value;
  if (value.incarnation_id === value.prior_marker.incarnation_id || generation_hash !== await sha256(canonical(content))) fail(503, 'journal_integrity_failed');
  return value;
}

async function loadControl(txn) {
  const binding = await checkedBinding(txn), control = await txn.get(CONTROL_KEY);
  if (binding === undefined && control === undefined) {
    await noRecords(txn, ['plan:', 'prepare:', 'commit:', 'recovery:']);
    return undefined;
  }
  if (!binding || !exact(control, ['version', 'project_id', 'binding_hash', 'state', 'marker', 'pending_operation_id', 'recovery_generation_id', 'quarantine']) ||
      control.version !== 1 || control.project_id !== PROJECT_ID || control.binding_hash !== binding.binding_hash ||
      !['serving', 'pending', 'quarantined'].includes(control.state) || !nullableUuid(control.pending_operation_id) || !nullableUuid(control.recovery_generation_id)) fail(503, 'journal_integrity_failed');
  try { validateMarker(control.marker); } catch { fail(503, 'journal_integrity_failed'); }
  if (control.marker.database_id !== binding.database_id || control.marker.incarnation_id !== binding.initial_marker.incarnation_id ||
      binding.initial_marker.cursor.sequence !== 0 && control.state !== 'quarantined' ||
      control.state === 'serving' && control.pending_operation_id !== null || control.state === 'pending' && control.pending_operation_id === null) fail(503, 'journal_integrity_failed');
  if (control.state === 'quarantined') {
    if (!exact(control.quarantine, ['reason', 'detected_at', 'observed_marker_hash']) || !reasons.has(control.quarantine.reason) ||
        !positive(control.quarantine.detected_at) || !(control.quarantine.observed_marker_hash === null || digest(control.quarantine.observed_marker_hash))) fail(503, 'journal_integrity_failed');
  } else if (control.quarantine !== null || control.recovery_generation_id !== null) fail(503, 'journal_integrity_failed');
  const lastCommit = await checkedCommit(txn, control.marker.checkpoint.revision, binding);
  const latestCommits = await txn.list({ prefix: 'commit:', reverse: true, limit: 1 });
  if (!equal(lastCommit.marker, control.marker) || latestCommits.size !== 1 || !latestCommits.has(commitKey(control.marker.checkpoint.revision))) fail(503, 'journal_integrity_failed');
  const latestPrepared = await txn.list({ prefix: 'prepare:', reverse: true, limit: 1 });
  if (control.pending_operation_id !== null || control.marker.checkpoint.revision > 0) {
    const revision = control.marker.checkpoint.revision + (control.pending_operation_id === null ? 0 : 1);
    const prepared = latestPrepared.get(prepareKey(revision));
    if (latestPrepared.size !== 1 || !exact(prepared, ['operation_id', 'plan_hash']) || !uuid(prepared.operation_id) || !digest(prepared.plan_hash)) fail(503, 'journal_integrity_failed');
    const operation = await checkedPlan(txn, prepared.operation_id);
    if (!operation || operation.plan_hash !== prepared.plan_hash || operation.plan.next.checkpoint.revision !== revision ||
        control.pending_operation_id !== null && (prepared.operation_id !== control.pending_operation_id || !equal(operation.plan.expected, control.marker)) ||
        control.pending_operation_id === null && (prepared.operation_id !== lastCommit.operation_id || prepared.plan_hash !== lastCommit.plan_hash)) fail(503, 'journal_integrity_failed');
  } else if (latestPrepared.size) fail(503, 'journal_integrity_failed');
  if (control.recovery_generation_id !== null) {
    const recovery = await checkedRecovery(txn, control.recovery_generation_id);
    if (control.state !== 'quarantined' || !equal(recovery.prior_marker, control.marker) || recovery.prior_pending_operation_id !== control.pending_operation_id) fail(503, 'journal_integrity_failed');
  } else await noRecords(txn, ['recovery:']);
  return control;
}

async function requireControl(txn) {
  const control = await loadControl(txn);
  if (!control) fail(409, 'control_uninitialized');
  return control;
}
async function quarantine(txn, control, reason, observed, now) {
  if (control.state !== 'quarantined') {
    control = { ...control, state: 'quarantined', quarantine: { reason, detected_at: clock(now),
      observed_marker_hash: observed === null ? null : await sha256(canonical(observed)) } };
    await txn.put({ [CONTROL_KEY]: control });
  }
  return { denied: 'serving_quarantined', status: 409 };
}
async function operationView(txn, operation, control) {
  const commit = await txn.get(commitKey(operation.plan.next.checkpoint.revision));
  if (commit === undefined) {
    if (control.pending_operation_id !== operation.plan.operation_id || control.marker.checkpoint.revision >= operation.plan.next.checkpoint.revision) fail(503, 'journal_integrity_failed');
    return { ...operation, status: 'pending', committed_at: null };
  }
  if (!exact(commit, ['version', 'project_id', 'marker', 'operation_id', 'plan_hash', 'committed_at']) ||
      commit.version !== 1 || commit.project_id !== PROJECT_ID || commit.operation_id !== operation.plan.operation_id ||
      commit.plan_hash !== operation.plan_hash || !equal(commit.marker, operation.plan.next) || !positive(commit.committed_at) ||
      commit.committed_at < operation.plan.prepared_at) fail(503, 'journal_integrity_failed');
  return { ...operation, status: 'committed', committed_at: commit.committed_at };
}

export async function bootstrapControl(storage, value, now = Date.now) {
  requireEnvelope(value, ['database_id', 'bootstrap_id'], 'bootstrap_invalid');
  if (!uuid(value.database_id) || !uuid(value.bootstrap_id)) fail(400, 'bootstrap_invalid');
  return storage.transaction(async txn => {
    const head = await loadHead(txn), control = await loadControl(txn), binding = await checkedBinding(txn);
    if (binding) {
      if (binding.database_id !== value.database_id || binding.bootstrap_id !== value.bootstrap_id) fail(409, 'database_already_bound');
      return { ...envelope(control), binding };
    }
    const created_at = clock(now, head.recorded_at), incarnation_id = crypto.randomUUID();
    const marker = { database_id: value.database_id, incarnation_id, checkpoint: { revision: 0,
      hash: await sha256(canonical({ protocol: PROTOCOL, kind: 'database-bootstrap-v1', project_id: PROJECT_ID,
        database_id: value.database_id, bootstrap_id: value.bootstrap_id, incarnation_id, cursor: headView(head) })) }, cursor: headView(head) };
    const content = { version: 1, project_id: PROJECT_ID, database_id: value.database_id, bootstrap_id: value.bootstrap_id, initial_marker: marker, created_at };
    const initialBinding = { ...content, binding_hash: await sha256(canonical(content)) };
    // Adopting a nonzero cursor is not proof that PostgreSQL applied its facts.
    // Preserve that history in a bound quarantine; this protocol has no route
    // that can certify replay or open it, including an exact bootstrap retry.
    const hasRestrictions = head.sequence !== 0;
    const initialControl = { version: 1, project_id: PROJECT_ID, binding_hash: initialBinding.binding_hash,
      state: hasRestrictions ? 'quarantined' : 'serving', marker, pending_operation_id: null, recovery_generation_id: null,
      quarantine: hasRestrictions ? { reason: 'preexisting_restrictions', detected_at: created_at, observed_marker_hash: null } : null };
    await txn.put({ [HEAD_KEY]: head, [BINDING_KEY]: initialBinding, [CONTROL_KEY]: initialControl,
      [commitKey(0)]: { version: 1, project_id: PROJECT_ID, marker, operation_id: null, plan_hash: null, committed_at: created_at } });
    return { ...envelope(initialControl), binding: initialBinding };
  });
}

export async function readControl(storage) {
  return storage.transaction(async txn => { await loadHead(txn); return envelope(await requireControl(txn)); });
}

export async function admitDatabase(storage, value, now = Date.now) {
  requireEnvelope(value, ['marker'], 'admission_invalid');
  const marker = validateMarker(value.marker);
  return finish(await storage.transaction(async txn => {
    const head = await loadHead(txn), control = await requireControl(txn);
    if (control.state === 'quarantined') return { denied: 'serving_quarantined', status: 409 };
    if (control.state === 'pending') {
      const operation = await checkedPlan(txn, control.pending_operation_id);
      if (equal(marker, control.marker) || equal(marker, operation.plan.next)) return { denied: 'operation_pending', status: 409 };
      return quarantine(txn, control, 'marker_mismatch', marker, now);
    }
    if (!equal(marker, control.marker)) return quarantine(txn, control, 'marker_mismatch', marker, now);
    if (!equal(marker.cursor, headView(head))) return quarantine(txn, control, 'journal_advanced', marker, now);
    return { ...envelope(control), admitted: true };
  }));
}

export async function prepareOperation(storage, raw, now = Date.now) {
  const input = validatePrepare(raw);
  return finish(await storage.transaction(async txn => {
    const head = await loadHead(txn), control = await requireControl(txn), existing = await checkedPlan(txn, input.operation_id);
    if (existing) {
      const { version, project_id, operation_id, input_hash, expected, allocations, events } = existing.plan;
      if (!equal(input, { version, project_id, operation_id, input_hash, expected, allocations, events })) fail(409, 'operation_conflict');
      return { ...envelope(control), operation: await operationView(txn, existing, control) };
    }
    if (control.state === 'quarantined') return { denied: 'serving_quarantined', status: 409 };
    if (control.state === 'pending') {
      const pending = await checkedPlan(txn, control.pending_operation_id);
      if (equal(input.expected, control.marker) || equal(input.expected, pending.plan.next)) return { denied: 'operation_pending', status: 409 };
      return quarantine(txn, control, 'marker_mismatch', input.expected, now);
    }
    if (!equal(input.expected, control.marker)) return quarantine(txn, control, 'marker_mismatch', input.expected, now);
    if (!equal(input.expected.cursor, headView(head))) return quarantine(txn, control, 'journal_advanced', input.expected, now);
    if (control.marker.checkpoint.revision >= Number.MAX_SAFE_INTEGER || input.events.length > Number.MAX_SAFE_INTEGER - head.sequence) fail(503, 'journal_sequence_exhausted');
    const priorCommit = await txn.get(commitKey(control.marker.checkpoint.revision));
    const prepared_at = clock(now, Math.max(head.recorded_at, priorCommit.committed_at)), receipts = [];
    // Validation and bounding completed before any storage mutation. All event
    // receipts, allocations, plan, prepare index and pending fence commit once.
    for (const event of input.events) receipts.push(await appendEventTransaction(txn, event, await sha256(canonical(event)), () => prepared_at, { manifest: true }));
    const cursor = receipts.length ? headView(receipts.at(-1)) : input.expected.cursor;
    const next = { database_id: input.expected.database_id, incarnation_id: input.expected.incarnation_id,
      checkpoint: { revision: input.expected.checkpoint.revision + 1, hash: await checkpointHash(input, cursor) }, cursor };
    const plan = { ...input, next, prepared_at, receipts }, operation = { plan, plan_hash: await sha256(canonical(plan)) };
    const pending = { ...control, state: 'pending', pending_operation_id: input.operation_id };
    await txn.put({ [planKey(input.operation_id)]: operation, [prepareKey(next.checkpoint.revision)]: { operation_id: input.operation_id, plan_hash: operation.plan_hash }, [CONTROL_KEY]: pending });
    return { ...envelope(pending), operation: { ...operation, status: 'pending', committed_at: null } };
  }));
}

export async function lookupOperation(storage, id) {
  if (!uuid(id)) fail(400, 'operation_invalid');
  return storage.transaction(async txn => {
    await loadHead(txn); const control = await requireControl(txn), operation = await checkedPlan(txn, id);
    if (!operation) fail(404, 'operation_not_found');
    return { ...envelope(control), operation: await operationView(txn, operation, control) };
  });
}

export async function acknowledgeOperation(storage, id, value, now = Date.now) {
  requireEnvelope(value, ['plan_hash', 'marker'], 'acknowledgement_invalid');
  if (!uuid(id) || !digest(value.plan_hash)) fail(400, 'acknowledgement_invalid');
  const marker = validateMarker(value.marker);
  return finish(await storage.transaction(async txn => {
    const head = await loadHead(txn), control = await requireControl(txn), operation = await checkedPlan(txn, id);
    if (!operation) fail(404, 'operation_not_found');
    if (value.plan_hash !== operation.plan_hash || !equal(marker, operation.plan.next)) return quarantine(txn, control, 'acknowledgement_mismatch', marker, now);
    const view = await operationView(txn, operation, control);
    // A historical acknowledgement is an idempotent receipt lookup. It never
    // changes a newer checkpoint or clears any independent quarantine.
    if (view.status === 'committed') return { ...envelope(control), operation: view };
    if (control.state === 'quarantined') return { denied: 'serving_quarantined', status: 409 };
    if (control.state !== 'pending' || control.pending_operation_id !== id || !equal(control.marker, operation.plan.expected) ||
        !equal(marker.cursor, headView(head))) return quarantine(txn, control, 'acknowledgement_mismatch', marker, now);
    const committed_at = clock(now, operation.plan.prepared_at), serving = { ...control, state: 'serving', marker, pending_operation_id: null };
    await txn.put({ [commitKey(marker.checkpoint.revision)]: { version: 1, project_id: PROJECT_ID, marker,
      operation_id: id, plan_hash: operation.plan_hash, committed_at }, [CONTROL_KEY]: serving });
    return { ...envelope(serving), operation: { ...operation, status: 'committed', committed_at } };
  }));
}

export async function beginRecovery(storage, value, now = Date.now) {
  requireEnvelope(value, ['recovery_id', 'expected'], 'recovery_invalid');
  if (!uuid(value.recovery_id)) fail(400, 'recovery_invalid');
  const expected = validateMarker(value.expected);
  return finish(await storage.transaction(async txn => {
    const head = await loadHead(txn), control = await requireControl(txn);
    if (control.recovery_generation_id !== null) {
      if (control.recovery_generation_id !== value.recovery_id) fail(409, 'recovery_in_progress');
      const recovery = await checkedRecovery(txn, value.recovery_id);
      if (!equal(expected, recovery.prior_marker)) fail(409, 'recovery_conflict');
      return { ...envelope(control), recovery };
    }
    if (!equal(expected, control.marker)) return quarantine(txn, control, 'marker_mismatch', expected, now);
    const created_at = clock(now, head.recorded_at), reason = control.quarantine?.reason ?? 'planned_restore';
    const content = { version: 1, project_id: PROJECT_ID, recovery_id: value.recovery_id, generation: 1, prior_marker: control.marker,
      prior_pending_operation_id: control.pending_operation_id, incarnation_id: crypto.randomUUID(), journal_head: headView(head), reason, created_at };
    const recovery = { ...content, generation_hash: await sha256(canonical(content)) };
    const fenced = { ...control, state: 'quarantined', recovery_generation_id: value.recovery_id,
      quarantine: control.quarantine ?? { reason, detected_at: created_at, observed_marker_hash: await sha256(canonical(expected)) } };
    await txn.put({ [recoveryKey(value.recovery_id)]: recovery, [CONTROL_KEY]: fenced });
    return { ...envelope(fenced), recovery };
  }));
}

export async function handleOperationRequest(request, env, storage, { now = Date.now } = {}) {
  try {
    await authenticate(request, env);
    const target = operationRoute(request);
    if (!target) fail(404, 'route_unavailable');
    let result;
    if (target.kind === 'control') result = await readControl(storage);
    else if (target.kind === 'lookup') result = await lookupOperation(storage, target.operation_id);
    else {
      const input = await readJson(request, MAX_OPERATION_BYTES, 'operation');
      if (target.kind === 'bootstrap') result = await bootstrapControl(storage, input, now);
      else if (target.kind === 'admission') result = await admitDatabase(storage, input, now);
      else if (target.kind === 'prepare') result = await prepareOperation(storage, input, now);
      else if (target.kind === 'acknowledge') result = await acknowledgeOperation(storage, target.operation_id, input, now);
      else result = await beginRecovery(storage, input, now);
    }
    if (encoder.encode(JSON.stringify(result)).byteLength > MAX_RESPONSE_BYTES) fail(503, 'journal_integrity_failed');
    return response(result);
  } catch (error) { return errorResponse(error); }
}
