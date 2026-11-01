import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startHarness, enroll, captureProofs, faceVerifierFixture } from './runtime-harness.mjs';
import { digest, stable } from '../src/types.ts';

// One database per file keeps the PostgreSQL-WASM memory envelope bounded.
test('operator queues, case history and upload diagnostics use actual authorized database routes', async t => {
  const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});
  try {
    const person=await enroll(h),adminPerson=await enroll(h);
    await h.storage.exec('UPDATE accounts SET roles_json=? WHERE id=?','["user","admin"]',adminPerson.accountId);
    const challenge=await h.json('/auth/face/challenge',{body:{face_handle:adminPerson.faceHandle,device_id:adminPerson.deviceId}},201);
    const credentials=await h.json('/auth/face/complete',{body:await captureProofs(h,challenge,adminPerson.keys.privateKey)});
    const token=credentials.access_token;
    const ids=Array.from({length:105},()=>crypto.randomUUID()),createdAt=1000;
    for(const [i,id] of ids.entries())await h.storage.exec(
      'INSERT INTO support_requests(id,account_id,subject,details,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
      id,person.accountId,'queuefixture '+i,'Synthetic request details',i===104?'open':'closed',createdAt,createdAt);

    let first;
    await t.test('pending support survives 100 older terminal records and every row is reachable',async()=>{
      first=await h.json('/admin/support-requests?limit=25&q=queuefixture',{token});
      assert.equal(first.page.total,105);assert.equal(first.support_requests[0].id,ids[104]);
      const seen=first.support_requests.map(x=>x.id);let next=first.page.next_cursor;
      while(next){const page=await h.json('/admin/support-requests?limit=25&q=queuefixture&cursor='+next,{token});seen.push(...page.support_requests.map(x=>x.id));next=page.page.next_cursor;}
      assert.equal(seen.length,105);assert.equal(new Set(seen).size,105);assert.deepEqual(new Set(seen),new Set(ids));
    });
    await t.test('query binding rejects reuse and invalid inputs before database interpolation',async()=>{
      for(const query of ['limit=0','limit=101','status=invented','q=a&q=b','cursor=bad','unknown=x'])await h.json('/admin/support-requests?'+query,{token},400);
      await h.json('/admin/support-requests?limit=25&q=different&cursor='+first.page.next_cursor,{token},400);
      await h.json('/admin/uploads?limit=25&q=queuefixture&cursor='+first.page.next_cursor,{token},400);
      assert.equal((await h.json('/admin/support-requests?limit=25&q=queuefixture&status=open',{token})).page.total,1);
    });
    await t.test('search is literal and complete rather than filtering a loaded page',async()=>{
      const id=crypto.randomUUID();await h.storage.exec('INSERT INTO support_requests(id,account_id,subject,details,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',id,person.accountId,'Literal %_\\ marker','Synthetic details','open',2,2);
      const page=await h.json('/admin/support-requests?q=%25_', {token});assert.deepEqual(page.support_requests.map(x=>x.id),[id]);
      assert.equal((await h.json('/admin/support-requests?q=queuefixture%20104',{token})).support_requests[0].id,ids[104]);
    });
    await t.test('own history pages are account scoped; operator routes deny ordinary users',async()=>{
      await h.storage.exec('INSERT INTO support_requests(id,account_id,subject,details,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',crypto.randomUUID(),adminPerson.accountId,'other-account','Synthetic details','open',1,1);
      const own=await h.json('/support/requests?limit=100&q=queuefixture',{token:person.token});assert.equal(own.page.total,105);assert.equal(own.support_requests.length,100);
      const rest=await h.json('/support/requests?limit=100&q=queuefixture&cursor='+own.page.next_cursor,{token:person.token});assert.equal(rest.support_requests.length,5);
      for(const path of ['/admin/support-requests','/admin/support-requests/'+ids[0],'/admin/uploads','/admin/uploads/'+crypto.randomUUID(),'/admin/safety/reports'])await h.json(path,{token:person.token},403);
      await h.json('/admin/support-requests/'+crypto.randomUUID(),{token},404);
      await h.json('/admin/support-requests/not-an-endpoint',{token},404);
    });

    let caseId,historyKey;
    await t.test('support history retains successive rationale, actor and revisions after current notes change',async()=>{
      const created=await h.json('/support/requests',{token:person.token,body:{subject:'History fixture',details:'Synthetic history detail',operation_key:crypto.randomUUID()}},201);caseId=created.id;
      historyKey=crypto.randomUUID();
      await h.json(`/admin/support-requests/${caseId}/start`,{token,body:{expected_revision:1,review_notes:'Initial investigation',operation_key:historyKey}});
      await h.json(`/admin/support-requests/${caseId}/approve`,{token,body:{expected_revision:2,review_notes:'Final explanation',operation_key:crypto.randomUUID()}});
      const value=await h.json(`/admin/support-requests/${caseId}?limit=2`,{token});assert.equal(value.support_request.review_notes,'Final explanation');assert.equal(value.page.total,3);
      const second=await h.json(`/admin/support-requests/${caseId}?limit=2&cursor=${value.page.next_cursor}`,{token});
      const history=[...value.history,...second.history];assert.deepEqual(history.map(x=>x.revision),[1,2,3]);
      assert.deepEqual(history.map(x=>x.review_notes),[null,'Initial investigation','Final explanation']);assert.equal(history[1].actor_id,adminPerson.accountId);
      assert.equal(value.history_scope,'retained_verified_operations');
      const wire=JSON.stringify(value);for(const name of ['payload_json','response_json','access_token','payload_hash'])assert(!wire.includes(name));
    });
    await t.test('corrupted support receipt fails closed instead of inventing a decision',async()=>{
      await h.storage.exec('UPDATE operations SET payload_hash=? WHERE actor_id=? AND operation_key=?','0'.repeat(64),adminPerson.accountId,historyKey);
      const value=await h.json(`/admin/support-requests/${caseId}`,{token},503);assert.equal(value.error.code,'support_history_unavailable');
    });

    const asset=crypto.randomUUID(),attempt=crypto.randomUUID(),version=crypto.randomUUID();
    await h.storage.exec("INSERT INTO assets(id,owner_id,source,status,object_key,content_type,byte_size,version,title,created_at) VALUES(?,?,'personal','failed',?,'image/jpeg',1024,?,'Upload fixture',1000)",asset,person.accountId,'private-object-do-not-return',version);
    await h.storage.exec("INSERT INTO processing_attempts(id,asset_id,source_version,source_checksum_sha256,model_version,status,captured_at,expires_at,error_code,lease_token,lease_until,rendition_key,processor_nonce) VALUES(?,?,?,?,'fixture-v1','failed',1000,2000,'inference_unavailable','private-lease',1500,'private-rendition','private-nonce')",attempt,asset,version,'a'.repeat(64));
    await h.storage.exec("INSERT INTO photo_job_outbox(id,attempt_id,asset_id,status,created_at,dispatched_at) VALUES(?,?,?,'dispatched',1000,1100)",crypto.randomUUID(),attempt,asset);
    const jobId=await digest(stable({category:'photo',payload:{attempt_id:attempt}}));
    await h.storage.exec("INSERT INTO job_queue(id,category,payload_json,state,available_at,created_at,attempts,error_code,lease_token) VALUES(?,'photo',?,'failed',2000,1000,20,'inference_unavailable','private-job-lease')",jobId,stable({attempt_id:attempt}));
    await t.test('upload detail explains attempts and exhausted queue without media or credentials',async()=>{
      const value=await h.json('/admin/uploads/'+asset,{token});assert.equal(value.upload.id,asset);assert.equal(value.attempts[0].job.attempts,20);assert.equal(value.attempts[0].job.state,'failed');
      assert.equal(value.attempts[0].outbox.status,'dispatched');assert.equal(value.diagnostics.private_media_included,false);assert.equal(value.diagnostics.retry_available,false);
      const wire=JSON.stringify(value);for(const text of ['private-object-do-not-return','private-lease','private-rendition','private-nonce','private-job-lease','payload_json','profiles_json'])assert(!wire.includes(text),text);
      const filtered=await h.json('/admin/uploads?status=failed&q=Upload',{token});assert.equal(filtered.page.total,1);assert.equal(filtered.uploads[0].id,asset);
    });
    await t.test('safety reports paginate independently from matching proposals',async()=>{
      const reports=Array.from({length:103},()=>crypto.randomUUID());
      for(const [i,id] of reports.entries())await h.storage.exec("INSERT INTO safety_reports(id,reporter_id,reason,status,created_at) VALUES(?,?,?,?,1000)",id,person.accountId,'Safety fixture',i===102?'open':'resolved');
      const page=await h.json('/admin/safety/reports?limit=100&collection=reports',{token});assert.equal(page.reports[0].id,reports[102]);assert.equal(page.page.total,103);assert.deepEqual(page.matches,[]);
      const next=await h.json('/admin/safety/reports?limit=100&collection=reports&cursor='+page.page.next_cursor,{token});assert.equal(next.reports.length,3);
      await h.json('/admin/safety/reports?limit=100&collection=matches&cursor='+page.page.next_cursor,{token},400);
      const matches=await h.json('/admin/safety/reports?collection=matches',{token});assert.deepEqual(matches.reports,[]);assert.equal(matches.collection,'matches');
    });
    await t.test('guardian pending work is visible ahead of 100 older approvals and all requests remain reachable',async()=>{
      const requests=Array.from({length:102},()=>crypto.randomUUID()),expiry=Date.now()+600000;
      for(const [i,id] of requests.entries())await h.storage.exec("INSERT INTO guardian_requests(id,child_account_id,guardian_account_id,state,child_audience_version,policy_version,created_at,expires_at,revision) VALUES(?,?,?,?,1,'audience-2026-10-24-v1',?,?,1)",id,person.accountId,adminPerson.accountId,i===101?'under_review':'approved',1000+i,expiry);
      const page=await h.json('/admin/guardian-requests?limit=100',{token});assert.equal(page.guardian_requests[0].id,requests[101]);assert.equal(page.page.total,102);assert.equal(page.guardian_requests.length,100);
      const next=await h.json('/admin/guardian-requests?limit=100&cursor='+page.page.next_cursor,{token});assert.equal(next.guardian_requests.length,2);
      assert.equal(new Set([...page.guardian_requests,...next.guardian_requests].map(x=>x.id)).size,102);
      const pending=await h.json('/admin/guardian-requests?status=under_review',{token});assert.deepEqual(pending.guardian_requests.map(x=>x.id),[requests[101]]);
      await h.json('/admin/guardian-requests?limit=100&status=approved&cursor='+page.page.next_cursor,{token},400);
    });
    await t.test('privacy pending approval precedes old completed records without exporting capabilities',async()=>{
      const requests=Array.from({length:102},()=>crypto.randomUUID()),expiry=Date.now()+600000;
      for(const [i,id] of requests.entries())await h.storage.exec("INSERT INTO privacy_requests(id,subject_id,requested_by,request_type,status,created_at,expires_at,export_key,execution_token) VALUES(?,?,?,'export',?,?,?,?,?)",id,person.accountId,person.accountId,i===101?'pending_approval':'completed',1000+i,expiry,'private-export-key','private-execution-token');
      const page=await h.json('/admin/privacy-requests?limit=100',{token});assert.equal(page.privacy_requests[0].id,requests[101]);assert.equal(page.page.total,102);
      const next=await h.json('/admin/privacy-requests?limit=100&cursor='+page.page.next_cursor,{token});assert.equal(next.privacy_requests.length,2);
      assert.equal(new Set([...page.privacy_requests,...next.privacy_requests].map(x=>x.id)).size,102);
      assert(!JSON.stringify(page).includes('private-export-key'));assert(!JSON.stringify(page).includes('private-execution-token'));
      assert.equal((await h.json('/admin/privacy-requests?status=pending_approval',{token})).page.total,1);
    });
  } finally { await h.close(); }
});
