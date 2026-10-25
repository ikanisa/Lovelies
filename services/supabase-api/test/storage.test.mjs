import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SupabasePrivateBucket} from '../src/storage.ts';

const missing={statusCode:'404',error:'not_found',message:'Object not found',code:'NoSuchKey'};
const bucket=fetcher=>new SupabasePrivateBucket('http://127.0.0.1:54321','sb_secret_owned_fixture','lovelies-photos',fetcher);
const unavailable=operation=>assert.rejects(operation,error=>error.status===503&&error.code==='private_storage_unavailable');

test('Storage exact HTTP400 NoSuchKey and native404 establish missing HEAD/GET only',async()=>{
 for(const response of [()=>Response.json(missing,{status:400}),()=>new Response(null,{status:404})]){
  assert.equal(await bucket(async()=>response()).head('owned/missing'),null);
  assert.equal(await bucket(async()=>response()).get('owned/missing'),null);
 }
 let calls=0;
 const raced=bucket(async()=>++calls===1?Response.json({size:3,etag:'owned-version',metadata:{}}):Response.json(missing,{status:400}));
 assert.equal(await raced.get('owned/deleted-between-info-and-get'),null);assert.equal(calls,2);
});

test('Storage exact absence envelope never makes failed POST/DELETE successful',async()=>{
 const failed=bucket(async()=>Response.json(missing,{status:400}));
 await unavailable(()=>failed.put('owned/missing',new Uint8Array([1])));
 await unavailable(()=>failed.delete('owned/missing'));
});

test('Storage arbitrary400, denied credentials and mismatched envelopes remain failures',async()=>{
 const cases=[
  [400,{}],[400,{message:'Object not found'}],[400,{...missing,statusCode:'403'}],
  [400,{...missing,error:'access_denied'}],[400,{...missing,code:'InvalidJWT'}],
  [400,{...missing,message:'Bucket not found'}],[400,{...missing,statusCode:404}],
  [400,{...missing,extra:'unrecognized'}],[400,[missing]],[400,null],
  [401,missing],[403,missing],[500,missing],
 ];
 for(const [status,body] of cases)await unavailable(()=>bucket(async()=>Response.json(body,{status})).head('owned/missing'));
 await unavailable(()=>bucket(async()=>new Response(JSON.stringify(missing),{status:400,headers:{'content-type':'text/html'}})).head('owned/missing'));
 await unavailable(()=>bucket(async()=>new Response('{broken',{status:400,headers:{'content-type':'application/json'}})).head('owned/missing'));
});

test('Storage error envelope byte, encoding and time limits fail closed and cancel bodies',async()=>{
 for(const headers of [
  {'content-type':'application/json','content-length':'2049'},
  {'content-type':'application/json','content-length':'invalid'},
 ])await unavailable(()=>bucket(async()=>new Response(JSON.stringify(missing),{status:400,headers})).head('owned/missing'));
 await unavailable(()=>bucket(async()=>new Response(' '.repeat(2049)+JSON.stringify(missing),{
  status:400,headers:{'content-type':'application/json'}})).head('owned/missing'));
 await unavailable(()=>bucket(async()=>new Response(new Uint8Array([0xff,0xfe]),{
  status:400,headers:{'content-type':'application/json'}})).head('owned/missing'));
 let cancelled=false;
 const hanging=bucket(async()=>new Response(new ReadableStream({start(output){output.enqueue(new TextEncoder().encode('{'));},
  cancel(){cancelled=true;return new Promise(()=>{});}}),{status:400,headers:{'content-type':'application/json'}}));
 const started=Date.now();await unavailable(()=>hanging.head('owned/missing'));
 assert(Date.now()-started<2500,'Unresponsive error body must not keep the missing-object probe alive');assert(cancelled);
});
