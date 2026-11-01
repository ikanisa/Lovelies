#!/usr/bin/env node
/** Explicit offline key rotation. Unknown outcomes keep all application paths closed. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
import {args,runtime,compose,command,sql,withOperationLock,requireCompose,privateRequest} from './local-supabase-common.mjs';
import {envText,parseEnv} from './local-supabase-configure.mjs';
import {validateValues} from './local-supabase-check.mjs';
import {ROTATION_PROTOCOL,ROTATION_ABORT_PROTOCOL,canonical,digest,decodeKey,rotationKeys,sealEscrow,openEscrow,sealIntent,openIntent} from './local-supabase-managed-auth-rotation-core.mjs';
import {privateRead,readDurable,readImmutable,writeImmutable,syncDirectory,compareAndSwapFile,readLifecycle,requireOpenLifecycle,setLifecycle,lifecycle} from './local-supabase-lifecycle.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const known=new Set(['db','api-gw','imgproxy','ml-face','ml-proxy','functions','auth','rest','storage','realtime','supavisor','studio','meta','push-provider','public-proxy']);
const nonwriters=new Set(['db','api-gw','imgproxy','ml-face','ml-proxy']);
const same=(a,b)=>canonical(a)===canonical(b);
const bytes=value=>Buffer.from(canonical(value)+'\n');
export function validateRotationInputs(r,environment=r.api){
 if(validateValues({...r,api:environment}).errors.length||r.app.POSTGRES_HOST!=='db'||r.app.POSTGRES_DB!=='postgres'||String(r.app.POSTGRES_PORT)!=='5432')throw Error('rotation_local_profile_invalid');
 const database=value=>{const url=new URL(value);
  return ['postgres:','postgresql:'].includes(url.protocol)&&url.hostname==='db'&&(!url.port||url.port==='5432')&&url.username==='lovelies_runtime'&&url.password===r.app.LOVELIES_API_DATABASE_PASSWORD&&url.pathname==='/postgres'&&!url.search&&!url.hash;
 };
 if(!database(environment.LOVELIES_DATABASE_URL)||environment.SUPABASE_DB_URL&&!database(environment.SUPABASE_DB_URL)||
   environment.LOVELIES_DATABASE_TLS_MODE!=='disable-internal'||environment.LOVELIES_DATABASE_PLAINTEXT_HOSTS!=='db'||environment.LOVELIES_DATABASE_CA||
   environment.INTERNAL_SUPABASE_URL!=='http://api-gw:8000'||environment.RESTORE_JOURNAL_URL!=='https://restore-journal:8443')throw Error('rotation_local_profile_invalid');
}
export function validateRenderedRotationProfile(r,config){
 validateRotationInputs(r);
 for(const name of ['functions','operator']){
  const service=config.services[name],environment=service?.environment;if(!environment)throw Error('rotation_effective_profile_invalid');
  validateRotationInputs(r,environment);
  if(environment.MANAGED_AUTH_ENCRYPTION_KEY!==r.api.MANAGED_AUTH_ENCRYPTION_KEY||
   !service.volumes?.some(value=>value.target==='/run/lovelies/lifecycle'&&value.source===path.join(r.directory,'lifecycle')&&value.read_only===true))throw Error('rotation_effective_profile_invalid');
 }
 const functions=config.services.functions;
 if(!functions.volumes.some(value=>value.target==='/home/deno/functions/main'&&value.source===path.join(r.config.deployment_root,'functions-main')&&value.read_only===true)||
  config.services.db.environment.POSTGRES_DB!=='postgres')throw Error('rotation_effective_profile_invalid');
}
async function effectiveProfile(r){
 const out=await compose(r,'application',['--profile','*','config','--format','json']);validateRenderedRotationProfile(r,JSON.parse(out.stdout));
}
async function runningApiProfile(r){
 const id=(await compose(r,'application',['ps','-q','functions'])).stdout.toString().trim();
 if(!/^[0-9a-f]{12,64}$/.test(id))throw Error('rotation_initial_runtime_not_running');
 const out=await command('docker',['inspect','--format','{{json .Config.Env}}',id]);
 const environment=Object.fromEntries(JSON.parse(out.stdout).map(entry=>{const split=entry.indexOf('=');return [entry.slice(0,split),entry.slice(split+1)];}));
 validateRotationInputs(r,environment);
 if(environment.MANAGED_AUTH_ENCRYPTION_KEY!==r.api.MANAGED_AUTH_ENCRYPTION_KEY)throw Error('rotation_running_key_mismatch');
}
async function optional(filename){try{return await readImmutable(filename);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function immutableOrSame(filename,value){const existing=await optional(filename),next=bytes(value);if(existing){if(!existing.equals(next))throw Error('rotation_record_changed');return;}await writeImmutable(filename,next);}
async function runningServices(){
 const out=await command('docker',['ps','--filter','label=com.docker.compose.project=lovelies-app','--format','{{.ID}} {{.Label "com.docker.compose.service"}} {{.Label "com.docker.compose.oneoff"}}']);
 const services=[];
 for(const line of out.stdout.toString().trim().split('\n').filter(Boolean)){
  const [id,service,oneoff]=line.trim().split(/\s+/);
  if(!/^[0-9a-f]{12,64}$/.test(id)||!known.has(service)||oneoff?.toLowerCase()==='true'||services.includes(service))throw Error('rotation_unexpected_running_container');
  services.push(service);
 }
 return services.sort();
}
async function cronSnapshot(r){
 const result=JSON.parse((await sql(r,"SELECT COALESCE(json_agg(json_build_object('jobid',jobid,'jobname',jobname,'schedule',schedule,'command',command,'database',database,'username',username,'active',active) ORDER BY jobid),'[]'::json) FROM cron.job;")).text);
 if(result.some(job=>job.active&&job.jobname!=='lovelies-private-maintenance'))throw Error('rotation_other_scheduled_writers_require_review');
 const jobs=result.filter(job=>job.jobname==='lovelies-private-maintenance');
 if(jobs.length!==1||!Number.isSafeInteger(jobs[0].jobid)||jobs[0].database!=='postgres'||jobs[0].command!=='SELECT lovelies_deployment.schedule_maintenance_request()'||typeof jobs[0].active!=='boolean')throw Error('rotation_scheduler_boundary_invalid');
 return jobs;
}
async function cronState(r,expected,active){
 const current=await cronSnapshot(r);
 if(!same(current.map(({active,...value})=>value),expected.map(({active,...value})=>value)))throw Error('rotation_scheduler_changed');
 await sql(r,'UPDATE cron.job SET active='+(active?'true':'false')+' WHERE jobid='+expected[0].jobid+';');
 const checked=await cronSnapshot(r);if(checked[0].active!==active)throw Error('rotation_scheduler_readback_failed');
}
async function quiesce(r,escrow){
 await setLifecycle(r.directory,lifecycle('blocked',escrow.rotation_id,parseEnv((await privateRead(path.join(r.directory,'api.env'))).toString()).MANAGED_AUTH_ENCRYPTION_KEY));
 // Persistently deny new runtime sessions before stopping known writers. The
 // worker also rejects any still-connected runtime session under the SQL lock.
 await sql(r,'ALTER ROLE lovelies_runtime NOLOGIN;');
 await cronState(r,escrow.cron,false);
 const services=(await runningServices()).filter(service=>!nonwriters.has(service));
 if(services.length)await compose(r,'application',['--profile','inference','stop','--timeout','60',...services],{timeout:240000});
 if((await runningServices()).some(service=>!nonwriters.has(service)))throw Error('rotation_writers_not_stopped');
}
async function worker(r,escrow,action,extra={}){
 const rotation=parseEnv((await privateRead(path.join(r.directory,'rotation.env'))).toString());
 if(digest(await privateRead(path.join(r.directory,'rotation.env')))!==escrow.rotation_environment_sha256)throw Error('rotation_operator_configuration_changed');
 const input=Buffer.from(JSON.stringify({command:action,rotation_id:escrow.rotation_id,database_url:rotation.LOVELIES_ROTATION_DATABASE_URL,old_key:escrow.old_key,new_key:escrow.new_key,...extra}));
 try{const out=await compose(r,'application',['--profile','operations','run','--rm','--no-deps','-T','--entrypoint','node','operator','--experimental-transform-types','scripts/local-supabase-managed-auth-rotation-worker.mjs'],{input,timeout:900000,maxBytes:65536});return JSON.parse(out.stdout.toString());}
 finally{input.fill(0);}
}
async function loadEscrow(directory,master){
 const raw=await readImmutable(path.join(directory,'keys.enc.json')),value=openEscrow(JSON.parse(raw.toString()),master);
 if(value.protocol!==ROTATION_PROTOCOL||!UUID.test(value.rotation_id)||!Array.isArray(value.running_services)||value.running_services.some(service=>!known.has(service))||!value.running_services.includes('functions')||!value.running_services.includes('auth'))throw Error('rotation_escrow_invalid');
 const before=Buffer.from(value.api_before,'base64'),after=Buffer.from(value.api_after,'base64');
 try{
  if(digest(before)!==value.api_before_sha256||digest(after)!==value.api_after_sha256)throw Error('rotation_escrow_invalid');
  const prior=parseEnv(before.toString()),next=parseEnv(after.toString());
  if(prior.MANAGED_AUTH_ENCRYPTION_KEY!==value.old_key||next.MANAGED_AUTH_ENCRYPTION_KEY!==value.new_key||!same({...prior,MANAGED_AUTH_ENCRYPTION_KEY:value.new_key},next))throw Error('rotation_escrow_invalid');
  const keys=rotationKeys(value.old_key,value.new_key,[prior.AUTH_SIGNING_SECRET,prior.MEDIA_SIGNING_SECRET,master.toString('base64')]);keys.oldKey.fill(0);keys.newKey.fill(0);
 }finally{before.fill(0);after.fill(0);}
 return {value,sha256:digest(raw)};
}
async function createEscrow(r,directory,id,master){
 const gate=await requireOpenLifecycle(r.directory,r.api.MANAGED_AUTH_ENCRYPTION_KEY);
 const before=await readDurable(path.join(r.directory,'api.env'));
 try{
  const prior=parseEnv(before.toString()),generatedKey=randomBytes(32);let nextKey;
  try{nextKey=generatedKey.toString('base64');}finally{generatedKey.fill(0);}
  const keys=rotationKeys(prior.MANAGED_AUTH_ENCRYPTION_KEY,nextKey,[prior.AUTH_SIGNING_SECRET,prior.MEDIA_SIGNING_SECRET,master.toString('base64')]);keys.oldKey.fill(0);keys.newKey.fill(0);
  const after=Buffer.from(envText({...prior,MANAGED_AUTH_ENCRYPTION_KEY:nextKey}));
  try{
   const services=await runningServices();if(!services.includes('functions')||!services.includes('auth')||(await sql(r,"SELECT rolcanlogin FROM pg_roles WHERE rolname='lovelies_runtime';")).text!=='t')throw Error('rotation_initial_runtime_not_running');
   await runningApiProfile(r);
   const value={protocol:ROTATION_PROTOCOL,rotation_id:id,created_at:Date.now(),old_key:prior.MANAGED_AUTH_ENCRYPTION_KEY,new_key:nextKey,
    api_before:before.toString('base64'),api_after:after.toString('base64'),api_before_sha256:digest(before),api_after_sha256:digest(after),
    rotation_environment_sha256:digest(await privateRead(path.join(r.directory,'rotation.env'))),application_environment_sha256:digest(await privateRead(path.join(r.directory,'app.env'))),gate_before:gate,running_services:services,cron:await cronSnapshot(r)};
   await writeImmutable(path.join(directory,'keys.enc.json'),bytes(sealEscrow(value,master)));
   const readback=await loadEscrow(directory,master);if(!same(readback.value,value))throw Error('rotation_escrow_readback_failed');return readback;
  }finally{after.fill(0);}
 }finally{before.fill(0);}
}
export async function ensureRotationDirectory(r,id,{afterMkdir}={}){
 if(!UUID.test(id))throw Error('rotation_identity_invalid');
 const base=path.join(r.directory,'managed-auth-rotations'),info=await fs.lstat(base);
 if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0)throw Error('rotation_directory_invalid');
 const directory=path.join(base,id);try{await fs.mkdir(directory,{mode:0o700});await afterMkdir?.();}catch(error){if(error.code!=='EEXIST')throw error;}
 const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)throw Error('rotation_directory_invalid');
 // EEXIST can follow a lost mkdir acknowledgement before its parent was synced.
 // Finish both directory barriers before any key escrow or database operation.
 await syncDirectory(directory);await syncDirectory(base);return directory;
}
async function authorization(directory,master,intent,receipt,escrow){
 const value=openEscrow(JSON.parse((await readImmutable(path.join(directory,'resume.enc.json'))).toString()),master);
 const aborted=receipt.protocol===ROTATION_ABORT_PROTOCOL,key=aborted?escrow.old_key:escrow.new_key,configuration=aborted?escrow.api_before_sha256:escrow.api_after_sha256;
 if(value.protocol!=='lovelies-managed-auth-rotation-resume-v1'||value.rotation_id!==intent.rotation_id||value.intent_sha256!==digest(canonical(intent))||value.receipt_sha256!==digest(canonical(receipt))||value.api_sha256!==configuration||value.outcome!==(aborted?'aborted':'committed')||!same(value.gate,lifecycle('open',intent.rotation_id,key)))throw Error('rotation_resumption_authority_invalid');
 const readback=await readImmutable(path.join(directory,'runtime-readback.json'));
 if(value.readback_sha256!==digest(readback))throw Error('rotation_resumption_authority_invalid');return value;
}
export async function rotateManagedAuth(r,operation,id){
 if(!['rotate','verify','abort','resume','resume-aborted'].includes(operation)||!UUID.test(id))throw Error('rotation_arguments_invalid');
 return withOperationLock(r,'managed-auth-key-rotation',async()=>{
  await requireCompose();await effectiveProfile(r);const directory=await ensureRotationDirectory(r,id);
  const masterBytes=await readDurable(path.join(r.directory,'backup.key'),{maximum:128}),master=decodeKey(masterBytes.toString().trim());masterBytes.fill(0);
  try{
   let saved=await optional(path.join(directory,'keys.enc.json'));
   if(!saved&&operation!=='rotate')throw Error('rotation_escrow_required');
   const {value:escrow,sha256:escrowHash}=saved?await loadEscrow(directory,master):await createEscrow(r,directory,id,master);
   if(escrow.rotation_id!==id)throw Error('rotation_identity_invalid');
   if(digest(await privateRead(path.join(r.directory,'app.env')))!==escrow.application_environment_sha256)throw Error('rotation_application_configuration_changed');
   let gate=await readLifecycle(r.directory),current=digest(await privateRead(path.join(r.directory,'api.env')));
   if(![escrow.api_before_sha256,escrow.api_after_sha256].includes(current))throw Error('rotation_configuration_changed');
   const sealed=await optional(path.join(directory,'intent.json'));
   let intent=sealed?openIntent(JSON.parse(sealed.toString()),master):null;
   if(intent&&(intent.rotation_id!==id||intent.escrow_sha256!==escrowHash||intent.api_before_sha256!==escrow.api_before_sha256||intent.api_after_sha256!==escrow.api_after_sha256))throw Error('rotation_intent_invalid');
   if(gate.state==='open'&&gate.rotation_id===id){
    if(!intent)throw Error('rotation_completed_state_invalid');
    const receipt=JSON.parse((await readImmutable(path.join(directory,'database-receipt.json'))).toString());
    const aborted=receipt.protocol===ROTATION_ABORT_PROTOCOL;
    if(aborted&&['rotate','resume'].includes(operation))throw Error('rotation_operation_retired_by_recovery');
    if(!aborted&&['abort','resume-aborted'].includes(operation))throw Error('rotation_positive_receipt_cannot_abort');
    if(current!==(aborted?escrow.api_before_sha256:escrow.api_after_sha256))throw Error('rotation_completed_state_invalid');
    await authorization(directory,master,intent,receipt,escrow);
    if(!same(gate,lifecycle('open',id,aborted?escrow.old_key:escrow.new_key)))throw Error('rotation_completed_state_invalid');
    return {protocol:ROTATION_PROTOCOL,rotation_id:id,status:'already_resumed',outcome:aborted?'aborted_original_id_terminal':'committed',qualification:'historical resumption authority only; no current database or release qualification'};
   }
   if(gate.state==='open'?!same(gate,escrow.gate_before):gate.rotation_id!==id)throw Error('rotation_other_lifecycle_intent');
   if(operation==='resume'&&(!intent||current!==escrow.api_after_sha256))throw Error('rotation_configuration_switch_required');
   if(['abort','resume-aborted'].includes(operation)&&(!intent||current!==escrow.api_before_sha256))throw Error('rotation_original_configuration_required');
   await quiesce(r,escrow);
   if(!intent){
    if(operation!=='rotate'||current!==escrow.api_before_sha256)throw Error('rotation_intent_required');
    const observed=await privateRequest(r,'restore-journal','/v1/control');
    const control=observed.control??observed;
    if(control.state!=='serving'||control.pending_operation_id!==null)throw Error('rotation_restore_not_serving');
    const {pre_state}=await worker(r,escrow,'inspect',{expected_marker:control.marker});
    intent={protocol:ROTATION_PROTOCOL,rotation_id:id,created_at:Date.now(),expected_marker:control.marker,pre_state,
     escrow_sha256:escrowHash,api_before_sha256:escrow.api_before_sha256,api_after_sha256:escrow.api_after_sha256};
    await writeImmutable(path.join(directory,'intent.json'),bytes(sealIntent(intent,master)));
    if(!same(openIntent(JSON.parse((await readImmutable(path.join(directory,'intent.json'))).toString()),master),intent))throw Error('rotation_intent_readback_failed');
   }
   const {receipt}=await worker(r,escrow,operation==='rotate'?'apply':operation==='abort'?'abort':'verify',{intent});
   const aborted=receipt.protocol===ROTATION_ABORT_PROTOCOL,outcome=aborted?'aborted':'committed',targetKey=aborted?escrow.old_key:escrow.new_key,targetConfiguration=aborted?escrow.api_before_sha256:escrow.api_after_sha256;
   await immutableOrSame(path.join(directory,'database-receipt.json'),receipt);
   if(operation==='verify')return {protocol:ROTATION_PROTOCOL,rotation_id:id,status:'database_verified_writers_stopped',outcome,rows:receipt.post_state.row_count,encrypted_rows:receipt.post_state.encrypted_rows,rows_sha256:receipt.post_state.rows_sha256};
   if(operation==='abort')return {protocol:ROTATION_ABORT_PROTOCOL,rotation_id:id,status:'aborted_original_id_terminal_writers_stopped',rows:receipt.post_state.row_count,encrypted_rows:receipt.post_state.encrypted_rows,next_action:'explicit resume-aborted with original-key private runtime readback; any future rotation requires a new ID'};
   if(operation==='rotate'){
    const next=Buffer.from(escrow.api_after,'base64');
    try{await compareAndSwapFile(path.join(r.directory,'api.env'),escrow.api_before_sha256,next);}finally{next.fill(0);}
    await setLifecycle(r.directory,lifecycle('blocked',id,escrow.new_key));
    return {protocol:ROTATION_PROTOCOL,rotation_id:id,status:'database_and_configuration_rotated_writers_stopped',rows:receipt.post_state.row_count,encrypted_rows:receipt.post_state.encrypted_rows,rows_sha256:receipt.post_state.rows_sha256,next_action:'explicit resume with private runtime readback'};
   }
   if((operation==='resume-aborted')!==aborted||current!==targetConfiguration)throw Error('rotation_resume_outcome_mismatch');
   await setLifecycle(r.directory,lifecycle('verification_only',id,targetKey));
   await sql(r,'ALTER ROLE lovelies_runtime LOGIN;');
   const prior=escrow.running_services.filter(service=>!nonwriters.has(service)&&!['functions','public-proxy'].includes(service));
   if(prior.length)await compose(r,'application',['--profile','inference','start','--wait','--wait-timeout','120',...prior],{timeout:180000});
   await compose(r,'application',['up','-d','--no-deps','--force-recreate','functions'],{timeout:180000});
   const readback=await worker(r,escrow,'readiness',{outcome});
   const final=await worker(r,escrow,'verify-readback',{intent,outcome});if(!same(final.receipt,receipt))throw Error('rotation_final_receipt_changed');
   const priorReadback=await optional(path.join(directory,'runtime-readback.json'));
   if(!priorReadback)await writeImmutable(path.join(directory,'runtime-readback.json'),bytes(readback));
   else if(!same(JSON.parse(priorReadback.toString()),readback))throw Error('rotation_runtime_readback_changed');
   const resumeFile=path.join(directory,'resume.enc.json');
   if(!await optional(resumeFile))await writeImmutable(resumeFile,bytes(sealEscrow({protocol:'lovelies-managed-auth-rotation-resume-v1',rotation_id:id,
    intent_sha256:digest(canonical(intent)),receipt_sha256:digest(canonical(receipt)),api_sha256:targetConfiguration,outcome,
    readback_sha256:digest(await readImmutable(path.join(directory,'runtime-readback.json'))),gate:lifecycle('open',id,targetKey),verified_at:Date.now()},master)));
   await authorization(directory,master,intent,receipt,escrow);
   await cronState(r,escrow.cron,escrow.cron[0].active);
   if(escrow.running_services.includes('public-proxy'))await compose(r,'application',['start','public-proxy']);
   if(digest(await privateRead(path.join(r.directory,'api.env')))!==targetConfiguration)throw Error('rotation_configuration_changed');
   // Last action: only the exact verified new key can serve. A lost rename reply
   // is recognized using this persistent gate and the authenticated resume file.
   await setLifecycle(r.directory,lifecycle('open',id,targetKey));
   return {protocol:ROTATION_PROTOCOL,rotation_id:id,status:'resumed_after_private_readback',outcome,rows:receipt.post_state.row_count,encrypted_rows:receipt.post_state.encrypted_rows,rows_sha256:receipt.post_state.rows_sha256,qualification:'operational key rotation or explicit abort only; no release acceptance'};
  }finally{master.fill(0);}
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [operation,...rest]=process.argv.slice(2),options=args(rest,['--runtime','--rotation-id','--execute'],['--execute']);
 (async()=>{if(!options['--execute'])throw Error('explicit_execute_required');const result=await rotateManagedAuth(await runtime(options['--runtime']),operation,options['--rotation-id']);console.log(JSON.stringify(result,null,2));})().catch(()=>{
  console.error('Managed Auth key rotation did not complete. Preserve the lifecycle gate, escrow, intent and any database receipt. Keep writers closed; use the same rotation ID for explicit verification. Never delete old escrow while retained backups require it. No credential values were printed.');process.exitCode=1;
 });
}
