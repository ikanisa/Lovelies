/** Actual cached Supabase Edge Runtime -> unchanged production entrypoint,
 * isolated PostgreSQL database, owned real private Storage and external pinned
 * real ML HTTP. Node owns setup/transports/HTTP cron only, never app authority.
 *
 * node --experimental-transform-types scripts/test-isolated-supabase-edge.mjs \
 *   --services-dir <existing-owned-services> --output <new-directory> \
 *   --ml-env <private-0600-env> [--port 18887] [--public-api-origin https://.../] \
 *   [--fixtures-dir <existing-frozen-fixture-directory>]
 * Existing fixtures are verified read-only; otherwise this invocation creates
 * its own <output>/fixtures with the existing shared fixture generator.
 *
 * SIGTERM/SIGINT removes only this invocation's exact Edge/relay containers,
 * confirms absence, then drops only its new DB. Owned Storage objects/volumes
 * and the private evidence/configuration are retained. Services may be reused
 * serially only with this tool's exact private bucket-ownership receipt.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile,lstat,realpath,rename,unlink} from 'node:fs/promises';
import {join,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import {isolatedPostgres} from '../services/supabase-api/test/postgres-harness.mjs';
import {createEngineeringFixtures} from '../services/supabase-api/test/openface-runtime.mjs';
import {exactReadiness} from '../services/supabase-api/src/inference-contract.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
const EDGE='public.ecr.aws/supabase/edge-runtime:v1.77.8@sha256:178c041398a33ded8219344382d0672a90051d1babbf0af03425cafe20039a75';
const CLIENT='public.ecr.aws/supabase/storage-api:v1.68.10';
const POSTGRES='public.ecr.aws/supabase/postgres:17.6.1.158';
const ARTIFACT='173b43d8f5d259f022f4fd83b7c658fc7ade3070e36321965436cd59f2da909f';
const PROCESSING='e5366532fe94660257f2228e59e5d6032fd35d45ee41733d82c84aee440a26fa';
// Registry image manifest and package artifact are deliberately distinct.
// Root supplies/verifies the external image receipt; /ready verifies the loaded
// artifact, processing generation, model hashes, capabilities and limits here.
const EXTERNAL_IMAGE_MANIFEST='982e2ed7bb66b17db17979495495892579f1b734c55d93516a2aeedbf70e1c6c';
const BUCKETS=['lovelies-photos','lovelies-quarantine','lovelies-privacy-exports'];
const FILE_LIMIT=20*1024*1024;
const MIGRATIONS=[
  '20261023162016_lovelies_private_core.sql','20261023210000_refresh_delivery.sql',
  '20261024170000_audience_retention.sql','20261024180000_inference_generation.sql',
  '20261024190000_retention_scan_cursors.sql',
];
const usage='Use --services-dir <owned-services> --output <new-dir> --ml-env <private-0600-env> [--port 18887] [--public-api-origin https://.../] [--fixtures-dir <existing-frozen-fixture-directory>]';
const argumentsMap=new Map();
for(let index=2;index<process.argv.length;index+=2){
  const key=process.argv[index],value=process.argv[index+1];
  assert(['--services-dir','--output','--ml-env','--port','--public-api-origin','--fixtures-dir'].includes(key)&&value&&!argumentsMap.has(key),usage);
  argumentsMap.set(key,value);
}
for(const key of ['--services-dir','--output','--ml-env'])assert(argumentsMap.has(key),usage);
const directory=resolve(argumentsMap.get('--output'));
const fixturesDirectory=argumentsMap.has('--fixtures-dir')?resolve(argumentsMap.get('--fixtures-dir')):join(directory,'fixtures');
const servicesDirectory=await realpath(resolve(argumentsMap.get('--services-dir')));
const apiPort=Number(argumentsMap.get('--port')??18887);
assert(Number.isSafeInteger(apiPort)&&apiPort>=1024&&apiPort<=65535,'Bounded loopback API port required');
const apiOrigin='http://127.0.0.1:'+apiPort;
let publicOrigin=apiOrigin;
if(argumentsMap.has('--public-api-origin')){
  const target=new URL(argumentsMap.get('--public-api-origin'));
  assert(target.protocol==='https:'&&!target.username&&!target.password&&target.pathname==='/'&&!target.search&&!target.hash&&
    !target.port&&!target.hostname.endsWith('.supabase.co')&&target.hostname!=='supabase.co'&&
    !['localhost','127.0.0.1','[::1]'].includes(target.hostname)&&/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(target.hostname),
  'Public API origin must be a credential-free HTTPS root outside Supabase');
  publicOrigin=target.origin;
}
await mkdir(directory,{recursive:false,mode:0o700});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const owner='lovelies-isolated-edge-'+randomBytes(6).toString('hex');
const edgeName=owner+'-api',relayName=owner+'-relays';
const redactions=[];
const redact=value=>redactions.filter(Boolean).sort((a,b)=>b.length-a.length).reduce((text,secret)=>text.replaceAll(secret,'[redacted]'),String(value));
const cleanEnvironment=Object.fromEntries(['PATH','HOME','TMPDIR','DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG']
  .flatMap(name=>process.env[name]===undefined?[]:[[name,process.env[name]]]));
const shutdown=new AbortController();
let resolveStop;
const stopped=new Promise(done=>{resolveStop=done;});
function stopRequested(){if(!shutdown.signal.aborted){shutdown.abort();resolveStop();}}
process.once('SIGTERM',stopRequested);process.once('SIGINT',stopRequested);
let database,ownsLock=false,maintenance,maintenanceAbort,sequence=0,ready=false;
let saveTail=Promise.resolve();
const lockPath=join(servicesDirectory,'.isolated-native-edge.lock');
const bucketReceiptPath=join(servicesDirectory,'isolated-native-bucket-ownership.json');
const report={schema:1,kind:'lovelies-isolated-native-supabase-edge-v1',status:'starting',started_at:new Date().toISOString(),
  api_origin:apiOrigin,public_api_base_url:publicOrigin,owner,containers:{edge:edgeName,relays:relayName},
  transports:{api:'actual_supabase_edge_runtime_production_entrypoint',database:'actual_postgresql_new_database',
    storage:'actual_owned_supabase_storage_http',inference:'external_actual_authenticated_pinned_ml_http'},
  limits:{container_memory_mib:1024,container_cpus:1,container_pids:128,tmpfs_bytes:128*1024*1024,
    max_workers:3,worker_memory_mib:256,worker_cpu_ms:2000,worker_timeout_ms:150000,
    worker_policy:'per_request',cpu_budget_scope:'per_request',
    worker_timeout_semantics:'Pinned per_request runtime resets its timeout while requests remain active; this is not an absolute HTTP wall deadline.'},
  external_image:{expected_manifest_sha256:EXTERNAL_IMAGE_MANIFEST,verification:'root_receipt_required_separately'},
  maintenance:{interval_after_completion_ms:1000,calls:0,failures:0},commands:[],
  does_not_establish:['Hosted deployment','Optical camera capture','Representative recognition accuracy','Store distribution'],
};
async function save(){
  const path=join(directory,'runtime.json'),temporary=path+'.tmp';
  const body=JSON.stringify(report,null,2)+'\n';
  const operation=saveTail.then(async()=>{await writeFile(temporary,body,{mode:0o600});await rename(temporary,path);});
  saveTail=operation.catch(()=>{});await operation;
}
async function privateEnvironment(path){
  const resolved=resolve(path),info=await lstat(resolved);
  assert(info.isFile()&&!info.isSymbolicLink()&&(info.mode&0o777)===0o600&&info.uid===process.getuid(),
    'Owned, ordinary mode-0600 environment file required');
  assert.equal(await realpath(resolved),resolved,'Environment links are not admitted');
  assert(info.size<=64*1024,'Environment file bound');
  const result={};
  for(const line of (await readFile(resolved,'utf8')).split(/\r?\n/)){
    if(!line.trim()||line.trimStart().startsWith('#'))continue;
    const match=/^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);assert(match,'Plain environment assignment required');
    assert(!(match[1] in result),'Duplicate environment assignment');
    let value=match[2];
    if(value.startsWith('"')&&value.endsWith('"')||value.startsWith("'")&&value.endsWith("'"))value=value.slice(1,-1);
    assert(!/[\r\n\0]/.test(value),'Single-line environment value required');result[match[1]]=value;
  }
  return result;
}
async function command(label,executable,args,{allowFailure=false,timeout=45000,input}={}){
  const started=Date.now();let output='',error='',timedOut=false,overflow=false;
  const child=spawn(executable,args,{cwd:root,env:cleanEnvironment,stdio:['pipe','pipe','pipe']});
  const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeout);
  const append=(field,chunk)=>{
    if(output.length+error.length+chunk.length>8*1024*1024){overflow=true;child.kill('SIGKILL');return;}
    if(field==='out')output+=chunk;else error+=chunk;
  };
  child.stdout.on('data',chunk=>append('out',chunk));child.stderr.on('data',chunk=>append('err',chunk));
  child.stdin.on('error',()=>{});child.stdin.end(input);
  const code=await new Promise((done,fail)=>{child.once('error',fail);child.once('close',done);}).finally(()=>clearTimeout(timer));
  const log=String(++sequence).padStart(3,'0')+'-'+label+'.log';
  await writeFile(join(directory,log),redact(output+error),{mode:0o600});
  report.commands.push({label,exit_code:code,timed_out:timedOut,output_bound_exceeded:overflow,duration_ms:Date.now()-started,log});
  if(!allowFailure)assert(code===0&&!timedOut&&!overflow,label+' failed; sanitized private diagnostic retained');
  return {code,output,error,timedOut,overflow};
}
const docker=(label,args,options)=>command(label,'docker',args,options);
async function inspect(name,{allowAbsent=false}={}){
  const format='{{json .Id}}\n{{json .Image}}\n{{json .Config.Image}}\n{{json .Config.Labels}}\n{{json .NetworkSettings.Networks}}\n{{json .NetworkSettings.Ports}}\n{{json .Mounts}}\n{{json .State.Running}}';
  const result=await docker('inspect-'+name,['inspect','--format',format,name],{allowFailure:true,timeout:10000});
  if(result.code!==0){
    if(allowAbsent&&result.code===1&&new RegExp('No such (?:object|container): '+name+'(?:\\s|$)','i').test(result.error))return null;
    throw new Error('OwnedContainerInspectionFailed');
  }
  const [id,imageId,image,labels,networks,ports,mounts,running]=result.output.trim().split('\n').map(line=>JSON.parse(line));
  return {id,imageId,image,labels,networks,ports,mounts,running};
}
async function freeze(){
  const paths=new Set();
  async function walk(path){
    const info=await lstat(path);assert(!info.isSymbolicLink(),'Source symlinks are not admitted');
    if(info.isDirectory()){
      for(const name of (await readdir(path)).sort())if(!['node_modules','__pycache__','.DS_Store'].includes(name))await walk(join(path,name));
    }else if(info.isFile())paths.add(path);
  }
  for(const name of ['services/supabase-api/src','supabase/functions/lovelies-api',
    'services/supabase-api/test/isolated-native-edge','scripts/test-isolated-supabase-edge.mjs',
    'scripts/test-openface-local-services.mjs','services/supabase-api/test/postgres-harness.mjs',
    'services/supabase-api/test/openface-runtime.mjs','services/supabase-api/test/runtime-harness.mjs',
    'services/supabase-api/test/openface-storage.mjs','android/app/src/androidTest/prepare-openface-manifest.mjs',
    'services/supabase-api/package.json','pnpm-lock.yaml','shared/assets/person02.jpg','shared/assets/portrait.jpg',
    ...MIGRATIONS.map(name=>'supabase/migrations/'+name)])await walk(join(root,name));
  return Promise.all([...paths].sort().map(async path=>{const bytes=await readFile(path);return {path:relative(root,path),bytes:bytes.length,sha256:digest(bytes)};}));
}
async function fixtureSnapshot(validateGraph=true){
  const folder=await lstat(fixturesDirectory);
  assert(folder.isDirectory()&&!folder.isSymbolicLink()&&await realpath(fixturesDirectory)===fixturesDirectory,'Ordinary link-free fixture directory required');
  const manifest=join(fixturesDirectory,'openface-native-journey.json'),info=await lstat(manifest);
  assert(info.isFile()&&!info.isSymbolicLink()&&info.size>0&&info.size<=64*1024&&await realpath(manifest)===manifest,'Bounded ordinary fixture manifest required');
  const manifestBytes=await readFile(manifest),metadata=JSON.parse(manifestBytes);
  const names=[...['a','b'].flatMap(slot=>Array.from({length:6},(_,index)=>`${slot}${index}.jpg`)),
    ...['P1','P2','P3','P4'].map(name=>name+'.jpg'),...[0,1,2].map(index=>`no-face-${index}.jpg`)];
  assert.deepEqual((await readdir(fixturesDirectory)).filter(name=>/\.jpe?g$/i.test(name)).sort(),[...names].sort(),'Exactly the existing 19 JPEG fixtures required');
  const files=[];
  for(const name of names){
    const path=join(fixturesDirectory,name),file=await lstat(path);
    assert(file.isFile()&&!file.isSymbolicLink()&&file.size>3&&file.size<=8*1024*1024&&await realpath(path)===path,'Bounded ordinary link-free fixture JPEG required');
    const bytes=await readFile(path);
    try{
      assert(bytes.length===file.size&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255,'Fixture JPEG encoding/length changed');
      files.push({path:name,bytes:bytes.length,sha256:digest(bytes)});
    }finally{bytes.fill(0);}
  }
  if(validateGraph){
    for(const label of ['a','b'])assert.equal(new Set(files.filter(row=>row.path.startsWith(label)).map(row=>row.sha256)).size,6,'Distinct enrolled/fresh encodings required');
    assert.equal(new Set(files.filter(row=>row.path.startsWith('no-face-')).map(row=>row.sha256)).size,3,'Distinct negative encodings required');
    const asset=name=>join(fixturesDirectory,name);
    const person=slot=>({selfies:[0,1,2].map(index=>asset(`${slot}${index}.jpg`)),fresh_selfie:asset(`${slot}5.jpg`)});
    // Match the existing prepare-openface-manifest.mjs contract exactly. This
    // validates reuse without rewriting its absolute paths, content or graph.
    assert.deepEqual(metadata,{
      api_origin:apiOrigin,
      scope:'Existing supplied Lovelies screen-reference portraits, declared encoded derivatives and three synthetic white JPEG negative inputs; real OpenFace/Supabase consumer engineering inputs. Three encodings are not three optical captures. No camera, representative recognition, civil identity, hosted, device or release acceptance.',
      owner:person('a'),recipients:{aline:person('a'),eric:person('b')},
      camera_quality_recovery_selfies:[0,1,2].map(index=>asset(`no-face-${index}.jpg`)),
      photos:[{name:'P1',path:asset('P1.jpg'),matches:['aline']},{name:'P2',path:asset('P2.jpg'),matches:['aline','eric']},
        {name:'P3',path:asset('P3.jpg'),matches:['eric']},{name:'P4',path:asset('P4.jpg'),matches:['aline','eric']}],
      exclusions:[{photo:'P4',recipient:'eric'}],global_excluded_photos:['P3'],
      approved:{aline:['P1','P2','P4'],eric:['P2']},strict_isolation:true,
      files:files.map(row=>({...row,path:asset(row.path)})),
    },'Existing fixture manifest paths, checksums, API origin, scope and graph must match');
  }
  const manifestHash=digest(manifestBytes);
  return {manifest,manifest_sha256:manifestHash,files,source_sha256:digest(JSON.stringify({manifest_sha256:manifestHash,files}))};
}
async function bindFixtures(){
  const snapshot=await fixtureSnapshot();
  report.fixture_manifest=snapshot.manifest;report.fixture_manifest_sha256=snapshot.manifest_sha256;
  report.fixture_files=snapshot.files;report.fixture_source_sha256=snapshot.source_sha256;
  report.fixture_reused=argumentsMap.has('--fixtures-dir');
}
async function boundedJson(response,limit=64*1024){
  assert(response.body,'JSON response body required');const reader=response.body.getReader();let size=0;const chunks=[];
  try{
    for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;assert(size<=limit,'JSON response bound');chunks.push(value);}
    return JSON.parse(Buffer.concat(chunks,size).toString('utf8'));
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
function localOrigin(raw){
  const target=new URL(raw);
  assert(target.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(target.hostname)&&target.pathname==='/'&&
    !target.username&&!target.password&&!target.search&&!target.hash,'Exact private loopback HTTP origin required');
  assert(Number(target.port)>=1024&&Number(target.port)<=65535,'Bounded private relay port required');return target;
}
async function privateBuckets(info,containers,storageEnvironment){
  const storage=localOrigin(storageEnvironment.TEST_STORAGE_API_URL),secret=storageEnvironment.TEST_STORAGE_SERVICE_KEY;
  assert(secret,'Owned Storage service credential required');redactions.push(secret);
  assert.equal(Number(storage.port),info.storagePort,'Storage origin differs from owned manifest');
  const headers={authorization:'Bearer '+secret,apikey:secret};
  const request=(path,init={})=>fetch(storage.origin+path,{...init,headers:{...headers,...init.headers},redirect:'manual',signal:AbortSignal.timeout(15000)});
  const listed=await request('/bucket');assert.equal(listed.status,200,'Owned bucket listing required');
  const all=await boundedJson(listed);assert(Array.isArray(all),'Storage bucket list shape');
  let receipt,reused=false;
  try{
    const stat=await lstat(bucketReceiptPath);assert(stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o777)===0o600&&stat.uid===process.getuid(),'Private owned bucket receipt required');
    receipt=JSON.parse(await readFile(bucketReceiptPath,'utf8'));reused=true;
  }catch(error){if(error.code!=='ENOENT')throw error;}
  if(receipt){
    assert(receipt.kind==='lovelies-isolated-native-buckets-v1'&&receipt.schema===1&&receipt.prefix===info.prefix&&
      receipt.postgres_container_id===containers.postgres.id&&receipt.storage_container_id===containers.storage.id,
    'Bucket receipt must match exact owned services');
    assert(Array.isArray(receipt.buckets)&&receipt.buckets.length===BUCKETS.length,'Exact bucket ownership receipt required');
    assert.deepEqual(receipt.buckets.map(row=>row.id).sort(),[...BUCKETS].sort());
    assert.deepEqual(all.map(row=>row.id).sort(),[...BUCKETS].sort(),'Unknown existing bucket denied');
  }else{
    assert.equal(all.length,0,'Unknown existing bucket without this tool ownership receipt denied');
    receipt={schema:1,kind:'lovelies-isolated-native-buckets-v1',prefix:info.prefix,
      postgres_container_id:containers.postgres.id,storage_container_id:containers.storage.id,
      created_at:new Date().toISOString(),created_by:owner,buckets:[]};
    for(const id of BUCKETS){
      shutdown.signal.throwIfAborted();
      const created=await request('/bucket',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({id,name:id,public:false,file_size_limit:FILE_LIMIT})});
      assert.equal(created.status,200,'Private owned bucket creation failed');await created.body?.cancel();
      const key='isolated-edge-privacy-probe/'+crypto.randomUUID()+'.bin';
      const probe=Buffer.from('lovelies-isolated-edge-private-storage-probe-v1\n');
      const uploaded=await request('/object/'+id+'/'+key,{method:'POST',headers:{'content-type':'application/octet-stream','x-upsert':'false'},body:probe});
      assert.equal(uploaded.status,200,'Private Storage probe write failed');await uploaded.body?.cancel();
      receipt.buckets.push({id,name:id,public:false,file_size_limit:FILE_LIMIT,probe_object:key,probe_sha256:digest(probe),probe_bytes:probe.length});
    }
  }
  for(const row of receipt.buckets){
    assert(row.name===row.id&&row.public===false&&row.file_size_limit===FILE_LIMIT&&
      /^isolated-edge-privacy-probe\/[a-f0-9-]{36}\.bin$/.test(row.probe_object)&&/^[a-f0-9]{64}$/.test(row.probe_sha256)&&
      row.probe_bytes===Buffer.byteLength('lovelies-isolated-edge-private-storage-probe-v1\n'),
    'Exact private bucket receipt fields required');
    const readback=await request('/bucket/'+row.id);assert.equal(readback.status,200,'Private bucket readback failed');
    const bucket=await boundedJson(readback);
    assert(bucket.id===row.id&&bucket.name===row.id&&bucket.public===false&&Number(bucket.file_size_limit)===FILE_LIMIT,'Private bucket settings changed');
    const object=await request('/object/authenticated/'+row.id+'/'+row.probe_object);assert.equal(object.status,200,'Owned privacy probe must exist');
    assert.equal(Number(object.headers.get('content-length')),row.probe_bytes,'Bounded privacy probe required');
    const bytes=Buffer.from(await object.arrayBuffer());assert(bytes.length===row.probe_bytes&&digest(bytes)===row.probe_sha256,'Owned privacy probe changed');
    const denied=await fetch(storage.origin+'/object/public/'+row.id+'/'+row.probe_object,{redirect:'manual',signal:AbortSignal.timeout(15000)});
    assert([400,401,403,404].includes(denied.status),'Public access to existing private probe must be denied');await denied.body?.cancel();
  }
  if(!reused)await writeFile(bucketReceiptPath,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
  report.storage={service_prefix:info.prefix,buckets:BUCKETS,public:false,file_size_limit:FILE_LIMIT,
    ownership_receipt:bucketReceiptPath,reused,existing_objects_retained:true,public_probe_denied:true};
}
async function maintenanceLoop(secret){
  while(!maintenanceAbort.signal.aborted){
    const started=Date.now();let status=null,errorClass;
    try{
      const response=await fetch(apiOrigin+'/_internal/maintenance',{method:'POST',headers:{authorization:'Bearer '+secret},
        redirect:'manual',signal:AbortSignal.any([maintenanceAbort.signal,AbortSignal.timeout(145000)])});
      status=response.status;await response.body?.cancel();
    }catch(error){errorClass=error.name;}
    if(maintenanceAbort.signal.aborted)break;
    const row={sequence:++report.maintenance.calls,status,duration_ms:Date.now()-started,...errorClass?{error:errorClass}:{}};
    if(status!==200)report.maintenance.failures++;
    report.maintenance.last=row;
    // Only status/timing survives; no job response, IDs, tokens or media data.
    await writeFile(join(directory,'maintenance.jsonl'),JSON.stringify(row)+'\n',{flag:'a',mode:0o600});
    await save();
    await new Promise(done=>{
      const signal=maintenanceAbort.signal,timer=setTimeout(finished,1000);
      function finished(){clearTimeout(timer);signal.removeEventListener('abort',finished);done();}
      signal.addEventListener('abort',finished,{once:true});if(signal.aborted)finished();
    });
  }
}
async function removeOwned(name){
  const present=await inspect(name,{allowAbsent:true});
  if(!present)return {name,absent:true};
  assert.equal(present.labels?.['lovelies.isolated-edge.owner'],owner,'Cleanup ownership mismatch');
  await docker('stop-'+name,['stop','--time','10',present.id],{allowFailure:true,timeout:20000});
  await docker('logs-'+name,['logs','--tail','2000',present.id],{allowFailure:true,timeout:10000});
  await docker('remove-'+name,['rm','-f',present.id],{timeout:20000});
  assert.equal(await inspect(name,{allowAbsent:true}),null,'Owned container absence must be confirmed');
  return {name,absent:true};
}
async function cleanup(status){
  report.status='cleanup_pending';await save();maintenanceAbort?.abort();
  if(maintenance)try{await maintenance;}catch(error){report.maintenance.stop_error=error.name;}
  const failures=[];report.cleanup={containers:[],database:'not_created',lock:'not_acquired'};
  for(const name of [relayName,edgeName]){
    try{report.cleanup.containers.push(await removeOwned(name));}
    catch(error){failures.push({resource:name,error:error.name});}
  }
  // The API must no longer hold connections before DROP DATABASE is attempted.
  if(database){
    if(failures.length)report.cleanup.database='retained_because_container_absence_unconfirmed';
    else try{await database.engine.close();report.cleanup.database='dropped_only_new_database';}
    catch(error){report.cleanup.database='drop_failed';failures.push({resource:'new_database',error:error.name});}
  }
  if(ownsLock){
    try{
      const lock=JSON.parse(await readFile(lockPath,'utf8'));assert.equal(lock.owner,owner,'Lock ownership mismatch');
      if(failures.length)report.cleanup.lock='retained_for_failed_cleanup';
      else{await unlink(lockPath);report.cleanup.lock='released';}
    }catch(error){failures.push({resource:'services_lock',error:error.name});}
  }
  report.cleanup.failures=failures;report.cleanup.storage_objects_and_service_volumes='retained';
  try{
    report.source_after=await freeze();const before=new Map(report.source.map(row=>[row.path,row.sha256]));
    const after=new Map(report.source_after.map(row=>[row.path,row.sha256]));
    report.changed_inputs=[...new Set([...before.keys(),...after.keys()])].filter(path=>before.get(path)!==after.get(path));
  }catch(error){report.changed_inputs=['source_freeze_unavailable'];report.source_after_error=error.name;}
  report.changed_fixtures=[];
  if(report.fixture_manifest){
    try{
      const after=await fixtureSnapshot(false);report.fixture_manifest_after_sha256=after.manifest_sha256;
      report.fixture_files_after=after.files;report.fixture_source_after_sha256=after.source_sha256;
      if(after.manifest_sha256!==report.fixture_manifest_sha256)report.changed_fixtures.push('openface-native-journey.json');
      for(const [index,row] of report.fixture_files.entries())if(row.sha256!==after.files[index].sha256||row.bytes!==after.files[index].bytes)report.changed_fixtures.push(row.path);
    }catch(error){report.changed_fixtures=['fixture_source_unavailable'];report.fixture_source_after_error=error.name;}
  }
  report.stopped_at=new Date().toISOString();
  report.status=failures.length?'cleanup_failed':report.changed_inputs.length||report.changed_fixtures.length?'source_changed':status;
  report.source_after_sha256=report.source_after?digest(JSON.stringify(report.source_after)):null;
  await save();
}

await save();
let finalStatus='startup_failed';
try{
  report.source=await freeze();report.source_sha256=digest(JSON.stringify(report.source));await save();
  // Reuse is read-only and validated before database, Storage or Docker effects.
  if(argumentsMap.has('--fixtures-dir')){await bindFixtures();await save();}
  const info=JSON.parse(await readFile(join(servicesDirectory,'services.json'),'utf8'));
  assert(info.kind==='lovelies-openface-owned-local-v1'&&/^lovelies-openface-[a-f0-9]{12}$/.test(info.prefix),'Owned local services manifest required');
  assert(info.postgresContainer===info.prefix+'-postgres'&&new RegExp('^'+info.prefix+'-storage(?:-retry[0-9]+)?$').test(info.storageContainer)&&
    info.network===info.prefix+'-network'&&info.postgresVolume===info.prefix+'-postgres-data'&&info.storageVolume===info.prefix+'-storage-data',
  'Exact owned service resource names required');
  assert(info.images.postgres===POSTGRES&&info.images.storage===CLIENT,'Pinned owned images required');
  const environments=await privateEnvironment(join(servicesDirectory,'test.env'));
  const mlEnvironment=await privateEnvironment(argumentsMap.get('--ml-env'));
  assert(environments.TEST_DATABASE_URL&&environments.TEST_STORAGE_API_URL&&environments.TEST_STORAGE_SERVICE_KEY,'Owned service fields required');
  assert(mlEnvironment.ML_INFERENCE_URL&&mlEnvironment.ML_INFERENCE_SECRET?.length>=32,'Private ML HTTP fields required');
  const ml=localOrigin(mlEnvironment.ML_INFERENCE_URL),adminUrl=new URL(environments.TEST_DATABASE_URL);
  assert(['postgres:','postgresql:'].includes(adminUrl.protocol)&&['127.0.0.1','localhost','[::1]'].includes(adminUrl.hostname)&&
    Number(adminUrl.port)===info.postgresPort&&adminUrl.pathname==='/postgres'&&adminUrl.username==='supabase_admin'&&adminUrl.password&&!adminUrl.search&&!adminUrl.hash,
  'Exact owned local PostgreSQL administrator required');
  redactions.push(environments.TEST_DATABASE_URL,decodeURIComponent(adminUrl.password),adminUrl.password,
    environments.TEST_STORAGE_SERVICE_KEY,mlEnvironment.ML_INFERENCE_SECRET);
  const images={};
  for(const [label,image] of Object.entries({edge:EDGE,relay:CLIENT,postgres:POSTGRES})){
    const result=await docker('cached-'+label,['image','inspect','--format','{{.Id}} {{.Architecture}}',image]);
    const [id,architecture]=result.output.trim().split(/\s+/);assert(/^sha256:[a-f0-9]{64}$/.test(id),'Cached image identity required');images[label]={reference:image,id,architecture};
  }
  const containers={postgres:await inspect(info.postgresContainer),storage:await inspect(info.storageContainer)};
  for(const [name,container] of Object.entries(containers)){
    const image=name==='postgres'?images.postgres:images.relay;
    assert(container.running&&container.labels?.['lovelies.openface.owner']===info.prefix&&container.imageId===image.id&&
      container.image===image.reference&&container.networks?.[info.network],'Owned running service labels/image/network must match');
    const containerPort=name==='postgres'?'5432/tcp':'5000/tcp',hostPort=name==='postgres'?info.postgresPort:info.storagePort;
    const mappings=container.ports?.[containerPort];
    assert(Array.isArray(mappings)&&mappings.length===1&&mappings[0].HostIp==='127.0.0.1'&&Number(mappings[0].HostPort)===hostPort,'Owned service must bind exact loopback port');
    const volume=name==='postgres'?info.postgresVolume:info.storageVolume;
    assert(container.mounts.some(mount=>mount.Type==='volume'&&mount.Name===volume),'Exact retained owned volume required');
  }
  const network=await docker('inspect-network',['network','inspect','--format','{{index .Labels "lovelies.openface.owner"}}',info.network]);
  assert.equal(network.output.trim(),info.prefix,'Owned network label mismatch');
  report.images=images;report.services={prefix:info.prefix,network:info.network,postgres_container:info.postgresContainer,
    postgres_container_id:containers.postgres.id,storage_container:info.storageContainer,storage_container_id:containers.storage.id};
  shutdown.signal.throwIfAborted();
  await writeFile(lockPath,JSON.stringify({schema:1,prefix:info.prefix,owner,pid:process.pid,created_at:new Date().toISOString()})+'\n',{flag:'wx',mode:0o600});ownsLock=true;
  const listener=createServer();
  await new Promise((done,fail)=>{listener.once('error',fail);listener.listen(apiPort,'127.0.0.1',done);});
  await new Promise(done=>listener.close(done));
  const mlReady=await fetch(ml.origin+'/ready',{headers:{authorization:'Bearer '+mlEnvironment.ML_INFERENCE_SECRET},redirect:'manual',signal:AbortSignal.timeout(15000)});
  assert.equal(mlReady.status,200,'External actual ML readiness required');const loaded=await boundedJson(mlReady);
  assert(exactReadiness(loaded,ARTIFACT,PROCESSING),'Exact external ML artifact/generation/model contract required');
  for(const headers of [{},{authorization:'Bearer invalid'}]){
    const denied=await fetch(ml.origin+'/ready',{headers,redirect:'manual',signal:AbortSignal.timeout(15000)});
    assert.equal(denied.status,401,'External ML must deny missing/wrong service credentials');await denied.body?.cancel();
  }
  report.inference=loaded;report.inference_authentication={correct:200,missing:401,wrong:401};
  await privateBuckets(info,containers,environments);
  shutdown.signal.throwIfAborted();database=await isolatedPostgres(environments.TEST_DATABASE_URL);
  report.database={name:new URL(database.url).pathname.slice(1),new_database:true,schema_version:null};
  redactions.push(database.url);
  for(const name of MIGRATIONS){shutdown.signal.throwIfAborted();await database.engine.exec(await readFile(join(root,'supabase/migrations',name),'utf8'));}
  const versions=(await database.engine.query('SELECT version FROM lovelies_private.schema_versions ORDER BY version')).rows.map(row=>Number(row.version));
  assert.deepEqual(versions,[7,8,9,10,11],'All five actual production migrations required');report.database.schema_version=11;report.database.applied_versions=versions;
  if(!argumentsMap.has('--fixtures-dir')){
    await createEngineeringFixtures(fixturesDirectory);
    await command('fixture-manifest',process.execPath,[join(root,'android/app/src/androidTest/prepare-openface-manifest.mjs'),fixturesDirectory,apiOrigin]);
    await bindFixtures();
  }
  const manifest=report.fixture_manifest;
  const databaseTarget=new URL(database.url);databaseTarget.hostname='127.0.0.1';databaseTarget.port='54321';
  const maintenanceSecret=randomBytes(32).toString('hex');
  const environment={APP_ENV:'test',SUPABASE_URL:'http://127.0.0.1:54322',LOVELIES_DATABASE_URL:databaseTarget.href,
    LOVELIES_STORAGE_SECRET:environments.TEST_STORAGE_SERVICE_KEY,AUTH_SIGNING_SECRET:randomBytes(32).toString('hex'),
    MEDIA_SIGNING_SECRET:randomBytes(32).toString('hex'),INTERNAL_MAINTENANCE_SECRET:maintenanceSecret,
    FACE_AUTH_POLICY_VERSION:'face-policy-fixture-v1',PHOTO_MODEL_VERSION:'opencv-yunet-sface-2021dec-v1',
    PHOTO_CONSENT_POLICY_VERSION:'photo-policy-fixture-v1',PUBLIC_API_BASE_URL:publicOrigin,
    ALLOWED_ORIGINS:'http://127.0.0.1:8765',PUBLIC_APP_BASE_URL:'http://127.0.0.1:8765',
    ML_INFERENCE_URL:'http://127.0.0.1:54323',ML_INFERENCE_SECRET:mlEnvironment.ML_INFERENCE_SECRET,
    ML_INFERENCE_ARTIFACT_SHA256:ARTIFACT,ML_INFERENCE_PROCESSING_SHA256:PROCESSING,DENO_DIR:'/tmp/deno'};
  redactions.push(environment.AUTH_SIGNING_SECRET,environment.MEDIA_SIGNING_SECRET,maintenanceSecret,environment.LOVELIES_DATABASE_URL);
  const edgeEnvironment=join(directory,'edge.env'),relayEnvironment=join(directory,'relay.env');
  await writeFile(edgeEnvironment,Object.entries(environment).map(([key,value])=>key+'='+value).join('\n')+'\n',{flag:'wx',mode:0o600});
  await writeFile(relayEnvironment,[`RELAY_POSTGRES_HOST=${info.postgresContainer}`,`RELAY_STORAGE_HOST=${info.storageContainer}`,`RELAY_ML_PORT=${ml.port}`].join('\n')+'\n',{flag:'wx',mode:0o600});
  const restrictions=['--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','128',
    '--tmpfs','/tmp:rw,nosuid,nodev,size=134217728'];
  const mounts=['services/supabase-api/src','services/supabase-api/node_modules','services/supabase-api/test/isolated-native-edge',
    'supabase/functions/lovelies-api','node_modules'].flatMap(name=>['--mount',`type=bind,source=${join(root,name)},target=/workspace/${name},readonly`]);
  shutdown.signal.throwIfAborted();
  await docker('edge-start',['run','-d','--pull=never','--name',edgeName,'--label','lovelies.isolated-edge.owner='+owner,
    '--network',info.network,'--publish',`127.0.0.1:${apiPort}:9000`,'--env-file',edgeEnvironment,
    '--memory','1024m','--cpus','1',...restrictions,...mounts,EDGE,'start','--main-service',
    '/workspace/services/supabase-api/test/isolated-native-edge/main','--port','9000','--policy','per_request','--max-parallelism','3']);
  shutdown.signal.throwIfAborted();
  await docker('relay-start',['run','-d','--pull=never','--name',relayName,'--label','lovelies.isolated-edge.owner='+owner,
    '--network','container:'+edgeName,'--env-file',relayEnvironment,'--entrypoint','node','--memory','128m','--cpus','0.5',
    ...restrictions,'--mount',`type=bind,source=${join(root,'services/supabase-api/test/isolated-native-edge/loopback-relays.mjs')},target=/loopback-relays.mjs,readonly`,CLIENT,'/loopback-relays.mjs']);
  const deadline=Date.now()+90000;let health,readiness;
  while(Date.now()<deadline){
    shutdown.signal.throwIfAborted();
    try{
      const response=await fetch(apiOrigin+'/health',{redirect:'manual',signal:AbortSignal.timeout(5000)});
      if(response.status===200){health=await boundedJson(response);break;}await response.body?.cancel();
    }catch{}
    await pause(250);
  }
  assert(health?.status==='ok'&&health.database==='supabase_postgresql'&&health.database_ready===true&&health.schema_version===11,
    'Only production PostgreSQL/schema-11 health can establish API readiness');
  const readyResponse=await fetch(apiOrigin+'/ready',{redirect:'manual',signal:AbortSignal.timeout(20000)});
  assert.equal(readyResponse.status,200,'Production Edge readiness required');readiness=await boundedJson(readyResponse);
  assert(readiness.status==='ok'&&readiness.database==='supabase_postgresql'&&readiness.schema_version===11&&
    readiness.inference_ready===true&&Array.isArray(readiness.missing)&&readiness.missing.length===0,'Complete production inference readiness required');
  report.health=health;report.ready=readiness;report.status='ready';ready=true;finalStatus='stopped';await save();
  console.log(JSON.stringify({status:'ready',api_origin:apiOrigin,public_api_base_url:publicOrigin,fixture_manifest:manifest,
    runtime:join(directory,'runtime.json'),transport:report.transports.api}));
  maintenanceAbort=new AbortController();maintenance=maintenanceLoop(maintenanceSecret);
  // File or cron failures are material; leave the failure in the receipt and
  // stop this invocation rather than silently continuing an unobserved queue.
  maintenance.catch(error=>{report.failure={stage:'maintenance',error:error.name};finalStatus='maintenance_failed';stopRequested();});
  await stopped;
}catch(error){
  report.failure={stage:ready?'running':'startup',error:error.name,code:typeof error.code==='string'?error.code:undefined};
  await writeFile(join(directory,'failure-private.log'),redact(String(error.stack??error))+'\n',{mode:0o600});
  finalStatus=shutdown.signal.aborted?'interrupted':ready?'runtime_failed':'startup_failed';
}finally{
  try{await cleanup(finalStatus);}catch(error){
    report.status='cleanup_unknown';report.cleanup_error=error.name;report.stopped_at=new Date().toISOString();
    try{await save();}catch{}
  }
}
console.log(JSON.stringify({status:report.status,runtime:join(directory,'runtime.json')}));
process.exitCode=report.status==='stopped'?0:1;
