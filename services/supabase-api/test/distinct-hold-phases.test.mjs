/** Deterministic local transaction-boundary tests; PGlite and synthetic journal only. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createApp,createHandler} from '../src/index.ts';
import {restoreOperationID} from '../src/restore-transaction.ts';
import {enroll,captureProofs,faceVerifierFixture} from './runtime-harness.mjs';
import {fixture} from './restore-database-fixture.mjs';
const key=x=>`${x}-${randomUUID()}`;
const statusToken=()=>`lvd_${randomUUID().replaceAll('-','')}${randomUUID().replaceAll('-','')}`;
const pgliteTest=process.env.TEST_DATABASE_URL === undefined ? test : test.skip;
async function administrator(h){
 const p=await enroll(h);await h.db.run('UPDATE accounts SET roles_json=? WHERE id=?',JSON.stringify(['user','admin']),p.accountId);
 const c=await h.json('/auth/face/challenge',{body:{face_handle:p.faceHandle,device_id:p.deviceId}},201);
 const auth=await h.json('/auth/face/complete',{body:await captureProofs(h,c,p.keys.privateKey)});
 assert(auth.roles.includes('admin'));return {...p,token:auth.access_token};
}
async function exercise(t,phase){
 assert.equal(process.env.TEST_DATABASE_URL,undefined,'external PostgreSQL prohibited');
 const f=await fixture(t),h=f.h;
 h.env.FACE_AUTH_VERIFIER={fetch:async req=>{const form=await req.formData();return Response.json(await faceVerifierFixture(JSON.parse(String(form.get('envelope'))),form));}};
 const owner=await h.anonymous({adult:true}),admin=await administrator(h),subject=owner.account_id;
 assert.notEqual(subject,admin.accountId,'reviewer must be independent');
 const withAsset=phase==='after_lease',asset=randomUUID(),objectKey=`private/synthetic-held/${asset}`,bytes=new Uint8Array([9,8,7,6]);
 await f.db.run('UPDATE accounts SET name=? WHERE id=?','synthetic owner metadata',subject);
 if(withAsset){
  await f.db.run('INSERT INTO assets(id,owner_id,source,status,object_key,content_type,byte_size,version,title,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
   asset,subject,'personal','ready',objectKey,'image/png',bytes.length,randomUUID(),'synthetic title',h.app.now());
  await h.env.QUARANTINE.put(objectKey,bytes);
  await f.db.run('INSERT INTO asset_retention(asset_id,raw_expires_at,preview_expires_at,updated_at) VALUES(?,?,?,?)',asset,h.app.now()+86400000,h.app.now()+86400000,h.app.now());
 }
 const handler=createHandler(createApp(f.db,h.env,h.app.now));
 async function req(path,{credential=admin.token,body,method=body===undefined?'GET':'POST'}={}){
  const response=await handler(new Request(`https://local.invalid${path}`,{method,headers:{authorization:`Bearer ${credential}`,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  return {status:response.status,value:await response.json()};
 }
 const primaryKey=key('phase-primary'),holdKey=key('phase-separate'),reviewKey=key('phase-review');
 async function create(op){return req('/privacy/account-deletion',{credential:owner.access_token,body:{operation_key:op,status_token:statusToken()}});}
 const a=await create(primaryKey),b=await create(holdKey);
 assert.equal(a.status,201);assert.equal(b.status,201);const primary=a.value.privacy_request.id,holdId=b.value.privacy_request.id;
 assert.notEqual(primary,holdId);
 const review=await req(`/privacy-requests/${primary}/approve`,{body:{operation_key:reviewKey}});
 assert.equal(review.status,200);assert.equal(review.value.privacy_request.reviewed_by,admin.accountId);
 const expectedEvents=[
  [await restoreOperationID(subject,'privacy',primaryKey),'account-deletion-requested',{account_id:subject,deletion_request_id:primary}],
  [await restoreOperationID(subject,'privacy',holdKey),'account-deletion-requested',{account_id:subject,deletion_request_id:holdId}],
  [await restoreOperationID(admin.accountId,'privacy',reviewKey),'account-deletion-reviewed',{account_id:subject,deletion_request_id:primary,reviewer_id:admin.accountId,decision:'approved'}],
 ];
 for(const [op,kind,scope] of expectedEvents){const saved=await f.journal.lookup(op);assert.equal(saved?.status,'committed');assert.equal(saved.plan.events.length,1);assert.equal(saved.plan.events[0].kind,kind);assert.deepEqual(saved.plan.events[0].scope,scope);}
 const erasedId=await restoreOperationID(subject,'privacy-erasure-system-v1','privacy.erasure.completed:'+primary);
 assert.equal(await f.journal.lookup(erasedId),null);
 const beforePrimary=await f.db.one('SELECT status,legal_hold,metadata_erased_at,completed_at FROM privacy_requests WHERE id=?',primary);
 const beforeHold=await f.db.one('SELECT subject_id,status,legal_hold FROM privacy_requests WHERE id=?',holdId);
 assert.equal(beforePrimary.status,'queued');assert.equal(beforePrimary.legal_hold,0);assert.equal(beforePrimary.metadata_erased_at,null);assert.equal(beforePrimary.completed_at,null);
 assert.equal(beforeHold.subject_id,subject);assert.equal(beforeHold.status,'pending_approval');assert.equal(beforeHold.legal_hold,0);
 const beforeAccount=await f.db.one('SELECT name,disabled_at FROM accounts WHERE id=?',subject);assert.equal(beforeAccount.name,'synthetic owner metadata');assert.equal(beforeAccount.disabled_at,null);
 const originalRun=f.db.run.bind(f.db),originalAll=f.db.all.bind(f.db),originalTransaction=f.db.transaction.bind(f.db);
 const remove=h.env.QUARANTINE.delete.bind(h.env.QUARANTINE),fixtureErrors=[],transactionErrors=[],deletes=[],events=[];
 let depth=0,seen=false,armed=true,injected=false;
 f.db.all=async(sql,...args)=>{try{return await originalAll(sql,...args);}catch(error){fixtureErrors.push({where:'query',message:String(error?.message??error)});throw error;}};
 f.db.run=async(sql,...args)=>{
  const value=await originalRun(sql,...args);
  if(armed&&args.at(-1)===primary&&((phase==='after_lease'&&sql.startsWith("UPDATE privacy_requests SET status='processing',execution_token=")) ||
    (phase==='before_finalization'&&sql.startsWith('UPDATE privacy_requests SET metadata_erased_at='))))seen=true;
  return value;
 };
 f.db.transaction=async(...args)=>{
  depth++;let result;
  try{result=await originalTransaction(...args);}catch(error){transactionErrors.push({code:error?.code??null,message:String(error?.message??error)});throw error;}finally{depth--;}
  if(depth===0&&armed&&seen){
   armed=false;
   try{
    const row=await f.db.one('SELECT status,execution_token,lease_until,metadata_erased_at,completed_at FROM privacy_requests WHERE id=?',primary);
    const hold=await f.db.one('SELECT legal_hold FROM privacy_requests WHERE id=?',holdId);
    const pending=await f.db.one("SELECT count(*) AS n FROM cleanup_intents WHERE request_id=? AND status<>'verified'",primary);
    assert.equal(row.status,'processing');assert(row.execution_token);assert(row.lease_until>h.app.now());assert.equal(row.completed_at,null);assert.equal(hold.legal_hold,0);
    if(phase==='after_lease')assert.equal(row.metadata_erased_at,null);else{assert.notEqual(row.metadata_erased_at,null);assert.equal(pending.n,0);}
    assert.equal(await f.journal.lookup(erasedId),null);
    const control=await f.journal.control();assert.equal(control.state,'serving');
    events.push({name:phase==='after_lease'?'lease_committed':'metadata_committed',metadata_erased:row.metadata_erased_at!==null,
      completed:row.completed_at!==null,unverified_cleanup:pending.n,checkpoint_revision:control.marker.checkpoint.revision});
    await f.db.run('UPDATE privacy_requests SET legal_hold=1 WHERE id=?',holdId);
    const nextHold=await f.db.one('SELECT legal_hold FROM privacy_requests WHERE id=?',holdId),nextControl=await f.journal.control();
    assert.equal(nextHold.legal_hold,1);assert.equal(nextControl.state,'serving');assert.equal(nextControl.marker.database_id,control.marker.database_id);
    assert.equal(nextControl.marker.incarnation_id,control.marker.incarnation_id);assert.equal(nextControl.marker.checkpoint.revision,control.marker.checkpoint.revision+1);
    assert.equal(await f.journal.lookup(erasedId),null);
    events.push({name:'distinct_hold_committed',active:true,checkpoint_revision:nextControl.marker.checkpoint.revision});injected=true;
   }catch(error){fixtureErrors.push({where:'phase_hook',message:String(error?.message??error)});throw error;}
  }
  return result;
 };
 h.env.QUARANTINE.delete=async target=>{deletes.push(target);if(!withAsset||target!==objectKey){const e=new Error('unexpected deletion target');fixtureErrors.push({where:'bucket',message:e.message});throw e;}return remove(target);};
 const processRequest=()=>req(`/privacy-requests/${primary}/process`,{body:{}});
 let denied,processError=null;try{denied=await processRequest();}catch(error){processError={code:error?.code??null,message:String(error?.message??error)};}
 const primaryAfter=await f.db.one('SELECT status,metadata_erased_at,completed_at,failure_code FROM privacy_requests WHERE id=?',primary);
 const accountAfter=await f.db.one('SELECT name,disabled_at FROM accounts WHERE id=?',subject),holdAfter=await f.db.one('SELECT subject_id,legal_hold FROM privacy_requests WHERE id=?',holdId);
 assert(primaryAfter);assert(accountAfter);assert(holdAfter);
 const currentAsset=withAsset?await f.db.one('SELECT title FROM assets WHERE id=? AND owner_id=?',asset,subject):null;
 const object=withAsset?await h.env.QUARANTINE.get(objectKey):null;
 const intact=!!object&&Buffer.from(await object.arrayBuffer()).equals(Buffer.from(bytes));
 const heldErased=await f.journal.lookup(erasedId);
 const obs={phase,injected,events,response_status:denied?.status??null,response_code:denied?.value?.error?.code??null,
  metadata_erased:primaryAfter.metadata_erased_at!==null,completed:primaryAfter.completed_at!==null,primary_status:primaryAfter.status,
  account_disabled:accountAfter.disabled_at!==null,owner_name_intact:accountAfter.name==='synthetic owner metadata',
  asset_title_intact:withAsset?currentAsset?.title==='synthetic title':null,object_bytes_intact:withAsset?intact:null,
  distinct_hold_active:holdAfter.subject_id===subject&&holdAfter.legal_hold===1,delete_calls:deletes.length,
  erased_event_during_hold:heldErased!==null,process_error:processError,fixture_errors:fixtureErrors,transaction_errors:transactionErrors};
 console.log('PHASE_OBSERVATION '+JSON.stringify(obs));
 assert.equal(processError,null);assert.deepEqual(fixtureErrors,[],'fixture failures cannot masquerade as a hold');
 assert.equal(injected,true,'hold was not installed at the requested transaction boundary');assert.equal(obs.distinct_hold_active,true);
 assert.equal(obs.response_status,409);assert.equal(obs.response_code,'privacy_legal_hold');assert.equal(obs.completed,false);assert.equal(obs.erased_event_during_hold,false);assert.equal(obs.delete_calls,0);
 if(phase==='after_lease'){assert.equal(obs.metadata_erased,false);assert.equal(obs.account_disabled,false);assert.equal(obs.owner_name_intact,true);assert.equal(obs.asset_title_intact,true);assert.equal(obs.object_bytes_intact,true);}
 else{assert.equal(obs.metadata_erased,true,'metadata was committed before the simulated late hold');assert.equal(obs.events[0].unverified_cleanup,0);}
 await f.db.run('UPDATE privacy_requests SET legal_hold=0 WHERE id=?',holdId);
 const released=await processRequest(),final=await f.db.one('SELECT status,completed_at FROM privacy_requests WHERE id=?',primary),erased=await f.journal.lookup(erasedId);
 const exact=erased?.status==='committed'&&erased.plan.events.length===1&&erased.plan.events[0].kind==='account-erased'&&erased.plan.events[0].scope.account_id===subject&&erased.plan.events[0].scope.deletion_request_id===primary;
 const releaseObs={phase,response_status:released.status,primary_status:final?.status??null,completed:final?.completed_at!==null,exact_erased_event:exact,
  delete_calls:deletes.length,object_absent:withAsset?!(await h.env.QUARANTINE.head(objectKey)):null,fixture_errors:fixtureErrors};
 console.log('PHASE_RELEASE '+JSON.stringify(releaseObs));
 assert.equal(released.status,200);assert.equal(final.status,'completed');assert.notEqual(final.completed_at,null);assert.equal(exact,true);
 assert.equal(deletes.length,withAsset?1:0);if(withAsset)assert.equal(releaseObs.object_absent,true);assert.deepEqual(fixtureErrors,[]);
}
for(const phase of ['after_lease','before_finalization'])pgliteTest(`distinct request hold at ${phase}`,{timeout:60000},t=>exercise(t,phase));
