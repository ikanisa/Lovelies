/** Synthetic PGlite and in-memory Storage only; no provider or network. */
import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {startHarness,closeHarnesses} from './runtime-harness.mjs';
import {settleMediaWrite} from '../src/operations.ts';
after(closeHarnesses);
const pgliteTest=process.env.TEST_DATABASE_URL?test.skip:test;
const id=()=>crypto.randomUUID();
async function within(promise,ms=30000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('synthetic maintenance deadline')),ms);})]);}finally{clearTimeout(timer);}}

async function fixture(t,kind,count){
 assert.equal(process.env.TEST_DATABASE_URL,undefined,'never connect this test to PostgreSQL or a provider');
 assert(['privacy','proof'].includes(kind));assert([1,100].includes(count));
 const h=await startHarness({consumeQueue:false});t.after(()=>h.close());
 const blocked=await h.anonymous(),eligible=await h.anonymous();assert.notEqual(blocked.account_id,eligible.account_id);
 const bucket=h.env.QUARANTINE,originalDelete=bucket.delete.bind(bucket),deletions=[];
 bucket.delete=async keys=>{for(const key of typeof keys==='string'?[keys]:keys)deletions.push(key);return originalDelete(keys);};
 const old=Date.now()-100000,now=old+100000,objects=[];
 const blockedRows=Array.from({length:count},(_,i)=>({writer:id(),challenge:id(),key:`face-auth/${blocked.account_id}/${id()}/${id()}`,created:old+i}));
 const target={writer:id(),challenge:id(),key:`face-auth/${eligible.account_id}/${id()}/${id()}`,created:old+1000};
 const untouched={writer:id(),challenge:id(),key:`face-auth/${eligible.account_id}/${id()}/${id()}`,created:old+2000};
 for(const row of [...blockedRows,target,untouched]){await bucket.put(row.key,new Uint8Array([1,2,3]));objects.push(row.key);}
 await h.db.transaction(async()=>{
  async function writer(account,row,status){await h.db.run("INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at) VALUES(?,?,'QUARANTINE',?,?,?)",row.writer,account,row.key,status,row.created);}
  async function proof(account,row,live){
   await h.db.run(`INSERT INTO auth_challenges(id,account_id,purpose,nonce,policy_version,expires_at,status,created_at,used_at)
    VALUES(?,?,'registration',?,'fixture-face-policy',?,?,?,?)`,row.challenge,account,id(),live?now+86400000:now-1000,live?'pending':'failed',old-1000,live?null:now-1000);
   await h.db.run("INSERT INTO auth_capture_proofs(challenge_id,capture_index,object_key,sha256,mime,byte_size,created_at) VALUES(?,0,?,?,'image/png',3,?)",row.challenge,row.key,'a'.repeat(64),row.created);
  }
  for(const row of blockedRows){
   await writer(blocked.account_id,row,'pending');
   if(kind==='privacy')await h.db.run("INSERT INTO cleanup_intents(id,subject_id,bucket,object_key,status,created_at) VALUES(?,?,'QUARANTINE',?,'pending',?)",id(),blocked.account_id,row.key,row.created);
   else await proof(blocked.account_id,row,false);
  }
  await writer(eligible.account_id,target,'settled');
  if(kind==='privacy')await h.db.run("INSERT INTO cleanup_intents(id,subject_id,bucket,object_key,status,created_at) VALUES(?,?,'QUARANTINE',?,'pending',?)",id(),eligible.account_id,target.key,target.created);
  else await proof(eligible.account_id,target,false);
  // A separate live proof, or an unrelated object without a cleanup obligation,
  // must survive; this catches overbroad cross-account/key cleanup.
  if(kind==='proof'){await writer(eligible.account_id,untouched,'settled');await proof(eligible.account_id,untouched,true);}
 });
 assert.equal(Number((await h.db.one("SELECT count(*) n FROM media_write_intents WHERE account_id=? AND status='pending'",blocked.account_id)).n),count);
 assert(await bucket.head(target.key));assert(await bucket.head(untouched.key));
 return {h,bucket,blocked,eligible,blockedRows,target,untouched,deletions,objects,kind,count};
}

async function assertBlocked(f){
 const pending=Number((await f.h.db.one("SELECT count(*) n FROM media_write_intents WHERE account_id=? AND status='pending'",f.blocked.account_id)).n);
 assert.equal(pending,f.count,'every unresolved writer must remain pending');
 if(f.kind==='privacy'){
  const rows=await f.h.db.all("SELECT status FROM cleanup_intents WHERE subject_id=?",f.blocked.account_id);
  assert.equal(rows.length,f.count);assert(rows.every(row=>row.status!=='verified'),'no blocked cleanup may claim verified absence');
 }else{
  const n=Number((await f.h.db.one('SELECT count(*) n FROM auth_capture_proofs p JOIN auth_challenges c ON c.id=p.challenge_id WHERE c.account_id=?',f.blocked.account_id)).n);
  assert.equal(n,f.count,'terminal proofs with pending writers stay recorded');
 }
 for(const row of f.blockedRows){assert(await f.bucket.head(row.key),'blocked object must remain');assert(!f.deletions.includes(row.key),'blocked key must never be deleted');}
 assert(await f.bucket.head(f.untouched.key),'unrelated or live object must remain');
 if(f.kind==='proof')assert(await f.h.db.one('SELECT challenge_id FROM auth_capture_proofs WHERE challenge_id=?',f.untouched.challenge));
}
async function targetState(f){
 const object=!!await f.bucket.head(f.target.key);
 if(f.kind==='privacy')return {object,status:(await f.h.db.one('SELECT status FROM cleanup_intents WHERE subject_id=? AND object_key=?',f.eligible.account_id,f.target.key))?.status??null};
 return {object,proof:!!await f.h.db.one('SELECT challenge_id FROM auth_capture_proofs WHERE challenge_id=?',f.target.challenge)};
}
function assertTargetClean(f,state){
 assert.deepEqual(state,f.kind==='privacy'?{object:false,status:'verified'}:{object:false,proof:false},'later eligible cleanup must progress independently');
 assert(f.deletions.includes(f.target.key),'actual memory Storage delete must run for exact eligible key');
}
async function run(f,passes){for(let i=0;i<passes;i++){await within(f.h.alarm());await assertBlocked(f);}}

for(const kind of ['privacy','proof']){
 pgliteTest(`${kind}: one held writer does not block eligible cleanup and release later completes it`,{timeout:90000},async t=>{
  const f=await fixture(t,kind,1);await run(f,1);assertTargetClean(f,await targetState(f));
  // This control's memory PUT was awaited before setup and has no remote or late
  // side effect. Simulate its known terminal acknowledgement, not an unknown PUT.
  await settleMediaWrite(f.h.app,f.blockedRows[0].writer);await within(f.h.alarm());
  assert.equal(await f.bucket.head(f.blockedRows[0].key),null);assert(f.deletions.includes(f.blockedRows[0].key));
  if(kind==='privacy')assert.equal((await f.h.db.one('SELECT status FROM cleanup_intents WHERE subject_id=? AND object_key=?',f.blocked.account_id,f.blockedRows[0].key)).status,'verified');
  else assert.equal(await f.h.db.one('SELECT challenge_id FROM auth_capture_proofs WHERE challenge_id=?',f.blockedRows[0].challenge),null);
  assert(await f.bucket.head(f.untouched.key));
 });
 pgliteTest(`${kind}: 100 older unresolved writers cannot starve a later account's eligible cleanup`,{timeout:120000},async t=>{
  const f=await fixture(t,kind,100);await run(f,2);assertTargetClean(f,await targetState(f));
 });
}
