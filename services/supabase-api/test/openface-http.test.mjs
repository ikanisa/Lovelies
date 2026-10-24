/** Actual authenticated private HTTP + native OpenCV inference through the
 * Supabase application engine. PGlite/memory Storage are declared test adapters;
 * this never establishes hosted Storage, camera or recognition acceptance. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {startHarness,deviceEnvelope,sign,sha256} from './runtime-harness.mjs';
import {AuthenticatedService} from '../src/service-fetcher.ts';
import {createModelServices} from '../src/model-services.ts';
import {INFERENCE_MODEL_ID} from '../src/inference-contract.ts';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const enabled=process.env.RUN_OPENFACE_HTTP_TESTS==='1';
const key=()=>crypto.randomUUID();
const pause=ms=>new Promise(done=>setTimeout(done,ms));
async function unusedPort(){
 const listener=createServer();await new Promise((done,fail)=>{listener.once('error',fail);listener.listen(0,'127.0.0.1',done);});
 const port=listener.address().port;await new Promise(done=>listener.close(done));return port;
}
async function stop(child){
 if(child.exitCode!==null||child.signalCode)return;
 const ended=new Promise(done=>child.once('exit',done));child.kill('SIGTERM');
 await Promise.race([ended,pause(5000)]);
 if(child.exitCode===null&&!child.signalCode){child.kill('SIGKILL');await ended;}
}

test('real OpenFace HTTP service verifies signed same-account enrollment/login and approved photo delivery',
 {skip:!enabled,timeout:120_000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'lovelies-openface-http-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const python=resolve(root,'services/ml-face/.venv/bin/python');
 const generated=spawnSync(python,['-c',[
  'from pathlib import Path',
  'from PIL import Image, ImageEnhance',
  'import sys',
  'source, output = Path(sys.argv[1]), Path(sys.argv[2])',
  'for label, filename in (("a","person02.jpg"),("b","portrait.jpg")):',
  ' with Image.open(source / filename) as original:',
  '  for index in range(6):',
  '   image=ImageEnhance.Brightness(original.convert("RGB")).enhance(1+index*0.025)',
  '   image.save(output / (label+str(index)+".jpg"),format="JPEG",quality=93-index)',
 ].join('\n'),join(root,'shared/assets'),directory],{encoding:'utf8'});
 assert.equal(generated.status,0,'Could not generate declared engineering stills');
 const [captures,otherCaptures]=await Promise.all(['a','b'].map(label=>Promise.all(
  [0,1,2,3,4,5].map(index=>readFile(join(directory,label+index+'.jpg'))))));
 t.after(()=>[...captures,...otherCaptures].forEach(bytes=>bytes.fill(0)));
 const port=await unusedPort(),secret=randomBytes(32).toString('base64url');
 const origin=`http://127.0.0.1:${port}`;
 const child=spawn(python,['-m','uvicorn','lovelies_ml_face.app:app','--host','127.0.0.1','--port',String(port),'--no-access-log'],{
  cwd:join(root,'services/ml-face'),env:{...process.env,PYTHONPATH:join(root,'services/ml-face/src'),
   APP_ENV:'local',ML_USE_DETERMINISTIC_SIMULATOR:'false',ML_DEPLOYMENT_TRANSPORT:'https_service',ML_INFERENCE_SECRET:secret},
  stdio:['ignore','ignore','pipe'],
 });
 let diagnostic='';child.stderr.on('data',chunk=>{if(diagnostic.length<32768)diagnostic+=chunk.toString();});
 t.after(()=>stop(child));
 let loaded;
 const deadline=Date.now()+60_000;
 while(Date.now()<deadline){
  if(child.exitCode!==null)throw new Error('Private inference startup failed: '+diagnostic);
  try{const response=await fetch(origin+'/ready',{headers:{Authorization:'Bearer '+secret},signal:AbortSignal.timeout(1000)});
   if(response.ok){loaded=await response.json();break;}}
  catch{}
  await pause(50);
 }
 assert(loaded,'Private inference did not become ready');
 assert.equal((await fetch(origin+'/ready')).status,401);
 assert.equal((await fetch(origin+'/ready',{headers:{Authorization:'Bearer invalid'}})).status,401);
 const h=await startHarness({vars:{PHOTO_MODEL_VERSION:INFERENCE_MODEL_ID}});t.after(()=>h.close());
 const service=new AuthenticatedService(origin,secret);
 const models=createModelServices({PHOTOS:h.env.PHOTOS,QUARANTINE:h.env.QUARANTINE,
  MODEL_VERSION:INFERENCE_MODEL_ID,FACE_AUTH_POLICY_VERSION:h.env.FACE_AUTH_POLICY_VERSION,
  ENGINE_ARTIFACT_SHA256:loaded.engine_artifact_sha256,PROCESSING_FINGERPRINT:loaded.processing_fingerprint,INFERENCE:service});
 Object.assign(h.env,{FACE_AUTH_VERIFIER:models.face,PHOTO_PROCESSOR:models.photo,MODEL_SERVICE_READINESS:models.ready});
 assert.equal((await h.json('/ready')).inference_ready,true);
 const sendCaptures=async(person,challenge,stills,token)=>{
  const manifest=[];
  for(let index=0;index<stills.length;index++){
   const bytes=stills[index],hash=await sha256(bytes);
   manifest.push({index,sha256:hash,mime:'image/jpeg',byte_size:bytes.length});
   await h.json(`/auth/face/proof/${challenge.challenge_id}/${index}`,{method:'PUT',token,raw:bytes,
    headers:{'content-type':'image/jpeg','x-lovelies-capture-sha256':hash,'x-lovelies-capture-bytes':String(bytes.length),
     'x-lovelies-device-signature':await sign(person.privateKey,{...deviceEnvelope(challenge),step:'capture',capture_index:index,
      capture_sha256:hash,mime:'image/jpeg',byte_size:bytes.length})}});
  }
  return {challenge_id:challenge.challenge_id,device_signature:await sign(person.privateKey,
   {...deviceEnvelope(challenge),step:'complete',capture_manifest:manifest})};
 };
 const enroll=async stills=>{
  const anonymous=await h.anonymous(),keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const challenge=await h.json('/auth/face/registration/challenge',{token:anonymous.access_token,body:{
   device_public_jwk:await crypto.subtle.exportKey('jwk',keys.publicKey),
   consent:{purpose:'face_authentication',granted:true,policy_version:h.env.FACE_AUTH_POLICY_VERSION}}},201);
  const person={privateKey:keys.privateKey,deviceId:challenge.device_id,faceHandle:challenge.face_handle};
  const completion=await sendCaptures(person,challenge,stills.slice(0,3),anonymous.access_token);
  const result=await h.json('/auth/face/registration/complete',{token:anonymous.access_token,body:completion});
  assert.equal(result.account_id,anonymous.account_id);assert.equal(result.auth_method,'registered_face');
  await h.json('/me',{token:anonymous.access_token},401);
  // Stored still encodings are fixtures, not separate optical captures.
  return {...person,...result,token:result.access_token};
 };
 const owner=await enroll(otherCaptures),recipient=await enroll(captures);
 for(const actor of [owner,recipient])await h.json('/me/photo-preferences',{token:actor.token,body:{
  policy_version:h.env.PHOTO_CONSENT_POLICY_VERSION,receive_matches:true,processing_consent:true,
  photo_matching_consent:true,operation_key:key()}});
 const templateRows=await h.storage.exec('SELECT template_key,template_digest FROM face_profiles');
 assert.equal(templateRows.length,2);
 for(const row of templateRows){
  const object=await h.env.PHOTOS.get(row.template_key),bytes=await object.arrayBuffer();
  assert.equal(await sha256(bytes),row.template_digest);
  const template=JSON.parse(new TextDecoder().decode(bytes));
  assert.equal(template.protocol,'lovelies-face-template-v2');
  assert.equal(template.processing_fingerprint,loaded.processing_fingerprint);
 }
 const photo=captures[4],upload=await h.json('/uploads/session',{token:owner.token,body:{source:'personal',content_type:'image/jpeg',
  byte_size:photo.length,title:'Declared engineering portrait fixture',operation_key:key()}},201);
 await h.json(upload.upload_url,{method:'PUT',token:owner.token,raw:photo,headers:{'content-type':'image/jpeg'}});
 await h.json(upload.complete_url,{token:owner.token,body:{operation_key:key()}},202);
 let state;const processingDeadline=Date.now()+20_000;
 do{state=await h.json(`/uploads/${upload.asset_id}/status`,{token:owner.token});
  if(['ready','failed'].includes(state.status))break;await pause(20);
 }while(Date.now()<processingDeadline);
 assert.equal(state.status,'ready',state.error_code);
 assert.equal((await h.json('/me/gallery',{token:recipient.token})).gallery_items.length,0);
 const snapshot=(await h.community(owner.token,'sharing.snapshot',{asset_ids:[upload.asset_id],operation_key:key()})).snapshot;
 assert.equal(snapshot.pairs.length,1);
 const preview=(await h.community(owner.token,'sharing.preview',{snapshot_id:snapshot.id,snapshot_version:snapshot.version,
  selected_asset_ids:[upload.asset_id],selected_recipient_ids:[recipient.account_id],excluded_pairs:[],draft_version:1,operation_key:key()})).preview;
 const commit={preview_id:preview.id,preview_version:preview.version,draft_version:1,operation_key:key()};
 const first=await h.community(owner.token,'sharing.commit',commit);
 assert.equal(first.status,'pending_acceptance');
 assert.deepEqual(await h.community(owner.token,'sharing.commit',commit),first);
 assert.equal((await h.storage.exec('SELECT COUNT(*) n FROM media_grants'))[0].n,0);
 const inbox=await h.community(recipient.token,'inbox'),request=inbox.items.find(item=>item.person.id===owner.account_id);
 assert(request);
 await h.community(recipient.token,'request.decide',{request_id:request.id,decision:'accept',operation_key:key()});
 assert.equal((await h.storage.exec('SELECT COUNT(*) n FROM media_grants'))[0].n,1);
 assert.equal((await h.json('/me/gallery',{token:recipient.token})).gallery_items.length,1);
 await h.json('/downloads/sign',{token:recipient.token,body:{asset_id:upload.asset_id,operation_key:key()}},403);
 await h.json('/auth/logout',{token:recipient.token,body:{}});
 const wrongChallenge=await h.json('/auth/face/challenge',{body:{face_handle:recipient.faceHandle,device_id:recipient.deviceId}},201);
 const wrongProof=await sendCaptures(recipient,wrongChallenge,[otherCaptures[5]]);
 const wrong=await h.json('/auth/face/complete',{body:wrongProof},401);
 assert.equal(wrong.error.code,'face_verification_failed');
 const challenge=await h.json('/auth/face/challenge',{body:{face_handle:recipient.faceHandle,device_id:recipient.deviceId}},201);
 const proof=await sendCaptures(recipient,challenge,[captures[5]]);
 const signedIn=await h.json('/auth/face/complete',{body:proof});
 assert.equal(signedIn.account_id,recipient.account_id);
 await h.json('/auth/face/complete',{body:proof},409);
 t.diagnostic('Real HTTP/OpenFace registration, photo proposals, exact approval/acceptance, idempotent grant and fresh returning comparison passed; PGlite and memory Storage; no hosted/device/accuracy acceptance.');
});
