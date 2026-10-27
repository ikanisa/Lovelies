/**
 * Append-only restriction facts, independent of the application database.
 * Storage port: transaction(async txn => ...); txn has get/put/list matching
 * Durable Object storage. No network or application-database access belongs here.
 */
export const PROJECT_ID = 'ltqfplqevxztlswlzexn';
export const PROTOCOL = 'lovelies-restriction-journal-v1';
export const GENESIS_HASH = '0'.repeat(64);
export const MAX_BODY_BYTES = 2048;
export const MAX_PAGE_SIZE = 100;
export const HEAD_KEY = 'meta:v1';
const encoder = new TextEncoder();
export const hashPattern = /^[0-9a-f]{64}$/;
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const opaquePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const purposes = new Set(['face_authentication', 'photo_matching', 'photo_processing']);
// All episode-scoped restrictions name the exact retired episode. A newer
// consent/profile/session/device/asset/request is not implicitly restricted.
export const SCOPE_FIELDS = Object.freeze({
  'account-deletion-requested': ['account_id', 'deletion_request_id'],
  'account-deletion-reviewed': ['account_id', 'deletion_request_id', 'reviewer_id', 'decision'],
  'account-erased': ['account_id', 'deletion_request_id'],
  'consent-withdrawn': ['account_id', 'consent_id', 'purpose'],
  'profile-retired': ['account_id', 'profile_id', 'profile_revision'],
  'guardian-approval-retired': ['child_account_id', 'guardian_request_id', 'guardian_approval_id', 'purpose'],
  'sharing-request-retired': ['sender_id', 'recipient_id', 'request_id'],
  'session-retired': ['account_id', 'session_id'],
  'device-retired': ['account_id', 'device_id', 'device_revision'],
  'asset-retired': ['owner_id', 'asset_id', 'asset_version'],
  'pair-blocked': ['blocker_id', 'blocked_id', 'block_operation_id'],
  'pair-block-ended': ['blocker_id', 'blocked_id', 'block_operation_id'],
});

