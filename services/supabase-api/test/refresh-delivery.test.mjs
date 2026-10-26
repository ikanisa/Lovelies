import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {startHarness,closeHarnesses,enroll,faceVerifierFixture,captureProofs} from './runtime-harness.mjs';
import {createApp,createHandler} from '../src/index.ts';
import {connectPostgres} from '../src/database.ts';
import {pruneRefreshDeliveries} from '../src/refresh-delivery.ts';
import {collectPrivacyExport} from '../src/privacy.ts';
after(closeHarnesses);
const protocol='lovelies-refresh-delivery-v1',key=()=>crypto.randomUUID();
const secret=()=>Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const intent=credentials=>({protocol,rotation_key:key(),delivery_secret:secret(),refresh_token:credentials.refresh_token});
const request=handler=>async(path,body)=>{const response=await handler(new Request('http://localhost'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));return{status:response.status,body:await response.json()};};
const rotate=(h,body,expected=200)=>h.json('/auth/session/refresh',{body},expected);
const cancel=(h,body,expected=200)=>h.json('/auth/session/refresh/cancel',{body},expected);

test('v2 refresh loss returns one encrypted exact credential result under the retained delivery capability',async()=>{
 const h=await startHarness({consumeQueue:false});try{
  const old=await h.anonymous({adult:true}),body=intent(old);
  const committed=await h.request('/auth/session/refresh',{body}),originalText=await committed.text();assert.equal(committed.status,200);
  // Simulate response loss: a different handler has only the durable old body.
  const response=await request(createHandler(createApp(h.db,h.env)))('/auth/session/refresh',structuredClone(body));
  assert.equal(response.status,200);assert.deepEqual(response.body,JSON.parse(originalText));
  const value=response.body;assert.equal(value.protocol,protocol);assert.equal(value.rotation_key,body.rotation_key);assert.equal(value.account_id,old.account_id);
  assert.equal(value.auth_method,'anonymous');assert.equal(value.expires_in,900);
  assert(Date.parse(value.delivery_expires_at)<=Date.now()+86400000);assert(Date.parse(value.access_expires_at)<Date.parse(value.refresh_expires_at));
  assert.equal((await h.db.one('SELECT count(*) n FROM sessions WHERE account_id=?',old.account_id)).n,2);
  const receipt=await h.db.one('SELECT * FROM refresh_delivery_receipts WHERE account_id=?',old.account_id),stored=JSON.stringify(receipt);
  for(const forbidden of [body.delivery_secret,body.refresh_token,value.refresh_token,value.access_token])assert(!stored.includes(forbidden),'receipt must not retain plaintext authority');
  assert.equal(receipt.iv.length,16);assert.equal(receipt.secret_hash.length,64);assert.equal(receipt.state,'active');
  assert.equal(JSON.stringify(value).includes(body.delivery_secret),false);
  await h.json('/me',{token:old.access_token},401);await h.json('/me',{token:value.access_token});
  await rotate(h,{refresh_token:old.refresh_token},401);
 }finally{await h.close();}
});

test('v2 validates canonical independent secrets and exact fields before consuming authority',async()=>{
 const h=await startHarness({consumeQueue:false});try{
  const old=await h.anonymous({adult:true}),body=intent(old);
  const malformed=[{...body,protocol:'v0'},{...body,rotation_key:'bad'},{...body,delivery_secret:'a'.repeat(42)},
   {...body,delivery_secret:'_'.repeat(43)},{...body,delivery_secret:body.delivery_secret+'='},{...body,extra:'field'},
   {...body,refresh_token:'bad'},Object.fromEntries(Object.entries(body).filter(([k])=>k!=='delivery_secret'))];
  for(const value of malformed)assert.equal((await rotate(h,value,401)).error.code,'refresh_invalid');
  assert.equal((await h.db.one('SELECT count(*) n FROM sessions')).n,1);assert.equal((await h.db.one('SELECT count(*) n FROM refresh_delivery_receipts')).n,0);
  const issued=await rotate(h,body);assert.equal(issued.account_id,old.account_id);
  await rotate(h,{...body,rotation_key:key()},401);await rotate(h,{...body,delivery_secret:secret()},401);
  const other=await h.anonymous({adult:true});await rotate(h,{...body,refresh_token:other.refresh_token},401);
  assert.equal((await h.db.one('SELECT count(*) n FROM sessions WHERE account_id=?',other.account_id)).n,1);
 }finally{await h.close();}
});

