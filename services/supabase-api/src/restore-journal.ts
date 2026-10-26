import { ApiError, digest, stable } from './types.ts';

export const RESTORE_PROJECT_ID = 'ltqfplqevxztlswlzexn' as const;
export const RESTORE_JOURNAL_PROTOCOL = 'lovelies-restriction-journal-v1' as const;
export const RESTORE_REQUEST_BYTES = 32_768;
export const RESTORE_RESPONSE_BYTES = 131_072;
const ZERO_HASH = '0'.repeat(64);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PURPOSES = new Set(['face_authentication', 'photo_matching', 'photo_processing']);
const SCOPE_FIELDS = {
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
} as const;

export type RestoreMarker = Readonly<{
  database_id: string; incarnation_id: string;
  checkpoint: Readonly<{ revision: number; hash: string }>;
  cursor: Readonly<{ sequence: number; hash: string }>;
}>;
export type RestoreRestrictionEvent = Readonly<{
  version: 1; project_id: typeof RESTORE_PROJECT_ID; operation_id: string;
  kind: keyof typeof SCOPE_FIELDS; scope: Readonly<Record<string, string>>;
}>;
export type RestoreOperationInput = Readonly<{
  version: 1; project_id: typeof RESTORE_PROJECT_ID; operation_id: string; input_hash: string;
  expected: RestoreMarker; allocations: Readonly<Record<string, string>>;
  events: readonly RestoreRestrictionEvent[];
}>;
export type RestoreEventReceipt = Readonly<{
  sequence: number; hash: string; previous_hash: string; payload_hash: string;
  recorded_at: number; event: RestoreRestrictionEvent;
}>;
export type RestoreOperationPlan = RestoreOperationInput & Readonly<{
  next: RestoreMarker; prepared_at: number; receipts: readonly RestoreEventReceipt[];
}>;
export type RestoreOperationRecord = Readonly<{
  plan: RestoreOperationPlan; plan_hash: string; status: 'pending' | 'committed'; committed_at: number | null;
}>;
export type RestoreControl = Readonly<{
  state: 'serving' | 'pending' | 'quarantined'; marker: RestoreMarker;
  pending_operation_id: string | null; recovery_generation_id: string | null;
}>;

const unavailable = (): never => { throw new ApiError(503, 'restore_journal_unavailable'); };
function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function exact(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return plain(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}
function identifier(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) return unavailable(); return value; }
function hash(value: unknown): string { if (typeof value !== 'string' || !HASH.test(value)) return unavailable(); return value; }
function integer(value: unknown, minimum = 0): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) return unavailable(); return value; }
function same(left: unknown, right: unknown): boolean { return stable(left) === stable(right); }

/** Strict constructors return fresh immutable values, never a caller's mutable
 * object. They are also usable for a raw PostgreSQL control-row marker. */
