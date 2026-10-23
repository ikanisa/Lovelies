// Adapted from the active private ML boundary. Storage stays in Supabase;
// inference is an authenticated private HTTP service, never a Cloudflare binding.
import type {PrivateBucket,PrivateObject,ServiceFetcher} from './types.ts';
interface Env { PHOTOS:PrivateBucket; QUARANTINE:PrivateBucket; MODEL_VERSION:string; FACE_AUTH_POLICY_VERSION:string; INFERENCE:ServiceFetcher; }
class BoundaryError extends Error { constructor(readonly status:number, readonly code:string) { super(code); } }
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
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes).buffer))].map(v=>v.toString(16).padStart(2,'0')).join('');
}
const base64=(bytes:Uint8Array):string=>{
  let value=''; for(let start=0; start<bytes.length; start+=32768) value+=String.fromCharCode(...bytes.subarray(start,start+32768));
  return btoa(value);
};
async function bounded(stream:ReadableStream<Uint8Array>|null,limit:number):Promise<Uint8Array> {
  if (!stream) throw new BoundaryError(400,'body_required');
  const reader=stream.getReader(),chunks:Uint8Array[]=[];let length=0;
  try {
    for(;;){const n=await reader.read();if(n.done) break; length+=n.value.length;
      if(length>limit){n.value.fill(0);throw new BoundaryError(413,'body_too_large');}chunks.push(n.value);}
    const bytes=new Uint8Array(length); let cursor=0;for(const c of chunks){bytes.set(c,cursor);cursor+=c.length;}return bytes;
  } finally {for(const c of chunks)c.fill(0);void reader.cancel().catch(()=>{});reader.releaseLock();}
}
async function body(request:Request,limit:number):Promise<Record<string,any>> {
  if(!/^application\/json(?:;|$)/i.test(request.headers.get('content-type')??''))throw new BoundaryError(415,'json_required');
  const bytes=await bounded(request.body,limit);
  try{return record(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}
  catch(error){if(error instanceof BoundaryError)throw error;throw new BoundaryError(400,'invalid_json');}
  finally{bytes.fill(0);}
}
function configured(env:Env):void {
  if(env.MODEL_VERSION!=='opencv-yunet-sface-2021dec-v1' || !env.PHOTOS || !env.QUARANTINE ||
    !env.INFERENCE)throw new BoundaryError(503,'face_model_unavailable');
}
async function inference(env:Env,path:string,payload:Record<string,unknown>,shard:string):Promise<Record<string,any>> {
  configured(env); const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new BoundaryError(503,'inference_timeout'));},55_000);});
  try {
    const request=new Request(`http://container${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),redirect:'manual',signal:controller.signal});
    const service=env.INFERENCE;
    const response=await Promise.race([service.fetch(request),timeout]);
    if(!response.ok||response.redirected)throw new BoundaryError(response.status===401?401:503,'inference_unavailable');
    return await Promise.race([body(response as unknown as Request,6*1024*1024),timeout]);
  }finally{clearTimeout(timer!);controller.abort();}
}
async function privateObject(bucket:PrivateBucket,key:string,limit:number,expected:string,owned:Uint8Array[]):Promise<{bytes:Uint8Array,object:PrivateObject}> {
  const object=await bucket.get(key);
  if(!object||object.size<1||object.size>limit)throw new BoundaryError(409,'private_object_unavailable');
  const bytes=await bounded(object.body,limit);owned.push(bytes);
  if(bytes.length!==object.size||await digest(bytes)!==expected)throw new BoundaryError(409,'private_object_changed');
  return {bytes,object};
}
async function handlePhoto(request:Request,env:Env):Promise<Response> {
  if(request.method!=='POST'||new URL(request.url).pathname!=='/process')throw new BoundaryError(404,'route_not_found');
  const p=await body(request,1024*1024);configured(env);
  for(const name of ['attempt_id','asset_id','source_version'])identifier(p[name]);
  hash(p.source_checksum_sha256);
  if(p.model_version!==env.MODEL_VERSION||typeof p.nonce!=='string'||p.nonce.length>128||!p.nonce||
    typeof p.quarantine_key!=='string'||!p.quarantine_key.startsWith('source/')||!Array.isArray(p.profiles)||p.profiles.length>1000)
    throw new BoundaryError(409,'processing_origin_invalid');
  const owned:Uint8Array[]=[];
  try {
    const source=await privateObject(env.QUARANTINE,p.quarantine_key,20*1024*1024,p.source_checksum_sha256,owned);
    if(source.object.customMetadata?.source_version!==p.source_version||source.object.customMetadata?.source_checksum_sha256!==p.source_checksum_sha256)
      throw new BoundaryError(409,'source_version_changed');
    const mime=source.object.httpMetadata?.contentType;
    if(!['image/jpeg','image/png','image/webp'].includes(mime??''))throw new BoundaryError(415,'image_required');
    const profiles=[];const seen=new Set<string>();
    for(const v of p.profiles){const profile=record(v);identifier(profile.account_id);identifier(profile.profile_id);hash(profile.template_digest);
      if(seen.has(profile.account_id)||profile.model_id!==env.MODEL_VERSION||typeof profile.revision!=='string'||!profile.revision||profile.revision.length>128||
        typeof profile.template_key!=='string'||!profile.template_key.startsWith(`registered-face/${profile.account_id}/${profile.profile_id}/`))
        throw new BoundaryError(409,'matching_profile_invalid');
      seen.add(profile.account_id);
      const template=await privateObject(env.PHOTOS,profile.template_key,64*1024,profile.template_digest,owned);
      profiles.push({account_id:profile.account_id,profile_id:profile.profile_id,revision:profile.revision,model_id:profile.model_id,
        template_digest:profile.template_digest,template_base64:base64(template.bytes)});
    }
    const result=await inference(env,'/internal/photo',{asset_id:p.asset_id,source:{mime,sha256:p.source_checksum_sha256,bytes_base64:base64(source.bytes)},profiles},'photo-primary');
    if(result.model_version!==env.MODEL_VERSION||!Array.isArray(result.matches)||result.matches.length>p.profiles.length)throw new BoundaryError(503,'processor_result_invalid');
    return json({attempt_id:p.attempt_id,nonce:p.nonce,asset_id:p.asset_id,source_version:p.source_version,
      source_checksum_sha256:p.source_checksum_sha256,model_version:p.model_version,preview:result.preview,matches:result.matches});
  }finally{for(const b of owned)b.fill(0);}
}
async function handleFace(request:Request,env:Env):Promise<Response> {
  if(request.method==='GET'&&new URL(request.url).pathname==='/ready'){configured(env);return json({available:true,model_version:env.MODEL_VERSION,liveness_required:false});}
  if(request.method!=='POST'||new URL(request.url).pathname!=='/v1/face-auth/verify')throw new BoundaryError(404,'route_not_found');
  configured(env); if(!env.FACE_AUTH_POLICY_VERSION)throw new BoundaryError(503,'face_policy_unavailable');
  const raw=await bounded(request.body,12*1024*1024),owned:Uint8Array[]=[raw];
  try {
    const form=await new Request('http://private/face',{method:'POST',headers:{'Content-Type':request.headers.get('content-type')??''},body:new Uint8Array(raw).buffer}).formData();
    const encoded=form.get('envelope');if(typeof encoded!=='string'||encoded.length>65536)throw new BoundaryError(400,'invalid_envelope');
    let e:Record<string,any>;try{e=record(JSON.parse(encoded));}catch{throw new BoundaryError(400,'invalid_envelope');}
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
      ...(reference_base64?{reference_base64,reference_digest:e.reference_digest}:{})},'face-primary');
    if(Date.now()>=e.expires_at||result.model_id!==env.MODEL_VERSION)throw new BoundaryError(409,'face_challenge_changed');
    if(typeof result.identity_verified!=='boolean')throw new BoundaryError(503,'face_result_invalid');
    const verdict={...e,verified_at:Date.now(),expires_at:e.expires_at,receipt_id:crypto.randomUUID().replaceAll('-',''),identity_verified:result.identity_verified};
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
    if(required===1)return json({...verdict,reference_match:result.reference_match===true});
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
  finally{if(request.body&&!request.body.locked)await request.body.cancel().catch(()=>{});}
}

export function createModelServices(env:Env):{face:ServiceFetcher;photo:ServiceFetcher}{
  return {
    face:{fetch:async(input,init)=>{const request=input instanceof Request?input:new Request(input,init);return boundary(request,()=>handleFace(request,env));}},
    photo:{fetch:async(input,init)=>{const request=input instanceof Request?input:new Request(input,init);return boundary(request,()=>handlePhoto(request,env));}},
  };
}
