/** Prepared only: synthetic memory tests; root runs after independent review. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fixture,id,hash,v2,operationInput,deleteInput,expectedError,PROJECT_ID,canonical,sha256,env} from './inventory-fixtures.mjs';
import {CONTROL_KEY,commitKey} from '../src/operations.mjs';
import {upgradeInventoryCapability,readInventoryControl,prepareInventory,acknowledgeInventory,observeHistoricalReply,
 beginInventoryRecovery,handleInventoryRequest,observeInventory,admitInventory,dispatchInventory,createInventoryCut,readInventoryProgress,readInventoryPage,acknowledgeInventoryPage} from '../src/inventory.mjs';
import worker,{RestoreJournal} from '../src/worker.mjs';
import {descriptor as d2Fixture,link as l2Fixture} from './inventory-descriptors-v2-fixtures.mjs';
const opt=f=>({...f.options,format:3,pageLimit:8});
const rows=f=>structuredClone(f.storage.rows);
async function capInput(f){const c=f.storage.rows.get(CONTROL_KEY);return {version:3,project_id:PROJECT_ID,capability_id:id(),expected_marker:c.marker,
 expected_control_hash:await sha256(canonical(c)),expected_restriction_head:c.marker.cursor,expected_registration_head:c.registration_head,expected_observation_head:c.observation_head};}
async function flip(f){const input=await capInput(f),old=f.control,result=await upgradeInventoryCapability(f.storage,input,{...f.options,pageLimit:8});f.control=result.control;return {input,old,result};}
async function commit3(f,operation){const result=await acknowledgeInventory(f.storage,operation.plan.operation_id,v2({plan_hash:operation.plan_hash,marker:operation.plan.next,writer_generation_id:operation.plan.writer_generation_id}),opt(f));f.control=result.control;return result.operation;}
function lateInput(cap,target,kind='put-reply'){return {version:3,project_id:PROJECT_ID,capability_id:cap.input.capability_id,original_writer_generation_id:cap.old.writer_generation_id,
 observation:v2({observation_id:id(),write_id:target.item.write_id,registration_hash:target.operation.plan.inventory_receipts[0].hash,plan_hash:target.operation.plan_hash,kind,
 result:{outcome:'unknown',http_status:null,evidence_hash:hash()}})};}
async function post(path,body,token,handler,extra={}){return handler(new Request('https://journal.invalid'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,...body===undefined?{}:{'content-type':'application/json'},...extra},...body===undefined?{}:{body:canonical(body)}}));}

test('format2 capability transition archives exact old state and retries without new generation',async()=>{
 const f=await fixture({history:true}),target=await f.put(),oldRows=rows(f),cap=await flip(f);
 assert.equal(cap.result.control.version,3);assert.notEqual(cap.result.control.writer_generation_id,cap.old.writer_generation_id);
 assert.deepEqual(f.storage.rows.get('inventory:capability-archive:'+cap.input.capability_id),oldRows.get(CONTROL_KEY));
 for(const [key,value] of oldRows)if(key!==CONTROL_KEY)assert.deepEqual(f.storage.rows.get(key),value,key);
 assert.deepEqual((await upgradeInventoryCapability(f.storage,cap.input,{...f.options,pageLimit:8})).capability,cap.result.capability);
 await assert.rejects(()=>readInventoryControl(f.storage,f.options),expectedError(409,'protocol_version_unsupported'));
 const control=await readInventoryControl(f.storage,opt(f));assert.equal(control.control.version,3);assert.equal(target.operation.plan.inventory_receipts.length,1);
});
test('frozen cutoff remains valid after later empty checkpoint, O advance, pending and quarantine',async()=>{
 const f=await fixture({history:true}),target=await f.put(),cap=await flip(f);
 const empty=await prepareInventory(f.storage,operationInput(f),opt(f));f.control=empty.control;await commit3(f,empty.operation);
 const first=lateInput(cap,target);const observed=await observeHistoricalReply(f.storage,first,opt(f));f.control=observed.control;
 const pending=await prepareInventory(f.storage,operationInput(f),opt(f));f.control=pending.control;assert.equal((await readInventoryControl(f.storage,opt(f))).control.state,'pending');
 const second=lateInput(cap,target);await observeHistoricalReply(f.storage,second,opt(f));await commit3(f,pending.operation);
 const recovery=await beginInventoryRecovery(f.storage,v2({recovery_id:id(),cut_id:id(),expected:f.control.marker,writer_generation_id:f.control.writer_generation_id}),opt(f));f.control=recovery.control;
 assert.equal((await readInventoryControl(f.storage,opt(f))).control.state,'quarantined');const late=await observeHistoricalReply(f.storage,lateInput(cap,target),opt(f));assert.equal(late.control.state,'quarantined');
});
for(const slot of ['receipt','archive','generation','old-origin','cutoff-registration','cutoff-commit'])test('corrupted '+slot+' is denied on normal control admission',async()=>{
 const f=await fixture({history:true});await f.put();const cap=await flip(f),r=cap.result.capability;
 const key=slot==='receipt'?'inventory:capability:'+cap.input.capability_id:slot==='archive'?'inventory:capability-archive:'+cap.input.capability_id:
 slot==='generation'?'inventory:writer-generation:'+r.new_writer_generation_id:slot==='old-origin'?'inventory:upgrade:'+cap.old.upgrade_id:
 slot==='cutoff-registration'?'inventory:r:'+String(r.registration_head.sequence).padStart(16,'0'):commitKey(r.marker.checkpoint.revision);
 assert(f.storage.rows.has(key));f.storage.rows.delete(key);const before=rows(f);await assert.rejects(()=>readInventoryControl(f.storage,opt(f)),expectedError(503));assert.deepEqual(rows(f),before);
});
test('late D1 PUT preserves current control fields and duplicate immutable receipt',async()=>{
 const f=await fixture(),target=await f.put(),cap=await flip(f),before=structuredClone(f.control),input=lateInput(cap,target);
 const first=await observeHistoricalReply(f.storage,input,opt(f)),next=first.control;
 for(const key of Object.keys(before).filter(k=>k!=='observation_head'))assert.deepEqual(next[key],before[key],key);
 assert.equal(next.observation_head.sequence,before.observation_head.sequence+1);
 const after=rows(f),again=await observeHistoricalReply(f.storage,input,opt(f));assert.deepEqual(again.observation,first.observation);assert.deepEqual(rows(f),after);
 const changed=structuredClone(input);changed.observation.result.outcome='success';await assert.rejects(()=>observeHistoricalReply(f.storage,changed,opt(f)),expectedError(409));
});
test('late D1 DELETE validates exact original target and permanent retirement',async()=>{
 const f=await fixture(),target=await f.put(),del=await deleteInput(f,target),op=await f.prepare(del);await f.commit(op);
 const cap=await flip(f),item=del.resources[0],input=lateInput(cap,{item,operation:op},'delete-reply');
 const before=structuredClone(f.control),result=await observeHistoricalReply(f.storage,input,opt(f));
 assert.equal(result.control.observation_head.sequence,before.observation_head.sequence+1);
 const bad=structuredClone(input);bad.observation.observation_id=id();bad.observation.kind='put-reply';const state=rows(f);
 await assert.rejects(()=>observeHistoricalReply(f.storage,bad,opt(f)),expectedError(409));assert.deepEqual(rows(f),state);
});
test('unverifiable original PUT commit denies historical DELETE observation',async()=>{
 const f=await fixture(),target=await f.put(),del=await deleteInput(f,target),op=await f.prepare(del);await f.commit(op);const cap=await flip(f);
 f.storage.rows.delete(commitKey(target.operation.plan.next.checkpoint.revision));const state=rows(f),input=lateInput(cap,{item:del.resources[0],operation:op},'delete-reply');
 await assert.rejects(()=>observeHistoricalReply(f.storage,input,opt(f)),expectedError(503));assert.deepEqual(rows(f),state);
});
test('historical D1 cannot be newly prepared or dispatched under f3',async()=>{
 const f=await fixture(),target=await f.put(),cap=await flip(f),old=structuredClone(target.input);old.operation_id=id();old.expected=f.control.marker;old.writer_generation_id=f.control.writer_generation_id;old.resources[0].operation_id=old.operation_id;
 old.resources[0].writer_generation_id=old.writer_generation_id;const before=rows(f);await assert.rejects(()=>prepareInventory(f.storage,old,opt(f)),expectedError(409));assert.deepEqual(rows(f),before);
});
test('scoped observer is denied by default and independently enforced on DO route',async()=>{
 const f=await fixture(),target=await f.put(),cap=await flip(f),value=lateInput(cap,target),observer='fixture-only-observer-token-0123456789abcdef';
 const route='/v3/inventory/late-observations',without={...env,RESTORE_INVENTORY_PAGE_LIMIT:'8'},withObserver={...without,RESTORE_JOURNAL_OBSERVER_TOKEN:observer};
 const disabled=await post(route,value,observer,request=>new RestoreJournal({storage:f.storage},without).fetch(request));assert.equal(disabled.status,503);
 const admin=await post(route,value,env.RESTORE_JOURNAL_TOKEN,request=>new RestoreJournal({storage:f.storage},withObserver).fetch(request));assert.equal(admin.status,401);
 const good=await post(route,value,observer,request=>new RestoreJournal({storage:f.storage},withObserver).fetch(request));assert.equal(good.status,200);
 const forged=await post('/v3/operations/prepare',operationInput(f),observer,request=>new RestoreJournal({storage:f.storage},withObserver).fetch(request),{'x-role':'admin'});assert.equal(forged.status,401);
 const equal={...without,RESTORE_JOURNAL_OBSERVER_TOKEN:env.RESTORE_JOURNAL_TOKEN};const denied=await post(route,value,env.RESTORE_JOURNAL_TOKEN,request=>handleInventoryRequest(request,equal,f.storage));assert.equal(denied.status,503);
});

test('D2 committed registration and exact L2 link survive f3 prepare, commit and lookup',async()=>{
 const f=await fixture(),cap=await flip(f),source=d2Fixture({minor:true}),d=source.value,initial=operationInput(f,{operation_id:d.operation_id,allocations:{id_0:d.write_id}});
 d.database_id=initial.expected.database_id;d.incarnation_id=initial.expected.incarnation_id;d.writer_generation_id=initial.writer_generation_id;initial.resources=[d];
 const prepared=await prepareInventory(f.storage,initial,opt(f));f.control=prepared.control;await commit3(f,prepared.operation);
 const l=await l2Fixture(d),publish=operationInput(f,{operation_id:l.operation_id,links:[l]});
 const linked=await prepareInventory(f.storage,publish,opt(f));f.control=linked.control;await commit3(f,linked.operation);
 assert.equal((await readInventoryControl(f.storage,opt(f))).control.state,'serving');
 assert.equal(linked.operation.plan.links[0].target_write_id,d.write_id);assert.equal(linked.operation.plan.links[0].authority_episode_hash,await sha256(canonical(d.authority)));
});

test('scoped observer is independently enforced before Worker namespace lookup and DO mutation',async()=>{
 const f=await fixture(),target=await f.put(),cap=await flip(f),value=lateInput(cap,target),observer='fixture-only-observer-token-0123456789abcdef';let lookups=0;
 const config={...env,RESTORE_INVENTORY_PAGE_LIMIT:'8',RESTORE_JOURNAL_OBSERVER_TOKEN:observer};
 const instance=new RestoreJournal({storage:f.storage},config);config.RESTORE_JOURNAL={jurisdiction(region){assert.equal(region,'eu');return {idFromName(){lookups++;return 'fixture';},get(){return instance;}};}};
 const call=token=>post('/v3/inventory/late-observations',value,token,request=>worker.fetch(request,config));const before=rows(f);
 assert.equal((await call(env.RESTORE_JOURNAL_TOKEN)).status,401);assert.equal(lookups,0);assert.deepEqual(rows(f),before);
 assert.equal((await call(observer)).status,200);assert.equal(lookups,1);
 const scopedWriter=await post('/v3/operations/prepare',operationInput(f),observer,request=>worker.fetch(request,config),{'x-role':'admin'});assert.equal(scopedWriter.status,401);assert.equal(lookups,1);
});

/** Synthetic scheduling checks only; native SQLite commit gap remains separate. */
class CommitGapStorage extends (await import('./fixtures.mjs')).MemoryStorage {
 arm(){const entered=Promise.withResolvers(),release=Promise.withResolvers(),completed=Promise.withResolvers();return this.gap={entered,release,completed,consumed:false,committed:false};}
 async transaction(callback){const gap=this.gap;this.gap=undefined;try{const result=await super.transaction(async tx=>{const value=await callback(tx);if(gap){gap.consumed=true;gap.entered.resolve();await gap.release.promise;}return value;});if(gap)gap.committed=true;return result;}finally{gap?.completed.resolve();}}
}
for(const kind of ['capability','late'])for(const mode of ['abort','deadline'])test(`${kind} f3 final-callback-to-commit loss reconciles exact outcome (${mode})`,{timeout:12000},async()=>{
 const storage=new CommitGapStorage(),f=await fixture({storage});let body,path,token=env.RESTORE_JOURNAL_TOKEN,config={...env,RESTORE_INVENTORY_PAGE_LIMIT:'8'};
 if(kind==='capability'){body=await capInput(f);path='/v3/control/capability';}
 else{const target=await f.put(),cap=await flip(f);body=lateInput(cap,target);path='/v3/inventory/late-observations';token='fixture-only-observer-token-0123456789abcdef';config.RESTORE_JOURNAL_OBSERVER_TOKEN=token;}
 const before=rows(f),gap=storage.arm(),controller=new AbortController(),watchdog=setTimeout(()=>gap.release.resolve(),6000);
 try{
  const request=new Request('https://journal.invalid'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:canonical(body),signal:controller.signal});
  const pending=handleInventoryRequest(request,config,storage,{now:f.options.now,deadlineMs:mode==='deadline'?1000:5000});
  await Promise.race([gap.entered.promise,pending.then(()=>{if(!gap.consumed)assert.fail('request failed before final callback/commit gap');})]);assert(gap.consumed&&!gap.committed);
  if(mode==='abort')controller.abort();const rejected=await pending;assert.equal(rejected.status,503);assert.deepEqual(rows(f),before);
  gap.release.resolve();await gap.completed.promise;assert(gap.committed);
  if(kind==='capability'){const result=await upgradeInventoryCapability(storage,body,{...f.options,pageLimit:8});assert.equal(result.control.version,3);assert.equal(result.capability.capability_id,body.capability_id);}
  else{const result=await observeHistoricalReply(storage,body,opt(f));assert.equal(result.observation.payload.observation_id,body.observation.observation_id);}
 }finally{clearTimeout(watchdog);gap.release.resolve();if(gap.consumed)await gap.completed.promise;}
});


