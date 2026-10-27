import assert from 'node:assert/strict';
import {test} from 'node:test';
import {encodeGeneration,selectedGeneration} from '../src/inference-generation.ts';
import {processPhotoJob} from '../src/processing.ts';
import {flushPrivacyCleanup} from '../src/privacy.ts';
import {startHarness,prepareEnrollment,enroll,captureProofs,faceVerifierFixture,fixturePng,stable} from './runtime-harness.mjs';
import {INFERENCE_ENGINE_SPACE} from '../src/inference-contract.ts';

// Controlled transport/authority proof with synthetic stills/verdicts. These
// tests never establish real recognition, native-device, hosted or release proof.
const first=encodeGeneration({engine_space:INFERENCE_ENGINE_SPACE,engine_artifact_sha256:'a'.repeat(64),processing_fingerprint:'b'.repeat(64)});
const next=encodeGeneration({engine_space:INFERENCE_ENGINE_SPACE,engine_artifact_sha256:'c'.repeat(64),processing_fingerprint:'d'.repeat(64)});
const key=()=>crypto.randomUUID();
async function harness(t,options={}){
  const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false,...options,
    vars:{INFERENCE_ENGINE_IDENTITY:first,...options.vars}});
  t.after(()=>h.close());return h;
}
const count=async(h,table,where='',...bindings)=>(await h.storage.exec(`SELECT COUNT(*) n FROM ${table} ${where}`,...bindings))[0].n;
async function noAuthentication(h,pending){
  const account=(await h.storage.exec('SELECT identity_state FROM accounts WHERE id=?',pending.anonymous.account_id))[0];
  assert.equal(account.identity_state,'anonymous');
  assert.equal(await count(h,'face_profiles','WHERE account_id=?',pending.anonymous.account_id),0);
  assert.equal(await count(h,'sessions',"WHERE account_id=? AND auth_method='registered_face'",pending.anonymous.account_id),0);
  assert.equal((await h.json('/me',{token:pending.anonymous.access_token})).user_id,pending.anonymous.account_id);
}
async function preferences(h,person,matching=true){
  return h.json('/me/photo-preferences',{token:person.token,body:{policy_version:h.env.PHOTO_CONSENT_POLICY_VERSION,
    receive_matches:matching,photo_matching_consent:matching,processing_consent:true,operation_key:key()}});
}
async function queuedPhoto(h,owner){
  const bytes=fixturePng(key()),reserved=await h.json('/uploads/session',{token:owner.token,body:{source:'personal',
    content_type:'image/png',byte_size:bytes.length,title:'Synthetic generation-bound fixture',operation_key:key()}},201);
  await h.json(reserved.upload_url,{method:'PUT',token:owner.token,raw:bytes,headers:{'content-type':'image/png'}});
  const completion=await h.json(reserved.complete_url,{token:owner.token,body:{operation_key:key()}},202);
  const attempt=(await h.storage.exec('SELECT * FROM processing_attempts WHERE id=?',completion.attempt_id))[0];
  assert.equal(attempt.engine_identity,selectedGeneration(h.env));
  return {...reserved,attempt};
}
function processed(input){
  return {attempt_id:input.attempt_id,nonce:input.nonce,asset_id:input.asset_id,source_version:input.source_version,
    source_checksum_sha256:input.source_checksum_sha256,model_version:input.model_version,engine_identity:input.engine_identity,
    preview:{bytes_base64:Buffer.from(fixturePng('preview:'+input.asset_id)).toString('base64'),content_type:'image/png',width:1,height:1},
    matches:input.profiles.map(profile=>({recipient_id:profile.account_id,profile_id:profile.profile_id,profile_version:profile.revision,model_version:profile.model_id}))};
}
async function noPublication(h,item,code){
  const state=(await h.storage.exec('SELECT status,error_code,engine_identity FROM processing_attempts WHERE id=?',item.attempt.id))[0];
  assert.equal(state.status,'failed');assert.equal(state.error_code,code);
  for(const table of ['candidates','match_origins','renditions','media_grants'])
    assert.equal(await count(h,table,'WHERE asset_id=?',item.asset_id),0,table+' must not publish a stale or unbound result');
  assert(![...h.env.PHOTOS.rows.keys()].some(value=>value.startsWith('preview/')&&value.includes('/'+item.asset_id+'/')));
}
const references=h=>h.storage.exec('SELECT account_id,id,revision,model_id,template_key,template_digest FROM face_profiles ORDER BY account_id');
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
async function arrived(gate){let timer;try{await Promise.race([gate.promise,new Promise((_,fail)=>{
  timer=setTimeout(()=>fail(new Error('controlled private transport was not reached')),6000);
})]);}finally{clearTimeout(timer);}}
function streamedFailure(body,{status=409,type='application/json',redirected=false,beforeSecondChunk}={}){
  const data=typeof body==='string'?new TextEncoder().encode(body):new Uint8Array(body);
  const middle=Math.max(1,Math.floor(data.length/2)),chunks=[data.slice(0,middle),data.slice(middle)].filter(chunk=>chunk.length);
  const state={delivered:[],cancelled:false};let index=0;
  const response=new Response(new ReadableStream({async pull(controller){
    if(index===chunks.length){controller.close();return;}
    if(index===1)await beforeSecondChunk?.();
    const chunk=chunks[index++];state.delivered.push(chunk);controller.enqueue(chunk);
  },cancel(){state.cancelled=true;for(const chunk of chunks.slice(index))chunk.fill(0);}}, {highWaterMark:0}),
  {status,headers:{'content-type':type}});
  if(redirected)Object.defineProperty(response,'redirected',{value:true});
  return {response,state};
}

