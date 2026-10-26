import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {PostgresDatabase,postgresQuery} from '../src/database.ts';
import {SupabasePrivateBucket} from '../src/storage.ts';
import {startHarness,closeHarnesses,enroll,faceVerifierFixture} from './runtime-harness.mjs';
import {PostgresJobQueue} from '../src/jobs.ts';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
after(closeHarnesses);
const key=()=>crypto.randomUUID();

test('migration refuses a pre-existing privileged or publicly inherited backend role',async()=>{
 const migration=fs.readdirSync(new URL('../../../supabase/migrations/',import.meta.url)).find(x=>/_lovelies_private_core\.sql$/.test(x));
 const source=fs.readFileSync(new URL('../../../supabase/migrations/'+migration,import.meta.url),'utf8');
 for(const collision of ['CREATE ROLE lovelies_api BYPASSRLS NOINHERIT','CREATE ROLE lovelies_api NOLOGIN NOINHERIT NOBYPASSRLS; GRANT lovelies_api TO authenticated']){
  const engine=await PGlite.create();
  try{
   await engine.exec('CREATE ROLE anon; CREATE ROLE authenticated; '+collision);
   await engine.exec('BEGIN');
   await assert.rejects(()=>engine.exec(source),/unexpected_lovelies_api_role/);
   await engine.exec('ROLLBACK');
   assert.equal((await engine.query("SELECT count(*)::int n FROM pg_namespace WHERE nspname='lovelies_private'")).rows[0].n,0);
  }finally{await engine.close();}
 }
});

test('PostgreSQL placeholders skip strings/comments, bind data separately and reject count drift',()=>{
 const result=postgresQuery("SELECT '?' quoted,? actual, $$?$$ dollar -- ?\n/*?*/ WHERE ? IS NULL",["Robert');DROP TABLE accounts;--",null]);
 assert.equal(result.sql,"SELECT '?' quoted,$1::text actual, $$?$$ dollar -- ?\n/*?*/ WHERE $2::text IS NULL");
 assert.deepEqual(result.values,["Robert');DROP TABLE accounts;--",null]);
 assert.throws(()=>postgresQuery('SELECT ?',[1,2]),/sql_binding_mismatch/);
});

test('every application table has forced RLS and anon/authenticated cannot use the private schema',async()=>{
 const h=await startHarness({consumeQueue:false});
 const tables=(await h.engine.query("SELECT count(*)::int total,count(*) FILTER(WHERE relrowsecurity AND relforcerowsecurity)::int protected FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='lovelies_private' AND c.relkind='r'")).rows[0];
 assert.equal(tables.total,69);assert.equal(tables.protected,69);
 for(const role of ['anon','authenticated']){
  const result=(await h.engine.query('SELECT has_schema_privilege($1,$2,$3) permitted',[role,'lovelies_private','USAGE'])).rows[0];assert.equal(result.permitted,false);
  await h.engine.exec('BEGIN; SET LOCAL ROLE '+role);
  await assert.rejects(()=>h.engine.query('SELECT * FROM lovelies_private.accounts'),/permission denied/);
  await h.engine.exec('ROLLBACK');
 }
 assert.equal((await h.engine.query("SELECT rolbypassrls FROM pg_roles WHERE rolname='lovelies_api'")).rows[0].rolbypassrls,false);
 await h.close();
});

test('transaction rollback cannot capture a simultaneous unrelated request through shared async context',async()=>{
 const h=await startHarness({consumeQueue:false}),first=key(),second=key();
 let entered,release;const signal=new Promise(resolve=>entered=resolve),hold=new Promise(resolve=>release=resolve);
 const failing=h.db.transaction(async()=>{await h.db.run('INSERT INTO accounts(id) VALUES(?)',first);entered();await hold;throw new Error('planned-rollback');});
 await signal;
 const independent=h.db.run('INSERT INTO accounts(id) VALUES(?)',second);release();
 await assert.rejects(failing,/planned-rollback/);await independent;
 assert.equal(await h.db.one('SELECT id FROM accounts WHERE id=?',first),null);
 assert.equal((await h.db.one('SELECT id FROM accounts WHERE id=?',second)).id,second);
 await h.close();
});

