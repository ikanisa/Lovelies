import test from 'node:test';
import assert from 'node:assert/strict';
import {createDemoStore,DEMO_STORAGE_KEY,DEMO_OPERATOR_ID} from './demo-store.mjs';

function memoryStorage() {
  const data = new Map();
  return {getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};
}

test('six reviews are actionable and snapshots cannot mutate the store',()=>{
  const store = createDemoStore(null);
  assert.equal(store.records().length,15);
  assert.equal(store.metrics().pendingReviews,6);
  assert.deepEqual([...new Set(store.records().map(row=>row.kind))].sort(),['privacy','safety','support','upload']);
  assert.equal(store.metrics().uploadsTotal,4);
  assert.equal(store.metrics().uploadsReady,2);
  store.records()[0].status = 'resolved';
  assert.equal(store.records()[0].status,'open');
  assert.equal(store.storageStatus,'memory');
});

test('support review persists across reloads and rejects later duplicate decisions',()=>{
  const storage = memoryStorage(), store = createDemoStore(storage);
  const started = store.update('support-001','start','Investigating the sample request.');
  assert.equal(started.record.status,'under_review');
  assert.equal(started.record.revision,2);
  assert.equal(started.persisted,true);
  const reloaded = createDemoStore(storage);
  const resolved = reloaded.update('support-001','reject','No missing approved share was found.');
  assert.equal(resolved.record.status,'resolved');
  assert.equal(resolved.record.reviewOutcome,'rejected');
  assert.equal(resolved.record.revision,3);
  assert.equal(reloaded.metrics().supportOpen,1);
  assert.throws(()=>reloaded.update('support-001','resolve','Another review.'),{code:'action_unavailable'});
  assert.equal(reloaded.activity()[0].action,'reject');
});

test('privacy approval queues the simulation and never erases or completes the account',()=>{
  const store = createDemoStore(memoryStorage());
  const result = store.update('privacy-001','approve','Independent review complete.');
  assert.equal(result.record.status,'queued');
  assert.equal(result.record.accountId,'Account 1037');
  assert.equal(store.records().length,15);
  assert.equal(result.record.approvalStatus,'approved');
  assert.equal(result.record.executionStatus,'queued');
  assert.equal(result.record.executionDetails.attemptCount,0);
  assert.equal(result.record.executionDetails.completedAt,null);
  assert.equal(store.metrics().privacyPending,1);
  assert.equal(store.metrics().pendingReviews,5);
  assert.throws(()=>store.update('privacy-001','approve','Retry the approval.'),{code:'action_unavailable'});
  assert.throws(()=>store.update('privacy-001','resolve','Erase the account.'),{code:'action_unavailable'});
});

test('safety holds stay actionable, then resolve without any recipient grants',()=>{
  const store = createDemoStore(memoryStorage());
  const held = store.update('safety-001','hold','Investigate the reported match.');
  assert.equal(held.record.status,'under_review');
  assert.equal(store.metrics().safetyOpen,2);
  const resolved = store.update('safety-001','resolve','Review of the sample report is complete.');
  assert.equal(resolved.record.status,'resolved');
  assert.equal(store.metrics().safetyOpen,1);
  assert.equal('grants' in resolved.record,false);
});

test('notes, terminal states, invalid actions, and uploads are guarded before mutation',()=>{
  const store = createDemoStore(memoryStorage()), before = store.records(), history = store.activity();
  assert.throws(()=>store.update('safety-001','resolve','  '),{code:'review_note_required'});
  assert.throws(()=>store.update('safety-001','resolve','x'.repeat(1001)),{code:'review_note_required'});
  assert.throws(()=>store.update('missing','resolve','A useful note.'),{code:'record_not_found'});
  assert.throws(()=>store.update('upload-001','approve','A useful note.'),{code:'action_unavailable'});
  assert.throws(()=>store.update('support-003','reject','A useful note.'),{code:'action_unavailable'});
  assert.throws(()=>store.update('safety-001','toString','A useful note.'),{code:'action_unavailable'});
  assert.deepEqual(store.records(),before);
  assert.deepEqual(store.activity(),history);
});

test('malformed or foreign stored content recovers only the synthetic fixture',()=>{
  for (const saved of ['{broken',JSON.stringify({version:2,records:[],activity:[]})]) {
    const storage = memoryStorage(); storage.setItem(DEMO_STORAGE_KEY,saved);
    const store = createDemoStore(storage);
    assert.equal(store.storageStatus,'recovered');
    assert.equal(store.metrics().pendingReviews,6);
  }
  const storage = memoryStorage(), store = createDemoStore(storage);
  const tampered = JSON.parse(storage.getItem(DEMO_STORAGE_KEY));
  tampered.records[0].accountId = 'Real person data';
  storage.setItem(DEMO_STORAGE_KEY,JSON.stringify(tampered));
  const recovered = createDemoStore(storage);
  assert.equal(recovered.storageStatus,'recovered');
  assert.equal(recovered.records()[0].accountId,'Account 1042');
  assert.equal(store.metrics().pendingReviews,6);
});