test('ordinary observations reject historical D1 including duplicates without changing storage',async()=>{
 const f=await fixture(),target=await f.put(),prior=await f.observation(target),cap=await flip(f),old=lateInput(cap,target).observation,before=rows(f);
 await assert.rejects(()=>observeInventory(f.storage,old,opt(f)),expectedError(409,'inventory_observation_not_current'));
 await assert.rejects(()=>observeInventory(f.storage,prior.input,opt(f)),expectedError(409,'inventory_observation_not_current'));assert.deepEqual(rows(f),before);
});
test('stale f2 prepare and conflicting acknowledgement cannot quarantine f3',async()=>{
 const f=await fixture(),old=operationInput(f),operation=await f.prepare(old);await f.commit(operation);await flip(f);const before=rows(f);
 await assert.rejects(()=>prepareInventory(f.storage,old,opt(f)),expectedError(409,'writer_generation_stale'));
 const ack=v2({plan_hash:'b'.repeat(64),marker:operation.plan.next,writer_generation_id:old.writer_generation_id});
 await assert.rejects(()=>acknowledgeInventory(f.storage,old.operation_id,ack,opt(f)),expectedError(409,'writer_generation_stale'));assert.deepEqual(rows(f),before);
});
test('equal or malformed observer credentials disable all routes at Worker and DO',async()=>{
 const f=await fixture();await flip(f);let lookups=0;const route='/v3/control',before=rows(f);
 for(const observer of [env.RESTORE_JOURNAL_TOKEN,'bad']){const config={...env,RESTORE_INVENTORY_PAGE_LIMIT:'8',RESTORE_JOURNAL_OBSERVER_TOKEN:observer};
  const instance=new RestoreJournal({storage:f.storage},config);config.RESTORE_JOURNAL={jurisdiction(){lookups++;return {idFromName(){return 'x';},get(){return instance;}};}};
  assert.equal((await post(route,undefined,env.RESTORE_JOURNAL_TOKEN,r=>worker.fetch(r,config))).status,503);
  assert.equal((await post(route,undefined,env.RESTORE_JOURNAL_TOKEN,r=>instance.fetch(r))).status,503);
 }assert.equal(lookups,0);assert.deepEqual(rows(f),before);
});
test('capability rejects excessive direct page limit and respects origin timestamp on clock rollback',async()=>{
 const f=await fixture(),input=await capInput(f),before=rows(f);
 await assert.rejects(()=>upgradeInventoryCapability(f.storage,input,{...f.options,pageLimit:9}),expectedError(503,'inventory_configuration_invalid'));assert.deepEqual(rows(f),before);
 const origin=f.storage.rows.get('inventory:upgrade:'+f.control.upgrade_id);
 const result=await upgradeInventoryCapability(f.storage,input,{...f.options,pageLimit:8,now:()=>1});
 assert(result.capability.recorded_at>=origin.recorded_at);assert.equal((await readInventoryControl(f.storage,opt(f))).control.version,3);
});
for(const kind of ['capability','late'])test(kind+' snapshots wrapper before first await',async()=>{
 const f=await fixture();let input,call;
 if(kind==='capability'){input=await capInput(f);call=options=>upgradeInventoryCapability(f.storage,input,options);}
 else{const target=await f.put(),cap=await flip(f);input=lateInput(cap,target);call=options=>observeHistoricalReply(f.storage,input,options);}
 const saved=structuredClone(input),entered=Promise.withResolvers(),release=Promise.withResolvers();let first=true;
 const gate={check(){},async wait(p){return p;},async hash(text){if(first){first=false;entered.resolve();await release.promise;}return sha256(text);}};
 const pending=call({...f.options,pageLimit:8,gate});await entered.promise;input.capability_id=id();if(input.observation)input.observation.write_id=id();release.resolve();
 const result=await pending;if(kind==='capability')assert.equal(result.capability.capability_id,saved.capability_id);else assert.equal(result.observation.payload.write_id,saved.observation.write_id);
});

