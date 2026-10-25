/** Reusable real-engine fixture runtime for the existing backend/native journeys.
 * Synthetic local accounts and transformed supplied portraits only. */
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createServer as netServer} from 'node:net';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {startHarness,deviceEnvelope,sign,sha256} from './runtime-harness.mjs';
import {privateStorageFromEnvironment} from './openface-storage.mjs';
import {AuthenticatedService} from '../src/service-fetcher.ts';
import {createModelServices} from '../src/model-services.ts';
import {INFERENCE_MODEL_ID} from '../src/inference-contract.ts';
import {AUDIENCE_POLICY} from '../src/audience.ts';

const root=fileURLToPath(new URL('../../../',import.meta.url));
export const pause=ms=>new Promise(done=>setTimeout(done,ms));
const python=resolve(root,'services/ml-face/.venv/bin/python');
async function unusedPort(){
 const listener=netServer();await new Promise((done,fail)=>{listener.once('error',fail);listener.listen(0,'127.0.0.1',done);});
 const port=listener.address().port;await new Promise(done=>listener.close(done));return port;
}
async function stop(child){
 if(child.exitCode!==null||child.signalCode)return;
 const ended=new Promise(done=>child.once('exit',done));child.kill('SIGTERM');
 await Promise.race([ended,pause(5000)]);
 if(child.exitCode===null&&!child.signalCode){child.kill('SIGKILL');await ended;}
}
export async function createEngineeringFixtures(directory){
 await mkdir(directory,{recursive:true,mode:0o700});
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
  'with Image.open(output / "a3.jpg") as a, Image.open(output / "b3.jpg") as b:',
  ' a.save(output / "P1.jpg", format="JPEG", quality=93)',
  ' b.save(output / "P3.jpg", format="JPEG", quality=93)',
  ' height=720',
  ' a=a.resize((round(a.width*height/a.height),height),Image.Resampling.LANCZOS)',
  ' b=b.resize((round(b.width*height/b.height),height),Image.Resampling.LANCZOS)',
  ' for filename, left, right in (("P2.jpg",a,b),("P4.jpg",b,a)):',
  '  combined=Image.new("RGB",(left.width+right.width+32,height),(36,36,36))',
  '  combined.paste(left,(0,0));combined.paste(right,(left.width+32,0))',
  '  combined.save(output / filename,format="JPEG",quality=93)',
  'with Image.new("RGB",(256,256),(255,255,255)) as blank:',
  ' for index, quality in enumerate((83,89,95)):',
  '  blank.save(output / ("no-face-"+str(index)+".jpg"),format="JPEG",quality=quality)',
 ].join('\n'),join(root,'shared/assets'),directory],{encoding:'utf8'});
 assert.equal(generated.status,0,'Could not generate declared engineering stills');
 const negatives=await Promise.all([0,1,2].map(index=>readFile(join(directory,`no-face-${index}.jpg`))));
 try{
  assert(negatives.every(bytes=>bytes.length>3&&bytes.length<=64*1024&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255),
   'Negative enrollment inputs must be bounded JPEG encodings');
  assert.equal(new Set(await Promise.all(negatives.map(sha256))).size,3,'Negative enrollment JPEG encodings must be distinct');
 }finally{negatives.forEach(bytes=>bytes.fill(0));}
 return directory;
}
/** Bridge only: production createHandler, HTTP framing and harness queue dispatch.
 * No test control route is added to the application. */
async function listenHarness(h,port=0){
 const dispatch=h.request;
 const server=createServer(async(incoming,outgoing)=>{
  try{
   const chunks=[];let size=0;
   for await(const chunk of incoming){size+=chunk.length;if(size>24*1024*1024)throw new Error('body_bound');chunks.push(chunk);}
   const raw=chunks.length?Buffer.concat(chunks):undefined;
   const response=await dispatch(incoming.url,{method:incoming.method,raw,headers:incoming.headers});
   raw?.fill(0);outgoing.writeHead(response.status,Object.fromEntries(response.headers));
   if(response.body){for await(const chunk of response.body)outgoing.write(chunk);}outgoing.end();
  }catch{if(!outgoing.headersSent)outgoing.writeHead(503,{'content-type':'application/json'});outgoing.end('{"error":{"code":"local_api_unavailable"}}');}
 });
 await new Promise((done,fail)=>{server.once('error',fail);server.listen(port,'127.0.0.1',done);});
 const origin='http://127.0.0.1:'+server.address().port;h.env.PUBLIC_API_BASE_URL=origin;
 const request=async(path,{token,body,raw,method=body===undefined&&raw===undefined?'GET':'POST',headers={}}={})=>{
  const url=new URL(path,origin);assert.equal(url.origin,origin,'Fixture API requests remain on their owned loopback origin');
  return fetch(url,{method,headers:{...(body===undefined?{}:{'content-type':'application/json'}),...(token?{authorization:'Bearer '+token}:{}),...headers},
   ...(body===undefined?raw===undefined?{}:{body:raw}:{body:JSON.stringify(body)}),redirect:'manual'});
 };
 const json=async(path,options={},expected=200)=>{const response=await request(path,options),value=await response.json();
  assert.equal(response.status,expected,`${options.method??'request'} ${new URL(path,origin).pathname}: ${value?.error?.code??value?.status??'unexpected_response'}`);return value;};
 return {origin,request,json,anonymous:async({adult=false}={})=>{
  const guest=await json('/auth/anonymous',{body:{}},201);
  if(adult)await json('/me/audience',{method:'PUT',token:guest.access_token,body:{
   age_band:'18_plus',policy_version:AUDIENCE_POLICY,expected_version:0,operation_key:crypto.randomUUID()}});
  return guest;
 },
  community:(token,action,payload={},expected=200)=>json('/community/action',{token,body:{action,payload}},expected),
  close:()=>new Promise(done=>{server.close(done);server.closeIdleConnections();})};
}

