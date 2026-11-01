import assert from 'node:assert/strict';
import {planEvents} from './restore-plan-fixture.mjs';
import {stable} from './runtime-harness.mjs';

const ordered=rows=>rows.map(row=>stable(row)).sort();
/** Assert deny-only reconciliation of the independently accepted plan. The
 * original callback's audit, operation receipt and positive allocations remain
 * absent. Exact pending work bound to a withdrawn consent is cancelled. */
export async function assertRestrictedAbort(f,{saved,before,snapshot}){
 const events=await planEvents(f,saved),id=saved.plan.operation_id;
 await f.db.one('SELECT id FROM accounts LIMIT 1');
 const recovered=await f.journal.lookup(id);assert.equal(recovered.status,'recovered');
 assert.equal(recovered.plan_hash,saved.plan_hash);assert.deepEqual(recovered.plan,saved.plan);
 const receipt=await f.h.db.one('SELECT operation_id,input_hash,plan_hash,outcome FROM restore_recovered_operations WHERE operation_id=?',id);
 assert.deepEqual(receipt,{operation_id:id,input_hash:saved.plan.input_hash,plan_hash:saved.plan_hash,outcome:'restricted-abort'});
 const applied=await f.h.db.all('SELECT kind,scope_json FROM restore_replay_facts WHERE sequence>? AND sequence<=? ORDER BY sequence',saved.plan.expected.cursor.sequence,saved.plan.next.cursor.sequence);
 assert.deepEqual(ordered(applied.map(row=>({kind:row.kind,scope:JSON.parse(row.scope_json)}))),ordered(events.map(({kind,scope})=>({kind,scope}))));
 const after=await snapshot(f),expected=structuredClone(before);
 const replace=(table,predicate,fields,required)=>{
  assert(expected[table],`fixture must include ${table}`);let count=0;
  expected[table]=expected[table].map(old=>{
   if(!predicate(old))return old;count++;
   const actual=after[table].find(row=>row.id===old.id);assert(actual);
   for(const [key,value]of Object.entries(required))assert.equal(actual[key],value);
   const changed={};for(const field of fields){assert(Number.isSafeInteger(actual[field])&&actual[field]>=0,`${field} must be a real replay timestamp`);changed[field]=actual[field];}
   return{...old,...required,...changed};
  });
  assert(count>0,`the exact ${table} episode must exist in this fixture`);
 };
 for(const event of events){const s=event.scope;
  if(event.kind==='session-retired')replace('sessions',row=>row.id===s.session_id&&row.account_id===s.account_id,['revoked_at','refresh_consumed_at'],{});
  else if(event.kind==='consent-withdrawn'){
   replace('consents',row=>row.id===s.consent_id&&row.account_id===s.account_id&&row.purpose===s.purpose,['revoked_at'],{status:'revoked'});
   expected.face_profile_operations=expected.face_profile_operations.map(old=>old.account_id===s.account_id&&old.consent_id===s.consent_id&&old.state==='pending'?{...old,state:'cancelled'}:old);
   expected.auth_challenges=expected.auth_challenges.map(old=>{
    if(old.account_id!==s.account_id||old.consent_id!==s.consent_id||old.used_at!==null)return old;
    const actual=after.auth_challenges.find(row=>row.id===old.id);assert(actual);assert.equal(actual.status,'cancelled');assert(Number.isSafeInteger(actual.used_at)&&actual.used_at>=0);
    return{...old,status:'cancelled',used_at:actual.used_at};
   });
  }
  else if(event.kind==='device-retired')replace('auth_devices',row=>row.id===s.device_id&&row.account_id===s.account_id&&row.revision===s.device_revision,[],{status:'revoked',face_handle:null});
  else if(event.kind==='push-device-retired'){
   replace('push_devices',row=>row.id===s.device_id&&row.account_id===s.account_id&&row.token_hash===s.token_hash,[],{active:0});
   expected.notification_deliveries=expected.notification_deliveries.map(old=>{
    if(old.device_id!==s.device_id||old.token_hash!==s.token_hash||old.status!=='queued'||old.attempts!==0||old.lease_token!==null||old.provider_receipt!==null)return old;
    const actual=after.notification_deliveries.find(row=>row.id===old.id);assert(actual);assert.equal(actual.status,'cancelled');assert(Number.isSafeInteger(actual.updated_at));
    return{...old,status:'cancelled',updated_at:actual.updated_at};
   });
  }else assert.fail(`unexpected recovery fact in this authority fixture: ${event.kind}`);
 }
 assert.deepEqual(after,expected,'recovery applies exact restrictions without recreating callback side effects or broad authority');
 assert.deepEqual((await f.journal.control()).marker.cursor,saved.plan.next.cursor);
 return{recovered,after};
}
