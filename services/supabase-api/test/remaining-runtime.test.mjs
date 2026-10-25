import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { startHarness, enroll, captureProofs, faceVerifierFixture, fixturePng, sha256, closeHarnesses } from './runtime-harness.mjs';

after(closeHarnesses);
const key=name=>name+'-'+crypto.randomUUID();
const vars={APPLE_BUNDLE_ID:'app.lovelies.ios',APPLE_APP_ID:'987654321',APPLE_SUBSCRIPTION_PRODUCT_ID:'app.lovelies.pro.monthly',GOOGLE_PLAY_PACKAGE_NAME:'app.lovelies.android',GOOGLE_PLAY_SUBSCRIPTION_PRODUCT_ID:'app.lovelies.pro.monthly'};
async function until(read,predicate,timeout=10000){const end=Date.now()+timeout;for(;;){const value=await read();if(predicate(value))return value;if(Date.now()>end)throw new Error('waiting for remaining backend state: '+JSON.stringify(value));await new Promise(resolve=>setTimeout(resolve,25));}}
async function administrator(h){const person=await enroll(h);await h.storage.exec('UPDATE accounts SET roles_json=? WHERE id=?','["user","admin"]',person.accountId);const challenge=await h.json('/auth/face/challenge',{body:{face_handle:person.faceHandle,device_id:person.deviceId}},201);const signed=await captureProofs(h,challenge,person.keys.privateKey);const credentials=await h.json('/auth/face/complete',{body:signed});return {...person,token:credentials.access_token};}
const tx=(account,extra={})=>({bundleId:vars.APPLE_BUNDLE_ID,productId:vars.APPLE_SUBSCRIPTION_PRODUCT_ID,type:'Auto-Renewable Subscription',inAppOwnershipType:'PURCHASED',appAccountToken:account,environment:'Production',purchaseDate:Date.now()-1000,expiresDate:Date.now()+86400000,signedDate:Date.now(),originalTransactionId:key('original'),transactionId:key('transaction'),...extra});
const verifier=(proofs,extra)=>async(envelope,path)=>{assert.equal(envelope.protocol,'lovelies-store-verifier-v1');assert.equal(envelope.input_hash,await sha256(new TextEncoder().encode(stable(envelope.input))));assert.equal(envelope.input.bundle_id,vars.APPLE_BUNDLE_ID);assert.equal(envelope.input.app_id,987654321);await extra?.(envelope,path);const payload=proofs.get(envelope.input.signed_payload);assert(payload,'missing test-only verified proof');return {...envelope,verified:true,payload};};
function stable(value){if(Array.isArray(value))return '['+value.map(stable).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}';return JSON.stringify(value);}
async function subscribe(h,person,signed='store.transaction.payload',extra={}){return h.json('/subscriptions/apple/transactions',{token:person.token,body:{product_id:vars.APPLE_SUBSCRIPTION_PRODUCT_ID,signed_transaction:signed,operation_key:key('store'),...extra}});}
function processor(envelope){return {attempt_id:envelope.attempt_id,nonce:envelope.nonce,asset_id:envelope.asset_id,source_version:envelope.source_version,source_checksum_sha256:envelope.source_checksum_sha256,model_version:envelope.model_version,engine_identity:envelope.engine_identity,preview:{bytes_base64:Buffer.from(fixturePng('preview:'+envelope.asset_id)).toString('base64'),content_type:'image/png',width:1,height:1},matches:envelope.profiles.map(profile=>({recipient_id:profile.account_id,profile_id:profile.profile_id,profile_version:profile.revision,model_version:profile.model_id}))};}
async function preferences(h,person){await h.json('/me/photo-preferences',{token:person.token,body:{receive_matches:true,photo_matching_consent:true,processing_consent:true,policy_version:'photo-policy-fixture-v1',operation_key:key('preferences')}});}
async function upload(h,owner){const bytes=fixturePng(key('original'));const reserved=await h.json('/uploads/session',{token:owner.token,body:{content_type:'image/png',byte_size:bytes.byteLength,source:'personal',title:'Owned source fixture',operation_key:key('reserve')}},201);await h.json(reserved.upload_url,{token:owner.token,raw:bytes,method:'PUT',headers:{'content-type':'image/png'}});await h.json(reserved.complete_url,{token:owner.token,body:{operation_key:key('complete')}},202);const done=await until(()=>h.json('/uploads/'+reserved.asset_id+'/status',{token:owner.token}),value=>['ready','failed'].includes(value.status));assert.equal(done.status,'ready',done.error_code);return {...reserved,bytes};}
async function requestShare(h,owner,person,asset){const snapshot=(await h.community(owner.token,'sharing.snapshot',{asset_ids:[asset],operation_key:key('snapshot')})).snapshot;const preview=(await h.community(owner.token,'sharing.preview',{snapshot_id:snapshot.id,snapshot_version:snapshot.version,draft_version:1,selected_asset_ids:[asset],selected_recipient_ids:[person.accountId],excluded_pairs:[],operation_key:key('preview')})).preview;const receipt=await h.community(owner.token,'sharing.commit',{preview_id:preview.id,preview_version:preview.version,draft_version:1,operation_key:key('commit')});return receipt.recipients[0].request_id;}