export async function createOpenFaceRuntime({directory,consumeQueue=true,apiPort=0,requireActualStorage=false}={}){
 const ownedDirectory=!directory;directory??=await mkdtemp(join(tmpdir(),'lovelies-openface-http-'));
 let child,storage,h,http;let diagnostic='';
 const close=async()=>{
  await http?.close();await h?.close();await storage?.close();if(child)await stop(child);
  if(ownedDirectory)await rm(directory,{recursive:true,force:true});
 };
 try{
  await createEngineeringFixtures(directory);
  const [captures,otherCaptures]=await Promise.all(['a','b'].map(label=>Promise.all(
   [0,1,2,3,4,5].map(index=>readFile(join(directory,label+index+'.jpg'))))));
  const secret=process.env.ML_INFERENCE_URL?process.env.ML_INFERENCE_SECRET:randomBytes(32).toString('base64url');
  assert(secret,'Configured private inference requires its service credential');
  const origin=process.env.ML_INFERENCE_URL??'http://127.0.0.1:'+await unusedPort();
  if(!process.env.ML_INFERENCE_URL){
   child=spawn(python,['-m','uvicorn','lovelies_ml_face.app:app','--host','127.0.0.1','--port',new URL(origin).port,'--no-access-log'],{
    cwd:join(root,'services/ml-face'),env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,
     PYTHONPATH:join(root,'services/ml-face/src'),APP_ENV:'local',ML_USE_DETERMINISTIC_SIMULATOR:'false',
     ML_DEPLOYMENT_TRANSPORT:'https_service',ML_INFERENCE_SECRET:secret},stdio:['ignore','ignore','pipe']});
   child.stderr.on('data',chunk=>{if(diagnostic.length<32768)diagnostic+=chunk.toString();});
  }
  let loaded;const deadline=Date.now()+60_000;
  while(Date.now()<deadline){
   if(child&&child.exitCode!==null)throw new Error('Private inference startup failed: '+diagnostic);
   try{const response=await fetch(origin+'/ready',{headers:{Authorization:'Bearer '+secret},signal:AbortSignal.timeout(1000)});
    if(response.ok){loaded=await response.json();break;}}
   catch{}await pause(50);
  }
  assert(loaded,'Private inference did not become ready');
  assert.equal((await fetch(origin+'/ready')).status,401);
  assert.equal((await fetch(origin+'/ready',{headers:{Authorization:'Bearer invalid'}})).status,401);
  storage=await privateStorageFromEnvironment();
  if(requireActualStorage)assert(storage&&process.env.TEST_DATABASE_URL,'Actual local PostgreSQL and Supabase Storage are required');
  h=await startHarness({consumeQueue,buckets:storage?.buckets,vars:{PHOTO_MODEL_VERSION:INFERENCE_MODEL_ID}});
  const service=new AuthenticatedService(origin,secret);
  const models=createModelServices({PHOTOS:h.env.PHOTOS,QUARANTINE:h.env.QUARANTINE,
   MODEL_VERSION:INFERENCE_MODEL_ID,FACE_AUTH_POLICY_VERSION:h.env.FACE_AUTH_POLICY_VERSION,
   ENGINE_ARTIFACT_SHA256:loaded.engine_artifact_sha256,PROCESSING_FINGERPRINT:loaded.processing_fingerprint,INFERENCE:service});
  Object.assign(h.env,{FACE_AUTH_VERIFIER:models.face,PHOTO_PROCESSOR:models.photo,MODEL_SERVICE_READINESS:models.ready,
   INFERENCE_ENGINE_IDENTITY:models.generation()});
  http=await listenHarness(h,apiPort);
  const runtime={...h,...http,directory,captures,otherCaptures,loaded,models,inferenceOrigin:origin,
   storageOrigin:storage?.origin,storageNames:storage?.names,
   transportScope:{database:h.databaseUrl?'actual_postgresql':'pglite',storage:storage?'actual_supabase_storage_http':'memory',api:'actual_loopback_http',inference:'actual_authenticated_http_real_models'},
   close:async()=>{captures.forEach(bytes=>bytes.fill(0));otherCaptures.forEach(bytes=>bytes.fill(0));await close();}};
  return runtime;
 }catch(error){await close();throw error;}
}

export async function sendRealCaptures(h,person,challenge,stills,token){
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
}
export async function enrollReal(h,stills){
 const anonymous=await h.anonymous({adult:true}),keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const challenge=await h.json('/auth/face/registration/challenge',{token:anonymous.access_token,body:{
  device_public_jwk:await crypto.subtle.exportKey('jwk',keys.publicKey),
  consent:{purpose:'face_authentication',granted:true,policy_version:h.env.FACE_AUTH_POLICY_VERSION}}},201);
 const person={privateKey:keys.privateKey,deviceId:challenge.device_id,faceHandle:challenge.face_handle};
 const completion=await sendRealCaptures(h,person,challenge,stills.slice(0,3),anonymous.access_token);
 const result=await h.json('/auth/face/registration/complete',{token:anonymous.access_token,body:completion});
 assert.equal(result.account_id,anonymous.account_id);assert.equal(result.auth_method,'registered_face');
 await h.json('/me',{token:anonymous.access_token},401);
 return {...person,...result,token:result.access_token};
}
export async function loginReal(h,person,still){
 const challenge=await h.json('/auth/face/challenge',{body:{face_handle:person.faceHandle,device_id:person.deviceId}},201);
 const proof=await sendRealCaptures(h,person,challenge,[still]);
 const value=await h.json('/auth/face/complete',{body:proof});assert.equal(value.account_id,person.account_id);
 return {...person,...value,token:value.access_token};
}
