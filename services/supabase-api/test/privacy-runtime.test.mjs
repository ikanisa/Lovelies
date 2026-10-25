import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { startHarness, enroll, prepareEnrollment, captureProofs, faceVerifierFixture, fixturePng, closeHarnesses } from './runtime-harness.mjs';

after(closeHarnesses);
const key=prefix=>`${prefix}-${crypto.randomUUID()}`;
async function administrator(h) {
  const person=await enroll(h);
  // Test-only SQL provisions the role; a fresh actual face login obtains the
  // signed role claim. No public request can elevate an account role.
  await h.storage.exec('UPDATE accounts SET roles_json=? WHERE id=?',JSON.stringify(['user','admin']),person.accountId);
  const challenge=await h.json('/auth/face/challenge',{body:{face_handle:person.faceHandle,device_id:person.deviceId}},201);
  const completion=await captureProofs(h,challenge,person.keys.privateKey);
  const credentials=await h.json('/auth/face/complete',{body:completion});
  assert(credentials.roles.includes('admin'));
  return {...person,token:credentials.access_token};
}
async function requestPrivacy(h,person,kind,operationKey=key('privacy-request')) {
  return (await h.json(kind==='delete'?'/privacy/account-deletion':'/privacy/export',{
    token:person.token,body:{operation_key:operationKey}},201)).privacy_request;
}
async function approve(h,admin,id) {
  return h.json(`/privacy-requests/${id}/approve`,{token:admin.token,body:{operation_key:key('independent-review')}});
}
async function waitFor(read,predicate,timeout=10_000) {
  const deadline=Date.now()+timeout;
  for (;;) {
    const value=await read();if(predicate(value))return value;
    if(Date.now()>=deadline)throw new Error(`timed out: ${JSON.stringify(value)}`);
    await new Promise(resolve=>setTimeout(resolve,20));
  }
}

test('actual anonymous authority cannot export; ownership and independent review remain enforced',async()=>{
  const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});
  try {
    const anonymous=await h.anonymous({adult:true});
    assert.equal((await h.json('/privacy/center',{token:anonymous.access_token})).consent_granted,false);
    const denied=await h.json('/privacy/export',{token:anonymous.access_token,body:{operation_key:key('anonymous')}},403);
    assert.equal(denied.error.code,'registered_face_required');
    const owner=await enroll(h),other=await enroll(h),admin=await administrator(h),operation=key('request-replay');
    const requested=await requestPrivacy(h,owner,'export',operation);
    assert.deepEqual(await requestPrivacy(h,owner,'export',operation),requested);
    await h.json('/privacy/export',{token:owner.token,body:{subject_user_id:other.accountId,operation_key:key('forged-subject')}},400);
    await h.json(`/privacy-requests/${requested.id}`,{token:other.token},404);
    await h.json(`/privacy-requests/${requested.id}/approve`,{token:owner.token,body:{operation_key:key('unauthorized-admin')}},403);
    const own=await requestPrivacy(h,admin,'delete');
    const self=await h.json(`/privacy-requests/${own.id}/approve`,{token:admin.token,body:{operation_key:key('self-approval')}},403);
    assert.equal(self.error.code,'independent_privacy_review_required');
    assert.equal((await h.json(`/privacy-requests/${requested.id}/approve`,{token:admin.token,body:{operation_key:key('restricted-admin')}},403)).error.code,'audience_restricted');
    await h.json('/privacy/center',{token:admin.token});
    const independent=await administrator(h);await approve(h,independent,requested.id);
    const queued=(await h.json(`/privacy-requests/${requested.id}`,{token:owner.token})).privacy_request;
    assert.equal(queued.status,'queued');
    const outbox=await h.storage.exec("SELECT payload_json FROM outbox WHERE category='privacy' AND entity_id=?",requested.id);
    assert.deepEqual(JSON.parse(outbox[0].payload_json),{request_id:requested.id});
    await h.json('/_internal/queue',{body:{category:'privacy',payload:{request_id:requested.id}},headers:{'x-lovelies-internal':'queue'}},404);
  } finally {await h.close();}
});

