import assert from 'node:assert/strict';
import {test} from 'node:test';
import {captureProofs,enroll} from './runtime-harness.mjs';
import {matchingHarness,queueMatchingPhoto} from './photo-matching-fixture.mjs';
import {digest,stable} from '../src/types.ts';
import {drainJobs} from '../src/jobs.ts';
import {processPhotoJob} from '../src/processing.ts';

const id=()=>crypto.randomUUID();
async function fixture(t,count=0){
  const f=await matchingHarness(t,count);
  const person=await enroll(f.h);
  await f.h.db.run('UPDATE accounts SET roles_json=? WHERE id=?','["user","admin"]',person.accountId);
  const challenge=await f.h.json('/auth/face/challenge',{body:{face_handle:person.faceHandle,device_id:person.deviceId}},201);
  const credentials=await f.h.json('/auth/face/complete',{body:await captureProofs(f.h,challenge,person.keys.privateKey)});
  const now=Date.now();f.h.app.now=()=>now;
  return {...f,admin:{...person,token:credentials.access_token},now};
}
async function stop(f,message,state='failed'){
  const queued=await f.h.env.PHOTO_JOBS.send(message);
  await f.h.db.run("UPDATE job_queue SET state=?,attempts=20,error_code='fixture_dispatch_stopped',completed_at=?,lease_token=NULL,lease_until=NULL WHERE id=?",state,state==='completed'?f.now-1000:null,queued.id);
  return queued.id;
}
async function photo(f,state='failed'){
  const item=await queueMatchingPhoto(f.h,f.owner);
  return {...item,job:await stop(f,{category:'photo',payload:{attempt_id:item.attempt.id}},state)};
}
async function privacy(f,{kind='export',state='failed'}={}){
  const request=id(),outbox=id();
  await f.h.db.transaction(async()=>{
    await f.h.db.run(`INSERT INTO privacy_requests(id,subject_id,requested_by,request_type,status,created_at,expires_at,reviewed_by,reviewed_at)
      VALUES(?,?,?,?,'queued',?,?,?,?)`,request,f.owner.accountId,f.owner.accountId,kind,f.now-2000,f.now+900000,f.admin.accountId,f.now-1000);
    await f.h.db.run(`INSERT INTO outbox(id,account_id,category,entity_id,event_key,payload_json,created_at)
      VALUES(?,?,'privacy',?,?,?,?)`,outbox,f.owner.accountId,request,`privacy:${request}:approved`,stable({request_id:request}),f.now-1000);
  });
  return {request,outbox,job:await stop(f,{category:'privacy',payload:{request_id:request}},state)};
}
const path=job=>'/admin/queue-repairs/'+job;
async function preview(f,job){return (await f.h.json(path(job),{token:f.admin.token})).queue_repair;}
const body=value=>({operation_key:id(),expected_fingerprint:value.fingerprint,reason:'Resume the exact queued episode after reviewing its current evidence.'});
async function refused(f,job,code){
  const before=await f.h.db.one('SELECT * FROM job_queue WHERE id=?',job),value=await preview(f,job);
  assert.equal(value.eligible,false);assert.equal(value.blocked_reason,code);assert.equal(value.action,null);
  const result=await f.h.json(path(job),{token:f.admin.token,body:body(value)},409);
  assert.equal(result.error.code,'queue_repair_blocked');
  assert.deepEqual(await f.h.db.one('SELECT * FROM job_queue WHERE id=?',job),before);
}

