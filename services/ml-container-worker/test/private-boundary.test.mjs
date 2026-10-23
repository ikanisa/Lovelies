import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { Miniflare,Response as RuntimeResponse } from 'miniflare';
import { builtinModules } from 'node:module';
const hash=async(bytes)=>Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
async function harness(t,infer=async()=>({identity_verified:false,model_id:'opencv-yunet-sface-2021dec-v1'})){
 const bundle=await build({entryPoints:[new URL('../src/index.ts',import.meta.url).pathname],write:false,bundle:true,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers',...builtinModules.flatMap(n=>[n,`node:${n}`])],logLevel:'silent'});
 let calls=0;
 const common={modules:true,compatibilityDate:'2026-07-21',compatibilityFlags:['nodejs_compat']};
 const mf=new Miniflare({workers:[{...common,name:'private-test-caller',script:`export default {fetch(request,env){const path=new URL(request.url).pathname;
 if(path==='/fixture/face')return env.FACE.fetch(new Request('https://face-auth.internal/v1/face-auth/verify',request));
 if(path==='/fixture/photo')return env.PHOTO.fetch(new Request('https://photo-processor.internal/process',request));return env.MODEL.fetch(request);}};`,serviceBindings:{FACE:{name:'private-model',entrypoint:'FaceVerifier'},PHOTO:{name:'private-model',entrypoint:'PhotoProcessor'},MODEL:'private-model'}},
 {...common,name:'private-model',script:bundle.outputFiles[0].text,r2Buckets:{PHOTOS:'PHOTOS',QUARANTINE:'QUARANTINE'},bindings:{MODEL_VERSION:'opencv-yunet-sface-2021dec-v1',FACE_AUTH_POLICY_VERSION:'registered-face-opencv-v1'},serviceBindings:{INFERENCE:async request=>{calls++;const input=await request.json(),value=await infer(input);if(value instanceof Response)return new RuntimeResponse(await value.arrayBuffer(),{status:value.status,headers:value.headers});return new RuntimeResponse(JSON.stringify(value),{headers:{'content-type':'application/json'}});}}}]});
 await mf.ready;t.after(()=>mf.dispose());return {mf,calls:()=>calls,send:async(route,input)=>{if(input?.body instanceof FormData){const serialized=new Request('http://local'+route,input);input={...input,headers:Object.fromEntries(serialized.headers),body:await serialized.arrayBuffer()};}return mf.dispatchFetch('http://local'+route,input);}};
}
async function form(){
 const f=new FormData(),captures=[];
 for(let index=0;index<3;index++){const bytes=new TextEncoder().encode('synthetic-protocol-capture-'+index);const sha256=await hash(bytes);captures.push({index,sha256,mime:'image/png',byte_size:bytes.length});f.set('capture_'+index,new Blob([bytes],{type:'image/png'}),'capture_'+index);}
 const e={protocol:'lovelies-face-auth-verdict-v1',account_id:crypto.randomUUID(),device_id:crypto.randomUUID(),challenge_id:crypto.randomUUID(),nonce:crypto.randomUUID(),purpose:'registration',device_revision:crypto.randomUUID(),profile_id:null,profile_revision:null,model_id:null,reference_digest:null,reference_mode:'first_registration',required_captures:3,policy_version:'registered-face-opencv-v1',expires_at:Date.now()+90000,capture_manifest:captures};f.set('envelope',JSON.stringify(e));return {f,e};
}
test('model Worker has no public inference, vector directory or enrolment route',async t=>{
 const h=await harness(t);for(const p of ['/ready','/internal/face','/v1/face-auth/verify','/v1/models','/faces'])assert.equal((await h.send(p)).status,404);assert.equal(h.calls(),0);
});
test('expired or changed private challenge and corrupted capture bytes stop before inference',async t=>{
 const h=await harness(t);
 for(const mutate of [e=>e.expires_at=Date.now()-1,e=>e.policy_version='wrong-policy',e=>e.capture_manifest[1].sha256='0'.repeat(64)]){
  const {f,e}=await form();mutate(e);f.set('envelope',JSON.stringify(e));const r=await h.send('/fixture/face',{method:'POST',body:f});assert([400,409].includes(r.status),JSON.stringify({status:r.status,error:await r.clone().json()}));assert.equal(r.headers.get('cache-control'),'no-store');
 }assert.equal(h.calls(),0);
});
test('private identity mismatch remains a negative bound verdict, with no invented liveness field',async t=>{
 const h=await harness(t),{f,e}=await form();const r=await h.send('/fixture/face',{method:'POST',body:f});assert.equal(r.status,200,JSON.stringify(await r.clone().json()));const verdict=await r.json();assert.equal(verdict.identity_verified,false);assert.equal(verdict.challenge_id,e.challenge_id);assert.equal(verdict.enrollment_verified,false);assert(!Object.keys(verdict).some(k=>k.startsWith('pad_')||k.startsWith('injection_')));assert.equal(h.calls(),1);
});
for(const code of ['no_face','multiple_faces','quality_low','invalid_image'])test('private bounded capture reason '+code+' preserves the exact envelope and no template',async t=>{
 const h=await harness(t,async()=>({identity_verified:false,model_id:'opencv-yunet-sface-2021dec-v1',capture_rejection:{code,capture_index:1}})),{f,e}=await form();
 const response=await h.send('/fixture/face',{method:'POST',body:f});assert.equal(response.status,200);
 const verdict=await response.json();assert.deepEqual(verdict.capture_rejection,{code,capture_index:1});
 assert.equal(verdict.challenge_id,e.challenge_id);assert.deepEqual(verdict.capture_manifest,e.capture_manifest);
 assert.equal(verdict.identity_verified,false);assert.equal(verdict.enrollment_verified,false);
 for(const denied of ['registered_reference','template_base64','template_sha256','quality_score','embeddings'])assert(!Object.hasOwn(verdict,denied));
});
test('malformed, unbound or positive capture-rejection claims fail closed at the private Worker',async t=>{
 const mutations=[
  value=>value.capture_rejection=null,value=>value.capture_rejection=[],value=>value.capture_rejection='no_face',
  value=>value.capture_rejection.code='private-secret-reference',value=>value.capture_rejection.capture_index=-1,
  value=>value.capture_rejection.capture_index=3,value=>value.capture_rejection.capture_index=true,
  value=>value.capture_rejection.capture_index='0',value=>value.capture_rejection.capture_index=0.5,
  value=>delete value.capture_rejection.capture_index,value=>value.capture_rejection.score=0.1,
  value=>value.identity_verified=true,value=>value.reference_match=true,value=>value.enrollment_verified=true,
  value=>value.reference_match='true',value=>value.enrollment_verified=1,
  value=>value.registered_reference=null,value=>value.template_base64='private-template',value=>value.template_sha256='a'.repeat(64),
 ];
 let mutate;
 const h=await harness(t,async()=>{const value={identity_verified:false,model_id:'opencv-yunet-sface-2021dec-v1',capture_rejection:{code:'no_face',capture_index:0}};mutate(value);return value;});
 for(mutate of mutations){const {f}=await form();const response=await h.send('/fixture/face',{method:'POST',body:f});
  assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:{code:'face_result_invalid'}});
 }
 assert.equal(h.calls(),mutations.length);
});
test('an inference redirect cannot establish a trusted face result',async t=>{
 const h=await harness(t,async()=>new Response(null,{status:302,headers:{location:'https://untrusted.invalid'}})),{f}=await form();const r=await h.send('/fixture/face',{method:'POST',body:f});assert.equal(r.status,503);assert.equal(h.calls(),1);
});
test('photo processing rejects a changed R2 digest or source version before model execution',async t=>{
 const h=await harness(t),bucket=await h.mf.getR2Bucket('QUARANTINE','private-model');const bytes=new TextEncoder().encode('protocol-source'),checksum=await hash(bytes),version=crypto.randomUUID();
 await bucket.put('source/private-test',bytes,{httpMetadata:{contentType:'image/jpeg'},customMetadata:{source_version:version,source_checksum_sha256:checksum}});
 const p={attempt_id:crypto.randomUUID(),asset_id:crypto.randomUUID(),source_version:version,source_checksum_sha256:checksum,model_version:'opencv-yunet-sface-2021dec-v1',nonce:'private-test-nonce',quarantine_key:'source/private-test',profiles:[]};
 for(const input of [{...p,source_checksum_sha256:'0'.repeat(64)},{...p,source_version:crypto.randomUUID()}])assert.equal((await h.send('/fixture/photo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)})).status,409);assert.equal(h.calls(),0);
});

async function replacingForm() {
 const {f,e}=await form(),reference=new TextEncoder().encode('synthetic-private-old-reference');
 Object.assign(e,{purpose:'replacement',reference_mode:'replace_reference',profile_id:crypto.randomUUID(),
  profile_revision:crypto.randomUUID(),model_id:'opencv-yunet-sface-2021dec-v1',reference_digest:await hash(reference)});
 f.set('reference',new Blob([reference],{type:'application/octet-stream'}),'registered_reference');
 f.set('envelope',JSON.stringify(e));return {f,e,reference};
}
test('replacement boundary sends three captures and the exact old reference before deriving a bound new reference',async t=>{
 const template=new TextEncoder().encode('synthetic-new-derived-reference');let observed;
 const h=await harness(t,async input=>{
  observed=input;return {model_id:'opencv-yunet-sface-2021dec-v1',identity_verified:true,reference_match:true,
   enrollment_verified:true,template_base64:Buffer.from(template).toString('base64'),template_sha256:await hash(template)};
 });
 const {f,e,reference}=await replacingForm(),response=await h.send('/fixture/face',{method:'POST',body:f});
 assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
 const result=await response.json();assert.equal(observed.reference_mode,'replace_reference');
 assert.equal(observed.captures.length,3);assert.equal(observed.reference_digest,e.reference_digest);
 assert.deepEqual(Buffer.from(observed.reference_base64,'base64'),Buffer.from(reference));
 assert.equal(result.reference_match,true);assert.equal(result.enrollment_verified,true);
 assert.equal(result.challenge_id,e.challenge_id);assert.equal(result.profile_revision,e.profile_revision);
 assert.notEqual(result.registered_reference.revision,e.profile_revision);
 assert.equal(result.registered_reference.template_sha256,await hash(template));
 assert.deepEqual(Buffer.from(result.registered_reference.template_base64,'base64url'),Buffer.from(template));
 assert.equal(h.calls(),1);
});
test('replacement cannot downgrade its purpose or omit/corrupt the registered reference before inference',async t=>{
 const h=await harness(t);
 for(const mutate of [(f,e)=>e.purpose='registration',(f,e)=>f.delete('reference'),
  (f,e)=>e.reference_digest='0'.repeat(64),(f,e)=>e.required_captures=1]){
  const {f,e}=await replacingForm();mutate(f,e);f.set('envelope',JSON.stringify(e));
  const response=await h.send('/fixture/face',{method:'POST',body:f});assert([400,409].includes(response.status));
 }assert.equal(h.calls(),0);
});
