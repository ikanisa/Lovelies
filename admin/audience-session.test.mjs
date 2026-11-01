import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OperatorSession} from './operator-session.mjs';
import {AUDIENCE_POLICY,AUDIENCE_RULE} from './audience.mjs';
const adultDecision={at_least_13:true,guardian_required:false};

function projection(account,declared=false) {
  return {protocol:'lovelies-audience-v2',policy_version:AUDIENCE_POLICY,account_id:account,
    authority_expires_at:declared?new Date(Date.now()+3600000).toISOString():null,
    audience:{at_least_13:declared?true:null,guardian_required:declared?false:null,status:declared?'eligible':'unknown',version:declared?1:0,policy_version:declared?AUDIENCE_POLICY:null,
      source:declared?'self_declaration':null,rule_version:declared?AUDIENCE_RULE:null,territory:declared?'global':null,declared_at:declared?new Date(Date.now()-1000).toISOString():null,
      next_review_at:declared?new Date(Date.now()+86400000).toISOString():null,review_required:false},
    capabilities:{face_authentication:declared,photo_matching:declared,photo_processing:declared},guardian_request:null};
}
function fixture(fetch) {
  const account=crypto.randomUUID(),vault={async save(value){this.value=structuredClone(value);}};
  const session=new OperatorSession({baseUrl:'https://example.test',policyVersion:'face-policy',vault,fetch:(url,options)=>fetch({account,vault,session,url,options})});
  session.state={anonymous:{account_id:account,access_token:'expired'},reference:null,pendingAudience:null};
  return {account,vault,session};
}

test('operator enrollment needs a neutral selection and separate explicit declaration before any request',async()=>{
  let requests=0;const {session}=fixture(()=>{requests++;throw Error('unexpected');});
  await assert.rejects(session.startEnrollment(true),{code:'audience_confirmation_required'});
  await assert.rejects(session.startEnrollment(true,undefined,true),{code:'audience_selection_required'});
  await assert.rejects(session.startEnrollment(true,true,true),{code:'audience_selection_required'});
  assert.equal(requests,0);
});

test('anonymous audience refresh preserves account, epoch and persisted exact mutation',async()=>{
  let reads=0,refreshes=0,body;
  const {session,account,vault}=fixture(({account,vault,options})=>{
    if(options.method==='GET')return ++reads===1?Response.json({error:{code:'session_expired'}},{status:401}):Response.json(projection(account));
    body=JSON.parse(options.body);
    assert.deepEqual(vault.value.pendingAudience,{version:2,kind:'declaration',accountId:account,body});
    assert.equal(options.headers.authorization,'Bearer refreshed');
    return Response.json(projection(account,true));
  });
  session.refreshAnonymous=async()=>{refreshes++;session.state.anonymous.access_token='refreshed';return session.state.anonymous;};
  await session.declareOperatorAudience(adultDecision);
  assert.equal(refreshes,1);assert.equal(session.epoch,0);assert.equal(session.state.anonymous.account_id,account);
  assert.equal(body.expected_version,0);assert.equal(body.at_least_13,true);assert.equal(body.guardian_required,false);assert(!Object.hasOwn(body,'age_band'));assert.equal(vault.value.pendingAudience,null);
});

test('lost audience mutation reply retains the same operation across vault recovery',async()=>{
  let lose=true;const bodies=[];
  const {session,vault}=fixture(({account,options})=>{
    if(options.method==='GET')return Response.json(projection(account));
    bodies.push(JSON.parse(options.body));if(lose){lose=false;throw Error('reply_lost');}
    return Response.json(projection(account,true));
  });
  await assert.rejects(session.declareOperatorAudience(adultDecision),/reply_lost/);
  const original=structuredClone(vault.value.pendingAudience);
  session.state=structuredClone(vault.value);await session.declareOperatorAudience();
  assert.deepEqual(bodies,[original.body,original.body]);assert.equal(vault.value.pendingAudience,null);
});

test('expired audience mutation retries the persisted key once after refresh',async()=>{
  let refreshed=0;const bodies=[];
  const {session}=fixture(({account,options})=>{
    if(options.method==='GET')return Response.json(projection(account));
    bodies.push(JSON.parse(options.body));
    return bodies.length===1?Response.json({error:{code:'expired'}},{status:401}):Response.json(projection(account,true));
  });
  session.refreshAnonymous=async()=>{refreshed++;session.state.anonymous.access_token='new';return session.state.anonymous;};
  await session.declareOperatorAudience(adultDecision);assert.equal(refreshed,1);assert.deepEqual(bodies[0],bodies[1]);
});

test('logout while refreshing audience prevents declaration dispatch',async()=>{
  let enter,release,mutations=0;const ready=new Promise(resolve=>enter=resolve);
  const {session}=fixture(({options})=>{
    if(options.method!=='GET')mutations++;
    return Response.json({error:{code:'expired'}},{status:401});
  });
  session.refreshAnonymous=async()=>{enter();await new Promise(resolve=>release=resolve);};
  const operation=session.declareOperatorAudience(adultDecision);await ready;session.cancelCapture();release();
  await assert.rejects(operation,{code:'session_changed'});assert.equal(mutations,0);
});