test('a fresh administrator can repair exact stopped photo and privacy jobs without resetting domain or history',async t=>{
  const f=await fixture(t),p=await photo(f,'completed'),r=await privacy(f);
  for(const entry of [p,r]){
    const value=await preview(f,entry.job),input=body(value);
    assert.deepEqual(Object.keys(value).sort(),['action','attempts','blocked_reason','category','domain_id','domain_status','eligible','error_code','fingerprint','job_id','queue_state'].sort());
    assert.equal(value.eligible,true);assert.equal(value.action,'resume_exact_work');assert.equal(value.domain_status,'queued');
    assert.equal(value.attempts,20);assert.equal(value.error_code,'fixture_dispatch_stopped');
    const table=entry.request?'privacy_requests':'processing_attempts',domain=entry.request??entry.attempt.id;
    const before=await f.h.db.one(`SELECT * FROM ${table} WHERE id=?`,domain);
    const result=await f.h.json(path(entry.job),{token:f.admin.token,body:input});
    assert.equal(result.queue_repair.status,'admitted');assert.equal(result.queue_repair.domain_id,domain);
    assert.deepEqual(await f.h.db.one(`SELECT * FROM ${table} WHERE id=?`,domain),before,'repair never changes domain authority or output');
    assert.deepEqual(await f.h.db.one('SELECT state,attempts,error_code,completed_at,available_at,lease_token,lease_until FROM job_queue WHERE id=?',entry.job),{
      state:'pending',attempts:20,error_code:'fixture_dispatch_stopped',completed_at:null,available_at:f.now,lease_token:null,lease_until:null});
    const audits=await f.h.db.all("SELECT actor_id,subject_id,details_json FROM audit_events WHERE action='admin.queue.repair' AND entity_id=?",entry.job);
    assert.equal(audits.length,1);assert.equal(audits[0].actor_id,f.admin.accountId);assert.equal(audits[0].subject_id,f.owner.accountId);
    const audit=JSON.parse(audits[0].details_json);
    assert.equal(audit.previous_state,value.queue_state);assert.equal(audit.previous_attempts,20);assert.equal(audit.previous_error_code,'fixture_dispatch_stopped');assert.equal(audit.fingerprint,value.fingerprint);
    assert.deepEqual((await f.h.db.all("SELECT subject_id FROM operation_subjects WHERE actor_id=? AND source='queue_repair' AND operation_key=? ORDER BY subject_id",f.admin.accountId,input.operation_key)).map(row=>row.subject_id),
      [f.admin.accountId,f.owner.accountId].sort(),'repair reason and receipt participate in both accounts\' export/erasure lineage');
    assert.deepEqual(await f.h.json(path(entry.job),{token:f.admin.token,body:input}),result,'exact retry returns its historical admission');
    assert.equal((await f.h.db.one("SELECT count(*) n FROM audit_events WHERE action='admin.queue.repair' AND entity_id=?",entry.job)).n,1);
    const changed=await f.h.json(path(entry.job),{token:f.admin.token,body:{...input,reason:'A different request under the same key'}},409);
    assert.equal(changed.error.code,'operation_key_conflict');
  }
  assert.deepEqual(await f.h.db.one('SELECT status,dispatched_at FROM photo_job_outbox WHERE attempt_id=?',p.attempt.id),{status:'dispatched',dispatched_at:f.now});
  assert.equal((await f.h.db.one('SELECT delivered_at FROM outbox WHERE id=?',r.outbox)).delivered_at,f.now);
  assert.equal(f.calls.length,0,'review and admission do not call the processor');
  assert.deepEqual(await drainJobs(f.h.app,2),{processed:2,failed:0},'the admitted exact jobs complete through normal workers');
  assert.equal((await f.h.db.one('SELECT status FROM processing_attempts WHERE id=?',p.attempt.id)).status,'completed');
  assert.equal((await f.h.db.one('SELECT status FROM privacy_requests WHERE id=?',r.request)).status,'completed');
  assert.equal((await f.h.db.one('SELECT count(*) n FROM job_queue WHERE id IN(?,?) AND attempts=21 AND state=\'completed\'',p.job,r.job)).n,2);
});

test('queue repair denies missing, anonymous, nonadmin, stale face and revoked admin authority before mutation',async t=>{
  const f=await fixture(t),r=await privacy(f),value=await preview(f,r.job),input=body(value);
  await f.h.json(path(r.job),{},401);
  await f.h.json(path(r.job),{body:input},401);
  await f.h.json(path(r.job),{token:f.owner.token},403);
  await f.h.json(path(r.job),{token:f.owner.token,body:input},403);
  const guest=await f.h.anonymous();
  await f.h.json(path(r.job),{token:guest.access_token},403);
  f.h.app.now=()=>f.now+300001;
  assert.equal((await f.h.json(path(r.job),{token:f.admin.token,body:input},403)).error.code,'fresh_face_authentication_required');
  assert.equal((await preview(f,r.job)).eligible,true,'read-only evidence does not require a new face capture');
  f.h.app.now=()=>f.now;
  await f.h.db.run('UPDATE accounts SET roles_json=? WHERE id=?','["user"]',f.admin.accountId);
  await f.h.json(path(r.job),{token:f.admin.token,body:input},401);
  assert.equal((await f.h.db.one('SELECT state FROM job_queue WHERE id=?',r.job)).state,'failed');
  assert.equal((await f.h.db.one("SELECT count(*) n FROM audit_events WHERE action='admin.queue.repair'")).n,0);
});

