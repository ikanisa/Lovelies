import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {rosterFixture,secret} from './roster-fixture.mjs';
import {fixture,env,envelope,input} from './independent-ledger-fixture.mjs';
import {ROSTER_BINDING} from '../src/roster-ledger.mjs';
import {createRosterGateway,requestHash} from '../src/gateway.mjs';
import {canonical,sha256} from '../src/push-plan.mjs';
import {ApnsAuthorization,ApnsProvider,FcmAuthorization,FcmProvider,providerGeneration} from '../src/providers.mjs';

test('complete immutable plan precedes every provider byte and duplicate attempts never resend',async t=>{
  let f,p;
  f=await rosterFixture({send:async prepared=>{
    const roster=(await f.roster.lookupPlan(prepared.input.notification.id)).result;
    assert.equal(roster.plan_sha256,p.hash);assert.equal(roster.receipts.length,2);
    assert.equal(roster.receipts.find(row=>row.operation_key===prepared.input.operation_key).status,'dispatching');
    return {status:'accepted',provider_message_id:'synthetic:'+prepared.id};
  }});t.after(()=>f.storage.database.close());
  p=await f.plan({devices:[{id:randomUUID(),token:'private-token-A-123456789'},{id:randomUUID(),token:'private-token-B-123456789'}]});
  assert.equal((await f.call('/send',f.sendBody(p))).status,409);
  assert.equal((await f.call('/notifications/plan',p.plan)).status,200);
  for(let index=0;index<2;index++){
    const replies=await Promise.all(Array.from({length:8},()=>f.call('/send',f.sendBody(p,index))));
    assert(replies.every(reply=>reply.status===200));
  }
  assert.equal(f.sent.length,2);
  const roster=(await f.roster.lookupPlan(p.plan.notification_id)).result;
  assert(roster.receipts.every(row=>row.status==='accepted'));assert.equal(new Set(roster.receipts.map(row=>row.provider_request_id)).size,2);
  const changed=structuredClone(p.plan);changed.attempts[0].request_sha256='a'.repeat(64);
  await assert.rejects(()=>f.roster.plan(changed),/binding_conflict/);
  const changedToken=f.sendBody(p);changedToken.dispatch={...changedToken.dispatch,token:'changed-private-token-123456789'};
  assert.equal((await f.call('/send',changedToken)).status,409);assert.equal(f.sent.length,2);
  for(const table of ['push_roster_plans_v2','push_roster_entries_v2','push_roster_intents_v2','push_roster_outcomes_v2'])
    assert.throws(()=>f.storage.database.prepare('DELETE FROM '+table).run(),/immutable_push_roster/);
  assert(!JSON.stringify(f.wire).includes('private-token-'));
});

test('subject and plan retirement fence unstarted work but retain unknown and late accepted outcomes',async t=>{
  const f=await rosterFixture();t.after(()=>f.storage.database.close());
  const p=await f.plan({devices:[{id:randomUUID(),token:'private-subject-token-A'},{id:randomUUID(),token:'private-subject-token-B'}]});
  await f.roster.plan(p.plan);const reserved=await f.roster.reserve(p.dispatches[0],p.hash);
  await f.roster.start(p.dispatches[0].operation_key,reserved.claim,f.generation);
  const proof=(await f.roster.retireSubject(p.plan.subject_sha256)).result;
  assert.equal(proof.started,1);assert.equal(proof.unresolved,1);assert.equal(proof.dispatch_quiescent,false);assert.equal(proof.provider_erasure_verified,false);
  const retired=(await f.roster.retirePlan(p.plan.notification_id)).result;
  assert.equal(retired.receipts[0].status,'dispatching');assert.equal(retired.receipts[1].status,'cancelled');
  assert.equal((await f.call('/send',f.sendBody(p,1))).status,200);assert.equal(f.sent.length,0);
  const later=await f.plan({subject:p.plan.subject_sha256});await assert.rejects(()=>f.roster.plan(later.plan),/subject_retired/);
  await f.roster.finish(p.dispatches[0].operation_key,{status:'accepted',provider_message_id:'late-known-acceptance'});
  const complete=(await f.roster.retireSubject(p.plan.subject_sha256)).result;
  assert.equal(complete.dispatch_quiescent,true);assert.equal(complete.settled,1);assert.equal(complete.provider_erasure_verified,false);
  await assert.rejects(()=>f.roster.finish(p.dispatches[0].operation_key,{status:'rejected',provider_code:'synthetic.changed'}),/terminal_outcome_conflict/);
  const missing=randomUUID();assert.equal((await f.roster.retirePlan(missing)).result.retired,true);
  const delayed=await f.plan({notificationID:missing});await assert.rejects(()=>f.roster.plan(delayed.plan),/plan_retired/);
});

