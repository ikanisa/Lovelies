import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startHarness,enroll,faceVerifierFixture} from './runtime-harness.mjs';
import {replayErasedAccountForRestore,completeErasedAccountForRestore} from '../src/privacy.ts';
import {stable} from '../src/types.ts';
const id=()=>crypto.randomUUID();
test('restore erasure adapter requires the exact independently replayed episode and preserves holds',{timeout:90000},async t=>{
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});t.after(()=>h.close());
 const subject=await enroll(h),reviewer=await enroll(h),other=await enroll(h),now=h.app.now(),request=id(),recovery=id();
 await h.db.run("INSERT INTO support_requests(id,account_id,subject,details,status,created_at,updated_at) VALUES(?,?,'Synthetic private support','Erase this restored private content','open',?,?)",id(),subject.accountId,now,now);
 await h.db.run("INSERT INTO privacy_requests(id,subject_id,requested_by,request_type,status,created_at,expires_at,reviewed_by,reviewed_at) VALUES(?,?,?,'delete','queued',?,?,?,?)",request,subject.accountId,subject.accountId,now-1000,now+86400000,reviewer.accountId,now);
 const input={recovery_id:recovery,reviewer_id:reviewer.accountId,reviewed_at:now};
 await t.test('ordinary rows, an account UUID and a requested deletion do not grant recovery authority',async()=>{
  await assert.rejects(replayErasedAccountForRestore(h.app,subject.accountId,request,input),e=>e.code==='restore_erasure_binding_unverified');
  assert.equal((await h.db.one('SELECT count(*) n FROM support_requests WHERE account_id=?',subject.accountId)).n,1);
 });
 await h.db.transaction(async()=>{
  await h.db.run("UPDATE accounts SET disabled_at=? WHERE id=?",now,subject.accountId);
  await h.db.run("INSERT INTO restore_recovery_runs(id,database_id,prior_incarnation_id,incarnation_id,generation_hash,restriction_sequence,restriction_hash,state,created_at,updated_at) VALUES(?,?,?,?,?,2,?,'replaying',?,?)",recovery,id(),id(),id(),'a'.repeat(64),'b'.repeat(64),now,now);
  await h.db.run("INSERT INTO restore_replay_facts(sequence,hash,operation_id,kind,scope_json,applied_at) VALUES(1,?,?,'account-deletion-reviewed',?,?)",'c'.repeat(64),id(),JSON.stringify({account_id:subject.accountId,deletion_request_id:request,reviewer_id:reviewer.accountId,decision:'approved'}),now);
 });
 await t.test('approval without an erased receipt, wrong reviewer/time and a different subject fail closed',async()=>{
  await assert.rejects(replayErasedAccountForRestore(h.app,subject.accountId,request,input),e=>e.code==='restore_erasure_receipt_required');
  await assert.rejects(replayErasedAccountForRestore(h.app,subject.accountId,request,{...input,reviewer_id:other.accountId}),e=>e.code==='restore_erasure_binding_unverified');
  await assert.rejects(replayErasedAccountForRestore(h.app,subject.accountId,request,{...input,reviewed_at:now-1}),e=>e.code==='restore_erasure_binding_unverified');
  await assert.rejects(replayErasedAccountForRestore(h.app,other.accountId,request,input),e=>e.code==='restore_erasure_binding_unverified');
 });
 await h.db.run("INSERT INTO restore_replay_facts(sequence,hash,operation_id,kind,scope_json,applied_at) VALUES(2,?,?,'account-erased',?,?)",'d'.repeat(64),id(),JSON.stringify({account_id:subject.accountId,deletion_request_id:request}),now);
 await t.test('a current moderation hold blocks replay without minimizing data or inventing absence',async()=>{
  const hold=id();await h.db.run("INSERT INTO moderation_holds(id,subject_id,active,created_at,reason) VALUES(?,?,1,?,'Synthetic restore hold')",hold,subject.accountId,now);
  try{await assert.rejects(replayErasedAccountForRestore(h.app,subject.accountId,request,input),e=>e.code==='privacy_legal_hold');
   assert.equal((await h.db.one('SELECT count(*) n FROM support_requests WHERE account_id=?',subject.accountId)).n,1);
   assert.equal((await h.db.one('SELECT metadata_erased_at FROM privacy_requests WHERE id=?',request)).metadata_erased_at,null);
  }finally{await h.db.run('UPDATE moderation_holds SET active=0,cleared_at=? WHERE id=?',now,hold);}
 });
 await t.test('authenticated historic approval repeats full metadata erasure without giving an operator new authority',async()=>{
  // Reviewer deliberately has ordinary user roles today. The independent old
  // review+erased receipts only authorize this exact restrictive episode.
  assert.equal(JSON.parse((await h.db.one('SELECT roles_json FROM accounts WHERE id=?',reviewer.accountId)).roles_json).includes('admin'),false);
  const before=h.env.PHOTOS.rows.size+h.env.QUARANTINE.rows.size+h.env.PRIVACY_EXPORTS.rows.size;
  const result=await replayErasedAccountForRestore(h.app,subject.accountId,request,input);
  assert.equal(result.subject_id,subject.accountId);assert.equal(result.request_id,request);assert(result.metadata_erased_at>0);assert(result.cleanup_remaining>0);
  assert.equal((await h.db.one('SELECT count(*) n FROM support_requests WHERE account_id=?',subject.accountId)).n,0);
  assert.equal((await h.db.one('SELECT count(*) n FROM sessions WHERE account_id=?',subject.accountId)).n,0);
  const stored=await h.db.one('SELECT status,failure_code,execution_token FROM privacy_requests WHERE id=?',request);
  assert.deepEqual(stored,{status:'failed',failure_code:'restore_cleanup_required',execution_token:null});
  assert.equal(h.env.PHOTOS.rows.size+h.env.QUARANTINE.rows.size+h.env.PRIVACY_EXPORTS.rows.size,before,'metadata replay cannot claim/delete physical bytes');
  assert.equal((await h.db.one('SELECT count(*) n FROM operator_capability_grants WHERE account_id=?',reviewer.accountId)).n,0);
  const again=await replayErasedAccountForRestore(h.app,subject.accountId,request,input);assert.equal(again.cleanup_remaining,result.cleanup_remaining);
 });
 await t.test('completion requires current exact absence proofs and never invents physical cleanup',async()=>{
  const originalMetadata=(await h.db.one('SELECT metadata_erased_at FROM privacy_requests WHERE id=?',request)).metadata_erased_at;
  await h.db.run('UPDATE privacy_requests SET metadata_erased_at=? WHERE id=?',now-1,request);
  await assert.rejects(completeErasedAccountForRestore(h.app,subject.accountId,request,input),e=>e.code==='restore_erasure_unconfirmed');
  await h.db.run('UPDATE privacy_requests SET metadata_erased_at=? WHERE id=?',originalMetadata,request);
  await assert.rejects(completeErasedAccountForRestore(h.app,subject.accountId,request,input),e=>e.code==='restore_cleanup_required');
  const writer=id();await h.db.run("INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at) VALUES(?,?,'PHOTOS','synthetic-undispatched-recovery-writer','pending',?)",writer,subject.accountId,now);
  await assert.rejects(completeErasedAccountForRestore(h.app,subject.accountId,request,input),e=>e.code==='privacy_writer_unresolved');
  // This isolated fixture has never dispatched that synthetic writer. It is
  // settled explicitly here, never inferred from elapsed time in production.
  await h.db.run("UPDATE media_write_intents SET status='settled',settled_at=? WHERE id=?",h.app.now(),writer);
  const cleanup=await h.db.all('SELECT id,bucket,object_key FROM cleanup_intents WHERE request_id=? ORDER BY id',request);assert(cleanup.length>0);
  for(const row of cleanup){await h.env[row.bucket].delete(row.object_key);await h.db.run("UPDATE cleanup_intents SET status='verified',verified_at=? WHERE id=?",h.app.now(),row.id);}
  await assert.rejects(completeErasedAccountForRestore(h.app,subject.accountId,request,input),e=>e.code==='restore_cleanup_proof_required');
  const metadata=(await h.db.one('SELECT metadata_erased_at FROM privacy_requests WHERE id=?',request)).metadata_erased_at;
  const proof=at=>stable({outcome:'absent',sha256:null,byte_size:null,etag:null,reference_hash:null,verified_at:at});
  for(const row of cleanup)await h.db.run(`INSERT INTO restore_cleanup_objects(recovery_id,effect_id,bucket,object_key,expected_sha256,expected_bytes,status,proof_json,updated_at)
   VALUES(?,?,?,?,?,0,'absent',?,?)`,recovery,'cleanup:'+row.id,row.bucket,row.object_key,'0'.repeat(64),proof(metadata-1),h.app.now());
  await assert.rejects(completeErasedAccountForRestore(h.app,subject.accountId,request,input),e=>e.code==='restore_cleanup_proof_required');
  for(const row of cleanup)await h.db.run('UPDATE restore_cleanup_objects SET proof_json=?,updated_at=? WHERE recovery_id=? AND effect_id=?',proof(h.app.now()),h.app.now(),recovery,'cleanup:'+row.id);
  await h.db.run('UPDATE restore_cleanup_objects SET object_key=? WHERE recovery_id=? AND effect_id=?','synthetic-wrong-proof-key',recovery,'cleanup:'+cleanup[0].id);
  await assert.rejects(completeErasedAccountForRestore(h.app,subject.accountId,request,input),e=>e.code==='restore_cleanup_proof_required');
  await h.db.run('UPDATE restore_cleanup_objects SET object_key=? WHERE recovery_id=? AND effect_id=?',cleanup[0].object_key,recovery,'cleanup:'+cleanup[0].id);
  const hold=id();await h.db.run("INSERT INTO moderation_holds(id,subject_id,active,created_at,reason) VALUES(?,?,1,?,'Completion hold')",hold,subject.accountId,h.app.now());
  await assert.rejects(completeErasedAccountForRestore(h.app,subject.accountId,request,input),e=>e.code==='privacy_legal_hold');
  await h.db.run('UPDATE moderation_holds SET active=0,cleared_at=? WHERE id=?',h.app.now(),hold);
  const physical=h.env.PHOTOS.rows.size+h.env.QUARANTINE.rows.size+h.env.PRIVACY_EXPORTS.rows.size;
  const result=await completeErasedAccountForRestore(h.app,subject.accountId,request,input);assert.equal(result.cleanup_verified,cleanup.length);
  assert.deepEqual(await h.db.one('SELECT status,completed_at,failure_code FROM privacy_requests WHERE id=?',request),{status:'completed',completed_at:result.completed_at,failure_code:null});
  assert.equal(h.env.PHOTOS.rows.size+h.env.QUARANTINE.rows.size+h.env.PRIVACY_EXPORTS.rows.size,physical,'completion consumes proof without performing external cleanup');
  assert.equal((await h.db.one('SELECT count(*) n FROM restore_replay_facts')).n,2,'completion must not invent another independent erasure fact');
  assert.deepEqual(await completeErasedAccountForRestore(h.app,subject.accountId,request,input),result);
  assert.equal((await h.db.one("SELECT count(*) n FROM audit_events WHERE action='privacy.erasure.restore_completed' AND entity_id=?",request)).n,1);
 });
 await t.test('completed recovery generations cannot reuse the private adapters',async()=>{
  await h.db.run("UPDATE restore_recovery_runs SET state='complete' WHERE id=?",recovery);
  await assert.rejects(replayErasedAccountForRestore(h.app,subject.accountId,request,input),e=>e.code==='restore_erasure_binding_unverified');
  await assert.rejects(completeErasedAccountForRestore(h.app,subject.accountId,request,input),e=>e.code==='restore_erasure_binding_unverified');
 });
});
