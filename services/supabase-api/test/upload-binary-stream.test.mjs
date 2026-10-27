/** Synthetic local fixture only; no real photos or provider calls. */
import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {runInNewContext} from 'node:vm';
import {handleProcessing} from '../src/processing.ts';
import {ApiError} from '../src/types.ts';
import {closeHarnesses,enroll,faceVerifierFixture,fixturePng,sha256,startHarness} from './runtime-harness.mjs';

after(closeHarnesses);
const CHUNK=262144,key=()=>crypto.randomUUID();
// The runtime cases deliberately use PGlite. A native-PostgreSQL run exercises
// its own fixtures and must not silently redirect these synthetic cases to it.
const pgliteTest=process.env.TEST_DATABASE_URL?test.skip:test;
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function within(promise,ms=5000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('synthetic fixture barrier deadline')),ms);})]);}finally{clearTimeout(timer);}}
async function setup(t,kind){
 // Never let this candidate connect to an externally configured PostgreSQL.
 assert.equal(process.env.TEST_DATABASE_URL,undefined,'external PostgreSQL is outside this synthetic fixture');
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});t.after(()=>h.close());
 const owner=await enroll(h);
 await h.json('/me/photo-preferences',{token:owner.token,body:{policy_version:'photo-policy-fixture-v1',processing_consent:true,operation_key:key()}});
 const size=kind==='chunk'?CHUNK+1:256,complete=new Uint8Array(size);complete.set(fixturePng('synthetic-binary-stream'));
 for(let i=100;i<complete.length;i++)complete[i]=i%251;
 const input={source:'personal',content_type:'image/png',byte_size:size,operation_key:key(),...(kind==='chunk'?{resumable:true,checksum_sha256:await sha256(complete)}:{})};
 const reserved=await h.json('/uploads/session',{token:owner.token,body:input},201);
 const original=new Uint8Array(kind==='chunk'?complete.subarray(0,CHUNK):complete),changed=new Uint8Array(original);changed[original.length-1]^=1;
 const beforeOriginal=new Uint8Array(original),beforeChanged=new Uint8Array(changed);
 assert.notEqual(await sha256(beforeOriginal),await sha256(beforeChanged));
 return {h,owner,reserved,original,changed,beforeOriginal,beforeChanged};
}
function requestFor(kind,owner,id,body,hash,signal){
 const path=kind==='chunk'?`/uploads/${id}/chunks?offset=0`:`/uploads/${id}`;
 return new Request('https://api.invalid'+path,{method:'PUT',headers:{authorization:'Bearer '+owner.token,'content-type':'image/png',...(kind==='chunk'?{'X-Lovelies-Chunk-SHA256':hash}:{})},body,duplex:'half',...(signal?{signal}:{})});
}
/** Deliver exactly one real reader result, then hold the next real authority
 * transaction before its callback. The handler itself is the unmodified source. */
