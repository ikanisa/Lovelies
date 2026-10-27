/** Focused same-subject local regressions; memory buckets and PGlite only. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
const pgliteTest=process.env.TEST_DATABASE_URL === undefined ? test : test.skip;
import {runRetention,pruneRetainedMetadata} from '../src/retention.ts';
import {retiredOperationInput,retiredOperationResponse} from '../src/operations.ts';
import {fixture,asset,profile,metadata,facts,release,staleScanThenHold,holdAfterScheduleSelect,holdBeforeScheduleMutation,holdAfterJobScan,staleScanThenVerified} from './retention-request-hold-fixture.mjs';

async function status(f,job){return f.h.db.one('SELECT status,error_code,lease_token,lease_until FROM retention_jobs WHERE id=?',job);}
async function objectStatus(f,job){return f.h.db.one('SELECT status,verified_at FROM retention_objects WHERE job_id=?',job);}

pgliteTest('pre-existing request hold preserves expired asset until release',{timeout:30000},async t=>{
 const f=await fixture(t),a=await asset(f);
 await runRetention(f.h.app);
 const item=await f.h.db.one('SELECT status,deleted_at,title FROM assets WHERE id=?',a.assetId);
 assert.deepEqual(f.errors,[]);assert.deepEqual(f.events,[]);assert.deepEqual(item,{status:'ready',deleted_at:null,title:'synthetic title'});
 assert.equal(await f.h.db.one('SELECT id FROM retention_jobs WHERE asset_id=?',a.assetId),null);assert(await f.h.env.QUARANTINE.head(a.key));
 await release(f);const result=await runRetention(f.h.app);
 assert.equal(result.verified,1);assert.equal(f.events.length,1);assert.equal(await f.h.env.QUARANTINE.head(a.key),null);
 assert.equal((await f.h.db.one('SELECT status FROM retention_jobs WHERE asset_id=?',a.assetId)).status,'verified');
});

pgliteTest('pre-existing request hold preserves face template until release',{timeout:30000},async t=>{
 const f=await fixture(t),a=await profile(f);
 await runRetention(f.h.app);
 assert.deepEqual(f.errors,[]);assert.deepEqual(f.events,[]);assert.equal((await f.h.db.one('SELECT status FROM face_profiles WHERE account_id=?',f.owner)).status,'active');
 assert.equal(await f.h.db.one("SELECT id FROM retention_jobs WHERE subject_id=? AND kind='profile'",f.owner),null);assert(await f.h.env.PHOTOS.head(a.key));
 await release(f);const result=await runRetention(f.h.app);
 assert.equal(result.verified,1);assert.equal(f.events.length,1);assert.equal(await f.h.env.PHOTOS.head(a.key),null);assert.equal(await f.h.db.one('SELECT status FROM face_profiles WHERE account_id=?',f.owner),null);
});

pgliteTest('pre-existing request hold preserves audit, consent and terminal support facts until release',{timeout:30000},async t=>{
 const f=await fixture(t),a=await metadata(f),before=await facts(f,a);assert(before.audits.every(Boolean)&&before.consent&&before.support&&before.operation);
 await pruneRetainedMetadata(f.h.app);assert.deepEqual(await facts(f,a),before);assert.deepEqual(f.errors,[]);assert.deepEqual(f.events,[]);
 await release(f);
 // The bounded source cursor advances through the held record and wraps after
 // an exhausted page; repeat only to observe its ordinary held-to-released path.
 await pruneRetainedMetadata(f.h.app);await pruneRetainedMetadata(f.h.app);
 const after=await facts(f,a);assert.deepEqual(after.audits,[null,null]);assert.equal(after.consent,null);assert.equal(after.support,null);
 assert.equal(after.operation.payload_json,retiredOperationInput);assert.equal(after.operation.response_json,retiredOperationResponse);
});

for(const kind of ['asset','profile'])pgliteTest(`unheld ${kind} retains ordinary retention progress`,{timeout:30000},async t=>{
 const f=await fixture(t,{held:false}),a=kind==='asset'?await asset(f):await profile(f),result=await runRetention(f.h.app);
 assert.deepEqual(f.errors,[]);assert.equal(result.verified,1);assert.equal(f.events.length,1);
 assert.equal(await f.h.env[kind==='asset'?'QUARANTINE':'PHOTOS'].head(a.key),null);
});

pgliteTest('terminal deletion request with legal_hold bit set is not an active request hold',{timeout:30000},async t=>{
 const f=await fixture(t,{held:true,status:'completed'}),a=await asset(f),result=await runRetention(f.h.app);
 assert.deepEqual(f.errors,[]);assert.equal(result.verified,1);assert.equal(f.events.length,1);assert.equal(await f.h.env.QUARANTINE.head(a.key),null);
});

pgliteTest('pre-existing request hold leaves an already scheduled job retryable until release',{timeout:30000},async t=>{
 const f=await fixture(t),a=await asset(f,{scheduled:true});
 await runRetention(f.h.app);assert.equal((await status(f,a.job)).status,'pending');assert.equal((await objectStatus(f,a.job)).status,'pending');
 assert.deepEqual(f.events,[]);assert(await f.h.env.QUARANTINE.head(a.key));
 await release(f);await runRetention(f.h.app);assert.equal((await status(f,a.job)).status,'verified');assert.equal(f.events.length,1);assert.equal(await f.h.env.QUARANTINE.head(a.key),null);
});

pgliteTest('request hold after claim but before first DELETE resumes after release',{timeout:30000},async t=>{
 const f=await fixture(t,{held:false}),a=await asset(f,{scheduled:true}),db=f.h.db,run=db.run.bind(db),tx=db.transaction.bind(db);
 let depth=0,claimed=false,injected=false,armed=true;
 db.run=async(sql,...args)=>{const value=await run(sql,...args);if(armed&&sql.startsWith("UPDATE retention_jobs SET status='processing'")&&args.includes(a.job))claimed=true;return value;};
 db.transaction=async(...args)=>{
  depth++;let value;try{value=await tx(...args);}finally{depth--;}
  if(depth===0&&armed&&claimed){
   armed=false;const current=await status(f,a.job);assert.equal(current.status,'processing');assert(current.lease_token&&current.lease_until>f.h.app.now());
   await db.run('UPDATE privacy_requests SET legal_hold=1 WHERE id=?',f.request);assert.equal((await db.one('SELECT legal_hold FROM privacy_requests WHERE id=?',f.request)).legal_hold,1);injected=true;
  }
  return value;
 };
 try{
  await runRetention(f.h.app);assert.equal(injected,true);assert.deepEqual(f.errors,[]);assert.deepEqual(f.events,[]);
  assert.equal((await status(f,a.job)).status,'failed');assert.equal((await status(f,a.job)).error_code,'retention_request_hold');assert(await f.h.env.QUARANTINE.head(a.key));
  await release(f);await runRetention(f.h.app);
  assert.equal((await status(f,a.job)).status,'verified');assert.equal(f.events.length,1);assert.equal(await f.h.env.QUARANTINE.head(a.key),null);
 }finally{db.run=run;db.transaction=tx;}
});

for(const phase of ['delete','head'])pgliteTest(`request hold during ${phase} prevents verification but cannot undo DELETE`,{timeout:30000},async t=>{
 const f=await fixture(t,{held:false}),a=await asset(f,{scheduled:true}),bucket=f.h.env.QUARANTINE;
 const original=phase==='delete'?bucket.delete.bind(bucket):bucket.head.bind(bucket);let injected=false;
 bucket[phase]=async key=>{
  const result=await original(key);
  if(!injected&&key===a.key){await f.h.db.run('UPDATE privacy_requests SET legal_hold=1 WHERE id=?',f.request);injected=true;}
  return result;
 };
 try{
  await runRetention(f.h.app);assert.equal(injected,true);assert.deepEqual(f.errors,[]);assert.equal(f.events.length,1);
  assert.equal((await status(f,a.job)).status,'blocked');assert.equal((await status(f,a.job)).error_code,'retention_request_hold');
  assert.deepEqual(await objectStatus(f,a.job),{status:'pending',verified_at:null});assert.equal(await bucket.head(a.key),null,'the dispatched DELETE already removed synthetic bytes');
  await release(f);await runRetention(f.h.app);assert.equal((await status(f,a.job)).status,'blocked');assert.equal(f.events.length,1,'unknown dispatched deletion is not reissued');
 }finally{bucket[phase]=original;}
});

pgliteTest('hold query failure after DELETE fails closed without verification or retry',{timeout:30000},async t=>{
 const f=await fixture(t,{held:false}),a=await asset(f,{scheduled:true}),db=f.h.db,one=db.one.bind(db);let injected=false;
 db.one=async(sql,...args)=>{
  if(!injected&&f.events.length===1&&sql.includes("FROM privacy_requests WHERE subject_id=? AND request_type='delete'")){
   injected=true;throw new Error('synthetic_hold_query_failure');
  }
  return one(sql,...args);
 };
 try{
  await runRetention(f.h.app);assert.equal(injected,true);assert.deepEqual(f.errors,[]);assert.equal(f.events.length,1);
  assert.equal((await status(f,a.job)).status,'blocked');assert.equal((await status(f,a.job)).error_code,'retention_request_hold_unavailable');
  assert.deepEqual(await objectStatus(f,a.job),{status:'pending',verified_at:null});assert.equal(await f.h.env.QUARANTINE.head(a.key),null);
  await runRetention(f.h.app);assert.equal(f.events.length,1);
 }finally{db.one=one;}
});

pgliteTest('source version conflicts remain blocked before DELETE',{timeout:30000},async t=>{
 const f=await fixture(t,{held:false}),a=await asset(f,{scheduled:true});
 await f.h.db.run('UPDATE assets SET version=? WHERE id=?',crypto.randomUUID(),a.assetId);
 await runRetention(f.h.app);assert.deepEqual(f.errors,[]);assert.deepEqual(f.events,[]);
 const state=await status(f,a.job);assert.equal(state.status,'blocked');assert.equal(state.error_code,'retention_source_changed');
 assert.deepEqual(await objectStatus(f,a.job),{status:'pending',verified_at:null});assert(await f.h.env.QUARANTINE.head(a.key));
});

for(const kind of ['global','moderation','asset'])pgliteTest(`existing ${kind} hold still protects the same-subject asset until release`,{timeout:30000},async t=>{
 const f=await fixture(t,{held:false}),a=await asset(f),now=f.h.app.now(),holdId=crypto.randomUUID();
 if(kind==='global')await f.h.db.run('INSERT INTO retention_settings(id,version,raw_days,preview_days,face_crop_days,free_cache_days,audit_days,legal_hold,updated_at) VALUES(?,?,?,?,?,?,?,?,?)','default',1,60,60,14,2,30,1,now);
 if(kind==='moderation')await f.h.db.run('INSERT INTO moderation_holds(id,subject_id,active,created_at,reason) VALUES(?,?,?,?,?)',holdId,f.owner,1,now,'synthetic hold');
 if(kind==='asset')await f.h.db.run('UPDATE asset_retention SET legal_hold=1 WHERE asset_id=?',a.assetId);
 await runRetention(f.h.app);assert.deepEqual(f.errors,[]);assert.deepEqual(f.events,[]);assert(await f.h.env.QUARANTINE.head(a.key));
 if(kind==='global')await f.h.db.run("UPDATE retention_settings SET legal_hold=0,version=version+1 WHERE id='default'");
 if(kind==='moderation')await f.h.db.run('UPDATE moderation_holds SET active=0,cleared_at=? WHERE id=?',now,holdId);
 if(kind==='asset')await f.h.db.run('UPDATE asset_retention SET legal_hold=0,version=version+1 WHERE asset_id=?',a.assetId);
 await runRetention(f.h.app);assert.equal(f.events.length,1);assert.equal(await f.h.env.QUARANTINE.head(a.key),null);
});

pgliteTest('hold-query failure before DELETE fails closed',{timeout:30000},async t=>{
 const f=await fixture(t,{held:false}),a=await asset(f,{scheduled:true}),db=f.h.db,one=db.one.bind(db);let injected=false;
 db.one=async(sql,...args)=>{
  if(!injected&&sql.includes("FROM privacy_requests WHERE subject_id=? AND request_type='delete'")){
   injected=true;throw new Error('synthetic_hold_query_failure');
  }
  return one(sql,...args);
 };
 try{
  await runRetention(f.h.app);assert.equal(injected,true);assert.deepEqual(f.errors,[]);assert.deepEqual(f.events,[]);
  assert.equal((await status(f,a.job)).status,'pending');assert.equal((await status(f,a.job)).error_code,null);
  assert.deepEqual(await objectStatus(f,a.job),{status:'pending',verified_at:null});assert(await f.h.env.QUARANTINE.head(a.key));
 }finally{db.one=one;}
});

pgliteTest('a previously failed job held after claim stays blocked after release',{timeout:30000},async t=>{
 const f=await fixture(t,{held:false}),a=await asset(f,{scheduled:true}),db=f.h.db;
 await db.run("UPDATE retention_jobs SET status='failed' WHERE id=?",a.job);
 const run=db.run.bind(db),tx=db.transaction.bind(db);let depth=0,claimed=false,injected=false,armed=true;
 db.run=async(sql,...args)=>{const value=await run(sql,...args);if(armed&&sql.startsWith("UPDATE retention_jobs SET status='processing'")&&args.includes(a.job))claimed=true;return value;};
 db.transaction=async(...args)=>{
  depth++;let value;try{value=await tx(...args);}finally{depth--;}
  if(depth===0&&armed&&claimed){armed=false;assert.equal((await status(f,a.job)).status,'processing');await db.run('UPDATE privacy_requests SET legal_hold=1 WHERE id=?',f.request);injected=true;}
  return value;
 };
 try{
  await runRetention(f.h.app);assert.equal(injected,true);assert.deepEqual(f.events,[]);assert.deepEqual(f.errors,[]);
  assert.equal((await status(f,a.job)).status,'blocked');assert.equal((await status(f,a.job)).error_code,'retention_request_hold');
  await release(f);await runRetention(f.h.app);assert.equal((await status(f,a.job)).status,'blocked');assert.deepEqual(f.events,[]);assert(await f.h.env.QUARANTINE.head(a.key));
 }finally{db.run=run;db.transaction=tx;}
});

pgliteTest('stale pending scan is not treated as a fresh claim after a prior failure',{timeout:30000},async t=>{
 const f=await fixture(t,{held:false}),a=await asset(f,{scheduled:true}),hook=staleScanThenHold(f,a);
 try{
  await runRetention(f.h.app);assert.deepEqual(hook.state(),{stale:true,claimed:true,injected:true});assert.deepEqual(f.errors,[]);assert.deepEqual(f.events,[]);
  assert.equal((await status(f,a.job)).status,'blocked');assert.equal((await status(f,a.job)).error_code,'retention_request_hold');
  await release(f);await runRetention(f.h.app);assert.equal((await status(f,a.job)).status,'blocked');assert.deepEqual(f.events,[]);assert(await f.h.env.QUARANTINE.head(a.key));
 }finally{hook.restore();}
});

for(const kind of ['asset','profile'])for(const phase of ['after_select','before_mutation'])pgliteTest(`request hold ${phase} preserves ${kind} before scheduling mutation`,{timeout:30000},async t=>{
 const f=await fixture(t,{held:false}),a=kind==='asset'?await asset(f):await profile(f);
 const hook=phase==='after_select'?holdAfterScheduleSelect(f,kind,kind==='asset'?a.assetId:a.profileId):holdBeforeScheduleMutation(f,kind);
 try{
  await runRetention(f.h.app);assert.deepEqual(hook.state(),{injected:true});assert.deepEqual(f.errors,[]);assert.deepEqual(f.events,[]);
  assert.equal((await f.h.db.one('SELECT legal_hold FROM privacy_requests WHERE id=?',f.request)).legal_hold,1);
  const row=kind==='asset'?await f.h.db.one('SELECT status,deleted_at,title FROM assets WHERE id=?',a.assetId):
   await f.h.db.one('SELECT status FROM face_profiles WHERE account_id=?',f.owner);
  if(kind==='asset')assert.deepEqual(row,{status:'ready',deleted_at:null,title:'synthetic title'});else assert.equal(row.status,'active');
  assert.equal(await f.h.db.one('SELECT id FROM retention_jobs WHERE subject_id=? AND kind=?',f.owner,kind==='asset'?'raw':'profile'),null);
  assert(await f.h.env[kind==='asset'?'QUARANTINE':'PHOTOS'].head(a.key));
  await release(f);await runRetention(f.h.app);assert.equal(f.events.length,1);
  assert.equal(await f.h.env[kind==='asset'?'QUARANTINE':'PHOTOS'].head(a.key),null);
 }finally{hook.restore();}
});

pgliteTest('hold after job scan but before claim leaves unclaimed pending job unchanged and resumes after release',{timeout:30000},async t=>{
 const f=await fixture(t,{held:false}),a=await asset(f,{scheduled:true}),hook=holdAfterJobScan(f,a);
 try{
  await runRetention(f.h.app);assert.deepEqual(hook.state(),{injected:true});assert.deepEqual(f.events,[]);assert.deepEqual(f.errors,[]);
  assert.deepEqual(await status(f,a.job),{status:'pending',error_code:null,lease_token:null,lease_until:null});
  await release(f);await runRetention(f.h.app);assert.equal((await status(f,a.job)).status,'verified');assert.equal(f.events.length,1);
 }finally{hook.restore();}
});

pgliteTest('stale scanned job cannot overwrite an already verified successor',{timeout:30000},async t=>{
 const f=await fixture(t,{held:false}),a=await asset(f,{scheduled:true}),hook=staleScanThenVerified(f,a);
 try{
  await runRetention(f.h.app);const {injected,verifiedBefore}=hook.state();assert.equal(injected,true);
  assert.deepEqual(f.errors,[]);assert.equal(f.events.length,1);
  const after=await f.h.db.one('SELECT status,verified_at,lease_token,lease_until,error_code FROM retention_jobs WHERE id=?',a.job);
  assert.deepEqual(after,verifiedBefore);assert.equal(after.status,'verified');
  assert.equal((await f.h.db.one('SELECT status FROM retention_objects WHERE job_id=?',a.job)).status,'verified');
  assert.equal(await f.h.env.QUARANTINE.head(a.key),null);
 }finally{hook.restore();}
});