test('first enrollment preserves its original account/device and denies switched or legacy-unbound challenge generations before inference',async t=>{
  let calls=0;const h=await harness(t,{faceVerifier:async(e,f)=>{calls++;return faceVerifierFixture(e,f);}});
  for(const change of ['configuration','legacy-null','durable-other']){
    h.env.INFERENCE_ENGINE_IDENTITY=first;
    const pending=await prepareEnrollment(h),row=(await h.storage.exec('SELECT * FROM auth_challenges WHERE id=?',pending.challenge.challenge_id))[0];
    assert.equal(row.engine_identity,first);assert(!Object.hasOwn(pending.challenge,'engine_identity'));
    if(change==='configuration')h.env.INFERENCE_ENGINE_IDENTITY=next;
    else await h.storage.exec('UPDATE auth_challenges SET engine_identity=? WHERE id=?',change==='legacy-null'?null:next,row.id);
    const response=await h.json('/auth/face/registration/complete',{token:pending.anonymous.access_token,body:pending.completion},409);
    assert.deepEqual(response,{error:{code:'inference_generation_changed'}});await noAuthentication(h,pending);
    const current=(await h.storage.exec('SELECT device_id,nonce,engine_identity FROM auth_challenges WHERE id=?',row.id))[0];
    assert.equal(current.device_id,row.device_id);assert.equal(current.nonce,row.nonce);
    assert.equal(current.engine_identity,change==='legacy-null'?null:change==='durable-other'?next:first);
  }
  assert.equal(calls,0);
});

