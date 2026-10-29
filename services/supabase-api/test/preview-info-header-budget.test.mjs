import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SupabasePrivateBucket} from '../src/storage.ts';
import {JSON_BODY_LIMITS} from '../src/types.ts';

const bucket=fetcher=>new SupabasePrivateBucket('http://127.0.0.1:1','synthetic-secret','lovelies-photos',fetcher);
const opt={metadataBody:'preview-read'};
const unavailable=e=>e?.status===503&&e?.code==='private_storage_unavailable';
const invalid=e=>e?.status===503&&e?.code==='private_storage_metadata_invalid';
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const metadata=()=>Response.json({size:3,etag:'synthetic',metadata:{mimetype:'image/png'},user_metadata:{source_version:'v1'}});

test('normal preview metadata completes and does not later abort its fetch signal',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let signal;
 const b=bucket(async(_url,init)=>{signal=init.signal;return metadata();});
 const head=await b.head('synthetic/source',opt);
 assert.equal(head.etag,'synthetic');assert.equal(head.size,3);assert.equal(head.customMetadata.source_version,'v1');
 assert(signal instanceof AbortSignal);assert.equal(signal.aborted,false);
 t.mock.timers.tick(JSON_BODY_LIMITS.timeoutMs+1);assert.equal(signal.aborted,false);
});

test('stalled preview headers time out despite ignored abort and late body is cancelled',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let signal,resolveFetch,cancelled=0;
 const b=bucket(async(_url,init)=>{signal=init.signal;return new Promise(resolve=>{resolveFetch=resolve;});});
 const pending=b.head('synthetic/source',opt),outcome=pending.then(value=>({value}),error=>({error}));
 await turn();t.mock.timers.tick(JSON_BODY_LIMITS.timeoutMs);
 assert(unavailable((await outcome).error));assert.equal(signal.aborted,true);
 const body=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('private-late-body'));},cancel(){cancelled++;return new Promise(()=>{});}});
 resolveFetch(new Response(body,{status:200,headers:{'content-type':'application/json'}}));
 await turn();await turn();assert.equal(cancelled,1);
});

test('late transport rejection after preview timeout is observed without an unhandled rejection',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let rejectFetch;const unhandled=[];
 const observe=reason=>unhandled.push(reason);process.on('unhandledRejection',observe);
 try{
  const b=bucket(async()=>new Promise((_resolve,reject)=>{rejectFetch=reject;}));
  const pending=b.head('synthetic/source',opt),outcome=pending.then(value=>({value}),error=>({error}));
  await turn();t.mock.timers.tick(JSON_BODY_LIMITS.timeoutMs);assert(unavailable((await outcome).error));
  rejectFetch(new Error('synthetic-late-rejection'));await turn();await turn();assert.deepEqual(unhandled,[]);
 }finally{process.removeListener('unhandledRejection',observe);}
});

test('a rejected late-body cancellation does not escape as an unhandled rejection',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let resolveFetch,cancelled=0;const unhandled=[];
 const observe=reason=>unhandled.push(reason);process.on('unhandledRejection',observe);
 try{
  const b=bucket(async()=>new Promise(resolve=>{resolveFetch=resolve;}));
  const pending=b.head('synthetic/source',opt),outcome=pending.then(value=>({value}),error=>({error}));
  await turn();t.mock.timers.tick(JSON_BODY_LIMITS.timeoutMs);assert(unavailable((await outcome).error));
  const body=new ReadableStream({cancel(){cancelled++;return Promise.reject(new Error('synthetic-cancel-rejection'));}},{highWaterMark:0});
  resolveFetch(new Response(body,{status:200,headers:{'content-type':'application/json'}}));
  await turn();await turn();assert.equal(cancelled,1);assert.deepEqual(unhandled,[]);
 }finally{process.removeListener('unhandledRejection',observe);}
});

test('a transport rejection before the budget preserves the original failure',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const error=new Error('synthetic transport');let signal;
 const b=bucket((_url,init)=>{signal=init.signal;throw error;});
 await assert.rejects(b.head('synthetic/source',opt),e=>e===error);
 assert.equal(signal.aborted,false);t.mock.timers.tick(JSON_BODY_LIMITS.timeoutMs+1);assert.equal(signal.aborted,false);
});

test('late error headers are discarded without reading an error envelope',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let resolveFetch,reads=0,cancelled=0;
 const b=bucket(async()=>new Promise(resolve=>{resolveFetch=resolve;}));
 const pending=b.head('synthetic/source',opt),outcome=pending.then(value=>({value}),error=>({error}));
 await turn();t.mock.timers.tick(JSON_BODY_LIMITS.timeoutMs);assert(unavailable((await outcome).error));
 const body=new ReadableStream({pull(){reads++;},cancel(){cancelled++;return new Promise(()=>{});}},{highWaterMark:0});
 resolveFetch(new Response(body,{status:400,headers:{'content-type':'application/json'}}));
 await turn();await turn();assert.equal(reads,0);assert.equal(cancelled,1);
});

