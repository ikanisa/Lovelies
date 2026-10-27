/** Bounded synthetic PGlite cursor tests; no provider or network. */
import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {nextCleanupIntents,nextTerminalFaceProofs} from '../src/cleanup-scan.ts';
import {connectPostgres} from '../src/database.ts';
import {startHarness,closeHarnesses} from './runtime-harness.mjs';

after(closeHarnesses);
const pgliteTest=process.env.TEST_DATABASE_URL?test.skip:test;
const id=()=>crypto.randomUUID();
async function fixture(t){
 assert.equal(process.env.TEST_DATABASE_URL,undefined);
 const h=await startHarness({consumeQueue:false});t.after(()=>h.close());
 return {h,owner:await h.anonymous()};
}
async function seedIntents(h,account,count,at){
 const ids=Array.from({length:count},id);
 await h.db.transaction(async()=>{for(const value of ids)await h.db.run("INSERT INTO cleanup_intents(id,subject_id,bucket,object_key,status,created_at) VALUES(?,?,'QUARANTINE',?,'pending',?)",value,account,'synthetic/'+value,at);});
 return ids;
}

pgliteTest('cleanup scan preserves equal-time entries and a finite cycle when newer work arrives',{timeout:60000},async t=>{
 const {h,owner}=await fixture(t),at=Date.now()-100000,original=await seedIntents(h,owner.account_id,101,at);
 const first=await nextCleanupIntents(h.app);assert.equal(first.length,100);
 const added=(await seedIntents(h,owner.account_id,1,at+1))[0];
 const second=await nextCleanupIntents(h.app);assert.equal(second.length,1);assert.notEqual(second[0].id,added);
 assert.deepEqual(new Set([...first,...second].map(row=>row.id)),new Set(original));
 await h.db.run("UPDATE cleanup_intents SET status='verified' WHERE subject_id=? AND created_at=?",owner.account_id,at);
 const third=await nextCleanupIntents(h.app);assert.deepEqual(third.map(row=>row.id),[added]);
});

pgliteTest('concurrent cleanup scans claim disjoint pages through the transaction cursor',{timeout:60000},async t=>{
 const {h,owner}=await fixture(t),ids=await seedIntents(h,owner.account_id,101,Date.now()-100000);
 const pages=await Promise.all([nextCleanupIntents(h.app),nextCleanupIntents(h.app)]);
 assert.deepEqual(pages.map(page=>page.length).sort((a,b)=>a-b),[1,100]);
 assert.deepEqual(new Set(pages.flat().map(row=>row.id)),new Set(ids));
});

pgliteTest('terminal face-proof scan uses every tie-breaker across a page boundary',{timeout:60000},async t=>{
 const {h,owner}=await fixture(t),at=Date.now()-100000,created=at-1000,expected=[];
 await h.db.transaction(async()=>{for(let i=0;i<34;i++){
  const challenge=id();await h.db.run("INSERT INTO auth_challenges(id,account_id,purpose,nonce,policy_version,expires_at,status,created_at,used_at) VALUES(?,?,'registration',?,'fixture',?,'used',?,?)",challenge,owner.account_id,id(),at-1,created,at-1);
  for(let index=0;index<3;index++){await h.db.run("INSERT INTO auth_capture_proofs(challenge_id,capture_index,object_key,sha256,mime,byte_size,created_at) VALUES(?,?,?,?,'image/png',1,?)",challenge,index,'synthetic/'+id(),'a'.repeat(64),at);expected.push(`${challenge}:${index}`);}
 }});
 const first=await nextTerminalFaceProofs(h.app),second=await nextTerminalFaceProofs(h.app);
 assert.equal(first.length,100);assert.equal(second.length,2);
 assert.deepEqual(new Set([...first,...second].map(row=>`${row.challenge_id}:${row.capture_index}`)),new Set(expected));
});

