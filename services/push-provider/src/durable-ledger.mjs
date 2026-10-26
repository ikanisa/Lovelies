/** Private operational receipts only. This service never sends a notification,
 * stores device tokens or reads the application's database. */
export const PUSH_LEDGER_PROJECT = 'ltqfplqevxztlswlzexn';
export const PUSH_LEDGER_PROTOCOL = 'lovelies-push-dispatch-ledger-v1';
export const PUSH_LEDGER_BODY_LIMIT = 4096;
export const PUSH_LEDGER_REPLY_LIMIT = 8192;
export const PUSH_LEDGER_BINDING = 'binding:v1';
export const PREFLIGHT_LEASE_MS = 30_000;
export const AMBIGUOUS_AFTER_MS = 60_000;
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID = new RegExp('^' + UUID_SOURCE + '$');
const OPERATION = new RegExp('^notification:(' + UUID_SOURCE + '):(' + UUID_SOURCE + ')$');
const HASH = /^[0-9a-f]{64}$/;
const CODE = /^[A-Za-z0-9._:-]{1,80}$/;
const MESSAGE = /^[A-Za-z0-9][A-Za-z0-9_:/.=+%\-]{0,255}$/;
const encoder = new TextEncoder();
const STATES = ['prepared', 'dispatching', 'accepted', 'rejected', 'ambiguous'];
const REASONS = ['ledger_recovery_required', 'storage_integrity_unconfirmed'];

export class PushLedgerError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const fail = (status, code) => { throw new PushLedgerError(status, code); };
export const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
export const exact = (value, fields) => plain(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
export async function hash(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? encoder.encode(value) : value))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
export function operationKey(value) { if (typeof value !== 'string' || !OPERATION.test(value)) fail(400, 'operation_invalid'); return value; }
export function identifier(value) { if (typeof value !== 'string' || !UUID.test(value)) fail(400, 'identifier_invalid'); return value; }
const nullable = (value, pattern) => value === null || typeof value === 'string' && pattern.test(value);
const envelope = (env, fields) => ({ protocol: PUSH_LEDGER_PROTOCOL, project_id: PUSH_LEDGER_PROJECT, ledger_id: env.PUSH_LEDGER_ID, ...fields });
export function ledgerResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, private',
    Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  } });
}
export function ledgerError(error) {
  return ledgerResponse({ error: error instanceof PushLedgerError ? error.code : 'provider_ledger_unavailable' }, error instanceof PushLedgerError ? error.status : 503);
}

/** Configuration is purpose-bound. Initial binding needs a separate temporary
 * operator credential; the Node gateway never receives that credential. */
