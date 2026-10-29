/** External, unexecuted PGlite/MemoryBucket regression candidates. No provider. */
import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {startHarness,closeHarnesses,enroll,captureProofs,faceVerifierFixture,fixturePng,sha256} from './runtime-harness.mjs';
import {processPhotoJob} from '../src/processing.ts';
import {flushPrivacyCleanup} from '../src/privacy.ts';
import {delayedPrivateMedia,observeWriterChecks} from './private-media-delayed-write.fixture.mjs';
const pgliteTest=process.env.TEST_DATABASE_URL===undefined?test:test.skip;
after(closeHarnesses);
const key=()=>crypto.randomUUID();
async function within(promise,ms=15000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('synthetic private-media fixture deadline')),ms))]);}finally{clearTimeout(timer);}}
async function admin(h){const person=await enroll(h);await h.storage.exec('UPDATE accounts SET roles_json=? WHERE id=?','["user","admin"]',person.accountId);const challenge=await h.json('/auth/face/challenge',{body:{face_handle:person.faceHandle,device_id:person.deviceId}},201);const credentials=await h.json('/auth/face/complete',{body:await captureProofs(h,challenge,person.keys.privateKey)});assert(credentials.roles.includes('admin'));return {...person,token:credentials.access_token};}
async function setup(t){assert(process.env.TEST_DATABASE_URL===undefined,'unset TEST_DATABASE_URL: external DB is outside this fixture');const preview=fixturePng('synthetic-delayed-generated-preview');const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false,photoProcessor:envelope=>({...envelope,preview:{bytes_base64:Buffer.from(preview).toString('base64'),content_type:'image/png',width:1,height:1},matches:[]})});t.after(()=>h.close());const owner=await enroll(h),reviewer=await admin(h);return {h,owner,reviewer,preview};}
async function facts(h,owner,bucket,target){return {writers:await h.storage.exec('SELECT id,account_id,bucket,object_key,status,created_at,settled_at FROM media_write_intents WHERE account_id=? AND bucket=? AND object_key=? ORDER BY id',owner.accountId,bucket,target),cleanup:await h.storage.exec('SELECT id,request_id,status,verified_at FROM cleanup_intents WHERE subject_id=? AND bucket=? AND object_key=? ORDER BY id',owner.accountId,bucket,target)};}
function fenceViolations(violations,label,value,first){if(value.writers.length!==1||value.writers[0].id!==first?.id||value.writers[0].account_id!==first?.account_id||value.writers[0].bucket!==first?.bucket||value.writers[0].object_key!==first?.object_key||value.writers[0].created_at!==first?.created_at||value.writers[0].status!=='pending'||value.writers[0].settled_at!==null)violations.push({invariant:'exact_writer_remains_pending',point:label,writer_count:value.writers.length,status:value.writers[0]?.status??null});if(value.cleanup.some(row=>row.status==='verified'||row.verified_at!==null))violations.push({invariant:'unknown_writer_cleanup_never_verified',point:label,statuses:value.cleanup.map(r=>r.status)});}
async function publicationCounts(h,id){const out={};for(const table of ['renditions','candidates','match_origins','media_grants'])out[table]=Number((await h.storage.exec('SELECT count(*) n FROM '+table+' WHERE asset_id=?',id))[0].n);out.completed=Number((await h.storage.exec("SELECT count(*) n FROM processing_attempts WHERE asset_id=? AND status='completed'",id))[0].n);return out;}
async function photo(t,mode){const f=await setup(t),{h,owner,reviewer}=f;await h.json('/me/photo-preferences',{token:owner.token,body:{policy_version:'photo-policy-fixture-v1',processing_consent:true,operation_key:key()}});const bytes=fixturePng('synthetic-private-media-source'),reservation=await h.json('/uploads/session',{token:owner.token,body:{source:'personal',content_type:'image/png',byte_size:bytes.length,operation_key:key()}},201);await h.json(reservation.upload_url,{token:owner.token,method:'PUT',raw:bytes,headers:{'content-type':'image/png'}});const complete=await h.json(reservation.complete_url,{token:owner.token,body:{operation_key:key()}},202);const memory=h.env.PHOTOS,fake=delayedPrivateMedia(memory,{bucket:'photos',prefix:`preview/${owner.accountId}/${reservation.asset_id}/${complete.attempt_id}/`,mode});h.env.PHOTOS=fake.bucket;const reference=(await h.storage.exec('SELECT template_key FROM face_profiles WHERE account_id=?',reviewer.accountId))[0];const reviewerHash=await sha256(await(await memory.get(reference.template_key)).arrayBuffer());return {...f,reservation,complete,memory,fake,reviewerReference:reference.template_key,reviewerHash};}

