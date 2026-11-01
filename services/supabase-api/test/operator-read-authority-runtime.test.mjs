import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startHarness,enroll,faceVerifierFixture} from './runtime-harness.mjs';

// One actual PostgreSQL fixture for the file; only the clock and awaited query
// boundaries are controlled. Routes, grants, actor checks and redaction are real.
test('operator reads retain current scope through queries and transaction completion',async t=>{
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});
 t.after(()=>h.close());
 const administrator=await enroll(h),staff=await enroll(h),subject=await enroll(h);
 await h.storage.exec('UPDATE accounts SET roles_json=? WHERE id=?','["user","admin"]',administrator.accountId);
 const originalNow=h.app.now,base=originalNow(),expires=base+5000,later=base+300000;
 let clock=base;h.app.now=()=>clock;t.after(()=>{h.app.now=originalNow;});
 const readScopes=['overview.read','users.read','support.read','safety.read','privacy.read','uploads.read'];
 const caseIds={support:[],safety:[],privacy:[]},asset=crypto.randomUUID(),attempt=crypto.randomUUID(),origin=crypto.randomUUID(),match=crypto.randomUUID(),version=crypto.randomUUID();
 await h.db.transaction(async()=>{
  for(let index=0;index<21;index++){
   const support=crypto.randomUUID(),safety=crypto.randomUUID(),privacy=crypto.randomUUID();
   caseIds.support.push(support);caseIds.safety.push(safety);caseIds.privacy.push(privacy);
   await h.db.run("INSERT INTO support_requests(id,account_id,subject,details,status,created_at,updated_at) VALUES(?,?,?,?,'open',?,?)",
    support,subject.accountId,'Read authority case '+index,'Synthetic private support contents',base+index,base+index);
   await h.db.run("INSERT INTO safety_reports(id,reporter_id,subject_id,reason,status,created_at) VALUES(?,?,?,?,'open',?)",
    safety,subject.accountId,subject.accountId,'Synthetic private report '+index,base+index);
   await h.db.run("INSERT INTO privacy_requests(id,subject_id,requested_by,request_type,status,created_at,expires_at) VALUES(?,?,?,'export','pending_approval',?,?)",
    privacy,subject.accountId,subject.accountId,base+index,later);
  }
  await h.db.run("INSERT INTO assets(id,owner_id,source,status,object_key,content_type,byte_size,version,title,created_at) VALUES(?,?,'personal','failed',?,'image/jpeg',1024,?,'Read authority upload',?)",
   asset,subject.accountId,'private-authority-test-object',version,base);
  await h.db.run("INSERT INTO processing_attempts(id,asset_id,source_version,source_checksum_sha256,model_version,status,captured_at,expires_at,error_code) VALUES(?,?,?,?,'fixture','failed',?,?,'processing_failed')",
   attempt,asset,version,'a'.repeat(64),base,later);
  await h.db.run('INSERT INTO match_origins(id,asset_id,recipient_id,profile_id,profile_version,model_version,source_version,source_checksum_sha256,attempt_id,captured_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
   origin,asset,staff.accountId,crypto.randomUUID(),crypto.randomUUID(),'fixture',version,'a'.repeat(64),attempt,base,later);
  await h.db.run("INSERT INTO candidates(id,asset_id,owner_id,recipient_id,origin_id,status,version,created_at) VALUES(?,?,?,?,?,'needs_review',?,?)",
   match,asset,subject.accountId,staff.accountId,origin,crypto.randomUUID(),base);
  await h.db.run('UPDATE safety_reports SET candidate_id=? WHERE id=?',match,caseIds.safety[0]);
 });
 async function grants(deadlines){
  clock=base;
  await h.db.transaction(async()=>{
   await h.db.run('UPDATE operator_capability_grants SET revoked_at=?,revoked_by=? WHERE account_id=? AND revoked_at IS NULL',base,administrator.accountId,staff.accountId);
   for(const [capability,deadline] of Object.entries(deadlines))await h.db.run(
    'INSERT INTO operator_capability_grants(id,account_id,capability,granted_by,operation_key,created_at,expires_at) VALUES(?,?,?,?,?,?,?)',
    crypto.randomUUID(),staff.accountId,capability,administrator.accountId,crypto.randomUUID(),base-1,deadline);
  });
 }
 const audit=action=>(sql,bindings)=>sql.startsWith('INSERT INTO audit_events')&&bindings.includes(action);
 const page=table=>sql=>sql.includes('AS _page_priority')&&sql.includes('FROM '+table+' WHERE');
 const routes=[
  {name:'support queue',path:'/admin/support-requests',method:'all',hook:page('support_requests')},
  {name:'support detail',path:'/admin/support-requests/'+caseIds.support[0],method:'run',hook:audit('support.admin_read')},
  {name:'safety queue',path:'/admin/safety/reports',method:'all',hook:page('safety_reports')},
  {name:'match detail',path:'/admin/matches/'+match,method:'all',hook:sql=>sql.startsWith('SELECT * FROM safety_reports WHERE candidate_id=')},
  {name:'metrics',path:'/admin/metrics',method:'one',hook:sql=>sql.startsWith("SELECT count(*) n FROM safety_reports WHERE status IN('open'")},
  {name:'upload queue',path:'/admin/uploads',method:'all',hook:page('assets')},
  {name:'upload detail',path:'/admin/uploads/'+asset,method:'run',hook:audit('upload.admin_read')},
  {name:'user list',path:'/admin/users',method:'run',hook:audit('admin.users.list')},
  {name:'user detail',path:'/admin/users/'+subject.accountId,method:'run',hook:audit('admin.user.read')},
 ];
 await t.test('unexpired scoped reads retain their response shapes and case pagination',async()=>{
  await grants(Object.fromEntries(readScopes.map(scope=>[scope,later])));
  for(const route of routes)await h.json(route.path,{token:staff.token});
  const value=await h.json('/admin/users/'+subject.accountId,{token:staff.token});
  for(const section of ['support','safety','privacy']){assert.equal(value.cases[section].length,20);assert.equal(value.has_more[section],true);}
  assert.deepEqual(value.redacted_sections,['history']);assert.deepEqual(value.history,[]);
 });
 for(const route of routes)await t.test(route.name+' denies a grant that expires after its private read',async()=>{
  await grants(Object.fromEntries(readScopes.map(scope=>[scope,expires])));
  const original=h.db[route.method].bind(h.db);let fired=false;
  h.db[route.method]=async(sql,...bindings)=>{
   const value=await original(sql,...bindings);
   if(!fired&&route.hook(sql,bindings)){fired=true;clock=expires;}
   return value;
  };
  try{
   const value=await h.json(route.path,{token:staff.token},403);
   assert.equal(fired,true,'the actual protected query boundary was reached');
   assert.equal(value.error.code,'operator_capability_required');
   assert.deepEqual(Object.keys(value),['error']);
  }finally{h.db[route.method]=original;clock=base;}
 });
 await t.test('main scope expiry while the read transaction completes denies the result',async()=>{
  await grants({'users.read':expires});
  const transaction=h.db.transaction.bind(h.db);let fired=false;
  h.db.transaction=async(...args)=>{
   const value=await transaction(...args);
   if(!fired&&Array.isArray(value?.users)){fired=true;clock=expires;}
   return value;
  };
  try{
   const value=await h.json('/admin/users',{token:staff.token},403);
   assert.equal(fired,true);assert.equal(value.error.code,'operator_capability_required');
  }finally{h.db.transaction=transaction;clock=base;}
 });
 for(const section of ['support','safety','privacy'])await t.test(section+' cases and pagination are redacted if its scope expires after all cases load',async()=>{
  await grants(Object.fromEntries(readScopes.map(scope=>[scope,scope===section+'.read'?expires:later])));
  const run=h.db.run.bind(h.db);let fired=false;
  h.db.run=async(sql,...bindings)=>{
   const value=await run(sql,...bindings);
   if(!fired&&audit('admin.user.read')(sql,bindings)){fired=true;clock=expires;}
   return value;
  };
  try{
   const value=await h.json('/admin/users/'+subject.accountId,{token:staff.token});
   assert.equal(fired,true);assert.equal(value.user.id,subject.accountId);assert(value.sessions.length);
   assert.deepEqual(value.cases[section],[]);assert.equal(value.has_more[section],false);
   assert.deepEqual(new Set(value.redacted_sections),new Set([section,'history']));
   for(const other of ['support','safety','privacy'].filter(name=>name!==section)){
    assert.equal(value.cases[other].length,20);assert.equal(value.has_more[other],true);
   }
  }finally{h.db.run=run;clock=base;}
 });
 await t.test('secondary expiry during transaction completion still removes cases and pagination',async()=>{
  await grants(Object.fromEntries(readScopes.map(scope=>[scope,scope==='support.read'?expires:later])));
  const transaction=h.db.transaction.bind(h.db);let fired=false;
  h.db.transaction=async(...args)=>{
   const value=await transaction(...args);
   if(!fired&&value?.cases?.support?.length){fired=true;clock=expires;}
   return value;
  };
  try{
   const value=await h.json('/admin/users/'+subject.accountId,{token:staff.token});
   assert.equal(fired,true);assert.deepEqual(value.cases.support,[]);assert.equal(value.has_more.support,false);
   assert.deepEqual(new Set(value.redacted_sections),new Set(['support','history']));
   assert.equal(value.cases.safety.length,20);assert.equal(value.cases.privacy.length,20);
  }finally{h.db.transaction=transaction;clock=base;}
 });
 await t.test('ordinary owner support and block reads do not acquire an operator requirement',async()=>{
  await grants({});
  const list=await h.json('/support/requests',{token:subject.token});assert.equal(list.support_requests.length,21);
  const detail=await h.json('/support/requests/'+caseIds.support[0],{token:subject.token});assert.equal(detail.support_request.id,caseIds.support[0]);
  assert.deepEqual((await h.json('/me/blocks',{token:subject.token})).items,[]);
 });
});
