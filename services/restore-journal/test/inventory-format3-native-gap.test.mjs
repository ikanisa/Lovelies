/** External candidate. A native SQLite transaction is held by a local-only
 * wrapper after the real journal callback returns; no production fault hook. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {env,id,v2,PROJECT_ID,canonical,sha256} from './inventory-fixtures.mjs';
const require=createRequire(new URL('../package.json',import.meta.url)),{Miniflare}=require('miniflare'),{build}=require('esbuild');
const v1=fields=>({version:1,project_id:PROJECT_ID,...fields});
test('native f3 capability, prepare and acknowledgement callback-to-commit failures reconcile exact durable state',{timeout:120000},async()=>{
 const bundle=await build({stdin:{contents:`
 import production,{RestoreJournal} from './src/worker.mjs';
 export class InventoryFixture extends RestoreJournal{
  constructor(ctx,env){const fault={gap:false,abort:null,release:null,transaction:null};
   const storage={transaction(callback){const pending=ctx.storage.transaction(async txn=>{let writes=0;
    const result=await callback({get:(...a)=>txn.get(...a),list:(...a)=>txn.list(...a),put:async value=>{await txn.put(value);writes++;}});
    if(fault.gap&&writes>0){fault.gap=false;const held=new Promise(resolve=>{fault.release=resolve;});fault.abort();await held;}return result;
   });fault.transaction=pending;pending.catch(()=>{});return pending;}};super({storage},env);this.fixtureFault=fault;
  }
  async fetch(request){const f=this.fixtureFault,hold=request.headers.get('x-fixture-final-check-commit-gap')==='yes';let actual=request;
   if(hold){const controller=new AbortController();f.gap=true;f.abort=()=>controller.abort();actual=new Request(request,{signal:controller.signal});}
   try{const result=await super.fetch(actual);if(hold){if(!f.release)throw new Error('native gap not reached');const failed=result.status!==200;f.release();await f.transaction;
     return new Response(JSON.stringify({...await result.json(),fixture_gap_reached:true,fixture_production_failed_before_native_commit:failed,fixture_native_commit_completed:true}),{status:result.status});}
    if(result.status===200&&request.headers.get('x-fixture-drop-reply')==='yes')return new Response(JSON.stringify({error:'synthetic_reply_lost_after_commit'}),{status:503});return result;
   }finally{f.gap=false;f.abort=null;f.release?.();f.release=null;f.transaction=null;}
  }
 }
 export default{fetch(request,env){return production.fetch(request,{...env,RESTORE_JOURNAL:{jurisdiction(region){if(region!=='eu')throw new Error('wrong jurisdiction');return env.RESTORE_JOURNAL;}}});}};
 `,resolveDir:new URL('../',import.meta.url).pathname,sourcefile:'f3-native-gap-fixture'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});
 const directory=await mkdtemp(path.join(tmpdir(),'lovelies-format3-gap-'));const config={name:'lovelies-f3-native-gap',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-21',durableObjects:{RESTORE_JOURNAL:{className:'InventoryFixture',useSQLite:true}},durableObjectsPersist:directory,bindings:{...env,RESTORE_INVENTORY_PAGE_LIMIT:'8'}};let mf;const open=async()=>{mf=new Miniflare(config);await mf.ready;};const restart=async()=>{await mf.dispose();mf=undefined;await open();};
 const send=async(route,body,status=200,headers={})=>{const response=await mf.dispatchFetch('https://journal.invalid'+route,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+env.RESTORE_JOURNAL_TOKEN,...body===undefined?{}:{'content-type':'application/json'},...headers},...body===undefined?{}:{body:canonical(body)}});const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;};
 const gap={'x-fixture-final-check-commit-gap':'yes'},checkFailure=value=>{assert.equal(value.error,'inventory_request_aborted');assert.equal(value.fixture_gap_reached,true);assert.equal(value.fixture_production_failed_before_native_commit,true);assert.equal(value.fixture_native_commit_completed,true);};
 try{await open();const boot=await send('/v1/control/bootstrap',v1({database_id:id(),bootstrap_id:id()}));const old={version:1,project_id:PROJECT_ID,binding_hash:boot.binding.binding_hash,state:'serving',marker:boot.control.marker,pending_operation_id:null,recovery_generation_id:null,quarantine:null};
  const f2=(await send('/v2/control/upgrade',v2({upgrade_id:id(),expected:old.marker,expected_control_hash:await sha256(canonical(old)),coverage_anchor_hash:'b'.repeat(64)}))).control;
  const cap={version:3,project_id:PROJECT_ID,capability_id:id(),expected_marker:f2.marker,expected_control_hash:await sha256(canonical(f2)),expected_restriction_head:f2.marker.cursor,expected_registration_head:f2.registration_head,expected_observation_head:f2.observation_head};
  checkFailure(await send('/v3/control/capability',cap,503,gap));await restart();const switched=(await send('/v3/control')).control;assert.equal(switched.capability_id,cap.capability_id);const retried=await send('/v3/control/capability',cap);assert.equal(retried.control.writer_generation_id,switched.writer_generation_id);
  const input=v2({operation_id:id(),input_hash:'a'.repeat(64),expected:switched.marker,writer_generation_id:switched.writer_generation_id,allocations:{},events:[],resources:[],links:[]});
  checkFailure(await send('/v3/operations/prepare',input,503,gap));await restart();const pending=await send('/v3/operations/'+input.operation_id);assert.equal(pending.operation.status,'pending');assert.equal(pending.control.pending_operation_id,input.operation_id);
  const same=await send('/v3/operations/prepare',input);assert.equal(same.operation.plan_hash,pending.operation.plan_hash);assert.deepEqual(same.operation.plan,pending.operation.plan);
  const ack=v2({plan_hash:pending.operation.plan_hash,marker:pending.operation.plan.next,writer_generation_id:input.writer_generation_id});checkFailure(await send('/v3/operations/'+input.operation_id+'/acknowledge',ack,503,gap));await restart();
  const committed=await send('/v3/operations/'+input.operation_id);assert.equal(committed.operation.status,'committed');assert.deepEqual(committed.control.marker,ack.marker);
  const ackAgain=await send('/v3/operations/'+input.operation_id+'/acknowledge',ack);assert.deepEqual(ackAgain.operation,committed.operation);
  const next=v2({...input,operation_id:id(),expected:committed.control.marker});const lost=await send('/v3/operations/prepare',next,503,{'x-fixture-drop-reply':'yes'});assert.equal(lost.error,'synthetic_reply_lost_after_commit');await restart();
  const recovered=await send('/v3/operations/'+next.operation_id);assert.equal(recovered.operation.status,'pending');assert.equal((await send('/v3/operations/prepare',next)).operation.plan_hash,recovered.operation.plan_hash);
 }finally{await mf?.dispose();await rm(directory,{recursive:true,force:true});}
});
