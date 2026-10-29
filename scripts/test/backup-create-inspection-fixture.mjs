import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {verifyBackup,withVerifiedBackup} from '../lib/encrypted-backup.mjs';

const cli=fileURLToPath(new URL('../backup-database.mjs',import.meta.url));
const payload=Buffer.from('PGDMP\x01synthetic-archive-only');
const max=16*1024*1024;
async function scope(){
  const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'lovelies-inspection-limit-'));
  const catalog=path.join(root,'catalog'),tools=path.join(root,'tools');
  await fs.mkdir(catalog,{mode:0o700});await fs.mkdir(tools,{mode:0o700});
  return {root,catalog,tools,key:randomBytes(32)};
}
async function tool(config,kind){
  const mode=kind==='dump'?'success':'over';
  const executable=path.join(config.tools,kind+'-'+mode+'.mjs');
  const marker=path.join(config.tools,kind+'-'+mode+'.json');
  const lines=[
    '#!'+process.execPath,
    "import fs from 'node:fs';",
    'const kind='+JSON.stringify(kind)+';const marker='+JSON.stringify(marker)+';',
    'const expected=Buffer.from('+JSON.stringify([...payload])+');',
    "if(process.argv[2]==='--version'){process.stdout.write((kind==='dump'?'pg_dump':'pg_restore')+' (PostgreSQL) 17.11\\n');}",
    "else if(kind==='dump'&&process.argv.includes('--format=custom')){fs.writeFileSync(marker,JSON.stringify({bytes:expected.length}),{mode:0o600});process.stdout.end(expected);}",
    "else if(kind==='restore'&&process.argv[2]==='--list'){",
    " const input=fs.readFileSync(0);if(!input.equals(expected))process.exit(8);",
    " process.on('SIGTERM',()=>{});const chunk=Buffer.alloc(65536,120);chunk[0]=10;",
    " for(let n=0;n<257;n++)await new Promise((ok,bad)=>process.stdout.write(chunk,e=>e?bad(e):ok()));",
    " fs.writeFileSync(marker,JSON.stringify({bytes:chunk.length*257}),{mode:0o600});process.stdout.end();",
    "}else process.exitCode=3;"
  ];
  await fs.writeFile(executable,lines.join('\n')+'\n',{mode:0o700,flag:'wx'});
  return {executable,marker};
}
function run(config,dump,restore){
  const secret=config.key.toString('base64url');
  const env={PATH:process.env.PATH,LOVELIES_BACKUP_ENCRYPTION_KEY:secret,
    PGHOST:'127.0.0.1',PGDATABASE:'lovelies_test_fixture',PGUSER:'fixture',PGPORT:'5432'};
  const result=spawnSync(process.execPath,[cli,'create','--directory',config.catalog,
    '--pg-dump',dump.executable,'--pg-restore',restore.executable,'--local-qualification'],
    {encoding:'utf8',env,timeout:30000,maxBuffer:1024*1024});
  assert.equal(result.error,undefined,result.error?.message);assert.equal(result.signal,null);
  assert(!result.stdout.includes(secret));assert(!result.stderr.includes(secret));return result;
}
export function registerCreateInspectionCase(candidate){
  const name=(candidate?'candidate':'baseline')+' create handles successful dump with over-limit zero-exit inspection';
  test(name,{timeout:45000},async()=>{
    const c=await scope();
    const sentinel=path.join(c.catalog,'unmanaged-preserve');
    await fs.writeFile(sentinel,'preserve',{mode:0o600,flag:'wx'});
    const dump=await tool(c,'dump'),restore=await tool(c,'restore');
    const result=run(c,dump,restore);
    assert.equal(JSON.parse(await fs.readFile(dump.marker,'utf8')).bytes,payload.length);
    assert.equal(JSON.parse(await fs.readFile(restore.marker,'utf8')).bytes,max+65536);
    if(candidate){
      assert.equal(result.status,1,result.stderr);assert.equal(result.stdout,'');
      assert.equal(JSON.parse(result.stderr).code,'backup_inspection_output_limit');
    }else{
      assert.equal(result.status,0,result.stderr);
      assert.equal(JSON.parse(result.stdout).status,'created_and_verified');
    }
    const entries=await fs.readdir(c.catalog);
    const manifests=entries.filter(x=>/^lovelies-db-[0-9a-f-]+\.json$/.test(x));
    assert.equal(manifests.length,1);
    const id=manifests[0].slice('lovelies-db-'.length,-'.json'.length);
    const config={directory:c.catalog,id,key:c.key,environment:'local-qualification'};
    const metadata=await verifyBackup(config);
    assert.equal(metadata.id,id);assert.equal(metadata.plaintext_bytes,payload.length);
    assert.equal(metadata.plaintext_sha256,createHash('sha256').update(payload).digest('hex'));
    assert.deepEqual(entries.sort(),[metadata.archive,manifests[0],'unmanaged-preserve'].sort());
    const archive=path.join(c.catalog,metadata.archive),manifest=path.join(c.catalog,manifests[0]);
    const archiveBefore=await fs.readFile(archive),manifestBefore=await fs.readFile(manifest);
    const recovered=await withVerifiedBackup(config,async stream=>{
      const chunks=[];for await(const chunk of stream)chunks.push(chunk);return Buffer.concat(chunks);
    });
    assert.deepEqual(recovered,payload);
    assert.deepEqual(await fs.readFile(archive),archiveBefore);
    assert.deepEqual(await fs.readFile(manifest),manifestBefore);
    assert.equal(await fs.readFile(sentinel,'utf8'),'preserve');
    assert.deepEqual((await fs.readdir(c.catalog)).sort(),entries.sort());
  });
}
