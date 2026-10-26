import { randomUUID } from 'node:crypto';
import { PROJECT_ID } from '../src/journal.mjs';

export const env = { SUPABASE_PROJECT_ID: PROJECT_ID, RESTORE_JOURNAL_TOKEN: 'synthetic-independent-journal-secret-32-characters' };
export const ids = Object.freeze(Object.fromEntries(['account', 'other', 'request', 'consent', 'profile', 'guardian', 'approval', 'session', 'device', 'asset', 'block'].map(key => [key, randomUUID()])));
export function event(kind = 'consent-withdrawn', scope = { account_id: ids.account, consent_id: ids.consent, purpose: 'photo_matching' }, operation = randomUUID()) {
  return { version: 1, project_id: PROJECT_ID, operation_id: operation, kind, scope };
}
export function request(path = '/v1/events', body, headers = {}) {
  return new Request('https://journal.invalid' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: 'Bearer ' + env.RESTORE_JOURNAL_TOKEN, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

/** Serial, rollback-capable storage port for unit failures, not a DO substitute. */
export class MemoryStorage {
  constructor(rows = new Map()) { this.rows = structuredClone(rows); this.tail = Promise.resolve(); this.calls = 0; this.failPut = false; }
  async transaction(callback) {
    this.calls += 1;
    const previous = this.tail;
    let unlock;
    this.tail = new Promise(resolve => { unlock = resolve; });
    await previous;
    const draft = structuredClone(this.rows);
    const tx = {
      get: async key => structuredClone(draft.get(key)),
      put: async values => {
        for (const [key, value] of Object.entries(values)) draft.set(key, structuredClone(value));
        if (this.failPut) throw new Error('synthetic storage unavailable, private diagnostic');
      },
      list: async ({ prefix = '', startAfter, reverse = false, limit } = {}) => {
        let keys = [...draft.keys()].filter(key => key.startsWith(prefix) && (startAfter === undefined || key > startAfter)).sort();
        if (reverse) keys.reverse();
        if (limit !== undefined) keys = keys.slice(0, limit);
        return new Map(keys.map(key => [key, structuredClone(draft.get(key))]));
      },
    };
    try {
      const result = await callback(tx);
      this.rows = draft;
      return structuredClone(result);
    } finally { unlock(); }
  }
}
