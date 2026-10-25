const fail=code=>{throw Object.assign(new Error(code),{code});};
export const AUDIENCE_POLICY='audience-2026-10-24-v1';
export const AUDIENCE_PURPOSES=Object.freeze(['face_authentication','photo_matching','photo_processing']);
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function audienceProjection(value,accountId) {
  const a=value?.audience,c=value?.capabilities;
  if(value?.protocol!=='lovelies-audience-v1'||value.policy_version!==AUDIENCE_POLICY||!uuid(accountId)||value.account_id!==accountId||
     !a||!['unknown','under13','13_17','18_plus'].includes(a.age_band)||!['unknown','blocked','guardian_pending','eligible','suspended'].includes(a.status)||
     !Number.isSafeInteger(a.version)||a.version<0||!c||AUDIENCE_PURPOSES.some(p=>typeof c[p]!=='boolean')||
     (a.age_band==='unknown'?(a.version!==0||a.status!=='unknown'||a.policy_version!==null):(a.version<1||a.policy_version!==AUDIENCE_POLICY)))fail('audience_response_invalid');
  if((a.status!=='eligible'||!['13_17','18_plus'].includes(a.age_band))&&AUDIENCE_PURPOSES.some(p=>c[p]))fail('audience_response_invalid');
  return Object.freeze({accountId,ageBand:a.age_band,status:a.status,version:a.version,capabilities:Object.freeze({...c})});
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
export function guardianReviewIntent(row,fields,key) {
  if(!uuid(row?.id)||!Number.isSafeInteger(row.revision)||row.revision<1||row.policy_version!==AUDIENCE_POLICY||
     !['under_review'].includes(row.state)||!uuid(row.child_account_id)||!uuid(row.guardian_account_id)||!uuid(key)||
     !Array.isArray(row.requested_purposes)||!row.requested_purposes.length||new Set(row.requested_purposes).size!==row.requested_purposes.length||
     row.requested_purposes.some(p=>!AUDIENCE_PURPOSES.includes(p)))fail('guardian_record_changed');
  const decision=fields.get('decision'),method=fields.get('evidence_method'),reference=fields.get('evidence_reference');
  const adult=fields.get('adult_verified')==='on',responsibility=fields.get('parental_responsibility_verified')==='on';
  if(!['approve','reject'].includes(decision)||!['independent_live_review','independent_document_review'].includes(method)||
     typeof reference!=='string'||!/^[A-Za-z0-9._:-]{16,128}$/.test(reference)||
     (decision==='approve'&&(!adult||!responsibility)))fail('guardian_evidence_required');
  return {path:`/admin/guardian-requests/${row.id}/review`,body:{expected_revision:row.revision,policy_version:AUDIENCE_POLICY,decision,evidence_method:method,
    evidence_reference:reference,adult_verified:adult,parental_responsibility_verified:responsibility,operation_key:key}};
}
export function adultReviewIntent(current,fields,key) {
  if(!current||!uuid(current.accountId)||!['under13','13_17'].includes(current.ageBand)||
     !Number.isSafeInteger(current.version)||current.version<1||!uuid(key))fail('audience_record_changed');
  const method=fields.get('evidence_method'),reference=fields.get('evidence_reference');
  if(!['independent_live_review','independent_document_review'].includes(method)||
     typeof reference!=='string'||!/^[A-Za-z0-9._:-]{16,128}$/.test(reference)||fields.get('adult_verified')!=='on')fail('adult_evidence_required');
  return {path:`/admin/audience/${current.accountId}/adult-review`,body:{expected_version:current.version,policy_version:AUDIENCE_POLICY,
    evidence_method:method,evidence_reference:reference,adult_verified:true,operation_key:key}};
}