test('ordinary f3 observation requires committed D2 in current serving generation',async()=>{
 const f=await fixture();await flip(f);const source=d2Fixture({minor:true}),d=source.value,input=operationInput(f,{operation_id:d.operation_id,allocations:{id_0:d.write_id}});
 d.database_id=input.expected.database_id;d.incarnation_id=input.expected.incarnation_id;d.writer_generation_id=input.writer_generation_id;input.resources=[d];
 const prepared=await prepareInventory(f.storage,input,opt(f));f.control=prepared.control;
 const obs=v2({observation_id:id(),write_id:d.write_id,registration_hash:prepared.operation.plan.inventory_receipts[0].hash,plan_hash:prepared.operation.plan_hash,kind:'put-reply',result:{outcome:'unknown',http_status:null,evidence_hash:hash()}});
 const pending=rows(f);await assert.rejects(()=>observeInventory(f.storage,obs,opt(f)),expectedError(409));assert.deepEqual(rows(f),pending);
 await commit3(f,prepared.operation);const result=await observeInventory(f.storage,obs,opt(f));assert.equal(result.observation.payload.write_id,d.write_id);
 const committed=rows(f),again=await observeInventory(f.storage,obs,opt(f));assert.deepEqual(again.observation,result.observation);assert.deepEqual(rows(f),committed);
});
test('persisted D2/L2 corruption fails closed without writes',async()=>{
 const f=await fixture();await flip(f);const d=d2Fixture({minor:true}).value,input=operationInput(f,{operation_id:d.operation_id,allocations:{id_0:d.write_id}});
 d.database_id=input.expected.database_id;d.incarnation_id=input.expected.incarnation_id;d.writer_generation_id=input.writer_generation_id;input.resources=[d];
 const first=await prepareInventory(f.storage,input,opt(f));f.control=first.control;await commit3(f,first.operation);
 const link=await l2Fixture(d),next=await prepareInventory(f.storage,operationInput(f,{operation_id:link.operation_id,links:[link]}),opt(f));f.control=next.control;await commit3(f,next.operation);
 const sequence=next.operation.plan.inventory_receipts[0].sequence,key='inventory:r:'+String(sequence).padStart(16,'0');
 f.storage.rows.get(key).payload.item.authority_episode_hash='b'.repeat(64);const before=rows(f);
 await assert.rejects(()=>readInventoryControl(f.storage,opt(f)),expectedError(503,'inventory_integrity_failed'));assert.deepEqual(rows(f),before);
});


