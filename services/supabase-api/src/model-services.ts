// Adapted from the active private ML boundary. Storage stays in Supabase;
// inference is an authenticated private HTTP service, never a Cloudflare binding.
import type {PrivateBucket,PrivateObject,ServiceFetcher,PhotoProcessorFetcher,PhotoAuthorityStage,PhotoAuthorityProfile} from './types.ts';
import {stable} from './types.ts';
import {INFERENCE_ENGINE_SPACE,INFERENCE_MODEL_ID,INFERENCE_LIMITS,INFERENCE_REPLY_BYTES,INFERENCE_READY_BYTES,
  exactBinding,exactReadiness,sha256Identity,type InferenceBinding} from './inference-contract.ts';
import {encodeGeneration} from './inference-generation.ts';
interface Env { PHOTOS:PrivateBucket; QUARANTINE:PrivateBucket; MODEL_VERSION:string; FACE_AUTH_POLICY_VERSION:string;
  ENGINE_ARTIFACT_SHA256?:string; PROCESSING_FINGERPRINT?:string; INFERENCE:ServiceFetcher; }
class BoundaryError extends Error { constructor(readonly status:number, readonly code:string) { super(code); } }
type PhotoAuthorityAssertion=NonNullable<Parameters<PhotoProcessorFetcher['fetch']>[2]>;
async function photoAuthority(assertAuthority:PhotoAuthorityAssertion,stage:PhotoAuthorityStage,profile?:PhotoAuthorityProfile):Promise<void> {
  try{await assertAuthority(stage,profile);}
  catch{throw new BoundaryError(409,'processing_authority_changed');}
}
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const record=(value:unknown):Record<string,any>=>{
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new BoundaryError(400,'invalid_input');
  return value as Record<string,any>;
};
const identifier=(value:unknown):string=>{
  if (typeof value!=='string' || !/^[0-9a-f-]{36}$/i.test(value)) throw new BoundaryError(400,'invalid_id');
  return value;
};
const hash=(value:unknown):string=>{
  if (typeof value!=='string' || !/^[0-9a-f]{64}$/.test(value)) throw new BoundaryError(400,'invalid_digest');
  return value;
};
async function digest(bytes:Uint8Array):Promise<string> {
  // Hash the exact view, including its offset/length. WebCrypto owns the input
  // snapshot; an additional full-size JavaScript copy is unnecessary.
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as BufferSource))].map(v=>v.toString(16).padStart(2,'0')).join('');
}
const base64=(bytes:Uint8Array):string=>{
  // Every nonfinal chunk ends on a three-byte boundary, so its base64 has no
  // padding. Avoid retaining a second, complete binary string for large photos.
  const chunks:string[]=[];for(let start=0;start<bytes.length;start+=32766)
    chunks.push(btoa(String.fromCharCode(...bytes.subarray(start,start+32766))));
  return chunks.join('');
};
/** Preserve stable()'s exact recursive JSON order without assembling a second
 * full-size JavaScript string. Large base64 fields are generated locally and
 * contain no JSON escapes; short/other strings retain JSON.stringify semantics.
 */
