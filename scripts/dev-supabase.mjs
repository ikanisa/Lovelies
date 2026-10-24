/** Local loopback HTTP adapter for the production Supabase engine.
 * Uses configured PostgreSQL/Storage/model services; never creates or resets a
 * database, provisions a bucket, imports donor data or simulates authentication.
 */
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {connectPostgres} from '../services/supabase-api/src/database.ts';
import {SupabasePrivateBucket} from '../services/supabase-api/src/storage.ts';
import {PostgresJobQueue} from '../services/supabase-api/src/jobs.ts';
import {AuthenticatedService} from '../services/supabase-api/src/service-fetcher.ts';
import {createModelServices} from '../services/supabase-api/src/model-services.ts';
import {createApp,createHandler} from '../services/supabase-api/src/index.ts';
const required=name=>{const value=process.env[name];if(!value)throw new Error('Missing configuration: '+name);return value;};
const port=Number(process.env.LOVELIES_DEV_PORT??8787);
if(!Number.isSafeInteger(port)||port<1024||port>65535)throw new Error('Invalid loopback port');
const project=new URL(required('SUPABASE_URL'));
if(project.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(project.hostname)||project.username||project.password||project.pathname!=='/'||project.search||project.hash)throw new Error('Invalid Supabase origin');
if(project.protocol==='https:'&&project.hostname!=='ltqfplqevxztlswlzexn.supabase.co')throw new Error('Unexpected Supabase project');
for(const name of ['AUTH_SIGNING_SECRET','MEDIA_SIGNING_SECRET','INTERNAL_MAINTENANCE_SECRET'])if(required(name).length<32)throw new Error('Strong independent secret required: '+name);
const db=connectPostgres(required('LOVELIES_DATABASE_URL'),process.env.LOVELIES_DATABASE_CA);
const env={...process.env,APP_ENV:'local',PUBLIC_API_BASE_URL:`http://127.0.0.1:${port}`,
 PHOTOS:new SupabasePrivateBucket(project.href,required('LOVELIES_STORAGE_SECRET'),'lovelies-photos'),
 QUARANTINE:new SupabasePrivateBucket(project.href,required('LOVELIES_STORAGE_SECRET'),'lovelies-quarantine'),
 PRIVACY_EXPORTS:new SupabasePrivateBucket(project.href,required('LOVELIES_STORAGE_SECRET'),'lovelies-privacy-exports'),
 PHOTO_JOBS:new PostgresJobQueue(db)};
for(const key of ['FACE_AUTH_POLICY_VERSION','PHOTO_MODEL_VERSION','PHOTO_CONSENT_POLICY_VERSION'])required(key);
if(process.env.ML_INFERENCE_URL&&process.env.ML_INFERENCE_SECRET){
 const services=createModelServices({PHOTOS:env.PHOTOS,QUARANTINE:env.QUARANTINE,MODEL_VERSION:env.PHOTO_MODEL_VERSION,FACE_AUTH_POLICY_VERSION:env.FACE_AUTH_POLICY_VERSION,
 ENGINE_ARTIFACT_SHA256:process.env.ML_INFERENCE_ARTIFACT_SHA256,PROCESSING_FINGERPRINT:process.env.ML_INFERENCE_PROCESSING_SHA256,
 INFERENCE:new AuthenticatedService(process.env.ML_INFERENCE_URL,process.env.ML_INFERENCE_SECRET)});env.FACE_AUTH_VERIFIER=services.face;env.PHOTO_PROCESSOR=services.photo;env.MODEL_SERVICE_READINESS=services.ready;
}
if(process.env.PUSH_SERVICE_URL&&process.env.PUSH_SERVICE_SECRET)env.PUSH_SERVICE=new AuthenticatedService(process.env.PUSH_SERVICE_URL,process.env.PUSH_SERVICE_SECRET);
const handler=createHandler(createApp(db,env));
const server=createServer(async(req,res)=>{
 try{
  const request=new Request(`http://127.0.0.1:${port}${req.url}`,{method:req.method,headers:req.headers,
   ...(['GET','HEAD'].includes(req.method)?{}:{body:Readable.toWeb(req),duplex:'half'})});
  const response=await handler(request);res.writeHead(response.status,Object.fromEntries(response.headers));
  if(response.body)Readable.fromWeb(response.body).pipe(res);else res.end();
 }catch{res.writeHead(503,{'content-type':'application/json','cache-control':'no-store'});res.end('{"error":{"code":"local_api_unavailable"}}');}
});
server.listen(port,'127.0.0.1',()=>console.log(`Lovelies Supabase API: http://127.0.0.1:${port}; configured private services; no automatic migrations.`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.close();void db.close().finally(()=>process.exit());});
