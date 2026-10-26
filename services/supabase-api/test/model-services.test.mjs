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
const generation=stable({engine_space:INFERENCE_ENGINE_SPACE,engine_artifact_sha256:artifact,processing_fingerprint:processing});
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
    const wire=await request.text(),input=JSON.parse(wire);observed.push({path:new URL(request.url).pathname,input});
    const reply=await infer(input,request,wire);return reply instanceof Response?reply:Response.json(reply);
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
    reference_digest:null,reference_mode:mode,required_captures:count,policy_version:'registered-face-opencv-v1',engine_identity:generation,
    expires_at:Date.now()+90_000,capture_manifest:manifest};
  if(mode!=='first_registration'){
    const reference=new TextEncoder().encode('synthetic-reference-contract-only');envelope.reference_digest=await digest(reference);
    form.set('reference',new Blob([reference],{type:'application/octet-stream'}),'registered-reference');
  }
  form.set('envelope',JSON.stringify(envelope));return {form,envelope};
}
const sendFace=async(h,form,signal)=>h.services.face.fetch(new Request('https://private/v1/face-auth/verify',{method:'POST',body:form,signal}));
const photoReply=async input=>({...binding(input),model_version:INFERENCE_MODEL_ID,
  preview:{bytes_base64:'cHJldmlldw==',content_type:'image/jpeg',width:1,height:1},matches:[]});
async function photoFixture(h,count=1){
  const source=new TextEncoder().encode('synthetic-guarded-private-photo'),checksum=await digest(source),version=crypto.randomUUID();
  h.quarantine.put('source/authority-contract',source,{httpMetadata:{contentType:'image/jpeg'},customMetadata:{source_version:version,source_checksum_sha256:checksum}});
  const profiles=[];
  for(let index=0;index<count;index++){
    const account=crypto.randomUUID(),profile=crypto.randomUUID(),template=new TextEncoder().encode('synthetic-guarded-template-'+index);
    const key=`registered-face/${account}/${profile}/current`;h.photos.put(key,template);
    profiles.push({account_id:account,profile_id:profile,revision:'fixture-revision-'+index,model_id:INFERENCE_MODEL_ID,
      template_key:key,template_digest:await digest(template)});
  }
  const input={attempt_id:crypto.randomUUID(),asset_id:crypto.randomUUID(),source_version:version,source_checksum_sha256:checksum,
    model_version:INFERENCE_MODEL_ID,engine_identity:generation,nonce:crypto.randomUUID(),quarantine_key:'source/authority-contract',profiles};
  return {input,send:assertAuthority=>h.services.photo.fetch('https://private/process',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)},assertAuthority)};
}
function trackPrivateReads(bucket,onChunk=()=>{}){
  const get=bucket.get.bind(bucket),reads=[];
  bucket.get=async key=>{
    const object=await get(key);if(!object)return object;
    const read={key,chunks:[]};reads.push(read);
    return {...object,body:object.body.pipeThrough(new TransformStream({transform:(chunk,output)=>{
      read.chunks.push(chunk);onChunk(key);output.enqueue(chunk);
    }}))};
  };
  return reads;
}
function trackOwnedDigests(t,afterCanonicalDigest=()=>{}){
  const digest=crypto.subtle.digest.bind(crypto.subtle),views=[];
  t.mock.method(crypto.subtle,'digest',async(algorithm,data)=>{
    const bytes=ArrayBuffer.isView(data)?new Uint8Array(data.buffer,data.byteOffset,data.byteLength):new Uint8Array(data);
    views.push(bytes);
    const canonical=new TextDecoder().decode(bytes.subarray(0,12)).startsWith('{"asset_id":');
    const value=await digest(algorithm,data);if(canonical)afterCanonicalDigest(bytes);return value;
  });
  return views;
}
function assertPrivateBytesCleared(reads,views){
  for(const read of reads)for(const bytes of read.chunks)
    assert(bytes.every(byte=>byte===0),'consumed private Storage chunks are retired');
  for(const bytes of views)assert(bytes.every(byte=>byte===0),'owned source, template and canonical digest bytes are retired');
}

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