function operatorFixture(fetch,now=Date.now) {
  const account=crypto.randomUUID(),vault={async save(value){this.value=structuredClone(value);}};
  const session=new OperatorSession({baseUrl:'https://example.test',policyVersion:'face-policy',vault,now,fetch});
  session.state={reference:{accountId:account},pendingAction:null};
  session.operator={user_id:account,roles:['admin']};session.credentials={access_token:'weak-own-session'};
  return {account,vault,session};
}

test('a lost action keeps its exact journal through fresh or current-authority denial and same-account sign-in',async t=>{
  for(const [status,code]of [[403,'fresh_face_authentication_required'],[403,'audience_restricted'],[403,'guardian_adult_required'],[401,'registered_face_session_invalid'],[401,'session_invalid']])await t.test(code,async()=>{
    const sent=[];let step=0;
    const {account,vault,session}=operatorFixture(async(_url,options)=>{
      sent.push(JSON.parse(options.body));
      if(++step===1)throw Error('committed_reply_lost');
      if(step===2)return Response.json({error:{code}},{status});
      return Response.json({guardian_request:{state:'withdrawn'}});
    });
    const path=`/admin/guardian-requests/${crypto.randomUUID()}/review`,body={operation_key:crypto.randomUUID(),expected_revision:2,decision:'approve'};
    await assert.rejects(session.action(path,body),/committed_reply_lost/);
    const original=structuredClone(vault.value.pendingAction);
    await assert.rejects(session.action(path,body),{code,status});
    assert.deepEqual(session.state.pendingAction,original);assert.deepEqual(vault.value.pendingAction,original);
    // Controlled sign-in fixture changes only the current credential; it does
    // not replace the saved account or recompute the original operation.
    const restored=new OperatorSession({baseUrl:session.base,policyVersion:'face-policy',vault,fetch:session.fetch});
    restored.state=structuredClone(vault.value);restored.operator={user_id:account,roles:['admin']};restored.credentials={access_token:'fresh-same-account'};
    assert.equal((await restored.action(path,body)).guardian_request.state,'withdrawn');
    assert.deepEqual(sent,[body,body,body]);assert.equal(vault.value.pendingAction,null);
  });
});

test('exact strong denials clear product authority while keeping the same credential and private recovery state',async t=>{
  for(const [status,code]of [[403,'audience_required'],[403,'age_not_supported'],[403,'guardian_approval_required'],[403,'audience_restricted'],[403,'registered_face_required'],[403,'admin_required'],[401,'registered_face_session_invalid']])await t.test(code,async()=>{
    const sent=[];let denied=true;
    const {session}=operatorFixture(async(url,options)=>{
      sent.push({url,authorization:options.headers.authorization});
      return denied?Response.json({error:{code}},{status}):Response.json({own:true});
    });
    session.state.pendingAction={path:'/admin/guardian-requests/example/review',body:{operation_key:crypto.randomUUID()},accountId:session.operator.user_id};
    session.challenge={sensitive:'old capture'};session.captures=[{index:0}];
    const credential=session.credentials,state=structuredClone(session.state),epoch=session.epoch;
    await assert.rejects(session.request('/admin/guardian-requests'),{code,status});
    assert.equal(session.operator,null);assert.equal(session.credentials,credential);assert.equal(session.challenge,null);assert.deepEqual(session.captures,[]);
    assert.deepEqual(session.state,state);assert.equal(session.epoch,epoch+1);
    denied=false;assert.deepEqual(await session.request('/privacy/center'),{own:true});
    assert.equal(sent[1].authorization,'Bearer '+credential.access_token);
  });
  const {session}=operatorFixture(async()=>Response.json({error:{code:'independent_privacy_review_required'}},{status:403}));
  const operator=session.operator,credential=session.credentials;
  await assert.rejects(session.request('/privacy-requests/example/approve'),{code:'independent_privacy_review_required'});
  assert.equal(session.operator,operator);assert.equal(session.credentials,credential);assert.equal(session.epoch,0);
  session.fetch=async()=>Response.json({error:{code:'session_invalid'}},{status:401});
  await assert.rejects(session.request('/privacy/center'),{code:'session_invalid'});
  assert.equal(session.operator,null);assert.equal(session.credentials,null);
});