test('same-generation prepare and commit retries remain idempotent in f3',async()=>{
 const f=await fixture();await flip(f);const input=operationInput(f);const first=await prepareInventory(f.storage,input,opt(f));f.control=first.control;
 const beforePending=rows(f),again=await prepareInventory(f.storage,input,opt(f));assert.equal(again.operation.plan_hash,first.operation.plan_hash);assert.deepEqual(rows(f),beforePending);
 await commit3(f,first.operation);const beforeCommitted=rows(f);const ack=v2({plan_hash:first.operation.plan_hash,marker:first.operation.plan.next,writer_generation_id:first.operation.plan.writer_generation_id});
 const retried=await acknowledgeInventory(f.storage,input.operation_id,ack,opt(f));assert.equal(retried.operation.status,'committed');assert.deepEqual(rows(f),beforeCommitted);
});


async function held(call, mutate){
 const entered=Promise.withResolvers(),release=Promise.withResolvers();let first=true,open=false;
 const pause=async()=>{if(first){first=false;entered.resolve();}if(!open)await release.promise;};
 const gate={check(){},async wait(p){await pause();return p;},async hash(text){await pause();return sha256(text);}};
 const pending=call(gate);await entered.promise;mutate();open=true;release.resolve();return pending;
}
test('f3 held-await admission and write envelopes use only the frozen input',async()=>{
 const f=await fixture();await flip(f);let input=v2({marker:structuredClone(f.control.marker),writer_generation_id:f.control.writer_generation_id,operation_version:2,inventory_protocol:1}),saved=structuredClone(input);
 const before=rows(f);const admission=await held(gate=>admitInventory(f.storage,input,{...opt(f),gate}),()=>{input.writer_generation_id=id();input.marker.checkpoint.hash='b'.repeat(64);});
 assert.equal(admission.admitted,true);assert.deepEqual(rows(f),before);assert.equal((await admitInventory(f.storage,saved,opt(f))).admitted,true);
 input=operationInput(f);saved=structuredClone(input);const first=await held(gate=>prepareInventory(f.storage,input,{...opt(f),gate}),()=>{input.operation_id=id();input.expected.checkpoint.hash='b'.repeat(64);});f.control=first.control;
 assert.equal(first.operation.plan.operation_id,saved.operation_id);let after=rows(f);assert.equal((await prepareInventory(f.storage,saved,opt(f))).operation.plan_hash,first.operation.plan_hash);assert.deepEqual(rows(f),after);
 input=v2({plan_hash:first.operation.plan_hash,marker:first.operation.plan.next,writer_generation_id:first.operation.plan.writer_generation_id});saved=structuredClone(input);
 const done=await held(gate=>acknowledgeInventory(f.storage,first.operation.plan.operation_id,input,{...opt(f),gate}),()=>{input.plan_hash='b'.repeat(64);input.writer_generation_id=id();});f.control=done.control;
 assert.equal(done.operation.status,'committed');after=rows(f);assert.equal((await acknowledgeInventory(f.storage,first.operation.plan.operation_id,saved,opt(f))).operation.status,'committed');assert.deepEqual(rows(f),after);
 const d=d2Fixture({minor:true}).value,put=operationInput(f,{operation_id:d.operation_id,allocations:{id_0:d.write_id}});d.database_id=put.expected.database_id;d.incarnation_id=put.expected.incarnation_id;d.writer_generation_id=put.writer_generation_id;put.resources=[d];
 const p=await prepareInventory(f.storage,put,opt(f));f.control=p.control;await commit3(f,p.operation);
 input=v2({marker:f.control.marker,writer_generation_id:f.control.writer_generation_id,write_id:d.write_id,descriptor_hash:await sha256(canonical(d)),plan_hash:p.operation.plan_hash});saved=structuredClone(input);
 const dispatch=await held(gate=>dispatchInventory(f.storage,input,{...opt(f),gate}),()=>{input.write_id=id();input.plan_hash='b'.repeat(64);});assert.equal(dispatch.write_id,saved.write_id);
 after=rows(f);assert.equal((await dispatchInventory(f.storage,saved,opt(f))).write_id,saved.write_id);assert.deepEqual(rows(f),after);
 input=v2({observation_id:id(),write_id:d.write_id,registration_hash:p.operation.plan.inventory_receipts[0].hash,plan_hash:p.operation.plan_hash,kind:'put-reply',result:{outcome:'unknown',http_status:null,evidence_hash:hash()}});saved=structuredClone(input);
 const observed=await held(gate=>observeInventory(f.storage,input,{...opt(f),gate}),()=>{input.write_id=id();input.result.evidence_hash='b'.repeat(64);});assert.deepEqual(observed.observation.payload,saved);
 after=rows(f);assert.deepEqual((await observeInventory(f.storage,saved,opt(f))).observation,observed.observation);assert.deepEqual(rows(f),after);
});

