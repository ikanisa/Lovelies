import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { startHarness } from './runtime-harness.mjs';

const folder=new URL('../../../supabase/migrations/',import.meta.url);
const v14=readFileSync(new URL('20261029190000_retention_schedule_saga.sql',folder),'utf8');
const v15=readFileSync(new URL('20261029210000_download_issuance_v15.sql',folder),'utf8');
async function apply(h,source){
  if(!h.databaseUrl)source=source.replace('PERFORM pg_advisory_xact_lock(704536419730718193::bigint);','');
  await h.engine.exec('BEGIN');try{await h.engine.exec(source);await h.engine.exec('COMMIT');}catch(error){await h.engine.exec('ROLLBACK');throw error;}
}
test('v13→v14→v15 preserves legacy ticket/operation bytes and empty authority, and v15 rejects an unsupported predecessor',async t=>{
  const h=await startHarness({consumeQueue:false,throughSchema:13});t.after(()=>h.close());
  const a=randomUUID(),s=randomUUID(),asset=randomUUID(),subscription=randomUUID(),ticket=randomUUID(),now=Date.now();
  await h.db.run('INSERT INTO accounts(id,created_at) VALUES(?,?)',a,now);
  await h.db.run("INSERT INTO sessions(id,account_id,refresh_hash,expires_at,refresh_expires_at,auth_epoch,auth_method,created_at) VALUES(?,?,?,?,?,1,'anonymous',?)",s,a,'legacy-'+s,now+60000,now+120000,now);
  await h.db.run("INSERT INTO assets(id,owner_id,source,status,object_key,content_type,byte_size,version,created_at) VALUES(?,?,'personal','ready',?,'image/png',1,?,?)",asset,a,'legacy/'+asset,randomUUID(),now);
  await h.db.run("INSERT INTO store_subscriptions(id,account_id,provider,app_identity,original_id,product_id,billing_environment,active,starts_at,expires_at,observed_at,transaction_id) VALUES(?,?,'apple','legacy','legacy','legacy','sandbox',0,?,?,?,'legacy')",subscription,a,now-1,now+1,now);
  await h.db.run('INSERT INTO download_tickets(id,account_id,session_id,asset_id,asset_version,source_checksum,subscription_id,subscription_version,expires_at,created_at,authority_json) VALUES(?,?,?,?,?,?,?,?,?,?,NULL)',
    ticket,a,s,asset,'legacy-source','a'.repeat(64),subscription,1,now+120000,now);
  const response=JSON.stringify({download_url:'https://legacy.invalid/downloads/'+ticket,unknown_history:'preserve'});
  await h.db.run("INSERT INTO operations(actor_id,source,operation_key,action,payload_hash,payload_json,response_json,created_at) VALUES(?,'media','legacy-key-0000001','download.sign',?,'{}',?,?)",a,'b'.repeat(64),response,now);
  const before=await h.db.all('SELECT * FROM download_tickets'),operations=await h.db.all('SELECT * FROM operations');
  await assert.rejects(()=>apply(h,v15),/download_issuance_requires_schema_v14/);
  assert.equal((await h.db.one('SELECT max(version) version FROM schema_versions')).version,13);
  await apply(h,v14);assert.equal((await h.db.one('SELECT max(version) version FROM schema_versions')).version,14);
  await apply(h,v15);assert.equal((await h.db.one('SELECT max(version) version FROM schema_versions')).version,15);
  assert.deepEqual(await h.db.all('SELECT * FROM download_tickets'),before);assert.deepEqual(await h.db.all('SELECT * FROM operations'),operations);
  assert.equal((await h.db.one('SELECT count(*) n FROM download_v2_operations')).n,0);assert.equal((await h.db.one('SELECT count(*) n FROM restore_control')).n,0);
  await assert.rejects(()=>apply(h,v15),/download_issuance_requires_schema_v14/);
});
test('new disposition/ticket tables have forced RLS and no public role/FK can block account/session/asset erasure',async t=>{
  const h=await startHarness({consumeQueue:false});t.after(()=>h.close());
  for(const table of ['download_v2_operations','download_v2_tickets']){
    const row=(await h.engine.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',['lovelies_private.'+table])).rows[0];
    assert.deepEqual(row,{relrowsecurity:true,relforcerowsecurity:true});
    for(const role of ['anon','authenticated','lovelies_api'])for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])
      assert.equal((await h.engine.query('SELECT has_table_privilege($1,$2,$3) permitted',[role,'lovelies_private.'+table,privilege])).rows[0].permitted,
        role==='lovelies_api'&&['SELECT','INSERT','UPDATE','DELETE'].includes(privilege),role+':'+table+':'+privilege);
  }
  const refs=(await h.engine.query("SELECT confrelid::regclass::text target FROM pg_constraint WHERE contype='f' AND conrelid IN('lovelies_private.download_v2_operations'::regclass,'lovelies_private.download_v2_tickets'::regclass)")).rows;
  assert.deepEqual([...refs],[{target:'lovelies_private.download_v2_operations'}]);
});
for(const fault of ['backend-truncate','backend-reference','backend-grant-option','extra-role-default','extra-role-membership'])
  test(`v15 rejects ${fault} without changing private history, DDL or the drift evidence`,async t=>{
    const h=await startHarness({consumeQueue:false,throughSchema:14});t.after(()=>h.close());
    const actor=randomUUID(),role='download_v15_extra_'+randomUUID().replaceAll('-','');
    await h.db.run('INSERT INTO accounts(id,name,created_at) VALUES(?,?,?)',actor,'Preserved unknown fixture',1000);
    await h.db.run("INSERT INTO operations(actor_id,source,operation_key,action,payload_hash,payload_json,response_json,created_at) VALUES(?,'media','preserve-legacy-key','download.sign',?,'{}',?,1000)",
      actor,'a'.repeat(64),JSON.stringify({unknown_history:'preserve',download_url:'https://legacy.invalid/downloads/'+randomUUID()}));
    const before={accounts:await h.db.all('SELECT * FROM accounts'),operations:await h.db.all('SELECT * FROM operations'),versions:await h.db.all('SELECT * FROM schema_versions ORDER BY version')};
    let revert;
    if(fault.startsWith('extra-role')){
      await h.engine.exec('CREATE ROLE '+role+' NOLOGIN');
      if(fault==='extra-role-default'){
        await h.engine.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA lovelies_private GRANT SELECT ON TABLES TO '+role);
        revert=async()=>{await h.engine.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA lovelies_private REVOKE SELECT ON TABLES FROM '+role);await h.engine.exec('DROP ROLE '+role);};
      }else{
        await h.engine.exec('GRANT lovelies_api TO '+role);
        revert=async()=>{await h.engine.exec('REVOKE lovelies_api FROM '+role);await h.engine.exec('DROP ROLE '+role);};
      }
    }else{
      const grant=fault==='backend-truncate'?'TRUNCATE':fault==='backend-reference'?'REFERENCES':'SELECT';
      await h.engine.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA lovelies_private GRANT '+grant+' ON TABLES TO lovelies_api'+(fault==='backend-grant-option'?' WITH GRANT OPTION':''));
      revert=()=>h.engine.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA lovelies_private REVOKE '+grant+' ON TABLES FROM lovelies_api');
    }
    try{
      const defaultACL=(await h.engine.query('SELECT defaclrole,defaclnamespace,defaclobjtype,defaclacl::text FROM pg_default_acl ORDER BY oid')).rows;
      await assert.rejects(()=>apply(h,v15),/unexpected_download_issuance_grant/);
      assert.deepEqual(await h.db.all('SELECT * FROM accounts'),before.accounts);assert.deepEqual(await h.db.all('SELECT * FROM operations'),before.operations);
      assert.deepEqual(await h.db.all('SELECT * FROM schema_versions ORDER BY version'),before.versions);
      assert.deepEqual((await h.engine.query('SELECT defaclrole,defaclnamespace,defaclobjtype,defaclacl::text FROM pg_default_acl ORDER BY oid')).rows,defaultACL);
      assert.equal((await h.engine.query("SELECT to_regclass('lovelies_private.download_v2_operations') relation")).rows[0].relation,null);
      assert.equal((await h.engine.query("SELECT count(*)::int n FROM pg_attribute WHERE attrelid='lovelies_private.restore_control'::regclass AND attname IN('last_disposition','last_receipt_hash')")).rows[0].n,0);
    }finally{await revert();}
    await apply(h,v15);assert.equal((await h.db.one('SELECT max(version) version FROM schema_versions')).version,15);
    assert.deepEqual(await h.db.all('SELECT * FROM operations'),before.operations);
  });
test('native PG migration waits for the same active writer lock and retains it until its atomic DDL completes',async t=>{
  const h=await startHarness({consumeQueue:false,throughSchema:14});t.after(()=>h.close());
  if(!h.databaseUrl){t.skip('native multi-pool PostgreSQL advisory-lock lane required');return;}
  const legacy=postgres(h.databaseUrl,{prepare:false,max:1,ssl:false,onnotice:()=>{}}),observer=postgres(h.databaseUrl,{prepare:false,max:1,ssl:false,onnotice:()=>{}});
  let entered,release;const acquired=new Promise(r=>entered=r),gate=new Promise(r=>release=r);let pending;
  try{
    const old=legacy.begin(async tx=>{await tx.unsafe('SELECT pg_advisory_xact_lock(704536419730718193::bigint)');entered();await gate;});
    await acquired;let completed=false;pending=apply(h,v15).then(()=>{completed=true;});
    const key=704536419730718193n,hi=Number(key>>32n),lo=Number(key&0xffffffffn),deadline=Date.now()+10000;
    for(;;){const locks=await observer.unsafe("SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND classid=$1::oid AND objid=$2::oid AND NOT granted",[hi,lo]);
      if(locks[0].n>0)break;if(Date.now()>=deadline)throw Error('migration did not wait on the writer lock');await new Promise(r=>setTimeout(r,10));}
    assert.equal(completed,false);release();await old;await pending;
    assert.equal((await h.db.one('SELECT max(version) version FROM schema_versions')).version,15);
  }finally{release?.();await pending?.catch(()=>{});await legacy.end({timeout:5});await observer.end({timeout:5});}
});
