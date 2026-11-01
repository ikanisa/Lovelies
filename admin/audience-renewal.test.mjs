import test from 'node:test';
import assert from 'node:assert/strict';
import {OperatorSession} from './operator-session.mjs';
import {AUDIENCE_POLICY,AUDIENCE_RULE,AUDIENCE_DEVICE_PROTOCOL} from './audience.mjs';

function returningFixture() {
  let clock=Date.now(),version=1,due=true,nextStep='face_login';
  const account=crypto.randomUUID(),device=crypto.randomUUID(),profile=crypto.randomUUID(),calls=[],signatures=[],saves=[];
  const reference={accountId:account,deviceId:device,faceHandle:'lfh_'+'a'.repeat(43),profileId:profile,profileRevision:crypto.randomUUID(),modelId:'test-reference-v1'};
  const audience=()=>({at_least_13:true,guardian_required:false,status:due?'suspended':'eligible',version,policy_version:AUDIENCE_POLICY,
    source:'self_declaration',rule_version:AUDIENCE_RULE,territory:'global',declared_at:new Date(clock-(due?365*86400000:1000)).toISOString(),
    next_review_at:new Date(clock+(due?-1:86400000)).toISOString(),review_required:due});
  const response=body=>({protocol:AUDIENCE_DEVICE_PROTOCOL,account_id:account,device_id:device,request_nonce:body.request_nonce,
    audience:audience(),authority_expires_at:due?null:new Date(clock+60000).toISOString(),renewal_available:due,guardian_review_available:false,guardian_request:null,next_step:due?'audience_review':nextStep});
  const challenge=()=>({protocol:'lovelies-face-auth-v1',purpose:'login',account_id:account,challenge_id:crypto.randomUUID(),device_id:device,
    device_revision:crypto.randomUUID(),nonce:'lfn_'+'b'.repeat(43),policy_version:'face-policy',profile_id:profile,profile_revision:reference.profileRevision,
    model_id:reference.modelId,required_captures:1,poses:['front'],maximum_capture_bytes:8*1024*1024,expires_at:new Date(clock+60000).toISOString()});
  const vault={async load(){return structuredClone(this.value);},async save(value){this.value=structuredClone(value);saves.push(structuredClone(value));},
    async sign(value){signatures.push(structuredClone(value));return 'signed-device-proof';}};
  const session=new OperatorSession({baseUrl:'https://example.test',policyVersion:'face-policy',vault,now:()=>clock,
    fetch:async(url,options)=>{
      const path=new URL(url).pathname,body=JSON.parse(options.body);calls.push({path,body,options});
      if(path.endsWith('/audience/status'))return Response.json(response(body));
      if(path.endsWith('/audience/renew')){
        assert.deepEqual(vault.value.pendingAudience.body,{at_least_13:body.at_least_13,guardian_required:body.guardian_required,policy_version:body.policy_version,
          expected_version:body.expected_version,operation_key:body.operation_key,consent:body.consent});
        version=Math.max(version,body.expected_version+1);due=false;
        return Response.json({...response(body),renewal:{operation_key:body.operation_key,from_version:body.expected_version,to_version:body.expected_version+1,next_step:'face_login'}});
      }
      if(path==='/auth/face/challenge'){
        const value=challenge();value.audience_authority={protocol:'lovelies-audience-challenge-v1',policy_version:AUDIENCE_POLICY,
          account_id:account,device_id:device,challenge_id:value.challenge_id,purpose:'login',audience_version:version,expires_at:value.expires_at};
        return Response.json(value);
      }
      throw Error('unexpected_route:'+path);
    }});
  session.state={reference,anonymous:null,pendingAudience:null,pendingAction:{accountId:account,path:'/saved/action',body:{operation_key:crypto.randomUUID()}}};
  vault.value=structuredClone(session.state);
  return {session,vault,account,device,reference,calls,signatures,saves,response,audience,
    now:()=>clock,advance:ms=>clock+=ms,setCurrent(options={}){if(options.version!=null)version=options.version;if(options.due!=null)due=options.due;if(options.nextStep)nextStep=options.nextStep;}};
}

