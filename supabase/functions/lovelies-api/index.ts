import { connectPostgres } from '../../../services/supabase-api/src/database.ts';
import { SupabasePrivateBucket } from '../../../services/supabase-api/src/storage.ts';
import { PostgresJobQueue } from '../../../services/supabase-api/src/jobs.ts';
import { AuthenticatedService } from '../../../services/supabase-api/src/service-fetcher.ts';
import { createModelServices } from '../../../services/supabase-api/src/model-services.ts';
import { createApp, createHandler } from '../../../services/supabase-api/src/index.ts';
import { RestoreJournalClient } from '../../../services/supabase-api/src/restore-journal.ts';
import { RestoreDatabaseFence } from '../../../services/supabase-api/src/restore-database.ts';
import { RestoreExternalEffects } from '../../../services/supabase-api/src/restore-effects.ts';
import type { SupabaseEnv } from '../../../services/supabase-api/src/types.ts';
import { uploadBudgetKeys } from '../../../services/supabase-api/src/upload-budgets.ts';
import { internalEndpoint, internalEndpointPolicy, publicApiBase, type DatabaseTlsPolicy } from '../../../services/supabase-api/src/endpoint-configuration.ts';
import { SupabaseManagedAuth } from '../../../services/supabase-api/src/managed-auth-provider.ts';

const value=(name:string)=>Deno.env.get(name);
const required=(name:string)=>{const result=value(name);if(!result)throw new Error('Missing server configuration: '+name);return result;};
const endpointPolicy=internalEndpointPolicy(value('LOVELIES_INTERNAL_SERVICE_ORIGINS'));
const projectUrl=internalEndpoint(required('INTERNAL_SUPABASE_URL'),endpointPolicy).origin;
const appEnvironment=value('APP_ENV')??'production';
const publicBase=publicApiBase(required('PUBLIC_API_BASE_URL'),appEnvironment);
const keys=value('SUPABASE_SECRET_KEYS');
// Upstream self-hosted Compose can emit {"default":""} while using the
// service-role JWT. An empty optional opaque key is not a selected credential.
const storageSecret=[value('LOVELIES_STORAGE_SECRET'),keys?JSON.parse(keys).default:undefined,value('SUPABASE_SERVICE_ROLE_KEY')]
  .find((candidate):candidate is string=>typeof candidate==='string'&&candidate.trim().length>0);
if(!storageSecret)throw new Error('Server-only Storage secret missing');
// No request/bootstrap fallback: a missing independent service or uninstalled
// database marker makes the production entrypoint unavailable, including jobs.
const journal=new RestoreJournalClient(required('RESTORE_JOURNAL_URL'),required('RESTORE_JOURNAL_TOKEN'));
const db=connectPostgres(value('LOVELIES_DATABASE_URL')??required('SUPABASE_DB_URL'),value('LOVELIES_DATABASE_CA'),new RestoreDatabaseFence(journal),{
  mode:value('LOVELIES_DATABASE_TLS_MODE') as DatabaseTlsPolicy['mode'],
  trustedPlaintextHosts:(value('LOVELIES_DATABASE_PLAINTEXT_HOSTS')??'').split(',').map(host=>host.trim()).filter(Boolean),
});
const effects=new RestoreExternalEffects(journal,()=>db.currentRestoreLineage(),async(bucket,key)=>
  (await db.one<{account_id:string}>('SELECT DISTINCT account_id FROM media_write_intents WHERE bucket=? AND object_key=?',bucket,key))?.account_id??null);