test('generation is canonical configured metadata, independent of a live readiness response, with no fallback pins',async()=>{
  const h=harness(undefined,()=>({...readyValue(),available:false}));
  assert.equal(h.services.generation(),generation);assert.equal(h.observed.length,0);
  assert.equal(await h.services.ready(),false);assert.equal(h.services.generation(),generation);
  const changed=harness();changed.env.PROCESSING_FINGERPRINT='c'.repeat(64);
  assert.equal(changed.services.generation(),stable({engine_space:INFERENCE_ENGINE_SPACE,
    engine_artifact_sha256:artifact,processing_fingerprint:'c'.repeat(64)}));
  for(const key of ['ENGINE_ARTIFACT_SHA256','PROCESSING_FINGERPRINT','MODEL_VERSION']){
    const invalid=harness();delete invalid.env[key];
    assert.throws(()=>invalid.services.generation(),error=>error.status===503&&error.code==='face_model_unavailable');
    assert.equal(await invalid.services.ready(),false);assert.equal(invalid.observed.length,0);
  }
});

test('missing or stale private face generation is denied before capture bytes, hashing, Storage or inference',async t=>{
  const stale=stable({engine_space:INFERENCE_ENGINE_SPACE,engine_artifact_sha256:artifact,processing_fingerprint:'c'.repeat(64)});
  for(const mode of ['first_registration','existing_reference','replace_reference']){
    for(const selected of [undefined,null,stale,generation+' ',JSON.parse(generation)]){
      const h=harness(),{form,envelope}=await faceForm(mode);
      if(selected===undefined)delete envelope.engine_identity;else envelope.engine_identity=selected;
      form.set('envelope',JSON.stringify(envelope));
      let captureReads=0,hashes=0,storageReads=0;
      const arrayBuffer=File.prototype.arrayBuffer,digest=crypto.subtle.digest.bind(crypto.subtle);
      t.mock.method(File.prototype,'arrayBuffer',function(){captureReads++;return arrayBuffer.call(this);});
      t.mock.method(crypto.subtle,'digest',(...args)=>{hashes++;return digest(...args);});
      h.photos.get=h.quarantine.get=async()=>{storageReads++;throw new Error('unexpected private read');};
      try{
        const response=await sendFace(h,form);assert.equal(response.status,409);
        assert.deepEqual(await response.json(),{error:{code:'inference_generation_changed'}});
        assert.equal(captureReads,0);assert.equal(hashes,0);assert.equal(storageReads,0);assert.equal(h.observed.length,0);
      }finally{t.mock.restoreAll();}
    }
  }
});

test('missing or stale private photo generation is denied before authority callbacks, Storage or inference',async()=>{
  const stale=stable({engine_space:INFERENCE_ENGINE_SPACE,engine_artifact_sha256:'c'.repeat(64),processing_fingerprint:processing});
  for(const selected of [undefined,null,stale,generation+' ',JSON.parse(generation)]){
    const h=harness(photoReply),fixture=await photoFixture(h),events=[];
    if(selected===undefined)delete fixture.input.engine_identity;else fixture.input.engine_identity=selected;
    const sourceReads=trackPrivateReads(h.quarantine),templateReads=trackPrivateReads(h.photos);
    const response=await fixture.send(async stage=>{events.push(stage);});assert.equal(response.status,409);
    assert.deepEqual(await response.json(),{error:{code:'inference_generation_changed'}});
    assert.deepEqual(events,[]);assert.deepEqual(sourceReads,[]);assert.deepEqual(templateReads,[]);assert.equal(h.observed.length,0);
  }
});

