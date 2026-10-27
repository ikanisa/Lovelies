/** Synthetic non-adversarial guardian/adult source guards; PGlite and memory only. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
const pgliteTest=process.env.TEST_DATABASE_URL === undefined ? test : test.skip;
import {pruneRetainedMetadata} from '../src/retention.ts';
import {digest,stable} from '../src/types.ts';
import {fixture,release,day,id} from './retention-request-hold-fixture.mjs';

async function seed(f,kind){
 const value=id(),{h,owner,now}=f;
 if(kind==='guardian'){
  await h.db.run('INSERT INTO guardian_requests(id,child_account_id,state,child_audience_version,policy_version,created_at,expires_at,terminated_at) VALUES(?,?,?,?,?,?,?,?)',
   value,owner,'expired',1,'synthetic-v1',now-400*day,now-370*day,now-366*day);
  return {id:value,table:'guardian_requests'};
 }
 // The independent reviewer is an ordinary synthetic role in the designed
 // workflow, never an adversarial owner or foreign-key alias simulation.
 const reviewer=(await h.anonymous()).account_id;
 await h.db.run('INSERT INTO audience_adult_reviews(id,account_id,reviewed_by,evidence_method,evidence_reference,created_at) VALUES(?,?,?,?,?,?)',
  value,owner,reviewer,'independent_live_review','synthetic-review-reference',now-366*day);
 const review=await h.db.one('SELECT id,account_id,reviewed_by,evidence_method,evidence_reference,created_at FROM audience_adult_reviews WHERE id=?',value);
 const generation=await digest(stable({review,audience_version:null}));
 const checkpoint=stable({protocol:'lovelies-retention-receipts-v1',generation,operation_key:'synthetic-operation-key'});
 await h.db.run('INSERT INTO retention_scan_cursors(scan,entity_id,last_at,last_id) VALUES(?,?,?,?)','adult',value,now-400*day,checkpoint);
 return {id:value,table:'audience_adult_reviews'};
}
async function facts(f,a){
 return {source:await f.h.db.one(`SELECT * FROM ${a.table} WHERE id=?`,a.id),
  cursor:a.table==='audience_adult_reviews'?await f.h.db.one("SELECT * FROM retention_scan_cursors WHERE scan='adult' AND entity_id=?",a.id):null};
}

for(const kind of ['guardian','adult'])pgliteTest(`pre-existing request hold preserves ${kind} source until release`,{timeout:30000},async t=>{
 const f=await fixture(t),a=await seed(f,kind),before=await facts(f,a);assert(before.source);
 await pruneRetainedMetadata(f.h.app);assert.deepEqual(await facts(f,a),before);assert.deepEqual(f.errors,[]);
 await release(f);await pruneRetainedMetadata(f.h.app);await pruneRetainedMetadata(f.h.app);
 assert.equal((await facts(f,a)).source,null);
});

for(const kind of ['guardian','adult'])pgliteTest(`late request hold guards ${kind} source and its cursor`,{timeout:30000},async t=>{
 const f=await fixture(t,{held:false}),a=await seed(f,kind),before=await facts(f,a),db=f.h.db,run=db.run.bind(db);let injected=false;
 db.run=async(sql,...args)=>{
  if(!injected&&sql.startsWith('DELETE FROM '+a.table)&&args[0]===a.id){injected=true;await run('UPDATE privacy_requests SET legal_hold=1 WHERE id=?',f.request);}
  return run(sql,...args);
 };
 try{
  await assert.rejects(pruneRetainedMetadata(f.h.app),error=>error?.status===409&&error.code==='retention_hold_changed');
  assert.equal(injected,true);assert.deepEqual(await facts(f,a),before);assert.equal((await db.one('SELECT legal_hold FROM privacy_requests WHERE id=?',f.request)).legal_hold,0);
 }finally{db.run=run;}
 await pruneRetainedMetadata(f.h.app);await pruneRetainedMetadata(f.h.app);assert.equal((await facts(f,a)).source,null);
});