pgliteTest('generated preview: rejected write stays fenced through real deletion cleanup and late arrival',{timeout:60000},async t=>{
 const f=await photo(t,'ambiguous'),{h,owner,reviewer,reservation,complete,fake,memory}=f;
 let checks;
 try{
  let failed=false;try{await within(processPhotoJob({attempt_id:complete.attempt_id},h.app));}catch{failed=true;}
  assert.equal(fake.writes.length,1,'actual preview POST must be reached exactly once');const target=fake.writes[0].key,first=await facts(h,owner,'PHOTOS',target),firstWriter=first.writers[0];assert(firstWriter,'producer must persist its actual writer');
  checks=observeWriterChecks(h.db,target);const beforePublication=await publicationCounts(h,reservation.asset_id);const privateRead=await h.request(`/community/media/${reservation.asset_id}/preview`,{token:owner.token});const readStatus=privateRead.status;await privateRead.body?.cancel();
  const deletion=(await h.json('/privacy/account-deletion',{token:owner.token,body:{operation_key:key()}},201)).privacy_request;await h.json(`/privacy-requests/${deletion.id}/approve`,{token:reviewer.token,body:{operation_key:key()}});
  const deleting=await h.request(`/privacy-requests/${deletion.id}/process`,{token:reviewer.token,body:{}});const deletionStatus=deleting.status;await deleting.body?.cancel();await within(h.alarm());
  const beforeLate=await facts(h,owner,'PHOTOS',target),deletionBefore=(await h.storage.exec('SELECT status,completed_at FROM privacy_requests WHERE id=?',deletion.id))[0],checksBefore=checks.count();assert(beforeLate.cleanup.some(row=>row.request_id===deletion.id),'real erasure inventory must include exact attempted preview key');
  assert.equal(await memory.head(target),null,'remote preview effect must still be held after real cleanup');fake.mark('cleanup-before-release-complete');await within(fake.release());assert(await memory.head(target),'independent synthetic preview must actually arrive');
  const late=await facts(h,owner,'PHOTOS',target);await within(h.alarm());const final=await facts(h,owner,'PHOTOS',target),deletionFinal=(await h.storage.exec('SELECT status,completed_at FROM privacy_requests WHERE id=?',deletion.id))[0],finalPublication=await publicationCounts(h,reservation.asset_id);
  const violations=[];for(const [label,value]of [['first',first],['before_late',beforeLate],['late',late],['after_late_maintenance',final]])fenceViolations(violations,label,value,firstWriter);
  if(!failed||readStatus!==404||Object.values(beforePublication).some(Boolean)||Object.values(finalPublication).some(Boolean))violations.push({invariant:'rejected_preview_never_publishes_authority',failed,read_status:readStatus,before:beforePublication,after:finalPublication});
  if(deletionStatus!==503||deletionBefore.status==='completed'||deletionFinal.status==='completed'||deletionBefore.completed_at!==null||deletionFinal.completed_at!==null)violations.push({invariant:'unknown_preview_writer_prevents_completed_erasure',response_status:deletionStatus,statuses:[deletionBefore.status,deletionFinal.status]});
  if(fake.events.some(e=>e.kind==='delete'&&e.key===target)||!await memory.head(target))violations.push({invariant:'unknown_preview_writer_is_never_deleted_or_assumed_absent'});
  if(fake.events.findIndex(e=>e.kind==='remote-commit')<=fake.events.findIndex(e=>e.kind==='cleanup-before-release-complete'))violations.push({invariant:'fixture_remote_commit_must_follow_actual_cleanup'});
  if(fake.writes.length!==1)violations.push({invariant:'no_extra_preview_dispatch',count:fake.writes.length});
  if(checksBefore<1||checks.count()<=checksBefore)violations.push({invariant:'real_cleanup_rechecks_exact_writer_before_and_after_late_arrival',counts:[checksBefore,checks.count()]});
  assert.equal(await sha256(await(await memory.get(f.reviewerReference)).arrayBuffer()),f.reviewerHash,'independent reviewer reference must survive owner erasure work');
  assert.deepEqual(violations,[],'local preview rejection cannot certify remote termination');
 }finally{checks?.restore();await within(fake.release());}
});

