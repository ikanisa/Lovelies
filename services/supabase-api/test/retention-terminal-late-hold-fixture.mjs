/** One-subject synthetic support source and optional exact linked receipt. */
import assert from 'node:assert/strict';
import {prepareOperation} from '../src/operations.ts';
import {day,id} from './retention-request-hold-fixture.mjs';

export async function seedSupport(f,{linked=true}={}){
 const support=id(),operation=id(),{h,owner,now}=f;
 await h.db.run('INSERT INTO support_requests(id,account_id,subject,details,status,category,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
  support,owner,'Synthetic support','Synthetic protected record','closed','general_support',now-92*day,now-91*day);
 if(linked){
  const body={subject:'Synthetic support',details:'Synthetic protected record',operation_key:operation};
  const prepared=await prepareOperation('support.create',body,'support');
  await h.db.run('INSERT INTO operations(actor_id,source,operation_key,action,payload_hash,payload_json,response_json,created_at) VALUES(?,?,?,?,?,?,?,?)',
   owner,'support',operation,'support.create',prepared.hash,prepared.payloadJson,JSON.stringify({id:support,status:'open',revision:1}),now-400*day);
  await h.db.run('INSERT INTO operation_subjects(actor_id,source,operation_key,subject_id) VALUES(?,?,?,?)',owner,'support',operation,owner);
 }
 return {support,operation,linked};
}
export async function supportFacts(f,a){
 return {source:await f.h.db.one('SELECT * FROM support_requests WHERE id=?',a.support),
  receipt:a.linked?await f.h.db.one('SELECT * FROM operations WHERE operation_key=?',a.operation):null};
}
/** Inject request hold in the same test transaction at a named mutation
 * boundary; not an actual second PostgreSQL backend or external writer. */
export function holdAtTerminalMutation(f,a,phase){
 const db=f.h.db,run=db.run.bind(db);let injected=false;
 db.run=async(sql,...args)=>{
  const matched=phase==='source'?sql.startsWith('DELETE FROM support_requests')&&args[0]===a.support:
   sql.startsWith('UPDATE operations SET payload_json=')&&args.includes(a.operation);
  if(!injected&&matched){
   assert(await db.one('SELECT id FROM support_requests WHERE id=?',a.support),'support source must exist');
   assert.equal((await db.one('SELECT legal_hold FROM privacy_requests WHERE id=?',f.request)).legal_hold,0);
   injected=true;await run('UPDATE privacy_requests SET legal_hold=1 WHERE id=?',f.request);
  }
  return run(sql,...args);
 };
 return {state:()=>({injected}),restore:()=>{db.run=run;}};
}
