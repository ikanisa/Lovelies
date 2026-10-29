/** Single-subject local regression: a transaction callback is not its commit. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runRetention} from '../src/retention.ts';
import {fixture,asset} from './retention-request-hold-fixture.mjs';

const pgliteTest=process.env.TEST_DATABASE_URL === undefined ? test : test.skip;

function failFinalization(f,job,mode){
 const db=f.h.db,run=db.run.bind(db),transaction=db.transaction.bind(db);
 let finalWrite=false,injected=false;
 db.run=async(sql,...args)=>{
  const value=await run(sql,...args);
  if(sql.startsWith("UPDATE retention_jobs SET status='verified'")&&args.includes(job))finalWrite=true;
  return value;
 };
 db.transaction=async(callback,intent)=>{
  const value=await transaction(async scope=>{
   const result=await callback(scope);
   // This injected error makes PGlite roll back the final transaction. It does
   // not undo the earlier synthetic object delete and per-object transaction.
   if(finalWrite&&!injected&&mode==='rollback'){
    injected=true;throw new Error('synthetic_final_transaction_rollback');
   }
   return result;
  },intent);
  // The underlying local commit returned, but this wrapper hides that result
  // from runRetention. It models a lost reply, not a real PostgreSQL fault.
  if(finalWrite&&!injected&&mode==='lost_reply'){
   injected=true;throw new Error('synthetic_final_transaction_reply_lost');
  }
  return value;
 };
 return {injected:()=>injected,restore:()=>{db.run=run;db.transaction=transaction;}};
}

for(const mode of ['rollback','lost_reply'])pgliteTest(`unconfirmed ${mode} is not counted as verified`,{timeout:30000},async t=>{
 const f=await fixture(t,{held:false}),a=await asset(f,{scheduled:true}),fault=failFinalization(f,a.job,mode);
 try{
  const summary=await runRetention(f.h.app);
  assert.equal(fault.injected(),true);
  assert.deepEqual(summary,{verified:0,pending:mode==='rollback'?1:0,failed:1});
  assert.deepEqual(f.errors,[]);
  assert.equal(f.events.length,1);
  const row=await f.h.db.one('SELECT status FROM retention_jobs WHERE id=?',a.job);
  assert.equal(row.status,mode==='rollback'?'failed':'verified');
 }finally{fault.restore();}
});

pgliteTest('acknowledged finalization is counted once',{timeout:30000},async t=>{
 const f=await fixture(t,{held:false}),a=await asset(f,{scheduled:true});
 assert.deepEqual(await runRetention(f.h.app),{verified:1,pending:0,failed:0});
 assert.equal((await f.h.db.one('SELECT status FROM retention_jobs WHERE id=?',a.job)).status,'verified');
 assert.deepEqual(f.errors,[]);assert.equal(f.events.length,1);
});