function installReadBarrier(request,db){
 const stream=request.body,originalGetReader=stream.getReader.bind(stream),originalTransaction=db.transaction;
 const entered=deferred(),release=deferred();let delivered=false,consumed=false,reads=0,firstBytes,firstView;
 Object.defineProperty(stream,'getReader',{configurable:true,value:(...args)=>{
  const reader=originalGetReader(...args);return {read:async()=>{const item=await reader.read();if(!item.done&&!delivered){reads++;firstView=item.value;firstBytes=new Uint8Array(item.value);delivered=true;}return item;},cancel:(...xs)=>reader.cancel(...xs),releaseLock:()=>reader.releaseLock()};
 }});
 db.transaction=async function(callback,...args){if(delivered&&!consumed){consumed=true;entered.resolve();await release.promise;}return originalTransaction.call(this,callback,...args);};
 return {entered:entered.promise,release:()=>release.resolve(),state:()=>({delivered,consumed,reads,firstBytes,firstView}),restore:()=>{delete stream.getReader;db.transaction=originalTransaction;}};
}
async function counts(h,id){
 const rows=await h.storage.exec('SELECT status,object_key,checksum_sha256 FROM assets WHERE id=?',id);
 const chunks=await h.storage.exec('SELECT offset_bytes,byte_size,sha256,object_key FROM upload_chunks WHERE asset_id=? ORDER BY offset_bytes',id);
 const intents=await h.storage.exec('SELECT bucket,object_key,status FROM media_write_intents WHERE account_id=(SELECT owner_id FROM assets WHERE id=?) ORDER BY object_key',id);
 return {asset:rows[0],chunks,intents,objects:[...h.env.QUARANTINE.rows.keys()].sort()};
}
for(const kind of ['source','chunk'])pgliteTest(`${kind} snapshots synthetic caller bytes before the awaited authority check`,{timeout:30000},async t=>{
 const f=await setup(t,kind),{h,owner,reserved,original,changed,beforeOriginal,beforeChanged}=f;
 const expectedHash=await sha256(beforeOriginal),id=reserved.asset_id,before=await counts(h,id),stream=new ReadableStream({pull(controller){controller.enqueue(original);controller.close();}},{highWaterMark:0});
 const request=requestFor(kind,owner,id,stream,expectedHash),barrier=installReadBarrier(request,h.db);
 const pending=h.db.invocation(()=>handleProcessing(request,h.app));void pending.catch(()=>{});
 try{
  await within(barrier.entered);const observed=barrier.state();assert(observed.delivered&&observed.consumed&&observed.reads===1,'must hold after the actual first nondone read');assert.deepEqual(observed.firstBytes,beforeOriginal);assert.equal(observed.firstView.buffer,original.buffer,'fixture must deliver the same backing store');assert.equal(observed.firstView.byteOffset,original.byteOffset);assert.equal(observed.firstView.byteLength,original.byteLength);
  original.set(changed);barrier.release();const response=await within(pending,10000);const value=await response.json();
  assert.equal(response.status,200,JSON.stringify(value));assert.deepEqual(original,beforeChanged,'reader must never zero/mutate producer memory');
  const after=await counts(h,id),newObjects=after.objects.filter(x=>!before.objects.includes(x));assert.equal(newObjects.length,1,'one private write for the incomplete first chunk or source');
  const object=h.env.QUARANTINE.rows.get(newObjects[0]);assert(object);assert.deepEqual(object.data,beforeOriginal);assert.equal(await sha256(object.data),expectedHash);
  const intent=after.intents.find(x=>x.object_key===newObjects[0]);assert(intent);assert.equal(intent.bucket,'QUARANTINE');assert.equal(intent.status,'settled');
  if(kind==='source'){assert.equal(after.asset.status,'uploaded');assert.equal(after.asset.checksum_sha256,expectedHash);assert.equal(after.asset.object_key,newObjects[0]);assert.deepEqual(after.chunks,before.chunks);}
  else{assert.equal(after.asset.status,'uploading');assert.equal(after.chunks.length,before.chunks.length+1);const chunk=after.chunks.find(x=>x.offset_bytes===0);assert(chunk);assert.equal(chunk.byte_size,CHUNK);assert.equal(chunk.sha256,expectedHash);assert.equal(chunk.object_key,newObjects[0]);const transfer=(await h.storage.exec('SELECT bytes_received,state FROM upload_transfers WHERE asset_id=?',id))[0];assert.equal(transfer.bytes_received,CHUNK);assert.equal(transfer.state,'uploading');}
 }finally{barrier.release();barrier.restore();await within(Promise.allSettled([pending]),10000);}
});

