/** Protocol v2 values. No application DB, provider credentials or remote effects. */
import { PROJECT_ID, GENESIS_HASH, canonical, sha256, exact, plain, fail, uuidPattern, hashPattern, validateEvent } from './journal.mjs';
import { validateMarker, MAX_MANIFEST_EVENTS, MAX_ALLOCATIONS, MAX_OPERATION_BYTES, MAX_RESPONSE_BYTES } from './operations.mjs';

export const INVENTORY_PROTOCOL = 'lovelies-write-inventory-v1';
export const LIMITS = Object.freeze({ descriptor: 2048, link: 1024, record: 3072, observation: 2048,
  state: 2048, ack: 1024, progress: 4096, cut: 8192, progressResponse: 16384, pageEnvelope: 4096,
  response: MAX_RESPONSE_BYTES, operation: MAX_OPERATION_BYTES, page: 32, source: 20971520, chunk: 262144 });
export const utf8 = new TextEncoder();
export const equal = (a, b) => canonical(a) === canonical(b);
export const uuid = x => typeof x === 'string' && uuidPattern.test(x);
export const digest = x => typeof x === 'string' && hashPattern.test(x);
export const unsigned = x => Number.isSafeInteger(x) && x >= 0;
export const positive = x => Number.isSafeInteger(x) && x > 0;
export const nullableUuid = x => x === null || uuid(x);
export const opaque = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(x);
const policy = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(x);
export const copy = x => JSON.parse(canonical(x));
export function bounded(value, limit, code = 'inventory_too_large', status = 413) {
  if (utf8.encode(canonical(value)).byteLength > limit) fail(status, code);
  return value;
}
export function envelope(value, fields, code = 'inventory_invalid') {
  if (!exact(value, ['version', 'project_id', ...fields]) || value.project_id !== PROJECT_ID) fail(400, code);
  if (value.version !== 2) fail(409, 'protocol_version_unsupported');
}
export function cursor(value) {
  if (!exact(value, ['sequence', 'hash']) || !unsigned(value.sequence) || !digest(value.hash)) fail(400, 'inventory_cursor_invalid');
  return { ...value };
}
export function chainName(value) {
  if (!['registrations', 'observations'].includes(value)) fail(400, 'inventory_chain_invalid');
  return value;
}
export const chainTag = name => chainName(name) === 'registrations' ? 'r' : 'o';
export const recordKey = (name, sequence) => 'inventory:' + chainTag(name) + ':' + String(sequence).padStart(16, '0');
export const metaKey = name => 'inventory:' + chainTag(name) + ':meta';
export const writeKey = id => 'inventory:write:' + id;
export const linkKey = id => 'inventory:link:' + id;
export const observationKey = id => 'inventory:observation:' + id;
export const cutKey = (recovery, id) => 'inventory:cut:' + recovery + ':' + id;
export const cutHeadKey = recovery => 'inventory:cut-head:' + recovery;
export const progressKey = (recovery, chain) => 'inventory:progress:' + recovery + ':' + chainTag(chain);
export const recoveryKey = id => 'inventory:recovery:' + id;
export const hashContent = async (kind, value, gate) => gate.hash(canonical({ kind, ...value }));
export const keyHash = (item, gate) => gate.hash(canonical({ project_id: PROJECT_ID, bucket: item.bucket, object_key: item.object_key }));
export async function genesis(binding, chain, gate) {
  return { version: 1, project_id: PROJECT_ID, database_id: binding.database_id,
    incarnation_id: binding.initial_marker.incarnation_id, sequence: 0,
    hash: await hashContent('inventory-genesis-v1', { project_id: PROJECT_ID, database_id: binding.database_id,
      incarnation_id: binding.initial_marker.incarnation_id, chain: chainName(chain) }, gate), recorded_at: 0 };
}
export function clock(now, minimum = 0) {
  const time = now();
  if (!positive(time)) fail(503, 'journal_clock_invalid');
  return Math.max(time, minimum);
}
export function validateDescriptor(value, input) {
  const common = ['version', 'project_id', 'operation_id', 'write_id', 'database_id', 'incarnation_id', 'writer_generation_id',
    'action', 'kind', 'owner_id', 'asset_id', 'asset_version', 'bucket', 'object_key', 'authority', 'payload'];
  if (!exact(value, common) || value.version !== 1 || value.project_id !== PROJECT_ID ||
      ['operation_id', 'write_id', 'database_id', 'incarnation_id', 'writer_generation_id', 'owner_id', 'asset_id'].some(k => !uuid(value[k])) ||
      !opaque(value.asset_version) || value.bucket !== 'QUARANTINE' || typeof value.object_key !== 'string' ||
      value.object_key.length > 512 || !/^[A-Za-z0-9_./-]+$/.test(value.object_key) ||
      value.object_key.split('/').some(part => !part || part === '.' || part === '..')) fail(400, 'inventory_descriptor_invalid');
  if (input && (value.operation_id !== input.operation_id || value.write_id !== input.allocations.id_0 ||
      value.database_id !== input.expected.database_id || value.incarnation_id !== input.expected.incarnation_id ||
      value.writer_generation_id !== input.writer_generation_id)) fail(400, 'inventory_descriptor_binding_invalid');
  const a = value.authority, p = value.payload;
  if (value.action === 'put') {
    if (!['direct-source', 'upload-chunk', 'assembled-source'].includes(value.kind) ||
        !exact(a, ['session_id', 'auth_epoch', 'purpose', 'consent_id', 'policy_version', 'consent_created_at', 'consent_expires_at']) ||
        !uuid(a.session_id) || !positive(a.auth_epoch) || a.purpose !== 'photo_processing' || !uuid(a.consent_id) ||
        !policy(a.policy_version) || !unsigned(a.consent_created_at) ||
        !(a.consent_expires_at === null || positive(a.consent_expires_at) && a.consent_expires_at > a.consent_created_at) ||
        !exact(p, ['byte_size', 'sha256', 'content_type', 'source_byte_size', 'offset_bytes', 'transfer_sha256']) ||
        !positive(p.byte_size) || p.byte_size > LIMITS.source || !digest(p.sha256) ||
        !['image/jpeg', 'image/png', 'image/webp'].includes(p.content_type) || !positive(p.source_byte_size) || p.source_byte_size > LIMITS.source) fail(400, 'inventory_descriptor_invalid');
    const base = `${value.owner_id}/${value.asset_id}`;
    if (value.kind === 'upload-chunk') {
      if (!unsigned(p.offset_bytes) || p.offset_bytes % LIMITS.chunk || p.offset_bytes >= p.source_byte_size ||
          p.byte_size !== Math.min(LIMITS.chunk, p.source_byte_size - p.offset_bytes) || !digest(p.transfer_sha256) ||
          value.object_key !== `upload-chunk/${base}/${p.offset_bytes}/${value.write_id}`) fail(400, 'inventory_descriptor_invalid');
    } else if (p.source_byte_size !== p.byte_size || p.offset_bytes !== null ||
        p.transfer_sha256 !== (value.kind === 'assembled-source' ? p.sha256 : null) ||
        value.object_key !== `source/${base}/${value.asset_version}/${value.write_id}`) fail(400, 'inventory_descriptor_invalid');
  } else if (value.action === 'delete') {
    if (value.kind !== 'retired-upload-delete' || !exact(a, ['cleanup_intent_id', 'deletion_request_id', 'cleanup_authority_hash']) ||
        !uuid(a.cleanup_intent_id) || !nullableUuid(a.deletion_request_id) || !digest(a.cleanup_authority_hash) ||
        !exact(p, ['target_write_id', 'target_descriptor_hash', 'expected_sha256', 'expected_byte_size', 'expected_etag']) ||
        !uuid(p.target_write_id) || p.target_write_id === value.write_id || !digest(p.target_descriptor_hash) || !digest(p.expected_sha256) ||
        !positive(p.expected_byte_size) || p.expected_byte_size > LIMITS.source ||
        !(p.expected_etag === null || typeof p.expected_etag === 'string' && /^[\x20-\x7e]{1,256}$/.test(p.expected_etag))) fail(400, 'inventory_descriptor_invalid');
  } else fail(400, 'inventory_descriptor_invalid');
  return copy(bounded(value, LIMITS.descriptor));
}
export function validateLink(value, input) {
  if (!exact(value, ['version', 'project_id', 'operation_id', 'writer_generation_id', 'owner_id', 'asset_id', 'asset_version',
      'target_write_id', 'target_descriptor_hash', 'relation', 'offset_bytes']) || value.version !== 1 || value.project_id !== PROJECT_ID ||
      ['operation_id', 'writer_generation_id', 'owner_id', 'asset_id', 'target_write_id'].some(k => !uuid(value[k])) ||
      !opaque(value.asset_version) || !digest(value.target_descriptor_hash) ||
      !['asset-source', 'upload-chunk', 'processing-source'].includes(value.relation) ||
      (value.relation === 'upload-chunk' ? !unsigned(value.offset_bytes) || value.offset_bytes >= LIMITS.source || value.offset_bytes % LIMITS.chunk !== 0 : value.offset_bytes !== null) ||
      input && (value.operation_id !== input.operation_id || value.writer_generation_id !== input.writer_generation_id)) fail(400, 'inventory_link_invalid');
  return copy(bounded(value, LIMITS.link));
}
export function validatePrepareV2(value) {
  envelope(value, ['operation_id', 'input_hash', 'expected', 'writer_generation_id', 'allocations', 'events', 'resources', 'links'], 'operation_invalid');
  if (!uuid(value.operation_id) || !digest(value.input_hash) || !uuid(value.writer_generation_id) || !plain(value.allocations) ||
      Object.keys(value.allocations).length > MAX_ALLOCATIONS || Object.entries(value.allocations).some(([k, id]) => !/^id_(?:[0-9]|[12][0-9]|3[01])$/.test(k) || !uuid(id)) ||
      new Set(Object.values(value.allocations)).size !== Object.values(value.allocations).length ||
      !Array.isArray(value.events) || value.events.length > MAX_MANIFEST_EVENTS || !Array.isArray(value.resources) ||
      !Array.isArray(value.links) || value.resources.length + value.links.length > 1) fail(400, 'operation_invalid');
  const input = { ...value, expected: validateMarker(value.expected), allocations: { ...value.allocations }, events: value.events.map(validateEvent) };
  if (new Set(input.events.map(x => x.operation_id)).size !== input.events.length) fail(400, 'operation_invalid');
  input.resources = value.resources.map(x => validateDescriptor(x, input));
  input.links = value.links.map(x => validateLink(x, input));
  return copy(bounded(input, LIMITS.operation, 'operation_too_large'));
}
export function validateObservation(value) {
  envelope(value, ['observation_id', 'write_id', 'registration_hash', 'plan_hash', 'kind', 'result'], 'inventory_observation_invalid');
  if (!uuid(value.observation_id) || !uuid(value.write_id) || !digest(value.registration_hash) || !digest(value.plan_hash)) fail(400, 'inventory_observation_invalid');
  const r = value.result;
  if (['put-reply', 'delete-reply'].includes(value.kind)) {
    if (!exact(r, ['outcome', 'http_status', 'evidence_hash']) || !['success', 'rejected', 'unknown'].includes(r.outcome) ||
        !(r.http_status === null || Number.isInteger(r.http_status) && r.http_status >= 100 && r.http_status <= 599) || !digest(r.evidence_hash)) fail(400, 'inventory_observation_invalid');
  } else if (value.kind === 'head-report') {
    if (!exact(r, ['presence', 'etag', 'byte_size', 'sha256', 'evidence_hash']) || !['present', 'absent', 'unknown'].includes(r.presence) ||
        !(r.etag === null || typeof r.etag === 'string' && /^[\x20-\x7e]{1,256}$/.test(r.etag)) ||
        !(r.byte_size === null || unsigned(r.byte_size) && r.byte_size <= LIMITS.source) || !(r.sha256 === null || digest(r.sha256)) || !digest(r.evidence_hash)) fail(400, 'inventory_observation_invalid');
  } else if (value.kind === 'bytes-report') {
    if (!exact(r, ['byte_size', 'sha256', 'evidence_hash']) || !positive(r.byte_size) || r.byte_size > LIMITS.source || !digest(r.sha256) || !digest(r.evidence_hash)) fail(400, 'inventory_observation_invalid');
  } else if (value.kind === 'publication') {
    if (!exact(r, ['publication_operation_id', 'publication_plan_hash']) || !uuid(r.publication_operation_id) || !digest(r.publication_plan_hash)) fail(400, 'inventory_observation_invalid');
  } else fail(400, 'inventory_observation_invalid');
  return copy(bounded(value, LIMITS.observation));
}

