/** Computed recovery continuation. The trusted SQL adapter acknowledges bounded
 * replay and exact effect reconciliation; there is no clear-quarantine flag. */
import {PROJECT_ID,PROTOCOL,GENESIS_HASH,canonical,sha256,exact,fail,loadHead,headView,checkedReceipt,uuidPattern,hashPattern} from './journal.mjs';
import {CONTROL_KEY,recoveryKey,commitKey,loadControl,checkedPlan,validateMarker} from './operations.mjs';
import {effectHeads,checkedEffect,effectSequenceKey,cancelUndispatchedEffect} from './effects.mjs';
import {manifestPreparing} from './manifests.mjs';
const uuid=x=>typeof x==='string'&&uuidPattern.test(x),hash=x=>typeof x==='string'&&hashPattern.test(x);
const uint=x=>Number.isSafeInteger(x)&&x>=0,equal=(a,b)=>canonical(a)===canonical(b),corrupt=()=>fail(503,'recovery_integrity_failed');
export const ACTIVE_INCARNATION='recovery:v2:active-incarnation';
export const recoveryStateKey=id=>'recovery:v2:state:'+id;
export const recoveryCompletionKey=id=>'recovery:v2:completion:'+id;
export const recoveryOutcomeKey=id=>'recovery:v2:operation-outcome:'+id;
const effectProofKey=(id,n)=>'recovery:v2:effect:'+id+':'+String(n).padStart(16,'0');
const observationHead=h=>({sequence:h.observation_sequence,hash:h.observation_hash});
const envelope=(c,r,s)=>({protocol:PROTOCOL,project_id:PROJECT_ID,control:{state:c.state,marker:c.marker,pending_operation_id:c.pending_operation_id,recovery_generation_id:c.recovery_generation_id},recovery:r,progress:s});
const input=(raw,fields)=>{if(!exact(raw,['version','project_id',...fields])||raw.version!==2||raw.project_id!==PROJECT_ID)fail(400,'recovery_invalid');};
const cursor=x=>exact(x,['sequence','hash'])&&uint(x.sequence)&&hash(x.hash)&&(x.sequence!==0||x.hash===GENESIS_HASH);
export async function checkedRecoveryV2(txn,id,value){
 if(!exact(value,['version','project_id','recovery_id','generation','prior_marker','prior_pending_operation_id','incarnation_id','journal_head','effect_head','reason','created_at','generation_hash'])||
  value.version!==2||value.project_id!==PROJECT_ID||value.recovery_id!==id||!uuid(id)||!uint(value.generation)||value.generation<1||
  !(value.prior_pending_operation_id===null||uuid(value.prior_pending_operation_id))||!uuid(value.incarnation_id)||!cursor(value.journal_head)||
  !cursor(value.effect_head)||!uint(value.created_at)||value.created_at<1||value.reason!=='planned_restore'||!hash(value.generation_hash))corrupt();
 try{validateMarker(value.prior_marker);}catch{corrupt();}
 if(value.incarnation_id===value.prior_marker.incarnation_id||value.generation_hash!==await sha256(canonical(Object.fromEntries(Object.entries(value).filter(([k])=>k!=='generation_hash')))))corrupt();
 return value;
}
async function state(txn,id){
 const s=await txn.get(recoveryStateKey(id));
 if(!exact(s,['replayed','effect_sequence','effect_hash','observation_head','retirement_hash','phase','clearance'])||!cursor(s.replayed)||!uint(s.effect_sequence)||!hash(s.effect_hash)||
  !cursor(s.observation_head)||!(s.retirement_hash===null||hash(s.retirement_hash))||!['replaying','prepared','completed'].includes(s.phase)||
  (s.phase==='replaying'?s.clearance!==null:!s.clearance))corrupt();return s;
}
async function active(txn,id){
 const control=await loadControl(txn),recovery=await txn.get(recoveryKey(id));
 if(!control||!recovery)fail(404,'recovery_not_found');await checkedRecoveryV2(txn,id,recovery);const progress=await state(txn,id);
 if(progress.phase!=='completed'&&(control.state!=='quarantined'||control.recovery_generation_id!==id))fail(409,'recovery_generation_retired');
 return {control,recovery,progress};
}
export async function beginFullRecovery(storage,value,now=Date.now){
 input(value,['recovery_id','expected']);if(!uuid(value.recovery_id))fail(400,'recovery_invalid');const expected=validateMarker(value.expected);
 return storage.transaction(async txn=>{
  const head=await loadHead(txn),control=await loadControl(txn);if(!control)fail(409,'control_uninitialized');
  const prior=await txn.get(recoveryKey(value.recovery_id));
  if(prior){const current=await active(txn,value.recovery_id);if(!equal(expected,current.recovery.prior_marker))fail(409,'recovery_conflict');return envelope(current.control,current.recovery,current.progress);}
  if(control.recovery_generation_id!==null)fail(409,'recovery_in_progress');
  if(!equal(expected,control.marker))fail(409,'recovery_marker_changed');
  if(control.pending_operation_id){const operation=await checkedPlan(txn,control.pending_operation_id);if(!operation||await manifestPreparing(txn,operation))fail(409,'manifest_incomplete');}
  const heads=await effectHeads(txn),created_at=Math.max(now(),head.recorded_at);if(!uint(created_at)||created_at<1)fail(503,'journal_clock_invalid');
  const recovery={version:2,project_id:PROJECT_ID,recovery_id:value.recovery_id,generation:control.marker.checkpoint.revision+1,
   prior_marker:control.marker,prior_pending_operation_id:control.pending_operation_id,incarnation_id:crypto.randomUUID(),journal_head:headView(head),
   effect_head:{sequence:heads.sequence,hash:heads.hash},reason:'planned_restore',created_at};recovery.generation_hash=await sha256(canonical(recovery));
  const progress={replayed:{sequence:0,hash:GENESIS_HASH},effect_sequence:0,effect_hash:GENESIS_HASH,observation_head:observationHead(heads),retirement_hash:null,phase:'replaying',clearance:null};
  const fenced={...control,state:'quarantined',recovery_generation_id:value.recovery_id,quarantine:{reason:'planned_restore',detected_at:created_at,observed_marker_hash:await sha256(canonical(expected))}};
  await txn.put({[recoveryKey(value.recovery_id)]:recovery,[recoveryStateKey(value.recovery_id)]:progress,[CONTROL_KEY]:fenced});return envelope(fenced,recovery,progress);
 });
}
export async function readFullRecovery(storage,id){if(!uuid(id))fail(400,'recovery_invalid');return storage.transaction(async txn=>{await loadHead(txn);const x=await active(txn,id);return envelope(x.control,x.recovery,x.progress);});}
export async function acknowledgeReplay(storage,id,value){
 input(value,['generation_hash','after','next']);if(!uuid(id)||!hash(value.generation_hash)||!cursor(value.after)||!cursor(value.next)||value.next.sequence-value.after.sequence>32||value.next.sequence<value.after.sequence)fail(400,'replay_ack_invalid');
 return storage.transaction(async txn=>{
  const head=await loadHead(txn),x=await active(txn,id);if(x.recovery.generation_hash!==value.generation_hash||x.progress.phase!=='replaying')fail(409,'recovery_conflict');
  if(equal(x.progress.replayed,value.next))return envelope(x.control,x.recovery,x.progress);
  if(!equal(x.progress.replayed,value.after)||!equal(headView(head),x.recovery.journal_head)||value.next.sequence>x.recovery.journal_head.sequence)fail(409,'replay_cursor_invalid');
  let previous=value.after.hash;for(let n=value.after.sequence+1;n<=value.next.sequence;n++){const r=await checkedReceipt(txn,n);if(r.previous_hash!==previous)corrupt();previous=r.hash;}
  if(previous!==value.next.hash)fail(409,'replay_cursor_invalid');const progress={...x.progress,replayed:value.next};await txn.put({[recoveryStateKey(id)]:progress});return envelope(x.control,x.recovery,progress);
 });
}
export async function refreshEffectCut(storage,id,value){
 input(value,['generation_hash']);if(!uuid(id)||!hash(value.generation_hash))fail(400,'recovery_invalid');
 return storage.transaction(async txn=>{await loadHead(txn);const x=await active(txn,id),heads=await effectHeads(txn);
  if(x.recovery.generation_hash!==value.generation_hash||x.progress.phase==='completed'||heads.sequence!==x.recovery.effect_head.sequence||heads.hash!==x.recovery.effect_head.hash)fail(409,'recovery_conflict');
  // The provisional SQL inventory digest included the former effect cut.
  // Discard that acknowledgement with its clearance; the adapter must recompute
  // it after every effect is proven again. Completed generations never enter here.
  const progress={...x.progress,phase:'replaying',clearance:null,retirement_hash:null,effect_sequence:0,effect_hash:GENESIS_HASH,observation_head:observationHead(heads)};
  await txn.put({[recoveryStateKey(id)]:progress});return envelope(x.control,x.recovery,progress);
 });
}
export async function acknowledgeEffectProof(storage,id,value,now=Date.now){
 input(value,['generation_hash','sequence','descriptor_hash','observation_hash','proof']);
 if(!uuid(id)||!hash(value.generation_hash)||!uint(value.sequence)||value.sequence<1||!hash(value.descriptor_hash)||
  !(value.observation_hash===null||hash(value.observation_hash))||!exact(value.proof,['outcome','sha256','byte_size','etag','reference_hash','verified_at'])||
  !['absent','preserved','historical-only'].includes(value.proof.outcome)||!(value.proof.sha256===null||hash(value.proof.sha256))||
  !(value.proof.byte_size===null||uint(value.proof.byte_size))||!(value.proof.etag===null||typeof value.proof.etag==='string'&&/^[\x20-\x7e]{1,256}$/.test(value.proof.etag))||
  !(value.proof.reference_hash===null||hash(value.proof.reference_hash))||!uint(value.proof.verified_at)||value.proof.verified_at<1)fail(400,'recovery_effect_proof_invalid');
 return storage.transaction(async txn=>{
  await loadHead(txn);const x=await active(txn,id),heads=await effectHeads(txn);
  if(x.recovery.generation_hash!==value.generation_hash||x.progress.phase!=='replaying'||value.sequence!==x.progress.effect_sequence+1||value.sequence>x.recovery.effect_head.sequence)fail(409,'recovery_effect_order');
  if(!equal(observationHead(heads),x.progress.observation_head))fail(409,'recovery_effect_cut_changed');
  const registration=await txn.get(effectSequenceKey(value.sequence));if(!registration)corrupt();let effect=await checkedEffect(txn,registration.effect_id);
  if(!effect||effect.descriptor_hash!==value.descriptor_hash||(effect.observation?.hash??null)!==value.observation_hash)fail(409,'recovery_effect_changed');
  if(effect.status==='registered')effect=await cancelUndispatchedEffect(txn,effect,now);
  if(effect.descriptor.kind==='storage-put'){
   if(!['succeeded','rejected','cancelled','materialized'].includes(effect.status))fail(409,'recovery_writer_unresolved');
   if(value.proof.outcome==='preserved'){
    if(value.proof.sha256!==effect.descriptor.payload_hash||value.proof.byte_size!==effect.descriptor.byte_size||!value.proof.etag||!value.proof.reference_hash)fail(409,'recovery_object_proof_invalid');
   }else if(value.proof.outcome!=='absent'||value.proof.sha256!==null||value.proof.byte_size!==null||value.proof.etag!==null||value.proof.reference_hash!==null)fail(409,'recovery_object_proof_invalid');
  }else if(value.proof.outcome!=='historical-only'||value.proof.sha256!==null||value.proof.byte_size!==null||value.proof.etag!==null||value.proof.reference_hash!==null)fail(409,'recovery_object_proof_invalid');
  const proof={sequence:value.sequence,descriptor_hash:value.descriptor_hash,observation_hash:effect.observation?.hash??null,proof:value.proof};
  const hash=await sha256(canonical({kind:'recovery-effect-proof-v1',recovery_id:id,generation_hash:value.generation_hash,previous_hash:x.progress.effect_hash,...proof}));
  const progress={...x.progress,effect_sequence:value.sequence,effect_hash:hash,observation_head:observationHead(await effectHeads(txn))};
  await txn.put({[effectProofKey(id,value.sequence)]:{...proof,hash},[recoveryStateKey(id)]:progress});return envelope(x.control,x.recovery,progress);
 });
}
export async function acknowledgeAuthorityRetirement(storage,id,value){
 input(value,['generation_hash','retirement_hash']);if(!uuid(id)||!hash(value.generation_hash)||!hash(value.retirement_hash))fail(400,'recovery_invalid');
 return storage.transaction(async txn=>{await loadHead(txn);const x=await active(txn,id);if(x.recovery.generation_hash!==value.generation_hash||x.progress.phase!=='replaying')fail(409,'recovery_conflict');
  if(x.progress.retirement_hash!==null&&x.progress.retirement_hash!==value.retirement_hash)fail(409,'recovery_retirement_conflict');
  const progress={...x.progress,retirement_hash:value.retirement_hash};await txn.put({[recoveryStateKey(id)]:progress});return envelope(x.control,x.recovery,progress);
 });
}
export async function prepareRecoveryClearance(storage,id,value,now=Date.now){
 input(value,['generation_hash']);if(!uuid(id)||!hash(value.generation_hash))fail(400,'recovery_invalid');
 return storage.transaction(async txn=>{
  const head=await loadHead(txn),x=await active(txn,id),heads=await effectHeads(txn);
  if(x.recovery.generation_hash!==value.generation_hash)fail(409,'recovery_conflict');
  if(x.progress.phase==='completed')return envelope(x.control,x.recovery,x.progress);
  if(!equal(headView(head),x.recovery.journal_head)||!equal(x.progress.replayed,x.recovery.journal_head)||
    x.progress.effect_sequence!==x.recovery.effect_head.sequence||heads.sequence!==x.recovery.effect_head.sequence||heads.hash!==x.recovery.effect_head.hash||
    !equal(observationHead(heads),x.progress.observation_head)||!hash(x.progress.retirement_hash))fail(409,'recovery_clearance_incomplete');
  if(x.progress.phase==='prepared')return envelope(x.control,x.recovery,x.progress);
  const content={version:2,project_id:PROJECT_ID,recovery_id:id,generation_hash:value.generation_hash,prior_marker:x.recovery.prior_marker,
    incarnation_id:x.recovery.incarnation_id,replayed:x.progress.replayed,effect_head:x.recovery.effect_head,effect_proof_hash:x.progress.effect_hash,
    observation_head:x.progress.observation_head,retirement_hash:x.progress.retirement_hash};
  const clearance_hash=await sha256(canonical(content));
  const marker={database_id:x.recovery.prior_marker.database_id,incarnation_id:x.recovery.incarnation_id,
    checkpoint:{revision:x.recovery.prior_marker.checkpoint.revision+1,hash:clearance_hash},cursor:x.recovery.journal_head};
  const clearance={...content,clearance_hash,marker,prepared_at:now()};if(!uint(clearance.prepared_at)||clearance.prepared_at<1)fail(503,'journal_clock_invalid');
  const progress={...x.progress,phase:'prepared',clearance};await txn.put({[recoveryStateKey(id)]:progress});return envelope(x.control,x.recovery,progress);
 });
}
export async function completeRecovery(storage,id,value,now=Date.now){
 input(value,['generation_hash','clearance_hash','marker']);if(!uuid(id)||!hash(value.generation_hash)||!hash(value.clearance_hash))fail(400,'recovery_invalid');const marker=validateMarker(value.marker);
 return storage.transaction(async txn=>{
  const head=await loadHead(txn),x=await active(txn,id),heads=await effectHeads(txn);
  if(x.recovery.generation_hash!==value.generation_hash||x.progress.clearance?.clearance_hash!==value.clearance_hash||!equal(x.progress.clearance.marker,marker))fail(409,'recovery_conflict');
  if(x.progress.phase==='completed')return envelope(x.control,x.recovery,x.progress);
  if(x.progress.phase!=='prepared'||!equal(headView(head),x.recovery.journal_head)||!equal(observationHead(heads),x.progress.observation_head)||
    heads.sequence!==x.recovery.effect_head.sequence||heads.hash!==x.recovery.effect_head.hash)fail(409,'recovery_clearance_changed');
  const committed_at=now();if(!uint(committed_at)||committed_at<x.progress.clearance.prepared_at)fail(503,'journal_clock_invalid');
  const completion={version:2,project_id:PROJECT_ID,recovery_id:id,clearance_hash:value.clearance_hash,marker,committed_at};
  const serving={...x.control,state:'serving',marker,pending_operation_id:null,recovery_generation_id:null,quarantine:null};
  const updates={ [ACTIVE_INCARNATION]:{recovery_id:id,marker,clearance_hash:value.clearance_hash},[recoveryCompletionKey(id)]:completion,[recoveryStateKey(id)]:{...x.progress,phase:'completed'},[CONTROL_KEY]:serving,
    [commitKey(marker.checkpoint.revision)]:{version:2,project_id:PROJECT_ID,marker,operation_id:id,plan_hash:value.clearance_hash,committed_at,kind:'recovery'} };
  if(x.recovery.prior_pending_operation_id){const operation=await checkedPlan(txn,x.recovery.prior_pending_operation_id);if(!operation||await manifestPreparing(txn,operation))corrupt();
    updates[recoveryOutcomeKey(operation.plan.operation_id)]={recovery_id:id,plan_hash:operation.plan_hash,input_hash:operation.plan.input_hash,recorded_at:committed_at};}
  await txn.put(updates);return envelope(serving,x.recovery,{...x.progress,phase:'completed'});
 });
}
export async function checkedRecoveryCommit(txn,record){
 if(!exact(record,['version','project_id','marker','operation_id','plan_hash','committed_at','kind'])||record.version!==2||record.project_id!==PROJECT_ID||record.kind!=='recovery'||!uuid(record.operation_id)||!hash(record.plan_hash)||!uint(record.committed_at)||record.committed_at<1)corrupt();
 const completion=await txn.get(recoveryCompletionKey(record.operation_id)),progress=await state(txn,record.operation_id),recovery=await txn.get(recoveryKey(record.operation_id));
 await checkedRecoveryV2(txn,record.operation_id,recovery);
 if(!exact(completion,['version','project_id','recovery_id','clearance_hash','marker','committed_at'])||completion.version!==2||completion.project_id!==PROJECT_ID||completion.recovery_id!==record.operation_id||
  completion.clearance_hash!==record.plan_hash||!equal(completion.marker,record.marker)||completion.committed_at!==record.committed_at||progress.phase!=='completed'||
  progress.clearance.clearance_hash!==record.plan_hash||!equal(progress.clearance.marker,record.marker)||record.marker.incarnation_id!==recovery.incarnation_id)corrupt();
 return record;
}
export async function recoveredOperationOutcome(txn,operation){
 const row=await txn.get(recoveryOutcomeKey(operation.plan.operation_id));if(row===undefined)return undefined;
 if(!exact(row,['recovery_id','plan_hash','input_hash','recorded_at'])||!uuid(row.recovery_id)||row.plan_hash!==operation.plan_hash||row.input_hash!==operation.plan.input_hash||!uint(row.recorded_at))corrupt();
 const completion=await txn.get(recoveryCompletionKey(row.recovery_id));if(!completion||completion.committed_at!==row.recorded_at)corrupt();return row;
}

export async function activeIncarnation(txn){
 const row=await txn.get(ACTIVE_INCARNATION);if(row===undefined)return undefined;
 if(!exact(row,['recovery_id','marker','clearance_hash'])||!uuid(row.recovery_id)||!hash(row.clearance_hash))corrupt();
 const completion=await txn.get(recoveryCompletionKey(row.recovery_id));
 if(!completion||completion.clearance_hash!==row.clearance_hash||!equal(completion.marker,row.marker))corrupt();
 await checkedRecoveryCommit(txn,{version:2,project_id:PROJECT_ID,marker:row.marker,operation_id:row.recovery_id,plan_hash:row.clearance_hash,committed_at:completion.committed_at,kind:'recovery'});
 return row;
}