test('monotonic expiry rejects late headers even before a delayed timer callback',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let now=0,resolveFetch,signal,cancelled=0;
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'performance');assert(descriptor?.configurable);
 Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>now}});
 try{
  const b=bucket(async(_url,init)=>{signal=init.signal;return new Promise(resolve=>{resolveFetch=resolve;});});
  const pending=b.head('synthetic/source',opt),outcome=pending.then(value=>({value}),error=>({error}));
  await turn();now=JSON_BODY_LIMITS.timeoutMs+1;
  const body=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('late'));},cancel(){cancelled++;return new Promise(()=>{});}});
  resolveFetch(new Response(body,{status:200,headers:{'content-type':'application/json'}}));
  assert(unavailable((await outcome).error));assert.equal(signal.aborted,true);await turn();assert.equal(cancelled,1);
 }finally{Object.defineProperty(globalThis,'performance',descriptor);}
});

test('monotonic expiry also takes precedence over a late transport rejection',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let now=0,rejectFetch,signal;
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'performance');assert(descriptor?.configurable);
 Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>now}});
 try{
  const b=bucket(async(_url,init)=>{signal=init.signal;return new Promise((_resolve,reject)=>{rejectFetch=reject;});});
  const pending=b.head('synthetic/source',opt),outcome=pending.then(value=>({value}),error=>({error}));
  await turn();now=JSON_BODY_LIMITS.timeoutMs+1;rejectFetch(new Error('synthetic late transport failure'));
  assert(unavailable((await outcome).error));assert.equal(signal.aborted,true);
 }finally{Object.defineProperty(globalThis,'performance',descriptor);}
});

test('headers and body share one budget rather than starting a second full deadline',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let resolveFetch,cancelled=0,settled=false;
 const b=bucket(async()=>new Promise(resolve=>{resolveFetch=resolve;}));
 const pending=b.head('synthetic/source',opt),outcome=pending.then(value=>({value}),error=>({error}));
 void pending.then(()=>{settled=true;},()=>{settled=true;});await turn();
 t.mock.timers.tick(40000);
 const body=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));},cancel(){cancelled++;return new Promise(()=>{});}});
 resolveFetch(new Response(body,{status:200,headers:{'content-type':'application/json'}}));await turn();
 t.mock.timers.tick(JSON_BODY_LIMITS.timeoutMs-40000-1);await turn();assert.equal(settled,false);
 t.mock.timers.tick(1);assert(invalid((await outcome).error));await turn();assert.equal(cancelled,1);
});

test('the same budget cancels an already-started stalled absence envelope',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let resolveFetch,signal,reads=0,cancelled=0;
 const b=bucket(async(_url,init)=>{signal=init.signal;return new Promise(resolve=>{resolveFetch=resolve;});});
 const pending=b.head('synthetic/source',opt),outcome=pending.then(value=>({value}),error=>({error}));
 await turn();t.mock.timers.tick(JSON_BODY_LIMITS.timeoutMs-500);
 const body=new ReadableStream({pull(){reads++;},cancel(){cancelled++;return new Promise(()=>{});}},{highWaterMark:0});
 resolveFetch(new Response(body,{status:400,headers:{'content-type':'application/json'}}));await turn();assert.equal(reads,1);
 t.mock.timers.tick(500);assert(unavailable((await outcome).error));assert.equal(signal.aborted,true);
 await turn();await turn();assert.equal(cancelled,1);
});

test('preview absence and redirect decisions remain classified as before',async()=>{
 const absent={statusCode:'404',error:'not_found',message:'Object not found',code:'NoSuchKey'};
 assert.equal(await bucket(async()=>Response.json(absent,{status:400})).head('synthetic/missing',opt),null);
 await assert.rejects(bucket(async()=>new Response(null,{status:302,headers:{location:'https://example.invalid'}})).head('synthetic/source',opt),
  e=>e?.status===503&&e?.code==='storage_redirect_denied');
});

test('non-preview HEAD, POST and DELETE remain pending beyond the preview budget',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const requests=[],release=[];
 const b=bucket(async(_url,init)=>{requests.push(init);return new Promise(resolve=>{release.push(resolve);});});
 for(const [action,response] of [
  [()=>b.head('synthetic/source'),()=>metadata()],
  [()=>b.put('synthetic/source',new Uint8Array([1])),()=>new Response(null,{status:200})],
  [()=>b.delete('synthetic/source'),()=>new Response(null,{status:200})],
 ]){
  let settled=false;const pending=action();void pending.then(()=>{settled=true;},()=>{settled=true;});
  await turn();t.mock.timers.tick(JSON_BODY_LIMITS.timeoutMs+1);await turn();
  try{assert.equal(settled,false);assert.equal(requests.at(-1).signal,undefined);}
  finally{release.shift()(response());}
  await pending;
 }
 assert.deepEqual(requests.map(init=>init.method??'GET'),['GET','POST','DELETE']);
});