test('native store requests require explicit provider config; anonymous access and external checkout stay denied',async()=>{
  const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});try{const anonymous=await h.anonymous({adult:true}),owner=await enroll(h);
    assert.equal((await h.json('/subscriptions/apple/transactions',{token:owner.token,body:{product_id:'com.lovelies.memories.pro.monthly',signed_transaction:'a.b.c',operation_key:key('store')}},503)).error.code,'apple_verifier_unconfigured');
    assert.equal((await h.json('/downloads/sign',{token:anonymous.access_token,body:{asset_id:crypto.randomUUID(),operation_key:key('download')}},403)).error.code,'registered_face_required');
    assert.equal((await h.json('/subscriptions/momo-ussd-requests',{token:owner.token,body:{}},404)).error.code,'route_not_found');
    assert.equal((await h.storage.exec('SELECT count(*) n FROM store_subscriptions'))[0].n,0);
  }finally{await h.close();}
});

test('actual PostgreSQL purchase replay, foreign binding, sandbox ineligibility, refund ordering and notification replay',async()=>{
  const proofs=new Map(),h=await startHarness({faceVerifier:faceVerifierFixture,storeVerifier:verifier(proofs),vars,consumeQueue:false});try{
    const owner=await enroll(h),peer=await enroll(h),production=tx(owner.accountId),operation=key('purchase');proofs.set('store.transaction.payload',production);
    const first=await subscribe(h,owner,'store.transaction.payload',{operation_key:operation});assert(first.active&&first.financial_eligible);assert.deepEqual(await subscribe(h,owner,'store.transaction.payload',{operation_key:operation}),first);
    const denied=await h.json('/subscriptions/apple/transactions',{token:peer.token,body:{product_id:vars.APPLE_SUBSCRIPTION_PRODUCT_ID,signed_transaction:'store.transaction.payload',operation_key:key('foreign')}},403);assert.equal(denied.error.code,'apple_account_mismatch');
    assert.equal((await h.json('/me/entitlements',{token:owner.token})).pro_active,true);
    proofs.set('sandbox.transaction.payload',tx(peer.accountId,{environment:'Sandbox'}));assert.equal((await subscribe(h,peer,'sandbox.transaction.payload')).financial_eligible,false);assert.equal((await h.json('/me/entitlements',{token:peer.token})).pro_active,false);
    const refund={...production,signedDate:Date.now()+10,revocationDate:Date.now()};proofs.set('refund.transaction.payload',refund);const event=key('refund-notification');proofs.set('refund.notification.payload',{notificationUUID:event,signedDate:Date.now()+10,data:{bundleId:vars.APPLE_BUNDLE_ID,appAppleId:987654321,environment:'Production',signedTransactionInfo:'refund.transaction.payload'}});
    const notification={body:{signedPayload:'refund.notification.payload'}};assert.equal((await h.json('/subscriptions/apple/notifications',notification)).duplicate,false);assert.equal((await h.json('/subscriptions/apple/notifications',notification)).duplicate,true);
    assert.equal((await h.json('/me/entitlements',{token:owner.token})).pro_active,false);assert.equal((await subscribe(h,owner)).stale,true);assert.equal((await h.json('/me/entitlements',{token:owner.token})).pro_active,false);
    assert.equal((await h.storage.exec('SELECT count(*) n FROM store_subscriptions'))[0].n,2);
  }finally{await h.close();}
});

