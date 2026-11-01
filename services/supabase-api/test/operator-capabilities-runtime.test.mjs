import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startHarness,enroll,captureProofs,faceVerifierFixture} from './runtime-harness.mjs';
import {OPERATOR_CAPABILITIES,hasOperatorCapability} from '../src/operator-capabilities.ts';
import {AUDIENCE_POLICY} from '../src/audience.ts';

test('delegated operators use current scoped grants across routes and cached operations',async t=>{
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});t.after(()=>h.close());
 const admin=await enroll(h),staff=await enroll(h),subject=await enroll(h);
 await h.storage.exec('UPDATE accounts SET roles_json=? WHERE id=?','["user","admin"]',admin.accountId);
 const challenge=await h.json('/auth/face/challenge',{body:{face_handle:admin.faceHandle,device_id:admin.deviceId}},201);
 const signed=await h.json('/auth/face/complete',{body:await captureProofs(h,challenge,admin.keys.privateKey)}),token=signed.access_token;
 const path=`/admin/operators/${staff.accountId}/capabilities`;
 const grant=async(capabilities,{expected,expires=Date.now()+3600000,key=crypto.randomUUID(),status=200}={})=>{
  const current=await h.json(`/admin/operators/${staff.accountId}`,{token});
  const body={capabilities,expected_revision:expected??current.operator.revision,expires_at:capabilities.length?new Date(expires).toISOString():null,
   reason:'Synthetic reviewed staff scope',operation_key:key};
  return {value:await h.json(path,{token,body},status),body};
 };
 const caseId=(await h.json('/support/requests',{token:subject.token,body:{subject:'Scoped support',details:'Synthetic private case contents',operation_key:crypto.randomUUID()}},201)).id;
 const adminPaths=['/admin/metrics','/admin/users','/admin/support-requests','/admin/safety/reports','/admin/guardian-requests','/admin/privacy-requests','/admin/uploads','/admin/retention','/admin/operators'];
 await t.test('ordinary account has no operator capabilities or admin route authority',async()=>{
  assert.deepEqual((await h.json('/me',{token:staff.token})).operator_capabilities,[]);
  for(const route of adminPaths)await h.json(route,{token:staff.token},403);
  assert.deepEqual((await h.json('/me',{token})).operator_capabilities,OPERATOR_CAPABILITIES);
 });
 await t.test('read-only support grant admits only its queue and cannot delegate or decide',async()=>{
  const assigned=await grant(['support.read']);assert.equal(assigned.value.administrator_created,false);
  const me=await h.json('/me',{token:staff.token});assert.deepEqual(me.roles,['user']);assert.deepEqual(me.operator_capabilities,['support.read']);
  assert.equal((await h.json('/admin/support-requests',{token:staff.token})).support_requests[0].id,caseId);
  for(const route of adminPaths.filter(route=>route!=='/admin/support-requests'))await h.json(route,{token:staff.token},403);
  await h.json(`/admin/support-requests/${caseId}/start`,{token:staff.token,body:{expected_revision:1,review_notes:'Read-only cannot act',operation_key:crypto.randomUUID()}},403);
  await h.json(path,{token:staff.token,body:assigned.body},403);
 });
 let decision,receipt;
 await t.test('only explicit review capability admits a support decision; users scope cannot reveal other case classes',async()=>{
  await grant(['support.read','support.review','users.read']);
  decision={expected_revision:1,review_notes:'Scoped operator investigation',operation_key:crypto.randomUUID()};
  receipt=await h.json(`/admin/support-requests/${caseId}/start`,{token:staff.token,body:decision});assert.equal(receipt.support_request.revision,2);
  assert.deepEqual(await h.community(staff.token,'operation',{operation_key:decision.operation_key}),receipt);
  await h.storage.exec("INSERT INTO privacy_requests(id,subject_id,requested_by,request_type,status,created_at,expires_at) VALUES(?,?,?,'export','pending_approval',?,?)",crypto.randomUUID(),subject.accountId,subject.accountId,Date.now(),Date.now()+86400000);
  await h.storage.exec("INSERT INTO safety_reports(id,reporter_id,reason,status,created_at) VALUES(?,?,'Hidden report','open',?)",crypto.randomUUID(),subject.accountId,Date.now());
  const detail=await h.json('/admin/users/'+subject.accountId,{token:staff.token});assert(detail.cases.support.length);
  assert.deepEqual(detail.cases.privacy,[]);assert.deepEqual(detail.cases.safety,[]);assert.deepEqual(detail.history,[]);
  assert.deepEqual(new Set(detail.redacted_sections),new Set(['privacy','safety','history']));
  await h.json(`/admin/users/${subject.accountId}/sessions/revoke`,{token:staff.token,body:{session_id:subject.challenge.session_id,reason:'Scope cannot revoke',operation_key:crypto.randomUUID()}},403);
 });
 await t.test('removing a capability denies a previously successful exact receipt replay without a new login',async()=>{
  await grant(['support.read']);
  const denied=await h.json(`/admin/support-requests/${caseId}/start`,{token:staff.token,body:decision},403);
  assert.equal(denied.error.code,'operator_capability_required');
  const genericDenied=await h.community(staff.token,'operation',{operation_key:decision.operation_key},403);
  assert.equal(genericDenied.error.code,'operator_capability_required');
  assert.equal((await h.db.one('SELECT revision FROM support_requests WHERE id=?',caseId)).revision,receipt.support_request.revision);
  assert.deepEqual((await h.json('/me',{token:staff.token})).operator_capabilities,['support.read']);
 });
 await t.test('expiry during a cached receipt lookup denies its response and expiry after a new write rolls the mutation back',async()=>{
  const expires=Date.now()+60000;await grant(['support.read','support.review'],{expires});
  const originalNow=h.app.now,one=h.db.one.bind(h.db),run=h.db.run.bind(h.db);let clock=originalNow(),armed=true;
  h.app.now=()=>clock;
  h.db.one=async(sql,...bindings)=>{const row=await one(sql,...bindings);if(armed&&sql.startsWith('SELECT action,payload_hash,payload_json,response_json FROM operations')){armed=false;clock=expires+1;}return row;};
  try{
   const denied=await h.json(`/admin/support-requests/${caseId}/start`,{token:staff.token,body:decision},403);
   assert.equal(denied.error.code,'operator_capability_required');assert.equal(armed,false);
  }finally{h.db.one=one;h.app.now=originalNow;}
  const before=await h.db.one('SELECT * FROM support_requests WHERE id=?',caseId),next={expected_revision:before.revision,review_notes:'Expire while mutation is in flight',operation_key:crypto.randomUUID()};
  clock=originalNow();armed=true;h.app.now=()=>clock;
  h.db.run=async(sql,...bindings)=>{const value=await run(sql,...bindings);if(armed&&sql.startsWith('UPDATE support_requests SET')){armed=false;clock=expires+1;}return value;};
  try{
   const denied=await h.json(`/admin/support-requests/${caseId}/approve`,{token:staff.token,body:next},403);
   assert.equal(denied.error.code,'operator_capability_required');assert.equal(armed,false);
  }finally{h.db.run=run;h.app.now=originalNow;}
  assert.deepEqual(await h.db.one('SELECT * FROM support_requests WHERE id=?',caseId),before);
  assert.equal(await h.db.one("SELECT operation_key FROM operations WHERE actor_id=? AND source='support' AND operation_key=?",staff.accountId,next.operation_key),null);
 });
 await t.test('stale revision, self-management, forged capability and missing read prerequisites leave grants unchanged',async()=>{
  const before=(await h.json(`/admin/operators/${staff.accountId}`,{token})).operator;
  await grant(['privacy.read'],{expected:0,status:409});
  const common={capabilities:['support.read'],expected_revision:0,expires_at:new Date(Date.now()+3600000).toISOString(),reason:'Synthetic independent decision',operation_key:crypto.randomUUID()};
  await h.json(`/admin/operators/${admin.accountId}/capabilities`,{token,body:common},403);
  await h.json(path,{token,body:{...common,capabilities:['operators.manage']}},400);
  await grant(['privacy.review'],{status:400});
  await grant(['support.read'],{expires:Date.now()+31*86400000,status:400});
  assert.deepEqual((await h.json(`/admin/operators/${staff.accountId}`,{token})).operator,before);
 });
 await t.test('grant replacement is idempotent and altered input under its original key conflicts',async()=>{
  const {value,body}=await grant(['privacy.read']);
  assert.deepEqual(await h.json(path,{token,body}),value);
  await h.json(path,{token,body:{...body,capabilities:['uploads.read']}},409);
  assert.equal((await h.db.one('SELECT version FROM operator_access_versions WHERE account_id=?',staff.accountId)).version,value.operator.revision);
  const retired=await h.db.all('SELECT id,revoked_at FROM operator_capability_grants WHERE account_id=? AND revoked_at IS NOT NULL',staff.accountId);assert(retired.length>=3);
  const captured=await h.db.all("SELECT scope_json FROM restore_transaction_facts WHERE kind='operator-capability-retired'");
  assert.deepEqual(captured,[],'an unbound fixture must not accumulate orphan capture rows; the fenced capture path has its own database regression');
 });
 await t.test('expired grant loses permission under the same token, and ordinary users cannot query grant records',async()=>{
  await grant(['support.read'],{expires:Date.now()+10000});
  const now=h.app.now;h.app.now=()=>now()+11000;
  try{await h.json('/admin/support-requests',{token:staff.token},403);assert.deepEqual((await h.json('/me',{token:staff.token})).operator_capabilities,[]);}
  finally{h.app.now=now;}
  await h.json(`/admin/operators/${staff.accountId}`,{token:staff.token},403);
 });
 await t.test('background reviewer authority also requires the current adult policy and review window',async()=>{
  await grant(['privacy.read','privacy.review']);
  assert.equal(await hasOperatorCapability(h.app,staff.accountId,'privacy.review'),true);
  const original=await h.db.one('SELECT decision_protocol,policy_version,declared_at,next_review_at FROM account_audience WHERE account_id=?',staff.accountId);
  assert.equal(original.decision_protocol,'decision-v2');assert(original.next_review_at>original.declared_at);
  try{
   await h.db.run('UPDATE account_audience SET policy_version=? WHERE account_id=?','superseded-synthetic-policy',staff.accountId);
   assert.equal(await hasOperatorCapability(h.app,staff.accountId,'privacy.review'),false);
   await h.db.run('UPDATE account_audience SET policy_version=?,next_review_at=? WHERE account_id=?',AUDIENCE_POLICY,h.app.now()-1,staff.accountId);
   assert.equal(await hasOperatorCapability(h.app,staff.accountId,'privacy.review'),false);
  }finally{await h.db.run('UPDATE account_audience SET policy_version=?,next_review_at=? WHERE account_id=?',original.policy_version,original.next_review_at,staff.accountId);}
  assert.equal(await hasOperatorCapability(h.app,staff.accountId,'privacy.review'),true);
 });
 await t.test('all capability names are installed with private RLS and episode identity cannot be edited back into authority',async()=>{
  const row=await h.db.one('SELECT * FROM operator_capability_grants WHERE account_id=? AND revoked_at IS NOT NULL LIMIT 1',staff.accountId);
  await assert.rejects(()=>h.storage.exec('UPDATE operator_capability_grants SET revoked_at=NULL WHERE id=?',row.id),/operator_capability_binding_immutable/);
  await assert.rejects(()=>h.storage.exec("UPDATE operator_capability_grants SET capability='privacy.review' WHERE id=?",row.id),/operator_capability_binding_immutable/);
  const list=await h.json('/admin/operators?limit=1',{token});assert.equal(list.operators.length,1);assert(list.page.next_cursor);
  await h.json('/admin/operators?limit=1&q=changed&cursor='+list.page.next_cursor,{token},400);
 });
});
