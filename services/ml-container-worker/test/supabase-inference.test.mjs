import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {builtinModules} from 'node:module';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

// Actual workerd/Worker proxy execution with explicit transport-only consumer
// fixtures. No container image, recognition, hosting or jurisdiction is claimed.
const secret='synthetic-supabase-inference-secret-for-tests';
const image='registry.cloudflare.com/'+'1'.repeat(32)+'/fixture-only@sha256:'+'d'.repeat(64);
const defaults={ML_INFERENCE_SECRET:secret,TEST_MODE:'consume',TEST_DEADLINE:'55000'};
const entry=new URL('../src/supabase-inference.ts',import.meta.url).pathname;
let bundled;
async function bundle(){
  bundled??=build({stdin:{resolveDir:new URL('..',import.meta.url).pathname,contents:`
    import {serveSupabaseInference,containerEnvironment,selectSupabaseContainer} from ${JSON.stringify(entry)};
    export {SupabaseInferenceContainer} from ${JSON.stringify(entry)};
    const state={calls:0,aborted:false,replyCancelled:false,lateCancelled:false};
    const json=value=>Response.json(value);
    const bytes=length=>{let remaining=length;return new ReadableStream({pull(output){if(!remaining){output.close();return;}const size=Math.min(65536,remaining);remaining-=size;output.enqueue(new Uint8Array(size));},cancel(){state.replyCancelled=true;}});};
    export default {async fetch(request,env,ctx){
      const path=new URL(request.url).pathname;
      if(path==='/_fixture/state')return json(state);
      if(path==='/_fixture/environment'){
        try{const values=containerEnvironment(env),{ML_INFERENCE_SECRET,...safe}=values;return json({safe,secretMatches:ML_INFERENCE_SECRET===env.ML_INFERENCE_SECRET});}
        catch{return json({denied:true});}
      }
      if(path==='/_fixture/selection'){
        const calls=[];selectSupabaseContainer({ML_SUPABASE_CONTAINER:{jurisdiction(value){calls.push(['jurisdiction',value]);return {idFromName(name){calls.push(['name',name]);return 'fixture-id';},get(id,options){calls.push(['get',id,options]);return {fetch(){throw new Error('not called');}};}};}}});return json(calls);
      }
      let selected=request;
      // Mutate only inside this workerd fixture so an intentionally oversized
      // declaration is evaluated by production admission, not rejected by the
      // Node HTTP client for disagreeing with its two-byte transport fixture.
      if(env.TEST_CLAIMED_LENGTH){const headers=new Headers(selected.headers);headers.set('content-length',env.TEST_CLAIMED_LENGTH);selected=new Request(selected,{headers});}
      if(env.TEST_CANCEL_AFTER){const controller=new AbortController();request.signal.addEventListener('abort',()=>controller.abort(),{once:true});setTimeout(()=>controller.abort(),Number(env.TEST_CANCEL_AFTER));selected=new Request(selected,{signal:controller.signal});}
      const fixtureService=()=>({async fetch(upstream){
        state.calls++;upstream.signal.addEventListener('abort',()=>{state.aborted=true;});
        if(env.TEST_MODE==='stallHeaders')return new Promise(()=>{});
        if(env.TEST_MODE==='lateHeaders')return new Promise(resolve=>setTimeout(()=>resolve(new Response(new ReadableStream({cancel(){state.lateCancelled=true;}}),{headers:{'content-type':'application/json'}})),60));
        if(env.TEST_MODE==='redirect')return new Response(null,{status:307,headers:{location:'https://untrusted.invalid'}});
        if(env.TEST_MODE==='declaredOversize')return new Response('{}',{headers:{'content-type':'application/json','content-length':String(6*1024*1024+1)}});
        if(env.TEST_MODE==='wrongReplyLength')return new Response('{}',{headers:{'content-type':'application/json','content-length':'3'}});
        if(env.TEST_MODE==='streamOversize')return new Response(bytes(6*1024*1024+1),{headers:{'content-type':'application/json'}});
        if(env.TEST_MODE==='stallBody')return new Response(new ReadableStream({cancel(){state.replyCancelled=true;}}),{headers:{'content-type':'application/json'}});
        if(env.TEST_MODE==='wrongType')return new Response('not json',{headers:{'content-type':'text/plain'}});
        let length=0;if(upstream.body){const reader=upstream.body.getReader();for(;;){const next=await reader.read();if(next.done)break;length+=next.value.byteLength;}}
        return new Response(JSON.stringify({length,path:new URL(upstream.url).pathname,redirect:upstream.redirect,
          secretMatches:upstream.headers.get('authorization')==='Bearer '+env.ML_INFERENCE_SECRET,
          leakedHeaders:['cookie','x-client-name','x-supabase-key'].filter(name=>upstream.headers.has(name))}),
          {status:env.TEST_MODE==='negative'?409:200,headers:{'content-type':'application/json','set-cookie':'must-not-escape','location':'https://must-not-escape.invalid'}});
      }});
      const proxied=await serveSupabaseInference(selected,env,env.TEST_MODE==='missingBinding'?selectSupabaseContainer:fixtureService,
        Number(env.TEST_DEADLINE),true,task=>ctx.waitUntil(task));
      // Inspect the production response stream before Miniflare translates its
      // failure into HTTP framing. Count only: no extra reply buffer is kept.
      if(env.TEST_INSPECT_BODY){let received=0;const reader=proxied.body.getReader();
        try{for(;;){const next=await reader.read();if(next.done)break;received+=next.value.byteLength;}return json({proxyStatus:proxied.status,completed:true,received});}
        catch(error){return json({proxyStatus:proxied.status,completed:false,received,failure:error.message});}
        finally{reader.releaseLock();}
      }
      return proxied;
    }};
  `},write:false,bundle:true,format:'esm',platform:'browser',target:'es2022',
    external:['cloudflare:workers',...builtinModules.flatMap(name=>[name,'node:'+name])],logLevel:'silent'});
  return (await bundled).outputFiles[0].text;
}
async function harness(t,bindings={}){
  const mf=new Miniflare({modules:true,compatibilityDate:'2026-07-21',compatibilityFlags:['nodejs_compat'],script:await bundle(),bindings:{...defaults,...bindings}});
  await mf.ready;t.after(()=>mf.dispose());
  const raw=(path,init={})=>mf.dispatchFetch('https://proxy.invalid'+path,init);
  const send=(path,init={})=>raw(path,{...init,headers:{authorization:'Bearer '+secret,'content-type':'application/json',...(init.headers??{})}});
  return {raw,send,state:async()=>(await raw('/_fixture/state')).json()};
}
function bytes(length){let remaining=length;return new ReadableStream({pull(output){if(!remaining){output.close();return;}const size=Math.min(65536,remaining);remaining-=size;output.enqueue(new Uint8Array(size));}});}
async function assertFailedStream(h){
  const report=await(await h.send('/ready')).json();
  assert.equal(report.completed,false,'the actual Worker response stream must fail before completion');
  assert(report.received<=6*1024*1024,'a stream failure cannot send more than the reply cap');
  const state=await h.state();assert.equal(state.calls,1);assert.equal(state.aborted,true);assert.equal(state.replyCancelled,true);
}

