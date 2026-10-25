import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {startHarness,closeHarnesses,enroll,captureProofs,faceVerifierFixture} from './runtime-harness.mjs';
import {AUDIENCE_POLICY,audienceContext,maintainAudience} from '../src/audience.ts';
import {pruneRetainedMetadata} from '../src/retention.ts';
import {flushPrivacyCleanup} from '../src/privacy.ts';
after(closeHarnesses);
const op=()=>crypto.randomUUID(), base=()=>({policy_version:AUDIENCE_POLICY,operation_key:op()});
const declaration=(h,g,band='13_17',version=0)=>h.json('/me/audience',{method:'PUT',token:g.access_token,body:{...base(),age_band:band,expected_version:version}});
async function administrator(h){const a=await enroll(h);await h.db.run('UPDATE accounts SET roles_json=? WHERE id=?','["user","admin"]',a.accountId);const c=await h.json('/auth/face/challenge',{body:{face_handle:a.faceHandle,device_id:a.deviceId}},201),b=await captureProofs(h,c,a.keys.privateKey);return {...a,token:(await h.json('/auth/face/complete',{body:b})).access_token};}
async function family(h){const child=await h.anonymous();await declaration(h,child);const r=(await h.json('/me/guardian-requests',{token:child.access_token,body:{...base(),expected_version:1}},201)).guardian_request;const guardian=await administrator(h),reviewer=await administrator(h);const claim={...base(),expected_revision:1,relationship_attested:true,purposes:['face_authentication']};await h.json(`/guardian-requests/${r.id}/claim`,{token:guardian.token,body:claim});return {child,guardian,reviewer,id:r.id,claim};}
const review=()=>({...base(),expected_revision:2,decision:'approve',evidence_method:'independent_live_review',evidence_reference:'test-review-'+op(),adult_verified:true,parental_responsibility_verified:true});
const approve=(h,f)=>h.json(`/admin/guardian-requests/${f.id}/review`,{token:f.reviewer.token,body:review()});
async function capture(h,child){const keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);const body={device_public_jwk:await crypto.subtle.exportKey('jwk',keys.publicKey),consent:{purpose:'face_authentication',policy_version:'face-policy-fixture-v1',granted:true}};const c=await h.json('/auth/face/registration/challenge',{token:child.access_token,body},201);return {c,b:await captureProofs(h,c,keys.privateKey,{token:child.access_token})};}
const statusToken=()=> 'lvd_'+Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
test('unknown/under13 denied before biometric storage; own privacy and deletion work without self-escalation',async()=>{const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});try{const g=await h.anonymous(),keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']),body={device_public_jwk:await crypto.subtle.exportKey('jwk',keys.publicKey),consent:{purpose:'face_authentication',policy_version:'face-policy-fixture-v1',granted:true}};assert.equal((await h.json('/auth/face/registration/challenge',{token:g.access_token,body},403)).error.code,'audience_required');await declaration(h,g,'under13');assert.equal((await h.json('/auth/face/registration/challenge',{token:g.access_token,body},403)).error.code,'age_not_supported');assert.equal((await h.json('/me/audience',{method:'PUT',token:g.access_token,body:{...base(),age_band:'18_plus',expected_version:1}},409)).error.code,'audience_age_review_required');assert.equal((await h.db.one('SELECT count(*) n FROM auth_challenges')).n,0);assert.equal((await h.db.one('SELECT count(*) n FROM consents')).n,0);await h.json('/me',{token:g.access_token});await h.json('/privacy/center',{token:g.access_token});await h.json('/privacy/account-deletion',{token:g.access_token,body:{operation_key:op(),status_token:statusToken()}},201);}finally{await h.close();}});
test('claim cannot self-review; independent review grants only chosen purpose, no subject consent/media grant',async()=>{const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});try{const f=await family(h);assert.equal((await h.json('/me/audience',{token:f.child.access_token})).capabilities.face_authentication,false);const q=await h.json('/admin/guardian-requests',{token:f.reviewer.token});assert.deepEqual(q.guardian_requests[0].requested_purposes,['face_authentication']);assert.equal(q.guardian_requests[0].evidence_recorded,false);assert.equal((await h.json(`/admin/guardian-requests/${f.id}/review`,{token:f.guardian.token,body:review()},403)).error.code,'guardian_independent_review_required');await approve(h,f);assert.deepEqual((await h.json('/me/audience',{token:f.child.access_token})).capabilities,{face_authentication:true,photo_matching:false,photo_processing:false});assert.equal((await h.db.one('SELECT count(*) n FROM consents WHERE account_id=?',f.child.account_id)).n,0);assert.equal((await h.db.one('SELECT count(*) n FROM media_grants WHERE recipient_id=?',f.child.account_id)).n,0);const {c,b}=await capture(h,f.child);assert.equal(c.audience_authority.protocol,'lovelies-audience-challenge-v1');assert.equal(c.audience_authority.challenge_id,c.challenge_id);assert.equal(c.audience_authority.account_id,f.child.account_id);assert.equal(c.audience_authority.expires_at,c.expires_at);const issued=await h.json('/auth/face/registration/complete',{token:f.child.access_token,body:b});assert.equal((await h.json('/me/photo-preferences',{token:issued.access_token,body:{policy_version:'photo-policy-fixture-v1',processing_consent:true,operation_key:op()}},403)).error.code,'guardian_approval_required');}finally{await h.close();}});
test('withdrawal during verifier await denies publication; replay current state, cross-account denial and status access survive',async()=>{let target,arrive,release;const entered=new Promise(r=>arrive=r),gate=new Promise(r=>release=r);const h=await startHarness({consumeQueue:false,faceVerifier:async(e,f)=>{if(e.account_id===target){arrive();await gate;}return faceVerifierFixture(e,f);}});try{const f=await family(h);await approve(h,f);const {b}=await capture(h,f.child);target=f.child.account_id;const pending=h.request('/auth/face/registration/complete',{token:f.child.access_token,body:b});await entered;await h.json(`/guardian-requests/${f.id}/withdraw`,{token:f.guardian.token,body:{expected_revision:3,operation_key:op()}});release();const res=await pending;assert.equal(res.status,409);assert.equal((await res.json()).error.code,'challenge_unavailable');assert.equal((await h.db.one('SELECT status FROM auth_challenges WHERE id=?',b.challenge_id)).status,'cancelled');assert.equal(await h.db.one('SELECT id FROM face_profiles WHERE account_id=?',target),null);assert.equal((await h.json(`/guardian-requests/${f.id}/claim`,{token:f.guardian.token,body:f.claim})).guardian_request.state,'withdrawn');const foreign=await h.anonymous();await h.json(`/me/guardian-requests/${f.id}`,{token:foreign.access_token},404);await h.json(`/guardian-requests/${f.id}/claim`,{token:f.guardian.token,body:{...f.claim,purposes:['photo_matching']}},409);await h.json('/me',{token:f.child.access_token});await h.json('/privacy/center',{token:f.child.access_token});}finally{release?.();await h.close();}});
test('guardian declaration version change denies child before maintenance and expires old request',async()=>{const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});try{const f=await family(h);await approve(h,f);assert(await audienceContext(h.app,f.child.account_id,'face_authentication'));await declaration(h,{access_token:f.guardian.token},'18_plus',1);assert.equal(await audienceContext(h.app,f.child.account_id,'face_authentication'),null);await maintainAudience(h.app);assert.equal((await h.db.one('SELECT state FROM guardian_requests WHERE id=?',f.id)).state,'expired');}finally{await h.close();}});
test('registered child withdrawal keeps restricted refresh/privacy; exact cleanup waits for writers and confirms absence',async()=>{const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});try{const f=await family(h);await approve(h,f);const {b}=await capture(h,f.child),issued=await h.json('/auth/face/registration/complete',{token:f.child.access_token,body:b}),p=await h.db.one('SELECT * FROM face_profiles WHERE account_id=?',f.child.account_id);await h.json(`/guardian-requests/${f.id}/withdraw`,{token:issued.access_token,body:{expected_revision:3,operation_key:op()}});assert.equal((await h.json('/me/gallery',{token:issued.access_token},403)).error.code,'guardian_approval_required');const renewed=await h.json('/auth/session/refresh',{body:{refresh_token:issued.refresh_token}});await h.json('/me/audience',{token:renewed.access_token});await h.json('/privacy/export',{token:renewed.access_token,body:{operation_key:op()}},201);await h.db.run("INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at) VALUES(?,?,'PHOTOS',?,'pending',?)",op(),f.child.account_id,p.template_key,Date.now());await flushPrivacyCleanup(h.app);assert(await h.env.PHOTOS.head(p.template_key));await h.db.run("UPDATE media_write_intents SET status='settled' WHERE account_id=?",f.child.account_id);await flushPrivacyCleanup(h.app);assert.equal(await h.env.PHOTOS.head(p.template_key),null);assert.equal((await h.db.one('SELECT status FROM cleanup_intents WHERE object_key=?',p.template_key)).status,'verified');}finally{await h.close();}});
test('metadata purge uses class deadlines/holds and never financial rows; valid deletion does not silently expire',async()=>{const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});try{const g=await h.anonymous({adult:true}),now=Date.now(),DAY=86400000;for(const [action,days]of [['diagnostic.sample',8],['security.sample',31],['guardian.withdrawn',366],['guardian.approved',364]])await h.db.run('INSERT INTO audit_events(id,subject_id,action,details_json,created_at) VALUES(?,?,?,?,?)',op(),g.account_id,action,'{}',now-days*DAY);await h.db.run('INSERT INTO financial_records(id,account_id,record_type,data_json,created_at) VALUES(?,?,?,?,?)',op(),g.account_id,'invoice','{}',now-500*DAY);await h.db.run('INSERT INTO moderation_holds(id,subject_id,active,created_at,reason) VALUES(?,?,1,?,?)',op(),g.account_id,now,'fixture hold');await h.db.transaction(()=>pruneRetainedMetadata(h.app));assert.equal((await h.db.one("SELECT count(*) n FROM audit_events WHERE action='diagnostic.sample'")).n,1);await h.db.run('UPDATE moderation_holds SET active=0 WHERE subject_id=?',g.account_id);await h.db.transaction(()=>pruneRetainedMetadata(h.app));const actions=(await h.db.all('SELECT action FROM audit_events')).map(x=>x.action);assert(!actions.includes('diagnostic.sample'));assert(!actions.includes('security.sample'));assert(!actions.includes('guardian.withdrawn'));assert(actions.includes('guardian.approved'));assert.equal((await h.db.one('SELECT count(*) n FROM financial_records')).n,1);const d=await h.json('/privacy/account-deletion',{token:g.access_token,body:{operation_key:op(),status_token:statusToken()}},201);await h.db.run('UPDATE privacy_requests SET expires_at=? WHERE id=?',now-1,d.privacy_request.id);await flushPrivacyCleanup(h.app);assert.equal((await h.db.one('SELECT status FROM privacy_requests WHERE id=?',d.privacy_request.id)).status,'pending_approval');assert.equal((await h.db.one("SELECT audit_days FROM retention_settings WHERE id='default'")).audit_days,30);}finally{await h.close();}});
test('review requires evidence and a fresh actual face login; refresh cannot manufacture it; adulthood transition is independently reviewed',async()=>{
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});try{
  const f=await family(h);
  await h.json(`/admin/guardian-requests/${f.id}/review`,{token:f.reviewer.token,body:{...review(),adult_verified:false}},400);
  const oldProof=await h.db.one("SELECT id,used_at FROM auth_challenges WHERE account_id=? AND purpose='login' AND status='used' ORDER BY used_at DESC LIMIT 1",f.reviewer.accountId);
  await h.db.run('UPDATE auth_challenges SET used_at=? WHERE id=?',Date.now()-360000,oldProof.id);
  const session=await h.db.one('SELECT refresh_hash FROM sessions WHERE id=?',JSON.parse(Buffer.from(f.reviewer.token.split('.')[1],'base64url').toString()).jti);
  assert(session);
  // This is a real refresh of the reviewer's original login session, not a new
  // face comparison. Its newly created session must not satisfy fresh review.
  const challenge=await h.json('/auth/face/challenge',{body:{face_handle:f.reviewer.faceHandle,device_id:f.reviewer.deviceId}},201);
  const completion=await captureProofs(h,challenge,f.reviewer.keys.privateKey),login=await h.json('/auth/face/complete',{body:completion});
  const proof=await h.db.one('SELECT used_at FROM auth_challenges WHERE id=?',challenge.challenge_id);await h.db.run('UPDATE auth_challenges SET used_at=? WHERE id=?',Date.now()-360000,challenge.challenge_id);
  const refreshed=await h.json('/auth/session/refresh',{body:{refresh_token:login.refresh_token}});
  assert.equal((await h.json(`/admin/guardian-requests/${f.id}/review`,{token:refreshed.access_token,body:review()},403)).error.code,'fresh_face_authentication_required');
  await h.db.run('UPDATE auth_challenges SET used_at=? WHERE id=?',proof.used_at,challenge.challenge_id);
  const freshChallenge=await h.json('/auth/face/challenge',{body:{face_handle:f.reviewer.faceHandle,device_id:f.reviewer.deviceId}},201),freshCompletion=await captureProofs(h,freshChallenge,f.reviewer.keys.privateKey),fresh=await h.json('/auth/face/complete',{body:freshCompletion});
  const detail=await h.json('/admin/users/'+f.child.account_id,{token:fresh.access_token});assert.equal(detail.audience.audience.version,1);assert.equal(detail.audience.audience.age_band,'13_17');
  const reviewed=await h.json('/admin/audience/'+f.child.account_id+'/adult-review',{token:fresh.access_token,body:{...base(),expected_version:1,evidence_method:'independent_live_review',evidence_reference:'adult-review-'+op(),adult_verified:true}});
  assert.equal(reviewed.audience.age_band,'18_plus');assert.equal(reviewed.audience.version,2);assert.equal((await h.db.one('SELECT count(*) n FROM consents WHERE account_id=?',f.child.account_id)).n,0);
 }finally{await h.close();}
});

