/** Prepared native old-binary rollback test; never deploy these local bundles. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {env,id,PROJECT_ID,canonical,sha256,putInput,linkInput} from './inventory-fixtures.mjs';
import {frozenF2Sources,frozenF2Sha256} from './inventory-f2-worker.fixture.mjs';
import {legacySources,legacySha256} from './inventory-v1-worker.fixture.mjs';
import {event as restrictionEvent} from './fixtures.mjs';
const require=createRequire(new URL('../package.json',import.meta.url));const {Miniflare}=require('miniflare'),{build}=require('esbuild');
const one=fields=>({version:1,project_id:PROJECT_ID,...fields}),two=fields=>({version:2,project_id:PROJECT_ID,...fields});
const runtimeWrapper=importLine=>`${importLine}\nexport class InventoryFixture extends RestoreJournal {async fetch(request){if(new URL(request.url).pathname==='/__fixture_dump')return new Response(JSON.stringify(Object.fromEntries(await this.storage.list())));return super.fetch(request);}};export default {fetch(request,env){return production.fetch(request,{...env,RESTORE_JOURNAL:{jurisdiction(region){if(region!=='eu')throw new Error('wrong jurisdiction');return env.RESTORE_JOURNAL;}}});}};`;
async function frozenBundle(sources,hashes,name){
 for(const [file,source] of Object.entries(sources))assert.equal(await sha256(source),hashes[file],name+':'+file);
 return build({stdin:{contents:runtimeWrapper("import production, {RestoreJournal} from 'frozen:worker.mjs';"),sourcefile:name},plugins:[{name:'exact-'+name,setup(builder){
  builder.onResolve({filter:/^frozen:/},args=>({path:args.path.slice(7),namespace:name}));
  builder.onResolve({filter:/^\.\//,namespace:name},args=>({path:args.path.slice(2),namespace:name}));
  builder.onLoad({filter:/.*/,namespace:name},args=>{if(!Object.hasOwn(sources,args.path))throw Error('unknown frozen dependency');return {contents:sources[args.path],loader:'js'};});
 }}],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});
}
test('actual frozen format1 and format2 Workers fail closed against same f3 SQLite state', {timeout:120000},async()=>{
 const modern=await build({stdin:{contents:runtimeWrapper("import production, {RestoreJournal} from './src/worker.mjs';"),resolveDir:new URL('../',import.meta.url).pathname,sourcefile:'f3-local-rollback'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});
 const f2=await frozenBundle(frozenF2Sources,frozenF2Sha256,'actual-f2'),f1=await frozenBundle(legacySources,legacySha256,'actual-f1');
 const directory=await mkdtemp(path.join(tmpdir(),'lovelies-format3-native-'));
 const config={name:'lovelies-format3-rollback-local',modules:true,script:modern.outputFiles[0].text,compatibilityDate:'2026-07-21',
  durableObjects:{RESTORE_JOURNAL:{className:'InventoryFixture',useSQLite:true}},durableObjectsPersist:directory,bindings:{...env,RESTORE_INVENTORY_PAGE_LIMIT:'8'}};
 let mf;const open=async(script=config.script)=>{mf=new Miniflare({...config,script});await mf.ready;};
 const restart=async script=>{await mf.dispose();mf=null;await open(script);};
 const send=async(pathname,body,expected)=>{const reply=await mf.dispatchFetch('https://journal.invalid'+pathname,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+env.RESTORE_JOURNAL_TOKEN,...body===undefined?{}:{'content-type':'application/json'}},...body===undefined?{}:{body:canonical(body)}});
  if(expected!==undefined)assert.equal(reply.status,expected,pathname);const value=await reply.json();return {reply,value};};
 const direct=async(pathname,body)=>{const ns=await mf.getDurableObjectNamespace('RESTORE_JOURNAL');const key=ns.idFromName('lovelies-restriction-journal-v1:'+PROJECT_ID);return ns.get(key).fetch('https://journal.invalid'+pathname,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+env.RESTORE_JOURNAL_TOKEN,...body===undefined?{}:{'content-type':'application/json'}},...body===undefined?{}:{body:canonical(body)}});};
 const dump=async()=>await (await direct('/__fixture_dump')).json();
 const blocked=async(pathname,body,expected,code,viaDirect=false)=>{const reply=viaDirect?await direct(pathname,body):await mf.dispatchFetch('https://journal.invalid'+pathname,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+env.RESTORE_JOURNAL_TOKEN,...body===undefined?{}:{'content-type':'application/json'}},...body===undefined?{}:{body:canonical(body)}});assert.equal(reply.status,expected,pathname);assert.deepEqual(await reply.json(),{error:code},pathname);};
 try{await open(f1.outputFiles[0].text);const bound=(await send('/v1/control/bootstrap',one({database_id:id(),bootstrap_id:id()}),200)).value;
  const f1input=one({operation_id:id(),input_hash:'a'.repeat(64),expected:bound.control.marker,allocations:{},events:[restrictionEvent()]});
  const f1plan=(await send('/v1/operations/prepare',f1input,200)).value.operation;assert.equal(f1plan.plan.receipts.length,1);assert.equal(f1plan.plan.next.cursor.sequence,1);
  await send('/v1/operations/'+f1input.operation_id+'/acknowledge',one({marker:f1plan.plan.next,plan_hash:f1plan.plan_hash}),200);
  const f1control=(await send('/v1/control',undefined,200)).value.control;
  const old={version:1,project_id:PROJECT_ID,binding_hash:bound.binding.binding_hash,state:'serving',marker:f1control.marker,pending_operation_id:null,recovery_generation_id:null,quarantine:null};
  await restart(f2.outputFiles[0].text);
  const initial=(await send('/v2/control/upgrade',two({upgrade_id:id(),expected:old.marker,expected_control_hash:await sha256(canonical(old)),coverage_anchor_hash:'b'.repeat(64)}),200)).value.control;
  await send('/v2/admission',two({marker:initial.marker,writer_generation_id:initial.writer_generation_id,operation_version:2,inventory_protocol:1}),200);
  const f2input=two({operation_id:id(),input_hash:'a'.repeat(64),expected:initial.marker,writer_generation_id:initial.writer_generation_id,allocations:{},events:[restrictionEvent()],resources:[],links:[]});
  const f2plan=(await send('/v2/operations/prepare',f2input,200)).value.operation;assert.equal(f2plan.plan.receipts.length,1);assert.equal(f2plan.plan.next.cursor.sequence,2);
  await send('/v2/operations/'+f2input.operation_id+'/acknowledge',two({plan_hash:f2plan.plan_hash,marker:f2plan.plan.next,writer_generation_id:initial.writer_generation_id}),200);
  const media={control:(await send('/v2/control',undefined,200)).value.control},put=putInput(media);
  const putOp=(await send('/v2/operations/prepare',put,200)).value.operation;
  media.control=(await send('/v2/operations/'+put.operation_id+'/acknowledge',two({plan_hash:putOp.plan_hash,marker:putOp.plan.next,writer_generation_id:put.writer_generation_id}),200)).value.control;
  const source={item:put.resources[0],operation:putOp},link=await linkInput(media,source),linkOp=(await send('/v2/operations/prepare',link,200)).value.operation;
  media.control=(await send('/v2/operations/'+link.operation_id+'/acknowledge',two({plan_hash:linkOp.plan_hash,marker:linkOp.plan.next,writer_generation_id:link.writer_generation_id}),200)).value.control;
  const observation=two({observation_id:id(),write_id:source.item.write_id,registration_hash:putOp.plan.inventory_receipts[0].hash,plan_hash:putOp.plan_hash,kind:'put-reply',result:{outcome:'unknown',http_status:null,evidence_hash:'a'.repeat(64)}});
  await send('/v2/inventory/observations',observation,200);
  const finalF2=(await send('/v2/control',undefined,200)).value.control;assert.equal(finalF2.registration_head.sequence,2);assert.equal(finalF2.observation_head.sequence,1);
  await restart();const cap={version:3,project_id:PROJECT_ID,capability_id:id(),expected_marker:finalF2.marker,expected_control_hash:await sha256(canonical(finalF2)),
    expected_restriction_head:finalF2.marker.cursor,expected_registration_head:finalF2.registration_head,expected_observation_head:finalF2.observation_head};
  const migrated=(await send('/v3/control/capability',cap,200)).value.control;assert.equal(migrated.version,3);assert.equal(cap.expected_restriction_head.sequence,2);assert.deepEqual(migrated.marker.cursor,cap.expected_restriction_head);const snapshot=await dump();
  const f2cases=[['/v2/control'],['/v2/admission',two({marker:migrated.marker,writer_generation_id:initial.writer_generation_id,operation_version:2,inventory_protocol:1})],
    ['/v2/operations/prepare',f2input],['/v2/operations/'+f2input.operation_id+'/acknowledge',two({plan_hash:f2plan.plan_hash,marker:f2plan.plan.next,writer_generation_id:initial.writer_generation_id})],
    ['/v2/inventory/dispatch-admission',two({marker:migrated.marker,writer_generation_id:initial.writer_generation_id,write_id:id(),descriptor_hash:'a'.repeat(64),plan_hash:'a'.repeat(64)})],
    ['/v2/recovery/begin',two({recovery_id:id(),cut_id:id(),expected:migrated.marker,writer_generation_id:initial.writer_generation_id})]];
  await restart(f2.outputFiles[0].text);for(const [route,body] of f2cases){await blocked(route,body,503,'inventory_integrity_failed');await blocked(route,body,503,'inventory_integrity_failed',true);}assert.deepEqual(await dump(),snapshot);
  const f1cases=[['/v1/control'],['/v1/admission',one({marker:migrated.marker})],['/v1/operations/prepare',f1input],
    ['/v1/operations/'+f1input.operation_id+'/acknowledge',one({marker:f1plan.plan.next,plan_hash:f1plan.plan_hash})],
    ['/v1/recovery/begin',one({recovery_id:id(),expected:migrated.marker})]];
  await restart(f1.outputFiles[0].text);for(const [route,body] of f1cases){await blocked(route,body,503,'journal_integrity_failed');await blocked(route,body,503,'journal_integrity_failed',true);}assert.deepEqual(await dump(),snapshot);
  await restart();const reread=(await send('/v3/control',undefined,200)).value.control;assert.deepEqual(reread,migrated);assert.deepEqual(await dump(),snapshot);
  assert.deepEqual((await send('/v3/operations/'+f1input.operation_id,undefined,200)).value.operation.plan.receipts,f1plan.plan.receipts);
  assert.deepEqual((await send('/v3/operations/'+f2input.operation_id,undefined,200)).value.operation.plan.receipts,f2plan.plan.receipts);
  assert.equal((await send('/v3/operations/'+put.operation_id,undefined,200)).value.operation.plan.resources[0].write_id,source.item.write_id);
  assert.equal((await send('/v3/operations/'+link.operation_id,undefined,200)).value.operation.plan.links[0].target_write_id,source.item.write_id);

 }finally{await mf?.dispose();await rm(directory,{recursive:true,force:true});}
});