pgliteTest('generated preview: acknowledged synthetic write settles and permits owner preview only',{timeout:60000},async t=>{
 const f=await photo(t,'acknowledged'),{h,owner,reviewer,reservation,complete,fake,memory}=f;
 try{await within(processPhotoJob({attempt_id:complete.attempt_id},h.app));assert.equal(fake.writes.length,1);const target=fake.writes[0].key,state=await facts(h,owner,'PHOTOS',target);assert.equal(state.writers.length,1);assert.equal(state.writers[0].status,'settled');assert(state.writers[0].settled_at!==null);const counts=await publicationCounts(h,reservation.asset_id);assert.equal(counts.renditions,1);assert.equal(counts.completed,1);assert.equal(counts.candidates+counts.match_origins+counts.media_grants,0);const row=(await h.storage.exec('SELECT object_key,checksum_sha256 FROM renditions WHERE asset_id=? AND status=\'ready\'',reservation.asset_id))[0];assert.equal(row.object_key,target);assert.equal(row.checksum_sha256,fake.writes[0].sha256);const response=await h.request(`/community/media/${reservation.asset_id}/preview`,{token:owner.token});assert.equal(response.status,200);assert.equal(await sha256(await response.arrayBuffer()),fake.writes[0].sha256);const peer=await h.request(`/community/media/${reservation.asset_id}/preview`,{token:reviewer.token});assert.equal(peer.status,403);await peer.body?.cancel();assert(await memory.head(target));assert.equal(fake.events.some(e=>e.kind==='delete'&&e.key===target),false);}finally{await within(fake.release());}
});

