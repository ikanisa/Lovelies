/** Deterministic adapter/transport resource fixture, never recognition evidence.
 * Synthetic zero-filled source/template bytes are hash-bound but deliberately
 * not face models or decodable photographs. Private storage and the remote
 * consumer are explicit fixtures. Production createModelServices and
 * AuthenticatedService execute unchanged, including hashing/body/deadline caps.
 */
import {AuthenticatedService} from '../src/service-fetcher.ts';
import {stable} from '../src/types.ts';
import {INFERENCE_ENGINE_SPACE,INFERENCE_MODEL_ID,INFERENCE_LIMITS} from '../src/inference-contract.ts';
import {encodeGeneration} from '../src/inference-generation.ts';
// Static graph edges are required by the cached Edge Runtime's eszip compiler.
// Computed file imports cannot load missing modules from its staged filesystem.
import {createModelServices as currentModelServices} from '../src/model-services.ts';
import {createModelServices as beforeModelServices} from './fixtures/model-resource-before/model-services.ts';

const encoder=new TextEncoder(),decoder=new TextDecoder(),artifact='a'.repeat(64),processing='b'.repeat(64);
const sourceBytes=INFERENCE_LIMITS.image_bytes,profileCount=INFERENCE_LIMITS.profiles;
const sourceDigest='cd52d81e25f372e6fa4db2c0dfceb59862c1969cab17096da352b34950c973cc'; // 20 MiB zero bytes
const zeroDigest=async(length:number)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(length)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
const identifier=(index:number)=>`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`;
const marker=(key:string)=>encoder.encode(JSON.stringify(key)+':"');
function find(bytes:Uint8Array,needle:Uint8Array):number {
  let cursor=0;
  for(;;){const at=bytes.indexOf(needle[0],cursor);if(at<0)return -1;
    if(at+needle.length<=bytes.length&&needle.every((byte,index)=>bytes[at+index]===byte))return at;cursor=at+1;}
}
async function fixture(overBy:0|1){
  const asset=identifier(1),version=identifier(2),profiles:Array<Record<string,any>>=[];
  const templateLengths=new Map<string,number>();
  let overhead=encoder.encode(stable({asset_id:asset,source:{mime:'image/jpeg',sha256:sourceDigest,bytes_base64:''},profiles:[],
    engine_space:INFERENCE_ENGINE_SPACE,engine_artifact_sha256:artifact,processing_fingerprint:processing,
    request_id:'0'.repeat(36),request_sha256:'0'.repeat(64)})).length+4*Math.ceil(sourceBytes/3);
  for(let index=0;index<profileCount;index++){
    const profile={account_id:identifier(10+index*2),profile_id:identifier(11+index*2),revision:'r',model_id:INFERENCE_MODEL_ID,
      template_key:'',template_digest:'0'.repeat(64)};
    profile.template_key=`registered-face/${profile.account_id}/${profile.profile_id}/current`;
    const {template_key,...admitted}=profile;
    overhead+=encoder.encode(stable({...admitted,template_base64:''})).length+(index?1:0);
    profiles.push(profile);
  }
  // Base64 grows in four-byte groups. A short ordinary revision accounts for
  // the remaining 0..3 bytes, producing the exact existing 40 MiB wire cap.
  const padding=(INFERENCE_LIMITS.photo_body_bytes-overhead)%4;
  profiles[0].revision+='r'.repeat(padding);overhead+=padding;
  const groups=(INFERENCE_LIMITS.photo_body_bytes-overhead)/4;
  const each=Math.floor(groups/profileCount),remainder=groups%profileCount,digests=new Map<number,string>();
  for(let index=0;index<profileCount;index++){
    const length=(each+(index<remainder?1:0))*3;
    if(length<1||length>65536)throw new Error('resource_fixture_template_budget_invalid');
    if(!digests.has(length))digests.set(length,await zeroDigest(length));
    profiles[index].template_digest=digests.get(length)!;templateLengths.set(profiles[index].template_key,length);
  }
  if(overBy)profiles[0].revision+='x';
  const payload={attempt_id:identifier(3),asset_id:asset,source_version:version,source_checksum_sha256:sourceDigest,
    model_version:INFERENCE_MODEL_ID,engine_identity:encodeGeneration({engine_space:INFERENCE_ENGINE_SPACE,
      engine_artifact_sha256:artifact,processing_fingerprint:processing}),
    nonce:'transport-resource-fixture',quarantine_key:'source/resource-fixture',profiles};
  return {payload,templateLengths,expectedBytes:INFERENCE_LIMITS.photo_body_bytes+overBy};
}

