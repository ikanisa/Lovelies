import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHmac,hkdfSync,randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {BACKUP_TTL,backupCatalog,backupHealth,createBackup} from '../lib/encrypted-backup.mjs';

const fixture=Buffer.from('PGDMP\u0001synthetic-only');
const cli=fileURLToPath(new URL('../backup-database.mjs',import.meta.url));
const environment='local-qualification',hour=3600000;
async function scope(t){
 const directory=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'lovelies-backup-health-'));
 await fs.chmod(directory,0o700);t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 return {directory,key:randomBytes(32),environment};
}
const create=(config,at)=>createBackup({...config,source:Readable.from([fixture]),now:()=>at});
const inspect=async stream=>{const parts=[];for await(const part of stream)parts.push(part);assert.deepEqual(Buffer.concat(parts),fixture);return {archive_listed:true,toc_lines:1};};
const health=(config,at,maxAgeHours=24,consumer=inspect)=>backupHealth({...config,maxAgeHours,now:()=>at},consumer);

test('empty verified catalog is attention and never invokes an archive inspector',async t=>{
 const config=await scope(t);assert.deepEqual((await backupCatalog(config)).backups,[]);let called=false;
 const value=await health(config,1000000,24,async()=>{called=true;});
 assert.equal(value.status,'local_backup_attention');assert.deepEqual(value.reasons,['no_backups']);assert.equal(called,false);
 assert.deepEqual(await fs.readdir(config.directory),[]);
});

test('fresh authenticated archive is checked through its verified stream and reports only local scope',async t=>{
 const config=await scope(t),at=10*hour,first=await create(config,at-hour),latest=await create(config,at-1000);
 let selected;const result=await health(config,at,24,async(stream,metadata)=>{selected=metadata.id;return inspect(stream);});
 assert.equal(result.status,'local_backup_artifact_verified');assert.equal(selected,latest.id);assert.notEqual(selected,first.id);
 assert.equal(result.managed_count,2);assert.equal(result.newest_id,latest.id);assert.equal(result.archive_listed,true);
 assert(result.not_established.includes('source_database_provenance'));assert(result.not_established.includes('offsite_custody'));
 assert(result.not_established.includes('schema_completeness'));assert(result.not_established.includes('catalog_history_completeness'));
 assert(result.not_established.includes('storage_objects'));assert(result.not_established.includes('restore_safety'));
 assert.deepEqual((await fs.readdir(config.directory)).sort(),[first.archive,latest.archive,`lovelies-db-${first.id}.json`,`lovelies-db-${latest.id}.json`].sort());
});

test('staleness, exact expiry, future timestamps and unknown entries never pass or delete data',async t=>{
 const config=await scope(t),created=await create(config,5*hour),unknown=path.join(config.directory,'unmanaged-file');
 assert.equal((await health(config,29*hour)).status,'local_backup_artifact_verified');
 const stale=await health(config,30*hour);assert(stale.reasons.includes('newest_backup_stale'));
 const expired=await health(config,created.expires_at,168);assert(expired.reasons.includes('expired_backups'));
 const future=await health(config,created.created_at-1);assert(future.reasons.includes('future_timestamps'));
 await fs.writeFile(unknown,'preserve',{mode:0o600});const unmanaged=await health(config,6*hour);
 assert(unmanaged.reasons.includes('unmanaged_entries'));assert.equal(await fs.readFile(unknown,'utf8'),'preserve');
 assert(await fs.stat(path.join(config.directory,created.archive)));
});

test('an expired older archive keeps the whole local catalog in attention despite a fresh archive',async t=>{
 const config=await scope(t),old=await create(config,1),at=BACKUP_TTL+2,fresh=await create(config,at-1);let called=false;
 const result=await health(config,at,24,async()=>{called=true;});assert(result.reasons.includes('expired_backups'));assert.equal(called,false);
 assert(await fs.stat(path.join(config.directory,old.archive)));assert(await fs.stat(path.join(config.directory,fresh.archive)));
});

test('corruption, a wrong key and inspector failure cannot produce health success',async t=>{
 const config=await scope(t),at=1000,record=await create(config,at);
 await assert.rejects(health({...config,key:randomBytes(32)},at),/backup_manifest_authentication/);
 await assert.rejects(health(config,at,24,async()=>({archive_listed:true,toc_lines:0})),/backup_health_inspection_invalid/);
 await assert.rejects(health(config,at,24,async()=>{throw Error('synthetic_inspector_failure');}),/synthetic_inspector_failure/);
 const file=path.join(config.directory,record.archive),bytes=await fs.readFile(file);bytes[bytes.length-17]^=1;await fs.writeFile(file,bytes);
 let called=false;await assert.rejects(health(config,at,24,async()=>{called=true;}),/backup_archive_integrity/);assert.equal(called,false);
 assert(await fs.stat(file));
});

