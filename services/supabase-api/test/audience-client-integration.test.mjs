import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {startHarness,closeHarnesses,enroll,captureProofs,faceVerifierFixture,fixturePng,sign} from './runtime-harness.mjs';
import {prepareOperation} from '../src/operations.ts';
import {OperatorSession} from '../../../admin/operator-session.mjs';
import {AUDIENCE_POLICY,AUDIENCE_DEVICE_PROTOCOL,audienceDecision,audienceProjection,audienceDeviceStatus,
  audienceRenewalReceipt,audienceChallenge} from '../../../clients/backend/audience-contracts.mjs';

after(closeHarnesses);
const key=()=>crypto.randomUUID(),DAY=86400000;
const harness=()=>startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});
async function declare(h,guest,selection){return h.json('/me/audience',{method:'PUT',token:guest.access_token,
  body:{...audienceDecision(selection),policy_version:AUDIENCE_POLICY,expected_version:0,operation_key:key()}});}
async function due(h,account,ago=1000){const deadline=Date.now()-ago;
  await h.db.run('UPDATE account_audience SET declared_at=?,next_review_at=? WHERE account_id=?',deadline-365*DAY,deadline,account);return deadline;}
async function deviceBody(person,step,extra={}){
  const body={account_id:person.accountId,device_id:person.deviceId,face_handle:person.faceHandle,request_nonce:key(),request_expires_at:Date.now()+45000,...extra};
  return {...body,device_signature:await sign(person.keys.privateKey,{protocol:AUDIENCE_DEVICE_PROTOCOL,step,...body})};
}
const binding=body=>({accountId:body.account_id,deviceId:body.device_id,requestNonce:body.request_nonce});
function operator(h,person,fetchOverride){
  const reference={accountId:person.accountId,deviceId:person.deviceId,faceHandle:person.faceHandle,profileId:person.profile_id,
    profileRevision:person.profile_revision,modelId:person.model_id};
  const vault={value:{reference,anonymous:null,pendingAudience:null,pendingAction:null},async load(){return structuredClone(this.value);},
    async save(value){this.value=structuredClone(value);},sign:payload=>sign(person.keys.privateKey,payload)};
  const fetch=(url,options)=>h.request(new URL(url).pathname,{method:options.method,raw:options.body,headers:options.headers});
  const session=new OperatorSession({baseUrl:'http://localhost',policyVersion:h.env.FACE_AUTH_POLICY_VERSION,vault,
    fetch:fetchOverride?fetchOverride(fetch):fetch});session.state=structuredClone(vault.value);
  return {session,vault,reference,fetch};
}
async function administrator(h){const person=await enroll(h);
  // Controlled fixture provisioning is separate from all client/age operations.
  await h.db.run('UPDATE accounts SET roles_json=? WHERE id=?','["user","admin"]',person.accountId);
  const challenge=await h.json('/auth/face/challenge',{body:{face_handle:person.faceHandle,device_id:person.deviceId}},201);
  const proof=await captureProofs(h,challenge,person.keys.privateKey);
  return {...person,token:(await h.json('/auth/face/complete',{body:proof})).access_token};
}

