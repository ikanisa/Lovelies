/** One-subject synthetic Storage interleavings. PGlite only; no provider traffic. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SupabasePrivateBucket} from '../src/storage.ts';
import {processPhotoJob} from '../src/processing.ts';
import {flushPrivacyCleanup} from '../src/privacy.ts';
import {startHarness,enroll,faceVerifierFixture,fixturePng,sha256,deviceEnvelope,sign,encode,captureProofs} from './runtime-harness.mjs';

const local=process.env.TEST_DATABASE_URL===undefined?test:test.skip;
const key=()=>crypto.randomUUID();
function deferred(){let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};}
async function within(promise,ms=15000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('synthetic fixture deadline')),ms);})]);}finally{clearTimeout(timer);}}

/** The first matching write returns a 200 whose cancellation hangs, while its
 * in-memory remote effect is held independently. Later writes use distinct keys
 * and ordinary synthetic responses, allowing real caller retries to be observed. */
function faultBucket(memory,bucketName,targetPrefix,otherPutPrefixes=[]){
 const origin='http://127.0.0.1:1',secret='synthetic-local-only',releaseRemote=deferred(),releaseCancel=deferred();
 const initial=new Set(memory.rows.keys()),events=[],writes=[];let faulted=false,cancels=0;
 const allowed=key=>initial.has(key)||writes.some(row=>row.key===key)||key.startsWith(targetPrefix)||otherPutPrefixes.some(p=>key.startsWith(p));
 const decode=(path,prefix)=>{assert(path.startsWith(prefix));const value=path.slice(prefix.length).split('/').map(decodeURIComponent).join('/');assert(allowed(value),'unrelated synthetic object is outside this fixture');return value;};
 const fetcher=async(input,init={})=>{
  const url=new URL(String(input)),method=(init.method??'GET').toUpperCase(),headers=new Headers(init.headers);
  assert.equal(url.origin,origin);assert.equal(url.search,'');assert.equal(headers.get('apikey'),secret);assert.equal(headers.get('authorization'),null);
  if(method==='POST'&&url.pathname.startsWith('/storage/v1/object/'+bucketName+'/')){
   const objectKey=decode(url.pathname,'/storage/v1/object/'+bucketName+'/'),body=init.body instanceof Uint8Array?new Uint8Array(init.body):new Uint8Array(init.body).slice();
   const options={customMetadata:JSON.parse(Buffer.from(headers.get('x-metadata')??'e30=','base64').toString('utf8')),httpMetadata:{contentType:headers.get('content-type')??'application/octet-stream'}};
   const selected=objectKey.startsWith(targetPrefix)&&!faulted;events.push({kind:'put',key:objectKey,selected});
   const remote=selected?releaseRemote.promise.then(()=>memory.put(objectKey,body,options)):memory.put(objectKey,body,options);void remote.catch(()=>{});
   writes.push({key:objectKey,remote,selected});
   if(selected){faulted=true;const stream=new ReadableStream({cancel(){cancels++;return releaseCancel.promise;}});return new Response(stream,{status:200});}
   await remote;return Response.json({Key:bucketName+'/'+objectKey,Id:'synthetic-control'});
  }
  if(method==='DELETE'&&url.pathname==='/storage/v1/object/'+bucketName){
   const payload=JSON.parse(String(init.body));assert(Array.isArray(payload.prefixes));
   for(const objectKey of payload.prefixes){assert(allowed(objectKey));events.push({kind:'delete',key:objectKey});await memory.delete(objectKey);}return new Response(null,{status:200});
  }
  if(method==='GET'&&url.pathname.startsWith('/storage/v1/object/info/'+bucketName+'/')){
   const objectKey=decode(url.pathname,'/storage/v1/object/info/'+bucketName+'/'),value=await memory.head(objectKey);
   if(!value)return Response.json({statusCode:'404',error:'not_found',message:'Object not found',code:'NoSuchKey'},{status:400});
   return Response.json({size:value.size,etag:value.etag,content_type:value.httpMetadata?.contentType??'application/octet-stream',metadata:value.customMetadata});
  }
  if(method==='GET'&&url.pathname.startsWith('/storage/v1/object/authenticated/'+bucketName+'/')){
   const objectKey=decode(url.pathname,'/storage/v1/object/authenticated/'+bucketName+'/'),value=await memory.get(objectKey);
   if(!value)return Response.json({statusCode:'404',error:'not_found',message:'Object not found',code:'NoSuchKey'},{status:400});
   return new Response(await value.arrayBuffer(),{status:200,headers:{etag:'"'+value.etag+'"'}});
  }
  throw new Error('unexpected synthetic Storage route');
 };
 return {bucket:new SupabasePrivateBucket(origin,secret,bucketName,fetcher),events,writes,cancels:()=>cancels,
  async release(){releaseRemote.resolve();releaseCancel.resolve();await Promise.all(writes.map(row=>row.remote));}};
}
async function harness(t,extra={}){
 assert.equal(process.env.TEST_DATABASE_URL,undefined,'external PostgreSQL prohibited');
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false,...extra});t.after(()=>h.close());return h;
}
async function record(h,subject,bucket,target){
 const writes=await h.storage.exec('SELECT id,status,settled_at FROM media_write_intents WHERE account_id=? AND bucket=? AND object_key=?',subject,bucket,target);
 const cleanup=await h.storage.exec('SELECT status,verified_at FROM cleanup_intents WHERE subject_id=? AND bucket=? AND object_key=?',subject,bucket,target);
 assert.equal(writes.length,1,'exactly one original writer');assert.equal(writes[0].status,'pending');assert.equal(writes[0].settled_at,null);
 assert(cleanup.length>=1,'the exact unknown key keeps a cleanup obligation');assert(cleanup.every(row=>row.status!=='verified'&&row.verified_at===null));return writes[0].id;
}
function assertNotDeleted(fake,target){assert.equal(fake.events.some(row=>row.kind==='delete'&&row.key===target),false,'pending writer must fence cleanup');}
async function preference(h,owner){await h.json('/me/photo-preferences',{token:owner.token,body:{policy_version:'photo-policy-fixture-v1',processing_consent:true,operation_key:key()}});}
async function administrator(h){
 const p=await enroll(h);await h.storage.exec('UPDATE accounts SET roles_json=? WHERE id=?','["user","admin"]',p.accountId);
 const c=await h.json('/auth/face/challenge',{body:{face_handle:p.faceHandle,device_id:p.deviceId}},201);
 const credentials=await h.json('/auth/face/complete',{body:await captureProofs(h,c,p.keys.privateKey)});assert(credentials.roles.includes('admin'));return {...p,token:credentials.access_token};
}

