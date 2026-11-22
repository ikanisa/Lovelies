import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {backupProcess} from '../lib/backup-process.mjs';

function tool(t,source,options={}){
  const task=backupProcess(process.execPath,['--input-type=module','-e',source],{PATH:process.env.PATH},options);
  const kill=task.child.kill.bind(task.child);
  t.after(async()=>{
    if(task.child.exitCode===null&&task.child.signalCode===null){
      kill('SIGKILL');await once(task.child,'close').catch(()=>{});
    }
  });
  task.child.stdin.end();return task;
}

test('backup producer preserves all bytes written before its encryption consumer attaches',async t=>{
  const size=512*1024;
  const task=tool(t,`process.stdout.end(Buffer.alloc(${size},71));`,{timeoutMs:5000});
  await new Promise(resolve=>setTimeout(resolve,50));
  const chunks=[];for await(const chunk of task.child.stdout)chunks.push(chunk);
  await task.completed;assert.deepEqual(Buffer.concat(chunks),Buffer.alloc(size,71));
});

test('backup process warning never becomes success or exposes raw diagnostics',async t=>{
  const task=tool(t,"process.stderr.end('SYNTHETIC_PRIVATE_DIAGNOSTIC');",{timeoutMs:5000});
  await assert.rejects(task.completed,error=>error.code==='backup_process_failed_or_warned'&&!error.message.includes('PRIVATE'));
});

test('an ignored termination request is escalated and the direct backup child is reaped',async t=>{
  const task=tool(t,"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);",{timeoutMs:1000,graceMs:100,reapMs:1000});
  await assert.rejects(task.completed,{code:'backup_process_timed_out'});
  assert.equal(task.child.signalCode,'SIGKILL');assert.equal(task.child.exitCode,null);
});

test('backup timeout remains failure when its child handles termination and exits zero',async t=>{
  const task=tool(t,"process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);",{timeoutMs:1000,graceMs:100,reapMs:1000});
  await assert.rejects(task.completed,{code:'backup_process_timed_out'});
  assert.equal(task.child.exitCode,0);
});

test('backup output overflow remains failure even after a successful child exit',async t=>{
  let copied=0;
  const task=tool(t,"process.stdout.end(Buffer.alloc(4096,65));",{timeoutMs:5000,stdoutLimit:1024,onStdout:bytes=>{copied+=bytes.length;}});
  await assert.rejects(task.completed,{code:'backup_inspection_output_limit'});
  assert.equal(copied,0);
});

test('unconfirmed reaping requires a hold and late zero exit cannot clear it',async t=>{
  const task=tool(t,"setTimeout(()=>process.exit(0),500);",{timeoutMs:100,graceMs:30,reapMs:30});
  // Simulate an unavailable signal/reaping facility with a bounded, naturally
  // exiting owned fixture. Its eventual close is awaited before this test ends.
  t.mock.method(task.child,'kill',()=>false);
  const closed=once(task.child,'close');
  let first;
  await assert.rejects(task.completed,error=>{first=error;return error.code==='backup_process_timed_out'&&error.backupOutcomeUnknown===true;});
  await closed;assert.equal(task.child.exitCode,0);
  await assert.rejects(task.completed,error=>error===first);
});

test('cancellation preserves primitive and frozen original failures without property writes',async t=>{
  for(const original of [undefined,null,0,false,'',Object.freeze(new Error('original frozen failure'))]){
    const task=tool(t,'setInterval(()=>{},1000);',{timeoutMs:5000,graceMs:50,reapMs:1000});
    assert.equal(await task.cancel(original),original);
    await task.completed.then(()=>assert.fail('cancelled child succeeded'),error=>assert.equal(error,original));
  }
});

test('pre-cancelled backup admission launches no tool',()=>{
  const controller=new AbortController();controller.abort();
  assert.throws(()=>backupProcess('/no/tool/should/start',[],{}, {signal:controller.signal}),{code:'backup_process_cancelled'});
});