async function inspectWire(request:Request){
  const reader=request.body!.getReader(),shaMarker=marker('request_sha256'),idMarker=marker('request_id');
  let bytes=0,claim:string|undefined,requestID:string|undefined;const chunks:number[]=[];
  try {
    for(;;){const next=await reader.read();if(next.done)break;
      const chunk=next.value;bytes+=chunk.byteLength;chunks.push(chunk.byteLength);
      const idAt=find(chunk,idMarker);if(idAt>=0)requestID=decoder.decode(chunk.subarray(idAt+idMarker.length,idAt+idMarker.length+36));
      const at=find(chunk,shaMarker);
      if(at>=0){
        if(claim)throw new Error('resource_fixture_duplicate_binding');
        const end=at+shaMarker.length+64;claim=decoder.decode(chunk.subarray(at+shaMarker.length,end));
        if(!/^[a-f0-9]{64}$/.test(claim)||chunk[end]!==34)throw new Error('resource_fixture_split_binding');
        // Inspect the binding header in either preserved canonical wire order
        // or the new digest-prefix form. This resource-only receiver drains
        // bytes; it deliberately does not rehash/parse another 40 MiB payload.
        // Digest correctness has separate focused and real-service evidence.
        if(chunk[at-1]===123){
          if(chunk[end+1]!==44)throw new Error('resource_fixture_missing_separator');
        }else if(chunk[at-1]!==44)throw new Error('resource_fixture_unexpected_binding_position');
      }
    }
  }finally{reader.releaseLock();}
  if(!claim||!requestID||!/^[a-f0-9-]{36}$/.test(requestID))throw new Error('resource_fixture_outbound_binding_invalid');
  const claimedLength=request.headers.get('content-length');
  if(claimedLength!==null&&Number(claimedLength)!==bytes)throw new Error('resource_fixture_outbound_length_invalid');
  return {bytes,body_chunks:chunks,request_id:requestID,request_sha256:claim,claimed_content_length:claimedLength===null?null:Number(claimedLength),digest_verified:false,
    digest_scope:'Binding shape only; resource fixture drains/counts bytes. Canonical digest correctness is covered by focused and real-service tests.'};
}