test('missing or wrong private verdict generation cannot enroll; valid retry retains the exact signed operation',async t=>{
  let mode='missing',calls=0;
  const h=await harness(t,{faceVerifier:async(e,f)=>{
    calls++;assert.equal(e.engine_identity,first);const verdict=await faceVerifierFixture(e,f);
    if(mode==='missing')delete verdict.engine_identity;
    if(mode==='wrong')verdict.engine_identity=next;
    if(mode==='object')verdict.engine_identity=JSON.parse(first);
    return verdict;
  }});
  for(const invalid of ['missing','wrong','object']){
    mode=invalid;const pending=await prepareEnrollment(h);
    const denied=await h.json('/auth/face/registration/complete',{token:pending.anonymous.access_token,body:pending.completion},503);
    assert.deepEqual(denied,{error:{code:'face_verdict_invalid'}});await noAuthentication(h,pending);
    assert.equal((await h.storage.exec('SELECT engine_identity FROM auth_challenges WHERE id=?',pending.challenge.challenge_id))[0].engine_identity,first);
    mode='valid';const accepted=await h.json('/auth/face/registration/complete',{token:pending.anonymous.access_token,body:pending.completion});
    assert.equal(accepted.account_id,pending.anonymous.account_id);assert.equal(accepted.device_id,pending.challenge.device_id);
    assert.equal(accepted.auth_method,'registered_face');assert(!Object.hasOwn(accepted,'engine_identity'));
  }
  assert.equal(calls,6);
});

test('configuration change during private face verification cannot publish a reference or mint a registered session',async t=>{
  let h,calls=0;
  h=await harness(t,{faceVerifier:async(e,f)=>{calls++;const verdict=await faceVerifierFixture(e,f);
    h.env.INFERENCE_ENGINE_IDENTITY=next;return verdict;}});
  const pending=await prepareEnrollment(h),before=(await h.storage.exec('SELECT auth_epoch FROM accounts WHERE id=?',pending.anonymous.account_id))[0];
  const denied=await h.json('/auth/face/registration/complete',{token:pending.anonymous.access_token,body:pending.completion},409);
  assert.deepEqual(denied,{error:{code:'inference_generation_changed'}});assert.equal(calls,1);
  await noAuthentication(h,pending);
  assert.deepEqual((await h.storage.exec('SELECT auth_epoch FROM accounts WHERE id=?',pending.anonymous.account_id))[0],before);
  assert.equal((await h.storage.exec('SELECT engine_identity FROM auth_challenges WHERE id=?',pending.challenge.challenge_id))[0].engine_identity,first);
  assert.equal(h.env.PHOTOS.rows.size,0);
});

test('only exact bounded private generation/reference-space failures cross the face boundary and never rewrite the retained reference',async t=>{
  const h=await harness(t),person=await enroll(h),before=await references(h);let retry;
  for(const code of ['registered_reference_space_incompatible','inference_generation_changed','unknown_private_failure']){
    h.env.FACE_AUTH_VERIFIER={fetch:async()=>Response.json({error:{code}},{status:409})};
    const challenge=await h.json('/auth/face/challenge',{body:{face_handle:person.faceHandle,device_id:person.deviceId}},201);
    const proof=await captureProofs(h,challenge,person.keys.privateKey);
    const denied=await h.json('/auth/face/complete',{body:proof},code==='unknown_private_failure'?503:409);
    assert.deepEqual(denied,{error:{code:code==='unknown_private_failure'?'face_verifier_unavailable':code}});
    assert.deepEqual(await references(h),before);
    if(code==='unknown_private_failure')retry={challenge,proof};
  }
  let index=0;for(const body of [JSON.stringify({error:{code:'registered_reference_space_incompatible',extra:'private'}}),
    '{"error":{"code":"unknown","code":"registered_reference_space_incompatible"}}','x'.repeat(1025)]){
    h.env.FACE_AUTH_VERIFIER={fetch:async()=>new Response(body,{status:409,headers:{'content-type':'application/json'}})};
    let proof;
    if(index++<2)proof=retry.proof;
    else{
      const challenge=await h.json('/auth/face/challenge',{body:{face_handle:person.faceHandle,device_id:person.deviceId}},201);
      proof=await captureProofs(h,challenge,person.keys.privateKey);
    }
    const denied=await h.json('/auth/face/complete',{body:proof},503);
    assert.deepEqual(denied,{error:{code:'face_verifier_unavailable'}});assert.deepEqual(await references(h),before);
  }
});

