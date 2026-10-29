import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AuthenticatedService} from '../src/service-fetcher.ts';

const secret='synthetic-private-service-secret-32-characters';
const deadline=20;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const immediate=()=>new Promise(resolve=>setImmediate(resolve));
const timeout=e=>e?.status===503&&e?.code==='private_service_timeout';
const service=(fetcher,ms=1000)=>new AuthenticatedService('https://private.invalid',secret,fetcher,ms);

for(const mode of ['timeout','caller'])test(`${mode} after headers rejects a buffered response`,{timeout:2000},async()=>{
 const caller=new AbortController(),reason=Error('synthetic_caller_abort');let forwarded;
 const response=await service(async request=>{forwarded=request;return new Response('ok');},mode==='timeout'?deadline:1000).fetch('https://internal.invalid/op',{signal:caller.signal});
 await immediate();
 if(mode==='timeout')await pause(50);else caller.abort(reason);
 assert.equal(forwarded.signal.aborted,true);
 await assert.rejects(()=>response.text(),mode==='timeout'?timeout:e=>e===reason);
});

for(const mode of ['timeout','caller'])test(`${mode} after headers rejects a pending empty stream and cancels once`,{timeout:2000},async()=>{
 const caller=new AbortController(),reason=Error('synthetic_empty_abort');let cancels=0;
 const response=await service(async()=>new Response(new ReadableStream({cancel(){cancels++;}})),mode==='timeout'?deadline:1000).fetch('https://internal.invalid/op',{signal:caller.signal});
 const pending=response.text();void pending.catch(()=>{});
 await immediate();if(mode==='timeout')await pause(50);else caller.abort(reason);
 await assert.rejects(pending,mode==='timeout'?timeout:e=>e===reason);assert.equal(cancels,1);
});

test('repeated abort preserves the first reason after one chunk was consumed',async()=>{
 const caller=new AbortController(),reason=Error('synthetic_first_abort');let cancels=0;
 const source=new ReadableStream({start(output){output.enqueue(new Uint8Array([1,2]));},cancel(){cancels++;}});
 const response=await service(async()=>new Response(source)).fetch('https://internal.invalid/op',{signal:caller.signal});
 const reader=response.body.getReader(),first=await reader.read();
 assert.deepEqual([...first.value],[1,2]);
 caller.abort(reason);caller.abort(Error('synthetic_second_abort'));
 await assert.rejects(()=>reader.read(),e=>e===reason);assert.equal(cancels,1);
 assert.deepEqual([...first.value],[1,2]);reader.releaseLock();
});

test('empty stream already at end of response stays complete after later caller abort',async()=>{
 const caller=new AbortController();const response=await service(async()=>new Response(new ReadableStream({start(out){out.close();}}))).fetch('https://internal.invalid/op',{signal:caller.signal});
 await immediate();caller.abort(Error('synthetic_after_complete'));assert.equal(await response.text(),'');
});

test('response without a body is complete before a later abort',async()=>{
 const caller=new AbortController();const response=await service(async()=>new Response(null,{status:204})).fetch('https://internal.invalid/op',{signal:caller.signal});
 caller.abort(Error('synthetic_after_complete'));assert.equal(await response.text(),'');
});

test('a pre-aborted caller is rejected before service dispatch',async()=>{
 const caller=new AbortController(),reason=Error('synthetic_before_dispatch');caller.abort(reason);let calls=0;
 await assert.rejects(()=>service(async()=>{calls++;return new Response('ok');}).fetch('https://internal.invalid/op',{signal:caller.signal}),e=>e===reason);
 assert.equal(calls,0);
});

test('synchronous abort concurrent with returned headers rejects and cancels only once',async()=>{
 const caller=new AbortController(),reason=Error('synthetic_during_dispatch');let cancels=0;
 const body=new ReadableStream({cancel(){cancels++;}});
 const reply=service(async()=>{caller.abort(reason);return new Response(body);}).fetch('https://internal.invalid/op',{signal:caller.signal});
 await assert.rejects(reply,e=>e===reason);await immediate();assert.equal(cancels,1);
});

test('a caller abort before a rejected fetch keeps the caller reason',async()=>{
 const caller=new AbortController(),reason=Error('synthetic_abort_first'),providerError=Error('synthetic_provider_failure_after_abort');
 const pending=service(async()=>{caller.abort(reason);throw providerError;}).fetch('https://internal.invalid/op',{signal:caller.signal});
 await assert.rejects(pending,e=>e===reason);
});

test('a provider error with no prior abort keeps its original reason',async()=>{
 const caller=new AbortController(),providerError=Error('synthetic_provider_failure_first');
 const pending=service(async()=>{throw providerError;}).fetch('https://internal.invalid/op',{signal:caller.signal});
 await assert.rejects(pending,e=>e===providerError);caller.abort(Error('synthetic_later_abort'));
});

test('an observed abort takes priority over an already queued provider rejection',async()=>{
 const caller=new AbortController(),reason=Error('synthetic_observed_abort'),providerError=Error('synthetic_queued_provider_error');
 const pending=service(()=>{
  const failure=Promise.reject(providerError);
  queueMicrotask(()=>caller.abort(reason));
  return failure;
 }).fetch('https://internal.invalid/op',{signal:caller.signal});
 await assert.rejects(pending,e=>e===reason);
});

test('timeout before headers rejects and a late response is cancelled',async()=>{
 let complete,cancels=0;
 const pending=service(async()=>new Promise(resolve=>{complete=resolve;}),deadline).fetch('https://internal.invalid/op');
 await assert.rejects(pending,timeout);
 complete(new Response(new ReadableStream({cancel(){cancels++;}})));await immediate();assert.equal(cancels,1);
});

for(const mode of ['reject','never'])test(`abort preserves reason when upstream cancellation ${mode}s`,{timeout:2000},async()=>{
 const caller=new AbortController(),reason=Error('synthetic_cleanup_abort');let cancels=0;
 const response=await service(async()=>new Response(new ReadableStream({cancel(){cancels++;return mode==='reject'?Promise.reject(Error('synthetic_cleanup_error')):new Promise(()=>{});}}))).fetch('https://internal.invalid/op',{signal:caller.signal});
 caller.abort(reason);await assert.rejects(()=>response.text(),e=>e===reason);await immediate();assert.equal(cancels,1);
});