test('queue repair previews are exact, current and bounded; changed queue or domain evidence cannot be applied',async t=>{
  const f=await fixture(t),r=await privacy(f),first=await preview(f,r.job);
  assert.equal((await preview(f,r.job)).fingerprint,first.fingerprint);
  await f.h.db.run('UPDATE job_queue SET attempts=21 WHERE id=?',r.job);
  assert.equal((await f.h.json(path(r.job),{token:f.admin.token,body:body(first)},409)).error.code,'queue_repair_snapshot_changed');
  const second=await preview(f,r.job);
  await f.h.db.run('UPDATE privacy_requests SET reviewed_at=reviewed_at+1 WHERE id=?',r.request);
  assert.equal((await f.h.json(path(r.job),{token:f.admin.token,body:body(second)},409)).error.code,'queue_repair_snapshot_changed');
  const third=await preview(f,r.job);
  for(const input of [{...body(third),extra:true},{...body(third),reason:'\n'}, {...body(third),expected_fingerprint:'bad'}, {...body(third),reason:'x'.repeat(1001)}])
    await f.h.json(path(r.job),{token:f.admin.token,body:input},400);
  await f.h.json(path(r.job)+'?ignored=1',{token:f.admin.token},400);
  await f.h.json(path(r.job),{token:f.admin.token,method:'DELETE'},405);
  await f.h.json(path('a'.repeat(64)),{token:f.admin.token},404);
  await f.h.db.run('UPDATE job_queue SET payload_json=? WHERE id=?',stable({request_id:id()}),r.job);
  await refused(f,r.job,'queue_binding_invalid');
  assert.equal((await f.h.db.one("SELECT count(*) n FROM audit_events WHERE action='admin.queue.repair'")).n,0);
});

test('terminal or leased domains and any durable external-work evidence keep privacy repair blocked',async t=>{
  const f=await fixture(t),r=await privacy(f),run=async(sql,args,undo,undoArgs,code)=>{
    await f.h.db.run(sql,...args);try{await refused(f,r.job,code);}finally{await f.h.db.run(undo,...undoArgs);}
  };
  for(const state of ['pending','processing'])await run('UPDATE job_queue SET state=? WHERE id=?',[state,r.job],"UPDATE job_queue SET state='failed' WHERE id=?",[r.job],'queue_not_terminal_unleased');
  await run('UPDATE job_queue SET lease_token=?,lease_until=? WHERE id=?',[id(),f.now-1,r.job],'UPDATE job_queue SET lease_token=NULL,lease_until=NULL WHERE id=?',[r.job],'queue_not_terminal_unleased');
  for(const state of ['failed','completed','processing','rejected'])await run('UPDATE privacy_requests SET status=? WHERE id=?',[state,r.request],"UPDATE privacy_requests SET status='queued' WHERE id=?",[r.request],'queue_privacy_not_pristine');
  for(const [column,value] of [['execution_token',id()],['metadata_erased_at',f.now],['failure_code','previous_attempt'],['export_key','private/fixture'],['legal_hold',1]])
    await run(`UPDATE privacy_requests SET ${column}=? WHERE id=?`,[value,r.request],`UPDATE privacy_requests SET ${column}=? WHERE id=?`,[column==='legal_hold'?0:null,r.request],'queue_privacy_not_pristine');
  await run('UPDATE privacy_requests SET reviewed_by=? WHERE id=?',[f.owner.accountId,r.request],'UPDATE privacy_requests SET reviewed_by=? WHERE id=?',[f.admin.accountId,r.request],'queue_privacy_authority_changed');
  await run('UPDATE outbox SET cancelled_at=? WHERE id=?',[f.now,r.outbox],'UPDATE outbox SET cancelled_at=NULL WHERE id=?',[r.outbox],'queue_outbox_changed');
  const writer=id();
  await run("INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at) VALUES(?,?,'PRIVACY_EXPORTS',?,'pending',?)",[writer,f.owner.accountId,'synthetic/'+writer,f.now],'DELETE FROM media_write_intents WHERE id=?',[writer],'queue_external_work_unresolved');
  const cleanup=id();
  await run("INSERT INTO cleanup_intents(id,request_id,subject_id,bucket,object_key,status,created_at) VALUES(?,?,?,'PRIVACY_EXPORTS',?,'verified',?)",[cleanup,r.request,f.owner.accountId,'synthetic/'+cleanup,f.now],'DELETE FROM cleanup_intents WHERE id=?',[cleanup],'queue_external_work_unresolved');
  const snapshot=id();
  // Complete export-v3 snapshot custody is subordinate to an exact publication;
  // both its immutable snapshot and publication are external-work evidence.
  await f.h.db.run("INSERT INTO privacy_exports(id,request_id,subject_id,object_key,sha256,bytes,expires_at,status,created_at) VALUES(?,?,?,?,?,1,?,'pending',?)",snapshot,r.request,f.owner.accountId,'synthetic/'+snapshot,'0'.repeat(64),f.now+10000,f.now);
  try{await run("INSERT INTO privacy_export_snapshots(id,request_id,subject_id,status,generated_at,expires_at,hash_state_json,chain_sha256) VALUES(?,?,?,'building',?,?,'{}',?)",[snapshot,r.request,f.owner.accountId,f.now,f.now+10000,'0'.repeat(64)],'DELETE FROM privacy_export_snapshots WHERE id=?',[snapshot],'queue_external_work_unresolved');}
  finally{await f.h.db.run('DELETE FROM privacy_exports WHERE id=?',snapshot);}
  const exp=id();
  await run("INSERT INTO privacy_exports(id,request_id,subject_id,object_key,sha256,bytes,expires_at,status,created_at) VALUES(?,?,?,?,?,1,?,'retired',?)",[exp,r.request,f.owner.accountId,'synthetic/'+exp,'a'.repeat(64),f.now+10000,f.now],'DELETE FROM privacy_exports WHERE id=?',[exp],'queue_external_work_unresolved');
  assert.equal((await preview(f,r.job)).eligible,true);
});

