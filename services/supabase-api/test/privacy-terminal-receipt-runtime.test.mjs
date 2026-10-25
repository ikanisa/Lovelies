import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {startHarness,enroll,captureProofs,faceVerifierFixture,closeHarnesses} from './runtime-harness.mjs';

after(closeHarnesses);
const DAY=86400000,operation=()=>crypto.randomUUID();
const deletionToken=()=> 'lvd_'+crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');

async function administrator(h){
  const person=await enroll(h);
  await h.storage.exec('UPDATE accounts SET roles_json=? WHERE id=?',JSON.stringify(['user','admin']),person.accountId);
  const challenge=await h.json('/auth/face/challenge',{body:{face_handle:person.faceHandle,device_id:person.deviceId}},201);
  const credentials=await h.json('/auth/face/complete',{body:await captureProofs(h,challenge,person.keys.privateKey)});
  assert(credentials.roles.includes('admin'));
  return {...person,token:credentials.access_token};
}

async function overdueDeletion(h){
  const guest=await h.anonymous({adult:true}),token=deletionToken();
  const created=await h.json('/privacy/account-deletion',{token:guest.access_token,body:{operation_key:operation(),status_token:token}},201);
  const id=created.privacy_request.id,now=Date.now();
  await h.storage.exec('UPDATE privacy_requests SET created_at=?,expires_at=? WHERE id=?',now-40*DAY,now-10*DAY,id);
  await h.storage.exec('UPDATE privacy_deletion_status_receipts SET created_at=?,expires_at=? WHERE request_id=?',now-40*DAY,now-10*DAY,id);
  return {id,token};
}

for(const finalState of ['rejected','completed'])test(`terminal deletion receipt ${finalState}: atomic thirty-day window survives cleanup failure, rollback and exact retry without reviving revoked receipts`,async()=>{
  const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});
  const run=h.db.run.bind(h.db);
  try{
    const admin=await administrator(h),request=await overdueDeletion(h),reviewKey=operation();
    let injectAtomicFailure=true,atomicFailures=0;
    h.db.run=async(sql,...bindings)=>{
      if(sql.startsWith('UPDATE privacy_deletion_status_receipts SET expires_at=(SELECT'))throw new Error('fixture_best_effort_normalization_unavailable');
      if(sql.startsWith('UPDATE privacy_deletion_status_receipts SET expires_at=?')&&injectAtomicFailure){
        injectAtomicFailure=false;atomicFailures++;throw new Error('fixture_atomic_receipt_write_unavailable');
      }
      return run(sql,...bindings);
    };
    const finish=async(target,key)=>{
      if(finalState==='rejected')return h.request(`/privacy-requests/${target.id}/reject`,{token:admin.token,body:{operation_key:key,reason:'Independent controlled fixture rejection'}});
      const row=await h.db.one('SELECT status FROM privacy_requests WHERE id=?',target.id);
      if(row.status==='pending_approval')await h.json(`/privacy-requests/${target.id}/approve`,{token:admin.token,body:{operation_key:key}});
      return h.request(`/privacy-requests/${target.id}/process`,{token:admin.token,body:{}});
    };
    assert.equal((await h.request('/privacy/account-deletion/status',{body:{status_token:request.token}})).status,200);
    const failed=await finish(request,reviewKey);assert.equal(failed.status,500);await failed.body?.cancel();
    assert.equal(atomicFailures,1);
    const afterFailure=await h.db.one('SELECT status FROM privacy_requests WHERE id=?',request.id);
    assert.equal(afterFailure.status,finalState==='rejected'?'pending_approval':'failed','Terminal status and receipt must commit together');
    assert.equal((await h.request('/privacy/account-deletion/status',{body:{status_token:request.token}})).status,200,'Unconfirmed processing remains trackable');
    const retry=await finish(request,reviewKey);assert.equal(retry.status,200);await retry.body?.cancel();
    const final=await h.db.one('SELECT status,reviewed_at,completed_at FROM privacy_requests WHERE id=?',request.id);
    const receipt=await h.db.one('SELECT expires_at,revoked_at FROM privacy_deletion_status_receipts WHERE request_id=?',request.id);
    const terminalAt=finalState==='completed'?final.completed_at:final.reviewed_at;
    assert.equal(final.status,finalState);assert.equal(receipt.expires_at,terminalAt+30*DAY);assert.equal(receipt.revoked_at,null);
    const status=await h.json('/privacy/account-deletion/status',{body:{status_token:request.token}});
    assert.equal(status.privacy_request.status,finalState);assert.equal(status.deletion_completed,finalState==='completed');
    assert.equal(Date.parse(status.deletion_status.expires_at),receipt.expires_at);
    if(finalState==='rejected'){
      const replay=await finish(request,reviewKey);assert.equal(replay.status,200);await replay.body?.cancel();
      assert.equal((await h.db.one('SELECT expires_at FROM privacy_deletion_status_receipts WHERE request_id=?',request.id)).expires_at,receipt.expires_at,'Exact review replay must not extend the final clock');
    }
    const revoked=await overdueDeletion(h),revokedAt=Date.now();
    await h.storage.exec('UPDATE privacy_deletion_status_receipts SET revoked_at=? WHERE request_id=?',revokedAt,revoked.id);
    const old=await h.db.one('SELECT expires_at FROM privacy_deletion_status_receipts WHERE request_id=?',revoked.id);
    const ended=await finish(revoked,operation());assert.equal(ended.status,200);await ended.body?.cancel();
    const unchanged=await h.db.one('SELECT expires_at,revoked_at FROM privacy_deletion_status_receipts WHERE request_id=?',revoked.id);
    assert.equal(unchanged.revoked_at,revokedAt);assert.equal(unchanged.expires_at,old.expires_at);
    await h.json('/privacy/account-deletion/status',{body:{status_token:revoked.token}},404);
  }finally{h.db.run=run;await h.close();}
});
