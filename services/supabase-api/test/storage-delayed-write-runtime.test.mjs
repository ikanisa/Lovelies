/** Synthetic local regression. No provider or network access. */
import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {SupabasePrivateBucket} from '../src/storage.ts';
import {startHarness,closeHarnesses,enroll,faceVerifierFixture,fixturePng,sha256} from './runtime-harness.mjs';
after(closeHarnesses);
// This fixture uses PGlite; a native PostgreSQL test run selects its own cases.
const pgliteTest=process.env.TEST_DATABASE_URL===undefined?test:test.skip;
const CHUNK=262144,key=()=>crypto.randomUUID();
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function within(promise,ms=15000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('synthetic fixture deadline')),ms);})]);}finally{clearTimeout(timer);}}

/** Emulate a private Storage server in memory, not a network service. The real
 * SupabasePrivateBucket constructs requests. In ambiguous mode its POST rejects
 * locally after dispatch while the copied remote write remains independently
 * releasable. Deletes may acknowledge absence before that delayed write arrives. */
function simulatedStorage(memory,mode){
 const release=deferred(),events=[],writes=[];
 const base='http://127.0.0.1:1',bucket='quarantine';
 const keyFrom=(path,prefix)=>{
  assert(path.startsWith(prefix),'fake transport accepts only fixed synthetic bucket routes');
  return path.slice(prefix.length).split('/').map(decodeURIComponent).join('/');
 };
 const fetcher=async(input,init={})=>{
  const url=new URL(String(input)),method=(init.method??'GET').toUpperCase();
  assert.equal(url.origin,base);const headers=new Headers(init.headers);
  assert.equal(headers.get('apikey'),'synthetic-local-only');
  if(method==='POST'&&url.pathname.startsWith('/storage/v1/object/'+bucket+'/')){
   const objectKey=keyFrom(url.pathname,'/storage/v1/object/'+bucket+'/');
   const value=init.body instanceof Uint8Array?new Uint8Array(init.body):new Uint8Array(init.body).slice();
   const customMetadata=JSON.parse(Buffer.from(headers.get('x-metadata')??'e30=','base64').toString('utf8'));
   const options={customMetadata,httpMetadata:{contentType:headers.get('content-type')??'application/octet-stream'}};
   events.push({kind:'put-dispatched',key:objectKey});
   if(mode==='ambiguous'){
    const remote=release.promise.then(async()=>{events.push({kind:'remote-write',key:objectKey});await memory.put(objectKey,value,options);});
    void remote.catch(()=>{});writes.push({key:objectKey,remote});
    throw Error('synthetic lost local PUT outcome');
   }
   assert.equal(mode,'acknowledged');await memory.put(objectKey,value,options);events.push({kind:'remote-write',key:objectKey});writes.push({key:objectKey,remote:Promise.resolve()});
   // This is a synthetic acknowledgement, not hosted-provider proof.
   return Response.json({Key:bucket+'/'+objectKey,Id:'synthetic-acknowledgement'});
  }
  if(method==='DELETE'&&url.pathname==='/storage/v1/object/'+bucket){
   const parsed=JSON.parse(String(init.body));assert(Array.isArray(parsed.prefixes));
   for(const objectKey of parsed.prefixes){events.push({kind:'delete',key:objectKey});await memory.delete(objectKey);}
   return new Response(null,{status:200});
  }
  if(method==='GET'&&url.pathname.startsWith('/storage/v1/object/info/'+bucket+'/')){
   const objectKey=keyFrom(url.pathname,'/storage/v1/object/info/'+bucket+'/');events.push({kind:'head',key:objectKey});
   const object=await memory.head(objectKey);if(!object)return Response.json({statusCode:'404',error:'not_found',message:'Object not found',code:'NoSuchKey'},{status:400});
   return Response.json({size:object.size,etag:object.etag,content_type:object.httpMetadata?.contentType??'application/octet-stream',metadata:object.customMetadata});
  }
  if(method==='GET'&&url.pathname.startsWith('/storage/v1/object/authenticated/'+bucket+'/')){
   const objectKey=keyFrom(url.pathname,'/storage/v1/object/authenticated/'+bucket+'/');events.push({kind:'get',key:objectKey});
   const object=await memory.get(objectKey);if(!object)return Response.json({statusCode:'404',error:'not_found',message:'Object not found',code:'NoSuchKey'},{status:400});
   return new Response(await object.arrayBuffer(),{status:200,headers:{etag:'"'+object.etag+'"'}});
  }
  throw Error('unexpected synthetic Storage route');
 };
 return {bucket:new SupabasePrivateBucket(base,'synthetic-local-only',bucket,fetcher),events,writes,
  release:async()=>{release.resolve();await Promise.all(writes.map(value=>value.remote));}};
}

