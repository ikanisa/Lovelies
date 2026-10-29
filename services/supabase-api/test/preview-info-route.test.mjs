import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SupabasePrivateBucket } from '../src/storage.ts';
import { JSON_BODY_LIMITS } from '../src/types.ts';
import { processPhotoJob } from '../src/processing.ts';
import { startHarness,enroll,faceVerifierFixture,fixturePng,sha256 } from './runtime-harness.mjs';

const operation=()=>crypto.randomUUID();

test('one owner preview bounds only the first successful info body and leaves source state intact', {timeout:60000}, async t=>{
 assert.equal(process.env.TEST_DATABASE_URL,undefined,'fixture must never attach to an external database');
 const preview=fixturePng('bounded-preview'),h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false,
  photoProcessor:envelope=>({...envelope,preview:{bytes_base64:Buffer.from(preview).toString('base64'),content_type:'image/png',width:1,height:1},matches:[]})});
 t.after(()=>h.close());
 const owner=await enroll(h);
 await h.json('/me/photo-preferences',{token:owner.token,body:{policy_version:'photo-policy-fixture-v1',processing_consent:true,operation_key:operation()}});
 const bytes=fixturePng('bounded-source'),upload=await h.json('/uploads/session',{token:owner.token,
  body:{source:'personal',content_type:'image/png',byte_size:bytes.length,operation_key:operation()}},201);
 await h.json(upload.upload_url,{token:owner.token,method:'PUT',raw:bytes,headers:{'content-type':'image/png'}});
 const complete=await h.json(upload.complete_url,{token:owner.token,body:{operation_key:operation()}},202);
 await processPhotoJob({attempt_id:complete.attempt_id},h.app);
 const source=(await h.storage.exec('SELECT object_key FROM assets WHERE id=?',upload.asset_id))[0];
 const memory=h.env.QUARANTINE,metadata=await memory.head(source.object_key);assert(metadata);
 let mode='valid',sourceStarted,cancelled=0,photoGets=0;const events=[];
 const transport=async(url,init={})=>{
  const u=new URL(url);events.push({method:init.method??'GET',path:u.pathname});
  assert.equal(init.method??'GET','GET');assert.equal(u.pathname,'/storage/v1/object/info/lovelies-quarantine/'+source.object_key.split('/').map(encodeURIComponent).join('/'));
  if(mode==='stall'){
   const body=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));sourceStarted();},cancel(){cancelled++;return new Promise(()=>{});}});
   return new Response(body,{status:200,headers:{'content-type':'application/json'}});
  }
  return Response.json({size:metadata.size,etag:metadata.etag,metadata:{mimetype:metadata.httpMetadata.contentType},user_metadata:metadata.customMetadata});
 };
 h.env.QUARANTINE=new SupabasePrivateBucket('http://127.0.0.1:1','synthetic-secret','lovelies-quarantine',transport);
 const photoGet=h.env.PHOTOS.get.bind(h.env.PHOTOS);h.env.PHOTOS.get=async key=>{photoGets++;return photoGet(key);};
 const url=`/community/media/${upload.asset_id}/preview`;
 const ordinary=await h.request(url,{token:owner.token});assert.equal(ordinary.status,200);assert.equal(await sha256(await ordinary.arrayBuffer()),await sha256(preview));assert.equal(photoGets,1);
 const assetsBefore=await h.storage.exec('SELECT * FROM assets WHERE id=?',upload.asset_id);
 const renditionsBefore=await h.storage.exec('SELECT * FROM renditions WHERE asset_id=? ORDER BY id',upload.asset_id);
 const cleanupBefore=await h.storage.exec('SELECT * FROM cleanup_intents WHERE subject_id=? ORDER BY id',owner.accountId);
 const writersBefore=await h.storage.exec('SELECT * FROM media_write_intents WHERE account_id=? ORDER BY id',owner.accountId);
 mode='stall';events.length=0;photoGets=0;t.mock.timers.enable({apis:['setTimeout']});
 const started=new Promise(resolve=>{sourceStarted=resolve;});
 const pending=h.request(url,{token:owner.token});void pending.catch(()=>{});
 await started;await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(JSON_BODY_LIMITS.timeoutMs+1);
 const response=await pending;assert.equal(response.status,503);await response.body?.cancel();
 assert.equal(cancelled,1);assert.equal(photoGets,0);assert.equal(events.length,1);assert.equal(events[0].method,'GET');
 assert.deepEqual(await h.storage.exec('SELECT * FROM assets WHERE id=?',upload.asset_id),assetsBefore);
 assert.deepEqual(await h.storage.exec('SELECT * FROM renditions WHERE asset_id=? ORDER BY id',upload.asset_id),renditionsBefore);
 assert.deepEqual(await h.storage.exec('SELECT * FROM cleanup_intents WHERE subject_id=? ORDER BY id',owner.accountId),cleanupBefore);
 assert.deepEqual(await h.storage.exec('SELECT * FROM media_write_intents WHERE account_id=? ORDER BY id',owner.accountId),writersBefore);
});