async function exported(t,mode){const f=await setup(t),{h,owner,reviewer}=f;const request=(await h.json('/privacy/export',{token:owner.token,body:{operation_key:key()}},201)).privacy_request;await h.json(`/privacy-requests/${request.id}/approve`,{token:reviewer.token,body:{operation_key:key()}});const memory=h.env.PRIVACY_EXPORTS,fake=delayedPrivateMedia(memory,{bucket:'privacy-exports',prefix:`privacy/${owner.accountId}/${request.id}/`,mode});h.env.PRIVACY_EXPORTS=fake.bucket;const row=(await h.storage.exec('SELECT expires_at FROM privacy_requests WHERE id=?',request.id))[0];return {...f,request,memory,fake,expiresAt:row.expires_at};}
async function exportPublication(h,id){return {request:(await h.storage.exec('SELECT status,completed_at,export_key FROM privacy_requests WHERE id=?',id))[0],exports:await h.storage.exec('SELECT id,object_key,status FROM privacy_exports WHERE request_id=? ORDER BY id',id),grants:Number((await h.storage.exec('SELECT count(*) n FROM privacy_export_grants WHERE request_id=?',id))[0].n)};}
pgliteTest('privacy export: rejected write stays pending after real cleanup and delayed remote arrival',{timeout:60000},async t=>{
 const f=await exported(t,'ambiguous'),{h,owner,reviewer,request,memory,fake}=f;
 let checks;
 try{
  const response=await h.request(`/privacy-requests/${request.id}/process`,{token:reviewer.token,body:{}});const processStatus=response.status;await response.body?.cancel();assert.equal(fake.writes.length,1,'actual export POST must be reached exactly once');const target=fake.writes[0].key,first=await facts(h,owner,'PRIVACY_EXPORTS',target),firstWriter=first.writers[0];assert(firstWriter);const firstPublication=await exportPublication(h,request.id);
  checks=observeWriterChecks(h.db,target);assert(h.app.now()<f.expiresAt,'grant denial must use a current actor/request, not expiry');const grant=await h.request(`/privacy-exports/${request.id}/grant`,{token:owner.token,body:{}});const grantStatus=grant.status;await grant.body?.cancel();
  // Use the actual cleanup task at the natural request-expiry boundary, avoiding
  // its unrelated failed-export auto-retry loop. Canonical rows and the normal
  // h.app actor clock are unchanged. This does not qualify active-window retries.
  const maintenance={...h.app,now:()=>f.expiresAt+1};await within(h.db.invocation(()=>flushPrivacyCleanup(maintenance)));const beforeLate=await facts(h,owner,'PRIVACY_EXPORTS',target),checksBefore=checks.count();assert(beforeLate.cleanup.length>=1,'real failed-export producer must create its exact cleanup obligation');assert.equal(await memory.head(target),null);fake.mark('cleanup-before-release-complete');await within(fake.release());assert(await memory.head(target),'independent export effect must arrive');const late=await facts(h,owner,'PRIVACY_EXPORTS',target);
  await within(h.db.invocation(()=>flushPrivacyCleanup(maintenance)));const final=await facts(h,owner,'PRIVACY_EXPORTS',target),finalPublication=await exportPublication(h,request.id);const grantAfter=await h.request(`/privacy-exports/${request.id}/grant`,{token:owner.token,body:{}});const grantAfterStatus=grantAfter.status;await grantAfter.body?.cancel();
  const violations=[];for(const [label,value]of [['first',first],['before_late',beforeLate],['late',late],['after_late_cleanup',final]])fenceViolations(violations,label,value,firstWriter);
  for(const [label,value]of [['first',firstPublication],['final',finalPublication]])if(value.request.status==='completed'||value.request.completed_at!==null||value.request.export_key!==null||value.exports.some(row=>row.status==='published')||value.grants)violations.push({invariant:'failed_export_never_publishes_or_grants',point:label,status:value.request.status,publications:value.exports.map(row=>row.status),grants:value.grants});
  if(processStatus<500||grantStatus!==404||grantAfterStatus!==404)violations.push({invariant:'failed_export_has_no_download_capability',process_status:processStatus,grant_statuses:[grantStatus,grantAfterStatus]});
  if(fake.events.some(e=>e.kind==='delete'&&e.key===target)||!await memory.head(target))violations.push({invariant:'unknown_export_write_not_deleted_or_assumed_absent'});
  if(fake.events.findIndex(e=>e.kind==='remote-commit')<=fake.events.findIndex(e=>e.kind==='cleanup-before-release-complete'))violations.push({invariant:'fixture_remote_commit_must_follow_actual_cleanup'});
  if(fake.writes.length!==1)violations.push({invariant:'no_unrelated_export_retry_in_cleanup_scope',count:fake.writes.length});
  if(checksBefore<1||checks.count()<=checksBefore)violations.push({invariant:'real_cleanup_rechecks_exact_writer_before_and_after_late_arrival',counts:[checksBefore,checks.count()]});
  assert.deepEqual(violations,[],'local export rejection cannot certify remote termination');
 }finally{checks?.restore();await within(fake.release());}
});
pgliteTest('privacy export: acknowledged synthetic write settles and permits its session-bound download',{timeout:60000},async t=>{
 const f=await exported(t,'acknowledged'),{h,owner,reviewer,request,fake,memory}=f;
 try{const completed=await h.json(`/privacy-requests/${request.id}/process`,{token:reviewer.token,body:{}});assert.equal(completed.privacy_request.status,'completed');assert.equal(fake.writes.length,1);const target=fake.writes[0].key,state=await facts(h,owner,'PRIVACY_EXPORTS',target);assert.equal(state.writers.length,1);assert.equal(state.writers[0].status,'settled');assert(state.writers[0].settled_at!==null);const publication=await exportPublication(h,request.id);assert.equal(publication.request.export_key,target);assert.equal(publication.exports.length,1);assert.equal(publication.exports[0].status,'published');const grant=await h.json(`/privacy-exports/${request.id}/grant`,{token:owner.token,body:{}});const response=await h.request(grant.grant_path,{token:owner.token});assert.equal(response.status,200);const bytes=new Uint8Array(await response.arrayBuffer());assert.equal(await sha256(bytes),fake.writes[0].sha256);assert.equal(JSON.parse(new TextDecoder().decode(bytes)).subject_user_id,owner.accountId);bytes.fill(0);await h.json(grant.grant_path,{token:owner.token},401);assert.equal(await memory.head(target),null);const retired=await facts(h,owner,'PRIVACY_EXPORTS',target);assert(retired.cleanup.some(row=>row.status==='verified'));}finally{await within(fake.release());}
});

