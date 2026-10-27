/** Same-subject terminal hold controls; no external effects. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
const pgliteTest=process.env.TEST_DATABASE_URL === undefined ? test : test.skip;
import {pruneRetainedMetadata} from '../src/retention.ts';
import {retiredOperationInput} from '../src/operations.ts';
import {fixture,release} from './retention-request-hold-fixture.mjs';
import {seedSupport,supportFacts,holdAtTerminalMutation} from './retention-terminal-late-hold-fixture.mjs';

for(const linked of [false,true])pgliteTest(`pre-existing request hold preserves support with linked=${linked} until release`,{timeout:30000},async t=>{
 const f=await fixture(t),a=await seedSupport(f,{linked}),before=await supportFacts(f,a);
 await pruneRetainedMetadata(f.h.app);assert.deepEqual(await supportFacts(f,a),before);assert.deepEqual(f.errors,[]);
 await release(f);await pruneRetainedMetadata(f.h.app);await pruneRetainedMetadata(f.h.app);
 const after=await supportFacts(f,a);assert.equal(after.source,null);if(linked)assert.equal(after.receipt.payload_json,retiredOperationInput);
});

for(const [phase,linked] of [['source',false],['source',true],['receipt',true]]){
 pgliteTest(`late request hold at ${phase} rolls back support changes with linked=${linked}`,{timeout:30000},async t=>{
  const f=await fixture(t,{held:false}),a=await seedSupport(f,{linked}),before=await supportFacts(f,a),hook=holdAtTerminalMutation(f,a,phase);
  try{
   await assert.rejects(pruneRetainedMetadata(f.h.app),error=>error?.status===409&&['retention_hold_changed','retention_operation_changed'].includes(error.code));
   assert.deepEqual(hook.state(),{injected:true});assert.deepEqual(await supportFacts(f,a),before);assert.deepEqual(f.errors,[]);
   assert.equal((await f.h.db.one('SELECT legal_hold FROM privacy_requests WHERE id=?',f.request)).legal_hold,0,'fixture hold rolled back with the transaction');
  }finally{hook.restore();}
  // A separately persisted hold remains protective; release returns to ordinary
  // cursor progression. This does not model independently committed concurrency.
  await f.h.db.run('UPDATE privacy_requests SET legal_hold=1 WHERE id=?',f.request);await pruneRetainedMetadata(f.h.app);
  assert.deepEqual(await supportFacts(f,a),before);
  await release(f);await pruneRetainedMetadata(f.h.app);await pruneRetainedMetadata(f.h.app);
  const after=await supportFacts(f,a);assert.equal(after.source,null);if(linked)assert.equal(after.receipt.payload_json,retiredOperationInput);
 });
}

pgliteTest('terminal source guard query failure rolls back earlier receipt changes',{timeout:30000},async t=>{
 const f=await fixture(t,{held:false}),a=await seedSupport(f,{linked:true}),before=await supportFacts(f,a),db=f.h.db,run=db.run.bind(db);let injected=false;
 db.run=async(sql,...args)=>{if(!injected&&sql.startsWith('DELETE FROM support_requests')&&args[0]===a.support){injected=true;assert(sql.includes('NOT EXISTS'));throw new Error('synthetic terminal guard failure');}return run(sql,...args);};
 try{
  await assert.rejects(pruneRetainedMetadata(f.h.app),/synthetic terminal guard failure/);
  assert.equal(injected,true);assert.deepEqual(await supportFacts(f,a),before);assert.deepEqual(f.errors,[]);
 }finally{db.run=run;}
});
