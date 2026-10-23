/** Actual workerd/SQLite DO/R2/Queues with the private copied model runtime.
 * Local emulation only. Hosted services use their Wrangler Container bindings. */
import { build } from '../services/cloudflare-api/node_modules/esbuild/lib/main.js';
import { Miniflare, Response as RuntimeResponse } from '../services/cloudflare-api/node_modules/miniflare/dist/src/index.js';
import { builtinModules } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir,readFile,stat,writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const apiDir=path.join(root,'services/cloudflare-api'), mlDir=path.join(root,'services/ml-face');
const secretsPath=path.join(apiDir,'.dev.vars');
let secretText;
try{secretText=await readFile(secretsPath,'utf8');if((await stat(secretsPath)).mode&0o077)throw new Error('Local signing keys require mode0600');}
catch(error){if(error.code!=='ENOENT')throw error;secretText=['AUTH_SIGNING_SECRET','MEDIA_SIGNING_SECRET'].map(k=>`${k}=${randomBytes(48).toString('base64url')}`).join('\n')+'\n';await writeFile(secretsPath,secretText,{mode:0o600,flag:'wx'});}
const secrets={};for(const line of secretText.split(/\r?\n/)){const match=/^(AUTH_SIGNING_SECRET|MEDIA_SIGNING_SECRET)=(.+)$/.exec(line);if(match)secrets[match[1]]=match[2].replace(/^['"]|['"]$/g,'');}
if(Object.values(secrets).length!==2||Object.values(secrets).some(s=>s.length<32))throw new Error('Local signing keys unavailable');
const modelPort=50880, apiPort=Number(process.env.LOVELIES_DEV_PORT??'8787');
if(!Number.isInteger(apiPort)||apiPort<1024||apiPort>65535)throw new Error('Invalid local API port');
const inferenceConfigured=process.env.LOVELIES_INFERENCE_URL;
const inferenceBase=new URL(inferenceConfigured??`http://127.0.0.1:${modelPort}`);
if(inferenceBase.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(inferenceBase.hostname)||
 inferenceBase.username||inferenceBase.password||inferenceBase.pathname!=='/'||inferenceBase.search||inferenceBase.hash)
 throw new Error('Private inference URL must be a loopback HTTP origin');
const state=process.env.LOVELIES_DEV_STATE_DIR?path.resolve(root,process.env.LOVELIES_DEV_STATE_DIR):path.join(root,'.wrangler/native-dev');
let model;
if(inferenceConfigured===undefined){
 const pythonPath=path.join(mlDir,'.venv/bin/python');await stat(pythonPath);
 model=spawn(pythonPath,['-m','uvicorn','lovelies_ml_face.app:app','--host','127.0.0.1','--port',String(modelPort),'--no-access-log'],{cwd:mlDir,stdio:['ignore','ignore','inherit'],env:{...process.env,APP_ENV:'production',CLOUDFLARE_ENV:'production',ML_DEPLOYMENT_MODE:'monitored_pilot',ML_REQUIRE_MODEL_ARTIFACTS:'true',ML_USE_DETERMINISTIC_SIMULATOR:'false',MODEL_MANIFEST_PATH:path.join(mlDir,'models/model-manifest.json'),PYTHONPATH:path.join(mlDir,'src')}});
}
let stopped=false;let mf;
async function stop(){if(stopped)return;stopped=true;await mf?.dispose();model?.kill('SIGTERM');}
process.on('SIGINT',()=>{void stop().then(()=>process.exit());});process.on('SIGTERM',()=>{void stop().then(()=>process.exit());});
async function bounded(stream,maximum){
 if(!stream)return new Uint8Array();const reader=stream.getReader(),chunks=[];let size=0;
 try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>maximum){next.value.fill(0);throw new Error('Private inference response exceeds its body limit');}chunks.push(next.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
 }finally{for(const chunk of chunks)chunk.fill(0);void reader.cancel().catch(()=>{});reader.releaseLock();}
}
const privateUnavailable=()=>new RuntimeResponse(JSON.stringify({error:{code:'inference_unavailable'}}),{status:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
try {
  let ready=false;
  for(let i=0;i<100&&!ready;i++){
   if(model&&model.exitCode!==null)throw new Error('Private model process exited');
   let body;
   try{const r=await fetch(new URL('/ready',inferenceBase),{redirect:'manual',signal:AbortSignal.timeout(1000)});
    body=await bounded(r.body,65536);
    if(r.ok&&!r.redirected){let health;try{health=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));}catch{throw new Error('Private model readiness is not JSON');}
     if(health.service!=='lovelies-ml-face'||health.model_version!=='opencv-yunet-sface-2021dec-v1'||health.model_artifacts!=='verified'||health.authentication!=='registered_face_comparison'||health.liveness_required!==false)
      throw new Error('Private model readiness does not match the configured model/policy');
     ready=true;
    }
   }catch(error){if(error.message?.startsWith('Private model readiness'))throw error;}
   finally{body?.fill(0);}
   if(!ready)await new Promise(resolve=>setTimeout(resolve,100));
  }
  if(!ready)throw new Error('Private model startup unavailable');
  const bundle=async(file)=>{const r=await build({entryPoints:[file],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers',...builtinModules.flatMap(n=>[n,`node:${n}`])],logLevel:'silent'});return r.outputFiles[0].text;};
  const [coreScript,mlScript]=await Promise.all([bundle(path.join(apiDir,'src/index.ts')),bundle(path.join(root,'services/ml-container-worker/src/index.ts'))]);
  const common={modules:true,compatibilityDate:'2026-07-21',compatibilityFlags:['nodejs_compat']};
  const buckets={PHOTOS:'lovelies-cloudflare-photos',QUARANTINE:'lovelies-cloudflare-quarantine'};
  const inference=async request=>{const url=new URL(request.url);
   if(request.method!=='POST'||url.origin!=='http://container'||url.search||url.hash||!['/internal/face','/internal/photo'].includes(url.pathname)){
    if(request.body&&!request.body.locked)await request.body.cancel().catch(()=>{});return new RuntimeResponse(null,{status:404});
   }
   let input,output;
   try{input=await bounded(request.body,url.pathname==='/internal/face'?12*1024*1024:40*1024*1024);
    const response=await fetch(new URL(url.pathname,inferenceBase),{method:'POST',headers:{'content-type':'application/json'},body:input,redirect:'manual',signal:AbortSignal.timeout(55000)});
    if(response.redirected||response.status>=300&&response.status<400){void response.body?.cancel().catch(()=>{});return privateUnavailable();}
    output=await bounded(response.body,6*1024*1024);
    return new RuntimeResponse(output.slice().buffer,{status:response.status,headers:{'Content-Type':response.headers.get('Content-Type')??'application/json','Cache-Control':'no-store'}});
   }catch{return privateUnavailable();}finally{input?.fill(0);output?.fill(0);}
  };
  await mkdir(state,{recursive:true,mode:0o700});
  mf=new Miniflare({host:'127.0.0.1',port:apiPort,durableObjectsPersist:path.join(state,'sqlite'),r2Persist:path.join(state,'r2'),cachePersist:path.join(state,'cache'),workers:[{
    ...common,name:'lovelies-local-core',script:coreScript,durableObjects:{LOVELIES_CORE:{className:'LoveliesCore',useSQLite:true}},
    r2Buckets:{...buckets,PRIVACY_EXPORTS:'lovelies-cloudflare-privacy-exports'},
    queueProducers:{PHOTO_JOBS:'lovelies-local-jobs'},queueConsumers:{'lovelies-local-jobs':{maxBatchSize:1,maxBatchTimeout:0}},
    bindings:{APP_ENV:'local',...secrets,FACE_AUTH_POLICY_VERSION:'registered-face-opencv-v1',PHOTO_MODEL_VERSION:'opencv-yunet-sface-2021dec-v1',PHOTO_CONSENT_POLICY_VERSION:'photo-policy-v1',ALLOWED_ORIGINS:'http://127.0.0.1:8765,http://localhost:8765',PUBLIC_APP_BASE_URL:'http://127.0.0.1:8765'},
    serviceBindings:{FACE_AUTH_VERIFIER:{name:'lovelies-local-private-model',entrypoint:'FaceVerifier'},PHOTO_PROCESSOR:{name:'lovelies-local-private-model',entrypoint:'PhotoProcessor'}},
  },{...common,name:'lovelies-local-private-model',script:mlScript,r2Buckets:buckets,
    bindings:{MODEL_VERSION:'opencv-yunet-sface-2021dec-v1',FACE_AUTH_POLICY_VERSION:'registered-face-opencv-v1'},serviceBindings:{INFERENCE:inference}}]});
  await mf.ready;console.log(`Lovelies Cloudflare local API: http://127.0.0.1:${apiPort}; inference ${inferenceConfigured===undefined?'host Python':inferenceBase.origin}; state ${state}; real private YuNet/SFace; anonymous first; no OTP or liveness.`);
  model?.on('exit',()=>{if(!stopped){console.error('Private model exited; stopping local API');void stop().then(()=>process.exit(1));}});
}catch(error){console.error(error.message);await stop();process.exitCode=1;}
