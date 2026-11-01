#!/usr/bin/env node
/** Explicit host operations, never run automatically by application requests. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {args,runtime,compose,command,sql,literal,sha256,canonical,privateRequest,requireCompose,writeReceipt,withOperationLock} from './local-supabase-common.mjs';
import {checkConfiguration} from './local-supabase-check.mjs';
import {PROJECT_ID,parseEnv} from './local-supabase-configure.mjs';
import {privateRead} from './local-supabase-lifecycle.mjs';

const volumes=['lovelies-app-db','lovelies-app-db-config','lovelies-app-storage','lovelies-caddy-data','lovelies-caddy-config','lovelies-custody-db','lovelies-custody-db-config'];
export async function migrationInventory(r){
 const directory=path.join(r.config.repository_root,'supabase/migrations');
 const names=(await fs.readdir(directory)).filter(name=>/^\d{14}_[a-z0-9_]+\.sql$/.test(name)).sort();
 if(!names.length)throw Error('migrations_missing');
 return Promise.all(names.map(async name=>{const source=await fs.readFile(path.join(directory,name),'utf8');return {name,sha256:sha256(source),source};}));
}
export async function provisionVolumes(){
 for(const name of volumes){
  const existing=await command('docker',['volume','inspect',name],{allowFailure:true});
  if(existing.code===0){
   const value=JSON.parse(existing.stdout.toString());if(value.length!==1||value[0].Labels?.['lovelies.profile']!=='local-supabase-v1')throw Error('existing_unowned_volume_requires_review');
  }else await command('docker',['volume','create','--label','lovelies.profile=local-supabase-v1',name]);
 }
}
export async function migrate(r){
 const inventory=await migrationInventory(r);
 const state=await sql(r,"SELECT json_build_object('schema',to_regclass('lovelies_private.schema_versions'),'inventory',to_regclass('lovelies_deployment.applied_migrations'));");
 const observed=JSON.parse(state.text);
 if(observed.schema&&!observed.inventory)throw Error('existing_schema_without_source_inventory_requires_review');
 await sql(r,`CREATE SCHEMA IF NOT EXISTS lovelies_deployment;
 REVOKE ALL ON SCHEMA lovelies_deployment FROM PUBLIC,anon,authenticated,service_role;
 CREATE TABLE IF NOT EXISTS lovelies_deployment.applied_migrations(name text PRIMARY KEY,sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),applied_at timestamptz NOT NULL DEFAULT clock_timestamp());
 REVOKE ALL ON lovelies_deployment.applied_migrations FROM PUBLIC,anon,authenticated,service_role;`);
 const previous=JSON.parse((await sql(r,"SELECT COALESCE(json_agg(json_build_object('name',name,'sha256',sha256) ORDER BY name),'[]'::json) FROM lovelies_deployment.applied_migrations;")).text);
 for(const record of previous)if(!inventory.some(file=>file.name===record.name&&file.sha256===record.sha256))throw Error('migration_source_drift');
 // Each existing script and its inventory record commit together. No successful
 // source is silently adopted, and a failed script receives no completion row.
 for(const file of inventory){if(previous.some(record=>record.name===file.name))continue;
  await sql(r,'BEGIN;\n'+file.source+'\nINSERT INTO lovelies_deployment.applied_migrations(name,sha256) VALUES('+literal(file.name)+','+literal(file.sha256)+');\nCOMMIT;');
 }
 const version=await sql(r,'SELECT max(version) FROM lovelies_private.schema_versions;');
 if(Number(version.text)!==r.config.expected_schema_version)throw Error('schema_version_mismatch');
 return inventory.map(({name,sha256})=>({name,sha256}));
}
export async function provisionRuntimeRole(r){
 if(!/^[a-f0-9]{64}$/.test(r.app.LOVELIES_API_DATABASE_PASSWORD))throw Error('runtime_password_invalid');
 await sql(r,`BEGIN;
 DO $roles$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='lovelies_runtime') THEN CREATE ROLE lovelies_runtime LOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION; END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='lovelies_runtime' AND (rolsuper OR rolinherit OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)) OR EXISTS(SELECT FROM pg_roles WHERE rolname='lovelies_api' AND rolcanlogin) THEN RAISE EXCEPTION 'runtime_role_boundary_invalid'; END IF;
 END $roles$;
 GRANT CONNECT ON DATABASE postgres TO lovelies_runtime;
 GRANT lovelies_api TO lovelies_runtime WITH INHERIT FALSE;
 ALTER ROLE lovelies_runtime PASSWORD ${literal(r.app.LOVELIES_API_DATABASE_PASSWORD)};
 REVOKE ALL ON SCHEMA lovelies_deployment FROM lovelies_runtime,lovelies_api;
 COMMIT;`);
}
export async function provisionRotationRole(r){
 const values=parseEnv((await privateRead(path.join(r.directory,'rotation.env'))).toString());
 const url=new URL(values.LOVELIES_ROTATION_DATABASE_URL);
 if(url.protocol!=='postgres:'||url.hostname!=='db'||url.username!=='lovelies_rotation'||url.pathname!=='/postgres'||url.search||url.hash||!/^\w{64}$/.test(url.password))throw Error('rotation_role_configuration_invalid');
 const ddl=await fs.readFile(path.join(r.config.deployment_root,'managed-auth-key-rotation.sql'),'utf8');
 await sql(r,`BEGIN;
 DO $role$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='lovelies_rotation') THEN CREATE ROLE lovelies_rotation LOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION; END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='lovelies_rotation' AND (rolsuper OR rolinherit OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN RAISE EXCEPTION 'rotation_role_boundary_invalid'; END IF;
 END $role$;
 GRANT CONNECT ON DATABASE postgres TO lovelies_rotation;
 GRANT lovelies_api TO lovelies_rotation WITH INHERIT FALSE;
 ALTER ROLE lovelies_rotation PASSWORD ${literal(url.password)};
 ALTER ROLE lovelies_rotation SET log_statement='none';
 ALTER ROLE lovelies_rotation SET log_min_error_statement='panic';
 ALTER ROLE lovelies_rotation SET log_min_duration_statement=-1;
 ALTER ROLE lovelies_rotation SET log_parameter_max_length=0;
 ALTER ROLE lovelies_rotation SET log_parameter_max_length_on_error=0;
 ${ddl}
 COMMIT;`);
}
export async function provisionBuckets(r){
 // Storage service migrations must have completed first. Preserve unexpected
 // bucket settings for review instead of rewriting existing user data.
 await sql(r,`DO $buckets$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['lovelies-photos','lovelies-quarantine','lovelies-privacy-exports'] LOOP
  IF EXISTS(SELECT FROM storage.buckets b WHERE b.id=name AND (b.public OR b.file_size_limit IS DISTINCT FROM 20971520)) THEN RAISE EXCEPTION 'existing_bucket_configuration_requires_review'; END IF;
  INSERT INTO storage.buckets(id,name,public,file_size_limit) VALUES(name,name,false,20971520) ON CONFLICT(id) DO NOTHING;
 END LOOP; END $buckets$;`);
}
export async function initializeAuthority(r){
 const check=await sql(r,"SELECT json_build_object('accounts',(SELECT count(*) FROM lovelies_private.accounts),'managed_users',(SELECT count(*) FROM auth.users),'objects',(SELECT count(*) FROM storage.objects),'markers',(SELECT count(*) FROM lovelies_private.restore_control));");
 const counts=JSON.parse(check.text);if(counts.accounts!==0||counts.managed_users!==0||counts.objects!==0||counts.markers>1)throw Error('initial_authority_requires_genuinely_empty_database');
 const result=await privateRequest(r,'restore-journal','/v1/control/bootstrap',{method:'POST',credential:'bootstrap',body:{version:1,project_id:PROJECT_ID,database_id:r.custody.RESTORE_DATABASE_ID,bootstrap_id:r.custody.RESTORE_BOOTSTRAP_ID}});
 const marker=result.binding?.initial_marker;
 if(!marker||result.control.state!=='serving'||canonical(marker)!==canonical(result.control.marker)||marker.checkpoint.revision!==0||marker.cursor.sequence!==0||marker.database_id!==r.custody.RESTORE_DATABASE_ID)throw Error('initial_custody_is_not_genesis');
 const UUID=/^[0-9a-f-]{36}$/,HASH=/^[0-9a-f]{64}$/;
 if(!UUID.test(marker.database_id)||!UUID.test(marker.incarnation_id)||!HASH.test(marker.checkpoint.hash)||!HASH.test(marker.cursor.hash))throw Error('initial_marker_invalid');
 await sql(r,`BEGIN;
 LOCK TABLE lovelies_private.accounts,lovelies_private.restore_control,auth.users,storage.objects IN SHARE ROW EXCLUSIVE MODE;
 DO $fresh$ BEGIN IF EXISTS(SELECT FROM lovelies_private.accounts) OR EXISTS(SELECT FROM auth.users) OR EXISTS(SELECT FROM storage.objects) THEN RAISE EXCEPTION 'initial_database_not_empty'; END IF;
 IF EXISTS(SELECT FROM lovelies_private.restore_control WHERE singleton<>1 OR project_id<>${literal(PROJECT_ID)} OR database_id<>${literal(marker.database_id)} OR incarnation_id<>${literal(marker.incarnation_id)} OR checkpoint_revision<>0 OR checkpoint_hash<>${literal(marker.checkpoint.hash)} OR journal_sequence<>0 OR journal_hash<>${literal(marker.cursor.hash)} OR last_operation_id IS NOT NULL OR last_plan_hash IS NOT NULL) THEN RAISE EXCEPTION 'existing_marker_requires_recovery'; END IF;
 IF NOT EXISTS(SELECT FROM lovelies_private.restore_control) THEN
 INSERT INTO lovelies_private.restore_control(singleton,project_id,database_id,incarnation_id,checkpoint_revision,checkpoint_hash,journal_sequence,journal_hash,last_operation_id,last_plan_hash)
 VALUES(1,${literal(PROJECT_ID)},${literal(marker.database_id)},${literal(marker.incarnation_id)},0,${literal(marker.checkpoint.hash)},0,${literal(marker.cursor.hash)},NULL,NULL);
 END IF; END $fresh$;
 COMMIT;`);
 const base={project_id:PROJECT_ID,ledger_id:r.custody.PUSH_LEDGER_ID};
 await privateRequest(r,'push-ledger','/v1/bootstrap',{method:'POST',credential:'bootstrap',body:{version:1,...base,bootstrap_id:r.custody.PUSH_LEDGER_V1_BOOTSTRAP_ID}});
 await privateRequest(r,'push-ledger','/v2/bootstrap',{method:'POST',credential:'bootstrap',body:{version:2,...base,bootstrap_id:r.custody.PUSH_LEDGER_BOOTSTRAP_ID,provider_generation:r.push.PUSH_PROVIDER_GENERATION}});
 return {journal_database_id:marker.database_id,journal_incarnation_id:marker.incarnation_id,push_ledger_id:base.ledger_id,provider_sends_enabled:false};
}
export async function installScheduler(r){
 if(!/^[0-9a-f]{64}$/.test(r.api.INTERNAL_MAINTENANCE_SECRET))throw Error('maintenance_secret_invalid');
 const schedule=await fs.readFile(path.join(r.config.deployment_root,'maintenance-scheduler.sql'),'utf8');
 await sql(r,`BEGIN;
 CREATE EXTENSION IF NOT EXISTS supabase_vault CASCADE;
 DO $secret$ DECLARE existing uuid; BEGIN
 SELECT id INTO existing FROM vault.secrets WHERE name='lovelies_internal_maintenance';
 IF existing IS NULL THEN PERFORM vault.create_secret(${literal(r.api.INTERNAL_MAINTENANCE_SECRET)},'lovelies_internal_maintenance','Private Lovelies maintenance admission');
 ELSE PERFORM vault.update_secret(existing,${literal(r.api.INTERNAL_MAINTENANCE_SECRET)}); END IF;
 END $secret$;\n${schedule}\nCOMMIT;`);
}
export const operate=(operation,r)=>withOperationLock(r,operation,()=>operateLocked(operation,r));
async function operateLocked(operation,r){
 await requireCompose();
 const check=await checkConfiguration(r,{docker:true});if(check.errors.length)throw Error('configuration_check_failed');
 if(operation==='initialize'){
  await provisionVolumes();
  await compose(r,'custody',['up','-d','--build','--wait'],{timeout:1800000,maxBytes:1024*1024});
  await compose(r,'application',['up','-d','--wait','db','auth','rest','storage','imgproxy','meta','studio','api-gw','realtime','supavisor'],{timeout:600000,maxBytes:1024*1024});
  const migrations=await migrate(r);await provisionRuntimeRole(r);await provisionRotationRole(r);await provisionBuckets(r);
  const authority=await initializeAuthority(r);await installScheduler(r);
  await compose(r,'application',['up','-d','functions','push-provider'],{timeout:120000});
  return {status:'initial_services_configured_not_release_qualified',migrations,authority,public_ingress_started:false,inference_started:false};
 }
 if(operation==='migrate'){const migrations=await migrate(r);await provisionRotationRole(r);return {status:'migrations_applied',migrations};}
 if(operation==='scheduler'){await installScheduler(r);return {status:'private_scheduler_configured'};}
 if(operation==='publish'){
  // An explicit operator action, after the separate release gates. Publishing
  // only starts the already configured proxy; it is not a qualification receipt.
  await compose(r,'application',['up','-d','public-proxy']);return {status:'public_proxy_started_not_release_qualified'};
 }
 if(operation==='inference'){
  await compose(r,'application',['--profile','inference','up','-d','--build','ml-face','ml-proxy'],{timeout:14400000,maxBytes:4*1024*1024});
  return {status:'inference_build_requested_live_evaluation_still_required'};
 }
 throw Error('operation_invalid');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [operation,...rest]=process.argv.slice(2);const options=args(rest,['--runtime','--execute','--receipt'],['--execute']);
 (async()=>{if(!options['--execute']||!options['--receipt'])throw Error('explicit_execute_and_new_receipt_required');const r=await runtime(options['--runtime']),result=await operate(operation,r);
  const receipt={protocol:'lovelies-local-supabase-operation-v1',operation,completed_at:new Date().toISOString(),public_api_base_url:r.config.public_api_base_url,...result};await writeReceipt(options['--receipt'],receipt);console.log(JSON.stringify(receipt,null,2));
 })().catch(()=>{console.error('Host operation did not complete. Preserve current volumes and runtime files; inspect private service status before retrying. No credentials were printed.');process.exitCode=1;});
}
