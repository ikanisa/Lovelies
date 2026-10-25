import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';
import {builtinModules} from 'node:module';
import {createHash} from 'node:crypto';
import {Miniflare} from 'miniflare';

test('temporary builder admits only authenticated fixed operations in its selected EU namespace',async t=>{
  const secret='a'.repeat(64);
  const source=new URL('../src/native-build.ts',import.meta.url).pathname;
  const bundled=await build({stdin:{resolveDir:new URL('..',import.meta.url).pathname,contents:`
    import controller,{NativeBuildContainer} from ${JSON.stringify(source)};
    const calls=[],inputCalls=[];
    export default {fetch(request,env,ctx){
      if(new URL(request.url).pathname==='/fixture-state')return Response.json(calls);
      if(new URL(request.url).pathname==='/fixture-input-state')return Response.json(inputCalls);
      if(new URL(request.url).pathname==='/fixture-activity')return (async()=>{
        // Execute our real lifecycle methods and the installed SDK's real
        // renewActivityTimeout, with the already-running start fast path.
        const instance=Object.create(NativeBuildContainer.prototype);
        instance.sleepAfter='15m';instance.sleepAfterMs=0;
        instance.start=async()=>{};instance.getState=async()=>({running:true});
        await instance.begin();const startRenewed=instance.sleepAfterMs>Date.now()+14*60*1000;
        instance.sleepAfterMs=0;await instance.inspect();
        return Response.json({startRenewed,stateRenewed:instance.sleepAfterMs>Date.now()+14*60*1000});
      })();
      const objects=JSON.parse(env.FIXTURE_INPUT_OBJECTS||'{}');
      return controller.fetch(request,{...env,
        BUILD_INPUT_MANIFEST:request.headers.get('x-fixture-manifest')??env.BUILD_INPUT_MANIFEST,
        BUILD_INPUTS:env.FIXTURE_INPUTS==='true'?{async get(key){
          inputCalls.push(['get',key]);const value=objects[key];if(!value)return null;
          if(value.fail)throw new Error('synthetic-input-read-failure');
          let offset=0;
          return {size:value.size,body:new ReadableStream({pull(output){
            if(offset===value.bytes.length){output.close();return;}
            const end=Math.min(offset+3,value.bytes.length);output.enqueue(new Uint8Array(value.bytes.slice(offset,end)));offset=end;
          },cancel(){inputCalls.push(['cancel',key]);}})};
        }}:undefined,
        NATIVE_BUILD:{jurisdiction(value){calls.push(['jurisdiction',value]);
        return {idFromName(name){calls.push(['name',name]);return 'test-only';},get(id,options){calls.push(['get',id,options]);
          return {async begin(){calls.push(['begin']);return 'started';},async inspect(){calls.push(['inspect']);return 'running';},async end(){calls.push(['end']);return 'stopped';}};}};}}},ctx);
    }};
  `},write:false,bundle:true,format:'esm',platform:'browser',target:'es2022',logLevel:'silent',
    external:['cloudflare:workers',...builtinModules.flatMap(name=>[name,'node:'+name])]});
  async function harness(expiry,options={}){
    const mf=new Miniflare({modules:true,compatibilityDate:'2026-07-21',compatibilityFlags:['nodejs_compat'],
      script:bundled.outputFiles[0].text,bindings:{BUILD_CONTROL_SECRET:secret,BUILD_EXPIRES_AT:expiry,
        ...options.manifest===undefined?{}:{BUILD_INPUT_MANIFEST:options.manifest},
        FIXTURE_INPUTS:options.inputs?'true':'false',FIXTURE_INPUT_OBJECTS:JSON.stringify(options.objects??{})}});
    await mf.ready;t.after(()=>mf.dispose());return mf;
  }
  const current=await harness(new Date(Date.now()+60_000).toISOString());
  const call=(mf,path,method='GET',headers={})=>mf.dispatchFetch('https://builder.invalid'+path,{method,headers:{...(method==='POST'?{'content-length':'0'}:{}),...headers}});
  assert.equal((await call(current,'/start','POST')).status,401);
  assert.equal((await call(current,'/start','POST',{authorization:'Bearer wrong'})).status,401);
  assert.deepEqual(await(await call(current,'/fixture-state')).json(),[]);
  const headers={authorization:'Bearer '+secret};
  assert.deepEqual(await(await call(current,'/fixture-activity')).json(),{startRenewed:true,stateRenewed:true});
  for(const [path,method] of [['/shell','POST'],['/start?command=whoami','POST'],['/start','GET'],['/state','POST']])
    assert.equal((await call(current,path,method,headers)).status,404);
  assert.equal((await call(current,'/start','POST',headers)).status,200);
  assert.deepEqual(await(await call(current,'/fixture-state')).json(),[
    ['jurisdiction','eu'],['name','lovelies-native-build-20261024'],['get','test-only',{locationHint:'weur'}],['begin']]);
  const expired=await harness(new Date(Date.now()-1000).toISOString());
  assert.equal((await call(expired,'/start','POST',headers)).status,410);
  assert.equal((await call(expired,'/state','GET',headers)).status,410);
  assert.deepEqual(await(await call(expired,'/fixture-state')).json(),[]);
  assert.equal((await call(expired,'/stop','POST',headers)).status,200);
  assert.deepEqual((await(await call(expired,'/fixture-state')).json()).at(-1),['end']);

  const bytes=[0,255,17,128,42,0,66,240,159,147,183],digest=createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
  const missing='2'.repeat(64),wrongSize='3'.repeat(64),failed='4'.repeat(64);
  const manifest=JSON.stringify([{sha256:digest,bytes:bytes.length},{sha256:missing,bytes:1},
    {sha256:wrongSize,bytes:bytes.length+1},{sha256:failed,bytes:1}]);
  const inputs=await harness(new Date(Date.now()+60_000).toISOString(),{inputs:true,manifest,objects:{
    [digest]:{size:bytes.length,bytes},[wrongSize]:{size:bytes.length,bytes},[failed]:{fail:true}}});
  const inputPath='/input/'+digest;
  for(const badHeaders of [{},{authorization:'Bearer wrong'},{authorization:'x'.repeat(513)}])
    assert.equal((await call(inputs,inputPath,'GET',badHeaders)).status,401);
  assert.deepEqual(await(await call(inputs,'/fixture-input-state')).json(),[]);
  assert.deepEqual(await(await call(inputs,'/fixture-state')).json(),[]);
  for(const [path,method] of [[inputPath+'?target=elsewhere','GET'],[inputPath+'/', 'GET'],
    ['/input/'+digest.toUpperCase(),'GET'],['/input/source.zip','GET'],[inputPath,'POST'],[inputPath,'HEAD']])
    assert.equal((await call(inputs,path,method,headers)).status,404);
  const withBody=await inputs.dispatchFetch('https://builder.invalid'+inputPath,{method:'POST',headers,body:'opaque-body'});
  assert.equal(withBody.status,404);
  assert.deepEqual(await(await call(inputs,'/fixture-input-state')).json(),[]);
  assert.equal((await call(inputs,'/input/'+'f'.repeat(64),'GET',headers)).status,404);
  assert.deepEqual(await(await call(inputs,'/fixture-input-state')).json(),[],'unknown digests never access R2');

  const output=await call(inputs,inputPath,'GET',headers);
  assert.equal(output.status,200);assert.equal(output.headers.get('content-type'),'application/octet-stream');
  assert.equal(output.headers.get('content-length'),String(bytes.length));assert.equal(output.headers.get('cache-control'),'no-store');
  assert.equal(output.headers.get('x-content-type-options'),'nosniff');
  assert.deepEqual([...new Uint8Array(await output.arrayBuffer())],bytes,'opaque stream preserves every byte');
  assert.deepEqual(await(await call(inputs,'/fixture-input-state')).json(),[['get',digest]]);
  assert.deepEqual(await(await call(inputs,'/fixture-state')).json(),[],'input delivery never obtains a Container or Durable Object');
  assert.equal((await call(inputs,'/input/'+missing,'GET',headers)).status,404);
  assert.equal((await call(inputs,'/input/'+failed,'GET',headers)).status,503);
  assert.equal((await call(inputs,'/input/'+wrongSize,'GET',headers)).status,503);
  assert.deepEqual((await(await call(inputs,'/fixture-input-state')).json()).slice(-2),[['get',wrongSize],['cancel',wrongSize]]);

  const valid={sha256:digest,bytes:bytes.length},tooMany=Array.from({length:9},(_,i)=>({sha256:String(i).repeat(64),bytes:1}));
  const invalidManifests=['not-json',JSON.stringify({inputs:[valid]}),'x'.repeat(4097),JSON.stringify(tooMany),
    ...[[valid,valid],[{...valid,extra:'not-allowed'}],[{sha256:digest}],[{...valid,sha256:digest.toUpperCase()}],
      ...[0,-1,1.5,314572801,'11',null].map(size=>[{...valid,bytes:size}])].map(value=>JSON.stringify(value))];
  const before=await(await call(inputs,'/fixture-input-state')).json();
  for(const damaged of invalidManifests){
    const denied=await call(inputs,inputPath,'GET',{...headers,'x-fixture-manifest':damaged});
    assert.equal(denied.status,503);assert.equal((await denied.json()).code,'build_input_configuration_required');
  }
  assert.deepEqual(await(await call(inputs,'/fixture-input-state')).json(),before,'damaged manifests never access R2');
  const atLimit=JSON.stringify([valid,...Array.from({length:7},(_,i)=>({sha256:String(i).repeat(64),bytes:314572800}))]);
  const atLimitOutput=await call(inputs,inputPath,'GET',{...headers,'x-fixture-manifest':atLimit});
  assert.equal(atLimitOutput.status,200);assert.deepEqual([...new Uint8Array(await atLimitOutput.arrayBuffer())],bytes);
  assert.deepEqual(await(await call(inputs,'/fixture-state')).json(),[]);

  for(const expiry of [new Date(Date.now()-1000).toISOString(),'not-a-date']){
    const unavailable=await harness(expiry,{inputs:true,manifest,objects:{[digest]:{size:bytes.length,bytes}}});
    assert.equal((await call(unavailable,inputPath,'GET',headers)).status,410);
    assert.deepEqual(await(await call(unavailable,'/fixture-input-state')).json(),[]);
    assert.deepEqual(await(await call(unavailable,'/fixture-state')).json(),[]);
  }
  for(const options of [{inputs:true},{manifest}]){
    const unavailable=await harness(new Date(Date.now()+60_000).toISOString(),options);
    assert.equal((await call(unavailable,inputPath,'GET',headers)).status,503);
    assert.deepEqual(await(await call(unavailable,'/fixture-input-state')).json(),[]);
    assert.deepEqual(await(await call(unavailable,'/fixture-state')).json(),[]);
  }
});