test('f3 held recovery and cut/page envelopes use frozen identity and replay only evidence',async()=>{
 const f=await fixture(),target=await f.put(),cap=await flip(f);const late=await observeHistoricalReply(f.storage,lateInput(cap,target),opt(f));f.control=late.control;
 let input=v2({recovery_id:id(),cut_id:id(),expected:f.control.marker,writer_generation_id:f.control.writer_generation_id}),saved=structuredClone(input);
 const recovery=await held(gate=>beginInventoryRecovery(f.storage,input,{...opt(f),gate}),()=>{input.recovery_id=id();input.cut_id=id();input.writer_generation_id=id();});f.control=recovery.control;
 assert.equal(recovery.recovery.recovery_id,saved.recovery_id);assert.equal(recovery.cut.cut_id,saved.cut_id);let before=rows(f);
 const replay=await beginInventoryRecovery(f.storage,saved,opt(f));assert.equal(replay.immutable_evidence_only,true);assert.equal(replay.clearance_available,false);assert.deepEqual(rows(f),before);
 await assert.rejects(()=>admitInventory(f.storage,v2({marker:f.control.marker,writer_generation_id:f.control.writer_generation_id,operation_version:2,inventory_protocol:1}),opt(f)),expectedError(409,'serving_quarantined'));assert.deepEqual(rows(f),before);
 const progress={};for(const chain of ['registrations','observations'])progress[chain]=await readInventoryProgress(f.storage,saved.recovery_id,chain,opt(f));
 input=v2({recovery_id:saved.recovery_id,cut_id:id(),expected_parent_cut_id:recovery.active_cut.cut_id,expected_parent_cut_hash:recovery.active_cut.cut_hash,expected_progress:Object.fromEntries(Object.entries(progress).map(([k,v])=>[k,v.progress.state_hash])),carry_prefix:{registrations:true,observations:true}});saved=structuredClone(input);
 const cut=await held(gate=>createInventoryCut(f.storage,saved.recovery_id,input,{...opt(f),gate}),()=>{input.cut_id=id();input.carry_prefix.registrations=false;input.expected_progress.observations='b'.repeat(64);});assert.equal(cut.cut.cut_id,saved.cut_id);
 before=rows(f);assert.equal((await createInventoryCut(f.storage,saved.recovery_id,saved,opt(f))).immutable_evidence_only,true);assert.deepEqual(rows(f),before);
 const prog=await readInventoryProgress(f.storage,saved.recovery_id,'registrations',opt(f));const page=await readInventoryPage(f.storage,saved.recovery_id,'registrations',{cut_id:cut.cut.cut_id,after:prog.progress.state.cursor,limit:1},opt(f));
 input=v2({recovery_id:saved.recovery_id,recovery_generation_id:page.recovery_generation_id,chain:'registrations',cut_id:page.cut_id,cut_hash:page.cut_hash,expected_state_hash:prog.progress.state_hash,after:page.after,limit:1,page_hash:page.page_hash,next:page.next});saved=structuredClone(input);
 const ack=await held(gate=>acknowledgeInventoryPage(f.storage,saved.recovery_id,input,{...opt(f),gate}),()=>{input.cut_id=id();input.page_hash='b'.repeat(64);input.next.hash='c'.repeat(64);});assert(ack.acknowledgement);
 before=rows(f);const duplicate=await acknowledgeInventoryPage(f.storage,saved.recovery_id,saved,opt(f));assert.deepEqual(duplicate.acknowledgement,ack.acknowledgement);assert.deepEqual(rows(f),before);
});

