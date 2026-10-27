/** Synthetic in-process baseline only. Exercises the real generic orphan scan. */
import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {flushPrivacyCleanup} from '../src/privacy.ts';
import {startHarness,closeHarnesses} from './runtime-harness.mjs';

after(closeHarnesses);
const pgliteTest=process.env.TEST_DATABASE_URL === undefined ? test : test.skip;
const id=()=>crypto.randomUUID();
const bytes=Uint8Array.from([19,29,39,49,59]);
const digest=async b=>Buffer.from(await crypto.subtle.digest('SHA-256',b)).toString('hex');
const modes=['unheld','subject_moderation_held','global_retention_held','deletion_request_held',
 'subject_moderation_released','global_retention_released','deletion_request_released',
 'linked_orphan_held','linked_orphan_released','adopted_orphan_held','adopted_orphan_released',
 'adopted_during_delete','late_hold','guard_query_fault'];

async function exercise(mode){
 assert.equal(process.env.TEST_DATABASE_URL,undefined,'external PostgreSQL is prohibited');
 const h=await startHarness({consumeQueue:false});
 try{
  const owner=await h.anonymous(),linked=mode.startsWith('linked_orphan'),adopted=mode.startsWith('adopted_orphan'),adopting=mode==='adopted_during_delete';
  const reviewer=linked||adopted||adopting?await h.anonymous():null;
  const subject=owner.account_id, now=Date.now(), cleanupId=id(),writerId=id();
  const objectKey=`synthetic-orphan/${subject}/${id()}`,holdId=id(),hash=await digest(bytes);
  const kind=mode.startsWith('subject_moderation')?'moderation':mode.startsWith('global_retention')?'global':mode.startsWith('deletion_request')||linked||adopted?'request':'none';
  const released=mode.endsWith('_released'),held=mode.endsWith('_held');
  let linkedRequestId=null;
  await h.env.QUARANTINE.put(objectKey,bytes);
  await h.db.transaction(async()=>{
   await h.db.run(`INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at,settled_at)
    VALUES(?,?,'QUARANTINE',?,'settled',?,?)`,writerId,subject,objectKey,now-2000,now-1000);
   await h.db.run(`INSERT INTO cleanup_intents(id,request_id,subject_id,bucket,object_key,status,attempts,created_at)
    VALUES(?,NULL,?,'QUARANTINE',?,'pending',0,?)`,cleanupId,subject,objectKey,now-900);
   if(kind==='moderation')await h.db.run(`INSERT INTO moderation_holds(id,subject_id,asset_id,active,created_at,reason)
    VALUES(?,?,NULL,1,?,'synthetic subject hold')`,holdId,subject,now-800);
   if(kind==='global')await h.db.run(`INSERT INTO retention_settings(id,version,raw_days,preview_days,face_crop_days,free_cache_days,audit_days,legal_hold,updated_at)
    VALUES('default',1,60,60,14,2,30,1,?) ON CONFLICT(id) DO UPDATE SET legal_hold=1`,now-800);
   if(kind==='request')await h.db.run(`INSERT INTO privacy_requests(id,subject_id,requested_by,request_type,status,created_at,expires_at,legal_hold)
    VALUES(?,?,?,'delete','pending_approval',?,?,1)`,holdId,subject,subject,now-800,now+60000);
   if(linked||adopted||adopting){
    const requestId=id();linkedRequestId=requestId;
    await h.db.run(`INSERT INTO privacy_requests(id,subject_id,requested_by,request_type,status,created_at,expires_at,reviewed_by,reviewed_at,metadata_erased_at,lease_until)
     VALUES(?,?,?,'delete','processing',?,?,?,?,?,?)`,requestId,subject,subject,now-1200,now+60000,reviewer.account_id,now-1100,now-1000,now+60000);
    if(linked)await h.db.run(`INSERT INTO cleanup_intents(id,request_id,subject_id,bucket,object_key,status,attempts,created_at,verified_at)
     VALUES(?,?,?,'QUARANTINE',?,'verified',1,?,?)`,id(),requestId,subject,objectKey,now-1000,now-950);
    else if(adopted)await h.db.run('UPDATE cleanup_intents SET request_id=? WHERE id=?',requestId,cleanupId);
   }
  });
  const holdQuery=async()=>kind==='moderation'?await h.db.one('SELECT active AS held FROM moderation_holds WHERE id=? AND subject_id=?',holdId,subject):
   kind==='global'?await h.db.one("SELECT legal_hold AS held FROM retention_settings WHERE id='default'"):
   kind==='request'?await h.db.one("SELECT legal_hold AS held FROM privacy_requests WHERE id=? AND subject_id=? AND request_type='delete' AND status NOT IN('completed','rejected','cancelled')",holdId,subject):null;
  if(kind!=='none')assert.equal((await holdQuery())?.held,1,'fixture hold was not active before release or scan');
  if(released)await h.db.transaction(async()=>{
   if(kind==='moderation')await h.db.run('UPDATE moderation_holds SET active=0 WHERE id=?',holdId);
   if(kind==='global')await h.db.run("UPDATE retention_settings SET legal_hold=0 WHERE id='default'");
   if(kind==='request')await h.db.run('UPDATE privacy_requests SET legal_hold=0 WHERE id=?',holdId);
  });
  const holdBefore=await holdQuery();
  if(kind!=='none')assert.equal(holdBefore?.held,released?0:1,'wrong hold state at scan');
  const writer=await h.db.one('SELECT account_id,bucket,object_key,status FROM media_write_intents WHERE id=?',writerId);
  const initialRow=await h.db.one('SELECT id,request_id,subject_id,bucket,object_key,status,attempts,verified_at FROM cleanup_intents WHERE id=?',cleanupId);
  const before=await h.env.QUARANTINE.get(objectKey);
  assert.deepEqual(writer,{account_id:subject,bucket:'QUARANTINE',object_key:objectKey,status:'settled'});
  assert.equal(initialRow?.request_id,adopted?linkedRequestId:null);assert.equal(initialRow?.subject_id,subject);assert.equal(initialRow?.object_key,objectKey);
  assert.equal(initialRow?.status,'pending');assert.equal(initialRow?.verified_at,null);assert(before);
  assert.equal(await digest(new Uint8Array(await before.arrayBuffer())),hash,'fixture bytes differ');
  assert.equal(await h.db.one('SELECT id FROM assets WHERE owner_id=? AND object_key=?',subject,objectKey),null);
  assert.equal(await h.db.one('SELECT id FROM media_write_intents WHERE account_id=? AND object_key=? AND status=?',subject,objectKey,'pending'),null);
  const realAll=h.db.all.bind(h.db),realOne=h.db.one.bind(h.db),realTransaction=h.db.transaction.bind(h.db);
  const realDelete=h.env.QUARANTINE.delete.bind(h.env.QUARANTINE);
  const fixtureErrors=[],transactionErrors=[],deleteTargets=[];let selected=0,flushError=null,injected=false,linkedMatches=0,orphanGuardCalls=0;
  h.db.all=async(sql,...args)=>{try{
   const rows=await realAll(sql,...args);
   if(sql.includes('SELECT id,request_id,subject_id,bucket,object_key,created_at FROM cleanup_intents')&&rows.some(row=>row.id===cleanupId))selected++;
   return rows;
  }catch(error){fixtureErrors.push({where:'db.all',message:String(error?.message??error)});throw error;}};
  h.db.one=async(sql,...args)=>{try{
   if(sql.includes('AS orphan_cleanup_held'))orphanGuardCalls++;
   if(mode==='guard_query_fault'&&!injected&&sql.includes('AS orphan_cleanup_held')){injected=true;throw new Error('synthetic hold-query failure');}
   const value=await realOne(sql,...args);
   if(linked&&sql.includes('SELECT c.request_id FROM cleanup_intents c JOIN privacy_requests r')&&value?.request_id===linkedRequestId)linkedMatches++;
   return value;
  }catch(error){fixtureErrors.push({where:'db.one',message:String(error?.message??error)});throw error;}};
  h.db.transaction=async(...args)=>{try{return await realTransaction(...args);}catch(error){transactionErrors.push({code:error?.code??null,message:String(error?.message??error)});throw error;}};
  h.env.QUARANTINE.delete=async target=>{
   deleteTargets.push(target);
   if(target!==objectKey){const e=new Error('unexpected synthetic deletion target');fixtureErrors.push({where:'bucket',message:e.message});throw e;}
   try{
    if(mode==='late_hold'&&deleteTargets.length===1)await h.db.transaction(()=>h.db.run(`INSERT INTO moderation_holds
     (id,subject_id,active,created_at,reason) VALUES(?,?,1,?,'synthetic late hold')`,holdId,subject,Date.now()));
    if(adopting&&deleteTargets.length===1)await h.db.transaction(async()=>{
     await h.db.run('UPDATE cleanup_intents SET request_id=? WHERE id=? AND request_id IS NULL',linkedRequestId,cleanupId);
     await h.db.run(`INSERT INTO privacy_requests(id,subject_id,requested_by,request_type,status,created_at,expires_at,legal_hold)
      VALUES(?,?,?,'delete','pending_approval',?,?,1)`,holdId,subject,subject,Date.now(),Date.now()+60000);
    });
    return await realDelete(target);
   }catch(error){fixtureErrors.push({where:'bucket',message:String(error?.message??error)});throw error;}
  };
  try{await h.db.invocation(()=>flushPrivacyCleanup(h.app));}catch(error){flushError={code:error?.code??null,message:String(error?.message??error)};}
  const after=await h.env.QUARANTINE.get(objectKey),row=await h.db.one('SELECT id,subject_id,bucket,object_key,status,attempts,verified_at FROM cleanup_intents WHERE id=?',cleanupId);
  const intact=!!after&&await digest(new Uint8Array(await after.arrayBuffer()))===hash;
  const observation={mode,selected:selected>0,hold_at_scan:holdBefore?.held??null,fixture_errors:fixtureErrors,transaction_errors:transactionErrors,
   flush_error:flushError,delete_calls:deleteTargets.length,delete_targets_exact:deleteTargets.every(target=>target===objectKey),object_bytes_intact:intact,
   cleanup_status:row?.status??null,cleanup_verified_at_is_null:row?.verified_at===null,cleanup_subject_and_key_match:row?.subject_id===subject&&row?.object_key===objectKey};
  console.log('ORPHAN_OBSERVATION '+JSON.stringify(observation));
  assert.equal(observation.selected,true,'the real cleanup scan did not select the intent');
  if(linked)assert(linkedMatches>0,'the orphan did not inherit the intended reviewed request');
  assert.equal(flushError,null,'cleanup dispatch failed outside its per-intent handler');
  assert.deepEqual(fixtureErrors,mode==='guard_query_fault'?[{where:'db.one',message:'synthetic hold-query failure'}]:[],
   'unexpected fixture errors cannot masquerade as hold behavior');
  assert.equal(observation.delete_targets_exact,true);assert.equal(observation.cleanup_subject_and_key_match,true);
  const unrelatedErrors=transactionErrors.filter(error=>error.code!=='privacy_cleanup_held'&&
   !(mode==='guard_query_fault'&&error.message==='synthetic hold-query failure'));
  assert.deepEqual(unrelatedErrors,[],'unexpected application errors cannot masquerade as hold behavior');
  if(held||mode==='guard_query_fault'){
   if(held&&deleteTargets.length===0)assert(transactionErrors.some(error=>error.code==='privacy_cleanup_held'),'no hold-specific denial observed');
   if(mode==='guard_query_fault')assert(injected,'expected hold query failure was not injected');
   assert.deepEqual([observation.delete_calls,observation.object_bytes_intact,observation.cleanup_status,observation.cleanup_verified_at_is_null],
    [0,true,'pending',true],'a pre-existing hold must preserve the synthetic orphan and its cleanup obligation');
  }else if(mode==='late_hold'||adopting){
   assert(adopting?await h.db.one('SELECT id FROM privacy_requests WHERE id=? AND legal_hold=1',holdId):
    await h.db.one('SELECT id FROM moderation_holds WHERE id=? AND active=1',holdId),'late hold was not recorded');
   if(adopting)assert.equal((await h.db.one('SELECT request_id FROM cleanup_intents WHERE id=?',cleanupId))?.request_id,linkedRequestId);
   if(adopting)assert(orphanGuardCalls>=2,'the original orphan hold guard did not run again after adoption');
   assert(transactionErrors.some(error=>error.code==='privacy_cleanup_held'),'late hold did not deny finalization');
   assert.deepEqual([observation.delete_calls,observation.object_bytes_intact,observation.cleanup_status,observation.cleanup_verified_at_is_null],
    [1,false,'failed',true],'a late hold must prevent verified status even though bytes have already been deleted');
  }else{
   assert.deepEqual(transactionErrors,[],'ordinary cleanup had a transaction error');
   assert.deepEqual([observation.delete_calls,observation.object_bytes_intact,observation.cleanup_status,observation.cleanup_verified_at_is_null],
    [1,false,'verified',false],'unheld or released cleanup must remove the synthetic orphan and verify the intent');
  }
  if(held){
   await h.db.transaction(async()=>{
    if(kind==='moderation')await h.db.run('UPDATE moderation_holds SET active=0 WHERE id=?',holdId);
    if(kind==='global')await h.db.run("UPDATE retention_settings SET legal_hold=0 WHERE id='default'");
    if(kind==='request')await h.db.run('UPDATE privacy_requests SET legal_hold=0 WHERE id=?',holdId);
   });
   await h.db.invocation(()=>flushPrivacyCleanup(h.app));
   const releasedRow=await h.db.one('SELECT status,verified_at FROM cleanup_intents WHERE id=?',cleanupId);
   assert.deepEqual([deleteTargets.length,await h.env.QUARANTINE.get(objectKey),releasedRow?.status],
    [1,null,'verified'],'cleanup must resume on the same object after its hold is released');
   assert.notEqual(releasedRow.verified_at,null);
  }
 }finally{await h.close();}
}
for(const mode of modes)pgliteTest(`generic orphan cleanup: ${mode}`,{timeout:60000},()=>exercise(mode));
