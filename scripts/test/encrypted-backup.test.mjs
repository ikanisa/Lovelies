import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {test} from 'node:test';
import {BACKUP_TTL,backupCatalog,backupDirectory,backupKey,createBackup,expireBackups,verifyBackup,withVerifiedBackup} from '../lib/encrypted-backup.mjs';

const environment='local-qualification';
const fixture=Buffer.from('PGDMP\u0001Cryptographic fixture only: PRIVATE_SYNTHETIC_DATABASE_CONTENT');
async function scope(t){const directory=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'lovelies-backup-test-'));await fs.chmod(directory,0o700);t.after(()=>fs.rm(directory,{recursive:true,force:true}));return {directory,key:randomBytes(32),environment};}
const source=()=>Readable.from([fixture.subarray(0,2),fixture.subarray(2,13),fixture.subarray(13)]);
const create=(config,at=1000000)=>createBackup({...config,source:source(),now:()=>at});

test('authenticated encrypted backup verifies and recovers exact bytes before any consumer runs',async t=>{
  const config=await scope(t),metadata=await create(config);
  assert.equal(metadata.expires_at-metadata.created_at,BACKUP_TTL);
  const raw=await fs.readFile(path.join(config.directory,metadata.archive));assert(!raw.includes(fixture));
  assert.equal((await fs.stat(path.join(config.directory,metadata.archive))).mode&0o777,0o600);
  assert.deepEqual(await verifyBackup({...config,id:metadata.id}),metadata);
  const recovered=await withVerifiedBackup({...config,id:metadata.id},async stream=>{const chunks=[];for await(const chunk of stream)chunks.push(chunk);return Buffer.concat(chunks);});
  assert.deepEqual(recovered,fixture);assert.equal((await backupCatalog(config)).backups.length,1);
});
test('failed producer after EOF cannot publish a successful or partial catalog entry',async t=>{
  const config=await scope(t);
  await assert.rejects(createBackup({...config,source:source(),sourceCompleted:Promise.reject(Error('synthetic pg_dump failure'))}),/synthetic pg_dump failure/);
  assert.deepEqual(await fs.readdir(config.directory),[]);
  await assert.rejects(createBackup({...config,source:Readable.from([Buffer.from('not a database archive')])}),/backup_source_format/);
  assert.deepEqual(await fs.readdir(config.directory),[]);
});
test('interrupted source preserves failure and releases its own lock without a catalog',async t=>{
  const config=await scope(t);
  const broken=Readable.from((async function*(){yield Buffer.from('PGDMP');throw Error('synthetic dropped producer');})());
  await assert.rejects(createBackup({...config,source:broken}),/synthetic dropped producer/);
  assert.deepEqual(await fs.readdir(config.directory),[]);
});
test('corrupted ciphertext never reaches a plaintext consumer or permits expiry',async t=>{
  const config=await scope(t),metadata=await create(config),file=path.join(config.directory,metadata.archive);
  const bytes=await fs.readFile(file);bytes[bytes.length-18]^=1;await fs.writeFile(file,bytes);
  let called=false;
  await assert.rejects(withVerifiedBackup({...config,id:metadata.id},async()=>{called=true;}),/backup_archive_integrity/);
  assert.equal(called,false);await assert.rejects(expireBackups({...config,now:()=>metadata.expires_at}),/backup_archive_integrity/);
  assert(await fs.stat(file));
});
test('manifest alterations and wrong keys fail without pruning an otherwise eligible archive',async t=>{
  const config=await scope(t),metadata=await create(config),file=path.join(config.directory,`lovelies-db-${metadata.id}.json`),raw=await fs.readFile(file);
  await assert.rejects(verifyBackup({...config,id:metadata.id,key:randomBytes(32)}),/backup_manifest_authentication/);
  const changed=JSON.parse(raw);changed.expires_at+=BACKUP_TTL;await fs.writeFile(file,JSON.stringify(changed));
  await assert.rejects(expireBackups({...config,now:()=>metadata.expires_at}),/backup_manifest_authentication/);
  await fs.writeFile(file,raw);assert.equal((await verifyBackup({...config,id:metadata.id})).expires_at,metadata.expires_at);
});
test('seven-day exact expiry preserves newer managed copies and every unknown file',async t=>{
  const config=await scope(t),old=await create(config,1000000),fresh=await create(config,1000001);
  const unknown=path.join(config.directory,'unknown-owner.bin');await fs.writeFile(unknown,'preserve',{mode:0o600});
  assert.deepEqual(await expireBackups({...config,now:()=>old.expires_at-1}),{expired:0,unmanaged_entries:1});
  assert.deepEqual(await expireBackups({...config,now:()=>old.expires_at}),{expired:1,unmanaged_entries:1});
  assert.equal((await backupCatalog(config)).backups[0].id,fresh.id);assert.equal(await fs.readFile(unknown,'utf8'),'preserve');
});
test('all recognized catalog pairs validate before any eligible pair is deleted',async t=>{
  const config=await scope(t),first=await create(config),second=await create(config);
  const file=path.join(config.directory,`lovelies-db-${second.id}.json`),changed=JSON.parse(await fs.readFile(file,'utf8'));changed.mac='0'.repeat(64);await fs.writeFile(file,JSON.stringify(changed));
  await assert.rejects(expireBackups({...config,now:()=>first.expires_at}),/backup_manifest_authentication/);
  assert(await fs.stat(path.join(config.directory,first.archive)));assert(await fs.stat(path.join(config.directory,second.archive)));
});
test('symlink, hardlink and broad directory permissions are refused',async t=>{
  const config=await scope(t),metadata=await create(config),file=path.join(config.directory,metadata.archive),outside=path.join(config.directory,'outside.bin');
  await fs.rename(file,outside);await fs.symlink(outside,file);await assert.rejects(verifyBackup({...config,id:metadata.id}),/backup_file_invalid/);
  await fs.unlink(file);await fs.link(outside,file);await assert.rejects(verifyBackup({...config,id:metadata.id}),/backup_file_invalid/);
  await fs.unlink(file);await fs.rename(outside,file);await fs.chmod(config.directory,0o750);await assert.rejects(backupDirectory(config.directory),/backup_directory_permissions/);
});
test('stale locks are preserved, cross-environment archives are denied, keys are canonical',async t=>{
  const config=await scope(t),metadata=await create(config);
  await assert.rejects(verifyBackup({...config,id:metadata.id,environment:'production'}),/backup_manifest_invalid/);
  const lock=path.join(config.directory,'.lovelies-backup.lock');await fs.writeFile(lock,'original lock',{mode:0o600});
  await assert.rejects(create(config),{code:'EEXIST'});assert.equal(await fs.readFile(lock,'utf8'),'original lock');
  for(const invalid of ['',randomBytes(31).toString('base64url'),'x'.repeat(44)])assert.throws(()=>backupKey(invalid),/backup_key_invalid/);
  const key=randomBytes(32);assert.deepEqual(backupKey(key.toString('base64url')),key);
});
test('a consumer failure cancels delivery and releases the exclusive catalog lease',async t=>{
  const config=await scope(t),metadata=await create(config);
  await assert.rejects(withVerifiedBackup({...config,id:metadata.id},async()=>{throw Error('controlled consumer stop');}),/controlled consumer stop/);
  assert.equal((await verifyBackup({...config,id:metadata.id})).id,metadata.id);
});
test('expiry recovers an interrupted payload-first deletion without adopting or deleting unknown data',async t=>{
  const config=await scope(t),metadata=await create(config),catalog=path.join(config.directory,`lovelies-db-${metadata.id}.json`),unlink=fs.unlink.bind(fs);let injected=false;
  t.mock.method(fs,'unlink',async file=>{if(file===catalog&&!injected){injected=true;throw Error('controlled catalog unlink interruption');}return unlink(file);});
  await assert.rejects(expireBackups({...config,now:()=>metadata.expires_at}),/controlled catalog unlink interruption/);
  await assert.rejects(fs.stat(path.join(config.directory,metadata.archive)),{code:'ENOENT'});assert(await fs.stat(catalog));
  const unknown=path.join(config.directory,'unknown-recovery-copy');await fs.writeFile(unknown,'preserve',{mode:0o600});
  assert.deepEqual(await expireBackups({...config,now:()=>metadata.expires_at}),{expired:1,unmanaged_entries:1});
  assert.equal(await fs.readFile(unknown,'utf8'),'preserve');assert.deepEqual((await backupCatalog(config)).backups,[]);
});
