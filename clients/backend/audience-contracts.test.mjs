import test from 'node:test';
import assert from 'node:assert/strict';
import {AUDIENCE_POLICY,AUDIENCE_RULE,AUDIENCE_DEVICE_PROTOCOL,audienceDecision,audienceDecisionFields,
  audienceRecord,audienceProjection,audienceDeviceStatus,audienceRenewalReceipt} from './audience-contracts.mjs';

const account=crypto.randomUUID(),device=crypto.randomUUID(),nonce=crypto.randomUUID(),now=Date.now();
const known=()=>({at_least_13:true,guardian_required:false,status:'eligible',version:1,policy_version:AUDIENCE_POLICY,
  source:'self_declaration',rule_version:AUDIENCE_RULE,territory:'global',declared_at:new Date(now-1000).toISOString(),next_review_at:new Date(now+86400000).toISOString(),review_required:false});
const projection=()=>({protocol:'lovelies-audience-v2',policy_version:AUDIENCE_POLICY,account_id:account,audience:known(),
  authority_expires_at:new Date(now+60000).toISOString(),
  capabilities:{face_authentication:true,photo_matching:false,photo_processing:false}});
const status=()=>({protocol:AUDIENCE_DEVICE_PROTOCOL,account_id:account,device_id:device,request_nonce:nonce,audience:known(),authority_expires_at:new Date(now+60000).toISOString(),renewal_available:false,guardian_review_available:false,guardian_request:null,next_step:'face_login'});
const binding={accountId:account,deviceId:device,requestNonce:nonce};

