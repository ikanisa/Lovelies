import { createHash, timingSafeEqual } from 'node:crypto';
import { LedgerConflict, receipt, PUSH_RECEIPT_PROTOCOL } from './ledger.mjs';
import {boundDispatch,exact,HASH,UUID as planUUID,validatePlan,PushPlanError} from './push-plan.mjs';
import {providerGeneration} from './providers.mjs';
import {RosterUnavailable,validateRosterReceipt} from './remote-roster.mjs';
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
        catch { return response(503, { protocol: PUSH_RECEIPT_PROTOCOL, operation_key: input.operation_key, request_sha256: requestHash(input), status: 'ambiguous', provider_code: 'receipt_persistence_unconfirmed' }); }
      } finally { inFlight--; }
    } catch (error) {
      if (error instanceof InputError) return response(400, { error: error.message });
      if (error instanceof LedgerConflict) return response(409, { error: 'operation_payload_conflict' });
      return response(503, { error: 'provider_ledger_unavailable' });
    }
  };
}

/** Selected production gateway. The legacy factory remains a compatibility
 * test/receipt adapter; server.start always selects this complete-roster path. */
export function createRosterGateway({roster,providers,secret,generation,maximumInFlight=32,dispatchEnabled=true}){
  if(typeof secret!=='string'||secret.length<32||secret.length>256||/\s/.test(secret)||!HASH.test(generation)||providerGeneration(providers)!==generation||typeof dispatchEnabled!=='boolean')
    throw new Error('push_roster_gateway_configuration_invalid');
  let inFlight=0;
  return async request=>{
    if(!authenticated(request.headers.get('authorization'),secret))return response(401,{error:'service_authentication_required'});
    const url=new URL(request.url);
    if(url.search||url.hash)return response(400,{error:'invalid_request'});
    try{
      if(request.method==='GET'&&url.pathname==='/ready'){
        if(!dispatchEnabled)return response(503,{error:'push_recovery_only'});
        const current=await roster.control();
        if(current.control.state!=='serving'||current.control.provider_generation!==generation||providerGeneration(providers)!==generation)
          return response(503,{error:'push_provider_generation_changed'});
        return response(200,current);
      }
      let match=/^\/notifications\/([0-9a-f-]{36})(?:\/(retire))?$/.exec(url.pathname);
      if(match&&planUUID.test(match[1])){
        if(request.method!==(match[2]?'POST':'GET'))return response(405,{error:'method_unavailable'});
        if(match[2]&&!exact(await boundedJSON(request,128),[]))throw new InputError('invalid_request');
        return response(200,match[2]?await roster.retirePlan(match[1]):await roster.lookupPlan(match[1]));
      }
      if(request.method==='POST'&&url.pathname==='/notifications/plan'){
        if(!dispatchEnabled)return response(503,{error:'push_recovery_only'});
        return response(200,await roster.plan(validatePlan(await boundedJSON(request,16384))));
      }
      match=/^\/subjects\/([0-9a-f]{64})\/retire$/.exec(url.pathname);
      if(match&&request.method==='POST'){
        if(!exact(await boundedJSON(request,128),[]))throw new InputError('invalid_request');
        return response(200,await roster.retireSubject(match[1]));
      }
      match=/^\/notifications\/page\/(0|[0-9a-f-]{36})$/.exec(url.pathname);
      if(match&&request.method==='GET'&&(match[1]==='0'||planUUID.test(match[1])))return response(200,await roster.listPlans(match[1]==='0'?'':match[1]));
      if(request.method==='GET'&&url.pathname.startsWith('/operations/')){
        let key;try{key=decodeURIComponent(url.pathname.slice('/operations/'.length));}catch{throw new InputError('invalid_operation');}
        if(!operationPattern.test(key))throw new InputError('invalid_operation');return response(200,await roster.lookup(key));
      }
      if(request.method!=='POST'||url.pathname!=='/send')return response(404,{error:'not_found'});
      if(!dispatchEnabled)return response(503,{error:'push_recovery_only'});
      if(inFlight>=maximumInFlight)return response(503,{error:'gateway_capacity'});
      inFlight++;
      try{
        const value=await boundedJSON(request,8192);
        if(!exact(value,['protocol','plan_sha256','dispatch'])||value.protocol!=='lovelies-push-send-v2'||!HASH.test(value.plan_sha256))throw new InputError('invalid_dispatch');
        const input=boundDispatch(value.dispatch,parseDispatch);
        const known=await roster.lookupPlan(input.notification.id),plan=known.result.plan;
        if(!plan||known.result.plan_sha256!==value.plan_sha256||plan.subject_sha256!==input.subject_sha256||plan.provider_generation!==input.provider_generation)
          return response(409,{error:'push_roster_binding_conflict'});
        const intended=plan.attempts.find(entry=>entry.operation_key===input.operation_key);
        if(!intended||intended.platform!==input.platform||intended.request_sha256!==requestHash(input)||intended.token_sha256!==createHash('sha256').update(input.token).digest('hex'))
          return response(409,{error:'operation_payload_conflict'});
        const old=known.result.receipts.find(entry=>entry.operation_key===input.operation_key);
        validateRosterReceipt(old,plan,value.plan_sha256);
        // A repeated exact request may inspect its historical outcome after a
        // generation change. It can never use that outcome to start new work.
        if(!['unstarted','preparing'].includes(old.status))return response(200,old);
        if(input.provider_generation!==generation||providerGeneration(providers)!==generation)return response(409,{error:'push_provider_generation_changed'});
        const reserved=await roster.reserve(input,value.plan_sha256);
        validateRosterReceipt(reserved.receipt,plan,value.plan_sha256);
        if(!reserved.claim)return response(200,reserved.receipt);
        const provider=providers[input.platform];let prepared;
        try{if(!provider)throw new Error('provider_unconfigured');prepared=await provider.prepare(input,reserved.receipt.provider_request_id);
          if(providerGeneration(providers)!==generation)throw new Error('provider_generation_changed');}
        catch{await roster.preflightFailed(input.operation_key,reserved.claim);return response(503,await roster.lookup(input.operation_key));}
        const admitted=await roster.start(input.operation_key,reserved.claim,generation);
        if(!admitted)return response(200,await roster.lookup(input.operation_key));
        validateRosterReceipt(admitted,plan,value.plan_sha256);
        if(admitted.status!=='dispatching')throw new RosterUnavailable();
        let result;
        if(providerGeneration(providers)!==generation)result={status:'rejected',provider_code:'gateway.provider_generation_changed',retryable:false,token_invalid:false};
        else try{result=await provider.send(prepared);}catch{result={status:'ambiguous',provider_code:'dispatch_result_unconfirmed'};}
        try{
          const saved=await roster.finish(input.operation_key,result);validateRosterReceipt(saved,plan,value.plan_sha256);return response(200,saved);
        }catch{return response(503,{...admitted,status:'ambiguous'});}
      }finally{inFlight--;}
    }catch(error){
      if(error instanceof InputError||error instanceof PushPlanError)return response(400,{error:'invalid_request'});
      if(error instanceof RosterUnavailable)return response(error.status,{error:error.code});
      return response(503,{error:'provider_roster_unavailable'});
    }
  };
}
