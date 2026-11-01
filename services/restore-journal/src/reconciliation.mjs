/** Safe terminal resolution after an independently prepared SQL rollback.
 * The trusted database adapter applies only these exact restrictive facts and
 * stores their checkpoint atomically; it never reruns the positive callback. */
import {PROJECT_ID,PROTOCOL,GENESIS_HASH,canonical,sha256,exact,fail,loadHead,headView,checkedReceipt,uuidPattern,hashPattern} from './journal.mjs';
import {CONTROL_KEY,commitKey,checkedPlan,loadControl,validateMarker,operationView} from './operations.mjs';
import {manifestPreparing} from './manifests.mjs';
const uuid=x=>typeof x==='string'&&uuidPattern.test(x),hash=x=>typeof x==='string'&&hashPattern.test(x);
const equal=(a,b)=>canonical(a)===canonical(b),uint=x=>Number.isSafeInteger(x)&&x>=0;
export const reconciliationKey=id=>'reconciliation:v1:'+id;
export async function checkedReconciliation(txn,id,operation){
 const r=await txn.get(reconciliationKey(id));if(r===undefined)return undefined;
 if(!exact(r,['version','project_id','operation_id','input_hash','plan_hash','marker','replayed','outcome','recorded_at','hash'])||r.version!==1||r.project_id!==PROJECT_ID||r.operation_id!==id||
  r.input_hash!==operation.plan.input_hash||r.plan_hash!==operation.plan_hash||!equal(r.marker,operation.plan.next)||!equal(r.replayed,operation.plan.next.cursor)||
  r.outcome!=='restricted-abort'||!uint(r.recorded_at)||r.recorded_at<operation.plan.prepared_at||r.hash!==await sha256(canonical(Object.fromEntries(Object.entries(r).filter(([k])=>k!=='hash')))))fail(503,'journal_integrity_failed');
 return r;
}
export async function readRestrictionPage(storage,value){
 if(!exact(value,['version','project_id','after','through','limit'])||value.version!==1||value.project_id!==PROJECT_ID||
  !exact(value.after,['sequence','hash'])||!exact(value.through,['sequence','hash'])||!uint(value.after.sequence)||!uint(value.through.sequence)||
  !hash(value.after.hash)||!hash(value.through.hash)||value.after.sequence>value.through.sequence||!Number.isInteger(value.limit)||value.limit<1||value.limit>32)fail(400,'replay_page_invalid');
 return storage.transaction(async txn=>{
  const head=await loadHead(txn);if(value.through.sequence>head.sequence||
   (value.after.sequence===0?value.after.hash!==GENESIS_HASH:(await checkedReceipt(txn,value.after.sequence)).hash!==value.after.hash)||
   (value.through.sequence===0?value.through.hash!==GENESIS_HASH:(await checkedReceipt(txn,value.through.sequence)).hash!==value.through.hash))fail(409,'replay_cursor_invalid');
  const records=[];let previous=value.after.hash;
  for(let sequence=value.after.sequence+1;sequence<=Math.min(value.through.sequence,value.after.sequence+value.limit);sequence++){
   const record=await checkedReceipt(txn,sequence);if(record.previous_hash!==previous)fail(503,'journal_integrity_failed');records.push(record);previous=record.hash;
  }
  return {protocol:PROTOCOL,project_id:PROJECT_ID,after:value.after,through:value.through,records,
   next:records.length?headView(records.at(-1)):value.after,complete:value.after.sequence+records.length===value.through.sequence};
 });
}
export async function reconcilePreparedOperation(storage,id,value,now=Date.now){
 if(!uuid(id)||!exact(value,['version','project_id','plan_hash','marker','replayed'])||value.version!==1||value.project_id!==PROJECT_ID||!hash(value.plan_hash))fail(400,'reconciliation_invalid');
 const marker=validateMarker(value.marker);
 return storage.transaction(async txn=>{
  const head=await loadHead(txn),control=await loadControl(txn),operation=await checkedPlan(txn,id);if(!control||!operation)fail(404,'operation_not_found');
  const old=await checkedReconciliation(txn,id,operation);
  if(old){if(value.plan_hash!==old.plan_hash||!equal(value.replayed,old.replayed)||!equal(marker,old.marker))fail(409,'reconciliation_conflict');
    return {protocol:PROTOCOL,project_id:PROJECT_ID,control:{state:control.state,marker:control.marker,pending_operation_id:control.pending_operation_id,recovery_generation_id:control.recovery_generation_id},operation:{...operation,status:'recovered',committed_at:old.recorded_at}};}
  if(control.state!=='pending'||control.pending_operation_id!==id||!equal(control.marker,operation.plan.expected)||
    await manifestPreparing(txn,operation)||value.plan_hash!==operation.plan_hash||!equal(marker,operation.plan.next)||
    !equal(value.replayed,marker.cursor)||!equal(marker.cursor,headView(head)))fail(409,'reconciliation_conflict');
  const recorded_at=Math.max(now(),operation.plan.prepared_at);if(!uint(recorded_at)||recorded_at<1)fail(503,'journal_clock_invalid');
  const receipt={version:1,project_id:PROJECT_ID,operation_id:id,input_hash:operation.plan.input_hash,plan_hash:operation.plan_hash,marker,
    replayed:marker.cursor,outcome:'restricted-abort',recorded_at};receipt.hash=await sha256(canonical(receipt));
  const serving={...control,state:'serving',marker,pending_operation_id:null};
  await txn.put({[reconciliationKey(id)]:receipt,[commitKey(marker.checkpoint.revision)]:{version:1,project_id:PROJECT_ID,marker,operation_id:id,plan_hash:operation.plan_hash,committed_at:recorded_at},[CONTROL_KEY]:serving});
  return {protocol:PROTOCOL,project_id:PROJECT_ID,control:{state:serving.state,marker,pending_operation_id:null,recovery_generation_id:null},operation:{...operation,status:'recovered',committed_at:recorded_at}};
 });
}
