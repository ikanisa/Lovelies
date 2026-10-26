import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { handleLedgerRequest, PUSH_LEDGER_PROJECT } from '../src/durable-ledger.mjs';
import { RemoteDispatchLedger } from '../src/remote-ledger.mjs';
/** Controlled KV rollback port with actual SQLite admission constraints. Hosted
 * SQL/KV atomicity is qualified separately under the production Worker runtime. */
export class MemoryStorage {
  constructor(rows = new Map()) {
    this.rows = structuredClone(rows); this.tail = Promise.resolve(); this.calls = 0; this.failPut = false;
    this.database = new DatabaseSync(':memory:');
    this.sql = { exec: (statement, ...bindings) => ({ toArray: () => this.database.prepare(statement).all(...bindings).map(value => ({ ...value })) }) };
  }
  async transaction(callback) {
    this.calls++; const previous = this.tail; let unlock;
    this.tail = new Promise(resolve => { unlock = resolve; }); await previous;
    const draft = structuredClone(this.rows); this.database.exec('BEGIN IMMEDIATE');
    const tx = {
      get: async key => structuredClone(draft.get(key)),
      put: async values => { for (const [key, value] of Object.entries(values)) draft.set(key, structuredClone(value)); if (this.failPut) throw new Error('synthetic private failure'); },
      list: async ({ limit } = {}) => new Map([...draft].sort().slice(0, limit)),
    };
    try { const result = await callback(tx); this.database.exec('COMMIT'); this.rows = draft; return structuredClone(result); }
    catch (error) { this.database.exec('ROLLBACK'); throw error; }
    finally { unlock(); }
  }
}
export const env = { SUPABASE_PROJECT_ID: PUSH_LEDGER_PROJECT, PUSH_LEDGER_ID: randomUUID(),
  PUSH_LEDGER_TOKEN: 'synthetic-private-push-ledger-secret-32-characters',
  PUSH_LEDGER_BOOTSTRAP_TOKEN: 'synthetic-temporary-bootstrap-secret-32-characters' };
export const bootstrapID = randomUUID();
export const envelope = fields => ({ version: 1, project_id: PUSH_LEDGER_PROJECT, ledger_id: env.PUSH_LEDGER_ID, ...fields });
export function input() {
  const note = randomUUID();
  return { operation_key: 'notification:' + note + ':' + randomUUID(), platform: 'android', token: 'private-device-token-never-on-ledger-wire',
    notification: { id: note, title: 'A photo sharing request is waiting', kind: 'match', entity_id: randomUUID() } };
}
export function request(path, body, secret = env.PUSH_LEDGER_TOKEN, headers = {}) {
  return new Request('https://ledger.invalid' + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: 'Bearer ' + secret, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
export async function fixture(options = {}) {
  const storage = new MemoryStorage(); let now = 1_800_000_000_000;
  const send = (path, body, secret, headers) => handleLedgerRequest(request(path, body, secret, headers), env, storage, { now: () => now });
  const initialized = await send('/v1/bootstrap', envelope({ bootstrap_id: bootstrapID }), env.PUSH_LEDGER_BOOTSTRAP_TOKEN);
  if (initialized.status !== 200) throw new Error('fixture initialization failed');
  const wire = [];
  const client = new RemoteDispatchLedger('https://ledger.invalid', env.PUSH_LEDGER_TOKEN, { ledgerID: env.PUSH_LEDGER_ID,
    fetcher: async (url, init) => { wire.push(init.body ? JSON.parse(init.body) : null); return handleLedgerRequest(new Request(url, init), env, storage, { now: () => now }); }, ...options });
  return { storage, send, client, wire, get now() { return now; }, advance: ms => { now += ms; } };
}