for(const [entity,scan] of [['cleanup-intent-scan-v1',nextCleanupIntents],['face-proof-scan-v1',nextTerminalFaceProofs]])pgliteTest(`${entity} rejects a malformed stored cursor`,{timeout:30000},async t=>{
 const {h}=await fixture(t),bad='{"unexpected":"private"}';
 await h.db.run("INSERT INTO retention_scan_cursors(scan,entity_id,last_at,last_id) VALUES('privacy',?,?,?)",entity,42,bad);
 await assert.rejects(scan(h.app),error=>error?.status===503&&error?.code==='cleanup_cursor_invalid');
 assert.equal((await h.db.one("SELECT last_id FROM retention_scan_cursors WHERE scan='privacy' AND entity_id=?",entity)).last_id,bad);
});

for(const [entity,scan,value] of [
 ['cleanup-intent-scan-v1',nextCleanupIntents,{id:'ffffffff-ffff-ffff-ffff-ffffffffffff',upper_at:42,upper_id:'00000000-0000-0000-0000-000000000000'}],
 ['face-proof-scan-v1',nextTerminalFaceProofs,{challenge:'11111111-1111-1111-1111-111111111111',index:2,upper_at:42,upper_challenge:'11111111-1111-1111-1111-111111111111',upper_index:1}],
])pgliteTest(`${entity} rejects an equal-time cursor past its upper tuple`,{timeout:30000},async t=>{
 const {h}=await fixture(t),encoded=JSON.stringify(value);
 await h.db.run("INSERT INTO retention_scan_cursors(scan,entity_id,last_at,last_id) VALUES('privacy',?,?,?)",entity,42,encoded);
 await assert.rejects(scan(h.app),error=>error?.status===503&&error?.code==='cleanup_cursor_invalid');
 assert.equal((await h.db.one("SELECT last_id FROM retention_scan_cursors WHERE scan='privacy' AND entity_id=?",entity)).last_id,encoded);
});

pgliteTest('unsupported IDs stay outside these scans and are reported while valid cleanup progresses',{timeout:60000},async t=>{
 const {h,owner}=await fixture(t),other=await h.anonymous(),now=Date.now(),bucket=h.env.QUARANTINE;
 const oldKey='synthetic/unsupported-cleanup',proofKey='synthetic/unsupported-proof',validKey='synthetic/valid';
 for(const value of [oldKey,proofKey,validKey])await bucket.put(value,new Uint8Array([1]));
 const valid=id(),challenge='unsupported-historic-challenge';
 await h.db.transaction(async()=>{
  for(const [account,key] of [[owner.account_id,oldKey],[owner.account_id,proofKey],[other.account_id,validKey]])await h.db.run("INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at) VALUES(?,?,'QUARANTINE',?,'settled',?)",id(),account,key,now-1000);
  await h.db.run("INSERT INTO cleanup_intents(id,subject_id,bucket,object_key,status,created_at) VALUES('unsupported-historic-cleanup',?,'QUARANTINE',?,'pending',?)",owner.account_id,oldKey,now-1000);
  await h.db.run("INSERT INTO cleanup_intents(id,subject_id,bucket,object_key,status,created_at) VALUES(?,?,'QUARANTINE',?,'pending',?)",valid,other.account_id,validKey,now);
  await h.db.run("INSERT INTO auth_challenges(id,account_id,purpose,nonce,policy_version,expires_at,status,created_at,used_at) VALUES(?,?,'registration',?,'fixture',?,'used',?,?)",challenge,owner.account_id,id(),now-1,now-10000,now-1);
  await h.db.run("INSERT INTO auth_capture_proofs(challenge_id,capture_index,object_key,sha256,mime,byte_size,created_at) VALUES(?,0,?,?,'image/png',1,?)",challenge,proofKey,'a'.repeat(64),now-1000);
 });
 const result=await h.alarm();
 assert.deepEqual(result.privacy_health.scan_integrity,{unsupported_cleanup_intents:1,unsupported_terminal_face_proofs:1});assert(result.maintenance_errors>0);
 assert(await bucket.head(oldKey));assert(await bucket.head(proofKey));assert.equal(await bucket.head(validKey),null);
 assert.equal((await h.db.one('SELECT status FROM cleanup_intents WHERE id=?','unsupported-historic-cleanup')).status,'pending');
 assert.equal((await h.db.one('SELECT status FROM cleanup_intents WHERE id=?',valid)).status,'verified');
 assert(await h.db.one('SELECT challenge_id FROM auth_capture_proofs WHERE challenge_id=?',challenge));
});

