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

test('Storage absence parsing keeps the bytes actually read when a stream reuses its buffer',async()=>{
 const encoder=new TextEncoder(),first=encoder.encode('{"statusCode":"403","error":"not_found",'),second=encoder.encode('"message":"Object not found","code":"NoSuchKey"}');
 let reads=0;
 const body=new ReadableStream({pull(controller){
  if(reads++===0){controller.enqueue(first);return;}
  return new Promise(resolve=>setTimeout(()=>{first.set(encoder.encode('{"statusCode":"404","error":"not_found",'));controller.enqueue(second);controller.close();resolve();},0));
 }});
 await unavailable(()=>bucket(async()=>new Response(body,{status:400,headers:{'content-type':'application/json'}})).head('owned/missing'));
});

test('Storage absence parsing rejects an excessive number of empty fragments',async()=>{
 let reads=0,cancelled=false;
 const body=new ReadableStream({pull(controller){
  if(reads++<257)controller.enqueue(new Uint8Array());
  else{controller.enqueue(new TextEncoder().encode(JSON.stringify(missing)));controller.close();}
 },cancel(){cancelled=true;}});
 await unavailable(()=>bucket(async()=>new Response(body,{status:400,headers:{'content-type':'application/json'}})).head('owned/missing'));
 assert(cancelled);
});

test('Storage absence parsing rejects inconsistent declared lengths and locked bodies',async()=>{
 const encoded=new TextEncoder().encode(JSON.stringify(missing));
 const valid=new ReadableStream({start(controller){controller.enqueue(encoded.slice(0,17));controller.enqueue(encoded.slice(17));controller.close();}});
 assert.equal(await bucket(async()=>new Response(valid,{status:400,headers:{'content-type':'application/json','content-length':String(encoded.byteLength)}})).head('owned/missing'),null);
 for(const length of [0,encoded.byteLength-1,encoded.byteLength+1]){
  await unavailable(()=>bucket(async()=>new Response(encoded,{status:400,headers:{'content-type':'application/json','content-length':String(length)}})).head('owned/missing'));
 }
 const body=new ReadableStream({start(controller){controller.enqueue(encoded);controller.close();}}),response=new Response(body,{status:400,headers:{'content-type':'application/json'}}),reader=response.body.getReader();
 try{await unavailable(()=>bucket(async()=>response).head('owned/missing'));}finally{reader.releaseLock();}
});

test('Storage mismatched get does not await uncooperative response cleanup',async()=>{
 let finishCancel,signalCancel,cancelCount=0,fetchCount=0,timer;
 const cancelled=new Promise(resolve=>{signalCancel=resolve;}),release=new Promise(resolve=>{finishCancel=resolve;});
 const body=new ReadableStream({cancel(){cancelCount++;signalCancel();return release;}});
 const instance=bucket(async()=>{
  fetchCount++;
  if(fetchCount===1)return Response.json({size:3,etag:'first-version',metadata:{}});
  return new Response(body,{status:200,headers:{etag:'second-version'}});
 });
 const pending=instance.get('owned/synthetic');
 const outcome=pending.then(value=>({value}),error=>({error}));
 try{
  const cancellation=await Promise.race([cancelled.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),2000);})]);
  clearTimeout(timer);assert(cancellation,'response cancellation must be requested');
  const result=await Promise.race([outcome,new Promise(resolve=>{timer=setTimeout(()=>resolve({deadline:true}),600);})]);
  assert.notEqual(result.deadline,true,'response cleanup must not delay the operation');
  assert(result.error?.status===409&&result.error?.code==='private_object_changed');
  assert.equal(fetchCount,2);assert.equal(cancelCount,1);
 }finally{clearTimeout(timer);finishCancel();await Promise.race([outcome,new Promise(resolve=>{timer=setTimeout(resolve,2000);})]);clearTimeout(timer);}
});

test('Storage mismatched get preserves its error when response cancellation rejects',async()=>{
 let cancelCount=0,fetchCount=0;
 const body=new ReadableStream({cancel(){cancelCount++;throw Error('synthetic cancellation failure');}});
 const instance=bucket(async()=>{
  fetchCount++;
  if(fetchCount===1)return Response.json({size:3,etag:'first-version',metadata:{}});
  return new Response(body,{status:200,headers:{etag:'second-version'}});
 });
 await assert.rejects(instance.get('owned/synthetic'),error=>error.status===409&&error.code==='private_object_changed');
 assert.equal(fetchCount,2);assert.equal(cancelCount,1);
});
