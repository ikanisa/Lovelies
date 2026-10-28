import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createModelServices} from '../src/model-services.ts';
import {INFERENCE_ENGINE_SPACE, INFERENCE_MODEL_ID, INFERENCE_MODEL_HASHES, INFERENCE_CAPABILITIES, INFERENCE_LIMITS} from '../src/inference-contract.ts';

// No accounts, credentials, storage, external inference, network or database.
const artifact='a'.repeat(64), processing='b'.repeat(64);
const ready={available:true,engine_space:INFERENCE_ENGINE_SPACE,engine_artifact_sha256:artifact,processing_fingerprint:processing,
  model_id:INFERENCE_MODEL_ID,model_hashes:{...INFERENCE_MODEL_HASHES},capabilities:[...INFERENCE_CAPABILITIES],limits:{...INFERENCE_LIMITS},liveness_required:false};
function harness(){
  let calls=0;
  const env={PHOTOS:{},QUARANTINE:{},MODEL_VERSION:INFERENCE_MODEL_ID,FACE_AUTH_POLICY_VERSION:'fixture',ENGINE_ARTIFACT_SHA256:artifact,PROCESSING_FINGERPRINT:processing,
    INFERENCE:{fetch:async request=>{calls++;assert.equal(new URL(request.url).pathname,'/ready');return Response.json(ready);}}};
  return {services:createModelServices(env),env,calls:()=>calls};
}
function delayedCancel(){
  let reached,release,reject,called=0;
  const entered=new Promise(resolve=>reached=resolve);
  const gate=new Promise((resolve,fail)=>{release=resolve;reject=fail;});
  // The consumer must still observe the promise returned by stream.cancel().
  const stream=new ReadableStream({cancel(){called++;reached();return gate;}},{highWaterMark:0});
  return {stream,entered,release,reject,calls:()=>called};
}
function request(body,path='/not-a-real-route',headers={}){return new Request('https://fixture.invalid'+path,{method:'POST',headers,body,duplex:'half'});}
async function within(promise,ms=500){
  let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('local_teardown_did_not_finish')),ms);})]);}
  finally{clearTimeout(timer);}
}
for(const route of ['face','photo'])test(`${route} invalid route responds before an uncooperative request-body cancellation settles`,{timeout:4000},async()=>{
  const h=harness(),input=delayedCancel(),pending=h.services[route].fetch(request(input.stream));
  try {
    await within(input.entered);
    const response=await within(pending);
    assert.equal(response.status,404);assert.deepEqual(await response.json(),{error:{code:'route_not_found'}});
    assert.equal(input.calls(),1);assert.equal(h.calls(),0);
  } finally {input.release();await pending.catch(()=>{});}
});
for(const [route,path,status,code] of [['face','/v1/face-auth/verify',503,'face_policy_unavailable'],['photo','/process',415,'json_required']])test(`${route} valid route rejects before body consumption or inference without waiting for cancellation`,{timeout:4000},async()=>{
  const h=harness(),input=delayedCancel();
  if(route==='face')h.env.FACE_AUTH_POLICY_VERSION='';
  const pending=h.services[route].fetch(request(input.stream,path,{'content-type':'application/octet-stream'}));
  try {
    await within(input.entered);const response=await within(pending);
    assert.equal(response.status,status);assert.deepEqual(await response.json(),{error:{code}});
    assert.equal(input.calls(),1);assert.equal(h.calls(),0);
  } finally {input.release();await pending.catch(()=>{});}
});
test('a late rejected cancellation is observed after the error response',{timeout:4000},async()=>{
  const h=harness(),input=delayedCancel(),pending=h.services.face.fetch(request(input.stream));
  try {
    await within(input.entered);const response=await within(pending);
    assert.equal(response.status,404);assert.equal(input.calls(),1);assert.equal(h.calls(),0);
    input.reject(new Error('synthetic late cancel failure'));await new Promise(resolve=>setTimeout(resolve,20));
  } finally {input.release();await pending.catch(()=>{});}
});
test('a synchronously throwing cancellation does not replace the route error',{timeout:4000},async()=>{
  const h=harness(),input=new ReadableStream({},{highWaterMark:0}),req=request(input);let calls=0;
  Object.defineProperty(req.body,'cancel',{value:()=>{calls++;throw new Error('synthetic sync cancel failure');}});
  const response=await within(h.services.face.fetch(req));assert.equal(response.status,404);
  assert.deepEqual(await response.json(),{error:{code:'route_not_found'}});assert.equal(calls,1);assert.equal(h.calls(),0);
});
test('an already locked request body is neither cancelled nor unlocked by the boundary',{timeout:4000},async()=>{
  const h=harness();let calls=0;const stream=new ReadableStream({cancel(){calls++;}},{highWaterMark:0}),req=request(stream),reader=req.body.getReader();
  try{const response=await within(h.services.face.fetch(req));assert.equal(response.status,404);assert.equal(req.body.locked,true);assert.equal(calls,0);}
  finally{reader.releaseLock();await req.body.cancel();}
  assert.equal(calls,1);assert.equal(h.calls(),0);
});
test('the synthetic ready response remains successful and is consumed normally',{timeout:4000},async()=>{
  const h=harness(),response=await within(h.services.face.fetch('https://fixture.invalid/ready'));
  assert.equal(response.status,200);assert.deepEqual(await response.json(),ready);assert.equal(h.calls(),1);
});
