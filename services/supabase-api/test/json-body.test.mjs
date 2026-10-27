/** Prepared external regression tests; root runs after source review. No DB/provider. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
import {ApiError,jsonBody,JSON_BODY_LIMITS} from '../src/types.ts';
const utf8=new TextEncoder(),error=(status,code)=>value=>value instanceof ApiError&&value.status===status&&value.code===code;
function source(kind,parts,{headers={},signal,cancel}={}){
 const state={pulls:0,cancels:0};let index=0;
 const stream=new ReadableStream({pull(output){state.pulls++;if(index<parts.length)output.enqueue(parts[index++]);else output.close();},cancel(reason){state.cancels++;return cancel?.(reason);}},{highWaterMark:0});
 const h={'content-type':'application/json',...headers};
 return {state,value:kind==='request'?new Request('https://api.invalid/auth/session/revoke',{method:'POST',headers:h,body:stream,duplex:'half',...signal?{signal}:{}}):new Response(stream,{headers:h})};
}
async function within(pending,ms=1000){let timer;try{return await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('test parser did not settle boundedly')),ms);})]);}finally{clearTimeout(timer);}}
for(const kind of ['request','response'])test(`${kind} snapshots mutable same-length identity bytes before a later read reuses them`,async()=>{
 const admitted={session_id:'11111111-1111-4111-8111-111111111111'},replacement={session_id:'22222222-2222-4222-8222-222222222222'},original=utf8.encode(JSON.stringify(admitted)),changed=utf8.encode(JSON.stringify(replacement)),shared=new Uint8Array(original);assert.equal(original.length,changed.length);let pulls=0;
 const stream=new ReadableStream({pull(output){if(pulls++===0)output.enqueue(shared);else{shared.set(changed);output.close();}}},{highWaterMark:0});
 const body=kind==='request'?new Request('https://api.invalid/auth/session/revoke',{method:'POST',headers:{'content-type':'application/json','content-length':String(original.length)},body:stream,duplex:'half'}):new Response(stream,{headers:{'content-type':'application/json'}});
 const value=await jsonBody(body);assert.deepEqual(value,admitted);assert.equal(pulls,2);assert.deepEqual(shared,changed,'parser must not zero or alter the producer-owned reused buffer');
});
for(const kind of ['request','response'])test(`${kind} accepts fragmented UTF8 and preserves every source-owned view`,async()=>{
 const value={label:'é',accepted:true},bytes=utf8.encode(JSON.stringify(value)),split=bytes.indexOf(0xc3)+1,parts=[bytes.subarray(0,split),new Uint8Array(0),bytes.subarray(split)],before=parts.map(x=>new Uint8Array(x)),s=source(kind,parts,{headers:kind==='request'?{'content-length':String(bytes.length)}:{}});
 assert.deepEqual(await jsonBody(s.value),value);for(let i=0;i<parts.length;i++)assert.deepEqual(parts[i],before[i]);assert.equal(s.state.cancels,0);
});
for(const kind of ['request','response'])test(`${kind} rejects consecutive empty fragments without awaiting an uncooperative cancel`,async()=>{
 const valid=utf8.encode('{"ok":true}'),s=source(kind,[...Array.from({length:64},()=>new Uint8Array(0)),valid],{cancel:()=>new Promise(()=>{})});
 await within(assert.rejects(jsonBody(s.value),error(kind==='request'?413:503,kind==='request'?'request_fragment_limit':'upstream_json_body_fragment_limit')));assert.equal(s.state.pulls,JSON_BODY_LIMITS.emptyFragments+1);assert.equal(s.state.cancels,1);assert.deepEqual(valid,utf8.encode('{"ok":true}'));
});
for(const kind of ['request','response'])test(`${kind} accepts the exact consecutive-empty boundary`,async()=>{
 const s=source(kind,[...Array.from({length:JSON_BODY_LIMITS.emptyFragments},()=>new Uint8Array(0)),utf8.encode('{"ok":true}')]);assert.deepEqual(await jsonBody(s.value),{ok:true});assert.equal(s.state.cancels,0);
});
for(const kind of ['request','response'])test(`${kind} bounds productive and alternating-empty fragmentation`,async()=>{
 const bytes=utf8.encode(JSON.stringify({data:'x'.repeat(JSON_BODY_LIMITS.fragments+32)}));
 for(const alternate of [false,true]){const parts=[];for(const byte of bytes){parts.push(new Uint8Array([byte]));if(alternate)parts.push(new Uint8Array(0));}const s=source(kind,parts);
  await assert.rejects(jsonBody(s.value,bytes.length),error(kind==='request'?413:503,kind==='request'?'request_fragment_limit':'upstream_json_body_fragment_limit'));assert.equal(s.state.pulls,JSON_BODY_LIMITS.fragments+1);assert.equal(s.state.cancels,1);
 }
});
for(const kind of ['request','response'])test(`${kind} accepts exactly the total fragment bound`,async()=>{
 const value={data:'x'.repeat(JSON_BODY_LIMITS.fragments+32)},bytes=utf8.encode(JSON.stringify(value)),parts=Array.from({length:JSON_BODY_LIMITS.fragments-1},(_,i)=>bytes.subarray(i,i+1));parts.push(bytes.subarray(JSON_BODY_LIMITS.fragments-1));const s=source(kind,parts);
 assert.deepEqual(await jsonBody(s.value,bytes.length),value);assert.equal(s.state.pulls,JSON_BODY_LIMITS.fragments+1);assert.equal(s.state.cancels,0);
});
for(const length of ['01','+2','-1','1.0','9007199254740992','','2,2'])test(`unencoded Request rejects noncanonical declared Content-Length ${JSON.stringify(length)} before reads`,async()=>{
 const s=source('request',[utf8.encode('{}')],{headers:{'content-length':length}});await assert.rejects(jsonBody(s.value),error(400,'invalid_content_length'));assert.equal(s.state.pulls,0);assert.equal(s.state.cancels,1);
});
for(const length of [1,3])test(`unencoded Request rejects syntactically valid but incomplete/overclaimed length ${length}`,async()=>{
 const bytes=utf8.encode('{}'),s=source('request',[bytes],{headers:{'content-length':String(length)}});await assert.rejects(jsonBody(s.value),error(400,'request_length_mismatch'));assert.deepEqual(bytes,utf8.encode('{}'));
});
test('declared request over the byte cap is rejected before reads',async()=>{
 const s=source('request',[utf8.encode('{}')],{headers:{'content-length':'100'}});await assert.rejects(jsonBody(s.value,99),error(413,'request_too_large'));assert.equal(s.state.pulls,0);assert.equal(s.state.cancels,1);
});
for(const coding of ['identity','IDENTITY','identity, identity'])test(`${coding} remains an exact-length unencoded Request`,async()=>{
 const s=source('request',[utf8.encode('{}')],{headers:{'content-encoding':coding,'content-length':'3'}});await assert.rejects(jsonBody(s.value),error(400,'request_length_mismatch'));
});
for(const coding of ['',',gzip','gzip,','gzip gzip'])test(`malformed Request encoding ${JSON.stringify(coding)} cannot create a length exemption`,async()=>{
 const s=source('request',[utf8.encode('{}')],{headers:{'content-encoding':coding,'content-length':'3'}});await assert.rejects(jsonBody(s.value),error(415,'invalid_content_encoding'));assert.equal(s.state.pulls,0);
});
for(const coding of ['gzip','br','gzip, br'])test(`runtime-decoded ${coding} Request enforces actual bytes without comparing encoded Content-Length`,async()=>{
 const value={ok:true},bytes=utf8.encode(JSON.stringify(value)),s=source('request',[bytes.subarray(0,3),bytes.subarray(3)],{headers:{'content-encoding':coding,'content-length':'999'}});assert.deepEqual(await jsonBody(s.value,bytes.length),value);
});
for(const length of ['1','999999999','not-a-length'])test(`fragmented provider Response preserves decoded bytes despite advisory Content-Length ${length}`,async()=>{
 // Models fetch's exposed decoded body with retained wire headers; this test
 // performs no decompression, network/provider request or compression proof.
 const value={receipt:'synthetic'},bytes=utf8.encode(JSON.stringify(value)),s=source('response',[bytes.subarray(0,4),bytes.subarray(4)],{headers:{'content-encoding':'gzip','content-length':length}});assert.deepEqual(await jsonBody(s.value,bytes.length),value);
});
for(const kind of ['request','response'])test(`${kind} still rejects actual bytes above maximum with an advisory/missing length`,async()=>{
 const bytes=utf8.encode('{"too":"large"}'),s=source(kind,[bytes],{headers:kind==='response'?{'content-encoding':'gzip','content-length':'1'}:{}});await assert.rejects(jsonBody(s.value,bytes.length-1),error(413,'request_too_large'));assert.deepEqual(bytes,utf8.encode('{"too":"large"}'));assert.equal(s.state.cancels,1);
});
for(const kind of ['request','response'])test(`${kind} stalled reads time out and uncooperative cancellation cannot hold the parser`,async()=>{
 let cancels=0;const stream=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancels++;return new Promise(()=>{});}},{highWaterMark:0}),value=kind==='request'?new Request('https://api.invalid/auth/session/revoke',{method:'POST',headers:{'content-type':'application/json'},body:stream,duplex:'half'}):new Response(stream,{headers:{'content-type':'application/json'}});
 await within(assert.rejects(jsonBody(value,100,{timeoutMs:20}),error(kind==='request'?408:503,kind==='request'?'json_body_timeout':'upstream_json_body_timeout')));assert.equal(cancels,1);
});
for(const kind of ['request','response'])test(`${kind} caller abort stops a held read without exposing its reason or awaiting cancel`,async()=>{
 const controller=new AbortController(),entered=Promise.withResolvers();let cancels=0;
 const stream=new ReadableStream({pull(){entered.resolve();return new Promise(()=>{});},cancel(){cancels++;return new Promise(()=>{});}},{highWaterMark:0}),value=kind==='request'?new Request('https://api.invalid/auth/session/revoke',{method:'POST',signal:controller.signal,headers:{'content-type':'application/json'},body:stream,duplex:'half'}):new Response(stream,{headers:{'content-type':'application/json'}});
 const pending=jsonBody(value,100,kind==='response'?{signal:controller.signal}:{});void pending.catch(()=>{});await within(entered.promise);controller.abort(Error('synthetic-private-abort-reason'));
 await within(assert.rejects(pending,e=>error(kind==='request'?400:503,kind==='request'?'json_body_aborted':'upstream_json_body_aborted')(e)&&e.message===(kind==='request'?'json_body_aborted':'upstream_json_body_aborted')));assert.equal(cancels,1);
});
for(const kind of ['request','response'])test(`${kind} already-aborted admission reads no chunks`,async()=>{
 const controller=new AbortController();controller.abort();const s=source(kind,[utf8.encode('{}')],{signal:controller.signal});await assert.rejects(jsonBody(s.value,100,kind==='response'?{signal:controller.signal}:{}),error(kind==='request'?400:503,kind==='request'?'json_body_aborted':'upstream_json_body_aborted'));assert.equal(s.state.pulls,0);assert.equal(s.state.cancels,1);
});
test('a rejecting cancellation cannot replace the actual byte-limit error or mutate its caller buffer',async()=>{
 const bytes=utf8.encode('{broken'),s=source('request',[bytes],{cancel(){throw Error('synthetic cancel failed');}});await assert.rejects(jsonBody(s.value,bytes.length-1),error(413,'request_too_large'));assert.deepEqual(bytes,utf8.encode('{broken'));assert.equal(s.state.cancels,1);
});
for(const bytes of [new Uint8Array([0xff]),utf8.encode('[]'),utf8.encode('null')])test(`invalid UTF8/top-level input remains rejected without zeroing producer bytes ${bytes.length}`,async()=>{
 const copy=new Uint8Array(bytes),s=source('response',[bytes]);await assert.rejects(jsonBody(s.value),e=>e instanceof ApiError&&e.status===400);assert.deepEqual(bytes,copy);
});
test('pre-existing private transport ApiError remains intact',async()=>{
 const failure=new ApiError(503,'private_service_timeout'),body=new ReadableStream({pull(output){output.error(failure);}},{highWaterMark:0});await assert.rejects(jsonBody(new Response(body,{headers:{'content-type':'application/json'}})),e=>e===failure);
});
test('unknown body-shaped/cross-realm-like objects fail closed instead of receiving Response exemptions',async()=>{
 let reads=0;const unknown={headers:new Headers({'content-type':'application/json','content-length':'99'}),body:{getReader(){reads++;throw Error('must not read');}},[Symbol.toStringTag]:'Response'};await assert.rejects(jsonBody(unknown),error(400,'invalid_input'));assert.equal(reads,0);
});
for(const timeoutMs of [0,-1,Infinity,JSON_BODY_LIMITS.timeoutMs+1])test(`invalid body deadline ${timeoutMs} cannot disable the bound`,async()=>{
 const s=source('request',[utf8.encode('{}')]);await assert.rejects(jsonBody(s.value,100,{timeoutMs}),error(503,'json_body_configuration_invalid'));assert.equal(s.state.pulls,0);
});

test('encoded Request exemption never bypasses the actual exposed-byte maximum',async()=>{
 const bytes=utf8.encode('{"receipt":"synthetic"}'),s=source('request',[bytes],{headers:{'content-encoding':'gzip','content-length':'1'}});await assert.rejects(jsonBody(s.value,bytes.length-1),error(413,'request_too_large'));assert.deepEqual(bytes,utf8.encode('{"receipt":"synthetic"}'));
});
test('Response exemption does not depend on a retained Content-Encoding header',async()=>{
 const s=source('response',[utf8.encode('{"ok":true}')],{headers:{'content-length':'999'}});assert.deepEqual(await jsonBody(s.value,11),{ok:true});
});

test('explicit processor Response limit preserves bodies larger than the default request limit',async()=>{
 const value={preview:'x'.repeat(3*1024*1024)},bytes=utf8.encode(JSON.stringify(value));
 await assert.rejects(jsonBody(source('response',[bytes]).value),error(413,'request_too_large'));
 const parts=[];for(let i=0;i<bytes.length;i+=131072)parts.push(bytes.subarray(i,i+131072));
 const parsed=await jsonBody(source('response',parts,{headers:{'content-encoding':'gzip','content-length':'999'}}).value,6*1024*1024);assert.equal(parsed.preview.length,value.preview.length);assert.equal(parsed.preview,value.preview);
});

for(const kind of ['request','response'])test(`${kind} accepts a real foreign-realm Uint8Array without mutating it`,async()=>{
 const value={session_id:'11111111-1111-4111-8111-111111111111'},encoded=[...utf8.encode(JSON.stringify(value))],bytes=runInNewContext('new Uint8Array('+JSON.stringify(encoded)+')');
 assert.equal(bytes instanceof Uint8Array,false);assert.equal(ArrayBuffer.isView(bytes),true);const before=new Uint8Array(bytes),s=source(kind,[bytes]);assert.deepEqual(await jsonBody(s.value),value);assert.deepEqual(new Uint8Array(bytes),before);
});
for(const kind of ['request','response'])test(`${kind} respects Buffer subarray offset/length and preserves its backing bytes`,async()=>{
 const json=Buffer.from('{"ok":true}'),parent=Buffer.concat([Buffer.from('prefix'),json,Buffer.from('suffix')]),view=parent.subarray(6,6+json.length),before=Buffer.from(parent),s=source(kind,[view]);assert.deepEqual(await jsonBody(s.value),{ok:true});assert.deepEqual(parent,before);
});
for(const kind of ['request','response'])for(const which of ['DataView','Uint16Array','Uint8ClampedArray','spoof','proxy'])test(`${kind} rejects ${which} even with a Uint8Array tag`,async()=>{
 const chunk=which==='spoof'?{0:123,1:125,length:2,byteLength:2,[Symbol.toStringTag]:'Uint8Array'}:which==='proxy'?new Proxy(new Uint8Array([123,125]),{}):runInNewContext(which==='DataView'?'new DataView(new ArrayBuffer(2))':'new '+which+'([123,125])');
 if(which!=='proxy')Object.defineProperty(chunk,Symbol.toStringTag,{value:'Uint8Array',configurable:true});const s=source(kind,[chunk]);await assert.rejects(jsonBody(s.value),error(kind==='request'?400:503,kind==='request'?'invalid_input':'upstream_json_body_invalid_chunk'));
});
for(const kind of ['request','response'])test(`${kind} uses intrinsic byte length/kind and set rather than caller-owned getters or iterator`,async()=>{
 const chunk=runInNewContext('new Uint8Array([123,125])');Object.defineProperty(chunk,'byteLength',{get(){throw Error('must not invoke owned length');}});Object.defineProperty(chunk,Symbol.toStringTag,{value:'spoofed-kind'});chunk[Symbol.iterator]=()=>{throw Error('must not iterate caller');};const s=source(kind,[chunk]);assert.deepEqual(await jsonBody(s.value),{});assert.equal(chunk[0],123);assert.equal(chunk[1],125);
});
for(const kind of ['request','response'])for(const realm of ['host','foreign'])test(`${kind} rejects ${realm} SharedArrayBuffer-backed bytes`,{skip:typeof SharedArrayBuffer==='undefined'},async()=>{
 const chunk=realm==='host'?new Uint8Array(new SharedArrayBuffer(2)):runInNewContext('new Uint8Array(new SharedArrayBuffer(2))');chunk.set([123,125]);const s=source(kind,[chunk]);await assert.rejects(jsonBody(s.value),error(kind==='request'?400:503,kind==='request'?'invalid_input':'upstream_json_body_invalid_chunk'));assert.equal(chunk[0],123);assert.equal(chunk[1],125);
});
for(const kind of ['request','response'])test(`${kind} locked native body is a controlled error and preserves the existing reader`,async()=>{
 const s=source(kind,[utf8.encode('{}')]),held=s.value.body.getReader();try{await assert.rejects(jsonBody(s.value),error(kind==='request'?400:503,kind==='request'?'json_body_unavailable':'upstream_json_body_unavailable'));assert.equal(s.value.body.locked,true);assert.equal(s.state.pulls,0);assert.equal(s.state.cancels,0);}finally{await held.cancel();held.releaseLock();}
});
