import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {env,envelope,bootstrapID} from './independent-ledger-fixture.mjs';
import {RemoteRosterLedger} from '../src/remote-roster.mjs';
import {sha256,canonical,PUSH_PLAN_PROTOCOL,PUSH_DISPATCH_PROTOCOL} from '../src/push-plan.mjs';
import {requestHash} from '../src/gateway.mjs';

const require=createRequire(new URL('../package.json',import.meta.url));
const {Miniflare}=require('miniflare'),{build}=require('esbuild');

test('real Worker/SQLite v2 plan admission is atomic, survives restart and refuses lost binding reset',{timeout:90000},async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'lovelies-push-roster-'));
  // Test-only local fault controls and EU selector adapter are generated here;
  // neither exists in production source, private routes or deployment config.
  const bundle=await build({stdin:{contents:`
    import production,{PushDispatchLedger} from './src/ledger-worker.mjs';
    export class FixturePushLedger extends PushDispatchLedger {
      constructor(ctx,env){
        const fault={enabled:false};
        const storage={sql:ctx.storage.sql,transaction(callback){return ctx.storage.transaction(async txn=>callback({
          get:(...args)=>txn.get(...args),list:(...args)=>txn.list(...args),
          put:async values=>{await txn.put(values);if(fault.enabled)throw new Error('synthetic v2 SQL/KV commit fault');}
        }));}};
        super({storage},env);this.original=ctx.storage;this.fault=fault;
      }
      async fetch(request){
        if(request.headers.get('x-fixture-drop-binding')==='1')await this.original.delete('push-roster-binding:v2');
        this.fault.enabled=request.headers.get('x-fixture-put-fault')==='1';
        try{return await super.fetch(request);}finally{this.fault.enabled=false;}
      }
    }
    export default {fetch(request,env){return production.fetch(request,{...env,PUSH_DISPATCH_LEDGER:{jurisdiction(region){
      if(region!=='eu')throw new Error('wrong jurisdiction');return env.PUSH_DISPATCH_LEDGER;
    }}});}};
  `,resolveDir:new URL('../',import.meta.url).pathname,sourcefile:'local-roster-fault-fixture.mjs'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});
  const options={name:'lovelies-push-roster-qualification',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-21',
    durableObjects:{PUSH_DISPATCH_LEDGER:{className:'FixturePushLedger',useSQLite:true}},durableObjectsPersist:directory,bindings:env};
  let mf;const boot=randomUUID(),generation='a'.repeat(64),body=fields=>({version:2,project_id:env.SUPABASE_PROJECT_ID,ledger_id:env.PUSH_LEDGER_ID,...fields});
  const open=async()=>{mf=new Miniflare(options);await mf.ready;},restart=async()=>{await mf.dispose();mf=undefined;await open();};
  const send=async(pathname,value,status=200,headers={})=>{
    const reply=await mf.dispatchFetch('https://ledger.invalid'+pathname,{method:value===undefined?'GET':'POST',headers:{
      authorization:'Bearer '+env.PUSH_LEDGER_TOKEN,...value===undefined?{}:{'content-type':'application/json'},...headers},...value===undefined?{}:{body:JSON.stringify(value)}});
    const result=await reply.json();assert.equal(reply.status,status,JSON.stringify(result));return result;
  };
  const remote=()=>new RemoteRosterLedger('https://ledger.invalid',env.PUSH_LEDGER_TOKEN,{ledgerID:env.PUSH_LEDGER_ID,bootstrapID:boot,fetcher:(url,init)=>mf.dispatchFetch(url,init)});
  try{
    await open();await send('/v1/bootstrap',envelope({bootstrap_id:bootstrapID}),200,{authorization:'Bearer '+env.PUSH_LEDGER_BOOTSTRAP_TOKEN});
    await send('/v2/bootstrap',body({bootstrap_id:boot,provider_generation:generation}),401);
    await send('/v2/bootstrap',body({bootstrap_id:boot,provider_generation:generation}),200,{authorization:'Bearer '+env.PUSH_LEDGER_BOOTSTRAP_TOKEN});
    const note=randomUUID(),device=randomUUID(),subject=await sha256(randomUUID());
    const input={protocol:PUSH_DISPATCH_PROTOCOL,subject_sha256:subject,provider_generation:generation,operation_key:'notification:'+note+':'+device,
      platform:'android',token:'synthetic-runtime-v2-private-device-token',notification:{id:note,title:'Your support request was reviewed',kind:'support',entity_id:randomUUID()}};
    const plan={protocol:PUSH_PLAN_PROTOCOL,ledger_id:env.PUSH_LEDGER_ID,ledger_bootstrap_id:boot,notification_id:note,subject_sha256:subject,provider_generation:generation,
      attempts:[{operation_key:input.operation_key,device_id:device,platform:'android',token_sha256:await sha256(input.token),request_sha256:requestHash(input)}]};
    const hash=await sha256(canonical(plan));
    await send('/v2/plans',body({plan,plan_sha256:hash}),503,{'x-fixture-put-fault':'1'});
    assert.equal((await remote().control()).control.plans,0);assert.equal((await remote().lookupPlan(note)).result.plan,null);
    await restart();await remote().plan(plan);
    const claims=await Promise.all(Array.from({length:8},()=>remote().reserve(input,hash)));assert.equal(claims.filter(value=>value.claim).length,1);
    const claimed=claims.find(value=>value.claim);await remote().start(input.operation_key,claimed.claim,generation);
    await remote().finish(input.operation_key,{status:'accepted',provider_message_id:'synthetic-worker-v2-acceptance'});
    await restart();assert.equal((await remote().lookup(input.operation_key)).status,'accepted');assert.equal((await remote().reserve(input,hash)).claim,null);
    const proof=(await remote().retireSubject(subject)).result;assert.equal(proof.dispatch_quiescent,true);assert.equal(proof.provider_erasure_verified,false);
    await send('/v2/control',undefined,503,{'x-fixture-drop-binding':'1'});await restart();
    await assert.rejects(()=>remote().lookupPlan(note),/unavailable/);
    await send('/v2/bootstrap',body({bootstrap_id:boot,provider_generation:generation}),503,{authorization:'Bearer '+env.PUSH_LEDGER_BOOTSTRAP_TOKEN});
    await send('/v1/operations/reserve',envelope({operation_key:input.operation_key,platform:'android',notification_id:note,request_sha256:requestHash(input)}),503);
  }finally{await mf?.dispose();await rm(directory,{recursive:true,force:true});}
});
