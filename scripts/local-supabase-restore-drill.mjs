#!/usr/bin/env node
/** Restore only into newly created isolated Docker resources. No serving restore. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID,randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {args,runtime,command,writeReceipt,privateRequest,requireCompose,literal,canonical} from './local-supabase-common.mjs';
import {backupKey,loadSnapshot,decryptStream} from './local-supabase-backup.mjs';
import {envText,PROJECT_ID} from './local-supabase-configure.mjs';

async function pipeToDocker(argv,produce){
 const child=spawn('docker',argv,{stdio:['pipe','pipe','pipe']});child.stdout.resume();child.stderr.resume();
 const done=new Promise((resolve,reject)=>{child.once('error',()=>reject(Error('restore_process_unavailable')));child.once('close',code=>code===0?resolve():reject(Error('restore_process_failed')));});
 const timer=setTimeout(()=>child.kill('SIGKILL'),3600000);
 try{await Promise.all([produce(child.stdin),done]);}catch(error){child.kill('SIGKILL');throw error;}finally{clearTimeout(timer);}
}
export async function restoreDrill(r,applicationDirectory,custodyDirectory,receiptPath){
 await requireCompose();
 const key=await backupKey(r.directory),application=await loadSnapshot(applicationDirectory,key),custody=await loadSnapshot(custodyDirectory,key);
 if(application.postgres_image!==r.config.postgres_image||custody.postgres_image!==r.config.postgres_image||application.public_api_base_url!==r.config.public_api_base_url||custody.public_api_base_url!==r.config.public_api_base_url)throw Error('snapshot_deployment_identity_mismatch');
 const old=application.journal.control.marker,current=custody.journal.control.marker;
 if(old.database_id!==current.database_id||old.incarnation_id!==current.incarnation_id||current.checkpoint.revision<=old.checkpoint.revision)throw Error('drill_requires_an_older_application_and_newer_same_incarnation_custody_snapshot');
 const id='lovelies-drill-'+randomUUID(),directory=path.join(r.directory,id);await fs.mkdir(directory,{mode:0o700});
 const files={app:'application.dump',custody:'custody.dump'},volumes={app:id+'-app-db',storage:id+'-storage',appConfig:id+'-app-config',custody:id+'-custody-db',custodyConfig:id+'-custody-config'};
 const containers={app:id+'-app',custody:id+'-custody',journal:id+'-journal'},checks=[];
 const before=await privateRequest(r,'restore-journal','/v1/control');
 const report={protocol:'lovelies-local-supabase-restore-drill-v1',drill_id:id,application_snapshot_id:application.snapshot_id,custody_snapshot_id:custody.snapshot_id,started_at:new Date().toISOString(),resources:{network:id,containers,volumes},checks,status:'running'};
 const pgEnv=path.join(directory,'postgres.env'),journalEnv=path.join(directory,'journal.env');
 await fs.writeFile(pgEnv,envText({POSTGRES_PASSWORD:randomBytes(32).toString('hex'),POSTGRES_DB:'postgres',PGDATABASE:'postgres',POSTGRES_HOST:'/var/run/postgresql',POSTGRES_PORT:5432}),{mode:0o600,flag:'wx'});
 await fs.writeFile(journalEnv,envText({SUPABASE_PROJECT_ID:PROJECT_ID,RESTORE_JOURNAL_TOKEN:r.custody.RESTORE_JOURNAL_TOKEN,RESTORE_JOURNAL_BOOTSTRAP_TOKEN:r.custody.RESTORE_JOURNAL_BOOTSTRAP_TOKEN,
  RESTORE_JOURNAL_OBSERVER_TOKEN:r.custody.RESTORE_JOURNAL_OBSERVER_TOKEN,CUSTODY_DATABASE_URL:'postgres://lovelies_journal:'+r.custody.CUSTODY_JOURNAL_PASSWORD+'@custody-db:5432/postgres',
  CUSTODY_DATABASE_TLS_MODE:'disable-internal',CUSTODY_DATABASE_TRUSTED_HOSTS:'custody-db',CUSTODY_SERVICE_ORIGIN:'https://restore-journal:8443',CUSTODY_HEALTH_TOKEN:r.custody.CUSTODY_HEALTH_TOKEN,
  CUSTODY_TLS_KEY_FILE:'/run/tls/key',CUSTODY_TLS_CERT_FILE:'/run/tls/cert',NODE_EXTRA_CA_CERTS:'/run/tls/ca.crt',PORT:8443}),{mode:0o600,flag:'wx'});
 const cloneSQL=async(name,source)=>{const result=await command('docker',['exec','-i',containers[name],'psql','-X','-q','-At','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d','postgres'],{input:source});return result.stdout.toString().trim();};
 const record=(payload,name)=>{const result=payload.components.find(value=>value.aad.component===name);if(!result)throw Error('snapshot_component_missing');return result;};
 const restoreTar=async(snapshotDir,payload,name,volume)=>pipeToDocker(['run','--rm','-i','--network','none','--read-only','--cap-drop','ALL','--cap-add','CHOWN','--cap-add','DAC_OVERRIDE','--cap-add','FOWNER','--security-opt','no-new-privileges','--mount','type=volume,src='+volume+',dst=/restore','--entrypoint','tar',r.config.postgres_image,'-C','/restore','-xpf','-'],output=>decryptStream(snapshotDir,record(payload,name),key,output));
 const probe=async(route,body)=>{
  const code=`const response=await fetch(process.env.CUSTODY_SERVICE_ORIGIN+${JSON.stringify(route)},{method:'POST',headers:{authorization:'Bearer '+process.env.RESTORE_JOURNAL_TOKEN,'content-type':'application/json'},body:JSON.stringify(${JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});process.stdout.write(JSON.stringify({status:response.status,body:await response.json()}));`;
  return JSON.parse((await command('docker',['exec','-i',containers.journal,'node','--input-type=module','-'],{input:code})).stdout.toString());
 };
 try{
  await command('docker',['network','create','--internal','--label','lovelies.drill='+id,id]);
  for(const volume of Object.values(volumes))await command('docker',['volume','create','--label','lovelies.drill='+id,volume]);
  await restoreTar(applicationDirectory,application,'storage.tar',volumes.storage);
  await restoreTar(applicationDirectory,application,'application-db-config.tar',volumes.appConfig);
  await restoreTar(custodyDirectory,custody,'custody-db-config.tar',volumes.custodyConfig);
  checks.push({id:'authenticated_storage_and_vault_key_bytes_restored_to_new_volumes',status:'passed'});
  for(const name of ['app','custody']){
   await command('docker',['run','-d','--name',containers[name],'--label','lovelies.drill='+id,'--network',id,'--network-alias',name==='custody'?'custody-db':'db','--env-file',pgEnv,
    '--mount','type=volume,src='+volumes[name]+',dst=/var/lib/postgresql/data','--mount','type=volume,src='+volumes[name==='app'?'appConfig':'custodyConfig']+',dst=/etc/postgresql-custom',r.config.postgres_image,
    'postgres','-c','config_file=/etc/postgresql/postgresql.conf','-c','cron.launch_active_jobs=off','-c','log_min_messages=fatal']);
   let ready=false;for(let i=0;i<60;i++){const health=await command('docker',['exec',containers[name],'pg_isready','-U','supabase_admin','-d','postgres'],{allowFailure:true});if(health.code===0){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,1000));}if(!ready)throw Error('clone_database_not_ready');
   const roleSQL=name==='app'?"CREATE ROLE lovelies_api NOLOGIN NOINHERIT NOBYPASSRLS; CREATE ROLE lovelies_runtime NOLOGIN NOINHERIT NOBYPASSRLS; GRANT lovelies_api TO lovelies_runtime WITH INHERIT FALSE;":"CREATE ROLE lovelies_journal NOLOGIN NOINHERIT NOBYPASSRLS; CREATE ROLE lovelies_push NOLOGIN NOINHERIT NOBYPASSRLS;";
   await cloneSQL(name,roleSQL);
   await pipeToDocker(['exec','-i',containers[name],'pg_restore','-U','supabase_admin','-d','postgres','--clean','--if-exists','--exit-on-error'],output=>decryptStream(name==='app'?applicationDirectory:custodyDirectory,record(name==='app'?application:custody,files[name]),key,output));
   checks.push({id:name+'_database_archive_restored',status:'passed'});
  }
  await cloneSQL('custody',"SET log_statement='none'; SET log_min_error_statement='panic'; ALTER ROLE lovelies_journal LOGIN PASSWORD "+literal(r.custody.CUSTODY_JOURNAL_PASSWORD)+';');
  const marker=JSON.parse(await cloneSQL('app',"SELECT json_build_object('database_id',database_id,'incarnation_id',incarnation_id,'checkpoint',json_build_object('revision',checkpoint_revision,'hash',checkpoint_hash),'cursor',json_build_object('sequence',journal_sequence,'hash',journal_hash)) FROM lovelies_private.restore_control WHERE singleton=1;"));
  if(canonical(marker)!==canonical(old))throw Error('restored_application_marker_mismatch');
  const objects=Number(await cloneSQL('app','SELECT count(*) FROM storage.objects;'));if(objects!==application.storage_inventory.objects)throw Error('restored_storage_metadata_mismatch');
  checks.push({id:'restored_database_and_storage_metadata_match_snapshot',status:'passed',object_count:objects});
  await command('docker',['run','-d','--name',containers.journal,'--label','lovelies.drill='+id,'--network',id,'--network-alias','restore-journal','--env-file',journalEnv,
   '--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/tmp',
   '--mount','type=bind,src='+path.join(r.directory,'tls/restore-journal.key')+',dst=/run/tls/key,readonly',
   '--mount','type=bind,src='+path.join(r.directory,'tls/restore-journal.crt')+',dst=/run/tls/cert,readonly',
   '--mount','type=bind,src='+path.join(r.directory,'tls/ca.crt')+',dst=/run/tls/ca.crt,readonly',
   'lovelies-private-services:'+r.app.LOVELIES_IMAGE_TAG,'node','services/restore-journal/src/server.mjs']);
  let ready=false;for(let i=0;i<30;i++){const health=await command('docker',['exec',containers.journal,'node','deploy/local-supabase/healthcheck.mjs'],{allowFailure:true});if(health.code===0){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,1000));}if(!ready)throw Error('clone_journal_not_ready');
  const admission=await probe('/v1/admission',{version:1,project_id:PROJECT_ID,marker});if(admission.status!==409||admission.body?.error!=='serving_quarantined')throw Error('older_application_copy_was_not_quarantined');
  const row=JSON.parse(await cloneSQL('custody',"SELECT value::text FROM restore_journal.kv WHERE key='control:v1';"));
  if(row.state!=='quarantined')throw Error('quarantine_not_persisted');
  checks.push({id:'older_application_is_denied_by_newer_independent_custody',status:'passed',http_status:admission.status});
  await command('docker',['restart',containers.journal]);
  let second=null;for(let i=0;i<20;i++){try{second=await probe('/v1/admission',{version:1,project_id:PROJECT_ID,marker});break;}catch{await new Promise(resolve=>setTimeout(resolve,1000));}}
  if(second?.status!==409||second.body?.error!=='serving_quarantined')throw Error('quarantine_not_durable');checks.push({id:'quarantine_persists_across_actual_custody_restart',status:'passed'});
  const after=await privateRequest(r,'restore-journal','/v1/control');
  if(after.control.marker.database_id!==before.control.marker.database_id||after.control.marker.checkpoint.revision<before.control.marker.checkpoint.revision)throw Error('live_custody_identity_changed');
  checks.push({id:'live_custody_not_restored_or_rebound',status:'passed',before_checkpoint:before.control.marker.checkpoint.revision,after_checkpoint:after.control.marker.checkpoint.revision});
  checks.push({id:'computed_replay_inventory_cleanup_and_serving_completion',status:'not_run',reason:'retain_isolated_clone_for_authorized_operator_recovery_using_existing_recovery_v2_protocol'});
  checks.push({id:'real_provider_unknown_outcome_reconciliation',status:'not_run',reason:'requires_current_provider_and_device_evidence_no_resend_is_permitted'});
  report.status='partial_restore_evidence_quarantine_proven';
 }catch{checks.push({id:'restore_drill_execution',status:'failed',reason:'inspect_only_the_isolated_drill_resources'});report.status='failed';}
 finally{
  // Keep encrypted evidence and the isolated volumes for investigation. Never
  // auto-delete an archive, remove a serving volume or reopen a quarantine.
  for(const container of Object.values(containers))await command('docker',['stop',container],{allowFailure:true}).catch(()=>{});
  report.completed_at=new Date().toISOString();report.isolated_resources_stopped=true;await writeReceipt(receiptPath,report);
 }
 return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const options=args(process.argv.slice(2),['--runtime','--snapshot','--custody-snapshot','--receipt','--execute'],['--execute']);
 (async()=>{if(!options['--execute']||!options['--receipt'])throw Error('explicit_execute_and_new_receipt_required');const report=await restoreDrill(await runtime(options['--runtime']),options['--snapshot'],options['--custody-snapshot'],options['--receipt']);console.log(JSON.stringify(report,null,2));process.exitCode=report.status==='failed'?1:2;})().catch(()=>{console.error('Restore drill did not start or could not write its receipt. No serving database or custody volume was restored.');process.exitCode=1;});
}
