import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {evidenceTemplate,verifyReleaseEvidence,requiredEnvironments} from '../release-gate.mjs';

// These bytes and readbacks test the validator only. They are deliberately not
// device/provider/signing/deployment evidence and cannot qualify a real release.
const sourceCommit='a'.repeat(40),now=Date.now(),observed=new Date(now).toISOString();
const tasks=[{id:'S01',priority:'P0',gate:'Core release',execution:'Workspace'},
  {id:'H05',priority:'P0',gate:'Core release',execution:'Host'},
  {id:'D06',priority:'P1',gate:'Core release',execution:'Device and store'},
  {id:'I01',priority:'P0',gate:'Core release',execution:'Mac runner'},
  {id:'R08',priority:'P2',gate:'After stable rollout',execution:'Host and operations'}];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const evidenceRoot=await fs.mkdtemp(path.join(os.tmpdir(),'lovelies-release-gate-'));t.after(()=>fs.rm(evidenceRoot,{recursive:true,force:true}));
  const put=async(name,value)=>{const bytes=Buffer.from(typeof value==='string'?value:JSON.stringify(value));await fs.writeFile(path.join(evidenceRoot,name),bytes);return {path:name,sha256:digest(bytes)};};
  const manifest=evidenceTemplate(tasks,sourceCommit,now);
  for(const row of manifest.tasks) {
    Object.assign(row,{status:'passed',reviewer:'Validator fixture reviewer',observed_at:observed});
    row.evidence=[await put('task-'+row.id+'.json',{protocol:'lovelies-task-qualification-v1',task_id:row.id,source_commit:sourceCommit,
      status:'passed',observed_at:observed,environments:row.environments,reviewer:'Validator fixture reviewer'})];
  }
  for(const platform of ['android','ios','backend']) {
    const file=await put(platform+'.fixture','Synthetic '+platform+' bytes for validator tests only; not a release artifact.\n');
    const artifact={platform,source_commit:sourceCommit,sha256:file.sha256,version:'fixture-1',file,
      ...(platform==='backend'?{image_digest:'sha256:'+'c'.repeat(64)}:{application_id:'com.lovelies.memories',signing_certificate_sha256:'d'.repeat(64)})};
    artifact.readback=await put(platform+'-readback.json',{protocol:'lovelies-release-artifact-readback-v1',status:'passed',platform,
      source_commit:sourceCommit,observed_at:observed,artifact_sha256:file.sha256,version:artifact.version,
      ...(platform==='backend'?{image_digest:artifact.image_digest}:{application_id:artifact.application_id,signing_certificate_sha256:artifact.signing_certificate_sha256,signing_verified:true,signing_lineage_verified:true})});
    manifest.artifacts.push(artifact);
  }
  const configuration=await put('configuration.json',{fixture:true,secrets_included:false,architecture:'locally_hosted_supabase'});
  const migration_inventory=await put('migrations.json',{fixture:true,migrations:[{name:'0019_fixture.sql',sha256:'e'.repeat(64)}]});
  const backend=manifest.artifacts.find(value=>value.platform==='backend');
  manifest.deployment={source_commit:sourceCommit,configuration_sha256:configuration.sha256,migration_inventory_sha256:migration_inventory.sha256,configuration,migration_inventory,
    readback:await put('deployment-readback.json',{protocol:'lovelies-release-deployment-readback-v1',status:'passed',source_commit:sourceCommit,observed_at:observed,
      architecture:'locally_hosted_supabase',schema_version:19,configuration_sha256:configuration.sha256,migration_inventory_sha256:migration_inventory.sha256,
      backend_artifact_sha256:backend.sha256,backend_image_digest:backend.image_digest})};
  manifest.decision={status:'approved',owner:'Validator fixture owner'};
  const revise=async(reference,change)=>{const value=JSON.parse(await fs.readFile(path.join(evidenceRoot,reference.path),'utf8'));change(value);return put(reference.path,value);};
  return {manifest,options:{sourceCommit,evidenceRoot,now},put,revise};
}
const has=(result,reason)=>result.failures.some(value=>value.reason===reason);