// Simulate a local response being lost only after the selected SQL transaction
// has committed. This observes the actual SQL boundary; it changes no results.
function loseCommitReply(h, marker) {
 const transaction=h.db.transaction.bind(h.db), run=h.db.run.bind(h.db);
 let marked=false, injected=false;
 h.db.run=async (sql,...bindings)=>{const result=await run(sql,...bindings);if(!injected&&sql.includes(marker))marked=true;return result;};
 h.db.transaction=async (callback,...rest)=>{const result=await transaction(callback,...rest);if(marked&&!injected){injected=true;throw Error('synthetic committed transaction reply lost');}return result;};
 return {injected:()=>injected,restore:()=>{h.db.run=run;h.db.transaction=transaction;}};
}

pgliteTest('generated preview: lost publication reply preserves the committed owner rendition',{timeout:60000},async t=>{
 const f=await photo(t,'acknowledged'),{h,owner,reservation,complete,fake,memory}=f;
 const fault=loseCommitReply(h,"UPDATE processing_attempts SET status='completed'");
 try{
  await assert.rejects(()=>within(processPhotoJob({attempt_id:complete.attempt_id},h.app)));
  assert(fault.injected(),'must lose a reply after the actual publication commit');fault.restore();
  const target=fake.writes[0].key,counts=await publicationCounts(h,reservation.asset_id);
  assert.equal(counts.renditions,1);assert.equal(counts.completed,1);
  assert.equal((await facts(h,owner,'PHOTOS',target)).cleanup.length,0,'a confirmed live rendition needs no orphan cleanup obligation');
  await within(h.db.invocation(()=>flushPrivacyCleanup(h.app)));
  assert(await memory.head(target),'committed preview must survive orphan cleanup');
  assert.equal(fake.events.some(e=>e.kind==='delete'&&e.key===target),false);
  const response=await h.request(`/community/media/${reservation.asset_id}/preview`,{token:owner.token});
  assert.equal(response.status,200);assert.equal(await sha256(await response.arrayBuffer()),fake.writes[0].sha256);
 }finally{fault.restore();await within(fake.release());}
});

pgliteTest('privacy export: lost publication reply preserves the committed one-time grant',{timeout:60000},async t=>{
 const f=await exported(t,'acknowledged'),{h,owner,reviewer,request,fake,memory}=f;
 const fault=loseCommitReply(h,"UPDATE privacy_requests SET status='completed',completed_at");
 try{
  const response=await h.request(`/privacy-requests/${request.id}/process`,{token:reviewer.token,body:{}});
  assert(response.status>=500);await response.body?.cancel();assert(fault.injected(),'must lose a reply after actual publication commit');fault.restore();
  const target=fake.writes[0].key,state=await exportPublication(h,request.id);
  assert.equal(state.request.status,'completed');assert.equal(state.request.export_key,target);assert.equal(state.exports[0].status,'published');
  await within(h.db.invocation(()=>flushPrivacyCleanup(h.app)));assert(await memory.head(target));
  const grant=await h.json(`/privacy-exports/${request.id}/grant`,{token:owner.token,body:{}});
  const download=await h.request(grant.grant_path,{token:owner.token});assert.equal(download.status,200);
  assert.equal(await sha256(await download.arrayBuffer()),fake.writes[0].sha256);
 }finally{fault.restore();await within(fake.release());}
});

