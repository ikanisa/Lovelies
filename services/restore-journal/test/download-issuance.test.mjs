import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PROJECT_ID,canonical,sha256 } from '../src/journal.mjs';
import { handleOperationRequest } from '../src/operations.mjs';
import { env,request,MemoryStorage } from './fixtures.mjs';
import { downloadReservationInput } from './download-issuance.fixture.mjs';
async function setup(){
  const storage=new MemoryStorage();let tick=1000;
  const call=async(path,body,headers)=>{const response=await handleOperationRequest(request(path,body,headers),env,storage,{now:()=>++tick});return {status:response.status,value:await response.json()};};
  const boot=await call('/v1/control/bootstrap',{version:1,project_id:PROJECT_ID,database_id:randomUUID(),bootstrap_id:randomUUID()});
  const input=await downloadReservationInput(boot.value.binding.initial_marker);
  return {storage,call,input};
}
for(const disposition of ['issued','not_issued'])test(`typed ${disposition} is exact, independently immutable, and generic ack cannot infer or overwrite it`,async()=>{
  const f=await setup(),prepared=await f.call('/v1/download-operations/prepare',f.input);assert.equal(prepared.status,200);
  const op=prepared.value.operation,base={version:1,project_id:PROJECT_ID,plan_hash:op.plan_hash,marker:op.plan.next};
  const ordinary=await f.call('/v1/operations/'+op.plan.operation_id+'/acknowledge',base);assert.equal(ordinary.status,409);assert.equal(ordinary.value.error,'typed_acknowledgement_required');
  const receipt_hash=disposition==='issued'?f.input.download.issued_receipt_hash:f.input.download.not_issued.receipt_hash;
  const settled=await f.call('/v1/download-operations/'+op.plan.operation_id+'/settle',{...base,disposition,receipt_hash});
  assert.equal(settled.status,200);assert.equal(settled.value.operation.disposition,disposition);assert.equal(settled.value.control.state,'serving');
  assert.deepEqual(await f.call('/v1/download-operations/'+op.plan.operation_id+'/settle',{...base,disposition,receipt_hash}),settled);
  const after=await f.call('/v1/operations/'+op.plan.operation_id+'/acknowledge',base);assert.equal(after.status,409);
  const other=disposition==='issued'?'not_issued':'issued',conflict=await f.call('/v1/download-operations/'+op.plan.operation_id+'/settle',{
    ...base,disposition:other,receipt_hash:other==='issued'?f.input.download.issued_receipt_hash:f.input.download.not_issued.receipt_hash});
  assert.equal(conflict.status,409);const history=await f.call('/v1/operations/'+op.plan.operation_id);assert.equal(history.value.operation.disposition,disposition);
});
test('descriptor context, timestamp, allocation, receipt hashes, no-events and checkpoint participate in independent exact binding',async()=>{
  for(const mutate of [v=>v.download.context.asset_id=randomUUID(),v=>v.allocations.id_1=randomUUID(),v=>v.download.ticket_id=randomUUID(),
    v=>v.input_hash='d'.repeat(64),v=>v.download.not_issued.receipt_hash='d'.repeat(64),v=>v.events.push({}),
    v=>v.download.not_issued.evidence_json=v.download.not_issued.evidence_json.replace('"recorded_at":1000','"recorded_at":1001')]){
    const f=await setup(),bad=structuredClone(f.input);mutate(bad);const before=structuredClone(f.storage.rows);
    const r=await f.call('/v1/download-operations/prepare',bad);assert(r.status>=400);assert.deepEqual(f.storage.rows,before);
  }
});
test('legacy writer formed before a cutover cannot admit, prepare or acknowledge through the current HTTP handler',async()=>{
  const f=await setup(),marker=f.input.expected,old={'X-Lovelies-Writer-Protocol':''};
  const requests=[['/v1/admission',{version:1,project_id:PROJECT_ID,marker}],['/v1/operations/prepare',{...f.input,download:undefined}],
    ['/v1/operations/'+f.input.operation_id+'/acknowledge',{version:1,project_id:PROJECT_ID,plan_hash:'a'.repeat(64),marker}]];
  const before=structuredClone(f.storage.rows);
  for(const [path,body]of requests){const r=await f.call(path,body,old);assert.equal(r.status,409);assert.equal(r.value.error,'writer_protocol_unsupported');}
  assert.deepEqual(f.storage.rows,before);
  assert.equal((await f.call('/v1/admission',{version:1,project_id:PROJECT_ID,marker})).status,200);
});