/** Deliberately recompute every affected digest/index around a bad L2 authority
 * episode; the remaining broken invariant is the typed D2/L2 association. */
test('coherently rehashed stored L2 association mismatch is integrity failure',async()=>{
 const f=await fixture();await flip(f);const d=d2Fixture({minor:true}).value,input=operationInput(f,{operation_id:d.operation_id,allocations:{id_0:d.write_id}});
 d.database_id=input.expected.database_id;d.incarnation_id=input.expected.incarnation_id;d.writer_generation_id=input.writer_generation_id;input.resources=[d];
 const put=await prepareInventory(f.storage,input,opt(f));f.control=put.control;await commit3(f,put.operation);
 const link=await l2Fixture(d),linked=await prepareInventory(f.storage,operationInput(f,{operation_id:link.operation_id,links:[link]}),opt(f));f.control=linked.control;await commit3(f,linked.operation);
 const obs=v2({observation_id:id(),write_id:d.write_id,registration_hash:put.operation.plan.inventory_receipts[0].hash,plan_hash:put.operation.plan_hash,kind:'publication',result:{publication_operation_id:link.operation_id,publication_plan_hash:linked.operation.plan_hash}});
 await observeInventory(f.storage,obs,opt(f));
 const rows=f.storage.rows,head=x=>({sequence:x.sequence,hash:x.hash}),recordHash=async r=>{const {payload,hash,...content}=r;return sha256(canonical(content));};
 const key='inventory:r:'+String(linked.operation.plan.registration_after.sequence).padStart(16,'0'),record=rows.get(key),stored=rows.get('plan:'+link.operation_id),plan=stored.plan;
 record.payload.item.authority_episode_hash='b'.repeat(64);record.payload.item_hash=await sha256(canonical(record.payload.item));record.payload_hash=await sha256(canonical(record.payload));record.hash=await recordHash(record);
 plan.links[0]=structuredClone(record.payload.item);plan.inventory_receipts[0]=structuredClone(record);plan.registration_after=head(record);
 const fields=['version','project_id','operation_id','input_hash','expected','writer_generation_id','allocations','events','resources','links'];const planInput=Object.fromEntries(fields.map(k=>[k,plan[k]]));
 plan.next.checkpoint.hash=await sha256(canonical({kind:'database-checkpoint-v2',input:planInput,restriction_cursor:plan.next.cursor,registration_before:plan.registration_before,registration_after:plan.registration_after,inventory_receipt_hashes:[record.hash]}));
 stored.plan_hash=await sha256(canonical(plan));const index=rows.get('inventory:link:'+link.operation_id);index.item_hash=record.payload.item_hash;index.hash=record.hash;index.plan_hash=stored.plan_hash;
 const prepare=rows.get('prepare:'+String(plan.next.checkpoint.revision).padStart(16,'0'));prepare.plan_hash=stored.plan_hash;
 const commit=rows.get(commitKey(plan.next.checkpoint.revision));commit.plan_hash=stored.plan_hash;commit.marker=structuredClone(plan.next);commit.registration_after=structuredClone(plan.registration_after);
 const regMeta=rows.get('inventory:r:meta');regMeta.hash=record.hash;
 const observation=rows.get('inventory:o:'+String(1).padStart(16,'0'));observation.payload.result.publication_plan_hash=stored.plan_hash;observation.payload_hash=await sha256(canonical(observation.payload));observation.hash=await recordHash(observation);
 const oi=rows.get('inventory:observation:'+obs.observation_id);oi.hash=observation.hash;oi.input_hash=observation.payload_hash;rows.get('inventory:o:meta').hash=observation.hash;
 const control=rows.get(CONTROL_KEY);control.marker=structuredClone(plan.next);control.registration_head=head(record);control.observation_head=head(observation);
 assert.equal(record.payload.item.target_descriptor_hash,await sha256(canonical(d)));assert.equal(record.payload.item_hash,await sha256(canonical(plan.links[0])));assert.equal(stored.plan_hash,await sha256(canonical(plan)));
 const {validateD2LinkTarget}=await import('../src/inventory-descriptors-v2.mjs');await assert.rejects(()=>validateD2LinkTarget(plan.links[0],d),expectedError(409,'inventory_descriptor_v2_binding_conflict'));
 const before=structuredClone(rows);await assert.rejects(()=>readInventoryControl(f.storage,opt(f)),expectedError(503,'inventory_integrity_failed'));assert.deepEqual(rows,before);
});
