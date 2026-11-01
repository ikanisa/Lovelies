#!/usr/bin/env node
/** Read-only host observation. No user rows, provider sends, repair, or alert delivery. */
import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {args,runtime,sql,privateRequest,writeReceipt} from './local-supabase-common.mjs';
import {sourceIdentity} from './local-supabase-evidence.mjs';

export const METRICS_SQL=`BEGIN READ ONLY;
SET LOCAL statement_timeout='5000ms';
SET LOCAL ROLE lovelies_api;
SELECT json_build_object(
 'schema_version',(SELECT max(version) FROM lovelies_private.schema_versions),
 'queue',COALESCE((SELECT json_agg(x) FROM (
  SELECT category,state,count(*)::integer AS count,
   greatest(0,floor((extract(epoch FROM clock_timestamp())*1000-min(created_at))/1000))::bigint AS oldest_seconds,
   count(*) FILTER(WHERE state='processing' AND lease_until<extract(epoch FROM clock_timestamp())*1000)::integer AS expired_leases
  FROM lovelies_private.job_queue WHERE state<>'completed' GROUP BY category,state ORDER BY category,state
 ) x),'[]'::json),
 'cleanup_unresolved',(SELECT count(*) FROM lovelies_private.cleanup_intents WHERE status<>'verified'),
 'media_writers_unsettled',(SELECT count(*) FROM lovelies_private.media_write_intents WHERE status='pending'),
 'push_uncertain',(SELECT count(*) FROM lovelies_private.notification_deliveries WHERE status IN('dispatching','ambiguous')),
 'managed_auth_unresolved',(SELECT count(*) FROM lovelies_private.managed_auth_bindings WHERE state IN('creating','ambiguous','retiring')),
 'waiting_locks',(SELECT count(*) FROM pg_catalog.pg_locks WHERE NOT granted),
 'database_bytes',pg_database_size(current_database())
);
ROLLBACK;`;

const limits=['max_queue_age_seconds','max_failed_jobs','max_expired_leases','max_cleanup_unresolved',
 'max_media_writers_unsettled','max_push_uncertain','max_managed_auth_unresolved','max_waiting_locks','max_read_p95_ms'];
