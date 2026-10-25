/** Local-only main-service fixture for the cached Supabase Edge Runtime.
 * Mount a generated worker directory whose index.ts imports and serves
 * model-resource-probe.ts. Root starts/stops the container and preserves logs.
 * This uses the versioned 1.74.3 userWorkers API, not V8 heap flags.
 * API reference: https://github.com/supabase/edge-runtime/blob/v1.74.3/examples/main/index.ts
 */
declare const EdgeRuntime:{userWorkers:{create(options:Record<string,unknown>):Promise<{fetch(request:Request):Promise<Response>}>}};
const limits={memoryLimitMb:256,workerTimeoutMs:150000,cpuTimeSoftLimitMs:2000,cpuTimeHardLimitMs:2000};
console.log(JSON.stringify({scope:'local model adapter transport resource fixture',limits,recognition:false}));
Deno.serve(async request=>{
  if(new URL(request.url).pathname==='/health')return Response.json({fixture:true,limits});
  const servicePath=Deno.env.get('LOVELIES_RESOURCE_WORKER_PATH');
  if(!servicePath)return Response.json({error:'resource_worker_path_required'},{status:503});
  const modelModule=Deno.env.get('LOVELIES_RESOURCE_MODEL_MODULE');
  try{
    const worker=await EdgeRuntime.userWorkers.create({servicePath,...limits,forceCreate:true,noModuleCache:true,
      allowRemoteModules:false,envVars:modelModule?[['LOVELIES_RESOURCE_MODEL_MODULE',modelModule]]:[]});
    return await worker.fetch(request);
  }catch(error){
    const code=error instanceof Error?error.name:'edge_worker_failure';
    console.error(JSON.stringify({event:'resource_fixture_worker_failed',code}));
    return Response.json({status:'failed',scope:'actual configured Edge worker supervisor',error:code,limits},{status:546});
  }
});
