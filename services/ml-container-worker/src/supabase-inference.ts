import {Container} from '@cloudflare/containers';

/** Supabase remains the application authority. This host transports opaque,
 * already-admitted inference JSON; it has no account or Storage credentials. */
export interface SupabaseInferenceEnv {
  ML_SUPABASE_CONTAINER:DurableObjectNamespace<SupabaseInferenceContainer>;
  ML_INFERENCE_SECRET?:string;
  INFERENCE_SERVING_ENABLED?:string;
  INFERENCE_RELEASE_RECEIPT_SHA256?:string;
  INFERENCE_IMAGE_URI?:string;
}
interface InferenceService {fetch(request:Request):Promise<Response>;}
type ServiceFactory=(env:SupabaseInferenceEnv)=>InferenceService;
type RetainCleanup=(task:Promise<void>)=>void;
class ProxyError extends Error {
  constructor(readonly status:number,readonly code:string){super(code);}
}
export const SUPABASE_INFERENCE_LIMITS=Object.freeze({face:12*1024*1024,photo:40*1024*1024,reply:6*1024*1024,deadlineMs:55_000});
const encoder=new TextEncoder();
const json=(code:string,status:number)=>Response.json({error:{code}},{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
function releaseConfigured(env:SupabaseInferenceEnv):boolean {
  // The deployment preparer verifies the accepted receipt and binds its exact
  // immutable registry URI into both Worker vars and containers[0].image.
  return env.INFERENCE_SERVING_ENABLED==='true'&&
    typeof env.INFERENCE_RELEASE_RECEIPT_SHA256==='string'&&/^[a-f0-9]{64}$/.test(env.INFERENCE_RELEASE_RECEIPT_SHA256)&&
    typeof env.INFERENCE_IMAGE_URI==='string'&&/^registry\.cloudflare\.com\/[a-f0-9]{32}\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/.test(env.INFERENCE_IMAGE_URI);
}
function secretConfigured(secret:unknown):secret is string {
  return typeof secret==='string'&&/^[\x21-\x7e]{32,512}$/.test(secret);
}
async function admission(request:Request,env:SupabaseInferenceEnv,https:boolean):Promise<{path:string;limit:number;claimed:number|null}> {
  if(!secretConfigured(env.ML_INFERENCE_SECRET))throw new ProxyError(503,'inference_configuration_required');
  const authorization=request.headers.get('authorization')??'';
  if(authorization.length>4096)throw new ProxyError(401,'service_authentication_required');
  const [provided,expected]=await Promise.all([
    crypto.subtle.digest('SHA-256',encoder.encode(authorization)),
    crypto.subtle.digest('SHA-256',encoder.encode('Bearer '+env.ML_INFERENCE_SECRET)),
  ]);
  // Workers extends WebCrypto with this native constant-time comparison. The
  // bundled WebWorker lib does not include the extension's declaration.
  const subtle=crypto.subtle as SubtleCrypto&{timingSafeEqual(a:ArrayBuffer,b:ArrayBuffer):boolean};
  if(!subtle.timingSafeEqual(provided,expected))throw new ProxyError(401,'service_authentication_required');
  if(!releaseConfigured(env))throw new ProxyError(503,'inference_release_not_accepted');
  const url=new URL(request.url);
  if(https&&url.protocol!=='https:')throw new ProxyError(400,'https_required');
  if(url.search||url.username||url.password||url.hash)throw new ProxyError(404,'route_not_found');
  const path=url.pathname,limit=path==='/internal/face'&&request.method==='POST'?SUPABASE_INFERENCE_LIMITS.face:
    path==='/internal/photo'&&request.method==='POST'?SUPABASE_INFERENCE_LIMITS.photo:
    path==='/ready'&&request.method==='GET'?0:-1;
  if(limit<0||request.headers.has('upgrade'))throw new ProxyError(404,'route_not_found');
  const length=request.headers.get('content-length');let claimed:number|null=null;
  if(length!==null){
    if(!/^\d+$/.test(length))throw new ProxyError(400,'invalid_content_length');
    claimed=Number(length);if(!Number.isSafeInteger(claimed)||claimed>limit)throw new ProxyError(413,'inference_body_too_large');
  }
  if(!limit){if(request.body!==null||claimed&&claimed>0)throw new ProxyError(400,'ready_body_not_allowed');}
  else{
    if(!/^application\/json(?:;|$)/i.test(request.headers.get('content-type')??''))throw new ProxyError(415,'json_required');
    if(!request.body||claimed===0)throw new ProxyError(400,'body_required');
  }
  return {path,limit,claimed};
}

/** The singleton is created in the EU subnamespace. The hint is best effort;
 * the container's WEUR/EU constraints are configured separately and read back
 * by the deployment owner. No global/account/profile registry is introduced. */
export function selectSupabaseContainer(env:SupabaseInferenceEnv):InferenceService {
  const namespace=env.ML_SUPABASE_CONTAINER.jurisdiction('eu');
  return namespace.get(namespace.idFromName('supabase-inference-v1'),{locationHint:'weur'});
}

export function containerEnvironment(env:SupabaseInferenceEnv):Record<string,string> {
  if(!releaseConfigured(env)||!secretConfigured(env.ML_INFERENCE_SECRET))throw new ProxyError(503,'inference_release_not_accepted');
  return {APP_ENV:'production',ML_DEPLOYMENT_MODE:'monitored_pilot',ML_REQUIRE_MODEL_ARTIFACTS:'true',
    ML_USE_DETERMINISTIC_SIMULATOR:'false',ML_DEPLOYMENT_TRANSPORT:'https_service',ML_INFERENCE_SECRET:env.ML_INFERENCE_SECRET};
}

/** The optional factory/deadline are controlled test seams, absent from the
 * deployed bindings. Both public Worker and Container entrypoint enforce the
 * same authentication/release/stream limits. No ambiguous request is retried. */
export async function serveSupabaseInference(request:Request,env:SupabaseInferenceEnv,
  serviceFactory:ServiceFactory=selectSupabaseContainer,deadlineMs=SUPABASE_INFERENCE_LIMITS.deadlineMs,https=true,retainCleanup?:RetainCleanup):Promise<Response> {
  let controller:AbortController|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  let forwarded:Request|undefined,reply:Response|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  let requestFailure:ProxyError|undefined,finished=false;
  const stop=()=>controller?.abort(new ProxyError(503,'inference_cancelled'));
  const finish=()=>{
    if(finished)return;finished=true;clearTimeout(timer);request.signal.removeEventListener('abort',stop);
    controller?.abort(new ProxyError(503,'inference_finished'));
    if(forwarded?.body&&!forwarded.body.locked)void forwarded.body.cancel().catch(()=>{});
  };
  try{
    const {path,limit,claimed}=await admission(request,env,https);
    if(request.signal.aborted)throw new ProxyError(503,'inference_cancelled');
    if(!Number.isSafeInteger(deadlineMs)||deadlineMs<1||deadlineMs>SUPABASE_INFERENCE_LIMITS.deadlineMs)throw new ProxyError(503,'inference_configuration_required');
    controller=new AbortController();const signal=controller.signal;
    request.signal.addEventListener('abort',stop,{once:true});if(request.signal.aborted)stop();
    const aborted=new Promise<never>((_,reject)=>{
      const rejectAbort=()=>reject(signal.reason instanceof ProxyError?signal.reason:new ProxyError(503,'inference_cancelled'));
      signal.addEventListener('abort',rejectAbort,{once:true});if(signal.aborted)rejectAbort();
    });void aborted.catch(()=>{});
    signal.addEventListener('abort',()=>{if(reader)void reader.cancel(signal.reason).catch(()=>{});},{once:true});
    timer=setTimeout(()=>controller!.abort(new ProxyError(503,'inference_timeout')),deadlineMs);
    let received=0;
    const body=limit?request.body!.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({
      transform:(chunk,output)=>{
        received+=chunk.byteLength;
        if(received>limit){requestFailure=new ProxyError(413,'inference_body_too_large');controller!.abort(requestFailure);throw requestFailure;}
        output.enqueue(chunk);
      },
      flush:()=>{
        if(!received||claimed!==null&&received!==claimed){requestFailure=new ProxyError(400,!received?'body_required':'body_length_mismatch');controller!.abort(requestFailure);throw requestFailure;}
      },
    }),{signal}):undefined;
    // Forward only service credentials and content metadata. Cookies, client
    // metadata, arbitrary targets and public cache headers never reach Python.
    forwarded=new Request('http://container'+path,{method:request.method,redirect:'manual',signal,
      headers:{Authorization:'Bearer '+env.ML_INFERENCE_SECRET,'Content-Type':'application/json',...(claimed!==null?{'Content-Length':String(claimed)}:{})},
      ...(body?{body,duplex:'half'}:{})} as RequestInit);
    const pending=serviceFactory(env).fetch(forwarded);
    const cancellation=pending.then(async late=>{if(signal.aborted)await late.body?.cancel().catch(()=>{});},()=>{});
    // A response can resolve after the caller deadline even when a transport
    // ignores abort. Keep only its cancellation observer alive after returning
    // 503, for at most one second after abort; do not extend the request or
    // replay it. Without waitUntil, a Worker may end that observer's context.
    if(retainCleanup)retainCleanup(new Promise<void>(resolve=>{
      let grace:ReturnType<typeof setTimeout>|undefined,done=false;
      const completed=()=>{if(done)return;done=true;clearTimeout(grace);signal.removeEventListener('abort',onAbort);resolve();};
      const onAbort=()=>{grace=setTimeout(completed,1000);};
      signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();
      void cancellation.then(completed,completed);
    }));
    reply=await Promise.race([pending,aborted]);
    if(requestFailure)throw requestFailure;
    if(reply.redirected||reply.status>=300&&reply.status<400)throw new ProxyError(503,'inference_redirect_denied');
    if(!/^application\/json(?:;|$)/i.test(reply.headers.get('content-type')??'')||!reply.body)throw new ProxyError(503,'inference_result_invalid');
    const responseLength=reply.headers.get('content-length');
    if(responseLength!==null&&(!/^\d+$/.test(responseLength)||!Number.isSafeInteger(Number(responseLength))||Number(responseLength)>SUPABASE_INFERENCE_LIMITS.reply))throw new ProxyError(503,'inference_reply_too_large');
    reader=reply.body.getReader();let returned=0;
    const responseBody=new ReadableStream<Uint8Array>({
      pull:async output=>{
        try{
          const next=await Promise.race([reader!.read(),aborted]);
          if(next.done){
            if(responseLength!==null&&returned!==Number(responseLength))throw new ProxyError(503,'inference_result_invalid');
            finish();reader!.releaseLock();output.close();return;
          }
          returned+=next.value.byteLength;
          if(returned>SUPABASE_INFERENCE_LIMITS.reply)throw new ProxyError(503,'inference_reply_too_large');
          output.enqueue(next.value);
        }catch(error){finish();void reader!.cancel(error).catch(()=>{});output.error(error);}
      },
      cancel:async reason=>{finish();try{await reader!.cancel(reason);}finally{reader!.releaseLock();}},
    });
    return new Response(responseBody,{status:reply.status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
      ...(responseLength!==null?{'Content-Length':responseLength}:{})}});
  }catch(error){
    finish();if(reply?.body&&!reply.body.locked)void reply.body.cancel().catch(()=>{});
    if(request.body&&!request.body.locked)void request.body.cancel().catch(()=>{});
    const failure=requestFailure??(error instanceof ProxyError?error:new ProxyError(503,'inference_unavailable'));
    return json(failure.code,failure.status);
  }
}

export class SupabaseInferenceContainer extends Container<SupabaseInferenceEnv> {
  defaultPort=8080;sleepAfter='5m';enableInternet=false;
  constructor(ctx:ConstructorParameters<typeof Container<SupabaseInferenceEnv>>[0],env:SupabaseInferenceEnv){super(ctx,env);this.envVars=containerEnvironment(env);}
  override fetch(request:Request):Promise<Response>{
    return serveSupabaseInference(request,this.env,()=>({fetch:super.fetch.bind(this)}),SUPABASE_INFERENCE_LIMITS.deadlineMs,false,task=>this.ctx.waitUntil(task));
  }
  override onError(_error:unknown){console.error('lovelies_supabase_inference_container_failed');}
}

export default {fetch:(request:Request,env:SupabaseInferenceEnv,ctx:ExecutionContext)=>serveSupabaseInference(request,env,selectSupabaseContainer,
  SUPABASE_INFERENCE_LIMITS.deadlineMs,true,task=>ctx.waitUntil(task))} satisfies ExportedHandler<SupabaseInferenceEnv>;
