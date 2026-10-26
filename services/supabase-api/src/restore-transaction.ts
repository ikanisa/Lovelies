import { ApiError, digest, stable } from './types.ts';
import { RESTORE_PROJECT_ID, RESTORE_REQUEST_BYTES, validateRestoreRestrictionEvent,
  type RestoreOperationInput, type RestoreRestrictionEvent } from './restore-journal.ts';

export type RestoreOperationIdentity = Readonly<Pick<RestoreOperationInput, 'operation_id' | 'input_hash' | 'allocations'>>;
export interface RestoreTransactionScope {
  operation(identity: RestoreOperationIdentity): void;
  restrict(kind: RestoreRestrictionEvent['kind'], scope: Readonly<Record<string, string>>): Promise<void>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const invalid = (): never => { throw new ApiError(500, 'restore_operation_invalid'); };

async function identifier(namespace: string, value: unknown): Promise<string> {
  const hash = await digest(stable({ namespace, project_id: RESTORE_PROJECT_ID, value }));
  // UUIDv8 namespaced by a SHA256 digest; preserve 122 digest bits.
  const chars = hash.slice(0, 32).split(''); chars[12] = '8';
  chars[16] = ((parseInt(chars[16], 16) & 3) | 8).toString(16);
  const hex = chars.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/** The key identifies one logical action across transport ambiguity. Keeping the
 * payload in input_hash (rather than this UUID) makes altered-input reuse conflict
 * at the independent journal as well as at the SQL receipt. */
export async function restoreOperationID(actorID: string, source: string, key: string): Promise<string> {
  if (!UUID.test(actorID) || !/^[A-Za-z0-9._:-]{1,128}$/.test(source) || !/^[A-Za-z0-9._:-]{16,128}$/.test(key)) return invalid();
  return identifier('lovelies-database-logical-operation-v1', { actor_id: actorID, source, operation_key: key });
}
function identity(value: unknown): RestoreOperationIdentity {
  if (!plain(value) || Object.keys(value).sort().join(',') !== 'allocations,input_hash,operation_id' ||
      typeof value.operation_id !== 'string' || !UUID.test(value.operation_id) ||
      typeof value.input_hash !== 'string' || !HASH.test(value.input_hash) || !plain(value.allocations) ||
      Object.keys(value.allocations).length > 32) return invalid();
  const allocations: Record<string, string> = {};
  for (const [slot, id] of Object.entries(value.allocations)) {
    if (!/^id_(?:[0-9]|[12][0-9]|3[01])$/.test(slot) || typeof id !== 'string' || !UUID.test(id)) return invalid();
    allocations[slot] = id;
  }
  if (new Set(Object.values(allocations)).size !== Object.keys(allocations).length) return invalid();
  return Object.freeze({ operation_id: value.operation_id, input_hash: value.input_hash, allocations: Object.freeze(allocations) });
}
/** One collector belongs to one actual PostgreSQL transaction, including nested
 * callbacks. Invalid registration poisons that transaction even if a caller catches
 * the immediate error. This class performs no I/O or recovery/serving clearance. */
export class RestoreTransactionCollector implements RestoreTransactionScope {
  #identity: RestoreOperationIdentity | undefined;
  #events: Promise<RestoreRestrictionEvent>[] = [];
  #closed = false; #failed = false;
  readonly #readOnly: boolean; readonly #explicitIntent: boolean;
  readonly scope: RestoreTransactionScope;
  constructor(readOnly = false, explicitIntent = false) {
    this.#readOnly = readOnly; this.#explicitIntent = explicitIntent;
    // Domain callbacks receive this frozen port, never seal/close controls.
    this.scope = Object.freeze({ operation: (value: RestoreOperationIdentity) => this.operation(value),
      restrict: (kind: RestoreRestrictionEvent['kind'], value: Readonly<Record<string, string>>) => this.restrict(kind, value) });
  }
  #open(): void {
    if (this.#closed || this.#failed || this.#explicitIntent) { this.#failed = true; return invalid(); }
    if (this.#readOnly) { this.#failed = true; throw new ApiError(500, 'read_only_transaction'); }
  }
  operation(raw: RestoreOperationIdentity): void {
    this.#open();
    try {
      const next = identity(raw);
      if (this.#identity && stable(this.#identity) !== stable(next)) return invalid();
      this.#identity = next;
    } catch (error) { this.#failed = true; throw error; }
  }
  restrict(kind: RestoreRestrictionEvent['kind'], scope: Readonly<Record<string, string>>): Promise<void> {
    this.#open();
    try {
      if (!this.#identity || this.#events.length >= 32) return invalid();
      // Validate/copy before the first await; caller mutation cannot change scope.
      const value = validateRestoreRestrictionEvent({ version: 1, project_id: RESTORE_PROJECT_ID,
        operation_id: this.#identity.operation_id, kind, scope });
      const slot = this.#events.length;
      const event = identifier('lovelies-database-restriction-slot-v1', { operation_id: this.#identity.operation_id, slot })
        .then(operation_id => Object.freeze({ ...value, operation_id }))
        .catch(error => { this.#failed = true; throw error; });
      this.#events.push(event);
      // Retain failure for seal even if trusted application code forgets to await.
      void event.catch(() => {});
      const completion = event.then(() => {});
      void completion.catch(() => {});
      return completion;
    } catch (error) { this.#failed = true; throw error; }
  }
  close(): void { this.#closed = true; }
  async seal(explicit?: unknown): Promise<unknown> {
    if (this.#closed) return invalid();
    this.#closed = true;
    if (this.#failed || explicit !== undefined && this.#identity !== undefined) return invalid();
    if (!this.#identity) return explicit;
    const events = await Promise.all(this.#events);
    if (this.#failed) return invalid();
    const manifest = Object.freeze({ ...this.#identity, events: Object.freeze(events) });
    if (new TextEncoder().encode(stable(manifest)).byteLength > RESTORE_REQUEST_BYTES) return invalid();
    return manifest;
  }
}
