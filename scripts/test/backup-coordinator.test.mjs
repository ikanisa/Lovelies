import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable,PassThrough} from 'node:stream';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {backupCatalog,backupHealth,createBackup,expireBackups,verifyBackup,withVerifiedBackup,withBackupCatalog} from '../lib/encrypted-backup.mjs';
import {backupProcess} from '../lib/backup-process.mjs';

const cli=fileURLToPath(new URL('../backup-database.mjs',import.meta.url));
const payload=Buffer.from('PGDMP\x01synthetic-coordinator-archive');
async function scope(t){
  const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'lovelies-backup-coordinator-'));
  const directory=path.join(root,'catalog');await fs.mkdir(directory,{mode:0o700});
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  return {root,directory,key:randomBytes(32),environment:'local-qualification'};
}
const create=config=>createBackup({...config,source:Readable.from([payload])});

test('one backup lease spans creation and inspection and excludes every ordinary library caller',async t=>{
  const config=await scope(t),hold=path.join(config.directory,'.lovelies-backup.lock');let id;
  await withBackupCatalog(config,async catalog=>{
    const before=await fs.readFile(hold,'utf8');id=(await catalog.create({source:Readable.from([payload])})).id;
    await catalog.consume(id,async stream=>{
      assert.equal(await fs.readFile(hold,'utf8'),before);
      const operations=[()=>create(config),()=>backupCatalog(config),()=>verifyBackup({...config,id}),
        ()=>withVerifiedBackup({...config,id},async()=>{}),()=>expireBackups(config),
        ()=>backupHealth({...config,maxAgeHours:24},async()=>{})];
      for(const operation of operations)await assert.rejects(operation,{code:'EEXIST'});
      const bytes=[];for await(const chunk of stream)bytes.push(chunk);assert.deepEqual(Buffer.concat(bytes),payload);
    });
    assert.equal(await fs.readFile(hold,'utf8'),before);
  });
  await assert.rejects(fs.stat(hold),{code:'ENOENT'});assert.equal((await verifyBackup({...config,id})).id,id);
});

test('a catalog capability expires and cannot be reused or accept an alternate directory',async t=>{
  const config=await scope(t);let saved;
  await withBackupCatalog(config,async catalog=>{saved=catalog;await catalog.catalog();});
  assert.equal(Object.isFrozen(saved),true);
  await assert.rejects(saved.catalog(),{code:'backup_lease_closed'});
  await assert.rejects(saved.create({...config,directory:'/alternate',source:Readable.from([payload])}),{code:'backup_lease_closed'});
});

test('a returned callback cannot release an unawaited archive writer',async t=>{
  const config=await scope(t),source=new PassThrough();let started,finished=false,operation;
  const entered=new Promise(resolve=>{started=resolve;});
  const outer=withBackupCatalog(config,catalog=>{operation=catalog.create({source});started();return 'callback result';}).then(value=>{finished=true;return value;});
  await entered;assert.equal(finished,false);await assert.rejects(backupCatalog(config),{code:'EEXIST'});
  source.end(payload);assert.equal(await outer,'callback result');
  const metadata=await operation;assert.equal((await verifyBackup({...config,id:metadata.id})).id,metadata.id);
});

test('unknown producer outcome retains its exact hold, partial archive and unknown files',async t=>{
  const config=await scope(t),sentinel=path.join(config.directory,'unmanaged-preserve');await fs.writeFile(sentinel,'preserve',{mode:0o600});
  const original=Object.assign(new Error('backup_process_outcome_unresolved'),{code:'backup_process_outcome_unresolved',backupOutcomeUnknown:true});
  const source=new Readable({read(){this.destroy(original);}});
  await assert.rejects(createBackup({...config,source,sourceCompleted:Promise.reject(original)}),error=>error.backupOutcomeUnknown===true);
  const entries=await fs.readdir(config.directory);
  assert(entries.includes('.lovelies-backup.lock'));assert(entries.some(name=>name.endsWith('.partial')));
  assert.equal(await fs.readFile(sentinel,'utf8'),'preserve');await assert.rejects(backupCatalog(config),{code:'EEXIST'});
});