test('concurrent refresh consumes its old credential exactly once and keeps account isolation',async()=>{
 const h=await startHarness({consumeQueue:false}),anonymous=await h.anonymous({adult:true});
 const responses=await Promise.all([0,1].map(()=>h.request('/auth/session/refresh',{body:{refresh_token:anonymous.refresh_token}})));
 assert.deepEqual(responses.map(x=>x.status).sort(),[200,401]);
 const values=await Promise.all(responses.map(x=>x.json()));const issued=values.find(x=>x.access_token);
 assert.equal(issued.account_id,anonymous.account_id);
 const row=await h.db.one('SELECT count(*) total FROM sessions WHERE account_id=?',anonymous.account_id);assert.equal(row.total,2);
 await h.json('/me',{token:anonymous.access_token},401);await h.close();
});

test('private Storage uses actual info metadata, propagates missing writes and never redirects credentials',async()=>{
 const calls=[],bytes=new Uint8Array([1,2,3]);
 const fetcher=async(url,init)=>{calls.push({url,init});
  if(url.includes('/info/'))return Response.json({size:3,etag:'abc',content_type:'image/png',metadata:{source_version:'version',source_checksum_sha256:'digest'}});
  if(init?.method==='POST')return Response.json({error:'missing bucket'},{status:404});
  return new Response(bytes,{headers:{etag:'"abc"'}});
 };
 const bucket=new SupabasePrivateBucket('https://ltqfplqevxztlswlzexn.supabase.co','sb_secret_fixture','lovelies-photos',fetcher);
 assert.throws(()=>new SupabasePrivateBucket('ftp://localhost','sb_secret_fixture','lovelies-photos'),/HTTPS Storage required/);
 const object=await bucket.get('private/photo.png');assert.equal(object.customMetadata.source_version,'version');assert.equal(object.httpMetadata.contentType,'image/png');assert.deepEqual(new Uint8Array(await object.arrayBuffer()),bytes);
 assert.equal(calls[0].init.headers.get('apikey'),'sb_secret_fixture');assert.equal(calls[0].init.headers.get('Authorization'),null);
 await assert.rejects(()=>bucket.put('private/missing.png',bytes),/private_storage_write_failed/);
 await assert.rejects(()=>bucket.head('../escape'),/invalid_private_object_key/);
 const redirect=new SupabasePrivateBucket('https://ltqfplqevxztlswlzexn.supabase.co','sb_secret_fixture','lovelies-photos',async()=>new Response(null,{status:302,headers:{Location:'https://evil.invalid'}}));
 await assert.rejects(()=>redirect.head('private/photo.png'),/storage_redirect_denied/);
});

test('durable job keys reconcile repeated enqueue without duplicating or broadening the payload',async()=>{
 const h=await startHarness({consumeQueue:false}),queue=new PostgresJobQueue(h.db),id=key();
 const message={category:'photo',payload:{attempt_id:id}};
 await Promise.all([queue.send(message),queue.send(message)]);
 const rows=await h.db.all('SELECT category,payload_json,state FROM job_queue');assert.equal(rows.length,1);assert.equal(rows[0].payload_json,JSON.stringify({attempt_id:id}));assert.equal(rows[0].state,'pending');
 await h.close();
});

test('push deactivation safely permits a next verified account without moving the former delivery history',async()=>{
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false}),first=await enroll(h),next=await enroll(h),token='synthetic-device-token-with-enough-length';
 const body={platform:'ios',push_token:token,operation_key:key()};
 const original=await h.json('/me/push-devices',{token:first.token,body});
 await h.json('/me/push-devices',{token:next.token,body:{...body,operation_key:key()}},403);
 await h.json('/me/push-devices/'+original.id,{token:first.token,method:'DELETE',body:{operation_key:key()}});
 const replacement=await h.json('/me/push-devices',{token:next.token,body:{...body,operation_key:key()}});assert.notEqual(original.id,replacement.id);
 const old=await h.db.one('SELECT account_id,active,token_value FROM push_devices WHERE id=?',original.id);assert.equal(old.account_id,first.accountId);assert.equal(old.active,0);assert.equal(old.token_value,'');
 const current=await h.db.one('SELECT account_id,active FROM push_devices WHERE id=?',replacement.id);assert.equal(current.account_id,next.accountId);assert.equal(current.active,1);
 await h.json('/auth/logout',{token:next.token,body:{}});assert.equal((await h.db.one('SELECT active FROM push_devices WHERE id=?',replacement.id)).active,0);
 await h.close();
});