test('generation activation requires a fence and all started outcomes, then rejects stale writers',async t=>{
  const f=await rosterFixture();t.after(()=>f.storage.database.close());
  const p=await f.plan();await f.roster.plan(p.plan);const reservation=await f.roster.reserve(p.dispatches[0],p.hash);
  await f.roster.start(p.dispatches[0].operation_key,reservation.claim,f.generation);
  const next='b'.repeat(64),activate=()=>f.send('/v2/generations/activate',f.envelope({previous_generation:f.generation,provider_generation:next}),env.PUSH_LEDGER_BOOTSTRAP_TOKEN);
  assert.equal((await activate()).status,409);
  assert.equal((await f.send('/v2/fence',f.envelope({reason:'provider_generation_retirement'}))).status,200);
  assert.equal((await activate()).status,503);
  f.advance(61000);assert.equal((await f.roster.lookup(p.dispatches[0].operation_key)).status,'ambiguous');
  await f.roster.finish(p.dispatches[0].operation_key,{status:'accepted',provider_message_id:'resolved-before-generation-retirement'});
  assert.equal((await activate()).status,200);assert.equal((await activate()).status,200);
  assert.equal((await f.roster.control()).control.provider_generation,next);
  const stale=await f.plan();await assert.rejects(()=>f.roster.plan(stale.plan),/generation_changed/);
  const original=(await f.call('/send',f.sendBody(p)));assert.equal(original.status,200);assert.equal((await original.json()).status,'accepted');assert.equal(f.sent.length,0);
});

for(const stage of ['start','finish'])test('lost '+stage+' acknowledgement cannot reopen a v2 dispatch',async t=>{
  let dropped=false;
  const f=await rosterFixture({fetcher:async(url,init,send)=>{const response=await send(url,init);
    if(!dropped&&url.endsWith('/'+stage)){dropped=true;await response.body.cancel();throw new Error('synthetic lost acknowledgement');}return response;}});
  t.after(()=>f.storage.database.close());const p=await f.plan();await f.roster.plan(p.plan);
  assert.equal((await f.call('/send',f.sendBody(p))).status,503);
  const reply=await f.call('/send',f.sendBody(p));assert.equal(reply.status,200);
  assert.equal((await reply.json()).status,stage==='start'?'dispatching':'accepted');assert.equal(f.sent.length,stage==='start'?0:1);
});

test('empty legacy bootstrap is explicit; nonempty legacy and lost v2 bindings cannot reset admission',async t=>{
  const old=await fixture();t.after(()=>old.storage.database.close());const legacy=input();await old.client.reserve(legacy,requestHash(legacy));
  const boot={version:2,project_id:env.SUPABASE_PROJECT_ID,ledger_id:env.PUSH_LEDGER_ID,bootstrap_id:randomUUID(),provider_generation:'a'.repeat(64)};
  assert.equal((await old.send('/v2/bootstrap',boot,env.PUSH_LEDGER_BOOTSTRAP_TOKEN)).status,503);
  assert((await old.client.lookup(legacy.operation_key)));
  const f=await rosterFixture();t.after(()=>f.storage.database.close());
  assert.equal((await f.send('/v1/operations/reserve',envelope({operation_key:legacy.operation_key,platform:legacy.platform,notification_id:legacy.notification.id,request_sha256:requestHash(legacy)}))).status,503);
  f.storage.rows.delete(ROSTER_BINDING);
  await assert.rejects(()=>f.roster.control(),/unavailable/);
  assert.equal((await f.send('/v2/bootstrap',f.envelope({bootstrap_id:f.bootstrap,provider_generation:f.generation}),env.PUSH_LEDGER_BOOTSTRAP_TOKEN)).status,503);
  assert.equal((await f.send('/v1/operations/reserve',envelope({operation_key:legacy.operation_key,platform:legacy.platform,notification_id:legacy.notification.id,request_sha256:requestHash(legacy)}))).status,503);
});

