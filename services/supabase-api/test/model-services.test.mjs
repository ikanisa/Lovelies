import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createModelServices} from '../src/model-services.ts';
import {AuthenticatedService} from '../src/service-fetcher.ts';
import {createApp,createHandler} from '../src/index.ts';
import {currentSchemaVersion} from '../src/schema.ts';
import {stable,digest} from '../src/types.ts';
import {INFERENCE_ENGINE_SPACE,INFERENCE_MODEL_ID,INFERENCE_MODEL_HASHES,INFERENCE_CAPABILITIES,INFERENCE_LIMITS} from '../src/inference-contract.ts';

// These deterministic fixtures qualify transport/authority binding only. The
// real model and numerical recognition have their separate consumer suite.
const artifact='a'.repeat(64),processing='b'.repeat(64),secret='synthetic-private-inference-service-secret-32';
const bindingNames=['engine_space','engine_artifact_sha256','processing_fingerprint','request_id','request_sha256'];
const binding=input=>Object.fromEntries(bindingNames.map(key=>[key,input[key]]));
const readyValue=()=>({available:true,engine_space:INFERENCE_ENGINE_SPACE,engine_artifact_sha256:artifact,
  processing_fingerprint:processing,model_id:INFERENCE_MODEL_ID,model_hashes:{...INFERENCE_MODEL_HASHES},
  capabilities:[...INFERENCE_CAPABILITIES],limits:{...INFERENCE_LIMITS},liveness_required:false});
class FixtureBucket {
  rows=new Map();
  put(key,bytes,options={}){this.rows.set(key,{bytes:new Uint8Array(bytes),...options});}
  async get(key){const row=this.rows.get(key);if(!row)return null;const response=new Response(new Uint8Array(row.bytes));
    return {size:row.bytes.length,etag:'fixture',...row,body:response.body,arrayBuffer:()=>response.arrayBuffer()};}
}
function harness(infer=async input=>({...binding(input),identity_verified:false,model_id:INFERENCE_MODEL_ID}),readiness=readyValue){
  const observed=[],photos=new FixtureBucket(),quarantine=new FixtureBucket();
  const transport=new AuthenticatedService('https://private.example/consumer',secret,async request=>{
    assert.equal(request.headers.get('authorization'),'Bearer '+secret);assert.equal(request.redirect,'manual');
    if(new URL(request.url).pathname==='/consumer/ready'){observed.push({path:'/ready'});return Response.json(await readiness());}
    const input=await request.json();observed.push({path:new URL(request.url).pathname,input});
    const reply=await infer(input,request);return reply instanceof Response?reply:Response.json(reply);
  });
  const env={PHOTOS:photos,QUARANTINE:quarantine,MODEL_VERSION:INFERENCE_MODEL_ID,
    FACE_AUTH_POLICY_VERSION:'registered-face-opencv-v1',ENGINE_ARTIFACT_SHA256:artifact,PROCESSING_FINGERPRINT:processing,INFERENCE:transport};
  return {env,services:createModelServices(env),photos,quarantine,observed};
}
async function faceForm(mode='first_registration'){
  const form=new FormData(),manifest=[],count=mode==='existing_reference'?1:3;
  for(let index=0;index<count;index++){
    const bytes=new TextEncoder().encode('synthetic-capture-'+index),sha256=await digest(bytes);
    manifest.push({index,sha256,mime:'image/jpeg',byte_size:bytes.length});
    form.set('capture_'+index,new Blob([bytes],{type:'image/jpeg'}),'capture_'+index+'.jpg');
  }
  const envelope={protocol:'lovelies-face-auth-verdict-v1',account_id:crypto.randomUUID(),device_id:crypto.randomUUID(),
    challenge_id:crypto.randomUUID(),nonce:crypto.randomUUID(),purpose:mode==='replace_reference'?'replacement':mode==='existing_reference'?'login':'registration',
    device_revision:crypto.randomUUID(),profile_id:mode==='first_registration'?null:crypto.randomUUID(),
    profile_revision:mode==='first_registration'?null:crypto.randomUUID(),model_id:mode==='first_registration'?null:INFERENCE_MODEL_ID,
    reference_digest:null,reference_mode:mode,required_captures:count,policy_version:'registered-face-opencv-v1',
    expires_at:Date.now()+90_000,capture_manifest:manifest};
  if(mode!=='first_registration'){
    const reference=new TextEncoder().encode('synthetic-reference-contract-only');envelope.reference_digest=await digest(reference);
    form.set('reference',new Blob([reference],{type:'application/octet-stream'}),'registered-reference');
  }
  form.set('envelope',JSON.stringify(envelope));return {form,envelope};
}
const sendFace=async(h,form,signal)=>h.services.face.fetch(new Request('https://private/v1/face-auth/verify',{method:'POST',body:form,signal}));

