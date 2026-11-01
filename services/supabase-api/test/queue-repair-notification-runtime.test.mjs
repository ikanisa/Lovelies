import assert from 'node:assert/strict';
import {test} from 'node:test';
import {notificationRosterFixture} from './notification-roster-fixture.mjs';
import {enroll,captureProofs,faceVerifierFixture} from './runtime-harness.mjs';
import {digest,stable} from '../src/types.ts';
import {drainJobs} from '../src/jobs.ts';

async function fixture(t,{plan=true,local=true,prepare}={}){
  const f=await notificationRosterFixture(t,{prepare});
  f.h.env.FACE_AUTH_VERIFIER={fetch:async request=>{const form=await request.formData();return Response.json(await faceVerifierFixture(JSON.parse(String(form.get('envelope'))),form));}};
  const person=await enroll(f.h);
  await f.h.db.run('UPDATE accounts SET roles_json=? WHERE id=?','["user","admin"]',person.accountId);
  const challenge=await f.h.json('/auth/face/challenge',{body:{face_handle:person.faceHandle,device_id:person.deviceId}},201);
  const auth=await f.h.json('/auth/face/complete',{body:await captureProofs(f.h,challenge,person.keys.privateKey)});
  const note=await f.h.db.one('SELECT entity_id FROM notifications WHERE id=?',f.notification);
  const snapshot=await f.provider.plan({notificationID:f.notification,subject:await digest('lovelies-push-subject-v2:'+f.account),
    devices:f.registrations.map(device=>({...device,entity_id:note.entity_id}))});
  const save=()=>f.h.db.run('INSERT INTO notification_dispatch_plans(notification_id,subject_sha256,provider_generation,plan_sha256,plan_json,created_at) VALUES(?,?,?,?,?,?)',
    f.notification,snapshot.plan.subject_sha256,snapshot.plan.provider_generation,snapshot.hash,stable(snapshot.plan),Date.now());
  if(plan)await f.provider.roster.plan(snapshot.plan);
  if(local)await save();
  const receipt=await f.h.env.PHOTO_JOBS.send({category:'notification',payload:{notification_id:f.notification}});
  await f.h.db.run("UPDATE job_queue SET state='failed',attempts=20,error_code='fixture_dispatch_stopped' WHERE id=?",receipt.id);
  f.calls.length=0;
  return {...f,snapshot,save,jobID:receipt.id,token:auth.access_token,path:'/admin/queue-repairs/'+receipt.id};
}
const input=preview=>({operation_key:crypto.randomUUID(),expected_fingerprint:preview.fingerprint,reason:'Verify the exact independent unsent roster before resuming.'});
async function preview(f){return (await f.h.json(f.path,{token:f.token})).queue_repair;}
async function blocked(f,code){
  const value=await preview(f);assert.equal(value.eligible,false);assert.equal(value.blocked_reason,code);
  assert.equal((await f.h.json(f.path,{token:f.token,body:input(value)},409)).error.code,'queue_repair_blocked');
  assert.equal((await f.h.db.one('SELECT state FROM job_queue WHERE id=?',f.jobID)).state,'failed');
}

test('a complete independently pinned unsent roster can be explicitly repaired and delivered once',async t=>{
  const f=await fixture(t),value=await preview(f),body=input(value);
  assert.equal(value.eligible,true);assert.equal(value.category,'notification');assert.equal(value.domain_id,f.notification);
  assert.equal(f.provider.sent.length,0);assert(f.calls.every(call=>call.method==='GET'));
  const result=await f.h.json(f.path,{token:f.token,body});
  assert.equal(result.queue_repair.status,'admitted');assert(f.calls.every(call=>call.method==='GET'),'repair never creates a plan or dispatches');
  assert.equal((await f.job()).status,'dispatched');
  assert.deepEqual(await f.h.db.one('SELECT state,attempts,error_code FROM job_queue WHERE id=?',f.jobID),{state:'pending',attempts:20,error_code:'fixture_dispatch_stopped'});
  assert.equal(f.provider.sent.length,0);
  assert.deepEqual(await drainJobs(f.h.app,1),{processed:1,failed:0});
  assert.equal(f.provider.sent.length,2);assert.equal((await f.job()).status,'accepted');
  assert.deepEqual(await f.h.json(f.path,{token:f.token,body}),result);
  assert.equal(f.provider.sent.length,2);
  assert.equal((await f.h.db.one("SELECT count(*) n FROM audit_events WHERE action='admin.queue.repair' AND entity_id=?",f.jobID)).n,1);
});