test('three-still enrollment echoes its private generation and digest-binds the existing capture operation',async()=>{
  const template=Buffer.from('synthetic-opaque-template-contract-only');
  const h=harness(async input=>{
    const {request_sha256,...identity}=input;
    assert.equal(await digest(stable(identity)),request_sha256);
    assert.equal(input.engine_space,INFERENCE_ENGINE_SPACE);assert.equal(input.engine_artifact_sha256,artifact);assert.equal(input.processing_fingerprint,processing);
    assert(!Object.hasOwn(input,'engine_identity'),'private operation metadata does not alter the ML consumer wire');
    assert.match(input.request_id,/^[0-9a-f-]{36}$/);assert.equal(input.captures.length,3);assert.equal(input.reference_mode,'first_registration');
    return {...binding(input),model_id:INFERENCE_MODEL_ID,identity_verified:true,enrollment_verified:true,
      template_sha256:await digest(template),template_base64:template.toString('base64')};
  });
  const {form,envelope}=await faceForm(),response=await sendFace(h,form);assert.equal(response.status,200);
  const verdict=await response.json();for(const [key,value] of Object.entries(envelope))assert.deepEqual(verdict[key],value);
  assert.equal(verdict.identity_verified,true);assert.equal(verdict.enrollment_verified,true);
  assert.equal(verdict.engine_identity,h.services.generation());
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

test('single encoded private body preserves canonical digest and exact content length across UTF-8 and base64 chunk boundaries',async()=>{
  const revisions=['révision-📷','quoted"revision','slash\\revision','line\nbreak','nul\0revision','tab\trevision','lone-\ud800','lone-\udfff','separator-\u2028\u2029'];
  let fixtureIndex=0;
  for(const length of [1,2,3,32765,32766,32767,65531,65532,65533]){
    const revision=revisions[fixtureIndex++];
    const source=Uint8Array.from({length},(_,index)=>index%251),template=Uint8Array.from({length:65536},(_,index)=>(index+1)%253);
    const checksum=await digest(source),version=crypto.randomUUID(),account=crypto.randomUUID(),profile=crypto.randomUUID(),key=`registered-face/${account}/${profile}/current`;
    const h=harness(async(input,request,wire)=>{
      const {request_sha256,...identity}=input;
      assert.equal(input.source.bytes_base64,Buffer.from(source).toString('base64'));
      assert.equal(input.profiles[0].template_base64,Buffer.from(template).toString('base64'));
      assert.equal(input.profiles[0].revision,revision);
      assert.equal(await digest(stable(identity)),request_sha256);
      assert.equal(wire,`{"request_sha256":"${request_sha256}",`+stable(identity).slice(1));
      assert.equal(Number(request.headers.get('content-length')),Buffer.byteLength(wire,'utf8'));
      return {...binding(input),model_version:INFERENCE_MODEL_ID,preview:{bytes_base64:'cHJldmlldw==',content_type:'image/jpeg',width:1,height:1},matches:[]};
    });
    h.quarantine.put('source/chunk-contract',source,{httpMetadata:{contentType:'image/jpeg'},customMetadata:{source_version:version,source_checksum_sha256:checksum}});
    h.photos.put(key,template);
    const response=await h.services.photo.fetch('https://private/process',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      attempt_id:crypto.randomUUID(),asset_id:crypto.randomUUID(),source_version:version,source_checksum_sha256:checksum,
      model_version:INFERENCE_MODEL_ID,engine_identity:generation,nonce:crypto.randomUUID(),quarantine_key:'source/chunk-contract',
      profiles:[{account_id:account,profile_id:profile,revision,model_id:INFERENCE_MODEL_ID,template_key:key,template_digest:await digest(template)}]})});
    assert.equal(response.status,200);
  }
});

