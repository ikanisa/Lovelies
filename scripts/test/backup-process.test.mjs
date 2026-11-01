import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {finished} from 'node:stream/promises';
import {managedBackupProcess,backupProcessStatus,reconcileBackupProcess,assertNoBackupProcessHolds} from '../lib/backup-process.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'lovelies-managed-process-'));await fs.chmod(directory,0o700);
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));return {directory,key:randomBytes(32),stage:'inspect',binary:process.execPath,environment:{PATH:process.env.PATH},timeoutMs:3000,graceMs:100,killWaitMs:1500};
}
async function launch(config,source){return managedBackupProcess({...config,args:['--input-type=module','-e',source]});}
const holds=async config=>(await fs.readdir(config.directory)).filter(x=>x.startsWith('.lovelies-process-'));

test('managed success waits for streams and records no leftover custody hold',async t=>{
 const c=await fixture(t),task=await launch(c,"process.stdout.write('verified synthetic output');");let output='';
 task.stdout.on('data',x=>output+=x);task.child.stdin.end();await Promise.all([finished(task.stdout,{cleanup:true}),task.completed]);
 assert.equal(output,'verified synthetic output');assert.deepEqual(await holds(c),[]);
});

test('native fast stdout survives process completion before a reader is attached',async t=>{
 const c=await fixture(t),expected=Buffer.from('PGDMP\u0001synthetic-native-stdout\n');
 const task=await managedBackupProcess({...c,binary:'/usr/bin/printf',args:['%s',expected.toString()]});
 try{
  task.child.stdin.end();await task.completed;
  assert.equal(task.child.exitCode,0);assert.equal(task.child.stdout.readableEnded,true);
  // Intentionally attach only AFTER raw stdout and the child have closed.
  // Process completion must not discard the consumer's still-unread bytes.
  assert.equal(task.stdout.destroyed,false);
  const chunks=[];for await(const chunk of task.stdout)chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks),expected);assert.deepEqual(await holds(c),[]);
 }finally{await task.stop('backup_process_consumer_failed').catch(()=>{});}
});

const largeWriter=`import {once} from 'node:events';
 const chunk=Buffer.alloc(32768,90);for(let i=0;i<128;i++)if(!process.stdout.write(chunk))await once(process.stdout,'drain');`;
async function buffered(task){
 const deadline=Date.now()+2000;
 while(task.stdout.readableLength<65536){
  if(task.child.exitCode!==null||task.child.signalCode!==null||Date.now()>deadline)throw Error('bounded_stdout_buffer_not_observed');
  await sleep(10);
 }
}
test('large stdout backpressures a delayed reader and preserves every byte on drain',async t=>{
 const c=await fixture(t);c.timeoutMs=5000;const task=await launch(c,largeWriter);
 try{
  task.child.stdin.end();await buffered(task);await sleep(50);
  assert.equal(task.child.exitCode,null,'A four-MiB producer must wait for the reader');
  assert(task.stdout.readableLength+task.stdout.writableLength<=256*1024,'Queued handoff bytes stay bounded');
  const actual=createHash('sha256'),expected=createHash('sha256');let bytes=0;
  for(let index=0;index<128;index++)expected.update(Buffer.alloc(32768,90));
  for await(const chunk of task.stdout){bytes+=chunk.length;actual.update(chunk);}
  await task.completed;assert.equal(bytes,4*1024*1024);assert.equal(actual.digest('hex'),expected.digest('hex'));
  assert.deepEqual(await holds(c),[]);
 }finally{await task.stop('backup_process_consumer_failed').catch(()=>{});}
});

test('a cancelled stdout reader terminates a backpressured producer without leaving a hold',async t=>{
 const c=await fixture(t);c.timeoutMs=5000;const task=await launch(c,largeWriter);
 try{
  task.child.stdin.end();await buffered(task);task.stdout.destroy();
  await assert.rejects(task.completed,{code:'backup_process_consumer_failed'});
  assert(task.child.exitCode!==null||task.child.signalCode!==null);assert.equal(task.child.stdout.destroyed,true);
  assert.deepEqual(await holds(c),[]);
 }finally{await task.stop('backup_process_consumer_failed').catch(()=>{});}
});

test('premature raw stdout closure cannot become a successful buffered result',async t=>{
 const c=await fixture(t);c.timeoutMs=5000;const task=await launch(c,largeWriter);
 try{
  task.child.stdin.end();await buffered(task);
  const consumed=finished(task.stdout,{cleanup:true});consumed.catch(()=>{});
  task.child.stdout.destroy();
  await assert.rejects(task.completed,{code:'backup_process_failed_or_warned'});
  await assert.rejects(consumed,{code:'backup_process_failed_or_warned'});
  assert.equal(task.stdout.destroyed,true);assert.deepEqual(await holds(c),[]);
 }finally{await task.stop('backup_process_consumer_failed').catch(()=>{});}
});

test('failed producer discards buffered output and preserves the primary process failure',async t=>{
 const c=await fixture(t),task=await launch(c,"process.stdout.write('partial');process.exit(7);");
 try{
  task.child.stdin.end();await assert.rejects(task.completed,{code:'backup_process_failed_or_warned'});
  assert.equal(task.child.exitCode,7);assert.equal(task.stdout.destroyed,true);
  await assert.rejects(finished(task.stdout,{cleanup:true}),{code:'backup_process_failed_or_warned'});
  assert.deepEqual(await holds(c),[]);
 }finally{await task.stop('backup_process_consumer_failed').catch(()=>{});}
});