/** Cooperative gate: no success after cancellation/deadline. After durable commit,
 * a failed response is unknown outcome, never a promise that state rolled back. */
export function requestGate(request, milliseconds = 5000) {
  let aborted = request.signal?.aborted ?? false, reason = 'inventory_request_aborted', rejectGate;
  const promise = new Promise((_, reject) => { rejectGate = reject; }); promise.catch(() => {});
  const abort = code => { if (!aborted) { aborted = true; reason = code; rejectGate(new Error(code)); } };
  const onAbort = () => abort('inventory_request_aborted');
  request.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => abort('inventory_deadline_exceeded'), milliseconds);
  timer.unref?.();
  const check = () => { if (aborted) fail(503, reason); };
  return { check, async wait(pending) { const tracked = Promise.resolve(pending); tracked.catch(() => {}); check(); try { const value = await Promise.race([tracked, promise]); check(); return value; } catch (error) { check(); throw error; } },
    async hash(text) { return this.wait(sha256(text)); }, close() { clearTimeout(timer); request.signal?.removeEventListener('abort', onAbort); } };
}
export function inertGate() { return { check() {}, wait: p => p, hash: sha256 }; }
export async function readCanonical(request, gate, maximum = LIMITS.operation) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('Content-Type') ?? '')) fail(415, 'content_type_invalid');
  if (request.headers.has('Content-Encoding')) fail(415, 'content_encoding_invalid');
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > maximum)) fail(413, 'inventory_too_large');
  const reader = request.body?.getReader(); if (!reader) fail(400, 'inventory_invalid');
  const chunks = []; let size = 0, done = false;
  try {
    for (;;) { const next = await gate.wait(reader.read()); if (next.done) { done = true; break; }
      size += next.value.byteLength; if (size > maximum) fail(413, 'inventory_too_large'); chunks.push(next.value); }
  } finally { if (!done) await gate.wait(reader.cancel()).catch(() => {}); reader.releaseLock(); }
  if (length !== null && Number(length) !== size) fail(400, 'inventory_length_invalid');
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let text, value; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); value = JSON.parse(text); }
  catch { fail(400, 'inventory_invalid'); }
  if (canonical(value) !== text) fail(400, 'inventory_canonical_required');
  gate.check(); return value;
}
export const restrictionGenesis = GENESIS_HASH;
