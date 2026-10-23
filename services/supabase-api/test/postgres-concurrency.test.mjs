import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {connectPostgres} from '../src/database.ts';
import {createApp,createHandler} from '../src/index.ts';
import {startHarness,closeHarnesses,enroll,faceVerifierFixture,fixturePng} from './runtime-harness.mjs';
after(closeHarnesses);
const options={skip:!process.env.TEST_DATABASE_URL,timeout:120000};
const key=()=>crypto.randomUUID();
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
async function until(read,predicate){const end=Date.now()+30000;for(;;){const result=await read();if(predicate(result))return result;if(Date.now()>end)throw new Error('PostgreSQL concurrency condition not observed');await new Promise(resolve=>setTimeout(resolve,20));}}
function client(handler){return async(path,{token,body}={})=>{
 const response=await handler(new Request('http://localhost'+path,{method:body===undefined?'GET':'POST',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}));
 return {status:response.status,body:await response.json()};
};}

test('real PostgreSQL advisory lock serializes independent pools while rollback and roles stay isolated',options,async t=>{
 const h=await startHarness({consumeQueue:false}),other=connectPostgres(h.databaseUrl);t.after(()=>other.close());
 const entered=deferred(),release=deferred(),first=key(),second=key();let secondEntered=false;
 const failing=h.db.transaction(async()=>{
  const authority=await h.db.one("SELECT current_user role,(SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) bypass");
  assert.deepEqual(authority,{role:'lovelies_api',bypass:false});
  await h.db.run('INSERT INTO accounts(id) VALUES(?)',first);entered.resolve();await release.promise;throw new Error('planned-cross-pool-rollback');
 });
 // Attach rejection handling before opening the independent request.
 const rolledBack=assert.rejects(failing,/planned-cross-pool-rollback/);
 try{
  await entered.promise;
  const independent=other.transaction(async()=>{secondEntered=true;await other.run('INSERT INTO accounts(id) VALUES(?)',second);});
  await until(async()=>Number((await h.engine.query("SELECT count(*) n FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())")).rows[0].n),n=>n>=1);
  assert.equal(secondEntered,false,'callback must wait behind the real advisory lock');
  const connections=(await h.engine.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database()")).rows[0].n;
  assert(connections>=3,'owner inspector plus two independent API backend processes are required');
  release.resolve();await rolledBack;await independent;
  assert.equal(await h.db.one('SELECT id FROM accounts WHERE id=?',first),null);
  assert.deepEqual(await h.db.all('SELECT id FROM accounts WHERE id=?',first),[]);
  assert.equal((await other.one('SELECT id FROM accounts WHERE id=?',second)).id,second);
  assert.equal((await h.engine.query('SELECT current_user role')).rows[0].role,'postgres');
 }finally{release.resolve();await rolledBack;}
});

test('real independent API pools consume one refresh credential exactly once under twelve simultaneous requests',options,async t=>{
 const h=await startHarness({consumeQueue:false}),other=connectPostgres(h.databaseUrl);t.after(()=>other.close());
 const second=client(createHandler(createApp(other,h.env))),anonymous=await h.anonymous();
 const replies=await Promise.all(Array.from({length:12},async(_,index)=>index%2?second('/auth/session/refresh',{body:{refresh_token:anonymous.refresh_token}}):(async()=>{const response=await h.request('/auth/session/refresh',{body:{refresh_token:anonymous.refresh_token}});return {status:response.status,body:await response.json()};})()));
 assert.equal(replies.filter(reply=>reply.status===200).length,1);
 assert.equal(replies.filter(reply=>reply.status===401).length,11);
 assert.equal((await h.db.one('SELECT count(*) n FROM sessions WHERE account_id=?',anonymous.account_id)).n,2);
 await h.json('/me',{token:anonymous.access_token},401);
});

test('real three-pool simultaneous review commits and recipient approvals create only exact approved grants',options,async t=>{
 const processor=envelope=>({...envelope,preview:{bytes_base64:Buffer.from(fixturePng('preview:'+envelope.asset_id)).toString('base64'),content_type:'image/png',width:1,height:1},matches:envelope.profiles.map(profile=>({recipient_id:profile.account_id,profile_id:profile.profile_id,profile_version:profile.revision,model_version:profile.model_id}))});
 const h=await startHarness({faceVerifier:faceVerifierFixture,photoProcessor:processor}),pools=[connectPostgres(h.databaseUrl),connectPostgres(h.databaseUrl)];t.after(()=>Promise.all(pools.map(db=>db.close())));
 const clients=[client(createHandler(h.app)),...pools.map(db=>client(createHandler(createApp(db,h.env))))];
 const owner=await enroll(h),first=await enroll(h),second=await enroll(h);
 for(const person of [owner,first,second])await h.json('/me/photo-preferences',{token:person.token,body:{receive_matches:true,photo_matching_consent:true,processing_consent:true,policy_version:'photo-policy-fixture-v1',operation_key:key()}});
 const assets=[];
 for(let i=0;i<2;i++){
  const bytes=fixturePng(key()),reserved=await h.json('/uploads/session',{token:owner.token,body:{source:'personal',content_type:'image/png',byte_size:bytes.length,operation_key:key()}},201);
  await h.json(reserved.upload_url,{token:owner.token,method:'PUT',raw:bytes,headers:{'Content-Type':'image/png'}});
  await h.json(reserved.complete_url,{token:owner.token,body:{operation_key:key()}},202);
  const complete=await until(()=>h.json('/uploads/'+reserved.asset_id+'/status',{token:owner.token}),value=>['ready','failed'].includes(value.status));assert.equal(complete.status,'ready');assets.push(reserved.asset_id);
 }
 const snapshot=(await h.community(owner.token,'sharing.snapshot',{asset_ids:assets,operation_key:key()})).snapshot;
 const preview=(await h.community(owner.token,'sharing.preview',{snapshot_id:snapshot.id,snapshot_version:snapshot.version,draft_version:1,selected_asset_ids:assets,selected_recipient_ids:[first.accountId,second.accountId],excluded_pairs:[{asset_id:assets[1],recipient_id:second.accountId}],operation_key:key()})).preview;
 assert.deepEqual(preview.totals,{photos:2,recipients:2,pairs:3});
 const commit={action:'sharing.commit',payload:{preview_id:preview.id,preview_version:preview.version,draft_version:1,operation_key:key()}};
 const committed=await Promise.all(clients.map(send=>send('/community/action',{token:owner.token,body:commit})));
 for(const reply of committed){assert.equal(reply.status,200);assert.deepEqual(reply.body,committed[0].body);assert.equal(reply.body.grants_created,0);}
 assert.equal((await h.db.one('SELECT count(*) n FROM sharing_requests')).n,2);
 assert.equal((await h.db.one('SELECT count(*) n FROM media_grants')).n,0);
 for(const person of [first,second]){
  const request=committed[0].body.recipients.find(row=>row.recipient_id===person.accountId).request_id;
  const decision={action:'request.decide',payload:{request_id:request,decision:'accept',operation_key:key()}};
  const accepted=await Promise.all(clients.map(send=>send('/community/action',{token:person.token,body:decision})));
  for(const reply of accepted){assert.equal(reply.status,200);assert.deepEqual(reply.body,accepted[0].body);}
 }
 const grants=await h.db.all('SELECT asset_id,recipient_id FROM media_grants WHERE active=1 ORDER BY recipient_id,asset_id');
 assert.equal(grants.length,3);assert(!grants.some(row=>row.recipient_id===second.accountId&&row.asset_id===assets[1]));
 assert.equal((await h.db.one('SELECT count(DISTINCT approval_id) n FROM media_grants')).n,3);
});