test('a signed wrong project and a different environment cannot qualify as this project',async t=>{
 const config=await scope(t),at=1000,record=await create(config,at);
 await assert.rejects(health({...config,environment:'production'},at),/backup_manifest_invalid/);
 const manifest=path.join(config.directory,`lovelies-db-${record.id}.json`),value=JSON.parse(await fs.readFile(manifest,'utf8'));
 value.project='other-project';const {mac,...metadata}=value;
 const signingKey=Buffer.from(hkdfSync('sha256',config.key,Buffer.from('lovelies-backup-v1'),Buffer.from('catalog-authentication'),32));
 value.mac=createHmac('sha256',signingKey).update(JSON.stringify(metadata,Object.keys(metadata).sort())).digest('hex');signingKey.fill(0);
 await fs.writeFile(manifest,JSON.stringify(value));await assert.rejects(health(config,at),/backup_manifest_invalid/);
});

test('production-labelled synthetic artifacts require the production environment and retain their limits',async t=>{
 const local=await scope(t),config={...local,environment:'production'},at=1000;await create(config,at);
 await assert.rejects(health(local,at),/backup_manifest_invalid/);
 const result=await health(config,at);assert.equal(result.environment,'production');
 assert.equal(result.status,'local_backup_artifact_verified');assert(result.not_established.includes('source_database_provenance'));
});

test('a mixed old/new-key catalog fails closed and preserves both archives',async t=>{
 const config=await scope(t),old=await create(config,100),rotated={...config,key:randomBytes(32)},newer=await create(rotated,101);
 for(const candidate of [config,rotated])await assert.rejects(health(candidate,102),/backup_manifest_authentication/);
 assert(await fs.stat(path.join(config.directory,old.archive)));assert(await fs.stat(path.join(config.directory,newer.archive)));
});

test('missing archive and changed authenticated time fields cannot produce a passing status',async t=>{
 const config=await scope(t),at=1000,record=await create(config,at),manifest=path.join(config.directory,`lovelies-db-${record.id}.json`);
 const original=await fs.readFile(manifest,'utf8'),changed=JSON.parse(original);changed.created_at+=3600000;changed.expires_at+=3600000;
 await fs.writeFile(manifest,JSON.stringify(changed));await assert.rejects(health(config,at),/backup_manifest_authentication/);
 await fs.writeFile(manifest,original);await fs.unlink(path.join(config.directory,record.archive));
 await assert.rejects(health(config,at),{code:'ENOENT'});assert(await fs.stat(manifest));
});

test('missing directory is not created, invalid bounds and unsafe clocks fail closed',async t=>{
 const config=await scope(t),missing=path.join(config.directory,'not-created');
 await assert.rejects(health({...config,directory:missing},100),/backup_directory_missing/);await assert.rejects(fs.stat(missing),{code:'ENOENT'});
 for(const maxAgeHours of [0,169,1.5,NaN,Infinity])await assert.rejects(health(config,100,maxAgeHours),/backup_health_config_invalid/);
 await assert.rejects(health(config,-1),/backup_clock_invalid/);
 await create(config,100);let reads=0;
 await assert.rejects(backupHealth({...config,maxAgeHours:24,now:()=>++reads===1?100:99},inspect),/backup_clock_invalid/);
 reads=0;await assert.rejects(backupHealth({...config,maxAgeHours:24,now:()=>++reads<3?100:99},inspect),/backup_clock_invalid/);
});

test('expiry during inspection becomes attention and an existing lock is not removed',async t=>{
 const config=await scope(t),record=await create(config,1000);let reads=0;
 const result=await backupHealth({...config,maxAgeHours:168,now:()=>++reads<3?record.expires_at-1:record.expires_at},inspect);
 assert.equal(result.status,'local_backup_attention');assert(result.reasons.includes('expired_backups'));
 const lock=path.join(config.directory,'.lovelies-backup.lock');await fs.writeFile(lock,'preserve original',{mode:0o600});
 await assert.rejects(health(config,1000),{code:'EEXIST'});assert.equal(await fs.readFile(lock,'utf8'),'preserve original');
});

test('health does not follow a substituted directory symlink',async t=>{
 const config=await scope(t),alias=path.join(config.directory,'alias');await fs.symlink(config.directory,alias);
 await assert.rejects(health({...config,directory:alias},1000),/backup_directory_invalid/);
 assert((await fs.lstat(alias)).isSymbolicLink());
});

