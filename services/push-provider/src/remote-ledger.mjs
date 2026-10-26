import { LedgerConflict } from './ledger.mjs';
import { PUSH_LEDGER_PROJECT, PUSH_LEDGER_PROTOCOL, PUSH_LEDGER_BODY_LIMIT, PUSH_LEDGER_REPLY_LIMIT,
  exact, identifier, operationKey, validateOutcome, validateDispatchRow } from './durable-ledger.mjs';

const unavailable = () => new Error('provider_ledger_unavailable');
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
function validateControl(value) {
  if (!exact(value, ['bootstrap_id', 'state', 'reason', 'created_at', 'last_at', 'records', 'revision']) ||
      !['serving', 'quarantined'].includes(value.state) || !integer(value.created_at, 1) || !integer(value.last_at, value.created_at) ||
      !integer(value.records) || !integer(value.revision, value.records) || value.state === 'serving' && value.reason !== null ||
      value.state === 'quarantined' && !['ledger_recovery_required', 'storage_integrity_unconfirmed'].includes(value.reason)) throw unavailable();
  identifier(value.bootstrap_id); return value;
}

/** HTTPS-only adapter for the existing DispatchLedger port. No retries: a lost
 * start acknowledgement must prevent provider bytes; a lost finish is resolved
 * by lookup. The raw reserve input deliberately never crosses this boundary. */
