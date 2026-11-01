const fail=code=>{throw Object.assign(new Error(code),{code});};
import {AUDIENCE_POLICY,AUDIENCE_PURPOSES} from '../clients/backend/audience-contracts.mjs';
export {AUDIENCE_POLICY,AUDIENCE_PURPOSES,AUDIENCE_RULE,AUDIENCE_PROTOCOL,AUDIENCE_DEVICE_PROTOCOL,
  audienceDecision,audienceDecisionFields,audienceRecord,audienceProjection,audienceDeviceStatus,audienceRenewalReceipt,audienceChallenge} from '../clients/backend/audience-contracts.mjs';
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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
  if(!current||!uuid(current.accountId)||!(current.atLeast13===false||current.guardianRequired===true)||
     !Number.isSafeInteger(current.version)||current.version<1||!uuid(key))fail('audience_record_changed');
  const method=fields.get('evidence_method'),reference=fields.get('evidence_reference');
  if(!['independent_live_review','independent_document_review'].includes(method)||
     typeof reference!=='string'||!/^[A-Za-z0-9._:-]{16,128}$/.test(reference)||fields.get('adult_verified')!=='on')fail('adult_evidence_required');
  return {path:`/admin/audience/${current.accountId}/adult-review`,body:{expected_version:current.version,policy_version:AUDIENCE_POLICY,
    evidence_method:method,evidence_reference:reference,adult_verified:true,operation_key:key}};
}