export class JournalError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
export const fail = (status, code) => { throw new JournalError(status, code); };
export function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
export function exact(value, fields) {
  return plain(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
export async function sha256(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function validateEvent(value) {
  if (!exact(value, ['version', 'project_id', 'operation_id', 'kind', 'scope']) || value.version !== 1 || value.project_id !== PROJECT_ID ||
      typeof value.operation_id !== 'string' || !uuidPattern.test(value.operation_id) || typeof value.kind !== 'string' || !Object.hasOwn(SCOPE_FIELDS, value.kind)) {
    fail(400, 'event_invalid');
  }
  const fields = SCOPE_FIELDS[value.kind];
  if (!exact(value.scope, fields) || fields.some(field => {
    const item = value.scope[field];
    if (typeof item !== 'string') return true;
    if (field === 'purpose') return !purposes.has(item);
    if (field === 'decision') return !['approved', 'rejected'].includes(item);
    return field.endsWith('_id') ? !uuidPattern.test(item) : !opaquePattern.test(item);
  })) fail(400, 'event_scope_invalid');
  if (value.kind.startsWith('pair-block') && value.scope.blocker_id === value.scope.blocked_id ||
      value.kind === 'account-deletion-reviewed' && value.scope.account_id === value.scope.reviewer_id ||
      value.kind === 'sharing-request-retired' && value.scope.sender_id === value.scope.recipient_id) fail(400, 'event_scope_invalid');
  // Build a new bounded object; callers cannot mutate an accepted scope later.
  return { version: 1, project_id: PROJECT_ID, operation_id: value.operation_id, kind: value.kind,
    scope: Object.fromEntries(fields.map(field => [field, value.scope[field]])) };
}
export function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, private',
    'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  } });
}
export function errorResponse(error) {
  return response({ error: error instanceof JournalError ? error.code : 'journal_unavailable' }, error instanceof JournalError ? error.status : 503);
}
/** Fixed-size digest comparison, with no mismatch-position early return. */
export async function authenticate(request, env) {
  const secret = env?.RESTORE_JOURNAL_TOKEN;
  if (env?.SUPABASE_PROJECT_ID !== PROJECT_ID || typeof secret !== 'string' || !/^[!-~]{32,256}$/.test(secret)) fail(503, 'journal_configuration_invalid');
  const authorization = request.headers.get('Authorization') ?? '';
  const match = authorization.length <= 263 ? /^Bearer ([!-~]{32,256})$/.exec(authorization) : null;
  const [expected, supplied] = await Promise.all([sha256(secret), sha256(match?.[1] ?? '')]);
  let difference = 0;
  for (let index = 0; index < 64; index += 1) difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  if (difference !== 0 || match === null) fail(401, 'journal_authentication_required');
}
export function route(request) {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || request.headers.has('Upgrade')) fail(400, 'transport_invalid');
  if (url.pathname !== '/v1/events' && url.pathname !== '/v1/head') fail(404, 'route_unavailable');
  if (url.pathname === '/v1/head') {
    if (request.method !== 'GET') fail(405, 'method_unavailable');
    if (url.search) fail(400, 'pagination_invalid');
    return { kind: 'head' };
  }
  if (request.method === 'POST') {
    if (url.search) fail(400, 'pagination_invalid');
    return { kind: 'append' };
  }
  if (request.method !== 'GET') fail(405, 'method_unavailable');
  const params = url.searchParams;
  if ([...params.keys()].some(key => !['after', 'limit'].includes(key)) || params.getAll('after').length > 1 || params.getAll('limit').length > 1) fail(400, 'pagination_invalid');
  const integer = (value, fallback) => {
    if (value === null) return fallback;
    if (!/^(0|[1-9][0-9]{0,15})$/.test(value)) fail(400, 'pagination_invalid');
    const number = Number(value);
    if (!Number.isSafeInteger(number)) fail(400, 'pagination_invalid');
    return number;
  };
  const after = integer(params.get('after'), 0), limit = integer(params.get('limit'), MAX_PAGE_SIZE);
  if (limit < 1 || limit > MAX_PAGE_SIZE) fail(400, 'pagination_invalid');
  return { kind: 'events', after, limit };
}
export async function readJson(request, maximum = MAX_BODY_BYTES, label = 'event') {
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) fail(415, 'content_type_invalid');
  if (request.headers.has('Content-Encoding')) fail(415, 'content_encoding_invalid');
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > maximum)) fail(413, label + '_too_large');
  const reader = request.body?.getReader();
  if (!reader) fail(400, label + '_invalid');
  const chunks = []; let size = 0, completed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { completed = true; break; }
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); fail(413, label + '_too_large'); }
      chunks.push(value);
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (length !== null && Number(length) !== size) fail(400, label + '_length_invalid');
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail(400, label + '_invalid'); }
  return parsed;
}
export const eventKey = sequence => 'event:' + String(sequence).padStart(16, '0');
const operationKey = operation => 'operation:' + operation;
const genesis = () => ({ version: 1, project_id: PROJECT_ID, sequence: 0, hash: GENESIS_HASH, recorded_at: 0 });
export const headView = head => ({ sequence: head.sequence, hash: head.hash });
async function validateReceipt(receipt, expectedSequence) {
  if (!exact(receipt, ['sequence', 'hash', 'previous_hash', 'payload_hash', 'recorded_at', 'event']) || !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1 ||
      receipt.sequence !== expectedSequence || !Number.isSafeInteger(receipt.recorded_at) || receipt.recorded_at < 1 ||
      typeof receipt.hash !== 'string' || !hashPattern.test(receipt.hash) || typeof receipt.previous_hash !== 'string' || !hashPattern.test(receipt.previous_hash) ||
      typeof receipt.payload_hash !== 'string' || !hashPattern.test(receipt.payload_hash)) fail(503, 'journal_integrity_failed');
  let event;
  try { event = validateEvent(receipt.event); } catch { fail(503, 'journal_integrity_failed'); }
  const payloadHash = await sha256(canonical(event));
  if (payloadHash !== receipt.payload_hash || receipt.hash !== await receiptHash(receipt)) fail(503, 'journal_integrity_failed');
  return receipt;
}
async function receiptHash(receipt) {
  return sha256(canonical({ protocol: PROTOCOL, project_id: PROJECT_ID, sequence: receipt.sequence,
    previous_hash: receipt.previous_hash, payload_hash: receipt.payload_hash, recorded_at: receipt.recorded_at }));
}
export async function checkedReceipt(txn, sequence) {
  const receipt = await validateReceipt(await txn.get(eventKey(sequence)), sequence);
  const operation = await txn.get(operationKey(receipt.event.operation_id));
  if (!exact(operation, ['sequence', 'payload_hash']) || operation.sequence !== sequence || operation.payload_hash !== receipt.payload_hash) fail(503, 'journal_integrity_failed');
  return receipt;
}
export async function loadHead(txn) {
  const head = await txn.get(HEAD_KEY);
  if (head === undefined) {
    if ((await txn.list({ limit: 1 })).size !== 0) fail(503, 'journal_integrity_failed');
    return genesis();
  }
  if (!exact(head, ['version', 'project_id', 'sequence', 'hash', 'recorded_at']) || head.version !== 1 || head.project_id !== PROJECT_ID ||
      !Number.isSafeInteger(head.sequence) || head.sequence < 0 || !Number.isSafeInteger(head.recorded_at) || head.recorded_at < 0 ||
      typeof head.hash !== 'string' || !hashPattern.test(head.hash)) fail(503, 'journal_integrity_failed');
  // Bootstrap persists an explicit genesis before adding control records. A
  // missing head amid any metadata is still corruption, never a fresh journal.
  if (head.sequence === 0) {
    if (head.hash !== GENESIS_HASH || head.recorded_at !== 0 || (await txn.list({ prefix: 'event:', limit: 1 })).size ||
        (await txn.list({ prefix: 'operation:', limit: 1 })).size) fail(503, 'journal_integrity_failed');
    return head;
  }
  if (head.recorded_at < 1) fail(503, 'journal_integrity_failed');
  const last = await checkedReceipt(txn, head.sequence);
  const latest = await txn.list({ prefix: 'event:', reverse: true, limit: 1 });
  if (last.hash !== head.hash || last.recorded_at !== head.recorded_at || latest.size !== 1 || !latest.has(eventKey(head.sequence))) fail(503, 'journal_integrity_failed');
  return head;
}
export async function appendEvent(storage, rawEvent, now = Date.now) {
  const event = validateEvent(rawEvent), payloadHash = await sha256(canonical(event));
  return storage.transaction(txn => appendEventTransaction(txn, event, payloadHash, now));
}
/** Internal transaction port used by the atomic operation manifest. */
export async function appendEventTransaction(txn, event, payloadHash, now, { manifest = false } = {}) {
    const head = await loadHead(txn);
    const operation = await txn.get(operationKey(event.operation_id));
    if (operation !== undefined) {
      if (!exact(operation, ['sequence', 'payload_hash']) || !Number.isSafeInteger(operation.sequence) || operation.sequence < 1 || operation.sequence > head.sequence ||
          typeof operation.payload_hash !== 'string' || !hashPattern.test(operation.payload_hash)) fail(503, 'journal_integrity_failed');
      const previous = await checkedReceipt(txn, operation.sequence);
      if (previous.event.operation_id !== event.operation_id) fail(503, 'journal_integrity_failed');
      if (operation.payload_hash !== payloadHash) fail(409, 'operation_conflict');
      if (manifest) fail(409, 'event_already_recorded');
      return previous;
    }
    // Keep event-only pre-binding use intact. Once the database is bound, a new
    // fact must participate in a checkpointed atomic operation manifest.
    if (!manifest && await txn.get('control:v1') !== undefined) fail(409, 'control_requires_operation');
    if (head.sequence >= Number.MAX_SAFE_INTEGER) fail(503, 'journal_sequence_exhausted');
    const recordedAt = now();
    if (!Number.isSafeInteger(recordedAt) || recordedAt < 1) fail(503, 'journal_clock_invalid');
    const receipt = { sequence: head.sequence + 1, previous_hash: head.hash, payload_hash: payloadHash,
      recorded_at: Math.max(recordedAt, head.recorded_at), event };
    receipt.hash = await receiptHash(receipt);
    // Atomic head, replay record and unique operation index. Never allow an
    // unconfirmed receipt or evict an operation record on a timer.
    await txn.put({ [eventKey(receipt.sequence)]: receipt,
      [operationKey(event.operation_id)]: { sequence: receipt.sequence, payload_hash: payloadHash },
      [HEAD_KEY]: { version: 1, project_id: PROJECT_ID, sequence: receipt.sequence, hash: receipt.hash, recorded_at: receipt.recorded_at } });
    return receipt;
}
export async function readHead(storage) {
  return storage.transaction(async txn => headView(await loadHead(txn)));
}
export async function readEvents(storage, after, limit) {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) fail(400, 'pagination_invalid');
  return storage.transaction(async txn => {
    const head = await loadHead(txn);
    if (after > head.sequence) fail(409, 'cursor_ahead');
    let previousHash = after === 0 ? GENESIS_HASH : (await checkedReceipt(txn, after)).hash;
    const expectedCount = Math.min(limit, head.sequence - after);
    const stored = await txn.list({ prefix: 'event:', startAfter: eventKey(after), limit });
    if (stored.size !== expectedCount) fail(503, 'journal_integrity_failed');
    const events = []; let next = after;
    for (const [key, value] of stored) {
      next += 1;
      if (key !== eventKey(next)) fail(503, 'journal_integrity_failed');
      const receipt = await validateReceipt(value, next);
      const indexed = await checkedReceipt(txn, next);
      if (receipt.hash !== indexed.hash || receipt.previous_hash !== previousHash) fail(503, 'journal_integrity_failed');
      previousHash = receipt.hash; events.push(receipt);
    }
    if (next === head.sequence && previousHash !== head.hash) fail(503, 'journal_integrity_failed');
    return { events, head: headView(head), next_after: next, has_more: next < head.sequence };
  });
}
export async function handleRequest(request, env, storage, { now = Date.now } = {}) {
  try {
    await authenticate(request, env);
    const target = route(request);
    if (target.kind === 'append') {
      const event = validateEvent(await readJson(request));
      return response({ protocol: PROTOCOL, project_id: PROJECT_ID, receipt: await appendEvent(storage, event, now) });
    }
    if (target.kind === 'head') return response({ protocol: PROTOCOL, project_id: PROJECT_ID, head: await readHead(storage) });
    return response({ protocol: PROTOCOL, project_id: PROJECT_ID, ...await readEvents(storage, target.after, target.limit) });
  } catch (error) { return errorResponse(error); }
}