test('Supabase host selects one immutable image without duplicate release switches or receipt claims',async()=>{
  const text=await readFile(new URL('../wrangler.supabase.jsonc',import.meta.url),'utf8');
  const config=JSON.parse(text.replace(/^\s*\/\/.*$/gm,''));
  assert.equal(config.main,'src/supabase-inference.ts');assert.equal(config.account_id,'2209b915a85b1c11cee79b7806c6e73b');
  assert(!Object.hasOwn(config,'vars'));
  assert.equal(config.workers_dev,true);assert.equal(config.preview_urls,false);assert.equal(config.observability.enabled,false);
  assert.equal(config.observability.logs.invocation_logs,false);assert.equal(config.observability.logs.persist,false);
  assert(!Object.hasOwn(config,'r2_buckets'));assert(!Object.hasOwn(config,'services'));
  assert.equal(config.containers.length,1);assert.equal(config.containers[0].max_instances,1);
  assert.equal(config.containers[0].image,'registry.cloudflare.com/2209b915a85b1c11cee79b7806c6e73b/lovelies-inference-native@sha256:d815c57f43cb4f1e26d624e68d8b5f43db5a76723e1c1de8d88a341273b68ffe');
  assert.deepEqual(config.containers[0].constraints,{jurisdiction:'eu',regions:['WEUR']});
  assert.deepEqual(config.containers[0].instance_type,{vcpu:1,memory_mib:3072,disk_mb:8000});
});