test('expired access can be delivered exactly then its still-current successor refresh can rotate',async()=>{
 const h=await startHarness({consumeQueue:false});try{
  const old=await h.anonymous({adult:true}),body=intent(old),issued=await rotate(h,body);
  const app=createApp(h.db,h.env,()=>Date.parse(issued.access_expires_at)+1000),send=request(createHandler(app));
  const delivered=await send('/auth/session/refresh',body);assert.equal(delivered.status,200);assert.deepEqual(delivered.body,issued);
  const next=await send('/auth/session/refresh',intent(delivered.body));assert.equal(next.status,200);assert.notEqual(next.body.refresh_token,issued.refresh_token);
  assert.equal((await send('/auth/session/refresh',body)).status,401,'a rotated successor retires its earlier receipt');
  assert.equal((await h.db.one('SELECT count(*) n FROM sessions WHERE account_id=?',old.account_id)).n,3);
 }finally{await h.close();}
});

test('receipt deadline is capped, matching expiry fails closed and bounded pruning never rotates',async()=>{
 const h=await startHarness({consumeQueue:false});try{
  const old=await h.anonymous({adult:true}),deadline=Date.now()+3600000;
  await h.db.run('UPDATE sessions SET refresh_expires_at=? WHERE account_id=?',deadline,old.account_id);
  const body=intent(old),issued=await rotate(h,body);assert.equal(Date.parse(issued.delivery_expires_at),deadline);
  const app=createApp(h.db,h.env,()=>deadline+1),send=request(createHandler(app));
  const expired=await send('/auth/session/refresh',body);assert.equal(expired.status,410);assert.equal(expired.body.error.code,'refresh_delivery_expired');
  await pruneRefreshDeliveries(app);assert.equal((await h.db.one('SELECT count(*) n FROM refresh_delivery_receipts')).n,0);
  assert.equal((await send('/auth/session/refresh',body)).status,401);assert.equal((await h.db.one('SELECT count(*) n FROM sessions')).n,2);
 }finally{await h.close();}
});

test('delivery rechecks account, role, epoch, registered reference, consent and device on every replay',async t=>{
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});try{
  const changes=[['account disabled',async(a)=>h.db.run('UPDATE accounts SET disabled_at=? WHERE id=?',Date.now(),a.accountId)],
   ['account epoch',async(a)=>h.db.run('UPDATE accounts SET auth_epoch=auth_epoch+1 WHERE id=?',a.accountId)],
   ['roles changed',async(a)=>h.db.run('UPDATE accounts SET roles_json=? WHERE id=?','["user","admin"]',a.accountId)],
   ['reference disabled',async(a)=>h.db.run("UPDATE face_profiles SET status='disabled' WHERE account_id=?",a.accountId)],
   ['authentication withdrawn',async(a)=>h.db.run('UPDATE face_profiles SET auth_enabled=0 WHERE account_id=?',a.accountId)],
   ['reference revision',async(a)=>h.db.run('UPDATE face_profiles SET revision=? WHERE account_id=?',key(),a.accountId)],
   ['consent revoked',async(a)=>h.db.run("UPDATE consents SET status='revoked',revoked_at=? WHERE account_id=? AND purpose='face_authentication'",Date.now(),a.accountId)],
   ['device revoked',async(a)=>h.db.run("UPDATE auth_devices SET status='revoked' WHERE id=?",a.deviceId)],
   ['device revision',async(a)=>h.db.run('UPDATE auth_devices SET revision=? WHERE id=?',key(),a.deviceId)]];
  for(const [name,change] of changes)await t.test(name,async()=>{
   const a=await enroll(h),body=intent(a),issued=await rotate(h,body);assert.equal(issued.auth_method,'registered_face');
   await change(a);const rejected=await h.request('/auth/session/refresh',{body});assert.equal(rejected.status,401);assert(!JSON.stringify(await rejected.json()).includes(issued.refresh_token));
  });
  await t.test('successor logout',async()=>{const a=await enroll(h),body=intent(a),issued=await rotate(h,body);await h.json('/auth/logout',{token:issued.access_token,body:{}});await rotate(h,body,401);});
 }finally{await h.close();}
});