test('actual PostgreSQL/R2 export excludes peer/private data and releases a session-bound one-time verified artifact',async()=>{
  const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});
  try {
    const owner=await enroll(h),other=await enroll(h),admin=await administrator(h);
    await h.storage.exec('UPDATE accounts SET name=? WHERE id=?','Own name',owner.accountId);
    await h.storage.exec('INSERT INTO financial_records(id,account_id,record_type,data_json,created_at) VALUES(?,?,?,?,?)',crypto.randomUUID(),owner.accountId,'invoice',JSON.stringify({amount:125,currency:'USD',status:'paid',counterparty_name:'PRIVATE OTHER NAME',refresh_token:'PRIVATE TOKEN',storage_key:'PRIVATE KEY'}),Date.now());
    const snapshot=crypto.randomUUID();
    await h.storage.exec('INSERT INTO sharing_snapshots(id,owner_id,source,version,graph_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)',snapshot,owner.accountId,'personal',crypto.randomUUID(),JSON.stringify({recipients:[{id:other.accountId,name:'PRIVATE OTHER NAME'}],pairs:[]}),Date.now(),Date.now()+100000);
    const request=await requestPrivacy(h,owner,'export');await approve(h,admin,request.id);
    const processed=await h.json(`/privacy-requests/${request.id}/process`,{token:admin.token,body:{}});
    assert.equal(processed.privacy_request.status,'completed');
    const profile=(await h.storage.exec('SELECT template_key,template_digest FROM face_profiles WHERE account_id=?',owner.accountId))[0];
    const grant=await h.json(`/privacy-exports/${request.id}/grant`,{token:owner.token,body:{}});
    assert(!grant.grant_path.includes('r2'));assert(!('object_key' in grant));
    await h.json(grant.grant_path,{token:other.token},401);
    const challenge=await h.json('/auth/face/challenge',{body:{face_handle:owner.faceHandle,device_id:owner.deviceId}},201);
    const completion=await captureProofs(h,challenge,owner.keys.privateKey);
    const another=await h.json('/auth/face/complete',{body:completion});
    await h.json(grant.grant_path,{token:another.access_token},401);
    const download=await h.request(grant.grant_path,{token:owner.token});assert.equal(download.status,200);
    assert.equal(download.headers.get('cache-control'),'no-store, private');
    const text=await download.text(),data=JSON.parse(text);
    assert.equal(data.subject_user_id,owner.accountId);assert.equal(data.tables.account[0].name,'Own name');
    for(const forbidden of ['PRIVATE OTHER NAME','PRIVATE TOKEN','PRIVATE KEY',profile.template_key,profile.template_digest,'refresh_hash','public_jwk','graph_json'])assert(!text.includes(forbidden),forbidden);
    assert.deepEqual(data.tables.financial_records[0].data,{amount:125,currency:'USD',status:'paid'});
    await h.json(grant.grant_path,{token:owner.token},401);
    const exports=await h.storage.exec('SELECT object_key,status FROM privacy_exports WHERE request_id=?',request.id);
    assert.equal(exports[0].status,'retired');assert.equal(await (await h.mf.getR2Bucket('PRIVACY_EXPORTS')).head(exports[0].object_key),null);
    assert.equal((await h.storage.exec("SELECT count(*) n FROM cleanup_intents WHERE request_id=? AND status='verified'",request.id))[0].n,1);
  } finally {await h.close();}
});

test('tampered or expired actual R2 export cannot release private bytes and retains cleanup evidence',async()=>{
  const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});
  try {
    const owner=await enroll(h),admin=await administrator(h),request=await requestPrivacy(h,owner,'export');
    await approve(h,admin,request.id);await h.json(`/privacy-requests/${request.id}/process`,{token:admin.token,body:{}});
    const publication=(await h.storage.exec('SELECT export_key FROM privacy_requests WHERE id=?',request.id))[0];
    const grant=await h.json(`/privacy-exports/${request.id}/grant`,{token:owner.token,body:{}});
    await (await h.mf.getR2Bucket('PRIVACY_EXPORTS')).put(publication.export_key,'tampered-private-object');
    const denied=await h.json(grant.grant_path,{token:owner.token},503);assert.equal(denied.error.code,'privacy_export_unverified');
    assert.equal((await h.storage.exec("SELECT count(*) n FROM cleanup_intents WHERE request_id=? AND status='pending'",request.id))[0].n,1);
    await h.json(`/privacy-exports/${request.id}/grant`,{token:owner.token,body:{}},404);
    const expired=await requestPrivacy(h,owner,'export');await approve(h,admin,expired.id);
    await h.json(`/privacy-requests/${expired.id}/process`,{token:admin.token,body:{}});
    await h.storage.exec('UPDATE privacy_requests SET export_expires_at=? WHERE id=?',Date.now()-1,expired.id);
    await h.json(`/privacy-exports/${expired.id}/grant`,{token:owner.token,body:{}},404);
  } finally {await h.close();}
});