test('service authorization precedes body/container access and retired release fields grant no authority',async t=>{
  const h=await harness(t,{INFERENCE_SERVING_ENABLED:'true',INFERENCE_RELEASE_RECEIPT_SHA256:'c'.repeat(64),INFERENCE_IMAGE_URI:image});
  for(const authorization of [undefined,'Bearer wrong',`Bearer ${secret}, Bearer ${secret}`]){
    const response=await h.raw('/internal/photo',{method:'POST',headers:{...(authorization?{authorization}:{}),'content-type':'application/json'},body:'private fixture bytes'});
    assert.equal(response.status,401);assert.deepEqual(await response.json(),{error:{code:'service_authentication_required'}});
  }
  assert.equal((await h.state()).calls,0);
  for(const bindings of [{ML_INFERENCE_SECRET:''},{ML_INFERENCE_SECRET:'short'},{TEST_MODE:'missingBinding'}]){
    const denied=await harness(t,bindings);assert.equal((await denied.send('/ready')).status,503);assert.equal((await denied.state()).calls,0);
  }
  const withoutFlags=await harness(t);
  assert.equal((await withoutFlags.send('/ready')).status,200);
  const retiredFlags=await harness(t,{INFERENCE_SERVING_ENABLED:'false',INFERENCE_RELEASE_RECEIPT_SHA256:'',INFERENCE_IMAGE_URI:'invalid'});
  assert.equal((await retiredFlags.send('/ready')).status,200);
});

test('only the three selected routes are available and private requests carry only the independent secret',async t=>{
  const h=await harness(t);
  for(const [path,method] of [['/internal/face','GET'],['/ready','POST'],['/internal/photo','PUT'],['/internal/photo?target=https://elsewhere.invalid','POST'],['/auth/anonymous','POST'],['/faces','GET']]){
    assert.equal((await h.send(path,{method,...(method!=='GET'?{body:'{}'}:{})})).status,404);
  }
  const response=await h.send('/internal/face',{method:'POST',headers:{cookie:'must-not-forward','x-client-name':'must-not-forward','x-supabase-key':'must-not-forward'},body:'{"opaque":"still-protocol-bytes"}'});
  assert.equal(response.status,200);const result=await response.json();assert.equal(result.length,33);assert.equal(result.path,'/internal/face');
  assert.equal(result.redirect,'manual');assert.equal(result.secretMatches,true);assert.deepEqual(result.leakedHeaders,[]);
  assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('set-cookie'),null);assert.equal(response.headers.get('location'),null);
  assert.equal((await h.send('/ready')).status,200);
});

