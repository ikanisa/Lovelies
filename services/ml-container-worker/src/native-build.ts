import {Container} from '@cloudflare/containers';

/** Temporary build infrastructure. No application, model or provider credentials
 * enter this Container. Commands are available only through provider SSH; this
 * Worker exposes authenticated start/state/stop and fixed opaque technical
 * input/artifact transfers, never a shell. */
interface NativeBuildEnv {
  NATIVE_BUILD:DurableObjectNamespace<NativeBuildContainer>;
  BUILD_CONTROL_SECRET?:string;
  BUILD_EXPIRES_AT?:string;
  // Temporary opaque native-build inputs only. No application media or authority.
  BUILD_INPUTS?:R2Bucket;
  BUILD_INPUT_MANIFEST?:string;
  BUILD_ARTIFACTS?:R2Bucket;
  BUILD_ARTIFACT_MANIFEST?:string;
}
function buildInputs(value:unknown,artifact=false):Map<string,number>|null {
  if(typeof value!=='string'||value.length>(artifact?8192:4096))return null;
  try{
    const entries:unknown=JSON.parse(value);if(!Array.isArray(entries)||entries.length>(artifact?32:8))return null;
    const admitted=new Map<string,number>();let total=0;
    for(const entry of entries){
      if(!entry||typeof entry!=='object'||Array.isArray(entry)||Object.keys(entry).length!==2||
        typeof entry.sha256!=='string'||!/^[a-f0-9]{64}$/.test(entry.sha256)||!Number.isSafeInteger(entry.bytes)||
        entry.bytes<1||entry.bytes>(artifact?67108864:314572800)||admitted.has(entry.sha256))return null;
      total+=entry.bytes;if(artifact&&total>2147483648)return null;
      admitted.set(entry.sha256,entry.bytes);
    }
    return admitted;
  }catch{return null;}
}
function artifactChecksum(object:R2Object,digest:string):boolean {
  const value=object.checksums?.sha256;
  return value instanceof ArrayBuffer&&value.byteLength===32&&
    [...new Uint8Array(value)].map(byte=>byte.toString(16).padStart(2,'0')).join('')===digest;
}
export class NativeBuildContainer extends Container<NativeBuildEnv> {
  sleepAfter='15m';enableInternet=true;
  // An independent one-hour process limit bounds unattended build capacity.
  // The daemon socket is Unix-only; no Docker TCP/API port is exposed.
  entrypoint=['sh','-c',
    'dockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock --iptables=false --ip6tables=false --ip-forward=false >/tmp/dockerd.log 2>&1 & daemon=$!; trap \'kill "$daemon" 2>/dev/null || true\' EXIT INT TERM; sleep 3600 & wait $!'];
  async begin(){await this.start();this.renewActivityTimeout();return this.getState();}
  async inspect(){this.renewActivityTimeout();return this.getState();}
  async end(){await this.stop();return this.getState();}
  override async fetch(_request:Request){return new Response('No container HTTP routes',{status:404});}
  override onError(_error:unknown){console.error('lovelies_native_build_container_failed');}
}

