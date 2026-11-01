import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,env} from './independent-ledger-fixture.mjs';
import {handleLedgerRequest,PUSH_LEDGER_PROJECT} from '../src/durable-ledger.mjs';
import {RemoteRosterLedger} from '../src/remote-roster.mjs';
import {createRosterGateway,requestHash} from '../src/gateway.mjs';
import {providerGeneration} from '../src/providers.mjs';
import {canonical,sha256,PUSH_PLAN_PROTOCOL,PUSH_DISPATCH_PROTOCOL} from '../src/push-plan.mjs';

export const secret='synthetic-v2-gateway-secret-for-local-tests-only';
export async function rosterFixture({send,prepare,fetcher}={}){
  const f=await fixture(),bootstrap=randomUUID(),wire=[],sent=[];
  const provider={configuration:()=>({provider:'synthetic-android',package_name:'com.lovelies.frontend.preview',key:'synthetic-public-key-fingerprint'}),
    prepare:async(input,id)=>prepare?prepare(input,id):({input,id}),
    send:async value=>{sent.push(value);return send?send(value):{status:'accepted',provider_message_id:'synthetic-receipt-'+value.id};}};
  const providers={android:provider},generation=providerGeneration(providers);
  const envelope=fields=>({version:2,project_id:PUSH_LEDGER_PROJECT,ledger_id:env.PUSH_LEDGER_ID,...fields});
  const initialized=await f.send('/v2/bootstrap',envelope({bootstrap_id:bootstrap,provider_generation:generation}),env.PUSH_LEDGER_BOOTSTRAP_TOKEN);
  assert.equal(initialized.status,200,JSON.stringify(await initialized.json()));
  const underlying=async(url,init)=>{wire.push({path:new URL(url).pathname,body:init.body?JSON.parse(init.body):null});
    return handleLedgerRequest(new Request(url,init),env,f.storage,{now:()=>f.now});};
  const client=options=>new RemoteRosterLedger('https://ledger.invalid',env.PUSH_LEDGER_TOKEN,{ledgerID:env.PUSH_LEDGER_ID,bootstrapID:bootstrap,
    fetcher:fetcher?((url,init)=>fetcher(url,init,underlying)):underlying,...options});
  const roster=client(),gateway=createRosterGateway({roster,providers,secret,generation});
  const call=async(path,body)=>gateway(new Request('https://gateway.invalid'+path,{method:body===undefined?'GET':'POST',
    headers:{authorization:'Bearer '+secret,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  const plan=async({notificationID=randomUUID(),subject,devices=[{id:randomUUID(),token:'synthetic-private-push-token-'+randomUUID()}],generation:gen=generation}={})=>{
    subject??=await sha256(randomUUID());
    const dispatches=devices.map(device=>({protocol:PUSH_DISPATCH_PROTOCOL,subject_sha256:subject,provider_generation:gen,
      operation_key:'notification:'+notificationID+':'+device.id,platform:device.platform??'android',token:device.token,
      notification:{id:notificationID,title:'Your support request was reviewed',kind:'support',entity_id:device.entity_id??randomUUID()}})).sort((a,b)=>a.operation_key.localeCompare(b.operation_key));
    const value={protocol:PUSH_PLAN_PROTOCOL,ledger_id:env.PUSH_LEDGER_ID,ledger_bootstrap_id:bootstrap,notification_id:notificationID,
      subject_sha256:subject,provider_generation:gen,attempts:await Promise.all(dispatches.map(async input=>({operation_key:input.operation_key,
        device_id:input.operation_key.split(':')[2],platform:input.platform,token_sha256:await sha256(input.token),request_sha256:requestHash(input)})))};
    return {plan:value,hash:await sha256(canonical(value)),dispatches};
  };
  return {...f,bootstrap,generation,providers,provider,wire,sent,envelope,client,roster,gateway,call,plan,underlying,
    sendBody:(p,index=0)=>({protocol:'lovelies-push-send-v2',plan_sha256:p.hash,dispatch:p.dispatches[index]})};
}