test('ciphertext, IV and authenticated metadata corruption release no credentials and never rotate',async t=>{
 const h=await startHarness({consumeQueue:false});try{
  for(const column of ['ciphertext','iv','expires_at'])await t.test(column,async()=>{
   const a=await h.anonymous({adult:true}),body=intent(a),issued=await rotate(h,body),receipt=await h.db.one('SELECT * FROM refresh_delivery_receipts WHERE account_id=?',a.account_id);
   const value=column==='expires_at'?receipt.expires_at-1:column==='iv'?Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('base64url'):(receipt.ciphertext[0]==='A'?'B':'A')+receipt.ciphertext.slice(1);
   await h.db.run('UPDATE refresh_delivery_receipts SET '+column+'=? WHERE account_id=?',value,a.account_id);
   const result=await rotate(h,body,503);assert.equal(result.error.code,'refresh_delivery_unavailable');assert(!JSON.stringify(result).includes(issued.refresh_token));
   assert.equal((await h.db.one('SELECT count(*) n FROM sessions WHERE account_id=?',a.account_id)).n,2);
  });
 }finally{await h.close();}
});

test('unavailable or rotated encryption secret releases no receipt or replacement authority',async()=>{
 const h=await startHarness({consumeQueue:false});try{
  const a=await h.anonymous({adult:true}),body=intent(a),original=h.env.AUTH_SIGNING_SECRET;h.env.AUTH_SIGNING_SECRET='short';
  assert.equal((await rotate(h,body,503)).error.code,'refresh_delivery_unavailable');assert.equal((await h.db.one('SELECT count(*) n FROM sessions')).n,1);
  h.env.AUTH_SIGNING_SECRET=original;const issued=await rotate(h,body);h.env.AUTH_SIGNING_SECRET='a-different-server-signing-secret-'+key();
  assert.equal((await rotate(h,body,503)).error.code,'refresh_delivery_unavailable');assert.equal((await h.db.one('SELECT count(*) n FROM sessions')).n,2);
  h.env.AUTH_SIGNING_SECRET=original;assert.deepEqual(await rotate(h,body),issued);
 }finally{await h.close();}
});

test('cancellation fences a first dispatch, revokes committed successors and preserves exact binding',async()=>{
 const h=await startHarness({consumeQueue:false});try{
  const a=await h.anonymous({adult:true}),body=intent(a),expected={protocol,rotation_key:body.rotation_key,account_id:a.account_id,status:'cancelled'};
  assert.deepEqual(await cancel(h,body),expected);assert.deepEqual(await cancel(h,body),expected);
  await rotate(h,body,401);await rotate(h,{refresh_token:a.refresh_token},401);assert.equal((await h.db.one('SELECT count(*) n FROM sessions')).n,1);
  const b=await h.anonymous({adult:true}),operation=intent(b),issued=await rotate(h,operation);
  await cancel(h,{...operation,delivery_secret:secret()},401);await cancel(h,{...operation,rotation_key:key()},401);assert.deepEqual(await rotate(h,operation),issued);
  const ack=await cancel(h,operation);assert.equal(ack.account_id,b.account_id);assert(!('access_token' in ack));assert.deepEqual(await cancel(h,operation),ack);
  await h.json('/me',{token:issued.access_token},401);await rotate(h,operation,401);await rotate(h,{refresh_token:issued.refresh_token},401);
  const row=await h.db.one('SELECT * FROM refresh_delivery_receipts WHERE account_id=?',b.account_id);assert.equal(row.state,'cancelled');assert.equal(row.ciphertext,null);assert.equal(row.iv,null);
  // Session erasure also erases its receipt without a privacy inventory FK trap.
  await h.db.run('DELETE FROM sessions WHERE account_id=?',b.account_id);assert.equal((await h.db.one('SELECT count(*) n FROM refresh_delivery_receipts WHERE account_id=?',b.account_id)).n,0);
 }finally{await h.close();}
});

test('pre-dispatch cancellation remains effective after its tombstone is pruned',async()=>{
 const h=await startHarness({consumeQueue:false});try{
  const a=await h.anonymous({adult:true}),body=intent(a);await cancel(h,body);const app=createApp(h.db,h.env,()=>Date.now()+86400001);
  await pruneRefreshDeliveries(app);assert.equal((await h.db.one('SELECT count(*) n FROM refresh_delivery_receipts')).n,0);
  assert.equal((await request(createHandler(app))('/auth/session/refresh',body)).status,401);assert.equal((await h.db.one('SELECT count(*) n FROM sessions')).n,1);
 }finally{await h.close();}
});

test('cancelling an already rotated receipt cannot retire its newer sessions device work',async()=>{
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});try{
  const a=await enroll(h),first=intent(a),issued=await rotate(h,first),current=await rotate(h,intent(issued));
  const registered=await h.json('/me/push-devices',{token:current.access_token,body:{platform:'ios',push_token:'fixture-active-current-device-token-'+key(),operation_key:key()}});
  await cancel(h,first);await h.json('/me',{token:current.access_token});assert.equal((await h.db.one('SELECT active FROM push_devices WHERE id=?',registered.id)).active,1);
 }finally{await h.close();}
});