export function thresholds(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join()!==[...limits].sort().join())throw Error('explicit_complete_thresholds_required');
 for(const name of limits)if(!Number.isSafeInteger(value[name])||value[name]<0||value[name]>1e12)throw Error('threshold_invalid');
 return Object.freeze({...value});
}
export function percentile(values,p){
 if(!values.length||values.some(v=>!Number.isFinite(v)||v<0)||p<=0||p>1)throw Error('latency_samples_invalid');
 return [...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
}
export function evaluate(sample,policy){
 const alerts=[];const exceed=(id,value,limit)=>{if(value>limit)alerts.push({id,value,limit});};
 if(sample.checks.some(check=>check.status!=='passed'))alerts.push({id:'service_observation_failed'});
 if(sample.database){
  if(sample.database.schema_version!==19)alerts.push({id:'schema_mismatch'});
  let expired=0,failed=0;
  for(const row of sample.database.queue){
   if(!['photo','privacy','notification'].includes(row.category)||!['pending','processing','failed'].includes(row.state)||
      [row.count,row.oldest_seconds,row.expired_leases].some(value=>!Number.isSafeInteger(Number(value))||Number(value)<0))throw Error('aggregate_shape_invalid');
   if(row.state!=='failed')exceed('queue_age_'+row.category,Number(row.oldest_seconds),policy.max_queue_age_seconds);
   if(row.state==='failed')failed+=Number(row.count);expired+=Number(row.expired_leases);
  }
  exceed('failed_jobs',failed,policy.max_failed_jobs);exceed('expired_leases',expired,policy.max_expired_leases);
  for(const name of ['cleanup_unresolved','media_writers_unsettled','push_uncertain','managed_auth_unresolved','waiting_locks']){
   const value=Number(sample.database[name]);if(!Number.isSafeInteger(value)||value<0)throw Error('aggregate_shape_invalid');
   exceed(name,value,policy['max_'+name]);
  }
 }
 if(sample.read_latency)exceed('read_p95_ms',sample.read_latency.p95_ms,policy.max_read_p95_ms);
 return alerts;
}

async function health(url){
 const begin=performance.now();
 const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(15000)});
 const reader=response.body?.getReader();let size=0;const chunks=[];
 if(!reader)throw Error('health_body_missing');
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>32768)throw Error('health_body_limit');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
 const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 if(!response.ok||value.status!=='ok'||value.schema_version!==19||value.service!=='lovelies-supabase-api')throw Error('health_failed');
 return {ms:performance.now()-begin,value};
}
export async function observe(r,{policy,probeCount=1,concurrency=1,dependencies={}}={}){
 const limits=thresholds(policy);
 if(!Number.isSafeInteger(probeCount)||probeCount<1||probeCount>100||!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>4||concurrency>probeCount)throw Error('bounded_probe_options_required');
 const source=dependencies.sourceIdentity??sourceIdentity,query=dependencies.sql??sql,privateGet=dependencies.privateRequest??privateRequest,readHealth=dependencies.health??health;
 const identity=await source(r),sample={protocol:'lovelies-platform-observation-v1',observed_at:new Date().toISOString(),
  ...identity,environment:'host',public_api_base_url:r.config.public_api_base_url,thresholds:limits,checks:[],
  scope:'Read-only health and aggregate database/custody observation. No mixed-write capacity, provider/device delivery, alert routing or recovery acceptance.'};
 const run=async(id,work)=>{try{const result=await work();sample.checks.push({id,status:'passed'});return result;}catch{sample.checks.push({id,status:'failed'});return null;}};
 sample.database=await run('private_database_aggregates',async()=>JSON.parse((await query(r,METRICS_SQL)).text));
 await run('public_application_readiness',async()=>{
  const {value}=await readHealth(r.config.public_api_base_url+'/ready');
  if(value.managed_auth_ready!==true||value.inference_ready!==true||value.push_roster_ready!==true)throw Error('dependency_not_ready');
 });
 for(const service of ['restore-journal','push-ledger'])await run(service+'_private_health',()=>privateGet(r,service,'/healthz',{credential:'health'}));
 await run('bounded_read_latency',async()=>{
  let next=0,failed=false;const times=[];
  const results=await Promise.allSettled(Array.from({length:concurrency},async()=>{while(!failed&&next++<probeCount){try{times.push((await readHealth(r.config.public_api_base_url+'/health')).ms);}catch(error){failed=true;throw error;}}}));
  if(results.some(result=>result.status==='rejected'))throw Error('read_probe_failed');
  sample.read_latency={requests:times.length,concurrency,p50_ms:percentile(times,.5),p95_ms:percentile(times,.95),max_ms:Math.max(...times)};
 });
 sample.alerts=evaluate(sample,limits);sample.status=sample.alerts.length?'attention_required':'within_configured_thresholds';
 return sample;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 (async()=>{
  const options=args(process.argv.slice(2),['--runtime','--thresholds','--receipt','--probe-count','--concurrency']);
  if(!options['--thresholds']||!options['--receipt'])throw Error('thresholds_and_new_receipt_required');
  const report=await observe(await runtime(options['--runtime']),{policy:JSON.parse(await fs.readFile(options['--thresholds'],'utf8')),
   probeCount:Number(options['--probe-count']??1),concurrency:Number(options['--concurrency']??1)});
  await writeReceipt(options['--receipt'],report);console.log(JSON.stringify(report,null,2));if(report.status!=='within_configured_thresholds')process.exitCode=2;
 })().catch(()=>{console.error('Observation could not complete. No recovery, provider send or alert delivery was attempted. Inspect the protected host configuration.');process.exitCode=1;});
}