test('deletion repair includes current complete holds and notifications require independent no-dispatch proof',async t=>{
  const f=await fixture(t),r=await privacy(f,{kind:'delete'}),value=await preview(f,r.job);
  assert.equal(value.eligible,true);
  const hold=id();
  await f.h.db.run("INSERT INTO moderation_holds(id,subject_id,active,created_at,reason) VALUES(?,?,1,?,'fixture hold')",hold,f.owner.accountId,f.now);
  await refused(f,r.job,'privacy_legal_hold');
  assert.equal((await f.h.json(path(r.job),{token:f.admin.token,body:body(value)},409)).error.code,'queue_repair_snapshot_changed');
  await f.h.db.run('UPDATE moderation_holds SET active=0,cleared_at=? WHERE id=?',f.now,hold);
  assert.equal((await preview(f,r.job)).eligible,true);
  const note=id();
  await f.h.db.run("INSERT INTO notifications(id,account_id,kind,entity_id,title,created_at) VALUES(?,?,'support',?,'Synthetic support',?)",note,f.owner.accountId,id(),f.now);
  await f.h.db.run("INSERT INTO notification_jobs(notification_id,account_id,auth_epoch,status,created_at) SELECT ?,id,auth_epoch,'queued',? FROM accounts WHERE id=?",note,f.now,f.owner.accountId);
  const job=await stop(f,{category:'notification',payload:{notification_id:note}});
  await refused(f,job,'queue_notification_independent_proof_required');
  assert.equal((await f.h.db.one("SELECT count(*) n FROM audit_events WHERE action='admin.queue.repair'")).n,0);
});

