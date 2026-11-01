import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startHarness} from './runtime-harness.mjs';
import {PostgresJobQueue} from '../src/jobs.ts';
import {requireQueueAdmission} from '../src/queue-admission.ts';
import {flushPhotoOutbox} from '../src/processing.ts';
import {flushPrivacyCleanup} from '../src/privacy.ts';

const id=()=>crypto.randomUUID();
async function fixture(t){
  const h=await startHarness({consumeQueue:false});t.after(()=>h.close());
  const account=id();let now=1700000000000;
  await h.db.run('INSERT INTO accounts(id,created_at) VALUES(?,?)',account,now);
  h.app.now=()=>now;h.env.PHOTO_JOBS=new PostgresJobQueue(h.db,()=>now);
  return {h,account,now:()=>now,advance:()=>{now+=60001;}};
}
async function photo(f,index=0,status='queued'){
  const asset=id(),attempt=id(),outbox=id(),created=f.now()+index;
  await f.h.db.transaction(async()=>{
    await f.h.db.run("INSERT INTO assets(id,owner_id,source,status,object_key,content_type,byte_size,version,created_at) VALUES(?,?,'personal','processing',?,'image/png',1,'v1',?)",asset,f.account,'synthetic/'+asset,created);
    await f.h.db.run("INSERT INTO processing_attempts(id,asset_id,source_version,source_checksum_sha256,model_version,status,captured_at,expires_at,owner_id,profiles_json) VALUES(?,?,'v1',?,'fixture',?,?,?,?, '[]')",attempt,asset,'a'.repeat(64),status,created,created+900000,f.account);
    await f.h.db.run("INSERT INTO photo_job_outbox(id,attempt_id,asset_id,status,created_at) VALUES(?,?,?,'pending',?)",outbox,attempt,asset,created);
  });
  return {outbox,attempt,message:{category:'photo',payload:{attempt_id:attempt}}};
}
async function privacy(f,index=0,status='queued'){
  const request=id(),outbox=id(),created=f.now()+index;
  await f.h.db.transaction(async()=>{
    await f.h.db.run("INSERT INTO privacy_requests(id,subject_id,requested_by,request_type,status,created_at,expires_at) VALUES(?,?,?,'export',?,?,?)",request,f.account,f.account,status,created,created+900000);
    await f.h.db.run("INSERT INTO outbox(id,account_id,category,entity_id,event_key,payload_json,created_at) VALUES(?,?,'privacy',?,?,?,?)",outbox,f.account,request,id(),JSON.stringify({request_id:request}),created);
  });
  return {request,outbox,message:{category:'privacy',payload:{request_id:request}}};
}
async function stopped(f,message,state='failed'){
  const receipt=await f.h.env.PHOTO_JOBS.send(message);
  await f.h.db.run("UPDATE job_queue SET state=?,attempts=20,error_code='synthetic_stop',completed_at=? WHERE id=?",state,state==='completed'?f.now():null,receipt.id);
  return receipt.id;
}

test('queue admission distinguishes new, existing and processing without duplicating identity',async t=>{
  const f=await fixture(t),p=await photo(f),first=await f.h.env.PHOTO_JOBS.send(p.message),second=await f.h.env.PHOTO_JOBS.send(p.message);
  assert.equal(first.admission,'queued');assert.equal(second.admission,'existing');assert.equal(first.id,second.id);
  requireQueueAdmission(first);requireQueueAdmission(second);
  await f.h.db.run("UPDATE job_queue SET state='processing' WHERE id=?",first.id);
  const leased=await f.h.env.PHOTO_JOBS.send(p.message);assert.equal(leased.state,'processing');requireQueueAdmission(leased);
  assert.equal((await f.h.db.one('SELECT count(*) n FROM job_queue')).n,1);
});