test('annual device status is a read-only pre-camera gate and never renews automatically',async()=>{
  const h=returningFixture();assert.equal(await h.session.startLogin(),null);
  assert.deepEqual(h.calls.map(c=>c.path),['/auth/face/audience/status']);assert.equal(h.saves.length,0);
  assert.equal(h.session.audienceReview.current.reviewRequired,true);assert.equal(h.session.challenge,null);
  assert.equal(h.session.credentials,null);assert.equal(h.session.operator,null);assert.equal(h.session.state.reference,h.reference);
  assert.equal(h.signatures[0].protocol,AUDIENCE_DEVICE_PROTOCOL);assert.equal(h.signatures[0].step,'status');
});
test('annual review requires a fresh explicit range, confirmation and separate authentication consent',async()=>{
  const h=returningFixture();await h.session.startLogin();
  await assert.rejects(h.session.renewOperatorAudience('18_plus',false,true),{code:'audience_confirmation_required'});
  await assert.rejects(h.session.renewOperatorAudience('18_plus',true,false),{code:'authentication_consent_required'});
  await assert.rejects(h.session.renewOperatorAudience('',true,true),{code:'audience_selection_required'});
  for(const selection of ['under13','13_17'])await assert.rejects(h.session.renewOperatorAudience(selection,true,true),{code:'operator_adult_required'});
  assert.equal(h.calls.length,1);assert.equal(h.saves.length,0);assert.equal(h.session.challenge,null);
});
test('new annual journals persist only exact minimized decisions and consent, then require fresh normal face login',async()=>{
  const h=returningFixture(),originalAction=structuredClone(h.session.state.pendingAction);await h.session.startLogin();
  const current=await h.session.renewOperatorAudience('18_plus',true,true);assert.equal(current.reviewRequired,false);
  const saved=h.saves.find(s=>s.pendingAudience)?.pendingAudience;
  assert.equal(saved.kind,'device-renewal');assert.equal(saved.body.expected_version,1);
  assert.deepEqual(saved.body.consent,{purpose:'face_authentication',policy_version:'face-policy',granted:true});
  for(const save of h.saves){assert(!JSON.stringify(save).includes('age_band'));assert(!JSON.stringify(save).includes('18_plus'));assert.deepEqual(save.pendingAction,originalAction);}
  assert.equal(h.session.state.pendingAudience,null);assert.equal(h.session.operator,null);assert.equal(h.session.credentials,null);assert.equal(h.session.challenge,null);
  assert.deepEqual(h.calls.map(c=>c.path),['/auth/face/audience/status','/auth/face/audience/renew']);
  await h.session.startLogin();assert.deepEqual(h.calls.slice(-2).map(c=>c.path),['/auth/face/audience/status','/auth/face/challenge']);assert(h.session.challenge);
});
test('a lost committed annual reply survives reconstruction with its original key, decision and consent but a fresh signed nonce',async()=>{
  const h=returningFixture(),fetch=h.session.fetch;let lost=true;
  h.session.fetch=async(url,options)=>{const value=await fetch(url,options);if(url.endsWith('/audience/renew')&&lost){lost=false;throw Error('committed_reply_lost');}return value;};
  await h.session.startLogin();await assert.rejects(h.session.renewOperatorAudience('18_plus',true,true),/committed_reply_lost/);
  const original=structuredClone(h.vault.value.pendingAudience);
  const restored=new OperatorSession({baseUrl:h.session.base,policyVersion:'face-policy',vault:h.vault,fetch:h.session.fetch,now:h.now});await restored.restore();
  await restored.recoverOperatorAudience();
  const sent=h.calls.filter(c=>c.path.endsWith('/audience/renew')).map(c=>c.body);assert.equal(sent.length,2);
  for(const body of sent)for(const [key,value]of Object.entries(original.body))assert.deepEqual(body[key],value);
  assert.notEqual(sent[0].request_nonce,sent[1].request_nonce);assert.equal(restored.state.pendingAudience,null);assert.equal(restored.challenge,null);
});
test('a saved renewal replays its original consent policy after configuration changes and uses current recovery authority',async()=>{
  const h=returningFixture(),fetch=h.session.fetch;let lost=true;
  h.session.fetch=async(url,options)=>{const response=await fetch(url,options);if(url.endsWith('/audience/renew')&&lost){lost=false;throw Error('committed_reply_lost');}return response;};
  await h.session.startLogin();await assert.rejects(h.session.renewOperatorAudience('18_plus',true,true),/committed_reply_lost/);
  const original=structuredClone(h.vault.value.pendingAudience);h.setCurrent({nextStep:'profile_recovery'});
  const restored=new OperatorSession({baseUrl:h.session.base,policyVersion:'face-policy-v2',vault:h.vault,fetch:h.session.fetch,now:h.now});await restored.restore();
  const current=await restored.recoverOperatorAudience();assert.equal(current.nextStep,'profile_recovery');
  const sent=h.calls.filter(c=>c.path.endsWith('/audience/renew')).map(c=>c.body);assert.equal(sent.length,2);
  for(const body of sent)for(const [key,value]of Object.entries(original.body))assert.deepEqual(body[key],value);
  assert.notEqual(sent[0].request_nonce,sent[1].request_nonce);assert.equal(restored.state.pendingAudience,null);
  assert.equal(restored.audienceReview.kind,'profile-recovery');assert.equal(restored.challenge,null);assert.equal(restored.operator,null);assert.equal(restored.credentials,null);
});
test('a policy rejection without a confirmed receipt preserves the original renewal bytes and key',async()=>{
  const h=returningFixture(),fetch=h.session.fetch;
  h.session.fetch=(url,options)=>url.endsWith('/audience/renew')?Promise.reject(Error('delivery_uncertain')):fetch(url,options);
  await h.session.startLogin();await assert.rejects(h.session.renewOperatorAudience('18_plus',true,true),/delivery_uncertain/);
  const original=structuredClone(h.vault.value.pendingAudience),sent=[];
  const restored=new OperatorSession({baseUrl:h.session.base,policyVersion:'face-policy-v2',vault:h.vault,now:h.now,
    fetch:async(url,options)=>{assert(url.endsWith('/audience/renew'));sent.push(JSON.parse(options.body));return Response.json({error:{code:'explicit_auth_consent_required'}},{status:400});}});
  await restored.restore();await assert.rejects(restored.recoverOperatorAudience(),{code:'explicit_auth_consent_required',status:400});
  assert.deepEqual(restored.state.pendingAudience,original);assert.deepEqual(h.vault.value.pendingAudience,original);
  for(const [key,value]of Object.entries(original.body))assert.deepEqual(sent[0][key],value);
  assert.equal(restored.operator,null);assert.equal(restored.credentials,null);assert.equal(restored.challenge,null);
});
test('both exact terminal restore contracts durably retire only the original renewal without replacement dispatch',async()=>{
  for(const [status,code] of [[409,'operation_recovered_without_result'],[410,'operation_retired_by_recovery']]) {
    const h=returningFixture(),fetch=h.session.fetch;await h.session.startLogin();
    const originalReference=h.session.state.reference,other={path:'/original-unrelated-action',body:{operation_key:crypto.randomUUID()}};
    h.session.state.pendingAction=other;let sends=0;
    h.session.fetch=(url,options)=>url.endsWith('/audience/renew')?(sends++,Promise.resolve(Response.json({error:{code}},{status}))):fetch(url,options);
    await assert.rejects(h.session.renewOperatorAudience('18_plus',true,true),{status,code});
    assert.equal(sends,1);assert.equal(h.session.state.pendingAudience,null);assert.equal(h.vault.value.pendingAudience,null);
    assert.equal(h.vault.value.audienceTerminal.code,code);assert.equal(h.vault.value.audienceTerminal.status,status);assert.match(h.vault.value.audienceTerminal.inputSha256,/^[0-9a-f]{64}$/);assert(h.vault.value.audienceTerminal.operationKey);assert.equal(h.vault.value.audienceTerminal.reconciledAt,undefined);
    assert.deepEqual(h.session.state.reference,originalReference);assert.deepEqual(h.session.state.pendingAction,other);
    assert.equal(h.session.challenge,null);assert.equal(h.session.operator,null);
  }
});
test('failed retirement storage keeps the exact renewal and never invents a replacement',async()=>{
  const h=returningFixture(),fetch=h.session.fetch,save=h.vault.save.bind(h.vault);await h.session.startLogin();let sends=0;
  h.vault.save=async value=>{if(!value.pendingAudience)throw Error('terminal_cleanup_write_failed');return save(value);};
  h.session.fetch=(url,options)=>url.endsWith('/audience/renew')?(sends++,Promise.resolve(Response.json({error:{code:'operation_retired_by_recovery'}},{status:410}))):fetch(url,options);
  await assert.rejects(h.session.renewOperatorAudience('18_plus',true,true),/terminal_cleanup_write_failed/);
  assert.equal(sends,1);assert(h.session.state.pendingAudience);assert.deepEqual(h.session.state.pendingAudience,h.vault.value.pendingAudience);
  assert.equal(h.session.challenge,null);assert.equal(h.session.operator,null);
});
test('durable journal failure prevents renewal dispatch and signing of its private operation',async()=>{
  const h=returningFixture();await h.session.startLogin();h.vault.save=async()=>{throw Error('private_write_failed');};
  await assert.rejects(h.session.renewOperatorAudience('18_plus',true,true),/private_write_failed/);
  assert.equal(h.calls.length,1);assert.equal(h.signatures.length,1);assert(h.session.state.pendingAudience,'The original in-memory key survives an uncertain storage outcome');
  await assert.rejects(h.session.recoverOperatorAudience(),/private_write_failed/);assert.equal(h.calls.length,1);assert.equal(h.signatures.length,1);
});
test('failure to clear a confirmed journal retains the original operation for idempotent recovery',async()=>{
  const h=returningFixture();await h.session.startLogin();const save=h.vault.save.bind(h.vault);let fail=true;
  h.vault.save=async value=>{if(!value.pendingAudience&&fail){fail=false;throw Error('clear_write_failed');}await save(value);};
  await assert.rejects(h.session.renewOperatorAudience('18_plus',true,true),/clear_write_failed/);
  const key=h.session.state.pendingAudience.body.operation_key;await h.session.recoverOperatorAudience();
  assert.equal(h.calls.filter(c=>c.path.endsWith('/renew')).length,2);assert(h.calls.filter(c=>c.path.endsWith('/renew')).every(c=>c.body.operation_key===key));
});
test('current profile recovery wins over a historical face-login receipt without creating another identity',async()=>{
  const h=returningFixture();await h.session.startLogin();h.setCurrent({nextStep:'profile_recovery',version:3});
  await h.session.renewOperatorAudience('18_plus',true,true);
  assert.equal(h.session.audienceReview.kind,'profile-recovery');assert.equal(h.session.state.audienceRecovery.nextStep,'profile_recovery');
  assert.equal(h.session.state.audienceRecovery.version,3);assert.equal(h.session.state.reference,h.reference);
  assert.equal(h.session.state.pendingAudience,null);assert.equal(h.session.challenge,null);assert.equal(h.session.operator,null);
  assert(!h.calls.some(c=>c.path==='/auth/anonymous'||c.path==='/auth/face/challenge'));
  const restored=new OperatorSession({baseUrl:h.session.base,policyVersion:'face-policy',vault:h.vault,fetch:h.session.fetch,now:h.now});await restored.restore();await restored.startLogin();
  assert.equal(restored.audienceReview.kind,'profile-recovery');assert.equal(restored.challenge,null);
  h.setCurrent({nextStep:'face_login'});await restored.startLogin();assert(restored.challenge,'A fresh current status, not the old marker, decides whether a challenge may be requested');
});
test('cancellation, logout, account and same-account session or reference replacement fence an in-flight signed renewal',async t=>{
  for(const stage of ['journal','sign','response'])for(const change of ['cancel','logout','account','reference','credentials'])await t.test(`${stage}/${change}`,async()=>{
    const h=returningFixture();await h.session.startLogin();let enter,release;const ready=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);
    if(stage==='journal'){const save=h.vault.save.bind(h.vault);h.vault.save=async value=>{await save(value);enter();await gate;};}
    if(stage==='sign'){const sign=h.vault.sign.bind(h.vault);h.vault.sign=async value=>{const result=await sign(value);enter();await gate;return result;};}
    if(stage==='response'){const fetch=h.session.fetch;h.session.fetch=async(...args)=>{const result=await fetch(...args);enter();await gate;return result;};}
    const work=h.session.renewOperatorAudience('18_plus',true,true);await ready;
    if(change==='cancel')h.session.cancelCapture();
    else if(change==='logout')await h.session.logout();
    else if(change==='account')h.session.state.reference={...h.reference,accountId:crypto.randomUUID()};
    else if(change==='reference')h.session.state.reference={...h.reference};
    else h.session.credentials={access_token:'new-same-account-session'};
    release();await assert.rejects(work,{code:['cancel','logout'].includes(change)?'session_changed':'private_state_scope_changed'});
    assert.equal(h.calls.filter(c=>c.path.endsWith('/renew')).length,stage==='response'?1:0);assert.equal(h.session.challenge,null);assert.equal(h.session.operator,null);
    assert(h.vault.value.pendingAudience,'The already durable original intent is retained');
  });
});
test('a request expiring while the device key signs cannot dispatch a renewal',async()=>{
  const h=returningFixture();await h.session.startLogin();h.vault.sign=async()=>{h.advance(45001);return 'late-signature';};
  await assert.rejects(h.session.renewOperatorAudience('18_plus',true,true),{code:'audience_device_request_expired'});
  assert.equal(h.calls.length,1);assert(h.session.state.pendingAudience);assert.equal(h.session.challenge,null);
});
test('a late status reply cannot publish a review or request a challenge after a same-account device change',async()=>{
  const h=returningFixture(),fetch=h.session.fetch;let enter,release;const ready=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);
  h.session.fetch=async(...args)=>{const value=await fetch(...args);enter();await gate;return value;};
  const work=h.session.startLogin();await ready;h.session.state.reference={...h.reference,deviceId:crypto.randomUUID()};release();
  await assert.rejects(work,{code:'private_state_scope_changed'});assert.equal(h.session.audienceReview,null);assert.equal(h.session.challenge,null);assert.equal(h.calls.length,1);
});
test('legacy uncertain audience declarations retry only their exact existing request and never rewrite missing receipts',async()=>{
  const account=crypto.randomUUID(),body={age_band:'18_plus',policy_version:AUDIENCE_POLICY,expected_version:0,operation_key:crypto.randomUUID()},sent=[],saves=[];
  const original={accountId:account,body},vault={async save(value){saves.push(structuredClone(value));}};
  const session=new OperatorSession({baseUrl:'https://example.test',policyVersion:'face-policy',vault,fetch:async(url,options)=>{
    sent.push({url,body:JSON.parse(options.body)});return Response.json({error:{code:'audience_upgrade_required'}},{status:409});}});
  session.state={reference:null,anonymous:{account_id:account,access_token:'same-account'},pendingAudience:structuredClone(original)};
  await assert.rejects(session.recoverOperatorAudience(),{code:'audience_upgrade_required'});
  assert.equal(sent.length,1);assert(sent[0].url.endsWith('/me/audience'));assert.deepEqual(sent[0].body,body);assert.deepEqual(session.state.pendingAudience,original);assert.equal(saves.length,0);
  await assert.rejects(session.declareOperatorAudience({at_least_13:true,guardian_required:true}),{code:'reconcile_audience_operation'});assert.equal(sent.length,1);
});
test('a new-format journal cannot smuggle a raw age band through the legacy recovery branch',async()=>{
  const account=crypto.randomUUID();let calls=0;
  const session=new OperatorSession({baseUrl:'https://example.test',policyVersion:'face-policy',vault:{},fetch:()=>{calls++;throw Error('unexpected');}});
  session.state={reference:null,anonymous:{account_id:account,access_token:'same-account'},pendingAudience:{version:2,kind:'declaration',accountId:account,
    body:{age_band:'18_plus',policy_version:AUDIENCE_POLICY,expected_version:0,operation_key:crypto.randomUUID()}}};
  await assert.rejects(session.recoverOperatorAudience(),{code:'private_state_scope_changed'});assert.equal(calls,0);
});
test('a committed journal write followed by cancellation cannot allow a replacement operation key',async()=>{
  const h=returningFixture();await h.session.startLogin();const save=h.vault.save.bind(h.vault);let enter,release,hold=true;
  const ready=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);
  h.vault.save=async value=>{await save(value);if(hold){hold=false;enter();await gate;}};
  const work=h.session.renewOperatorAudience('18_plus',true,true);await ready;const original=structuredClone(h.vault.value.pendingAudience);
  await h.session.logout();release();await assert.rejects(work,{code:'session_changed'});
  assert.deepEqual(h.session.state.pendingAudience,original);
  const before=h.calls.length;assert.equal(await h.session.startLogin(),null);assert.equal(h.calls.length,before);
  await h.session.recoverOperatorAudience();const renewals=h.calls.filter(c=>c.path.endsWith('/renew'));
  assert.equal(renewals.length,1);assert.equal(renewals[0].body.operation_key,original.body.operation_key);
});
test('a login challenge cannot exceed the effective authority deadline even when the own review is later',async()=>{
  const h=returningFixture(),fetch=h.session.fetch;h.setCurrent({due:false});
  h.session.fetch=async(url,options)=>{
    const response=await fetch(url,options);if(!url.endsWith('/audience/status'))return response;
    const value=await response.json();value.authority_expires_at=new Date(h.now()+1000).toISOString();return Response.json(value);
  };
  await assert.rejects(h.session.startLogin(),{code:'audience_challenge_invalid'});assert.equal(h.session.challenge,null);assert.equal(h.session.operator,null);
});
