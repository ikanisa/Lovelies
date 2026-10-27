/** One-subject, same-transaction retention visibility models. */
import assert from 'node:assert/strict';
import {day,id} from './retention-request-hold-fixture.mjs';

export async function seedConsent(f){
 const consent=id();
 await f.h.db.run('INSERT INTO consents(id,account_id,purpose,policy_version,status,revoked_at,created_at) VALUES(?,?,?,?,?,?,?)',
  consent,f.owner,'synthetic_fixture','fixture-v1','revoked',f.now-400*day,f.now-401*day);
 return consent;
}
export function globalBeforeConsentDelete(f,mode){
 const db=f.h.db,run=db.run.bind(db);let injected=false;
 db.run=async(sql,...args)=>{
  if(!injected&&sql.startsWith('DELETE FROM consents')){
   const before=await db.one("SELECT legal_hold FROM retention_settings WHERE id='default'");assert(before);assert.equal(before.legal_hold,0);injected=true;
   if(mode==='active')await run("UPDATE retention_settings SET legal_hold=1 WHERE id='default'");
   else if(mode==='missing')await run("DELETE FROM retention_settings WHERE id='default'");
   else throw new Error('unknown mode');
  }
  return run(sql,...args);
 };
 return {state:()=>({injected}),restore:()=>{db.run=run;}};
}
