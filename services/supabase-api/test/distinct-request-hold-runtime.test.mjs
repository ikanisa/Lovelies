/** PGlite, in-process synthetic journal and buckets only; no provider traffic. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createApp,createHandler} from '../src/index.ts';
import {restoreOperationID} from '../src/restore-transaction.ts';
import {enroll,captureProofs,faceVerifierFixture} from './runtime-harness.mjs';
import {fixture} from './restore-database-fixture.mjs';

const pgliteTest=process.env.TEST_DATABASE_URL === undefined ? test : test.skip;
const key=label=>`${label}-${randomUUID()}`;
const token=()=>`lvd_${randomUUID().replaceAll('-','')}${randomUUID().replaceAll('-','')}`;
async function administrator(h){
 const person=await enroll(h);
 await h.db.run('UPDATE accounts SET roles_json=? WHERE id=?',JSON.stringify(['user','admin']),person.accountId);
 const challenge=await h.json('/auth/face/challenge',{body:{face_handle:person.faceHandle,device_id:person.deviceId}},201);
 const credential=await h.json('/auth/face/complete',{body:await captureProofs(h,challenge,person.keys.privateKey)});
 assert(credential.roles.includes('admin'));return {...person,token:credential.access_token};
}
async function exercise(t,mode){
 assert.equal(process.env.TEST_DATABASE_URL,undefined,'external PostgreSQL prohibited');
 const f=await fixture(t),h=f.h;
 h.env.FACE_AUTH_VERIFIER={fetch:async request=>{const form=await request.formData();return Response.json(await faceVerifierFixture(JSON.parse(String(form.get('envelope'))),form));}};
 const owner=await h.anonymous({adult:true}),admin=await administrator(h),subject=owner.account_id;
 assert.notEqual(subject,admin.accountId,'reviewer must be independent');
 const hasAsset=mode!=='held_no_asset',asset=randomUUID(),objectKey=`private/synthetic-erasure/${asset}`,bytes=new Uint8Array([6,7,8]);
 await f.db.run('UPDATE accounts SET name=? WHERE id=?','synthetic owner metadata',subject);
 if(hasAsset){
  await f.db.run('INSERT INTO assets(id,owner_id,source,status,object_key,content_type,byte_size,version,title,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
   asset,subject,'personal','ready',objectKey,'image/png',bytes.length,randomUUID(),'synthetic held title',h.app.now());
  await h.env.QUARANTINE.put(objectKey,bytes);
  await f.db.run('INSERT INTO asset_retention(asset_id,raw_expires_at,preview_expires_at,updated_at) VALUES(?,?,?,?)',
   asset,h.app.now()+86400000,h.app.now()+86400000,h.app.now());
 }
 const context=createApp(f.db,h.env,h.app.now),handler=createHandler(context);
 async function req(path,{credential=admin.token,body,method=body===undefined?'GET':'POST'}={}){
  const response=await handler(new Request(`https://local.invalid${path}`,{method,headers:{authorization:`Bearer ${credential}`,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  const value=await response.json();return {status:response.status,value};
 }
 const create=()=>req('/privacy/account-deletion',{credential:owner.access_token,body:{operation_key:key('synthetic-request'),status_token:token()}});
 const main=await create(),separate=await create();
 assert.equal(main.status,201,`primary request setup failed: ${main.value?.error?.code}`);
 assert.equal(separate.status,201,`separate request setup failed: ${separate.value?.error?.code}`);
 const primary=main.value.privacy_request.id,holdId=separate.value.privacy_request.id;
 assert.notEqual(primary,holdId,'a distinct deletion request is required');
 const review=await req(`/privacy-requests/${primary}/approve`,{body:{operation_key:key('synthetic-independent-review')}});
 assert.equal(review.status,200,`independent review failed: ${review.value?.error?.code}`);
 assert.equal(review.value.privacy_request.reviewed_by,admin.accountId);
 if(mode!=='unheld_asset')await f.db.run('UPDATE privacy_requests SET legal_hold=1 WHERE id=?',holdId);
 const firstHold=await f.db.one('SELECT subject_id,request_type,status,legal_hold FROM privacy_requests WHERE id=?',holdId);
 assert.equal(firstHold?.subject_id,subject);assert.equal(firstHold?.request_type,'delete');assert.equal(firstHold?.status,'pending_approval');
 assert.equal(firstHold?.legal_hold,mode==='unheld_asset'?0:1);
 if(mode==='released_asset')await f.db.run('UPDATE privacy_requests SET legal_hold=0 WHERE id=?',holdId);
 const preHold=await f.db.one('SELECT subject_id,status,legal_hold FROM privacy_requests WHERE id=?',holdId);
 const primaryBefore=await f.db.one('SELECT subject_id,status,legal_hold,metadata_erased_at,completed_at,reviewed_by FROM privacy_requests WHERE id=?',primary);
 const accountBefore=await f.db.one('SELECT name,disabled_at FROM accounts WHERE id=?',subject);
 assert.equal(primaryBefore.subject_id,subject);assert.equal(primaryBefore.status,'queued');assert.equal(primaryBefore.legal_hold,0);
 assert.equal(primaryBefore.reviewed_by,admin.accountId);assert.equal(primaryBefore.metadata_erased_at,null);assert.equal(primaryBefore.completed_at,null);
 assert.equal(accountBefore.name,'synthetic owner metadata');assert.equal(accountBefore.disabled_at,null);
 if(hasAsset){assert.equal((await f.db.one('SELECT title FROM assets WHERE id=? AND owner_id=?',asset,subject)).title,'synthetic held title');assert(await h.env.QUARANTINE.head(objectKey));}
 const all=f.db.all.bind(f.db),transaction=f.db.transaction.bind(f.db),remove=h.env.QUARANTINE.delete.bind(h.env.QUARANTINE);
 const fixtureErrors=[],transactionErrors=[],deletes=[];
 f.db.all=async(sql,...args)=>{try{return await all(sql,...args);}catch(error){fixtureErrors.push({where:'database',message:String(error?.message??error)});throw error;}};
 f.db.transaction=async(...args)=>{try{return await transaction(...args);}catch(error){transactionErrors.push({code:error?.code??null,message:String(error?.message??error)});throw error;}};
 h.env.QUARANTINE.delete=async target=>{
  deletes.push(target);
  if(!hasAsset||target!==objectKey){const error=new Error('unexpected deletion target');fixtureErrors.push({where:'bucket',message:error.message});throw error;}
  try{return await remove(target);}catch(error){fixtureErrors.push({where:'bucket',message:String(error?.message??error)});throw error;}
 };
 const processRequest=()=>req(`/privacy-requests/${primary}/process`,{body:{}});
 let response,processError=null;
 try{response=await processRequest();}catch(error){processError={code:error?.code??null,message:String(error?.message??error)};}
 const primaryAfter=await f.db.one('SELECT status,metadata_erased_at,completed_at,failure_code FROM privacy_requests WHERE id=?',primary);
 const accountAfter=await f.db.one('SELECT name,disabled_at FROM accounts WHERE id=?',subject);
 const holdAfter=await f.db.one('SELECT subject_id,status,legal_hold FROM privacy_requests WHERE id=?',holdId);
 const assetAfter=hasAsset?await f.db.one('SELECT title FROM assets WHERE id=? AND owner_id=?',asset,subject):null;
 assert(primaryAfter,'primary request row missing after execution');assert(accountAfter,'owner account row missing after execution');assert(holdAfter,'separate request row missing after execution');
 const objectAfter=hasAsset?await h.env.QUARANTINE.get(objectKey):null;
 const objectIntact=!!objectAfter&&Buffer.from(await objectAfter.arrayBuffer()).equals(Buffer.from(bytes));
 const erasedId=await restoreOperationID(subject,'privacy-erasure-system-v1','privacy.erasure.completed:'+primary);
 const erased=await f.journal.lookup(erasedId);
 const observation={mode,reviewed_by_independent_operator:true,distinct_same_subject_request:true,hold_at_process:preHold.legal_hold,
  response_status:response?.status??null,response_code:response?.value?.error?.code??null,process_error:processError,
  primary_status:primaryAfter?.status??null,metadata_erased:primaryAfter?.metadata_erased_at!==null,completed:primaryAfter?.completed_at!==null,
  account_disabled:accountAfter?.disabled_at!==null,owner_name_intact:accountAfter?.name==='synthetic owner metadata',
  asset_title_intact:hasAsset?assetAfter?.title==='synthetic held title':null,object_bytes_intact:hasAsset?objectIntact:null,
  hold_remains_active:holdAfter?.legal_hold===1,delete_calls:deletes.length,delete_targets_exact:deletes.every(x=>x===objectKey),
  erased_journal_committed:erased?.status==='committed'&&erased.plan.events.some(event=>event.kind==='account-erased'&&event.scope.account_id===subject&&event.scope.deletion_request_id===primary),fixture_errors:fixtureErrors,transaction_errors:transactionErrors};
 console.log('ERASURE_OBSERVATION '+JSON.stringify(observation));
 assert.equal(processError,null,'handler failed outside its response');assert.deepEqual(fixtureErrors,[],'fixture/database failures must not mask behavior');
 assert.equal(observation.delete_targets_exact,true,'unexpected deletion target');
 if(mode.startsWith('held_')){
  // Capture whether the same, already attempted work can resume after release.
  await f.db.run('UPDATE privacy_requests SET legal_hold=0 WHERE id=?',holdId);
  const retried=await processRequest();const retriedRow=await f.db.one('SELECT status FROM privacy_requests WHERE id=?',primary);
  const absent=hasAsset?!(await h.env.QUARANTINE.head(objectKey)):true;
  console.log('RELEASE_OBSERVATION '+JSON.stringify({mode,response_status:retried.status,response_code:retried.value?.error?.code??null,primary_status:retriedRow?.status,object_absent:absent,delete_calls:deletes.length,fixture_errors:fixtureErrors}));
  assert.equal(retried.status,200,'erasure did not resume after release');assert.equal(retriedRow?.status,'completed');assert.equal(absent,true);assert.equal(deletes.length,hasAsset?1:0);assert.deepEqual(fixtureErrors,[]);
  const retriedErasure=await f.journal.lookup(erasedId);
  assert(retriedErasure?.status==='committed'&&retriedErasure.plan.events.some(event=>event.kind==='account-erased'&&event.scope.account_id===subject&&event.scope.deletion_request_id===primary));
 }
 if(mode.startsWith('held_')){
  assert.equal(observation.hold_at_process,1);assert.equal(observation.hold_remains_active,true);
  assert.equal(observation.response_status,409,'a distinct same-subject hold must reject erasure before metadata changes');
  assert.equal(observation.response_code,'privacy_legal_hold','denial should report the held deletion request');
  assert.equal(observation.primary_status,'queued','the held request must not acquire an execution lease');
  assert.equal(observation.metadata_erased,false,'metadata was erased while another same-subject deletion request was held');
  assert.equal(observation.completed,false,'erasure completed while another same-subject deletion request was held');
  assert.equal(observation.account_disabled,false);assert.equal(observation.owner_name_intact,true);
  assert.equal(observation.erased_journal_committed,false);
  if(hasAsset){assert.equal(observation.asset_title_intact,true);assert.equal(observation.object_bytes_intact,true);assert.equal(observation.delete_calls,0);}
 }else{
  assert.equal(observation.hold_at_process,0);assert.equal(observation.response_status,200);
  assert.equal(observation.primary_status,'completed');assert.equal(observation.metadata_erased,true);assert.equal(observation.completed,true);
  assert.equal(observation.erased_journal_committed,true);assert.equal(observation.object_bytes_intact,false);assert.equal(observation.delete_calls,1);
 }
}
for(const mode of ['unheld_asset','held_asset','released_asset','held_no_asset'])pgliteTest(`distinct deletion-request hold: ${mode}`,{timeout:60000},t=>exercise(t,mode));