test('retired guardian lineage cannot suspend a reviewed adult through maintenance or repeated withdrawal',async()=>{
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});try{
  const f=await family(h);await approve(h,f);
  const adultBody={...base(),expected_version:1,evidence_method:'independent_live_review',evidence_reference:'adult-lineage-'+op(),adult_verified:true};
  await h.json('/admin/audience/'+f.child.account_id+'/adult-review',{token:f.reviewer.token,body:adultBody});
  const expected=await h.db.one('SELECT * FROM account_audience WHERE account_id=?',f.child.account_id);
  assert.equal(expected.age_band,'18_plus');assert.equal(expected.version,2);assert.equal(expected.status,'eligible');
  const retired=await h.db.one('SELECT * FROM guardian_requests WHERE id=?',f.id);assert.equal(retired.state,'withdrawn');
  await maintainAudience(h.app);
  for(let i=0;i<2;i++)await h.json(`/guardian-requests/${f.id}/withdraw`,{token:f.guardian.token,body:{expected_revision:retired.revision,operation_key:op()}});
  assert.deepEqual(await h.db.one('SELECT * FROM account_audience WHERE account_id=?',f.child.account_id),expected);
  assert(await audienceContext(h.app,f.child.account_id,'face_authentication'));
  assert(Object.values((await h.json(`/me/guardian-requests/${f.id}`,{token:f.guardian.token})).guardian_request.purposes).every(value=>value===false));
 }finally{await h.close();}
});
test('old expired same-version guardian request cannot revoke a replacement pending lineage',async()=>{
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});try{
  const f=await family(h);await approve(h,f);
  await h.db.run('UPDATE guardian_requests SET expires_at=? WHERE id=?',Date.now()-1,f.id);
  const replacement=await h.json('/me/guardian-requests',{token:f.child.access_token,body:{...base(),expected_version:1}},201);
  assert.equal(replacement.audience.audience.version,2,'renewal retires old authority before the new request is bound');
  const version=replacement.audience.audience.version;
  // Represent an older, overlapping same-version row without changing the new
  // current declaration/request. Termination must not act on another lineage.
  await h.db.run("UPDATE guardian_requests SET state='under_review',child_audience_version=?,terminated_at=NULL WHERE id=?",version,f.id);
  const before=await h.db.one('SELECT * FROM account_audience WHERE account_id=?',f.child.account_id);
  await maintainAudience(h.app);
  assert.equal((await h.db.one('SELECT state FROM guardian_requests WHERE id=?',f.id)).state,'expired');
  assert.equal((await h.db.one('SELECT state FROM guardian_requests WHERE id=?',replacement.guardian_request.id)).state,'pending');
  assert.deepEqual(await h.db.one('SELECT * FROM account_audience WHERE account_id=?',f.child.account_id),before);
  // Even an active stale row with that same declaration cannot be used by its
  // old bound guardian to cancel the replacement's current authority.
  await h.db.run("UPDATE guardian_requests SET state='under_review',expires_at=?,terminated_at=NULL WHERE id=?",Date.now()+86400000,f.id);
  const revision=(await h.db.one('SELECT revision FROM guardian_requests WHERE id=?',f.id)).revision;
  await h.json(`/guardian-requests/${f.id}/withdraw`,{token:f.guardian.token,body:{expected_revision:revision,operation_key:op()}});
  assert.deepEqual(await h.db.one('SELECT * FROM account_audience WHERE account_id=?',f.child.account_id),before);
 }finally{await h.close();}
});
test('cached admin guardian and adulthood review replays require current fresh independent operator authority',async()=>{
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});try{
  const f=await family(h),approval=review();
  await h.json(`/admin/guardian-requests/${f.id}/review`,{token:f.reviewer.token,body:approval});
  const transition={...base(),expected_version:1,evidence_method:'independent_live_review',evidence_reference:'replay-adult-'+op(),adult_verified:true};
  await h.json('/admin/audience/'+f.child.account_id+'/adult-review',{token:f.reviewer.token,body:transition});
  const proof=await h.db.one("SELECT id,used_at FROM auth_challenges WHERE account_id=? AND purpose='login' AND status='used' ORDER BY used_at DESC LIMIT 1",f.reviewer.accountId);
  await h.db.run('UPDATE auth_challenges SET used_at=? WHERE id=?',Date.now()-360000,proof.id);
  for(const [path,body]of [[`/admin/guardian-requests/${f.id}/review`,approval],['/admin/audience/'+f.child.account_id+'/adult-review',transition]])assert.equal((await h.json(path,{token:f.reviewer.token,body},403)).error.code,'fresh_face_authentication_required');
  await h.db.run('UPDATE auth_challenges SET used_at=? WHERE id=?',proof.used_at,proof.id);
  await h.db.run('UPDATE accounts SET roles_json=? WHERE id=?','["user"]',f.reviewer.accountId);
  const challenge=await h.json('/auth/face/challenge',{body:{face_handle:f.reviewer.faceHandle,device_id:f.reviewer.deviceId}},201),completion=await captureProofs(h,challenge,f.reviewer.keys.privateKey),currentUser=await h.json('/auth/face/complete',{body:completion});
  for(const [path,body]of [[`/admin/guardian-requests/${f.id}/review`,approval],['/admin/audience/'+f.child.account_id+'/adult-review',transition]])assert.equal((await h.json(path,{token:currentUser.access_token,body},403)).error.code,'admin_required');
 }finally{await h.close();}
});
test('erasure adopts retired exact-key cleanup and resolves duplicate obligations after writer/absence proof without authorizing unknown keys',async()=>{
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});try{
  const person=await enroll(h),operator=await administrator(h),profile=await h.db.one('SELECT * FROM face_profiles WHERE account_id=?',person.accountId);
  const writer=op();await h.db.run("INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at) VALUES(?,?,'PHOTOS',?,'pending',?)",writer,person.accountId,profile.template_key,Date.now());
  const deletion=(await h.json('/privacy/account-deletion',{token:person.token,body:{operation_key:op()}},201)).privacy_request;
  const original=await h.db.one('SELECT * FROM cleanup_intents WHERE request_id IS NULL AND subject_id=? AND object_key=?',person.accountId,profile.template_key);assert(original);
  await h.db.transaction(async()=>{for(let i=0;i<102;i++)await h.db.run("INSERT INTO cleanup_intents(id,subject_id,bucket,object_key,status,created_at) VALUES(?,?,'PHOTOS',?,'pending',?)",op(),person.accountId,profile.template_key,Date.now()-1000-i);});
  const unknownKey='unknown-not-in-erasure-inventory/'+op(),unknownID=op();await h.env.PHOTOS.put(unknownKey,new Uint8Array([1]));await h.db.run("INSERT INTO cleanup_intents(id,subject_id,bucket,object_key,status,created_at) VALUES(?,?,'PHOTOS',?,'pending',?)",unknownID,person.accountId,unknownKey,Date.now()-5000);
  await h.json(`/privacy-requests/${deletion.id}/approve`,{token:operator.token,body:{operation_key:op()}});
  await h.json(`/privacy-requests/${deletion.id}/process`,{token:operator.token,body:{}},503);
  const adopted=await h.db.one('SELECT * FROM cleanup_intents WHERE id=?',original.id);assert.equal(adopted.request_id,deletion.id);assert.notEqual(adopted.status,'verified');assert(await h.env.PHOTOS.head(profile.template_key));
  assert.equal((await h.db.one('SELECT status FROM media_write_intents WHERE id=?',writer)).status,'pending');
  await h.db.run("UPDATE media_write_intents SET status='settled',settled_at=? WHERE id=?",Date.now(),writer);
  const actualHead=h.env.PHOTOS.head.bind(h.env.PHOTOS);let reportPresent=true;h.env.PHOTOS.head=async key=>key===profile.template_key&&reportPresent?{size:1,etag:'unconfirmed'}:actualHead(key);
  await h.json(`/privacy-requests/${deletion.id}/process`,{token:operator.token,body:{}},503);assert.notEqual((await h.db.one('SELECT status FROM cleanup_intents WHERE id=?',original.id)).status,'verified');
  reportPresent=false;const completed=await h.json(`/privacy-requests/${deletion.id}/process`,{token:operator.token,body:{}});assert.equal(completed.privacy_request.status,'completed');assert.equal((await h.db.one('SELECT count(*) n FROM media_write_intents WHERE account_id=?',person.accountId)).n,0);assert.equal((await h.db.one('SELECT count(*) n FROM face_profile_retirements WHERE account_id=?',person.accountId)).n,0);
  await flushPrivacyCleanup(h.app);await flushPrivacyCleanup(h.app);
  assert.equal((await h.db.one("SELECT count(*) n FROM cleanup_intents WHERE subject_id=? AND object_key=? AND status<>'verified'",person.accountId,profile.template_key)).n,0);
  assert.equal(await h.env.PHOTOS.head(profile.template_key),null);assert(await h.env.PHOTOS.head(unknownKey));assert.notEqual((await h.db.one('SELECT status FROM cleanup_intents WHERE id=?',unknownID)).status,'verified');
 }finally{await h.close();}
});
