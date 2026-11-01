import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startHarness,enroll,faceVerifierFixture,fixturePng} from './runtime-harness.mjs';
import {prepareOperation} from '../src/operations.ts';
import {restoreOperationID} from '../src/restore-transaction.ts';

test('terminal original upload-complete retry returns before Storage while fresh and committed calls retain behavior',{timeout:40000},async t=>{
  let modelCalls=0;
  const h=await startHarness({faceVerifier:faceVerifierFixture,photoProcessor:async()=>{modelCalls++;throw new Error('model must not run in this gate');},consumeQueue:false});
  t.after(()=>h.close());const owner=await enroll(h),key=()=>crypto.randomUUID();
  await h.json('/me/photo-preferences',{token:owner.token,body:{policy_version:'photo-policy-fixture-v1',processing_consent:true,operation_key:key()}});
  const bytes=fixturePng('terminal-complete'),reservation=await h.json('/uploads/session',{token:owner.token,
    body:{source:'personal',content_type:'image/png',byte_size:bytes.length,operation_key:key()}},201);
  await h.json(reservation.upload_url,{token:owner.token,method:'PUT',raw:bytes,headers:{'content-type':'image/png'}});
  const body={operation_key:key()},intent=await prepareOperation('photo.upload.complete',{...body,asset_id:reservation.asset_id},'personal');
  await h.db.run(`INSERT INTO restore_recovered_operations(operation_id,input_hash,plan_hash,outcome,recovered_at)
    VALUES(?,?,?,'restricted-abort',?)`,await restoreOperationID(owner.accountId,'personal',intent.key),intent.hash,'a'.repeat(64),Date.now());
  const head=h.env.QUARANTINE.head.bind(h.env.QUARANTINE);let heads=0,denyHead=true;
  h.env.QUARANTINE.head=async(...args)=>{heads++;if(denyHead)throw new Error('Storage must not be contacted after terminal recovery');return head(...args);};
  assert.equal((await h.json(reservation.complete_url,{token:owner.token,body},409)).error.code,'operation_recovered_without_result');
  assert.equal((await h.json(reservation.complete_url,{token:owner.token,body:{...body,title:'changed exact request'}},409)).error.code,'operation_key_conflict');
  assert.equal(heads,0);assert.equal(modelCalls,0);
  assert.equal((await h.db.one('SELECT count(*) n FROM processing_attempts WHERE asset_id=?',reservation.asset_id)).n,0);
  assert.equal((await h.db.one("SELECT count(*) n FROM job_queue WHERE category='photo'")).n,0);
  denyHead=false;
  const fresh={operation_key:key()},first=await h.json(reservation.complete_url,{token:owner.token,body:fresh},202);
  assert.equal(first.status,'processing');assert.equal(heads,1);
  const replay=await h.json(reservation.complete_url,{token:owner.token,body:fresh},202);
  assert.deepEqual(replay,first);assert.equal(heads,2);assert.equal(modelCalls,0);
  assert.equal((await h.db.one('SELECT count(*) n FROM processing_attempts WHERE asset_id=?',reservation.asset_id)).n,1);
  await h.db.run('UPDATE sessions SET revoked_at=? WHERE account_id=?',Date.now(),owner.accountId);
  await h.json(reservation.complete_url,{token:owner.token,body},401);assert.equal(heads,2);
});
