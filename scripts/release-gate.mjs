#!/usr/bin/env node
/** Verify exact-candidate evidence integrity and declared qualification scope.
 * A complete record is not independent proof of observations or launch authorization.
 * This program never deploys, signs, publishes, or fills in a passing observation. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const root=fileURLToPath(new URL('../',import.meta.url));
const exactKeys=(value,keys)=>object(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const sha=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const commit=value=>typeof value==='string'&&/^[0-9a-f]{40}$/.test(value);
const named=value=>typeof value==='string'&&value===value.trim()&&value.length>=3&&value.length<=200&&!/[\x00-\x1f\x7f]/.test(value);
const environmentNames=Object.freeze({workspace:'source',host:'host',device:'device',provider:'provider',browser:'browser',store:'store',
  'mac runner':'mac_runner',repository:'repository',runner:'runner',domain:'domain',signing:'signing',operations:'operations',data:'recognition_data'});
const knownEnvironments=new Set(Object.values(environmentNames));
const environments=value=>Array.isArray(value)&&value.length>0&&value.length<=knownEnvironments.size&&
  value.every(item=>knownEnvironments.has(item))&&new Set(value).size===value.length;
const covers=(actual,required)=>required.every(value=>actual.includes(value));
const timestamp=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)?Date.parse(value):NaN;
const fresh=(value,now,maxAge)=>Number.isFinite(timestamp(value))&&timestamp(value)<=now+300000&&timestamp(value)>=now-maxAge;
const limits='Verifies file integrity, exact candidate bindings, required scope and declared qualification completeness only. It does not independently establish the truth or sufficiency of observations, authorize launch, deploy or publish. Named reviewers and the release owner retain those responsibilities.';

export function requiredEnvironments(execution) {
  if(typeof execution!=='string')throw Error('invalid_task_execution');
  const parts=execution.trim().toLowerCase().split(/\s+and\s+/),result=parts.map(part=>environmentNames[part]);
  if(!result.length||result.some(value=>!value)||new Set(result).size!==result.length)throw Error('invalid_task_execution');
  return result.sort();
}
function coreTasks(tasks) {
  if(!Array.isArray(tasks)||tasks.length<1||tasks.length>200)throw Error('invalid_task_catalog');
  const ids=new Set();
  for(const task of tasks) {
    if(!object(task)||!/^[A-Z][0-9]{2}$/.test(task.id??'')||ids.has(task.id)||!['P0','P1','P2'].includes(task.priority)||
      !['Core release','Platform capability','After stable rollout'].includes(task.gate))throw Error('invalid_task_catalog');
    ids.add(task.id);requiredEnvironments(task.execution);
  }
  const required=tasks.filter(task=>task.gate==='Core release');
  if(!required.length)throw Error('empty_core_task_catalog');
  return required;
}
const operational=task=>requiredEnvironments(task.execution).some(value=>value!=='source');

export function evidenceTemplate(tasks,sourceCommit,now=Date.now()) {
  assert(commit(sourceCommit),'Exact source commit required');
  return {protocol:'lovelies-release-evidence-v2',source_commit:sourceCommit,created_at:new Date(now).toISOString(),architecture:'locally_hosted_supabase',
    deployment:{source_commit:null,configuration_sha256:null,migration_inventory_sha256:null,configuration:null,migration_inventory:null,readback:null},
    artifacts:[],tasks:coreTasks(tasks).map(task=>({id:task.id,status:'pending',scope:operational(task)?'operational':'source',
      environments:requiredEnvironments(task.execution),reviewer:null,observed_at:null,evidence:[]})),decision:{status:'blocked',owner:null}};
}

async function readEvidence(base,reference,{json=false,artifact=false}={}) {
  if(!exactKeys(reference,['path','sha256'])||!sha(reference.sha256)||typeof reference.path!=='string'||!reference.path||
    path.isAbsolute(reference.path)||reference.path.includes('\\')||reference.path.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('invalid_evidence_reference');
  if(typeof base!=='string'||!base)throw Error('evidence_root_required');
  const target=path.resolve(base,reference.path),realBase=await fs.realpath(base),real=await fs.realpath(target);
  if(real!==target||!real.startsWith(realBase+path.sep))throw Error('evidence_path_escape');
  const stat=await fs.lstat(target),maximum=artifact?2*1024**3:json?2*1024**2:64*1024**2;
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>maximum)throw Error('invalid_evidence_file');
  const digest=createHash('sha256');
  if(json) {
    const bytes=await fs.readFile(target);digest.update(bytes);
    if(digest.digest('hex')!==reference.sha256)throw Error('evidence_digest_mismatch');
    let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{throw Error('qualification_json_required');}
    if(!object(value))throw Error('qualification_json_required');return value;
  }
  for await(const chunk of createReadStream(target))digest.update(chunk);
  if(digest.digest('hex')!==reference.sha256)throw Error('evidence_digest_mismatch');
  return reference.sha256;
}
const evidenceCode=error=>/^(invalid_evidence_reference|evidence_root_required|evidence_path_escape|invalid_evidence_file|evidence_digest_mismatch|qualification_json_required)$/.test(error?.message??'')?error.message:'evidence_unreadable';

export async function verifyReleaseEvidence(manifest,tasks,{sourceCommit,evidenceRoot,now=Date.now(),maxAgeMs=7*86400000}={}) {
  const failures=[];
  const fail=(id,reason)=>failures.push({id:typeof id==='string'?id:'manifest',reason});
  const result=required=>({status:failures.length?'blocked':'evidence_record_complete',source_commit:sourceCommit,required_tasks:required,
    checked_at:Number.isFinite(new Date(now).getTime())?new Date(now).toISOString():null,failures,limits});
  let required=[];
  try {
    if(!Number.isFinite(now)||!Number.isFinite(new Date(now).getTime())||!Number.isFinite(maxAgeMs)||maxAgeMs<=0||maxAgeMs>30*86400000){fail('manifest','invalid_validation_window');return result(0);}
    try{required=coreTasks(tasks);}catch(error){fail('tasks',error.message);return result(0);}
    if(!object(manifest)||manifest.protocol!=='lovelies-release-evidence-v2'||manifest.architecture!=='locally_hosted_supabase'){
      fail('manifest','unsupported_protocol_or_architecture');return result(required.length);
    }
    if(!commit(sourceCommit)||manifest.source_commit!==sourceCommit)fail('manifest','source_commit_mismatch');
    if(!fresh(manifest.created_at,now,maxAgeMs))fail('manifest','stale_or_invalid_record');
    const expected=new Set(required.map(task=>task.id)),entries=new Map(),usedQualifications=new Set();
    if(!Array.isArray(manifest.tasks)||manifest.tasks.length>200){fail('tasks','task_records_required');}
    else for(const row of manifest.tasks) {
      if(!object(row)||!expected.has(row.id)||entries.has(row.id)){fail(row?.id??'tasks','unknown_or_duplicate_task');continue;}
      entries.set(row.id,row);
    }
    for(const task of required) {
      const row=entries.get(task.id),needed=requiredEnvironments(task.execution);
      if(!row||row.status!=='passed'){fail(task.id,'acceptance_not_passed');continue;}
      if(row.scope!==(operational(task)?'operational':'source'))fail(task.id,'scope_does_not_satisfy_acceptance');
      if(!environments(row.environments)||!covers(row.environments,needed))fail(task.id,'required_environment_coverage_missing');
      if(!named(row.reviewer))fail(task.id,'named_acceptance_reviewer_required');
      if(!fresh(row.observed_at,now,maxAgeMs))fail(task.id,'stale_or_invalid_observation');
      if(!Array.isArray(row.evidence)||row.evidence.length<1||row.evidence.length>32){fail(task.id,'qualification_receipt_required');continue;}
      const observedCoverage=new Set();let latestObservation=-Infinity;
      for(const reference of row.evidence) {
        try {
          const receipt=await readEvidence(evidenceRoot,reference,{json:true});
          if(usedQualifications.has(reference.path)){fail(task.id,'qualification_receipt_reused');continue;}
          usedQualifications.add(reference.path);
          if(receipt.protocol!=='lovelies-task-qualification-v1'||receipt.task_id!==task.id||receipt.source_commit!==sourceCommit||receipt.status!=='passed'){
            fail(task.id,'qualification_receipt_binding_mismatch');continue;
          }
          if(!fresh(receipt.observed_at,now,maxAgeMs)||!named(receipt.reviewer)){fail(task.id,'qualification_observation_invalid');continue;}
          if(!environments(receipt.environments)){fail(task.id,'qualification_environment_invalid');continue;}
          for(const environment of receipt.environments)observedCoverage.add(environment);
          latestObservation=Math.max(latestObservation,timestamp(receipt.observed_at));
        }catch(error){fail(task.id,evidenceCode(error));}
      }
      if(!covers([...observedCoverage],needed))fail(task.id,'qualification_environment_coverage_missing');
      if(timestamp(row.observed_at)!==latestObservation)fail(task.id,'qualification_observation_binding_mismatch');
      if(environments(row.environments)&&!covers([...observedCoverage],row.environments))fail(task.id,'declared_environment_unqualified');
    }
    const artifacts=Array.isArray(manifest.artifacts)?manifest.artifacts:[],byPlatform=new Map();
    if(!Array.isArray(manifest.artifacts)||artifacts.length!==3)fail('artifacts','three_exact_release_artifacts_required');
    for(const item of artifacts) {
      if(!object(item)||!['android','ios','backend'].includes(item.platform)||byPlatform.has(item.platform)){fail('artifacts','unknown_or_duplicate_artifact');continue;}
      byPlatform.set(item.platform,item);
    }
    for(const platform of ['android','ios','backend']) {
      const artifact=byPlatform.get(platform);
      if(!artifact){fail(platform,'one_exact_release_artifact_required');continue;}
      if(artifact.source_commit!==sourceCommit||!sha(artifact.sha256)||!named(artifact.version)||artifact.file?.sha256!==artifact.sha256)
        fail(platform,'artifact_provenance_required');
      if(platform!=='backend'&&(artifact.application_id!=='com.lovelies.memories'||!sha(artifact.signing_certificate_sha256)))
        fail(platform,'existing_identity_and_signing_lineage_required');
      if(platform==='backend'&&!/^sha256:[0-9a-f]{64}$/.test(artifact.image_digest??''))fail(platform,'immutable_image_digest_required');
      try{await readEvidence(evidenceRoot,artifact.file,{artifact:true});}catch(error){fail(platform,evidenceCode(error));}
      try {
        const receipt=await readEvidence(evidenceRoot,artifact.readback,{json:true});
        if(receipt.protocol!=='lovelies-release-artifact-readback-v1'||receipt.status!=='passed'||receipt.source_commit!==sourceCommit||
          receipt.platform!==platform||receipt.artifact_sha256!==artifact.sha256||receipt.version!==artifact.version||!fresh(receipt.observed_at,now,maxAgeMs))
          fail(platform,'artifact_readback_binding_mismatch');
        if(platform!=='backend'&&(receipt.application_id!==artifact.application_id||receipt.signing_certificate_sha256!==artifact.signing_certificate_sha256||
          receipt.signing_verified!==true||receipt.signing_lineage_verified!==true))fail(platform,'signed_candidate_readback_required');
        if(platform==='backend'&&receipt.image_digest!==artifact.image_digest)fail(platform,'backend_image_readback_mismatch');
      }catch(error){fail(platform,evidenceCode(error));}
    }
    const deployment=manifest.deployment;
    if(!object(deployment)||deployment.source_commit!==sourceCommit||!sha(deployment.configuration_sha256)||!sha(deployment.migration_inventory_sha256)||
      deployment.configuration?.sha256!==deployment.configuration_sha256||deployment.migration_inventory?.sha256!==deployment.migration_inventory_sha256)
      fail('deployment','exact_deployment_files_required');
    for(const key of ['configuration','migration_inventory'])try{await readEvidence(evidenceRoot,deployment?.[key]);}catch(error){fail('deployment',evidenceCode(error));}
    try {
      const receipt=await readEvidence(evidenceRoot,deployment?.readback,{json:true}),backend=byPlatform.get('backend');
      if(receipt.protocol!=='lovelies-release-deployment-readback-v1'||receipt.status!=='passed'||receipt.source_commit!==sourceCommit||
        receipt.architecture!=='locally_hosted_supabase'||receipt.schema_version!==19||!fresh(receipt.observed_at,now,maxAgeMs)||
        receipt.configuration_sha256!==deployment?.configuration_sha256||receipt.migration_inventory_sha256!==deployment?.migration_inventory_sha256||
        !backend||receipt.backend_artifact_sha256!==backend.sha256||receipt.backend_image_digest!==backend.image_digest)
        fail('deployment','deployment_readback_binding_mismatch');
    }catch(error){fail('deployment',evidenceCode(error));}
    if(manifest.decision?.status!=='approved'||!named(manifest.decision?.owner))fail('decision','named_launch_decision_required');
  }catch{fail('manifest','malformed_manifest_or_evidence');}
  return result(required.length);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2),mode=args[0],file=args[1];
    if(args.length!==2||!['--template','--manifest'].includes(mode)||!file)throw Error('invalid_arguments');
    const tasks=JSON.parse(await fs.readFile(path.join(root,'docs/release/local-supabase-tasks.json'),'utf8')).tasks;
    const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
    if(mode==='--template') {
      await fs.writeFile(file,JSON.stringify(evidenceTemplate(tasks,sourceCommit),null,2)+'\n',{flag:'wx',mode:0o600});
      process.stdout.write(JSON.stringify({status:'blocked_template_created',path:path.resolve(file)})+'\n');
    }else{
      // A HEAD label cannot qualify a different, uncommitted source candidate.
      const dirty=execFileSync('git',['status','--porcelain','--untracked-files=normal'],{cwd:root,encoding:'utf8'}).trim();
      if(dirty)throw Error('source_worktree_not_clean');
      const manifest=JSON.parse(await fs.readFile(file,'utf8'));
      const result=await verifyReleaseEvidence(manifest,tasks,{sourceCommit,evidenceRoot:path.dirname(path.resolve(file))});
      process.stdout.write(JSON.stringify(result,null,2)+'\n');process.exitCode=result.status==='evidence_record_complete'?0:2;
    }
  }catch(error){
    process.stdout.write(JSON.stringify({status:'blocked',failures:[{id:'input',reason:['invalid_arguments','source_worktree_not_clean'].includes(error.message)?error.message:'release_input_unavailable_or_malformed'}],limits})+'\n');
    process.exitCode=2;
  }
}
