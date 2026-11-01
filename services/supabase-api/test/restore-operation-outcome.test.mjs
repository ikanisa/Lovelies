import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {executeOperation,prepareOperation} from '../src/operations.ts';
import {restoreOperationID} from '../src/restore-transaction.ts';
import {ApiError} from '../src/types.ts';

test('recovered logical operation authenticates first and cannot re-enter its callback or accept changed input',async()=>{
 const actor={accountId:randomUUID(),sessionId:randomUUID(),roles:['user'],authMethod:'registered_face',authEpoch:1,expiresAt:9000000000000};
 const intent=await prepareOperation('preferences.update',{operation_key:randomUUID(),receive_matches:false});
 const operationID=await restoreOperationID(actor.accountId,intent.source,intent.key),trace=[];let valid=true,callbackCalls=0;
 const ctx={now:()=>1000,env:{},assertActor:async()=>{trace.push('authority');if(!valid)throw new ApiError(401,'session_invalid');},
  db:{transaction:async callback=>callback({operation:()=>trace.push('bind'),restrict:()=>{throw Error('unexpected_restriction');}}),one:async(sql,...bindings)=>{
   if(sql==='SELECT identity_state,disabled_at FROM accounts WHERE id=?'){trace.push('account');assert.equal(bindings[0],actor.accountId);return{identity_state:'registered_face',disabled_at:null};}
   if(sql==='SELECT input_hash FROM restore_recovered_operations WHERE operation_id=?'){trace.push('outcome');assert.equal(bindings[0],operationID);return{input_hash:intent.hash};}
   throw Error('callback_or_receipt_lookup_was_entered');
  }}};
 const callback=()=>{callbackCalls++;return{accepted:true};};
 await assert.rejects(executeOperation(ctx,actor,intent,callback),error=>error.status===410&&error.code==='operation_retired_by_recovery');
 assert.deepEqual(trace,['authority','account','outcome']);assert.equal(callbackCalls,0);
 trace.length=0;const changed=await prepareOperation('preferences.update',{operation_key:intent.key,receive_matches:true});
 await assert.rejects(executeOperation(ctx,actor,changed,callback),error=>error.status===409&&error.code==='operation_key_conflict');assert.equal(callbackCalls,0);
 trace.length=0;valid=false;await assert.rejects(executeOperation(ctx,actor,intent,callback),error=>error.code==='session_invalid');
 assert.deepEqual(trace,['authority']);assert.equal(callbackCalls,0);
});
