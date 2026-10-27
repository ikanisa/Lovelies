/** Same synthetic child; PGlite and in-process journal. No provider calls. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {fixture} from './restore-database-fixture.mjs';
import {AUDIENCE_POLICY,maintainAudience} from '../src/audience.ts';
import {createApp} from '../src/index.ts';
import {ApiError} from '../src/types.ts';
const localTest=process.env.TEST_DATABASE_URL===undefined?test:test.skip;
if(process.env.TEST_DATABASE_URL===undefined)globalThis.fetch=async()=>{throw Error('external_fetch_prohibited');};
const cursor=f=>f.db.one("SELECT last_at,last_id FROM retention_scan_cursors WHERE scan='guardian' AND entity_id='audience-expiry-v1'");
async function setup(t){
 const f=await fixture(t),h=f.h,child=await h.anonymous(),now=h.app.now();
 await h.json('/me/audience',{method:'PUT',token:child.access_token,body:{age_band:'13_17',policy_version:AUDIENCE_POLICY,expected_version:0,operation_key:randomUUID()}});
 const g=await h.json('/me/guardian-requests',{token:child.access_token,body:{policy_version:AUDIENCE_POLICY,expected_version:1,operation_key:randomUUID()}},201);
 const requestId=g.guardian_request.id;await h.db.run('UPDATE guardian_requests SET expires_at=?,created_at=? WHERE id=?',now-1,now-2000,requestId);
 const context=createApp(f.db,h.env,h.app.now);
 return {...f,child,requestId,context,now};
}
async function injectAfterFailedProcessing(f,mode){
 const db=f.db,originalRun=db.run.bind(db),originalTx=db.transaction.bind(db);let armed=true,intervened=false,matched=false;
 db.run=async(sql,...args)=>{
  if(armed&&sql.startsWith('UPDATE guardian_requests SET state=')&&args[2]===f.requestId){armed=false;throw new ApiError(409,'audience_authority_changed');}
  return originalRun(sql,...args);
 };
 db.transaction=async(callback,...options)=>{
  let saw=false;
  try{
   return await originalTx(async restore=>{
    const one=db.one;db.one=async(sql,...args)=>{if(sql==='SELECT * FROM guardian_requests WHERE id=?'&&args[0]===f.requestId)saw=true;return one.call(db,sql,...args);};
    try{return await callback(restore);}finally{db.one=one;}
   },...options);
  }catch(error){
   if(saw&&error instanceof ApiError&&error.code==='audience_authority_changed'&&!intervened){
    intervened=true;matched=true;
    await originalTx(async()=>{
      if(mode==='terminal')await originalRun("UPDATE guardian_requests SET state='withdrawn',revision=revision+1,terminated_at=? WHERE id=?",f.now,f.requestId);
      else await originalRun('DELETE FROM guardian_requests WHERE id=?',f.requestId);
    });
   }
   throw error;
  }
 };
 return {restore:()=>{db.run=originalRun;db.transaction=originalTx;},observed:()=>matched};
}
for(const mode of ['terminal','disappeared'])localTest(`stale ${mode} source must not be written into expiry cursor`,{timeout:45000},async t=>{
 const f=await setup(t),hook=await injectAfterFailedProcessing(f,mode);
 try{await assert.rejects(()=>f.db.invocation(()=>maintainAudience(f.context)),e=>e instanceof ApiError&&e.code==='audience_maintenance_blocked');}finally{hook.restore();}
 assert(hook.observed(),'same-subject transition must occur after the processing transaction and before cursor save');
 const row=await f.db.one('SELECT state FROM guardian_requests WHERE id=?',f.requestId);
 if(mode==='terminal')assert.equal(row.state,'withdrawn');else assert.equal(row,null);
 const actual=await cursor(f);assert(actual===null||actual.last_id!==f.requestId,'terminal or removed source must not become a newly saved cursor');
});
localTest('deterministic failure advances while later same-child request expires and earlier one retries after wrap',{timeout:45000},async t=>{
 const f=await setup(t),db=f.db,run=db.run.bind(db),later=randomUUID();
 await f.h.db.run("INSERT INTO guardian_requests(id,child_account_id,state,child_audience_version,policy_version,created_at,expires_at,revision) VALUES(?,?,'pending',1,?,?,?,1)",later,f.child.account_id,AUDIENCE_POLICY,f.now-1000,f.now-1);
 let denied=false;db.run=async(sql,...args)=>{if(!denied&&sql.startsWith('UPDATE guardian_requests SET state=')&&args[2]===f.requestId){denied=true;throw new ApiError(409,'audience_authority_changed');}return run(sql,...args);};
 try{await assert.rejects(()=>db.invocation(()=>maintainAudience(f.context)),e=>e instanceof ApiError&&e.code==='audience_maintenance_blocked');}finally{db.run=run;}
 assert(denied);assert.equal((await db.one('SELECT state FROM guardian_requests WHERE id=?',f.requestId)).state,'pending');assert.equal((await db.one('SELECT state FROM guardian_requests WHERE id=?',later)).state,'expired');assert.equal((await cursor(f)).last_id,later);
 await db.invocation(()=>maintainAudience(f.context));assert.deepEqual(await cursor(f),{last_at:null,last_id:null});
 await db.invocation(()=>maintainAudience(f.context));assert.equal((await db.one('SELECT state FROM guardian_requests WHERE id=?',f.requestId)).state,'expired');
});
localTest('disappearance after successful expiry cannot be saved as a stale source',{timeout:45000},async t=>{
 const f=await setup(t),db=f.db,tx=db.transaction.bind(db),run=db.run.bind(db);let injected=false,saw=false;
 db.transaction=async(callback,...options)=>{
  let seen=false;const result=await tx(async restore=>{
   const one=db.one;db.one=async(sql,...args)=>{if(sql==='SELECT * FROM guardian_requests WHERE id=?'&&args[0]===f.requestId)seen=true;return one.call(db,sql,...args);};
   try{return await callback(restore);}finally{db.one=one;}
  },...options);
  if(seen&&!injected){injected=true;saw=true;await tx(()=>run('DELETE FROM guardian_requests WHERE id=?',f.requestId));}
  return result;
 };
 try{await db.invocation(()=>maintainAudience(f.context));}finally{db.transaction=tx;}
 assert(saw);assert.equal(await db.one('SELECT id FROM guardian_requests WHERE id=?',f.requestId),null);const saved=await cursor(f);assert(saved===null||saved.last_id!==f.requestId);
});
localTest('concurrent cursor advancement is not overwritten after successful processing',{timeout:45000},async t=>{
 const f=await setup(t),db=f.db,tx=db.transaction.bind(db),run=db.run.bind(db),competing=randomUUID();let injected=false;
 db.transaction=async(callback,...options)=>{
  let seen=false;const result=await tx(async restore=>{
   const one=db.one;db.one=async(sql,...args)=>{if(sql==='SELECT * FROM guardian_requests WHERE id=?'&&args[0]===f.requestId)seen=true;return one.call(db,sql,...args);};
   try{return await callback(restore);}finally{db.one=one;}
  },...options);
  if(seen&&!injected){injected=true;await tx(()=>run("INSERT INTO retention_scan_cursors(scan,entity_id,last_at,last_id) VALUES('guardian','audience-expiry-v1',?,?)",f.now,competing));}
  return result;
 };
 try{await assert.rejects(()=>db.invocation(()=>maintainAudience(f.context)),e=>e instanceof ApiError&&e.code==='audience_cursor_changed');}finally{db.transaction=tx;}
 assert(injected);assert.deepEqual(await cursor(f),{last_at:f.now,last_id:competing});assert.equal((await db.one('SELECT state FROM guardian_requests WHERE id=?',f.requestId)).state,'expired');
});
localTest('stale empty-page wrap cannot clear a newer cursor',{timeout:45000},async t=>{
 const f=await setup(t),db=f.db,all=db.all.bind(db),old=randomUUID(),next=randomUUID();let injected=false;
 await db.transaction(()=>db.run("INSERT INTO retention_scan_cursors(scan,entity_id,last_at,last_id) VALUES('guardian','audience-expiry-v1',?,?)",f.now+100,old));
 let depth=0;
 db.all=async(sql,...args)=>{
  depth++;
  try {
   const rows=await all(sql,...args);
   // PostgresDatabase.all re-enters itself inside an automatic READ ONLY
   // transaction. Simulate the other worker only after that transaction closes.
   if(depth===1&&!injected&&sql.startsWith('SELECT r.*,admitted.version admitted_audience_version FROM guardian_requests r')){
    assert.equal(rows.length,0);injected=true;await db.transaction(()=>db.run("UPDATE retention_scan_cursors SET last_at=?,last_id=? WHERE scan='guardian' AND entity_id='audience-expiry-v1'",f.now+200,next));
   }
   return rows;
  } finally {depth--;}
 };
 try{await assert.rejects(()=>db.invocation(()=>maintainAudience(f.context)),e=>e instanceof ApiError&&e.code==='audience_cursor_changed');}finally{db.all=all;}
 assert(injected);assert.deepEqual(await cursor(f),{last_at:f.now+200,last_id:next});assert.equal((await db.one('SELECT state FROM guardian_requests WHERE id=?',f.requestId)).state,'pending');
});
localTest('a failure after the guarded cursor write rolls that write back while keeping an already committed expiry',{timeout:45000},async t=>{
 const f=await setup(t),db=f.db,one=db.one.bind(db);let injected=false;
 db.one=async(sql,...args)=>{
  const value=await one(sql,...args);
  if(!injected&&sql.startsWith('INSERT INTO retention_scan_cursors')&&sql.includes('RETURNING last_at,last_id')){injected=true;throw Error('synthetic_after_cursor_write');}
  return value;
 };
 try{await assert.rejects(()=>db.invocation(()=>maintainAudience(f.context)),/synthetic_after_cursor_write/);}finally{db.one=one;}
 assert(injected);assert.equal(await cursor(f),null);assert.equal((await db.one('SELECT state FROM guardian_requests WHERE id=?',f.requestId)).state,'expired');
 await db.invocation(()=>maintainAudience(f.context));assert.equal(await cursor(f),null);
});
localTest('changed but still-active episode is not skipped and is reconsidered on the next pass',{timeout:45000},async t=>{
 const f=await setup(t),db=f.db,originalRun=db.run.bind(db),originalTx=db.transaction.bind(db);let armed=true,changed=false;
 db.run=async(sql,...args)=>{if(armed&&sql.startsWith('UPDATE guardian_requests SET state=')&&args[2]===f.requestId){armed=false;throw new ApiError(409,'audience_authority_changed');}return originalRun(sql,...args);};
 db.transaction=async(callback,...options)=>{
  let seen=false;
  try{return await originalTx(async restore=>{
   const one=db.one;db.one=async(sql,...args)=>{if(sql==='SELECT * FROM guardian_requests WHERE id=?'&&args[0]===f.requestId)seen=true;return one.call(db,sql,...args);};
   try{return await callback(restore);}finally{db.one=one;}
  },...options);}catch(error){
   if(seen&&!changed&&error instanceof ApiError&&error.code==='audience_authority_changed'){
    changed=true;await originalTx(()=>originalRun('UPDATE guardian_requests SET revision=revision+1 WHERE id=?',f.requestId));
   }
   throw error;
  }
 };
 try{await assert.rejects(()=>db.invocation(()=>maintainAudience(f.context)),e=>e instanceof ApiError&&e.code==='audience_maintenance_blocked');}finally{db.run=originalRun;db.transaction=originalTx;}
 assert(changed);assert.equal(await cursor(f),null);assert.equal((await db.one('SELECT state FROM guardian_requests WHERE id=?',f.requestId)).state,'pending');
 await db.invocation(()=>maintainAudience(f.context));assert.equal((await db.one('SELECT state FROM guardian_requests WHERE id=?',f.requestId)).state,'expired');
});
localTest('lost cursor-commit acknowledgement reconciles the exact marker without repeating expiry',{timeout:45000},async t=>{
 const f=await setup(t),db=f.db,one=db.one.bind(db);let injected=false;
 db.one=async(sql,...args)=>{
  const value=await one(sql,...args);
  if(!injected&&sql.startsWith('INSERT INTO retention_scan_cursors')&&sql.includes('RETURNING last_at,last_id')){
   injected=true;f.faults.commitReply=true;
  }
  return value;
 };
 try{await assert.rejects(()=>db.invocation(()=>maintainAudience(f.context)),/synthetic_commit_result_lost/);}finally{db.one=one;}
 assert(injected);const pending=await f.journal.control();assert.equal(pending.state,'pending');
 const marker=await f.h.db.one('SELECT last_operation_id,last_plan_hash FROM restore_control WHERE singleton=1');assert.equal(marker.last_operation_id,pending.pending_operation_id);
 const prior=await f.journal.lookup(marker.last_operation_id);assert.equal(prior.status,'pending');assert.equal(prior.plan_hash,marker.last_plan_hash);
 const recorded=await db.one('SELECT state,revision FROM guardian_requests WHERE id=?',f.requestId);assert.equal(recorded.state,'expired');
 assert.equal((await f.journal.control()).state,'serving');assert.equal((await f.journal.lookup(marker.last_operation_id)).status,'committed');
 assert.equal((await cursor(f)).last_id,f.requestId);
 await db.invocation(()=>maintainAudience(f.context));assert.deepEqual(await db.one('SELECT state,revision FROM guardian_requests WHERE id=?',f.requestId),recorded);
});
