/** Synthetic single-subject generic-operation controls; no provider or network. */
import assert from 'node:assert/strict';
import {after,test as nodeTest} from 'node:test';
import {randomUUID} from 'node:crypto';
import {startHarness,enroll,faceVerifierFixture,closeHarnesses} from './runtime-harness.mjs';
import {retiredOperationResponse} from '../src/operations.ts';
const test=process.env.TEST_DATABASE_URL === undefined ? nodeTest : nodeTest.skip;
const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw Error('external_fetch_prohibited');};
after(async()=>{globalThis.fetch=originalFetch;await closeHarnesses();});
async function setup(t){
  const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});t.after(()=>h.close());
  const owner=await enroll(h),key='android-'+randomUUID();
  async function insert(source,action,response,input='{}'){
    await h.storage.exec('INSERT INTO operations(actor_id,source,operation_key,action,payload_hash,payload_json,response_json,created_at) VALUES(?,?,?,?,?,?,?,?)',owner.accountId,source,key,action,'a'.repeat(64),input,response,Date.now());
  }
  async function lookup(expected=200){return h.community(owner.token,'operation',{operation_key:key},expected);}
  return {h,owner,key,insert,lookup};
}
async function unavailable(f){const value=await f.lookup(503);assert.equal(value.error.code,'store_operation_receipt_unavailable');assert(!JSON.stringify(value).includes('synthetic-private-token'));}

test('generic lookup does not release an intact store receipt',{timeout:30000},async t=>{
  const f=await setup(t);await f.insert('store','store.google',JSON.stringify({token:'synthetic-private-token'}));await unavailable(f);
});
test('generic lookup does not classify a retired store receipt as definitive',{timeout:30000},async t=>{
  const f=await setup(t);await f.insert('store','store.google',retiredOperationResponse,'null');await unavailable(f);
});
test('generic lookup does not emit a mixed-source conflict when a store row exists',{timeout:30000},async t=>{
  const f=await setup(t);await f.insert('personal','support.create',JSON.stringify({status:'ok'}));await f.insert('store','store.google',JSON.stringify({status:'ok'}));await unavailable(f);
});
test('a store action with a damaged source is withheld by the generic lookup',{timeout:30000},async t=>{
  const f=await setup(t);await f.insert('personal','store.apple',JSON.stringify({status:'ok'}));await unavailable(f);
});
test('generic personal and absent operation behavior remains available',{timeout:30000},async t=>{
  const f=await setup(t);assert.deepEqual(await f.lookup(),{status:'unknown'});
  await f.insert('personal','support.create',JSON.stringify({status:'accepted'}));assert.deepEqual(await f.lookup(),{status:'accepted'});
});