pgliteTest('chunk compares the snapshotted bytes to the supplied checksum before any write', {timeout:30000}, async t=>{
 const {h,owner,reserved,original,changed,beforeOriginal,beforeChanged}=await setup(t,'chunk');
 const id=reserved.asset_id,before=await counts(h,id),wrongHash=await sha256(beforeChanged);
 const stream=new ReadableStream({pull(controller){controller.enqueue(original);controller.close();}},{highWaterMark:0});
 const request=requestFor('chunk',owner,id,stream,wrongHash),barrier=installReadBarrier(request,h.db);
 const pending=h.db.invocation(()=>handleProcessing(request,h.app));void pending.catch(()=>{});
 try{
  await within(barrier.entered);const observed=barrier.state();assert.equal(observed.reads,1);assert.deepEqual(observed.firstBytes,beforeOriginal);
  assert.equal(observed.firstView.buffer,original.buffer,'fixture must deliver the same backing store');assert.equal(observed.firstView.byteOffset,original.byteOffset);assert.equal(observed.firstView.byteLength,original.byteLength);
  original.set(changed);barrier.release();
  await assert.rejects(within(pending,10000),error=>error instanceof ApiError&&error.status===400&&error.code==='upload_chunk_checksum_mismatch');
  assert.deepEqual(await counts(h,id),before,'checksum rejection must not create an object, intent, chunk, or asset mutation');
  const transfer=(await h.storage.exec('SELECT bytes_received,state FROM upload_transfers WHERE asset_id=?',id))[0];assert.equal(transfer.bytes_received,0);assert.equal(transfer.state,'uploading');
 }finally{barrier.release();barrier.restore();await within(Promise.allSettled([pending]),10000);}
});
for(const kind of ['source','chunk'])pgliteTest(`${kind} stops a stalled incoming reader after abort before any new media write`,{timeout:30000},async t=>{
 const {h,owner,reserved,beforeOriginal}=await setup(t,kind),id=reserved.asset_id,before=await counts(h,id),entered=deferred(),release=deferred(),cancelEntered=deferred(),cancelRelease=deferred(),controller=new AbortController();let cancels=0;
 const stream=new ReadableStream({pull(out){return release.promise.then(()=>{try{out.error(Error('synthetic fixture shutdown'));}catch{}});},cancel(){cancels++;cancelEntered.resolve();return cancelRelease.promise;}},{highWaterMark:0});
 const request=requestFor(kind,owner,id,stream,await sha256(beforeOriginal),controller.signal),body=request.body,getReader=body.getReader.bind(body);
 Object.defineProperty(body,'getReader',{configurable:true,value:(...args)=>{const reader=getReader(...args);return {read:(...xs)=>{entered.resolve();return reader.read(...xs);},cancel:(...xs)=>reader.cancel(...xs),releaseLock:()=>reader.releaseLock()};}});
 const pending=h.db.invocation(()=>handleProcessing(request,h.app));void pending.catch(()=>{});
 try{
  await within(entered.promise);controller.abort(Error('synthetic private abort'));
  const settled=await Promise.race([pending.then(response=>({response}),error=>({error})),new Promise(resolve=>setTimeout(()=>resolve(null),1000))]);
  assert(settled,'body abort must settle before the uncooperative producer is released');
  if(settled.response)assert(settled.response.status>=400,'abort must not return success');
  else assert(settled.error instanceof ApiError&&settled.error.status>=400&&settled.error.status<600,'abort must produce a controlled API error');
  await within(cancelEntered.promise);assert(cancels>=1,'reader cancellation must be requested, not assumed settled');assert.deepEqual(await counts(h,id),before);
 }finally{release.resolve();cancelRelease.resolve();delete body.getReader;await within(Promise.allSettled([pending]),10000);}
});

for(const kind of ['source','chunk'])pgliteTest(`${kind} rejects a finite empty-fragment flood without private writes`,{timeout:30000},async t=>{
 const {UPLOAD_BODY_MAX_EMPTY_FRAGMENTS}=await import('../src/upload-body.ts');
 const {h,owner,reserved,beforeOriginal}=await setup(t,kind),id=reserved.asset_id,before=await counts(h,id);let produced=0,cancels=0;
 const stream=new ReadableStream({pull(out){produced++;out.enqueue(new Uint8Array(0));},cancel(){cancels++;}},{highWaterMark:0});
 const request=requestFor(kind,owner,id,stream,await sha256(beforeOriginal));
 await assert.rejects(within(h.db.invocation(()=>handleProcessing(request,h.app)),15000),error=>error instanceof ApiError&&error.status===413&&error.code==='upload_body_fragment_limit');
 assert.equal(produced,UPLOAD_BODY_MAX_EMPTY_FRAGMENTS+1);assert.equal(cancels,1);assert.deepEqual(await counts(h,id),before);
 if(kind==='chunk'){const transfer=(await h.storage.exec('SELECT bytes_received,state FROM upload_transfers WHERE asset_id=?',id))[0];assert.equal(transfer.bytes_received,0);assert.equal(transfer.state,'uploading');}
});

