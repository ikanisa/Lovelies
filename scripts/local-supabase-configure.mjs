#!/usr/bin/env node
/** Generate a new private deployment input directory; never overwrite secrets. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {randomBytes,randomUUID,createHmac} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {providerGeneration} from '../services/push-provider/src/providers.mjs';
import {lifecycle} from './local-supabase-lifecycle.mjs';

export const PROJECT_ID='ltqfplqevxztlswlzexn';
export const UPSTREAM_COMMIT='a05e7ec1d79e67cba65e3871b7caf105db27f8b1';
export const POSTGRES_IMAGE='supabase/postgres:17.11.0.003@sha256:7374d196da7e301512cc5329e18040e0f7bb856287b323777cdadecccbc6c7e4';
export const EDGE_IMAGE='public.ecr.aws/supabase/edge-runtime:v1.77.8@sha256:178c041398a33ded8219344382d0672a90051d1babbf0af03425cafe20039a75';
const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const deployment=path.join(repository,'deploy/local-supabase');
const secret=()=>randomBytes(32).toString('hex');
const jwt=(role,key,now)=>{
 const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
 const unsigned=encode({alg:'HS256',typ:'JWT'})+'.'+encode({role,iss:'supabase',iat:Math.floor(now/1000),exp:Math.floor(now/1000)+365*86400});
 return unsigned+'.'+createHmac('sha256',key).update(unsigned).digest('base64url');
};
export function envText(values){return Object.entries(values).map(([key,value])=>{
 if(!/^[A-Z][A-Z0-9_]*$/.test(key)||/[\r\n\0]/.test(String(value)))throw Error('invalid_environment_value');
 return key+'='+JSON.stringify(String(value));
}).join('\n')+'\n';}
export function parseEnv(text){
 const values={};
 for(const raw of text.split(/\r?\n/)){
  const line=raw.trim();if(!line||line.startsWith('#'))continue;
  const match=/^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);if(!match)throw Error('invalid_environment_file');
  if(Object.hasOwn(values,match[1]))throw Error('duplicate_environment_key');
  const value=match[2].trim();values[match[1]]=value.startsWith('"')?JSON.parse(value):value;
 }
 return values;
}
export function generateConfiguration({host,email,runtimeDirectory,publicSiteRoot,now=Date.now(),uid=process.getuid?.()??1000,gid=process.getgid?.()??1000}){
 if(typeof host!=='string'||!/[.]/.test(host)||!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/.test(host)||host==='supabase.co'||host.endsWith('.supabase.co')||host.includes('..')||!/^\S+@[^\s@]+\.[^\s@]+$/.test(email??''))throw Error('public_host_and_operator_email_required');
 if(!path.isAbsolute(runtimeDirectory)||!path.isAbsolute(publicSiteRoot)||path.basename(publicSiteRoot)!=='public'||path.dirname(publicSiteRoot)==='/')throw Error('absolute_private_and_staged_public_paths_required');
 const origin='https://'+host,signing=secret(),anon=jwt('anon',signing,now),service=jwt('service_role',signing,now);
 const common={LOVELIES_REPOSITORY_ROOT:repository,LOVELIES_DEPLOYMENT_ROOT:deployment,LOVELIES_RUNTIME_DIR:runtimeDirectory,
  LOVELIES_PUBLIC_SITE_ROOT:publicSiteRoot,LOVELIES_STATIC_ROOT:path.dirname(publicSiteRoot),LOVELIES_IMAGE_TAG:'local-supabase-20261101',LOVELIES_SERVICE_UID:uid,LOVELIES_SERVICE_GID:gid};
 const custody={...common,CUSTODY_POSTGRES_PASSWORD:secret(),CUSTODY_JOURNAL_PASSWORD:secret(),CUSTODY_PUSH_PASSWORD:secret(),
  RESTORE_JOURNAL_TOKEN:secret(),RESTORE_JOURNAL_BOOTSTRAP_TOKEN:secret(),RESTORE_JOURNAL_OBSERVER_TOKEN:secret(),
  CUSTODY_HEALTH_TOKEN:secret(),PUSH_LEDGER_TOKEN:secret(),PUSH_LEDGER_BOOTSTRAP_TOKEN:secret(),PUSH_LEDGER_ID:randomUUID(),
  PUSH_LEDGER_BOOTSTRAP_ID:randomUUID(),PUSH_LEDGER_V1_BOOTSTRAP_ID:randomUUID(),RESTORE_DATABASE_ID:randomUUID(),RESTORE_BOOTSTRAP_ID:randomUUID()};
 const app={...common,PUBLIC_HOST:host,ACME_EMAIL:email,SUPABASE_PUBLIC_URL:origin,API_EXTERNAL_URL:origin+'/auth/v1',
  POSTGRES_HOST:'db',POSTGRES_DB:'postgres',POSTGRES_PORT:5432,POSTGRES_PASSWORD:secret(),LOVELIES_API_DATABASE_PASSWORD:secret(),
  JWT_SECRET:signing,ANON_KEY:anon,SERVICE_ROLE_KEY:service,SUPABASE_PUBLISHABLE_KEY:'',SUPABASE_SECRET_KEY:'',
  DASHBOARD_USERNAME:'lovelies-operator',DASHBOARD_PASSWORD:secret(),SECRET_KEY_BASE:randomBytes(48).toString('base64'),
  REALTIME_DB_ENC_KEY:randomBytes(8).toString('hex'),VAULT_ENC_KEY:randomBytes(16).toString('hex'),PG_META_CRYPTO_KEY:secret(),
  LOGFLARE_PUBLIC_ACCESS_TOKEN:secret(),LOGFLARE_PRIVATE_ACCESS_TOKEN:secret(),S3_PROTOCOL_ACCESS_KEY_ID:randomBytes(16).toString('hex'),S3_PROTOCOL_ACCESS_KEY_SECRET:secret(),
  SITE_URL:origin,ADDITIONAL_REDIRECT_URLS:origin+'/auth/callback',JWT_EXPIRY:900,DISABLE_SIGNUP:'false',ENABLE_ANONYMOUS_USERS:'true',
  ENABLE_EMAIL_SIGNUP:'false',ENABLE_EMAIL_AUTOCONFIRM:'false',ENABLE_PHONE_SIGNUP:'false',ENABLE_PHONE_AUTOCONFIRM:'false',AUTH_ANONYMOUS_RATE_LIMIT:600,
  SMTP_HOST:'',SMTP_PORT:587,SMTP_USER:'',SMTP_PASS:'',SMTP_ADMIN_EMAIL:email,SMTP_SENDER_NAME:'Lovelies',
  MAILER_URLPATHS_INVITE:'/auth/v1/verify',MAILER_URLPATHS_CONFIRMATION:'/auth/v1/verify',MAILER_URLPATHS_RECOVERY:'/auth/v1/verify',MAILER_URLPATHS_EMAIL_CHANGE:'/auth/v1/verify',
  POOLER_PROXY_PORT_TRANSACTION:6543,POOLER_DEFAULT_POOL_SIZE:20,POOLER_MAX_CLIENT_CONN:100,POOLER_TENANT_ID:PROJECT_ID,POOLER_DB_POOL_SIZE:5,
  PGRST_DB_SCHEMAS:'public,storage,graphql_public',PGRST_DB_MAX_ROWS:1000,PGRST_DB_EXTRA_SEARCH_PATH:'public',
  STUDIO_DEFAULT_ORGANIZATION:'Lovelies',STUDIO_DEFAULT_PROJECT:'Local Supabase',OPENAI_API_KEY:'',
  GLOBAL_S3_BUCKET:'lovelies-private-storage',REGION:'local',STORAGE_TENANT_ID:PROJECT_ID,IMGPROXY_AUTO_WEBP:'true',FUNCTIONS_VERIFY_JWT:'false'};
 const api={APP_ENV:'production',SUPABASE_PROJECT_ID:PROJECT_ID,INTERNAL_SUPABASE_URL:'http://api-gw:8000',PUBLIC_API_BASE_URL:origin+'/functions/v1/lovelies-api',
  PUBLIC_APP_BASE_URL:origin,ALLOWED_ORIGINS:origin,LOVELIES_INTERNAL_SERVICE_ORIGINS:'http://api-gw:8000,http://push-provider:8091',
  LOVELIES_DATABASE_URL:'postgres://lovelies_runtime:'+app.LOVELIES_API_DATABASE_PASSWORD+'@db:5432/postgres',LOVELIES_DATABASE_TLS_MODE:'disable-internal',LOVELIES_DATABASE_PLAINTEXT_HOSTS:'db',
  SUPABASE_ANON_KEY:anon,SUPABASE_SERVICE_ROLE_KEY:service,AUTH_SIGNING_SECRET:secret(),MEDIA_SIGNING_SECRET:secret(),MANAGED_AUTH_ENCRYPTION_KEY:randomBytes(32).toString('base64'),
  INTERNAL_MAINTENANCE_SECRET:secret(),RESTORE_JOURNAL_URL:'https://restore-journal:8443',RESTORE_JOURNAL_TOKEN:custody.RESTORE_JOURNAL_TOKEN,
  PUSH_SERVICE_URL:'http://push-provider:8091',PUSH_SERVICE_SECRET:secret(),PUSH_LEDGER_ID:custody.PUSH_LEDGER_ID,PUSH_LEDGER_BOOTSTRAP_ID:custody.PUSH_LEDGER_BOOTSTRAP_ID,
  PUSH_PROVIDER_GENERATION:providerGeneration({}),ML_INFERENCE_URL:'https://ml-proxy:8443',ML_INFERENCE_SECRET:secret(),
  ML_INFERENCE_ARTIFACT_SHA256:'',ML_INFERENCE_PROCESSING_SHA256:'',FACE_AUTH_POLICY_VERSION:'',PHOTO_MODEL_VERSION:'',PHOTO_CONSENT_POLICY_VERSION:'',
  APPLE_BUNDLE_ID:'com.lovelies.memories',GOOGLE_PLAY_PACKAGE_NAME:'com.lovelies.memories'};
 const push={PUSH_LEDGER_URL:'https://push-ledger:8443',PUSH_LEDGER_TOKEN:custody.PUSH_LEDGER_TOKEN,PUSH_LEDGER_ID:custody.PUSH_LEDGER_ID,
  PUSH_LEDGER_BOOTSTRAP_ID:custody.PUSH_LEDGER_BOOTSTRAP_ID,PUSH_PROVIDER_GENERATION:providerGeneration({}),PUSH_SERVICE_SECRET:api.PUSH_SERVICE_SECRET,
  PUSH_PROVIDER_SEND_ENABLED:'false',PUSH_RECOVERY_ONLY:'false',APNS_TOPIC:'com.lovelies.memories',ANDROID_PACKAGE_NAME:'com.lovelies.memories'};
 const ml={ML_DEPLOYMENT_TRANSPORT:'https_service',ML_INFERENCE_SECRET:api.ML_INFERENCE_SECRET,APP_ENV:'production',ML_USE_DETERMINISTIC_SIMULATOR:'false',PORT:8080};
 const rotation={LOVELIES_ROTATION_DATABASE_URL:'postgres://lovelies_rotation:'+secret()+'@db:5432/postgres'};
 const config={protocol:'lovelies-local-supabase-deployment-v1',project_id:PROJECT_ID,created_at:new Date(now).toISOString(),
  public_supabase_url:origin,public_api_base_url:api.PUBLIC_API_BASE_URL,internal_supabase_url:api.INTERNAL_SUPABASE_URL,
  restore_journal_url:api.RESTORE_JOURNAL_URL,push_ledger_url:push.PUSH_LEDGER_URL,push_service_url:api.PUSH_SERVICE_URL,
  expected_schema_version:19,upstream_commit:UPSTREAM_COMMIT,postgres_image:POSTGRES_IMAGE,edge_runtime_image:EDGE_IMAGE,
  compose_projects:{application:'lovelies-app',custody:'lovelies-custody'},runtime_directory:runtimeDirectory,
  repository_root:repository,deployment_root:deployment,public_site_root:publicSiteRoot,static_root:path.dirname(publicSiteRoot),
  status:'configuration_generated_not_deployed',provider_sends_enabled:false};
 return {app,custody,api,push,ml,rotation,config,backupKey:randomBytes(32).toString('base64')};
}
export async function writeConfiguration(input){
 const generated=generateConfiguration(input),directory=input.runtimeDirectory;
 await fs.mkdir(directory,{mode:0o700});
 try{
  for(const name of ['app','custody','api','push','ml','rotation'])await fs.writeFile(path.join(directory,name+'.env'),envText(generated[name]),{mode:0o600,flag:'wx'});
  await fs.mkdir(path.join(directory,'lifecycle'),{mode:0o755});
  await fs.writeFile(path.join(directory,'lifecycle/gate.json'),JSON.stringify(lifecycle('open',null,generated.api.MANAGED_AUTH_ENCRYPTION_KEY))+'\n',{mode:0o644,flag:'wx'});
  await fs.mkdir(path.join(directory,'managed-auth-rotations'),{mode:0o700});
  await fs.writeFile(path.join(directory,'config.json'),JSON.stringify(generated.config,null,2)+'\n',{mode:0o600,flag:'wx'});
  await fs.writeFile(path.join(directory,'backup.key'),generated.backupKey+'\n',{mode:0o600,flag:'wx'});
  await fs.mkdir(path.join(directory,'providers'),{mode:0o700});
  const tls=path.join(directory,'tls');await fs.mkdir(tls,{mode:0o700});
  const run=args=>execFileSync('openssl',args,{cwd:tls,stdio:['ignore','ignore','pipe']});
  run(['req','-x509','-newkey','rsa:3072','-sha256','-days','3650','-nodes','-keyout','ca.key','-out','ca.crt','-subj','/CN=Lovelies private custody CA','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign']);
  for(const service of ['restore-journal','push-ledger','ml-proxy']){
   run(['req','-newkey','rsa:3072','-nodes','-keyout',service+'.key','-out',service+'.csr','-subj','/CN='+service]);
   await fs.writeFile(path.join(tls,service+'.ext'),'subjectAltName=DNS:'+service+'\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n',{mode:0o600});
   run(['x509','-req','-in',service+'.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial','-out',service+'.crt','-days','90','-sha256','-extfile',service+'.ext']);
   await fs.chmod(path.join(tls,service+'.key'),0o600);await fs.chmod(path.join(tls,service+'.crt'),0o644);
  }
  await fs.chmod(path.join(tls,'ca.key'),0o600);await fs.chmod(path.join(tls,'ca.crt'),0o644);
  return generated.config;
 }catch{throw new Error('configuration_incomplete_preserved_for_operator_review');}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const args=process.argv.slice(2),input={};
 for(let n=0;n<args.length;n+=2){const key={'--host':'host','--email':'email','--runtime':'runtimeDirectory','--public-site':'publicSiteRoot'}[args[n]];if(!key||!args[n+1])throw Error('Usage: --host <own.domain> --email <operator> --runtime <new-private-directory> --public-site <built-public-directory>');input[key]=args[n+1];}
 writeConfiguration(input).then(config=>console.log(JSON.stringify(config,null,2))).catch(()=>{console.error('Configuration was not completed. Existing files were preserved; no credential values were printed.');process.exitCode=1;});
}