test('a neutral range becomes only the minimized decision and has no default',()=>{
  assert.deepEqual(audienceDecision('under13'),{at_least_13:false,guardian_required:false});
  assert.deepEqual(audienceDecision('13_17'),{at_least_13:true,guardian_required:true});
  assert.deepEqual(audienceDecision('18_plus'),{at_least_13:true,guardian_required:false});
  for(const selection of [undefined,null,'',true,'unknown','21_plus'])assert.throws(()=>audienceDecision(selection),{code:'audience_selection_required'});
  for(const decision of [{at_least_13:false,guardian_required:true},{at_least_13:'true',guardian_required:false},
    {at_least_13:true,guardian_required:false,age_band:'18_plus'}])assert.throws(()=>audienceDecisionFields(decision),{code:'audience_decision_invalid'});
});
test('v2 projection refuses legacy age retention, missing metadata and invented decision authority',()=>{
  const current=audienceProjection(projection(),account,now);assert.equal(current.atLeast13,true);assert.equal(current.guardianRequired,false);
  assert(!Object.hasOwn(current,'ageBand'));assert(!JSON.stringify(current).includes('18_plus'));
  for(const patch of [{age_band:'18_plus'},{rule_version:'invented'},{source:'face_age_estimation'},{territory:'precise-location'},
    {declared_at:null},{next_review_at:null},{next_review_at:new Date(now+366*86400000).toISOString()},
    {review_required:true},{guardian_required:'false'},{at_least_13:false}]){
    const value=projection();Object.assign(value.audience,patch);assert.throws(()=>audienceProjection(value,account,now),{code:'audience_response_invalid'});
  }
  const old=projection();old.protocol='lovelies-audience-v1';assert.throws(()=>audienceProjection(old,account,now),{code:'audience_response_invalid'});
});
test('annual expiry cannot retain product capability or become a default adult decision',()=>{
  const value=projection();value.audience={...value.audience,status:'suspended',declared_at:new Date(now-365*86400000).toISOString(),next_review_at:new Date(now).toISOString(),review_required:true};
  assert.throws(()=>audienceProjection(value,account,now),{code:'audience_response_invalid'});
  value.capabilities.face_authentication=false;value.authority_expires_at=null;assert.equal(audienceProjection(value,account,now).reviewRequired,true);
  const unknown={at_least_13:null,guardian_required:null,status:'unknown',version:0,policy_version:null,source:null,rule_version:null,territory:null,declared_at:null,next_review_at:null,review_required:false};
  assert.equal(audienceRecord(unknown,now).atLeast13,null);
  assert.throws(()=>audienceRecord({...unknown,at_least_13:true},now),{code:'audience_response_invalid'});
});
test('signed status is bound to the exact account, device and fresh request nonce and exposes no credentials',()=>{
  assert.equal(audienceDeviceStatus(status(),binding,now).nextStep,'face_login');
  for(const key of ['account_id','device_id','request_nonce']){
    const value=status();value[key]=crypto.randomUUID();assert.throws(()=>audienceDeviceStatus(value,binding,now),{code:'audience_device_response_invalid'});
  }
  for(const key of ['access_token','refresh_token','challenge','capabilities']){
    const value=status();value[key]='not-allowed';assert.throws(()=>audienceDeviceStatus(value,binding,now),{code:'audience_device_response_invalid'});
  }
  const wider=status();wider.guardian_request={id:crypto.randomUUID(),state:'pending',revision:1,policy_version:AUDIENCE_POLICY,expires_at:new Date(now+1000).toISOString(),guardian_account_id:crypto.randomUUID()};
  assert.throws(()=>audienceDeviceStatus(wider,binding,now),{code:'audience_device_response_invalid'});
});
test('a historical renewal receipt cannot substitute for current authority and may precede the current version',()=>{
  const body={expected_version:2,operation_key:crypto.randomUUID()},value={renewal:{operation_key:body.operation_key,from_version:2,to_version:3,next_step:'face_login'}};
  assert.equal(audienceRenewalReceipt(value,body,4).toVersion,3);
  for(const patch of [{operation_key:crypto.randomUUID()},{from_version:1},{to_version:4},{next_step:'authenticated'}]){
    assert.throws(()=>audienceRenewalReceipt({renewal:{...value.renewal,...patch}},body,4),{code:'audience_renewal_response_invalid'});
  }
  assert.throws(()=>audienceRenewalReceipt(value,body,2),{code:'audience_renewal_response_invalid'});
});
test('a child decision retains its own review date while an earlier guardian authority deadline controls capability',()=>{
  const value=projection();value.audience.guardian_required=true;value.authority_expires_at=new Date(now+1000).toISOString();
  const current=audienceProjection(value,account,now);assert.equal(current.nextReviewAt,Date.parse(value.audience.next_review_at));
  assert.equal(current.authorityExpiresAt,now+1000);assert(current.authorityExpiresAt<current.nextReviewAt);
  assert.throws(()=>audienceProjection(value,account,now+1001),{code:'audience_response_invalid'});
  for(const authority of [null,new Date(now-1).toISOString(),new Date(now+2*86400000).toISOString()]){
    assert.throws(()=>audienceProjection({...projection(),authority_expires_at:authority},account,now),{code:'audience_response_invalid'});
  }
});
test('an explicit adult annual-review status has no current product deadline and is never a face-login grant',()=>{
  const value=status();value.audience={...known(),status:'suspended',declared_at:new Date(now-365*86400000).toISOString(),next_review_at:new Date(now).toISOString(),review_required:true};
  Object.assign(value,{authority_expires_at:null,renewal_available:true,next_step:'audience_review',guardian_request:null});
  const current=audienceDeviceStatus(value,binding,now);assert.equal(current.reviewRequired,true);assert.equal(current.authorityExpiresAt,null);assert.equal(current.nextStep,'audience_review');
  assert.throws(()=>audienceDeviceStatus({...value,next_step:'face_login'},binding,now),{code:'audience_device_response_invalid'});
  assert.throws(()=>audienceDeviceStatus({...value,renewal_available:false},binding,now),{code:'audience_device_response_invalid'});
  assert.throws(()=>audienceDeviceStatus({...status(),next_step:'audience_review'},binding,now),{code:'audience_device_response_invalid'});
});
test('guardian review availability is distinct from adult renewal and can precede the child annual deadline',()=>{
  const value={...status(),audience:{...known(),guardian_required:true,status:'guardian_pending'},authority_expires_at:null,
    next_step:'guardian_review',guardian_review_available:true};
  const current=audienceDeviceStatus(value,binding,now);assert.equal(current.reviewRequired,false);
  assert.equal(current.guardianReviewAvailable,true);assert.equal(current.renewalAvailable,false);assert.equal(current.authorityExpiresAt,null);
  for(const patch of [{guardian_review_available:undefined},{renewal_available:true},{next_step:'face_login'},
    {audience:{...value.audience,guardian_required:false,status:'suspended'}}])assert.throws(()=>audienceDeviceStatus({...value,...patch},binding,now),{code:'audience_device_response_invalid'});
  const missing=status();delete missing.guardian_request;assert.throws(()=>audienceDeviceStatus(missing,binding,now),{code:'audience_device_response_invalid'});
});
