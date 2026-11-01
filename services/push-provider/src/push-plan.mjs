/** Token-free immutable admission metadata shared by the independent ledger and
 * gateway. A sealed plan is the complete intended fanout for one notification. */
export const PUSH_PLAN_PROTOCOL = 'lovelies-push-attempt-plan-v2';
export const PUSH_DISPATCH_PROTOCOL = 'lovelies-push-request-v2';
export const PUSH_RECEIPT_V2 = 'lovelies-push-dispatch-receipt-v2';
export const PUSH_ROSTER_PROTOCOL = 'lovelies-push-attempt-roster-v2';
export const PUSH_GENERATION_PROTOCOL = 'lovelies-push-provider-generation-v1';
export const MAX_PLAN_DEVICES = 10;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const HASH = /^[0-9a-f]{64}$/;
export const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key));
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key)+':'+canonical(value[key])).join(',') + '}';
}
export async function sha256(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
export class PushPlanError extends Error {}
export function validatePlan(value) {
  if (!exact(value,['protocol','ledger_id','ledger_bootstrap_id','notification_id','subject_sha256','provider_generation','attempts']) ||
    value.protocol!==PUSH_PLAN_PROTOCOL || !UUID.test(value.ledger_id) || !UUID.test(value.ledger_bootstrap_id) || !UUID.test(value.notification_id) ||
    typeof value.subject_sha256!=='string' || !HASH.test(value.subject_sha256) || typeof value.provider_generation!=='string' || !HASH.test(value.provider_generation) ||
    !Array.isArray(value.attempts) || value.attempts.length>MAX_PLAN_DEVICES) throw new PushPlanError('push_plan_invalid');
  let previous='';
  for (const entry of value.attempts) {
    if (!exact(entry,['operation_key','device_id','platform','token_sha256','request_sha256']) || !UUID.test(entry.device_id) ||
      entry.operation_key!=='notification:'+value.notification_id+':'+entry.device_id || entry.operation_key<=previous ||
      !['ios','android'].includes(entry.platform) || typeof entry.token_sha256!=='string' || !HASH.test(entry.token_sha256) ||
      typeof entry.request_sha256!=='string' || !HASH.test(entry.request_sha256)) throw new PushPlanError('push_plan_invalid');
    previous=entry.operation_key;
  }
  return structuredClone(value);
}
export function boundDispatch(value, parseLegacy) {
  if (!exact(value,['protocol','subject_sha256','provider_generation','operation_key','platform','token','notification']) ||
    value.protocol!==PUSH_DISPATCH_PROTOCOL || typeof value.subject_sha256!=='string' || !HASH.test(value.subject_sha256) ||
    typeof value.provider_generation!=='string' || !HASH.test(value.provider_generation)) throw new PushPlanError('push_dispatch_invalid');
  const legacy=parseLegacy({operation_key:value.operation_key,platform:value.platform,token:value.token,notification:value.notification});
  // This explicit property order is part of the request-digest contract.
  return {protocol:PUSH_DISPATCH_PROTOCOL,subject_sha256:value.subject_sha256,provider_generation:value.provider_generation,
    operation_key:legacy.operation_key,platform:legacy.platform,token:legacy.token,notification:legacy.notification};
}
