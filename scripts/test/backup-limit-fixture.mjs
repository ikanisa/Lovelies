import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {createBackup} from '../lib/encrypted-backup.mjs';

const cli=fileURLToPath(new URL('../backup-database.mjs',import.meta.url));
const payload=Buffer.from('PGDMP\x01synthetic-archive-only');
const max=16*1024*1024;
async function scope(t) {
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'lovelies-inspection-limit-'));
 // Preserve this task-owned synthetic fixture, especially on timeout/failure.
 const catalog=path.join(root,'catalog'),tools=path.join(root,'tools');
 await fs.mkdir(catalog,{mode:0o700});await fs.mkdir(tools,{mode:0o700});
 return {root,catalog,tools,key:randomBytes(32)};
}
async function tool(config,kind,mode) {
 const executable=path.join(config.tools,kind+'-'+mode+'.mjs'),marker=path.join(config.tools,kind+'-'+mode+'.json');
 const lines=[
  '#!'+process.execPath,
  "import fs from 'node:fs';",
  'const kind='+JSON.stringify(kind)+';const mode='+JSON.stringify(mode)+';const marker='+JSON.stringify(marker)+';',
  "if(process.argv[2]==='--version'){process.stdout.write((kind==='dump'?'pg_dump':'pg_restore')+' (PostgreSQL) 17.11\\n');}",
  "else if(kind==='restore'&&process.argv[2]==='--list'){",
  " const input=fs.readFileSync(0);if(input.subarray(0,5).toString()!=='PGDMP')process.exit(8);",
  " if(mode==='timed'){process.on('SIGTERM',()=>{fs.writeFileSync(marker,JSON.stringify({signal:true}),{mode:0o600});process.exit(0);});await new Promise((ok,bad)=>process.stdout.write('; synthetic listing\\n',e=>e?bad(e):ok()));setTimeout(()=>process.exit(42),5000);}",
  " else {if(mode==='over')process.on('SIGTERM',()=>{});const chunk=mode==='ordinary'?Buffer.from('; synthetic listing\\n'):Buffer.alloc(65536,120);if(mode!=='ordinary')chunk[0]=10;",
  " const blocks=mode==='ordinary'?1:mode==='below'?255:mode==='exact'?256:257;",
  " for(let n=0;n<blocks;n++)await new Promise((ok,bad)=>process.stdout.write(chunk,e=>e?bad(e):ok()));",
  " fs.writeFileSync(marker,JSON.stringify({bytes:chunk.length*blocks}),{mode:0o600});process.stdout.end();}",
  "}",
  "else if(kind==='dump'&&process.argv.includes('--format=custom')&&mode==='timed'){",
  " process.on('SIGTERM',()=>{fs.writeFileSync(marker,JSON.stringify({signal:true}),{mode:0o600});process.exit(0);});",
  " await new Promise((ok,bad)=>process.stdout.write(Buffer.from([80,71,68,77,80,1,115,121,110]),e=>e?bad(e):ok()));setTimeout(()=>process.exit(42),5000);",
  "}",
  "else process.exitCode=3;"
 ];
 await fs.writeFile(executable,lines.join('\n')+'\n',{mode:0o700,flag:'wx'});
 return {executable,marker};
}
async function shortTimer(config) {
 const preload=path.join(config.tools,'short-timer.mjs');
 await fs.writeFile(preload,"const native=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...args)=>native(fn,ms===240000?500:ms,...args);\n",{mode:0o600,flag:'wx'});
 return preload;
}
function execute(config,cmd,args,{preload}={}) {
 const secret=config.key.toString('base64url');
 const env={PATH:process.env.PATH,LOVELIES_BACKUP_ENCRYPTION_KEY:secret,
  PGHOST:'127.0.0.1',PGDATABASE:'lovelies_test_fixture',PGUSER:'fixture',PGPORT:'5432'};
 const result=spawnSync(process.execPath,[...(preload?['--import',preload]:[]),cli,cmd,'--directory',config.catalog,...args,'--local-qualification'],
  {encoding:'utf8',env,timeout:30000,maxBuffer:1024*1024});
 assert.equal(result.error,undefined,result.error?.message);assert.equal(result.signal,null);
 assert(!result.stdout.includes(secret));assert(!result.stderr.includes(secret));return result;
}
async function createFixture(config) {
 return createBackup({directory:config.catalog,key:config.key,environment:'local-qualification',source:Readable.from([payload]),now:Date.now});
}
async function saved(config,record) {
 const name='lovelies-db-'+record.id+'.json',archive=path.join(config.catalog,record.archive),manifest=path.join(config.catalog,name);
 return {archive,manifest,archiveBytes:await fs.readFile(archive),manifestBytes:await fs.readFile(manifest)};
}
async function unchanged(snapshot) {
 assert.deepEqual(await fs.readFile(snapshot.archive),snapshot.archiveBytes);
 assert.deepEqual(await fs.readFile(snapshot.manifest),snapshot.manifestBytes);
}
function ok(result,status) {
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).status,status);
}
function limited(result,code) {
 assert.equal(result.status,1,result.stderr);assert.equal(result.stdout,'');assert.equal(JSON.parse(result.stderr).code,code);
}
export function registerSuite(candidate) {
 const name=candidate?'candidate':'baseline';
 for(const mode of ['ordinary','below','exact']) test(name+' health accepts '+mode+' listing',{timeout:45000},async t=>{
  const c=await scope(t),record=await createFixture(c),snapshot=await saved(c,record),fake=await tool(c,'restore',mode);
  const result=execute(c,'health',['--pg-restore',fake.executable,'--max-age-hours','24']);
  ok(result,'local_backup_artifact_verified');
  const evidence=JSON.parse(await fs.readFile(fake.marker,'utf8'));
  assert.equal(evidence.bytes,mode==='ordinary'?Buffer.byteLength('; synthetic listing\n'):mode==='below'?max-65536:max);
  await unchanged(snapshot);
 });
 for(const cmd of ['health','inspect']) test(name+' '+cmd+' handles over-limit zero-exit child',{timeout:45000},async t=>{
  const c=await scope(t),record=await createFixture(c),snapshot=await saved(c,record),fake=await tool(c,'restore','over');
  const args=cmd==='health'?['--pg-restore',fake.executable,'--max-age-hours','24']:['--pg-restore',fake.executable,'--id',record.id];
  const result=execute(c,cmd,args),evidence=JSON.parse(await fs.readFile(fake.marker,'utf8'));
  assert.equal(evidence.bytes,max+65536);
  if(candidate)limited(result,'backup_inspection_output_limit');else ok(result,cmd==='health'?'local_backup_artifact_verified':'archive_inspected');
  await unchanged(snapshot);
 });
 test(name+' health handles timed-out zero-exit restore child',{timeout:45000},async t=>{
  const c=await scope(t),record=await createFixture(c),snapshot=await saved(c,record),fake=await tool(c,'restore','timed'),preload=await shortTimer(c);
  const result=execute(c,'health',['--pg-restore',fake.executable,'--max-age-hours','24'],{preload});
  assert.equal(JSON.parse(await fs.readFile(fake.marker,'utf8')).signal,true);
  if(candidate)limited(result,'backup_process_timed_out');else ok(result,'local_backup_artifact_verified');
  await unchanged(snapshot);
 });
 test(name+' create handles timed-out zero-exit dump child',{timeout:45000},async t=>{
  const c=await scope(t),unknown=path.join(c.catalog,'unmanaged-preserve');await fs.writeFile(unknown,'preserve',{mode:0o600});
  const dump=await tool(c,'dump','timed'),restore=await tool(c,'restore','ordinary'),preload=await shortTimer(c);
  const result=execute(c,'create',['--pg-dump',dump.executable,'--pg-restore',restore.executable],{preload});
  assert.equal(JSON.parse(await fs.readFile(dump.marker,'utf8')).signal,true);
  assert.equal(await fs.readFile(unknown,'utf8'),'preserve');
  if(candidate){limited(result,'backup_process_timed_out');assert.deepEqual(await fs.readdir(c.catalog),['unmanaged-preserve']);}
  else {ok(result,'created_and_verified');const files=await fs.readdir(c.catalog);assert.equal(files.filter(x=>x.endsWith('.lvbk')).length,1);assert.equal(files.filter(x=>x.endsWith('.json')).length,1);}
 });
}
