import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {AuthenticatedService} from '../src/service-fetcher.ts';
const secret='synthetic-private-service-secret-32-characters';
const limits={requestBytes:10,responseBytes:10};
const expected=code=>error=>error?.status===503&&error?.code===code;

function syntheticResponse(kind,mode){
 let cancelled=0;const body=new ReadableStream({cancel(){cancelled++;if(mode==='reject')return Promise.reject(Error('synthetic-cancel-rejection'));if(mode==='never')return new Promise(()=>{});}});
 if(mode==='sync')Object.defineProperty(body,'cancel',{value:()=>{cancelled++;throw Error('synthetic-cancel-throw');}});
 const response=new Response(body,{status:kind==='redirect'?302:200,headers:kind==='oversize'?{'content-length':'11'}:{location:'https://untrusted.invalid'}});
 let reader;if(mode==='locked')reader=response.body.getReader();
 return {response,count:()=>cancelled,release:async()=>{if(reader){await reader.cancel();reader.releaseLock();}}};
}
for(const kind of ['redirect','oversize'])for(const mode of ['sync','reject','never','locked','normal'])test(`${kind}: ${mode} cancellation cannot replace or delay its existing error`,{timeout:3000},async()=>{
 const f=syntheticResponse(kind,mode);let calls=0;
 const service=new AuthenticatedService('https://private.invalid',secret,async()=>{calls++;return f.response;},1000,limits);
 const code=kind==='redirect'?'private_service_redirect_denied':'private_service_response_too_large';
 await assert.rejects(()=>service.fetch('https://internal.invalid/operation'),expected(code));
 assert.equal(calls,1);if(mode!=='locked')assert.equal(f.count(),1);await f.release();
});

for(const kind of ['stream_oversize','stream_timeout'])for(const mode of ['sync','reject','never'])test(`${kind}: ${mode} reader cancellation preserves the original stream error`,{timeout:3000},async()=>{
 let cancelled=0;const stream=new ReadableStream({start(output){if(kind==='stream_oversize')output.enqueue(new Uint8Array(11));},cancel(){cancelled++;if(mode==='reject')return Promise.reject(Error('synthetic-reader-rejection'));if(mode==='never')return new Promise(()=>{});}});
 const response=new Response(stream);const original=stream.getReader.bind(stream);
 Object.defineProperty(stream,'getReader',{value:()=>{const reader=original();if(mode==='sync')Object.defineProperty(reader,'cancel',{value:()=>{cancelled++;throw Error('synthetic-reader-throw');}});return reader;}});
 const service=new AuthenticatedService('https://private.invalid',secret,async()=>response,kind==='stream_timeout'?20:1000,limits);
 const wrapped=await service.fetch('https://internal.invalid/operation');
 await assert.rejects(()=>wrapped.arrayBuffer(),expected(kind==='stream_timeout'?'private_service_timeout':'private_service_response_too_large'));
 assert.equal(cancelled,1);
});

test('the redirected flag is still rejected and the response body is cancelled',async()=>{
 const f=syntheticResponse('oversize','normal');Object.defineProperty(f.response,'redirected',{value:true});
 const service=new AuthenticatedService('https://private.invalid',secret,async()=>f.response,1000,limits);
 await assert.rejects(()=>service.fetch('https://internal.invalid/operation'),expected('private_service_redirect_denied'));assert.equal(f.count(),1);
});

test('request-body cleanup cannot replace a declared oversize error',async t=>{
 let cancellations=0,calls=0;t.mock.method(ReadableStream.prototype,'cancel',()=>{cancellations++;throw Error('synthetic-request-cancel-throw');});
 const service=new AuthenticatedService('https://private.invalid',secret,async()=>{calls++;return Response.json({});},1000,limits);
 await assert.rejects(()=>service.fetch('https://internal.invalid/operation',{method:'POST',headers:{'content-length':'11'},body:'synthetic'}),error=>error?.status===413&&error?.code==='private_service_request_too_large');
 assert.equal(calls,0);assert.equal(cancellations,1);
});

