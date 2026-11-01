#!/usr/bin/env node
/** Secrets are read only from the environment. Progress never includes private
 * object keys, account IDs, provider bodies, URLs, or connection strings. */
import postgres from 'postgres';
import {RestoreJournalClient} from '../src/restore-journal.ts';
import {RestoreRecoveryController} from '../src/restore-recovery.ts';
import {SupabasePrivateBucket} from '../src/storage.ts';
import {SupabaseManagedAuth} from '../src/managed-auth-provider.ts';
import {AuthenticatedService} from '../src/service-fetcher.ts';
import {currentSchemaVersion} from '../src/schema.ts';
import {internalEndpoint,internalEndpointPolicy,databaseTlsConfiguration} from '../src/endpoint-configuration.ts';
const args=process.argv.slice(2),command=args.shift();
const required=name=>{const value=process.env[name];if(!value)throw Error('missing_'+name.toLowerCase());return value;};
const options=new Map();for(let index=0;index<args.length;index+=2){const key=args[index],value=args[index+1];if(!['--recovery-id','--steps'].includes(key)||!value||options.has(key))throw Error('invalid_arguments');options.set(key,value);}
const id=options.get('--recovery-id'),steps=options.has('--steps')?Number(options.get('--steps')):1;
if(!['status','begin','step'].includes(command)||!id||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)||!Number.isInteger(steps)||steps<1||steps>100||command!=='step'&&options.has('--steps')){
 process.stderr.write('Usage: node --experimental-transform-types services/supabase-api/scripts/restore-recovery.mjs status|begin|step --recovery-id UUID [--steps 1..100]\n');process.exitCode=2;
}else{
 let sql;
 try{
  const databaseUrl=required('LOVELIES_DATABASE_URL'),database=new URL(databaseUrl);
  if(!['postgres:','postgresql:'].includes(database.protocol))throw Error('invalid_database_configuration');
  const endpointPolicy=internalEndpointPolicy(process.env.LOVELIES_INTERNAL_SERVICE_ORIGINS);
  const projectUrl=internalEndpoint(required('INTERNAL_SUPABASE_URL'),endpointPolicy).origin;
  const tls=databaseTlsConfiguration(databaseUrl,process.env.LOVELIES_DATABASE_CA,{mode:process.env.LOVELIES_DATABASE_TLS_MODE,trustedPlaintextHosts:(process.env.LOVELIES_DATABASE_PLAINTEXT_HOSTS??'').split(',').map(host=>host.trim()).filter(Boolean)});
  sql=postgres(databaseUrl,{prepare:false,max:1,ssl:tls,connect_timeout:10,idle_timeout:20,onnotice:()=>{},
   connection:{search_path:'lovelies_private,pg_catalog',application_name:'lovelies-restore-recovery'},types:{bigint:{to:20,from:[20],serialize:String,parse:value=>{const n=Number(value);if(!Number.isSafeInteger(n))throw Error('unsafe_database_integer');return n;}}}});
  const wrap=runner=>({query:async(source,values)=>Array.from(await runner.unsafe(source,values)),begin:async callback=>sql.begin(tx=>callback(wrap(tx)))}),connection=wrap(sql);
  await connection.begin(async c=>{await c.query('SET LOCAL ROLE lovelies_api',[]);const rows=await c.query('SELECT max(version) AS version FROM lovelies_private.schema_versions',[]);if(rows.length!==1||Number(rows[0].version)!==currentSchemaVersion)throw Error('restore_schema_version_mismatch');});
  const journal=new RestoreJournalClient(required('RESTORE_JOURNAL_URL'),required('RESTORE_JOURNAL_TOKEN')),secret=required('LOVELIES_STORAGE_SECRET');
  const services=command==='step'?{
   MANAGED_AUTH:new SupabaseManagedAuth(projectUrl,required('SUPABASE_ANON_KEY'),required('SUPABASE_SERVICE_ROLE_KEY'),fetch,endpointPolicy),
   MANAGED_AUTH_ENCRYPTION_KEY:required('MANAGED_AUTH_ENCRYPTION_KEY'),AUTH_SIGNING_SECRET:required('AUTH_SIGNING_SECRET'),MEDIA_SIGNING_SECRET:required('MEDIA_SIGNING_SECRET'),
   PUSH_SERVICE:new AuthenticatedService(process.env.PUSH_RECOVERY_SERVICE_URL||required('PUSH_SERVICE_URL'),process.env.PUSH_RECOVERY_SERVICE_SECRET||required('PUSH_SERVICE_SECRET'),fetch,55000,undefined,undefined,endpointPolicy),
   PUSH_PROVIDER_GENERATION:required('PUSH_PROVIDER_GENERATION'),PUSH_LEDGER_ID:required('PUSH_LEDGER_ID'),PUSH_LEDGER_BOOTSTRAP_ID:required('PUSH_LEDGER_BOOTSTRAP_ID')
  }:{};
  const controller=new RestoreRecoveryController(connection,journal,{
   PHOTOS:new SupabasePrivateBucket(projectUrl,secret,'lovelies-photos',fetch,undefined,endpointPolicy),QUARANTINE:new SupabasePrivateBucket(projectUrl,secret,'lovelies-quarantine',fetch,undefined,endpointPolicy),PRIVACY_EXPORTS:new SupabasePrivateBucket(projectUrl,secret,'lovelies-privacy-exports',fetch,undefined,endpointPolicy)},Date.now,services);
  const output=(view,phase)=>process.stdout.write(JSON.stringify({recovery_id:id,phase,serving_state:view.control.state,replayed: view.progress.replayed.sequence,
   restriction_count:view.recovery.journal_head.sequence,reconciled_effects:view.progress.effect_sequence,effect_count:view.recovery.effect_head.sequence,
   generation_hash:view.recovery.generation_hash,clearance_hash:view.progress.clearance?.clearance_hash??null})+'\n');
  if(command==='status'){const view=await controller.read(id);output(view,view.progress.phase);}
  else if(command==='begin'){const view=await controller.begin(id);output(view,view.progress.phase);}
  else{await controller.begin(id);for(let index=0;index<steps;index++){const result=await controller.step(id);output(result.recovery,result.phase);if(result.phase==='completed')break;}}
 }catch(error){const code=typeof error?.code==='string'&&/^[a-z_]{1,100}$/.test(error.code)?error.code:typeof error?.message==='string'&&/^(missing_[a-z_]+|invalid_[a-z_]+|unexpected_supabase_project|restore_schema_version_mismatch|unsafe_database_integer)$/.test(error.message)?error.message:'restore_recovery_failed';
  process.stderr.write(JSON.stringify({error:code,recovery_id:id,serving_clearance_claimed:false})+'\n');process.exitCode=1;
 }finally{await sql?.end({timeout:5});}
}