test('retired stored categories and their activity cannot reappear',()=>{
  for (const version of [1,2,3]) {
    const storage = memoryStorage(); createDemoStore(storage);
    const legacy = JSON.parse(storage.getItem(DEMO_STORAGE_KEY));
    legacy.version = version;
    legacy.records[0] = {...legacy.records[0],id:'photographer-001',kind:'photographer',title:'Retired application',status:'pending'};
    legacy.activity[0] = {...legacy.activity[0],recordId:'photographer-001',kind:'photographer',title:'Retired application'};
    storage.setItem(DEMO_STORAGE_KEY,JSON.stringify(legacy));
    const store = createDemoStore(storage);
    assert.equal(store.storageStatus,'recovered');
    assert.deepEqual([...new Set(store.records().map(row=>row.kind))].sort(),['privacy','safety','support','upload']);
    assert.equal(store.activity().some(item=>item.kind==='photographer'),false);
    assert.equal(storage.getItem(DEMO_STORAGE_KEY).includes('photographer'),false);
    assert.equal(JSON.parse(storage.getItem(DEMO_STORAGE_KEY)).version,3);
  }
});

test('denied reads and writes preserve in-memory work without claiming a save',()=>{
  const denied = {getItem(){throw new Error('Denied');},setItem(){throw new Error('Denied');}};
  const first = createDemoStore(denied);
  assert.equal(first.storageStatus,'memory');
  assert.equal(first.update('support-001','resolve','Sample sharing question answered.').persisted,false);
  assert.equal(first.metrics().supportOpen,1);
  const storage = memoryStorage(), store = createDemoStore(storage);
  storage.setItem = ()=>{throw new Error('Quota exceeded');};
  const result = store.update('privacy-002','reject','The sample request requires clarification.');
  assert.equal(result.persisted,false);
  assert.equal(store.storageStatus,'memory');
  assert.equal(result.record.status,'rejected');
  assert.equal(store.reset().persisted,false);
  assert.equal(store.metrics().pendingReviews,6);
});

test('reset restores fixtures and activity persistently',()=>{
  const storage = memoryStorage(), store = createDemoStore(storage);
  const original = store.activity();
  store.update('privacy-002','reject','More detail about the sample request is needed.');
  assert.equal(store.reset().persisted,true);
  const reloaded = createDemoStore(storage);
  assert.equal(reloaded.metrics().pendingReviews,6);
  assert.deepEqual(reloaded.activity(),original);
  assert.equal(reloaded.records().find(row=>row.id==='privacy-002').status,'pending_approval');
});

test('account details map existing records, preserve source separation, and expose no deleted profile metadata',()=>{
  const store = createDemoStore(null), users = store.users();
  assert.equal(users.length,14);
  for(const record of store.records()) assert.ok(store.user(record.accountId),record.accountId);
  assert.deepEqual([...new Set(users.filter(row=>row.status==='active').map(row=>row.role))].sort(),['admin','user']);
  assert.equal(store.user(DEMO_OPERATOR_ID).isCurrentOperator,true);
  const paused = store.user('Account 1086');
  assert.equal(paused.identityState,'registered_face');
  assert.equal(paused.matchingStatus,'paused');
  assert.equal(paused.faceProfile.status,'paused');
  assert.equal(store.user('Account 1033').identityState,'anonymous');
  assert.equal(store.user('Account 1033').matchingStatus,'absent');
  const deleted = store.user('Account 1099');
  assert.equal(deleted.name,'Deleted account');
  for(const field of ['role','identityState','createdAt','matchingStatus','faceProfile']) assert.equal(deleted[field],null);
  assert.deepEqual(deleted.sessions,[]);
  assert.equal(deleted.activeSessionCount,0);
  assert.equal(store.user('missing'),null);
  users[0].name='Changed outside store'; users[0].sessions[0].status='revoked';
  assert.equal(store.user(DEMO_OPERATOR_ID).name,'Alex Morgan');
  assert.equal(store.user(DEMO_OPERATOR_ID).sessions[0].status,'active');
});

test('single session revocation keeps unrelated sessions and records a durable sample-only reason',()=>{
  const storage = memoryStorage(), store = createDemoStore(storage), user = store.user('Account 1042');
  const target = user.sessions[0], before = store.records(), other = user.sessions[1];
  const result = store.revokeUserSession(user.id,target.id,'  The sample device was reported lost.  ',{expectedRevision:user.revision});
  assert.equal(result.persisted,true);
  assert.equal(result.user.revision,user.revision+1);
  assert.equal(result.user.sessions[0].status,'revoked');
  assert.ok(result.user.sessions[0].revokedAt);
  assert.deepEqual(result.user.sessions[1],other);
  assert.equal(result.user.activeSessionCount,user.activeSessionCount-1);
  assert.equal(result.activity.sessionId,target.id);
  assert.equal(result.activity.note,'The sample device was reported lost.');
  assert.deepEqual(store.records(),before);
  const reloaded = createDemoStore(storage);
  assert.deepEqual(reloaded.user(user.id),result.user);
  assert.equal(reloaded.storageStatus,'persistent');
  assert.throws(()=>reloaded.revokeUserSession(user.id,target.id,'Duplicate decision.'),{code:'session_unavailable'});
  assert.equal(reloaded.activity().filter(row=>row.action==='revoke_session').length,1);
});

