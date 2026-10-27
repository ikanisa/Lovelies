import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { startHarness, enroll, faceVerifierFixture, closeHarnesses } from './runtime-harness.mjs';
import { prepareOperation, retiredOperationResponse } from '../src/operations.ts';

after(closeHarnesses);
const localOnly=process.env.TEST_DATABASE_URL!==undefined;
const fixedRequest='00000000-0000-4000-8000-000000000001';
const operationKey=suffix=>`android-request-decision-${suffix}-${crypto.randomUUID()}`;

test('authenticated request-decision receipt binds stored canonical input and preserves generic lookup', {skip:localOnly}, async()=>{
  const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});
  try {
    const person=await enroll(h);const key=operationKey('recorded');
    const payload={request_id:fixedRequest,decision:'accept',operation_key:key};
    const intent=await prepareOperation('request.decide',payload,'personal');
    const result={source:'personal',request_id:fixedRequest,status:'accepted',available_count:1};
    const insert=async({operation=intent,action='request.decide',hash=operation.hash,input=operation.payloadJson,response=JSON.stringify(result)}={})=>
      h.storage.exec('INSERT INTO operations(actor_id,source,operation_key,action,payload_hash,payload_json,response_json,created_at) VALUES(?,?,?,?,?,?,?,?)',person.accountId,'personal',operation.key,action,hash,input,response,Date.now());
    await insert();
    const call=(k,expected=200)=>h.community(person.token,'request.decision-operation',{operation_key:k},expected);
    const receipt=await call(key);
    assert.deepEqual(receipt,{protocol:'lovelies-request-decision-operation-v1',status:'recorded',action:'request.decide',source:'personal',actor_id:person.accountId,operation_key:key,input_hash:intent.hash,result});
    assert.deepEqual(await h.community(person.token,'operation',{operation_key:key}),result);
    const raw=await h.request('/community/action',{token:person.token,body:{action:'request.decision-operation',payload:{operation_key:key}}});
    assert.equal(raw.status,200);assert(raw.headers.get('cache-control')?.split(',').map(value=>value.trim()).includes('no-store'));await raw.body?.cancel();
    const missing=operationKey('unknown');assert.deepEqual(await call(missing),{protocol:'lovelies-request-decision-operation-v1',status:'unknown',action:'request.decide',source:'personal',actor_id:person.accountId,operation_key:missing});
    const late=await prepareOperation('request.decide',{...payload,operation_key:missing},'personal');
    await insert({operation:late});assert.equal((await call(missing)).status,'recorded');
    const extraPayload={...payload,operation_key:operationKey('extra'),extra:'fixture'};
    const extra=await prepareOperation('request.decide',extraPayload,'personal');
    await insert({operation:extra,response:JSON.stringify({...result,internal_only:'not-returned'})});
    const extraReceipt=await call(extra.key);
    assert.equal(extraReceipt.input_hash,extra.hash);assert.deepEqual(extraReceipt.result,result);
    assert.notEqual(extraReceipt.input_hash,(await prepareOperation('request.decide',{...payload,operation_key:extra.key},'personal')).hash);
    await h.community(person.token,'request.decision-operation',{operation_key:key,extra:'unexpected'},400);
    await h.community(person.token,'request.decision-operation',{operation_key:'short'},400);
    await h.json('/community/action',{body:{action:'request.decision-operation',payload:{operation_key:key}}},401);

    const wrongAction=await prepareOperation('account.profile.update',{operation_key:operationKey('other'),name:'fixture'},'personal');
    await insert({operation:wrongAction,action:'account.profile.update',response:JSON.stringify({name:'fixture'})});
    const conflict=await call(wrongAction.key,409);assert.equal(conflict.error.code,'operation_key_conflict');
    const wrongHash=await prepareOperation('request.decide',{...payload,operation_key:operationKey('wronghash')},'personal');
    await insert({operation:wrongHash,hash:'0'.repeat(64)});const damaged=await call(wrongHash.key,503);assert.equal(damaged.error.code,'operation_receipt_unavailable');
    const wrongResult=await prepareOperation('request.decide',{...payload,operation_key:operationKey('wrongresult')},'personal');
    await insert({operation:wrongResult,response:JSON.stringify({...result,status:'declined'})});
    assert.equal((await call(wrongResult.key,503)).error.code,'operation_receipt_unavailable');
    const retired=await prepareOperation('request.decide',{...payload,operation_key:operationKey('retired')},'personal');
    await insert({operation:retired,input:'null',response:retiredOperationResponse});
    assert.equal((await call(retired.key,410)).error.code,'operation_receipt_retired');
    assert.equal((await h.storage.exec('SELECT COUNT(*) n FROM operations WHERE actor_id=? AND source=? AND operation_key IN(?,?,?,?,?,?,?)',person.accountId,'personal',key,missing,extra.key,wrongAction.key,wrongHash.key,wrongResult.key,retired.key))[0].n,7);

    await h.storage.exec('UPDATE sessions SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL',Date.now(),person.accountId);
    const revoked=await h.request('/community/action',{token:person.token,body:{action:'request.decision-operation',payload:{operation_key:key}}});
    assert.equal(revoked.status,401);await revoked.body?.cancel();
  } finally { await h.close(); }
});

test('canonical request-decision vector matches the Android fixture', async()=>{
  const p={request_id:'00000000-0000-4000-8000-000000000001',decision:'accept',operation_key:'android-11111111-1111-4111-8111-111111111111'};
  const intent=await prepareOperation('request.decide',p,'personal');
  assert.equal(intent.hash,'f76be055ac09859236f851f4aa8d181cec86b2c55b94e7b64d6edf38d2e6f6ae');
});