test('a legal hold prevents account disable and a pending private writer prevents false erasure completion',async()=>{
  const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});
  try {
    const owner=await enroll(h),admin=await administrator(h),request=await requestPrivacy(h,owner,'delete');
    await approve(h,admin,request.id);await h.storage.exec('UPDATE privacy_requests SET legal_hold=1 WHERE id=?',request.id);
    assert.equal((await h.json(`/privacy-requests/${request.id}/process`,{token:admin.token,body:{}},409)).error.code,'privacy_legal_hold');
    assert.equal((await h.storage.exec('SELECT disabled_at FROM accounts WHERE id=?',owner.accountId))[0].disabled_at,null);
    await h.storage.exec('UPDATE privacy_requests SET legal_hold=0 WHERE id=?',request.id);
    const beforeEpoch=(await h.storage.exec('SELECT auth_epoch FROM accounts WHERE id=?',owner.accountId))[0].auth_epoch;
    const writer=crypto.randomUUID(),privateKey='private/late-writer/'+crypto.randomUUID();
    await h.storage.exec('INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at) VALUES(?,?,?,?,?,?)',writer,owner.accountId,'PHOTOS',privateKey,'pending',Date.now());
    const pending=await h.json(`/privacy-requests/${request.id}/process`,{token:admin.token,body:{}},503);assert.equal(pending.error.code,'privacy_writer_unresolved');
    assert.equal((await h.storage.exec('SELECT status FROM privacy_requests WHERE id=?',request.id))[0].status,'failed');
    await h.json('/me',{token:owner.token},401);
    const bucket=await h.mf.getR2Bucket('PHOTOS');await bucket.put(privateKey,new Uint8Array([1,2,3]));
    await h.storage.exec("UPDATE media_write_intents SET status='settled',settled_at=? WHERE id=?",Date.now(),writer);
    const completed=await h.json(`/privacy-requests/${request.id}/process`,{token:admin.token,body:{}});assert.equal(completed.privacy_request.status,'completed');
    assert.equal(await bucket.head(privateKey),null);
    assert.equal((await h.storage.exec('SELECT count(*) n FROM sessions WHERE account_id=?',owner.accountId))[0].n,0);
    assert.equal((await h.storage.exec('SELECT auth_epoch FROM accounts WHERE id=?',owner.accountId))[0].auth_epoch,beforeEpoch+1);
  } finally {await h.close();}
});

function processorFixture(envelope) {
  return {attempt_id:envelope.attempt_id,nonce:envelope.nonce,asset_id:envelope.asset_id,
    source_version:envelope.source_version,source_checksum_sha256:envelope.source_checksum_sha256,model_version:envelope.model_version,engine_identity:envelope.engine_identity,
    preview:{bytes_base64:Buffer.from(fixturePng(envelope.asset_id)).toString('base64'),content_type:'image/png',width:1,height:1},
    matches:envelope.profiles.map(profile=>({recipient_id:profile.account_id,profile_id:profile.profile_id,profile_version:profile.revision,model_version:profile.model_id}))};
}
async function preferences(h,person) {
  await h.json('/me/photo-preferences',{token:person.token,body:{receive_matches:true,photo_matching_consent:true,processing_consent:true,policy_version:'photo-policy-fixture-v1',operation_key:key('preferences')}});
}

