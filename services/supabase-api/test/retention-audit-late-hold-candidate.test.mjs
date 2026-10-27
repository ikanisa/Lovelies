/** Synthetic one-subject audit visibility regressions; PGlite only. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
const pgliteTest=process.env.TEST_DATABASE_URL === undefined ? test : test.skip;
import {pruneRetainedMetadata} from '../src/retention.ts';
import {fixture} from './retention-request-hold-fixture.mjs';
import {seedAudit,holdBeforeAuditDelete,releaseAuditHold} from './retention-audit-fixture.mjs';

for(const [kind,role] of [['request','subject'],['request','actor'],['moderation','subject'],['moderation','actor'],['global','subject']]){
 pgliteTest(`late ${kind} hold for audit ${role} is checked by DELETE`,{timeout:30000},async t=>{
  const f=await fixture(t,{held:false}),audit=await seedAudit(f,role),hook=holdBeforeAuditDelete(f,audit,kind);
  try{
   await assert.rejects(pruneRetainedMetadata(f.h.app),error=>error?.status===409&&error.code==='retention_hold_changed');
   assert.equal(hook.state().injected,true);assert.deepEqual(f.errors,[]);assert.deepEqual(f.events,[]);
   assert(await f.h.db.one('SELECT id FROM audit_events WHERE id=?',audit));
   await releaseAuditHold(f,kind,hook.state().holdId);await pruneRetainedMetadata(f.h.app);
   assert.equal(await f.h.db.one('SELECT id FROM audit_events WHERE id=?',audit),null);
  }finally{hook.restore();}
 });
}

for(const kind of ['request','moderation','global']){
 pgliteTest(`pre-existing ${kind} hold preserves audit until release`,{timeout:30000},async t=>{
  const f=await fixture(t,{held:kind==='request'});await pruneRetainedMetadata(f.h.app);
  const audit=await seedAudit(f,'subject');let holdId=null;
  if(kind==='moderation'){holdId=crypto.randomUUID();await f.h.db.run('INSERT INTO moderation_holds(id,subject_id,active,created_at,reason) VALUES(?,?,?,?,?)',holdId,f.owner,1,f.now,'synthetic hold');}
  if(kind==='global')await f.h.db.run("UPDATE retention_settings SET legal_hold=1 WHERE id='default'");
  await pruneRetainedMetadata(f.h.app);assert(await f.h.db.one('SELECT id FROM audit_events WHERE id=?',audit));assert.deepEqual(f.errors,[]);
  await releaseAuditHold(f,kind,holdId);await pruneRetainedMetadata(f.h.app);assert.equal(await f.h.db.one('SELECT id FROM audit_events WHERE id=?',audit),null);
 });
}

pgliteTest('audit DELETE query failure rolls back and preserves the row',{timeout:30000},async t=>{
 const f=await fixture(t,{held:false}),audit=await seedAudit(f,'subject'),db=f.h.db,run=db.run.bind(db);let injected=false;
 db.run=async(sql,...args)=>{if(!injected&&sql.startsWith('DELETE FROM audit_events')&&args[0]===audit){injected=true;assert(sql.includes('NOT EXISTS'));throw new Error('synthetic audit guard query failure');}return run(sql,...args);};
 try{
  await assert.rejects(pruneRetainedMetadata(f.h.app),/synthetic audit guard query failure/);
  assert.equal(injected,true);assert(await db.one('SELECT id FROM audit_events WHERE id=?',audit));assert.deepEqual(f.errors,[]);
 }finally{db.run=run;}
});