test('readiness requires an authenticated loaded engine, exact hashes, capabilities, limits and both frozen identities',async()=>{
  const h=harness();assert.equal(await h.services.ready(),true);assert.deepEqual(h.observed,[{path:'/ready'}]);
  const response=await h.services.face.fetch('https://private/ready');assert.equal(response.status,200);assert.deepEqual(await response.json(),readyValue());
  for(const mutate of [
    value=>delete value.available,value=>value.available='true',value=>delete value.engine_space,
    value=>value.engine_space='other-app-space',value=>value.engine_artifact_sha256='c'.repeat(64),
    value=>value.processing_fingerprint='c'.repeat(64),value=>value.model_id='other-model',
    value=>value.model_hashes.yunet='c'.repeat(64),value=>value.model_hashes.sface='c'.repeat(64),
    value=>value.capabilities.pop(),value=>value.capabilities.push('face_pad_device_key'),
    value=>value.capabilities[1]=value.capabilities[0],value=>value.liveness_required=true,
    value=>delete value.liveness_required,value=>value.limits.image_pixels=24_000_000,
  ]){
    const invalid=harness(undefined,()=>{const value=readyValue();mutate(value);return value;});
    assert.equal(await invalid.services.ready(),false);
    assert.equal((await invalid.services.face.fetch('https://private/ready')).status,503);
  }
  for(const key of ['ENGINE_ARTIFACT_SHA256','PROCESSING_FINGERPRINT']){
    const invalid=harness();delete invalid.env[key];assert.equal(await invalid.services.ready(),false);assert.equal(invalid.observed.length,0);
  }
});

test('three-still enrollment returns the unchanged native envelope and digest-binds the exact private operation',async()=>{
  const template=Buffer.from('synthetic-opaque-template-contract-only');
  const h=harness(async input=>{
    const {request_sha256,...identity}=input;
    assert.equal(await digest(stable(identity)),request_sha256);
    assert.equal(input.engine_space,INFERENCE_ENGINE_SPACE);assert.equal(input.engine_artifact_sha256,artifact);assert.equal(input.processing_fingerprint,processing);
    assert.match(input.request_id,/^[0-9a-f-]{36}$/);assert.equal(input.captures.length,3);assert.equal(input.reference_mode,'first_registration');
    return {...binding(input),model_id:INFERENCE_MODEL_ID,identity_verified:true,enrollment_verified:true,
      template_sha256:await digest(template),template_base64:template.toString('base64')};
  });
  const {form,envelope}=await faceForm(),response=await sendFace(h,form);assert.equal(response.status,200);
  const verdict=await response.json();for(const [key,value] of Object.entries(envelope))assert.deepEqual(verdict[key],value);
  assert.equal(verdict.identity_verified,true);assert.equal(verdict.enrollment_verified,true);
  assert.equal(verdict.registered_reference.model_id,INFERENCE_MODEL_ID);assert.equal(verdict.registered_reference.template_sha256,await digest(template));
  for(const key of bindingNames)assert(!Object.hasOwn(verdict,key),'private binding must not alter the native envelope');
});

test('fresh comparison and replacement retain the exact registered reference and their distinct decisions',async()=>{
  for(const mode of ['existing_reference','replace_reference']){
    const h=harness(async input=>{
      assert.equal(input.reference_mode,mode);assert.equal(await digest(Buffer.from(input.reference_base64,'base64')),input.reference_digest);
      assert.equal(input.captures.length,mode==='existing_reference'?1:3);
      return {...binding(input),model_id:INFERENCE_MODEL_ID,identity_verified:false,reference_match:false};
    });
    const {form,envelope}=await faceForm(mode),response=await sendFace(h,form);assert.equal(response.status,200);
    const verdict=await response.json();assert.equal(verdict.reference_digest,envelope.reference_digest);assert.equal(verdict.reference_match,false);
    assert.equal(verdict.identity_verified,false);assert(!Object.hasOwn(verdict,'registered_reference'));
  }
});

