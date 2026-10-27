/** Synthetic PGlite/Storage regression. No network, provider or real media. */
import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {delayedFaceStorage} from './face-delayed-storage-fixture.mjs';
import {startHarness,closeHarnesses,faceVerifierFixture,captureProofs,fixturePng,deviceEnvelope,sign,sha256,encode} from './runtime-harness.mjs';
after(closeHarnesses);
const pgliteTest=process.env.TEST_DATABASE_URL?test.skip:test;
const protocol='lovelies-face-enrollment-device-v1',policy='face-policy-fixture-v1';
async function within(promise,ms=15000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('synthetic face fixture deadline')),ms);})]);}finally{clearTimeout(timer);}}
async function started(t){
 assert.equal(process.env.TEST_DATABASE_URL,undefined,'external fixture must not connect to native PostgreSQL');
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});t.after(()=>h.close());
 const anonymous=await h.anonymous({adult:true}),keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const jwk=await crypto.subtle.exportKey('jwk',keys.publicKey),saved={account_id:anonymous.account_id,enrollment_key:crypto.randomUUID(),face_handle:'lfh_'+encode(crypto.getRandomValues(new Uint8Array(32)))};
 const body={...saved,device_public_jwk:jwk,consent:{purpose:'face_authentication',policy_version:policy,granted:true}};
 body.device_signature=await sign(keys.privateKey,{protocol,step:'start',...saved,policy_version:policy,device_public_jwk:jwk});
 const challenge=await h.json('/auth/face/registration/challenge',{token:anonymous.access_token,body},201);
 assert.equal(challenge.required_captures,3);assert.equal(challenge.account_id,saved.account_id);assert(Number.isInteger(challenge.enrollment_generation));
 assert.equal(Number((await h.storage.exec('SELECT count(*) n FROM face_enrollment_intents WHERE account_id=? AND enrollment_key=?',saved.account_id,saved.enrollment_key))[0].n),1,'must exercise durable signed enrollment');
 return {h,anonymous,keys,jwk,saved,challenge};
}
async function signedRecovery(i,step,fields={}){const body={...i.saved,request_nonce:crypto.randomUUID(),request_expires_at:Date.now()+45000,...fields};return {...body,device_signature:await sign(i.keys.privateKey,{protocol,step,...body})};}
async function status(i){const response=await within(i.h.request('/auth/face/registration/recovery',{token:i.anonymous.access_token,body:await signedRecovery(i,'status')}));const body=await response.json();assert.equal(response.status,200,'signed enrollment recovery status must be available');return body;}
async function resume(i){const body=await signedRecovery(i,'resume',{resume_key:crypto.randomUUID(),expected_generation:i.challenge.enrollment_generation,expected_challenge_id:i.challenge.challenge_id});const response=await within(i.h.request('/auth/face/registration/resume',{token:i.anonymous.access_token,body}));const value=await response.json();return {status:response.status,error:value?.error?.code??null};}
async function capture(i,index,seed=crypto.randomUUID()){
 const bytes=fixturePng('synthetic-delayed-face:'+seed),digest=await sha256(bytes),mime='image/png';
 const signature=await sign(i.keys.privateKey,{...deviceEnvelope(i.challenge),step:'capture',capture_index:index,capture_sha256:digest,mime,byte_size:bytes.length});
 const response=await within(i.h.request(`/auth/face/proof/${i.challenge.challenge_id}/${index}`,{token:i.anonymous.access_token,method:'PUT',raw:bytes,headers:{'content-type':mime,'x-lovelies-capture-sha256':digest,'x-lovelies-capture-bytes':String(bytes.length),'x-lovelies-device-signature':signature}}));
 const body=await response.json();return {status:response.status,error:body?.error?.code??null,body,bytes,digest};
}
async function facts(i,bucket,key){const {h,saved,challenge}=i;
 const writers=await h.storage.exec('SELECT id,status FROM media_write_intents WHERE account_id=? AND bucket=? AND object_key=?',saved.account_id,bucket,key);
 const cleanup=await h.storage.exec('SELECT status FROM cleanup_intents WHERE subject_id=? AND bucket=? AND object_key=?',saved.account_id,bucket,key);
 const one=async(sql,...bindings)=>Number((await h.storage.exec(sql,...bindings))[0].n);
 const account=(await h.storage.exec('SELECT identity_state FROM accounts WHERE id=?',saved.account_id))[0];
 return {writerCount:writers.length,writer:writers.length===1?writers[0].status:null,cleanup:cleanup.map(r=>r.status),identity:account?.identity_state??null,
  proofTargetRefs:await one('SELECT count(*) n FROM auth_capture_proofs WHERE challenge_id=? AND object_key=?',challenge.challenge_id,key),
  proofCount:await one('SELECT count(*) n FROM auth_capture_proofs WHERE challenge_id=?',challenge.challenge_id),
  profiles:await one('SELECT count(*) n FROM face_profiles WHERE account_id=?',saved.account_id),
  templateTargetRefs:await one('SELECT count(*) n FROM face_profiles WHERE account_id=? AND template_key=?',saved.account_id,key),
  registeredSessions:await one("SELECT count(*) n FROM sessions WHERE account_id=? AND auth_method='registered_face'",saved.account_id)};
}
function noPublication(violations,value,kind){if(value.profiles||value.registeredSessions||value.identity!=='anonymous'||value.templateTargetRefs||value.proofTargetRefs||kind==='capture'&&value.proofCount!==0)
 violations.push({invariant:'failed_face_write_cannot_publish_proof_profile_or_registered_session',observed:value});}