for(const [label,sqlTime] of [['negative','-1'],['unsafe large','9007199254740992']])pgliteTest(`${label} cleanup timestamps remain reported even when backlog health is unavailable`,{timeout:60000},async t=>{
 const {h,owner}=await fixture(t),other=await h.anonymous(),now=Date.now(),bucket=h.env.QUARANTINE;
 const heldKey='synthetic/time-held',proofKey='synthetic/time-proof',validKey='synthetic/time-valid',badCleanup=id(),challenge=id(),valid=id();
 for(const value of [heldKey,proofKey,validKey])await bucket.put(value,new Uint8Array([1]));
 await h.db.transaction(async()=>{
  for(const [account,key] of [[owner.account_id,heldKey],[owner.account_id,proofKey],[other.account_id,validKey]])await h.db.run("INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at) VALUES(?,?,'QUARANTINE',?,'settled',?)",id(),account,key,now-1000);
  await h.db.run(`INSERT INTO cleanup_intents(id,subject_id,bucket,object_key,status,created_at) VALUES(?,?,'QUARANTINE',?,'pending',${sqlTime})`,badCleanup,owner.account_id,heldKey);
  await h.db.run("INSERT INTO cleanup_intents(id,subject_id,bucket,object_key,status,created_at) VALUES(?,?,'QUARANTINE',?,'pending',?)",valid,other.account_id,validKey,now);
  await h.db.run("INSERT INTO auth_challenges(id,account_id,purpose,nonce,policy_version,expires_at,status,created_at,used_at) VALUES(?,?,'registration',?,'fixture',?,'used',?,?)",challenge,owner.account_id,id(),now-1,now-10000,now-1);
  await h.db.run(`INSERT INTO auth_capture_proofs(challenge_id,capture_index,object_key,sha256,mime,byte_size,created_at) VALUES(?,0,?,?,'image/png',1,${sqlTime})`,challenge,proofKey,'a'.repeat(64));
 });
 const result=await h.alarm();
 assert.equal(result.privacy_health.status,'unavailable');
 assert.deepEqual(result.privacy_health.scan_integrity,{unsupported_cleanup_intents:1,unsupported_terminal_face_proofs:1});assert(result.maintenance_errors>0);
 assert(await bucket.head(heldKey));assert(await bucket.head(proofKey));assert.equal(await bucket.head(validKey),null);
 assert.equal((await h.db.one('SELECT status FROM cleanup_intents WHERE id=?',badCleanup)).status,'pending');
 assert.equal((await h.db.one('SELECT status FROM cleanup_intents WHERE id=?',valid)).status,'verified');
 assert(await h.db.one('SELECT challenge_id FROM auth_capture_proofs WHERE challenge_id=?',challenge));
});

test('native PostgreSQL cleanup scan coordinates separate pools',{skip:process.env.LOVELIES_DISPOSABLE_PG_TEST!=='1',timeout:60000},async t=>{
 const target=new URL(process.env.TEST_DATABASE_URL??'');
 assert(['127.0.0.1','localhost','::1','[::1]'].includes(target.hostname),'native fixture must be loopback-only');
 const h=await startHarness({consumeQueue:false}),other=connectPostgres(h.databaseUrl);t.after(async()=>{await other.close();await h.close();});
 const owner=await h.anonymous(),ids=await seedIntents(h,owner.account_id,101,Date.now()-100000),second={...h.app,db:other};
 const pages=await Promise.all([nextCleanupIntents(h.app),nextCleanupIntents(second)]);
 assert.deepEqual(pages.map(page=>page.length).sort((a,b)=>a-b),[1,100]);
 assert.deepEqual(new Set(pages.flat().map(row=>row.id)),new Set(ids));
});