for(const hold of ['global','asset','subject-moderation','asset-moderation'])pgliteTest(`failed preview cleanup respects ${hold} hold`,{timeout:60000},async t=>{
 const f=await photo(t,'acknowledged'),{h,owner,reservation,complete,memory}=f;
 h.env.PHOTOS=memory;
 const target=`preview/${owner.accountId}/${reservation.asset_id}/${complete.attempt_id}/synthetic-orphan`;
 await memory.put(target,new TextEncoder().encode('synthetic-held-preview'));
 await h.storage.exec("INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at,settled_at) VALUES(?,?, 'PHOTOS',?,'settled',?,?)",key(),owner.accountId,target,Date.now(),Date.now());
 await h.storage.exec("INSERT INTO cleanup_intents(id,subject_id,bucket,object_key,status,created_at) VALUES(?,?,'PHOTOS',?,'pending',?)",key(),owner.accountId,target,Date.now());
 const holdId=key();
 if(hold==='global'){
  await h.storage.exec("INSERT INTO retention_settings(id,version,raw_days,preview_days,face_crop_days,free_cache_days,audit_days,legal_hold,updated_at) VALUES('default',1,60,60,14,2,30,1,?) ON CONFLICT(id) DO UPDATE SET legal_hold=1",Date.now());
  assert.equal((await h.db.one("SELECT legal_hold FROM retention_settings WHERE id='default'")).legal_hold,1);
 }else if(hold==='asset'){
  await h.storage.exec('INSERT INTO asset_retention(asset_id,raw_expires_at,preview_expires_at,legal_hold,updated_at) VALUES(?,?,?,1,?) ON CONFLICT(asset_id) DO UPDATE SET legal_hold=1',reservation.asset_id,Date.now()+60000,Date.now()+60000,Date.now());
  assert.equal((await h.db.one('SELECT legal_hold FROM asset_retention WHERE asset_id=?',reservation.asset_id)).legal_hold,1);
 }else{
  await h.storage.exec('INSERT INTO moderation_holds(id,subject_id,asset_id,active,created_at,reason) VALUES(?,?,?,1,?,?)',holdId,hold==='subject-moderation'?owner.accountId:null,hold==='asset-moderation'?reservation.asset_id:null,Date.now(),'synthetic hold');
  assert.equal((await h.db.one('SELECT active FROM moderation_holds WHERE id=?',holdId)).active,1);
 }
 await within(h.db.invocation(()=>flushPrivacyCleanup(h.app)));
 assert(await memory.head(target),'held asset preview must remain in storage');
 const held=await facts(h,owner,'PHOTOS',target);assert.equal(held.cleanup.length,1);assert(held.cleanup.every(row=>row.status!=='verified'&&row.verified_at===null));
 if(hold==='global')await h.storage.exec("UPDATE retention_settings SET legal_hold=0 WHERE id='default'");
 else if(hold==='asset')await h.storage.exec('UPDATE asset_retention SET legal_hold=0 WHERE asset_id=?',reservation.asset_id);
 else await h.storage.exec('UPDATE moderation_holds SET active=0 WHERE id=?',holdId);
 await within(h.db.invocation(()=>flushPrivacyCleanup(h.app)));
 assert.equal(await memory.head(target),null);const released=await facts(h,owner,'PHOTOS',target);assert(released.cleanup.some(row=>row.status==='verified'));
});

pgliteTest('preview orphan with missing asset metadata is retained for reconciliation',{timeout:60000},async t=>{
 const {h,owner}=await setup(t),memory=h.env.PHOTOS,target=`preview/${owner.accountId}/${key()}/${key()}/${key()}`;
 await memory.put(target,new TextEncoder().encode('synthetic-unknown-preview'));
 await h.storage.exec("INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at,settled_at) VALUES(?,?,'PHOTOS',?,'settled',?,?)",key(),owner.accountId,target,Date.now(),Date.now());
 await h.storage.exec("INSERT INTO cleanup_intents(id,subject_id,bucket,object_key,status,created_at) VALUES(?,?,'PHOTOS',?,'pending',?)",key(),owner.accountId,target,Date.now());
 await within(h.db.invocation(()=>flushPrivacyCleanup(h.app)));
 assert(await memory.head(target));const state=await facts(h,owner,'PHOTOS',target);assert.equal(state.cleanup.length,1);assert(state.cleanup.every(row=>row.status!=='verified'&&row.verified_at===null));
});