function canonicalBytes(value:unknown,limit:number):Uint8Array {
  const encoder=new TextEncoder(),parts:Array<{text:string;bytes:number}>=[];
  const base64Fields=new Set(['bytes_base64','template_base64','reference_base64']);let length=0;
  const append=(text:string,ascii=false)=>{
    const bytes=ascii?text.length:encoder.encode(text).byteLength;length+=bytes;
    if(length>limit)throw new BoundaryError(413,'inference_body_too_large');
    parts.push({text,bytes});
  };
  const visit=(current:unknown,key?:string):void=>{
    if(typeof current==='string'){
      if(key!==undefined&&base64Fields.has(key)&&/^[A-Za-z0-9+/=]*$/.test(current)){
        append('"',true);append(current,true);append('"',true);
      }else append(JSON.stringify(current));
    }else if(Array.isArray(current)){
      append('[',true);current.forEach((item,index)=>{if(index)append(',',true);visit(item);});append(']',true);
    }else if(current!==null&&typeof current==='object'){
      append('{',true);Object.keys(current).sort().forEach((name,index)=>{
        if(index)append(',',true);append(JSON.stringify(name));append(':',true);visit((current as Record<string,unknown>)[name],name);
      });append('}',true);
    }else{
      const text=JSON.stringify(current);if(typeof text!=='string')throw new BoundaryError(503,'inference_encoding_invalid');append(text,true);
    }
  };
  visit(value);const encoded=new Uint8Array(length);let cursor=0;
  try{
    for(const part of parts){const result=encoder.encodeInto(part.text,encoded.subarray(cursor));
      if(result.read!==part.text.length||result.written!==part.bytes)throw new BoundaryError(503,'inference_encoding_invalid');cursor+=result.written;}
    return encoded;
  }catch(error){encoded.fill(0);throw error;}
}
/** These objects are new, private transient payloads. Their metadata survives;
 * once encoded, immutable image/template strings need not remain referenced
 * alongside the UTF-8 buffer and WebCrypto's own input snapshot. */