test('terminal queue rows never acknowledge still-live or missing domain work and are not reset',async t=>{
  const f=await fixture(t);
  for(const category of ['photo','privacy','notification'])for(const state of ['failed','completed']){
    const entry=category==='photo'?await photo(f):category==='privacy'?await privacy(f):{message:{category,payload:{notification_id:id()}}};
    const key=await stopped(f,entry.message,state),before=await f.h.db.one('SELECT * FROM job_queue WHERE id=?',key);
    const receipt=await f.h.env.PHOTO_JOBS.send(entry.message);
    assert.equal(receipt.admission,'terminal');assert.equal(receipt.domain_terminal,false);
    assert.throws(()=>requireQueueAdmission(receipt),{code:'job_queue_reconciliation_required'});
    assert.deepEqual(await f.h.db.one('SELECT * FROM job_queue WHERE id=?',key),before);
  }
});

test('terminal domain evidence is checked by exact category and identity before acknowledging',async t=>{
  const f=await fixture(t),p=await photo(f,0,'failed'),r=await privacy(f,0,'completed'),note=id();
  await f.h.db.run("INSERT INTO notifications(id,account_id,kind,entity_id,title,created_at) VALUES(?,?,'support','synthetic','Synthetic',?)",note,f.account,f.now());
  await f.h.db.run("INSERT INTO notification_jobs(notification_id,account_id,auth_epoch,status,created_at) VALUES(?,?,1,'accepted',?)",note,f.account,f.now());
  for(const message of [p.message,r.message,{category:'notification',payload:{notification_id:note}}]){
    await stopped(f,message);const receipt=await f.h.env.PHOTO_JOBS.send(message);
    assert.equal(receipt.domain_terminal,true);requireQueueAdmission(receipt);
  }
  await flushPhotoOutbox(f.h.app);
  assert.deepEqual(await f.h.db.one('SELECT status,dispatched_at FROM photo_job_outbox WHERE id=?',p.outbox),{status:'settled',dispatched_at:null});
  assert.equal((await f.h.db.one('SELECT count(*) n FROM job_queue WHERE attempts=20')).n,3);
});

test('a queue key with altered payload never produces a successful receipt',async t=>{
  const f=await fixture(t),p=await photo(f),receipt=await f.h.env.PHOTO_JOBS.send(p.message);
  await f.h.db.run('UPDATE job_queue SET payload_json=? WHERE id=?',JSON.stringify({attempt_id:id()}),receipt.id);
  await assert.rejects(f.h.env.PHOTO_JOBS.send(p.message),{code:'job_queue_binding_invalid'});
});

test('photo outbox preserves unresolved jobs, progresses past a full stopped batch, and records only real handoffs',async t=>{
  const f=await fixture(t),held=[];
  for(let index=0;index<21;index++){const p=await photo(f,index);held.push(p);await stopped(f,p.message);}
  const next=await photo(f,22);
  await assert.rejects(flushPhotoOutbox(f.h.app),{code:'job_queue_reconciliation_required'});
  assert.equal((await f.h.db.one('SELECT count(*) n FROM photo_job_outbox WHERE last_examined_at IS NOT NULL')).n,20);
  await assert.rejects(flushPhotoOutbox(f.h.app),{code:'job_queue_reconciliation_required'});
  assert.deepEqual(await f.h.db.one('SELECT status,dispatched_at FROM photo_job_outbox WHERE id=?',next.outbox),{status:'dispatched',dispatched_at:f.now()});
  for(const p of held)assert.deepEqual(await f.h.db.one('SELECT status,dispatched_at FROM photo_job_outbox WHERE id=?',p.outbox),{status:'pending',dispatched_at:null});
});

test('privacy outbox preserves stopped queue outcomes and continues other handoffs',async t=>{
  const f=await fixture(t),held=await privacy(f),next=await privacy(f,1);await stopped(f,held.message);
  await assert.rejects(flushPrivacyCleanup(f.h.app),{code:'job_queue_reconciliation_required'});
  assert.deepEqual(await f.h.db.one('SELECT delivered_at,cancelled_at FROM outbox WHERE id=?',held.outbox),{delivered_at:null,cancelled_at:null});
  assert.equal((await f.h.db.one('SELECT delivered_at FROM outbox WHERE id=?',next.outbox)).delivered_at,f.now());
});