async function setup(t,kind,mode){const i=await started(t);let completion;
 if(kind==='template')completion=await captureProofs(i.h,i.challenge,i.keys.privateKey,{token:i.anonymous.access_token,seed:'synthetic-template-inputs:'+crypto.randomUUID()});
 const bucket=kind==='capture'?'QUARANTINE':'PHOTOS',memory=i.h.env[bucket],fake=delayedFaceStorage(memory,{bucket:kind==='capture'?'quarantine':'photos',prefix:kind==='capture'?`face-auth/${i.saved.account_id}/${i.challenge.challenge_id}/`:`registered-face/${i.saved.account_id}/`,mode});i.h.env[bucket]=fake.bucket;
 return {...i,bucket,memory,fake,completion};
}
async function attempt(i,kind){if(kind==='capture')return capture(i,0);
 const response=await within(i.h.request('/auth/face/registration/complete',{token:i.anonymous.access_token,body:i.completion}));const body=await response.json();return {status:response.status,error:body?.error?.code??null,body};}

for(const kind of ['capture','template'])pgliteTest(`${kind}: locally rejected signed face write stays pending through cleanup and delayed arrival`,{timeout:45000},async t=>{
 const i=await setup(t,kind,'ambiguous'),{h,fake,bucket}=i;
 try{const reply=await attempt(i,kind);assert.equal(fake.writes.length,1,'real handler must dispatch one target Storage POST');const target=fake.writes[0].key;
  const first=await facts(i,bucket,target);await within(h.alarm());const beforeLate=await facts(i,bucket,target),deletedBeforeLate=fake.events.some(e=>e.kind==='delete'&&e.key===target);
  assert.equal(await h.env[bucket].head(target),null,'the fixture remote write must still be independently held');
  await within(fake.release());assert(await h.env[bucket].head(target),'synthetic remote bytes must actually arrive');
  await within(h.alarm());const late=await facts(i,bucket,target),recovery=await status(i),violations=[];
  if(reply.status<400)violations.push({invariant:'unknown_face_write_must_not_return_success',observed:reply.status});
  for(const [point,value]of [['first',first],['before_late',beforeLate],['late',late]]){if(value.writerCount!==1||value.writer!=='pending')violations.push({invariant:'unknown_face_writer_stays_pending',point,observed:value.writer});if(value.cleanup.includes('verified'))violations.push({invariant:'cleanup_not_verified_for_unknown_face_writer',point,observed:value.cleanup});noPublication(violations,value,kind);}
  if(deletedBeforeLate||fake.events.some(e=>e.kind==='delete'&&e.key===target))violations.push({invariant:'unknown_face_write_never_deleted_or_assumed_absent',observed:true});
  if(recovery.state!=='capture_pending')violations.push({invariant:'signed_recovery_retains_account_writer_fence',observed:recovery.state});
  const dispatches=fake.events.filter(e=>e.kind==='put-dispatched').length;
  if(kind==='capture'){const retried=await capture(i,0);if(retried.status!==409||fake.events.filter(e=>e.kind==='put-dispatched').length!==dispatches)violations.push({invariant:'unknown_capture_blocks_another_capture_dispatch',observed:{status:retried.status,put_count:fake.events.filter(e=>e.kind==='put-dispatched').length}});}
  else{const resumed=await resume(i);if(resumed.status!==409)violations.push({invariant:'unknown_template_blocks_signed_challenge_replacement',observed:resumed});}
  const final=await facts(i,bucket,target);if(final.writer!=='pending')violations.push({invariant:'later_attempt_cannot_clear_original_writer_fence',observed:final.writer});
  if(final.cleanup.includes('verified')||fake.events.some(e=>e.kind==='delete'&&e.key===target)||!await h.env[bucket].head(target))violations.push({invariant:'late_face_bytes_stay_preserved_while_their_writer_is_unknown',observed:{cleanup:final.cleanup,deleted:fake.events.some(e=>e.kind==='delete'&&e.key===target)}});
  noPublication(violations,final,kind);
  assert.deepEqual(violations,[],'a local face Storage rejection is not a terminal remote-write result');
 }finally{await within(fake.release());}
});