export function validateRestoreMarker(value: unknown): RestoreMarker {
  if (!exact(value, ['database_id', 'incarnation_id', 'checkpoint', 'cursor']) ||
      !exact(value.checkpoint, ['revision', 'hash']) || !exact(value.cursor, ['sequence', 'hash'])) return unavailable();
  const sequence = integer(value.cursor.sequence), cursorHash = hash(value.cursor.hash);
  if (sequence === 0 && cursorHash !== ZERO_HASH) return unavailable();
  return Object.freeze({ database_id: identifier(value.database_id), incarnation_id: identifier(value.incarnation_id),
    checkpoint: Object.freeze({ revision: integer(value.checkpoint.revision), hash: hash(value.checkpoint.hash) }),
    cursor: Object.freeze({ sequence, hash: cursorHash }) });
}
export function validateRestoreRestrictionEvent(value: unknown): RestoreRestrictionEvent {
  if (!exact(value, ['version', 'project_id', 'operation_id', 'kind', 'scope']) || value.version !== 1 || value.project_id !== RESTORE_PROJECT_ID ||
      typeof value.kind !== 'string' || !Object.hasOwn(SCOPE_FIELDS, value.kind)) return unavailable();
  const kind = value.kind as keyof typeof SCOPE_FIELDS, fields = SCOPE_FIELDS[kind];
  if (!exact(value.scope, fields)) return unavailable();
  const scope: Record<string, string> = {};
  for (const field of fields) {
    const item = value.scope[field];
    if (typeof item !== 'string') return unavailable();
    if (field === 'purpose' ? !PURPOSES.has(item) : field === 'decision' ? !['approved', 'rejected'].includes(item) :
      field.endsWith('_id') ? !UUID.test(item) : !OPAQUE.test(item)) return unavailable();
    scope[field] = item;
  }
  if (kind.startsWith('pair-block') && scope.blocker_id === scope.blocked_id ||
      kind === 'account-deletion-reviewed' && scope.account_id === scope.reviewer_id ||
      kind === 'sharing-request-retired' && scope.sender_id === scope.recipient_id) return unavailable();
  return Object.freeze({ version: 1, project_id: RESTORE_PROJECT_ID, operation_id: identifier(value.operation_id), kind, scope: Object.freeze(scope) });
}
export function validateRestoreOperationInput(value: unknown): RestoreOperationInput {
  if (!exact(value, ['version', 'project_id', 'operation_id', 'input_hash', 'expected', 'allocations', 'events']) ||
      value.version !== 1 || value.project_id !== RESTORE_PROJECT_ID || !plain(value.allocations) ||
      Object.keys(value.allocations).length > 32 || !Array.isArray(value.events) || value.events.length > 32) return unavailable();
  const allocations: Record<string, string> = {};
  for (const [slot, id] of Object.entries(value.allocations)) {
    if (!/^id_(?:[0-9]|[12][0-9]|3[01])$/.test(slot)) return unavailable();
    allocations[slot] = identifier(id);
  }
  if (new Set(Object.values(allocations)).size !== Object.keys(allocations).length) return unavailable();
  const events = value.events.map(validateRestoreRestrictionEvent);
  if (new Set(events.map(event => event.operation_id)).size !== events.length) return unavailable();
  const input = Object.freeze({ version: 1 as const, project_id: RESTORE_PROJECT_ID, operation_id: identifier(value.operation_id),
    input_hash: hash(value.input_hash), expected: validateRestoreMarker(value.expected),
    allocations: Object.freeze(allocations), events: Object.freeze(events) });
  if (new TextEncoder().encode(stable(input)).byteLength > RESTORE_REQUEST_BYTES) return unavailable();
  return input;
}
export function validateRestoreControl(value: unknown): RestoreControl {
  if (!exact(value, ['state', 'marker', 'pending_operation_id', 'recovery_generation_id']) ||
      !['serving', 'pending', 'quarantined'].includes(value.state as string)) return unavailable();
  const pending = value.pending_operation_id === null ? null : identifier(value.pending_operation_id);
  const recovery = value.recovery_generation_id === null ? null : identifier(value.recovery_generation_id);
  if (value.state === 'serving' && (pending !== null || recovery !== null) || value.state === 'pending' && (pending === null || recovery !== null)) return unavailable();
  return Object.freeze({ state: value.state as RestoreControl['state'], marker: validateRestoreMarker(value.marker),
    pending_operation_id: pending, recovery_generation_id: recovery });
}
async function validateReceipt(value: unknown, event: RestoreRestrictionEvent, sequence: number, previous: string): Promise<RestoreEventReceipt> {
  if (!exact(value, ['sequence', 'hash', 'previous_hash', 'payload_hash', 'recorded_at', 'event']) ||
      value.sequence !== sequence || value.previous_hash !== previous || !same(validateRestoreRestrictionEvent(value.event), event)) return unavailable();
  const payloadHash = await digest(stable(event)), recordedAt = integer(value.recorded_at, 1);
  if (hash(value.payload_hash) !== payloadHash || hash(value.hash) !== await digest(stable({ protocol: RESTORE_JOURNAL_PROTOCOL,
    project_id: RESTORE_PROJECT_ID, sequence, previous_hash: previous, payload_hash: payloadHash, recorded_at: recordedAt }))) return unavailable();
  return Object.freeze({ sequence, hash: value.hash as string, previous_hash: previous, payload_hash: payloadHash, recorded_at: recordedAt, event });
}
export async function validateRestoreOperationRecord(value: unknown): Promise<RestoreOperationRecord> {
  if (!exact(value, ['plan', 'plan_hash', 'status', 'committed_at']) || !exact(value.plan,
    ['version', 'project_id', 'operation_id', 'input_hash', 'expected', 'allocations', 'events', 'next', 'prepared_at', 'receipts'])) return unavailable();
  const raw = value.plan;
  const input = validateRestoreOperationInput({ version: raw.version, project_id: raw.project_id, operation_id: raw.operation_id,
    input_hash: raw.input_hash, expected: raw.expected, allocations: raw.allocations, events: raw.events });
  if (!Array.isArray(raw.receipts) || raw.receipts.length !== input.events.length) return unavailable();
  const next = validateRestoreMarker(raw.next), preparedAt = integer(raw.prepared_at, 1);
  if (input.expected.checkpoint.revision === Number.MAX_SAFE_INTEGER || next.database_id !== input.expected.database_id ||
      next.incarnation_id !== input.expected.incarnation_id || next.checkpoint.revision !== input.expected.checkpoint.revision + 1) return unavailable();
  const receipts: RestoreEventReceipt[] = []; let previous = input.expected.cursor.hash, sequence = input.expected.cursor.sequence, recordedAt = 0;
  for (let index = 0; index < input.events.length; index++) {
    if (sequence === Number.MAX_SAFE_INTEGER) return unavailable();
    const receipt = await validateReceipt(raw.receipts[index], input.events[index], ++sequence, previous);
    if (receipt.recorded_at < recordedAt || receipt.recorded_at !== preparedAt) return unavailable();
    receipts.push(receipt); previous = receipt.hash; recordedAt = receipt.recorded_at;
  }
  if (next.cursor.sequence !== sequence || next.cursor.hash !== previous || next.checkpoint.hash !== await digest(stable({
    protocol: RESTORE_JOURNAL_PROTOCOL, kind: 'database-checkpoint-v1', project_id: RESTORE_PROJECT_ID,
    operation_id: input.operation_id, input_hash: input.input_hash, expected: input.expected,
    allocations: input.allocations, events: input.events, cursor: next.cursor,
  }))) return unavailable();
  const plan = Object.freeze({ ...input, next, prepared_at: preparedAt, receipts: Object.freeze(receipts) });
  const committedAt = value.committed_at === null ? null : integer(value.committed_at, 1);
  if (!['pending', 'committed'].includes(value.status as string) || value.status === 'pending' && committedAt !== null ||
      value.status === 'committed' && (committedAt === null || committedAt < preparedAt) || hash(value.plan_hash) !== await digest(stable(plan))) return unavailable();
  return Object.freeze({ plan, plan_hash: value.plan_hash as string, status: value.status as RestoreOperationRecord['status'], committed_at: committedAt });
}

