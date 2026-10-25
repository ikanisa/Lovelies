import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startHarness,enroll,faceVerifierFixture,captureProofs,encode,sign} from './runtime-harness.mjs';
import {nextRetentionAt,pruneInactiveProfileMetadata,runRetention} from '../src/retention.ts';
import {finishLifecycleCleanup} from '../src/face-profile.ts';
import {flushPrivacyCleanup} from '../src/privacy.ts';
const DAY=86400000,key=()=>crypto.randomUUID();
async function signed(h,person,control,step,fields={},nonce=true){
 const body={account_id:person.accountId,device_id:person.deviceId,control_key:control,
  ...(nonce?{request_nonce:key(),request_expires_at:h.app.now()+45000}:{}),...fields};
 return {...body,device_signature:await sign(person.keys.privateKey,{protocol:'lovelies-face-profile-device-v1',step,...body})};
}
async function removed(t){
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});t.after(()=>h.close());
 const person=await enroll(h),control='lfl_'+encode(crypto.getRandomValues(new Uint8Array(32)));
 const created=await h.json('/auth/face/profile/control',{token:person.token,body:await signed(h,person,control,'control',{control_operation_key:key()},false)},201);
 const operation=key(),old=await h.db.one('SELECT * FROM face_profiles WHERE account_id=?',person.accountId);
 const intent={operation_key:operation,action:'remove',expected_version:created.version};
 await h.json('/auth/face/profile/action',{body:await signed(h,person,control,'action',intent)});
 await flushPrivacyCleanup(h.app);await finishLifecycleCleanup(h.app);
 const row=await h.db.one('SELECT * FROM face_profile_operations WHERE account_id=? AND operation_key=?',person.accountId,operation);
 assert.equal((await h.db.one('SELECT status FROM cleanup_intents WHERE id=?',row.cleanup_id)).status,'verified');
 assert.equal(await h.env.PHOTOS.head(old.template_key),null);
 const read=async(expected=200)=>h.json('/auth/face/profile/status',{body:await signed(h,person,control,'status',{operation_key:operation})},expected);
 const age=async(days=14,delta=0)=>{
  const at=h.app.now()-days*DAY+delta;
  await h.db.run('UPDATE cleanup_intents SET created_at=? WHERE id=?',at,row.cleanup_id);
  await h.db.run('UPDATE face_profile_operations SET created_at=? WHERE account_id=? AND operation_key=?',at-1,person.accountId,operation);
  await h.db.run("UPDATE media_write_intents SET created_at=? WHERE bucket='PHOTOS' AND object_key=?",at-2,old.template_key);
  return at;
 };
 return {h,person,control,operation,row,old,intent,read,age};
}
async function pruneUntil(h,predicate,limit=1){for(let i=0;i<10&&!await predicate();i++)await pruneInactiveProfileMetadata(h.app,limit);assert(await predicate());}

test('14-day exact absence compacts old reference addresses while signed status and fresh three-capture re-enrollment remain truthful',async t=>{
 const f=await removed(t),{h,person,control,row,old}=f;
 const retiredAt=await f.age(13);assert.equal(await nextRetentionAt(h.app),retiredAt+14*DAY,'inactive metadata deadline is bound to the persisted retirement clock');
 await f.age(14,1000);assert.equal(await pruneInactiveProfileMetadata(h.app),0);
 assert(await h.db.one('SELECT cleanup_id FROM face_profile_retirements WHERE cleanup_id=?',row.cleanup_id),'before original retirement deadline');
 const at=await f.age();await pruneUntil(h,async()=>!await h.db.one('SELECT id FROM cleanup_intents WHERE id=?',row.cleanup_id));
 const op=await h.db.one('SELECT * FROM face_profile_operations WHERE account_id=? AND operation_key=?',person.accountId,f.operation);
 assert.equal(op.cleanup_id,null);assert.equal(op.state,'applied');
 const facts=await h.db.all("SELECT * FROM retention_jobs WHERE subject_id=? AND object_version=?",person.accountId,'inactive-profile-operation-v1:'+f.operation);
 assert.equal(facts.length,1);assert.equal(facts[0].created_at,at);assert.equal(facts[0].status,'verified');
 assert(!JSON.stringify(facts).includes(old.template_key));assert(!JSON.stringify(facts).includes(old.template_digest));
 assert.equal((await h.db.one("SELECT count(*) n FROM media_write_intents WHERE object_key=?",old.template_key)).n,0);
 const metadata=await f.read();assert.equal(metadata.removal_state,'completed');assert.equal(metadata.operation.cleanup_state,'completed');assert.equal(metadata.operation.state,'applied');
 const before=await h.db.one('SELECT count(*) n FROM sessions WHERE account_id=?',person.accountId);
 await h.json('/auth/face/profile/action',{body:await signed(h,person,control,'action',f.intent)});
 assert.deepEqual(await h.db.one('SELECT count(*) n FROM sessions WHERE account_id=?',person.accountId),before,'old replay issues no credentials');
 const next=await h.json('/auth/face/profile/challenge',{body:await signed(h,person,control,'challenge',{
  action:'enroll',operation_key:key(),expected_version:metadata.version,consent:{purpose:'face_authentication',policy_version:'face-policy-fixture-v1',granted:true}})},201);
 assert.equal(next.required_captures,3);assert.equal(await h.db.one('SELECT id FROM face_profiles WHERE account_id=?',person.accountId),null,'completion fact itself grants no new profile');
 const completed=await h.json('/auth/face/profile/complete',{body:await captureProofs(h,next,person.keys.privateKey)});
 assert.equal(completed.account_id,person.accountId);
 const fresh=await h.db.one('SELECT * FROM face_profiles WHERE account_id=?',person.accountId);assert.notEqual(fresh.template_key,old.template_key);
 await pruneInactiveProfileMetadata(h.app);assert(await h.env.PHOTOS.head(fresh.template_key),'fresh profile survives historical compaction');
});

