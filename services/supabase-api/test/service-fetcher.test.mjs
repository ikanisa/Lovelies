import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AuthenticatedService} from '../src/service-fetcher.ts';
const secret='synthetic-private-service-secret-32-characters';
test('private transport permits only HTTPS or explicit loopback HTTP and pins authorization/destination',async()=>{
 for(const url of ['ftp://localhost','ws://127.0.0.1','http://service.example','https://user:password@private.example','https://private.example?url=other'])assert.throws(()=>new AuthenticatedService(url,secret),/Private service requires/);
 let observed;
 const service=new AuthenticatedService('https://private.example/prefix',secret,async request=>{observed=request;return Response.json({ok:true});});
 const response=await service.fetch('https://untrusted.invalid/internal/face?query=bound',{headers:{Authorization:'Bearer caller'}});assert.deepEqual(await response.json(),{ok:true});
 assert.equal(observed.url,'https://private.example/prefix/internal/face?query=bound');assert.equal(observed.headers.get('authorization'),'Bearer '+secret);assert.equal(observed.redirect,'manual');
});
test('private transport bounds missing response headers and late streaming bytes',async()=>{
 const never=new AuthenticatedService('http://127.0.0.1',secret,async()=>new Promise(()=>{}),20);
 await assert.rejects(()=>never.fetch('http://internal/send'),/private_service_timeout/);
 const stream=new AuthenticatedService('http://127.0.0.1',secret,async()=>new Response(new ReadableStream({start(output){output.enqueue(new Uint8Array([1]));}})),20);
 const response=await stream.fetch('http://internal/send');await assert.rejects(()=>response.arrayBuffer(),/private_service_timeout/);
});
test('private transport preserves caller cancellation and rejects credential-bearing redirects',async()=>{
 let observed;const controller=new AbortController(),reason=new Error('synthetic-caller-cancelled');
 const service=new AuthenticatedService('http://127.0.0.1',secret,async request=>{observed=request;return new Promise(()=>{});});
 const pending=service.fetch('http://internal/send',{signal:controller.signal});controller.abort(reason);
 await assert.rejects(pending,error=>error===reason);assert.equal(observed.signal.aborted,true);
 const redirect=new AuthenticatedService('https://private.example',secret,async()=>new Response(null,{status:307,headers:{Location:'https://elsewhere.invalid'}}));
 await assert.rejects(()=>redirect.fetch('http://internal/send'),/private_service_redirect_denied/);
});
test('private transport bounds actual request and response bytes even without trustworthy content lengths',async()=>{
 const limits={requestBytes:10,responseBytes:10};let calls=0;
 const service=new AuthenticatedService('http://127.0.0.1',secret,async request=>{calls++;await request.arrayBuffer();return new Response('ok');},1000,limits);
 await assert.rejects(()=>service.fetch('http://internal/send',{method:'POST',body:'x'.repeat(11)}),/private_service_request_too_large/);
 assert.equal(calls,1);
 await assert.rejects(()=>service.fetch('http://internal/send',{method:'POST',headers:{'Content-Length':'11'},body:'x'.repeat(11)}),/private_service_request_too_large/);
 assert.equal(calls,1,'known oversized body must not reach the network');
 let cancelled=false;
 const stream=new AuthenticatedService('http://127.0.0.1',secret,async()=>new Response(new ReadableStream({
   start(output){output.enqueue(new Uint8Array(6));output.enqueue(new Uint8Array(5));},cancel(){cancelled=true;},
 })),1000,limits);
 const response=await stream.fetch('http://internal/send');await assert.rejects(()=>response.arrayBuffer(),/private_service_response_too_large/);assert.equal(cancelled,true);
 const claimed=new AuthenticatedService('http://127.0.0.1',secret,async()=>new Response('x'.repeat(11),{headers:{'Content-Length':'11'}}),1000,limits);
 await assert.rejects(()=>claimed.fetch('http://internal/send'),/private_service_response_too_large/);
});
test('a response arriving after timeout is cancelled instead of being silently retained',async()=>{
 let finish,cancelled=false;
 const service=new AuthenticatedService('http://127.0.0.1',secret,async()=>new Promise(resolve=>finish=resolve),20);
 await assert.rejects(()=>service.fetch('http://internal/send'),/private_service_timeout/);
 finish(new Response(new ReadableStream({cancel(){cancelled=true;}})));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(cancelled,true);
});