test('actual unknown and neutral declarations round-trip through the shared v2 parser without retaining raw age bands',async()=>{
  const h=await harness();try{
    const unknown=await h.anonymous(),initial=await h.json('/me/audience',{token:unknown.access_token});
    const parsed=audienceProjection(initial,unknown.account_id);assert.equal(parsed.atLeast13,null);assert.equal(parsed.authorityExpiresAt,null);
    for(const selection of ['under13','13_17','18_plus']){
      const guest=await h.anonymous(),wire=await declare(h,guest,selection),current=audienceProjection(wire,guest.account_id);
      assert.equal(current.atLeast13,selection!=='under13');assert.equal(current.guardianRequired,selection==='13_17');
      assert.equal(current.capabilities.face_authentication,selection==='18_plus');assert(!Object.hasOwn(wire.audience,'age_band'));
      const row=await h.db.one('SELECT age_band,decision_protocol,at_least_13,guardian_required FROM account_audience WHERE account_id=?',guest.account_id);
      assert.equal(row.age_band,null);assert.equal(row.decision_protocol,'decision-v2');
      assert.equal(row.at_least_13,selection==='under13'?0:1);assert.equal(row.guardian_required,selection==='13_17'?1:0);
    }
    assert.equal((await h.db.one('SELECT count(*) n FROM auth_challenges')).n,0);
    assert.equal((await h.db.one('SELECT count(*) n FROM consents')).n,0);
  }finally{await h.close();}
});
test('actual signed expired-adult status opens only explicit annual review, with a null guardian and no product deadline',async()=>{
  const h=await harness();try{
    const person=await enroll(h);await due(h,person.accountId);
    const before=(await h.db.one('SELECT count(*) n FROM auth_challenges WHERE account_id=?',person.accountId)).n;
    const body=await deviceBody(person,'status'),wire=await h.json('/auth/face/audience/status',{body}),current=audienceDeviceStatus(wire,binding(body));
    assert.equal(wire.guardian_request,null);assert.equal(current.nextStep,'audience_review');assert.equal(current.renewalAvailable,true);
    assert.equal(current.reviewRequired,true);assert.equal(current.authorityExpiresAt,null);
    assert(!Object.hasOwn(wire,'access_token'));assert(!Object.hasOwn(wire,'challenge'));assert(!Object.hasOwn(wire,'capabilities'));
    const {session}=operator(h,person);assert.equal(await session.startLogin(),null);assert.equal(session.audienceReview.kind,'device');
    assert.equal(session.challenge,null);assert.equal(session.operator,null);
    assert.equal((await h.db.one('SELECT count(*) n FROM auth_challenges WHERE account_id=?',person.accountId)).n,before);
    assert.equal((await h.db.one('SELECT version FROM account_audience WHERE account_id=?',person.accountId)).version,1);
  }finally{await h.close();}
});
test('actual lost renewal reply replays the stored minimized key with fresh signatures and one new consent before fresh operator login',async()=>{
  const h=await harness();try{
    const person=await administrator(h);await due(h,person.accountId);
    const before=(await h.db.one("SELECT count(*) n FROM consents WHERE account_id=? AND purpose='face_authentication'",person.accountId)).n;
    const sent=[];let lose=true;
    const {session,vault}=operator(h,person,fetch=>async(url,options)=>{
      const response=await fetch(url,options);
      if(url.endsWith('/audience/renew')){sent.push(JSON.parse(options.body));if(lose&&response.ok){lose=false;await response.body.cancel();throw Error('committed_annual_reply_lost');}}
      return response;
    });
    await session.startLogin();await assert.rejects(session.renewOperatorAudience('18_plus',true,true),/committed_annual_reply_lost/);
    const pending=structuredClone(vault.value.pendingAudience);assert(pending);assert(!JSON.stringify(pending).includes('age_band'));assert(!JSON.stringify(pending).includes('18_plus'));
    const restored=new OperatorSession({baseUrl:session.base,policyVersion:h.env.FACE_AUTH_POLICY_VERSION,vault,fetch:session.fetch});await restored.restore();
    const current=await restored.recoverOperatorAudience();assert.equal(current.nextStep,'face_login');assert.equal(restored.state.pendingAudience,null);
    assert.equal(sent.length,2);assert.notEqual(sent[0].request_nonce,sent[1].request_nonce);
    for(const request of sent)for(const [name,value]of Object.entries(pending.body))assert.deepEqual(request[name],value);
    assert.equal((await h.db.one("SELECT count(*) n FROM consents WHERE account_id=? AND purpose='face_authentication'",person.accountId)).n,before+1);
    assert.equal((await h.db.one('SELECT version FROM account_audience WHERE account_id=?',person.accountId)).version,2);
    assert.equal((await h.db.one("SELECT count(*) n FROM consents WHERE account_id=? AND purpose IN('photo_matching','photo_processing') AND status='granted'",person.accountId)).n,0);
    assert.equal(restored.operator,null);assert.equal(restored.credentials,null);assert.equal(restored.challenge,null);
    const oldAccess=await h.request('/admin/metrics',{token:person.token});assert([401,403].includes(oldAccess.status));await oldAccess.body?.cancel();
    await restored.startLogin();assert(restored.challenge);assert.equal(restored.operator,null);
    await restored.useCapture(fixturePng('fresh-operator-after-explicit-annual-review'),'image/png');await restored.complete();
    assert.equal(restored.operator.user_id,person.accountId);assert(restored.operator.roles.includes('admin'));
  }finally{await h.close();}
});
test('actual signed status rejects malformed and cross-account device proofs without creating product authority',async()=>{
  const h=await harness();try{
    const person=await enroll(h),other=await h.anonymous();await due(h,person.accountId);
    const before=(await h.db.one('SELECT count(*) n FROM auth_challenges')).n,body=await deviceBody(person,'status');
    const invalid=[{...body,account_id:other.account_id},{...body,device_id:key()},
      {...body,request_nonce:key()},{...body,request_expires_at:Date.now()-1}];
    for(const attempt of invalid){const response=await h.request('/auth/face/audience/status',{body:attempt});assert([400,401,403,404].includes(response.status));
      const value=await response.json();assert(!Object.hasOwn(value,'audience'));assert(!Object.hasOwn(value,'access_token'));assert(!Object.hasOwn(value,'challenge'));}
    assert.equal((await h.db.one('SELECT count(*) n FROM auth_challenges')).n,before);
    assert.equal((await h.db.one('SELECT count(*) n FROM audience_review_retirements')).n,0);
    assert.equal((await h.db.one('SELECT version FROM account_audience WHERE account_id=?',person.accountId)).version,1);
  }finally{await h.close();}
});
test('actual child authority uses the earliest guardian consent, request, approval and annual deadline without rewriting own review metadata',async()=>{
  const h=await harness();try{
    const child=await h.anonymous();await declare(h,child,'13_17');
    const created=(await h.json('/me/guardian-requests',{token:child.access_token,body:{expected_version:1,policy_version:AUDIENCE_POLICY,operation_key:key()}},201)).guardian_request;
    const guardian=await administrator(h),reviewer=await administrator(h);
    await h.json('/guardian-requests/'+created.id+'/claim',{token:guardian.token,body:{expected_revision:1,policy_version:AUDIENCE_POLICY,
      relationship_attested:true,purposes:['face_authentication'],operation_key:key()}});
    await h.json('/admin/guardian-requests/'+created.id+'/review',{token:reviewer.token,body:{expected_revision:2,policy_version:AUDIENCE_POLICY,
      decision:'approve',evidence_method:'independent_live_review',evidence_reference:'fixture-independent-'+key(),adult_verified:true,parental_responsibility_verified:true,operation_key:key()}});
    const now=Date.now(),auth=(await h.db.one('SELECT auth_consent_id FROM face_profiles WHERE account_id=?',guardian.accountId)).auth_consent_id;
    const own=(await h.db.one('SELECT next_review_at FROM account_audience WHERE account_id=?',child.account_id)).next_review_at;
    await h.db.run('UPDATE consents SET expires_at=? WHERE id=?',now+600000,auth);
    await h.db.run('UPDATE guardian_requests SET expires_at=? WHERE id=?',now+1200000,created.id);
    await h.db.run('UPDATE guardian_purpose_approvals SET expires_at=? WHERE request_id=?',now+1800000,created.id);
    await h.db.run('UPDATE account_audience SET next_review_at=? WHERE account_id=?',now+2400000,guardian.accountId);
    const read=async()=>audienceProjection(await h.json('/me/audience',{token:child.access_token}),child.account_id);
    let current=await read();assert.equal(current.authorityExpiresAt,now+600000);assert.equal(current.nextReviewAt,own);
    await h.db.run('UPDATE consents SET expires_at=? WHERE id=?',now+3600000,auth);current=await read();assert.equal(current.authorityExpiresAt,now+1200000);
    await h.db.run('UPDATE guardian_requests SET expires_at=? WHERE id=?',now+4200000,created.id);current=await read();assert.equal(current.authorityExpiresAt,now+1800000);
    await h.db.run('UPDATE guardian_purpose_approvals SET expires_at=? WHERE request_id=?',now+4800000,created.id);current=await read();assert.equal(current.authorityExpiresAt,now+2400000);assert.equal(current.nextReviewAt,own);
    await due(h,guardian.accountId);current=await read();assert.equal(current.capabilities.face_authentication,false);assert.equal(current.authorityExpiresAt,null);assert.equal(current.nextReviewAt,own);
  }finally{await h.close();}
});
test('actual legacy receipt recovery preserves the old exact key and converts only the returned current projection',async()=>{
  const h=await harness();try{
    const guest=await h.anonymous({adult:true}),body={age_band:'18_plus',policy_version:AUDIENCE_POLICY,expected_version:0,operation_key:key()};
    // Explicit historical receipt fixture: the upgraded endpoint must consume
    // these original bytes rather than perform a new legacy declaration.
    const intent=await prepareOperation('audience.declare',body,'audience');
    await h.db.run('INSERT INTO operations(actor_id,source,operation_key,action,payload_hash,payload_json,response_json,created_at) VALUES(?,?,?,?,?,?,?,?)',
      guest.account_id,intent.source,intent.key,intent.action,intent.hash,intent.payloadJson,JSON.stringify({account_id:guest.account_id}),Date.now());
    const state={reference:null,anonymous:guest,pendingAudience:{accountId:guest.account_id,body}},vault={value:structuredClone(state),async save(value){this.value=structuredClone(value);}};
    const sent=[],session=new OperatorSession({baseUrl:'http://localhost',policyVersion:h.env.FACE_AUTH_POLICY_VERSION,vault,
      fetch:(url,options)=>{sent.push(JSON.parse(options.body));return h.request(new URL(url).pathname,{method:options.method,raw:options.body,headers:options.headers});}});session.state=structuredClone(state);
    const current=await session.recoverOperatorAudience();assert.equal(current.atLeast13,true);assert.equal(current.guardianRequired,false);
    assert.deepEqual(sent,[body]);assert.equal(vault.value.pendingAudience,null);assert.equal((await h.db.one('SELECT version FROM account_audience WHERE account_id=?',guest.account_id)).version,1);
    const missing={...body,operation_key:key()};session.state.pendingAudience={accountId:guest.account_id,body:missing};
    await assert.rejects(session.recoverOperatorAudience(),{code:'audience_upgrade_required',status:409});assert.deepEqual(session.state.pendingAudience.body,missing);
    assert.equal((await h.db.one('SELECT count(*) n FROM operations WHERE actor_id=? AND operation_key=?',guest.account_id,missing.operation_key)).n,0);
  }finally{await h.close();}
});
test('actual review beyond the bounded reference window returns profile recovery and never recreates a profile or session',async()=>{
  const h=await harness();try{
    const person=await enroll(h);await due(h,person.accountId,2*DAY);
    const before=(await h.db.one('SELECT count(*) n FROM consents WHERE account_id=?',person.accountId)).n;
    const {session}=operator(h,person),reference=session.state.reference;await session.startLogin();
    const current=await session.renewOperatorAudience('18_plus',true,true);
    assert.equal(current.nextStep,'profile_recovery');assert.equal(current.reviewRequired,false);assert(current.authorityExpiresAt>Date.now());
    assert.equal(session.audienceReview.kind,'profile-recovery');assert.equal(session.state.reference,reference);assert.equal(session.state.audienceRecovery.nextStep,'profile_recovery');
    assert.equal(session.operator,null);assert.equal(session.credentials,null);assert.equal(session.challenge,null);assert.equal(session.state.pendingAudience,null);
    assert.equal((await h.db.one('SELECT count(*) n FROM consents WHERE account_id=?',person.accountId)).n,before);
    assert.equal((await h.db.one('SELECT auth_enabled FROM face_profiles WHERE account_id=?',person.accountId)).auth_enabled,0);
  }finally{await h.close();}
});
test('actual pending enrollment crosses annual review with its original account and resume key after fresh explicit consent',async()=>{
  const h=await harness();try{
    const guest=await h.anonymous({adult:true}),keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
    const exported=await crypto.subtle.exportKey('jwk',keys.publicKey),devicePublicJwk={kty:'EC',crv:'P-256',x:exported.x,y:exported.y,ext:true,key_ops:['verify']};
    const vault={value:{reference:null,enrollment:null,anonymous:guest,pendingAudience:null,devicePublicJwk},
      async load(){return structuredClone(this.value);},async save(value){this.value=structuredClone(value);},sign:payload=>sign(keys.privateKey,payload)};
    let loseResume=false;const resumeRequests=[];
    const fetch=async(url,options)=>{
      const path=new URL(url).pathname;if(path.endsWith('/registration/resume'))resumeRequests.push(JSON.parse(options.body));
      const response=await h.request(path,{method:options.method,raw:options.body,headers:options.headers});
      if(path.endsWith('/registration/resume')&&response.ok&&loseResume){loseResume=false;await response.body.cancel();throw Error('committed_resume_reply_lost');}
      return response;
    };
    const make=()=>new OperatorSession({baseUrl:'http://localhost',policyVersion:h.env.FACE_AUTH_POLICY_VERSION,vault,fetch});
    const session=make();await session.restore();await session.startEnrollment(true,'18_plus',true);
    const original=session.state.enrollment,originalChallenge=original.challenge.challenge_id;
    const originalConsent=(await h.db.one('SELECT consent_id FROM face_enrollment_intents WHERE account_id=?',guest.account_id)).consent_id;
    await due(h,guest.account_id);
    await assert.rejects(session.restartEnrollment(),{code:'audience_restricted',status:403});
    const originalResume=structuredClone(session.state.enrollment.resume);assert(originalResume.session_prepared);
    assert.equal(await session.declareOperatorAudience(),null);assert.equal(session.audienceReview.kind,'anonymous');
    assert.equal(session.challenge,null);assert.equal(session.operator,null);
    await session.renewOperatorAudience('18_plus',true,true);
    assert.equal(session.challenge,null);assert.equal(session.state.enrollment.enrollment_key,original.enrollment_key);
    assert.deepEqual(session.state.enrollment.resume,originalResume);
    loseResume=true;await assert.rejects(session.restartEnrollment(),/committed_resume_reply_lost/);
    const restored=make();await restored.restore();await restored.restartEnrollment();
    assert.equal(restored.challenge.account_id,guest.account_id);assert.equal(restored.challenge.purpose,'registration');
    assert.equal(restored.challenge.device_id,original.challenge.device_id);assert.notEqual(restored.challenge.challenge_id,originalChallenge);
    assert.equal(restored.state.enrollment.enrollment_key,original.enrollment_key);assert.equal(restored.state.enrollment.resume,null);
    for(const request of resumeRequests){assert.equal(request.enrollment_key,original.enrollment_key);assert.equal(request.resume_key,originalResume.resume_key);}
    assert.equal(new Set(resumeRequests.map(request=>request.request_nonce)).size,resumeRequests.length);
    const row=await h.db.one('SELECT consent_id,generation FROM face_enrollment_intents WHERE account_id=?',guest.account_id);
    assert.notEqual(row.consent_id,originalConsent);assert.equal(row.generation,originalResume.expected_generation+1);
    assert.equal((await h.db.one('SELECT status FROM consents WHERE id=?',originalConsent)).status,'revoked');
    assert.equal((await h.db.one("SELECT count(*) n FROM consents WHERE account_id=? AND purpose='face_authentication'",guest.account_id)).n,2);
    assert.equal((await h.db.one('SELECT count(*) n FROM accounts')).n,1);assert.equal((await h.db.one('SELECT count(*) n FROM face_profiles')).n,0);
    assert.equal(restored.operator,null);assert.equal(restored.credentials,null);
  }finally{await h.close();}
});