for(const unawaited of [false,true])test('caught or already settled unknown operation keeps the backup hold: unawaited='+unawaited,{timeout:5000},async t=>{
  const config=await scope(t),original=Object.assign(new Error('backup_process_outcome_unresolved'),{code:'backup_process_outcome_unresolved',backupOutcomeUnknown:true});
  const source=new Readable({read(){this.destroy(original);}});let rejected;
  await assert.rejects(withBackupCatalog(config,async catalog=>{
    const task=catalog.create({source,sourceCompleted:Promise.reject(original)});
    if(unawaited){
      task.catch(error=>{rejected=error;});
      // Let failure settle before callback exit so there is no current pending
      // operation for final accounting to discover.
      while(!rejected&&!t.signal.aborted)await new Promise(resolve=>setImmediate(resolve));
      assert(rejected);
      await new Promise(resolve=>setImmediate(resolve));
    }else try{await task;}catch(error){rejected=error;}
    return 'must not authorize lease release';
  }),error=>error===rejected&&error.backupOutcomeUnknown===true);
  assert((await fs.stat(path.join(config.directory,'.lovelies-backup.lock'))).isFile());
  await assert.rejects(backupCatalog(config),{code:'EEXIST'});
});

for(const partial of [false,true])test('early verified-consumer success stops a large transfer without deleting its backup: partial='+partial,async t=>{
  const config=await scope(t),large=Buffer.alloc(1024*1024,71);payload.copy(large);
  const metadata=await createBackup({...config,source:Readable.from([large])});
  const file=path.join(config.directory,metadata.archive),before=await fs.readFile(file);
  await assert.rejects(withVerifiedBackup({...config,id:metadata.id},async stream=>{
    if(partial){await once(stream,'readable');assert.equal(stream.read(1).length,1);}
    return 'synthetic premature success';
  }),{code:'backup_consumer_incomplete'});
  assert.deepEqual(await fs.readFile(file),before);
  assert.equal((await verifyBackup({...config,id:metadata.id})).id,metadata.id);
});

test('a falsy producer rejection before lease admission cannot publish an archive',async t=>{
  const config=await scope(t);
  for(const original of [undefined,null,false,0,'']){
    await createBackup({...config,source:Readable.from([payload]),sourceCompleted:Promise.reject(original)})
      .then(()=>assert.fail('failed producer succeeded'),error=>assert.equal(error,original));
    assert.deepEqual(await fs.readdir(config.directory),[]);
  }
});

test('failed inspection preserves the completed authenticated backup and releases a settled lease',async t=>{
  const config=await scope(t);let id;
  await assert.rejects(withBackupCatalog(config,async catalog=>{
    id=(await catalog.create({source:Readable.from([payload])})).id;
    await catalog.consume(id,async()=>{throw new Error('synthetic inspector failure');});
  }),/synthetic inspector failure/);
  assert.equal((await verifyBackup({...config,id})).id,id);
});

test('replaced lease path is preserved and cleanup cannot mask a frozen original failure',async t=>{
  const config=await scope(t),hold=path.join(config.directory,'.lovelies-backup.lock'),saved=path.join(config.directory,'saved-original-hold');
  const original=Object.freeze(Object.assign(new Error('backup_synthetic_original'),{code:'backup_synthetic_original'}));
  await assert.rejects(withBackupCatalog(config,async()=>{
    await fs.rename(hold,saved);await fs.writeFile(hold,'replacement owner',{mode:0o600});throw original;
  }),error=>error.code===original.code&&error.cause===original&&error.backupOutcomeUnknown===true);
  assert.equal(await fs.readFile(hold,'utf8'),'replacement owner');assert((await fs.stat(saved)).isFile());
});

test('primitive callback failures are never converted into a successful lease result',async t=>{
  const config=await scope(t);
  for(const original of [undefined,null,0,false,'']){
    await withBackupCatalog(config,()=>{throw original;}).then(()=>assert.fail('failed callback succeeded'),error=>assert.equal(error,original));
    assert.deepEqual((await backupCatalog(config)).backups,[]);
  }
});