test('current production entitlement releases actual R2 original bytes and refund invalidates a prior capability',async()=>{
  const proofs=new Map(),h=await startHarness({faceVerifier:faceVerifierFixture,photoProcessor:processor,storeVerifier:verifier(proofs),vars});try{
    const owner=await enroll(h),peer=await enroll(h);
    // Historical stored roles cannot break ordinary processing or signed downloads.
    await h.storage.exec('UPDATE accounts SET roles_json=? WHERE id=?',JSON.stringify(['user','photographer']),owner.accountId);
    await preferences(h,owner);await preferences(h,peer);const photo=await upload(h,owner);
    assert.equal((await h.json('/downloads/sign',{token:owner.token,body:{asset_id:photo.asset_id,operation_key:key('download')}},403)).error.code,'missing_entitlement');
    const purchase=tx(owner.accountId);proofs.set('store.transaction.payload',purchase);await subscribe(h,owner);
    const ticket=await h.json('/downloads/sign',{token:owner.token,body:{asset_id:photo.asset_id,operation_key:key('download')}});assert(!ticket.download_url.includes('quarantine'));const response=await h.request(new URL(ticket.download_url).pathname);assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store, private');assert.deepEqual(new Uint8Array(await response.arrayBuffer()),photo.bytes);
    assert.equal((await h.storage.exec('SELECT count(*) n FROM download_records'))[0].n,1);
    await h.json('/downloads/sign',{token:peer.token,body:{asset_id:photo.asset_id,operation_key:key('foreign-download')}},403);
    proofs.set('refund.transaction.payload',{...purchase,signedDate:Date.now()+10,revocationDate:Date.now()});await subscribe(h,owner,'refund.transaction.payload');await h.json(new URL(ticket.download_url).pathname,{},403);assert.equal((await h.storage.exec('SELECT count(*) n FROM download_records'))[0].n,1);
  }finally{await h.close();}
});

test('provider-await logout fences a late verified transaction before durable state publication',async()=>{
  const proofs=new Map();let entered,release;const enteredPromise=new Promise(resolve=>{entered=resolve;}),releasePromise=new Promise(resolve=>{release=resolve;});
  const h=await startHarness({faceVerifier:faceVerifierFixture,storeVerifier:verifier(proofs,async()=>{entered();await releasePromise;}),vars,consumeQueue:false});try{
    const owner=await enroll(h);proofs.set('store.transaction.payload',tx(owner.accountId));const pending=h.request('/subscriptions/apple/transactions',{token:owner.token,body:{product_id:vars.APPLE_SUBSCRIPTION_PRODUCT_ID,signed_transaction:'store.transaction.payload',operation_key:key('late')}});
    await enteredPromise;await h.json('/auth/logout',{token:owner.token,body:{}});release();const response=await pending;assert.equal(response.status,401);await response.arrayBuffer();assert.equal((await h.storage.exec('SELECT count(*) n FROM store_subscriptions'))[0].n,0);
  }finally{release?.();await h.close();}
});

test('actual support ownership and revision review survive retired photographer route removal',async()=>{
  const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});try{
    const owner=await enroll(h),peer=await enroll(h),admin=await administrator(h);const support=await h.json('/support/requests',{token:owner.token,body:{subject:'Upload help',details:'Please inspect this account',operation_key:key('support')}},201);
    assert.equal((await h.json('/support/requests',{token:owner.token})).support_requests.length,1);assert.equal((await h.json('/support/requests',{token:peer.token})).support_requests.length,0);await h.json('/support/requests/'+support.id,{token:peer.token},404);await h.json('/admin/support-requests',{token:owner.token},403);
    const reviewed=await h.json('/admin/support-requests/'+support.id+'/approve',{token:admin.token,body:{expected_revision:1,review_notes:'Verified account request',operation_key:key('review')}});assert.equal(reviewed.support_request.status,'resolved');await h.json('/admin/support-requests/'+support.id+'/approve',{token:admin.token,body:{expected_revision:1,operation_key:key('stale')}},409);
    for(const path of ['/me/photographer-request','/me/photographer-access/activate','/admin/photographer-requests',`/admin/photographer-requests/${crypto.randomUUID()}/approve`,`/admin/photographer-requests/${crypto.randomUUID()}/reject`]) {
      for(const token of [owner.token,admin.token]) {
        assert.equal((await h.json(path,{token},404)).error.code,'route_not_found');
        assert.equal((await h.json(path,{token,body:{operation_key:key('retired')}},404)).error.code,'route_not_found');
      }
    }
    assert.equal((await h.storage.exec("SELECT count(*) n FROM information_schema.tables WHERE table_schema='lovelies_private' AND table_name='photographer_requests'"))[0].n,0);
    assert.deepEqual((await h.json('/me',{token:owner.token})).roles,['user']);
  }finally{await h.close();}
});