export default {async fetch(request:Request,env:NativeBuildEnv,ctx:ExecutionContext):Promise<Response>{
  const response=(code:string,status:number)=>Response.json({code},{status,headers:{'Cache-Control':'no-store'}});
  const secret=env.BUILD_CONTROL_SECRET;
  if(typeof secret!=='string'||!/^[a-f0-9]{64}$/.test(secret))return response('build_configuration_required',503);
  const encoder=new TextEncoder();
  const provided=request.headers.get('authorization')??'';
  if(provided.length>512)return response('build_authentication_required',401);
  const [a,b]=await Promise.all([crypto.subtle.digest('SHA-256',encoder.encode(provided)),
    crypto.subtle.digest('SHA-256',encoder.encode('Bearer '+secret))]);
  const subtle=crypto.subtle as SubtleCrypto&{timingSafeEqual(a:ArrayBuffer,b:ArrayBuffer):boolean};
  if(!subtle.timingSafeEqual(a,b))return response('build_authentication_required',401);
  const url=new URL(request.url);
  if(url.protocol!=='https:'||url.search)return response('route_not_found',404);
  const artifact=/^\/artifact\/([a-f0-9]{64})$/.exec(url.pathname)?.[1];
  if(artifact&&(request.method==='PUT'||request.method==='GET')){
    if(request.method==='GET'&&request.body!==null)return response('route_not_found',404);
    const expiry=Date.parse(env.BUILD_EXPIRES_AT??'');
    if(!Number.isFinite(expiry)||Date.now()>=expiry)return response('build_window_expired',410);
    const admitted=buildInputs(env.BUILD_ARTIFACT_MANIFEST,true),bucket=env.BUILD_ARTIFACTS;
    if(!admitted||!bucket)return response('build_artifact_configuration_required',503);
    const bytes=admitted.get(artifact);if(bytes===undefined)return response('build_artifact_not_found',404);
    if(request.method==='PUT'){
      if(request.headers.get('content-type')!=='application/octet-stream')return response('build_artifact_content_type_required',415);
      if(request.headers.get('content-length')!==String(bytes)||request.body===null)return response('build_artifact_length_invalid',400);
      if(request.signal.aborted)return response('build_artifact_unavailable',503);
      const transfer=new AbortController(),abort=()=>transfer.abort();
      request.signal.addEventListener('abort',abort,{once:true});
      const stream=new FixedLengthStream(bytes),pipe=request.body.pipeTo(stream.writable,{signal:transfer.signal});
      void pipe.catch(()=>{});
      try{
        // R2 verifies SHA-256 while receiving the stream. Only the admitted
        // opaque object can commit; retries of the same content are idempotent.
        // https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2putoptions
        const [object]=await Promise.all([bucket.put(artifact,stream.readable,{sha256:artifact,
          httpMetadata:{contentType:'application/octet-stream',cacheControl:'no-store'}}),pipe]);
        if(!object||object.size!==bytes||!artifactChecksum(object,artifact))return response('build_artifact_unavailable',503);
        return response('build_artifact_stored',200);
      }catch{return response('build_artifact_unavailable',503);}
      finally{request.signal.removeEventListener('abort',abort);transfer.abort();await pipe.catch(()=>{});}
    }
    try{
      const object=await bucket.get(artifact);
      if(!object)return response('build_artifact_not_found',404);
      if(object.size!==bytes||!artifactChecksum(object,artifact)){
        await object.body.cancel().catch(()=>{});return response('build_artifact_unavailable',503);
      }
      const stream=new FixedLengthStream(bytes);
      ctx.waitUntil(object.body.pipeTo(stream.writable).catch(()=>{}));
      return new Response(stream.readable,{headers:{'Content-Type':'application/octet-stream','Content-Length':String(bytes),
        'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    }catch{return response('build_artifact_unavailable',503);}
  }
  if(request.body!==null&&request.headers.get('content-length')!=='0')return response('route_not_found',404);
  const input=request.method==='GET'&&request.body===null?/^\/input\/([a-f0-9]{64})$/.exec(url.pathname)?.[1]:undefined;
  const operation=request.method==='POST'&&url.pathname==='/start'?'begin':
    request.method==='POST'&&url.pathname==='/stop'?'end':request.method==='GET'&&url.pathname==='/state'?'inspect':null;
  if(!operation&&!input)return response('route_not_found',404);
  const expiry=Date.parse(env.BUILD_EXPIRES_AT??'');
  if(operation!=='end'&&(!Number.isFinite(expiry)||Date.now()>=expiry))return response('build_window_expired',410);
  if(input){
    const admitted=buildInputs(env.BUILD_INPUT_MANIFEST);
    if(!admitted||!env.BUILD_INPUTS)return response('build_input_configuration_required',503);
    const bytes=admitted.get(input);if(bytes===undefined)return response('build_input_not_found',404);
    try{
      const object=await env.BUILD_INPUTS.get(input);
      if(!object)return response('build_input_not_found',404);
      if(object.size!==bytes){await object.body.cancel().catch(()=>{});return response('build_input_unavailable',503);}
      // FixedLengthStream makes the length authoritative in workerd while
      // retaining network backpressure; no complete input is buffered here.
      const stream=new FixedLengthStream(bytes);
      ctx.waitUntil(object.body.pipeTo(stream.writable).catch(()=>{}));
      return new Response(stream.readable,{headers:{'Content-Type':'application/octet-stream','Content-Length':String(bytes),
        'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    }catch{return response('build_input_unavailable',503);}
  }
  if(!operation)return response('route_not_found',404);
  const namespace=env.NATIVE_BUILD.jurisdiction('eu');
  const instance=namespace.get(namespace.idFromName('lovelies-native-build-20261024'),{locationHint:'weur'});
  try{return Response.json({state:await instance[operation]()},{headers:{'Cache-Control':'no-store'}});}
  catch{return response('build_unavailable',503);}
}} satisfies ExportedHandler<NativeBuildEnv>;