test('bounded pruning removes at most 100 expired receipts and preserves active delivery',async()=>{
 const h=await startHarness({consumeQueue:false});try{
  const a=await h.anonymous({adult:true}),body=intent(a),issued=await rotate(h,body),prefix='prune-'+key(),now=Date.now();
  await h.db.run(`INSERT INTO sessions(id,account_id,refresh_hash,expires_at,refresh_expires_at,revoked_at,auth_epoch,auth_method,created_at,refresh_consumed_at)
   SELECT ?||g::text,?,?||g::text,?,?,?,1,'anonymous',?,? FROM generate_series(1,105) g`,prefix,a.account_id,prefix,now+900000,now+86400000,now-3000,now-3000,now-3000);
  await h.db.run(`INSERT INTO refresh_delivery_receipts(original_session_id,account_id,rotation_key,secret_hash,state,created_at,expires_at)
   SELECT ?||g::text,?,?||g::text,repeat('a',64),'cancelled',?,? FROM generate_series(1,105) g`,prefix,a.account_id,prefix,now-2000,now-1000);
  await pruneRefreshDeliveries(h.app);assert.equal((await h.db.one('SELECT count(*) n FROM refresh_delivery_receipts')).n,6);
  await pruneRefreshDeliveries(h.app);assert.equal((await h.db.one('SELECT count(*) n FROM refresh_delivery_receipts')).n,1);assert.deepEqual(await rotate(h,body),issued);
 }finally{await h.close();}
});

test('privacy export excludes delivery authority and erasure clears ciphertext before a held writer settles',async()=>{
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});try{
  const a=await enroll(h),body=intent(a),issued=await rotate(h,body),receipt=await h.db.one('SELECT * FROM refresh_delivery_receipts WHERE account_id=?',a.accountId);
  const exported=JSON.stringify(await h.db.transaction(()=>collectPrivacyExport(h.app,a.accountId)));
  for(const forbidden of [body.delivery_secret,body.refresh_token,issued.refresh_token,issued.access_token,receipt.ciphertext,receipt.secret_hash,'refresh_delivery_receipts','secret_hash','ciphertext'])assert(!exported.includes(forbidden));
  const admin=await enroll(h);await h.db.run('UPDATE accounts SET roles_json=? WHERE id=?','["user","admin"]',admin.accountId);
  const challenge=await h.json('/auth/face/challenge',{body:{face_handle:admin.faceHandle,device_id:admin.deviceId}},201),proof=await captureProofs(h,challenge,admin.keys.privateKey);
  const authority=await h.json('/auth/face/complete',{body:proof});
  const privacy=(await h.json('/privacy/account-deletion',{token:issued.access_token,body:{operation_key:key()}},201)).privacy_request;
  await h.json(`/privacy-requests/${privacy.id}/approve`,{token:authority.access_token,body:{operation_key:key()}});
  const writer=key();await h.db.run("INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at) VALUES(?,?,'PHOTOS',?,'pending',?)",writer,a.accountId,'private-test/'+key(),Date.now());
  const held=await h.json(`/privacy-requests/${privacy.id}/process`,{token:authority.access_token,body:{}},503);assert.equal(held.error.code,'privacy_writer_unresolved');
  const retired=await h.db.one('SELECT state,ciphertext,iv FROM refresh_delivery_receipts WHERE account_id=?',a.accountId);
  assert(retired===null || (retired.state==='cancelled'&&retired.ciphertext===null&&retired.iv===null),'erasure must remove or retire encrypted delivery before the writer settles');await rotate(h,body,401);
  await h.db.run("UPDATE media_write_intents SET status='settled',settled_at=? WHERE id=?",Date.now(),writer);
  const completed=await h.json(`/privacy-requests/${privacy.id}/process`,{token:authority.access_token,body:{}});assert.equal(completed.privacy_request.status,'completed');
  assert.equal((await h.db.one('SELECT count(*) n FROM sessions WHERE account_id=?',a.accountId)).n,0);assert.equal((await h.db.one('SELECT count(*) n FROM refresh_delivery_receipts WHERE account_id=?',a.accountId)).n,0);
 }finally{await h.close();}
});