test('queued photo attempts reject switched or null generations without dispatch or publication',async t=>{
  let calls=0;const h=await harness(t,{photoProcessor:input=>{calls++;return processed(input);}}),owner=await enroll(h);
  await preferences(h,owner);
  for(const change of ['configuration','legacy-null']){
    h.env.INFERENCE_ENGINE_IDENTITY=first;const item=await queuedPhoto(h,owner);
    if(change==='configuration')h.env.INFERENCE_ENGINE_IDENTITY=next;
    else await h.storage.exec('UPDATE processing_attempts SET engine_identity=NULL WHERE id=?',item.attempt.id);
    await processPhotoJob({attempt_id:item.attempt.id},h.app);
    await noPublication(h,item,'inference_generation_changed');
    assert.equal((await h.storage.exec('SELECT engine_identity FROM processing_attempts WHERE id=?',item.attempt.id))[0].engine_identity,
      change==='legacy-null'?null:first);
  }
  assert.equal(calls,0);
});

test('exact bounded photo adapter409 failures retain their terminal code with no publication or reference relabelling',async t=>{
  const h=await harness(t,{photoProcessor:processed}),owner=await enroll(h),recipient=await enroll(h);
  for(const person of [owner,recipient])await preferences(h,person);
  const before=await references(h);let calls=0;
  for(const code of ['registered_reference_space_incompatible','inference_generation_changed']){
    const item=await queuedPhoto(h,owner),failure=streamedFailure(JSON.stringify({error:{code}}));
    h.env.PHOTO_PROCESSOR={fetch:async request=>{
      calls++;assert.equal((await request.json()).engine_identity,first);return failure.response;
    }};
    await assert.rejects(processPhotoJob({attempt_id:item.attempt.id},h.app),error=>error?.status===409&&error?.code===code);
    await noPublication(h,item,code);assert.deepEqual(await references(h),before);
    assert.equal(failure.state.delivered.length,2);
    assert(failure.state.delivered.every(chunk=>chunk.every(byte=>byte===0)),'consumed private failure buffers are zeroed');
    const terminal=(await h.storage.exec('SELECT engine_identity FROM processing_attempts WHERE id=?',item.attempt.id))[0];
    assert.equal(terminal.engine_identity,first);
    await processPhotoJob({attempt_id:item.attempt.id},h.app);
    await noPublication(h,item,code);
  }
  assert.equal(calls,2,'retrying a terminal incompatible attempt cannot redispatch it');
});

test('arbitrary, malformed, oversized, redirected or status-mismatched photo failures remain generic503',async t=>{
  const h=await harness(t,{photoProcessor:processed}),owner=await enroll(h);await preferences(h,owner);const before=await references(h);
  const known=JSON.stringify({error:{code:'registered_reference_space_incompatible'}});
  const cases=[
    {body:JSON.stringify({error:{code:'unknown_private_failure'}})},
    {body:JSON.stringify({error:{code:'inference_generation_unavailable'}})},
    {body:JSON.stringify({error:{code:'registered_reference_space_incompatible',extra:'private'}})},
    {body:'{"error":{"code":"unknown","code":"registered_reference_space_incompatible"}}'},
    {body:'{"error":'},
    {body:new Uint8Array([255,254])},
    {body:'x'.repeat(1025)},
    {body:known,type:'text/plain'},
    {body:known,redirected:true},
    ...[400,401,403,503].map(status=>({body:known,status})),
  ];
  for(const fixture of cases){
    const item=await queuedPhoto(h,owner),failure=streamedFailure(fixture.body,fixture);
    h.env.PHOTO_PROCESSOR={fetch:async()=>failure.response};
    await assert.rejects(processPhotoJob({attempt_id:item.attempt.id},h.app),error=>error?.status===503&&error?.code==='photo_processing_unavailable');
    await noPublication(h,item,'photo_processing_unavailable');assert.deepEqual(await references(h),before);
    assert(failure.state.delivered.every(chunk=>chunk.every(byte=>byte===0)),'rejected private failure buffers are zeroed');
  }
  const item=await queuedPhoto(h,owner);
  h.env.PHOTO_PROCESSOR={fetch:async()=>new Response(new ReadableStream({start(controller){
    controller.error(new Error('synthetic private response read failure'));
  }}),{status:409,headers:{'content-type':'application/json'}})};
  await assert.rejects(processPhotoJob({attempt_id:item.attempt.id},h.app),error=>error?.status===503&&error?.code==='photo_processing_unavailable');
  await noPublication(h,item,'photo_processing_unavailable');assert.deepEqual(await references(h),before);
});