test('capture expiry, cancellation and exact challenge replacement during persistence or signing cannot dispatch bytes',async t=>{
  for(const stage of ['save','sign'])for(const change of ['expiry','cancel','replacement'])await t.test(`${stage} ${change}`,async()=>{
    let clock=Date.now(),entered,release,dispatches=0,signatures=0;
    const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
    const {session,vault}=operatorFixture(async()=>{dispatches++;throw Error('private_bytes_dispatched');},()=>clock);
    const challenge={protocol:'lovelies-face-auth-v1',purpose:'registration',account_id:crypto.randomUUID(),challenge_id:crypto.randomUUID(),device_id:crypto.randomUUID(),
      device_revision:crypto.randomUUID(),nonce:'lfn_'+'a'.repeat(43),policy_version:'face-policy',profile_id:null,profile_revision:null,
      required_captures:3,maximum_capture_bytes:8*1024*1024,expires_at:new Date(clock+60000).toISOString()};
    challenge.audience_authority={protocol:'lovelies-audience-challenge-v1',policy_version:AUDIENCE_POLICY,account_id:challenge.account_id,
      challenge_id:challenge.challenge_id,device_id:challenge.device_id,purpose:challenge.purpose,audience_version:1,expires_at:new Date(clock+1000).toISOString()};
    session.challenge=challenge;session.state.enrollment={captures:[]};session.state.anonymous={access_token:'original-account'};
    vault.save=async()=>{if(stage==='save'){entered();await gate;}};
    vault.sign=async()=>{signatures++;if(stage==='sign'){entered();await gate;}return 'signed-capture';};
    const work=session.useCapture(new Uint8Array([1,2,3]));await ready;
    if(change==='expiry')clock+=1001;
    else if(change==='cancel')session.cancelCapture();
    else session.challenge={...challenge};
    release();await assert.rejects(work,{code:change==='expiry'?'audience_challenge_invalid':change==='cancel'?'session_changed':'capture_scope_changed'});
    assert.equal(dispatches,0);assert.equal(signatures,stage==='save'?0:1);assert.equal(session.captureBusy,false);
  });
});

test('unknown operator audience never defaults to adulthood and an explicit unsupported range cannot reach a camera',async()=>{
  const sent=[];let decided=false;
  const {session,vault}=fixture(({account,url,options})=>{
    sent.push({url,method:options.method,body:options.body?JSON.parse(options.body):null});
    if(options.method==='GET')return Response.json(projection(account));
    decided=true;const value=projection(account,true);Object.assign(value.audience,{at_least_13:false,guardian_required:false,status:'blocked'});
    value.authority_expires_at=null;value.capabilities={face_authentication:false,photo_matching:false,photo_processing:false};return Response.json(value);
  });
  await assert.rejects(session.declareOperatorAudience(),{code:'audience_selection_required'});assert.equal(decided,false);assert.equal(vault.value,undefined);
  await assert.rejects(session.startEnrollment(true,'under13',true),{code:'operator_adult_required'});assert.equal(decided,true);
  const mutation=sent.find(x=>x.method==='PUT');assert.equal(mutation.body.at_least_13,false);assert.equal(mutation.body.guardian_required,false);assert(!Object.hasOwn(mutation.body,'age_band'));
  assert.equal(session.challenge,null);assert.equal(vault.value.pendingAudience,null);assert(sent.every(x=>x.url.endsWith('/me/audience')));
});
test('a same-account anonymous credential replacement during an audience read cannot dispatch a decision',async()=>{
  let enter,release,mutations=0;const ready=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);
  const {session}=fixture(async({account,options})=>{
    if(options.method==='GET'){enter();await gate;return Response.json(projection(account));}
    mutations++;throw Error('wrong_session_dispatch');
  });
  const work=session.declareOperatorAudience(adultDecision);await ready;session.state.anonymous.access_token='new-same-account-token';release();
  await assert.rejects(work,{code:'private_state_scope_changed'});assert.equal(mutations,0);assert.equal(session.state.pendingAudience,null);
});
test('a proven old declaration receipt clears only that operation and presents a now-due annual review',async()=>{
  const sent=[];
  const {session,account,vault}=fixture(({account,options})=>{
    sent.push(JSON.parse(options.body));const value=projection(account,true),deadline=Date.now()-1000;
    Object.assign(value.audience,{status:'suspended',declared_at:new Date(deadline-365*86400000).toISOString(),next_review_at:new Date(deadline).toISOString(),review_required:true});
    value.authority_expires_at=null;value.capabilities={face_authentication:false,photo_matching:false,photo_processing:false};return Response.json(value);
  });
  const body={age_band:'18_plus',policy_version:AUDIENCE_POLICY,expected_version:0,operation_key:crypto.randomUUID()};
  session.state.pendingAudience={accountId:account,body};
  assert.equal(await session.recoverOperatorAudience(),null);assert.deepEqual(sent,[body]);
  assert.equal(vault.value.pendingAudience,null);assert.equal(session.state.pendingAudience,null);
  assert.equal(session.audienceReview.kind,'anonymous');assert.equal(session.audienceReview.current.reviewRequired,true);
  assert.equal(session.challenge,null);assert.equal(session.credentials,null);assert.equal(session.operator,null);
});