test('private streams must match their admitted exact length before inference, including zero-padded short input',async()=>{
  const expected=new Uint8Array(4),checksum=await digest(expected),version=crypto.randomUUID();
  for(const entry of [
    {size:4,chunks:[new Uint8Array(2)],code:'private_object_changed'},
    {size:4,chunks:[],code:'private_object_changed'},
    {size:4,chunks:[new Uint8Array(5).fill(7)],code:'private_object_changed'},
    ...[NaN,Infinity,1.5,0,-1,INFERENCE_LIMITS.image_bytes+1].map(size=>({size,chunks:[],code:'private_object_unavailable'})),
  ]){
    const h=harness();let next=0;
    h.quarantine.get=async()=>({size:entry.size,etag:'changed-stream',
      httpMetadata:{contentType:'image/jpeg'},customMetadata:{source_version:version,source_checksum_sha256:checksum},
      body:new ReadableStream({pull:output=>{if(next<entry.chunks.length)output.enqueue(entry.chunks[next++]);else output.close();}})});
    const response=await h.services.photo.fetch('https://private/process',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      attempt_id:crypto.randomUUID(),asset_id:crypto.randomUUID(),source_version:version,source_checksum_sha256:checksum,
      model_version:INFERENCE_MODEL_ID,engine_identity:generation,nonce:crypto.randomUUID(),quarantine_key:'source/changed-stream',profiles:[]})});
    assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:{code:entry.code}});
    assert.equal(h.observed.length,0);
    for(const chunk of entry.chunks)assert(chunk.every(byte=>byte===0),'consumed rejected bytes are retired');
  }
});

