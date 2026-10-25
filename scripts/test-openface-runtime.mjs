/** Keep the existing real-model fixture harness alive for native HTTP suites.
 * Requires the explicitly disposable PostgreSQL/Storage configuration. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createOpenFaceRuntime} from '../services/supabase-api/test/openface-runtime.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const directory=resolve(process.argv[2]??'');
assert(process.argv.length===3,'Pass a new evidence/fixture directory');
const apiPort=Number(process.env.LOVELIES_FIXTURE_API_PORT??0);
assert(Number.isSafeInteger(apiPort)&&(apiPort===0||apiPort>=1024&&apiPort<=65535),'A bounded local fixture port is required');
assert(process.env.TEST_DATABASE_URL&&process.env.TEST_STORAGE_API_URL&&process.env.TEST_STORAGE_SERVICE_KEY,
 'Explicit disposable PostgreSQL and private Storage are required');
await mkdir(directory,{recursive:false,mode:0o700});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function freeze(location){
 const entries=await readdir(location,{withFileTypes:true}),rows=[];
 for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
  const path=join(location,entry.name);
  if(entry.isDirectory())rows.push(...await freeze(path));
  else if(entry.isFile()&&!entry.name.endsWith('.pyc')){
   const bytes=await readFile(path);rows.push({path:relative(root,path),bytes:bytes.length,sha256:digest(bytes)});
  }
 }
 return rows;
}
const source=[...await freeze(join(root,'services/supabase-api/src')),
 ...await freeze(join(root,'services/ml-face/src')),
 ...await freeze(join(root,'services/ml-face/vendor'))];
for(const name of ['scripts/test-openface-runtime.mjs','services/supabase-api/test/openface-runtime.mjs',
 'services/supabase-api/test/runtime-harness.mjs','services/supabase-api/test/openface-storage.mjs',
 'android/app/src/androidTest/prepare-openface-manifest.mjs','services/ml-face/models/model-manifest.json']){
 const bytes=await readFile(join(root,name));source.push({path:name,bytes:bytes.length,sha256:digest(bytes)});
}
let runtime,closing=false;
const report={schema:1,status:'starting',started_at:new Date().toISOString(),source,
 scope:'Disposable local PostgreSQL, actual Supabase Storage HTTP, production API handler and authenticated real-model inference',
 does_not_establish:['Hosted deployment','Optical camera capture','Representative recognition accuracy','Store distribution']};
const save=()=>writeFile(join(directory,'runtime.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
async function close(status){
 if(closing)return;closing=true;
 try{
  await runtime?.close();
  report.changed_inputs=[];
  for(const item of source)if(digest(await readFile(join(root,item.path)))!==item.sha256)report.changed_inputs.push(item.path);
  report.status=report.changed_inputs.length?'source_changed':status;
 }catch(error){report.status='close_failed';report.failure=error.name;}
 report.stopped_at=new Date().toISOString();await save();
 process.exit(report.status==='stopped'?0:1);
}
process.once('SIGINT',()=>void close('stopped'));
process.once('SIGTERM',()=>void close('stopped'));
await save();
try{
 runtime=await createOpenFaceRuntime({directory,apiPort,requireActualStorage:true});
 const configured=spawnSync(process.execPath,[join(root,'android/app/src/androidTest/prepare-openface-manifest.mjs'),directory,runtime.origin],
  {cwd:root,env:{PATH:process.env.PATH,HOME:process.env.HOME},encoding:'utf8'});
 assert.equal(configured.status,0,'Frozen native fixture metadata generation failed');
 const health=await runtime.json('/health'),ready=await runtime.json('/ready');
 assert.equal(health.database,'supabase_postgresql');assert.equal(ready.inference_ready,true);
 Object.assign(report,{status:'ready',api_origin:runtime.origin,transports:runtime.transportScope,
  inference:runtime.loaded,health,ready,
  fixture_manifest:join(directory,'openface-native-journey.json'),
  fixture_manifest_sha256:digest(await readFile(join(directory,'openface-native-journey.json')))});
 await save();
 console.log(JSON.stringify({status:report.status,api_origin:runtime.origin,fixture_manifest:report.fixture_manifest,transports:report.transports}));
}catch(error){
 await writeFile(join(directory,'startup-private.log'),String(error.stack??error),{mode:0o600});
 report.failure=error.name;await close('startup_failed');
}