export async function authenticateLedger(request, env, bootstrap = false) {
  if (env?.SUPABASE_PROJECT_ID !== PUSH_LEDGER_PROJECT || typeof env.PUSH_LEDGER_ID !== 'string' || !UUID.test(env.PUSH_LEDGER_ID) ||
      typeof env.PUSH_LEDGER_TOKEN !== 'string' || !/^[!-~]{32,256}$/.test(env.PUSH_LEDGER_TOKEN)) fail(503, 'ledger_configuration_invalid');
  const secret = bootstrap ? env.PUSH_LEDGER_BOOTSTRAP_TOKEN : env.PUSH_LEDGER_TOKEN;
  if (typeof secret !== 'string' || !/^[!-~]{32,256}$/.test(secret) || bootstrap && secret === env.PUSH_LEDGER_TOKEN) fail(503, 'ledger_initialization_unavailable');
  const supplied = request.headers.get('Authorization') ?? '';
  const candidate = supplied.length <= 263 ? /^Bearer ([!-~]{32,256})$/.exec(supplied) : null;
  const [left, right] = await Promise.all([hash(secret), hash(candidate?.[1] ?? '')]);
  let different = 0;
  for (let n = 0; n < 64; n++) different |= left.charCodeAt(n) ^ right.charCodeAt(n);
  if (candidate === null || different !== 0) fail(401, 'ledger_authentication_required');
}
export function ledgerRoute(request) {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || request.headers.has('Upgrade')) fail(400, 'transport_invalid');
  const fixed = {
    '/v1/control': ['GET', 'control'], '/v1/bootstrap': ['POST', 'bootstrap'],
    '/v1/quarantine': ['POST', 'quarantine'], '/v1/operations/reserve': ['POST', 'reserve'],
  };
  if (Object.hasOwn(fixed, url.pathname)) {
    const [method, kind] = fixed[url.pathname];
    if (request.method !== method) fail(405, 'method_unavailable');
    return { kind };
  }
  const matched = /^\/v1\/operations\/([^/]+)(?:\/(preflight-failed|start|finish))?$/.exec(url.pathname);
  if (!matched) fail(404, 'route_unavailable');
  let key;
  try { key = decodeURIComponent(matched[1]); } catch { fail(404, 'route_unavailable'); }
  if (!OPERATION.test(key) || encodeURIComponent(key) !== matched[1]) fail(404, 'route_unavailable');
  if (request.method !== (matched[2] ? 'POST' : 'GET')) fail(405, 'method_unavailable');
  return { kind: matched[2] ?? 'lookup', key };
}
async function readJSON(request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('Content-Type') ?? '') || request.headers.has('Content-Encoding')) fail(415, 'content_type_invalid');
  const claimed = request.headers.get('Content-Length');
  if (claimed !== null && (!/^(0|[1-9][0-9]*)$/.test(claimed) || Number(claimed) > PUSH_LEDGER_BODY_LIMIT)) fail(413, 'ledger_request_too_large');
  const reader = request.body?.getReader(); if (!reader) fail(400, 'ledger_input_invalid');
  const chunks = []; let size = 0, done = false, timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new PushLedgerError(408, 'ledger_request_deadline')), 10_000); });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]); if (next.done) { done = true; break; }
      size += next.value.byteLength; if (size > PUSH_LEDGER_BODY_LIMIT) fail(413, 'ledger_request_too_large'); chunks.push(next.value);
    }
    if (claimed !== null && Number(claimed) !== size) fail(400, 'ledger_length_invalid');
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { fail(400, 'ledger_input_invalid'); }
    finally { bytes.fill(0); }
  } finally {
    clearTimeout(timer);
    for (const chunk of chunks) chunk.fill(0);
    if (!done) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function inputEnvelope(value, env, fields) {
  if (!exact(value, ['version', 'project_id', 'ledger_id', ...fields]) || value.version !== 1 || value.project_id !== PUSH_LEDGER_PROJECT || value.ledger_id !== env.PUSH_LEDGER_ID) fail(400, 'ledger_input_invalid');
}
export function validateOutcome(value) {
  if (!plain(value) || !Object.hasOwn(value, 'status') || Object.keys(value).some(key => !['status', 'provider_message_id', 'provider_code', 'retryable', 'token_invalid'].includes(key)) ||
      !['accepted', 'rejected', 'ambiguous'].includes(value.status) ||
      value.provider_message_id !== undefined && !nullable(value.provider_message_id, MESSAGE) ||
      value.provider_code !== undefined && !nullable(value.provider_code, CODE) ||
      value.retryable !== undefined && typeof value.retryable !== 'boolean' || value.token_invalid !== undefined && typeof value.token_invalid !== 'boolean') fail(400, 'provider_outcome_invalid');
  if (value.status === 'accepted' && (typeof value.provider_message_id !== 'string' || !MESSAGE.test(value.provider_message_id))) fail(400, 'provider_outcome_invalid');
  return { status: value.status, provider_message_id: value.provider_message_id ?? null, provider_code: value.provider_code ?? null,
    retryable: value.retryable === true, token_invalid: value.token_invalid === true };
}
export function validateDispatchRow(value, expectedKey) {
  if (!exact(value, ['operation_key', 'request_sha256', 'platform', 'notification_id', 'provider_request_id', 'status', 'claim_id', 'lease_until',
    'provider_message_id', 'provider_code', 'retryable', 'token_invalid', 'created_at', 'updated_at', 'dispatched_at']) ||
    typeof value.operation_key !== 'string' || !OPERATION.test(value.operation_key) || expectedKey !== undefined && value.operation_key !== expectedKey ||
    typeof value.request_sha256 !== 'string' || !HASH.test(value.request_sha256) || !['ios', 'android'].includes(value.platform) ||
    !UUID.test(value.notification_id) || OPERATION.exec(value.operation_key)[1] !== value.notification_id || !UUID.test(value.provider_request_id) ||
    !STATES.includes(value.status) || !nullable(value.claim_id, UUID) || !nullable(value.provider_message_id, MESSAGE) || !nullable(value.provider_code, CODE) ||
    typeof value.retryable !== 'boolean' || typeof value.token_invalid !== 'boolean' || !integer(value.created_at, 1) || !integer(value.updated_at, value.created_at)) fail(503, 'ledger_integrity_failed');
  if (value.status === 'prepared' ? !integer(value.lease_until) || value.dispatched_at !== null || value.provider_message_id !== null || value.retryable || value.token_invalid ||
      value.claim_id === null && value.lease_until !== 0 || value.claim_id !== null && value.lease_until <= value.created_at :
      value.claim_id !== null || value.lease_until !== null || !integer(value.dispatched_at, value.created_at) || value.dispatched_at > value.updated_at) fail(503, 'ledger_integrity_failed');
  if (value.status === 'accepted' && value.provider_message_id === null || value.status === 'dispatching' &&
      (value.provider_message_id !== null || value.provider_code !== null || value.retryable || value.token_invalid)) fail(503, 'ledger_integrity_failed');
  return structuredClone(value);
}
const rowKey = key => 'dispatch:' + key;
const indexKey = key => 'operation:' + key;
const providerKey = id => 'provider:' + id;
const admissionTable = 'push_dispatch_admissions_v1';
const intentTable = 'push_dispatch_intents_v1';
function query(sql, statement, ...bindings) {
  try { return sql.exec(statement, ...bindings).toArray(); } catch { fail(503, 'ledger_integrity_failed'); }
}
const bindingFields = ['version', 'protocol', 'project_id', 'ledger_id', 'bootstrap_id', 'state', 'reason', 'created_at', 'last_at', 'records', 'dispatches', 'revision', 'last_operation_key', 'last_row_hash', 'binding_hash'];
async function sealBinding(value) { return { ...value, binding_hash: await hash(canonical(value)) }; }
function control(binding) {
  return { bootstrap_id: binding.bootstrap_id, state: binding.state, reason: binding.reason, created_at: binding.created_at,
    last_at: binding.last_at, records: binding.records, revision: binding.revision };
}
async function loadRow(txn, key, sql) {
  const [raw, index] = await Promise.all([txn.get(rowKey(key)), txn.get(indexKey(key))]);
  // Immutable SQL admission evidence prevents a lost older KV row/index pair
  // from becoming a fresh key. It shares the SQLite transaction with KV writes.
  const admissions = query(sql, `SELECT operation_key, request_sha256, provider_request_id, created_at FROM ${admissionTable} WHERE operation_key=?`, key);
  const intents = query(sql, `SELECT operation_key, provider_request_id, dispatched_at FROM ${intentTable} WHERE operation_key=?`, key);
  if (raw === undefined && index === undefined && admissions.length === 0 && intents.length === 0) return null;
  const row = validateDispatchRow(raw, key);
  const digest = await hash(canonical(row));
  if (!exact(index, ['request_sha256', 'provider_request_id', 'created_at', 'row_hash']) || index.request_sha256 !== row.request_sha256 ||
    index.provider_request_id !== row.provider_request_id || index.created_at !== row.created_at || index.row_hash !== digest ||
    await txn.get(providerKey(row.provider_request_id)) !== key || admissions.length !== 1 || admissions[0].operation_key !== key ||
    admissions[0].request_sha256 !== row.request_sha256 || admissions[0].provider_request_id !== row.provider_request_id || admissions[0].created_at !== row.created_at) fail(503, 'ledger_integrity_failed');
  if (row.status === 'prepared' ? intents.length !== 0 : intents.length !== 1 || intents[0].operation_key !== key ||
      intents[0].provider_request_id !== row.provider_request_id || intents[0].dispatched_at !== row.dispatched_at) fail(503, 'ledger_integrity_failed');
  return row;
}
async function loadBinding(txn, env, sql) {
  const value = await txn.get(PUSH_LEDGER_BINDING);
  if (!exact(value, bindingFields) || value.version !== 1 || value.protocol !== PUSH_LEDGER_PROTOCOL || value.project_id !== PUSH_LEDGER_PROJECT ||
    value.ledger_id !== env.PUSH_LEDGER_ID || !UUID.test(value.bootstrap_id) || !['serving', 'quarantined'].includes(value.state) ||
    !integer(value.created_at, 1) || !integer(value.last_at, value.created_at) || !integer(value.records) || !integer(value.dispatches) || value.dispatches > value.records || !integer(value.revision, value.records) ||
    !HASH.test(value.binding_hash) || value.state === 'serving' && value.reason !== null || value.state === 'quarantined' && !REASONS.includes(value.reason) ||
    value.records === 0 && (value.last_operation_key !== null || value.last_row_hash !== null) ||
    value.records > 0 && (typeof value.last_operation_key !== 'string' || !OPERATION.test(value.last_operation_key) || typeof value.last_row_hash !== 'string' || !HASH.test(value.last_row_hash))) fail(503, 'ledger_binding_unavailable');
  const { binding_hash, ...fields } = value;
  if (binding_hash !== await hash(canonical(fields))) fail(503, 'ledger_integrity_failed');
  if (query(sql, `SELECT COUNT(*) AS records FROM ${admissionTable}`)[0]?.records !== value.records) fail(503, 'ledger_integrity_failed');
  if (query(sql, `SELECT COUNT(*) AS records FROM ${intentTable}`)[0]?.records !== value.dispatches) fail(503, 'ledger_integrity_failed');
  if (value.records > 0) {
    const last = await loadRow(txn, value.last_operation_key, sql);
    if (!last || await hash(canonical(last)) !== value.last_row_hash) fail(503, 'ledger_integrity_failed');
  }
  return value;
}
function clock(now, binding, reserve = false) {
  const value = now(); if (!integer(value, 1)) fail(503, 'ledger_clock_invalid');
  const at = Math.max(value, binding?.last_at ?? 0);
  if (reserve && at > Number.MAX_SAFE_INTEGER - PREFLIGHT_LEASE_MS) fail(503, 'ledger_clock_invalid');
  return at;
}
async function saveRow(txn, binding, row, at, inserted = false, sql, dispatchIntent = false) {
  validateDispatchRow(row, row.operation_key);
  if (binding.revision >= Number.MAX_SAFE_INTEGER || inserted && binding.records >= Number.MAX_SAFE_INTEGER) fail(503, 'ledger_sequence_exhausted');
  const digest = await hash(canonical(row));
  const { binding_hash, ...fields } = binding;
  const next = await sealBinding({ ...fields, last_at: at, records: binding.records + (inserted ? 1 : 0), dispatches: binding.dispatches + (dispatchIntent ? 1 : 0), revision: binding.revision + 1,
    last_operation_key: row.operation_key, last_row_hash: digest });
  if (inserted) query(sql, `INSERT INTO ${admissionTable} (operation_key,request_sha256,provider_request_id,created_at) VALUES (?,?,?,?)`,
    row.operation_key, row.request_sha256, row.provider_request_id, row.created_at);
  if (dispatchIntent) query(sql, `INSERT INTO ${intentTable} (operation_key,provider_request_id,dispatched_at) VALUES (?,?,?)`,
    row.operation_key, row.provider_request_id, row.dispatched_at);
  await txn.put({ [rowKey(row.operation_key)]: row, [indexKey(row.operation_key)]: {
    request_sha256: row.request_sha256, provider_request_id: row.provider_request_id, created_at: row.created_at, row_hash: digest,
  }, [providerKey(row.provider_request_id)]: row.operation_key, [PUSH_LEDGER_BINDING]: next });
  return next;
}
const serving = binding => { if (binding.state !== 'serving') fail(503, 'ledger_quarantined'); };

export async function executeLedger(storage, env, route, value, { now = Date.now } = {}) {
  const sql = storage.sql;
  if (route.kind === 'bootstrap') {
    inputEnvelope(value, env, ['bootstrap_id']); identifier(value.bootstrap_id);
    return storage.transaction(async txn => {
      const existing = await txn.get(PUSH_LEDGER_BINDING);
      if (existing !== undefined) {
        const binding = await loadBinding(txn, env, sql);
        if (binding.bootstrap_id !== value.bootstrap_id) fail(409, 'ledger_binding_conflict');
        return envelope(env, { control: control(binding) });
      }
      if ((await txn.list({ limit: 1 })).size !== 0) fail(503, 'ledger_initialization_refused');
      const tables = query(sql, "SELECT name FROM sqlite_master WHERE type='table'").filter(value => value.name !== '__cf_kv' && !value.name.startsWith('sqlite_'));
      if (tables.length !== 0) fail(503, 'ledger_initialization_refused');
      query(sql, `CREATE TABLE ${admissionTable} (operation_key TEXT PRIMARY KEY, request_sha256 TEXT NOT NULL, provider_request_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL) STRICT`);
      query(sql, `CREATE TRIGGER push_admission_no_update BEFORE UPDATE ON ${admissionTable} BEGIN SELECT RAISE(ABORT,'immutable_admission'); END`);
      query(sql, `CREATE TRIGGER push_admission_no_delete BEFORE DELETE ON ${admissionTable} BEGIN SELECT RAISE(ABORT,'immutable_admission'); END`);
      query(sql, `CREATE TABLE ${intentTable} (operation_key TEXT PRIMARY KEY REFERENCES ${admissionTable}(operation_key), provider_request_id TEXT NOT NULL UNIQUE, dispatched_at INTEGER NOT NULL) STRICT`);
      query(sql, `CREATE TRIGGER push_intent_no_update BEFORE UPDATE ON ${intentTable} BEGIN SELECT RAISE(ABORT,'immutable_dispatch_intent'); END`);
      query(sql, `CREATE TRIGGER push_intent_no_delete BEFORE DELETE ON ${intentTable} BEGIN SELECT RAISE(ABORT,'immutable_dispatch_intent'); END`);
      const at = clock(now);
      const binding = await sealBinding({ version: 1, protocol: PUSH_LEDGER_PROTOCOL, project_id: PUSH_LEDGER_PROJECT, ledger_id: env.PUSH_LEDGER_ID,
        bootstrap_id: value.bootstrap_id, state: 'serving', reason: null, created_at: at, last_at: at, records: 0, dispatches: 0, revision: 0, last_operation_key: null, last_row_hash: null });
      await txn.put({ [PUSH_LEDGER_BINDING]: binding }); return envelope(env, { control: control(binding) });
    });
  }
  if (!['control', 'lookup'].includes(route.kind)) {
    const fields = { quarantine: ['reason'], reserve: ['operation_key', 'request_sha256', 'platform', 'notification_id'],
      'preflight-failed': ['claim_id', 'code'], start: ['claim_id'], finish: ['result'] }[route.kind];
    inputEnvelope(value, env, fields);
    if (route.kind === 'reserve') {
      operationKey(value.operation_key); identifier(value.notification_id);
      if (!HASH.test(value.request_sha256) || !['ios', 'android'].includes(value.platform) || OPERATION.exec(value.operation_key)[1] !== value.notification_id) fail(400, 'ledger_input_invalid');
    } else if (['preflight-failed', 'start'].includes(route.kind)) {
      identifier(value.claim_id); if (route.kind === 'preflight-failed' && (typeof value.code !== 'string' || !CODE.test(value.code))) fail(400, 'ledger_input_invalid');
    } else if (route.kind === 'finish') validateOutcome(value.result);
    else if (!REASONS.includes(value.reason)) fail(400, 'ledger_input_invalid');
  }
  return storage.transaction(async txn => {
    let binding = await loadBinding(txn, env, sql);
    const at = clock(now, binding, route.kind === 'reserve');
    if (route.kind === 'control') return envelope(env, { control: control(binding) });
    if (route.kind === 'quarantine') {
      if (binding.state !== 'quarantined') {
        const { binding_hash, ...fields } = binding;
        binding = await sealBinding({ ...fields, state: 'quarantined', reason: value.reason, last_at: at });
        await txn.put({ [PUSH_LEDGER_BINDING]: binding });
      }
      return envelope(env, { control: control(binding) });
    }
    // Receipt inspection and completion of an already dispatched outcome remain
    // possible under quarantine. Neither operation can authorize a new send.
    if (!['lookup', 'finish', 'preflight-failed'].includes(route.kind)) serving(binding);
    const key = route.kind === 'reserve' ? value.operation_key : route.key;
    let row = await loadRow(txn, key, sql);
    if (route.kind === 'reserve') {
      if (row && (row.request_sha256 !== value.request_sha256 || row.platform !== value.platform || row.notification_id !== value.notification_id)) fail(409, 'operation_payload_conflict');
      if (row && (row.status !== 'prepared' || row.lease_until > at)) return envelope(env, { control: control(binding), result: { row, claim: null } });
      const claim = crypto.randomUUID();
      if (row) row = { ...row, claim_id: claim, lease_until: at + PREFLIGHT_LEASE_MS, updated_at: at, provider_code: null };
      else {
        const provider = crypto.randomUUID();
        if (await txn.get(providerKey(provider)) !== undefined) fail(503, 'ledger_identifier_collision');
        row = { operation_key: key, request_sha256: value.request_sha256, platform: value.platform, notification_id: value.notification_id,
          provider_request_id: provider, status: 'prepared', claim_id: claim, lease_until: at + PREFLIGHT_LEASE_MS,
          provider_message_id: null, provider_code: null, retryable: false, token_invalid: false, created_at: at, updated_at: at, dispatched_at: null };
      }
      binding = await saveRow(txn, binding, row, at, await txn.get(rowKey(key)) === undefined, sql);
      return envelope(env, { control: control(binding), result: { row, claim } });
    }
    if (route.kind === 'lookup') {
      if (!row) fail(404, 'operation_not_found');
      if (row.status === 'dispatching' && row.dispatched_at <= at - AMBIGUOUS_AFTER_MS) {
        row = { ...row, status: 'ambiguous', provider_code: 'dispatch_result_unconfirmed', updated_at: at };
        binding = await saveRow(txn, binding, row, at, false, sql);
      }
      return envelope(env, { control: control(binding), result: { row } });
    }
    if (route.kind === 'preflight-failed') {
      const updated = row?.status === 'prepared' && row.claim_id === value.claim_id;
      if (updated) { row = { ...row, claim_id: null, lease_until: 0, provider_code: value.code, updated_at: at }; binding = await saveRow(txn, binding, row, at, false, sql); }
      return envelope(env, { control: control(binding), result: { updated } });
    }
    if (route.kind === 'start') {
      if (row?.status !== 'prepared' || row.claim_id !== value.claim_id || row.lease_until <= at) return envelope(env, { control: control(binding), result: { row: null } });
      row = { ...row, status: 'dispatching', claim_id: null, lease_until: null, dispatched_at: at, updated_at: at, provider_code: null };
      binding = await saveRow(txn, binding, row, at, false, sql, true); return envelope(env, { control: control(binding), result: { row } });
    }
    if (!row || !['dispatching', 'ambiguous'].includes(row.status)) fail(503, 'dispatch_receipt_not_saved');
    row = { ...row, ...validateOutcome(value.result), updated_at: at };
    binding = await saveRow(txn, binding, row, at, false, sql); return envelope(env, { control: control(binding), result: { row } });
  });
}

export async function handleLedgerRequest(request, env, storage, options) {
  try {
    const route = ledgerRoute(request);
    await authenticateLedger(request, env, route.kind === 'bootstrap');
    const value = ['control', 'lookup'].includes(route.kind) ? undefined : await readJSON(request);
    const result = await executeLedger(storage, env, route, value, options);
    if (encoder.encode(JSON.stringify(result)).byteLength > PUSH_LEDGER_REPLY_LIMIT) fail(503, 'ledger_integrity_failed');
    return ledgerResponse(result);
  } catch (error) { return ledgerError(error); }
}
