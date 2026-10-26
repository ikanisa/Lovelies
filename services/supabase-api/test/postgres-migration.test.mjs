import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import postgres from 'postgres';
import {isolatedPostgres} from './postgres-harness.mjs';

test('private schema migration succeeds under a non-superuser CREATEROLE database owner', {skip:!process.env.TEST_DATABASE_URL,timeout:60000}, async()=>{
 const local=await isolatedPostgres(process.env.TEST_DATABASE_URL),administrator=postgres(process.env.TEST_DATABASE_URL,{prepare:false,max:1,ssl:false,onnotice:()=>{}});
 const suffix=crypto.randomUUID().replaceAll('-',''),owner='lovelies_migrator_'+suffix,backend='lovelies_api_'+suffix;
 const name=new URL(local.url).pathname.slice(1);
 const file=fs.readdirSync(new URL('../../../supabase/migrations/',import.meta.url)).find(x=>/_lovelies_private_core\.sql$/.test(x));
 // Roles are global to the disposable server. A unique test name exercises the
 // fresh-role path without dropping/changing the role used by other fixtures.
 const migration=fs.readFileSync(new URL('../../../supabase/migrations/'+file,import.meta.url),'utf8').replaceAll('lovelies_api',backend);
 let created=false;
 try{
  await administrator.unsafe('CREATE ROLE '+owner+' NOLOGIN CREATEROLE NOBYPASSRLS');created=true;
  await administrator.unsafe('GRANT '+owner+' TO postgres');
  await administrator.unsafe('GRANT CREATE ON DATABASE '+name+' TO '+owner);
  await local.engine.exec('SET ROLE '+owner);
  const role=(await local.engine.query('SELECT rolsuper,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert.deepEqual(role,{rolsuper:false,rolcreaterole:true,rolbypassrls:false});
  await local.engine.exec(migration);
  const tables=(await local.engine.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='lovelies_private'")).rows[0].n;assert.equal(tables,62);
  // The production baseline grants SET ROLE to its named postgres migration
  // account. This differently named fixture grants itself that same membership
  // using its existing ADMIN option, without superuser or BYPASSRLS authority.
  await local.engine.exec('GRANT '+backend+' TO '+owner);
  const additive=fs.readFileSync(new URL('../../../supabase/migrations/20261023210000_refresh_delivery.sql',import.meta.url),'utf8').replaceAll('lovelies_api',backend);
  await local.engine.exec(additive);
  assert.equal((await local.engine.query('SELECT current_user role')).rows[0].role,owner);
  assert.equal((await local.engine.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='lovelies_private'")).rows[0].n,63);
  await local.engine.exec('SET ROLE '+backend);
  assert.equal(Number((await local.engine.query('SELECT max(version) version FROM lovelies_private.schema_versions')).rows[0].version),8);
  await local.engine.exec('SET ROLE '+owner);
  const audience=fs.readFileSync(new URL('../../../supabase/migrations/20261024170000_audience_retention.sql',import.meta.url),'utf8').replaceAll('lovelies_api',backend);
  await local.engine.exec(audience);
  assert.equal((await local.engine.query('SELECT current_user role')).rows[0].role,owner);
  assert.equal((await local.engine.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='lovelies_private'")).rows[0].n,67);
  await local.engine.exec('SET ROLE '+backend);
  assert.equal(Number((await local.engine.query('SELECT max(version) version FROM lovelies_private.schema_versions')).rows[0].version),9);
  assert.equal(Number((await local.engine.query('SELECT count(*) n FROM lovelies_private.account_audience')).rows[0].n),0,'no adult backfill');
  await local.engine.exec('SET ROLE '+owner);
  const generation=fs.readFileSync(new URL('../../../supabase/migrations/20261024180000_inference_generation.sql',import.meta.url),'utf8').replaceAll('lovelies_api',backend);
  await local.engine.exec(generation);await local.engine.exec(generation);
  assert.equal((await local.engine.query('SELECT current_user role')).rows[0].role,owner);
  assert.equal((await local.engine.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='lovelies_private'")).rows[0].n,67);
  await local.engine.exec('SET ROLE '+backend);
  assert.equal(Number((await local.engine.query('SELECT max(version) version FROM lovelies_private.schema_versions')).rows[0].version),10);
  const columns=(await local.engine.query("SELECT table_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='lovelies_private' AND column_name='engine_identity' ORDER BY table_name")).rows;
  assert.deepEqual([...columns],['auth_challenges','processing_attempts'].map(table_name=>({table_name,data_type:'text',is_nullable:'YES',column_default:null})));
  await local.engine.exec('SET ROLE '+owner);
  const cursors=fs.readFileSync(new URL('../../../supabase/migrations/20261024190000_retention_scan_cursors.sql',import.meta.url),'utf8').replaceAll('lovelies_api',backend);
  await local.engine.exec(cursors);
  assert.equal((await local.engine.query('SELECT current_user role')).rows[0].role,owner);
  assert.equal((await local.engine.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='lovelies_private'")).rows[0].n,68);
  const cursorProtection=(await local.engine.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='lovelies_private.retention_scan_cursors'::regclass")).rows[0];
  assert.deepEqual(cursorProtection,{relrowsecurity:true,relforcerowsecurity:true});
  const cursorPolicy=(await local.engine.query("SELECT policyname,roles,qual,with_check FROM pg_policies WHERE schemaname='lovelies_private' AND tablename='retention_scan_cursors'")).rows;
  assert.deepEqual([...cursorPolicy].map(row=>({...row,roles:[...row.roles]})),[{policyname:'backend_only',roles:[backend],qual:'true',with_check:'true'}]);
  for(const client of ['anon','authenticated'])assert.equal((await local.engine.query(
   "SELECT has_table_privilege($1,'lovelies_private.retention_scan_cursors','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') permitted",[client])).rows[0].permitted,false);
  await local.engine.exec('SET ROLE '+backend);
  assert.equal(Number((await local.engine.query('SELECT max(version) version FROM lovelies_private.schema_versions')).rows[0].version),11);
  assert.equal(Number((await local.engine.query('SELECT count(*) n FROM lovelies_private.retention_scan_cursors')).rows[0].n),0,'v11 seeds no continuation or account data');
  await local.engine.exec("INSERT INTO lovelies_private.retention_scan_cursors(scan,last_at,last_id) VALUES('support',1000,'support-record')");
  const cursorRow=(await local.engine.query("SELECT scan,entity_id,last_at,last_id FROM lovelies_private.retention_scan_cursors WHERE entity_id=''")).rows[0];
  assert.deepEqual({...cursorRow,last_at:Number(cursorRow.last_at)},{scan:'support',entity_id:'',last_at:1000,last_id:'support-record'});
  await local.engine.exec(`INSERT INTO lovelies_private.retention_scan_cursors(scan,entity_id,last_at,last_id) VALUES
   ('support','source-one',2000,'operation-one'),('support','source-two',3000,'operation-two');
   INSERT INTO lovelies_private.retention_scan_cursors(scan,entity_id,last_at,last_id) VALUES('support','source-one',4000,'operation-three')
    ON CONFLICT(scan,entity_id) DO UPDATE SET last_at=excluded.last_at,last_id=excluded.last_id;`);
  const sourceCursors=(await local.engine.query("SELECT entity_id,last_at,last_id FROM lovelies_private.retention_scan_cursors WHERE scan='support' AND entity_id<>'' ORDER BY entity_id")).rows;
  assert.deepEqual([...sourceCursors].map(row=>({...row,last_at:Number(row.last_at)})),[
   {entity_id:'source-one',last_at:4000,last_id:'operation-three'},
   {entity_id:'source-two',last_at:3000,last_id:'operation-two'}]);
  assert.deepEqual((await local.engine.query("SELECT scan,entity_id,last_at,last_id FROM lovelies_private.retention_scan_cursors WHERE entity_id=''")).rows[0],cursorRow,'source upsert preserves the default class cursor');
  await assert.rejects(()=>local.engine.exec("INSERT INTO lovelies_private.retention_scan_cursors(scan,entity_id) VALUES('support','source-one')"),/duplicate key/);
  await assert.rejects(()=>local.engine.exec("INSERT INTO lovelies_private.retention_scan_cursors(scan,entity_id) VALUES('support',NULL)"),/not-null constraint/);
  await assert.rejects(()=>local.engine.exec("UPDATE lovelies_private.retention_scan_cursors SET last_at=NULL WHERE scan='support' AND entity_id='source-one'"),/check constraint/);
  await local.engine.exec('SET ROLE '+owner);
  const checkpoint=fs.readFileSync(new URL('../../../supabase/migrations/20261026132612_restore_control.sql',import.meta.url),'utf8').replaceAll('lovelies_api',backend);
  const authority=fs.readFileSync(new URL('../../../supabase/migrations/20261026224211_lovelies_media_authority.sql',import.meta.url),'utf8').replaceAll('lovelies_api',backend);
  await local.engine.exec(checkpoint); await local.engine.exec(authority);
  assert.equal((await local.engine.query('SELECT current_user role')).rows[0].role,owner);
  assert.equal((await local.engine.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='lovelies_private'")).rows[0].n,69);
  const authorityColumns=(await local.engine.query("SELECT table_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='lovelies_private' AND column_name='authority_json' ORDER BY table_name")).rows;
  assert.deepEqual([...authorityColumns].map(row=>({...row})),['download_tickets','media_tickets'].map(table_name=>({table_name,data_type:'text',is_nullable:'YES',column_default:null})));
  await local.engine.exec('SET ROLE '+backend);
  assert.equal(Number((await local.engine.query('SELECT max(version) version FROM lovelies_private.schema_versions')).rows[0].version),13);
  assert.equal(Number((await local.engine.query('SELECT count(*) n FROM lovelies_private.restore_control')).rows[0].n),0,'v13 does not seed restore authority');
  await local.engine.exec('RESET ROLE');
  assert.equal((await local.engine.query('SELECT pg_has_role($1,$2,$3) permitted',['postgres',backend,'MEMBER'])).rows[0].permitted,true);
 }finally{
  await local.engine.exec('RESET ROLE');await local.engine.close();
  await administrator.unsafe('DROP ROLE IF EXISTS '+backend);
  if(created)await administrator.unsafe('DROP ROLE '+owner);
  await administrator.end({timeout:5});
 }
});