export async function runResourceProbe(overBy:0|1=0){
  const selected=Deno.env.get('LOVELIES_RESOURCE_MODEL_MODULE')??'current';
  const before=selected==='before'||selected.endsWith('/continuation/resource-before/model-services.ts')||selected.endsWith('/test/fixtures/model-resource-before/model-services.ts');
  if(!before&&selected!=='current'&&!selected.endsWith('/services/supabase-api/src/model-services.ts'))throw new Error('resource_fixture_module_not_in_static_graph');
  const createModelServices=before?beforeModelServices:currentModelServices;
  const snapshots:Array<Record<string,unknown>>=[];
  const sample=(stage:string)=>{
    const value={stage,...Deno.memoryUsage()};snapshots.push(value);
    // Scalar stage samples survive a supervisor termination; they remain
    // snapshots, not a replacement for the actual memory-limit outcome.
    console.log(JSON.stringify({event:'resource_memory_sample',...value}));
  };
  const began=performance.now();sample('before_fixture');
  const data=await fixture(overBy);let outbound:Awaited<ReturnType<typeof inspectWire>>|undefined,calls=0;
  const unsupported={head:async()=>{throw new Error('resource_fixture_unexpected_head');},
    put:async()=>{throw new Error('resource_fixture_unexpected_write');},delete:async()=>{throw new Error('resource_fixture_unexpected_delete');}};
  const source={...unsupported,get:async()=>{
    sample('source_read_start');let remaining=sourceBytes;
    return {size:sourceBytes,etag:'synthetic-resource-fixture',
      httpMetadata:{contentType:'image/jpeg'},customMetadata:{source_version:data.payload.source_version,source_checksum_sha256:sourceDigest},
      // A real Storage download is pulled through a bounded network window.
      // Generate one owned 64 KiB chunk per pull rather than prequeueing20MiB.
      body:new ReadableStream<Uint8Array>({pull:output=>{
        if(!remaining){output.close();return;}
        const length=Math.min(65536,remaining);remaining-=length;output.enqueue(new Uint8Array(length));
      }}),arrayBuffer:async()=>{throw new Error('resource_fixture_unexpected_arraybuffer');}};
  }};
  let templateReads=0;
  const photos={...unsupported,get:async(key:string)=>{
    const length=data.templateLengths.get(key);if(!length)return null;
    templateReads++;if(templateReads===1||templateReads%250===0)sample('template_read_'+templateReads);
    return {size:length,etag:'synthetic-resource-template',body:new ReadableStream<Uint8Array>({start:output=>{output.enqueue(new Uint8Array(length));output.close();}}),
      arrayBuffer:async()=>{throw new Error('resource_fixture_unexpected_arraybuffer');}};
  }};
  const inference=new AuthenticatedService('https://transport-resource.invalid','transport-resource-fixture-secret-only',async request=>{
    if(!(request instanceof Request))throw new Error('resource_fixture_request_required');
    calls++;sample('private_transport_start');outbound=await inspectWire(request);sample('private_transport_drained');
    return Response.json({engine_space:INFERENCE_ENGINE_SPACE,engine_artifact_sha256:artifact,processing_fingerprint:processing,
      request_id:outbound.request_id,request_sha256:outbound.request_sha256,model_version:INFERENCE_MODEL_ID,
      preview:{bytes_base64:'',content_type:'image/jpeg',width:1,height:1},matches:[]});
  });
  const services=createModelServices({PHOTOS:photos,QUARANTINE:source,MODEL_VERSION:INFERENCE_MODEL_ID,
    FACE_AUTH_POLICY_VERSION:'registered-face-opencv-v1',ENGINE_ARTIFACT_SHA256:artifact,PROCESSING_FINGERPRINT:processing,INFERENCE:inference});
  const input=JSON.stringify(data.payload),prepared=performance.now();sample('before_adapter');
  const response=await services.photo.fetch('http://resource-fixture/process',{method:'POST',headers:{'Content-Type':'application/json'},body:input});
  const result=await response.json(),finished=performance.now();sample('after_adapter');
  const passed=overBy===0?response.status===200&&calls===1&&outbound?.bytes===data.expectedBytes:
    response.status===413&&result?.error?.code==='inference_body_too_large'&&calls===0;
  return {schema:1,status:passed?'passed':'failed',scope:'Synthetic private Storage and remote-consumer fixtures; actual production adapter and authenticated streaming transport; no recognition/decoded-image/hosted acceptance',
    model_module:selected,case:overBy?'cap_plus_one':'exact_cap',source_bytes:sourceBytes,profiles:profileCount,expected_outbound_bytes:data.expectedBytes,
    admission_input_bytes:encoder.encode(input).byteLength,response_status:response.status,denial_code:result?.error?.code??null,private_transport_calls:calls,
    outbound:outbound??null,wall_ms:{setup:prepared-began,adapter:finished-prepared,total:finished-began},
    process_cpu_us:null,
    cpu_semantics:'No CPU estimate is substituted for the actual Edge worker supervisor counter; wall_ms is elapsed wall time.',
    memory_snapshots:snapshots,memory_semantics:'Deno.memoryUsage snapshots are not peak isolate memory and RSS may include sibling workers; only an actual configured Edge supervisor establishes the 256 MiB/2000 ms resource-limit outcome.',
    runtime:Deno.version,does_not_establish:['Recognition or matching accuracy','Actual Supabase Storage/PostgreSQL/network/TLS resource overhead','Maximum aggregate full-API Edge request cost','Hosted deployment acceptance']};
}

if(import.meta.main){
  if(Deno.args[0]==='--once'){
    const result=await runResourceProbe(Deno.args[1]==='over'?1:0);console.log(JSON.stringify(result));Deno.exit(result.status==='passed'?0:1);
  }
  Deno.serve({hostname:'127.0.0.1',port:Number(Deno.env.get('LOVELIES_RESOURCE_PORT')??'9018')},async request=>{
    const url=new URL(request.url);
    if(url.pathname!=='/resource'||request.method!=='GET')return new Response(null,{status:404});
    return Response.json(await runResourceProbe(url.searchParams.get('case')==='over'?1:0));
  });
}