local('assembly status retry uses a new key while its timed-out writer remains fenced',{timeout:45000},async t=>{
 const h=await harness(t),owner=await enroll(h);await preference(h,owner);
 const bytes=new Uint8Array(256);bytes.set(fixturePng('synthetic-assembly-cleanup'));for(let i=100;i<bytes.length;i++)bytes[i]=i%251;
 const receipt=await h.json('/uploads/session',{token:owner.token,body:{source:'personal',content_type:'image/png',byte_size:bytes.length,operation_key:key(),resumable:true,checksum_sha256:await sha256(bytes)}},201),id=receipt.asset_id;
 const memory=h.env.QUARANTINE,sourcePrefix=`source/${owner.accountId}/${id}/${receipt.version}/`,chunkPrefix=`upload-chunk/${owner.accountId}/${id}/`,fake=faultBucket(memory,'quarantine',sourcePrefix,[chunkPrefix]);h.env.QUARANTINE=fake.bucket;
 try{
  const response=await within(h.request(`/uploads/${id}/chunks?offset=0`,{token:owner.token,method:'PUT',raw:bytes,headers:{'content-type':'image/png','X-Lovelies-Chunk-SHA256':await sha256(bytes)}}));
  const body=await response.json();assert.equal(response.status,503);assert.equal(body.error.code,'private_storage_write_failed');
  const old=fake.writes.find(row=>row.selected)?.key;assert(old);assert.equal(fake.cancels(),1);const writerId=await record(h,owner.accountId,'QUARANTINE',old);
  const before=(await h.storage.exec('SELECT status,object_key FROM assets WHERE id=?',id))[0];assert.equal(before.status,'uploading');assert.notEqual(before.object_key,old);
  // Status legitimately retries assembly; observe it and require exact-key fencing.
  const status=await h.json(`/uploads/${id}/status`,{token:owner.token});assert.equal(status.status,'uploaded');
  const newWrites=fake.writes.filter(row=>row.key.startsWith(sourcePrefix));assert.equal(newWrites.length,2);assert.notEqual(newWrites[1].key,old);
  const current=(await h.storage.exec('SELECT status,object_key FROM assets WHERE id=?',id))[0];assert.equal(current.object_key,newWrites[1].key);assert.equal(current.status,'uploaded');
  assert.equal(await record(h,owner.accountId,'QUARANTINE',old),writerId);assertNotDeleted(fake,old);assert.equal(await memory.head(old),null);
  await within(fake.release());assert(await memory.head(old));await within(h.alarm());assert.equal(await record(h,owner.accountId,'QUARANTINE',old),writerId);assertNotDeleted(fake,old);assert(await memory.head(old));
  console.log('PUT_CALLER_OBSERVATION '+JSON.stringify({caller:'assembly',retry:'new-key-uploaded',old_writer:'pending',old_deleted:false,old_late_bytes:true}));
 }finally{await within(fake.release());}
});