test('bare terminal operation and malformed, mismatched or duplicate minimal facts never manufacture cleanup authority',async t=>{
 const f=await removed(t),{h,person}=f;await f.age();
 await h.db.run('UPDATE face_profile_operations SET cleanup_id=NULL WHERE account_id=? AND operation_key=?',person.accountId,f.operation);
 assert.equal((await f.read()).removal_state,'none');
 await h.db.run("UPDATE face_profile_operations SET state='completed' WHERE account_id=? AND operation_key=?",person.accountId,f.operation);
 assert.equal((await f.read()).removal_state,'none');
 await h.db.run("UPDATE face_profile_operations SET state='applied',cleanup_id=? WHERE account_id=? AND operation_key=?",f.row.cleanup_id,person.accountId,f.operation);
 await pruneUntil(h,async()=>!await h.db.one('SELECT id FROM cleanup_intents WHERE id=?',f.row.cleanup_id));
 const fact=await h.db.one('SELECT * FROM retention_jobs WHERE subject_id=?',person.accountId),body=JSON.parse(fact.binding_json);
 for(const change of [x=>{delete x.input_hash;},x=>{x.input_hash='0'.repeat(64);},x=>{x.account_id=key();},x=>{x.retired_at=h.app.now()+DAY;}]){
  const changed=structuredClone(body);change(changed);await h.db.run('UPDATE retention_jobs SET binding_json=? WHERE id=?',JSON.stringify(changed),fact.id);
  assert.equal((await f.read(503)).error.code,'face_profile_cleanup_fact_invalid');
 }
 await h.db.run('UPDATE retention_jobs SET binding_json=? WHERE id=?',fact.binding_json,fact.id);
 for(const [column,value] of [['verified_at',h.app.now()+DAY],['policy_version',0],['error_code','unresolved']]){
  await h.db.run('UPDATE retention_jobs SET '+column+'=? WHERE id=?',value,fact.id);
  assert.equal((await f.read(503)).error.code,'face_profile_cleanup_fact_invalid');
  await h.db.run('UPDATE retention_jobs SET '+column+'=? WHERE id=?',fact[column],fact.id);
 }
 await h.db.run("INSERT INTO retention_jobs(id,subject_id,kind,binding_json,policy_version,object_version,status,created_at,verified_at) VALUES(?,?,'profile',?,?,?,'verified',?,?)",key(),person.accountId,fact.binding_json,fact.policy_version+1,fact.object_version,fact.created_at,fact.verified_at);
 assert.equal((await f.read(503)).error.code,'face_profile_cleanup_fact_invalid');
});

