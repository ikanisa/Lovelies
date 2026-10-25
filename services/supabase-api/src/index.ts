import { handleAudience } from './audience.ts';
import { authenticate, assertActor, handleAuth } from './auth.ts';
import { handleFaceAuth } from './face-auth.ts';
import { handleFaceProfile } from './face-profile.ts';
import { handleSharing } from './sharing.ts';
import { handleGallery } from './gallery.ts';
import { handleProfile } from './profile.ts';
import { handleIdentity } from './identity.ts';
import { handleEntitlements } from './entitlements.ts';
import { handleOperators } from './operators.ts';
import { handleAdminUsers } from './admin-users.ts';
import { handleNotifications } from './notifications.ts';
import { handleRetention } from './retention.ts';
import { handleProcessing } from './processing.ts';
import { handlePrivacy } from './privacy.ts';
import { ApiError, digest, ok, type AppContext, type Database, type SupabaseEnv } from './types.ts';
import { currentSchemaVersion } from './schema.ts';
import { maintain } from './jobs.ts';

export function createApp(db:Database,env:SupabaseEnv,now=Date.now):AppContext {
  const app:AppContext={db,env,now,authenticate:request=>authenticate(request,app),assertActor:actor=>assertActor(actor,app)};return app;
}
function failure(error:unknown):Response {
  if(error instanceof ApiError)return ok({error:{code:error.code}},error.status);
  console.error('lovelies_api_failure',error instanceof Error?error.name:'unknown');return ok({error:{code:'internal_error'}},500);
}
function missingConfiguration(env:SupabaseEnv):string[]{
  const missing:string[]=[];
  for(const key of ['PHOTOS','QUARANTINE','PRIVACY_EXPORTS','PHOTO_JOBS','FACE_AUTH_VERIFIER','PHOTO_PROCESSOR','MODEL_SERVICE_READINESS'] as const)if(!env[key])missing.push(key);
  for(const key of ['AUTH_SIGNING_SECRET','MEDIA_SIGNING_SECRET','INTERNAL_MAINTENANCE_SECRET'] as const)if((env[key]?.length??0)<32)missing.push(key);
  for(const key of ['FACE_AUTH_POLICY_VERSION','PHOTO_MODEL_VERSION','PUBLIC_API_BASE_URL'] as const)if(!env[key]?.trim())missing.push(key);
  return missing;
}
async function limitAuth(request:Request,ctx:AppContext,lane:string):Promise<void>{
  const slot=Math.floor(ctx.now()/60000);
  // Validate the gateway's trusted proxy chain before relying on per-IP limits.
  // Raw addresses are never retained.
  const address=(request.headers.get('x-forwarded-for')??'gateway-unavailable').split(',').at(-1)!.trim();
  const key=await digest(`${lane}:${slot}:${address}`);
  await ctx.db.transaction(async()=>{
    await ctx.db.run('DELETE FROM request_limits WHERE expires_at<?',ctx.now());
    const prior=await ctx.db.one<{hits:number}>('SELECT hits FROM request_limits WHERE key=?',key);
    if(prior&&prior.hits>=(lane==='profile'?120:30))throw new ApiError(429,'authentication_rate_limited');
    await ctx.db.run('INSERT INTO request_limits(key,hits,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET hits=request_limits.hits+1',key,(slot+2)*60000);
  });
}
async function maintenanceAuthorized(request:Request,env:SupabaseEnv):Promise<boolean>{
  const secret=env.INTERNAL_MAINTENANCE_SECRET;if(!secret||secret.length<32)return false;
  const candidate=request.headers.get('authorization')??'';
  return (await digest(candidate))===(await digest('Bearer '+secret));
}
async function databaseVersion(ctx:AppContext):Promise<number|null>{
  const row=await ctx.db.one<{version:number|null}>('SELECT MAX(version) version FROM schema_versions');
  return row?.version??null;
}
async function requireCurrentDatabase(ctx:AppContext):Promise<void>{
  // Check each request: a running isolate must also stop after schema drift.
  // This guards version compatibility; it is not a restore-suppression ledger.
  if(await databaseVersion(ctx)!==currentSchemaVersion)throw new ApiError(503,'database_schema_not_ready');
}
export function normalizedRequest(request:Request):Request {
  const url=new URL(request.url);
  for(const prefix of ['/functions/v1/lovelies-api','/lovelies-api']){
    if(url.pathname===prefix||url.pathname.startsWith(prefix+'/')){url.pathname=url.pathname.slice(prefix.length)||'/';break;}
  }
  return new Request(url,request);
}
export function createHandler(ctx:AppContext):(request:Request)=>Promise<Response>{
  return async incoming=>{
    const request=normalizedRequest(incoming),origin=request.headers.get('origin');
    const allowed=new Set((ctx.env.ALLOWED_ORIGINS??'').split(',').map(x=>x.trim()).filter(Boolean));
    if(ctx.env.PUBLIC_APP_BASE_URL)allowed.add(ctx.env.PUBLIC_APP_BASE_URL);
    let response:Response;
    try{
      if(origin&&!allowed.has(origin))throw new ApiError(403,'origin_not_allowed');
      const path=new URL(request.url).pathname;
      if(request.method==='OPTIONS'){
        if(!origin)throw new ApiError(403,'origin_required');
        response=new Response(null,{status:204,headers:{'Access-Control-Allow-Methods':'GET,POST,PUT,PATCH,DELETE,OPTIONS','Access-Control-Allow-Headers':'Authorization,Content-Type,X-Lovelies-Capture-SHA256,X-Lovelies-Device-Signature,X-Lovelies-Capture-Bytes,X-Lovelies-Chunk-SHA256','Access-Control-Max-Age':'600'}});
      }else if(request.method==='GET'&&(path==='/health'||path==='/ready')){
        const version=await databaseVersion(ctx),ready=version===currentSchemaVersion;
        const missing=path==='/ready'?missingConfiguration(ctx.env):[];
        let inferenceReady:boolean|undefined;
        if(path==='/ready'){
          inferenceReady=false;
          if(ready)try{inferenceReady=!!ctx.env.MODEL_SERVICE_READINESS&&await ctx.env.MODEL_SERVICE_READINESS(request.signal)===true;}catch{inferenceReady=false;}
        }
        const available=ready&&!missing.length&&inferenceReady!==false;
        response=ok({status:available?'ok':'unavailable',service:'lovelies-supabase-api',database:'supabase_postgresql',database_ready:ready,schema_version:version,missing,
          ...(path==='/ready'?{inference_ready:inferenceReady}:{}),verification:'registered_face_comparison',liveness_required:false,hosted_provider_acceptance:false},available?200:503);
      }else if(path==='/_internal/maintenance'&&request.method==='POST'){
        if(!await maintenanceAuthorized(request,ctx.env))throw new ApiError(404,'route_not_found');
        await requireCurrentDatabase(ctx);
        const result=await maintain(ctx);response=ok(result,result.maintenance_errors||result.failed?503:200);
      }else{
        if(path.startsWith('/_internal'))throw new ApiError(404,'route_not_found');
        await requireCurrentDatabase(ctx);
        if(path==='/auth/anonymous'&&request.method==='POST')await limitAuth(request,ctx,'anonymous');
        if(path.startsWith('/auth/face/recovery/'))await limitAuth(request,ctx,'recovery');
        if(path.startsWith('/auth/face/profile/'))await limitAuth(request,ctx,'profile');
        let handled:Response|null=null;
        for(const handler of [handleAuth,handleAudience,handleFaceProfile,handleFaceAuth,handleIdentity,handleProfile,handleProcessing,handleSharing,handleGallery,handleEntitlements,handleOperators,handleAdminUsers,handleNotifications,handleRetention,handlePrivacy]){
          handled=await handler(request,ctx);if(handled)break;
        }
        if(!handled)throw new ApiError(404,'route_not_found');response=handled;
      }
    }catch(error){response=failure(error);}
    finally{if(request.body&&!request.body.locked)await request.body.cancel().catch(()=>{});}
    const headers=new Headers(response.headers);headers.set('Cache-Control','no-store, private');headers.set('X-Content-Type-Options','nosniff');headers.set('Vary','Origin');
    if(origin&&allowed.has(origin))headers.set('Access-Control-Allow-Origin',origin);else headers.delete('Access-Control-Allow-Origin');
    return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
  };
}