test('deleting Aline redacts her frozen graph/provenance while Eric keeps his exact accepted approval and protected bytes',async()=>{
  const h=await startHarness({faceVerifier:faceVerifierFixture,photoProcessor:processorFixture});
  try {
    const owner=await enroll(h),aline=await enroll(h),eric=await enroll(h),admin=await administrator(h);
    for(const person of [owner,aline,eric])await preferences(h,person);
    await h.storage.exec('UPDATE accounts SET name=? WHERE id=?','Aline',aline.accountId);await h.storage.exec('UPDATE accounts SET name=? WHERE id=?','Eric',eric.accountId);
    const bytes=fixturePng('privacy-source'),photo=await h.json('/uploads/session',{token:owner.token,body:{content_type:'image/png',byte_size:bytes.byteLength,source:'personal',operation_key:key('reserve')}},201);
    await h.json(photo.upload_url,{token:owner.token,raw:bytes,method:'PUT',headers:{'content-type':'image/png'}});
    await h.json(photo.complete_url,{token:owner.token,body:{operation_key:key('complete')}},202);
    await waitFor(()=>h.json(`/uploads/${photo.asset_id}/status`,{token:owner.token}),row=>row.status==='ready');
    const snapshot=(await h.community(owner.token,'sharing.snapshot',{asset_ids:[photo.asset_id],operation_key:key('snapshot')})).snapshot;
    assert.deepEqual(new Set(snapshot.recipients.map(person=>person.name)),new Set(['Aline','Eric']));
    const preview=(await h.community(owner.token,'sharing.preview',{snapshot_id:snapshot.id,snapshot_version:snapshot.version,draft_version:1,selected_asset_ids:[photo.asset_id],selected_recipient_ids:[aline.accountId,eric.accountId],excluded_pairs:[],operation_key:key('preview')})).preview;
    const operation=key('commit'),outcome=await h.community(owner.token,'sharing.commit',{preview_id:preview.id,preview_version:preview.version,draft_version:1,operation_key:operation});
    for(const person of [aline,eric])await h.community(person.token,'request.decide',{request_id:outcome.recipients.find(row=>row.recipient_id===person.accountId).request_id,decision:'accept',operation_key:key('accept')});
    const beforeApproval=await h.storage.exec('SELECT * FROM sharing_approvals WHERE recipient_id=?',eric.accountId),beforeGrant=await h.storage.exec('SELECT * FROM media_grants WHERE recipient_id=?',eric.accountId);
    await h.storage.exec('INSERT INTO financial_records(id,account_id,record_type,data_json,created_at) VALUES(?,?,?,?,?)',crypto.randomUUID(),aline.accountId,'invoice','{"amount":10}',Date.now());
    const request=await requestPrivacy(h,aline,'delete');await approve(h,admin,request.id);
    await waitFor(async()=>(await h.storage.exec('SELECT status,failure_code FROM privacy_requests WHERE id=?',request.id))[0],row=>row.status==='completed');
    assert.deepEqual(await h.storage.exec('SELECT * FROM sharing_approvals WHERE recipient_id=?',eric.accountId),beforeApproval);
    assert.deepEqual(await h.storage.exec('SELECT * FROM media_grants WHERE recipient_id=?',eric.accountId),beforeGrant);
    assert.equal((await h.storage.exec('SELECT count(*) n FROM sharing_approvals WHERE recipient_id=?',aline.accountId))[0].n,0);
    const graph=(await h.storage.exec('SELECT graph_json FROM sharing_snapshots WHERE id=?',snapshot.id))[0].graph_json;
    assert(!graph.includes('Aline'));assert(!graph.includes(aline.accountId));assert(graph.includes('Eric'));
    const source=(await h.storage.exec('SELECT pairs_json FROM sharing_previews WHERE id=?',preview.id))[0];
    assert.deepEqual(JSON.parse(source.pairs_json).map(pair=>pair.recipient_id),[eric.accountId]);
    const provenance=(await h.storage.exec('SELECT profiles_json,matches_json,status FROM processing_attempts WHERE asset_id=?',photo.asset_id))[0];
    assert.equal(provenance.status,'completed');assert(!provenance.profiles_json.includes(aline.accountId));assert(!provenance.matches_json.includes(aline.accountId));
    assert.equal((await h.request(`/community/media/${photo.asset_id}/preview`,{token:eric.token})).status,200);
    assert.deepEqual((await h.json('/me/gallery',{token:eric.token})).gallery_items.map(row=>row.media_asset_id),[photo.asset_id]);
    assert.equal((await h.community(owner.token,'operation',{operation_key:operation})).status,'unknown');
    await h.json('/me/gallery',{token:aline.token},401);
    assert.equal((await h.storage.exec('SELECT count(*) n FROM financial_records WHERE account_id=?',aline.accountId))[0].n,1);
    assert.equal((await h.storage.exec("SELECT count(*) n FROM cleanup_intents WHERE request_id=? AND status<>'verified'",request.id))[0].n,0);
  } finally {await h.close();}
});

