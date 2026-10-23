import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { captureProofs, closeHarnesses, enroll, faceVerifierFixture, fixturePng, sha256, startHarness } from './runtime-harness.mjs';

after(closeHarnesses);
const key=()=>crypto.randomUUID(),CHUNK=262144;
const image=(n=CHUNK*2+37)=>{const bytes=new Uint8Array(n);bytes.set(fixturePng('resumable'));return bytes;};
const processor=envelope=>({...envelope,preview:{bytes_base64:Buffer.from(fixturePng('preview')).toString('base64'),content_type:'image/png',width:1,height:1},matches:[]});
async function setup(t,options={}){
  const h=await startHarness({faceVerifier:faceVerifierFixture,photoProcessor:processor,...options});t.after(h.close);
  const owner=await enroll(h);await h.json('/me/photo-preferences',{token:owner.token,body:{policy_version:'photo-policy-fixture-v1',processing_consent:true,operation_key:key()}});
  return {h,owner};
}
async function reserve(h,owner,bytes,extra={}){
  const payload={source:'personal',upload_batch_id:key(),title:'Original selected caption',content_type:'image/png',byte_size:bytes.length,
    resumable:true,checksum_sha256:await sha256(bytes),operation_key:key(),...extra};
  const receipt=await h.json('/uploads/session',{token:owner.token,body:payload},201);return {receipt,payload};
}
async function put(h,owner,id,bytes,offset=0,expected=200,hash){
  return h.json(`/uploads/${id}/chunks?offset=${offset}`,{token:owner.token,method:'PUT',raw:bytes,
    headers:{'content-type':'image/png','X-Lovelies-Chunk-SHA256':hash??await sha256(bytes)}},expected);
}
const status=(h,owner,id)=>h.json(`/uploads/${id}/status`,{token:owner.token});

