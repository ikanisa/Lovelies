import { connectPostgres } from '../../../services/supabase-api/src/database.ts';
import { SupabasePrivateBucket } from '../../../services/supabase-api/src/storage.ts';
import { PostgresJobQueue } from '../../../services/supabase-api/src/jobs.ts';
import { AuthenticatedService } from '../../../services/supabase-api/src/service-fetcher.ts';
import { createModelServices } from '../../../services/supabase-api/src/model-services.ts';
import { createApp, createHandler } from '../../../services/supabase-api/src/index.ts';
import type { SupabaseEnv } from '../../../services/supabase-api/src/types.ts';

const value=(name:string)=>Deno.env.get(name);
const required=(name:string)=>{const result=value(name);if(!result)throw new Error('Missing server configuration: '+name);return result;};
const projectUrl=required('SUPABASE_URL');
const project=new URL(projectUrl);
if(project.hostname!=='ltqfplqevxztlswlzexn.supabase.co'&&!['localhost','127.0.0.1','kong'].includes(project.hostname))throw new Error('Unexpected Supabase project');
const keys=value('SUPABASE_SECRET_KEYS');
const storageSecret=value('LOVELIES_STORAGE_SECRET')??(keys?JSON.parse(keys).default:undefined)??value('SUPABASE_SERVICE_ROLE_KEY');
if(!storageSecret)throw new Error('Server-only Storage secret missing');
const db=connectPostgres(value('LOVELIES_DATABASE_URL')??required('SUPABASE_DB_URL'),value('LOVELIES_DATABASE_CA'));
const env:SupabaseEnv={
  APP_ENV:value('APP_ENV')??'production',
  PHOTOS:new SupabasePrivateBucket(projectUrl,storageSecret,'lovelies-photos'),
  QUARANTINE:new SupabasePrivateBucket(projectUrl,storageSecret,'lovelies-quarantine'),
  PRIVACY_EXPORTS:new SupabasePrivateBucket(projectUrl,storageSecret,'lovelies-privacy-exports'),
  PHOTO_JOBS:new PostgresJobQueue(db),
  PUBLIC_API_BASE_URL:value('PUBLIC_API_BASE_URL')??project.origin+'/functions/v1/lovelies-api',
};
for(const name of ['AUTH_SIGNING_SECRET','MEDIA_SIGNING_SECRET','FACE_AUTH_POLICY_VERSION','PHOTO_MODEL_VERSION','PHOTO_CONSENT_POLICY_VERSION','APPLE_BUNDLE_ID','APPLE_APP_ID','APPLE_SUBSCRIPTION_PRODUCT_ID','GOOGLE_PLAY_PACKAGE_NAME','GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID','GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL','GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY','GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY_ID','GOOGLE_PLAY_RTDN_AUDIENCE','GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL','ALLOWED_ORIGINS','PUBLIC_APP_BASE_URL','INTERNAL_MAINTENANCE_SECRET'] as const){
  const configured=value(name);if(configured)env[name]=configured;
}
const inferenceUrl=value('ML_INFERENCE_URL'),inferenceSecret=value('ML_INFERENCE_SECRET');
if(inferenceUrl&&inferenceSecret){
  const model=createModelServices({PHOTOS:env.PHOTOS,QUARANTINE:env.QUARANTINE,MODEL_VERSION:env.PHOTO_MODEL_VERSION??'',FACE_AUTH_POLICY_VERSION:env.FACE_AUTH_POLICY_VERSION??'',INFERENCE:new AuthenticatedService(inferenceUrl,inferenceSecret)});
  env.FACE_AUTH_VERIFIER=model.face;env.PHOTO_PROCESSOR=model.photo;
}
for(const [urlName,secretName,binding] of [['STORE_VERIFIER_URL','STORE_VERIFIER_SECRET','STORE_VERIFIER'],['PUSH_SERVICE_URL','PUSH_SERVICE_SECRET','PUSH_SERVICE']] as const){
  const url=value(urlName),secret=value(secretName);if(url&&secret)env[binding]=new AuthenticatedService(url,secret);
}
const bindHost=value('LOVELIES_BIND_HOST'),portText=value('PORT');
if(bindHost&&!['127.0.0.1','::1','[::1]'].includes(bindHost))throw new Error('Explicit local bind must be loopback');
if(portText&&(!/^[1-9][0-9]{0,4}$/.test(portText)||Number(portText)>65535))throw new Error('Invalid listener port');
Deno.serve({...bindHost?{hostname:bindHost}:{},...portText?{port:Number(portText)}:{}},createHandler(createApp(db,env)));
