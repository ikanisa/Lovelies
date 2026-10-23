/** Live local HTTP + real copied YuNet/SFace. Reference-portrait variants are
 * image fixtures, not camera/liveness/accuracy or physical-device evidence. */
import assert from 'node:assert/strict';
import { access,mkdir,readFile,writeFile } from 'node:fs/promises';
import { randomUUID,webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { faceCapturePayload,faceCompletionPayload,faceSigningBytes } from '../clients/backend/face-contracts.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),base=process.env.LOVELIES_TEST_API??'http://127.0.0.1:8787';
const api=new URL(base);if(api.hostname!=='127.0.0.1'||api.protocol!=='http:'||api.username||api.password||api.pathname!=='/'||api.search||api.hash)throw new Error('This test is confined to a local development API origin');
const output=process.env.LOVELIES_TEST_OUTPUT?path.resolve(root,process.env.LOVELIES_TEST_OUTPUT):path.join(root,'verification/cloudflare-native-port/real-face-journey.json');
try{await access(output);throw new Error('Journey evidence output already exists; select a new LOVELIES_TEST_OUTPUT path');}catch(error){if(error.code!=='ENOENT')throw error;}
await mkdir(path.dirname(output),{recursive:true,mode:0o700});
const target=route=>{const url=new URL(route,api);if(url.origin!==api.origin||url.username||url.password||url.hash)throw new Error('Backend path escaped the configured local API origin');return url;};
const actors=[];const checks=[];const pass=name=>checks.push({name,status:'passed'});const key=()=>randomUUID();
const sha=async b=>Buffer.from(await webcrypto.subtle.digest('SHA-256',b)).toString('hex');
const sign=async(k,body)=>Buffer.from(await webcrypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},k,faceSigningBytes(body))).toString('base64url');
async function call(route,{token,body,raw,headers={},method=body===undefined&&raw===undefined?'GET':'POST'}={},expected=200){
 const response=await fetch(target(route),{method,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(token?{Authorization:`Bearer ${token}`}:{ }),...headers},...(body===undefined?raw===undefined?{}:{body:raw}:{body:JSON.stringify(body)}),redirect:'manual',signal:AbortSignal.timeout(60000)});
 const result=await response.json();assert.equal(response.status,expected,`${route}: ${result.error?.code??result.status??'unexpected response'}`);return result;
}
const captures=await Promise.all([0,1,2].map(i=>readFile(path.join(root,`verification/cloudflare-native-port/fixtures/reference-selfie-${i}.jpg`))));
async function enroll(){
 const anonymous=await call('/auth/anonymous',{body:{}},201);const keys=await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const policy=await call('/auth/face/policy');const challenge=await call('/auth/face/registration/challenge',{token:anonymous.access_token,body:{device_public_jwk:await webcrypto.subtle.exportKey('jwk',keys.publicKey),consent:{purpose:'face_authentication',granted:true,policy_version:policy.policy_version}}},201);
 const manifests=[];
 for(let i=0;i<3;i++){const hash=await sha(captures[i]);manifests.push({index:i,sha256:hash,mime:'image/jpeg',byte_size:captures[i].length});
  const payload=faceCapturePayload(challenge,{index:i,sha256:hash,mime:'image/jpeg',byteSize:captures[i].length});
  await call(`/auth/face/proof/${challenge.challenge_id}/${i}`,{token:anonymous.access_token,method:'PUT',raw:captures[i],headers:{'Content-Type':'image/jpeg','X-Lovelies-Capture-SHA256':hash,'X-Lovelies-Capture-Bytes':String(captures[i].length),'X-Lovelies-Device-Signature':await sign(keys.privateKey,payload)}});
 }
 const completed=await call('/auth/face/registration/complete',{token:anonymous.access_token,body:{challenge_id:challenge.challenge_id,device_signature:await sign(keys.privateKey,faceCompletionPayload(challenge,manifests))}});
 assert.equal(completed.account_id,anonymous.account_id);assert.equal(completed.auth_method,'registered_face');
 await call('/me',{token:anonymous.access_token},401);
 const actor={...completed,privateKey:keys.privateKey,faceHandle:challenge.face_handle,deviceId:challenge.device_id};actors.push(actor);
 const photoPolicy=await call('/me/photo-preferences',{token:actor.access_token});assert.equal(typeof photoPolicy.policy_version,'string');assert(photoPolicy.policy_version.length);
 actor.photoPolicy=photoPolicy.policy_version;
 await call('/me/photo-preferences',{token:actor.access_token,body:{policy_version:actor.photoPolicy,receive_matches:true,photo_matching_consent:true,processing_consent:true,operation_key:key()}});
 return actor;
}
try{
 const health=await call('/health');assert.equal(health.database,'cloudflare_durable_object_sqlite');assert.equal(health.database_ready,true);pass('Actual workerd SQLite v2 authority');
 const owner=await enroll(),recipient=await enroll();pass('Real model enrollment automatically upgrades same anonymous account; no OTP/liveness verdict');
 await call('/me/profile',{token:recipient.access_token,method:'PATCH',body:{name:'Local model recipient',operation_key:key()}});
 const upload=await call('/uploads/session',{token:owner.access_token,body:{source:'personal',content_type:'image/jpeg',byte_size:captures[1].length,title:'Local reference image fixture',operation_key:key()}},201);
 await call(upload.upload_url,{token:owner.access_token,method:'PUT',raw:captures[1],headers:{'Content-Type':'image/jpeg'}});
 await call(upload.complete_url,{token:owner.access_token,body:{operation_key:key()}},202);
 let status;for(let i=0;i<100;i++){status=await call(`/uploads/${upload.asset_id}/status`,{token:owner.access_token});if(['ready','failed'].includes(status.status))break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(status.status,'ready',status.error_code);pass('Real private processor binds source/templates and publishes normalized rendition');
 assert.equal((await call('/me/gallery',{token:recipient.access_token})).gallery_items.length,0);pass('Matching proposal creates no recipient access');
 const community=(actor,action,payload={})=>call('/community/action',{token:actor.access_token,body:{action,payload}});
 const snapshot=await community(owner,'sharing.snapshot',{asset_ids:[upload.asset_id],operation_key:key()});assert.equal(snapshot.status,'ready');assert.equal(snapshot.snapshot.pairs.length,1);
 const preview=await community(owner,'sharing.preview',{snapshot_id:snapshot.snapshot.id,snapshot_version:snapshot.snapshot.version,selected_asset_ids:[upload.asset_id],selected_recipient_ids:[recipient.account_id],excluded_pairs:[],draft_version:1,operation_key:key()});assert.equal(preview.status,'ready');
 const operation=key(),outcome=await community(owner,'sharing.commit',{preview_id:preview.preview.id,preview_version:preview.preview.version,draft_version:1,operation_key:operation});
 assert.equal(outcome.status,'pending_acceptance');assert.equal((await call('/me/gallery',{token:recipient.access_token})).gallery_items.length,0);pass('Contributor exact subset approval still awaits recipient acceptance');
 const inbox=await community(recipient,'inbox');const request=inbox.items.find(item=>item.person.id===owner.account_id);assert(request);
 await community(recipient,'request.decide',{request_id:request.id,decision:'accept',operation_key:key()});
 const gallery=await call('/me/gallery',{token:recipient.access_token});assert.equal(gallery.gallery_items.length,1);assert.equal(gallery.gallery_items[0].media_asset_id,upload.asset_id);pass('Acceptance releases only the approved photo');
 const protectedPreview=await fetch(target(`/community/media/${upload.asset_id}/preview`),{headers:{Authorization:`Bearer ${recipient.access_token}`},redirect:'manual',signal:AbortSignal.timeout(60000)});assert.equal(protectedPreview.status,200);assert(protectedPreview.headers.get('content-type').startsWith('image/jpeg'));await protectedPreview.arrayBuffer();pass('Actual reduced private rendition is readable after current approval');
 await call('/downloads/sign',{token:recipient.access_token,body:{asset_id:upload.asset_id,operation_key:key()}},403);pass('Original download remains blocked without verified store entitlement');
 await call('/auth/logout',{token:recipient.access_token,body:{}});await call('/me',{token:recipient.access_token},401);
 const challenge=await call('/auth/face/challenge',{body:{face_handle:recipient.faceHandle,device_id:recipient.deviceId}},201);const hash=await sha(captures[0]);
 const manifest=[{index:0,sha256:hash,mime:'image/jpeg',byte_size:captures[0].length}];
 await call(`/auth/face/proof/${challenge.challenge_id}/0`,{method:'PUT',raw:captures[0],headers:{'Content-Type':'image/jpeg','X-Lovelies-Capture-SHA256':hash,'X-Lovelies-Capture-Bytes':String(captures[0].length),'X-Lovelies-Device-Signature':await sign(recipient.privateKey,faceCapturePayload(challenge,{index:0,sha256:hash,mime:'image/jpeg',byteSize:captures[0].length}))}});
 const login=await call('/auth/face/complete',{body:{challenge_id:challenge.challenge_id,device_signature:await sign(recipient.privateKey,faceCompletionPayload(challenge,manifest))}});recipient.access_token=login.access_token;assert.equal(login.account_id,recipient.account_id);pass('Fresh registered-face comparison after logout authenticates original account');
 await call('/auth/face/complete',{body:{challenge_id:challenge.challenge_id,device_signature:await sign(recipient.privateKey,faceCompletionPayload(challenge,manifest))}},409);pass('One-use challenge cannot be replayed');
 console.log(JSON.stringify({checks:checks.length,passed:checks.length,real_models:true,camera_or_liveness_evidence:false,hosted:false},null,2));
 await writeFile(output,JSON.stringify({verified_at:new Date().toISOString(),input:'Provided screen-reference portrait variants, not camera captures',api_origin:api.origin,runtime:'Actual workerd / SQLite DO / R2 / Queue / private ML Worker / real YuNet+SFace inference',checks},null,2)+'\n',{flag:'wx',mode:0o600});
}finally{
 for(const actor of actors){try{if(actor.photoPolicy)await call('/me/photo-preferences',{token:actor.access_token,body:{policy_version:actor.photoPolicy,receive_matches:false,photo_matching_consent:false,processing_consent:false,operation_key:key()}});}catch{}finally{try{await call('/auth/logout',{token:actor.access_token,body:{}});}catch{}}}
 for(const bytes of captures)bytes.fill(0);
}
