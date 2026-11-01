#!/usr/bin/env node
/** Real-host qualification. It never turns a missing host check into a pass. */
import {pathToFileURL} from 'node:url';
import {args,runtime,compose,sql,privateRequest,writeReceipt,withOperationLock} from './local-supabase-common.mjs';
import {checkConfiguration} from './local-supabase-check.mjs';
import {migrationInventory} from './local-supabase-operate.mjs';
import {sourceIdentity,actualConfiguration,evidenceFile,artifactHash} from './local-supabase-evidence.mjs';

export const qualify=(r,options={})=>withOperationLock(r,'host-qualification',()=>qualifyLocked(r,options));
async function qualifyLocked(r,{restartCustody=false,receiptBase,backendArtifact}={}){
 const checks=[],run=async(id,operation)=>{try{checks.push({id,status:'passed',...await operation()});}catch{checks.push({id,status:'failed'});}};
 const identity=await sourceIdentity(r),bindings={};
 const configuration=await checkConfiguration(r,{docker:true});
 if(configuration.errors.length)throw Error('host_configuration_invalid');
 await run('actual_container_configuration_readback',async()=>{
  const value=await actualConfiguration(r);
  if(!receiptBase)throw Error();const file=await evidenceFile(receiptBase+'.configuration.json',value);
  bindings.configuration=file;bindings.configuration_sha256=file.sha256;
  const runtime=value.services.find(service=>service.service==='functions');
  const digest=runtime.registry_digests.find(value=>value.includes('/edge-runtime@sha256:'));
  if(!digest)throw Error();bindings.backend_image_digest=digest.split('@')[1];
  if(backendArtifact){bindings.backend_artifact_sha256=await artifactHash(backendArtifact);bindings.backend_artifact_binding='operator_supplied_file_requires_candidate_to_container_source_verification';}
  return {configuration_sha256:file.sha256,backend_image_digest:bindings.backend_image_digest};
 });
 await run('exact_public_https_health',async()=>{
  const response=await fetch(r.config.public_api_base_url+'/health',{redirect:'error',signal:AbortSignal.timeout(20000)}),value=await response.json();
  if(!response.ok||value.schema_version!==r.config.expected_schema_version||value.service!=='lovelies-supabase-api')throw Error();return {schema_version:value.schema_version,public_api_base_url:r.config.public_api_base_url};
 });
 await run('full_application_readiness',async()=>{
  const response=await fetch(r.config.public_api_base_url+'/ready',{redirect:'error',signal:AbortSignal.timeout(60000)}),value=await response.json();
  if(!response.ok||value.status!=='ok'||value.managed_auth_ready!==true||value.inference_ready!==true||value.push_roster_ready!==true)throw Error();return {schema_version:value.schema_version};
 });
 for(const [id,url] of [['public_managed_auth_blocked',r.config.public_supabase_url+'/auth/v1/signup'],['public_maintenance_blocked',r.config.public_api_base_url+'/_internal/maintenance']])await run(id,async()=>{
  const response=await fetch(url,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(15000)});await response.body?.cancel();if(response.status!==404)throw Error();return {http_status:404};
 });
 await run('exact_applied_migration_inventory',async()=>{
  const expected=(await migrationInventory(r)).map(({name,sha256})=>({name,sha256}));
  const actual=JSON.parse((await sql(r,"SELECT COALESCE(json_agg(json_build_object('name',name,'sha256',sha256) ORDER BY name),'[]'::json) FROM lovelies_deployment.applied_migrations;")).text);
  if(JSON.stringify(expected)!==JSON.stringify(actual)||!receiptBase)throw Error();
  const file=await evidenceFile(receiptBase+'.migrations.json',actual);bindings.migration_inventory=file;bindings.migration_inventory_sha256=file.sha256;return {migrations:actual,migration_inventory_sha256:file.sha256};
 });
 await run('database_role_and_secret_boundaries',async()=>{
  const result=await sql(r,`SELECT json_build_object(
   'api_login',(SELECT rolcanlogin FROM pg_roles WHERE rolname='lovelies_api'),
   'runtime_super',(SELECT rolsuper OR rolbypassrls OR rolinherit OR rolcreatedb OR rolcreaterole OR rolreplication FROM pg_roles WHERE rolname='lovelies_runtime'),
   'anon_member',pg_has_role('anon','lovelies_api','MEMBER'),
   'authenticated_member',pg_has_role('authenticated','lovelies_api','MEMBER'),
   'api_auth_read',has_table_privilege('lovelies_api','auth.sessions','SELECT'),
   'api_vault_read',has_table_privilege('lovelies_api','vault.decrypted_secrets','SELECT'),
   'api_net_read',has_table_privilege('lovelies_api','net.http_request_queue','SELECT'),
   'runtime_net_read',has_table_privilege('lovelies_runtime','net.http_request_queue','SELECT'),
   'runtime_vault_read',has_table_privilege('lovelies_runtime','vault.decrypted_secrets','SELECT'),
   'api_schedule_execute',has_function_privilege('lovelies_api','lovelies_deployment.schedule_maintenance_request()','EXECUTE'),
   'client_table_grants',(SELECT count(*)>0 FROM information_schema.table_privileges WHERE table_schema='lovelies_private' AND grantee IN ('anon','authenticated','PUBLIC')),
   'unprotected_private_tables',(SELECT count(*)>0 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='lovelies_private' AND c.relkind='r' AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity))
  );`);
  const values=JSON.parse(result.text);if(Object.values(values).some(value=>value!==false))throw Error();return values;
 });
 for(const role of ['anon','authenticated'])await run(role+'_actual_private_read_denied',async()=>{
  const result=await sql(r,'BEGIN; SET LOCAL ROLE '+role+'; SELECT id FROM lovelies_private.accounts LIMIT 1; ROLLBACK;',{allowFailure:true});
  if(result.code===0)throw Error();return {database_refused:true};
 });
 await run('managed_auth_and_storage_on_private_gateway',async()=>{
  const response=await compose(r,'application',['exec','-T','push-provider','node','deploy/local-supabase/qualify-inside.mjs'],{input:JSON.stringify({execute:true,origin:r.config.internal_supabase_url,anonKey:r.api.SUPABASE_ANON_KEY,serviceKey:r.api.SUPABASE_SERVICE_ROLE_KEY}),timeout:240000});
  const value=JSON.parse(response.stdout.toString());checks.push(...value.checks);if(value.checks.some(check=>check.status!=='passed'))throw Error();return {synthetic_run_id:value.run_id};
 });
 await run('private_maintenance_scheduled_and_delivered',async()=>{
  const jobs=await sql(r,"SELECT count(*) FROM cron.job WHERE jobname='lovelies-private-maintenance' AND active AND schedule='* * * * *';");if(jobs.text!=='1')throw Error();
  const queued=await sql(r,'SELECT lovelies_deployment.schedule_maintenance_request();');if(!/^\d+$/.test(queued.text))throw Error();
  let status=null;for(let attempt=0;attempt<20;attempt++){
   const response=await sql(r,'SELECT status_code FROM net._http_response WHERE id='+queued.text+';');if(response.text){status=Number(response.text);break;}await new Promise(resolve=>setTimeout(resolve,1000));
  }
  if(status!==200)throw Error();return {http_status:status};
 });
 await run('independent_custody_serving_bindings',async()=>{
  const journal=await privateRequest(r,'restore-journal','/v1/control'),push=await privateRequest(r,'push-ledger','/v2/control');
  if(journal.control.state!=='serving'||push.control.state!=='serving'||push.ledger_id!==r.custody.PUSH_LEDGER_ID||push.control.provider_generation!==r.push.PUSH_PROVIDER_GENERATION)throw Error();
  return {journal_database_id:journal.control.marker.database_id,push_ledger_id:push.ledger_id};
 });
 if(restartCustody)await run('custody_survives_actual_service_restart',async()=>{
  const before=await privateRequest(r,'restore-journal','/v1/control'),pushBefore=await privateRequest(r,'push-ledger','/v2/control');
  // Maintenance is not stopped here; compare immutable identities and monotonic
  // checkpoint rather than falsely requiring an idle live system.
  await compose(r,'custody',['restart','restore-journal','push-ledger']);
  await compose(r,'custody',['up','-d','--wait','restore-journal','push-ledger']);
  const after=await privateRequest(r,'restore-journal','/v1/control'),pushAfter=await privateRequest(r,'push-ledger','/v2/control');
  if(before.control.marker.database_id!==after.control.marker.database_id||before.control.marker.incarnation_id!==after.control.marker.incarnation_id||after.control.marker.checkpoint.revision<before.control.marker.checkpoint.revision||pushBefore.ledger_id!==pushAfter.ledger_id||pushBefore.ledger_bootstrap_id!==pushAfter.ledger_bootstrap_id)throw Error();return {restart_executed:true};
 });else checks.push({id:'custody_survives_actual_service_restart',status:'not_run',reason:'requires_explicit_restart_custody_flag'});
 checks.push({id:'coordinated_restore_replay_and_device_delivery',status:'not_run',reason:'separate_isolated_restore_drill_and_real_device_provider_evidence_required'});
 return {protocol:'lovelies-local-supabase-host-qualification-v1',observed_at:new Date().toISOString(),environment:'host',architecture:'locally_hosted_supabase',schema_version:r.config.expected_schema_version,...identity,...bindings,public_api_base_url:r.config.public_api_base_url,upstream_commit:r.config.upstream_commit,postgres_image:r.config.postgres_image,
  status:checks.some(check=>check.status==='failed')?'failed':checks.some(check=>check.status==='not_run')?'partial_host_evidence':'host_checks_passed',configuration_warnings:configuration.warnings,checks};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const options=args(process.argv.slice(2),['--runtime','--receipt','--execute','--restart-custody','--backend-artifact'],['--execute','--restart-custody']);
 (async()=>{if(!options['--execute']||!options['--receipt'])throw Error('explicit_execute_and_new_receipt_required');const report=await qualify(await runtime(options['--runtime']),{restartCustody:!!options['--restart-custody'],receiptBase:options['--receipt'],backendArtifact:options['--backend-artifact']});await writeReceipt(options['--receipt'],report);console.log(JSON.stringify(report,null,2));if(report.status!=='host_checks_passed')process.exitCode=2;})().catch(()=>{console.error('Host qualification could not complete. Preserve any partial evidence and inspect synthetic-resource cleanup before retry. No credentials were printed.');process.exitCode=1;});
}