for(const kind of ['source','chunk'])pgliteTest(`${kind} rechecks the actual session after reading before any private write`,{timeout:30000},async t=>{
 const {h,owner,reserved,original,beforeOriginal}=await setup(t,kind),id=reserved.asset_id,before=await counts(h,id);
 const stream=new ReadableStream({pull(out){out.enqueue(original);out.close();}},{highWaterMark:0});
 const request=requestFor(kind,owner,id,stream,await sha256(beforeOriginal)),barrier=installReadBarrier(request,h.db);
 const pending=h.db.invocation(()=>handleProcessing(request,h.app));void pending.catch(()=>{});
 try{
  await within(barrier.entered);assert.equal(barrier.state().reads,1);
  await h.storage.exec('UPDATE sessions SET revoked_at=? WHERE account_id=?',Date.now(),owner.accountId);
  barrier.release();
  await assert.rejects(within(pending,10000),error=>error instanceof ApiError&&error.status===401&&error.code==='session_invalid');
  assert.deepEqual(await counts(h,id),before);assert.deepEqual(original,beforeOriginal);
 }finally{barrier.release();barrier.restore();await within(Promise.allSettled([pending]),10000);}
});

for(const kind of ['source','chunk'])pgliteTest(`${kind} abort while authority is held prevents storage dispatch`,{timeout:30000},async t=>{
 const {h,owner,reserved,original,beforeOriginal}=await setup(t,kind),id=reserved.asset_id,before=await counts(h,id),controller=new AbortController();
 const stream=new ReadableStream({pull(out){out.enqueue(original);out.close();}},{highWaterMark:0});
 const request=requestFor(kind,owner,id,stream,await sha256(beforeOriginal),controller.signal),barrier=installReadBarrier(request,h.db);
 const pending=h.db.invocation(()=>handleProcessing(request,h.app));void pending.catch(()=>{});
 try{
  await within(barrier.entered);assert.equal(barrier.state().reads,1);controller.abort();barrier.release();
  await assert.rejects(within(pending,10000),error=>error instanceof ApiError&&error.status===400&&error.code==='upload_body_aborted');
  assert.deepEqual(await counts(h,id),before);assert.deepEqual(original,beforeOriginal);
 }finally{barrier.release();barrier.restore();await within(Promise.allSettled([pending]),10000);}
});

test('upload body acquisition deadline interrupts a stalled read and requests cleanup', {timeout:30000}, async ()=>{
 const {UploadBodyReader}=await import('../src/upload-body.ts'),cancelled=deferred(),release=deferred();
 const stream=new ReadableStream({pull(){return release.promise;},cancel(){cancelled.resolve();}},{highWaterMark:0});
 const request=new Request('https://api.invalid/upload',{method:'PUT',body:stream,duplex:'half'}),reader=new UploadBodyReader(request,25);
 try{
  await assert.rejects(within(reader.readInto(new Uint8Array(10),0,'image_too_large'),2000),error=>error instanceof ApiError&&error.status===408&&error.code==='upload_body_timeout');
 }finally{reader.close();release.resolve();}
 await within(cancelled.promise);
});

test('total nonempty fragment limit is finite', {timeout:90000}, async ()=>{
 const {UploadBodyReader,UPLOAD_BODY_MAX_FRAGMENTS}=await import('../src/upload-body.ts');let sent=0;
 const stream=new ReadableStream({pull(out){sent++;out.enqueue(Uint8Array.of(42));},cancel(){}},{highWaterMark:0});
 const request=new Request('https://api.invalid/upload',{method:'PUT',body:stream,duplex:'half'}),reader=new UploadBodyReader(request,60000),bytes=new Uint8Array(UPLOAD_BODY_MAX_FRAGMENTS+1);
 try{
  for(let offset=0;offset<UPLOAD_BODY_MAX_FRAGMENTS;offset++){const next=await reader.readInto(bytes,offset,'image_too_large');assert.equal(next.length,1);}
  await assert.rejects(reader.readInto(bytes,UPLOAD_BODY_MAX_FRAGMENTS,'image_too_large'),error=>error instanceof ApiError&&error.status===413&&error.code==='upload_body_fragment_limit');
  assert.equal(sent,UPLOAD_BODY_MAX_FRAGMENTS+1);
 }finally{reader.close();bytes.fill(0);}
});

