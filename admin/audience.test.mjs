import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AUDIENCE_POLICY,audienceProjection,audienceChallenge,guardianReviewIntent,adultReviewIntent} from './audience.mjs';
const account='00000000-0000-4000-8000-000000000001';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const capabilities={face_authentication:true,photo_matching:false,photo_processing:false};
const projection=()=>({protocol:'lovelies-audience-v1',policy_version:AUDIENCE_POLICY,account_id:account,
  audience:{age_band:'18_plus',status:'eligible',version:1,policy_version:AUDIENCE_POLICY},capabilities:{...capabilities}});
test('audience projection binds the account and denies contradictory pending capability',()=>{
  assert.equal(audienceProjection(projection(),account).capabilities.face_authentication,true);
  assert.throws(()=>audienceProjection(projection(),id(2)),{code:'audience_response_invalid'});
  const pending=projection();pending.audience={...pending.audience,age_band:'13_17',status:'guardian_pending'};
  assert.throws(()=>audienceProjection(pending,account),{code:'audience_response_invalid'});
  pending.capabilities.face_authentication=false;
  assert.equal(audienceProjection(pending,account).capabilities.face_authentication,false);
});
test('unknown audience is explicit and cannot default to adulthood or an old policy',()=>{
  const value=projection();value.audience={age_band:'unknown',status:'unknown',version:0,policy_version:null};value.capabilities.face_authentication=false;
  assert.equal(audienceProjection(value,account).ageBand,'unknown');
  value.audience.version=1;assert.throws(()=>audienceProjection(value,account),{code:'audience_response_invalid'});
  const old=projection();old.policy_version='older';assert.throws(()=>audienceProjection(old,account),{code:'audience_response_invalid'});
});
test('returning-device audience proof is challenge and time bound, never a plain approval boolean',()=>{
  const now=Date.now(),expires=new Date(now+60000).toISOString();
  const value={account_id:account,challenge_id:id(2),device_id:id(3),purpose:'login',expires_at:expires};
  value.audience_authority={protocol:'lovelies-audience-challenge-v1',policy_version:AUDIENCE_POLICY,
    ...value,audience_version:2};
  assert.equal(audienceChallenge(value,now),value);
  for(const field of ['account_id','challenge_id','device_id','purpose']){
    const changed=structuredClone(value);changed.audience_authority[field]=field==='purpose'?'registration':id(8);
    assert.throws(()=>audienceChallenge(changed,now),{code:'audience_challenge_invalid'});
  }
  for(const date of [new Date(now-1).toISOString(),new Date(now+60001).toISOString(),'invalid']){
    const changed=structuredClone(value);changed.audience_authority.expires_at=date;
    assert.throws(()=>audienceChallenge(changed,now),{code:'audience_challenge_invalid'});
  }
  const old=structuredClone(value);delete old.audience_authority;
  assert.throws(()=>audienceChallenge(old,now),{code:'audience_challenge_invalid'});
});
test('guardian decision preserves exact request revision, purposes and minimized review reference',()=>{
  const row={id:id(5),child_account_id:account,guardian_account_id:id(6),revision:3,state:'under_review',
    policy_version:AUDIENCE_POLICY,requested_purposes:['face_authentication']};
  const fields=new Map([['decision','approve'],['evidence_method','independent_live_review'],['evidence_reference','review-record-20261024'],
    ['adult_verified','on'],['parental_responsibility_verified','on']]);
  const intent=guardianReviewIntent(row,fields,id(7));
  assert.equal(intent.body.expected_revision,3);assert.equal(intent.path,`/admin/guardian-requests/${id(5)}/review`);
  assert(!Object.hasOwn(intent.body,'purposes'),'The operator cannot widen the guardian’s requested purposes');
  for(const field of ['adult_verified','parental_responsibility_verified']){
    const missing=new Map(fields);missing.delete(field);
    assert.throws(()=>guardianReviewIntent(row,missing,id(7)),{code:'guardian_evidence_required'});
  }
  const sensitive=new Map(fields);sensitive.set('evidence_reference','https://private.example/id');
  assert.throws(()=>guardianReviewIntent(row,sensitive,id(7)),{code:'guardian_evidence_required'});
  assert.throws(()=>guardianReviewIntent({...row,state:'approved'},fields,id(7)),{code:'guardian_record_changed'});
  fields.set('decision','reject');fields.delete('adult_verified');fields.delete('parental_responsibility_verified');
  assert.equal(guardianReviewIntent(row,fields,id(7)).body.decision,'reject');
});
test('adulthood review uses current account version and independently verified minimized evidence',()=>{
  const current={accountId:account,ageBand:'13_17',version:4};
  const fields=new Map([['evidence_method','independent_live_review'],['evidence_reference','age-review-record-20261024'],['adult_verified','on']]);
  const intent=adultReviewIntent(current,fields,id(7));
  assert.equal(intent.path,`/admin/audience/${account}/adult-review`);assert.equal(intent.body.expected_version,4);
  assert.equal(intent.body.adult_verified,true);assert(!Object.hasOwn(intent.body,'purposes'));
  fields.delete('adult_verified');assert.throws(()=>adultReviewIntent(current,fields,id(7)),{code:'adult_evidence_required'});
  fields.set('adult_verified','on');fields.set('evidence_reference','https://private.example/identity');
  assert.throws(()=>adultReviewIntent(current,fields,id(7)),{code:'adult_evidence_required'});
  assert.throws(()=>adultReviewIntent({...current,ageBand:'18_plus'},fields,id(7)),{code:'audience_record_changed'});
});
