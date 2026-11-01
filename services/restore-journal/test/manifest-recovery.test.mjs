import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {MemoryStorage,env,event,request} from './fixtures.mjs';
import {handleOperationRequest} from '../src/operations.mjs';
import {manifestKey,manifestChunkKey} from '../src/manifests.mjs';
import {RestoreJournalClient} from '../../supabase-api/src/restore-journal.ts';
import {restrictionManifest} from '../../supabase-api/src/restore-manifest.ts';
import {digest,stable} from '../../supabase-api/src/types.ts';
const project=env.SUPABASE_PROJECT_ID,base={version:1,project_id:project},v2={version:2,project_id:project};
async function fixture(){
 const storage=new MemoryStorage(),sizes=[],paths=[];let tick=1000,fault;
 const call=async(path,body)=>{const response=await handleOperationRequest(request(path,body),env,storage,{now:()=>++tick});return {status:response.status,body:await response.json()};};
 const bootstrap=await call('/v1/control/bootstrap',{...base,database_id:randomUUID(),bootstrap_id:randomUUID()});assert.equal(bootstrap.status,200);
 const client=new RestoreJournalClient('https://journal.invalid',env.RESTORE_JOURNAL_TOKEN,{fetcher:async(url,init)=>{
  const req=new Request(url,init),path=new URL(req.url).pathname;paths.push(path);if(init.body)sizes.push(new TextEncoder().encode(init.body).length);
  const result=await handleOperationRequest(req,env,storage,{now:()=>++tick});if(fault?.path===path){fault=null;await result.body.cancel();throw new Error('synthetic_reply_lost');}return result;
 }});
 return {storage,client,marker:bootstrap.body.control.marker,call,sizes,paths,lose:path=>fault={path},now:()=>++tick};
}
const input=(f,count)=>({...base,operation_id:randomUUID(),input_hash:'a'.repeat(64),expected:f.marker,allocations:{id_0:randomUUID()},events:Array.from({length:count},()=>event())});
async function full(f){const id=randomUUID(),reply=await f.call('/v1/recovery/begin-v2',{...v2,recovery_id:id,expected:(await f.client.control()).marker});assert.equal(reply.status,200);return {id,view:reply.body,generation_hash:reply.body.recovery.generation_hash};}
const recoveryBody=(r,fields={})=>({...v2,generation_hash:r.generation_hash,...fields});
const absent=()=>({outcome:'absent',sha256:null,byte_size:null,etag:null,reference_hash:null,verified_at:10000});
async function register(f,kind='storage-put'){
 const descriptor={...base,effect_id:randomUUID(),expected:(await f.client.control()).marker,kind,
  target:kind==='storage-put'?{bucket:'PHOTOS',object_key:'owned/synthetic/immutable.bin',owner_id:randomUUID()}:{service:'push',method:'POST',path:'/v1/send'},payload_hash:'b'.repeat(64),byte_size:4,metadata_hash:'c'.repeat(64)};
 const reply=await f.call('/v1/effects/register',descriptor);assert.equal(reply.status,200);return reply.body.effect;
}
async function dispatch(f,e){const r=await f.call('/v1/effects/'+e.descriptor.effect_id+'/dispatch',{...base,descriptor_hash:e.descriptor_hash,incarnation_id:e.descriptor.expected.incarnation_id});assert.equal(r.status,200);return r.body.effect;}
test('513 exact facts use bounded immutable chunks and compact prepare/ACK; no fact is dropped',async()=>{
 const f=await fixture(),raw=input(f,513),record=await f.client.prepare(raw);assert.equal(record.status,'pending');assert.equal(record.plan.version,2);assert.equal(record.plan.event_manifest.count,513);assert.equal(record.plan.event_manifest.chunks,17);
 assert.equal(f.paths.filter(p=>p.endsWith('/continue')).length,17);assert.ok(Math.max(...f.sizes)<=32768);let after=f.marker.cursor,collected=[];
 while(after.sequence<record.plan.next.cursor.sequence){const page=await f.client.restrictionPage(after,record.plan.next.cursor);assert.ok(page.length<=32);collected.push(...page.map(x=>x.event));after={sequence:page.at(-1).sequence,hash:page.at(-1).hash};}
 assert.deepEqual(collected,raw.events);await f.client.acknowledge(raw.operation_id,record.plan_hash,record.plan.next);assert.equal((await f.client.admission(record.plan.next)).state,'serving');
});
test('incomplete manifest cannot prepare, and altered indexed chunk never replaces accepted bytes',async()=>{
 const f=await fixture(),raw=input(f,33),{header,chunks}=await restrictionManifest(raw),header_hash=await digest(stable(header));
 assert.equal((await f.call('/v1/manifests/begin',header)).status,200);
 assert.equal((await f.call('/v1/manifests/'+raw.operation_id+'/chunk',chunks[0])).status,200);
 const denied=await f.call('/v1/manifests/'+raw.operation_id+'/prepare',{...v2,header_hash});assert.equal(denied.status,409);assert.equal(denied.body.error,'manifest_incomplete');assert.equal((await f.client.control()).state,'serving');
 const changed=structuredClone(chunks[0]);changed.events[0].scope.consent_id=randomUUID();
 assert.equal((await f.call('/v1/manifests/'+raw.operation_id+'/chunk',changed)).status,400);assert.deepEqual(f.storage.rows.get(manifestChunkKey(raw.operation_id,0)).events,chunks[0].events);
 const record=await f.client.prepare(raw);assert.equal(record.plan.event_manifest.count,33);
});
test('lost continuation reply resumes the accepted full root without new identities or duplicate journal events',async()=>{
 const f=await fixture(),raw=input(f,70);f.lose('/v1/manifests/'+raw.operation_id+'/continue');await assert.rejects(f.client.prepare(raw));
 let record=await f.client.lookup(raw.operation_id);assert.equal(record.status,'preparing');record=await f.client.finishPreparation(record);assert.equal(record.status,'pending');assert.equal(record.plan.next.cursor.sequence,70);
 assert.equal([...f.storage.rows.keys()].filter(k=>k.startsWith('event:')).length,70);assert.equal(f.storage.rows.get(manifestKey(raw.operation_id)).uploaded_chunks,3);
});
test('immutable root binds changed operation input and rejects corrupt stored chunk before further append',async()=>{
 const f=await fixture(),raw=input(f,65);f.lose('/v1/manifests/'+raw.operation_id+'/prepare');await assert.rejects(f.client.prepare(raw));
 const altered={...raw,input_hash:'f'.repeat(64)};await assert.rejects(f.client.prepare(altered));
 const chunk=f.storage.rows.get(manifestChunkKey(raw.operation_id,0));chunk.events[0].scope.consent_id=randomUUID();f.storage.rows.set(manifestChunkKey(raw.operation_id,0),chunk);
 await assert.rejects(f.client.finishPreparation(await f.client.lookup(raw.operation_id)));
});
test('deny-only SQL reconciliation has a distinct terminal outcome and does not rerun positive operation',async()=>{
 const f=await fixture(),raw=input(f,40),record=await f.client.prepare(raw);
 const recovered=await f.client.acknowledgeRecovery(record);assert.equal(recovered.status,'recovered');assert.equal((await f.client.lookup(raw.operation_id)).status,'recovered');
 assert.equal((await f.client.admission(record.plan.next)).state,'serving');assert.equal((await f.client.acknowledgeRecovery(record)).status,'recovered');
 const next=await f.client.prepare({...input(f,0),expected:record.plan.next});assert.equal(next.status,'pending');assert.equal(next.plan.next.checkpoint.revision,2);
});
test('full recovery requires contiguous authenticated replay and computed prerequisites',async()=>{
 const f=await fixture(),raw=input(f,3),op=await f.client.prepare(raw);await f.client.acknowledge(raw.operation_id,op.plan_hash,op.plan.next);
 const r=await full(f);assert.equal((await f.call('/v1/recovery/'+r.id+'/prepare-clearance',recoveryBody(r))).body.error,'recovery_clearance_incomplete');
 let result=await f.call('/v1/recovery/'+r.id+'/replay',recoveryBody(r,{after:{sequence:0,hash:'0'.repeat(64)},next:{sequence:3,hash:'d'.repeat(64)}}));assert.equal(result.status,409);
 result=await f.call('/v1/recovery/'+r.id+'/replay',recoveryBody(r,{after:{sequence:0,hash:'0'.repeat(64)},next:op.plan.next.cursor}));assert.equal(result.status,200);
 assert.equal((await f.call('/v1/recovery/'+r.id+'/retire-authority',recoveryBody(r,{retirement_hash:'e'.repeat(64)}))).status,200);
 result=await f.call('/v1/recovery/'+r.id+'/prepare-clearance',recoveryBody(r));assert.equal(result.status,200);const clearance=result.body.progress.clearance;
 result=await f.call('/v1/recovery/'+r.id+'/complete',recoveryBody(r,{clearance_hash:clearance.clearance_hash,marker:clearance.marker}));assert.equal(result.status,200);assert.equal(result.body.control.state,'serving');assert.notEqual(result.body.control.marker.incarnation_id,f.marker.incarnation_id);
 assert.equal((await f.client.admission(clearance.marker)).state,'serving');
 const newOp=await f.client.prepare({...input(f,0),expected:clearance.marker});await f.client.acknowledge(newOp.plan.operation_id,newOp.plan_hash,newOp.plan.next);
 result=await f.call('/v1/recovery/'+r.id+'/complete',recoveryBody(r,{clearance_hash:clearance.clearance_hash,marker:clearance.marker}));assert.equal(result.status,200);assert.equal(result.body.control.marker.checkpoint.revision,newOp.plan.next.checkpoint.revision);
});
test('stale external dispatch is fenced; undispatched immutable write can be cancelled and proved absent',async()=>{
 const f=await fixture(),effect=await register(f),r=await full(f);
 const denied=await f.call('/v1/effects/'+effect.descriptor.effect_id+'/dispatch',{...base,descriptor_hash:effect.descriptor_hash,incarnation_id:f.marker.incarnation_id});assert.equal(denied.status,409);assert.equal(denied.body.error,'effect_generation_retired');
 const proof=await f.call('/v1/recovery/'+r.id+'/effect',recoveryBody(r,{sequence:1,descriptor_hash:effect.descriptor_hash,observation_hash:null,proof:absent()}));assert.equal(proof.status,200);
 const row=await f.call('/v1/effects/'+effect.descriptor.effect_id);assert.equal(row.body.effect.status,'cancelled');
});
test('unknown in-flight Storage write cannot become absence; exact materialization invalidates and refreshes the effect cut',async()=>{
 const f=await fixture();let effect=await dispatch(f,await register(f)),r=await full(f);
 const body=()=>recoveryBody(r,{sequence:1,descriptor_hash:effect.descriptor_hash,observation_hash:effect.observation.hash,proof:absent()});
 assert.equal((await f.call('/v1/recovery/'+r.id+'/effect',body())).body.error,'recovery_writer_unresolved');
 const observed=await f.call('/v1/effects/'+effect.descriptor.effect_id+'/observe',{...base,descriptor_hash:effect.descriptor_hash,status:'materialized',result:{http_status:null,sha256:effect.descriptor.payload_hash,byte_size:4,etag:'exact-synthetic-object'}});assert.equal(observed.status,200);effect=observed.body.effect;
 assert.equal((await f.call('/v1/recovery/'+r.id+'/effect',body())).body.error,'recovery_effect_cut_changed');
 assert.equal((await f.call('/v1/recovery/'+r.id+'/refresh-effects',recoveryBody(r))).status,200);
 const proof={outcome:'preserved',sha256:effect.descriptor.payload_hash,byte_size:4,etag:'exact-synthetic-object',reference_hash:'d'.repeat(64),verified_at:10000};
 assert.equal((await f.call('/v1/recovery/'+r.id+'/effect',recoveryBody(r,{sequence:1,descriptor_hash:effect.descriptor_hash,observation_hash:effect.observation.hash,proof}))).status,200);
});
test('late service outcome after prepared clearance prevents completion until a refreshed complete proof cut',async()=>{
 const f=await fixture();let effect=await dispatch(f,await register(f,'service-request')),r=await full(f);
 const proof={...absent(),outcome:'historical-only'};
 assert.equal((await f.call('/v1/recovery/'+r.id+'/effect',recoveryBody(r,{sequence:1,descriptor_hash:effect.descriptor_hash,observation_hash:effect.observation.hash,proof}))).status,200);
 await f.call('/v1/recovery/'+r.id+'/retire-authority',recoveryBody(r,{retirement_hash:'e'.repeat(64)}));
 const prepared=await f.call('/v1/recovery/'+r.id+'/prepare-clearance',recoveryBody(r));assert.equal(prepared.status,200);const clearance=prepared.body.progress.clearance;
 const late=await f.call('/v1/effects/'+effect.descriptor.effect_id+'/observe',{...base,descriptor_hash:effect.descriptor_hash,status:'succeeded',result:{http_status:200,sha256:null,byte_size:null,etag:null}});assert.equal(late.status,200);
 const denied=await f.call('/v1/recovery/'+r.id+'/complete',recoveryBody(r,{clearance_hash:clearance.clearance_hash,marker:clearance.marker}));assert.equal(denied.status,409);assert.equal(denied.body.error,'recovery_clearance_changed');assert.equal((await f.client.control()).state,'quarantined');
 const refreshed=await f.call('/v1/recovery/'+r.id+'/refresh-effects',recoveryBody(r));assert.equal(refreshed.status,200);assert.equal(refreshed.body.progress.retirement_hash,null);
 effect=late.body.effect;assert.equal((await f.call('/v1/recovery/'+r.id+'/effect',recoveryBody(r,{sequence:1,descriptor_hash:effect.descriptor_hash,observation_hash:effect.observation.hash,proof:{...proof,verified_at:10001}}))).status,200);
 assert.equal((await f.call('/v1/recovery/'+r.id+'/retire-authority',recoveryBody(r,{retirement_hash:'f'.repeat(64)}))).status,200);
 const preparedAgain=await f.call('/v1/recovery/'+r.id+'/prepare-clearance',recoveryBody(r));assert.equal(preparedAgain.status,200);const next=preparedAgain.body.progress.clearance;assert.notEqual(next.clearance_hash,clearance.clearance_hash);
 assert.equal((await f.call('/v1/recovery/'+r.id+'/complete',recoveryBody(r,{clearance_hash:clearance.clearance_hash,marker:clearance.marker}))).status,409);
 assert.equal((await f.call('/v1/recovery/'+r.id+'/complete',recoveryBody(r,{clearance_hash:next.clearance_hash,marker:next.marker}))).status,200);
});
