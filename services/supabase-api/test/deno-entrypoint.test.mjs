import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import {once} from 'node:events';
import {isolatedPostgres} from './postgres-harness.mjs';

test('actual Deno Edge entrypoint uses PostgreSQL ALS and current anonymous/refresh/logout authority', {skip:!process.env.TEST_DATABASE_URL,timeout:60000},async()=>{
 const local=await isolatedPostgres(process.env.TEST_DATABASE_URL),folder=path.resolve(import.meta.dirname,'../../../supabase/functions/lovelies-api');
 let reserve,child,closed,spawnError,failure,failed=false;
 try{
 const migrations=fs.readdirSync(new URL('../../../supabase/migrations/',import.meta.url)).filter(x=>/_lovelies_private_core\.sql$|_refresh_delivery\.sql$|_audience_retention\.sql$|_inference_generation\.sql$|_retention_scan_cursors\.sql$/.test(x)).sort();
 for(const migration of migrations)await local.engine.exec(fs.readFileSync(new URL('../../../supabase/migrations/'+migration,import.meta.url),'utf8'));
 reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise((resolve,reject)=>reserve.close(error=>error?reject(error):resolve()));
 const base='http://127.0.0.1:'+port,fixtureSecret='synthetic-local-deno-only-'+crypto.randomUUID(),databasePort=new URL(local.url).port;
 child=spawn(process.env.LOVELIES_DENO_BIN??'deno',['run','--cached-only','--allow-env','--allow-read','--allow-sys','--allow-net=127.0.0.1:'+port+',127.0.0.1:'+databasePort+',localhost:'+databasePort,'--config='+path.join(folder,'deno.json'),'--lock='+path.join(folder,'deno.lock'),path.join(folder,'index.ts')],{
  cwd:folder,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,HOME:process.env.HOME,...process.env.DENO_DIR?{DENO_DIR:process.env.DENO_DIR}:{},SUPABASE_URL:'http://127.0.0.1',LOVELIES_DATABASE_URL:local.url,LOVELIES_STORAGE_SECRET:fixtureSecret,AUTH_SIGNING_SECRET:fixtureSecret+'-auth',MEDIA_SIGNING_SECRET:fixtureSecret+'-media',INTERNAL_MAINTENANCE_SECRET:fixtureSecret+'-maintenance',FACE_AUTH_POLICY_VERSION:'synthetic-deno-face-policy',PHOTO_MODEL_VERSION:'synthetic-deno-model',LOVELIES_BIND_HOST:'127.0.0.1',PORT:String(port),APP_ENV:'test'},
 });
 closed=new Promise(resolve=>child.once('close',resolve));
 let output='';child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>output+=bytes);child.on('error',error=>spawnError=error);
 const request=async(route,{body,token}={})=>{
  const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{...body===undefined?{}:{'Content-Type':'application/json'},...token?{Authorization:'Bearer '+token}:{}},...body===undefined?{}:{body:JSON.stringify(body)}});
  return {status:response.status,body:await response.json()};
 };
  const deadline=Date.now()+20000;let health;
  while(Date.now()<deadline){if(spawnError)throw spawnError;if(child.exitCode!==null)break;try{health=await request('/health');if(health.status===200)break;}catch{}await new Promise(resolve=>setTimeout(resolve,40));}
  assert.equal(health?.status,200,'Deno startup failed: '+output.replaceAll(local.url,'[private test DB]').replaceAll(fixtureSecret,'[fixture secret]'));
  assert.equal(health.body.database,'supabase_postgresql');assert.equal(health.body.schema_version,11);
  assert.equal((await request('/ready')).status,503,'fixture has no Storage/model/provider qualification');
  const anonymous=await request('/auth/anonymous',{body:{}});assert.equal(anonymous.status,201);assert.equal(anonymous.body.auth_method,'anonymous');
  const account=await request('/me',{token:anonymous.body.access_token});assert.equal(account.status,200);assert.equal(account.body.user_id,anonymous.body.account_id);assert.equal(account.body.authenticated,false);
  assert.equal((await request('/me/gallery',{token:anonymous.body.access_token})).status,403);
  const renewed=await request('/auth/session/refresh',{body:{refresh_token:anonymous.body.refresh_token}});assert.equal(renewed.status,200);
  assert.equal((await request('/me',{token:anonymous.body.access_token})).status,401);
  assert.equal((await request('/auth/session/refresh',{body:{refresh_token:anonymous.body.refresh_token}})).status,401);
  assert.equal((await request('/auth/logout',{token:renewed.body.access_token,body:{}})).status,200);
  assert.equal((await request('/me',{token:renewed.body.access_token})).status,401);
  const guest=await request('/auth/anonymous',{body:{}}),delivery={protocol:'lovelies-refresh-delivery-v1',refresh_token:guest.body.refresh_token,
   rotation_key:crypto.randomUUID(),delivery_secret:Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')};
  const issued=await request('/auth/session/refresh',{body:delivery});assert.equal(issued.status,200);assert.equal(issued.body.protocol,delivery.protocol);
  assert.deepEqual(await request('/auth/session/refresh',{body:delivery}),issued,'Deno HKDF/AES receipt replay must return its exact successor');
  assert.equal((await request('/me',{token:issued.body.access_token})).status,200);
  const cancelled=await request('/auth/session/refresh/cancel',{body:delivery});assert.equal(cancelled.status,200);
  assert.deepEqual(cancelled.body,{protocol:delivery.protocol,rotation_key:delivery.rotation_key,account_id:guest.body.account_id,status:'cancelled'});
  assert.equal((await request('/me',{token:issued.body.access_token})).status,401);assert.equal((await request('/auth/session/refresh',{body:delivery})).status,401);
  // A live isolate must stop serving after the database is replaced or its
  // migration history changes; a failed health probe alone is insufficient.
  const history=await local.engine.query('SELECT version,applied_at FROM lovelies_private.schema_versions ORDER BY version');
  const before=(await local.engine.query('SELECT count(*)::int n FROM lovelies_private.accounts')).rows[0].n;
  await local.engine.exec('DELETE FROM lovelies_private.schema_versions WHERE version>8');
  assert.equal((await request('/health')).status,503);
  const blocked=await request('/functions/v1/lovelies-api/auth/anonymous',{body:{}});
  assert.deepEqual(blocked,{status:503,body:{error:{code:'database_schema_not_ready'}}});
  assert.equal((await local.engine.query('SELECT count(*)::int n FROM lovelies_private.accounts')).rows[0].n,before);
  for(const row of history.rows)await local.engine.query('INSERT INTO lovelies_private.schema_versions(version,applied_at) VALUES($1,$2) ON CONFLICT(version) DO NOTHING',[row.version,row.applied_at]);
  assert.equal((await request('/health')).status,200);
 }catch(error){failed=true;failure=error;throw error;}finally{
  const cleanupErrors=[];
  if(reserve?.listening)try{await new Promise((resolve,reject)=>reserve.close(error=>error?reject(error):resolve()));}catch(error){cleanupErrors.push(error);}
  if(child)try{
   const waitForClose=async()=>{
    let timer;
    try{return await Promise.race([closed.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),5000);})]);}
    finally{clearTimeout(timer);}
   };
   if(child.exitCode===null&&child.signalCode===null&&!spawnError)child.kill('SIGTERM');
   if(!await waitForClose()){
    if(child.exitCode===null&&child.signalCode===null&&!spawnError)child.kill('SIGKILL');
    if(!await waitForClose())throw new Error('Deno subprocess did not close after termination');
   }
  }catch(error){cleanupErrors.push(error);}
  try{await local.engine.close();}catch(error){cleanupErrors.push(error);}
  if(cleanupErrors.length){
   if(!failed)throw new AggregateError(cleanupErrors,'Deno entrypoint test cleanup failed');
   try{if(failure instanceof Error&&Object.isExtensible(failure))Object.defineProperty(failure,'cleanupErrors',{value:cleanupErrors,configurable:true});}catch{}
  }
 }
});