test('holds, duplicate cleanup, unsettled or newer writers and fresh HEAD failures preserve exact old metadata',async t=>{
 const f=await removed(t),{h,person,old}=f;const at=await f.age();const before=await h.db.one('SELECT * FROM face_profile_retirements WHERE cleanup_id=?',f.row.cleanup_id);
 const preserved=async()=>{await pruneInactiveProfileMetadata(h.app);await pruneInactiveProfileMetadata(h.app);assert.deepEqual(await h.db.one('SELECT * FROM face_profile_retirements WHERE cleanup_id=?',f.row.cleanup_id),before);};
 const hold=key();await h.db.run("INSERT INTO moderation_holds(id,subject_id,reason,active,created_at) VALUES(?,?,?,1,?)",hold,person.accountId,'Synthetic hold',h.app.now());await preserved();await h.db.run('DELETE FROM moderation_holds WHERE id=?',hold);
 const duplicate=key();await h.db.run("INSERT INTO cleanup_intents(id,subject_id,bucket,object_key,status,created_at,verified_at) VALUES(?,?,'PHOTOS',?,'verified',?,?)",duplicate,person.accountId,old.template_key,h.app.now()-20*DAY,h.app.now());await preserved();await h.db.run('DELETE FROM cleanup_intents WHERE id=?',duplicate);
 const writer=key();await h.db.run("INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at) VALUES(?,?,'PHOTOS',?,'pending',?)",writer,person.accountId,old.template_key,h.app.now());await preserved();await h.db.run("UPDATE media_write_intents SET status='settled',settled_at=? WHERE id=?",h.app.now(),writer);await preserved();
 await h.db.run('UPDATE media_write_intents SET created_at=?,settled_at=? WHERE id=?',at-2,at-3,writer);await preserved();
 await h.db.run('DELETE FROM media_write_intents WHERE id=?',writer);
 const head=h.env.PHOTOS.head.bind(h.env.PHOTOS);h.env.PHOTOS.head=async()=>{throw new Error('synthetic failed HEAD');};await preserved();h.env.PHOTOS.head=async()=>({key:old.template_key});await preserved();h.env.PHOTOS.head=head;
 await pruneUntil(h,async()=>!await h.db.one('SELECT cleanup_id FROM face_profile_retirements WHERE cleanup_id=?',f.row.cleanup_id));
});

test('a hold committed during external HEAD and a compaction-transaction fault preserve the full cleanup lineage',async t=>{
 const f=await removed(t),{h,person}=f;await f.age();const head=h.env.PHOTOS.head.bind(h.env.PHOTOS);let entered=false;const hold=key();
 h.env.PHOTOS.head=async key=>{if(!entered){entered=true;await h.db.transaction(()=>h.db.run("INSERT INTO moderation_holds(id,subject_id,reason,active,created_at) VALUES(?,?,?,1,?)",hold,person.accountId,'Hold during HEAD',h.app.now()));}return head(key);};
 await pruneInactiveProfileMetadata(h.app);assert(entered,'HEAD occurred outside the transaction lock');assert(await h.db.one('SELECT id FROM cleanup_intents WHERE id=?',f.row.cleanup_id));
 h.env.PHOTOS.head=head;await h.db.run('DELETE FROM moderation_holds WHERE id=?',hold);
 const run=h.db.run.bind(h.db);h.db.run=async(sql,...args)=>{if(sql.startsWith('DELETE FROM face_profile_retirements'))throw new Error('synthetic compaction rollback');return run(sql,...args);};
 await pruneInactiveProfileMetadata(h.app);await pruneInactiveProfileMetadata(h.app);assert(await h.db.one('SELECT id FROM cleanup_intents WHERE id=?',f.row.cleanup_id));assert.equal((await h.db.one('SELECT count(*) n FROM retention_jobs WHERE subject_id=?',person.accountId)).n,0);
 assert.equal((await h.db.one('SELECT cleanup_id FROM face_profile_operations WHERE account_id=? AND operation_key=?',person.accountId,f.operation)).cleanup_id,f.row.cleanup_id);
 h.db.run=run;await pruneUntil(h,async()=>!await h.db.one('SELECT id FROM cleanup_intents WHERE id=?',f.row.cleanup_id));
});

