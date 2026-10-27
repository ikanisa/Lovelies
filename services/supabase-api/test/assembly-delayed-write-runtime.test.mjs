/** Synthetic PGlite and in-memory Storage only; no provider or network. */
import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {startHarness,closeHarnesses,enroll,faceVerifierFixture,fixturePng,sha256} from './runtime-harness.mjs';
after(closeHarnesses);
const pgliteTest=process.env.TEST_DATABASE_URL?test.skip:test;
const key=()=>crypto.randomUUID();
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function within(promise,ms=15000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('synthetic deadline')),ms);})]);}finally{clearTimeout(timer);}}
async function setup(t,delayed){
 assert.equal(process.env.TEST_DATABASE_URL,undefined);
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});t.after(()=>h.close());
 const owner=await enroll(h);await h.json('/me/photo-preferences',{token:owner.token,body:{policy_version:'photo-policy-fixture-v1',processing_consent:true,operation_key:key()}});
 const bytes=new Uint8Array(256);bytes.set(fixturePng('synthetic-assembly'));for(let i=100;i<bytes.length;i++)bytes[i]=i%251;
 const receipt=await h.json('/uploads/session',{token:owner.token,body:{source:'personal',content_type:'image/png',byte_size:bytes.length,operation_key:key(),resumable:true,checksum_sha256:await sha256(bytes)}},201);
 const storage=h.env.QUARANTINE,put=storage.put,remove=storage.delete,release=deferred(),events=[];let remote=null,remoteKey=null;
 storage.put=async function(objectKey,value,options){
  if(delayed&&objectKey.startsWith('source/')){
   assert.equal(remote,null);remoteKey=objectKey;const copy=new Uint8Array(value).slice();events.push({kind:'dispatch',key:objectKey});
   remote=release.promise.then(()=>put.call(storage,objectKey,copy,options));void remote.catch(()=>{});
   throw Error('synthetic lost assembly acknowledgement');
  }
  return put.call(storage,objectKey,value,options);
 };
 storage.delete=async function(keys){for(const k of typeof keys==='string'?[keys]:keys)events.push({kind:'delete',key:k});return remove.call(storage,keys);};
 return {h,owner,receipt,bytes,storage,events,remoteKey:()=>remoteKey,release:async()=>{release.resolve();if(remote)await remote;}};
}

pgliteTest('assembly keeps an ambiguous source writer pending through cancellation and late remote completion',{timeout:45000},async t=>{
 const f=await setup(t,true),{h,owner,receipt,bytes,storage,events}=f,id=receipt.asset_id;
 try{
  const response=await within(h.request(`/uploads/${id}/chunks?offset=0`,{token:owner.token,method:'PUT',raw:bytes,headers:{'content-type':'image/png','X-Lovelies-Chunk-SHA256':await sha256(bytes)}}));
  assert(response.status>=400);await response.body?.cancel();const objectKey=f.remoteKey();assert(objectKey,'must reach the actual assembly PUT');
  const query=async()=>({writer:(await h.storage.exec("SELECT status FROM media_write_intents WHERE account_id=? AND bucket='QUARANTINE' AND object_key=?",owner.accountId,objectKey))[0]?.status??null,
   cleanup:(await h.storage.exec("SELECT status FROM cleanup_intents WHERE subject_id=? AND bucket='QUARANTINE' AND object_key=?",owner.accountId,objectKey)).map(x=>x.status),
   asset:(await h.storage.exec('SELECT status,object_key FROM assets WHERE id=?',id))[0],
   grants:Number((await h.storage.exec('SELECT count(*) n FROM media_grants WHERE asset_id=?',id))[0].n)});
  const first=await query();const cancelled=await h.json(`/uploads/${id}/cancel`,{token:owner.token,body:{operation_key:key()}});await within(h.alarm());
  const status=await h.json(`/uploads/${id}/status`,{token:owner.token}),before=await query(),deleted=events.some(x=>x.kind==='delete'&&x.key===objectKey);
  assert.equal(await storage.head(objectKey),null);await within(f.release());assert(await storage.head(objectKey));const late=await query();
  const violations=[];
  if(first.writer!=='pending'||late.writer!=='pending')violations.push({invariant:'unknown_writer_pending',observed:[first.writer,late.writer]});
  if(deleted||before.cleanup.includes('verified'))violations.push({invariant:'no_cleanup_before_terminal_writer',observed:{deleted,cleanup:before.cleanup}});
  if(cancelled.status!=='cancelled'||status.cleanup_pending!==true)violations.push({invariant:'cancel_reports_pending_cleanup',observed:status.cleanup_pending});
  if(late.asset.status!=='cancelled'||late.asset.object_key===objectKey||late.grants)violations.push({invariant:'late_object_not_published',observed:late.asset.status});
  assert.deepEqual(violations,[]);
 }finally{await within(f.release());}
});

pgliteTest('acknowledged synthetic assembly still publishes its original source',{timeout:45000},async t=>{
 const f=await setup(t,false),{h,owner,receipt,bytes,storage}=f,id=receipt.asset_id;
 const response=await within(h.request(`/uploads/${id}/chunks?offset=0`,{token:owner.token,method:'PUT',raw:bytes,headers:{'content-type':'image/png','X-Lovelies-Chunk-SHA256':await sha256(bytes)}}));
 const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.status,'uploaded');
 const asset=(await h.storage.exec('SELECT status,object_key FROM assets WHERE id=?',id))[0];assert.equal(asset.status,'uploaded');assert(await storage.head(asset.object_key));
 const writer=(await h.storage.exec("SELECT status FROM media_write_intents WHERE account_id=? AND bucket='QUARANTINE' AND object_key=?",owner.accountId,asset.object_key))[0];assert.equal(writer.status,'settled');
});
