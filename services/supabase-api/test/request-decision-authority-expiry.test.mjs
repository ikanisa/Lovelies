import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {startHarness,enroll,faceVerifierFixture,closeHarnesses,stable} from './runtime-harness.mjs';
import {prepareOperation,retiredOperationResponse} from '../src/operations.ts';

after(closeHarnesses);
const localOnly=process.env.TEST_DATABASE_URL!==undefined;
const requestId='00000000-0000-4000-8000-000000000001';
const key=label=>`android-receipt-authority-${label}-${crypto.randomUUID()}`;
function gate(){let enter,release;const entered=new Promise(r=>enter=r),held=new Promise(r=>release=r);return {entered,enter,held,release};}
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('fixture_gate_timeout')),8000);})]);}finally{clearTimeout(timer);}}

test('operation-specific result or error requires authority after a delayed row/hash read',{skip:localOnly,timeout:60000},async t=>{
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});
 try {
  const person=await enroll(h);const base=Date.now();let now=base;h.app.now=()=>now;
  const session=(await h.storage.exec("SELECT id,expires_at FROM sessions WHERE account_id=? AND auth_method='registered_face' AND revoked_at IS NULL",person.accountId))[0];assert(session);
  const insert=async(label,{action='request.decide',hash,payloadJson,responseJson,decision='accept'}={})=>{
   const operationKey=key(label),payload={request_id:requestId,decision,operation_key:operationKey};
   const intent=await prepareOperation('request.decide',payload,'personal');
   await h.storage.exec('INSERT INTO operations(actor_id,source,operation_key,action,payload_hash,payload_json,response_json,created_at) VALUES(?,?,?,?,?,?,?,?)',person.accountId,'personal',operationKey,action,hash??intent.hash,payloadJson??intent.payloadJson,responseJson??JSON.stringify({source:'personal',request_id:requestId,status:'accepted',available_count:1}),base);
   return {operationKey,payload};
  };
  const wrongAction=await insert('wrong-action',{action:'account.profile.update'});
  const retired=await insert('retired',{payloadJson:'null',responseJson:retiredOperationResponse});
  const partial=await insert('partial-retirement',{payloadJson:'null'});
  const wrongHash=await insert('wrong-hash',{hash:'0'.repeat(64)});
  const badResult=await insert('bad-result',{responseJson:'[]'});
  const invalidDecision=await insert('non-string-decision',{decision:['accept']});
  const success=await insert('success');
  const missing={operationKey:key('unknown')};
  const branches=[['wrong action',wrongAction,409],['retired',retired,410],['partial retirement',partial,503],['wrong hash',wrongHash,503],['invalid result',badResult,503],['non-string decision',invalidDecision,503],['recorded success',success,200],['unknown',missing,200]];
  const call=operationKey=>h.request('/community/action',{token:person.token,body:{action:'request.decision-operation',payload:{operation_key:operationKey}}});
  const setAudience=async deadline=>h.storage.exec('UPDATE account_audience SET next_review_at=? WHERE account_id=?',deadline,person.accountId);
  for(const [name,fixture,status] of branches)await t.test(`${name} retains its ordinary response when authority remains current`,async()=>{now=base;await setAudience(null);const r=await call(fixture.operationKey);assert.equal(r.status,status);await r.body?.cancel();});
  async function delayedRow(fixture,authority){
   now=base;await setAudience(authority==='audience'?base+1000:null);const g=gate(),original=h.db.one;let hits=0;
   h.db.one=async function(sql,...bindings){const value=await original.call(this,sql,...bindings);if(sql.startsWith('SELECT action,payload_hash,payload_json,response_json FROM operations')&&bindings[2]===fixture.operationKey){hits++;g.enter();await g.held;}return value;};
   let request;try {request=call(fixture.operationKey);await bounded(g.entered);now=authority==='session'?session.expires_at:base+1001;g.release();const r=await bounded(request);const value=await r.json();assert.equal(hits,1);assert.equal(r.status,authority==='session'?401:403,JSON.stringify(value));assert.equal(value.error?.code,authority==='session'?'session_invalid':'audience_restricted');}
   finally{g.release();h.db.one=original;if(request)await request.catch(()=>{});now=base;await setAudience(null);}
  }
  for(const [name,fixture] of branches)for(const authority of ['session','audience'])await t.test(`${name} is withheld when ${authority} expires during SQL row lookup`,()=>delayedRow(fixture,authority));
  // Substitute same-subject authority query results only after the operation
  // row is selected. This exercises actual actor checks without writing inside
  // the read-only transaction or claiming a multi-pool concurrent writer.
  async function changedAuthority(fixture,authority){
   now=base;await setAudience(null);const original=h.db.one;let hits=0,overrides=0,armed=false;
   h.db.one=async function(sql,...bindings){const value=await original.call(this,sql,...bindings);
    if(sql.startsWith('SELECT action,payload_hash,payload_json,response_json FROM operations')&&bindings[2]===fixture.operationKey){hits++;armed=true;return value;}
    if(armed && authority==='session' && sql.startsWith('SELECT * FROM sessions WHERE id=? AND account_id=?') && bindings[0]===session.id && bindings[1]===person.accountId && value){overrides++;return {...value,revoked_at:base};}
    if(armed && authority==='audience' && sql.startsWith('SELECT * FROM account_audience WHERE account_id=?') && bindings[0]===person.accountId && value){overrides++;return {...value,status:'suspended'};}
    return value;};
   try {const r=await bounded(call(fixture.operationKey));const value=await r.json();assert.equal(hits,1);assert(overrides>=1);assert.equal(r.status,authority==='session'?401:403,JSON.stringify(value));assert.equal(value.error?.code,authority==='session'?'session_invalid':'audience_restricted');}
   finally {h.db.one=original;}
   const [sessionState]=await h.storage.exec('SELECT revoked_at FROM sessions WHERE id=? AND account_id=?',session.id,person.accountId);
   const [audienceState]=await h.storage.exec('SELECT status FROM account_audience WHERE account_id=?',person.accountId);
   assert.equal(sessionState.revoked_at,null);assert.equal(audienceState.status,'eligible');
  }
  for(const [name,fixture] of branches)for(const authority of ['session','audience'])await t.test(`${name} is withheld after injected ${authority} change`,()=>changedAuthority(fixture,authority));
  async function delayedHash(fixture,authority){
   now=base;await setAudience(authority==='audience'?base+1000:null);const expected=stable({action:'request.decide',source:'personal',payload:fixture.payload});const g=gate(),subtle=crypto.subtle;const original=subtle.digest;let hits=0;
   Object.defineProperty(subtle,'digest',{configurable:true,writable:true,value:async function(algorithm,data){const value=await original.call(this,algorithm,data);if(new TextDecoder().decode(data)===expected){hits++;g.enter();await g.held;}return value;}});
   let request;try {request=call(fixture.operationKey);await bounded(g.entered);now=authority==='session'?session.expires_at:base+1001;g.release();const r=await bounded(request);const value=await r.json();assert.equal(hits,1);assert.equal(r.status,authority==='session'?401:403,JSON.stringify(value));assert.equal(value.error?.code,authority==='session'?'session_invalid':'audience_restricted');}
   finally{g.release();delete subtle.digest;if(request)await request.catch(()=>{});now=base;await setAudience(null);}
  }
  for(const [name,fixture] of [['wrong hash',wrongHash],['recorded success',success]])for(const authority of ['session','audience'])await t.test(`${name} is withheld when ${authority} expires during asynchronous hash`,()=>delayedHash(fixture,authority));
 } finally {await h.close();}
});