for(const failWrite of [1,2])test('encrypted write failure '+failWrite+' cancels its live producer before awaiting completion',async t=>{
  const config=await scope(t),original=Object.freeze(Object.assign(new Error('backup_synthetic_write'),{code:'backup_synthetic_write'}));
  const open=fs.open.bind(fs);let writes=0,cancelled=false;
  t.mock.method(fs,'open',async(name,...args)=>{
    const handle=await open(name,...args);
    if(!String(name).endsWith('.lvbk.partial'))return handle;
    return new Proxy(handle,{get(target,key){
      if(key==='write')return async(...values)=>{if(++writes===failWrite)throw original;return target.write(...values);};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
  });
  const task=backupProcess(process.execPath,['--input-type=module','-e',
    `process.stdout.write(Buffer.from(${JSON.stringify([...payload])}));setInterval(()=>{},1000);`],
    {PATH:process.env.PATH},{timeoutMs:5000,graceMs:50,reapMs:1000});
  t.after(()=>{if(task.child.exitCode===null&&task.child.signalCode===null)task.child.kill('SIGKILL');});
  task.child.stdin.end();
  await assert.rejects(createBackup({...config,source:task.child.stdout,sourceCompleted:task.completed,
    cancelSource:reason=>{cancelled=true;return task.cancel(reason);}}),error=>error===original);
  assert.equal(cancelled,true);assert(task.child.exitCode!==null||task.child.signalCode!==null);
  assert.deepEqual(await fs.readdir(config.directory),[]);
});

async function fixtureTools(config){
  const tools=path.join(config.root,'tools'),log=path.join(config.root,'phases.jsonl');await fs.mkdir(tools,{mode:0o700});
  for(const name of ['pg_dump','pg_restore']){
    const script=`#!${process.execPath}\nimport fs from 'node:fs';\nconst name=${JSON.stringify(name)},hold=${JSON.stringify(path.join(config.directory,'.lovelies-backup.lock'))},log=${JSON.stringify(log)};\nconst lease=JSON.parse(fs.readFileSync(hold,'utf8'));fs.appendFileSync(log,JSON.stringify({name,phase:process.argv[2],run_id:lease.run_id})+'\\n',{mode:0o600});\nif(process.argv[2]==='--version')process.stdout.end(name+' (PostgreSQL) 17.11\\n');\nelse if(name==='pg_dump')process.stdout.end(Buffer.from(${JSON.stringify([...payload])}));\nelse {const bytes=fs.readFileSync(0);if(!bytes.equals(Buffer.from(${JSON.stringify([...payload])})))process.exit(9);process.stdout.end('; synthetic archive entry\\n');}\n`;
    await fs.writeFile(path.join(tools,name),script,{mode:0o700});
  }
  return {dump:path.join(tools,'pg_dump'),restore:path.join(tools,'pg_restore'),log};
}
async function execute(config,args){
  const child=spawn(process.execPath,[cli,...args,'--directory',config.directory,'--local-qualification'],
    {env:{PATH:process.env.PATH,LOVELIES_BACKUP_ENCRYPTION_KEY:config.key.toString('base64url'),PGHOST:'127.0.0.1',PGDATABASE:'lovelies_test_coordinator',PGUSER:'fixture'},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',bytes=>{stdout+=bytes;});child.stderr.on('data',bytes=>{stderr+=bytes;});
  const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
  try{const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});return {code,stdout,stderr};}
  finally{clearTimeout(timer);}
}

test('CLI holds one lease before both version probes, dump and final inspection',async t=>{
  const config=await scope(t),tools=await fixtureTools(config);
  const result=await execute(config,['create','--pg-dump',tools.dump,'--pg-restore',tools.restore]);
  assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(result.stdout).status,'created_and_verified');
  const phases=(await fs.readFile(tools.log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(phases.map(value=>[value.name,value.phase]),[['pg_dump','--version'],['pg_restore','--version'],['pg_dump','--format=custom'],['pg_restore','--list']]);
  assert.equal(new Set(phases.map(value=>value.run_id)).size,1);assert.equal(typeof phases[0].run_id,'string');
});

test('an existing catalog hold prevents CLI tool qualification or producer dispatch',async t=>{
  const config=await scope(t),tools=await fixtureTools(config),hold=path.join(config.directory,'.lovelies-backup.lock');
  await fs.writeFile(hold,'existing owner',{mode:0o600});
  const result=await execute(config,['create','--pg-dump',tools.dump,'--pg-restore',tools.restore]);
  assert.equal(result.code,1);assert.equal(result.stdout,'');await assert.rejects(fs.stat(tools.log),{code:'ENOENT'});
  assert.equal(await fs.readFile(hold,'utf8'),'existing owner');
});