test('photo repair refuses source changes, revoked owner authority, output, writers and competing episodes',async t=>{
  const f=await fixture(t),p=await photo(f),run=async(sql,args,undo,undoArgs,code)=>{
    await f.h.db.run(sql,...args);try{await refused(f,p.job,code);}finally{await f.h.db.run(undo,...undoArgs);}
  };
  for(const state of ['running','failed','completed'])await run('UPDATE processing_attempts SET status=? WHERE id=?',[state,p.attempt.id],"UPDATE processing_attempts SET status='queued' WHERE id=?",[p.attempt.id],'queue_photo_not_resumable');
  await run('UPDATE assets SET version=? WHERE id=?',[id(),p.asset_id],'UPDATE assets SET version=? WHERE id=?',[p.attempt.source_version,p.asset_id],'queue_photo_source_changed');
  await run('UPDATE sessions SET revoked_at=? WHERE id=?',[f.now,p.attempt.owner_session_id],'UPDATE sessions SET revoked_at=NULL WHERE id=?',[p.attempt.owner_session_id],'session_revoked');
  await run('UPDATE processing_attempts SET rendition_key=? WHERE id=?',['synthetic/ambiguous-write',p.attempt.id],'UPDATE processing_attempts SET rendition_key=NULL WHERE id=?',[p.attempt.id],'queue_photo_not_resumable');
  await run('UPDATE processing_attempts SET lease_token=? WHERE id=?',[id(),p.attempt.id],'UPDATE processing_attempts SET lease_token=NULL WHERE id=?',[p.attempt.id],'queue_photo_not_resumable');
  const writer=id();
  await run("INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at) VALUES(?,?,'PHOTOS',?,'pending',?)",[writer,f.owner.accountId,'synthetic/'+writer,f.now],'DELETE FROM media_write_intents WHERE id=?',[writer],'queue_external_work_unresolved');
  const rival=id();
  await run("INSERT INTO processing_attempts(id,asset_id,source_version,source_checksum_sha256,model_version,status,captured_at,expires_at) VALUES(?,?,?,?,?,'queued',?,?)",[rival,p.asset_id,p.attempt.source_version,p.attempt.source_checksum_sha256,p.attempt.model_version,f.now,f.now+10000],'DELETE FROM processing_attempts WHERE id=?',[rival],'queue_photo_publication_or_competitor');
  const rendition=id();
  await run("INSERT INTO renditions(id,asset_id,object_key,content_type,byte_size,checksum_sha256,source_checksum_sha256,version,status,source_version) VALUES(?,?,?,'image/png',1,?,?,?,'retired',?)",[rendition,p.asset_id,'synthetic/'+rendition,'a'.repeat(64),p.attempt.source_checksum_sha256,id(),p.attempt.source_version],'DELETE FROM renditions WHERE id=?',[rendition],'queue_photo_publication_or_competitor');
  assert.equal((await preview(f,p.job)).eligible,true);assert.equal(f.calls.length,0);
});

test('repair resumes a sealed later photo page without repeating earlier inference or resetting its failure budget',async t=>{
  const f=await fixture(t,129),p=await photo(f);
  assert.deepEqual(await processPhotoJob({attempt_id:p.attempt.id},f.h.app),{pending:true});
  const before=await f.h.db.one('SELECT * FROM processing_match_progress WHERE attempt_id=?',p.attempt.id);
  assert.equal(before.next_ordinal,128);assert.equal(f.calls.length,1);
  const value=await preview(f,p.job);assert.equal(value.eligible,true);
  const input=body(value),result=await f.h.json(path(p.job),{token:f.admin.token,body:input});
  assert.deepEqual(await f.h.db.one('SELECT * FROM processing_match_progress WHERE attempt_id=?',p.attempt.id),before);
  assert.deepEqual(await drainJobs(f.h.app,1),{processed:1,failed:0});
  assert.equal(f.calls.length,2);assert.equal(f.calls[0].profiles.length,128);assert.equal(f.calls[1].profiles.length,1);
  assert.equal(new Set(f.calls.flatMap(call=>call.profiles.map(p=>p.account_id))).size,129);
  assert.deepEqual(await f.h.json(path(p.job),{token:f.admin.token,body:input}),result);
  assert.deepEqual(await f.h.db.one('SELECT state,attempts FROM job_queue WHERE id=?',p.job),{state:'completed',attempts:21});
  await refused(f,p.job,'queue_photo_not_resumable');
  assert.equal(await digest(stable({category:'photo',payload:{attempt_id:p.attempt.id}})),p.job);
});

test('a face review deadline expiring after the callback rolls back the receipt, queue admission and outbox handoff',async t=>{
  const f=await fixture(t),r=await privacy(f),value=await preview(f,r.job),original=f.h.db.run.bind(f.h.db);
  let changed=false;
  f.h.db.run=async(sql,...bindings)=>{
    const result=await original(sql,...bindings);
    if(!changed&&sql.startsWith('INSERT INTO operations(')&&bindings[1]==='queue_repair'){
      changed=true;f.h.app.now=()=>f.now+300001;
    }
    return result;
  };
  const result=await f.h.json(path(r.job),{token:f.admin.token,body:body(value)},403);
  assert.equal(result.error.code,'fresh_face_authentication_required');assert.equal(changed,true);
  f.h.db.run=original;f.h.app.now=()=>f.now;
  assert.equal((await f.h.db.one('SELECT state FROM job_queue WHERE id=?',r.job)).state,'failed');
  assert.equal((await f.h.db.one('SELECT delivered_at FROM outbox WHERE id=?',r.outbox)).delivered_at,null);
  assert.equal((await f.h.db.one("SELECT count(*) n FROM operations WHERE source='queue_repair'")).n,0);
  assert.equal((await f.h.db.one("SELECT count(*) n FROM audit_events WHERE action='admin.queue.repair'")).n,0);
});