// Observe the actual adapter's own timeout and abort-listener lifecycle without
// mistaking caller cancellation for proof that an external producer stopped.
async function lifecycle(run){
 const nativeSet=globalThis.setTimeout,nativeClear=globalThis.clearTimeout,add=AbortSignal.prototype.addEventListener,remove=AbortSignal.prototype.removeEventListener;
 const timers=new Set(),listeners=new Map();let additions=0,removals=0;
 globalThis.setTimeout=function(fn,ms,...args){const timer=nativeSet(fn,ms,...args);if(ms===37)timers.add(timer);return timer;};
 globalThis.clearTimeout=function(timer){timers.delete(timer);return nativeClear(timer);};
 AbortSignal.prototype.addEventListener=function(type,listener,...options){if(type==='abort'&&listener?.name==='forwardAbort'){listeners.set(listener,this);additions++;}return add.call(this,type,listener,...options);};
 AbortSignal.prototype.removeEventListener=function(type,listener,...options){if(type==='abort'&&listeners.get(listener)===this){listeners.delete(listener);removals++;}return remove.call(this,type,listener,...options);};
 try{await run({timers,listeners});assert.equal(timers.size,0);assert.equal(listeners.size,0);assert.equal(additions,1);assert.equal(removals,1);}
 finally{globalThis.setTimeout=nativeSet;globalThis.clearTimeout=nativeClear;AbortSignal.prototype.addEventListener=add;AbortSignal.prototype.removeEventListener=remove;}
}
for(const kind of ['redirect','oversize','stream_oversize','stream_timeout'])test(`${kind} cleans its timeout and forwarded abort listener`,{timeout:3000},()=>lifecycle(async()=>{
 const response=kind==='redirect'||kind==='oversize'?syntheticResponse(kind,'sync').response:new Response(new ReadableStream({start(output){if(kind==='stream_oversize')output.enqueue(new Uint8Array(11));}}));
 const service=new AuthenticatedService('https://private.invalid',secret,async()=>response,37,limits);
 if(kind.startsWith('stream_')){const wrapped=await service.fetch('https://internal.invalid/operation');await assert.rejects(()=>wrapped.arrayBuffer(),expected(kind==='stream_timeout'?'private_service_timeout':'private_service_response_too_large'));}
 else await assert.rejects(()=>service.fetch('https://internal.invalid/operation'),expected(kind==='redirect'?'private_service_redirect_denied':'private_service_response_too_large'));
}));
for(const mode of ['reject','pending'])test(`caller-initiated ${mode} cancellation keeps settlement semantics and cleanup`,{timeout:3000},()=>lifecycle(async({timers,listeners})=>{
 let settle;const rejection=Error('synthetic-caller-cancel-rejection');
 const source=new ReadableStream({cancel(){if(mode==='reject')return Promise.reject(rejection);return new Promise(resolve=>{settle=resolve;});}});let forwarded;
 const service=new AuthenticatedService('https://private.invalid',secret,async request=>{forwarded=request;return new Response(source);},37,limits);
 const response=await service.fetch('https://internal.invalid/operation');assert.equal(timers.size,1);assert.equal(listeners.size,1);
 const cancellation=response.body.cancel('synthetic-caller-cancel');assert.equal(forwarded.signal.aborted,true);
 if(mode==='reject')await assert.rejects(cancellation,error=>error===rejection);
 else{let completed=false;void cancellation.then(()=>{completed=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(completed,false);settle();await cancellation;}
}));

// Run the late-reply cases in child Node processes with strict unhandled-rejection
// behavior. This tests the actual adapter without installing a process-wide
// rejection handler or turning an asynchronous crash into a passing test.
for(const mode of ['sync','reject','never','normal'])test(`late response after timeout: ${mode} cancellation cannot create an unhandled rejection`,{timeout:5000},()=>{
 const moduleUrl=new URL('../src/service-fetcher.ts',import.meta.url).href;
 const program=`import assert from 'node:assert/strict';
 import {AuthenticatedService} from ${JSON.stringify(moduleUrl)};
 let finish,cancels=0;const mode=${JSON.stringify(mode)};
 const service=new AuthenticatedService('https://private.invalid',${JSON.stringify(secret)},async()=>new Promise(resolve=>finish=resolve),20);
 await assert.rejects(()=>service.fetch('https://internal.invalid/operation'),e=>e?.status===503&&e?.code==='private_service_timeout');
 const body=new ReadableStream({cancel(){cancels++;if(mode==='reject')return Promise.reject(Error('synthetic-rejection'));if(mode==='never')return new Promise(()=>{});}});
 if(mode==='sync')Object.defineProperty(body,'cancel',{value:()=>{cancels++;throw Error('synthetic-late-cancel-throw');}});
 finish(new Response(body,{status:302}));await new Promise(resolve=>setTimeout(resolve,30));assert.equal(cancels,1);
 process.stdout.write('timeout_preserved_and_late_cancel_observed\\n');`;
 const child=spawnSync(process.execPath,['--experimental-transform-types','--unhandled-rejections=strict','--input-type=module','--eval',program],{encoding:'utf8',timeout:2500,env:{PATH:process.env.PATH??'/usr/bin:/bin',TMPDIR:process.env.TMPDIR??'/tmp'}});
 assert.equal(child.error,undefined,child.error?.message);assert.equal(child.status,0,`child exited ${child.status}: ${child.stderr}`);
 assert.match(child.stdout,/timeout_preserved_and_late_cancel_observed/);
});
