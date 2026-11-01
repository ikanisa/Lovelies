import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const folder=new URL('../../../supabase/migrations/',import.meta.url);
const stages=['20261101012732_audience_and_delivery_reconciliation.sql','20261101013223_managed_auth_session_custody.sql'];
const source=name=>fs.readFileSync(new URL(name,folder),'utf8');
const one=async(e,sql,args=[])=>(await e.query(sql,args)).rows[0];
test('the Complete v17 chain upgrades atomically through audience/delivery v18 and private managed Auth v19',async t=>{
 const e=await PGlite.create();t.after(()=>e.close());await e.exec('CREATE ROLE anon;CREATE ROLE authenticated;');
 for(const name of fs.readdirSync(folder).filter(name=>name.endsWith('.sql')&&name<stages[0]).sort())await e.exec(source(name));
 const account=crypto.randomUUID(),now=Date.now();
 await e.query("INSERT INTO lovelies_private.accounts(id,name,created_at) VALUES($1,'preserved synthetic user',$2)",[account,now]);
 await e.query("INSERT INTO lovelies_private.account_audience(account_id,age_band,status,version,declared_at,policy_version) VALUES($1,'18_plus','eligible',1,$2,'audience-2026-10-24-v1')",[account,now]);
 const before=await one(e,'SELECT to_jsonb(a) value FROM lovelies_private.accounts a WHERE id=$1',[account]);
 assert.equal(Number((await one(e,'SELECT max(version) n FROM lovelies_private.schema_versions')).n),17);
 await t.test('v18 wrong predecessor and a late function collision leave no partial tables or version',async()=>{
  await e.exec('BEGIN');try{await e.exec('DELETE FROM lovelies_private.schema_versions WHERE version=17');await assert.rejects(()=>e.exec(source(stages[0])),/requires_schema_v17/);}finally{await e.exec('ROLLBACK');}
  await e.exec('CREATE FUNCTION lovelies_private.processing_attempt_profile_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$');
  try{await assert.rejects(()=>e.exec(source(stages[0])),/already exists/);
   assert.equal((await one(e,"SELECT to_regclass('lovelies_private.audience_review_retirements') value")).value,null);
   assert.equal(Number((await one(e,'SELECT max(version) n FROM lovelies_private.schema_versions')).n),17);
  }finally{await e.exec('DROP FUNCTION lovelies_private.processing_attempt_profile_immutable()');}
 });
 await e.exec(source(stages[0]));
 await t.test('v18 retains raw legacy tuples, export-v3, computed recovery and existing capability grants',async()=>{
  assert.deepEqual(await one(e,'SELECT to_jsonb(a) value FROM lovelies_private.accounts a WHERE id=$1',[account]),before);
  const row=await one(e,'SELECT age_band,decision_protocol,at_least_13,guardian_required FROM lovelies_private.account_audience WHERE account_id=$1',[account]);
  assert.deepEqual(row,{age_band:'18_plus',decision_protocol:'legacy-v1',at_least_13:null,guardian_required:null});
  for(const table of ['privacy_export_snapshots','privacy_export_snapshot_rows','privacy_export_chunks','restore_recovered_operations','restore_recovery_runs','operator_capability_grants'])
   assert.equal((await one(e,'SELECT to_regclass($1)::text value',['lovelies_private.'+table])).value,'lovelies_private.'+table);
  await e.query("UPDATE lovelies_private.account_audience SET age_band=NULL,decision_protocol='decision-v2',at_least_13=1,guardian_required=0,decision_source='self_declaration',rule_version='audience-13-plus-guardian-v1',territory='global',next_review_at=$2 WHERE account_id=$1",[account,now+365*86400000]);
  for(const column of ['at_least_13','guardian_required','decision_source','rule_version','territory','next_review_at'])
   await assert.rejects(()=>e.query('UPDATE lovelies_private.account_audience SET '+column+'=NULL WHERE account_id=$1',[account]),/check constraint/);
  const examination=(await e.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='lovelies_private' AND column_name IN('last_examined_at','last_recovery_scan_at')")).rows;
  assert.deepEqual(examination.map(row=>row.table_name+'.'+row.column_name).sort(),['notification_jobs.last_examined_at','outbox.last_examined_at','photo_job_outbox.last_examined_at','privacy_requests.last_recovery_scan_at']);
 });
 await t.test('v19 late predicate collision rolls back credential custody and version',async()=>{
  await e.exec('CREATE FUNCTION lovelies_private.managed_auth_user_absent(text) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$');
  try{await assert.rejects(()=>e.exec(source(stages[1])),/already exists/);
   assert.equal((await one(e,"SELECT to_regclass('lovelies_private.managed_auth_bindings') value")).value,null);
   assert.equal((await one(e,"SELECT to_regprocedure('lovelies_private.managed_auth_session_current(text,text,bigint)') value")).value,null);
   assert.equal(Number((await one(e,'SELECT max(version) n FROM lovelies_private.schema_versions')).n),18);
  }finally{await e.exec('DROP FUNCTION lovelies_private.managed_auth_user_absent(text)');}
 });
 await e.exec(source(stages[1]));
 const tables=['audience_review_retirements','processing_attempt_profiles','processing_match_progress','notification_dispatch_plans','notification_recovered_receipts','managed_auth_bindings'];
 for(const table of tables){
  assert.deepEqual(await one(e,'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',['lovelies_private.'+table]),{relrowsecurity:true,relforcerowsecurity:true});
  for(const role of ['anon','authenticated'])assert.equal((await one(e,'SELECT has_table_privilege($1,$2,$3) allowed',[role,'lovelies_private.'+table,'SELECT,INSERT,UPDATE,DELETE'])).allowed,false);
 }
 for(const signature of ['lovelies_private.managed_auth_session_current(text,text,bigint)','lovelies_private.managed_auth_user_absent(text)']){
  for(const role of ['anon','authenticated'])assert.equal((await one(e,'SELECT has_function_privilege($1,$2,$3) allowed',[role,signature,'EXECUTE'])).allowed,false);
  assert.equal((await one(e,'SELECT has_function_privilege($1,$2,$3) allowed',['lovelies_api',signature,'EXECUTE'])).allowed,true);
  assert.deepEqual(await one(e,'SELECT prosecdef,proisstrict,provolatile,proconfig FROM pg_proc WHERE oid=$1::regprocedure',[signature]),
   {prosecdef:true,proisstrict:true,provolatile:'v',proconfig:['search_path=pg_catalog']});
  assert.equal(Number((await one(e,"SELECT count(*) n FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE p.oid=$1::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE'",[signature])).n),0);
 }
 await t.test('local Auth absence is a restricted physical-row predicate, independent of session validity',async()=>{
  await e.exec('CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,is_anonymous boolean,deleted_at timestamptz,banned_until timestamptz);CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid,not_after timestamptz,created_at timestamptz);');
  const user=crypto.randomUUID(),session=crypto.randomUUID();
  await e.query('INSERT INTO auth.users(id,is_anonymous,deleted_at,banned_until) VALUES($1,true,$2,$3)',[user,new Date(),new Date(Date.now()+3600000)]);
  await e.exec('SET ROLE lovelies_api');
  try{
   assert.equal((await one(e,'SELECT lovelies_private.managed_auth_session_current($1,$2,$3) value',[user,session,Date.now()])).value,false);
   assert.equal((await one(e,'SELECT lovelies_private.managed_auth_user_absent($1) value',[user])).value,false);
   assert.equal((await one(e,'SELECT lovelies_private.managed_auth_user_absent($1) value',['invalid-user'])).value,false);
   assert.equal((await one(e,'SELECT lovelies_private.managed_auth_user_absent(NULL) value')).value,null);
   for(const table of ['auth.users','auth.sessions']){
    await assert.rejects(()=>e.query('SELECT id FROM '+table),/permission denied/);
   }
  }finally{await e.exec('RESET ROLE');}
  for(const table of ['auth.users','auth.sessions'])for(const role of ['lovelies_api','anon','authenticated'])
   assert.equal((await one(e,'SELECT has_table_privilege($1,$2,$3) value',[role,table,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'])).value,false);
  await e.query('DELETE FROM auth.users WHERE id=$1',[user]);
  await e.exec('SET ROLE lovelies_api');
  try{assert.equal((await one(e,'SELECT lovelies_private.managed_auth_user_absent($1) value',[user])).value,true);}
  finally{await e.exec('RESET ROLE');}
 });
 assert.equal(Number((await one(e,'SELECT max(version) n FROM lovelies_private.schema_versions')).n),19);
 assert.equal(Number((await one(e,'SELECT count(*) n FROM lovelies_private.restore_control')).n),0);
 assert.equal(Number((await one(e,'SELECT count(*) n FROM lovelies_private.managed_auth_bindings')).n),0);
 await assert.rejects(()=>e.exec(source(stages[1])),/requires_schema_v18/);
});