pgliteTest('privacy export: active-window retry cannot clear an earlier uncertain writer',{timeout:60000},async t=>{
 const f=await exported(t,'ambiguous'),{h,owner,reviewer,request,fake,memory}=f;
 try{
  const response=await h.request(`/privacy-requests/${request.id}/process`,{token:reviewer.token,body:{}});assert(response.status>=500);await response.body?.cancel();
  assert.equal(fake.writes.length,1);const old=fake.writes[0].key,first=await facts(h,owner,'PRIVACY_EXPORTS',old),writer=first.writers[0];assert(writer);assert.equal(first.cleanup.length,1);const cleanupId=first.cleanup[0].id;
  // Maintenance is inside the actual request window and retries through the
  // application, with the later acknowledged upload using the owned bucket.
  assert(h.app.now()<f.expiresAt);const deleted=[],del=memory.delete.bind(memory);memory.delete=async value=>{deleted.push(...(Array.isArray(value)?value:[value]));return del(value);};h.env.PRIVACY_EXPORTS=memory;
  await within(h.db.invocation(()=>flushPrivacyCleanup(h.app)));
  const current=await exportPublication(h,request.id),prior=await facts(h,owner,'PRIVACY_EXPORTS',old);
  assert.equal(current.request.status,'completed');assert.notEqual(current.request.export_key,old);
  assert.equal(prior.writers[0]?.id,writer.id);assert.equal(prior.writers[0]?.status,'pending');assert.equal(prior.cleanup.length,1);assert.equal(prior.cleanup[0].id,cleanupId);assert(prior.cleanup.every(row=>row.status!=='verified'&&row.verified_at===null));assert(!deleted.includes(old),'active retry must not delete the uncertain old key');
  fake.mark('active-retry-before-release');await within(fake.release());assert(await memory.head(old));
  await within(h.db.invocation(()=>flushPrivacyCleanup(h.app)));const later=await facts(h,owner,'PRIVACY_EXPORTS',old);
  assert.equal(later.writers[0]?.status,'pending');assert.equal(later.cleanup.length,1);assert.equal(later.cleanup[0].id,cleanupId);assert(later.cleanup.every(row=>row.status!=='verified'&&row.verified_at===null));assert(await memory.head(old));assert(!deleted.includes(old));
  const grant=await h.json(`/privacy-exports/${request.id}/grant`,{token:owner.token,body:{}}),download=await h.request(grant.grant_path,{token:owner.token});
  assert.equal(download.status,200);assert.equal(JSON.parse(await download.text()).subject_user_id,owner.accountId);
 }finally{await within(fake.release());}
});

pgliteTest('generated preview: lost writer registration reply dispatches no PUT or DELETE',{timeout:60000},async t=>{
 const f=await photo(t,'acknowledged'),{h,owner,complete,fake}=f;
 const deletes=[],del=fake.bucket.delete.bind(fake.bucket);fake.bucket.delete=async value=>{deletes.push(value);return del(value);};
 const fault=loseCommitReply(h,'INSERT INTO media_write_intents');
 try{
  await assert.rejects(()=>within(processPhotoJob({attempt_id:complete.attempt_id},h.app)));assert(fault.injected());fault.restore();
  const writers=await h.storage.exec("SELECT object_key,status,settled_at FROM media_write_intents WHERE account_id=? AND bucket='PHOTOS' AND object_key LIKE 'preview/%'",owner.accountId);
  assert.equal(writers.length,1);assert.equal(writers[0].status,'pending');assert.equal(writers[0].settled_at,null);
  assert.equal(fake.writes.length,0);assert.deepEqual(deletes,[]);
 }finally{fault.restore();await within(fake.release());}
});

pgliteTest('privacy export: lost writer registration reply dispatches no PUT or cleanup',{timeout:60000},async t=>{
 const f=await exported(t,'acknowledged'),{h,owner,reviewer,request,fake}=f;
 const fault=loseCommitReply(h,'INSERT INTO media_write_intents');
 try{
  const response=await h.request(`/privacy-requests/${request.id}/process`,{token:reviewer.token,body:{}});
  assert(response.status>=500);await response.body?.cancel();assert(fault.injected());fault.restore();
  const rows=await h.storage.exec("SELECT object_key,status,settled_at FROM media_write_intents WHERE account_id=? AND bucket='PRIVACY_EXPORTS'",owner.accountId);
  assert.equal(rows.length,1);assert.equal(rows[0].status,'pending');assert.equal(rows[0].settled_at,null);assert.equal(fake.writes.length,0);
  const state=await facts(h,owner,'PRIVACY_EXPORTS',rows[0].object_key);assert.equal(state.cleanup.length,0);
  const grant=await h.request(`/privacy-exports/${request.id}/grant`,{token:owner.token,body:{}});assert.equal(grant.status,404);await grant.body?.cancel();
 }finally{fault.restore();await within(fake.release());}
});
