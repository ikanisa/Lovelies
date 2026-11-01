import assert from 'node:assert/strict';
import {test} from 'node:test';
import {matchingHarness,queueMatchingPhoto,finishMatching,assertUnpublished,candidateId,seedCandidates} from './photo-matching-fixture.mjs';
import {processPhotoJob} from '../src/processing.ts';
import {drainJobs} from '../src/jobs.ts';
import {encodeGeneration} from '../src/inference-generation.ts';
import {INFERENCE_ENGINE_SPACE} from '../src/inference-contract.ts';

test('captured pages only subtract revoked, reconsented, blocked and audience-ineligible identities; later arrivals cannot enter',{timeout:30000},async t=>{
  const {h,owner,calls}=await matchingHarness(t,260,{score:n=>n===261?.01:n===260?.1:n===129?.12:.8});
  const item=await queueMatchingPhoto(h,owner),original=item.attempt.profiles_json;
  await seedCandidates(h,261,261);
  const newConsent=crypto.randomUUID();
  await h.storage.exec("INSERT INTO consents(id,account_id,purpose,policy_version,status) VALUES(?,?,'photo_matching',?,'granted')",newConsent,candidateId(1),h.env.PHOTO_CONSENT_POLICY_VERSION);
  await h.storage.exec('UPDATE face_profiles SET consent_id=? WHERE account_id=?',newConsent,candidateId(1));
  await h.storage.exec('INSERT INTO blocks(blocker_id,blocked_id,created_at) VALUES(?,?,?)',owner.accountId,candidateId(2),Date.now());
  await h.storage.exec("UPDATE account_audience SET status='suspended' WHERE account_id=?",candidateId(3));
  assert.deepEqual(await processPhotoJob({attempt_id:item.attempt.id},h.app),{pending:true});
  await h.storage.exec("UPDATE consents SET status='revoked',revoked_at=? WHERE account_id=? AND purpose='photo_matching'",Date.now(),candidateId(129));
  await finishMatching(h,item);
  const seen=new Set(calls.flatMap(call=>call.profiles.map(p=>p.account_id)));
  for(const n of [1,2,3,129,261])assert(!seen.has(candidateId(n)),`changed/unadmitted identity ${n} must not reach the model`);
  assert.equal(seen.size,256);assert(seen.has(candidateId(260)));
  assert.deepEqual(await h.storage.exec('SELECT recipient_id FROM candidates WHERE asset_id=?',item.asset_id),[{recipient_id:candidateId(260)}]);
  assert.equal((await h.storage.exec('SELECT profiles_json FROM processing_attempts WHERE id=?',item.attempt.id))[0].profiles_json,original);
  await assert.rejects(h.storage.exec('UPDATE processing_attempt_profiles SET profile_json=profile_json WHERE attempt_id=?',item.attempt.id),/matching_capture_immutable/);
});

test('a globally retained winner withdrawn after its page cannot be replaced using incomplete runner-up evidence',{timeout:30000},async t=>{
  const {h,owner,calls}=await matchingHarness(t,129,{score:n=>n===1?.1:n===129?.12:.8});
  const item=await queueMatchingPhoto(h,owner);
  await processPhotoJob({attempt_id:item.attempt.id},h.app);
  await h.storage.exec("UPDATE consents SET status='revoked',revoked_at=? WHERE account_id=? AND purpose='photo_matching'",Date.now(),candidateId(1));
  await assert.rejects(processPhotoJob({attempt_id:item.attempt.id},h.app),e=>e.code==='matching_profile_changed');
  assert.equal(calls.length,2);await assertUnpublished(h,item,'matching_profile_changed');
});

test('a reclaimed queue resumes its exact checkpoint and rejects a changed query on the next page',{timeout:30000},async t=>{
  let changed=false;
  const {h,owner,calls}=await matchingHarness(t,129,{score:n=>n===129?.1:.8,beforeReply:(_input,result)=>{
    if(changed)result.ranking.query_sha256='d'.repeat(64);return result;
  }});
  const item=await queueMatchingPhoto(h,owner);
  await processPhotoJob({attempt_id:item.attempt.id},h.app);
  // Simulate isolate death after the page commit but before the queue ack.
  await h.storage.exec("UPDATE job_queue SET state='processing',lease_token='expired-fixture',lease_until=?,attempts=1 WHERE category='photo'",Date.now()-1);
  changed=true;assert.deepEqual(await drainJobs(h.app,1),{processed:0,failed:1});
  assert.equal(calls.length,2);assert.deepEqual(calls[1].profiles.map(p=>p.account_id),[candidateId(129)]);
  assert.equal((await h.storage.exec('SELECT next_ordinal FROM processing_match_progress WHERE attempt_id=?',item.attempt.id))[0].next_ordinal,128);
  await assertUnpublished(h,item,'matching_query_changed');
});

test('missing capture rows and switched inference generations stop resumed work before another private call',{timeout:30000},async t=>{
  const {h,owner,calls}=await matchingHarness(t,129,{score:n=>n===129?.1:.8});
  const missing=await queueMatchingPhoto(h,owner);
  await h.storage.exec('DELETE FROM processing_attempt_profiles WHERE attempt_id=? AND ordinal=0',missing.attempt.id);
  await assert.rejects(processPhotoJob({attempt_id:missing.attempt.id},h.app),e=>e.code==='matching_plan_invalid');
  assert.equal(calls.length,0);await assertUnpublished(h,missing,'matching_plan_invalid');
  const generation=await queueMatchingPhoto(h,owner);
  await processPhotoJob({attempt_id:generation.attempt.id},h.app);assert.equal(calls.length,1);
  h.env.INFERENCE_ENGINE_IDENTITY=encodeGeneration({engine_space:INFERENCE_ENGINE_SPACE,engine_artifact_sha256:'e'.repeat(64),processing_fingerprint:'f'.repeat(64)});
  await processPhotoJob({attempt_id:generation.attempt.id},h.app);
  assert.equal(calls.length,1);await assertUnpublished(h,generation,'inference_generation_changed');
});
