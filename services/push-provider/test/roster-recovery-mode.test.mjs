import assert from 'node:assert/strict';
import {test} from 'node:test';
import {rosterFixture,secret} from './roster-fixture.mjs';
import {env as ledgerEnv} from './independent-ledger-fixture.mjs';
import {configuredGateway} from '../src/server.mjs';

test('explicit recovery startup needs pinned history but never reads provider keys or admits sends',async t=>{
  const f=await rosterFixture();t.after(()=>f.storage.database.close());const p=await f.plan();await f.roster.plan(p.plan);
  await f.send('/v2/fence',f.envelope({reason:'provider_generation_retirement'}));
  const env={PUSH_LEDGER_URL:'https://ledger.invalid',PUSH_LEDGER_TOKEN:ledgerEnv.PUSH_LEDGER_TOKEN,PUSH_LEDGER_ID:ledgerEnv.PUSH_LEDGER_ID,
    PUSH_LEDGER_BOOTSTRAP_ID:f.bootstrap,PUSH_SERVICE_SECRET:secret,PUSH_RECOVERY_ONLY:'true',PUSH_PROVIDER_SEND_ENABLED:'true'};
  Object.defineProperty(env,'APNS_PRIVATE_KEY_FILE',{get(){assert.fail('recovery must never load private provider material');}});
  const {handle,recoveryOnly}=await configuredGateway(env,{fetcher:f.underlying});assert.equal(recoveryOnly,true);
  const call=(path,body)=>handle(new Request('https://gateway.invalid'+path,{method:body===undefined?'GET':'POST',headers:{
    authorization:'Bearer '+secret,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  assert.equal((await call('/ready')).status,503);
  const read=await call('/notifications/'+p.plan.notification_id);assert.equal(read.status,200);assert.equal((await read.json()).result.plan_sha256,p.hash);
  assert.equal((await call('/send',f.sendBody(p))).status,503);assert.equal((await call('/notifications/plan',p.plan)).status,503);
  const retirement=await call('/subjects/'+p.plan.subject_sha256+'/retire',{});assert.equal(retirement.status,200);
  assert.equal((await retirement.json()).result.dispatch_quiescent,true);assert.equal(f.sent.length,0);assert.equal((await f.roster.control()).control.started,0);
  await assert.rejects(()=>configuredGateway({...env,PUSH_LEDGER_BOOTSTRAP_ID:crypto.randomUUID()},{fetcher:f.underlying}),/unavailable/);
  await assert.rejects(()=>configuredGateway({...env,PUSH_RECOVERY_ONLY:'false'},{fetcher:f.underlying}),/roster_unavailable/);
});