test('session action rejects self, deleted, stale, invalid and expired targets before mutation',()=>{
  const storage = memoryStorage(), store = createDemoStore(storage), before = store.users(), history = store.activity();
  const user = store.user('Account 1042'), session = user.sessions[0];
  assert.throws(()=>store.revokeUserSession(DEMO_OPERATOR_ID,store.user(DEMO_OPERATOR_ID).sessions[0].id,'Self account.'),{code:'self_action_unavailable'});
  assert.throws(()=>store.revokeUserSession('Account 1099','missing','Deleted account.'),{code:'account_deleted'});
  assert.throws(()=>store.revokeUserSession('missing','missing','Unknown account.'),{code:'user_not_found'});
  assert.throws(()=>store.revokeUserSession(user.id,'missing','Unknown session.'),{code:'session_not_found'});
  assert.throws(()=>store.revokeUserSession(user.id,user.sessions[1].id,'Expired session.'),{code:'session_unavailable'});
  assert.throws(()=>store.revokeUserSession(user.id,session.id,'Valid reason.',{expectedRevision:0}),{code:'stale_revision'});
  for(const note of ['  ','x'.repeat(1001),'Invalid\u0000reason']) assert.throws(()=>store.revokeUserSession(user.id,session.id,note),{code:'review_note_required'});
  assert.deepEqual(store.users(),before); assert.deepEqual(store.activity(),history);
  const second = createDemoStore(storage);
  second.update('support-001','start','Review in another sample tab.');
  assert.throws(()=>store.revokeUserSession(user.id,session.id,'Changed workspace.'),{code:'stale_state'});
  assert.deepEqual(store.users(),before);
});

test('privacy approval and worker execution remain independent and each case has complete sample history',()=>{
  const store = createDemoStore(memoryStorage()), records = store.records();
  for(const record of records) {
    assert.ok(Object.keys(record.context).length>0);
    assert.ok(record.history.some(event=>event.action==='submitted'));
    assert.ok(record.history.every(event=>event.recordId===record.id));
  }
  const running = records.find(row=>row.id==='privacy-004'), failed = records.find(row=>row.id==='privacy-005');
  assert.equal(running.approvalStatus,'approved'); assert.equal(running.executionStatus,'running');
  assert.equal(running.executionDetails.completedAt,null);
  assert.equal(failed.approvalStatus,'approved'); assert.equal(failed.executionStatus,'failed');
  assert.ok(failed.executionDetails.lastErrorCode);
  assert.ok(failed.history.some(event=>event.action==='execution_failed'));
  assert.equal(store.metrics().privacyRunning,1); assert.equal(store.metrics().privacyFailed,1);
  for(const row of [running,failed]) assert.throws(()=>store.update(row.id,'approve','Another approval.'),{code:'action_unavailable'});
  const rejected = store.update('privacy-002','reject','The request needs clarification.').record;
  assert.equal(rejected.approvalStatus,'rejected'); assert.equal(rejected.executionStatus,'not_started');
  const upload = records.find(row=>row.id==='upload-004');
  assert.equal(upload.status,'failed'); assert.equal(upload.source,'personal');
  assert.equal(upload.processing.attemptCount,2); assert.ok(upload.processing.errorCode);
  assert.equal(upload.processing.retryEligible,false); assert.equal(upload.processing.nextRetryAt,null);
  assert.throws(()=>store.update(upload.id,'retry','Retry processing.'),{code:'action_unavailable'});
});

test('persisted user metadata, session changes, or missing audit evidence cannot become trusted sample state',()=>{
  for(const tamper of [
    value=>{value.users[1].name='Imported person';},
    value=>{value.users[1].role='photographer';},
    value=>{value.users[1].sessions[0].status='revoked';},
    value=>{value.records.find(row=>row.kind==='privacy').executionStatus='completed';},
    value=>{value.activity.pop();},
  ]) {
    const storage = memoryStorage();createDemoStore(storage);
    const state = JSON.parse(storage.getItem(DEMO_STORAGE_KEY));tamper(state);
    storage.setItem(DEMO_STORAGE_KEY,JSON.stringify(state));
    const recovered = createDemoStore(storage);
    assert.equal(recovered.storageStatus,'recovered');
    assert.equal(recovered.user('Account 1042').name,'Maya Reed');
    assert.equal(recovered.user('Account 1042').sessions[0].status,'active');
    assert.equal(recovered.metrics().pendingReviews,6);
  }
});

test('failed persistence reports memory-only session work and reset restores original accounts',()=>{
  const storage = memoryStorage(), store = createDemoStore(storage), original = store.users(), user = store.user('Account 1042');
  storage.setItem=()=>{throw new Error('Quota exceeded');};
  assert.equal(store.revokeUserSession(user.id,user.sessions[0].id,'Sample session no longer needed.').persisted,false);
  assert.equal(store.storageStatus,'memory');
  assert.equal(store.user(user.id).sessions[0].status,'revoked');
  store.reset();assert.deepEqual(store.users(),original);
});
