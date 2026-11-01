import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {createHash,randomUUID} from 'node:crypto';
const folder=new URL('../../../supabase/migrations/',import.meta.url),name='20261029140000_chunked_privacy_exports.sql',source=fs.readFileSync(new URL(name,folder),'utf8');
const rows=async(engine,sql,values=[])=>(await engine.query(sql,values)).rows;
const backend=async(engine,fn)=>{await engine.exec('SET ROLE lovelies_api');try{return await fn();}finally{await engine.exec('RESET ROLE');}};
async function snapshot(engine){
 const names=(await rows(engine,"SELECT tablename FROM pg_tables WHERE schemaname='lovelies_private' ORDER BY tablename")).map(r=>r.tablename),result={};
 await backend(engine,async()=>{for(const name of names){let projection='to_jsonb(t)';
  if(name==='privacy_exports')projection+="-ARRAY['content_format','chunk_count','manifest_sha256','manifest_object_sha256','manifest_object_bytes']";
  if(name==='privacy_export_deliveries')projection+="-ARRAY['protocol_version','chunk_count','manifest_sha256']";
  result[name]=createHash('sha256').update(JSON.stringify(await rows(engine,`SELECT ${projection} value FROM lovelies_private.${name} t ORDER BY(${projection})::text`))).digest('hex');
 }});return result;
}
test('v16 preserves v15 records, installs atomically and protects private snapshot bindings',{timeout:60000},async t=>{
 assert.equal(process.env.TEST_DATABASE_URL,undefined,'embedded PostgreSQL fixture only');
 const engine=await PGlite.create();t.after(()=>engine.close());await engine.exec('CREATE ROLE anon;CREATE ROLE authenticated;');
 for(const file of fs.readdirSync(folder).filter(x=>x.endsWith('.sql')&&x<name).sort())await engine.exec(fs.readFileSync(new URL(file,folder),'utf8'));
 const account=randomUUID(),session=randomUUID(),request=randomUUID(),publication=randomUUID(),delivery=randomUUID();
 await backend(engine,async()=>{
  await engine.query("INSERT INTO lovelies_private.accounts(id,created_at) VALUES($1,1)",[account]);
  await engine.query("INSERT INTO lovelies_private.sessions(id,account_id,refresh_hash,expires_at,refresh_expires_at,auth_epoch,auth_method,created_at) VALUES($1,$2,$3,10000,20000,1,'anonymous',1)",[session,account,randomUUID()]);
  await engine.query("INSERT INTO lovelies_private.privacy_requests(id,subject_id,requested_by,request_type,status,created_at,expires_at) VALUES($1,$2,$2,'export','completed',1,10000)",[request,account]);
  await engine.query("INSERT INTO lovelies_private.privacy_exports(id,request_id,subject_id,object_key,sha256,bytes,expires_at,status,created_at) VALUES($1,$2,$3,$4,$5,10,10000,'published',1)",[publication,request,account,'synthetic/'+publication,'a'.repeat(64)]);
  await engine.query("INSERT INTO lovelies_private.privacy_export_deliveries(id,request_id,subject_id,session_id,publication_id,operation_key,sha256,bytes,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,10,1000,1)",[delivery,request,account,session,publication,randomUUID(),'a'.repeat(64)]);
 });
 const before=await snapshot(engine);
 await t.test('wrong schema/unsafe backend role fail before any DDL',async()=>{
  for(const change of ['DELETE FROM lovelies_private.schema_versions WHERE version=15','ALTER ROLE lovelies_api BYPASSRLS']){
   await engine.exec('BEGIN');try{await engine.exec(change);await assert.rejects(engine.exec(source),/requires_schema_v15|unexpected_lovelies_api_role/);}finally{await engine.exec('ROLLBACK');}
   assert.deepEqual(await snapshot(engine),before);
  }
 });
 await t.test('late trigger collision rolls back tables, columns and version without an outer transaction',async()=>{
  const atomic=source.slice(source.indexOf('DO $chunked_privacy_exports$'),source.indexOf('RESET search_path;')).trim();
  await engine.exec('SET search_path TO lovelies_private,pg_catalog');
  await engine.exec('CREATE FUNCTION lovelies_private.guard_privacy_export_chunk() RETURNS trigger LANGUAGE plpgsql AS $c$ BEGIN RETURN NEW; END $c$');
  try{await assert.rejects(engine.exec(atomic),/guard_privacy_export_chunk.*already exists/);assert.deepEqual(await snapshot(engine),before);
   assert.equal((await rows(engine,"SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='lovelies_private' AND table_name='privacy_exports' AND column_name='content_format'"))[0].n,0);
  }finally{await engine.exec('DROP FUNCTION lovelies_private.guard_privacy_export_chunk();RESET search_path;');}
 });
 await engine.exec(source);
 await t.test('legacy rows keep defaultv2 and tables remain forcedRLS/backend-only',async()=>{
  const after=await snapshot(engine);assert.equal(Object.keys(after).length,Object.keys(before).length+3);
  for(const table of Object.keys(before))if(table!=='schema_versions')assert.equal(after[table],before[table],table);
  await backend(engine,async()=>{assert.equal(Number((await rows(engine,'SELECT protocol_version FROM lovelies_private.privacy_export_deliveries WHERE id=$1',[delivery]))[0].protocol_version),2);});
  const tables=['privacy_export_snapshots','privacy_export_snapshot_rows','privacy_export_chunks'];
  for(const table of tables){const row=(await rows(engine,"SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=('lovelies_private.'||$1)::regclass",[table]))[0];assert(row.relrowsecurity&&row.relforcerowsecurity);
   for(const role of ['anon','authenticated'])assert.equal((await rows(engine,'SELECT has_table_privilege($1,$2,$3) allowed',[role,'lovelies_private.'+table,'SELECT,INSERT,UPDATE,DELETE']))[0].allowed,false);
  }
 });
 await t.test('snapshot values and chunk bindings are immutable; private hash tails can only clear',async()=>backend(engine,async()=>{
  await engine.query("INSERT INTO lovelies_private.privacy_export_snapshots(id,request_id,subject_id,generated_at,status,hash_state_json,chain_sha256,expires_at) VALUES($1,$2,$3,1,'capturing','{}',$4,1000)",[publication,request,account,'b'.repeat(64)]);
  await engine.query("INSERT INTO lovelies_private.privacy_export_snapshot_rows(snapshot_id,sequence,payload_text,byte_length) VALUES($1,0,'{}',2)",[publication]);
  await engine.query("UPDATE lovelies_private.privacy_export_snapshots SET status='building',segment_count=1,row_count=1,total_bytes=2 WHERE id=$1",[publication]);
  await assert.rejects(engine.query("UPDATE lovelies_private.privacy_export_snapshot_rows SET payload_text='[]' WHERE snapshot_id=$1",[publication]),/privacy_export_snapshot_row_immutable/);
  await assert.rejects(engine.query('DELETE FROM lovelies_private.privacy_export_snapshot_rows WHERE snapshot_id=$1',[publication]),/privacy_export_snapshot_row_immutable/);
  await assert.rejects(engine.query('UPDATE lovelies_private.privacy_export_snapshots SET total_bytes=3 WHERE id=$1',[publication]),/privacy_export_snapshot_immutable/);
  await engine.query("INSERT INTO lovelies_private.privacy_export_chunks(publication_id,chunk_index,bytes,sha256,root_sha256,object_key,write_intent_id,status,start_seq,start_offset,end_seq,end_offset,hash_state_json,created_at) VALUES($1,0,2,$2,$3,'synthetic-chunk',$4,'pending',0,0,1,0,'{\"tail\":[1]}',1)",[publication,'c'.repeat(64),'d'.repeat(64),randomUUID()]);
  await assert.rejects(engine.query("UPDATE lovelies_private.privacy_export_chunks SET hash_state_json='{\"tail\":[2]}' WHERE publication_id=$1",[publication]),/privacy_export_chunk_immutable/);
  await engine.query("UPDATE lovelies_private.privacy_export_chunks SET status='verified',hash_state_json='{}' WHERE publication_id=$1",[publication]);
  await assert.rejects(engine.query("UPDATE lovelies_private.privacy_export_chunks SET status='pending' WHERE publication_id=$1",[publication]),/privacy_export_chunk_immutable/);
  await engine.query("UPDATE lovelies_private.privacy_export_snapshots SET status='retired',hash_state_json='{}' WHERE id=$1",[publication]);
  await engine.query('DELETE FROM lovelies_private.privacy_export_snapshot_rows WHERE snapshot_id=$1',[publication]);
 }));
 await t.test('only unpublished pending candidates can move, with exact old/new writer and cleanup proofs',async()=>backend(engine,async()=>{
  const req=randomUUID(),pub=randomUUID(),oldWrite=randomUUID(),nextWrite=randomUUID(),oldRoot=randomUUID(),nextRoot=randomUUID();
  const q=(sql,values=[])=>(engine.query(sql,values));
  await q("INSERT INTO lovelies_private.privacy_requests(id,subject_id,requested_by,request_type,status,created_at,expires_at) VALUES($1,$2,$2,'export','processing',1,10000)",[req,account]);
  await q("INSERT INTO lovelies_private.privacy_exports(id,request_id,subject_id,object_key,sha256,bytes,expires_at,status,created_at) VALUES($1,$2,$3,$4,$5,2,10000,'pending',1)",[pub,req,account,'synthetic-root-placeholder/'+pub,'a'.repeat(64)]);
  await q("INSERT INTO lovelies_private.privacy_export_snapshots(id,request_id,subject_id,generated_at,status,segment_count,row_count,total_bytes,hash_state_json,chain_sha256,expires_at) VALUES($1,$2,$3,1,'building',1,1,2,'{}',$4,10000)",[pub,req,account,'b'.repeat(64)]);
  for(const write of [oldWrite,nextWrite,oldRoot,nextRoot])await q("INSERT INTO lovelies_private.media_write_intents(id,account_id,bucket,object_key,status,created_at) VALUES($1,$2,'PRIVACY_EXPORTS',$3,'pending',1)",[write,account,'synthetic-attempt/'+write]);
  await q("INSERT INTO lovelies_private.privacy_export_chunks(publication_id,chunk_index,bytes,sha256,root_sha256,object_key,write_intent_id,status,start_seq,start_offset,end_seq,end_offset,hash_state_json,created_at) VALUES($1,0,2,$2,$3,$4,$5,'pending',0,0,1,0,'{}',1)",[pub,'c'.repeat(64),'d'.repeat(64),'synthetic-attempt/'+oldWrite,oldWrite]);
  const moveChunk=()=>q('UPDATE lovelies_private.privacy_export_chunks SET object_key=$1,write_intent_id=$2 WHERE publication_id=$3',['synthetic-attempt/'+nextWrite,nextWrite,pub]);
  await assert.rejects(moveChunk(),/privacy_export_chunk_immutable/);
  for(const write of [oldWrite,nextWrite])await q("INSERT INTO lovelies_private.cleanup_intents(id,request_id,subject_id,bucket,object_key,status,created_at) VALUES($1,$2,$3,'PRIVACY_EXPORTS',$4,'pending',1)",[randomUUID(),req,account,'synthetic-attempt/'+write]);
  await moveChunk();assert.equal((await q('SELECT status FROM lovelies_private.media_write_intents WHERE id=$1',[oldWrite])).rows[0].status,'pending');
  await q("UPDATE lovelies_private.privacy_export_chunks SET status='verified' WHERE publication_id=$1",[pub]);
  await assert.rejects(q('UPDATE lovelies_private.privacy_export_chunks SET object_key=$1,write_intent_id=$2 WHERE publication_id=$3',['synthetic-attempt/'+oldWrite,oldWrite,pub]),/privacy_export_chunk_immutable/);
  await q("UPDATE lovelies_private.privacy_export_snapshots SET status='publishing',cursor_seq=1,emitted_bytes=2,chunk_count=1,sha256=$1,root_write_id=$2 WHERE id=$3",['e'.repeat(64),oldRoot,pub]);
  const moveRoot=()=>q('UPDATE lovelies_private.privacy_export_snapshots SET root_write_id=$1 WHERE id=$2',[nextRoot,pub]);
  await assert.rejects(moveRoot(),/privacy_export_snapshot_immutable/);
  for(const write of [oldRoot,nextRoot])await q("INSERT INTO lovelies_private.cleanup_intents(id,request_id,subject_id,bucket,object_key,status,created_at) VALUES($1,$2,$3,'PRIVACY_EXPORTS',$4,'pending',1)",[randomUUID(),req,account,'synthetic-attempt/'+write]);
  await moveRoot();assert.equal((await q('SELECT status FROM lovelies_private.media_write_intents WHERE id=$1',[oldRoot])).rows[0].status,'pending');
  await q("UPDATE lovelies_private.privacy_export_snapshots SET status='completed' WHERE id=$1",[pub]);
  await assert.rejects(q('UPDATE lovelies_private.privacy_export_snapshots SET root_write_id=$1 WHERE id=$2',[oldRoot,pub]),/privacy_export_snapshot_immutable/);
 }));
 const after=await snapshot(engine);await assert.rejects(engine.exec(source),/requires_schema_v15/);assert.deepEqual(await snapshot(engine),after);
});
