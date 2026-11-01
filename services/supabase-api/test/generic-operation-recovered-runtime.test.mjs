import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startHarness,enroll,faceVerifierFixture,stable} from './runtime-harness.mjs';
import {prepareOperation} from '../src/operations.ts';
import {restoreOperationID} from '../src/restore-transaction.ts';

const sources=['personal','notification','account','privacy','support','moderation','safety',
  'admin_users','audience','guardian','retention','media','store','queue_repair'];

test('generic operation lookup combines exact account-bound committed and recovered evidence',{timeout:45000},async t=>{
  const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});t.after(()=>h.close());
  const owner=await enroll(h),foreign=await enroll(h),key=()=>crypto.randomUUID();
  const lookup=(operationKey,expected=200,actor=owner)=>h.community(actor.token,'operation',{operation_key:operationKey},expected);
  async function terminal(source,operationKey=key(),actor=owner){
    const intent=await prepareOperation('fixture.recovered',{operation_key:operationKey},source);
    await h.db.run(`INSERT INTO restore_recovered_operations(operation_id,input_hash,plan_hash,outcome,recovered_at)
      VALUES(?,?,?,'restricted-abort',?)`,await restoreOperationID(actor.accountId,source,operationKey),intent.hash,'a'.repeat(64),Date.now());
    return operationKey;
  }
  async function committed(source,operationKey=key(),actor=owner,action='fixture.committed'){
    const payload={operation_key:operationKey},result={status:'committed',value:'synthetic-private-value'};
    const intent=await prepareOperation(action,payload,source);
    await h.db.run('INSERT INTO operations(actor_id,source,operation_key,action,payload_hash,payload_json,response_json,created_at) VALUES(?,?,?,?,?,?,?,?)',
      actor.accountId,source,operationKey,action,intent.hash,stable(payload),stable(result),Date.now());
    return {key:operationKey,result};
  }
  function error(value,code){assert.equal(value.error.code,code);assert(!JSON.stringify(value).includes('synthetic-private-value'));}

  await t.test('only-terminal outcomes resolve across every current generic source with one bounded exact probe',async()=>{
    const all=h.db.all.bind(h.db),probes=[];
    h.db.all=async(sql,...bindings)=>{
      if(sql.startsWith('SELECT operation_id,input_hash,plan_hash,outcome FROM restore_recovered_operations'))probes.push({sql,bindings});
      return all(sql,...bindings);
    };
    try{
      for(const source of sources.filter(source=>source!=='store')){
        const operationKey=await terminal(source);
        const value=await lookup(operationKey,409);error(value,'operation_recovered_without_result');
        const probe=probes.at(-1);
        assert.match(probe.sql,/WHERE operation_id IN \((?:\?,){13}\?\)$/);
        assert.equal(probe.bindings.length,sources.length);
        assert.deepEqual([...probe.bindings].sort(),(await Promise.all(sources.map(item=>restoreOperationID(owner.accountId,item,operationKey)))).sort());
      }
      assert.equal(probes.length,sources.length-1);
    }finally{h.db.all=all;}
  });

  await t.test('committed plus terminal and two-terminal sources are ambiguous without releasing a result',async()=>{
    for(const [committedSource,terminalSource] of [['personal','account'],['account','personal'],['legacy_source','queue_repair']]){
      const receipt=await committed(committedSource);await terminal(terminalSource,receipt.key);
      error(await lookup(receipt.key,409),'operation_source_ambiguous');
    }
    const operationKey=await terminal('notification');await terminal('privacy',operationKey);
    error(await lookup(operationKey,409),'operation_source_ambiguous');
    const same=await committed('personal');await terminal('personal',same.key);
    error(await lookup(same.key,503),'operation_receipt_unavailable');
    const both=await committed('personal');await committed('account',both.key);
    error(await lookup(both.key,409),'operation_source_ambiguous');
  });

  await t.test('terminal store outcomes retain typed-store exclusion including mixed-source keys',async()=>{
    const store=await terminal('store');error(await lookup(store,503),'store_operation_receipt_unavailable');
    error(await h.json('/me/store-operations',{token:owner.token,body:{operation_key:store}},409),'operation_recovered_without_result');
    assert.equal((await h.json('/me/store-operations',{token:foreign.token,body:{operation_key:store}})).status,'unknown');
    await committed('personal',store);error(await lookup(store,503),'store_operation_receipt_unavailable');
    const both=await terminal('account');await terminal('store',both);
    error(await lookup(both,503),'store_operation_receipt_unavailable');
    const committedStore=await committed('store',key(),owner,'store.google');
    error(await lookup(committedStore.key,503),'store_operation_receipt_unavailable');
  });

  await t.test('unknown and committed behavior remains compatible with legacy sources and lookup key formats',async()=>{
    for(const operationKey of [key(),'eightkey','x'.repeat(200),'legacy lookup with spaces'])
      assert.deepEqual(await lookup(operationKey),{status:'unknown'});
    for(const source of ['personal','legacy_source']){
      const receipt=await committed(source);assert.deepEqual(await lookup(receipt.key),receipt.result);
    }
    const receipt=await committed('personal');
    await h.db.run('UPDATE operations SET operation_key=? WHERE actor_id=? AND source=? AND operation_key=?',
      'old-key8',owner.accountId,'personal',receipt.key);
    assert.deepEqual(await lookup('old-key8'),receipt.result);
  });

  await t.test('foreign outcomes and receipts cannot disclose existence or conflict with the current account',async()=>{
    const operationKey=await terminal('account',key(),foreign);
    assert.deepEqual(await lookup(operationKey),{status:'unknown'});
    error(await lookup(operationKey,409,foreign),'operation_recovered_without_result');
    const receipt=await committed('personal',operationKey);
    assert.deepEqual(await lookup(operationKey),receipt.result);
    const foreignReceipt=await committed('privacy',key(),foreign);
    assert.deepEqual(await lookup(foreignReceipt.key),{status:'unknown'});
    await terminal('notification',foreignReceipt.key);
    error(await lookup(foreignReceipt.key,409),'operation_recovered_without_result');
    assert.deepEqual(await lookup(foreignReceipt.key,200,foreign),foreignReceipt.result);
  });

  await t.test('current session authority is rechecked before terminal, ambiguous, unknown, or committed results',async()=>{
    const terminalKey=await terminal('personal'),mixed=await committed('account');await terminal('notification',mixed.key);
    const saved=await committed('privacy');
    for(const operationKey of [terminalKey,mixed.key,key(),saved.key]){
      const all=h.db.all.bind(h.db);let revoked=false;
      h.db.all=async(sql,...bindings)=>{
        const rows=await all(sql,...bindings);
        if(!revoked&&sql.startsWith('SELECT operation_id,input_hash,plan_hash,outcome FROM restore_recovered_operations')){
          revoked=true;await h.db.run('UPDATE sessions SET revoked_at=? WHERE account_id=?',Date.now(),owner.accountId);
        }
        return rows;
      };
      try{await lookup(operationKey,401);assert.equal(revoked,true);}finally{h.db.all=all;}
      // The route transaction rolls back the synthetic concurrent revocation;
      // each next case starts with the same valid actor and isolates result type.
      assert.equal((await h.db.one('SELECT count(*) n FROM sessions WHERE account_id=? AND revoked_at IS NULL',owner.accountId)).n>0,true);
    }
    await h.db.run('UPDATE sessions SET revoked_at=? WHERE account_id=?',Date.now(),owner.accountId);
    await lookup(terminalKey,401);
    const anonymous=await h.anonymous();
    await h.community(anonymous.access_token,'operation',{operation_key:terminalKey},403);
  });
});
