/** Local-only supervisor. Every application request, including health, reaches
 * the unchanged production Edge entrypoint. This file has no app/test routes.
 * Pinned SDK: https://github.com/supabase/edge-runtime/blob/v1.77.8/ext/workers/user_workers.js
 */
declare const EdgeRuntime:{userWorkers:{create(options:Record<string,unknown>):Promise<{
  fetch(request:Request,options?:{signal?:AbortSignal}):Promise<Response>;
}>}};

const servicePath='/workspace/supabase/functions/lovelies-api';
const limits={memoryLimitMb:256,cpuTimeSoftLimitMs:2000,cpuTimeHardLimitMs:2000,workerTimeoutMs:150000};
// Never pass the supervisor's entire environment to application isolates.
const allowed=[
  'APP_ENV','SUPABASE_URL','LOVELIES_DATABASE_URL','LOVELIES_STORAGE_SECRET',
  'AUTH_SIGNING_SECRET','MEDIA_SIGNING_SECRET','INTERNAL_MAINTENANCE_SECRET',
  'FACE_AUTH_POLICY_VERSION','PHOTO_MODEL_VERSION','PHOTO_CONSENT_POLICY_VERSION',
  'PUBLIC_API_BASE_URL','ALLOWED_ORIGINS','PUBLIC_APP_BASE_URL',
  'ML_INFERENCE_URL','ML_INFERENCE_SECRET','ML_INFERENCE_ARTIFACT_SHA256','ML_INFERENCE_PROCESSING_SHA256',
  'RESTORE_JOURNAL_URL','RESTORE_JOURNAL_TOKEN',
] as const;
const envVars=allowed.flatMap(name=>{
  const value=Deno.env.get(name);return value===undefined?[]:[[name,value]];
});
let requestsAwaitingHeaders=0;
const failureNames=new Set(['Error','TypeError','RangeError','AbortError','TimeoutError',
  'DOMException','InvalidWorkerCreation']);
Deno.serve(async request=>{
  requestsAwaitingHeaders++;
  let stage:'acquisition'|'fetch'='acquisition';
  try{
    // Acquire from the pinned SDK pool for each NEW request. forceCreate:false
    // reuses eligible isolates and skips retired UUIDs. CLI per_request resets
    // the 2000-ms CPU budget for each request and returns completed workers to
    // the pool; retaining a JS handle would bypass those admission checks.
    // https://github.com/supabase/edge-runtime/blob/v1.77.8/crates/base/src/worker/pool.rs
    const worker=await EdgeRuntime.userWorkers.create({
      servicePath,...limits,forceCreate:false,noModuleCache:false,allowRemoteModules:false,
      envVars,context:{importMapPath:servicePath+'/deno.json'},
    });
    // Never retry the current fetch: its external effect may be unknown.
    stage='fetch';
    return await worker.fetch(request,{signal:request.signal});
  }catch(error){
    const name=error instanceof Error&&failureNames.has(error.name)?error.name:'UnknownWorkerFailure';
    console.error(JSON.stringify({event:'isolated_edge_worker_failure',name,stage,
      requests_awaiting_headers:Math.min(requestsAwaitingHeaders,1024),
      requests_awaiting_headers_capped:requestsAwaitingHeaders>1024}));
    return Response.json({error:{code:'edge_worker_unavailable'}},
      {status:503,headers:{'cache-control':'no-store, private'}});
  }finally{
    requestsAwaitingHeaders--;
  }
});
