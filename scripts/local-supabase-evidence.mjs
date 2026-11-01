/** Sanitized actual-container readback. Raw inspect/environment data never leaves this module. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {command,compose,sha256} from './local-supabase-common.mjs';

export async function sourceIdentity(r){
 const commit=(await command('git',['-C',r.config.repository_root,'rev-parse','HEAD'])).stdout.toString().trim();
 if(!/^[0-9a-f]{40}$/.test(commit))throw Error('source_commit_invalid');
 const dirty=(await command('git',['-C',r.config.repository_root,'status','--porcelain'])).stdout.length>0;
 return {source_commit:commit,source_dirty:dirty};
}
export async function actualConfiguration(r){
 const declarations=[
  ['application','functions',{...r.api,SUPABASE_DB_URL:'postgresql://lovelies_runtime:'+r.app.LOVELIES_API_DATABASE_PASSWORD+'@db:5432/postgres'}],
  ['application','auth',{GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED:'true',GOTRUE_EXTERNAL_EMAIL_ENABLED:'false',GOTRUE_EXTERNAL_PHONE_ENABLED:'false',GOTRUE_EXTERNAL_GOOGLE_ENABLED:'false'}],
  ['application','push-provider',r.push],['application','public-proxy',{PUBLIC_HOST:r.app.PUBLIC_HOST}],
  ['application','api-gw',{}],['application','db',{}],
  ['custody','restore-journal',{CUSTODY_SERVICE_ORIGIN:r.config.restore_journal_url}],
  ['custody','push-ledger',{CUSTODY_SERVICE_ORIGIN:r.config.push_ledger_url}],
 ];
 const services=[];
 for(const [project,service,expected] of declarations){
  const id=(await compose(r,project,['ps','-q',service])).stdout.toString().trim();if(!/^[0-9a-f]{12,64}$/.test(id))throw Error('running_service_missing');
  const value=JSON.parse((await command('docker',['inspect','--format','{{json .}}',id])).stdout.toString());
  if(value.State?.Running!==true||value.HostConfig?.NetworkMode==='host')throw Error('service_runtime_state_invalid');
  const env=Object.fromEntries(value.Config.Env.map(entry=>{const split=entry.indexOf('=');return [entry.slice(0,split),entry.slice(split+1)];}));
  for(const [key,input] of Object.entries(expected))if(env[key]!==String(input))throw Error('runtime_environment_mismatch');
  if(!['public-proxy'].includes(service)&&Object.keys(value.HostConfig.PortBindings??{}).length)throw Error('private_service_has_published_port');
  const digestList=JSON.parse((await command('docker',['image','inspect','--format','{{json .RepoDigests}}',value.Image])).stdout.toString()||'null')??[];
  services.push({service,project,container_id:id,image:value.Config.Image,image_id:value.Image,registry_digests:digestList,running:true,selected_environment_matches_input:true});
 }
 const proxy=(await compose(r,'application',['exec','-T','public-proxy','sha256sum','/etc/caddy/Caddyfile'])).stdout.toString().split(/\s+/)[0];
 const caddyHash=sha256(await fs.readFile(path.join(r.config.deployment_root,'Caddyfile')));if(proxy!==caddyHash)throw Error('public_proxy_configuration_mismatch');
 return {protocol:'lovelies-effective-configuration-inventory-v1',observed_at:new Date().toISOString(),architecture:'locally_hosted_supabase',
  public_api_base_url:r.config.public_api_base_url,internal_supabase_url:r.config.internal_supabase_url,
  restore_journal_url:r.config.restore_journal_url,push_ledger_url:r.config.push_ledger_url,
  database_role:'lovelies_runtime',application_role:'lovelies_api',database_tls_mode:r.api.LOVELIES_DATABASE_TLS_MODE,
  managed_auth:'server_held_anonymous_sessions',public_managed_auth:false,public_maintenance:false,
  provider_generation:r.push.PUSH_PROVIDER_GENERATION,provider_sends_enabled:r.push.PUSH_PROVIDER_SEND_ENABLED==='true',
  inference_model_version:r.api.PHOTO_MODEL_VERSION,inference_policy_version:r.api.FACE_AUTH_POLICY_VERSION,
  inference_artifact_sha256:r.api.ML_INFERENCE_ARTIFACT_SHA256,inference_processing_sha256:r.api.ML_INFERENCE_PROCESSING_SHA256,
  public_proxy_sha256:caddyHash,services};
}
export async function evidenceFile(file,value){const bytes=JSON.stringify(value,null,2)+'\n';await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});return {path:file,sha256:sha256(bytes)};}
export async function artifactHash(file){const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');}