const protocol='lovelies-face-enrollment-device-v1',policy='face-policy-fixture-v1';
async function faceStart(t){
 const h=await harness(t),anonymous=await h.anonymous({adult:true}),keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const jwk=await crypto.subtle.exportKey('jwk',keys.publicKey),saved={account_id:anonymous.account_id,enrollment_key:key(),face_handle:'lfh_'+encode(crypto.getRandomValues(new Uint8Array(32)))};
 const body={...saved,device_public_jwk:jwk,consent:{purpose:'face_authentication',policy_version:policy,granted:true}};
 body.device_signature=await sign(keys.privateKey,{protocol,step:'start',...saved,policy_version:policy,device_public_jwk:jwk});
 const challenge=await h.json('/auth/face/registration/challenge',{token:anonymous.access_token,body},201);return {h,anonymous,keys,saved,challenge};
}
async function faceCapture(f){
 const bytes=fixturePng('synthetic-capture:'+key()),digest=await sha256(bytes),mime='image/png';
 const signature=await sign(f.keys.privateKey,{...deviceEnvelope(f.challenge),step:'capture',capture_index:0,capture_sha256:digest,mime,byte_size:bytes.length});
 const response=await within(f.h.request(`/auth/face/proof/${f.challenge.challenge_id}/0`,{token:f.anonymous.access_token,method:'PUT',raw:bytes,headers:{'content-type':mime,'x-lovelies-capture-sha256':digest,'x-lovelies-capture-bytes':String(bytes.length),'x-lovelies-device-signature':signature}}));
 return {status:response.status,body:await response.json()};
}
async function faceResume(f){
 const body={...f.saved,request_nonce:key(),request_expires_at:Date.now()+45000,resume_key:key(),expected_generation:f.challenge.enrollment_generation,expected_challenge_id:f.challenge.challenge_id};
 body.device_signature=await sign(f.keys.privateKey,{protocol,step:'resume',...body});
 const response=await within(f.h.request('/auth/face/registration/resume',{token:f.anonymous.access_token,body}));return {status:response.status,body:await response.json()};
}
for(const kind of ['capture','template'])local(`face ${kind} timeout preserves the signed enrollment writer and blocks retry`,{timeout:45000},async t=>{
 const f=await faceStart(t),{h,anonymous,keys,saved,challenge}=f;
 const completion=kind==='template'?await captureProofs(h,challenge,keys.privateKey,{token:anonymous.access_token}):null;
 const bucket=kind==='capture'?'QUARANTINE':'PHOTOS',memory=h.env[bucket],prefix=kind==='capture'?`face-auth/${saved.account_id}/${challenge.challenge_id}/`:`registered-face/${saved.account_id}/`,fake=faultBucket(memory,kind==='capture'?'quarantine':'photos',prefix);h.env[bucket]=fake.bucket;
 try{
  let status,body;if(kind==='capture')({status,body}=await faceCapture(f));else{const r=await within(h.request('/auth/face/registration/complete',{token:anonymous.access_token,body:completion}));status=r.status;body=await r.json();}
  assert.equal(status,503);assert.equal(body.error.code,'private_storage_write_failed');const old=fake.writes.find(row=>row.selected)?.key;assert(old);assert.equal(fake.cancels(),1);const writerId=await record(h,saved.account_id,bucket,old);
  const count=async(sql,...params)=>Number((await h.storage.exec(sql,...params))[0].n);
  assert.equal(await count('SELECT count(*) n FROM face_profiles WHERE account_id=?',saved.account_id),0);assert.equal(await count("SELECT count(*) n FROM sessions WHERE account_id=? AND auth_method='registered_face'",saved.account_id),0);
  assert.equal(await count('SELECT count(*) n FROM auth_capture_proofs WHERE challenge_id=? AND object_key=?',challenge.challenge_id,old),0);
  const prior=fake.writes.length,retry=kind==='capture'?await faceCapture(f):await faceResume(f);assert.equal(retry.status,409);assert.equal(fake.writes.length,prior);
  await within(h.alarm());assert.equal(await memory.head(old),null);assertNotDeleted(fake,old);
  await within(fake.release());assert(await memory.head(old));await within(h.alarm());assert.equal(await record(h,saved.account_id,bucket,old),writerId);assertNotDeleted(fake,old);assert(await memory.head(old));
  assert.equal(await count('SELECT count(*) n FROM face_profiles WHERE account_id=?',saved.account_id),0);assert.equal(await count("SELECT count(*) n FROM sessions WHERE account_id=? AND auth_method='registered_face'",saved.account_id),0);
  console.log('PUT_CALLER_OBSERVATION '+JSON.stringify({caller:'face_'+kind,retry:'blocked',old_writer:'pending',old_deleted:false,old_late_bytes:true}));
 }finally{await within(fake.release());}
});