test('real three-pool delivery replay, competing keys and cancellation have one authoritative successor',{skip:!process.env.TEST_DATABASE_URL,timeout:60000},async t=>{
 const h=await startHarness({consumeQueue:false}),pools=[connectPostgres(h.databaseUrl),connectPostgres(h.databaseUrl)];
 try{
  const clients=[request(createHandler(h.app)),...pools.map(db=>request(createHandler(createApp(db,h.env))))];
  const a=await h.anonymous({adult:true}),body=intent(a),replies=await Promise.all(Array.from({length:12},(_,i)=>clients[i%3]('/auth/session/refresh',body)));
  for(const reply of replies){assert.equal(reply.status,200);assert.deepEqual(reply.body,replies[0].body);}
  assert.equal((await h.db.one('SELECT count(*) n FROM sessions WHERE account_id=?',a.account_id)).n,2);
  const connections=(await h.engine.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database()")).rows[0].n;assert(connections>=4);
  const b=await h.anonymous({adult:true}),competing=Array.from({length:9},()=>intent(b));
  const races=await Promise.all(competing.map((item,i)=>clients[i%3]('/auth/session/refresh',item)));assert.equal(races.filter(x=>x.status===200).length,1);assert.equal(races.filter(x=>x.status===401).length,8);
  assert.equal((await h.db.one('SELECT count(*) n FROM sessions WHERE account_id=?',b.account_id)).n,2);
  const c=await h.anonymous({adult:true}),held=intent(c),outcomes=await Promise.all([clients[0]('/auth/session/refresh',held),clients[1]('/auth/session/refresh/cancel',held),clients[2]('/auth/session/refresh',held)]);
  assert.equal(outcomes[1].status,200);assert(outcomes.every(x=>[200,401].includes(x.status)));
  assert.equal((await clients[0]('/auth/session/refresh',held)).status,401);
  const final=await h.db.one('SELECT count(*) n FROM sessions WHERE account_id=? AND revoked_at IS NULL',c.account_id);assert.equal(final.n,0);
  assert((await h.db.one('SELECT count(*) n FROM sessions WHERE account_id=?',c.account_id)).n<=2);
 }finally{await Promise.all(pools.map(db=>db.close()));await h.close();}
});

test('frozen v7 baseline remains byte-identical and v8 receipt alone adds forced RLS',async()=>{
 const folder=new URL('../../../supabase/migrations/',import.meta.url),source=fs.readFileSync(new URL('20261023162016_lovelies_private_core.sql',folder));
 assert.equal(createHash('sha256').update(source).digest('hex'),'ccd7d4b23b21bc65088fce436ade9019f0513e622140eb4e89c0048793bd9a6b');
 const h=await startHarness({consumeQueue:false});try{
  assert.equal((await h.db.one('SELECT max(version) version FROM schema_versions')).version,13);
  const rls=(await h.engine.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='lovelies_private.refresh_delivery_receipts'::regclass")).rows[0];assert.deepEqual(rls,{relrowsecurity:true,relforcerowsecurity:true});
  for(const role of ['anon','authenticated'])assert.equal((await h.engine.query("SELECT has_table_privilege($1,'lovelies_private.refresh_delivery_receipts','SELECT') permitted",[role])).rows[0].permitted,false);
 }finally{await h.close();}
});

test('restricted refresh keeps only own controls while revoked or revised exact devices deny every credential lane',async t=>{
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});try{
  for(const change of ['revoked','revised'])await t.test(change,async()=>{
   const person=await enroll(h),body=intent(person),issued=await rotate(h,body);
   await h.json('/privacy/account-deletion',{token:issued.access_token,body:{operation_key:key()}},201);
   // An actual audience restriction permits reconciliation of that same saved
   // credential, but never repairs the now-revoked biometric/product authority.
   assert.deepEqual(await rotate(h,body),issued);
   await h.json('/privacy/center',{token:issued.access_token});
   assert.equal((await h.json('/me/gallery',{token:issued.access_token},403)).error.code,'audience_restricted');
   const count=(await h.db.one('SELECT count(*) n FROM sessions WHERE account_id=?',person.accountId)).n;
   if(change==='revoked')await h.db.run("UPDATE auth_devices SET status='revoked' WHERE id=?",person.deviceId);
   else await h.db.run('UPDATE auth_devices SET revision=? WHERE id=?',key(),person.deviceId);
   await rotate(h,body,401);
   await h.json('/auth/session/refresh',{body:{refresh_token:issued.refresh_token}},401);
   await h.json('/privacy/center',{token:issued.access_token},401);
   await h.json('/me/audience',{token:issued.access_token},401);
   assert.equal((await h.db.one('SELECT count(*) n FROM sessions WHERE account_id=?',person.accountId)).n,count);
  });
 }finally{await h.close();}
});
