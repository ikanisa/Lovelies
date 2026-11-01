#!/usr/bin/env node
/** Credential-free local regressions with exact-source, per-file checkpoints.
 * This never deploys, qualifies native/store builds, or connects to PostgreSQL. */
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(Number(process.versions.node.split('.')[0])<24)throw Error('Node 24 or newer is required');
const args=process.argv.slice(2);
if(args.length && (args.length!==2||!['--output','--resume'].includes(args[0])))
  throw Error('Usage: node scripts/verify-local-readiness.mjs [--output /new/directory | --resume /incomplete/directory]');
const resume=args[0]==='--resume';
const output=path.resolve(args[1]??path.join(root,'verification','local-readiness-'+new Date().toISOString().replaceAll(':','-')));
const environment={...process.env,WRANGLER_SEND_METRICS:'false',CI:'true'};
delete environment.TEST_DATABASE_URL;
const files=async(directory,pattern)=>(await fs.readdir(path.join(root,directory))).filter(name=>pattern.test(name)).sort().map(name=>path.join(directory,name));
const node=process.execPath;
const testArgs=['--experimental-transform-types','--test','--test-isolation=none','--test-reporter=tap','--test-concurrency=1'];
const group=(name,command,args)=>({name,units:[{id:name,command,args}]});
const fileGroup=(name,paths,extra=[])=>({name,units:paths.map(file=>({id:name+'/'+path.basename(file),command:node,args:[...extra,...testArgs,file]}))});
const tasks=[
  group('backend-typecheck',node,['node_modules/typescript/bin/tsc','--noEmit','-p','services/supabase-api/tsconfig.json']),
  group('admin-and-client',node,[...testArgs,...await files('admin',/\.test\.mjs$/),...await files('clients/backend',/\.test\.mjs$/)]),
  // Explicit one-file children avoid retained Wasm memory and nested test-runner
  // buffering. Only a completed named-test result becomes a durable checkpoint.
  fileGroup('backend-regressions',await files('services/supabase-api/test',/\.test\.mjs$/),
    ['--max-old-space-size=256','--expose-gc','--import','./services/supabase-api/test/offline-regression-guard.mjs','--test-timeout=120000']),
  group('preview-server','python3',['-m','unittest','discover','-s','scripts','-p','test_serve_preview.py']),
  fileGroup('push-provider',await files('services/push-provider/test',/\.test\.mjs$/)),
  fileGroup('restore-journal',await files('services/restore-journal/test',/\.test\.mjs$/)),
  fileGroup('backup-custody',await files('scripts/test',/^(?:backup-.*|encrypted-backup)\.test\.mjs$/)),
  fileGroup('link-association',['services/link-association-worker/test/worker.test.mjs']),
];
if(tasks.some(task=>task.units.length===0))throw Error('A required verification group has no test files.');
const sha=value=>createHash('sha256').update(value).digest('hex');
const commands=tasks.map(task=>({name:task.name,units:task.units.map(unit=>({...unit,command:unit.command===node?'node':unit.command}))}));
const commandFingerprint=sha(JSON.stringify(commands));
const git=promisify(execFile);
const relativeOutput=path.relative(root,output);
const outputInsideRepo=relativeOutput!==''&&!relativeOutput.startsWith('..'+path.sep)&&!path.isAbsolute(relativeOutput);
// Tests also read public assets and release fixtures outside their own source
// directories. Hash the whole git inventory except the separately verified
// native lane and generated evidence, so a changed fixture cannot reuse a pass.
const included=name=>!name.startsWith('verification/')&&
  !(outputInsideRepo&&(name===relativeOutput||name.startsWith(relativeOutput+'/')))&&
  !/^(?:ios\/|android\/|scripts\/(?:test_android_|test-ios-|test-fixtures\/android-))/.test(name);