test('durable partial progress and original reserve key survive response loss; exact chunks replay without duplicates',async t=>{
  const {h,owner}=await setup(t),bytes=image(),{receipt:r,payload}=await reserve(h,owner,bytes);
  assert.equal(r.bytes_received,0);assert.equal(r.maximum_chunk_bytes,CHUNK);assert.equal(r.processing_creates_access,false);
  // Discard a successful response, then read durable authority as a restarted consumer.
  await put(h,owner,r.asset_id,bytes.subarray(0,CHUNK));
  const read=await status(h,owner,r.asset_id);assert.equal(read.bytes_received,CHUNK);assert.equal(read.status,'uploading');
  assert.equal(read.checksum_sha256,payload.checksum_sha256);assert.equal(read.upload_batch_id,payload.upload_batch_id);assert.equal(read.title,payload.title);
  const restored=await h.json('/uploads/session',{token:owner.token,body:payload},201);assert.equal(restored.asset_id,r.asset_id);
  const replay=await put(h,owner,r.asset_id,bytes.subarray(0,CHUNK));assert.equal(replay.bytes_received,CHUNK);
  assert.equal((await h.storage.exec('SELECT count(*) n FROM upload_chunks WHERE asset_id=?',r.asset_id))[0].n,1);
  for(let offset=CHUNK;offset<bytes.length;offset+=CHUNK)await put(h,owner,r.asset_id,bytes.subarray(offset,offset+CHUNK),offset);
  const final=await status(h,owner,r.asset_id);assert.equal(final.status,'uploaded');assert.equal(final.bytes_received,bytes.length);
  const replayLast=await put(h,owner,r.asset_id,bytes.subarray(CHUNK*2),CHUNK*2);assert.equal(replayLast.status,'uploaded');
  const row=(await h.storage.exec('SELECT * FROM assets WHERE id=?',r.asset_id))[0];
  assert.equal(row.checksum_sha256,payload.checksum_sha256);const bucket=await h.mf.getR2Bucket('QUARANTINE');
  assert.equal(await sha256(await(await bucket.get(row.object_key)).arrayBuffer()),payload.checksum_sha256);
  await h.alarm();for(const chunk of await h.storage.exec('SELECT object_key FROM upload_chunks WHERE asset_id=?',r.asset_id))assert.equal(await bucket.head(chunk.object_key),null);
  assert(await bucket.head(row.object_key));assert.equal((await status(h,owner,r.asset_id)).cleanup_pending,false);
  assert.equal((await h.storage.exec('SELECT count(*) n FROM media_grants'))[0].n,0);
});
test('gaps, changed overlap, oversized and false-hash chunks cannot advance accepted progress',async t=>{
  const {h,owner}=await setup(t),bytes=image(),{receipt:r}=await reserve(h,owner,bytes),first=bytes.subarray(0,CHUNK);
  assert.equal((await put(h,owner,r.asset_id,bytes.subarray(CHUNK,CHUNK*2),CHUNK,409)).error.code,'upload_offset_conflict');
  assert.equal((await put(h,owner,r.asset_id,first,0,400,'a'.repeat(64))).error.code,'upload_chunk_checksum_mismatch');
  await put(h,owner,r.asset_id,bytes.subarray(0,CHUNK+1),0,413);
  await put(h,owner,r.asset_id,first);const altered=new Uint8Array(first);altered[100]^=1;
  assert.equal((await put(h,owner,r.asset_id,altered,0,409)).error.code,'upload_offset_conflict');
  assert.equal((await status(h,owner,r.asset_id)).bytes_received,CHUNK);
});
test('concurrent identical chunks publish one accepted offset and cleanup the losing private writer',async t=>{
  const {h,owner}=await setup(t),bytes=image(),{receipt:r}=await reserve(h,owner,bytes),first=bytes.subarray(0,CHUNK);
  const results=await Promise.all([put(h,owner,r.asset_id,first),put(h,owner,r.asset_id,first)]);
  assert(results.every(x=>x.bytes_received===CHUNK));assert.equal((await h.storage.exec('SELECT count(*) n FROM upload_chunks WHERE asset_id=?',r.asset_id))[0].n,1);
  await h.alarm();const accepted=(await h.storage.exec('SELECT object_key FROM upload_chunks WHERE asset_id=?',r.asset_id))[0].object_key;
  const bucket=await h.mf.getR2Bucket('QUARANTINE');assert(await bucket.head(accepted));
});
test('terminal whole-source hash mismatch cannot process or loop forever at a full accepted offset',async t=>{
  const {h,owner}=await setup(t),bytes=image(200),{receipt:r}=await reserve(h,owner,bytes,{checksum_sha256:'a'.repeat(64)});
  const rejected=await put(h,owner,r.asset_id,bytes,0,422);assert.equal(rejected.error.code,'upload_checksum_mismatch');
  const state=await status(h,owner,r.asset_id);assert.equal(state.status,'failed');assert.equal(state.transfer_status,'failed');assert.equal(state.error_code,'upload_checksum_mismatch');
  await h.json(`/uploads/${r.asset_id}/complete`,{token:owner.token,body:{operation_key:key()}},409);
  await h.json(`/uploads/${r.asset_id}/cancel`,{token:owner.token,body:{operation_key:key()}});await h.alarm();
  assert.equal((await status(h,owner,r.asset_id)).cleanup_pending,false);
});
test('invalid source magic is a terminal format rejection without changing identity or authorizing processing',async t=>{
  const {h,owner}=await setup(t),bytes=new Uint8Array(100),{receipt:r}=await reserve(h,owner,bytes);
  assert.equal((await put(h,owner,r.asset_id,bytes,0,415)).error.code,'image_invalid');
  assert.equal((await status(h,owner,r.asset_id)).error_code,'image_invalid');
});
test('cancel is idempotent, retains truthful cleanup, and fences future bytes and processing',async t=>{
  const {h,owner}=await setup(t),bytes=image(),{receipt:r}=await reserve(h,owner,bytes);await put(h,owner,r.asset_id,bytes.subarray(0,CHUNK));
  const operation_key=key(),cancel=()=>h.json(`/uploads/${r.asset_id}/cancel`,{token:owner.token,body:{operation_key}});
  assert.equal((await cancel()).status,'cancelled');assert.equal((await cancel()).bytes_received,CHUNK);
  assert.equal((await put(h,owner,r.asset_id,bytes.subarray(CHUNK,CHUNK*2),CHUNK,409)).error.code,'upload_cancelled');
  await h.json(`/uploads/${r.asset_id}/complete`,{token:owner.token,body:{operation_key:key()}},409);
  await h.alarm();const state=await status(h,owner,r.asset_id);assert.equal(state.status,'cancelled');assert.equal(state.cleanup_pending,false);
  assert.equal((await h.storage.exec('SELECT count(*) n FROM photo_job_outbox WHERE asset_id=?',r.asset_id))[0].n,0);
});
test('expiry cancels only unfinished transfers while uploaded and ready sources survive transfer TTL',async t=>{
  const {h,owner}=await setup(t),bytes=image(200),a=await reserve(h,owner,bytes),b=await reserve(h,owner,bytes);
  await put(h,owner,b.receipt.asset_id,bytes);
  await h.storage.exec('UPDATE upload_transfers SET expires_at=created_at+1');await new Promise(r=>setTimeout(r,5));await h.alarm();
  const expired=await status(h,owner,a.receipt.asset_id);assert.equal(expired.status,'cancelled');assert.equal(expired.error_code,'upload_expired');
  assert.equal((await status(h,owner,b.receipt.asset_id)).status,'uploaded');
});
test('cross-account, anonymous, revoked session and withdrawn processing consent cannot access/resume someone else\'s transfer',async t=>{
  const {h,owner}=await setup(t),peer=await enroll(h),anonymous=await h.anonymous(),bytes=image(),{receipt:r}=await reserve(h,owner,bytes);
  await h.json(`/uploads/${r.asset_id}/status`,{token:peer.token},404);await h.json(`/uploads/${r.asset_id}/status`,{token:anonymous.access_token},403);
  await h.json('/me/photo-preferences',{token:owner.token,body:{policy_version:'photo-policy-fixture-v1',processing_consent:false,operation_key:key()}});
  assert.equal((await status(h,owner,r.asset_id)).status,'uploading');
  await put(h,owner,r.asset_id,bytes.subarray(0,CHUNK),0,403);
  // The owner can cancel private pending bytes even after withdrawing processing.
  await h.json(`/uploads/${r.asset_id}/cancel`,{token:owner.token,body:{operation_key:key()}});
  await h.json('/auth/logout',{token:owner.token,body:{}});
  await h.json(`/uploads/${r.asset_id}/status`,{token:owner.token},401);
});
test('source/processing stages stay separate and repeated complete creates no duplicate processing attempt or access',async t=>{
  const {h,owner}=await setup(t),bytes=image(200),{receipt:r}=await reserve(h,owner,bytes);await put(h,owner,r.asset_id,bytes);
  const operation_key=key();await h.json(`/uploads/${r.asset_id}/complete`,{token:owner.token,body:{operation_key}},202);
  await h.json(`/uploads/${r.asset_id}/complete`,{token:owner.token,body:{operation_key}},202);
  for(let i=0;i<100;i++){if((await status(h,owner,r.asset_id)).status==='ready')break;await new Promise(r=>setTimeout(r,20));}
  assert.equal((await status(h,owner,r.asset_id)).status,'ready');assert.equal((await h.storage.exec('SELECT count(*) n FROM processing_attempts WHERE asset_id=?',r.asset_id))[0].n,1);
  assert.equal((await h.storage.exec('SELECT count(*) n FROM media_grants'))[0].n,0);
  assert.equal((await h.json(`/uploads/${r.asset_id}/cancel`,{token:owner.token,body:{operation_key:key()}},409)).error.code,'upload_already_processing');
});

