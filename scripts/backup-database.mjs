/** Operator CLI. Database access is read-only; there is no serving restore command. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {finished,pipeline} from 'node:stream/promises';
import {managedBackupProcess,backupProcessStatus,reconcileBackupProcess,assertNoBackupProcessHolds} from './lib/backup-process.mjs';
import {backupCatalog,backupDirectory,backupHealth,backupKey,createBackup,expireBackups,PROJECT,verifyBackup,withVerifiedBackup} from './lib/encrypted-backup.mjs';

const error=code=>Object.assign(new Error(code),{code});
function options(args){
  const result={command:args.shift()};
  for(let i=0;i<args.length;i++){
    const name=args[i];if(name==='--local-qualification'){if(result.local)throw error('backup_arguments_invalid');result.local=true;continue;}
    if(!['--directory','--id','--pg-dump','--pg-restore','--max-age-hours'].includes(name)||result[name]!==undefined||!args[i+1]||args[i+1].startsWith('--'))throw error('backup_arguments_invalid');
    result[name]=args[++i];
  }
  if(!['create','catalog','verify','expire','inspect','health','process-status','reconcile-process'].includes(result.command)||!result['--directory'])throw error('backup_arguments_invalid');
  const allowed={create:['--directory','--pg-dump','--pg-restore'],catalog:['--directory'],verify:['--directory','--id'],expire:['--directory'],inspect:['--directory','--id','--pg-restore'],health:['--directory','--pg-restore','--max-age-hours'],'process-status':['--directory','--id'],'reconcile-process':['--directory','--id']}[result.command];
  if(Object.keys(result).some(name=>!['command','local',...allowed].includes(name))||allowed.some(name=>!result[name]))throw error('backup_arguments_invalid');
  return result;
}
async function binary(value,name,config){
  if(!value||!path.isAbsolute(value))throw error('backup_tool_path_invalid');
  const resolved=await fs.realpath(value),stat=await fs.stat(resolved);
  if(!stat.isFile())throw error('backup_tool_path_invalid');
  const task=await managedBackupProcess({...config,stage:name==='pg_dump'?'probe_dump':'probe_restore',binary:resolved,args:['--version'],
    environment:{PATH:process.env.PATH,LC_ALL:'C'},timeoutMs:10000});
  let output='',size=0;task.stdout.on('data',bytes=>{size+=bytes.length;if(size>16384){task.stop('backup_tool_version_unqualified');return;}output+=bytes.toString();});
  task.child.stdin.end();await Promise.all([finished(task.stdout,{cleanup:true}),task.completed]);
  // The process may already be quiescent when buffered bytes reach this reader;
  // stop() then cannot substitute for checking the consumed byte bound itself.
  if(size>16384||!new RegExp('^'+name+' \\(PostgreSQL\\) 17\\.').test(output))throw error('backup_tool_version_unqualified');
  return resolved;
}
function producer(binary,args,environment,config){
  return managedBackupProcess({...config,stage:args.includes('--list')?'inspect':'dump',binary,args,environment});
}
function databaseEnvironment(local){
  const value=name=>process.env[name];
  const host=value('PGHOST'),database=value('PGDATABASE'),user=value('PGUSER'),port=value('PGPORT')??'5432';
  if(!user||!/^\w[\w.]*$/.test(user)||!/^\d{1,5}$/.test(port)||Number(port)<1||Number(port)>65535)throw error('backup_database_config_invalid');
  if(local){if(!['127.0.0.1','localhost','::1'].includes(host)||!/^lovelies_(?:test|backup_qualification)_[a-z0-9]+$/.test(database??''))throw error('backup_local_target_invalid');}
  else if(host!==`db.${PROJECT}.supabase.co`||database!=='postgres'||port!=='5432'||!value('PGPASSWORD')||!path.isAbsolute(value('PGSSLROOTCERT')??''))throw error('backup_project_target_invalid');
  return {PATH:process.env.PATH,LC_ALL:'C',PGHOST:host,PGDATABASE:database,PGUSER:user,PGPORT:port,
    ...(value('PGPASSWORD')?{PGPASSWORD:value('PGPASSWORD')}:{}),PGSSLMODE:local?'disable':'verify-full',
    ...(!local?{PGSSLROOTCERT:value('PGSSLROOTCERT')}:{}),PGCONNECT_TIMEOUT:'10',PGAPPNAME:'lovelies-encrypted-backup-v1',PGOPTIONS:'-c statement_timeout=180000'};
}
async function inspectStream(stream,tool,config){
    const task=await producer(tool,['--list'],{PATH:process.env.PATH,LC_ALL:'C'},config);let lines=0,bytes=0,outputLimitExceeded=false;
    task.stdout.on('data',chunk=>{
      bytes+=chunk.length;lines+=chunk.toString().split('\n').length-1;
      if(bytes>16*1024*1024&&!outputLimitExceeded){outputLimitExceeded=true;task.stop('backup_inspection_output_limit');}
    });
    try{await Promise.all([pipeline(stream,task.child.stdin),finished(task.stdout,{cleanup:true}),task.completed]);}
    catch(error){await task.stop(error?.code??'backup_process_consumer_failed').catch(()=>{});throw error;}
    // A child can handle SIGTERM and exit zero; a breached listing bound must
    // remain a failure even when its process reports success.
    if(outputLimitExceeded)throw error('backup_inspection_output_limit');
    return {archive_listed:true,toc_lines:lines};
}
async function inspectArchive(config,tool){return withVerifiedBackup(config,stream=>inspectStream(stream,tool,config));}
try{
  const opt=options(process.argv.slice(2)),key=backupKey(process.env.LOVELIES_BACKUP_ENCRYPTION_KEY);
  const config={directory:opt['--directory'],key,environment:opt.local?'local-qualification':'production',id:opt['--id']};
  await backupDirectory(config.directory,{create:!['health','process-status','reconcile-process'].includes(opt.command)});
  if(!['process-status','reconcile-process'].includes(opt.command))await assertNoBackupProcessHolds(config.directory);
  let result;
  if(opt.command==='create'){
    const tool=await binary(opt['--pg-dump'],'pg_dump',config),restore=await binary(opt['--pg-restore'],'pg_restore',config),env=databaseEnvironment(opt.local);
    if(!opt.local){const ca=await fs.stat(env.PGSSLROOTCERT);if(!ca.isFile())throw error('backup_tls_ca_invalid');}
    const task=await producer(tool,['--format=custom','--schema=lovelies_private','--strict-names','--enable-row-security','--role=lovelies_api','--no-owner','--no-privileges','--no-password','--lock-wait-timeout=10s'],env,config);
    task.child.stdin.end();
    try{
      const metadata=await createBackup({...config,source:task.stdout,sourceCompleted:task.completed});
      const inspection=await inspectArchive({...config,id:metadata.id},restore);
      result={status:'created_and_verified',id:metadata.id,environment:config.environment,created_at:metadata.created_at,expires_at:metadata.expires_at,archive_sha256:metadata.archive_sha256,...inspection};
    }catch(error){await task.stop(error?.code??'backup_process_consumer_failed').catch(()=>{});throw error;}
  }else if(opt.command==='process-status'){
    result=await backupProcessStatus(config);process.exitCode=2;
  }else if(opt.command==='reconcile-process'){
    result=await reconcileBackupProcess(config);
  }else if(opt.command==='catalog'){
    const catalog=await backupCatalog(config);result={status:catalog.unmanaged_entries.length?'catalog_needs_reconciliation':'catalog_verified',environment:config.environment,backups:catalog.backups.map(x=>({id:x.id,created_at:x.created_at,expires_at:x.expires_at})),unmanaged_entries:catalog.unmanaged_entries.length};
    if(catalog.unmanaged_entries.length)process.exitCode=2;
  }else if(opt.command==='health'){
    if(!/^(?:[1-9]|[1-9][0-9]|1[0-5][0-9]|16[0-8])$/.test(opt['--max-age-hours']))throw error('backup_arguments_invalid');
    const tool=await binary(opt['--pg-restore'],'pg_restore',config);
    result=await backupHealth({...config,maxAgeHours:Number(opt['--max-age-hours'])},stream=>inspectStream(stream,tool,config));
    if(result.status!=='local_backup_artifact_verified')process.exitCode=2;
  }else if(opt.command==='expire'){
    const expiry=await expireBackups(config);result={status:expiry.unmanaged_entries?'expiry_needs_reconciliation':'verified_expiry_complete',environment:config.environment,...expiry};if(expiry.unmanaged_entries)process.exitCode=2;
  }
  else if(opt.command==='verify'){const metadata=await verifyBackup(config);result={status:'archive_verified',id:metadata.id,environment:config.environment,expires_at:metadata.expires_at};}
  else result={status:'archive_inspected',environment:config.environment,...await inspectArchive(config,await binary(opt['--pg-restore'],'pg_restore',config))};
  key.fill(0);console.log(JSON.stringify(result));
}catch(problem){
  console.error(JSON.stringify({status:'failed',code:/^backup_[a-z_]+$/.test(problem?.code??'')?problem.code:'backup_operation_failed'}));process.exitCode=1;
}
