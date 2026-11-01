import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startHarness,enroll,captureProofs,faceVerifierFixture} from './runtime-harness.mjs';
import {pruneRetainedMetadata} from '../src/retention.ts';
import {prepareOperation,retiredOperationInput,retiredOperationResponse} from '../src/operations.ts';

test('bounded operator retention advances past malformed receipts and preserves identity and holds',async t=>{
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});t.after(()=>h.close());
 const admin=await enroll(h),staff=await enroll(h),DAY=86400000;
 await h.db.run('UPDATE accounts SET roles_json=? WHERE id=?','["user","admin"]',admin.accountId);
 const challenge=await h.json('/auth/face/challenge',{body:{face_handle:admin.faceHandle,device_id:admin.deviceId}},201);
 const auth=await h.json('/auth/face/complete',{body:await captureProofs(h,challenge,admin.keys.privateKey)});
 const body={capabilities:['support.read'],expires_at:new Date(h.app.now()+DAY).toISOString(),expected_revision:0,reason:'Synthetic private delegation review',operation_key:crypto.randomUUID()};
 const granted=await h.json(`/admin/operators/${staff.accountId}/capabilities`,{token:auth.access_token,body});
 const read=()=>h.db.one('SELECT * FROM operations WHERE operation_key=?',body.operation_key),original=await read();
 const malformed=await prepareOperation('operator.access.update',{account_id:admin.accountId,reason:'Unclassified earlier receipt',operation_key:crypto.randomUUID()},'operator_access');
 await h.db.run('INSERT INTO operations(actor_id,source,operation_key,action,payload_hash,payload_json,response_json,created_at) VALUES(?,?,?,?,?,?,?,?)',admin.accountId,malformed.source,malformed.key,malformed.action,malformed.hash,malformed.payloadJson,'{}',original.created_at-DAY);
 await pruneRetainedMetadata(h.app,1); // Installs the normal retention policy before applying its hold.
 const clock=h.app.now;h.app.now=()=>clock()+367*DAY;
 try{
  await h.db.run("UPDATE retention_settings SET legal_hold=1 WHERE id='default'");
  await pruneRetainedMetadata(h.app,1);assert.equal((await read()).payload_json,original.payload_json);
  await h.db.run("UPDATE retention_settings SET legal_hold=0 WHERE id='default'");
  await pruneRetainedMetadata(h.app,1);assert.equal((await read()).payload_json,original.payload_json,'the malformed earlier row consumes only its bounded scan');
  await pruneRetainedMetadata(h.app,1);
  const retired=await read();assert.equal(retired.payload_json,retiredOperationInput);assert.equal(retired.response_json,retiredOperationResponse);
  for(const field of ['actor_id','source','operation_key','action','payload_hash','created_at'])assert.equal(retired[field],original[field]);
  assert.equal((await h.db.one('SELECT payload_json FROM operations WHERE operation_key=?',malformed.key)).payload_json,malformed.payloadJson,'unknown evidence is preserved');
  assert.equal((await h.db.one('SELECT version FROM operator_access_versions WHERE account_id=?',staff.accountId)).version,granted.operator.revision,'the version cannot roll back after metadata retention');
  assert.equal((await h.db.one('SELECT count(*) n FROM operator_capability_grants WHERE account_id=?',staff.accountId)).n,0,'expired grants are minimized only after their original receipt');
  const cursor=await h.db.one("SELECT last_at,last_id FROM retention_scan_cursors WHERE scan='privacy' AND entity_id='operator-operation-copies-v1'");assert(cursor.last_id);
  await pruneRetainedMetadata(h.app,1);
  const wrapped=await h.db.one("SELECT last_at,last_id FROM retention_scan_cursors WHERE scan='privacy' AND entity_id='operator-operation-copies-v1'");assert.deepEqual(wrapped,{last_at:null,last_id:null});
 }finally{h.app.now=clock;}
});
