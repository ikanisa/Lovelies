/** PGlite and synthetic memory transport only. No PostgreSQL URL or provider. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SupabasePrivateBucket} from '../src/storage.ts';
import {startHarness,enroll,faceVerifierFixture,fixturePng,sha256} from './runtime-harness.mjs';

const pgliteTest=process.env.TEST_DATABASE_URL===undefined?test:test.skip;
const base='http://127.0.0.1:1', bucketName='quarantine', secret='synthetic-local-only';
const key=()=>crypto.randomUUID();
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function within(promise,ms=5000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('synthetic test deadline')),ms);})]);}finally{clearTimeout(timer);}}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function cancellationResponse(mode){
 const entered=deferred(),release=deferred();let calls=0;
 const body=new ReadableStream({cancel(){calls++;entered.resolve();
  if(mode==='stall')return release.promise;
  if(mode==='reject')return Promise.reject(new Error('synthetic cancellation rejection'));
  return undefined;
 }});
 if(mode==='throw')Object.defineProperty(body,'cancel',{configurable:true,value(){calls++;entered.resolve();throw new Error('synthetic synchronous cancellation failure');}});
 return {response:new Response(body,{status:200}),entered:entered.promise,release:()=>release.resolve(),reject:()=>release.reject(new Error('synthetic late cancellation failure')),calls:()=>calls};
}
function simpleBucket(cls,fetcher){return new cls(base,secret,bucketName,fetcher);}
const rejectedWrite=fn=>assert.rejects(fn,error=>error?.status===503&&error?.code==='private_storage_write_failed');

for(const mode of ['stall','throw','reject'])test(`PUT ${mode} cleanup returns a bounded storage error`,{timeout:6000},async()=>{
 const fixture=cancellationResponse(mode);let dispatches=0;
 const put=simpleBucket(SupabasePrivateBucket,async()=>{dispatches++;return fixture.response;}).put('synthetic/candidate',new Uint8Array([1]));
 try{await within(fixture.entered);await within(rejectedWrite(()=>put));assert.equal(dispatches,1);assert.equal(fixture.calls(),1);}
 finally{fixture.release();}
});

test('a cancellation rejection after the timeout remains observed and cannot change the error',{timeout:6000},async()=>{
 const fixture=cancellationResponse('stall');
 const put=simpleBucket(SupabasePrivateBucket,async()=>fixture.response).put('synthetic/late-rejection',new Uint8Array([1]));
 await within(fixture.entered);await within(rejectedWrite(()=>put));fixture.reject();await delay(20);assert.equal(fixture.calls(),1);
});

test('a locked PUT response body produces an unresolved-write error',{timeout:6000},async()=>{
 const response=new Response(new ReadableStream(),{status:200}),reader=response.body.getReader();
 try{await within(rejectedWrite(()=>simpleBucket(SupabasePrivateBucket,async()=>response).put('synthetic/locked',new Uint8Array([1]))));}
 finally{reader.releaseLock();await response.body.cancel();}
});

test('ordinary PUT cleanup and existing HTTP error classifications are preserved',{timeout:6000},async()=>{
 let calls=0;
 const ok=simpleBucket(SupabasePrivateBucket,async()=>{calls++;return Response.json({Key:'synthetic/ok',Id:'fixture-only'});});
 await within(ok.put('synthetic/ok',new Uint8Array([1])));assert.equal(calls,1);
 for(const [status,code] of [[400,'private_storage_unavailable'],[401,'private_storage_unavailable'],[403,'private_storage_unavailable'],[404,'private_storage_write_failed'],[500,'private_storage_unavailable'],[302,'storage_redirect_denied']]){
  await assert.rejects(()=>simpleBucket(SupabasePrivateBucket,async()=>new Response(null,{status})).put('synthetic/failed',new Uint8Array([1])),error=>error?.status===503&&error?.code===code);
 }
 const head=simpleBucket(SupabasePrivateBucket,async()=>new Response(null,{status:404}));
 await assert.rejects(()=>head.head('synthetic/missing'),error=>error?.status===503&&error?.code==='private_storage_unavailable');
 const del=simpleBucket(SupabasePrivateBucket,async()=>new Response(null,{status:404}));
 await assert.rejects(()=>del.delete('synthetic/missing'),error=>error?.status===503&&error?.code==='private_storage_unavailable');
});

/** Strictly in-memory fake. A later effect is independent of the local response
 * cancellation, so error handling cannot mistake the result for terminality. */