const deletionToken=()=> 'lvd_'+crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
const deletionStatus=(h,status_token,expected=200)=>h.json('/privacy/account-deletion/status',{body:{status_token}},expected);
test('actual guest deletion is own-only, replay-bound and read-only with no face enrollment requirement',async()=>{
  const h=await startHarness({consumeQueue:false});
  try {
    const guest=await h.anonymous(),other=await h.anonymous(),token=deletionToken(),operation=key('guest-delete');
    const body={operation_key:operation,status_token:token};
    for(const malicious of [
      {...body,operation_key:token},
      {...body,operation_key:'delete:'+token},
      {...body,reason:token},
      {...body,reason:'Please erase '+token+' now'},
    ]) {
      await h.json('/privacy/account-deletion',{token:guest.access_token,body:malicious},400);
      for(const table of ['privacy_requests','privacy_deletion_status_receipts','operations','audit_events']) {
        assert.equal((await h.storage.exec('SELECT count(*) n FROM '+table))[0].n,0);
      }
    }
    const first=await h.json('/privacy/account-deletion',{token:guest.access_token,body},201);
    assert.equal(first.protocol,'lovelies-account-deletion-v1');assert.equal(first.source,'privacy');
    assert.equal(first.privacy_request.subject_user_id,guest.account_id);assert.equal(first.deletion_completed,false);
    assert.deepEqual(await h.json('/privacy/account-deletion',{token:guest.access_token,body},201),first);
    await h.json('/privacy/account-deletion',{token:guest.access_token,body:{...body,status_token:deletionToken()}},409);
    await h.json('/privacy/account-deletion',{token:other.access_token,body:{...body,operation_key:key('foreign-token')}},409);
    await h.json('/privacy/account-deletion',{token:guest.access_token,body:{...body,subject_user_id:other.account_id}},400);
    assert.equal((await h.storage.exec('SELECT count(*) n FROM privacy_requests'))[0].n,1);
    assert.equal((await h.storage.exec('SELECT count(*) n FROM face_profiles'))[0].n,0);
    assert.equal((await h.json(`/privacy-requests/${first.privacy_request.id}`,{token:guest.access_token})).privacy_request.status,'pending_approval');
    await h.json(`/privacy-requests/${first.privacy_request.id}`,{token:other.access_token},404);
    await h.json('/privacy/export',{token:guest.access_token,body:{operation_key:key('guest-export')}},403);
    await h.json('/community/action',{token:guest.access_token,body:{action:'photos',payload:{}}},403);
    await h.json(`/privacy-requests/${first.privacy_request.id}/approve`,{token:guest.access_token,body:{operation_key:key('guest-admin')}},403);
    await h.json('/privacy/account-deletion/status',{body:{status_token:token,request_id:first.privacy_request.id}},400);
    await h.json('/privacy/account-deletion/status?status_token='+token,{body:{status_token:token}},400);
    const status=await deletionStatus(h,token);assert.equal(status.operation_key,operation);
    const raw=JSON.stringify(await h.storage.exec('SELECT * FROM operations'));
    assert(!raw.includes(token));assert(raw.includes('status_token_hash'));
    await h.json('/me',{token:token},401);
    await h.storage.exec('UPDATE sessions SET revoked_at=? WHERE account_id=?',Date.now(),guest.account_id);
    await h.json('/privacy/account-deletion',{token:guest.access_token,body},401);
    assert.equal((await deletionStatus(h,token)).privacy_request.status,'pending_approval');
    const response=await h.request('/privacy/account-deletion/status',{body:{status_token:token}});
    assert.equal(response.headers.get('cache-control'),'no-store, private');
  } finally {await h.close();}
});

test('lost creation reply reconciles after actual pending-selfie R2 cleanup and session/operation erasure',async()=>{
  const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});
  try {
    const pending=await prepareEnrollment(h),admin=await administrator(h),token=deletionToken(),operation=key('lost-guest-reply');
    const proofRows=await h.storage.exec('SELECT p.object_key FROM auth_capture_proofs p JOIN auth_challenges c ON c.id=p.challenge_id WHERE c.account_id=?',pending.anonymous.account_id);
    assert.equal(proofRows.length,3);
    const creation=await h.request('/privacy/account-deletion',{token:pending.anonymous.access_token,body:{operation_key:operation,status_token:token}});
    assert.equal(creation.status,201);await creation.arrayBuffer(); // Deliberately discard the acknowledgement body.
    const request=(await h.storage.exec('SELECT id FROM privacy_requests WHERE subject_id=?',pending.anonymous.account_id))[0];
    await approve(h,admin,request.id);
    assert.equal((await deletionStatus(h,token)).deletion_completed,false);
    await h.json(`/privacy-requests/${request.id}/process`,{token:admin.token,body:{}});
    const finished=await deletionStatus(h,token);assert.equal(finished.privacy_request.status,'completed');assert.equal(finished.deletion_completed,true);
    assert.equal(finished.operation_key,operation);assert.equal(finished.privacy_request.id,request.id);
    assert.equal((await h.storage.exec('SELECT count(*) n FROM sessions WHERE account_id=?',pending.anonymous.account_id))[0].n,0);
    assert.equal((await h.storage.exec('SELECT count(*) n FROM operations WHERE actor_id=?',pending.anonymous.account_id))[0].n,0);
    const bucket=await h.mf.getR2Bucket('QUARANTINE');for(const row of proofRows)assert.equal(await bucket.head(row.object_key),null);
    assert.deepEqual(await h.storage.exec('SELECT c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=\'lovelies_private\' AND c.contype=\'f\' AND NOT c.convalidated'),[]);
    const text=JSON.stringify(finished);for(const forbidden of [token,pending.anonymous.account_id,admin.accountId,'subject_user_id','reason','reviewed_by','object_key','template'])assert(!text.includes(forbidden),forbidden);
    await h.json('/me',{token:pending.anonymous.access_token},401);
    await h.json(`/privacy-exports/${request.id}/grant`,{body:{status_token:token}},401);
  } finally {await h.close();}
});

