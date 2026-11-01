import assert from 'node:assert/strict';
import {test} from 'node:test';
import {matchingHarness,queueMatchingPhoto,finishMatching,candidateId} from './photo-matching-fixture.mjs';
import {MATCH_PAGE_SIZE,MATCH_PLAN_PROTOCOL} from '../src/photo-matching.ts';
import {drainJobs} from '../src/jobs.ts';

test('999,1000,1001 and4097 captured profiles complete in bounded pages with global confidence', {timeout:180000}, async t=>{
  let total=4097,ambiguous=false;
  const {h,owner,calls}=await matchingHarness(t,total,{score:n=>n===total?.10:ambiguous&&n===1?.12:.8});
  for(const count of [999,1000,1001,4097]){
    total=count;ambiguous=count===1000;calls.length=0;
    await h.storage.exec("UPDATE accounts SET disabled_at=CASE WHEN id>? THEN ? ELSE NULL END WHERE id LIKE '20000000-0000-4000-8000-%'",candidateId(count),Date.now());
    const item=await queueMatchingPhoto(h,owner),manifest=JSON.parse(item.attempt.profiles_json);
    assert.equal(manifest.protocol,MATCH_PLAN_PROTOCOL);assert.equal(manifest.profile_count,count);
    assert.equal((await h.storage.exec('SELECT count(*) n FROM processing_attempt_profiles WHERE attempt_id=?',item.attempt.id))[0].n,count);
    assert.equal(await finishMatching(h,item),Math.ceil(count/MATCH_PAGE_SIZE));
    const seen=calls.flatMap(call=>call.profiles.map(p=>p.account_id));
    assert.equal(seen.length,count);assert.equal(new Set(seen).size,count);assert.equal(seen.at(-1),candidateId(count));
    assert(calls.slice(0,-1).every(call=>call.include_preview===false));assert.equal(calls.at(-1).include_preview,true);
    const matches=await h.storage.exec('SELECT recipient_id FROM candidates WHERE asset_id=?',item.asset_id);
    assert.deepEqual(matches,ambiguous?[]:[{recipient_id:candidateId(count)}]);
    assert.equal((await h.storage.exec('SELECT status,profiles_json FROM processing_attempts WHERE id=?',item.attempt.id))[0].status,'completed');
    assert.equal((await h.storage.exec('SELECT count(*) n FROM media_grants WHERE asset_id=?',item.asset_id))[0].n,0,'matching never grants media');
    assert.equal((await h.storage.exec('SELECT count(*) n FROM processing_match_progress WHERE attempt_id=?',item.attempt.id))[0].n,0);
  }
});

test('successful page continuation preserves queue failure history and never acknowledges a partial photo as complete',{timeout:30000},async t=>{
  const {h,owner}=await matchingHarness(t,129,{score:n=>n===129?.1:.8});
  const item=await queueMatchingPhoto(h,owner);
  await h.storage.exec("UPDATE job_queue SET attempts=7,error_code='previous_transport_failure' WHERE category='photo'");
  assert.deepEqual(await drainJobs(h.app,1),{processed:0,failed:0,pending:1});
  const queue=(await h.storage.exec("SELECT state,attempts,error_code,completed_at FROM job_queue WHERE category='photo'"))[0];
  assert.deepEqual(queue,{state:'pending',attempts:7,error_code:'previous_transport_failure',completed_at:null});
  assert.equal((await h.storage.exec('SELECT next_ordinal FROM processing_match_progress WHERE attempt_id=?',item.attempt.id))[0].next_ordinal,128);
  assert.equal((await h.storage.exec('SELECT status FROM assets WHERE id=?',item.asset_id))[0].status,'processing');
  assert.deepEqual(await drainJobs(h.app,1),{processed:1,failed:0});
  assert.equal((await h.storage.exec("SELECT state FROM job_queue WHERE category='photo'"))[0].state,'completed');
});