test('privacy scan progresses past more than one bounded batch of stopped queue rows',async t=>{
  const f=await fixture(t);
  for(let index=0;index<26;index++){const p=await privacy(f,index);await stopped(f,p.message);}
  const next=await privacy(f,27);
  await assert.rejects(flushPrivacyCleanup(f.h.app),{code:'job_queue_reconciliation_required'});
  await assert.rejects(flushPrivacyCleanup(f.h.app),{code:'job_queue_reconciliation_required'});
  assert.equal((await f.h.db.one('SELECT delivered_at FROM outbox WHERE id=?',next.outbox)).delivered_at,f.now());
  assert.equal((await f.h.db.one('SELECT count(*) n FROM outbox WHERE delivered_at IS NULL')).n,26);
});

test('concurrent outbox scans admit each selected row once during its examination interval',async t=>{
  const f=await fixture(t);for(let index=0;index<5;index++)await photo(f,index);
  let calls=0;const send=f.h.env.PHOTO_JOBS.send.bind(f.h.env.PHOTO_JOBS);
  f.h.env.PHOTO_JOBS.send=async message=>{calls++;return send(message);};
  await Promise.all([flushPhotoOutbox(f.h.app),flushPhotoOutbox(f.h.app)]);
  assert.equal(calls,5);assert.equal((await f.h.db.one("SELECT count(*) n FROM photo_job_outbox WHERE status='dispatched'")).n,5);
});

test('a lost queue admission response retries the same job after cooldown without false dispatch',async t=>{
  const f=await fixture(t),p=await photo(f),send=f.h.env.PHOTO_JOBS.send.bind(f.h.env.PHOTO_JOBS);let lost=true;
  f.h.env.PHOTO_JOBS.send=async message=>{const receipt=await send(message);if(lost){lost=false;throw Error('synthetic_reply_lost');}return receipt;};
  await assert.rejects(flushPhotoOutbox(f.h.app),/synthetic_reply_lost/);
  assert.equal((await f.h.db.one('SELECT status FROM photo_job_outbox WHERE id=?',p.outbox)).status,'pending');
  await flushPhotoOutbox(f.h.app);f.advance();await flushPhotoOutbox(f.h.app);
  assert.equal((await f.h.db.one('SELECT status FROM photo_job_outbox WHERE id=?',p.outbox)).status,'dispatched');
  assert.equal((await f.h.db.one('SELECT count(*) n FROM job_queue')).n,1);
});

test('privacy recovery scan reaches later failures without borrowing or fabricating approval',async t=>{
  const f=await fixture(t),requests=[];
  for(let index=0;index<21;index++)requests.push((await privacy(f,index,'failed')).request);
  // The deliberately unapproved requests must remain failed, but a held first
  // batch cannot monopolize recovery examination for all subsequent requests.
  await f.h.db.run("UPDATE outbox SET cancelled_at=?",f.now());
  await flushPrivacyCleanup(f.h.app);
  assert.equal((await f.h.db.one('SELECT count(*) n FROM privacy_requests WHERE last_recovery_scan_at IS NOT NULL')).n,10);
  await flushPrivacyCleanup(f.h.app);await flushPrivacyCleanup(f.h.app);
  assert.equal((await f.h.db.one('SELECT count(*) n FROM privacy_requests WHERE last_recovery_scan_at IS NOT NULL')).n,21);
  for(const request of requests){
    const row=await f.h.db.one('SELECT status,reviewed_by,reviewed_at,completed_at FROM privacy_requests WHERE id=?',request);
    assert.deepEqual(row,{status:'failed',reviewed_by:null,reviewed_at:null,completed_at:null});
  }
  assert.equal((await f.h.db.one('SELECT count(*) n FROM privacy_exports')).n,0);
});