for(const kind of ['capture','template'])pgliteTest(`${kind}: acknowledged synthetic signed face write settles and permits intended enrollment progress`,{timeout:45000},async t=>{
 const i=await setup(t,kind,'acknowledged'),reply=await attempt(i,kind);assert.equal(reply.status,200,'acknowledged control must complete its intended stage');assert.equal(i.fake.writes.length,1);
 const target=i.fake.writes[0].key,value=await facts(i,i.bucket,target);assert.equal(value.writerCount,1);assert.equal(value.writer,'settled');assert.equal(i.fake.events.some(e=>e.kind==='delete'&&e.key===target),false);assert(await i.h.env[i.bucket].head(target));
 if(kind==='capture'){assert.equal(value.proofTargetRefs,1);assert.equal(value.proofCount,1);assert.equal(value.profiles,0);assert.equal(value.registeredSessions,0);assert.equal(value.identity,'anonymous');assert.equal(await sha256(await(await i.h.env.QUARANTINE.get(target)).arrayBuffer()),reply.digest);const recovery=await status(i);assert.equal(recovery.state,'pending');assert.equal(recovery.captures.length,1);assert.equal(recovery.captures[0].sha256,reply.digest);}
 else{assert.equal(value.templateTargetRefs,1);assert.equal(value.profiles,1);assert.equal(value.registeredSessions,1);assert.equal(value.identity,'registered_face');const profile=(await i.h.storage.exec('SELECT template_digest,status,auth_enabled FROM face_profiles WHERE account_id=?',i.saved.account_id))[0];assert.equal(profile.status,'active');assert.equal(Number(profile.auth_enabled),1);assert.equal(await sha256(await(await i.h.env.PHOTOS.get(target)).arrayBuffer()),profile.template_digest);assert.equal(reply.body.auth_method,'registered_face');assert.equal((await i.h.json('/me',{token:reply.body.access_token})).authenticated,true);}
});