test('wrong, missing or replayed result binding cannot become a native verdict',async()=>{
  for(const mutate of [
    ...bindingNames.map(key=>value=>delete value[key]),
    value=>value.engine_space='other-app-space',value=>value.engine_artifact_sha256='c'.repeat(64),
    value=>value.processing_fingerprint='c'.repeat(64),value=>value.request_id=crypto.randomUUID(),
    value=>value.request_sha256='c'.repeat(64),value=>value.model_id='other-model',
    value=>value.identity_verified='true',
  ]){
    const h=harness(async input=>{const value={...binding(input),model_id:INFERENCE_MODEL_ID,identity_verified:false};mutate(value);return value;});
    const {form}=await faceForm();assert([409,503].includes((await sendFace(h,form)).status));
  }
  let prior;
  const h=harness(async input=>{prior??={...binding(input),identity_verified:false,model_id:INFERENCE_MODEL_ID};return prior;});
  const first=await faceForm();assert.equal((await sendFace(h,first.form)).status,200);
  const second=await faceForm();assert.equal((await sendFace(h,second.form)).status,503);
  const malformed=harness(async input=>({...binding(input),identity_verified:true,reference_match:'true',model_id:INFERENCE_MODEL_ID}));
  const login=await faceForm('existing_reference');assert.equal((await sendFace(malformed,login.form)).status,503);
});

test('bounded capture rejection remains a negative verdict while malformed private JSON and redirects fail closed',async()=>{
  for(const code of ['no_face','multiple_faces','quality_low','invalid_image']){
    const h=harness(async input=>({...binding(input),identity_verified:false,model_id:INFERENCE_MODEL_ID,capture_rejection:{code,capture_index:1}}));
    const {form}=await faceForm(),response=await sendFace(h,form);assert.equal(response.status,200);
    const result=await response.json();assert.equal(result.identity_verified,false);assert.deepEqual(result.capture_rejection,{code,capture_index:1});
  }
  for(const reply of [
    new Response('{truncated-json',{headers:{'content-type':'application/json'}}),
    Response.json(null),Response.json([]),new Response(null,{status:307,headers:{location:'https://untrusted.invalid'}}),
    new Response('not-json',{headers:{'content-type':'text/plain'}}),new Response(null,{status:401}),
  ]){
    const h=harness(async()=>reply),{form}=await faceForm();assert([401,503].includes((await sendFace(h,form)).status));
  }
});