test('status lookup uses the read-only adapter and never starts a mutation transaction',{skip:localOnly,timeout:30000},async()=>{
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});
 try {
  const person=await enroll(h),operationKey=key('read-only');
  const payload={request_id:requestId,decision:'accept',operation_key:operationKey};
  const intent=await prepareOperation('request.decide',payload,'personal');
  await h.storage.exec('INSERT INTO operations(actor_id,source,operation_key,action,payload_hash,payload_json,response_json,created_at) VALUES(?,?,?,?,?,?,?,?)',person.accountId,'personal',operationKey,'request.decide',intent.hash,intent.payloadJson,JSON.stringify({source:'personal',request_id:requestId,status:'accepted'}),Date.now());
  const prior=h.db.transaction;let transactions=0;
  h.db.transaction=async function(...args){transactions++;return await prior.apply(this,args);};
  try {
   for(const k of [operationKey,key('missing')]){const r=await h.request('/community/action',{token:person.token,body:{action:'request.decision-operation',payload:{operation_key:k}}});assert.equal(r.status,200);await r.body?.cancel();}
   assert.equal(transactions,0,'status read started a mutation transaction');
  } finally {h.db.transaction=prior;}
  await assert.rejects(h.db.read(()=>h.db.run('UPDATE accounts SET name=? WHERE id=?','changed',person.accountId)),error=>error.code==='read_only_transaction');
 } finally {await h.close();}
});
