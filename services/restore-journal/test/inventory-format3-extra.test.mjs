/** External candidate; root executes after review against matching frozen src. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fixture,id,hash,v2,operationInput,linkInput,expectedError,PROJECT_ID,canonical,sha256} from './inventory-fixtures.mjs';
import {event} from './fixtures.mjs';
import {descriptor as d2Fixture,link as l2Fixture} from './inventory-descriptors-v2-fixtures.mjs';
import {CONTROL_KEY} from '../src/operations.mjs';
import {upgradeInventoryCapability,prepareInventory,acknowledgeInventory,readInventoryControl,observeHistoricalReply,beginInventoryRecovery,readInventoryProgress,readInventoryPage,admitInventory,observeInventory,acknowledgeInventoryPage} from '../src/inventory.mjs';
const opt=f=>({...f.options,format:3,pageLimit:8});const snapshot=f=>structuredClone(f.storage.rows);
async function flip(f){const c=f.control,input={version:3,project_id:PROJECT_ID,capability_id:id(),expected_marker:c.marker,expected_control_hash:await sha256(canonical(c)),expected_restriction_head:c.marker.cursor,expected_registration_head:c.registration_head,expected_observation_head:c.observation_head};const result=await upgradeInventoryCapability(f.storage,input,{...f.options,pageLimit:8});f.control=result.control;return {input,result,old:c};}
async function commit3(f,op){const ack=v2({plan_hash:op.plan_hash,marker:op.plan.next,writer_generation_id:op.plan.writer_generation_id});const r=await acknowledgeInventory(f.storage,op.plan.operation_id,ack,opt(f));f.control=r.control;return {ack,result:r};}
async function media3(f){const d=d2Fixture({minor:true}).value,raw=operationInput(f,{operation_id:d.operation_id,allocations:{id_0:d.write_id}});d.database_id=raw.expected.database_id;d.incarnation_id=raw.expected.incarnation_id;d.writer_generation_id=raw.writer_generation_id;raw.resources=[d];const op=(await prepareInventory(f.storage,raw,opt(f))).operation;f.control=(await readInventoryControl(f.storage,opt(f))).control;await commit3(f,op);return {d,op};}
function late(cap,target){return {version:3,project_id:PROJECT_ID,capability_id:cap.input.capability_id,original_writer_generation_id:cap.old.writer_generation_id,observation:v2({observation_id:id(),write_id:target.item.write_id,registration_hash:target.operation.plan.inventory_receipts[0].hash,plan_hash:target.operation.plan_hash,kind:'put-reply',result:{outcome:'unknown',http_status:null,evidence_hash:hash()}})};}

test('mixed history enumerates eight plus one registration and observations, and enforces the 32-event boundary',async()=>{
 const f=await fixture(),d1=await f.put(),oldLink=await linkInput(f,d1),oldOp=await f.prepare(oldLink);await f.commit(oldOp);const oldObservation=await f.observation(d1);await flip(f);
 const {d,op}=await media3(f),link=await l2Fixture(d),newOp=(await prepareInventory(f.storage,operationInput(f,{operation_id:link.operation_id,links:[link]}),opt(f))).operation;f.control=(await readInventoryControl(f.storage,opt(f))).control;await commit3(f,newOp);
 const extras=[];for(let i=0;i<5;i++)extras.push(await media3(f));
 const newObservation=v2({observation_id:id(),write_id:d.write_id,registration_hash:op.plan.inventory_receipts[0].hash,plan_hash:op.plan_hash,kind:'put-reply',result:{outcome:'unknown',http_status:null,evidence_hash:hash()}});
 const seen=await observeInventory(f.storage,newObservation,opt(f));f.control=seen.control;
 const invalid=operationInput(f,{events:Array.from({length:33},()=>event())}),before=snapshot(f);await assert.rejects(()=>prepareInventory(f.storage,invalid,opt(f)),expectedError(400,'operation_invalid'));assert.deepEqual(snapshot(f),before);
 const facts=Array.from({length:32},()=>event()),input=operationInput(f,{events:facts}),batch=(await prepareInventory(f.storage,input,opt(f))).operation;f.control=(await readInventoryControl(f.storage,opt(f))).control;await commit3(f,batch);
 assert.equal(batch.plan.receipts.length,32);assert.deepEqual(batch.plan.receipts.map(r=>r.event),facts);assert.equal(f.control.marker.cursor.sequence,32);
 const recovery=await beginInventoryRecovery(f.storage,v2({recovery_id:id(),cut_id:id(),expected:f.control.marker,writer_generation_id:f.control.writer_generation_id}),opt(f)),rid=recovery.recovery.recovery_id;
 const initial=await readInventoryProgress(f.storage,rid,'registrations',opt(f)),beforeLimit=snapshot(f);
 await assert.rejects(()=>readInventoryPage(f.storage,rid,'registrations',{cut_id:recovery.cut.cut_id,after:initial.progress.state.cursor,limit:9},opt(f)),expectedError(400,'inventory_page_limit_invalid'));
 assert.deepEqual(snapshot(f),beforeLimit);
 async function pageAndAcknowledge(chain,limit){const progress=await readInventoryProgress(f.storage,rid,chain,opt(f));const page=await readInventoryPage(f.storage,rid,chain,{cut_id:recovery.cut.cut_id,after:progress.progress.state.cursor,limit},opt(f));
  const ack=v2({recovery_id:rid,recovery_generation_id:page.recovery_generation_id,chain,cut_id:page.cut_id,cut_hash:page.cut_hash,expected_state_hash:progress.progress.state_hash,after:page.after,limit,page_hash:page.page_hash,next:page.next});
  const accepted=await acknowledgeInventoryPage(f.storage,rid,ack,opt(f)),after=snapshot(f),duplicate=await acknowledgeInventoryPage(f.storage,rid,ack,opt(f));assert.deepEqual(duplicate.acknowledgement,accepted.acknowledgement);assert.deepEqual(snapshot(f),after);return {page,accepted};}
 const first=await pageAndAcknowledge('registrations',8);assert.equal(first.page.records.length,8);assert.equal(first.page.has_more,true);assert.equal(first.page.enumeration_at_cut_end,false);
 const last=await pageAndAcknowledge('registrations',8);assert.equal(last.page.records.length,1);assert.equal(last.page.has_more,false);assert.equal(last.page.enumeration_at_cut_end,true);assert.deepEqual(last.page.after,first.page.next);
 const records=[...first.page.records,...last.page.records];assert.deepEqual(records.map(r=>[r.payload.entry_kind,r.payload.item.version]),[['write',1],['link',1],['write',2],['link',2],...extras.map(()=>['write',2])]);
 assert.deepEqual(records.map(r=>r.hash),[d1.operation.plan.inventory_receipts[0].hash,oldOp.plan.inventory_receipts[0].hash,op.plan.inventory_receipts[0].hash,newOp.plan.inventory_receipts[0].hash,...extras.map(x=>x.op.plan.inventory_receipts[0].hash)]);
 const observations=await pageAndAcknowledge('observations',8);assert.deepEqual(observations.page.records.map(r=>r.hash),[oldObservation.record.hash,seen.observation.hash]);assert.equal(observations.page.enumeration_at_cut_end,true);
 assert.equal(recovery.control.state,'quarantined');assert.equal(recovery.clearance_available,false);
});

test('same generation retries preserve exact receipt; post-recovery old credential stays fenced',async()=>{
 const f=await fixture();await flip(f);const input=operationInput(f),p=await prepareInventory(f.storage,input,opt(f));f.control=p.control;let before=snapshot(f);assert.equal((await prepareInventory(f.storage,input,opt(f))).operation.plan_hash,p.operation.plan_hash);assert.deepEqual(snapshot(f),before);
 const {ack,result}=await commit3(f,p.operation);before=snapshot(f);assert.deepEqual((await acknowledgeInventory(f.storage,input.operation_id,ack,opt(f))).operation,result.operation);assert.deepEqual(snapshot(f),before);
 const recoveryInput=v2({recovery_id:id(),cut_id:id(),expected:f.control.marker,writer_generation_id:f.control.writer_generation_id}),recovery=await beginInventoryRecovery(f.storage,recoveryInput,opt(f));f.control=recovery.control;before=snapshot(f);
 await assert.rejects(()=>prepareInventory(f.storage,input,opt(f)),expectedError(409,'writer_generation_stale'));await assert.rejects(()=>acknowledgeInventory(f.storage,input.operation_id,ack,opt(f)),expectedError(409,'writer_generation_stale'));
 await assert.rejects(()=>admitInventory(f.storage,v2({marker:f.control.marker,writer_generation_id:f.control.writer_generation_id,operation_version:2,inventory_protocol:1}),opt(f)),expectedError(409,'serving_quarantined'));
 const replay=await beginInventoryRecovery(f.storage,recoveryInput,opt(f));assert.equal(replay.immutable_evidence_only,true);assert.equal(replay.clearance_available,false);assert.deepEqual(snapshot(f),before);
});

for(const which of ['observer-hash','observer-input','cap-old-generation','archive-marker'])test('f3 corrupted '+which+' fails closed with no mutation',async()=>{
 const f=await fixture(),target=await f.put(),cap=await flip(f),reply=late(cap,target);await observeHistoricalReply(f.storage,reply,opt(f));
 if(which==='observer-hash')f.storage.rows.get('inventory:observation:'+reply.observation.observation_id).hash='b'.repeat(64);
 if(which==='observer-input')f.storage.rows.get('inventory:observation:'+reply.observation.observation_id).input_hash='b'.repeat(64);
 if(which==='cap-old-generation')f.storage.rows.get('inventory:capability:'+cap.input.capability_id).old_writer_generation_id=id();
 if(which==='archive-marker')f.storage.rows.get('inventory:capability-archive:'+cap.input.capability_id).marker.checkpoint.hash='b'.repeat(64);
 const before=snapshot(f);await assert.rejects(()=>readInventoryControl(f.storage,opt(f)),expectedError(503,'inventory_integrity_failed'));assert.deepEqual(snapshot(f),before);
});
