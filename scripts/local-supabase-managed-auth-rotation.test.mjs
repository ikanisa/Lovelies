import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {RestoreDatabaseFence} from '../services/supabase-api/src/restore-database.ts';
import {RestoreJournalClient,RESTORE_PROJECT_ID} from '../services/supabase-api/src/restore-journal.ts';
import {managedAuthSchemaStatements} from '../services/supabase-api/src/managed-auth.ts';
import {handleOperationRequest} from '../services/restore-journal/src/operations.mjs';
import {MemoryStorage,env,event} from '../services/restore-journal/test/fixtures.mjs';
import {ROTATION_PROTOCOL,ROTATION_ABORT_PROTOCOL,canonical,digest,mutationIntent,rotationKeys,keyFingerprint,encryptCredential,decryptCredential,inspectDatabase,rotateDatabase,verifyDatabase,applyOrVerifyDatabase,abortDatabase,abortOrVerifyDatabase,verifyAbortedDatabase,sealEscrow,openEscrow,sealIntent,openIntent} from './local-supabase-managed-auth-rotation-core.mjs';
import {compareAndSwapFile,writeImmutable,readImmutable,readLifecycle,lifecycle} from './local-supabase-lifecycle.mjs';
import {lifecycleRequestAllowed} from '../deploy/local-supabase/functions-main/lifecycle-gate.mjs';
import {generateConfiguration} from './local-supabase-configure.mjs';
import {validateRotationInputs,ensureRotationDirectory} from './local-supabase-rotate-managed-auth.mjs';

const {PGlite}=createRequire(new URL('../services/restore-journal/package.json',import.meta.url))('@electric-sql/pglite');
let sharedEngine;
test.after(async()=>{await sharedEngine?.close();});
const oldKey=randomBytes(32),newKey=randomBytes(32);
const row=(state='bound')=>({id:randomUUID(),account_id:randomUUID(),local_session_id:state==='bound'?randomUUID():null,predecessor_session_id:null,
 incarnation_id:randomUUID(),operation:'signup',state,creation_marker:digest(randomBytes(32)),auth_user_id:randomUUID(),auth_session_id:randomUUID(),
 ciphertext:null,iv:null,tokens_expires_at:1,created_at:1,updated_at:2,retire_after:3,logout_verified_at:null,user_deleted_at:null,failure_code:null,reconcile_page:1});
const tokens=value=>({access_token:'synthetic-access-'+randomUUID(),refresh_token:'synthetic-refresh-'+randomUUID(),user_id:value.auth_user_id,session_id:value.auth_session_id,expires_at:value.tokens_expires_at});
const encrypted=(state='bound',key=oldKey)=>{const value=row(state);return {...value,...encryptCredential(tokens(value),value,key)};};
const toNumbers=rows=>rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,typeof value==='bigint'?Number(value):value])));