test('technical artifacts use fixed streaming manifests and R2 integrity checks without Container authority',async t=>{
  const secret='b'.repeat(64),bytes=new Uint8Array([0,255,17,128,42,0,66,240,159,147,183]);
  const digest=createHash('sha256').update(bytes).digest('hex'),path='/artifact/'+digest;
  const source=new URL('../src/native-build.ts',import.meta.url).pathname;
  const bundled=await build({stdin:{resolveDir:new URL('..',import.meta.url).pathname,contents:`
    import controller from ${JSON.stringify(source)};
    const calls=[];
    export default {async fetch(original,env,ctx){
      if(new URL(original.url).pathname==='/fixture-state')return Response.json(calls);
      const headers=new Headers(original.headers);
      const bodyKind=headers.get('x-fixture-body');let request=original;
      if(bodyKind||headers.has('x-fixture-length')){
        let body=original.body;
        if(bodyKind){body=new ReadableStream({start(output){output.enqueue(new Uint8Array(bodyKind==='short'?2:32));output.close();}});}
        request=new Request(original,{headers,body});
        // workerd may derive Content-Length from a known-size body again after
        // an async native call. This header-only unit seam deliberately exposes
        // the exact malformed text even across awaits; body/signal stay real.
        // Ordinary upload and actual R2 checksum tests below use a real Request.
        // JSON encoding keeps the empty-header case distinct from an omitted
        // fixture-control header at the outer HTTP transport.
        const length=headers.has('x-fixture-length')?JSON.parse(headers.get('x-fixture-length')):original.headers.get('content-length');
        const view=new Headers(headers);
        if(length!==null)view.set('content-length',length);else view.delete('content-length');
        const target=request;
        request=new Proxy(target,{get(object,key){
          if(key==='headers')return view;
          const value=Reflect.get(object,key,object);return typeof value==='function'?value.bind(object):value;
        }});
        await Promise.resolve();
        if(request.headers.get('content-length')!==length)throw new Error('fixture_length_header_was_normalized');
      }
      const bucket={
        async put(key,body,options){
          calls.push(['put',key,body instanceof ReadableStream,options]);
          if(headers.get('x-fixture-put-failure')==='true')throw new Error('synthetic-secret-must-not-escape');
          return env.FIXTURE_ARTIFACT_BUCKET.put(key,body,options);
        },
        async get(key){
          calls.push(['get',key]);const object=await env.FIXTURE_ARTIFACT_BUCKET.get(key);
          if(!object)return null;
          if(headers.get('x-fixture-get-damaged')==='true')return {size:object.size,body:object.body,checksums:{sha256:new Uint8Array(32).buffer}};
          return object;
        }
      };
      return controller.fetch(request,{...env,
        BUILD_ARTIFACT_MANIFEST:headers.get('x-fixture-manifest')??env.BUILD_ARTIFACT_MANIFEST,
        BUILD_ARTIFACTS:env.FIXTURE_NO_BUCKET==='true'?undefined:bucket,
        NATIVE_BUILD:{jurisdiction(){calls.push(['DO_ACCESS']);throw new Error('artifact must not access Container authority');}}
      },ctx);
    }};
  `},write:false,bundle:true,format:'esm',platform:'browser',target:'es2022',logLevel:'silent',
    external:['cloudflare:workers',...builtinModules.flatMap(name=>[name,'node:'+name])]});
  const manifest=JSON.stringify([{sha256:digest,bytes:bytes.length}]);
  async function harness(overrides={}){
    const mf=new Miniflare({modules:true,compatibilityDate:'2026-07-21',compatibilityFlags:['nodejs_compat'],
      script:bundled.outputFiles[0].text,r2Buckets:['FIXTURE_ARTIFACT_BUCKET'],bindings:{BUILD_CONTROL_SECRET:secret,
        BUILD_EXPIRES_AT:new Date(Date.now()+60_000).toISOString(),BUILD_ARTIFACT_MANIFEST:manifest,...overrides}});
    await mf.ready;t.after(()=>mf.dispose());return mf;
  }
  const mf=await harness(),auth={authorization:'Bearer '+secret};
  const get=(target=path,headers=auth)=>mf.dispatchFetch('https://builder.invalid'+target,{headers});
  const put=(target=path,value=bytes,headers={})=>mf.dispatchFetch('https://builder.invalid'+target,{method:'PUT',
    headers:{...auth,'content-type':'application/octet-stream','content-length':String(value.length),...headers},body:value});
  const calls=async()=>await(await get('/fixture-state')).json();
  const bucket=await mf.getR2Bucket('FIXTURE_ARTIFACT_BUCKET');
  for(const method of ['GET','PUT']){
    for(const header of [{},{authorization:'Bearer wrong'}]){
      const denied=await mf.dispatchFetch('https://builder.invalid'+path,{method,headers:header});
      assert.equal(denied.status,401);
    }
  }
  assert.deepEqual(await calls(),[]);
  for(const target of [path+'?target=other',path+'/', '/artifact/'+digest.toUpperCase(),'/artifact/source.tar'])
    assert.equal((await put(target)).status,404);
  for(const method of ['POST','DELETE','HEAD'])
    assert.equal((await mf.dispatchFetch('https://builder.invalid'+path,{method,headers:auth})).status,404);
  assert.equal((await mf.dispatchFetch('http://builder.invalid'+path,{headers:auth})).status,404);
  assert.equal((await put('/artifact/'+'f'.repeat(64))).status,404);
  assert.deepEqual(await calls(),[],'route/auth/unknown-digest denials never reach R2');
  assert.equal((await get()).status,404,'admitted artifact does not exist before PUT');

  for(const type of ['image/jpeg','application/octet-stream; charset=utf-8',''])
    assert.equal((await put(path,bytes,{'content-type':type})).status,415);
  for(const length of ['','011','+11','12','0'])
    assert.equal((await put(path,bytes,{'x-fixture-length':JSON.stringify(length)})).status,400,'reject actual malformed header '+JSON.stringify(length));
  assert.equal((await bucket.get(digest)),null);

  const wrong=Uint8Array.from(bytes,byte=>byte^1);
  const rejected=await put(path,wrong);
  assert.equal(rejected.status,503);assert.deepEqual(await rejected.json(),{code:'build_artifact_unavailable'});
  assert.equal(await bucket.get(digest),null,'actual local R2 rejects SHA-256 mismatch without publishing an object');
  assert.deepEqual(await calls(),[['get',digest],['put',digest,true,{sha256:digest,
    httpMetadata:{contentType:'application/octet-stream',cacheControl:'no-store'}}]]);

  for(let retry=0;retry<2;retry++){
    const stored=await put();assert.equal(stored.status,200);assert.deepEqual(await stored.json(),{code:'build_artifact_stored'});
    const output=await get();assert.equal(output.status,200);
    assert.equal(output.headers.get('content-type'),'application/octet-stream');assert.equal(output.headers.get('content-length'),String(bytes.length));
    assert.equal(output.headers.get('cache-control'),'no-store');assert.equal(output.headers.get('x-content-type-options'),'nosniff');
    assert.deepEqual(new Uint8Array(await output.arrayBuffer()),bytes);
  }
  const actual=await bucket.get(digest);
  assert.equal(actual.size,bytes.length);assert.equal(Buffer.from(actual.checksums.sha256).toString('hex'),digest);
  assert.equal(actual.httpMetadata.cacheControl,'no-store');await actual.body.cancel();
  assert.equal((await put(path,wrong)).status,503);
  assert.deepEqual(new Uint8Array(await(await get()).arrayBuffer()),bytes,'failed replacement preserves the committed object');
  for(const kind of ['short','long']){
    const denied=await put(path,bytes,{'x-fixture-body':kind});
    assert.equal(denied.status,503);assert.deepEqual(await denied.json(),{code:'build_artifact_unavailable'});
  }
  const failure=await put(path,bytes,{'x-fixture-put-failure':'true'});
  assert.equal(failure.status,503);assert.deepEqual(await failure.json(),{code:'build_artifact_unavailable'});
  assert.equal((await get(path,{...auth,'x-fixture-get-damaged':'true'})).status,503);

  const valid={sha256:digest,bytes:bytes.length};
  const invalid=['not-json',JSON.stringify({objects:[valid]}),'x'.repeat(8193),
    ...[[valid,valid],[{...valid,extra:true}],[{sha256:digest}],...['11',0,-1,1.5,67108865].map(value=>[{...valid,bytes:value}]),
      Array.from({length:33},(_,index)=>({sha256:index.toString(16).padStart(64,'0'),bytes:1}))].map(value=>JSON.stringify(value))];
  const before=await calls();
  for(const damaged of invalid){
    const denied=await get(path,{...auth,'x-fixture-manifest':damaged});
    assert.equal(denied.status,503);assert.deepEqual(await denied.json(),{code:'build_artifact_configuration_required'});
  }
  assert.deepEqual(await calls(),before,'damaged artifact manifests never reach R2');
  const atLimit=[valid,...Array.from({length:31},(_,index)=>({sha256:index.toString(16).padStart(64,'0'),bytes:67108864}))];
  const output=await get(path,{...auth,'x-fixture-manifest':JSON.stringify(atLimit)});
  assert.equal(output.status,200);assert.deepEqual(new Uint8Array(await output.arrayBuffer()),bytes);
  atLimit[0].bytes=67108864;
  const exactTotal=await get(path,{...auth,'x-fixture-manifest':JSON.stringify(atLimit)});
  assert.equal(exactTotal.status,503);assert.deepEqual(await exactTotal.json(),{code:'build_artifact_unavailable'},'exact2GiB manifest passes admission but wrong stored size is denied');
  assert(!(await calls()).some(row=>row[0]==='DO_ACCESS'));

  for(const overrides of [{BUILD_EXPIRES_AT:new Date(Date.now()-1000).toISOString()},
    {BUILD_EXPIRES_AT:'invalid'},{BUILD_ARTIFACT_MANIFEST:''},{FIXTURE_NO_BUCKET:'true'}]){
    const closed=await harness(overrides);
    for(const method of ['GET','PUT']){
      const denied=await closed.dispatchFetch('https://builder.invalid'+path,{method,
        headers:{...auth,...(method==='PUT'?{'content-type':'application/octet-stream','content-length':String(bytes.length)}:{})},
        ...(method==='PUT'?{body:bytes}:{})});
      assert.equal(denied.status,overrides.BUILD_EXPIRES_AT?410:503);
    }
    assert.deepEqual(await(await closed.dispatchFetch('https://builder.invalid/fixture-state')).json(),[]);
  }
});
