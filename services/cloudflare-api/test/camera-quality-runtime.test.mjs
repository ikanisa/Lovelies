import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startHarness,faceVerifierFixture,prepareEnrollment,enroll,captureProofs} from './runtime-harness.mjs';

// Actual workerd/SQLite/R2; negative private model fixtures prove protocol only.
const codes=['no_face','multiple_faces','quality_low','invalid_image'];
function rejected(value,code='no_face',index=0){
 delete value.registered_reference;delete value.pose_evidence;
 return {...value,identity_verified:false,...(value.enrollment_verified!==undefined?{enrollment_verified:false}:{}),
  ...(value.reference_match!==undefined?{reference_match:false}:{}),capture_rejection:{code,capture_index:index}};
}
async function harness(t,verifier){
 const h=await startHarness({faceVerifier:verifier,consumeQueue:false}),close=h.close;
 let closing;h.close=()=>closing??=close(); // Explicit loop cleanup and after-hook share one disposal.
 t.after(()=>h.close());return h;
}
const count=async(h,table,where='',...values)=>(await h.storage.exec('SELECT count(*) n FROM '+table+' '+where,...values))[0].n;

for(const code of codes)test('camera '+code+' returns bounded422, retires exact proofs and keeps the original anonymous account',async t=>{
 const h=await harness(t,async(e,f)=>rejected(await faceVerifierFixture(e,f),code,1));
 const p=await prepareEnrollment(h);
 const result=await h.json('/auth/face/registration/complete',{token:p.anonymous.access_token,body:p.completion},422);
 assert.deepEqual(result,{error:{code:'face_capture_'+code}});
 assert.equal((await h.json('/me',{token:p.anonymous.access_token})).user_id,p.anonymous.account_id);
 assert.equal(await count(h,'face_profiles'),0);assert.equal(await count(h,'sessions',"WHERE auth_method='registered_face'"),0);
 assert.equal((await h.storage.exec('SELECT status FROM auth_challenges WHERE id=?',p.challenge.challenge_id))[0].status,'failed');
 assert.equal(await count(h,'auth_capture_proofs','WHERE challenge_id=?',p.challenge.challenge_id),0);
 assert.equal((await(await h.mf.getR2Bucket('QUARANTINE')).list()).objects.length,0);
 await h.json('/auth/face/registration/complete',{token:p.anonymous.access_token,body:p.completion},409);
});

test('ordinary fresh-login quality rejection preserves registered profile and other valid session authority',async t=>{
 let reject=false;
 const h=await harness(t,async(e,f)=>{const value=await faceVerifierFixture(e,f);return reject?rejected(value,'quality_low'):value;});
 const person=await enroll(h),before=(await h.storage.exec('SELECT * FROM face_profiles WHERE account_id=?',person.accountId))[0];
 reject=true;
 const challenge=await h.json('/auth/face/challenge',{body:{face_handle:person.faceHandle,device_id:person.deviceId}},201);
 const result=await h.json('/auth/face/complete',{body:await captureProofs(h,challenge,person.keys.privateKey)},422);
 assert.deepEqual(result,{error:{code:'face_capture_quality_low'}});
 assert.deepEqual((await h.storage.exec('SELECT * FROM face_profiles WHERE account_id=?',person.accountId))[0],before);
 assert.equal((await h.json('/me',{token:person.token})).user_id,person.accountId);
 assert.equal(await count(h,'auth_capture_proofs','WHERE challenge_id=?',challenge.challenge_id),0);
 reject=false;
 const fresh=await h.json('/auth/face/challenge',{body:{face_handle:person.faceHandle,device_id:person.deviceId}},201);
 assert.notEqual(fresh.challenge_id,challenge.challenge_id);
 const signedIn=await h.json('/auth/face/complete',{body:await captureProofs(h,fresh,person.keys.privateKey)});
 assert.equal(signedIn.account_id,person.accountId);assert.equal(signedIn.device_id,person.deviceId);
});

test('core rejects malformed or contradictory private quality reports after validating exact challenge binding',async t=>{
 const mutations=[
  value=>value.capture_rejection=null,value=>value.capture_rejection=[],value=>value.capture_rejection='no_face',
  value=>value.capture_rejection.code='secret-reference',value=>value.capture_rejection.capture_index=-1,
  value=>value.capture_rejection.capture_index=3,value=>value.capture_rejection.capture_index=true,
  value=>value.capture_rejection.capture_index='0',value=>value.capture_rejection.capture_index=0.5,
  value=>delete value.capture_rejection.capture_index,value=>value.capture_rejection.score=.1,
  value=>value.identity_verified=true,value=>value.reference_match=true,value=>value.enrollment_verified=true,
  value=>value.reference_match='true',value=>value.enrollment_verified=1,
  value=>value.registered_reference=null,value=>value.template_base64='SECRET',value=>value.template_sha256='a'.repeat(64),
  value=>value.account_id=crypto.randomUUID(),value=>value.capture_manifest[0].sha256='a'.repeat(64),
 ];
 for(const mutate of mutations){
  const h=await harness(t,async(e,f)=>{const value=rejected(await faceVerifierFixture(e,f));mutate(value);return value;});
  const p=await prepareEnrollment(h);const response=await h.json('/auth/face/registration/complete',{token:p.anonymous.access_token,body:p.completion},503);
  assert.deepEqual(response,{error:{code:'face_verdict_invalid'}});assert.equal(await count(h,'face_profiles'),0);
  assert.equal(await count(h,'sessions',"WHERE auth_method='registered_face'"),0);
  // Three bounded provider retries still cannot turn a malformed verdict into authority.
  await h.close();
 }
});