test('a cooperative writer cannot alter the catalog while health inspects the snapshot',async t=>{
 const config=await scope(t);await create(config,100);let release,entered;
 const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 const running=health(config,100,24,async stream=>{entered();await gate;return inspect(stream);});
 await started;await assert.rejects(create(config,100),{code:'EEXIST'});release();
 assert.equal((await running).status,'local_backup_artifact_verified');assert.equal((await backupCatalog(config)).backups.length,1);
});

test('on-disk archive mutation during listing cannot leave a successful health signal',async t=>{
 const config=await scope(t),at=1000,record=await create(config,at),file=path.join(config.directory,record.archive);
 await assert.rejects(health(config,at,24,async stream=>{
   const result=await inspect(stream),bytes=await fs.readFile(file);bytes[bytes.length-17]^=1;await fs.writeFile(file,bytes);return result;
 }),/backup_archive_integrity/);
 assert(await fs.stat(file));
});

test('an unmanaged file introduced during listing prevents success and is preserved',async t=>{
 const config=await scope(t),at=1000;await create(config,at);const unknown=path.join(config.directory,'appeared-during-inspection');
 await assert.rejects(health(config,at,24,async stream=>{const result=await inspect(stream);await fs.writeFile(unknown,'preserve',{mode:0o600});return result;}),/backup_catalog_changed/);
 assert.equal(await fs.readFile(unknown,'utf8'),'preserve');
});

test('CLI uses its own authenticated local catalog, rejects forged stdin and validates inspection',async t=>{
 const config=await scope(t),toolDirectory=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'lovelies-backup-tool-'));
 await fs.chmod(toolDirectory,0o700);t.after(()=>fs.rm(toolDirectory,{recursive:true,force:true}));
 const script=`#!${process.execPath}\nimport fs from 'node:fs';if(process.argv[2]==='--version'){console.log('pg_restore (PostgreSQL) 17.11');}else if(process.argv[2]==='--list'){const bytes=fs.readFileSync(0);if(bytes.subarray(0,5).toString()!=='PGDMP')process.exit(3);console.log('; synthetic listing');}else process.exit(4);\n`;
 // Place the executable outside the catalog, so it is not an unmanaged entry.
 const executable=path.join(toolDirectory,'pg_restore');await fs.writeFile(executable,script,{mode:0o700,flag:'wx'});
 const env={PATH:process.env.PATH,LOVELIES_BACKUP_ENCRYPTION_KEY:config.key.toString('base64url')};
 const args=[cli,'health','--directory',config.directory,'--pg-restore',executable,'--max-age-hours','24','--local-qualification'];
 const fake=JSON.stringify({status:'catalog_verified',backups:[{id:'forged'}]});
 let result=spawnSync(process.execPath,args,{encoding:'utf8',input:fake,env,timeout:10000});
 assert.equal(result.status,2);assert.deepEqual(JSON.parse(result.stdout).reasons,['no_backups']);
 await create(config,Date.now());result=spawnSync(process.execPath,args,{encoding:'utf8',input:fake,env,timeout:10000});
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).status,'local_backup_artifact_verified');
 assert(!result.stdout.includes(env.LOVELIES_BACKUP_ENCRYPTION_KEY));assert(!result.stderr.includes(env.LOVELIES_BACKUP_ENCRYPTION_KEY));
 for(const invalid of ['0','169','2.5','001','not-a-number']){
   result=spawnSync(process.execPath,[...args.slice(0,7),invalid,'--local-qualification'],{encoding:'utf8',env,timeout:10000});
   assert.notEqual(result.status,0);assert.equal(JSON.parse(result.stderr).code,'backup_arguments_invalid');
 }
});

test('native pg_restore rejects an authenticated but structurally incomplete synthetic archive',async t=>{
 const restore=process.env.LOVELIES_TEST_PG_RESTORE;if(!restore){t.skip('native pg_restore not supplied');return;}
 const config=await scope(t),record=await create(config,Date.now());
 const env={PATH:process.env.PATH,LOVELIES_BACKUP_ENCRYPTION_KEY:config.key.toString('base64url')};
 const args=[cli,'health','--directory',config.directory,'--pg-restore',restore,'--max-age-hours','24','--local-qualification'];
 const result=spawnSync(process.execPath,args,{encoding:'utf8',env,timeout:10000});
 assert.equal(result.status,1);assert.equal(result.stdout,'');
 assert(['backup_process_failed_or_warned','backup_operation_failed'].includes(JSON.parse(result.stderr).code));
 assert(await fs.stat(path.join(config.directory,record.archive)));
});