local('preview retry publishes only a new key while the timed-out key remains pending',{timeout:45000},async t=>{
 const preview=fixturePng('synthetic-preview'),h=await harness(t,{photoProcessor:envelope=>({...envelope,preview:{bytes_base64:Buffer.from(preview).toString('base64'),content_type:'image/png',width:1,height:1},matches:[]})}),owner=await enroll(h);await preference(h,owner);
 const bytes=fixturePng('synthetic-preview-source'),reservation=await h.json('/uploads/session',{token:owner.token,body:{source:'personal',content_type:'image/png',byte_size:bytes.length,operation_key:key()}},201),id=reservation.asset_id;
 await h.json(reservation.upload_url,{token:owner.token,method:'PUT',raw:bytes,headers:{'content-type':'image/png'}});
 const attempt=await h.json(reservation.complete_url,{token:owner.token,body:{operation_key:key()}},202),memory=h.env.PHOTOS,fake=faultBucket(memory,'photos',`preview/${owner.accountId}/${id}/`);h.env.PHOTOS=fake.bucket;
 try{
  await assert.rejects(()=>within(processPhotoJob({attempt_id:attempt.attempt_id},h.app)),error=>error?.status===503&&error?.code==='private_storage_write_failed');
  const old=fake.writes.find(row=>row.selected)?.key;assert(old);const writerId=await record(h,owner.accountId,'PHOTOS',old);
  assert.equal(Number((await h.storage.exec("SELECT count(*) n FROM renditions WHERE asset_id=? AND status='ready'",id))[0].n),0);
  // A new application attempt may proceed under its own immutable object key.
  const retry=await h.json(reservation.complete_url,{token:owner.token,body:{operation_key:key()}},202);assert.notEqual(retry.attempt_id,attempt.attempt_id);
  await within(processPhotoJob({attempt_id:retry.attempt_id},h.app));const later=fake.writes.filter(row=>row.key!==old);assert.equal(later.length,1);
  const ready=await h.storage.exec("SELECT object_key FROM renditions WHERE asset_id=? AND status='ready'",id);assert.equal(ready.length,1);assert.equal(ready[0].object_key,later[0].key);
  assert.equal(await record(h,owner.accountId,'PHOTOS',old),writerId);assertNotDeleted(fake,old);assert.equal(await memory.head(old),null);
  await within(fake.release());assert(await memory.head(old));await within(h.alarm());assert.equal(await record(h,owner.accountId,'PHOTOS',old),writerId);assertNotDeleted(fake,old);assert(await memory.head(old));
  console.log('PUT_CALLER_OBSERVATION '+JSON.stringify({caller:'preview',retry:'new-key-ready',old_writer:'pending',old_deleted:false,old_late_bytes:true}));
 }finally{await within(fake.release());}
});