test('photo request binds its source and exact admitted snapshot; a reply from another photo is denied',async()=>{
  let previous;
  const h=harness(async input=>{
    assert.equal(input.profiles.length,1);assert.equal(input.source.mime,'image/jpeg');
    const {request_sha256,...identity}=input;assert.equal(await digest(stable(identity)),request_sha256);
    const result={...binding(input),model_version:INFERENCE_MODEL_ID,preview:{bytes_base64:'cHJldmlldw==',content_type:'image/jpeg',width:1,height:1},
      matches:[{recipient_id:input.profiles[0].account_id,profile_id:input.profiles[0].profile_id,profile_version:input.profiles[0].revision,model_version:INFERENCE_MODEL_ID}]};
    if(previous)return previous;previous=result;return result;
  });
  const source=new TextEncoder().encode('synthetic-private-photo'),checksum=await digest(source),version=crypto.randomUUID();
  h.quarantine.put('source/private-contract',source,{httpMetadata:{contentType:'image/jpeg'},customMetadata:{source_version:version,source_checksum_sha256:checksum}});
  const account=crypto.randomUUID(),profile=crypto.randomUUID(),template=new TextEncoder().encode('synthetic-private-template');
  const key=`registered-face/${account}/${profile}/current`;
  h.photos.put(key,template);
  const input={attempt_id:crypto.randomUUID(),asset_id:crypto.randomUUID(),source_version:version,source_checksum_sha256:checksum,
    model_version:INFERENCE_MODEL_ID,nonce:crypto.randomUUID(),quarantine_key:'source/private-contract',
    profiles:[{account_id:account,profile_id:profile,revision:'fixture-revision',model_id:INFERENCE_MODEL_ID,template_key:key,template_digest:await digest(template)}]};
  const send=()=>h.services.photo.fetch('https://private/process',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
  const first=await send();assert.equal(first.status,200);const result=await first.json();
  assert.equal(result.attempt_id,input.attempt_id);assert.equal(result.nonce,input.nonce);assert.equal(result.matches[0].recipient_id,account);
  assert.equal((await send()).status,503);
});

test('a bounded profile count cannot bypass the total photo request budget through large templates',async()=>{
  const h=harness(),source=new Uint8Array(INFERENCE_LIMITS.image_bytes),checksum=await digest(source),version=crypto.randomUUID();
  h.quarantine.put('source/large-contract',source,{httpMetadata:{contentType:'image/jpeg'},customMetadata:{source_version:version,source_checksum_sha256:checksum}});
  const template=new Uint8Array(65536),templateHash=await digest(template),profiles=[];
  for(let index=0;index<180;index++){
    const account=crypto.randomUUID(),profile=crypto.randomUUID(),key=`registered-face/${account}/${profile}/current`;
    h.photos.put(key,template);profiles.push({account_id:account,profile_id:profile,revision:'fixture-revision',
      model_id:INFERENCE_MODEL_ID,template_key:key,template_digest:templateHash});
  }
  let reads=0;const get=h.photos.get.bind(h.photos);h.photos.get=async key=>{reads++;return get(key);};
  const response=await h.services.photo.fetch('https://private/process',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
    attempt_id:crypto.randomUUID(),asset_id:crypto.randomUUID(),source_version:version,source_checksum_sha256:checksum,
    model_version:INFERENCE_MODEL_ID,nonce:crypto.randomUUID(),quarantine_key:'source/large-contract',profiles})});
  assert.equal(response.status,413);assert.deepEqual(await response.json(),{error:{code:'inference_body_too_large'}});
  assert(reads<profiles.length,'stop loading the snapshot as soon as the byte budget is exhausted');assert.equal(h.observed.length,0);
});

test('inference timeout and caller cancellation cannot produce a verdict or leave the transport active',async()=>{
  for(const cancel of [false,true]){
    let started,observed;
    const began=new Promise(resolve=>started=resolve),h=harness();
    h.env.INFERENCE=new AuthenticatedService('https://private.example',secret,async request=>{observed=request;started();return new Promise(()=>{});},cancel?1000:20);
    const controller=new AbortController(),{form}=await faceForm(),pending=sendFace(h,form,controller.signal);
    await began;if(cancel)controller.abort(new Error('synthetic-caller-cancel'));
    const response=await pending;assert.equal(response.status,503);assert.equal(observed.signal.aborted,true);
  }
});

test('public API readiness reports a sanitized live-probe boolean and health remains independent',async()=>{
  const h=harness(),env={APP_ENV:'test',PHOTOS:h.photos,QUARANTINE:h.quarantine,PRIVACY_EXPORTS:{},PHOTO_JOBS:{},
    FACE_AUTH_VERIFIER:h.services.face,PHOTO_PROCESSOR:h.services.photo,MODEL_SERVICE_READINESS:h.services.ready,
    AUTH_SIGNING_SECRET:secret,MEDIA_SIGNING_SECRET:secret,INTERNAL_MAINTENANCE_SECRET:secret,
    FACE_AUTH_POLICY_VERSION:'registered-face-opencv-v1',PHOTO_MODEL_VERSION:INFERENCE_MODEL_ID,PUBLIC_API_BASE_URL:'https://api.example'};
  const handler=createHandler(createApp({one:async()=>({version:currentSchemaVersion})},env));
  const live=await handler(new Request('https://api.example/ready'));assert.equal(live.status,200);
  const value=await live.json();assert.equal(value.inference_ready,true);assert.equal(value.hosted_provider_acceptance,false);
  for(const key of [...bindingNames,'model_hashes','processing_fingerprint','capabilities'])assert(!Object.hasOwn(value,key));
  env.MODEL_SERVICE_READINESS=async()=>false;assert.equal((await handler(new Request('https://api.example/ready'))).status,503);
  env.MODEL_SERVICE_READINESS=async()=>{throw new Error('synthetic-private-failure');};assert.equal((await handler(new Request('https://api.example/ready'))).status,503);
  delete env.MODEL_SERVICE_READINESS;assert.equal((await handler(new Request('https://api.example/ready'))).status,503);
  assert.equal((await handler(new Request('https://api.example/health'))).status,200);
});
