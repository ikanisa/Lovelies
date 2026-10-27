/** Same-subject synthetic PGlite fixture: no native database or provider. */
import assert from 'node:assert/strict';
import {startHarness} from './runtime-harness.mjs';
import {prepareOperation} from '../src/operations.ts';

export const day=86400000, id=()=>crypto.randomUUID();
export async function fixture(t,{held=true,status='pending_approval'}={}){
 assert.equal(process.env.TEST_DATABASE_URL,undefined,'external database forbidden');
 const h=await startHarness({consumeQueue:false});t.after(()=>h.close());
 const owner=(await h.anonymous()).account_id,request=id(),now=h.app.now();
 await h.db.run('INSERT INTO privacy_requests(id,subject_id,requested_by,request_type,status,created_at,expires_at,legal_hold) VALUES(?,?,?,?,?,?,?,?)',
  request,owner,owner,'delete',status,now,now+day,held?1:0);
 const errors=[],events=[];
 for(const name of ['QUARANTINE','PHOTOS']){
  const bucket=h.env[name],raw=bucket.delete.bind(bucket);
  bucket.delete=async key=>{
   if(typeof key!=='string'||!key.startsWith('synthetic/'+owner+'/')){const e=Error('unexpected synthetic deletion target');errors.push(e.message);throw e;}
   events.push({kind:'delete',bucket:name,key});return raw(key);
  };
 }
 return {h,owner,request,now,errors,events};
}
export async function release(f){await f.h.db.run('UPDATE privacy_requests SET legal_hold=0 WHERE id=?',f.request);}
export async function asset(f,{scheduled=false}={}){
 const {h,owner,now}=f,assetId=id(),version=id(),key='synthetic/'+owner+'/asset/'+assetId,deleted=scheduled?now-1000:null;
 await h.db.run('INSERT INTO assets(id,owner_id,source,status,object_key,content_type,byte_size,version,title,deleted_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  assetId,owner,'personal',scheduled?'expired':'ready',key,'image/png',3,version,'synthetic title',deleted,now-70*day);
 await h.db.run('INSERT INTO asset_retention(asset_id,raw_expires_at,preview_expires_at,legal_hold,version,updated_at) VALUES(?,?,?,?,?,?)',assetId,now-day,now+day,0,1,now);
 await h.env.QUARANTINE.put(key,new Uint8Array([1,2,3]));
 let job=null;
 if(scheduled){
  await h.db.run('INSERT INTO retention_settings(id,version,raw_days,preview_days,face_crop_days,free_cache_days,audit_days,legal_hold,updated_at) VALUES(?,?,?,?,?,?,?,?,?)','default',1,60,60,14,2,30,0,now);
  job=id();
  const binding=JSON.stringify({object_key:key,checksum:null,retention_version:1,deleted_at:deleted});
  await h.db.run('INSERT INTO retention_jobs(id,subject_id,asset_id,kind,binding_json,policy_version,object_version,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
   job,owner,assetId,'raw',binding,1,version,'pending',now);
  await h.db.run('INSERT INTO retention_objects(id,job_id,bucket,object_key,status,created_at) VALUES(?,?,?,?,?,?)',id(),job,'QUARANTINE',key,'pending',now);
 }
 return {assetId,version,key,job};
}
export async function profile(f){
 const {h,owner}=f,profileId=id(),revision=id(),key='synthetic/'+owner+'/profile/'+profileId;
 await h.db.run('INSERT INTO face_profiles(account_id,id,revision,model_id,template_key,template_digest,status,auth_enabled,auth_epoch) VALUES(?,?,?,?,?,?,?,?,?)',
  owner,profileId,revision,'fixture-model',key,'a'.repeat(64),'active',0,1);
 await h.env.PHOTOS.put(key,new Uint8Array([4,5,6]));
 return {profileId,revision,key};
}
export async function metadata(f){
 const {h,owner,now}=f,actorAudit=id(),subjectAudit=id(),consent=id(),support=id(),operation=id();
 for(const [audit,actor,subject] of [[actorAudit,owner,null],[subjectAudit,null,owner]]){
  await h.db.run('INSERT INTO audit_events(id,actor_id,subject_id,action,entity_id,details_json,created_at) VALUES(?,?,?,?,?,?,?)',
   audit,actor,subject,'privacy.synthetic',id(),'{}',now-400*day);
 }
 await h.db.run('INSERT INTO consents(id,account_id,purpose,policy_version,status,revoked_at,created_at) VALUES(?,?,?,?,?,?,?)',
  consent,owner,'synthetic_fixture','fixture-v1','revoked',now-400*day,now-401*day);
 await h.db.run('INSERT INTO support_requests(id,account_id,subject,details,status,category,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
  support,owner,'Synthetic support','Synthetic protected record','closed','general_support',now-92*day,now-91*day);
 const body={subject:'Synthetic support',details:'Synthetic protected record',operation_key:operation},prepared=await prepareOperation('support.create',body,'support');
 await h.db.run('INSERT INTO operations(actor_id,source,operation_key,action,payload_hash,payload_json,response_json,created_at) VALUES(?,?,?,?,?,?,?,?)',
  owner,'support',operation,'support.create',prepared.hash,prepared.payloadJson,JSON.stringify({id:support,status:'open',revision:1}),now-400*day);
 await h.db.run('INSERT INTO operation_subjects(actor_id,source,operation_key,subject_id) VALUES(?,?,?,?)',owner,'support',operation,owner);
 return {actorAudit,subjectAudit,consent,support,operation};
}
export async function facts(f,a){
 const {h}=f;
 return {
  audits:[await h.db.one('SELECT id FROM audit_events WHERE id=?',a.actorAudit),await h.db.one('SELECT id FROM audit_events WHERE id=?',a.subjectAudit)],
  consent:await h.db.one('SELECT id FROM consents WHERE id=?',a.consent),
  support:await h.db.one('SELECT id FROM support_requests WHERE id=?',a.support),
  operation:await h.db.one('SELECT payload_json,response_json FROM operations WHERE operation_key=?',a.operation)
 };
}

/** Model a stale scan only: change the same synthetic job from pending to failed
 * after selection, then set the subject hold after the later claim. No other
 * account, worker, socket, provider or actual prior deletion is simulated. */
export function staleScanThenHold(f,a){
 const db=f.h.db,all=db.all.bind(db),run=db.run.bind(db),tx=db.transaction.bind(db);
 let allDepth=0,txDepth=0,armedScan=true,armedClaim=true,stale=false,claimed=false,injected=false;
 db.all=async(sql,...args)=>{
  allDepth++;let value;try{value=await all(sql,...args);}finally{allDepth--;}
  if(allDepth===0&&armedScan&&sql.startsWith('SELECT j.* FROM retention_jobs j')){
   const selected=value.find(row=>row.id===a.job);assert(selected);assert.equal(selected.status,'pending');assert.equal(selected.lease_until,null);
   armedScan=false;await db.run("UPDATE retention_jobs SET status='failed' WHERE id=?",a.job);
   assert.equal((await db.one('SELECT status FROM retention_jobs WHERE id=?',a.job)).status,'failed');stale=true;
  }
  return value;
 };
 db.run=async(sql,...args)=>{const value=await run(sql,...args);if(armedClaim&&sql.startsWith("UPDATE retention_jobs SET status='processing'")&&args.includes(a.job))claimed=true;return value;};
 db.transaction=async(...args)=>{
  txDepth++;let value;try{value=await tx(...args);}finally{txDepth--;}
  if(txDepth===0&&armedClaim&&claimed&&stale){
   armedClaim=false;const row=await db.one('SELECT status,lease_token FROM retention_jobs WHERE id=?',a.job);
   assert.equal(row.status,'processing');assert(row.lease_token);await db.run('UPDATE privacy_requests SET legal_hold=1 WHERE id=?',f.request);
   assert.equal((await db.one('SELECT legal_hold FROM privacy_requests WHERE id=?',f.request)).legal_hold,1);injected=true;
  }
  return value;
 };
 return {state:()=>({stale,claimed,injected}),restore:()=>{db.all=all;db.run=run;db.transaction=tx;}};
}

/** In-transaction injection: models a hold becoming visible after a candidate
 * SELECT. It is not evidence of an independently committed concurrent writer. */
export function holdAfterScheduleSelect(f,kind,target){
 const db=f.h.db,all=db.all.bind(db);let injected=false;
 db.all=async(sql,...args)=>{
  const rows=await all(sql,...args);
  const matches=kind==='asset'?sql.startsWith('SELECT a.* FROM assets a LEFT JOIN asset_retention'):
   sql.startsWith("SELECT f.* FROM face_profiles f WHERE f.status='active'");
  if(!injected&&matches){
   const selected=rows.find(row=>kind==='asset'?row.id===target:row.account_id===f.owner);
   assert(selected,'the exact synthetic subject must be selected before hold insertion');
   assert.equal((await db.one('SELECT legal_hold FROM privacy_requests WHERE id=?',f.request)).legal_hold,0);
   injected=true;await db.run('UPDATE privacy_requests SET legal_hold=1 WHERE id=?',f.request);
   assert.equal((await db.one('SELECT legal_hold FROM privacy_requests WHERE id=?',f.request)).legal_hold,1);
  }
  return rows;
 };
 return {state:()=>({injected}),restore:()=>{db.all=all;}};
}

/** Model a same-job successor completing after scan, before claim. The
 * successor's DELETE is synthetic memory-only; there is no concurrent worker. */
export function staleScanThenVerified(f,a){
 const db=f.h.db,all=db.all.bind(db);let depth=0,armed=true,injected=false,verifiedBefore=null;
 db.all=async(sql,...args)=>{
  depth++;let rows;try{rows=await all(sql,...args);}finally{depth--;}
  if(depth===0&&armed&&sql.startsWith('SELECT j.* FROM retention_jobs j')){
   const selected=rows.find(row=>row.id===a.job);assert(selected);assert.equal(selected.status,'pending');assert.equal(selected.lease_token,null);
   armed=false;await f.h.env.QUARANTINE.delete(a.key);
   const now=f.h.app.now();
   await db.transaction(async()=>{
    await db.run("UPDATE retention_objects SET status='verified',verified_at=? WHERE job_id=?",now,a.job);
    await db.run("UPDATE retention_jobs SET status='verified',verified_at=?,lease_token=NULL,lease_until=NULL,error_code=NULL WHERE id=?",now,a.job);
   });
   verifiedBefore=await db.one('SELECT status,verified_at,lease_token,lease_until,error_code FROM retention_jobs WHERE id=?',a.job);
   assert.equal(verifiedBefore.status,'verified');assert(verifiedBefore.verified_at!==null);injected=true;
  }
  return rows;
 };
 return {state:()=>({injected,verifiedBefore}),restore:()=>{db.all=all;}};
}

/** Same-transaction injection after the last writer query and before the
 * scheduling mutation; models visibility, not a concurrent backend. */
export function holdBeforeScheduleMutation(f,kind){
 const db=f.h.db,one=db.one.bind(db);let injected=false;
 db.one=async(sql,...args)=>{
  const result=await one(sql,...args);
  const matches=kind==='asset'?sql.startsWith("SELECT id FROM media_write_intents WHERE bucket=? AND object_key=?"):
   sql.startsWith("SELECT id FROM media_write_intents WHERE bucket='PHOTOS' AND object_key=?");
  if(!injected&&matches){
   assert.equal(result,null,'fixture must have no pending writer');
   assert.equal((await one('SELECT legal_hold FROM privacy_requests WHERE id=?',f.request)).legal_hold,0);
   injected=true;await db.run('UPDATE privacy_requests SET legal_hold=1 WHERE id=?',f.request);
  }
  return result;
 };
 return {state:()=>({injected}),restore:()=>{db.one=one;}};
}

/** Inject hold after a selected pending job is returned but before its claim. */
export function holdAfterJobScan(f,a){
 const db=f.h.db,all=db.all.bind(db);let depth=0,injected=false;
 db.all=async(sql,...args)=>{
  depth++;let rows;try{rows=await all(sql,...args);}finally{depth--;}
  if(depth===0&&!injected&&sql.startsWith('SELECT j.* FROM retention_jobs j')){
   const row=rows.find(x=>x.id===a.job);assert(row);assert.equal(row.status,'pending');injected=true;
   await db.run('UPDATE privacy_requests SET legal_hold=1 WHERE id=?',f.request);
  }
  return rows;
 };
 return {state:()=>({injected}),restore:()=>{db.all=all;}};
}
