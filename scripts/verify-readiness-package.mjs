#!/usr/bin/env node
/** Sequential local verification. No deployment, signing, provider credentials,
 * production database, or live API is used. Failures/unexpected skips fail.
 * Named native-only cases remain explicit exclusions, never passing tests. */
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,readdir,open} from 'node:fs/promises';
import {resolve,dirname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const flags=new Map();
for(let i=2;i<process.argv.length;i++) {
  const flag=process.argv[i];
  if(!['--output','--only','--shard','--list'].includes(flag)||flags.has(flag))throw new Error('Use --output NEW_DIRECTORY [--only suite,suite] [--shard INDEX/TOTAL] or --list');
  if(flag==='--list'){flags.set(flag,true);continue;}
  const value=process.argv[++i];if(!value||value.startsWith('--'))throw new Error('Missing option value');flags.set(flag,value);
}
const files=async(directory,suffix='.test.mjs')=>(await readdir(resolve(root,directory))).filter(name=>name.endsWith(suffix)).sort().map(name=>directory+'/'+name);
const testArgs=['--expose-gc','--max-old-space-size=512','--experimental-transform-types','--test','--test-isolation=none','--test-concurrency=1','--test-timeout=180000','--test-reporter=tap'];
const suites=[
  {id:'api-typecheck',command:process.execPath,args:['node_modules/typescript/bin/tsc','--noEmit','--project','services/supabase-api/tsconfig.json']},
  {id:'admin',command:process.execPath,args:[...testArgs,...await files('admin')],tap:true},
  {id:'clients',command:process.execPath,args:[...testArgs,...await files('clients/backend')],tap:true},
  {id:'operator-queues',command:process.execPath,args:[...testArgs,'services/supabase-api/test/operator-queue-readiness.test.mjs'],tap:true},
  {id:'delivery',command:process.execPath,args:[...testArgs,'services/supabase-api/test/delivery-readiness-runtime.test.mjs'],tap:true},
  {id:'delivery-migration',command:process.execPath,args:[...testArgs,'services/supabase-api/test/delivery-migration.test.mjs'],tap:true},
  {id:'delivery-lifecycle',command:process.execPath,args:[...testArgs,'services/supabase-api/test/delivery-lifecycle.test.mjs'],tap:true},
  {id:'schema',command:process.execPath,args:[...testArgs,'services/supabase-api/test/supabase-boundaries.test.mjs'],tap:true},
  {id:'restore-database',command:process.execPath,args:[...testArgs,'services/supabase-api/test/restore-database.test.mjs'],tap:true},
  ...['notification-dispositions','notification-device-removal-race','notification-logout-delivery-race','notification-redirect-cancel','service-fetcher-push-consumer','job-stale-completion']
    .map(id=>({id,command:process.execPath,args:[...testArgs,'services/supabase-api/test/'+id+'.test.mjs'],tap:true})),
  {id:'push-provider',command:process.execPath,args:[...testArgs,...await files('services/push-provider/test')],tap:true},
  {id:'preview-server',command:'python3',args:['-m','unittest','discover','-s','scripts','-p','test_serve_preview.py']},
  {id:'ios-release-inputs',command:'python3',args:['-m','unittest','discover','-s','ios/Tests','-p','test_release_policy_urls.py']},
];
// Keep platform/service-dependent acceptance in its existing native lanes.
// Each added API file gets its own process so completed embedded PostgreSQL
// heaps cannot accumulate across an entire repository-wide run.
const externalOnly=new Map([
 ['deno-entrypoint','Deno and an isolated native PostgreSQL instance'],
 ['postgres-concurrency','independent native PostgreSQL pools'],
 ['postgres-migration','native PostgreSQL database owner/role checks'],
 ['restore-postcommit-runtime','independent native PostgreSQL commit boundary'],
 ['refresh-cancel-peer-runtime','independent native PostgreSQL pools'],
 ['openface-http','separately started recognition service and model assets'],
]);
const nativeCases=new Map([
 ['refresh-delivery','^real three-pool delivery replay, competing keys and cancellation have one authoritative successor$'],
 ['cleanup-scan-runtime','^native PostgreSQL cleanup scan coordinates separate pools$'],
]);
const alreadyCovered=new Set(suites.flatMap(suite=>suite.args).filter(arg=>arg.endsWith('.test.mjs')));
for(const file of await files('services/supabase-api/test')){
 const stem=file.split('/').at(-1).slice(0,-'.test.mjs'.length);
 if(alreadyCovered.has(file)||externalOnly.has(stem))continue;
 const omitted=nativeCases.get(stem);
 suites.push({id:'api-'+stem,command:process.execPath,args:[...testArgs,...(omitted?['--test-name-pattern','^(?!'+omitted.slice(1)+').*$']:[]),file],tap:true,
   ...(omitted?{excluded_native_case:omitted}:{} )});
}
for(const file of await files('services/restore-journal/test'))suites.push({id:'journal-'+file.split('/').at(-1).slice(0,-'.test.mjs'.length),command:process.execPath,args:[...testArgs,file],tap:true});
if(flags.get('--list')){console.log(JSON.stringify(suites.map(x=>({id:x.id,command:[x.command,...x.args]})),null,2));process.exit(0);}
if(!flags.has('--output'))throw new Error('--output must name a new evidence directory');
const output=resolve(flags.get('--output'));
if(!isAbsolute(flags.get('--output')))throw new Error('--output must be absolute');
let selected=flags.has('--only')?flags.get('--only').split(','):suites.map(x=>x.id);
if(!selected.length||new Set(selected).size!==selected.length||selected.some(id=>!suites.some(x=>x.id===id)))throw new Error('Unknown or duplicate suite');
let shard=null;
if(flags.has('--shard')){
 const match=/^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(flags.get('--shard'));
 if(!match||Number(match[1])>Number(match[2])||Number(match[2])>32)throw new Error('Invalid shard INDEX/TOTAL');
 shard={index:Number(match[1]),total:Number(match[2])};selected=selected.filter((_,index)=>index%shard.total===shard.index-1);
 if(!selected.length)throw new Error('Empty shard');
}
await mkdir(output,{recursive:false});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function gitRead(args){
 return new Promise((resolveGit,reject)=>{
  const child=spawn('git',args,{cwd:root,stdio:['ignore','pipe','pipe']}),chunks=[],errors=[];
  child.stdout.on('data',chunk=>chunks.push(chunk));child.stderr.on('data',chunk=>errors.push(chunk));
  child.on('error',reject);child.on('close',code=>code===0?resolveGit(Buffer.concat(chunks).toString('utf8')):reject(new Error('Git inventory failed: '+Buffer.concat(errors).toString('utf8'))));
 });
}
async function sourceDigest() {
  const names=(await gitRead(['ls-files','-z','--cached','--others','--exclude-standard'])).split('\0')
    .filter(name=>name&&!name.startsWith('verification/')&&!name.startsWith('docs/')&&/\.(ts|mjs|cjs|js|kt|kts|swift|sql|py|json|jsonc|yml|yaml|xml|properties|sh|plist|xcconfig|pbxproj|xcscheme|entitlements|strings|stringsdict)$/.test(name));
  const h=createHash('sha256'),sources={};
  for(const name of [...new Set(names)].sort()){const digest=hash(await readFile(resolve(root,name)));sources[name]=digest;h.update(name+'\0');h.update(digest+'\0');}
  return {digest:h.digest('hex'),files:sources};
}
const before=await sourceDigest(),started=new Date().toISOString(),results=[];
const env={...process.env};delete env.TEST_DATABASE_URL;delete env.LOVELIES_DISPOSABLE_PG_TEST; // Force disposable in-process PostgreSQL fixtures.
async function run(suite) {
  const stdoutPath=resolve(output,suite.id+'.stdout.log'),stderrPath=resolve(output,suite.id+'.stderr.log');
  // Direct file descriptors preserve complete output even on runtimes that
  // cannot reliably drain nested test-runner pipes. They also bound RAM use.
  const stdoutFile=await open(stdoutPath,'wx'),stderrFile=await open(stderrPath,'wx');
  return new Promise(resolveRun=>{
    const start=Date.now();let timedOut=false,spawnError=null;
    const child=spawn(suite.command,suite.args,{cwd:root,env,stdio:['ignore',stdoutFile.fd,stderrFile.fd]});
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');},900000);
    const hardTimer=setTimeout(()=>child.kill('SIGKILL'),905000);
    child.on('error',error=>{spawnError=error.code??'spawn_failed';});
    child.on('close',async(code,signal)=>{
      clearTimeout(timer);clearTimeout(hardTimer);await stdoutFile.close();await stderrFile.close();
      resolveRun({code,signal,timedOut,spawnError,duration_ms:Date.now()-start,stdout:await readFile(stdoutPath),stderr:await readFile(stderrPath)});
    });
  });
}
function tapSummary(bytes) {
  const text=bytes.toString('utf8'),result={};
  for(const key of ['tests','pass','fail','cancelled','skipped','todo']) {
    const matches=[...text.matchAll(new RegExp('^# '+key+' (\\d+)\\s*$','gm'))];
    if(matches.length!==1)return null;result[key]=Number(matches[0][1]);
  }
  return result;
}
function nativeExclusions(suite,bytes,summary) {
  if(!suite.excluded_native_case||!summary?.skipped)return [];
  const allowed=new RegExp(suite.excluded_native_case);
  const names=[...bytes.toString('utf8').matchAll(/^ok \d+ - (.+?) # SKIP(?: .*)?$/gm)].map(match=>match[1]);
  if(names.length!==summary.skipped||names.some(name=>!allowed.test(name)))return [];
  return names.map(name=>({name,reason:'Requires independent native PostgreSQL pools; not executed by the embedded local fixture.'}));
}
for(const suite of suites.filter(x=>selected.includes(x.id))) {
  console.log('Running '+suite.id);
  const actual=await run(suite),summary=suite.tap?tapSummary(actual.stdout):null;
  const excluded=nativeExclusions(suite,actual.stdout,summary);
  const passed=actual.code===0&&!actual.timedOut&&!actual.spawnError&&(!suite.tap||summary&&summary.pass>0&&summary.pass+excluded.length===summary.tests&&summary.fail===0&&summary.cancelled===0&&summary.skipped===excluded.length&&summary.todo===0);
  const status=passed?(excluded.length?'passed_with_native_exclusions':'passed'):'failed';
  results.push({id:suite.id,status,command:[suite.command,...suite.args],cwd:'.',exit_code:actual.code,signal:actual.signal,
    ...(excluded.length?{excluded_tests:excluded}:{}),
    ...(suite.excluded_native_case?{excluded_native_case:suite.excluded_native_case}:{}),timed_out:actual.timedOut,spawn_error:actual.spawnError,duration_ms:actual.duration_ms,tap:summary,
    stdout_sha256:hash(actual.stdout),stderr_sha256:hash(actual.stderr)});
  await writeFile(resolve(output,'progress.json'),JSON.stringify({started_at:started,source_files:before.files,results},null,2)+'\n');
  console.log(suite.id+': '+(passed?status:'FAILED')+' (exit '+actual.code+(actual.signal?', '+actual.signal:'')+')');
}
const after=await sourceDigest(),stable=before.digest===after.digest,passed=stable&&results.every(x=>['passed','passed_with_native_exclusions'].includes(x.status));
await writeFile(resolve(output,'result.json'),JSON.stringify({protocol:'lovelies-local-readiness-evidence-v1',started_at:started,finished_at:new Date().toISOString(),
  status:passed?'passed':'failed',source_inputs_stable:stable,source_sha256_before:before.digest,source_sha256_after:after.digest,source_files:before.files,shard,
  base_commit:(await gitRead(['rev-parse','HEAD'])).trim(),node:process.version,selected_suites:selected,external_acceptance_exclusions:Object.fromEntries(externalOnly),mixed_suite_exclusions:Object.fromEntries(nativeCases),
  scope:'Source/local fixtures only; no hosted, physical-device, provider, signing, store or recovery-drill acceptance.',results},null,2)+'\n');
console.log(JSON.stringify({status:passed?'passed':'failed',source_inputs_stable:stable,report:resolve(output,'result.json')}));
process.exitCode=passed?0:1;