test('12 MiB face and 40 MiB photo streams pass; their next byte is denied without a fabricated verdict',async t=>{
  const h=await harness(t);
  for(const [path,limit] of [['/internal/face',12*1024*1024],['/internal/photo',40*1024*1024]]){
    const accepted=await h.send(path,{method:'POST',body:bytes(limit),duplex:'half'});
    assert.equal(accepted.status,200);assert.equal((await accepted.json()).length,limit);
    const denied=await h.send(path,{method:'POST',body:bytes(limit+1),duplex:'half'});
    assert.equal(denied.status,413);assert.deepEqual(await denied.json(),{error:{code:'inference_body_too_large'}});
    const declared=await harness(t,{TEST_CLAIMED_LENGTH:String(limit+1)});
    const claimed=await declared.send(path,{method:'POST',body:'{}'});
    assert.equal(claimed.status,413);assert.equal((await declared.state()).calls,0);
  }
});

test('redirects and invalid/oversized declared replies cannot escape the service boundary',async t=>{
  for(const mode of ['redirect','wrongType','declaredOversize']){
    const h=await harness(t,{TEST_MODE:mode});const response=await h.send('/ready');assert.equal(response.status,503);
    assert.equal(response.headers.get('location'),null);assert.equal((await h.state()).calls,1);
  }
  const h=await harness(t,{TEST_MODE:'streamOversize',TEST_INSPECT_BODY:'true'});
  await assertFailedStream(h);
  const mismatch=await harness(t,{TEST_MODE:'wrongReplyLength',TEST_INSPECT_BODY:'true'});
  const report=await(await mismatch.send('/ready')).json();assert.equal(report.completed,false);assert.equal(report.failure,'inference_result_invalid');
  assert.equal((await mismatch.state()).aborted,true);
});

test('one deadline covers headers and response consumption; late responses are cancelled without replay',async t=>{
  for(const mode of ['stallHeaders','stallBody']){
    const h=await harness(t,{TEST_MODE:mode,TEST_DEADLINE:'20',...(mode==='stallBody'?{TEST_INSPECT_BODY:'true'}:{})});
    if(mode==='stallHeaders'){
      const response=await h.send('/ready');assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:{code:'inference_timeout'}});
    }else await assertFailedStream(h);
    const state=await h.state();assert.equal(state.calls,1);assert.equal(state.aborted,true);
    if(mode==='stallBody')assert.equal(state.replyCancelled,true);
  }
  const h=await harness(t,{TEST_MODE:'lateHeaders',TEST_DEADLINE:'10'});
  assert.equal((await h.send('/ready')).status,503);
  for(let attempt=0;attempt<30&&!((await h.state()).lateCancelled);attempt++)await new Promise(resolve=>setTimeout(resolve,10));
  const state=await h.state();assert.equal(state.calls,1);assert.equal(state.lateCancelled,true);
});

test('caller cancellation aborts the original container request without starting another operation',async t=>{
  const h=await harness(t,{TEST_MODE:'stallHeaders',TEST_DEADLINE:'1000',TEST_CANCEL_AFTER:'20'});
  const response=await h.send('/ready');assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{error:{code:'inference_cancelled'}});
  const state=await h.state();assert.equal(state.calls,1);assert.equal(state.aborted,true);
});

test('container environment has no application credentials and namespace selection binds the EU singleton',async t=>{
  const h=await harness(t,{SUPABASE_SERVICE_ROLE_KEY:'synthetic-must-not-enter-container',AUTH_SIGNING_SECRET:'synthetic-must-not-enter-container'});
  const variables=await(await h.raw('/_fixture/environment')).json();
  assert.equal(variables.secretMatches,true);assert.deepEqual(variables.safe,{APP_ENV:'production',ML_DEPLOYMENT_MODE:'monitored_pilot',
    ML_REQUIRE_MODEL_ARTIFACTS:'true',ML_USE_DETERMINISTIC_SIMULATOR:'false',ML_DEPLOYMENT_TRANSPORT:'https_service'});
  assert.deepEqual(await(await h.raw('/_fixture/selection')).json(),[['jurisdiction','eu'],['name','supabase-inference-v1'],['get','fixture-id',{locationHint:'weur'}]]);
});