test('lost actual final R2 PUT reply retains the full accepted prefix; status retries assembly without uploading chunks again',async t=>{
  let dropped=false;
  const {h,owner}=await setup(t,{mediaWriteGate:({key,stage})=>{
    if(!dropped && key.startsWith('source/') && stage==='after'){dropped=true;return new Response('declared lost reply',{status:503});}
    return {continued:true};
  }}),bytes=image(200),{receipt:r}=await reserve(h,owner,bytes);
  await put(h,owner,r.asset_id,bytes,0,500);assert(dropped);
  const state=await status(h,owner,r.asset_id);assert.equal(state.status,'uploaded');assert.equal(state.bytes_received,bytes.length);
  assert.equal((await h.storage.exec('SELECT count(*) n FROM upload_chunks WHERE asset_id=?',r.asset_id))[0].n,1);
  await h.alarm();const bucket=await h.mf.getR2Bucket('QUARANTINE');const object=(await h.storage.exec('SELECT object_key FROM assets WHERE id=?',r.asset_id))[0];assert(await bucket.head(object.object_key));
  assert.equal((await status(h,owner,r.asset_id)).cleanup_pending,false);
});
test('cancel while actual chunk PUT is held fences late publication and retains cleanup until that writer settles',async t=>{
  let entered,release;const arrived=new Promise(r=>entered=r),blocked=new Promise(r=>release=r);let heldKey;
  const {h,owner}=await setup(t,{mediaWriteGate:async({key,stage})=>{
    if(key.startsWith('upload-chunk/') && stage==='after'){heldKey=key;entered();await blocked;}return {continued:true};
  }}),bytes=image(),{receipt:r}=await reserve(h,owner,bytes);
  const writing=put(h,owner,r.asset_id,bytes.subarray(0,CHUNK),0,409);
  try {
    await Promise.race([arrived,new Promise((_,reject)=>setTimeout(()=>reject(new Error('actual writer not reached')),5000))]);
    const cancelled=await h.json(`/uploads/${r.asset_id}/cancel`,{token:owner.token,body:{operation_key:key()}});assert.equal(cancelled.cleanup_pending,true);
    await h.alarm();const bucket=await h.mf.getR2Bucket('QUARANTINE');assert(await bucket.head(heldKey));
    release();assert.equal((await writing).error.code,'upload_cancelled');await h.alarm();
    assert.equal(await bucket.head(heldKey),null);assert.equal((await status(h,owner,r.asset_id)).cleanup_pending,false);
    assert.equal((await h.storage.exec('SELECT count(*) n FROM upload_chunks WHERE asset_id=?',r.asset_id))[0].n,0);
  } finally {release();await writing;}
});
test('retention and moderation holds preserve cancelled source bytes while cancellation immediately fences access',async t=>{
  const {h,owner}=await setup(t),bytes=image(200),{receipt:r}=await reserve(h,owner,bytes);await put(h,owner,r.asset_id,bytes);
  const object=(await h.storage.exec('SELECT object_key FROM assets WHERE id=?',r.asset_id))[0].object_key;
  // A global retention hold has the same persisted operator representation.
  await h.storage.exec("INSERT INTO retention_settings(id,version,raw_days,preview_days,face_crop_days,free_cache_days,audit_days,legal_hold,updated_at) VALUES('default',1,60,60,14,2,2555,1,?)",Date.now());
  await h.json(`/uploads/${r.asset_id}/cancel`,{token:owner.token,body:{operation_key:key()}});await h.alarm();
  const bucket=await h.mf.getR2Bucket('QUARANTINE');assert(await bucket.head(object));assert.equal((await status(h,owner,r.asset_id)).cleanup_pending,true);
  await h.storage.exec("UPDATE retention_settings SET legal_hold=0 WHERE id='default'");
  const hold=key();await h.storage.exec("INSERT INTO moderation_holds(id,subject_id,asset_id,active,created_at,reason) VALUES(?,?,?,1,?,'Declared test hold')",hold,owner.accountId,r.asset_id,Date.now());
  await h.alarm();assert(await bucket.head(object));assert.equal((await status(h,owner,r.asset_id)).status,'cancelled');
  await h.storage.exec('UPDATE moderation_holds SET active=0 WHERE id=?',hold);await h.alarm();
  assert.equal(await bucket.head(object),null);assert.equal((await status(h,owner,r.asset_id)).cleanup_pending,false);
});
test('approved account erasure cascades partial transfer rows and deletes exact chunk objects',async t=>{
  const {h,owner}=await setup(t,{consumeQueue:false}),bytes=image(),{receipt:r}=await reserve(h,owner,bytes);
  await put(h,owner,r.asset_id,bytes.subarray(0,CHUNK));
  const chunk=(await h.storage.exec('SELECT object_key FROM upload_chunks WHERE asset_id=?',r.asset_id))[0].object_key;
  const admin=await enroll(h);await h.storage.exec('UPDATE accounts SET roles_json=? WHERE id=?',JSON.stringify(['user','admin']),admin.accountId);
  const challenge=await h.json('/auth/face/challenge',{body:{face_handle:admin.faceHandle,device_id:admin.deviceId}},201);
  const completion=await captureProofs(h,challenge,admin.keys.privateKey);const credentials=await h.json('/auth/face/complete',{body:completion});
  const deletion=(await h.json('/privacy/account-deletion',{token:owner.token,body:{operation_key:key()}},201)).privacy_request;
  await h.json(`/privacy-requests/${deletion.id}/approve`,{token:credentials.access_token,body:{operation_key:key()}});
  const processed=await h.json(`/privacy-requests/${deletion.id}/process`,{token:credentials.access_token,body:{}});
  assert.equal(processed.privacy_request.status,'completed');
  assert.equal((await h.storage.exec('SELECT count(*) n FROM upload_transfers WHERE asset_id=?',r.asset_id))[0].n,0);
  assert.equal((await h.storage.exec('SELECT count(*) n FROM upload_chunks WHERE asset_id=?',r.asset_id))[0].n,0);
  assert.equal(await(await h.mf.getR2Bucket('QUARANTINE')).head(chunk),null);assert.deepEqual(await h.storage.exec('SELECT c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=\'lovelies_private\' AND c.contype=\'f\' AND NOT c.convalidated'),[]);
});