async function inputSnapshot(){
  const inventory=(await git('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:root,maxBuffer:16*1024*1024})).stdout.split('\0');
  const hashes={};
  for(const name of [...new Set(inventory.filter(name=>name&&included(name)))].sort()){
    const source=path.join(root,name),stat=await fs.lstat(source);
    hashes[name]=sha(stat.isSymbolicLink()?'symlink:'+await fs.readlink(source):await fs.readFile(source));
  }
  return hashes;
}
const inputHashes=await inputSnapshot();
const sourceFingerprint=sha(JSON.stringify(inputHashes));
await fs.mkdir(output,{recursive:true});
const summaryPath=path.join(output,'result.json'),lockPath=path.join(output,'runner.lock');
let summary;
if(resume){
  summary=JSON.parse(await fs.readFile(summaryPath,'utf8'));
  if(summary.protocol!=='lovelies-local-readiness-v3'||summary.source_fingerprint!==sourceFingerprint||
      summary.command_fingerprint!==commandFingerprint||summary.node!==process.versions.node)
    throw Error('Resume refused: source, commands or Node version differ. Start a new evidence directory.');
  if(JSON.stringify(JSON.parse(await fs.readFile(path.join(output,'inputs.json'),'utf8')))!==JSON.stringify(inputHashes))
    throw Error('Resume refused: input evidence differs.');
}else{
  if((await fs.readdir(output)).length)throw Error('Evidence directory must be empty; earlier results are never overwritten');
  summary={protocol:'lovelies-local-readiness-v3',status:'running',started_at:new Date().toISOString(),node:process.versions.node,
    scope:'Local synthetic fixtures only; external database environment removed; no deployment or native release acceptance',
    source_fingerprint:sourceFingerprint,command_fingerprint:commandFingerprint,expected_groups:tasks.map(task=>task.name),
    active_group:null,active_unit:null,results:[],completed_units:{},attempts:{},interruptions:[]};
  await fs.writeFile(path.join(output,'inputs.json'),JSON.stringify(inputHashes,null,2)+'\n',{mode:0o600});
}
// Never run two controllers against the same evidence. A dead controller can
// be resumed; a live/reused PID is conservatively held rather than signalled.
let lock;
try{lock=await fs.open(lockPath,'wx',0o600);}
catch(error){
  if(error.code!=='EEXIST'||!resume)throw error;
  const recoveryPath=path.join(output,'resume.lock'),recovery=await fs.open(recoveryPath,'wx',0o600);
  try{
    const previous=await fs.readFile(lockPath,'utf8'),owner=JSON.parse(previous);
    if(!Number.isSafeInteger(owner.pid)||owner.pid<1)throw Error('Invalid runner lock; use a new evidence directory.');
    let absent=false;
    try{process.kill(owner.pid,0);}catch(problem){if(problem.code==='ESRCH')absent=true;else throw problem;}
    if(!absent)throw Error('Runner lock owner is still present; resume refused.');
    if(await fs.readFile(lockPath,'utf8')!==previous)throw Error('Runner lock changed; resume refused.');
    await fs.unlink(lockPath);lock=await fs.open(lockPath,'wx',0o600);
  }finally{await recovery.close();await fs.unlink(recoveryPath);}
}
await lock.writeFile(JSON.stringify({pid:process.pid,started_at:new Date().toISOString()})+'\n');
await lock.sync();
const persist=async()=>{
  const temporary=summaryPath+'.tmp';
  await fs.writeFile(temporary,JSON.stringify(summary,null,2)+'\n',{mode:0o600});
  await fs.rename(temporary,summaryPath);
};
const parseCounts=(text,command,exitCode)=>{
  const counts=Object.fromEntries([...text.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm)].map(match=>[match[1],Number(match[2])]));
  if(command==='python3'){
    const ran=/^Ran (\d+) tests? /m.exec(text);
    if(ran)Object.assign(counts,{tests:Number(ran[1]),pass:exitCode===0?Number(ran[1]):null,fail:exitCode===0?0:null});
  }
  return counts;
};
try{
  if(resume&&summary.active_unit)summary.interruptions.push({unit:summary.active_unit,resumed_at:new Date().toISOString(),previous_status:summary.status});
  summary.status='running';delete summary.finished_at;
  await persist();
  for(const task of tasks){
    summary.active_group=task.name;
    process.stdout.write(`Running ${task.name}\n`);
    const completed=[];
    for(const unit of task.units){
      const retained=summary.completed_units[unit.id];
      if(retained){
        const text=await fs.readFile(path.join(output,retained.log),'utf8');
        if(retained.exit_code!==0||retained.signal||retained.spawn_error||retained.verification_error||
            retained.id!==unit.id||sha(text)!==retained.log_sha256||
            JSON.stringify(retained.counts)!==JSON.stringify(parseCounts(text,unit.command,0)))
          throw Error('Completed unit evidence is invalid: '+unit.id);
        completed.push(retained);continue;
      }
      summary.active_unit=unit.id;
      const attempt=(summary.attempts[unit.id]??0)+1;summary.attempts[unit.id]=attempt;
      await persist();
      const logName=unit.id+'-attempt-'+attempt+'.log',logPath=path.join(output,logName);
      await fs.mkdir(path.dirname(logPath),{recursive:true});
      const log=await fs.open(logPath,'wx',0o600),started=Date.now();
      let exitCode=null,signal=null,spawnError=null;
      try{
        const result=await new Promise(resolve=>{
          const child=spawn(unit.command,unit.args,{cwd:root,env:environment,stdio:['ignore',log.fd,log.fd],shell:false});
          child.once('error',error=>{spawnError=error.code??'spawn_failed';});
          child.once('close',(code,closedSignal)=>resolve({code,signal:closedSignal}));
        });
        exitCode=result.code;signal=result.signal;
      }finally{await log.close();}
      const logText=await fs.readFile(logPath,'utf8'),counts=parseCounts(logText,unit.command,exitCode);
      const verificationError=task.name!=='backend-typecheck'&&(!Number.isSafeInteger(counts.tests)||counts.tests<1)?'test_counts_missing':
        (counts.fail??0)>0||(counts.cancelled??0)>0?'test_failures_present':null;
      const result={id:unit.id,command:[unit.command===node?'node':unit.command,...unit.args],exit_code:exitCode,
        signal,spawn_error:spawnError,verification_error:verificationError,duration_ms:Date.now()-started,
        log:logName,log_sha256:sha(logText),counts};
      if(exitCode!==0||signal||spawnError||verificationError){
        summary.status='failed';summary.failed_unit=result;summary.finished_at=new Date().toISOString();
        await persist();process.stdout.write(logText.split('\n').slice(-45).join('\n')+'\n');
        process.exitCode=1;break;
      }
      summary.completed_units[unit.id]=result;completed.push(result);summary.active_unit=null;delete summary.failed_unit;
      await persist();
      if(task.units.length>1)process.stdout.write(`  ${path.basename(unit.id)}: passed (${completed.length}/${task.units.length})\n`);
    }
    if(summary.status==='failed')break;
    const counts={};
    for(const row of completed)for(const [name,value] of Object.entries(row.counts))counts[name]=(counts[name]??0)+value;
    const result={name:task.name,exit_code:0,signal:null,spawn_error:null,verification_error:null,
      duration_ms:completed.reduce((sum,row)=>sum+row.duration_ms,0),counts,units:completed.map(row=>row.id)};
    summary.results=summary.results.filter(row=>row.name!==task.name);summary.results.push(result);
    summary.results.sort((a,b)=>tasks.findIndex(task=>task.name===a.name)-tasks.findIndex(task=>task.name===b.name));
    await persist();process.stdout.write(`${task.name}: passed\n`);
  }
  if(summary.status!=='failed'){
    if(sha(JSON.stringify(await inputSnapshot()))!==sourceFingerprint)
      throw Error('Source changed during verification; the completed units are retained but the aggregate is not accepted.');
    summary.status=summary.results.length===tasks.length?'passed':'failed';
    summary.finished_at=new Date().toISOString();summary.active_group=null;summary.active_unit=null;
    await persist();
  }
}catch(error){
  summary.status='interrupted';summary.interruption_error=error instanceof Error?error.message:'runner_interrupted';
  summary.finished_at=new Date().toISOString();await persist();throw error;
}finally{
  await lock.close();
  const current=JSON.parse(await fs.readFile(lockPath,'utf8'));
  if(current.pid===process.pid)await fs.unlink(lockPath);
}
process.stdout.write(`Evidence: ${output}\n`);