function simulatedStorage(memory,mode){
 const releaseRemote=deferred(),events=[],writes=[];let cancellation;
 const decode=(path,prefix)=>{assert(path.startsWith(prefix),'unexpected synthetic path');return path.slice(prefix.length).split('/').map(decodeURIComponent).join('/');};
 const fetcher=async(input,init={})=>{
  const url=new URL(String(input)),method=(init.method??'GET').toUpperCase();assert.equal(url.origin,base);
  assert.equal(new Headers(init.headers).get('apikey'),secret);
  if(method==='POST'&&url.pathname.startsWith('/storage/v1/object/'+bucketName+'/')){
   const target=decode(url.pathname,'/storage/v1/object/'+bucketName+'/'),headers=new Headers(init.headers);
   const bytes=init.body instanceof Uint8Array?new Uint8Array(init.body):new Uint8Array(init.body).slice();
   const metadata=JSON.parse(Buffer.from(headers.get('x-metadata')??'e30=','base64').toString('utf8'));
   const options={customMetadata:metadata,httpMetadata:{contentType:headers.get('content-type')??'application/octet-stream'}};
   events.push({kind:'put',target});
   const remote=mode==='normal'?memory.put(target,bytes,options):releaseRemote.promise.then(()=>memory.put(target,bytes,options));
   void remote.catch(()=>{});writes.push({target,remote});
   if(mode==='normal'){await remote;return Response.json({Key:bucketName+'/'+target,Id:'synthetic-control'});}
   cancellation=cancellationResponse(mode);return cancellation.response;
  }
  if(method==='DELETE'&&url.pathname==='/storage/v1/object/'+bucketName){
   const parsed=JSON.parse(String(init.body));assert(Array.isArray(parsed.prefixes));
   for(const target of parsed.prefixes){events.push({kind:'delete',target});await memory.delete(target);}
   return new Response(null,{status:200});
  }
  if(method==='GET'&&url.pathname.startsWith('/storage/v1/object/info/'+bucketName+'/')){
   const target=decode(url.pathname,'/storage/v1/object/info/'+bucketName+'/'),object=await memory.head(target);
   if(!object)return Response.json({statusCode:'404',error:'not_found',message:'Object not found',code:'NoSuchKey'},{status:400});
   return Response.json({size:object.size,etag:object.etag,content_type:object.httpMetadata?.contentType??'application/octet-stream',metadata:object.customMetadata});
  }
  if(method==='GET'&&url.pathname.startsWith('/storage/v1/object/authenticated/'+bucketName+'/')){
   const target=decode(url.pathname,'/storage/v1/object/authenticated/'+bucketName+'/'),object=await memory.get(target);
   if(!object)return Response.json({statusCode:'404',error:'not_found',message:'Object not found',code:'NoSuchKey'},{status:400});
   return new Response(await object.arrayBuffer(),{status:200,headers:{etag:'"'+object.etag+'"'}});
  }
  throw new Error('unexpected synthetic Storage route');
 };
 return {bucket:new SupabasePrivateBucket(base,secret,bucketName,fetcher),events,writes,
  cancellation:()=>cancellation,async release(){releaseRemote.resolve();cancellation?.release();await Promise.all(writes.map(w=>w.remote));}};
}
async function setup(t,kind,mode){
 assert.equal(process.env.TEST_DATABASE_URL,undefined,'external PostgreSQL prohibited');
 const h=await startHarness({faceVerifier:faceVerifierFixture,photoProcessor:()=>({}),consumeQueue:false});
 t.after(()=>h.close());const owner=await enroll(h);
 await h.json('/me/photo-preferences',{token:owner.token,body:{policy_version:'photo-policy-fixture-v1',processing_consent:true,operation_key:key()}});
 const chunkSize=262144,complete=new Uint8Array(kind==='chunk'?chunkSize+1:256);complete.set(fixturePng('synthetic-cleanup'));
 for(let i=100;i<complete.length;i++)complete[i]=i%251;
 const part=kind==='chunk'?complete.slice(0,chunkSize):complete.slice();
 const reservation=await h.json('/uploads/session',{token:owner.token,body:{source:'personal',content_type:'image/png',byte_size:complete.length,operation_key:key(),...(kind==='chunk'?{resumable:true,checksum_sha256:await sha256(complete)}:{})}},201);
 const memory=h.env.QUARANTINE,fake=simulatedStorage(memory,mode);h.env.QUARANTINE=fake.bucket;
 const path=kind==='chunk'?`/uploads/${reservation.asset_id}/chunks?offset=0`:`/uploads/${reservation.asset_id}`;
 const headers={'content-type':'image/png',...(kind==='chunk'?{'X-Lovelies-Chunk-SHA256':await sha256(part)}:{})};
 return {h,owner,reservation,part,path,headers,memory,fake};
}
async function facts(h,owner,id,target){
 const writer=await h.storage.exec("SELECT id,account_id,bucket,object_key,status,settled_at FROM media_write_intents WHERE account_id=? AND bucket='QUARANTINE' AND object_key=?",owner.accountId,target);
 const cleanup=await h.storage.exec("SELECT status,verified_at FROM cleanup_intents WHERE subject_id=? AND bucket='QUARANTINE' AND object_key=?",owner.accountId,target);
 const asset=(await h.storage.exec('SELECT status,object_key FROM assets WHERE id=?',id))[0];
 const count=async table=>Number((await h.storage.exec('SELECT count(*) n FROM '+table+' WHERE asset_id=?',id))[0].n);
 return {writer,cleanup,asset,chunks:await count('upload_chunks'),attempts:await count('processing_attempts'),outbox:await count('photo_job_outbox'),grants:await count('media_grants')};
}
function assertPending(state,owner,target,id){
 assert.equal(state.writer.length,1);assert.equal(state.writer[0].account_id,owner.accountId);assert.equal(state.writer[0].object_key,target);assert.equal(state.writer[0].status,'pending');assert.equal(state.writer[0].settled_at,null);
 assert.notEqual(state.asset.object_key,target,`unconfirmed writer for ${id} must not bind asset`);
 assert(['uploading','cancelled'].includes(state.asset.status));assert.equal(state.chunks,0);assert.equal(state.attempts,0);assert.equal(state.outbox,0);assert.equal(state.grants,0);
 assert(state.cleanup.length>=1,'a durable exact-key cleanup obligation must remain');assert(state.cleanup.every(row=>row.status!=='verified'&&row.verified_at===null));
}
for(const kind of ['source','chunk'])for(const mode of ['stall','throw','reject'])pgliteTest(`${kind}: ${mode} response cleanup leaves the exact writer unresolved`,{timeout:30000},async t=>{
 const {h,owner,reservation,part,path,headers,memory,fake}=await setup(t,kind,mode),id=reservation.asset_id;
 try{
  const response=await within(h.request(path,{token:owner.token,method:'PUT',raw:part,headers}),7000),body=await response.json();
  assert.equal(response.status,503);assert.equal(body?.error?.code,'private_storage_write_failed');assert.equal(fake.writes.length,1);assert.equal(fake.cancellation().calls(),1);
  const target=fake.writes[0].target,first=await facts(h,owner,id,target);assertPending(first,owner,target,id);
  if(kind==='chunk'){const cancelled=await h.json(`/uploads/${id}/cancel`,{token:owner.token,body:{operation_key:key()}});assert.equal(cancelled.status,'cancelled');}
  await within(h.alarm());assert.equal(await memory.head(target),null);assertPending(await facts(h,owner,id,target),owner,target,id);
  fake.events.push({kind:'before-late',target});await within(fake.release());assert(await memory.head(target),'the held remote effect must really arrive');
  await within(h.alarm());assertPending(await facts(h,owner,id,target),owner,target,id);assert(await memory.head(target));
  assert.equal(fake.events.some(event=>event.kind==='delete'&&event.target===target),false,'unknown writer cannot be erased or declared terminal');
  console.log('PUT_CLEANUP_OBSERVATION '+JSON.stringify({kind,mode,status:response.status,writer:'pending',cleanup_verified:false,publication:false,late_bytes_present:true,target_deleted:false}));
 }finally{await within(fake.release());}
});
for(const kind of ['source','chunk'])pgliteTest(`${kind}: ordinary synthetic PUT retains existing progress`,{timeout:30000},async t=>{
 const {h,owner,reservation,part,path,headers,memory,fake}=await setup(t,kind,'normal'),id=reservation.asset_id;
 try{
  const response=await within(h.request(path,{token:owner.token,method:'PUT',raw:part,headers}),7000),body=await response.json();
  assert.equal(response.status,200,JSON.stringify(body));assert.equal(fake.writes.length,1);const target=fake.writes[0].target,state=await facts(h,owner,id,target);
  assert.equal(state.writer.length,1);assert.equal(state.writer[0].status,'settled');assert(state.writer[0].settled_at!==null);assert.equal(await sha256(await(await memory.get(target)).arrayBuffer()),await sha256(part));
  assert.equal(state.attempts,0);assert.equal(state.outbox,0);assert.equal(state.grants,0);
  if(kind==='source'){assert.equal(state.asset.status,'uploaded');assert.equal(state.asset.object_key,target);assert.equal(state.chunks,0);}
  else{assert.equal(state.asset.status,'uploading');assert.equal(state.chunks,1);}
 }finally{await within(fake.release());}
});
