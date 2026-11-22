/** Operator CLI. Database access is read-only; there is no serving restore command. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {backupKey,PROJECT,withBackupCatalog} from './lib/encrypted-backup.mjs';
import {backupProcess} from './lib/backup-process.mjs';

const error=code=>Object.assign(new Error(code),{code});
function options(args){
  const result={command:args.shift()};
  for(let i=0;i<args.length;i++){
    const name=args[i];if(name==='--local-qualification'){if(result.local)throw error('backup_arguments_invalid');result.local=true;continue;}
    if(!['--directory','--id','--pg-dump','--pg-restore','--max-age-hours'].includes(name)||result[name]!==undefined||!args[i+1]||args[i+1].startsWith('--'))throw error('backup_arguments_invalid');
    result[name]=args[++i];
  }
  if(!['create','catalog','verify','expire','inspect','health'].includes(result.command)||!result['--directory'])throw error('backup_arguments_invalid');
  const allowed={create:['--directory','--pg-dump','--pg-restore'],catalog:['--directory'],verify:['--directory','--id'],expire:['--directory'],inspect:['--directory','--id','--pg-restore'],health:['--directory','--pg-restore','--max-age-hours']}[result.command];
  if(Object.keys(result).some(name=>!['command','local',...allowed].includes(name))||allowed.some(name=>!result[name]))throw error('backup_arguments_invalid');
  return result;
}
const cancellation=new AbortController();
const cancelled=()=>cancellation.abort();
process.once('SIGTERM',cancelled);process.once('SIGINT',cancelled);
const current=()=>{if(cancellation.signal.aborted)throw error('backup_process_cancelled');};
async function binary(value,name){
  if(!value||!path.isAbsolute(value))throw error('backup_tool_path_invalid');
  const resolved=await fs.realpath(value),stat=await fs.stat(resolved);
  if(!stat.isFile())throw error('backup_tool_path_invalid');
  const chunks=[],task=backupProcess(resolved,['--version'],{PATH:process.env.PATH,LC_ALL:'C'},
    {timeoutMs:10000,stdoutLimit:65536,stdoutLimitCode:'backup_tool_version_unqualified',onStdout:bytes=>chunks.push(bytes),signal:cancellation.signal});
  task.child.stdin.end();await task.completed;
  if(!new RegExp('^'+name+' \\(PostgreSQL\\) 17\\.').test(Buffer.concat(chunks).toString('utf8')))throw error('backup_tool_version_unqualified');
  return resolved;
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
async function inspectStream(stream,tool){
  let lines=0;
  const task=backupProcess(tool,['--list'],{PATH:process.env.PATH,LC_ALL:'C'},
    {stdoutLimit:16*1024*1024,onStdout:chunk=>{lines+=chunk.toString().split('\n').length-1;},signal:cancellation.signal});
  try{await Promise.all([pipeline(stream,task.child.stdin),task.completed]);}
  catch(problem){throw await task.cancel(problem);}
  return {archive_listed:true,toc_lines:lines};
}
let key;
try{
  const opt=options(process.argv.slice(2));key=backupKey(process.env.LOVELIES_BACKUP_ENCRYPTION_KEY);
  const config={directory:opt['--directory'],key,environment:opt.local?'local-qualification':'production'};
  if(opt.command==='health'&&!/^(?:[1-9]|[1-9][0-9]|1[0-5][0-9]|16[0-8])$/.test(opt['--max-age-hours']))throw error('backup_arguments_invalid');
  const result=await withBackupCatalog({...config,create:opt.command!=='health'},async catalog=>{
    current();let result;
    // The lease is already durable before version probes or a producer starts,
    // and remains held across create and its subsequent archive inspection.
    if(opt.command==='create'){
      const env=databaseEnvironment(opt.local);
      if(!opt.local){const ca=await fs.stat(env.PGSSLROOTCERT);if(!ca.isFile())throw error('backup_tls_ca_invalid');}
      const tool=await binary(opt['--pg-dump'],'pg_dump'),restore=await binary(opt['--pg-restore'],'pg_restore');
      const task=backupProcess(tool,['--format=custom','--schema=lovelies_private','--strict-names','--enable-row-security','--role=lovelies_api','--no-owner','--no-privileges','--no-password','--lock-wait-timeout=10s'],env,{signal:cancellation.signal});
      task.child.stdin.end();
      try{
        const metadata=await catalog.create({source:task.child.stdout,sourceCompleted:task.completed,cancelSource:problem=>task.cancel(problem)});
        current();
        const inspection=await catalog.consume(metadata.id,stream=>inspectStream(stream,restore));
        result={status:'created_and_verified',id:metadata.id,environment:config.environment,created_at:metadata.created_at,expires_at:metadata.expires_at,archive_sha256:metadata.archive_sha256,...inspection};
      }catch(problem){throw await task.cancel(problem);}
    }else if(opt.command==='catalog'){
      const value=await catalog.catalog();result={status:value.unmanaged_entries.length?'catalog_needs_reconciliation':'catalog_verified',environment:config.environment,backups:value.backups.map(x=>({id:x.id,created_at:x.created_at,expires_at:x.expires_at})),unmanaged_entries:value.unmanaged_entries.length};
      if(value.unmanaged_entries.length)process.exitCode=2;
    }else if(opt.command==='health'){
      const tool=await binary(opt['--pg-restore'],'pg_restore');
      result=await catalog.health({maxAgeHours:Number(opt['--max-age-hours'])},stream=>inspectStream(stream,tool));
      if(result.status!=='local_backup_artifact_verified')process.exitCode=2;
    }else if(opt.command==='expire'){
      const expiry=await catalog.expire();result={status:expiry.unmanaged_entries?'expiry_needs_reconciliation':'verified_expiry_complete',environment:config.environment,...expiry};
      if(expiry.unmanaged_entries)process.exitCode=2;
    }else if(opt.command==='verify'){
      const metadata=await catalog.verify(opt['--id']);result={status:'archive_verified',id:metadata.id,environment:config.environment,expires_at:metadata.expires_at};
    }else{
      const tool=await binary(opt['--pg-restore'],'pg_restore');
      result={status:'archive_inspected',environment:config.environment,...await catalog.consume(opt['--id'],stream=>inspectStream(stream,tool))};
    }
    current();return result;
  });
  current();console.log(JSON.stringify(result));
}catch(problem){
  console.error(JSON.stringify({status:'failed',code:/^backup_[a-z_]+$/.test(problem?.code??'')?problem.code:'backup_operation_failed',
    ...(problem?.backupOutcomeUnknown?{reconciliation_required:true}:{})}));process.exitCode=1;
}finally{
  key?.fill(0);process.removeListener('SIGTERM',cancelled);process.removeListener('SIGINT',cancelled);
}