local('export maintenance retry publishes a new key without clearing its timed-out writer',{timeout:45000},async t=>{
 const h=await harness(t),owner=await enroll(h),reviewer=await administrator(h);
 const request=(await h.json('/privacy/export',{token:owner.token,body:{operation_key:key()}},201)).privacy_request;await h.json(`/privacy-requests/${request.id}/approve`,{token:reviewer.token,body:{operation_key:key()}});
 const memory=h.env.PRIVACY_EXPORTS,fake=faultBucket(memory,'privacy-exports',`privacy/${owner.accountId}/${request.id}/`);h.env.PRIVACY_EXPORTS=fake.bucket;
 try{
  const response=await within(h.request(`/privacy-requests/${request.id}/process`,{token:reviewer.token,body:{}})),body=await response.json();assert.equal(response.status,503);assert.equal(body.error.code,'private_storage_write_failed');
  const old=fake.writes.find(row=>row.selected)?.key;assert(old);const writerId=await record(h,owner.accountId,'PRIVACY_EXPORTS',old);
  const first=(await h.storage.exec('SELECT status,completed_at,export_key,expires_at FROM privacy_requests WHERE id=?',request.id))[0];assert.notEqual(first.status,'completed');assert.equal(first.completed_at,null);assert.equal(first.export_key,null);assert(h.app.now()<first.expires_at);
  await within(h.db.invocation(()=>flushPrivacyCleanup(h.app)));const current=(await h.storage.exec('SELECT status,export_key FROM privacy_requests WHERE id=?',request.id))[0];
  assert.equal(current.status,'completed');assert.notEqual(current.export_key,old);assert(fake.writes.some(row=>row.key===current.export_key));assert.equal(await record(h,owner.accountId,'PRIVACY_EXPORTS',old),writerId);assertNotDeleted(fake,old);assert.equal(await memory.head(old),null);
  await within(fake.release());assert(await memory.head(old));await within(h.db.invocation(()=>flushPrivacyCleanup(h.app)));assert.equal(await record(h,owner.accountId,'PRIVACY_EXPORTS',old),writerId);assertNotDeleted(fake,old);assert(await memory.head(old));
  console.log('PUT_CALLER_OBSERVATION '+JSON.stringify({caller:'export',retry:'new-key-completed',old_writer:'pending',old_deleted:false,old_late_bytes:true}));
 }finally{await within(fake.release());}
});

for(const kind of ['source','chunk'])local(`${kind} retry uses a distinct key while its timed-out writer remains fenced`,{timeout:45000},async t=>{
 const h=await harness(t),owner=await enroll(h);await preference(h,owner);
 const chunkSize=262144,bytes=new Uint8Array(kind==='chunk'?chunkSize+1:256);bytes.set(fixturePng('synthetic-upload-retry'));for(let i=100;i<bytes.length;i++)bytes[i]=i%251;
 const part=kind==='chunk'?bytes.slice(0,chunkSize):bytes.slice();
 const receipt=await h.json('/uploads/session',{token:owner.token,body:{source:'personal',content_type:'image/png',byte_size:bytes.length,operation_key:key(),...(kind==='chunk'?{resumable:true,checksum_sha256:await sha256(bytes)}:{})}},201),id=receipt.asset_id;
 const prefix=kind==='chunk'?`upload-chunk/${owner.accountId}/${id}/`:`source/${owner.accountId}/${id}/${receipt.version}/`;
 const memory=h.env.QUARANTINE,fake=faultBucket(memory,'quarantine',prefix);h.env.QUARANTINE=fake.bucket;
 const path=kind==='chunk'?`/uploads/${id}/chunks?offset=0`:`/uploads/${id}`,headers={'content-type':'image/png',...(kind==='chunk'?{'X-Lovelies-Chunk-SHA256':await sha256(part)}:{})};
 try{
  const first=await within(h.request(path,{token:owner.token,method:'PUT',raw:part,headers})),firstBody=await first.json();assert.equal(first.status,503);assert.equal(firstBody.error.code,'private_storage_write_failed');
  const old=fake.writes.find(row=>row.selected)?.key;assert(old);const writerId=await record(h,owner.accountId,'QUARANTINE',old);
  const retry=await within(h.request(path,{token:owner.token,method:'PUT',raw:part,headers})),retryBody=await retry.json();assert.equal(retry.status,200,JSON.stringify(retryBody));
  const writes=fake.writes.filter(row=>row.key.startsWith(prefix));assert.equal(writes.length,2);assert.notEqual(writes[1].key,old);
  const asset=(await h.storage.exec('SELECT status,object_key FROM assets WHERE id=?',id))[0];
  if(kind==='source'){assert.equal(asset.status,'uploaded');assert.equal(asset.object_key,writes[1].key);}
  else{assert.equal(asset.status,'uploading');const chunks=await h.storage.exec('SELECT object_key FROM upload_chunks WHERE asset_id=?',id);assert.equal(chunks.length,1);assert.equal(chunks[0].object_key,writes[1].key);}
  assert.equal(await record(h,owner.accountId,'QUARANTINE',old),writerId);assertNotDeleted(fake,old);assert.equal(await memory.head(old),null);
  await within(fake.release());assert(await memory.head(old));await within(h.alarm());assert.equal(await record(h,owner.accountId,'QUARANTINE',old),writerId);assertNotDeleted(fake,old);assert(await memory.head(old));
  console.log('PUT_CALLER_OBSERVATION '+JSON.stringify({caller:kind,retry:'new-key-progress',old_writer:'pending',old_deleted:false,old_late_bytes:true}));
 }finally{await within(fake.release());}
});
