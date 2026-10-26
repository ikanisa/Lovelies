/** Actual API handlers and synthetic same-device sessions; no provider sends. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {startHarness,enroll,faceVerifierFixture,captureProofs,sign,encode,stable} from './runtime-harness.mjs';
import {sessionRetirementScope} from '../src/session-retirement.ts';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const rowHash=rows=>hash(stable(rows));
const protocol='lovelies-refresh-delivery-v1',deviceProtocol='lovelies-face-profile-device-v1';
const sessionID=token=>JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString()).jti;
const capability=person=>({protocol,rotation_key:randomUUID(),delivery_secret:encode(crypto.getRandomValues(new Uint8Array(32))),refresh_token:person.refresh_token});
async function login(h,person){
  const challenge=await h.json('/auth/face/challenge',{body:{face_handle:person.faceHandle,device_id:person.deviceId}},201);
  return h.json('/auth/face/complete',{body:await captureProofs(h,challenge,person.keys.privateKey)});
}
async function peerPending(h,person,token){
  const controlKey='lfl_'+encode(crypto.getRandomValues(new Uint8Array(32)));
  const signed=async(step,fields,creation=false)=>{
    const body={account_id:person.accountId,device_id:person.deviceId,control_key:controlKey,
      ...(!creation?{request_nonce:randomUUID(),request_expires_at:Date.now()+45000}:{}),...fields};
    return {...body,device_signature:await sign(person.keys.privateKey,{protocol:deviceProtocol,step,...body})};
  };
  await h.json('/auth/face/profile/control',{token,body:await signed('control',{control_operation_key:randomUUID()},true)},201);
  const state=await h.db.one('SELECT version FROM face_profile_states WHERE account_id=?',person.accountId),key=randomUUID();
  await h.json('/auth/face/profile/challenge',{body:await signed('challenge',{operation_key:key,action:'replace',expected_version:state.version,
    consent:{purpose:'face_authentication',policy_version:'face-policy-fixture-v1',granted:true}})},201);
  const op=await h.db.one('SELECT * FROM face_profile_operations WHERE account_id=? AND operation_key=?',person.accountId,key);
  assert(op&&op.state==='pending'&&op.consent_id&&op.challenge_id);
  return op;
}
async function seedNotifications(h,person,push){
  const row=await h.db.one('SELECT * FROM push_devices WHERE id=?',push.id);assert(row&&row.active===1&&row.token_value);
  // These are explicitly synthetic queued/accepted catalog states. No provider
  // receipt, accepted send or actual notification delivery is established.
  for(const status of ['queued','accepted']){
    const notification=randomUUID();
    await h.db.run("INSERT INTO notifications(id,account_id,kind,entity_id,title,created_at) VALUES(?,?,'support',?,'Synthetic refresh peer preservation',?)",notification,person.accountId,randomUUID(),h.app.now());
    await h.db.run('INSERT INTO notification_deliveries(id,notification_id,device_id,operation_key,status,token_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',randomUUID(),notification,push.id,randomUUID(),status,row.token_hash,h.app.now(),h.app.now());
  }
}
const tables=['sessions','auth_devices','face_profiles','face_profile_controls','face_profile_operations','auth_challenges','consents','push_devices','notification_deliveries','refresh_delivery_receipts'];
async function snapshot(h){
  const value={};for(const table of tables)value[table]=await h.db.all('SELECT * FROM '+table+' ORDER BY '+(table==='face_profiles'?'account_id':table==='face_profile_controls'?'account_id,device_id':table==='face_profile_operations'?'account_id,operation_key':table==='refresh_delivery_receipts'?'original_session_id':'id'));
  return value;
}
for(const lifecycle of [false,true])test('saved refresh cancellation preserves an unconsumed successor peer and its push'+(lifecycle?' plus actual pending lifecycle':' without pending controls'),{skip:!process.env.TEST_DATABASE_URL},async t=>{
  const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});
  t.after(async()=>{await h.close();});
  assert(h.databaseUrl,'Native PostgreSQL database must be allocated');
  const person=await enroll(h),first=capability(person),issued=await h.json('/auth/session/refresh',{body:first});
  const saved=await h.db.one('SELECT * FROM refresh_delivery_receipts WHERE original_session_id=?',sessionID(person.access_token));
  assert(saved&&saved.state==='active'&&saved.successor_session_id===sessionID(issued.access_token));
  const peer=await login(h,person),targetID=saved.successor_session_id,peerID=sessionID(peer.access_token);
  assert.notEqual(targetID,peerID);
  const target=await h.db.one('SELECT * FROM sessions WHERE id=?',targetID),peerRow=await h.db.one('SELECT * FROM sessions WHERE id=?',peerID);
  assert.equal(target.revoked_at,null);assert.equal(target.refresh_consumed_at,null);
  assert.equal(peerRow.revoked_at,null);assert.equal(peerRow.refresh_consumed_at,null);
  for(const field of ['account_id','device_id','device_revision','auth_epoch'])assert.equal(target[field],peerRow[field]);
  assert.equal(target.device_id,person.deviceId);
  const push=await h.json('/me/push-devices',{token:peer.access_token,body:{platform:'ios',push_token:'synthetic-refresh-peer-push-'+randomUUID(),operation_key:randomUUID()}});
  await seedNotifications(h,person,push);
  const pending=lifecycle?await peerPending(h,person,peer.access_token):null;
  const scope=await sessionRetirementScope(h.app,target);
  if(lifecycle){assert.equal(scope.cancelDeviceLifecycle,false);assert(scope.peers.some(row=>row.id===peerID));}
  else{
    assert.equal(scope.controls.length,0);
    assert.equal((await h.db.one("SELECT count(*) n FROM face_profile_operations WHERE account_id=? AND state='pending'",person.accountId)).n,0);
    assert.equal((await h.db.one('SELECT count(*) n FROM face_profile_controls WHERE account_id=?',person.accountId)).n,0);
    // The domain precondition is a real live peer even without any pending
    // lifecycle row. Do not require the helper to keep its conditional query.
    assert(await h.db.one('SELECT id FROM sessions WHERE id=? AND revoked_at IS NULL',peerID));
  }
  const before=await snapshot(h);
  const response=await h.request('/auth/session/refresh/cancel',{body:first}),reply=await response.json(),after=await snapshot(h);
  const preservation=Object.fromEntries(tables.map(table=>[table,{before:rowHash(before[table]),after:rowHash(after[table]),unchanged:rowHash(before[table])===rowHash(after[table])}]));
  const afterTarget=after.sessions.find(row=>row.id===targetID),afterPeer=after.sessions.find(row=>row.id===peerID),afterPush=after.push_devices.find(row=>row.id===push.id);
  const afterPending=pending?after.face_profile_operations.find(row=>row.operation_key===pending.operation_key):null;
  t.diagnostic(JSON.stringify({case:lifecycle?'pending_lifecycle':'no_pending_controls',http_status:response.status,
    original_successor_was_unconsumed:true,target_retired:afterTarget?.revoked_at!==null,peer_revoked:afterPeer?.revoked_at!==null,
    peer_push_active:afterPush?.active,peer_push_token_cleared:afterPush?.token_value==='',
    pending_state:afterPending?.state??null,selected_scope_peer_count:scope.peers.length,rows:preservation}));
  assert.equal(response.status,200);
  assert.deepEqual(reply,{protocol,rotation_key:first.rotation_key,account_id:person.accountId,status:'cancelled'});
  assert(afterTarget&&afterTarget.revoked_at!==null&&afterTarget.refresh_consumed_at!==null,'Only the selected successor must retire');
  assert.equal(rowHash(after.sessions.filter(row=>row.id!==targetID)),rowHash(before.sessions.filter(row=>row.id!==targetID)),'Every non-target session, including the real same-device peer, must survive');
  const receipt=after.refresh_delivery_receipts.find(row=>row.original_session_id===saved.original_session_id);
  assert(receipt&&receipt.state==='cancelled'&&receipt.ciphertext===null&&receipt.iv===null);
  if(lifecycle){
    for(const table of ['face_profile_operations','auth_challenges','consents'])assert.equal(rowHash(after[table]),rowHash(before[table]),'Peer-owned '+table+' must survive exact refresh cancellation');
  }
  for(const table of ['push_devices','notification_deliveries','auth_devices','face_profiles','face_profile_controls'])assert.equal(rowHash(after[table]),rowHash(before[table]),'Peer-owned '+table+' must remain byte-equivalent');
  await h.json('/me',{token:peer.access_token});
  const terminal=await snapshot(h);
  assert.deepEqual(await h.json('/auth/session/refresh/cancel',{body:first}),reply);
  assert.equal(rowHash(await snapshot(h)),rowHash(terminal),'Repeated exact cancellation is effect-free');
});

for(const changed of ['exclusive','revision','foreign','epoch'])test('saved refresh cancellation '+(changed==='exclusive'?'cleans an exclusive current device push':'preserves push for '+changed+' authority'),{skip:!process.env.TEST_DATABASE_URL},async t=>{
  const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});t.after(()=>h.close());
  const person=await enroll(h),first=capability(person),issued=await h.json('/auth/session/refresh',{body:first});
  const push=await h.json('/me/push-devices',{token:issued.access_token,body:{platform:'ios',push_token:'synthetic-exclusive-push-'+randomUUID(),operation_key:randomUUID()}});
  await seedNotifications(h,person,push);
  if(changed==='revision')await h.db.run('UPDATE auth_devices SET revision=? WHERE id=?',randomUUID(),person.deviceId);
  if(changed==='foreign'){
    const foreign=await h.anonymous({adult:true});await h.db.run('UPDATE auth_devices SET account_id=? WHERE id=?',foreign.account_id,person.deviceId);
  }
  if(changed==='epoch')await h.db.run('UPDATE accounts SET auth_epoch=auth_epoch+1 WHERE id=?',person.accountId);
  const before=await snapshot(h);await h.json('/auth/session/refresh/cancel',{body:first});const after=await snapshot(h);
  assert.notEqual(after.sessions.find(row=>row.id===sessionID(issued.access_token)).revoked_at,null);
  if(changed!=='exclusive'){
    assert.equal(rowHash(after.push_devices),rowHash(before.push_devices));
    assert.equal(rowHash(after.notification_deliveries),rowHash(before.notification_deliveries));
  }else{
    const row=after.push_devices.find(value=>value.id===push.id);assert.equal(row.active,0);assert.equal(row.token_value,'');
    assert.deepEqual(after.notification_deliveries.map(value=>value.status).sort(),['accepted','cancelled']);
  }
});

test('pre-dispatch cancellation cleans its sole current session lifecycle and push', {skip:!process.env.TEST_DATABASE_URL}, async t=>{
  const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});t.after(()=>h.close());
  const person=await enroll(h),first=capability(person);
  const push=await h.json('/me/push-devices',{token:person.access_token,body:{platform:'ios',push_token:'synthetic-first-push-'+randomUUID(),operation_key:randomUUID()}});
  await seedNotifications(h,person,push);const pending=await peerPending(h,person,person.access_token);
  await h.json('/auth/session/refresh/cancel',{body:first});
  assert.notEqual((await h.db.one('SELECT revoked_at FROM sessions WHERE id=?',sessionID(person.access_token))).revoked_at,null);
  assert.equal((await h.db.one('SELECT state FROM face_profile_operations WHERE operation_key=?',pending.operation_key)).state,'cancelled');
  assert.equal((await h.db.one('SELECT status FROM auth_challenges WHERE id=?',pending.challenge_id)).status,'cancelled');
  assert.equal((await h.db.one('SELECT status FROM consents WHERE id=?',pending.consent_id)).status,'revoked');
  const registered=await h.db.one('SELECT active,token_value FROM push_devices WHERE id=?',push.id);assert.equal(registered.active,0);assert.equal(registered.token_value,'');
  const deliveries=await h.db.all('SELECT status FROM notification_deliveries WHERE device_id=? ORDER BY status',push.id);
  assert.deepEqual(deliveries.map(row=>row.status),['accepted','cancelled']);
});
