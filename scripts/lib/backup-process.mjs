/** PostgreSQL tool supervision. No shell, process-group signals or raw diagnostics.
 * A deadline is failure even if the child later exits zero. An unconfirmed
 * direct-child/stdio outcome carries a durable-catalog-hold requirement.
 */
import {spawn} from 'node:child_process';

const failure=code=>Object.assign(new Error(code),{code});
const unknown=reason=>Object.assign(new Error(/^backup_[a-z_]+$/.test(reason?.code??'')?reason.code:'backup_process_outcome_unresolved',{cause:reason}),
  {code:/^backup_[a-z_]+$/.test(reason?.code??'')?reason.code:'backup_process_outcome_unresolved',backupOutcomeUnknown:true});
export function backupProcess(executable,args,environment,{
  timeoutMs=240000,graceMs=1000,reapMs=1000,stdoutLimit=Infinity,
  stdoutLimitCode='backup_inspection_output_limit',onStdout,signal,
}={}){
  for(const value of [timeoutMs,graceMs,reapMs])
    if(!Number.isSafeInteger(value)||value<1)throw failure('backup_process_config_invalid');
  if(!(stdoutLimit===Infinity||Number.isSafeInteger(stdoutLimit)&&stdoutLimit>=0)||
      onStdout!==undefined&&typeof onStdout!=='function')throw failure('backup_process_config_invalid');
  if(signal?.aborted)throw failure('backup_process_cancelled');
  const child=spawn(executable,args,{env:environment,stdio:['pipe','pipe','pipe']});
  let resolve,reject,problem,failed=false,settled=false,exited=false,closed=false,spawnFailed=false;
  let stderrBytes=0,stdoutBytes=0,graceTimer,reapTimer;
  const completed=new Promise((yes,no)=>{resolve=yes;reject=no;});
  // The producer can fail while the caller is opening its encrypted output.
  completed.catch(()=>{});
  const clear=()=>{clearTimeout(deadline);clearTimeout(graceTimer);clearTimeout(reapTimer);signal?.removeEventListener('abort',aborted);};
  function finish(){
    if(settled||!closed)return;
    settled=true;clear();
    if(!exited&&!spawnFailed)reject(unknown(failed?problem:failure('backup_process_outcome_unresolved')));
    else if(failed)reject(problem);
    else if(spawnFailed)reject(failure('backup_process_unavailable'));
    else if(child.exitCode!==0||stderrBytes!==0)reject(failure('backup_process_failed_or_warned'));
    else resolve();
  }
  function unresolved(){
    if(settled)return;
    problem=unknown(problem);failed=true;
    settled=true;clear();
    // These are only the coordinator's owned pipes. Closing them and unref'ing
    // the child permits a bounded failure response; neither proves that an
    // inherited pipe holder or an uninterruptible child terminated.
    for(const stream of [child.stdin,child.stdout,child.stderr])stream.destroy(problem);
    child.unref();reject(problem);
  }
  function stop(reason){
    if(settled)return;
    if(!failed){problem=reason;failed=true;}
    if(graceTimer||reapTimer)return;
    if(!exited&&!spawnFailed){try{child.kill('SIGTERM');}catch{}}
    graceTimer=setTimeout(()=>{
      // Signal only this still-owned ChildProcess, never a saved numeric PID.
      if(!exited&&!spawnFailed){try{child.kill('SIGKILL');}catch{}}
      reapTimer=setTimeout(unresolved,reapMs);
    },graceMs);
  }
  function aborted(){stop(failure('backup_process_cancelled'));}
  const deadline=setTimeout(()=>stop(failure('backup_process_timed_out')),timeoutMs);
  child.once('error',()=>{spawnFailed=child.pid===undefined;if(!failed){problem=failure('backup_process_unavailable');failed=true;}if(!spawnFailed)stop(problem);});
  child.once('exit',()=>{exited=true;});
  child.once('close',()=>{closed=true;finish();});
  // Avoid unhandled pipe errors when a failed/terminated inspector closes stdin.
  for(const stream of [child.stdin,child.stdout,child.stderr])stream.on('error',reason=>{
    stop(/^backup_[a-z_]+$/.test(reason?.code??'')?reason:failure('backup_process_stream_failed'));
  });
  child.stderr.on('data',bytes=>{stderrBytes+=bytes.length;if(stderrBytes>65536)stop(failure('backup_process_failed_or_warned'));});
  // A dump's stdout must remain paused until the encryption pipeline attaches.
  // Merely installing a data-counting listener here would discard early bytes.
  if(onStdout||stdoutLimit!==Infinity)child.stdout.on('data',bytes=>{
    stdoutBytes+=bytes.length;
    if(stdoutBytes>stdoutLimit)stop(failure(stdoutLimitCode));
    else if(onStdout){try{onStdout(bytes);}catch{stop(failure('backup_process_output_failed'));}}
  });
  signal?.addEventListener('abort',aborted,{once:true});
  if(signal?.aborted)aborted();
  return {child,completed,async cancel(reason){
    stop(reason);
    try{await completed;}catch(outcome){return outcome;}
    return reason;
  }};
}
