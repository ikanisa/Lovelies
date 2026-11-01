/** Bounded POSIX process-group custody for the qualified backup toolchain.
 * Records contain identities and hashes, never database credentials or output.
 * Unknown exits survive as authenticated holds; reconciliation never sends a
 * signal to a PID recovered from disk. */
import {spawn} from 'node:child_process';
import {createHash,createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {PassThrough} from 'node:stream';

const code=name=>Object.assign(new Error(name),{code:name});
const canonical=value=>JSON.stringify(value,Object.keys(value).sort());
const sha=value=>createHash('sha256').update(value).digest('hex');
const sign=(value,key)=>createHmac('sha256',key).update('lovelies-backup-process-v1\n'+canonical(value)).digest('hex');
const filename=(directory,id)=>path.join(directory,`.lovelies-process-${id}.json`);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const controllerNonce=randomUUID();
async function syncDirectory(directory){const h=await fs.open(directory,'r');try{await h.sync();}finally{await h.close();}}
async function privateDirectory(directory){
  if(!path.isAbsolute(directory))throw code('backup_process_directory_invalid');
  const s=await fs.lstat(directory);
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077))throw code('backup_process_directory_invalid');
}
async function identity(pid){
  if(process.platform!=='linux')return null;
  try{
    const raw=await fs.readFile(`/proc/${pid}/stat`,'utf8'),fields=raw.slice(raw.lastIndexOf(')')+2).split(' ');
    return {pid,start:fields[19],group:Number(fields[2]),state:fields[0],boot:(await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim()};
  }catch(error){if(error.code==='ENOENT'||error.code==='ESRCH')return null;throw error;}
}
/** A nonce shared by this CLI's archive lock and authenticated process holds.
 * PID alone is never sufficient to release a lock after a restart. */
export async function backupControllerIdentity(){
  const owner=await identity(process.pid);
  return {protocol:'lovelies-backup-lock-v2',owner_pid:process.pid,owner_start:owner?.start??null,
    boot:owner?.boot??null,owner_nonce:controllerNonce};
}
export async function assertNoBackupProcessHolds(directory){
  await privateDirectory(directory);
  if((await fs.readdir(directory)).some(name=>name.startsWith('.lovelies-process-')))
    throw code('backup_process_reconciliation_required');
}
function exists(group){try{process.kill(-group,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}
async function groupStopped(group){
  if(!exists(group))return true;
  if(process.platform!=='linux')return false;
  // Reaped children may remain as zombies under a minimal container init.
  // They execute no code and own no open streams. Require two complete scans;
  // any inaccessible identity or live member keeps the outcome unknown.
  for(let pass=0;pass<2;pass++){
    for(const name of await fs.readdir('/proc'))if(/^\d+$/.test(name)){
      let item;try{item=await identity(Number(name));}catch{return false;}
      if(item?.group===group&&item.state!=='Z'&&item.state!=='X')return false;
    }
  }
  return true;
}
async function store(directory,record,key,initial=false){
  const destination=filename(directory,record.id),encoded=JSON.stringify({...record,mac:sign(record,key)})+'\n';
  if(initial){const h=await fs.open(destination,'wx',0o600);try{await h.writeFile(encoded);await h.sync();}finally{await h.close();}}
  else{
    const temporary=destination+'.'+randomUUID()+'.pending',h=await fs.open(temporary,'wx',0o600);
    try{await h.writeFile(encoded);await h.sync();}finally{await h.close();}
    await fs.rename(temporary,destination);
  }
  await syncDirectory(directory);
}
async function load(directory,id,key){
  if(!uuid.test(id))throw code('backup_process_id_invalid');await privateDirectory(directory);
  const file=filename(directory,id),s=await fs.lstat(file);
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&0o077)||s.size>8192)throw code('backup_process_record_invalid');
  const value=JSON.parse(await fs.readFile(file,'utf8')),{mac,...record}=value;
  if(record.protocol!=='lovelies-backup-process-v1'||record.id!==id||record.directory!==directory||typeof mac!=='string'||!/^[0-9a-f]{64}$/.test(mac)||
      !timingSafeEqual(Buffer.from(mac,'hex'),Buffer.from(sign(record,key),'hex')))throw code('backup_process_record_invalid');
  return record;
}

export async function backupProcessStatus({directory,id,key}){
  const record=await load(directory,id,key);
  return {status:'process_custody_hold',id:record.id,phase:record.phase,stage:record.stage,created_at:record.created_at,
    process_identity_recorded:Number.isSafeInteger(record.child_pid),successful_backup_established:false};
}
export async function reconcileBackupProcess({directory,id,key}){
  const record=await load(directory,id,key);
  // A prepared record without an observed child identity has an uncertain
  // spawn window. A restarted process cannot safely infer what ran there.
  if(!Number.isSafeInteger(record.child_pid)||!record.child_start||!record.boot||process.platform!=='linux')throw code('backup_process_reconciliation_required');
  const boot=(await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
  if(boot!==record.boot)throw code('backup_process_host_generation_changed');
  const owner=await identity(record.owner_pid);
  if(owner&&owner.start===record.owner_start&&owner.state!=='Z')throw code('backup_process_controller_active');
  const child=await identity(record.child_pid);
  if(child&&child.start!==record.child_start)throw code('backup_process_identity_changed');
  if(child&&child.state!=='Z'&&child.state!=='X'||!await groupStopped(record.child_pid))throw code('backup_process_still_active');
  // Re-read the authenticated record immediately before release; never adopt a
  // changed hold, delete an archive, or turn an unknown operation into success.
  if(canonical(await load(directory,id,key))!==canonical(record))throw code('backup_process_record_changed');
  let lockReleased=false;
  const lockPath=path.join(directory,'.lovelies-backup.lock');
  try{
    const stat=await fs.lstat(lockPath);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.uid!==process.getuid()||(stat.mode&0o077)||stat.size>2048)
      throw code('backup_process_lock_reconciliation_required');
    let lock;try{lock=JSON.parse(await fs.readFile(lockPath,'utf8'));}catch{throw code('backup_process_lock_reconciliation_required');}
    const same=lock.protocol==='lovelies-backup-lock-v2'&&uuid.test(record.owner_nonce??'')&&lock.owner_nonce===record.owner_nonce&&
      lock.owner_pid===record.owner_pid&&lock.owner_start===record.owner_start&&lock.boot===record.boot;
    if(!same)throw code('backup_process_lock_reconciliation_required');
    // Every other process hold must first be reconciled independently. A
    // prepared, malformed or unknown hold is never silently discarded.
    const others=(await fs.readdir(directory)).filter(name=>name.startsWith('.lovelies-process-')&&name!==path.basename(filename(directory,id)));
    if(!others.length){
      const current=await fs.lstat(lockPath);
      if(current.dev!==stat.dev||current.ino!==stat.ino||canonical(JSON.parse(await fs.readFile(lockPath,'utf8')))!==canonical(lock))
        throw code('backup_process_lock_reconciliation_required');
      // Release the exact dead controller's lock before its final hold. A
      // crash between these steps leaves the authenticated hold fencing work.
      await fs.unlink(lockPath);await syncDirectory(directory);lockReleased=true;
    }
  }catch(error){if(error.code!=='ENOENT')throw error;}
  await fs.unlink(filename(directory,id));await syncDirectory(directory);
  return {status:'process_custody_released_after_observed_stop',id,lock_released:lockReleased,successful_backup_established:false};
}

export async function managedBackupProcess({directory,key,stage,binary,args,environment,timeoutMs=240000,graceMs=1000,killWaitMs=3000,stderrLimit=65536}){
  if(process.platform==='win32')throw code('backup_process_platform_unqualified');
  if(!['probe_dump','probe_restore','dump','inspect'].includes(stage)||![timeoutMs,graceMs,killWaitMs,stderrLimit].every(x=>Number.isSafeInteger(x)&&x>0))throw code('backup_process_config_invalid');
  await privateDirectory(directory);
  const real=await fs.realpath(binary),stat=await fs.stat(real);
  if(!stat.isFile())throw code('backup_tool_path_invalid');
  const owner=await backupControllerIdentity(),id=randomUUID(),record={protocol:'lovelies-backup-process-v1',id,directory,stage,created_at:Date.now(),
    owner_pid:owner.owner_pid,owner_start:owner.owner_start,owner_nonce:owner.owner_nonce,boot:owner.boot,binary_sha256:sha(await fs.readFile(real)),
    arguments_sha256:sha(JSON.stringify(args)),phase:'prepared',child_pid:null,child_start:null};
  await store(directory,record,key,true);
  // A native tool can write and exit while its identity/running record is
  // being persisted. Attach this byte-mode, backpressured handoff immediately
  // at spawn; callers consume stdout below, never the raw child.stdout pipe.
  const stdout=new PassThrough({highWaterMark:64*1024});
  let child,exit=null,closed=false,failure=null,settled=false,ready=false,stdoutClosed=false,stderrClosed=false,timer,termTimer,killTimer,exitTimer,checking=false;
  let persist=Promise.resolve(),resolveCompleted,rejectCompleted;
  const completed=new Promise((resolve,reject)=>{resolveCompleted=resolve;rejectCompleted=reject;});completed.catch(()=>{});
  const save=phase=>{record.phase=phase;persist=persist.then(()=>store(directory,record,key));persist.catch(()=>{});return persist;};
  const signal=name=>{if(!child?.pid)return;try{process.kill(-child.pid,name);}catch(error){if(error.code!=='ESRCH')failure??='backup_process_signal_failed';}};
  const release=async unknown=>{
    if(settled)return;settled=true;clearTimeout(timer);clearTimeout(termTimer);clearTimeout(killTimer);clearTimeout(exitTimer);
    child?.stdin.destroy();child?.stdout.destroy();child?.stderr.destroy();
    try{
      await persist;
      if(unknown){await save('unknown');child?.unref();stdout.destroy(code('backup_process_outcome_unresolved'));rejectCompleted(code('backup_process_outcome_unresolved'));}
      else{
        await fs.unlink(filename(directory,id));await syncDirectory(directory);
        // Successful process closure does not consume the handoff's buffered
        // bytes. Leave it readable until its consumer has actually drained it.
        if(failure){stdout.destroy(code(failure));rejectCompleted(code(failure));}else resolveCompleted();
      }
    }catch{child?.unref();stdout.destroy(code('backup_process_custody_write_failed'));rejectCompleted(code('backup_process_custody_write_failed'));}
  };
  const inspect=async(force=false)=>{
    if(settled||checking||!exit||!ready)return;checking=true;
    try{
      if(closed&&stdoutClosed&&stderrClosed&&await groupStopped(child.pid))await release(false);
      else if(force)stop(failure??'backup_process_descendants_unresolved');
    }catch{await release(true);}finally{checking=false;}
  };
  const stop=reason=>{
    if(settled)return completed;
    failure??=reason;
    if(termTimer||killTimer)return completed;
    stdout.destroy(code(failure));
    save('terminating');signal('SIGTERM');child?.stdin.destroy();
    termTimer=setTimeout(()=>{
      termTimer=null;save('killing');signal('SIGKILL');
      killTimer=setTimeout(async()=>{
        killTimer=null;
        try{if(exit&&closed&&stdoutClosed&&stderrClosed&&await groupStopped(child.pid))await release(false);else await release(true);}
        catch{await release(true);}
      },killWaitMs);
      void inspect();
    },graceMs);
    return completed;
  };
  // These listeners exist before any bytes can arrive or any caller can
  // receive the handoff. Early cancellation must unblock a stalled producer;
  // failures must remain handled even while launch is awaiting durable custody.
  stdout.on('error',()=>{if(!settled)void stop('backup_process_consumer_failed');});
  stdout.once('close',()=>{if(!settled&&!stdout.readableEnded)void stop('backup_process_consumer_failed');});
  try{
    child=spawn(real,args,{env:environment,stdio:['pipe','pipe','pipe'],detached:true,shell:false});
    child.stdin.on('error',()=>{});child.stdout.on('error',()=>{void stop('backup_process_failed_or_warned');});child.stderr.on('error',()=>{});
    let stderr=0;
    child.stderr.on('data',bytes=>{stderr+=bytes.length;if(stderr>stderrLimit)stop('backup_process_output_limit');});
    child.stdout.once('close',()=>{stdoutClosed=true;if(!settled&&!child.stdout.readableEnded)void stop('backup_process_failed_or_warned');void inspect();});child.stderr.once('close',()=>{stderrClosed=true;void inspect();});
    child.once('error',()=>{failure??='backup_process_unavailable';exit={code:null};closed=true;stdoutClosed=true;stderrClosed=true;if(!child.pid)void release(false);});
    child.once('exit',(status,signalName)=>{exit={code:status,signal:signalName};if(status!==0||signalName||stderr)failure??='backup_process_failed_or_warned';exitTimer=setTimeout(()=>void inspect(true),1000);void inspect();});
    child.once('close',()=>{closed=true;void inspect();});
    child.stdout.pipe(stdout);
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    record.child_pid=child.pid;record.child_start=(await identity(child.pid))?.start??null;
    await save('running');
    ready=true;
    timer=setTimeout(()=>stop('backup_process_timed_out'),timeoutMs);
    if(exit)void inspect();
    return {child,stdout,completed,stop,id};
  }catch(error){if(child?.pid){ready=true;stop('backup_process_custody_write_failed');await completed.catch(()=>{});}else{failure??='backup_process_unavailable';await release(false);}throw error;}
}