test('the recovery inbox pages all stopped domain mismatches without provider calls or raw payload disclosure',async t=>{
  const f=await fixture(t),jobs=[],domainIDs=[];
  await f.h.db.transaction(async()=>{
    for(let index=0;index<152;index++){
      const note=id(),job=await digest(stable({category:'notification',payload:{notification_id:note}}));
      domainIDs.push(note);if(index<151)jobs.push(job);
      await f.h.db.run("INSERT INTO notifications(id,account_id,kind,entity_id,title,created_at) VALUES(?,?,'support',?,'Synthetic private title',?)",note,f.owner.accountId,id(),f.now-2000+index);
      await f.h.db.run('INSERT INTO notification_jobs(notification_id,account_id,auth_epoch,status,created_at) VALUES(?,?,1,?,?)',note,f.owner.accountId,index===151?'accepted':'queued',f.now-2000+index);
      await f.h.db.run('INSERT INTO job_queue(id,category,payload_json,state,attempts,error_code,available_at,created_at) VALUES(?,?,?,?,20,?,?,?)',job,'notification',stable({notification_id:note}),index===151||index===0?'completed':'failed',index===0?'old_%_case':'fixture_stopped',f.now,f.now-2000+(index>>1));
    }
    await f.h.db.run("INSERT INTO job_queue(id,category,payload_json,state,available_at,created_at) VALUES(?,'notification',?,'failed',?,?)",'b'.repeat(64),stable('malformed private payload'),f.now,f.now-3000);
  });
  let calls=0;f.h.env.PUSH_SERVICE={fetch:async()=>{calls++;throw Error('collection must not contact provider');}};
  const found=[],params={limit:'37'};let cursor;
  do{
    const page=await f.h.json('/admin/queue-repairs?'+new URLSearchParams({...params,...(cursor?{cursor}:{})}),{token:f.admin.token});
    assert.equal(page.page.total,152);assert(page.queue_repairs.length<=37);
    for(const row of page.queue_repairs){assert.equal(row.id,row.job_id);assert.match(row.id,/^[0-9a-f]{64}$/);assert(!Object.hasOwn(row,'payload_json'));assert(!Object.hasOwn(row,'eligible'));}
    found.push(...page.queue_repairs);cursor=page.page.next_cursor;
    if(cursor)assert.equal(page.page.has_more,true);
  }while(cursor);
  assert.equal(found.length,152);assert.equal(new Set(found.map(row=>row.id)).size,152);
  assert.deepEqual(new Set(found.map(row=>row.id)),new Set([...jobs,'b'.repeat(64)]));
  const corrupt=found.find(row=>row.id==='b'.repeat(64));assert.equal(corrupt.domain_id,null);assert.equal(corrupt.domain_status,null);
  const all=await f.h.json('/admin/queue-repairs?status=all&limit=100',{token:f.admin.token});assert.equal(all.page.total,153);
  const completed=await f.h.json('/admin/queue-repairs?status=completed',{token:f.admin.token});assert.equal(completed.page.total,2);
  const exact=await f.h.json('/admin/queue-repairs?q='+domainIDs[0],{token:f.admin.token});assert.deepEqual(exact.queue_repairs.map(row=>row.job_id),[jobs[0]]);
  const literal=await f.h.json('/admin/queue-repairs?q=%25_',{token:f.admin.token});assert.deepEqual(literal.queue_repairs.map(row=>row.job_id),[jobs[0]]);
  await f.h.json('/admin/queue-repairs?limit=37&status=all&cursor='+encodeURIComponent(all.page.next_cursor),{token:f.admin.token},400);
  for(const query of ['limit=101','status=processing','cursor=bad','q=x&q=y','private=1'])await f.h.json('/admin/queue-repairs?'+query,{token:f.admin.token},400);
  await f.h.json('/admin/queue-repairs',{token:f.owner.token},403);await f.h.json('/admin/queue-repairs',{},401);
  assert.equal(calls,0);
});
