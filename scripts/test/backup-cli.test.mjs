import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

const cli=fileURLToPath(new URL('../backup-database.mjs',import.meta.url));
test('CLI denies wrong production and local targets before database access without exposing credentials',async t=>{
  const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'lovelies-backup-cli-'));await fs.chmod(root,0o700);t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const marker=path.join(root,'database-access-attempted');
  for(const name of ['pg_dump','pg_restore']){
    const code=`#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';if(process.argv[2]==='--version')console.log(path.basename(process.argv[1])+' (PostgreSQL) 17.6');else{fs.writeFileSync(${JSON.stringify(marker)},'unexpected database access');process.exit(99);}\n`;
    await fs.writeFile(path.join(root,name),code,{mode:0o700});
  }
  const password='PRIVATE_TEST_PASSWORD_'+randomBytes(16).toString('hex'),key=randomBytes(32).toString('base64url');
  const cases=[
    {name:'other_project',host:'db.otherproject.supabase.co',database:'postgres',local:false,code:'backup_project_target_invalid'},
    {name:'implicit_local',host:'127.0.0.1',database:'lovelies_test_abc',local:false,code:'backup_project_target_invalid'},
    {name:'local_shared_database',host:'127.0.0.1',database:'postgres',local:true,code:'backup_local_target_invalid'},
  ];
  for(const item of cases){
    const directory=path.join(root,item.name);await fs.mkdir(directory,{mode:0o700});
    const args=[cli,'create','--directory',directory,'--pg-dump',path.join(root,'pg_dump'),'--pg-restore',path.join(root,'pg_restore'),...(item.local?['--local-qualification']:[])];
    const result=spawnSync(process.execPath,args,{encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH,PGHOST:item.host,PGDATABASE:item.database,PGUSER:'postgres',PGPORT:'5432',PGPASSWORD:password,PGSSLROOTCERT:'/never-read/ca.pem',LOVELIES_BACKUP_ENCRYPTION_KEY:key}});
    assert.equal(result.status,1,item.name);assert.equal(JSON.parse(result.stderr).code,item.code);assert(!result.stderr.includes(password)&&!result.stderr.includes(key));assert.equal(result.stdout,'');assert.deepEqual(await fs.readdir(directory),[]);
  }
  await assert.rejects(fs.stat(marker),{code:'ENOENT'});
});
test('CLI arguments cannot inject producer options or turn inspection into a restore',()=>{
  for(const args of [['restore','--directory','/not-used'],['create','--directory','/not-used','--pg-dump','--clean'],['create','--directory','/not-used','--directory','/another'],['expire','--directory','/not-used','--id','ignored-id'],['verify','--directory','/not-used']]){
    const result=spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH}});
    assert.equal(result.status,1);assert.equal(JSON.parse(result.stderr).code,'backup_arguments_invalid');assert.equal(result.stdout,'');
  }
});