export class RemoteDispatchLedger {
  #origin; #token; #id; #fetch; #timeout;
  constructor(url, token, { ledgerID, fetcher = fetch, timeoutMs = 15_000 } = {}) {
    let parsed;
    try { parsed = new URL(url); identifier(ledgerID); } catch { throw unavailable(); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/' ||
        typeof token !== 'string' || !/^[!-~]{32,256}$/.test(token) || typeof fetcher !== 'function' || !integer(timeoutMs, 1) || timeoutMs > 30_000) throw unavailable();
    this.#origin = parsed.origin; this.#token = token; this.#id = ledgerID; this.#fetch = fetcher; this.#timeout = timeoutMs;
  }
  async #request(path, fields, { missing = false, conflict = false, serving = false, control: controlOnly = false } = {}) {
    const controller = new AbortController(); let response, reader, complete = false, expired = false;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; controller.abort(); void reader?.cancel().catch(() => {}); reject(unavailable()); }, this.#timeout);
    });
    const operation = async () => {
      const body = fields === undefined ? undefined : JSON.stringify({ version: 1, project_id: PUSH_LEDGER_PROJECT, ledger_id: this.#id, ...fields });
      if (body !== undefined && Buffer.byteLength(body) > PUSH_LEDGER_BODY_LIMIT) throw unavailable();
      response = await this.#fetch(this.#origin + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: 'Bearer ' + this.#token, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body }), redirect: 'error', signal: controller.signal });
      if (expired) { await response.body?.cancel().catch(() => {}); throw unavailable(); }
      if (response.redirected || response.url && response.url !== this.#origin + path ||
          !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '') || response.headers.has('content-encoding')) throw unavailable();
      const claimed = response.headers.get('content-length');
      if (claimed !== null && (!/^(0|[1-9][0-9]*)$/.test(claimed) || Number(claimed) > PUSH_LEDGER_REPLY_LIMIT)) throw unavailable();
      reader = response.body?.getReader(); if (!reader) throw unavailable();
      const chunks = []; let size = 0;
      try {
        for (;;) {
          const next = await reader.read(); if (next.done) { complete = true; break; }
          if (expired) throw unavailable();
          size += next.value.byteLength; if (size > PUSH_LEDGER_REPLY_LIMIT) throw unavailable(); chunks.push(next.value);
        }
        if (claimed !== null && Number(claimed) !== size || expired) throw unavailable();
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        let value;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        finally { bytes.fill(0); }
        if (response.status !== 200) {
          if (missing && response.status === 404 && exact(value, ['error']) && value.error === 'operation_not_found') return null;
          if (conflict && response.status === 409 && exact(value, ['error']) && value.error === 'operation_payload_conflict') throw new LedgerConflict();
          throw unavailable();
        }
        if (!exact(value, ['protocol', 'project_id', 'ledger_id', 'control', ...(controlOnly ? [] : ['result'])]) ||
            value.protocol !== PUSH_LEDGER_PROTOCOL || value.project_id !== PUSH_LEDGER_PROJECT || value.ledger_id !== this.#id) throw unavailable();
        const control = validateControl(value.control);
        if (serving && control.state !== 'serving') throw unavailable();
        return value;
      } finally { for (const chunk of chunks) chunk.fill(0); }
    };
    try { return await Promise.race([operation(), timeout]); }
    catch (error) { if (error instanceof LedgerConflict) throw error; throw unavailable(); }
    finally {
      clearTimeout(timer);
      if (!complete) { controller.abort(); if (reader) void reader.cancel().catch(() => {}); else if (response) void response.body?.cancel().catch(() => {}); }
    }
  }
  async control() {
    // Control has no body and differs only in the absence of a result field.
    return this.#control();
  }
  async #control() {
    const value = await this.#request('/v1/control', undefined, { control: true }); return value.control;
  }
  async reserve(input, requestHash) {
    try {
      operationKey(input.operation_key); identifier(input.notification.id);
      if (!/^[0-9a-f]{64}$/.test(requestHash) || !['ios', 'android'].includes(input.platform)) throw unavailable();
      const value = await this.#request('/v1/operations/reserve', { operation_key: input.operation_key, request_sha256: requestHash,
        platform: input.platform, notification_id: input.notification.id }, { conflict: true, serving: true });
      if (!exact(value.result, ['row', 'claim'])) throw unavailable();
      const row = validateDispatchRow(value.result.row, input.operation_key), claim = value.result.claim;
      if (row.request_sha256 !== requestHash || row.platform !== input.platform || row.notification_id !== input.notification.id ||
          claim !== null && (identifier(claim) !== row.claim_id || row.status !== 'prepared')) throw unavailable();
      return { row, claim };
    } catch (error) { if (error instanceof LedgerConflict) throw error; throw unavailable(); }
  }
  async preflightFailed(key, claim, code = 'provider_preflight_unavailable') {
    try {
      operationKey(key); identifier(claim);
      if (typeof code !== 'string' || !/^[A-Za-z0-9._:-]{1,80}$/.test(code)) throw unavailable();
      const value = await this.#request('/v1/operations/' + encodeURIComponent(key) + '/preflight-failed', { claim_id: claim, code });
      if (!exact(value.result, ['updated']) || typeof value.result.updated !== 'boolean') throw unavailable();
    } catch { throw unavailable(); }
  }
  async startDispatch(key, claim) {
    try {
      operationKey(key); identifier(claim);
      const value = await this.#request('/v1/operations/' + encodeURIComponent(key) + '/start', { claim_id: claim }, { serving: true });
      if (!exact(value.result, ['row'])) throw unavailable();
      if (value.result.row === null) return null;
      const row = validateDispatchRow(value.result.row, key); if (row.status !== 'dispatching') throw unavailable(); return row;
    } catch { throw unavailable(); }
  }
  async finish(key, result) {
    try {
      operationKey(key); const outcome = validateOutcome(result);
      const value = await this.#request('/v1/operations/' + encodeURIComponent(key) + '/finish', { result: outcome });
      if (!exact(value.result, ['row'])) throw unavailable();
      const row = validateDispatchRow(value.result.row, key);
      for (const [name, expected] of Object.entries(outcome)) if (row[name] !== expected) throw unavailable();
      return row;
    } catch { throw unavailable(); }
  }
  async lookup(key) {
    try {
      operationKey(key); const value = await this.#request('/v1/operations/' + encodeURIComponent(key), undefined, { missing: true });
      if (value === null) return null;
      if (!exact(value.result, ['row'])) throw unavailable(); return validateDispatchRow(value.result.row, key);
    } catch { throw unavailable(); }
  }
}
