#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHmac,timingSafeEqual,X509Certificate} from 'node:crypto';
import {PROJECT_ID,UPSTREAM_COMMIT,POSTGRES_IMAGE,EDGE_IMAGE} from './local-supabase-configure.mjs';
import {args,runtime,sha256,compose,requireCompose,writeReceipt} from './local-supabase-common.mjs';
import {requireOpenLifecycle,privateRead} from './local-supabase-lifecycle.mjs';
import {parseEnv} from './local-supabase-configure.mjs';

export function validateValues(r){
 const errors=[],warnings=[];const require=(pass,code)=>{if(!pass)errors.push(code);};
 const {app,api,push,custody,config}=r;
 let publicURL;try{publicURL=new URL(config.public_supabase_url);}catch{}
 require(publicURL?.protocol==='https:'&&!publicURL.username&&!publicURL.password&&!publicURL.search&&!publicURL.hash&&publicURL.pathname==='/'&&publicURL.hostname===app.PUBLIC_HOST&&publicURL.hostname!=='supabase.co'&&!publicURL.hostname.endsWith('.supabase.co'),'public_origin_invalid');
 require(config.project_id===PROJECT_ID&&config.expected_schema_version===19&&config.upstream_commit===UPSTREAM_COMMIT&&config.postgres_image===POSTGRES_IMAGE&&config.edge_runtime_image===EDGE_IMAGE,'deployment_pin_mismatch');
 require(config.public_site_root===path.join(config.static_root??'','public')&&app.LOVELIES_STATIC_ROOT===config.static_root,'staged_public_root_mismatch');
 require(api.PUBLIC_API_BASE_URL===config.public_api_base_url&&api.PUBLIC_API_BASE_URL===config.public_supabase_url+'/functions/v1/lovelies-api','public_api_path_mismatch');
 require(api.INTERNAL_SUPABASE_URL==='http://api-gw:8000'&&config.internal_supabase_url===api.INTERNAL_SUPABASE_URL,'internal_gateway_mismatch');
 require((api.LOVELIES_INTERNAL_SERVICE_ORIGINS??'').split(',').includes(api.INTERNAL_SUPABASE_URL),'internal_origin_not_trusted');
 require(app.API_EXTERNAL_URL===config.public_supabase_url+'/auth/v1','auth_issuer_path_mismatch');
 require(app.ENABLE_ANONYMOUS_USERS==='true'&&app.DISABLE_SIGNUP==='false'&&['ENABLE_EMAIL_SIGNUP','ENABLE_EMAIL_AUTOCONFIRM','ENABLE_PHONE_SIGNUP','ENABLE_PHONE_AUTOCONFIRM'].every(key=>app[key]==='false'),'managed_anonymous_profile_invalid');
 require(api.RESTORE_JOURNAL_URL===config.restore_journal_url&&api.RESTORE_JOURNAL_URL==='https://restore-journal:8443'&&push.PUSH_LEDGER_URL===config.push_ledger_url&&push.PUSH_LEDGER_URL==='https://push-ledger:8443','custody_origin_mismatch');
 require(api.RESTORE_JOURNAL_TOKEN===custody.RESTORE_JOURNAL_TOKEN&&push.PUSH_LEDGER_TOKEN===custody.PUSH_LEDGER_TOKEN&&api.PUSH_SERVICE_SECRET===push.PUSH_SERVICE_SECRET,'service_secret_binding_mismatch');
 require(api.PUSH_LEDGER_ID===custody.PUSH_LEDGER_ID&&push.PUSH_LEDGER_ID===custody.PUSH_LEDGER_ID&&api.PUSH_LEDGER_BOOTSTRAP_ID===custody.PUSH_LEDGER_BOOTSTRAP_ID&&push.PUSH_LEDGER_BOOTSTRAP_ID===custody.PUSH_LEDGER_BOOTSTRAP_ID&&push.PUSH_PROVIDER_GENERATION===api.PUSH_PROVIDER_GENERATION,'push_binding_mismatch');
 require(api.SUPABASE_ANON_KEY===app.ANON_KEY&&api.SUPABASE_SERVICE_ROLE_KEY===app.SERVICE_ROLE_KEY,'managed_auth_key_mismatch');
 require(r.ml?.ML_INFERENCE_SECRET===api.ML_INFERENCE_SECRET&&r.ml?.ML_DEPLOYMENT_TRANSPORT==='https_service'&&r.ml?.ML_USE_DETERMINISTIC_SIMULATOR==='false'&&api.ML_INFERENCE_URL==='https://ml-proxy:8443','inference_transport_mismatch');
 for(const [key,role] of [['ANON_KEY','anon'],['SERVICE_ROLE_KEY','service_role']]){
  try{const parts=app[key].split('.'),claims=JSON.parse(Buffer.from(parts[1],'base64url')),expected=createHmac('sha256',app.JWT_SECRET).update(parts.slice(0,2).join('.')).digest();
   const signature=Buffer.from(parts[2],'base64url');require(parts.length===3&&claims.role===role&&claims.exp*1000>Date.now()+30*86400000&&expected.length===signature.length&&timingSafeEqual(expected,signature),'supabase_'+role+'_key_invalid_or_expiring');
  }catch{errors.push('supabase_'+role+'_key_invalid');}
 }
 const secrets=[app.POSTGRES_PASSWORD,app.LOVELIES_API_DATABASE_PASSWORD,app.JWT_SECRET,custody.CUSTODY_POSTGRES_PASSWORD,custody.CUSTODY_JOURNAL_PASSWORD,custody.CUSTODY_PUSH_PASSWORD,custody.RESTORE_JOURNAL_TOKEN,custody.RESTORE_JOURNAL_BOOTSTRAP_TOKEN,custody.RESTORE_JOURNAL_OBSERVER_TOKEN,custody.CUSTODY_HEALTH_TOKEN,custody.PUSH_LEDGER_TOKEN,custody.PUSH_LEDGER_BOOTSTRAP_TOKEN,api.AUTH_SIGNING_SECRET,api.MEDIA_SIGNING_SECRET,api.MANAGED_AUTH_ENCRYPTION_KEY,api.INTERNAL_MAINTENANCE_SECRET,api.PUSH_SERVICE_SECRET];
 require(secrets.every(value=>typeof value==='string'&&value.length>=32)&&new Set(secrets).size===secrets.length,'secret_strength_or_separation_invalid');
 require(Buffer.from(api.MANAGED_AUTH_ENCRYPTION_KEY??'','base64').length===32,'managed_auth_aes_key_invalid');
 require(!Object.hasOwn(api,'RESTORE_JOURNAL_BOOTSTRAP_TOKEN')&&!Object.hasOwn(api,'PUSH_LEDGER_BOOTSTRAP_TOKEN'),'operator_secret_exposed_to_api');
 require(api.LOVELIES_DATABASE_TLS_MODE==='disable-internal'&&api.LOVELIES_DATABASE_PLAINTEXT_HOSTS==='db','database_transport_profile_mismatch');
 try{const db=new URL(api.LOVELIES_DATABASE_URL);require(db.hostname==='db'&&db.username==='lovelies_runtime'&&db.password===app.LOVELIES_API_DATABASE_PASSWORD&&db.pathname==='/postgres'&&!db.search&&!db.hash,'database_binding_mismatch');}catch{errors.push('database_url_invalid');}
 if(Number(app.LOVELIES_SERVICE_UID)===0)warnings.push('container_service_uid_is_root_use_a_dedicated_operator_account');
 if(push.PUSH_PROVIDER_SEND_ENABLED!=='true')warnings.push('provider_sends_disabled_pending_real_provider_qualification');
 if(['FACE_AUTH_POLICY_VERSION','PHOTO_MODEL_VERSION','PHOTO_CONSENT_POLICY_VERSION'].some(key=>!api[key]))warnings.push('inference_policy_pins_not_configured_readiness_must_fail');
 warnings.push('anonymous_auth_limit_is_aggregate_requires_load_qualification');
 return {errors:[...new Set(errors)],warnings};
}
export async function checkConfiguration(r,{docker=false}={}){
 const result=validateValues(r),manifest=JSON.parse(await fs.readFile(path.join(r.config.deployment_root,'UPSTREAM.json'),'utf8'));
 try{await requireOpenLifecycle(r.directory,r.api.MANAGED_AUTH_ENCRYPTION_KEY);
  const rotation=parseEnv((await privateRead(path.join(r.directory,'rotation.env'))).toString());
  const url=new URL(rotation.LOVELIES_ROTATION_DATABASE_URL);
  if(url.protocol!=='postgres:'||url.hostname!=='db'||url.username!=='lovelies_rotation'||!/^\w{64}$/.test(url.password)||url.pathname!=='/postgres'||url.search||url.hash)throw Error();
 }catch{result.errors.push('managed_auth_rotation_or_lifecycle_configuration_invalid');}
 try{
  const directory=r.config.static_root,stage=JSON.parse(await fs.readFile(path.join(directory,'local-supabase-static-manifest.json'),'utf8'));
  if(stage.protocol!=='lovelies-local-public-stage-v1'||!Array.isArray(stage.files)||!stage.files.length)throw Error();
  const expected=new Set();for(const file of stage.files){
   if(typeof file.path!=='string'||file.path.includes('..')||file.path.startsWith('/')||file.path.includes('\\')||/\.test\.[cm]?js$/.test(file.path)||!file.path.match(/^(public|admin|clients\/backend|shared)\//))throw Error();
   if(expected.has(file.path))throw Error();expected.add(file.path);
   const target=path.join(directory,file.path),info=await fs.lstat(target);if(!info.isFile()||sha256(await fs.readFile(target))!==file.sha256)throw Error();
  }
  const walk=async(relative='')=>{for(const entry of await fs.readdir(path.join(directory,relative),{withFileTypes:true})){
   const file=relative?relative+'/'+entry.name:entry.name;if(entry.isSymbolicLink())throw Error();if(entry.isDirectory())await walk(file);else if(file!=='local-supabase-static-manifest.json'&&!expected.has(file))throw Error();
  }};await walk();
 }catch{result.errors.push('public_static_stage_missing_modified_or_contains_unlisted_files');}
 const files=Array.isArray(manifest.files)?manifest.files:Object.entries(manifest.files).map(([name,value])=>({path:name,...(typeof value==='string'?{sha256:value}:value)}));
 for(const file of files){const name=file.path??file.file;try{if(sha256(await fs.readFile(path.join(r.config.deployment_root,'upstream',name)))!==file.sha256)result.errors.push('upstream_hash_mismatch:'+name);}catch{result.errors.push('upstream_file_missing:'+name);}}
 for(const name of ['restore-journal','push-ledger','ml-proxy']){
  try{const ca=new X509Certificate(await fs.readFile(path.join(r.directory,'tls/ca.crt'))),cert=new X509Certificate(await fs.readFile(path.join(r.directory,'tls',name+'.crt')));
   if(!cert.verify(ca.publicKey)||!cert.checkHost(name)||Date.parse(cert.validTo)<Date.now()+14*86400000)result.errors.push('custody_certificate_invalid_or_expiring:'+name);
  }catch{result.errors.push('custody_certificate_unavailable:'+name);}
 }
 if(docker){await requireCompose();for(const project of ['application','custody']){
  const out=await compose(r,project,['config','--format','json']);const config=JSON.parse(out.stdout.toString());
  for(const [service,value] of Object.entries(config.services))for(const port of value.ports??[]){
   if(!(project==='application'&&service==='public-proxy'&&[80,443].includes(Number(port.target))||project==='application'&&service==='studio'&&port.host_ip==='127.0.0.1'&&Number(port.target)===3000))result.errors.push('unexpected_published_port:'+service);
  }
  if(project==='custody'&&Object.values(config.volumes??{}).some(value=>value.external!==true))result.errors.push('custody_volume_not_external');
 }}
 return {protocol:'lovelies-local-supabase-config-check-v1',checked_at:new Date().toISOString(),status:result.errors.length?'failed':'configuration_valid_not_host_qualified',docker_compose_validated:docker,...result};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const options=args(process.argv.slice(2),['--runtime','--docker','--receipt'],['--docker']);
 (async()=>{const report=await checkConfiguration(await runtime(options['--runtime']),{docker:!!options['--docker']});if(options['--receipt'])await writeReceipt(options['--receipt'],report);console.log(JSON.stringify(report,null,2));if(report.errors.length)process.exitCode=1;})().catch(()=>{console.error('Configuration check could not complete. No credentials were printed.');process.exitCode=1;});
}