test('current generation and session authority outrank a known photo failure when its bounded body is still arriving',async t=>{
  const h=await harness(t,{photoProcessor:processed}),owner=await enroll(h);await preferences(h,owner);const before=await references(h);
  for(const [change,status,code] of [['generation',409,'inference_generation_changed'],
    ['unavailable',503,'inference_generation_unavailable'],['session',401,'session_invalid']]){
    h.env.INFERENCE_ENGINE_IDENTITY=first;const item=await queuedPhoto(h,owner);
    const failure=streamedFailure(JSON.stringify({error:{code:'registered_reference_space_incompatible'}}),{
      beforeSecondChunk:async()=>{
        if(change==='generation')h.env.INFERENCE_ENGINE_IDENTITY=next;
        else if(change==='unavailable')delete h.env.INFERENCE_ENGINE_IDENTITY;
        else await h.storage.exec('UPDATE sessions SET revoked_at=? WHERE id=?',Date.now(),item.attempt.owner_session_id);
      },
    });
    h.env.PHOTO_PROCESSOR={fetch:async()=>failure.response};
    await assert.rejects(processPhotoJob({attempt_id:item.attempt.id},h.app),error=>error?.status===status&&error?.code===code);
    await noPublication(h,item,code);assert.deepEqual(await references(h),before);
    assert.equal(failure.state.delivered.length,2,'authority changes during body consumption');
    assert(failure.state.delivered.every(chunk=>chunk.every(byte=>byte===0)),'authority rejection zeros the arriving failure bytes');
  }
});

test('missing/wrong photo reply generation and a post-await engine switch publish nothing and preserve exact existing references',async t=>{
  let mode='missing',captured,entered,release;
  const h=await harness(t,{photoProcessor:async input=>{
    captured=input;const result=processed(input);
    if(mode==='missing')delete result.engine_identity;
    if(mode==='wrong')result.engine_identity=next;
    if(mode==='object')result.engine_identity=JSON.parse(first);
    if(mode==='held'){entered.resolve();await release.promise;}
    return result;
  }}),owner=await enroll(h),recipient=await enroll(h);
  for(const person of [owner,recipient])await preferences(h,person);
  const before=await references(h);
  for(const invalid of ['missing','wrong','object']){
    mode=invalid;const item=await queuedPhoto(h,owner);
    await assert.rejects(processPhotoJob({attempt_id:item.attempt.id},h.app),error=>error?.code==='processor_origin_unverified');
    assert.equal(captured.engine_identity,first);await noPublication(h,item,'processor_origin_unverified');
    assert.deepEqual(await references(h),before);
  }
  mode='held';entered=deferred();release=deferred();const item=await queuedPhoto(h,owner);
  const pending=processPhotoJob({attempt_id:item.attempt.id},h.app).then(()=>null,error=>error);
  try{await arrived(entered);h.env.INFERENCE_ENGINE_IDENTITY=next;}
  finally{release.resolve();}
  assert.equal((await pending)?.code,'inference_generation_changed');
  await noPublication(h,item,'inference_generation_changed');assert.deepEqual(await references(h),before);
  assert.equal((await h.storage.exec('SELECT engine_identity FROM processing_attempts WHERE id=?',item.attempt.id))[0].engine_identity,first);
});

