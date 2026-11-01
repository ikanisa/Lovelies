/** Independent immutable external-effect roster. A timeout never cancels a
 * dispatched effect. Late replies add history without granting send authority. */
import {PROJECT_ID,PROTOCOL,GENESIS_HASH,canonical,sha256,exact,fail,loadHead,uuidPattern,hashPattern} from './journal.mjs';
import {loadControl,validateMarker} from './operations.mjs';
const uuid=x=>typeof x==='string'&&uuidPattern.test(x),hash=x=>typeof x==='string'&&hashPattern.test(x);
const uint=x=>Number.isSafeInteger(x)&&x>=0,equal=(a,b)=>canonical(a)===canonical(b);
export const EFFECT_HEAD='effect:v1:head';
export const effectKey=id=>'effect:v1:id:'+id;
export const effectSequenceKey=n=>'effect:v1:sequence:'+String(n).padStart(16,'0');
const observationKey=n=>'effect:v1:observation:'+String(n).padStart(16,'0');
const corrupt=()=>fail(503,'effect_inventory_integrity_failed');
const envelope=control=>({protocol:PROTOCOL,project_id:PROJECT_ID,control:{state:control.state,marker:control.marker,
 pending_operation_id:control.pending_operation_id,recovery_generation_id:control.recovery_generation_id}});