for(const kind of ['source','chunk'])pgliteTest(`${kind} rejects an oversized stored asset before locking the body`,{timeout:30000},async t=>{
 const {UPLOAD_MAX_SOURCE_BYTES}=await import('../src/upload-body.ts');
 const {h,owner,reserved,beforeOriginal}=await setup(t,kind),id=reserved.asset_id;
 await h.storage.exec('UPDATE assets SET byte_size=? WHERE id=?',UPLOAD_MAX_SOURCE_BYTES+1,id);
 const before=await counts(h,id);let acquired=0;
 const stream=new ReadableStream({start(out){out.enqueue(beforeOriginal);out.close();}}),request=requestFor(kind,owner,id,stream,await sha256(beforeOriginal));
 const originalGetReader=request.body.getReader.bind(request.body);
 Object.defineProperty(request.body,'getReader',{configurable:true,value:(...args)=>{acquired++;return originalGetReader(...args);}});
 try{
  await assert.rejects(h.db.invocation(()=>handleProcessing(request,h.app)),error=>error instanceof ApiError&&error.status===413&&error.code==='image_too_large');
  assert.equal(acquired,0);assert.deepEqual(await counts(h,id),before);
 }finally{delete request.body.getReader;await request.body.cancel().catch(()=>{});}
});

async function viewReader(view){
 const {UploadBodyReader}=await import('../src/upload-body.ts');
 const stream=new ReadableStream({start(out){out.enqueue(view);out.close();}});
 const request=new Request('https://api.invalid/upload',{method:'PUT',body:stream,duplex:'half'});
 return new UploadBodyReader(request,1000);
}
for(const [label,make] of [
 ['foreign Uint8Array',()=>runInNewContext('new Uint8Array([9, 8, 7])')],
 ['Buffer subarray',()=>Buffer.from([0, 9, 8, 7, 0]).subarray(1,4)],
 ['overridden getters',()=>{const value=Uint8Array.of(9,8,7);Object.defineProperty(value,'byteLength',{value:999});Object.defineProperty(value,'buffer',{value:new ArrayBuffer(0)});return value;}],
])test(`upload reader copies ${label} using intrinsic byte view state`,async()=>{
 const value=make(),reader=await viewReader(value),target=new Uint8Array(5);
 try{const result=await reader.readInto(target,1,'image_too_large');assert.equal(result.length,3);assert.deepEqual([...target],[0,9,8,7,0]);}
 finally{reader.close();}
});
test('upload reader rejects a DataView with a spoofed Uint8Array tag',async()=>{
 const value=new DataView(new ArrayBuffer(3));Object.defineProperty(value,Symbol.toStringTag,{value:'Uint8Array'});const reader=await viewReader(value);
 try{await assert.rejects(reader.readInto(new Uint8Array(3),0,'image_too_large'),error=>error instanceof ApiError&&error.code==='invalid_upload_body');}
 finally{reader.close();}
});
test('upload reader maps detached bytes to a controlled error',async()=>{
 const buffer=new ArrayBuffer(3),value=new Uint8Array(buffer);structuredClone(buffer,{transfer:[buffer]});const reader=await viewReader(value);
 try{await assert.rejects(reader.readInto(new Uint8Array(3),0,'image_too_large'),error=>error instanceof ApiError&&error.code==='invalid_upload_body');}
 finally{reader.close();}
});
for(const foreign of [false,true])test(`upload reader rejects ${foreign?'foreign':'host'} shared backing`,async t=>{
 if(typeof SharedArrayBuffer==='undefined'){t.skip('SharedArrayBuffer unavailable');return;}
 const value=foreign?runInNewContext('new Uint8Array(new SharedArrayBuffer(3))'):new Uint8Array(new SharedArrayBuffer(3));
 Object.defineProperty(value,'buffer',{value:new ArrayBuffer(3)});const reader=await viewReader(value);
 try{await assert.rejects(reader.readInto(new Uint8Array(3),0,'image_too_large'),error=>error instanceof ApiError&&error.code==='invalid_upload_body');}
 finally{reader.close();}
});
