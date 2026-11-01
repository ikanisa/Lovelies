import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const directory=new URL('../../../supabase/migrations/',import.meta.url),name='20261029150000_operator_capabilities.sql';
const sql=fs.readFileSync(new URL(name,directory),'utf8');
test('operator migration is additive, private, atomic, and grants nobody access',async t=>{
 const engine=await PGlite.create();t.after(()=>engine.close());await engine.exec('CREATE ROLE anon; CREATE ROLE authenticated;');
 for(const file of fs.readdirSync(directory).filter(file=>file.endsWith('.sql')&&file<name).sort())await engine.exec(fs.readFileSync(new URL(file,directory),'utf8'));
 const account=crypto.randomUUID();await engine.query("INSERT INTO lovelies_private.accounts(id,name,roles_json,created_at) VALUES($1,'Preserved synthetic user','[\"user\"]',1)",[account]);
 const before=(await engine.query('SELECT to_jsonb(a) value FROM lovelies_private.accounts a WHERE id=$1',[account])).rows[0];
 await t.test('wrong predecessor and privileged backend role reject before schema effects',async()=>{
  for(const change of ['DELETE FROM lovelies_private.schema_versions WHERE version=16','ALTER ROLE lovelies_api BYPASSRLS']){
   await engine.exec('BEGIN');try{await engine.exec(change);await assert.rejects(()=>engine.exec(sql),/operator_capabilities_requires_schema_v16|unexpected_lovelies_api_role/);}finally{await engine.exec('ROLLBACK');}
   assert.equal((await engine.query("SELECT to_regclass('lovelies_private.operator_capability_grants') value")).rows[0].value,null);
  }
 });
 await t.test('a late guard collision rolls back all tables, policies, grants and version',async()=>{
  const atom=sql.slice(sql.indexOf('DO $operator_capabilities$'),sql.indexOf('RESET search_path;')).trim();
  await engine.exec('SET search_path TO lovelies_private,pg_catalog');
  await engine.exec('CREATE FUNCTION guard_operator_capability_binding() RETURNS trigger LANGUAGE plpgsql AS $collision$ BEGIN RETURN NEW; END $collision$');
  try{await assert.rejects(()=>engine.exec(atom),/already exists/);
   assert.equal((await engine.query("SELECT to_regclass('lovelies_private.operator_capability_grants') value")).rows[0].value,null);
   assert.equal(Number((await engine.query('SELECT max(version) n FROM lovelies_private.schema_versions')).rows[0].n),16);
  }finally{await engine.exec('DROP FUNCTION guard_operator_capability_binding(); RESET search_path');}
 });
 await engine.exec(sql);
 await t.test('existing account bytes remain intact, zero grants exist, and all new tables use forced private RLS',async()=>{
  assert.deepEqual((await engine.query('SELECT to_jsonb(a) value FROM lovelies_private.accounts a WHERE id=$1',[account])).rows[0],before);
  assert.equal(Number((await engine.query('SELECT count(*) n FROM lovelies_private.operator_capability_grants')).rows[0].n),0);
  const rows=(await engine.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='lovelies_private' AND relname IN('operator_access_versions','operator_capability_grants')")).rows;
  assert.equal(rows.length,2);assert(rows.every(row=>row.relrowsecurity&&row.relforcerowsecurity));
  for(const role of ['anon','authenticated'])for(const row of rows)assert.equal((await engine.query('SELECT has_table_privilege($1,$2,$3) allowed',[role,'lovelies_private.'+row.relname,'SELECT,INSERT,UPDATE,DELETE'])).rows[0].allowed,false);
  const trigger=(await engine.query("SELECT count(*) n FROM pg_trigger WHERE tgrelid='lovelies_private.operator_capability_grants'::regclass AND tgname='capture_restore_restriction'")).rows[0];assert.equal(Number(trigger.n),1);
 });
 await assert.rejects(()=>engine.exec(sql),/operator_capabilities_requires_schema_v16/);
});
