import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SupabasePrivateBucket } from '../src/storage.ts';
import { JSON_BODY_LIMITS } from '../src/types.ts';

const bucket = fetcher => new SupabasePrivateBucket('http://127.0.0.1:1','synthetic-secret','lovelies-photos',fetcher);
const opt = {metadataBody:'preview-read'};
const invalid = error => error?.status===503 && error?.code==='private_storage_metadata_invalid';
const metadata = {size:3,etag:'"synthetic-version"',metadata:{mimetype:'image/png'},user_metadata:{source_version:'synthetic-source'}};
const expected = {size:3,etag:'synthetic-version',customMetadata:{source_version:'synthetic-source'},httpMetadata:{contentType:'image/png'}};

test('preview info preserves ordinary metadata and the default path',async()=>{
 const b=bucket(async()=>Response.json(metadata));
 assert.deepEqual(await b.head('synthetic/object',opt),expected);
 assert.deepEqual(await b.head('synthetic/object'),expected);
});

test('preview info body times out without awaiting an uncooperative cancellation',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let cancelled=0,started;
 const ready=new Promise(resolve=>{started=resolve;});
 const body=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));started();},cancel(){cancelled++;return new Promise(()=>{});}});
 const b=bucket(async()=>new Response(body,{status:200,headers:{'content-type':'application/json'}}));
 const pending=b.head('synthetic/object',opt),outcome=pending.then(value=>({value}),error=>({error}));
 await ready;await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(JSON_BODY_LIMITS.timeoutMs+1);
 const result=await outcome;assert(invalid(result.error));assert.equal(cancelled,1);
});

test('default info after DELETE still waits past the preview deadline and can finish normally',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let stream,settled=false,cancelled=0;
 const body=new ReadableStream({start(controller){stream=controller;controller.enqueue(new TextEncoder().encode('{'));},cancel(){cancelled++;}});
 const requests=[];const b=bucket(async(_url,init={})=>{const method=init.method??'GET';requests.push(method);return method==='DELETE'?new Response(null,{status:200}):new Response(body,{status:200,headers:{'content-type':'application/json'}});});
 await b.delete('synthetic/object');const pending=b.head('synthetic/object');void pending.then(()=>{settled=true;},()=>{settled=true;});
 await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(JSON_BODY_LIMITS.timeoutMs+1);await new Promise(resolve=>setImmediate(resolve));
 try{assert.equal(settled,false);assert.equal(cancelled,0);assert.deepEqual(requests,['DELETE','GET']);}
 finally{stream.enqueue(new TextEncoder().encode('"size":3,"etag":"synthetic","metadata":{}}'));stream.close();}
 assert.equal((await pending).etag,'synthetic');
});

test('preview info rejects malformed JSON and cancels wrongly typed bodies',async()=>{
 const malformed=bucket(async()=>new Response('{broken',{status:200,headers:{'content-type':'application/json'}}));
 await assert.rejects(malformed.head('synthetic/object',opt),invalid);
 let cancelled=0;const body=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{"size":3}'));},cancel(){cancelled++;return new Promise(()=>{});}});
 const wrongType=bucket(async()=>new Response(body,{status:200,headers:{'content-type':'text/html'}}));
 await assert.rejects(wrongType.head('synthetic/object',opt),invalid);assert.equal(cancelled,1);
});

test('preview info rejects a body over the selected bound',async()=>{
 let cancelled=0;const data=new Uint8Array(8*1024*1024+1);data.fill(0x20);
 const body=new ReadableStream({start(c){c.enqueue(data);},cancel(){cancelled++;}});
 const b=bucket(async()=>new Response(body,{status:200,headers:{'content-type':'application/json'}}));
 await assert.rejects(b.head('synthetic/object',opt),invalid);assert.equal(cancelled,1);
});

test('preview opt-in preserves exact absence and unknown error handling',async()=>{
 const missing={statusCode:'404',error:'not_found',message:'Object not found',code:'NoSuchKey'};
 assert.equal(await bucket(async()=>Response.json(missing,{status:400})).head('synthetic/missing',opt),null);
 await assert.rejects(bucket(async()=>new Response(null,{status:404})).head('synthetic/missing',opt),error=>error?.status===503&&error?.code==='private_storage_unavailable');
});
