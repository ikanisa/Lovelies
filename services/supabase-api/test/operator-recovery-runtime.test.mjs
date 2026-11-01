import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startHarness,enroll,captureProofs,faceVerifierFixture,sha256} from './runtime-harness.mjs';
import {digest,stable} from '../src/types.ts';

test('reviewed processing recovery resumes only the original still-authorized work',async t=>{
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});t.after(()=>h.close());
 const owner=await enroll(h),admin=await enroll(h);
 await h.storage.exec('UPDATE accounts SET roles_json=? WHERE id=?','["user","admin"]',admin.accountId);
 const challenge=await h.json('/auth/face/challenge',{body:{face_handle:admin.faceHandle,device_id:admin.deviceId}},201);
 const signed=await h.json('/auth/face/complete',{body:await captureProofs(h,challenge,admin.keys.privateKey)}),token=signed.access_token;
 await h.json('/me/photo-preferences',{token:owner.token,body:{processing_consent:true,policy_version:h.env.PHOTO_CONSENT_POLICY_VERSION,operation_key:crypto.randomUUID()}});
 const ownerClaims=JSON.parse(Buffer.from(owner.token.split('.')[1],'base64url').toString()),ownerSession=ownerClaims.jti;
 const bytes=new Uint8Array([255,216,255]),checksum=await sha256(bytes);
 async function fixture({status='failed',error='photo_processor_unavailable',jobState=null,lease=null,backoff=Date.now()}={}){
  const asset=crypto.randomUUID(),attempt=crypto.randomUUID(),version=crypto.randomUUID(),objectKey=`source/${owner.accountId}/${asset}/${version}/original`,now=Date.now();
  await h.storage.exec("INSERT INTO assets(id,owner_id,source,status,object_key,content_type,byte_size,checksum_sha256,version,created_at) VALUES(?,?,'personal',?,?,'image/jpeg',?,?,?,?)",asset,owner.accountId,status==='failed'?'failed':'processing',objectKey,bytes.length,checksum,version,now);
  await h.env.QUARANTINE.put(objectKey,bytes,{customMetadata:{source_checksum_sha256:checksum,source_version:version}});
  await h.storage.exec(`INSERT INTO processing_attempts(id,asset_id,source_version,source_checksum_sha256,model_version,status,captured_at,expires_at,owner_id,owner_session_id,owner_auth_epoch,source,profiles_json,processor_nonce,engine_identity,error_code,lease_token,lease_until)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,'personal','[]',?,?,?,?,?)`,attempt,asset,version,checksum,h.env.PHOTO_MODEL_VERSION,status,now,now+8*60000,owner.accountId,ownerSession,ownerClaims.auth_epoch,crypto.randomUUID(),h.env.INFERENCE_ENGINE_IDENTITY,error,lease?crypto.randomUUID():null,lease);
  const jobId=await digest(stable({category:'photo',payload:{attempt_id:attempt}}));
  if(jobState)await h.storage.exec("INSERT INTO job_queue(id,category,payload_json,state,available_at,created_at,attempts,error_code,lease_token,lease_until) VALUES(?,'photo',?,?,?,?,20,'prior_scheduler_failure',?,?)",jobId,stable({attempt_id:attempt}),jobState,backoff,now,jobState==='processing'?crypto.randomUUID():null,jobState==='processing'?lease:null);
  const diag=async()=>{const detail=await h.json('/admin/uploads/'+asset,{token});return detail.attempts.find(row=>row.id===attempt).recovery;};
  const path=`/admin/uploads/${asset}/attempts/${attempt}/resume`;
  const body=async()=>({expected_revision:(await diag()).expected_revision,reason:'Reviewed transient processor outage',operation_key:crypto.randomUUID()});
  return {asset,attempt,version,objectKey,jobId,diag,path,body};
 }
 await t.test('resumes the same attempt, keeps captured scope and scheduler backoff, and retries exactly once after reply loss',async()=>{
  const future=Date.now()+60000,f=await fixture({jobState:'failed',backoff:future});const before=await h.db.one('SELECT * FROM processing_attempts WHERE id=?',f.attempt);
  const original=await f.body(),result=await h.json(f.path,{token,body:original});assert.equal(result.attempt_id,f.attempt);assert.equal(result.completed,false);assert.equal(result.grants_created,0);
  const after=await h.db.one('SELECT * FROM processing_attempts WHERE id=?',f.attempt);assert.equal(after.status,'queued');
  for(const field of ['id','asset_id','source_version','source_checksum_sha256','owner_id','owner_session_id','owner_auth_epoch','model_version','engine_identity','profiles_json','processor_nonce','expires_at'])assert.deepEqual(after[field],before[field],field);
  const job=await h.db.one('SELECT * FROM job_queue WHERE id=?',f.jobId);assert.equal(job.state,'pending');assert.equal(job.attempts,20);assert.equal(job.handoff_count,1);assert.equal(job.available_at,future);assert.equal(job.error_code,'prior_scheduler_failure');
  const oldHead=h.env.QUARANTINE.head;h.env.QUARANTINE.head=async()=>{throw new Error('replay must not make a new external read');};
  try{assert.deepEqual(await h.json(f.path,{token,body:original}),result);}finally{h.env.QUARANTINE.head=oldHead;}
  assert.equal((await h.db.one('SELECT handoff_count FROM job_queue WHERE id=?',f.jobId)).handoff_count,1);
  await h.json(f.path,{token,body:{...original,reason:'Changed original mutation input'}},409);
 });
 await t.test('stale diagnostics never reset a concurrently changed attempt or queue',async()=>{
  const f=await fixture({jobState:'failed'}),body=await f.body();await h.storage.exec('UPDATE job_queue SET handoff_count=handoff_count+1 WHERE id=?',f.jobId);
  const reply=await h.json(f.path,{token,body},409);assert.equal(reply.error.code,'operator_recovery_revision_changed');assert.equal((await h.db.one('SELECT status FROM processing_attempts WHERE id=?',f.attempt)).status,'failed');
 });
 await t.test('active leases and absent lease proof cannot be stolen',async()=>{
  for(const lease of [Date.now()+60000,null]){
   const f=await fixture({status:'running',jobState:'processing',lease});const d=await f.diag();assert.equal(d.eligible,false);
   assert.equal(d.reason,lease?'processing_in_progress':'job_handoff_unverified');await h.json(f.path,{token,body:await f.body()},409);
  }
 });
 await t.test('moderation holds and unresolved remote writes remain durable blockers',async()=>{
  const f=await fixture(),hold=crypto.randomUUID();await h.storage.exec("INSERT INTO moderation_holds(id,asset_id,active,created_at,reason) VALUES(?,?,1,?,'Synthetic hold')",hold,f.asset,Date.now());
  assert.equal((await f.diag()).reason,'moderation_hold');await h.json(f.path,{token,body:await f.body()},409);
  await h.storage.exec('UPDATE moderation_holds SET active=0,cleared_at=? WHERE id=?',Date.now(),hold);
  const writer=crypto.randomUUID();await h.storage.exec("INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at) VALUES(?,?,'PHOTOS',?,'pending',?)",writer,owner.accountId,'synthetic-unresolved-exact-key',Date.now());
  assert.equal((await f.diag()).reason,'external_write_unconfirmed');await h.json(f.path,{token,body:await f.body()},409);
  assert.equal((await h.db.one('SELECT status FROM media_write_intents WHERE id=?',writer)).status,'pending');
  await h.storage.exec("UPDATE media_write_intents SET status='settled' WHERE id=?",writer);
 });
 await t.test('terminal, expired, mismatched model and invalid provider output need an owner-authorized fresh action',async()=>{
  const bad=await fixture({error:'processor_origin_unverified'});assert.equal((await bad.diag()).reason,'fresh_owner_action_required');await h.json(bad.path,{token,body:await bad.body()},409);
  const expired=await fixture();await h.storage.exec('UPDATE processing_attempts SET expires_at=? WHERE id=?',Date.now()-1,expired.attempt);assert.equal((await expired.diag()).reason,'processing_attempt_expired');
  const changed=await fixture();await h.storage.exec('UPDATE processing_attempts SET model_version=? WHERE id=?','new-model',changed.attempt);assert.equal((await changed.diag()).reason,'owner_authority_changed');
 });
 await t.test('source metadata is verified and ordinary accounts cannot request operator recovery',async()=>{
  const f=await fixture(),body=await f.body();await h.json(f.path,{token:owner.token,body},403);
  h.env.QUARANTINE.rows.get(f.objectKey).metadata.source_checksum_sha256='0'.repeat(64);
  assert.equal((await h.json(f.path,{token,body},409)).error.code,'source_unverified');
  assert.equal((await h.db.one('SELECT status FROM processing_attempts WHERE id=?',f.attempt)).status,'failed');
 });
 await t.test('the per-attempt recovery budget rejects a fourth new intent while an original receipt remains replayable',async()=>{
  const f=await fixture(),original=[];
  for(let index=0;index<3;index++){
   const body=await f.body();original.push({body,result:await h.json(f.path,{token,body})});
   await h.storage.exec("UPDATE processing_attempts SET status='failed',error_code='photo_processor_unavailable' WHERE id=?",f.attempt);
   await h.storage.exec("UPDATE job_queue SET state='failed' WHERE id=?",f.jobId);
  }
  assert.equal((await f.diag()).reason,'operator_recovery_budget_exhausted');
  await h.json(f.path,{token,body:await f.body()},409);
  assert.deepEqual(await h.json(f.path,{token,body:original[0].body}),original[0].result);
  assert.equal((await h.db.one('SELECT status FROM processing_attempts WHERE id=?',f.attempt)).status,'failed');
 });
 await t.test('owner consent withdrawal invalidates recovery without replacing its original candidate set',async()=>{
  const f=await fixture();await h.json('/me/photo-preferences',{token:owner.token,body:{processing_consent:false,policy_version:h.env.PHOTO_CONSENT_POLICY_VERSION,operation_key:crypto.randomUUID()}});
  const d=await f.diag();assert.equal(d.eligible,false);assert.equal(d.reason,'processing_consent_required');await h.json(f.path,{token,body:await f.body()},409);
  assert.equal((await h.db.one('SELECT profiles_json FROM processing_attempts WHERE id=?',f.attempt)).profiles_json,'[]');
 });
});
