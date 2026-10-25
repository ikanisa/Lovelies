/** Real public API + authenticated model HTTP. With the explicit Storage flag,
 * actual disposable PostgreSQL and Supabase Storage HTTP are mandatory. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sha256} from './runtime-harness.mjs';
import {createOpenFaceRuntime,enrollReal,loginReal,sendRealCaptures,pause} from './openface-runtime.mjs';
import {processPhotoJob} from '../src/processing.ts';

const enabled=process.env.RUN_OPENFACE_HTTP_TESTS==='1';
const actualStorage=process.env.RUN_OPENFACE_STORAGE_HTTP_TESTS==='1';
const key=()=>crypto.randomUUID();
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
async function reached(signal){let timer;try{await Promise.race([signal.promise,new Promise((_,fail)=>{
 timer=setTimeout(()=>fail(new Error('Real inference reply was not reached')),30_000);
})]);}finally{clearTimeout(timer);}}

test('real OpenFace signed enrollment/login, exact grants and stale-state/privacy fences through the selected transports',
 {skip:!enabled,timeout:240_000},async t=>{
 const h=await createOpenFaceRuntime({consumeQueue:false,requireActualStorage:actualStorage});t.after(()=>h.close());
 const {captures,otherCaptures,loaded}=h;
 assert.equal((await h.json('/ready')).inference_ready,true);
 let owner=await enrollReal(h,otherCaptures),recipient=await enrollReal(h,captures);
 const preferences=(person,enabled=true)=>h.json('/me/photo-preferences',{token:person.token,body:{
  policy_version:h.env.PHOTO_CONSENT_POLICY_VERSION,receive_matches:enabled,processing_consent:true,
  photo_matching_consent:enabled,operation_key:key()}});
 for(const actor of [owner,recipient])await preferences(actor);
 const templateRows=await h.storage.exec('SELECT template_key,template_digest FROM face_profiles');
 assert.equal(templateRows.length,2);
 for(const row of templateRows){
  const object=await h.env.PHOTOS.get(row.template_key),bytes=await object.arrayBuffer();
  assert.equal(await sha256(bytes),row.template_digest);
  const template=JSON.parse(new TextDecoder().decode(bytes));
  assert.equal(template.protocol,'lovelies-face-template-v2');
  assert.equal(template.processing_fingerprint,loaded.processing_fingerprint);
  if(h.storageOrigin){
   const unauthenticated=await fetch(h.storageOrigin+'/storage/v1/object/authenticated/'+h.storageNames.PHOTOS+'/'+row.template_key);
   assert([400,401,403,404].includes(unauthenticated.status),'Actual private Storage must deny a request without bearer authority');
   await unauthenticated.body?.cancel();
   const publicRead=await fetch(h.storageOrigin+'/storage/v1/object/public/'+h.storageNames.PHOTOS+'/'+row.template_key);
   assert([400,401,403,404].includes(publicRead.status),'A private biometric object must not become a public Storage object');
   await publicRead.body?.cancel();
  }
 }
 const photo=captures[4],upload=await h.json('/uploads/session',{token:owner.token,body:{source:'personal',content_type:'image/jpeg',
  byte_size:photo.length,title:'Declared engineering portrait fixture',operation_key:key()}},201);
 await h.json(upload.upload_url,{method:'PUT',token:owner.token,raw:photo,headers:{'content-type':'image/jpeg'}});
 const completed=await h.json(upload.complete_url,{token:owner.token,body:{operation_key:key()}},202);
 await processPhotoJob({attempt_id:completed.attempt_id},h.app);
 let state;const processingDeadline=Date.now()+20_000;
 do{state=await h.json(`/uploads/${upload.asset_id}/status`,{token:owner.token});
  if(['ready','failed'].includes(state.status))break;await pause(20);
 }while(Date.now()<processingDeadline);
 assert.equal(state.status,'ready',state.error_code);
 assert.equal((await h.json('/me/gallery',{token:recipient.token})).gallery_items.length,0);
 await h.json('/community/media/'+upload.asset_id+'/preview',{token:recipient.token},403);
 const snapshot=(await h.community(owner.token,'sharing.snapshot',{asset_ids:[upload.asset_id],operation_key:key()})).snapshot;
 assert.equal(snapshot.pairs.length,1);
 const preview=(await h.community(owner.token,'sharing.preview',{snapshot_id:snapshot.id,snapshot_version:snapshot.version,
  selected_asset_ids:[upload.asset_id],selected_recipient_ids:[recipient.account_id],excluded_pairs:[],draft_version:1,operation_key:key()})).preview;
 const commit={preview_id:preview.id,preview_version:preview.version,draft_version:1,operation_key:key()};
 const first=await h.community(owner.token,'sharing.commit',commit);
 assert.equal(first.status,'pending_acceptance');
 assert.deepEqual(await h.community(owner.token,'sharing.commit',commit),first);
 assert.equal((await h.storage.exec('SELECT COUNT(*) n FROM media_grants'))[0].n,0);
 const inbox=await h.community(recipient.token,'inbox'),request=inbox.items.find(item=>item.person.id===owner.account_id);
 assert(request);
 const acceptance={request_id:request.id,decision:'accept',operation_key:key()};
 const accepted=await h.community(recipient.token,'request.decide',acceptance);
 assert.deepEqual(await h.community(recipient.token,'request.decide',acceptance),accepted);
 assert.equal((await h.storage.exec('SELECT COUNT(*) n FROM media_grants'))[0].n,1);
 assert.equal((await h.json('/me/gallery',{token:recipient.token})).gallery_items.length,1);
 const actualPreview=await h.request('/community/media/'+upload.asset_id+'/preview',{token:recipient.token});
 assert.equal(actualPreview.status,200);assert.equal(actualPreview.headers.get('content-type'),'image/jpeg');
 assert((await actualPreview.arrayBuffer()).byteLength>0);
 await h.json('/downloads/sign',{token:recipient.token,body:{asset_id:upload.asset_id,operation_key:key()}},403);
 await h.json('/auth/logout',{token:recipient.token,body:{}});
 const wrongChallenge=await h.json('/auth/face/challenge',{body:{face_handle:recipient.faceHandle,device_id:recipient.deviceId}},201);
 const wrongProof=await sendRealCaptures(h,recipient,wrongChallenge,[otherCaptures[5]]);
 const wrong=await h.json('/auth/face/complete',{body:wrongProof},401);
 assert.equal(wrong.error.code,'face_verification_failed');
 const challenge=await h.json('/auth/face/challenge',{body:{face_handle:recipient.faceHandle,device_id:recipient.deviceId}},201);
 const proof=await sendRealCaptures(h,recipient,challenge,[captures[5]]);
 const signedIn=await h.json('/auth/face/complete',{body:proof});
 assert.equal(signedIn.account_id,recipient.account_id);
 await h.json('/auth/face/complete',{body:proof},409);
 recipient={...recipient,...signedIn,token:signedIn.access_token};

 // A barrier holds an already completed real inference reply. State changes below
 // use the actual PostgreSQL pool when configured; no verdict is fabricated.
 const uploadForRace=async()=>{
  const still=captures[4],reserved=await h.json('/uploads/session',{token:owner.token,body:{source:'personal',
   content_type:'image/jpeg',byte_size:still.length,title:'Declared pending authority fixture',operation_key:key()}},201);
  await h.json(reserved.upload_url,{method:'PUT',token:owner.token,raw:still,headers:{'content-type':'image/jpeg'}});
  const result=await h.json(reserved.complete_url,{token:owner.token,body:{operation_key:key()}},202);
  return {...reserved,attempt_id:result.attempt_id};
 };
 const assertUnpublished=async item=>{
  for(const table of ['candidates','match_origins','renditions','media_grants'])
   assert.equal((await h.storage.exec('SELECT COUNT(*) n FROM '+table+' WHERE asset_id=?',item.asset_id))[0].n,0,
    table+' must not publish a stale inference reply');
 };
 for(const scenario of ['profile','consent','session','source','lease'])await t.test('pending real inference fences changed '+scenario,async()=>{
  const item=await uploadForRace(),entered=deferred(),release=deferred();let calls=0;
  const original=h.env.PHOTO_PROCESSOR;
  h.env.PHOTO_PROCESSOR={fetch:async request=>{
   const response=await original.fetch(request);
   if(++calls===1){assert.equal(response.status,200);entered.resolve();await release.promise;}
   return response;
  }};
  const pending=processPhotoJob({attempt_id:item.attempt_id},h.app).then(()=>({}),error=>({error}));
  let previous;
  try{
   await reached(entered);
   if(scenario==='profile'){
    previous=(await h.storage.exec('SELECT revision FROM face_profiles WHERE account_id=?',recipient.account_id))[0].revision;
    await h.storage.exec('UPDATE face_profiles SET revision=? WHERE account_id=?',key(),recipient.account_id);
   }else if(scenario==='consent')await preferences(recipient,false);
   else if(scenario==='session')await h.json('/auth/logout',{token:owner.token,body:{}});
   else if(scenario==='source'){
    const source=(await h.storage.exec('SELECT object_key FROM assets WHERE id=?',item.asset_id))[0];
    await h.env.QUARANTINE.delete(source.object_key);assert.equal(await h.env.QUARANTINE.head(source.object_key),null);
   }else{
    // A known later lease wins; the held worker may not publish after takeover.
    await h.storage.exec('UPDATE processing_attempts SET lease_token=?,lease_until=0 WHERE id=?',key(),item.attempt_id);
    await processPhotoJob({attempt_id:item.attempt_id},h.app);
   }
   release.resolve();const result=await pending;assert(result.error,'Held stale worker must reject publication');
   if(scenario==='lease'){
    assert.equal((await h.storage.exec('SELECT status FROM processing_attempts WHERE id=?',item.attempt_id))[0].status,'completed');
    assert.equal((await h.storage.exec('SELECT COUNT(*) n FROM renditions WHERE asset_id=?',item.asset_id))[0].n,1);
    assert.equal((await h.storage.exec('SELECT COUNT(*) n FROM candidates WHERE asset_id=?',item.asset_id))[0].n,1);
    await processPhotoJob({attempt_id:item.attempt_id},h.app);
    assert.equal((await h.storage.exec('SELECT COUNT(*) n FROM renditions WHERE asset_id=?',item.asset_id))[0].n,1);
    assert.equal((await h.storage.exec('SELECT COUNT(*) n FROM media_grants WHERE asset_id=?',item.asset_id))[0].n,0);
   }else await assertUnpublished(item);
  }finally{
   release.resolve();await pending;h.env.PHOTO_PROCESSOR=original;
   if(scenario==='profile'&&previous)await h.storage.exec('UPDATE face_profiles SET revision=? WHERE account_id=?',previous,recipient.account_id);
   if(scenario==='consent')await preferences(recipient);
   if(scenario==='session')owner=await loginReal(h,owner,otherCaptures[5]);
  }
 });
 await t.test('actual private media cleanup requires DELETE and confirmed absence',async()=>{
  // Test-only provisioning creates an independent local operator; the actual
  // signed fresh-face login is what receives that operator role claim.
  await h.storage.exec('UPDATE accounts SET roles_json=? WHERE id=?',JSON.stringify(['user','admin']),recipient.account_id);
  recipient=await loginReal(h,recipient,captures[5]);assert(recipient.roles.includes('admin'));
  const objects=[
   ...await h.storage.exec("SELECT 'PHOTOS' bucket,template_key object_key FROM face_profiles WHERE account_id=?",owner.account_id),
   ...await h.storage.exec("SELECT 'QUARANTINE' bucket,object_key FROM assets WHERE owner_id=?",owner.account_id),
   ...await h.storage.exec("SELECT 'PHOTOS' bucket,r.object_key FROM renditions r JOIN assets a ON a.id=r.asset_id WHERE a.owner_id=?",owner.account_id),
  ];
  assert(objects.length>=4,'Reference, original and preview cleanup must be exercised');
  const requested=(await h.json('/privacy/account-deletion',{token:owner.token,body:{operation_key:key()}},201)).privacy_request;
  await h.json('/privacy-requests/'+requested.id+'/approve',{token:recipient.token,body:{operation_key:key()}});
  const completed=await h.json('/privacy-requests/'+requested.id+'/process',{token:recipient.token,body:{}});
  assert.equal(completed.privacy_request.status,'completed');
  for(const object of objects)assert.equal(await h.env[object.bucket].head(object.object_key),null,'Owned private object must be absent after cleanup');
  assert.equal((await h.storage.exec("SELECT COUNT(*) n FROM cleanup_intents WHERE request_id=? AND status<>'verified'",requested.id))[0].n,0);
  assert.equal((await h.storage.exec('SELECT COUNT(*) n FROM sessions WHERE account_id=?',owner.account_id))[0].n,0);
  assert.equal((await h.storage.exec('SELECT COUNT(*) n FROM face_profiles WHERE account_id=?',owner.account_id))[0].n,0);
  await h.json('/me',{token:owner.token},401);
 });
 t.diagnostic('Selected transport scope: '+JSON.stringify(h.transportScope)+
  '; transformed supplied portrait fixtures; no hosted, physical-device, camera, representative accuracy or release acceptance.');
});