test('guest receipt stays failed while a private writer is unresolved and becomes complete only after absent HEAD',async()=>{
  const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});
  try {
    const guest=await h.anonymous({adult:true}),admin=await administrator(h),token=deletionToken();
    const requested=await h.json('/privacy/account-deletion',{token:guest.access_token,body:{operation_key:key('guest-writer'),status_token:token}},201);
    const id=requested.privacy_request.id,writer=crypto.randomUUID(),objectKey='private/guest-pending/'+crypto.randomUUID();
    await h.storage.exec('INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at) VALUES(?,?,?,?,?,?)',writer,guest.account_id,'QUARANTINE',objectKey,'pending',Date.now());
    await approve(h,admin,id);
    assert.equal((await h.json(`/privacy-requests/${id}/process`,{token:admin.token,body:{}},503)).error.code,'privacy_writer_unresolved');
    const failed=await deletionStatus(h,token);assert.equal(failed.privacy_request.status,'failed');assert.equal(failed.deletion_completed,false);
    const bucket=await h.mf.getR2Bucket('QUARANTINE');await bucket.put(objectKey,new Uint8Array([2,3,4]));
    await h.storage.exec("UPDATE media_write_intents SET status='settled',settled_at=? WHERE id=?",Date.now(),writer);
    await h.json(`/privacy-requests/${id}/process`,{token:admin.token,body:{}});
    assert.equal(await bucket.head(objectKey),null);assert.equal((await deletionStatus(h,token)).deletion_completed,true);
  } finally {await h.close();}
});

test('valid guest receipt survives internal review deadline and distinguishes rejected/cancelled final outcomes',async()=>{
  const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});
  try {
    const guest=await h.anonymous({adult:true}),admin=await administrator(h),token=deletionToken();
    const creation=await h.json('/privacy/account-deletion',{token:guest.access_token,body:{operation_key:key('guest-expiry'),status_token:token}},201),id=creation.privacy_request.id;
    await h.storage.exec('UPDATE privacy_requests SET expires_at=? WHERE id=?',Date.now()-1,id);
    const expired=await deletionStatus(h,token);assert.equal(expired.request_expired,false);assert.equal(expired.deletion_completed,false);
    assert.equal((await h.json('/me',{token:guest.access_token})).auth_method,'anonymous');
    await h.storage.exec("UPDATE privacy_requests SET status='cancelled' WHERE id=?",id);
    const cancelled=await deletionStatus(h,token);assert.equal(cancelled.privacy_request.status,'cancelled');assert.equal(cancelled.deletion_completed,false);
    await h.storage.exec("UPDATE privacy_requests SET status='pending_approval',expires_at=? WHERE id=?",Date.now()+100000,id);
    await h.json(`/privacy-requests/${id}/reject`,{token:admin.token,body:{operation_key:key('reject-guest'),reason:'Fixture review rejection'}});
    const rejected=await deletionStatus(h,token);assert.equal(rejected.privacy_request.status,'rejected');assert.equal(rejected.deletion_completed,false);
    await h.storage.exec('UPDATE privacy_deletion_status_receipts SET expires_at=? WHERE request_id=?',Date.now()-1,id);
    const unavailable=await deletionStatus(h,token,404),unknown=await deletionStatus(h,deletionToken(),404);
    assert.deepEqual(unavailable,unknown);assert.equal(unavailable.error.code,'deletion_status_unavailable');
  } finally {await h.close();}
});