test('every execution domain has explicit coverage; a Mac runner is not a physical device',()=>{
  for(const [input,expected] of [['Workspace',['source']],['Device and provider',['device','provider']],['Mac runner',['mac_runner']],
    ['Workspace and browser',['browser','source']],['Store and signing',['signing','store']],['Data and host',['host','recognition_data']],
    ['Repository and runner',['repository','runner']],['Domain and operations',['domain','operations']]])assert.deepEqual(requiredEnvironments(input),expected);
  assert.throws(()=>requiredEnvironments('Runner or device'));assert.throws(()=>requiredEnvironments('Host and invented'));
});
test('new release template is blocked and keeps every current core task',async t=>{
  const {options}=await fixture(t),template=evidenceTemplate(tasks,sourceCommit,now);
  const result=await verifyReleaseEvidence(template,tasks,options);assert.equal(result.status,'blocked');assert.equal(result.required_tasks,4);assert(has(result,'acceptance_not_passed'));
  const actual=JSON.parse(await fs.readFile(new URL('../../docs/release/local-supabase-tasks.json',import.meta.url),'utf8')).tasks;
  assert.deepEqual(evidenceTemplate(actual,sourceCommit,now).tasks.map(value=>value.id),actual.filter(value=>value.gate==='Core release').map(value=>value.id));
  assert.equal(evidenceTemplate(actual,sourceCommit,now).tasks.length,60);
});
test('typed synthetic fixture is structurally complete and explicitly not independent qualification or authorization',async t=>{
  const {manifest,options}=await fixture(t),result=await verifyReleaseEvidence(manifest,tasks,options);
  assert.deepEqual(result.failures,[]);assert.equal(result.status,'evidence_record_complete');assert.notEqual(result.status,'accepted');
  assert.match(result.limits,/does not independently establish/);assert.match(result.limits,/authorize launch/);
});
test('original false positive: one plain text file, fabricated digests and runner-only claims cannot close all tasks',async t=>{
  const {manifest,options,put}=await fixture(t),evidence=[await put('synthetic.txt','No deployment, signing, devices or release artifacts exist.\n')];
  for(const row of manifest.tasks){row.environments=['runner'];row.evidence=evidence;}
  manifest.deployment={source_commit:sourceCommit,configuration_sha256:'b'.repeat(64),migration_inventory_sha256:'b'.repeat(64)};
  manifest.artifacts=manifest.artifacts.map(value=>({...value,sha256:'b'.repeat(64),file:undefined,readback:undefined,evidence}));
  const result=await verifyReleaseEvidence(manifest,tasks,options);assert.equal(result.status,'blocked');
  for(const code of ['qualification_json_required','required_environment_coverage_missing','artifact_provenance_required','exact_deployment_files_required'])assert(has(result,code),code);
});
test('generic JSON runner qualification cannot close device/store, Mac or host acceptance',async t=>{
  const {manifest,options,revise}=await fixture(t);
  for(const row of manifest.tasks){row.environments=['runner'];row.evidence[0]=await revise(row.evidence[0],value=>{value.environments=['runner'];});}
  const result=await verifyReleaseEvidence(manifest,tasks,options);assert.equal(result.status,'blocked');
  for(const id of ['H05','D06','I01'])assert(result.failures.some(value=>value.id===id&&value.reason==='qualification_environment_coverage_missing'));
});
test('task receipt cannot be reused, relabelled, or bound to a different candidate',async t=>{
  const {manifest,options,revise}=await fixture(t);
  manifest.tasks[1].evidence=manifest.tasks[0].evidence;
  manifest.tasks[2].evidence[0]=await revise(manifest.tasks[2].evidence[0],value=>{value.source_commit='f'.repeat(40);});
  const result=await verifyReleaseEvidence(manifest,tasks,options);assert.equal(result.status,'blocked');
  assert(has(result,'qualification_receipt_reused'));assert(has(result,'qualification_receipt_binding_mismatch'));
});
test('real file digest and signed artifact readback must identify the same exact candidate',async t=>{
  const {manifest,options,revise}=await fixture(t);
  manifest.artifacts[0].sha256='f'.repeat(64);
  manifest.artifacts[1].readback=await revise(manifest.artifacts[1].readback,value=>{value.application_id='replacement.app';value.signing_lineage_verified=false;});
  const result=await verifyReleaseEvidence(manifest,tasks,options);assert.equal(result.status,'blocked');
  assert(has(result,'artifact_provenance_required'));assert(has(result,'artifact_readback_binding_mismatch'));assert(has(result,'signed_candidate_readback_required'));
});
test('actual artifact bytes are hashed, not just the metadata sidecar',async t=>{
  const {manifest,options}=await fixture(t);await fs.writeFile(path.join(options.evidenceRoot,manifest.artifacts[0].file.path),'Changed candidate bytes');
  assert(has(await verifyReleaseEvidence(manifest,tasks,options),'evidence_digest_mismatch'));
});
test('deployment requires schema19, actual configuration and migration files and matching backend digest',async t=>{
  const {manifest,options,revise}=await fixture(t);
  manifest.deployment.readback=await revise(manifest.deployment.readback,value=>{value.schema_version=18;value.backend_artifact_sha256='f'.repeat(64);value.status='partial_host_evidence';});
  const result=await verifyReleaseEvidence(manifest,tasks,options);assert.equal(result.status,'blocked');assert(has(result,'deployment_readback_binding_mismatch'));
  await fs.writeFile(path.join(options.evidenceRoot,manifest.deployment.configuration.path),'Changed effective configuration');
  assert(has(await verifyReleaseEvidence(manifest,tasks,options),'evidence_digest_mismatch'));
});
test('stale qualification and artifact receipts plus misleading row timestamps are blocked',async t=>{
  const {manifest,options,revise}=await fixture(t),stale=new Date(now-8*86400000).toISOString();
  manifest.tasks[0].evidence[0]=await revise(manifest.tasks[0].evidence[0],value=>{value.observed_at=stale;});
  manifest.artifacts[0].readback=await revise(manifest.artifacts[0].readback,value=>{value.observed_at=stale;});
  const result=await verifyReleaseEvidence(manifest,tasks,options);assert.equal(result.status,'blocked');
  assert(has(result,'qualification_observation_invalid'));assert(has(result,'qualification_observation_binding_mismatch'));assert(has(result,'artifact_readback_binding_mismatch'));
});
test('path escape, symlink evidence and changed receipt bytes fail integrity checks',async t=>{
  const {manifest,options}=await fixture(t);
  manifest.tasks[0].evidence=[{path:'../outside.json',sha256:'f'.repeat(64)}];
  await fs.symlink(path.join(options.evidenceRoot,manifest.tasks[1].evidence[0].path),path.join(options.evidenceRoot,'linked.json'));
  manifest.tasks[1].evidence=[{path:'linked.json',sha256:manifest.tasks[1].evidence[0].sha256}];
  await fs.writeFile(path.join(options.evidenceRoot,manifest.tasks[2].evidence[0].path),'changed');
  const result=await verifyReleaseEvidence(manifest,tasks,options);assert.equal(result.status,'blocked');
  for(const code of ['invalid_evidence_reference','evidence_path_escape','evidence_digest_mismatch'])assert(has(result,code),code);
});
test('malformed evidence arrays, missing catalog and inconsistent tasks always return blocked',async t=>{
  const {manifest,options}=await fixture(t);
  for(const change of [value=>{value.tasks[0].evidence={};},value=>{value.artifacts={};},value=>{value.artifacts[0].readback=[];},
    value=>{value.tasks.push({...value.tasks[0]});},value=>{value.deployment=null;},value=>{value.decision.owner='';}]){
    const candidate=structuredClone(manifest);change(candidate);assert.equal((await verifyReleaseEvidence(candidate,tasks,options)).status,'blocked');
  }
  for(const catalog of [null,[],[...tasks,{...tasks[0]}]])assert.equal((await verifyReleaseEvidence(manifest,catalog,options)).status,'blocked');
});
