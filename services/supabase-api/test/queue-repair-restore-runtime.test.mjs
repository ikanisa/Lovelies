import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fixture as restoreFixture} from './restore-database-fixture.mjs';
import {enroll,captureProofs,faceVerifierFixture} from './runtime-harness.mjs';
import {createApp,createHandler} from '../src/index.ts';
import {stable} from '../src/types.ts';

test('operator freshness expiring during independent prepare rolls back queue work and retires the original intent',async t=>{
  const f=await restoreFixture(t);
  f.h.env.FACE_AUTH_VERIFIER={fetch:async request=>{const form=await request.formData();return Response.json(await faceVerifierFixture(JSON.parse(String(form.get('envelope'))),form));}};
  const admin=await enroll(f.h),subject=await enroll(f.h);
  await f.h.db.run('UPDATE accounts SET roles_json=? WHERE id=?','["user","admin"]',admin.accountId);
  const challenge=await f.h.json('/auth/face/challenge',{body:{face_handle:admin.faceHandle,device_id:admin.deviceId}},201);
  const auth=await f.h.json('/auth/face/complete',{body:await captureProofs(f.h,challenge,admin.keys.privateKey)});
  const requestID=crypto.randomUUID(),outboxID=crypto.randomUUID(),operationKey=crypto.randomUUID();let now=Date.now();
  await f.h.db.run("INSERT INTO privacy_requests(id,subject_id,requested_by,request_type,status,created_at,expires_at,reviewed_by,reviewed_at) VALUES(?,?,?,'export','queued',?,?,?,?)",
    requestID,subject.accountId,subject.accountId,now,now+900000,admin.accountId,now);
  await f.h.db.run("INSERT INTO outbox(id,account_id,category,entity_id,event_key,payload_json,created_at) VALUES(?,?,'privacy',?,?,?,?)",
    outboxID,subject.accountId,requestID,'privacy:'+requestID+':approved',stable({request_id:requestID}),now);
  const job=await f.queue.send({category:'privacy',payload:{request_id:requestID}});
  await f.db.run("UPDATE job_queue SET state='failed',attempts=20,error_code='fixture_dispatch_stopped' WHERE id=?",job.id);
  const app=createApp(f.db,f.h.env,()=>now),handler=createHandler(app),path='http://localhost/admin/queue-repairs/'+job.id;
  const previewResponse=await handler(new Request(path,{headers:{authorization:'Bearer '+auth.access_token}}));
  assert.equal(previewResponse.status,200);const preview=(await previewResponse.json()).queue_repair;assert.equal(preview.eligible,true);
  const prepare=f.db.fence.prepare.bind(f.db.fence);let advanced=false;
  f.db.fence.prepare=async(...args)=>{const result=await prepare(...args);if(!advanced){advanced=true;now+=300001;}return result;};
  const response=await handler(new Request(path,{method:'POST',headers:{authorization:'Bearer '+auth.access_token,'content-type':'application/json'},
    body:JSON.stringify({operation_key:operationKey,expected_fingerprint:preview.fingerprint,reason:'Synthetic independent-prepare expiry proof'})}));
  assert.equal(response.status,503,JSON.stringify(await response.clone().json()));
  assert.equal((await response.json()).error.code,'queue_repair_outcome_unresolved');assert.equal(advanced,true);
  assert.equal((await f.journal.control()).state,'pending','Complete prepare remains fenced until exact reconciliation');
  now-=300001;
  const recovered=await handler(new Request(path,{headers:{authorization:'Bearer '+auth.access_token}}));
  assert.equal(recovered.status,200);await recovered.body?.cancel();
  assert.equal((await f.journal.control()).state,'serving','Complete computes restrictive replay before reopening admission');
  assert.deepEqual(await f.h.db.one('SELECT state,attempts,error_code FROM job_queue WHERE id=?',job.id),{state:'failed',attempts:20,error_code:'fixture_dispatch_stopped'});
  assert.equal((await f.h.db.one('SELECT delivered_at FROM outbox WHERE id=?',outboxID)).delivered_at,null);
  assert.equal((await f.h.db.one("SELECT count(*) n FROM operations WHERE source='queue_repair'")).n,0);
  assert.deepEqual(await f.h.db.all('SELECT outcome FROM restore_recovered_operations'),[{outcome:'restricted-abort'}]);
  assert.equal((await f.h.db.one("SELECT count(*) n FROM audit_events WHERE action='admin.queue.repair'")).n,0);
  const retry=await handler(new Request(path,{method:'POST',headers:{authorization:'Bearer '+auth.access_token,'content-type':'application/json'},body:JSON.stringify({operation_key:operationKey,expected_fingerprint:preview.fingerprint,reason:'Synthetic independent-prepare expiry proof'})}));
  assert.equal(retry.status,410);assert.equal((await retry.json()).error.code,'operation_retired_by_recovery');
});