async function fixture(t,rows=[encrypted(),encrypted('retiring'),encrypted('prepared'),{...row('retired'),ciphertext:null,iv:null}]){
 // These cases run serially. Reuse one WASM engine and reset real schemas/roles
 // instead of retaining multiple PostgreSQL WASM heaps until a later GC cycle.
 const engine=sharedEngine??(sharedEngine=new PGlite()),trace=[],storage=new MemoryStorage(),faults={};
 await engine.exec(`SET SESSION AUTHORIZATION postgres;
  DROP SCHEMA IF EXISTS lovelies_private CASCADE;DROP SCHEMA IF EXISTS lovelies_deployment CASCADE;
  DROP ROLE IF EXISTS lovelies_rotation;DROP ROLE IF EXISTS lovelies_runtime;DROP ROLE IF EXISTS lovelies_api;
  DROP ROLE IF EXISTS anon;DROP ROLE IF EXISTS authenticated;DROP ROLE IF EXISTS service_role;`);
 await engine.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
  CREATE ROLE lovelies_api NOLOGIN;CREATE ROLE lovelies_runtime LOGIN NOINHERIT;CREATE ROLE lovelies_rotation LOGIN NOINHERIT;
  GRANT lovelies_api TO lovelies_rotation WITH INHERIT FALSE;
  CREATE SCHEMA lovelies_private;GRANT USAGE ON SCHEMA lovelies_private TO lovelies_api;
  SET search_path TO lovelies_private,pg_catalog;
  ${managedAuthSchemaStatements.map(sql=>sql.replaceAll(' INTEGER',' BIGINT')+';').join('\n')}
  ALTER TABLE managed_auth_bindings ENABLE ROW LEVEL SECURITY;ALTER TABLE managed_auth_bindings FORCE ROW LEVEL SECURITY;
  CREATE POLICY backend_only ON managed_auth_bindings TO lovelies_api USING(true) WITH CHECK(true);
  CREATE TABLE restore_control(singleton integer PRIMARY KEY,project_id text,database_id text,incarnation_id text,
   checkpoint_revision bigint,checkpoint_hash text,journal_sequence bigint,journal_hash text,last_operation_id text,last_plan_hash text);
  CREATE TABLE restore_recovered_operations(operation_id text PRIMARY KEY,input_hash text,plan_hash text,outcome text,recovered_at bigint);
  GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA lovelies_private TO lovelies_api;`);
 await engine.exec(await fs.readFile(new URL('../deploy/local-supabase/managed-auth-key-rotation.sql',import.meta.url),'utf8'));
 for(const value of rows){const fields=Object.keys(value);await engine.query('INSERT INTO lovelies_private.managed_auth_bindings('+fields.join(',')+') VALUES('+fields.map((_,i)=>'$'+(i+1)).join(',')+')',Object.values(value));}
 const response=await handleOperationRequest(new Request('https://journal.invalid/v1/control/bootstrap',{method:'POST',headers:{authorization:'Bearer '+env.RESTORE_JOURNAL_TOKEN,'content-type':'application/json'},body:JSON.stringify({version:1,project_id:RESTORE_PROJECT_ID,database_id:randomUUID(),bootstrap_id:randomUUID()})}),env,storage);
 assert.equal(response.status,200);const marker=(await response.json()).binding.initial_marker;
 await engine.query('INSERT INTO lovelies_private.restore_control VALUES(1,$1,$2,$3,$4,$5,$6,$7,NULL,NULL)',[RESTORE_PROJECT_ID,marker.database_id,marker.incarnation_id,marker.checkpoint.revision,marker.checkpoint.hash,marker.cursor.sequence,marker.cursor.hash]);
 const journal=new RestoreJournalClient('https://journal.invalid',env.RESTORE_JOURNAL_TOKEN,{fetcher:async(url,init)=>{
  const request=new Request(url,init),pathname=new URL(request.url).pathname;trace.push({kind:'journal',pathname});
  const response=await handleOperationRequest(request,env,storage);
  if(faults.lostJournal===pathname){delete faults.lostJournal;await response.body?.cancel();throw Error('synthetic_journal_reply_lost');}return response;
 }});
 await engine.exec('SET SESSION AUTHORIZATION lovelies_rotation');
 const query=async(sql,values=[])=>{trace.push({kind:'sql',sql});if(sql.startsWith('SELECT pg_advisory_xact_lock('))return [];return toNumbers((await engine.query(sql,values)).rows);};
 const connection={query,begin:async callback=>{await engine.exec('BEGIN');let committed=false;try{
  const value=await callback({query});if(faults.beforeCommit){delete faults.beforeCommit;throw Error('synthetic_commit_rejected');}
  await engine.exec('COMMIT');committed=true;
  if(faults.commitReply){delete faults.commitReply;throw Error('synthetic_commit_reply_lost');}return value;
 }catch(error){if(!committed)await engine.exec('ROLLBACK');throw error;}}};
 const ports={connection,journal,fence:new RestoreDatabaseFence(journal)};
 const administrator=async callback=>{await engine.exec('SET SESSION AUTHORIZATION postgres');try{return await callback(engine);}finally{await engine.exec('SET SESSION AUTHORIZATION lovelies_rotation');}};
 const intent=async()=>({protocol:ROTATION_PROTOCOL,rotation_id:randomUUID(),created_at:Date.now(),expected_marker:marker,pre_state:await inspectDatabase(ports,marker,oldKey),escrow_sha256:'a'.repeat(64),api_before_sha256:'b'.repeat(64),api_after_sha256:'c'.repeat(64)});
 const all=()=>administrator(async db=>(await db.query('SELECT to_jsonb(m) AS value FROM lovelies_private.managed_auth_bindings m ORDER BY id COLLATE "C"')).rows.map(row=>row.value));
 return {ports,engine,marker,intent,all,administrator,trace,faults};
}

test('AES-GCM re-encryption preserves exact backend AAD/token binding, expired and retiring credentials',async()=>{
 for(const state of ['bound','prepared','superseded','ambiguous','retiring']){
  const value=encrypted(state),plain=decryptCredential(value,oldKey),next={...value,...encryptCredential(plain,value,newKey)};
  assert.deepEqual(decryptCredential(next,newKey),plain);assert.throws(()=>decryptCredential(next,oldKey));
  for(const field of ['id','account_id','incarnation_id','auth_user_id','auth_session_id'])assert.throws(()=>decryptCredential({...next,[field]:randomUUID()},newKey));
  assert.throws(()=>decryptCredential({...next,tokens_expires_at:2},newKey));
  const extra={...value,...encryptCredential({...plain,extra:'forbidden'},value,oldKey)};assert.throws(()=>decryptCredential(extra,oldKey));
  const key=await crypto.subtle.importKey('raw',newKey,'AES-GCM',false,['decrypt']);
  const aad=Buffer.from(canonical({protocol:'lovelies-managed-auth-custody-v1',id:value.id,account_id:value.account_id,incarnation_id:value.incarnation_id,auth_user_id:value.auth_user_id,auth_session_id:value.auth_session_id}));
  const independent=await crypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(next.iv,'base64url'),additionalData:aad},key,Buffer.from(next.ciphertext,'base64url'));
  assert.deepEqual(JSON.parse(Buffer.from(independent)),plain);
 }
 assert.throws(()=>rotationKeys(oldKey.toString('base64'),oldKey.toString('base64url')));
 assert.throws(()=>rotationKeys(oldKey.toString('base64'),newKey.toString('base64'),[newKey.toString('base64url')]));
});
test('all rows rotate in one fenced commit and immutable receipt while state/authority columns remain identical',async t=>{
 const f=await fixture(t),intent=await f.intent(),before=await f.all(),receipt=await rotateDatabase(f.ports,intent,oldKey,newKey),after=await f.all();
 assert.equal(receipt.post_state.row_count,4);assert.equal(receipt.post_state.encrypted_rows,3);
 assert.equal((await f.ports.journal.lookup(intent.rotation_id)).status,'committed');
 for(let i=0;i<before.length;i++){
  const {ciphertext,iv,...metadata}=before[i],{ciphertext:next,iv:nextIV,...nextMetadata}=after[i];assert.deepEqual(nextMetadata,metadata);
  if(ciphertext){assert.notEqual(ciphertext,next);assert.notEqual(iv,nextIV);assert.deepEqual(decryptCredential(before[i],oldKey),decryptCredential(after[i],newKey));}
 }
 assert.deepEqual(await verifyDatabase(f.ports,intent,newKey),receipt);
 assert(!f.trace.some(item=>item.kind==='sql'&&/\bauth\./i.test(item.sql)));
 const grant=await f.administrator(async db=>(await db.query("SELECT has_table_privilege('lovelies_api','lovelies_deployment.managed_auth_key_rotations','SELECT,INSERT,UPDATE,DELETE') AS app,has_table_privilege('lovelies_rotation','lovelies_deployment.managed_auth_key_rotations','UPDATE,DELETE,TRUNCATE') AS mutates")).rows[0]);
 assert.deepEqual(grant,{app:false,mutates:false});
});
test('failure before prepare rolls back every ciphertext and permits only the exact unchanged intent',async t=>{
 const f=await fixture(t),intent=await f.intent(),before=await f.all();
 await assert.rejects(()=>rotateDatabase(f.ports,intent,oldKey,newKey,{afterRewrite:()=>{throw Error('synthetic_pre_prepare_crash');}}));
 assert.deepEqual(await f.all(),before);assert.equal(await f.ports.journal.lookup(intent.rotation_id),null);
 await rotateDatabase(f.ports,intent,oldKey,newKey);
});
test('accepted prepare plus rejected SQL commit remains terminal after ordinary recovery and cannot reuse the ID',async t=>{
 const f=await fixture(t),intent=await f.intent(),before=await f.all();f.faults.beforeCommit=true;
 await assert.rejects(()=>rotateDatabase(f.ports,intent,oldKey,newKey));assert.deepEqual(await f.all(),before);
 assert.equal((await f.ports.journal.lookup(intent.rotation_id)).status,'pending');
 await assert.rejects(()=>rotateDatabase(f.ports,intent,oldKey,newKey),/requires_reconciliation/);
 await f.ports.connection.begin(async c=>{await c.query('SET LOCAL ROLE lovelies_api');await c.query('SET LOCAL search_path TO lovelies_private,pg_catalog');await f.ports.fence.reconcile(c);});
 await f.ports.connection.begin(async c=>{await c.query('SET LOCAL ROLE lovelies_api');await c.query('SET LOCAL search_path TO lovelies_private,pg_catalog');await f.ports.fence.enter(c);});
 assert.equal((await f.ports.journal.lookup(intent.rotation_id)).status,'recovered');
 await assert.rejects(()=>rotateDatabase(f.ports,intent,oldKey,newKey),error=>error.status===410);
 assert.deepEqual(await f.all(),before);
});
test('lost actual SQL COMMIT reply is resolved by receipt + all new-key rows before independent acknowledgement',async t=>{
 const f=await fixture(t),intent=await f.intent();f.faults.commitReply=true;
 // Arm only after the preflight inspection has completed.
 await assert.rejects(()=>rotateDatabase(f.ports,intent,oldKey,newKey),/commit_reply_lost/);
 assert.equal((await f.ports.journal.lookup(intent.rotation_id)).status,'pending');
 await assert.rejects(()=>verifyDatabase(f.ports,intent,oldKey));
 assert.equal((await f.ports.journal.lookup(intent.rotation_id)).status,'pending');
 const receipt=await verifyDatabase(f.ports,intent,newKey);assert.equal(receipt.post_state.encrypted_rows,3);
 assert.equal((await f.ports.journal.lookup(intent.rotation_id)).status,'committed');
});
test('lost journal acknowledgement is verified without replaying the ciphertext rewrite',async t=>{
 const f=await fixture(t),intent=await f.intent();f.faults.lostJournal='/v1/operations/'+intent.rotation_id+'/acknowledge';
 await assert.rejects(()=>rotateDatabase(f.ports,intent,oldKey,newKey));const after=await f.all();
 await verifyDatabase(f.ports,intent,newKey);assert.deepEqual(await f.all(),after);
});
test('mixed, corrupt and unexpected new-key input fail atomically even beyond the first page',async t=>{
 for(const variant of ['mixed','corrupt','new']){
  await t.test(variant,async t=>{
   const values=Array.from({length:130},()=>encrypted('retiring')).sort((a,b)=>a.id.localeCompare(b.id)),f=await fixture(t,values),intent=await f.intent();
   await f.administrator(async db=>{
    const selected=values.at(-1),change=variant==='corrupt'?{ciphertext:'invalid'}:encryptCredential(decryptCredential(selected,oldKey),selected,newKey);
    await db.query('UPDATE lovelies_private.managed_auth_bindings SET ciphertext=$1'+(change.iv?',iv=$3':'')+' WHERE id=$2',[change.ciphertext,selected.id,...(change.iv?[change.iv]:[])]);
    if(variant==='new')for(const value of values.slice(0,-1)){const change=encryptCredential(decryptCredential(value,oldKey),value,newKey);await db.query('UPDATE lovelies_private.managed_auth_bindings SET ciphertext=$1,iv=$2 WHERE id=$3',[change.ciphertext,change.iv,value.id]);}
   });
   const before=await f.all();await assert.rejects(()=>rotateDatabase(f.ports,intent,oldKey,newKey));assert.deepEqual(await f.all(),before);assert.equal(await f.ports.journal.lookup(intent.rotation_id),null);
  });
 }
});
test('metadata drift and corrupt post-commit credentials cannot authorize a configuration switch',async t=>{
 const f=await fixture(t),intent=await f.intent();
 await assert.rejects(()=>rotateDatabase(f.ports,intent,oldKey,newKey,{afterCommit:()=>{throw Error('synthetic_process_exit');}}));
 const row=(await f.all()).find(value=>value.ciphertext);
 await f.administrator(db=>db.query('UPDATE lovelies_private.managed_auth_bindings SET failure_code=$1 WHERE id=$2',['unexpected-change',row.id]));
 await assert.rejects(()=>verifyDatabase(f.ports,intent,newKey),/post_state_changed/);
 assert.equal((await f.ports.journal.lookup(intent.rotation_id)).status,'pending');
 await f.administrator(db=>db.query('UPDATE lovelies_private.managed_auth_bindings SET ciphertext=$1 WHERE id=$2',['corrupt',row.id]));
 await assert.rejects(()=>verifyDatabase(f.ports,intent,newKey));assert.equal((await f.ports.journal.lookup(intent.rotation_id)).status,'pending');
});
test('empty custody still needs an atomic receipt and exact journal marker',async t=>{
 const f=await fixture(t,[]),intent=await f.intent();await assert.rejects(()=>verifyDatabase(f.ports,intent,newKey),/receipt_unconfirmed/);
 const receipt=await rotateDatabase(f.ports,intent,oldKey,newKey);assert.deepEqual(receipt.post_state,intent.pre_state);
 assert.notDeepEqual(receipt.expected_marker,receipt.next_marker);assert.equal((await f.ports.journal.lookup(intent.rotation_id)).status,'committed');
});
test('unsafe BIGINT metadata is rejected for encrypted and empty custody rows before hashing',async t=>{
 const f=await fixture(t),values=await f.all();
 for(const value of [values.find(row=>row.ciphertext),values.find(row=>!row.ciphertext)]){
  await f.administrator(db=>db.query('UPDATE lovelies_private.managed_auth_bindings SET created_at=9007199254740993 WHERE id=$1',[value.id]));
  await assert.rejects(()=>f.intent(),/inventory_integer_invalid/);
  await f.administrator(db=>db.query('UPDATE lovelies_private.managed_auth_bindings SET created_at=$1 WHERE id=$2',[value.created_at,value.id]));
 }
});
test('explicit abort atomically retains all old credentials and durably retires only the accepted empty rotation',async t=>{
 const f=await fixture(t),intent=await f.intent(),before=await f.all();f.faults.beforeCommit=true;
 await assert.rejects(()=>rotateDatabase(f.ports,intent,oldKey,newKey));
 await assert.rejects(()=>abortDatabase(f.ports,intent,oldKey,{afterCommit:()=>{throw Error('synthetic_abort_commit_reply_lost');}}));
 assert.equal((await f.ports.journal.lookup(intent.rotation_id)).status,'pending');assert.deepEqual(await f.all(),before);
 const receipt=await verifyAbortedDatabase(f.ports,intent,oldKey);assert.equal(receipt.protocol,ROTATION_ABORT_PROTOCOL);
 assert.equal((await f.ports.journal.lookup(intent.rotation_id)).status,'recovered');assert.deepEqual(receipt.post_state,intent.pre_state);
 assert.deepEqual(await abortOrVerifyDatabase(f.ports,intent,oldKey),receipt);
 await assert.rejects(()=>applyOrVerifyDatabase(f.ports,intent,oldKey,newKey),error=>error.status===410);
 await assert.rejects(()=>verifyDatabase(f.ports,intent,newKey));assert.deepEqual(await f.all(),before);
});
test('abort refuses positive commits, nonempty restriction plans, changed old rows and lost pre-commit negative work',async t=>{
 await t.test('positive receipt cannot become an abort',async t=>{
  const f=await fixture(t),intent=await f.intent();await rotateDatabase(f.ports,intent,oldKey,newKey);const after=await f.all();
  await assert.rejects(()=>abortOrVerifyDatabase(f.ports,intent,oldKey),/positive_receipt/);assert.deepEqual(await f.all(),after);
 });
 await t.test('foreign restrictions stay blocked for controlled recovery',async t=>{
  const f=await fixture(t),intent=await f.intent();await f.ports.journal.prepare({version:1,project_id:RESTORE_PROJECT_ID,...mutationIntent(intent),expected:intent.expected_marker,events:[event()]});
  await assert.rejects(()=>abortDatabase(f.ports,intent,oldKey),/abort_plan_invalid/);assert.equal((await f.ports.journal.lookup(intent.rotation_id)).status,'pending');
 });
 await t.test('negative SQL rollback never clears or changes the original credentials',async t=>{
  const f=await fixture(t),intent=await f.intent(),before=await f.all();f.faults.beforeCommit=true;await assert.rejects(()=>rotateDatabase(f.ports,intent,oldKey,newKey));
  await assert.rejects(()=>abortDatabase(f.ports,intent,oldKey,{afterReconcile:()=>{throw Error('synthetic_abort_before_commit');}}));
  assert.deepEqual(await f.all(),before);assert.equal((await f.ports.journal.lookup(intent.rotation_id)).status,'pending');
  await f.administrator(db=>db.query('UPDATE lovelies_private.managed_auth_bindings SET updated_at=updated_at+1 WHERE id=$1',[before[0].id]));
  await assert.rejects(()=>abortDatabase(f.ports,intent,oldKey),/old_state_changed/);assert.equal((await f.ports.journal.lookup(intent.rotation_id)).status,'pending');
 });
});
test('encrypted escrow and immutable intent reject substitution without exposing tokens or keys',()=>{
 const master=randomBytes(32),id=randomUUID(),secret='synthetic-private-token';
 const value={rotation_id:id,old_key:oldKey.toString('base64'),new_key:newKey.toString('base64'),secret},sealed=sealEscrow(value,master);
 assert.deepEqual(openEscrow(sealed,master),value);assert(!JSON.stringify(sealed).includes(secret));assert(!JSON.stringify(sealed).includes(value.old_key));
 assert.throws(()=>openEscrow(sealed,randomBytes(32)));assert.throws(()=>openEscrow({...sealed,header:{...sealed.header,rotation_id:randomUUID()}},master));
 const intent={protocol:ROTATION_PROTOCOL,rotation_id:id,created_at:1,expected_marker:{database_id:randomUUID(),incarnation_id:randomUUID(),checkpoint:{revision:0,hash:'f'.repeat(64)},cursor:{sequence:0,hash:'0'.repeat(64)}},pre_state:{row_count:0,encrypted_rows:0,rows_sha256:digest('[]')},escrow_sha256:'a'.repeat(64),api_before_sha256:'b'.repeat(64),api_after_sha256:'c'.repeat(64)};
 const signed=sealIntent(intent,master);assert.deepEqual(openIntent(signed,master),intent);assert.throws(()=>openIntent({...signed,intent:{...intent,api_after_sha256:'d'.repeat(64)}},master));
});
test('lost atomic configuration-write acknowledgement recognizes only exact old/new bytes and rejects symlinks',async t=>{
 const directory=await fs.mkdtemp('/tmp/lovelies-key-rotation-');t.after(()=>fs.rm(directory,{recursive:true,force:true}));const file=path.join(directory,'api.env');
 await writeImmutable(file,'old synthetic configuration\n');
 await assert.rejects(()=>compareAndSwapFile(file,digest('old synthetic configuration\n'),'new synthetic configuration\n',{afterRename:()=>{throw Error('synthetic_rename_reply_lost');}}));
 assert.equal(await compareAndSwapFile(file,digest('old synthetic configuration\n'),'new synthetic configuration\n'),'already_applied');
 await fs.writeFile(file,'unknown operator edit\n');await assert.rejects(()=>compareAndSwapFile(file,digest('old synthetic configuration\n'),'new synthetic configuration\n'));
 assert.equal(await fs.readFile(file,'utf8'),'unknown operator edit\n');
 await fs.symlink(file,path.join(directory,'symlink'));await assert.rejects(()=>compareAndSwapFile(path.join(directory,'symlink'),digest('unknown operator edit\n'),'replaced\n'));
});
test('real process exits cannot publish partial immutable records or skip a pending configuration directory sync',async t=>{
 const directory=await fs.mkdtemp('/tmp/lovelies-publication-crash-');t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const module=new URL('./local-supabase-lifecycle.mjs',import.meta.url).href,payload='complete synthetic immutable receipt\n';
 const child=source=>spawnSync(process.execPath,['--input-type=module','-e','const api=await import('+JSON.stringify(module)+');'+source],{encoding:'utf8'});
 const staged=path.join(directory,'staged.json');
 assert.equal(child('await api.writeImmutable('+JSON.stringify(staged)+','+JSON.stringify(payload)+',{afterStaging(){process.exit(73)}});').status,73);
 await assert.rejects(()=>fs.stat(staged),error=>error.code==='ENOENT');
 await writeImmutable(staged,payload);assert.equal((await readImmutable(staged)).toString(),payload);
 const published=path.join(directory,'published.json');
 assert.equal(child('await api.writeImmutable('+JSON.stringify(published)+','+JSON.stringify(payload)+',{afterPublication(){process.exit(74)}});').status,74);
 assert.equal((await fs.stat(published)).nlink,2);assert.equal((await readImmutable(published)).toString(),payload);assert.equal((await fs.stat(published)).nlink,1);
 await assert.rejects(()=>writeImmutable(published,'unexpected replacement'));assert.equal((await readImmutable(published)).toString(),payload);
 const config=path.join(directory,'api.env');await writeImmutable(config,'before\n');
 assert.equal(child('await api.compareAndSwapFile('+JSON.stringify(config)+','+JSON.stringify(digest('before\n'))+',"after\\n",{afterRenameBeforeSync(){process.exit(75)}});').status,75);
 assert.equal(await compareAndSwapFile(config,digest('before\n'),'after\n'),'already_applied');assert.equal(await fs.readFile(config,'utf8'),'after\n');
 await fs.link(published,path.join(directory,'unknown-link'));await assert.rejects(()=>readImmutable(published),/publication_unknown/);
});
test('rotation refuses any different effective API database, principal, credential, TLS profile or inherited override',()=>{
 const fixture=()=>generateConfiguration({host:'api.example.test',email:'operator@example.test',runtimeDirectory:'/tmp/rotation-profile',publicSiteRoot:'/tmp/rotation-stage/public'});
 validateRotationInputs(fixture());
 for(const mutate of [
  r=>{r.api.LOVELIES_DATABASE_URL=r.api.LOVELIES_DATABASE_URL.replace('@db:', '@other-db:');},
  r=>{r.api.LOVELIES_DATABASE_URL=r.api.LOVELIES_DATABASE_URL.replace('/postgres','/other');},
  r=>{r.api.LOVELIES_DATABASE_URL=r.api.LOVELIES_DATABASE_URL.replace('lovelies_runtime','postgres');},
  r=>{r.app.LOVELIES_API_DATABASE_PASSWORD='d'.repeat(64);},
  r=>{r.api.LOVELIES_DATABASE_TLS_MODE='verify-full';},
  r=>{r.api.SUPABASE_DB_URL='postgres://lovelies_runtime:wrong@other-db:5432/postgres';},
 ]){const r=fixture();mutate(r);assert.throws(()=>validateRotationInputs(r));}
});
test('same-ID retry finishes rotation-directory publication after a process exits immediately after mkdir',async t=>{
 const directory=await fs.mkdtemp('/tmp/lovelies-rotation-directory-');t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 await fs.mkdir(path.join(directory,'managed-auth-rotations'),{mode:0o700});const id=randomUUID();
 const source='const api=await import('+JSON.stringify(new URL('./local-supabase-rotate-managed-auth.mjs',import.meta.url).href)+');await api.ensureRotationDirectory('+JSON.stringify({directory})+','+JSON.stringify(id)+',{afterMkdir(){process.exit(76)}});';
 assert.equal(spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8'}).status,76);
 const actual=await ensureRotationDirectory({directory},id);assert.equal(actual,path.join(directory,'managed-auth-rotations',id));
 await writeImmutable(path.join(actual,'intent.json'),'synthetic intent\n');assert.equal((await readImmutable(path.join(actual,'intent.json'))).toString(),'synthetic intent\n');
});
test('persistent gate rejects missing/malformed state and allows only exact GET readiness with the configured new key',async t=>{
 const directory=await fs.mkdtemp('/tmp/lovelies-lifecycle-');t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 await fs.mkdir(path.join(directory,'lifecycle'));await assert.rejects(()=>readLifecycle(directory));
 const id=randomUUID(),next=newKey.toString('base64'),gate=lifecycle('verification_only',id,next);
 for(const method of ['POST','HEAD','PUT'])assert.equal(lifecycleRequestAllowed(gate,method,'/lovelies-api/health',keyFingerprint(next)),false);
 for(const route of ['/lovelies-api/health/extra','/lovelies-api/ready/','/lovelies-api/_internal/maintenance','/lovelies-api/auth/anonymous'])assert.equal(lifecycleRequestAllowed(gate,'GET',route,keyFingerprint(next)),false);
 for(const route of ['/lovelies-api/health','/lovelies-api/ready'])assert.equal(lifecycleRequestAllowed(gate,'GET',route,keyFingerprint(next)),true);
 assert.equal(lifecycleRequestAllowed(gate,'GET','/lovelies-api/health',keyFingerprint(oldKey.toString('base64'))),false);
 assert.equal(lifecycleRequestAllowed({...gate,state:'blocked'},'GET','/lovelies-api/health',keyFingerprint(next)),false);
 await fs.writeFile(path.join(directory,'lifecycle/gate.json'),'{"state":"open"}');await assert.rejects(()=>readLifecycle(directory));
 await fs.writeFile(path.join(directory,'lifecycle/gate.json'),JSON.stringify(gate));assert.deepEqual(await readLifecycle(directory),gate);
 await fs.rename(path.join(directory,'lifecycle/gate.json'),path.join(directory,'lifecycle/other.json'));await fs.symlink('other.json',path.join(directory,'lifecycle/gate.json'));await assert.rejects(()=>readLifecycle(directory));
});
