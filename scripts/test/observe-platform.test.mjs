import test from 'node:test';
import assert from 'node:assert/strict';
import {METRICS_SQL,thresholds,percentile,evaluate,observe} from '../observe-platform.mjs';
const policy={max_queue_age_seconds:60,max_failed_jobs:0,max_expired_leases:0,max_cleanup_unresolved:0,max_media_writers_unsettled:0,max_push_uncertain:0,max_managed_auth_unresolved:0,max_waiting_locks:0,max_read_p95_ms:100};
const database=()=>({schema_version:19,queue:[],cleanup_unresolved:0,media_writers_unsettled:0,push_uncertain:0,managed_auth_unresolved:0,waiting_locks:0,database_bytes:512});
test('observation requires complete explicit thresholds and computes nearest-rank tail latency',()=>{
 assert.throws(()=>thresholds({}));assert.throws(()=>thresholds({...policy,max_failed_jobs:-1}));assert.throws(()=>thresholds({...policy,extra:1}));
 assert.equal(percentile([1,100,3,2,4],.95),100);assert.equal(percentile([1,100,3,2,4],.5),3);
});
test('aggregate query is read-only and excludes row identities, payloads, tokens and private content',()=>{
 assert.match(METRICS_SQL,/BEGIN READ ONLY/);assert.match(METRICS_SQL,/SET LOCAL ROLE lovelies_api/);assert.match(METRICS_SQL,/statement_timeout/);
 assert.doesNotMatch(METRICS_SQL,/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|payload_json|object_key|token_hash|account_id|subject_id|provider_receipt)\b/i);
 assert.match(METRICS_SQL,/ROLLBACK/);
});
test('failed observation and stalled queues are material even with healthy HTTP',()=>{
 const sample={checks:[{status:'failed'}],database:{...database(),queue:[{category:'photo',state:'pending',count:1,oldest_seconds:61,expired_leases:0},{category:'privacy',state:'failed',count:1,oldest_seconds:3,expired_leases:0}]},read_latency:{p95_ms:101}};
 assert.deepEqual(evaluate(sample,thresholds(policy)).map(x=>x.id),['service_observation_failed','queue_age_photo','failed_jobs','read_p95_ms']);
 assert.throws(()=>evaluate({...sample,database:{...database(),push_uncertain:'secret'}},policy));
});
test('bounded concurrent probes preserve count and never mutate or emit messages',async()=>{
 let active=0,max=0,calls=0;const r={config:{public_api_base_url:'https://staging.invalid/functions/v1/lovelies-api'}};
 const report=await observe(r,{policy,probeCount:7,concurrency:3,dependencies:{
  sourceIdentity:async()=>({source_commit:'a'.repeat(40),source_dirty:false}),sql:async(_r,text)=>{assert.equal(text,METRICS_SQL);return {text:JSON.stringify(database())};},
  privateRequest:async(_r,_service,route,options)=>{assert.equal(route,'/healthz');assert.equal(options.credential,'health');return {status:'ok'};},
  health:async url=>{calls++;active++;max=Math.max(max,active);await new Promise(resolve=>setTimeout(resolve,1));active--;assert.match(url,/\/(ready|health)$/);return {ms:10,value:{managed_auth_ready:true,inference_ready:true,push_roster_ready:true}};}
 }});
 assert.equal(calls,8);assert.equal(max,3);assert.equal(report.read_latency.requests,7);assert.equal(report.status,'within_configured_thresholds');
 assert.equal(report.environment,'host');assert.match(report.scope,/No mixed-write capacity/);
});
test('a missing custody dependency records failure without leaking the exception',async()=>{
 const report=await observe({config:{public_api_base_url:'https://staging.invalid'}},{policy,dependencies:{
  sourceIdentity:async()=>({source_commit:'b'.repeat(40),source_dirty:true}),sql:async()=>({text:JSON.stringify(database())}),
  privateRequest:async()=>{throw Error('credential-and-private-data');},health:async()=>({ms:1,value:{managed_auth_ready:true,inference_ready:true,push_roster_ready:true}})
 }});
 assert.equal(report.status,'attention_required');assert.equal(report.checks.filter(x=>x.status==='failed').length,2);
 assert.doesNotMatch(JSON.stringify(report),/credential-and-private-data/);
});