export function validateEffect(value){
 if(!exact(value,['version','project_id','effect_id','expected','kind','target','payload_hash','byte_size','metadata_hash'])||value.version!==1||value.project_id!==PROJECT_ID||
 !uuid(value.effect_id)||!hash(value.payload_hash)||!uint(value.byte_size)||!hash(value.metadata_hash)||!['storage-put','service-request'].includes(value.kind))fail(400,'effect_invalid');
 const expected=validateMarker(value.expected);
 if(value.kind==='storage-put'){
  if(!exact(value.target,['bucket','object_key','owner_id'])||!uuid(value.target.owner_id)||!['PHOTOS','QUARANTINE','PRIVACY_EXPORTS'].includes(value.target.bucket)||
    typeof value.target.object_key!=='string'||value.target.object_key.length>1024||!/^[A-Za-z0-9_./-]+$/.test(value.target.object_key)||
    value.target.object_key.split('/').some(x=>!x||x==='.'||x==='..'))fail(400,'effect_invalid');
 }else if(!exact(value.target,['service','method','path'])||!['inference','push','store'].includes(value.target.service)||
    !['POST','PUT','PATCH','DELETE'].includes(value.target.method)||typeof value.target.path!=='string'||value.target.path.length>512||
    !value.target.path.startsWith('/')||/[?#\x00-\x20]/.test(value.target.path))fail(400,'effect_invalid');
 return {...value,expected,target:{...value.target}};
}
export async function effectHeads(txn){
 const head=await txn.get(EFFECT_HEAD);
 if(head===undefined){
  if((await txn.list({prefix:'effect:v1:',limit:1})).size)corrupt();
  return {sequence:0,hash:GENESIS_HASH,observation_sequence:0,observation_hash:GENESIS_HASH};
 }
 if(!exact(head,['sequence','hash','observation_sequence','observation_hash'])||!uint(head.sequence)||!hash(head.hash)||!uint(head.observation_sequence)||!hash(head.observation_hash)||
   head.sequence===0&&head.hash!==GENESIS_HASH||head.observation_sequence===0&&head.observation_hash!==GENESIS_HASH)corrupt();
 if(head.sequence){const last=await txn.get(effectSequenceKey(head.sequence));if(!last||last.hash!==head.hash)corrupt();}
 if(head.observation_sequence){const last=await txn.get(observationKey(head.observation_sequence));if(!last||last.hash!==head.observation_hash)corrupt();}
 return head;
}
export async function checkedEffect(txn,id){
 const row=await txn.get(effectKey(id));if(row===undefined)return undefined;
 if(!exact(row,['descriptor','descriptor_hash','registration','status','observation'])||!hash(row.descriptor_hash)||
   !['registered','dispatching','succeeded','rejected','unknown','cancelled','materialized'].includes(row.status))corrupt();
 try{validateEffect(row.descriptor);}catch{corrupt();}
 const r=row.registration;
 if(row.descriptor.effect_id!==id||row.descriptor_hash!==await sha256(canonical(row.descriptor))||
  !exact(r,['sequence','previous_hash','descriptor_hash','effect_id','recorded_at','hash'])||!uint(r.sequence)||r.sequence<1||!hash(r.previous_hash)||!hash(r.hash)||
  r.descriptor_hash!==row.descriptor_hash||r.effect_id!==id||!uint(r.recorded_at)||r.recorded_at<1||r.hash!==await sha256(canonical({kind:'effect-registration-v1',...Object.fromEntries(Object.entries(r).filter(([k])=>k!=='hash'))}))||
  !equal(r,await txn.get(effectSequenceKey(r.sequence))))corrupt();
 if(row.status==='registered'&&row.observation!==null||row.status!=='registered'&&!row.observation)corrupt();
 if(row.observation){const o=row.observation;if(!exact(o,['sequence','previous_hash','effect_id','descriptor_hash','status','result','recorded_at','hash'])||
  o.effect_id!==id||o.descriptor_hash!==row.descriptor_hash||o.status!==row.status||!hash(o.hash)||o.hash!==await sha256(canonical({kind:'effect-observation-v1',...Object.fromEntries(Object.entries(o).filter(([k])=>k!=='hash'))}))||
  !equal(o,await txn.get(observationKey(o.sequence))))corrupt();}
 return row;
}
async function appendObservation(txn,head,row,status,result,now){
 if(head.observation_sequence===Number.MAX_SAFE_INTEGER)fail(503,'journal_sequence_exhausted');
 const o={sequence:head.observation_sequence+1,previous_hash:head.observation_hash,effect_id:row.descriptor.effect_id,
  descriptor_hash:row.descriptor_hash,status,result,recorded_at:now()};
 if(!uint(o.recorded_at)||o.recorded_at<1)fail(503,'journal_clock_invalid');
 o.hash=await sha256(canonical({kind:'effect-observation-v1',...o}));
 const next={...row,status,observation:o},heads={...head,observation_sequence:o.sequence,observation_hash:o.hash};
 await txn.put({[effectKey(o.effect_id)]:next,[observationKey(o.sequence)]:o,[EFFECT_HEAD]:heads});return next;
}
export async function registerEffect(storage,raw,now=Date.now){
 const descriptor=validateEffect(raw),descriptor_hash=await sha256(canonical(descriptor));
 return storage.transaction(async txn=>{
  await loadHead(txn);const control=await loadControl(txn);if(!control)fail(409,'control_uninitialized');
  const old=await checkedEffect(txn,descriptor.effect_id);
  if(old){if(old.descriptor_hash!==descriptor_hash||!equal(old.descriptor,descriptor))fail(409,'effect_conflict');return {...envelope(control),effect:old};}
  if(control.state!=='serving'||!equal(control.marker,descriptor.expected))fail(409,'effect_generation_retired');
  const head=await effectHeads(txn);if(head.sequence===Number.MAX_SAFE_INTEGER)fail(503,'journal_sequence_exhausted');
  const r={sequence:head.sequence+1,previous_hash:head.hash,descriptor_hash,effect_id:descriptor.effect_id,recorded_at:now()};
  if(!uint(r.recorded_at)||r.recorded_at<1)fail(503,'journal_clock_invalid');r.hash=await sha256(canonical({kind:'effect-registration-v1',...r}));
  const row={descriptor,descriptor_hash,registration:r,status:'registered',observation:null};
  await txn.put({[effectKey(descriptor.effect_id)]:row,[effectSequenceKey(r.sequence)]:r,[EFFECT_HEAD]:{...head,sequence:r.sequence,hash:r.hash}});
  return {...envelope(control),effect:row};
 });
}
export async function dispatchEffect(storage,id,raw,now=Date.now){
 if(!uuid(id)||!exact(raw,['version','project_id','descriptor_hash','incarnation_id'])||raw.version!==1||raw.project_id!==PROJECT_ID||!hash(raw.descriptor_hash)||!uuid(raw.incarnation_id))fail(400,'effect_invalid');
 return storage.transaction(async txn=>{
  await loadHead(txn);const control=await loadControl(txn),row=await checkedEffect(txn,id);if(!control||!row)fail(404,'effect_not_found');
  if(row.descriptor_hash!==raw.descriptor_hash||row.descriptor.expected.incarnation_id!==raw.incarnation_id)fail(409,'effect_conflict');
  if(control.state!=='serving'||control.marker.incarnation_id!==raw.incarnation_id)fail(409,'effect_generation_retired');
  // A repeated dispatch receipt cannot start a second provider request.
  if(row.status!=='registered')fail(409,'effect_already_dispatched');
  const next=await appendObservation(txn,await effectHeads(txn),row,'dispatching',{dispatch_id:crypto.randomUUID()},now);
  return {...envelope(control),effect:next};
 });
}
export async function observeEffect(storage,id,raw,now=Date.now){
 if(!uuid(id)||!exact(raw,['version','project_id','descriptor_hash','status','result'])||raw.version!==1||raw.project_id!==PROJECT_ID||!hash(raw.descriptor_hash)||
  !['succeeded','rejected','unknown','materialized'].includes(raw.status)||!exact(raw.result,['http_status','sha256','byte_size','etag'])||
  !(raw.result.http_status===null||Number.isInteger(raw.result.http_status)&&raw.result.http_status>=100&&raw.result.http_status<=599)||
  !(raw.result.sha256===null||hash(raw.result.sha256))||!(raw.result.byte_size===null||uint(raw.result.byte_size))||
  !(raw.result.etag===null||typeof raw.result.etag==='string'&&/^[\x20-\x7e]{1,256}$/.test(raw.result.etag)))fail(400,'effect_observation_invalid');
 return storage.transaction(async txn=>{
  await loadHead(txn);const control=await loadControl(txn),row=await checkedEffect(txn,id);if(!control||!row)fail(404,'effect_not_found');
  if(row.descriptor_hash!==raw.descriptor_hash)fail(409,'effect_conflict');
  if(raw.status==='succeeded'&&!(raw.result.http_status>=200&&raw.result.http_status<=299)||
     raw.status==='rejected'&&!(raw.result.http_status>=400&&raw.result.http_status<=499)||
     raw.status==='materialized'&&(row.descriptor.kind!=='storage-put'||raw.result.sha256!==row.descriptor.payload_hash||raw.result.byte_size!==row.descriptor.byte_size||raw.result.etag===null))fail(400,'effect_observation_invalid');
  if(row.status===raw.status&&equal(row.observation?.result,raw.result))return {...envelope(control),effect:row};
  if(!['dispatching','unknown'].includes(row.status))fail(409,'effect_terminal_conflict');
  const next=await appendObservation(txn,await effectHeads(txn),row,raw.status,raw.result,now);
  return {...envelope(control),effect:next};
 });
}
export async function cancelUndispatchedEffect(txn,row,now=Date.now){
 if(row.status!=='registered')return row;
 return appendObservation(txn,await effectHeads(txn),row,'cancelled',{never_dispatched:true},now);
}
export async function readEffectPage(storage,raw){
 if(!exact(raw,['version','project_id','after','limit'])||raw.version!==1||raw.project_id!==PROJECT_ID||!uint(raw.after)||!Number.isInteger(raw.limit)||raw.limit<1||raw.limit>32)fail(400,'effect_page_invalid');
 return storage.transaction(async txn=>{
  await loadHead(txn);const control=await loadControl(txn);if(!control)fail(409,'control_uninitialized');const head=await effectHeads(txn);
  if(raw.after>head.sequence)fail(409,'effect_page_invalid');const effects=[];
  for(let n=raw.after+1;n<=Math.min(raw.after+raw.limit,head.sequence);n++){
   const entry=await txn.get(effectSequenceKey(n));if(!entry)corrupt();const row=await checkedEffect(txn,entry.effect_id);if(!row||row.registration.sequence!==n)corrupt();effects.push(row);
  }
  return {...envelope(control),head,effects,next:raw.after+effects.length,complete:raw.after+effects.length===head.sequence};
 });
}
export async function lookupEffect(storage,id){
 if(!uuid(id))fail(400,'effect_invalid');return storage.transaction(async txn=>{await loadHead(txn);const control=await loadControl(txn);if(!control)fail(409,'control_uninitialized');
 const effect=await checkedEffect(txn,id);if(!effect)fail(404,'effect_not_found');return {...envelope(control),effect};});
}