test('real reviewed acceptance grants are revoked bilaterally by block and stay revoked after removal',async()=>{
  const h=await startHarness({faceVerifier:faceVerifierFixture,photoProcessor:processor});try{
    const owner=await enroll(h),person=await enroll(h);await preferences(h,owner);await preferences(h,person);const photo=await upload(h,owner),requestId=await requestShare(h,owner,person,photo.asset_id);
    await h.community(person.token,'request.decide',{request_id:requestId,decision:'accept',operation_key:key('accept')});assert.equal((await h.json('/me/gallery',{token:person.token})).gallery_items.length,1);
    await h.json('/me/blocks/'+owner.accountId,{token:person.token,body:{operation_key:key('block')}});assert.equal((await h.json('/me/blocks',{token:person.token})).items.length,1);assert.equal((await h.json('/me/gallery',{token:person.token})).gallery_items.length,0);
    const result=await h.json('/me/blocks/'+owner.accountId,{method:'DELETE',token:person.token,body:{operation_key:key('remove')}});assert.equal(result.access_restored,false);assert.equal((await h.json('/me/gallery',{token:person.token})).gallery_items.length,0);assert.equal((await h.storage.exec('SELECT count(*) n FROM media_grants WHERE active=1'))[0].n,0);
  }finally{await h.close();}
});

test('durable private notification outbox uses an accepted provider operation receipt and preserves preference mutes',async()=>{
  let sends=0;const h=await startHarness({faceVerifier:faceVerifierFixture,pushService:async request=>{assert.equal(request.method,'POST');const body=await request.json();assert.equal(body.notification.title,'Your support request was reviewed');assert(!JSON.stringify(body.notification).includes('private-push-token'));sends++;return {status:'accepted',operation_key:body.operation_key,provider_message_id:key('provider')};}});try{
    const owner=await enroll(h),admin=await administrator(h);
    await h.json('/me/notification-settings',{method:'PATCH',token:owner.token,body:{match_alerts:false,operation_key:key('mute')}});await h.json('/me/notification-settings',{method:'PATCH',token:owner.token,body:{payment_alerts:false,operation_key:key('mute')}});const settings=await h.json('/me/notification-settings',{token:owner.token});assert.equal(settings.match_alerts,false);assert.equal(settings.payment_alerts,false);assert.equal(settings.support_alerts,true);
    await h.json('/me/push-devices',{token:owner.token,body:{platform:'ios',push_token:'private-push-token-'+crypto.randomUUID(),operation_key:key('push')}});
    const support=await h.json('/support/requests',{token:owner.token,body:{subject:'Delivery help',details:'Please review current support state',operation_key:key('support')}},201);await h.json('/admin/support-requests/'+support.id+'/approve',{token:admin.token,body:{expected_revision:1,operation_key:key('review')}});
    await h.alarm();const rows=await until(()=>h.storage.exec('SELECT status,provider_receipt FROM notification_deliveries'),value=>value.length&&value[0].status==='accepted');assert(rows[0].provider_receipt);assert.equal(sends,1);assert.equal((await h.json('/me/notifications',{token:owner.token})).items.length,1);
    const peer=await enroll(h);assert.equal((await h.json('/me/notifications',{token:peer.token})).items.length,0);const exportRows=await h.storage.exec('SELECT payload_json FROM operations WHERE source=?','notification');assert(exportRows.length); // server-private store only; privacy projection below excludes token.
  }finally{await h.close();}
});