test('complete independent inventory uses bounded stable pages and exact bootstrap pins',async t=>{
  const f=await rosterFixture();t.after(()=>f.storage.database.close());const identifiers=[];
  for(let index=0;index<31;index++){const p=await f.plan({devices:[]});identifiers.push(p.plan.notification_id);await f.roster.plan(p.plan);}
  let cursor='',found=[];do{const page=(await f.roster.listPlans(cursor)).result;assert(page.items.length<=25);found.push(...page.items.map(row=>row.notification_id));cursor=page.next_cursor;}while(cursor);
  assert.deepEqual(found,identifiers.sort());
  await assert.rejects(()=>f.client({bootstrapID:randomUUID()}).control(),/unavailable/);
  const tampered=f.client({fetcher:async(url,init)=>{const result=await f.underlying(url,init),value=await result.json();value.result.receipts=[];return Response.json(value);}});
  const p=await f.plan();await f.roster.plan(p.plan);await assert.rejects(()=>tampered.lookupPlan(p.plan.notification_id),/unavailable/);
});

test('provider generation binds APNs topic/origin/key and FCM project/package/key without private material',()=>{
  const ec=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({type:'pkcs8',format:'pem'});
  const authorization=new ApnsAuthorization({teamID:'ABCDEFGHIJ',keyID:'1234567890',privateKey:ec});
  const apns=new ApnsProvider({authorization,topic:'com.lovelies.app',environment:'production'}),original=providerGeneration({ios:apns});
  assert.equal(providerGeneration({ios:apns}),original);
  apns.topic='com.lovelies.other';assert.notEqual(providerGeneration({ios:apns}),original);apns.topic='com.lovelies.app';
  apns.origin='https://api.sandbox.push.apple.com';assert.notEqual(providerGeneration({ios:apns}),original);
  assert(!canonical(apns.configuration()).includes('PRIVATE KEY'));
  const rsa=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});
  const serviceAccount={type:'service_account',project_id:'lovelies-test',client_email:'sender@lovelies-test.iam.gserviceaccount.com',token_uri:'https://oauth2.googleapis.com/token',private_key:rsa};
  const fcm=new FcmProvider({authorization:new FcmAuthorization({serviceAccount,projectID:'lovelies-test'}),projectID:'lovelies-test',packageName:'com.lovelies.app'});
  const baseline=providerGeneration({android:fcm});fcm.packageName='com.lovelies.other';assert.notEqual(providerGeneration({android:fcm}),baseline);
  fcm.packageName='com.lovelies.app';fcm.projectID='other-project';assert.notEqual(providerGeneration({android:fcm}),baseline);
  assert(!canonical(fcm.configuration()).includes('PRIVATE KEY'));
  const key2=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({type:'pkcs8',format:'pem'});
  const rotated=new ApnsProvider({authorization:new ApnsAuthorization({teamID:'ABCDEFGHIJ',keyID:'1234567890',privateKey:key2}),topic:'com.lovelies.app',environment:'production'});
  assert.notEqual(providerGeneration({ios:rotated}),original);
});

test('configuration change during preflight records no start and emits no provider bytes',async t=>{
  let f;f=await rosterFixture({prepare:async()=>{f.provider.configuration=()=>({provider:'synthetic-android',key:'changed'});return {};}});
  t.after(()=>f.storage.database.close());const p=await f.plan();await f.roster.plan(p.plan);
  const response=await f.call('/send',f.sendBody(p));assert.equal(response.status,503);assert.equal((await response.json()).status,'unstarted');
  assert.equal((await f.roster.control()).control.started,0);assert.equal(f.sent.length,0);
});