test('f2 recovery and extra cut prevent a format3 switch without synthetic clearance', {timeout:120000}, async()=>{
 const modern=await build({stdin:{contents:runtimeWrapper("import production, {RestoreJournal} from './src/worker.mjs';"),resolveDir:new URL('../',import.meta.url).pathname,sourcefile:'f3-recovery-rejection'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});
 const f2=await frozenBundle(frozenF2Sources,frozenF2Sha256,'actual-f2-recovery');const directory=await mkdtemp(path.join(tmpdir(),'lovelies-f2-recovery-native-'));
 const cfg={name:'lovelies-f2-recovery-local',modules:true,compatibilityDate:'2026-07-21',durableObjects:{RESTORE_JOURNAL:{className:'InventoryFixture',useSQLite:true}},durableObjectsPersist:directory,bindings:{...env,RESTORE_INVENTORY_PAGE_LIMIT:'8'}};
 let mf;const open=async script=>{mf=new Miniflare({...cfg,script});await mf.ready;};const restart=async script=>{await mf.dispose();mf=null;await open(script);};
 const send=async(pathname,body,status)=>{const reply=await mf.dispatchFetch('https://journal.invalid'+pathname,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+env.RESTORE_JOURNAL_TOKEN,...body===undefined?{}:{'content-type':'application/json'}},...body===undefined?{}:{body:canonical(body)}});assert.equal(reply.status,status,pathname);return reply.json();};
 const dump=async()=>{const ns=await mf.getDurableObjectNamespace('RESTORE_JOURNAL'),key=ns.idFromName('lovelies-restriction-journal-v1:'+PROJECT_ID);return (await ns.get(key).fetch('https://journal.invalid/__fixture_dump')).json();};
 try{await open(f2.outputFiles[0].text);const bound=await send('/v1/control/bootstrap',one({database_id:id(),bootstrap_id:id()}),200);
  const old={version:1,project_id:PROJECT_ID,binding_hash:bound.binding.binding_hash,state:'serving',marker:bound.control.marker,pending_operation_id:null,recovery_generation_id:null,quarantine:null};
  const control=(await send('/v2/control/upgrade',two({upgrade_id:id(),expected:old.marker,expected_control_hash:await sha256(canonical(old)),coverage_anchor_hash:'b'.repeat(64)}),200)).control;
  const recoveryId=id(),begin=await send('/v2/recovery/begin',two({recovery_id:recoveryId,cut_id:id(),expected:control.marker,writer_generation_id:control.writer_generation_id}),200);
  const progress={};for(const chain of ['registrations','observations'])progress[chain]=await send('/v2/recovery/'+recoveryId+'/enumeration-progress?chain='+chain,undefined,200);
  const cut=two({recovery_id:recoveryId,cut_id:id(),expected_parent_cut_id:begin.active_cut.cut_id,expected_parent_cut_hash:begin.active_cut.cut_hash,
   expected_progress:Object.fromEntries(Object.entries(progress).map(([k,v])=>[k,v.progress.state_hash])),carry_prefix:{registrations:true,observations:true}});
  const made=await send('/v2/recovery/'+recoveryId+'/cuts',cut,200);assert.equal(made.cut.cut_ordinal,1);const quarantine=(await send('/v2/control',undefined,200)).control,snapshot=await dump();
  await restart(modern.outputFiles[0].text);const input={version:3,project_id:PROJECT_ID,capability_id:id(),expected_marker:quarantine.marker,expected_control_hash:await sha256(canonical(quarantine)),expected_restriction_head:quarantine.marker.cursor,expected_registration_head:quarantine.registration_head,expected_observation_head:quarantine.observation_head};
  assert.deepEqual(await send('/v3/control/capability',input,409),{error:'inventory_capability_not_serving'});assert.deepEqual(await dump(),snapshot);
 }finally{await mf?.dispose();await rm(directory,{recursive:true,force:true});}
});
