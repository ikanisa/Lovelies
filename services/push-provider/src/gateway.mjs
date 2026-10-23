import { createHash, timingSafeEqual } from 'node:crypto';
import { LedgerConflict, receipt } from './ledger.mjs';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const operationPattern = new RegExp('^notification:(' + UUID + '):(' + UUID + ')$');
const uuidPattern = new RegExp('^' + UUID + '$');
const titles = Object.freeze({ match: 'A photo sharing request is waiting', payment: 'Your subscription status was updated', support: 'Your support request was reviewed' });
export class InputError extends Error {}
export function parseDispatch(value) {
  const exact = (item, keys) => item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === keys.length && keys.every(key => Object.hasOwn(item, key));
  if (!exact(value, ['operation_key', 'platform', 'token', 'notification']) || !exact(value.notification, ['id', 'title', 'kind', 'entity_id'])) throw new InputError('invalid_dispatch');
  const { operation_key: operation, platform, token, notification: note } = value;
  const match = typeof operation === 'string' && operationPattern.exec(operation);
  if (!match || !['ios', 'android'].includes(platform) || typeof token !== 'string' || token.length < 16 || token.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(token) ||
      typeof note.id !== 'string' || !uuidPattern.test(note.id) || match[1] !== note.id || typeof note.kind !== 'string' || !Object.hasOwn(titles, note.kind) || note.title !== titles[note.kind] ||
      typeof note.entity_id !== 'string' || note.entity_id.length < 1 || note.entity_id.length > 300 || /[\u0000-\u001f\u007f]/.test(note.entity_id) ||
      (note.kind !== 'payment' && !uuidPattern.test(note.entity_id))) throw new InputError('invalid_dispatch');
  if (platform === 'ios' && !/^[0-9a-f]{32,512}$/i.test(token)) throw new InputError('invalid_apns_token');
  return { operation_key: operation, platform, token, notification: { id: note.id, title: note.title, kind: note.kind, entity_id: note.entity_id } };
}
export function requestHash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function authenticated(header, secret) {
  if (typeof header !== 'string' || header.length > 512 || !header.startsWith('Bearer ')) return false;
  const hash = text => createHash('sha256').update(text).digest();
  return timingSafeEqual(hash(header.slice(7)), hash(secret));
}
async function boundedJSON(request, limit) {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json') || /[^0-9]/.test(request.headers.get('content-length') ?? '')) throw new InputError('json_required');
  if (Number(request.headers.get('content-length') ?? 0) > limit) throw new InputError('body_too_large');
  const reader = request.body?.getReader(); if (!reader) throw new InputError('json_required');
  const buffers = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) { await reader.cancel(); throw new InputError('body_too_large'); } buffers.push(value); } return JSON.parse(Buffer.concat(buffers).toString('utf8')); }
  catch (error) { if (error instanceof InputError) throw error; throw new InputError('invalid_json'); }
  finally { reader.releaseLock(); }
}
const response = (status, body) => Response.json(body, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
export function createGateway({ ledger, providers, secret, now = Date.now, maximumInFlight = 32 }) {
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 256 || /\s/.test(secret)) throw new Error('PUSH_SERVICE_SECRET must be a private 32–256 character token');
  let inFlight = 0;
  return async function handle(request) {
    if (!authenticated(request.headers.get('authorization'), secret)) return response(401, { error: 'service_authentication_required' });
    const url = new URL(request.url);
    if (url.search || url.hash) return response(400, { error: 'invalid_request' });
    try {
      if (request.method === 'GET' && url.pathname.startsWith('/operations/')) {
        let key; try { key = decodeURIComponent(url.pathname.slice('/operations/'.length)); } catch { throw new InputError('invalid_operation'); }
        if (!operationPattern.test(key)) throw new InputError('invalid_operation');
        return response(200, receipt(await ledger.lookup(key), key, now()));
      }
      if (request.method !== 'POST' || url.pathname !== '/send') return response(404, { error: 'not_found' });
      if (inFlight >= maximumInFlight) return response(503, { error: 'gateway_capacity' });
      inFlight++;
      try {
        const input = parseDispatch(await boundedJSON(request, 8192));
        const reserved = await ledger.reserve(input, requestHash(input));
        if (!reserved.claim) return response(200, receipt(await ledger.lookup(input.operation_key), input.operation_key, now()));
        const provider = providers[input.platform];
        let prepared;
        try { if (!provider) throw new Error('provider_unconfigured'); prepared = await provider.prepare(input, reserved.row.provider_request_id); }
        catch { await ledger.preflightFailed(input.operation_key, reserved.claim); return response(503, receipt(await ledger.lookup(input.operation_key), input.operation_key, now())); }
        // Commit dispatch intent before the first provider message byte. Once
        // here, neither a timeout, crash nor duplicated caller can resend it.
        const dispatch = await ledger.startDispatch(input.operation_key, reserved.claim);
        if (!dispatch) return response(200, receipt(await ledger.lookup(input.operation_key), input.operation_key, now()));
        let result;
        try { result = await provider.send(prepared); }
        catch { result = { status: 'ambiguous', provider_code: 'dispatch_result_unconfirmed' }; }
        try { return response(200, receipt(await ledger.finish(input.operation_key, result), input.operation_key, now())); }
        catch { return response(503, { operation_key: input.operation_key, status: 'ambiguous', provider_code: 'receipt_persistence_unconfirmed' }); }
      } finally { inFlight--; }
    } catch (error) {
      if (error instanceof InputError) return response(400, { error: error.message });
      if (error instanceof LedgerConflict) return response(409, { error: 'operation_payload_conflict' });
      return response(503, { error: 'provider_ledger_unavailable' });
    }
  };
}
