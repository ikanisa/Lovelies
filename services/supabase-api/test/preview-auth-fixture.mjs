import assert from 'node:assert/strict';
import { SupabasePrivateBucket } from '../src/storage.ts';
import { JSON_BODY_LIMITS } from '../src/types.ts';
import { processPhotoJob } from '../src/processing.ts';
import { startHarness,enroll,faceVerifierFixture,fixturePng } from './runtime-harness.mjs';

const operation=()=>crypto.randomUUID();
export async function runStalledPreview(t,route,change,expected){
 assert.equal(process.env.TEST_DATABASE_URL,undefined,'fixture must never attach to an external database');
 const preview=fixturePng('authority-preview'),h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false,
  photoProcessor:envelope=>({...envelope,preview:{bytes_base64:Buffer.from(preview).toString('base64'),content_type:'image/png',width:1,height:1},matches:[]})});
 t.after(()=>h.close());
 const owner=await enroll(h),claims=JSON.parse(Buffer.from(owner.token.split('.')[1],'base64url').toString('utf8'));
 await h.json('/me/photo-preferences',{token:owner.token,body:{policy_version:'photo-policy-fixture-v1',processing_consent:true,operation_key:operation()}});
 const bytes=fixturePng('authority-source'),upload=await h.json('/uploads/session',{token:owner.token,
  body:{source:'personal',content_type:'image/png',byte_size:bytes.length,operation_key:operation()}},201);
 await h.json(upload.upload_url,{token:owner.token,method:'PUT',raw:bytes,headers:{'content-type':'image/png'}});
 const complete=await h.json(upload.complete_url,{token:owner.token,body:{operation_key:operation()}},202);
 await processPhotoJob({attempt_id:complete.attempt_id},h.app);
 const source=(await h.storage.exec('SELECT object_key FROM assets WHERE id=?',upload.asset_id))[0];
 assert(source);const memory=h.env.QUARANTINE,metadata=await memory.head(source.object_key);assert(metadata);
 let target=`/community/media/${upload.asset_id}/preview`,requestOptions={token:owner.token};
 if(route==='ticket'){
  const ticket=await h.json('/previews/sign',{token:owner.token,body:{asset_id:upload.asset_id}});
  target=new URL(ticket.preview_url).pathname;requestOptions={};
 }
 let started,sourceController;const entered=new Promise(resolve=>{started=resolve;}),events=[];let cancellations=0,photoGets=0;
 t.after(()=>{try{sourceController?.error(new Error('synthetic_fixture_closed'));}catch{}});
 const transport=async(url,init={})=>{
  const u=new URL(url);events.push({method:init.method??'GET',path:u.pathname});
  assert.equal(init.method??'GET','GET');assert.equal(u.pathname,'/storage/v1/object/info/lovelies-quarantine/'+source.object_key.split('/').map(encodeURIComponent).join('/'));
  const body=new ReadableStream({start(c){sourceController=c;c.enqueue(new TextEncoder().encode('{'));started();},cancel(){cancellations++;return new Promise(()=>{});}});
  return new Response(body,{status:200,headers:{'content-type':'application/json'}});
 };
 h.env.QUARANTINE=new SupabasePrivateBucket('http://127.0.0.1:1','synthetic-secret','lovelies-quarantine',transport);
 const photoGet=h.env.PHOTOS.get.bind(h.env.PHOTOS);h.env.PHOTOS.get=async key=>{photoGets++;return photoGet(key);};
 const assetsBefore=await h.storage.exec('SELECT * FROM assets WHERE id=?',upload.asset_id);
 const renditionsBefore=await h.storage.exec('SELECT * FROM renditions WHERE asset_id=? ORDER BY id',upload.asset_id);
 t.mock.timers.enable({apis:['setTimeout']});
 const pending=h.request(target,requestOptions);void pending.catch(()=>{});
 await entered;await new Promise(resolve=>setImmediate(resolve));
 if(change==='logout'){
  await h.json('/auth/logout',{token:owner.token,body:{}});
  const session=(await h.storage.exec('SELECT revoked_at FROM sessions WHERE id=? AND account_id=?',claims.jti,owner.accountId))[0];assert.ok(session?.revoked_at);
 }else if(change==='withdraw'){
  await h.json('/me/photo-preferences',{token:owner.token,body:{policy_version:'photo-policy-fixture-v1',processing_consent:false,operation_key:operation()}});
  const consent=(await h.storage.exec("SELECT count(*) n FROM consents WHERE account_id=? AND purpose='photo_processing' AND status='granted'",owner.accountId))[0];assert.equal(Number(consent.n),0);
 }
 t.mock.timers.tick(JSON_BODY_LIMITS.timeoutMs+1);
 const response=await pending,body=await response.json();assert.equal(response.status,expected.status);assert.equal(body.error.code,expected.code);
 assert.equal(cancellations,1);assert.equal(photoGets,0);assert.equal(events.length,1);
 assert.deepEqual(await h.storage.exec('SELECT * FROM assets WHERE id=?',upload.asset_id),assetsBefore);
 assert.deepEqual(await h.storage.exec('SELECT * FROM renditions WHERE asset_id=? ORDER BY id',upload.asset_id),renditionsBefore);
}