test('a generation switch after a private preview write retires that preview and leaves no published result',async t=>{
  const h=await harness(t,{photoProcessor:processed}),owner=await enroll(h);await preferences(h,owner);
  const item=await queuedPhoto(h,owner),before=await references(h),put=h.env.PHOTOS.put.bind(h.env.PHOTOS);
  h.env.PHOTOS.put=async(key,value,options)=>{await put(key,value,options);if(key.startsWith('preview/'))h.env.INFERENCE_ENGINE_IDENTITY=next;};
  await assert.rejects(processPhotoJob({attempt_id:item.attempt.id},h.app),error=>error?.code==='inference_generation_changed');
  const keys=[...h.env.PHOTOS.rows.keys()].filter(value=>value.startsWith('preview/')&&value.includes('/'+item.asset_id+'/'));
  assert.equal(keys.length,1,'unpublished preview awaits authority-checked cleanup');
  const queued=await h.storage.exec("SELECT status,verified_at FROM cleanup_intents WHERE subject_id=? AND bucket='PHOTOS' AND object_key=?",owner.accountId,keys[0]);
  assert.equal(queued.length,1);assert.equal(queued[0].status,'pending');assert.equal(queued[0].verified_at,null);
  const writer=(await h.storage.exec("SELECT status FROM media_write_intents WHERE account_id=? AND bucket='PHOTOS' AND object_key=?",owner.accountId,keys[0]))[0];
  assert.equal(writer.status,'settled');
  const denied=await h.request(`/community/media/${item.asset_id}/preview`,{token:owner.token});assert.equal(denied.status,404);await denied.body?.cancel();
  await h.db.invocation(()=>flushPrivacyCleanup(h.app));
  const cleaned=(await h.storage.exec("SELECT status,verified_at FROM cleanup_intents WHERE subject_id=? AND bucket='PHOTOS' AND object_key=?",owner.accountId,keys[0]))[0];
  assert.equal(cleaned.status,'verified');assert.notEqual(cleaned.verified_at,null);
  await noPublication(h,item,'inference_generation_changed');assert.deepEqual(await references(h),before);
});

test('canonical account maps reject duplicate captured identities and subtract a reconsented full profile without relabelling the snapshot',async t=>{
  let calls=0,dispatched;
  const h=await harness(t,{photoProcessor:input=>{calls++;dispatched=input;return processed(input);}}),owner=await enroll(h),recipient=await enroll(h);
  for(const person of [owner,recipient])await preferences(h,person);
  const duplicate=await queuedPhoto(h,owner),captured=JSON.parse(duplicate.attempt.profiles_json);
  assert.equal(captured.length,1);
  await h.storage.exec('UPDATE processing_attempts SET profiles_json=? WHERE id=?',stable([captured[0],captured[0]]),duplicate.attempt.id);
  await assert.rejects(processPhotoJob({attempt_id:duplicate.attempt.id},h.app),error=>error?.code==='matching_profile_changed');
  await noPublication(h,duplicate,'matching_profile_changed');assert.equal(calls,0);
  const item=await queuedPhoto(h,owner),before=await references(h);
  await preferences(h,recipient,false);await preferences(h,recipient,true);
  await processPhotoJob({attempt_id:item.attempt.id},h.app);
  assert.deepEqual(dispatched.profiles,[]);assert.equal(dispatched.engine_identity,first);
  const current=(await h.storage.exec('SELECT profiles_json,engine_identity,status,matches_json FROM processing_attempts WHERE id=?',item.attempt.id))[0];
  assert.equal(current.profiles_json,item.attempt.profiles_json);assert.equal(current.engine_identity,first);
  assert.equal(current.status,'completed');assert.deepEqual(JSON.parse(current.matches_json),[]);
  assert.equal(await count(h,'candidates','WHERE asset_id=?',item.asset_id),0);assert.deepEqual(await references(h),before);
});
