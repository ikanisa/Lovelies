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
  await local.engine.exec('RESET ROLE');
  assert.equal((await local.engine.query('SELECT pg_has_role($1,$2,$3) permitted',['postgres',backend,'MEMBER'])).rows[0].permitted,true);
 }finally{
  await local.engine.exec('RESET ROLE');await local.engine.close();
  await administrator.unsafe('DROP ROLE IF EXISTS '+backend);
  if(created)await administrator.unsafe('DROP ROLE '+owner);
  await administrator.end({timeout:5});
 }
});
