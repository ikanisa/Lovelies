/** Same-subject synthetic audit guard model; no provider or external database. */
import assert from 'node:assert/strict';
import {day,id} from './retention-request-hold-fixture.mjs';

export async function seedAudit(f,role){
 const audit=id(),actor=role==='actor'?f.owner:null,subject=role==='subject'?f.owner:null;
 await f.h.db.run('INSERT INTO audit_events(id,actor_id,subject_id,action,entity_id,details_json,created_at) VALUES(?,?,?,?,?,?,?)',
  audit,actor,subject,'privacy.synthetic',id(),'{}',f.now-400*day);
 return audit;
}
/** Hold is inserted by the fixture in the same test transaction after the
 * SELECT and before the DELETE. This is not concurrent-backend proof. */
export function holdBeforeAuditDelete(f,audit,kind){
 const db=f.h.db,run=db.run.bind(db);let injected=false,holdId=null;
 db.run=async(sql,...args)=>{
  if(!injected&&sql.startsWith('DELETE FROM audit_events')&&args[0]===audit){
   assert(await db.one('SELECT id FROM audit_events WHERE id=?',audit),'selected audit must exist');
   assert.equal((await db.one('SELECT legal_hold FROM privacy_requests WHERE id=?',f.request)).legal_hold,0);
   injected=true;
   if(kind==='request')await run('UPDATE privacy_requests SET legal_hold=1 WHERE id=?',f.request);
   else if(kind==='moderation'){holdId=id();await run('INSERT INTO moderation_holds(id,subject_id,active,created_at,reason) VALUES(?,?,?,?,?)',holdId,f.owner,1,f.now,'synthetic audit hold');}
   else if(kind==='global')await run("UPDATE retention_settings SET legal_hold=1 WHERE id='default'");
   else throw new Error('unknown synthetic hold');
  }
  return run(sql,...args);
 };
 return {state:()=>({injected,holdId}),restore:()=>{db.run=run;}};
}
export async function releaseAuditHold(f,kind,holdId){
 if(kind==='request')await f.h.db.run('UPDATE privacy_requests SET legal_hold=0 WHERE id=?',f.request);
 else if(kind==='moderation')await f.h.db.run('UPDATE moderation_holds SET active=0,cleared_at=? WHERE id=?',f.now,holdId);
 else await f.h.db.run("UPDATE retention_settings SET legal_hold=0,version=version+1 WHERE id='default'");
}