test('actual PostgreSQL/R2 retention honors a legal hold, retires source access and verifies physical deletion',async()=>{
  const h=await startHarness({faceVerifier:faceVerifierFixture,photoProcessor:processor});try{
    const owner=await enroll(h),admin=await administrator(h);await preferences(h,owner);const photo=await upload(h,owner);await h.storage.exec('UPDATE assets SET created_at=? WHERE id=?',Date.now()-61*86400000,photo.asset_id);
    const rule=(await h.json('/admin/assets/'+photo.asset_id+'/retention',{token:admin.token})).asset_retention;await h.json('/admin/assets/'+photo.asset_id+'/retention',{method:'PATCH',token:admin.token,body:{expected_version:rule.version,legal_hold:true,operation_key:key('hold')}});await h.alarm();assert.equal((await h.storage.exec('SELECT deleted_at FROM assets WHERE id=?',photo.asset_id))[0].deleted_at,null);
    const held=(await h.json('/admin/assets/'+photo.asset_id+'/retention',{token:admin.token})).asset_retention;await h.json('/admin/assets/'+photo.asset_id+'/retention',{method:'PATCH',token:admin.token,body:{expected_version:held.version,legal_hold:false,operation_key:key('release')}});await h.alarm();assert.equal((await h.storage.exec('SELECT status FROM retention_jobs WHERE asset_id=?',photo.asset_id))[0].status,'verified');
    const source=(await h.storage.exec('SELECT object_key,status,deleted_at FROM assets WHERE id=?',photo.asset_id))[0],preview=(await h.storage.exec('SELECT object_key FROM renditions WHERE asset_id=?',photo.asset_id))[0];assert.equal(source.status,'expired');assert(source.deleted_at);assert.equal(await (await h.mf.getR2Bucket('QUARANTINE')).head(source.object_key),null);assert.equal(await (await h.mf.getR2Bucket('PHOTOS')).head(preview.object_key),null);await h.json('/previews/sign',{token:owner.token,body:{asset_id:photo.asset_id}},404);
  }finally{await h.close();}
});

test('privacy export excludes new provider/push/private media secrets and owner erasure clears report/hold FKs',async()=>{
  const proofs=new Map(),h=await startHarness({faceVerifier:faceVerifierFixture,photoProcessor:processor,storeVerifier:verifier(proofs),vars});try{
    const owner=await enroll(h),admin=await administrator(h);await preferences(h,owner);const photo=await upload(h,owner);proofs.set('store.transaction.payload',tx(owner.accountId));await subscribe(h,owner);await h.json('/me/push-devices',{token:owner.token,body:{platform:'ios',push_token:'private-push-token-'+crypto.randomUUID(),operation_key:key('push')}});
    const report=await h.json('/safety/reports',{token:owner.token,body:{asset_id:photo.asset_id,reason:'Please review this specific photograph',operation_key:key('report')}},201);await h.json('/admin/safety/reports/'+report.id+'/resolve',{token:admin.token,body:{action:'hold',expected_revision:1,reason:'Reviewed scope hold',operation_key:key('hold')}});
    const exported=(await h.json('/privacy/export',{token:owner.token,body:{operation_key:key('export')}},201)).privacy_request;await h.json('/privacy-requests/'+exported.id+'/approve',{token:admin.token,body:{operation_key:key('review')}});
    // This harness operates the real durable queue. Approval can already have
    // started its worker before a manual process request arrives; reconcile the
    // authoritative result instead of requiring a second competing executor.
    await until(()=>h.json('/privacy-requests/'+exported.id,{token:admin.token}),value=>value.privacy_request.status==='completed');
    const grant=await h.json('/privacy-exports/'+exported.id+'/grant',{token:owner.token,body:{}});const response=await h.request(grant.grant_path,{token:owner.token}),text=await response.text();assert.equal(response.status,200);for(const secret of ['private-push-token','store.transaction.payload','template_key','payload_json','token_hash','profiles_json'])assert(!text.includes(secret),secret);assert(text.includes('store_transactions'));
    const erased=(await h.json('/privacy/account-deletion',{token:owner.token,body:{operation_key:key('erase')}},201)).privacy_request;await h.json('/privacy-requests/'+erased.id+'/approve',{token:admin.token,body:{operation_key:key('review')}});await until(()=>h.json('/privacy-requests/'+erased.id,{token:admin.token}),value=>value.privacy_request.status==='completed');assert.equal((await h.storage.exec('SELECT asset_id,reason FROM safety_reports WHERE id=?',report.id))[0].asset_id,null);assert.equal((await h.storage.exec('SELECT count(*) n FROM moderation_holds WHERE asset_id=?',photo.asset_id))[0].n,0);assert.deepEqual(await h.storage.exec('SELECT c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=\'lovelies_private\' AND c.contype=\'f\' AND NOT c.convalidated'),[]);assert.equal((await h.storage.exec('SELECT active FROM store_subscriptions WHERE account_id=?',owner.accountId))[0].active,0);await h.json('/me',{token:owner.token},401);
  }finally{await h.close();}
});