function retireEncodedPayload(payload:Record<string,unknown>):void {
  const clear=(value:unknown,key:string)=>{
    if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.hasOwn(value,key))(value as Record<string,unknown>)[key]='';
  };
  clear(payload.source,'bytes_base64');
  if(Array.isArray(payload.captures))for(const capture of payload.captures)clear(capture,'bytes_base64');
  if(Array.isArray(payload.profiles))for(const profile of payload.profiles)clear(profile,'template_base64');
  if(typeof payload.reference_base64==='string')payload.reference_base64='';
}
async function bounded(stream:ReadableStream<Uint8Array>|null,limit:number,signal?:AbortSignal,exactSize?:number):Promise<Uint8Array> {
  if (!stream) throw new BoundaryError(400,'body_required');
  const reader=stream.getReader(),chunks:Uint8Array[]=[];let length=0;
  const fixed=exactSize===undefined?undefined:new Uint8Array(exactSize);let completed=false;
  const stop=()=>{void reader.cancel(signal?.reason).catch(()=>{});};
  signal?.addEventListener('abort',stop,{once:true});
  try {
    if(signal?.aborted)throw new BoundaryError(503,'inference_cancelled');
    for(;;){const n=await reader.read();if(signal?.aborted)throw new BoundaryError(503,'inference_cancelled');if(n.done) break; length+=n.value.length;
      if(length>limit){n.value.fill(0);throw new BoundaryError(413,'body_too_large');}
      if(fixed){
        if(length>fixed.length){n.value.fill(0);throw new BoundaryError(409,'private_object_changed');}
        fixed.set(n.value,length-n.value.length);n.value.fill(0);
      }else chunks.push(n.value);}
    if(fixed){if(length!==fixed.length)throw new BoundaryError(409,'private_object_changed');completed=true;return fixed;}
    const bytes=new Uint8Array(length);let cursor=0;for(const c of chunks){bytes.set(c,cursor);cursor+=c.length;}completed=true;return bytes;
  } finally {signal?.removeEventListener('abort',stop);if(!completed)fixed?.fill(0);for(const c of chunks)c.fill(0);void reader.cancel().catch(()=>{});reader.releaseLock();}
}
async function body(request:Request,limit:number,signal?:AbortSignal):Promise<Record<string,any>> {
  if(!/^application\/json(?:;|$)/i.test(request.headers.get('content-type')??''))throw new BoundaryError(415,'json_required');
  const bytes=await bounded(request.body,limit,signal);
  try{return record(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}
  catch(error){if(error instanceof BoundaryError)throw error;throw new BoundaryError(400,'invalid_json');}
  finally{bytes.fill(0);}
}
function configured(env:Env):void {
  if(env.MODEL_VERSION!==INFERENCE_MODEL_ID || !sha256Identity(env.ENGINE_ARTIFACT_SHA256) ||
    !sha256Identity(env.PROCESSING_FINGERPRINT) || !env.PHOTOS || !env.QUARANTINE ||
    !env.INFERENCE)throw new BoundaryError(503,'face_model_unavailable');
}
function engineGeneration(env:Env):string {
  configured(env);
  return encodeGeneration({engine_space:INFERENCE_ENGINE_SPACE,engine_artifact_sha256:env.ENGINE_ARTIFACT_SHA256!,
    processing_fingerprint:env.PROCESSING_FINGERPRINT!});
}
function assertEngineGeneration(expected:unknown,env:Env):string {
  const selected=engineGeneration(env);
  if(expected!==selected)throw new BoundaryError(409,'inference_generation_changed');
  return selected;
}
interface ServiceBody {stream:ReadableStream<Uint8Array>;byteLength:number;}
async function serviceReply(env:Env,path:string,payload?:ServiceBody,limit=INFERENCE_REPLY_BYTES,signal?:AbortSignal):Promise<Record<string,any>> {
  configured(env); const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{reject(new BoundaryError(503,'inference_timeout'));controller.abort();},55_000);});
  const stop=()=>controller.abort(signal?.reason);
  signal?.addEventListener('abort',stop,{once:true});
  const aborted=new Promise<never>((_,reject)=>{
    const rejectAbort=()=>reject(new BoundaryError(503,'inference_cancelled'));
    controller.signal.addEventListener('abort',rejectAbort,{once:true});
  });
  void aborted.catch(()=>{});
  let response:Response|undefined,request:Request|undefined;
  try {
    if(signal?.aborted)throw new BoundaryError(503,'inference_cancelled');
    request=new Request(`http://container${path}`,{method:payload?'POST':'GET',
      headers:{'Content-Type':'application/json',...(payload?{'Content-Length':String(payload.byteLength)}:{})},
      ...(payload?{body:payload.stream,duplex:'half'}:{}),redirect:'manual',signal:controller.signal} as RequestInit);
    const service=env.INFERENCE;
    const pending=service.fetch(request);
    void pending.then(late=>{if(controller.signal.aborted)void late.body?.cancel().catch(()=>{});},()=>{});
    response=await Promise.race([pending,timeout,aborted]);
    if(response.status===409&&!response.redirected&&(path==='/internal/face'||path==='/internal/photo')){
      let incompatible=false;
      try{
        const error=await Promise.race([body(response as unknown as Request,1024,controller.signal),timeout,aborted]);
        incompatible=Object.keys(error).length===1&&error.detail==='registered_reference_space_incompatible';
      }catch(error){if(error instanceof BoundaryError&&error.code==='inference_timeout')throw error;}
      if(incompatible)throw new BoundaryError(409,'registered_reference_space_incompatible');
    }
    if(!response.ok||response.redirected)throw new BoundaryError(response.status===401?401:503,'inference_unavailable');
    try{return await Promise.race([body(response as unknown as Request,limit,controller.signal),timeout,aborted]);}
    catch(error){if(error instanceof BoundaryError&&error.code==='inference_timeout')throw error;throw new BoundaryError(503,'inference_result_invalid');}
  }finally{clearTimeout(timer!);signal?.removeEventListener('abort',stop);controller.abort();
    if(request?.body&&!request.body.locked)void request.body.cancel().catch(()=>{});
    if(response?.body&&!response.body.locked)void response.body.cancel().catch(()=>{});}
}
async function inference(env:Env,path:string,payload:Record<string,unknown>,engine_identity:string,signal?:AbortSignal,beforeDispatch?:()=>Promise<void>):Promise<Record<string,any>> {
  assertEngineGeneration(engine_identity,env);
  const identity={...payload,engine_space:INFERENCE_ENGINE_SPACE,engine_artifact_sha256:env.ENGINE_ARTIFACT_SHA256!,
    processing_fingerprint:env.PROCESSING_FINGERPRINT!,request_id:crypto.randomUUID()};
  // Canonical JSON sorts object keys recursively, preserves array order, and uses
  // only the wire contract's strings/integers. The digest includes the fresh ID.
  const limit=path==='/internal/face'?INFERENCE_LIMITS.face_body_bytes:INFERENCE_LIMITS.photo_body_bytes;
  const prefixText='{"request_sha256":"';
  const extraBytes=prefixText.length+64+2-1; // closing quote/comma; replace '{'
  const encoded=canonicalBytes(identity,limit-extraBytes);retireEncodedPayload(payload);
  let prefix:Uint8Array|undefined;
  try {
    // JSON wire order is immaterial. Prefixing the digest lets the same owned
    // canonical bytes supply both hashing and transport, without serializing or
    // encoding the complete request a second time. Account for all five binding
    // fields before hashing or starting the private transport.
    const request_sha256=await digest(encoded);
    const binding:InferenceBinding={engine_space:identity.engine_space,engine_artifact_sha256:identity.engine_artifact_sha256,
      processing_fingerprint:identity.processing_fingerprint,request_id:identity.request_id,request_sha256};
    prefix=new TextEncoder().encode(prefixText+request_sha256+'",');let next=0;
    const stream=new ReadableStream<Uint8Array>({pull:output=>{
      if(next===0){next=1;output.enqueue(prefix!);}
      else if(next===1){next=2;output.enqueue(encoded.subarray(1));}
      else output.close();
    }});
    // Canonical hashing yields to WebCrypto. A photo's current authority must be
    // acknowledged after that yield, before any private inference dispatch.
    if(beforeDispatch)await beforeDispatch();
    assertEngineGeneration(engine_identity,env);
    const result=await serviceReply(env,path,{stream,byteLength:prefix.byteLength+encoded.byteLength-1},INFERENCE_REPLY_BYTES,signal);
    if(!exactBinding(result,binding))throw new BoundaryError(503,'inference_result_invalid');
    return result;
  }finally{encoded.fill(0);prefix?.fill(0);}
}
async function readiness(env:Env,signal?:AbortSignal):Promise<Record<string,any>> {
  const result=await serviceReply(env,'/ready',undefined,INFERENCE_READY_BYTES,signal);
  if(!exactReadiness(result,env.ENGINE_ARTIFACT_SHA256!,env.PROCESSING_FINGERPRINT!))throw new BoundaryError(503,'inference_not_ready');
  return result;
}
async function privateObject(bucket:PrivateBucket,key:string,limit:number,expected:string,owned:Uint8Array[]):Promise<{bytes:Uint8Array,object:PrivateObject}> {
  const object=await bucket.get(key);
  if(!object||!Number.isSafeInteger(object.size)||object.size<1||object.size>limit)throw new BoundaryError(409,'private_object_unavailable');
  // Metadata already bounds the exact size. Fill one owned destination as the
  // network stream arrives instead of retaining all chunks plus another copy.
  const bytes=await bounded(object.body,limit,undefined,object.size);owned.push(bytes);
  if(bytes.length!==object.size||await digest(bytes)!==expected)throw new BoundaryError(409,'private_object_changed');
  return {bytes,object};
}
async function handlePhoto(request:Request,env:Env,assertAuthority?:PhotoAuthorityAssertion):Promise<Response> {
  if(request.method!=='POST'||new URL(request.url).pathname!=='/process')throw new BoundaryError(404,'route_not_found');
  const p=await body(request,1024*1024);configured(env);
  const engine_identity=assertEngineGeneration(p.engine_identity,env);
  for(const name of ['attempt_id','asset_id','source_version'])identifier(p[name]);
  hash(p.source_checksum_sha256);
  if(p.model_version!==env.MODEL_VERSION||typeof p.nonce!=='string'||p.nonce.length>128||!p.nonce||
    typeof p.quarantine_key!=='string'||!p.quarantine_key.startsWith('source/')||!Array.isArray(p.profiles)||p.profiles.length>1000)
    throw new BoundaryError(409,'processing_origin_invalid');
  const owned:Uint8Array[]=[];
  try {
    if(assertAuthority)await photoAuthority(assertAuthority,'before_source');
    let sourcePayload:{mime:string;sha256:string;bytes_base64:string};
    {
      const source=await privateObject(env.QUARANTINE,p.quarantine_key,20*1024*1024,p.source_checksum_sha256,owned);
      try {
        if(source.object.customMetadata?.source_version!==p.source_version||source.object.customMetadata?.source_checksum_sha256!==p.source_checksum_sha256)
          throw new BoundaryError(409,'source_version_changed');
        const mime=source.object.httpMetadata?.contentType;
        if(typeof mime!=='string'||!['image/jpeg','image/png','image/webp'].includes(mime))throw new BoundaryError(415,'image_required');
        if(assertAuthority)await photoAuthority(assertAuthority,'after_source');
        sourcePayload={mime,sha256:p.source_checksum_sha256,bytes_base64:base64(source.bytes)};
      }finally{source.bytes.fill(0);owned.pop();}
    }
    const profiles=[];const seen=new Set<string>();
    // Count the complete wire form incrementally before retaining a large
    // snapshot. Base64 is ASCII; the other fields use their actual UTF-8 size.
    // UUID/digest placeholders have exactly the lengths of the final binding.
    let serializedBytes=new TextEncoder().encode(stable({asset_id:p.asset_id,
      source:{...sourcePayload,bytes_base64:''},profiles:[],engine_space:INFERENCE_ENGINE_SPACE,
      engine_artifact_sha256:env.ENGINE_ARTIFACT_SHA256,processing_fingerprint:env.PROCESSING_FINGERPRINT,
      request_id:'0'.repeat(36),request_sha256:'0'.repeat(64)})).length+sourcePayload.bytes_base64.length;
    for(const v of p.profiles){const profile=record(v);identifier(profile.account_id);identifier(profile.profile_id);hash(profile.template_digest);
      if(seen.has(profile.account_id)||profile.model_id!==env.MODEL_VERSION||typeof profile.revision!=='string'||!profile.revision||profile.revision.length>128||
        typeof profile.template_key!=='string'||!profile.template_key.startsWith(`registered-face/${profile.account_id}/${profile.profile_id}/`))
        throw new BoundaryError(409,'matching_profile_invalid');
      seen.add(profile.account_id);
      const authorityProfile:PhotoAuthorityProfile=Object.freeze({account_id:profile.account_id,profile_id:profile.profile_id,
        revision:profile.revision,model_id:profile.model_id});
      if(assertAuthority)await photoAuthority(assertAuthority,'before_template',authorityProfile);
      const template=await privateObject(env.PHOTOS,profile.template_key,64*1024,profile.template_digest,owned);
      try {
        if(assertAuthority)await photoAuthority(assertAuthority,'after_template',authorityProfile);
        const admitted={account_id:profile.account_id,profile_id:profile.profile_id,revision:profile.revision,model_id:profile.model_id,
          template_digest:profile.template_digest,template_base64:base64(template.bytes)};
        serializedBytes+=new TextEncoder().encode(stable(admitted)).length+(profiles.length?1:0);
        if(serializedBytes>INFERENCE_LIMITS.photo_body_bytes)throw new BoundaryError(413,'inference_body_too_large');
        profiles.push(admitted);
      }finally{template.bytes.fill(0);owned.pop();}
    }
    const result=await inference(env,'/internal/photo',{asset_id:p.asset_id,source:sourcePayload,profiles},engine_identity,request.signal,
      assertAuthority?()=>photoAuthority(assertAuthority,'before_dispatch'):undefined);
    if(result.model_version!==env.MODEL_VERSION||!Array.isArray(result.matches)||result.matches.length>p.profiles.length)throw new BoundaryError(503,'processor_result_invalid');
    return json({attempt_id:p.attempt_id,nonce:p.nonce,asset_id:p.asset_id,source_version:p.source_version,
      source_checksum_sha256:p.source_checksum_sha256,model_version:p.model_version,engine_identity,preview:result.preview,matches:result.matches});
  }finally{for(const b of owned)b.fill(0);}
}
async function handleFace(request:Request,env:Env):Promise<Response> {
  if(request.method==='GET'&&new URL(request.url).pathname==='/ready')return json(await readiness(env,request.signal));
  if(request.method!=='POST'||new URL(request.url).pathname!=='/v1/face-auth/verify')throw new BoundaryError(404,'route_not_found');
  configured(env); if(!env.FACE_AUTH_POLICY_VERSION)throw new BoundaryError(503,'face_policy_unavailable');
  const raw=await bounded(request.body,INFERENCE_LIMITS.face_body_bytes,request.signal),owned:Uint8Array[]=[raw];
  try {
    const form=await new Request('http://private/face',{method:'POST',headers:{'Content-Type':request.headers.get('content-type')??''},body:new Uint8Array(raw).buffer}).formData();
    const encoded=form.get('envelope');if(typeof encoded!=='string'||encoded.length>65536)throw new BoundaryError(400,'invalid_envelope');
    let e:Record<string,any>;try{e=record(JSON.parse(encoded));}catch{throw new BoundaryError(400,'invalid_envelope');}
    const engine_identity=assertEngineGeneration(e.engine_identity,env);
    for(const n of ['account_id','device_id','challenge_id'])identifier(e[n]);
    const replacing=e.reference_mode==='replace_reference';
    const required=e.reference_mode==='first_registration'||replacing?3:e.reference_mode==='existing_reference'?1:0;
    if((replacing?e.purpose!=='replacement':e.reference_mode==='first_registration'?e.purpose!=='registration':!['registration','login'].includes(e.purpose))||e.protocol!=='lovelies-face-auth-verdict-v1'||e.policy_version!==env.FACE_AUTH_POLICY_VERSION||e.required_captures!==required||!required||
      !Array.isArray(e.capture_manifest)||e.capture_manifest.length!==required||!Number.isSafeInteger(e.expires_at)||e.expires_at<=Date.now()||
      e.expires_at>Date.now()+120000||typeof e.nonce!=='string'||!e.nonce)throw new BoundaryError(409,'face_challenge_invalid');
    const captures=[];let total=0;const seen=new Set<string>();
    for(let i=0;i<required;i++){
      const c=record(e.capture_manifest[i]);hash(c.sha256);const image=form.get(`capture_${i}`);
      if(c.index!==i||!(image instanceof File)||image.type!==c.mime||image.size!==c.byte_size||image.size<1||seen.has(c.sha256)||
        !['image/jpeg','image/png','image/webp'].includes(c.mime)||(total+=image.size)>8*1024*1024)throw new BoundaryError(400,'capture_manifest_invalid');
      seen.add(c.sha256);const bytes=new Uint8Array(await image.arrayBuffer());owned.push(bytes);
      if(await digest(bytes)!==c.sha256)throw new BoundaryError(400,'capture_digest_invalid');
      captures.push({bytes_base64:base64(bytes),mime:c.mime,sha256:c.sha256});
    }
    let reference_base64:string|undefined;
    if(required===1||replacing){hash(e.reference_digest);if(e.model_id!==env.MODEL_VERSION)throw new BoundaryError(409,'reference_model_changed');
      const file=form.get('reference');if(!(file instanceof File)||file.size<1||file.size>65536)throw new BoundaryError(400,'reference_required');
      const reference=new Uint8Array(await file.arrayBuffer());owned.push(reference);
      if(await digest(reference)!==e.reference_digest)throw new BoundaryError(409,'reference_changed');reference_base64=base64(reference);}
    const result=await inference(env,'/internal/face',{reference_mode:e.reference_mode,captures,
      ...(reference_base64?{reference_base64,reference_digest:e.reference_digest}:{})},engine_identity,request.signal);
    if(Date.now()>=e.expires_at||result.model_id!==env.MODEL_VERSION)throw new BoundaryError(409,'face_challenge_changed');
    if(typeof result.identity_verified!=='boolean')throw new BoundaryError(503,'face_result_invalid');
    const verdict={...e,engine_identity,verified_at:Date.now(),expires_at:e.expires_at,receipt_id:crypto.randomUUID().replaceAll('-',''),identity_verified:result.identity_verified};
    if(Object.hasOwn(result,'capture_rejection')) {
      if(!result.capture_rejection||typeof result.capture_rejection!=='object'||Array.isArray(result.capture_rejection))
        throw new BoundaryError(503,'face_result_invalid');
      const rejection=record(result.capture_rejection);
      if(result.identity_verified!==false||(Object.hasOwn(result,'reference_match')&&result.reference_match!==false)||
        (Object.hasOwn(result,'enrollment_verified')&&result.enrollment_verified!==false)||
        ['registered_reference','template_base64','template_sha256'].some(key=>Object.hasOwn(result,key))||
        Object.keys(rejection).length!==2||!Object.hasOwn(rejection,'code')||!Object.hasOwn(rejection,'capture_index')||
        !['no_face','multiple_faces','quality_low','invalid_image'].includes(rejection.code)||
        !Number.isSafeInteger(rejection.capture_index)||rejection.capture_index<0||rejection.capture_index>=required)
        throw new BoundaryError(503,'face_result_invalid');
      return json({...verdict,capture_rejection:{code:rejection.code,capture_index:rejection.capture_index},
        ...(required===1||replacing?{reference_match:false}:{}),...(required===3?{enrollment_verified:false}:{})});
    }
    if(required===1){
      if(typeof result.reference_match!=='boolean'||result.reference_match!==result.identity_verified)throw new BoundaryError(503,'face_result_invalid');
      return json({...verdict,reference_match:result.reference_match});
    }
    if(result.identity_verified!==true)return json({...verdict,enrollment_verified:false,...(replacing?{reference_match:false}:{})});
    if(replacing&&result.reference_match!==true)return json({...verdict,identity_verified:false,reference_match:false,enrollment_verified:false});
    if(result.enrollment_verified!==true||typeof result.template_base64!=='string'||result.template_base64.length>87384)throw new BoundaryError(503,'face_result_invalid');
    const bytes=Uint8Array.from(atob(result.template_base64),c=>c.charCodeAt(0));owned.push(bytes);
    if(bytes.length<1||bytes.length>65536||await digest(bytes)!==hash(result.template_sha256))throw new BoundaryError(503,'face_template_invalid');
    return json({...verdict,enrollment_verified:true,...(replacing?{reference_match:true}:{}),registered_reference:{revision:crypto.randomUUID(),model_id:env.MODEL_VERSION,
      template_sha256:result.template_sha256,template_base64:base64(bytes).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')}});
  }finally{for(const b of owned)b.fill(0);}
}
async function boundary(request:Request,handler:()=>Promise<Response>):Promise<Response> {
  try{return await handler();}catch(error){return json({error:{code:error instanceof BoundaryError?error.code:'private_model_unavailable'}},error instanceof BoundaryError?error.status:503);}
  finally{
    // Request teardown is local best effort, not proof that a producer or an
    // already dispatched inference has stopped. Never await its settlement.
    try{if(request.body&&!request.body.locked)void request.body.cancel().catch(()=>{});}catch{}
  }
}

export function createModelServices(env:Env):{face:ServiceFetcher;photo:PhotoProcessorFetcher;ready:(signal?:AbortSignal)=>Promise<boolean>;generation:()=>string}{
  return {
    generation:()=>engineGeneration(env),
    ready:async signal=>{try{await readiness(env,signal);return true;}catch{return false;}},
    face:{fetch:async(input,init)=>{const request=input instanceof Request?input:new Request(input,init);return boundary(request,()=>handleFace(request,env));}},
    photo:{fetch:async(input,init,assertAuthority)=>{const request=input instanceof Request?input:new Request(input,init);return boundary(request,()=>handlePhoto(request,env,assertAuthority));}},
  };
}
