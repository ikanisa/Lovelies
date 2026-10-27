/** Synthetic PGlite and MemoryBucket only. Never connect a real provider. */
import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {startHarness,closeHarnesses} from './runtime-harness.mjs';
after(closeHarnesses);
const pgliteTest=process.env.TEST_DATABASE_URL===undefined?test:test.skip;
const uuid=()=>crypto.randomUUID();
async function within(promise,ms=30000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('synthetic maintenance deadline')),ms);})]);}finally{clearTimeout(timer);}}
async function setup(t,count){
 assert.equal(process.env.TEST_DATABASE_URL,undefined,'must never use real PostgreSQL');assert([1,100].includes(count));
 const h=await startHarness({consumeQueue:false});t.after(()=>h.close());
 const owner=await h.anonymous(),other=await h.anonymous();assert.notEqual(owner.account_id,other.account_id);
 const bucket=h.env.QUARANTINE,remove=bucket.delete.bind(bucket),deletes=[];
 bucket.delete=async keys=>{for(const k of typeof keys==='string'?[keys]:keys)deletes.push(k);return remove(keys);};
 const now=Date.now(),old=now-100000;
 const held=Array.from({length:count},(_,n)=>({challenge:uuid(),writer:uuid(),cleanup:uuid(),created:old+n}));
 for(const row of held)row.key=`face-auth/${owner.account_id}/${row.challenge}/${uuid()}`;
 const later={writer:uuid(),cleanup:uuid(),key:`face-auth/${other.account_id}/${uuid()}/${uuid()}`,created:old+1000};
 const untouched=`face-auth/${other.account_id}/${uuid()}/${uuid()}`;
 for(const key of [...held.map(x=>x.key),later.key,untouched])await bucket.put(key,new Uint8Array([4,5,6]));
 await h.db.transaction(async()=>{
  for(const r of held){
   await h.db.run("INSERT INTO auth_challenges(id,account_id,purpose,nonce,policy_version,expires_at,status,created_at,auth_epoch) VALUES(?,?,'registration',?,'fixture',?,'pending',?,1)",r.challenge,owner.account_id,uuid(),now+86400000,old-1000);
   await h.db.run("INSERT INTO auth_capture_proofs(challenge_id,capture_index,object_key,sha256,mime,byte_size,created_at) VALUES(?,0,?,?,'image/png',3,?)",r.challenge,r.key,'a'.repeat(64),r.created);
   await h.db.run("INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at) VALUES(?,?,'QUARANTINE',?,'settled',?)",r.writer,owner.account_id,r.key,r.created);
   await h.db.run("INSERT INTO cleanup_intents(id,subject_id,bucket,object_key,status,created_at) VALUES(?,?,'QUARANTINE',?,'pending',?)",r.cleanup,owner.account_id,r.key,r.created);
  }
  await h.db.run("INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at) VALUES(?,?,'QUARANTINE',?,'settled',?)",later.writer,other.account_id,later.key,later.created);
  await h.db.run("INSERT INTO cleanup_intents(id,subject_id,bucket,object_key,status,created_at) VALUES(?,?,'QUARANTINE',?,'pending',?)",later.cleanup,other.account_id,later.key,later.created);
 });
 assert.equal(Number((await h.db.one("SELECT count(*) n FROM media_write_intents WHERE account_id=? AND status='pending'",owner.account_id)).n),0,'these are live-reference holds, not pending-writer holds');
 return {h,owner,other,held,later,untouched,bucket,deletes,count};
}
async function check(f){
 assert.equal(Number((await f.h.db.one("SELECT count(*) n FROM media_write_intents WHERE account_id=? AND status='pending'",f.owner.account_id)).n),0);
 assert.equal(Number((await f.h.db.one('SELECT count(*) n FROM auth_capture_proofs p JOIN auth_challenges c ON c.id=p.challenge_id WHERE c.account_id=?',f.owner.account_id)).n),f.count);
 const rows=await f.h.db.all('SELECT status FROM cleanup_intents WHERE subject_id=?',f.owner.account_id);assert.equal(rows.length,f.count);assert(rows.every(r=>r.status!=='verified'));
 for(const r of f.held){assert(await f.bucket.head(r.key));assert(!f.deletes.includes(r.key),'live proof must not be deleted');}
 assert(await f.bucket.head(f.untouched));
}
async function cleanLater(f){
 assert.equal(await f.bucket.head(f.later.key),null);
 assert.equal((await f.h.db.one('SELECT status FROM cleanup_intents WHERE id=?',f.later.cleanup)).status,'verified');
 assert(f.deletes.includes(f.later.key));
}
for(const count of [1,100])pgliteTest(`eligible cleanup progresses past ${count} older live-reference ${count===1?'hold':'holds'}`,{timeout:120000},async t=>{
 const f=await setup(t,count);
 for(let pass=0;pass<(count===1?1:2);pass++){await within(f.h.alarm());await check(f);}
 await cleanLater(f);
 if(count===1){
  // Synthetic control: make the challenge terminal; this is fixture setup,
  // not a claim that a production challenge or provider may be force-settled.
  await f.h.db.run("UPDATE auth_challenges SET status='used',used_at=? WHERE id=?",Date.now(),f.held[0].challenge);
  await within(f.h.alarm());assert.equal(await f.bucket.head(f.held[0].key),null);
  assert.equal(await f.h.db.one('SELECT challenge_id FROM auth_capture_proofs WHERE challenge_id=?',f.held[0].challenge),null);
  assert.equal((await f.h.db.one('SELECT status FROM cleanup_intents WHERE id=?',f.held[0].cleanup)).status,'verified');
  assert(await f.bucket.head(f.untouched));
 }
});