test('SIGTERM-resistant owned child is killed within the bound without touching an unrelated process',async t=>{
 const c=await fixture(t);c.timeoutMs=250;
 const sentinel=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 t.after(()=>{try{sentinel.kill('SIGKILL');}catch{}});
 const started=Date.now(),task=await launch(c,"process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000);");
 task.stdout.resume();task.child.stdin.end();await assert.rejects(task.completed,{code:'backup_process_timed_out'});
 assert(Date.now()-started<5000);assert.equal(sentinel.exitCode,null);assert.equal(sentinel.signalCode,null);
 assert.deepEqual(await holds(c),[]);
});

test('inherited descendant stdout cannot leave inspection waiting forever',async t=>{
 const c=await fixture(t);const task=await launch(c,`import {spawn} from 'node:child_process';
 spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:['ignore',1,2]}).unref();process.exit(0);`);
 task.stdout.resume();task.child.stdin.end();
 await assert.rejects(task.completed,error=>['backup_process_descendants_unresolved','backup_process_timed_out'].includes(error.code));
 assert.deepEqual(await holds(c),[]);
});

test('stderr bounds and consumer cancellation cannot be reported as successful completion',async t=>{
 const c=await fixture(t);c.stderrLimit=128;
 let task=await launch(c,"process.on('SIGTERM',()=>{});process.stderr.write('x'.repeat(4096));setInterval(()=>{},1000);");
 task.stdout.resume();task.child.stdin.end();await assert.rejects(task.completed,{code:'backup_process_output_limit'});
 task=await launch(c,"setInterval(()=>{},1000);");task.stdout.resume();
 await assert.rejects(task.stop('backup_process_consumer_failed'),{code:'backup_process_consumer_failed'});
 assert.deepEqual(await holds(c),[]);
});

test('authenticated hold refuses active-controller release and changed record identity',async t=>{
 const c=await fixture(t),task=await launch(c,"setInterval(()=>{},1000);");task.stdout.resume();
 const config={...c,id:task.id},file=path.join(c.directory,`.lovelies-process-${task.id}.json`),original=await fs.readFile(file);
 assert.equal((await backupProcessStatus(config)).successful_backup_established,false);
 await assert.rejects(assertNoBackupProcessHolds(c.directory),{code:'backup_process_reconciliation_required'});
 await assert.rejects(reconcileBackupProcess(config),{code:'backup_process_controller_active'});
 const record=JSON.parse(original);record.child_pid++;await fs.writeFile(file,JSON.stringify(record),{mode:0o600});
 await assert.rejects(backupProcessStatus(config),{code:'backup_process_record_invalid'});await fs.writeFile(file,original,{mode:0o600});
 await assert.rejects(task.stop('backup_process_consumer_failed'),{code:'backup_process_consumer_failed'});assert.deepEqual(await holds(c),[]);
});

test('controller death leaves a durable unknown hold; restart never signals a saved PID and releases only after observed stop', {timeout:15000},async t=>{
 if(process.platform!=='linux'){t.skip('Linux process-identity qualification');return;}
 const c=await fixture(t),helper=path.join(c.directory,'controller.mjs'),module=new URL('../lib/backup-process.mjs',import.meta.url).href;
 const code=`import {managedBackupProcess,backupControllerIdentity} from ${JSON.stringify(module)};
 import fs from 'node:fs/promises';import path from 'node:path';
 const c=${JSON.stringify({directory:c.directory,key:c.key.toString('hex')})};c.key=Buffer.from(c.key,'hex');
 const task=await managedBackupProcess({...c,stage:'inspect',binary:process.execPath,args:['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],environment:{PATH:process.env.PATH},timeoutMs:60000});
 await fs.writeFile(path.join(c.directory,'.lovelies-backup.lock'),JSON.stringify(await backupControllerIdentity()),{mode:0o600});
 task.stdout.resume();console.log(task.id);await task.completed;`;
 await fs.writeFile(helper,code,{mode:0o600});
 const parent=spawn(process.execPath,[helper],{stdio:['ignore','pipe','ignore']});let group=null;
 t.after(()=>{try{parent.kill('SIGKILL');}catch{}if(group)try{process.kill(-group,'SIGKILL');}catch{}});
 const id=await new Promise((resolve,reject)=>{let text='';parent.stdout.on('data',b=>{text+=b;if(text.includes('\n'))resolve(text.trim());});parent.once('error',reject);parent.once('exit',n=>{if(!text)reject(Error('controller failed '+n));});});
 const file=path.join(c.directory,`.lovelies-process-${id}.json`),record=JSON.parse(await fs.readFile(file));group=record.child_pid;
 const exited=new Promise(resolve=>parent.once('exit',resolve));parent.kill('SIGKILL');await exited;
 await assert.rejects(reconcileBackupProcess({...c,id}),{code:'backup_process_still_active'});
 process.kill(-group,0);process.kill(-group,'SIGKILL');
 let result;
 for(let attempt=0;attempt<30;attempt++){try{result=await reconcileBackupProcess({...c,id});break;}catch(error){if(error.code!=='backup_process_still_active')throw error;await sleep(20);}}
 assert.equal(result?.status,'process_custody_released_after_observed_stop');assert.equal(result.successful_backup_established,false);
 assert.equal(result.lock_released,true);await assert.rejects(fs.stat(path.join(c.directory,'.lovelies-backup.lock')),{code:'ENOENT'});
 assert.deepEqual(await holds(c),[]);
 await assertNoBackupProcessHolds(c.directory);
});
