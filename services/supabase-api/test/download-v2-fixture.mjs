import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { fixture, databaseConnection, installMarker } from './restore-database-fixture.mjs';
import { faceVerifierFixture, enroll, fixturePng, sha256 } from './runtime-harness.mjs';
import { PostgresDatabase } from '../src/database.ts';
import { RestoreDatabaseFence } from '../src/restore-database.ts';
import { RestoreJournalClient, RESTORE_PROJECT_ID } from '../src/restore-journal.ts';
import { createApp, createHandler } from '../src/index.ts';
import { handleOperationRequest } from '../../restore-journal/src/operations.mjs';
import { MemoryStorage, env as journalEnv } from '../../restore-journal/test/fixtures.mjs';

export function downloadRequest(person,asset,version,operationKey=randomUUID(),capability='lvd_v2_'+randomBytes(32).toString('base64url')){
  const jwt=JSON.parse(Buffer.from(person.token.split('.')[1],'base64url').toString('utf8'));
  return {body:{protocol:'lovelies-download-input-v2',operation_key:operationKey,original_session_id:jwt.jti,
    asset_id:asset,source_version:version},headers:{'X-Lovelies-Download-Capability':capability},token:person.token};
}
export function fencedHttp(h,context){
  const app=createApp(context.db,context.env,context.now);
  const handler=createHandler(app);
  const request=(path,options={})=>{
    if(path&&typeof path==='object'){options={...path.intent,...options};path=path.url;}
    const {token,body,raw,method=body===undefined&&raw===undefined?'GET':'POST',headers={}}=options;
    return handler(new Request(path.startsWith('http')?path:'http://localhost'+path,{method,headers:{...(body===undefined?{}:{'content-type':'application/json'}),
      ...(token?{authorization:'Bearer '+token}:{}),...headers},...(body===undefined?raw===undefined?{}:{body:raw}:{body:JSON.stringify(body)})}));
  };
  const json=async(path,options={},expected=200)=>{const r=await request(path,options),v=await r.json();assert.equal(r.status,expected,`${path}: ${v?.error?.code??'unexpected'}`);return v;};
  return {...h,app,request,json,community:(token,action,payload={},expected=200)=>json('/community/action',{token,body:{action,payload}},expected)};
}
/** Attach the ACTUAL journal HTTP handler + production fence to an already
 * seeded synthetic runtime. Setup/corruption still uses h.storage explicitly. */
export async function attachDownloadFence(h,t){
  const storage=new MemoryStorage(),trace=[],faults={};let tick=1000;
  const rawJournal=(path,body)=>handleOperationRequest(new Request('https://journal.invalid'+path,{method:body===undefined?'GET':'POST',
    headers:{authorization:'Bearer '+journalEnv.RESTORE_JOURNAL_TOKEN,'X-Lovelies-Writer-Protocol':'lovelies-api-v15',...(body===undefined?{}:{'content-type':'application/json'})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})}),journalEnv,storage,{now:()=>++tick});
  const boot=await rawJournal('/v1/control/bootstrap',{version:1,project_id:RESTORE_PROJECT_ID,database_id:randomUUID(),bootstrap_id:randomUUID()});
  assert.equal(boot.status,200);await installMarker(h,(await boot.json()).binding.initial_marker);
  const journal=new RestoreJournalClient('https://journal.invalid',journalEnv.RESTORE_JOURNAL_TOKEN,{fetcher:async(url,init)=>handleOperationRequest(new Request(url,init),journalEnv,storage,{now:()=>++tick})});
  const db=new PostgresDatabase(databaseConnection(h,trace,faults),new RestoreDatabaseFence(journal,h.env));
  let closed=false;const close=async()=>{if(!closed){closed=true;await db.close();}};t.after(close);
  const originalClose=h.close;h.close=async()=>{await close();await originalClose();};
  return {h:fencedHttp(h,{...h.app,db}),db,journal,storage,trace,faults};
}
/** Synthetic face verdict and cached production-entitlement seed, real API,
 * SQL transactions/advisory locks (when TEST_DATABASE_URL is set), and actual
 * independent journal handlers. It does not qualify a provider/store/device. */
export async function downloadFixture(t){
  const f=await fixture(t,{harness:{faceVerifier:faceVerifierFixture,vars:{APPLE_BUNDLE_ID:'app.lovelies.ios',APPLE_APP_ID:'987654321',APPLE_SUBSCRIPTION_PRODUCT_ID:'app.lovelies.pro.monthly'}}});
  const person=await enroll(f.h),asset=randomUUID(),version=randomUUID(),rendition=randomUUID(),subscription=randomUUID(),now=Date.now();
  const bytes=fixturePng('download-v2-source'),checksum=await sha256(bytes),objectKey=`originals/${person.accountId}/${asset}/${version}`;
  await f.h.storage.exec("INSERT INTO consents(id,account_id,purpose,policy_version,status,created_at) VALUES(?,?,'photo_processing','photo-policy-fixture-v1','granted',?)",randomUUID(),person.accountId,now);
  await f.h.storage.exec("INSERT INTO assets(id,owner_id,source,status,object_key,content_type,byte_size,checksum_sha256,version,created_at) VALUES(?,?,'personal','ready',?,'image/png',?,?,?,?)",
    asset,person.accountId,objectKey,bytes.length,checksum,version,now);
  await f.h.storage.exec("INSERT INTO renditions(id,asset_id,object_key,content_type,byte_size,checksum_sha256,source_checksum_sha256,version,verified_at,status,source_version,model_version,kind) VALUES(?,?,?,'image/png',?,?,?,?,?,'ready',?,?,'preview')",
    rendition,asset,'preview/'+asset,bytes.length,checksum,checksum,randomUUID(),now,version,f.h.env.PHOTO_MODEL_VERSION);
  await f.h.storage.exec("INSERT INTO store_subscriptions(id,account_id,provider,app_identity,original_id,product_id,billing_environment,active,starts_at,expires_at,observed_at,transaction_id,version,acknowledged) VALUES(?,?,'apple','app.lovelies.ios:987654321',?,'app.lovelies.pro.monthly','production',1,?,?,?,?,1,1)",
    subscription,person.accountId,'synthetic-original-'+randomUUID(),now-1000,now+86400000,now,'synthetic-transaction-'+randomUUID());
  await f.h.env.QUARANTINE.put(objectKey,bytes,{httpMetadata:{contentType:'image/png'},customMetadata:{source_version:version,source_checksum_sha256:checksum}});
  const h=fencedHttp(f.h,f.context),intent=downloadRequest(person,asset,version);
  return {...f,h,context:h.app,person,asset,version,subscription,bytes,checksum,objectKey,intent,
    newIntent:()=>downloadRequest(person,asset,version),call:(mode,input=intent,expected=200)=>h.json('/downloads/v2/'+mode,input,expected)};
}
