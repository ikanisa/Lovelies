#!/usr/bin/env node
/** Runs only in the explicit private operator profile. Secrets enter on stdin. */
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {RestoreDatabaseFence} from '../services/supabase-api/src/restore-database.ts';
import {RestoreJournalClient,validateRestoreMarker} from '../services/supabase-api/src/restore-journal.ts';
import {ROTATION_ABORT_PROTOCOL,rotationKeys,keyFingerprint,inspectDatabase,applyOrVerifyDatabase,abortOrVerifyDatabase,verifyRotationOutcome,canonical} from './local-supabase-managed-auth-rotation-core.mjs';
import {readLifecycle} from './local-supabase-lifecycle.mjs';

async function input(){const chunks=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>524288)throw Error('rotation_input_invalid');chunks.push(chunk);}const bytes=Buffer.concat(chunks);for(const chunk of chunks)chunk.fill(0);try{return JSON.parse(bytes.toString());}finally{bytes.fill(0);}}
async function assertGate(value,mode){
 const gate=await readLifecycle('/run/lovelies');
 if(gate.rotation_id!==value.rotation_id||gate.state!==mode||
   ![keyFingerprint(value.old_key),keyFingerprint(value.new_key)].includes(gate.key_sha256))throw Error('rotation_gate_invalid');
 if(mode==='verification_only'&&(!['committed','aborted'].includes(value.outcome)||gate.key_sha256!==keyFingerprint(value.outcome==='aborted'?value.old_key:value.new_key)))throw Error('rotation_gate_invalid');
 return gate;
}
async function ports(value){
 const url=new URL(value.database_url);
 if(url.protocol!=='postgres:'||url.hostname!=='db'||url.username!=='lovelies_rotation'||url.pathname!=='/postgres'||url.port&&url.port!=='5432'||url.search||url.hash||!/^[0-9a-f]{64}$/.test(url.password))throw Error('rotation_database_invalid');
 const postgres=createRequire(new URL('../services/supabase-api/package.json',import.meta.url))('postgres');
 const native=postgres(url.href,{max:1,prepare:false,ssl:false,connect_timeout:15,idle_timeout:10,onnotice:()=>{},
  connection:{application_name:'lovelies-managed-auth-key-rotation',statement_timeout:300000,lock_timeout:30000},
  types:{bigint:{to:20,from:[20],serialize:String,parse:value=>{const result=Number(value);if(!Number.isSafeInteger(result))throw Error('rotation_integer_invalid');return result;}}}});
 const query=runner=>async(sql,values=[])=>Array.from(await runner.unsafe(sql,values));
 const connection={query:query(native),begin:callback=>native.begin(sql=>callback({query:query(sql)}))};
 try{
  const [role]=await connection.query(`SELECT current_user AS name,rolsuper,rolinherit,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,
   pg_has_role('lovelies_runtime','lovelies_rotation','MEMBER') AS runtime_member,
   pg_has_role('lovelies_api','lovelies_rotation','MEMBER') AS app_member,
   has_table_privilege(current_user,'lovelies_deployment.managed_auth_key_rotations','SELECT') AS receipt_read,
   has_table_privilege(current_user,'lovelies_deployment.managed_auth_key_rotations','INSERT') AS receipt_insert,
   has_table_privilege(current_user,'lovelies_deployment.managed_auth_key_rotations','UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') AS receipt_mutation,
   has_schema_privilege(current_user,'lovelies_deployment','CREATE') AS receipt_ddl
   FROM pg_roles WHERE rolname=current_user`);
  if(!role||role.name!=='lovelies_rotation'||['rolsuper','rolinherit','rolbypassrls','rolcreatedb','rolcreaterole','rolreplication','runtime_member','app_member','receipt_mutation','receipt_ddl'].some(name=>role[name]!==false)||role.receipt_read!==true||role.receipt_insert!==true)throw Error('rotation_role_boundary_invalid');
  const [runtimeRole]=await connection.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='lovelies_runtime'");
  if(value.command!=='verify-readback'&&runtimeRole?.rolcanlogin!==false)throw Error('rotation_runtime_login_not_blocked');
  for(const [name,expected] of [['log_statement','none'],['log_min_error_statement','panic'],['log_min_duration_statement','-1'],['log_parameter_max_length','0'],['log_parameter_max_length_on_error','0']]){
   const [row]=await connection.query('SHOW '+name);if(String(row[name])!==expected)throw Error('rotation_logging_boundary_invalid');
  }
  const active=await connection.query("SELECT count(*) AS count FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND usename IN('lovelies_runtime','lovelies_rotation')");
  if(Number(active[0]?.count)!==0&&value.command!=='verify-readback')throw Error('rotation_writers_not_quiesced');
  if(value.command==='verify-readback'){
   const others=await connection.query("SELECT count(*) AS count FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND usename='lovelies_rotation'");
   if(Number(others[0]?.count)!==0)throw Error('rotation_writers_not_quiesced');
  }
  const journal=new RestoreJournalClient(process.env.RESTORE_JOURNAL_URL,process.env.RESTORE_JOURNAL_TOKEN);
  return {connection,journal,fence:new RestoreDatabaseFence(journal),close:()=>native.end({timeout:5})};
 }catch(error){await native.end({timeout:5});throw error;}
}
async function readiness(value){
 await assertGate(value,'verification_only');
 for(const route of ['health','ready']){
  const response=await fetch('http://api-gw:8000/functions/v1/lovelies-api/'+route,{signal:AbortSignal.timeout(20000)});
  const bytes=await response.text();if(bytes.length>32768)throw Error('rotation_readback_invalid');
  const body=JSON.parse(bytes),data=body.data??body;
  if(data.service!=='lovelies-supabase-api'||data.schema_version!==19||data.database_ready!==true||
    route==='health'&&response.status!==200||route==='ready'&&(![200,503].includes(response.status)||data.managed_auth_ready!==true))throw Error('rotation_runtime_not_ready');
 }
 await assertGate(value,'verification_only');
 return {protocol:'lovelies-managed-auth-rotation-readback-v1',schema_version:19,managed_auth_ready:true,outcome:value.outcome,key_sha256:keyFingerprint(value.outcome==='aborted'?value.old_key:value.new_key),
  observation:'private Edge health and managed Auth readiness; full release readiness remains a separate gate'};
}
export async function runWorker(value){
 if(!value||!['inspect','apply','abort','verify','verify-readback','readiness'].includes(value.command))throw Error('rotation_command_invalid');
 const keys=rotationKeys(value.old_key,value.new_key,[process.env.AUTH_SIGNING_SECRET,process.env.MEDIA_SIGNING_SECRET]);
 let p;
 try{
  if(value.command==='readiness')return readiness(value);
  const mode=value.command==='verify-readback'?'verification_only':'blocked';
  await assertGate(value,mode);p=await ports(value);
  if(value.command==='inspect')return {pre_state:await inspectDatabase(p,validateRestoreMarker(value.expected_marker),keys.oldKey)};
  if(value.intent?.rotation_id!==value.rotation_id)throw Error('rotation_intent_invalid');
  const receipt=value.command==='apply'?await applyOrVerifyDatabase(p,value.intent,keys.oldKey,keys.newKey):value.command==='abort'?await abortOrVerifyDatabase(p,value.intent,keys.oldKey):await verifyRotationOutcome(p,value.intent,keys.oldKey,keys.newKey);
  if(value.command==='verify-readback'&&(receipt.protocol===ROTATION_ABORT_PROTOCOL?'aborted':'committed')!==value.outcome)throw Error('rotation_readback_outcome_mismatch');
  await assertGate(value,mode);return {receipt};
 }finally{keys.oldKey.fill(0);keys.newKey.fill(0);await p?.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 (async()=>{const result=await runWorker(await input());process.stdout.write(canonical(result)+'\n');})().catch(()=>{
  console.error('Managed Auth rotation worker did not complete. Preserve the blocked lifecycle, escrow and intent; no credential values were printed.');process.exitCode=1;
 });
}