test('early private failure cancels an unread encoded body and clears its owned prefix bytes',async()=>{
  const h=harness();let observed,ownedPrefix;
  h.env.INFERENCE={fetch:async request=>{
    observed=request;const reader=request.body.getReader();ownedPrefix=(await reader.read()).value;reader.releaseLock();
    assert.match(new TextDecoder().decode(ownedPrefix),/^\{"request_sha256":"[a-f0-9]{64}",$/);
    return new Response(null,{status:503});
  }};
  const {form}=await faceForm(),response=await sendFace(h,form);
  assert.equal(response.status,503);assert.equal(observed.signal.aborted,true);
  assert(ownedPrefix.every(byte=>byte===0),'owned encoded bytes are retired even when the service responds before draining them');
  assert.equal((await observed.body.getReader().read()).done,true);
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

test('only the exact bounded consumer reference-space error is preserved as an internal conflict',async()=>{
  const detail='registered_reference_space_incompatible',error=JSON.stringify({detail});
  const replies=[
    {make:()=>Response.json({detail},{status:409}),status:409,code:detail},
    {make:()=>new Response(error+' '.repeat(1024-error.length),{status:409,headers:{'content-type':'application/json'}}),status:409,code:detail},
    {make:()=>new Response(error+' '.repeat(1025-error.length),{status:409,headers:{'content-type':'application/json'}})},
    {make:()=>Response.json({detail,unexpected:secret},{status:409})},
    {make:()=>Response.json({detail:'inference_generation_changed'},{status:409})},
    {make:()=>Response.json({detail:[detail]},{status:409})},
    {make:()=>Response.json([detail],{status:409})},
    {make:()=>Response.json(null,{status:409})},
    {make:()=>new Response('{truncated-json',{status:409,headers:{'content-type':'application/json'}})},
    {make:()=>new Response(error,{status:409,headers:{'content-type':'text/plain'}})},
    {make:()=>Response.json({detail},{status:503})},
    {make:()=>Response.json({detail},{status:401}),status:401},
  ];
  for(const entry of replies)for(const path of ['face','photo']){
    const h=harness(async()=>entry.make());
    const response=path==='face'?await sendFace(h,(await faceForm('existing_reference')).form):await(await photoFixture(h)).send();
    assert.equal(response.status,entry.status??503);
    assert.deepEqual(await response.json(),{error:{code:entry.code??'inference_unavailable'}});
    assert.equal(h.observed.length,1);
  }
});

test('photo request binds its source and exact admitted snapshot; a reply from another photo is denied',async()=>{
  let previous;
  const h=harness(async input=>{
    assert.equal(input.profiles.length,1);assert.equal(input.source.mime,'image/jpeg');
    assert(!Object.hasOwn(input,'engine_identity'),'private operation metadata does not alter the ML consumer wire');
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
    model_version:INFERENCE_MODEL_ID,engine_identity:generation,nonce:crypto.randomUUID(),quarantine_key:'source/private-contract',
    profiles:[{account_id:account,profile_id:profile,revision:'fixture-revision',model_id:INFERENCE_MODEL_ID,template_key:key,template_digest:await digest(template)}]};
  const send=()=>h.services.photo.fetch('https://private/process',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
  const first=await send();assert.equal(first.status,200);const result=await first.json();
  assert.equal(result.attempt_id,input.attempt_id);assert.equal(result.nonce,input.nonce);assert.equal(result.matches[0].recipient_id,account);
  assert.equal(result.engine_identity,h.services.generation());
  assert.equal((await send()).status,503);
});

test('photo authority callbacks receive only exact profile identities at every private read and final dispatch',async()=>{
  const h=harness(photoReply),fixture=await photoFixture(h,2),events=[];
  const sourceReads=trackPrivateReads(h.quarantine),templateReads=trackPrivateReads(h.photos);
  const response=await fixture.send(async(stage,profile)=>{
    events.push({stage,profile});
    if(stage==='before_source')assert.equal(sourceReads.length,0);
    if(stage==='after_source')assert.equal(sourceReads.length,1);
    if(stage==='before_template')assert.equal(templateReads.length,events.filter(event=>event.stage==='before_template').length-1);
    if(stage==='after_template')assert.equal(templateReads.length,events.filter(event=>event.stage==='after_template').length);
    if(stage==='before_dispatch')assert.equal(h.observed.length,0);
    if(stage==='before_template'||stage==='after_template'){
      const expected=fixture.input.profiles.find(value=>value.profile_id===profile.profile_id);
      assert(expected);assert.deepEqual(profile,Object.fromEntries(['account_id','profile_id','revision','model_id'].map(key=>[key,expected[key]])));
      assert(Object.isFrozen(profile),'callback identity cannot be edited into another profile');
    }else assert.equal(profile,undefined);
  });
  assert.equal(response.status,200);assert.equal(h.observed.length,1);
  assert.deepEqual(events.map(event=>event.stage),['before_source','after_source','before_template','after_template',
    'before_template','after_template','before_dispatch']);
  assert.equal(h.observed[0].input.profiles.length,2);
  assertPrivateBytesCleared([...sourceReads,...templateReads],[]);
});

test('photo authority rejection at any acknowledged boundary is sanitized and stops private inference',async t=>{
  const stages=['before_source','after_source','before_template','after_template','before_dispatch'];
  for(const rejected of stages){
    const h=harness(photoReply),fixture=await photoFixture(h),events=[];
    const sourceReads=trackPrivateReads(h.quarantine),templateReads=trackPrivateReads(h.photos),views=trackOwnedDigests(t);
    try{
      const response=await fixture.send(async stage=>{events.push(stage);if(stage===rejected)throw new Error('private domain details '+secret);});
      assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:{code:'processing_authority_changed'}});
      assert.equal(response.headers.get('cache-control'),'no-store');
      assert.deepEqual(events,stages.slice(0,stages.indexOf(rejected)+1));assert.equal(h.observed.length,0);
      assert.equal(sourceReads.length,rejected==='before_source'?0:1);
      assert.equal(templateReads.length,['after_template','before_dispatch'].includes(rejected)?1:0);
      assertPrivateBytesCleared([...sourceReads,...templateReads],views);
    }finally{t.mock.restoreAll();}
  }
});

test('revoked authority during either template read prevents another template read or inference and clears held bytes',async t=>{
  for(const changedTemplate of [0,1]){
    const h=harness(photoReply),fixture=await photoFixture(h,2),events=[];let allowed=true;
    const sourceReads=trackPrivateReads(h.quarantine),templateReads=trackPrivateReads(h.photos,key=>{
      if(key===fixture.input.profiles[changedTemplate].template_key)allowed=false;
    }),views=trackOwnedDigests(t);
    try{
      const response=await fixture.send(async(stage,profile)=>{
        events.push({stage,profile});if(!allowed)throw {code:'private_profile_revoked',credential:secret};
      });
      assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:{code:'processing_authority_changed'}});
      assert.equal(templateReads.length,changedTemplate+1);assert.equal(h.observed.length,0);
      assert.equal(events.at(-1).stage,'after_template');
      assert.equal(events.at(-1).profile.profile_id,fixture.input.profiles[changedTemplate].profile_id);
      assert.equal(views.length,changedTemplate+2,'only source and admitted template bytes reached hashing');
      assertPrivateBytesCleared([...sourceReads,...templateReads],views);
    }finally{t.mock.restoreAll();}
  }
});

test('authority revoked while canonical WebCrypto hashing yields is denied at final dispatch and all owned bytes are zeroed',async t=>{
  const h=harness(photoReply),fixture=await photoFixture(h),events=[];let allowed=true,canonical;
  const sourceReads=trackPrivateReads(h.quarantine),templateReads=trackPrivateReads(h.photos);
  const views=trackOwnedDigests(t,bytes=>{canonical=bytes;allowed=false;});
  const response=await fixture.send(async stage=>{
    events.push(stage);
    if(stage==='before_dispatch')assert(canonical,'final authority check follows the canonical digest await');
    if(!allowed)throw 'private source/session/consent changed '+secret;
  });
  assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:{code:'processing_authority_changed'}});
  assert.equal(events.at(-1),'before_dispatch');assert.equal(h.observed.length,0);
  assert(canonical);assert.equal(views.length,3);
  assertPrivateBytesCleared([...sourceReads,...templateReads],views);
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
    model_version:INFERENCE_MODEL_ID,engine_identity:generation,nonce:crypto.randomUUID(),quarantine_key:'source/large-contract',profiles})});
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
    INFERENCE_ENGINE_IDENTITY:h.services.generation(),
    AUTH_SIGNING_SECRET:secret,MEDIA_SIGNING_SECRET:secret,INTERNAL_MAINTENANCE_SECRET:secret,
    FACE_AUTH_POLICY_VERSION:'registered-face-opencv-v1',PHOTO_MODEL_VERSION:INFERENCE_MODEL_ID,PUBLIC_API_BASE_URL:'https://api.example'};
  // Bounded unfenced readiness unit port; this supplies no restore-admission
  // authority and does not replace the PostgreSQL invocation/runtime checks.
  const handler=createHandler(createApp({one:async()=>({version:currentSchemaVersion}),invocation:async callback=>callback()},env));
  const live=await handler(new Request('https://api.example/ready'));assert.equal(live.status,200);
  const value=await live.json();assert.equal(value.inference_ready,true);assert.equal(value.hosted_provider_acceptance,false);
  for(const key of [...bindingNames,'model_hashes','processing_fingerprint','capabilities'])assert(!Object.hasOwn(value,key));
  env.MODEL_SERVICE_READINESS=async()=>false;assert.equal((await handler(new Request('https://api.example/ready'))).status,503);
  env.MODEL_SERVICE_READINESS=async()=>{throw new Error('synthetic-private-failure');};assert.equal((await handler(new Request('https://api.example/ready'))).status,503);
  delete env.MODEL_SERVICE_READINESS;assert.equal((await handler(new Request('https://api.example/ready'))).status,503);
  assert.equal((await handler(new Request('https://api.example/health'))).status,200);
});