const env:SupabaseEnv={
  APP_ENV:appEnvironment,
  PHOTOS:new SupabasePrivateBucket(projectUrl,storageSecret,'lovelies-photos',fetch,effects.storage('PHOTOS'),endpointPolicy),
  QUARANTINE:new SupabasePrivateBucket(projectUrl,storageSecret,'lovelies-quarantine',fetch,effects.storage('QUARANTINE'),endpointPolicy),
  PRIVACY_EXPORTS:new SupabasePrivateBucket(projectUrl,storageSecret,'lovelies-privacy-exports',fetch,effects.storage('PRIVACY_EXPORTS'),endpointPolicy),
  PHOTO_JOBS:new PostgresJobQueue(db),
  PUBLIC_API_BASE_URL:publicBase,
  MANAGED_AUTH:new SupabaseManagedAuth(projectUrl,required('SUPABASE_ANON_KEY'),required('SUPABASE_SERVICE_ROLE_KEY'),fetch,endpointPolicy),
  MANAGED_AUTH_ENCRYPTION_KEY:required('MANAGED_AUTH_ENCRYPTION_KEY'),
};
for(const name of ['AUTH_SIGNING_SECRET','MEDIA_SIGNING_SECRET','FACE_AUTH_POLICY_VERSION','PHOTO_MODEL_VERSION','PHOTO_CONSENT_POLICY_VERSION','APPLE_BUNDLE_ID','APPLE_APP_ID','APPLE_SUBSCRIPTION_PRODUCT_ID','GOOGLE_PLAY_PACKAGE_NAME','GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID','GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL','GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY','GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY_ID','GOOGLE_PLAY_RTDN_AUDIENCE','GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL','ALLOWED_ORIGINS','PUBLIC_APP_BASE_URL','INTERNAL_MAINTENANCE_SECRET'] as const){
  const configured=value(name);if(configured)env[name]=configured;
}
const inferenceUrl=value('ML_INFERENCE_URL'),inferenceSecret=value('ML_INFERENCE_SECRET');
for(const name of uploadBudgetKeys){const configured=value(name);if(configured)env[name]=configured;}
for(const name of ['PUSH_PROVIDER_GENERATION','PUSH_LEDGER_ID','PUSH_LEDGER_BOOTSTRAP_ID'] as const){const configured=value(name);if(configured)env[name]=configured;}
if(inferenceUrl&&inferenceSecret){
  const model=createModelServices({PHOTOS:env.PHOTOS,QUARANTINE:env.QUARANTINE,MODEL_VERSION:env.PHOTO_MODEL_VERSION??'',FACE_AUTH_POLICY_VERSION:env.FACE_AUTH_POLICY_VERSION??'',
    ENGINE_ARTIFACT_SHA256:value('ML_INFERENCE_ARTIFACT_SHA256'),PROCESSING_FINGERPRINT:value('ML_INFERENCE_PROCESSING_SHA256'),
    INFERENCE:new AuthenticatedService(inferenceUrl,inferenceSecret,fetch,55000,undefined,effects.service('inference'),endpointPolicy)});
  env.FACE_AUTH_VERIFIER=model.face;env.PHOTO_PROCESSOR=model.photo;env.MODEL_SERVICE_READINESS=model.ready;
  // Invalid or absent inference pins leave biometric operations unavailable;
  // anonymous application access still uses the existing handler.
  try{env.INFERENCE_ENGINE_IDENTITY=model.generation();}catch{}
}
for(const [urlName,secretName,binding] of [['STORE_VERIFIER_URL','STORE_VERIFIER_SECRET','STORE_VERIFIER'],['PUSH_SERVICE_URL','PUSH_SERVICE_SECRET','PUSH_SERVICE']] as const){
  const url=value(urlName),secret=value(secretName);if(url&&secret)env[binding]=new AuthenticatedService(url,secret,fetch,55000,undefined,effects.service(binding==='STORE_VERIFIER'?'store':'push'),endpointPolicy);
}
const bindHost=value('LOVELIES_BIND_HOST'),portText=value('PORT');
if(bindHost&&!['127.0.0.1','::1','[::1]'].includes(bindHost))throw new Error('Explicit local bind must be loopback');
if(portText&&(!/^[1-9][0-9]{0,4}$/.test(portText)||Number(portText)>65535))throw new Error('Invalid listener port');
Deno.serve({...bindHost?{hostname:bindHost}:{},...portText?{port:Number(portText)}:{}},createHandler(createApp(db,env)));