async function setup(t,kind,mode){
 assert.equal(process.env.TEST_DATABASE_URL,undefined,'synthetic fixture must not connect to PostgreSQL');
 const h=await startHarness({faceVerifier:faceVerifierFixture,photoProcessor:()=>({}),consumeQueue:false});t.after(()=>h.close());
 const owner=await enroll(h);
 await h.json('/me/photo-preferences',{token:owner.token,body:{policy_version:'photo-policy-fixture-v1',processing_consent:true,operation_key:key()}});
 const complete=new Uint8Array(kind==='chunk'?CHUNK+1:256);complete.set(fixturePng('synthetic-delayed-write'));
 for(let i=100;i<complete.length;i++)complete[i]=i%251;
 const part=kind==='chunk'?complete.slice(0,CHUNK):complete.slice();
 const reserve={source:'personal',content_type:'image/png',byte_size:complete.byteLength,operation_key:key(),
  ...(kind==='chunk'?{resumable:true,checksum_sha256:await sha256(complete)}:{})};
 const receipt=await h.json('/uploads/session',{token:owner.token,body:reserve},201);
 const fake=simulatedStorage(h.env.QUARANTINE,mode);h.env.QUARANTINE=fake.bucket;
 const path=kind==='chunk'?`/uploads/${receipt.asset_id}/chunks?offset=0`:`/uploads/${receipt.asset_id}`;
 const headers={'content-type':'image/png',...(kind==='chunk'?{'X-Lovelies-Chunk-SHA256':await sha256(part)}:{})};
 return {h,owner,receipt,part,fake,path,headers};
}
async function factRows(h,owner,id,objectKey){
 const asset=(await h.storage.exec('SELECT status,object_key FROM assets WHERE id=?',id))[0]??null;
 const writers=await h.storage.exec("SELECT status FROM media_write_intents WHERE account_id=? AND bucket='QUARANTINE' AND object_key=?",owner.accountId,objectKey);
 const cleanup=await h.storage.exec("SELECT status FROM cleanup_intents WHERE subject_id=? AND bucket='QUARANTINE' AND object_key=?",owner.accountId,objectKey);
 const count=async table=>Number((await h.storage.exec('SELECT count(*) n FROM '+table+' WHERE asset_id=?',id))[0].n);
 return {asset,writer: writers.length===1?writers[0].status:null,writerCount:writers.length,
  cleanup:cleanup.map(row=>row.status),chunks:await count('upload_chunks'),attempts:await count('processing_attempts'),
  outbox:await count('photo_job_outbox'),grants:await count('media_grants')};
}