test('a failed provider preflight can resume only after the complete independent roster proves every entry unstarted',async t=>{
  let ready=false;
  const f=await fixture(t,{prepare:async(input,id)=>{if(!ready)throw Error('synthetic_preflight_failure');return {input,id};}});
  await assert.rejects(f.process,error=>error.code==='push_reconciliation_required');
  assert.equal((await f.job()).status,'ambiguous');assert.equal(f.provider.sent.length,0);
  assert((await f.receipts()).every(row=>row.status==='unstarted'));
  const value=await preview(f);assert.equal(value.eligible,true);assert.equal(value.domain_status,'ambiguous');
  ready=true;
  await f.h.json(f.path,{token:f.token,body:input(value)});
  const audit=await f.h.db.one("SELECT details_json FROM audit_events WHERE action='admin.queue.repair' AND entity_id=?",f.jobID);
  assert.equal(JSON.parse(audit.details_json).previous_domain_status,'ambiguous');
  assert.deepEqual(await drainJobs(f.h.app,1),{processed:1,failed:0});
  assert.equal(f.provider.sent.length,2);assert.equal((await f.job()).status,'accepted');
});

test('notification repair holds missing local or independent plans, changed payloads and current devices',async t=>{
  const f=await fixture(t,{plan:false,local:false});
  await blocked(f,'queue_notification_not_pristine');
  await f.provider.roster.plan(f.snapshot.plan);
  await blocked(f,'queue_notification_plan_changed');
  await f.save();assert.equal((await preview(f)).eligible,true);
  const original=await f.h.db.one('SELECT title FROM notifications WHERE id=?',f.notification);
  await f.h.db.run('UPDATE notifications SET title=? WHERE id=?','Changed current title',f.notification);
  await blocked(f,'queue_notification_payload_changed');
  await f.h.db.run('UPDATE notifications SET title=? WHERE id=?',original.title,f.notification);
  await f.h.db.run('UPDATE push_devices SET active=0 WHERE id=?',f.registrations[0].id);
  await blocked(f,'queue_notification_device_changed');
  await f.h.db.run('UPDATE push_devices SET active=1 WHERE id=?',f.registrations[0].id);
  await f.h.db.run('INSERT INTO notification_settings(account_id,support_alerts,updated_at) VALUES(?,0,?)',f.account,Date.now());
  await blocked(f,'queue_notification_authority_changed');
  await f.h.db.run('DELETE FROM notification_settings WHERE account_id=?',f.account);
  const entry=f.snapshot.plan.attempts[0],legacy=crypto.randomUUID();
  await f.h.db.run("INSERT INTO notification_deliveries(id,notification_id,device_id,operation_key,status,token_hash,request_sha256,attempts,created_at,updated_at) VALUES(?,?,?,?,'ambiguous',?,?,1,?,?)",
    legacy,f.notification,entry.device_id,entry.operation_key,entry.token_sha256,entry.request_sha256,Date.now(),Date.now());
  await blocked(f,'queue_notification_not_pristine');
  await f.h.db.run('DELETE FROM notification_deliveries WHERE id=?',legacy);
  assert.equal((await preview(f)).eligible,true);assert.equal(f.provider.sent.length,0);
  assert(f.calls.every(call=>call.method==='GET'));
});

test('independent dispatch transitions invalidate previews and never become retry authority',async t=>{
  const f=await fixture(t),value=await preview(f),dispatch=f.snapshot.dispatches[0];
  const reserved=await f.provider.roster.reserve(dispatch,f.snapshot.hash);
  assert.equal(reserved.receipt.status,'preparing');
  assert.equal((await f.h.json(f.path,{token:f.token,body:input(value)},409)).error.code,'queue_repair_snapshot_changed');
  await blocked(f,'queue_notification_not_pristine');
  await f.provider.roster.start(dispatch.operation_key,reserved.claim,f.provider.generation);
  await blocked(f,'queue_notification_not_pristine');
  await f.provider.roster.finish(dispatch.operation_key,{status:'accepted',provider_message_id:'synthetic-existing-acceptance'});
  await blocked(f,'queue_notification_not_pristine');
  await f.provider.roster.retirePlan(f.notification);
  await blocked(f,'queue_notification_not_pristine');
  assert.equal(f.provider.sent.length,0);assert(f.calls.every(call=>call.method==='GET'));
  assert.equal((await f.h.db.one("SELECT count(*) n FROM audit_events WHERE action='admin.queue.repair'")).n,0);
});

test('provider outage or incorrect bootstrap pin cannot be converted into a repair preview or mutation',async t=>{
  const f=await fixture(t),value=await preview(f),service=f.h.env.PUSH_SERVICE;
  f.h.env.PUSH_SERVICE={fetch:async()=>Response.json({error:'fixture_outage'},{status:503})};
  await f.h.json(f.path,{token:f.token},503);
  await f.h.json(f.path,{token:f.token,body:input(value)},503);
  f.h.env.PUSH_SERVICE=service;
  f.h.env.PUSH_LEDGER_BOOTSTRAP_ID=crypto.randomUUID();
  await f.h.json(f.path,{token:f.token},503);
  await f.h.json(f.path,{token:f.token,body:input(value)},503);
  assert.equal((await f.h.db.one('SELECT state,attempts FROM job_queue WHERE id=?',f.jobID)).state,'failed');
  assert.equal(f.provider.sent.length,0);
});
