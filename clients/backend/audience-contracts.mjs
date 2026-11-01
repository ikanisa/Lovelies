const fail=code=>{throw Object.assign(new Error(code),{code});};
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value??{},key);
const day=24*60*60*1000;
export const AUDIENCE_POLICY='audience-2026-10-24-v1';
export const AUDIENCE_RULE='audience-13-plus-guardian-v1';
export const AUDIENCE_PROTOCOL='lovelies-audience-v2';
export const AUDIENCE_DEVICE_PROTOCOL='lovelies-audience-device-v1';
export const AUDIENCE_PURPOSES=Object.freeze(['face_authentication','photo_matching','photo_processing']);

/** The range is a transient UI input. Persist only the returned decision. */
export function audienceDecision(selection) {
  if(!['under13','13_17','18_plus'].includes(selection))fail('audience_selection_required');
  return Object.freeze({at_least_13:selection!=='under13',guardian_required:selection==='13_17'});
}
export function audienceDecisionFields(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='at_least_13,guardian_required'||
      typeof value.at_least_13!=='boolean'||typeof value.guardian_required!=='boolean'||(!value.at_least_13&&value.guardian_required))fail('audience_decision_invalid');
  return Object.freeze({at_least_13:value.at_least_13,guardian_required:value.guardian_required});
}
export function audienceRecord(value,now=Date.now()) {
  const a=value;
  if(!a||typeof a!=='object'||Array.isArray(a)||own(a,'age_band')||
      !['unknown','blocked','guardian_pending','eligible','suspended'].includes(a.status)||
      !Number.isSafeInteger(a.version)||a.version<0||typeof a.review_required!=='boolean')fail('audience_response_invalid');
  const unknown=a.version===0;
  let declaredAt=null,nextReviewAt=null;
  if(unknown) {
    if(a.status!=='unknown'||a.review_required||['at_least_13','guardian_required','policy_version','source','rule_version','territory','declared_at','next_review_at'].some(key=>a[key]!==null))fail('audience_response_invalid');
  } else {
    if(typeof a.at_least_13!=='boolean'||typeof a.guardian_required!=='boolean'||(!a.at_least_13&&a.guardian_required)||a.status==='unknown'||
        a.policy_version!==AUDIENCE_POLICY||a.rule_version!==AUDIENCE_RULE||a.territory!=='global'||
        !['self_declaration','independent_review','legacy_declaration'].includes(a.source))fail('audience_response_invalid');
    declaredAt=typeof a.declared_at==='string'?Date.parse(a.declared_at):NaN;
    nextReviewAt=typeof a.next_review_at==='string'?Date.parse(a.next_review_at):NaN;
    if(!Number.isFinite(declaredAt)||!Number.isFinite(nextReviewAt)||declaredAt<0||nextReviewAt<=declaredAt||nextReviewAt>declaredAt+365*day||
        (!a.at_least_13&&a.status!=='blocked')||(a.status==='guardian_pending'&&!a.guardian_required)||
        (a.status==='eligible'&&(!a.at_least_13||a.review_required||nextReviewAt<=now)))fail('audience_response_invalid');
  }
  return Object.freeze({atLeast13:a.at_least_13,guardianRequired:a.guardian_required,status:a.status,version:a.version,
    policyVersion:a.policy_version,source:a.source,ruleVersion:a.rule_version,territory:a.territory,declaredAt,nextReviewAt,
    reviewRequired:a.review_required||(!unknown&&nextReviewAt<=now)});
}
function authorityDeadline(value,current,now,required) {
  if(value===null){if(required)fail('audience_response_invalid');return null;}
  const deadline=typeof value==='string'?Date.parse(value):NaN;
  if(!Number.isFinite(deadline)||deadline<=now||current.nextReviewAt===null||deadline>current.nextReviewAt||current.reviewRequired||current.status!=='eligible')fail('audience_response_invalid');
  return deadline;
}
export function audienceProjection(value,accountId,now=Date.now()) {
  if(value?.protocol!==AUDIENCE_PROTOCOL||value.policy_version!==AUDIENCE_POLICY||!uuid(accountId)||value.account_id!==accountId)fail('audience_response_invalid');
  const current=audienceRecord(value.audience,now),c=value.capabilities;
  if(!c||AUDIENCE_PURPOSES.some(p=>typeof c[p]!=='boolean')||
      ((current.status!=='eligible'||current.atLeast13!==true||current.reviewRequired)&&AUDIENCE_PURPOSES.some(p=>c[p])))fail('audience_response_invalid');
  const any=AUDIENCE_PURPOSES.some(p=>c[p]),authorityExpiresAt=authorityDeadline(value.authority_expires_at,current,now,any);
  if(!any&&authorityExpiresAt!==null)fail('audience_response_invalid');
  return Object.freeze({accountId,...current,authorityExpiresAt,capabilities:Object.freeze(Object.fromEntries(AUDIENCE_PURPOSES.map(p=>[p,c[p]])))});
}
export function audienceDeviceStatus(value,{accountId,deviceId,requestNonce},now=Date.now()) {
  if(value?.protocol!==AUDIENCE_DEVICE_PROTOCOL||!uuid(accountId)||!uuid(deviceId)||!uuid(requestNonce)||
      value.account_id!==accountId||value.device_id!==deviceId||value.request_nonce!==requestNonce||typeof value.renewal_available!=='boolean'||
      typeof value.guardian_review_available!=='boolean'||!own(value,'guardian_request')||
      !['face_login','profile_recovery','guardian_review','audience_review'].includes(value.next_step)||
      ['access_token','refresh_token','challenge','capabilities'].some(key=>own(value,key)))fail('audience_device_response_invalid');
  const current=audienceRecord(value.audience,now);
  if(value.renewal_available&&(current.atLeast13!==true||current.guardianRequired!==false||!current.reviewRequired))fail('audience_device_response_invalid');
  if(value.guardian_review_available&&(current.atLeast13!==true||current.guardianRequired!==true||value.next_step!=='guardian_review'))fail('audience_device_response_invalid');
  if(value.next_step==='audience_review'&&(!value.renewal_available||current.atLeast13!==true||current.guardianRequired!==false||!current.reviewRequired))fail('audience_device_response_invalid');
  const guardian=value.guardian_request;
  if(guardian!=null&&(!uuid(guardian.id)||!['pending','under_review','approved','rejected','withdrawn','expired'].includes(guardian.state)||
      !Number.isSafeInteger(guardian.revision)||guardian.revision<1||guardian.policy_version!==AUDIENCE_POLICY||typeof guardian.expires_at!=='string'||
      !Number.isFinite(Date.parse(guardian.expires_at))||Object.keys(guardian).sort().join(',')!=='expires_at,id,policy_version,revision,state'))fail('audience_device_response_invalid');
  const authorityExpiresAt=authorityDeadline(value.authority_expires_at,current,now,current.status==='eligible'&&current.atLeast13===true&&!current.reviewRequired);
  if(value.next_step==='face_login'&&authorityExpiresAt===null)fail('audience_device_response_invalid');
  return Object.freeze({accountId,deviceId,...current,authorityExpiresAt,renewalAvailable:value.renewal_available,
    guardianReviewAvailable:value.guardian_review_available,nextStep:value.next_step});
}
export function audienceRenewalReceipt(value,body,currentVersion) {
  const receipt=value?.renewal;
  if(!receipt||receipt.operation_key!==body.operation_key||receipt.from_version!==body.expected_version||
      !Number.isSafeInteger(receipt.to_version)||receipt.to_version!==body.expected_version+1||currentVersion<receipt.to_version||
      !['face_login','profile_recovery','guardian_review'].includes(receipt.next_step))fail('audience_renewal_response_invalid');
  return Object.freeze({operationKey:receipt.operation_key,fromVersion:receipt.from_version,toVersion:receipt.to_version,nextStep:receipt.next_step});
}
export function audienceChallenge(value,now=Date.now()) {
  const a=value?.audience_authority;
  if(!a||a.protocol!=='lovelies-audience-challenge-v1'||a.policy_version!==AUDIENCE_POLICY||
      !uuid(a.account_id)||!uuid(a.challenge_id)||!uuid(a.device_id)||
      ['account_id','challenge_id','device_id','purpose'].some(k=>a[k]!==value[k])||
      !['registration','login'].includes(value.purpose)||!Number.isFinite(Date.parse(value.expires_at))||
      !Number.isSafeInteger(a.audience_version)||a.audience_version<1||!Number.isFinite(Date.parse(a.expires_at))||
      Date.parse(a.expires_at)<=now||Date.parse(a.expires_at)>Date.parse(value.expires_at))fail('audience_challenge_invalid');
  return value;
}