for(const kind of ['source','chunk'])pgliteTest(`${kind}: uncertain PUT keeps its intent pending and fences a delayed remote write`,{timeout:45000},async t=>{
 const {h,owner,receipt,part,fake,path,headers}=await setup(t,kind,'ambiguous'),id=receipt.asset_id;
 try{
  const upload=await within(h.request(path,{token:owner.token,method:'PUT',raw:part,headers}));
  const uploadStatus=upload.status;await upload.body?.cancel();
  assert.equal(fake.writes.length,1,'fixture must dispatch one actual handler PUT');
  const objectKey=fake.writes[0].key,first=await factRows(h,owner,id,objectKey);
  let cancellation=null,statusAfterCleanup=null;
  if(kind==='chunk'){
   cancellation=await h.json(`/uploads/${id}/cancel`,{token:owner.token,body:{operation_key:key()}});
   await within(h.alarm());statusAfterCleanup=await h.json(`/uploads/${id}/status`,{token:owner.token});
  }else await within(h.alarm());
  const beforeLate=await factRows(h,owner,id,objectKey),deletedBeforeLate=fake.events.some(event=>event.kind==='delete'&&event.key===objectKey);
  assert.equal(await h.env.QUARANTINE.head(objectKey),null,'the synthetic remote write is still held');
  await within(fake.release());
  assert(await h.env.QUARANTINE.head(objectKey),'the independent synthetic remote write must actually arrive');
  const complete=await within(h.request(`/uploads/${id}/complete`,{token:owner.token,body:{operation_key:key()}}));
  const completeStatus=complete.status;await complete.body?.cancel();
  const late=await factRows(h,owner,id,objectKey);
  // Collect every invariant before failing, so the preserved pre-fix output
  // identifies more than the first consequence of premature settlement.
  const violations=[];
  if(uploadStatus<400)violations.push({invariant:'ambiguous_upload_must_not_succeed',observed:uploadStatus});
  if(first.writerCount!==1||first.writer!=='pending')violations.push({invariant:'ambiguous_writer_stays_pending_after_local_rejection',observed:first.writer});
  if(deletedBeforeLate)violations.push({invariant:'no_immediate_delete_before_remote_outcome',observed:true});
  if(beforeLate.cleanup.includes('verified'))violations.push({invariant:'no_verified_cleanup_while_writer_unknown',observed:beforeLate.cleanup});
  if(kind==='chunk'&&(cancellation?.status!=='cancelled'||statusAfterCleanup?.cleanup_pending!==true))violations.push({invariant:'cancelled_transfer_reports_pending_cleanup',observed:statusAfterCleanup?.cleanup_pending??null});
  if(late.writerCount!==1||late.writer!=='pending')violations.push({invariant:'late_remote_writer_remains_fenced',observed:late.writer});
  if(late.asset?.object_key===objectKey||!['uploading','cancelled'].includes(late.asset?.status)||late.chunks||late.attempts||late.outbox||late.grants||completeStatus<400)
   violations.push({invariant:'late_bytes_never_become_published_authority',observed:{asset_status:late.asset?.status??null,bound:late.asset?.object_key===objectKey,chunks:late.chunks,attempts:late.attempts,outbox:late.outbox,grants:late.grants,complete_status:completeStatus}});
  assert.deepEqual(violations,[],'a locally rejected PUT is not a terminal remote-write outcome');
 }finally{await within(fake.release());}
});

for(const kind of ['source','chunk'])pgliteTest(`${kind}: acknowledged synthetic Storage PUT settles and permits the intended local progress`,{timeout:45000},async t=>{
 const {h,owner,receipt,part,fake,path,headers}=await setup(t,kind,'acknowledged'),id=receipt.asset_id;
 const upload=await within(h.request(path,{token:owner.token,method:'PUT',raw:part,headers}));
 const value=await upload.json();assert.equal(upload.status,200,JSON.stringify(value));assert.equal(fake.writes.length,1);
 const objectKey=fake.writes[0].key,rows=await factRows(h,owner,id,objectKey);
 assert.equal(rows.writerCount,1);assert.equal(rows.writer,'settled');assert.equal(await sha256(await(await h.env.QUARANTINE.get(objectKey)).arrayBuffer()),await sha256(part));
 assert.equal(rows.attempts,0);assert.equal(rows.outbox,0);assert.equal(rows.grants,0);
 if(kind==='source'){assert.equal(rows.asset.status,'uploaded');assert.equal(rows.asset.object_key,objectKey);assert.equal(rows.chunks,0);}
 else{assert.equal(rows.asset.status,'uploading');assert.equal(rows.chunks,1);const transfer=(await h.storage.exec('SELECT state,bytes_received FROM upload_transfers WHERE asset_id=?',id))[0];assert.equal(transfer.state,'uploading');assert.equal(transfer.bytes_received,CHUNK);}
});