/** Server-only, fixed-project client. No bootstrap/recovery-clear method and no
 * automatic write retry: a failed prepare/ack may have taken effect. Lookup is
 * evidence for reconciliation, never serving authority. */
export class RestoreJournalClient {
  readonly #token: string;
  private readonly base: URL;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  constructor(url: string, token: string, options: { fetcher?: typeof fetch; timeoutMs?: number } = {}) {
    let base:URL;
    try { base = new URL(url); } catch { throw new ApiError(503,'restore_journal_unavailable'); }
    const timeoutMs=options.timeoutMs??15_000;
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash ||
      !['', '/'].includes(base.pathname) || typeof token!=='string' || !/^[!-~]{32,256}$/.test(token) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 55_000) throw new ApiError(503,'restore_journal_unavailable');
    this.base=base;this.#token=token;this.timeoutMs=timeoutMs;this.fetcher=options.fetcher??fetch;
  }
  private async request<T>(path: string, body: unknown | undefined, validate: (value: unknown, status: number) => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, this.timeoutMs);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const interrupted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new ApiError(503, 'restore_journal_unavailable')), { once: true });
      if (controller.signal.aborted) reject(new ApiError(503, 'restore_journal_unavailable'));
    });
    void interrupted.catch(() => {});
    let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const chunks: Uint8Array[] = [];
    try {
      const serialized = body === undefined ? undefined : stable(body);
      if (serialized !== undefined && new TextEncoder().encode(serialized).byteLength > RESTORE_REQUEST_BYTES || controller.signal.aborted) return unavailable();
      const destination = new URL(path, this.base);
      const pending = this.fetcher(destination, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual', signal: controller.signal,
        headers: { Authorization: 'Bearer ' + this.#token, Accept: 'application/json', 'Accept-Encoding': 'identity',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }) }, ...(serialized === undefined ? {} : { body: serialized }) });
      void pending.then(late => { if (controller.signal.aborted) void late.body?.cancel().catch(() => {}); }, () => {});
      response = await Promise.race([pending, interrupted]);
      if (response.redirected || response.status >= 300 && response.status < 400 ||
          !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('Content-Type') ?? '') || response.headers.has('Content-Encoding')) return unavailable();
      const claimed = response.headers.get('Content-Length');
      if (claimed !== null && (!/^(0|[1-9][0-9]*)$/.test(claimed) || Number(claimed) > RESTORE_RESPONSE_BYTES)) return unavailable();
      reader = response.body?.getReader(); if (!reader) return unavailable();
      let size = 0;
      for (;;) {
        const next = await Promise.race([reader.read(), interrupted]); if (next.done) break;
        size += next.value.byteLength; if (size > RESTORE_RESPONSE_BYTES) return unavailable(); chunks.push(next.value);
      }
      if (claimed !== null && Number(claimed) !== size) return unavailable();
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } finally { bytes.fill(0); }
      const result = await Promise.race([validate(parsed, response.status), interrupted]);
      if (controller.signal.aborted) return unavailable();
      return result;
    } catch { return unavailable(); }
    finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort();
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      else if (response?.body) void response.body.cancel().catch(() => {});
      for (const chunk of chunks) chunk.fill(0);
    }
  }
  private envelope(value: unknown, fields: readonly string[]): Record<string, unknown> {
    if (!exact(value, fields) || value.protocol !== RESTORE_JOURNAL_PROTOCOL || value.project_id !== RESTORE_PROJECT_ID) return unavailable(); return value;
  }
  async control(signal?: AbortSignal): Promise<RestoreControl> {
    return this.request('/v1/control', undefined, (value, status) => {
      if (status !== 200) return unavailable(); return validateRestoreControl(this.envelope(value, ['protocol', 'project_id', 'control']).control);
    }, signal);
  }
  async admission(marker: RestoreMarker, signal?: AbortSignal): Promise<RestoreControl> {
    const expected = validateRestoreMarker(marker);
    return this.request('/v1/admission', { version: 1, project_id: RESTORE_PROJECT_ID, marker: expected }, (value, status) => {
      if (status !== 200) return unavailable(); const envelope = this.envelope(value, ['protocol', 'project_id', 'control', 'admitted']);
      const control = validateRestoreControl(envelope.control);
      if (envelope.admitted !== true || control.state !== 'serving' || !same(control.marker, expected)) return unavailable(); return control;
    }, signal);
  }
  async prepare(value: RestoreOperationInput, signal?: AbortSignal): Promise<RestoreOperationRecord> {
    const input = validateRestoreOperationInput(value);
    return this.request('/v1/operations/prepare', input, async (value, status) => {
      if (status !== 200) return unavailable(); const envelope = this.envelope(value, ['protocol', 'project_id', 'control', 'operation']);
      const control = validateRestoreControl(envelope.control), operation = await validateRestoreOperationRecord(envelope.operation);
      const plan = operation.plan;
      if (!same({ version: plan.version, project_id: plan.project_id, operation_id: plan.operation_id, input_hash: plan.input_hash,
        expected: plan.expected, allocations: plan.allocations, events: plan.events }, input) || control.state === 'quarantined') return unavailable();
      if (operation.status === 'pending' && (control.state !== 'pending' || control.pending_operation_id !== input.operation_id || !same(control.marker, input.expected))) return unavailable();
      if (operation.status === 'committed' && (control.state !== 'serving' || !same(control.marker, plan.next))) return unavailable();
      return operation;
    }, signal);
  }
  async lookup(operationId: string, signal?: AbortSignal): Promise<RestoreOperationRecord | null> {
    const id = identifier(operationId);
    return this.request('/v1/operations/' + id, undefined, async (value, status) => {
      if (status === 404 && exact(value, ['error']) && value.error === 'operation_not_found') return null;
      if (status !== 200) return unavailable(); const envelope = this.envelope(value, ['protocol', 'project_id', 'control', 'operation']);
      validateRestoreControl(envelope.control); const operation = await validateRestoreOperationRecord(envelope.operation);
      if (operation.plan.operation_id !== id) return unavailable(); return operation;
    }, signal);
  }
  async acknowledge(operationId: string, planHash: string, marker: RestoreMarker, signal?: AbortSignal): Promise<RestoreOperationRecord> {
    const id = identifier(operationId), expectedHash = hash(planHash), next = validateRestoreMarker(marker);
    return this.request('/v1/operations/' + id + '/acknowledge', { version: 1, project_id: RESTORE_PROJECT_ID, plan_hash: expectedHash, marker: next }, async (value, status) => {
      if (status !== 200) return unavailable(); const envelope = this.envelope(value, ['protocol', 'project_id', 'control', 'operation']);
      const control = validateRestoreControl(envelope.control), operation = await validateRestoreOperationRecord(envelope.operation);
      if (operation.plan.operation_id !== id || operation.plan_hash !== expectedHash || operation.status !== 'committed' ||
        !same(operation.plan.next, next) || control.state !== 'serving' || !same(control.marker, next)) return unavailable();
      return operation;
    }, signal);
  }
}
