/** Same-subject synthetic late-global and pruning rollback controls. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
const pgliteTest=process.env.TEST_DATABASE_URL === undefined ? test : test.skip;
import {pruneRetainedMetadata} from '../src/retention.ts';
import {retiredOperationInput} from '../src/operations.ts';
import {fixture,metadata,facts,release} from './retention-request-hold-fixture.mjs';
import {holdBeforeAuditDelete} from './retention-audit-fixture.mjs';
import {seedConsent,globalBeforeConsentDelete} from './retention-consent-transaction-fixture.mjs';

for(const mode of ['active','missing'])pgliteTest(`late ${mode} global state prevents consent deletion and rolls back`,{timeout:30000},async t=>{
 const f=await fixture(t,{held:false});await pruneRetainedMetadata(f.h.app);
 const consent=await seedConsent(f),hook=globalBeforeConsentDelete(f,mode);
 try{
  await assert.rejects(pruneRetainedMetadata(f.h.app),error=>error?.status===409&&error.code==='retention_hold_changed');
  assert.deepEqual(hook.state(),{injected:true});assert.deepEqual(f.errors,[]);assert(await f.h.db.one('SELECT id FROM consents WHERE id=?',consent));
  assert.equal((await f.h.db.one("SELECT legal_hold FROM retention_settings WHERE id='default'")).legal_hold,0,'fixture global change rolled back');
 }finally{hook.restore();}
 if(mode==='active'){
  await f.h.db.run("UPDATE retention_settings SET legal_hold=1 WHERE id='default'");await pruneRetainedMetadata(f.h.app);
  assert(await f.h.db.one('SELECT id FROM consents WHERE id=?',consent));await f.h.db.run("UPDATE retention_settings SET legal_hold=0,version=version+1 WHERE id='default'");
 }
 await pruneRetainedMetadata(f.h.app);assert.equal(await f.h.db.one('SELECT id FROM consents WHERE id=?',consent),null);
});

pgliteTest('late request hold at audit DELETE rolls back earlier support and receipt minimization',{timeout:30000},async t=>{
 const f=await fixture(t,{held:false}),a=await metadata(f),before=await facts(f,a);
 const target=[a.actorAudit,a.subjectAudit].sort()[0],hook=holdBeforeAuditDelete(f,target,'request');
 try{
  await assert.rejects(pruneRetainedMetadata(f.h.app),error=>error?.status===409&&error.code==='retention_hold_changed');
  assert.equal(hook.state().injected,true);assert.deepEqual(await facts(f,a),before);assert.deepEqual(f.errors,[]);
  assert.equal((await f.h.db.one('SELECT legal_hold FROM privacy_requests WHERE id=?',f.request)).legal_hold,0,'fixture hold rolled back with pruning');
 }finally{hook.restore();}
 await f.h.db.run('UPDATE privacy_requests SET legal_hold=1 WHERE id=?',f.request);await pruneRetainedMetadata(f.h.app);
 assert.deepEqual(await facts(f,a),before);await release(f);await pruneRetainedMetadata(f.h.app);await pruneRetainedMetadata(f.h.app);
 const after=await facts(f,a);assert.equal(after.support,null);assert.equal(after.operation.payload_json,retiredOperationInput);assert.equal(after.consent,null);
});

pgliteTest('late global hold at consent DELETE rolls back earlier audit, support and receipt changes',{timeout:30000},async t=>{
 const f=await fixture(t,{held:false});await pruneRetainedMetadata(f.h.app);
 const a=await metadata(f),before=await facts(f,a),hook=globalBeforeConsentDelete(f,'active');
 try{
  await assert.rejects(pruneRetainedMetadata(f.h.app),error=>error?.status===409&&error.code==='retention_hold_changed');
  assert.deepEqual(hook.state(),{injected:true});assert.deepEqual(await facts(f,a),before);assert.deepEqual(f.errors,[]);
  assert.equal((await f.h.db.one("SELECT legal_hold FROM retention_settings WHERE id='default'")).legal_hold,0);
 }finally{hook.restore();}
 await f.h.db.run("UPDATE retention_settings SET legal_hold=1 WHERE id='default'");await pruneRetainedMetadata(f.h.app);
 assert.deepEqual(await facts(f,a),before);await f.h.db.run("UPDATE retention_settings SET legal_hold=0,version=version+1 WHERE id='default'");
 await pruneRetainedMetadata(f.h.app);await pruneRetainedMetadata(f.h.app);
 const after=await facts(f,a);assert.equal(after.support,null);assert.equal(after.operation.payload_json,retiredOperationInput);assert.equal(after.consent,null);
});

pgliteTest('consent guard query failure rolls back and preserves consent',{timeout:30000},async t=>{
 const f=await fixture(t,{held:false});await pruneRetainedMetadata(f.h.app);const consent=await seedConsent(f),db=f.h.db,run=db.run.bind(db);let injected=false;
 db.run=async(sql,...args)=>{
  if(!injected&&sql.startsWith('DELETE FROM consents')){injected=true;assert(sql.includes("p.legal_hold=0"));throw new Error('synthetic consent guard query failure');}
  return run(sql,...args);
 };
 try{
  await assert.rejects(pruneRetainedMetadata(f.h.app),/synthetic consent guard query failure/);
  assert.equal(injected,true);assert(await db.one('SELECT id FROM consents WHERE id=?',consent));assert.deepEqual(f.errors,[]);
 }finally{db.run=run;}
});