test('verified automatic profile-retention jobs minimize addresses from the original job clock without replaying physical cleanup',async t=>{
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});t.after(()=>h.close());const person=await enroll(h);
 const old=await h.db.one('SELECT * FROM face_profiles WHERE account_id=?',person.accountId);
 await h.db.run("UPDATE consents SET status='revoked',revoked_at=? WHERE account_id=?",h.app.now(),person.accountId);
 await runRetention(h.app);assert.equal(await h.env.PHOTOS.head(old.template_key),null);assert.equal(await h.db.one('SELECT id FROM face_profiles WHERE account_id=?',person.accountId),null);
 const job=await h.db.one("SELECT * FROM retention_jobs WHERE subject_id=? AND kind='profile'",person.accountId);assert.equal(job.status,'verified');
 const at=h.app.now()-14*DAY;await h.db.run('UPDATE retention_jobs SET created_at=? WHERE id=?',at,job.id);await h.db.run("UPDATE media_write_intents SET created_at=? WHERE object_key=?",at-1,old.template_key);
 await pruneUntil(h,async()=>JSON.parse((await h.db.one('SELECT binding_json FROM retention_jobs WHERE id=?',job.id)).binding_json).protocol==='lovelies-inactive-profile-job-completion-v1');
 const result=await h.db.one('SELECT * FROM retention_jobs WHERE id=?',job.id);assert.equal(result.created_at,at);assert.equal(result.verified_at,job.verified_at);
 assert.equal((await h.db.one('SELECT count(*) n FROM retention_objects WHERE job_id=?',job.id)).n,0);assert(!JSON.stringify(result).includes(old.template_key));assert(!JSON.stringify(result).includes(old.template_digest));
 await runRetention(h.app);assert.deepEqual(await h.db.one('SELECT * FROM retention_jobs WHERE id=?',job.id),result,'minimal completion is not reinterpreted as physical object work');
});

test('one-item maintenance alternates source classes and reaches automatic jobs behind a growing held lifecycle backlog',async t=>{
 const f=await removed(t),{h,person}=f;const at=await f.age();
 const hold=key();await h.db.run("INSERT INTO moderation_holds(id,subject_id,reason,active,created_at) VALUES(?,?,?,1,?)",hold,person.accountId,'Synthetic held backlog',h.app.now());
 const addHeld=async()=>{
  const cleanup=key(),reference='registered-face/'+person.accountId+'/'+key()+'/'+key();
  await h.db.run("INSERT INTO cleanup_intents(id,subject_id,bucket,object_key,status,created_at,verified_at) VALUES(?,?,'PHOTOS',?,'verified',?,?)",cleanup,person.accountId,reference,at-1000,h.app.now());
  await h.db.run('INSERT INTO face_profile_retirements(cleanup_id,account_id,operation_key,profile_id,profile_revision,template_key,template_digest) VALUES(?,?,?,?,?,?,?)',cleanup,person.accountId,'audience:'+key(),reference.split('/')[2],key(),reference,'0'.repeat(64));
 };
 for(let i=0;i<21;i++)await addHeld();
 const other=await enroll(h),old=await h.db.one('SELECT * FROM face_profiles WHERE account_id=?',other.accountId);
 await h.db.run("UPDATE consents SET status='revoked',revoked_at=? WHERE account_id=?",h.app.now(),other.accountId);
 await runRetention(h.app);const job=await h.db.one("SELECT * FROM retention_jobs WHERE subject_id=? AND kind='profile'",other.accountId);
 assert.equal(job.status,'verified');await h.db.run('UPDATE retention_jobs SET created_at=? WHERE id=?',at,job.id);
 await h.db.run('UPDATE media_write_intents SET created_at=? WHERE object_key=?',at-1,old.template_key);
 await h.db.run("INSERT INTO retention_scan_cursors(scan,entity_id,last_at,last_id) VALUES('privacy','inactive-profile-class-v1',?,'job') ON CONFLICT(scan,entity_id) DO UPDATE SET last_at=excluded.last_at,last_id=excluded.last_id",h.app.now());
 let heads=0;const head=h.env.PHOTOS.head.bind(h.env.PHOTOS);h.env.PHOTOS.head=async key=>{heads++;return head(key);};
 assert.equal(await pruneInactiveProfileMetadata(h.app,1),0);assert.equal(heads,0,'held lifecycle source performs no external HEAD');
 assert.equal(JSON.parse((await h.db.one('SELECT binding_json FROM retention_jobs WHERE id=?',job.id)).binding_json).template_key,old.template_key);
 await addHeld();assert.equal(await pruneInactiveProfileMetadata(h.app,1),0);assert.equal(heads,1,'second bounded turn reaches the other source class');
 assert.equal(JSON.parse((await h.db.one('SELECT binding_json FROM retention_jobs WHERE id=?',job.id)).binding_json).protocol,'lovelies-inactive-profile-job-completion-v1');
 assert.equal((await h.db.one('SELECT count(*) n FROM face_profile_retirements WHERE account_id=?',person.accountId)).n,23,'held lineage remains intact');
 assert.equal(await nextRetentionAt(h.app),null,'held or minimized sources create no spurious maintenance deadline');
 await h.db.run("UPDATE retention_scan_cursors SET last_id='unknown' WHERE scan='privacy' AND entity_id='inactive-profile-class-v1'");
 await assert.rejects(()=>pruneInactiveProfileMetadata(h.app,1),error=>error.code==='retention_cursor_invalid');
});
