import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { startHarness, enroll, faceVerifierFixture, fixturePng, closeHarnesses } from './runtime-harness.mjs';

after(closeHarnesses);

const key = prefix => `${prefix}-${crypto.randomUUID()}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
async function until(read, predicate, timeout = 10_000) {
  const deadline = Date.now()+timeout;
  for (;;) {
    const value = await read(); if (predicate(value)) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for state: ${JSON.stringify(value)}`);
    await sleep(20);
  }
}
function processorResult(envelope, recipients = envelope.profiles.map(profile => profile.account_id)) {
  return { attempt_id: envelope.attempt_id, nonce: envelope.nonce, asset_id: envelope.asset_id,
    source_version: envelope.source_version, source_checksum_sha256: envelope.source_checksum_sha256,
    model_version: envelope.model_version,
    preview: { bytes_base64: Buffer.from(fixturePng(envelope.asset_id)).toString('base64'), content_type: 'image/png', width: 1, height: 1 },
    matches: envelope.profiles.filter(profile => recipients.includes(profile.account_id)).map(profile => ({
      recipient_id: profile.account_id, profile_id: profile.profile_id, profile_version: profile.revision, model_version: profile.model_id })) };
}
async function preferences(h, person, extra = {}) {
  return h.json('/me/photo-preferences',{ token: person.token,body: {
    receive_matches: true,photo_matching_consent: true,processing_consent: true,
    policy_version: 'photo-policy-fixture-v1',operation_key: key('preferences'),...extra } });
}
async function upload(h, owner, plan, recipients, { batch = crypto.randomUUID(),source = 'personal',complete = true } = {}) {
  const bytes = fixturePng(crypto.randomUUID());
  const reserved = await h.json('/uploads/session',{token: owner.token,body: {
    content_type:'image/png',byte_size:bytes.byteLength,upload_batch_id:batch,source,
    title:'Fixture photo',operation_key:key('upload') }},201);
  plan.set(reserved.asset_id,recipients);
  await h.json(reserved.upload_url,{token:owner.token,raw:bytes,method:'PUT',headers:{'content-type':'image/png'}});
  if (complete) {
    await h.json(reserved.complete_url,{token:owner.token,body:{operation_key:key('complete')}},202);
    const state = await until(() => h.json(`/uploads/${reserved.asset_id}/status`,{token:owner.token}),
      value => ['ready','failed'].includes(value.status));
    assert.equal(state.status,'ready',state.error_code);
    assert.equal(state.processing_creates_access,false);
  }
  return reserved;
}
async function fixture() {
  const plan = new Map();
  const h = await startHarness({faceVerifier:faceVerifierFixture,
    photoProcessor: envelope => processorResult(envelope,plan.get(envelope.asset_id) ?? [])});
  const owner = await enroll(h), aline = await enroll(h), eric = await enroll(h);
  for (const person of [owner,aline,eric]) await preferences(h,person);
  await h.storage.exec('UPDATE accounts SET name=? WHERE id=?','Aline',aline.accountId);
  await h.storage.exec('UPDATE accounts SET name=? WHERE id=?','Eric',eric.accountId);
  return {h,plan,owner,aline,eric};
}
async function reviewed(h,owner,assetIds,recipientIds,excludedPairs = []) {
  const snap = (await h.community(owner.token,'sharing.snapshot',{asset_ids:assetIds,operation_key:key('snapshot')})).snapshot;
  const body = {snapshot_id:snap.id,snapshot_version:snap.version,draft_version:1,
    selected_asset_ids:assetIds,selected_recipient_ids:recipientIds,excluded_pairs:excludedPairs,operation_key:key('preview')};
  const preview = (await h.community(owner.token,'sharing.preview',body)).preview;
  return {snap,preview,body};
}

test('PostgreSQL/memory-storage/job-queue P1-P4 review creates only Aline P1/P2 and Eric P3 after exclusions and acceptance',async () => {
  const {h,plan,owner,aline,eric} = await fixture();
  try {
    const batch = crypto.randomUUID();
    const photos = [];
    for (const recipients of [[aline.accountId,eric.accountId],[aline.accountId],[eric.accountId],[aline.accountId,eric.accountId]])
      photos.push((await upload(h,owner,plan,recipients,{batch})).asset_id);
    const [p1,p2,p3,p4] = photos;
    assert.equal((await h.json('/me/gallery',{token:aline.token})).gallery_items.length,0);
    assert.equal((await h.storage.exec('SELECT COUNT(*) n FROM media_grants'))[0].n,0);
    const snap = (await h.community(owner.token,'sharing.snapshot',{upload_batch_id:batch,operation_key:key('snapshot')})).snapshot;
    assert.equal(snap.pairs.length,6); assert.equal(snap.scope.has_more,false);
    assert.deepEqual(new Set(snap.recipients.map(person => person.name)),new Set(['Aline','Eric']));
    assert(snap.assets.every(asset => asset.width===1 && asset.height===1));
    assert(snap.pairs.every(pair => !('origin_id' in pair) && !('profile_digest' in pair)));
    const empty = await h.community(owner.token,'sharing.preview',{snapshot_id:snap.id,snapshot_version:snap.version,draft_version:1,
      selected_asset_ids:[],selected_recipient_ids:[aline.accountId],excluded_pairs:[],operation_key:key('empty')});
    assert.equal(empty.status,'empty'); assert.deepEqual(empty.totals,{photos:0,recipients:0,pairs:0}); assert(!empty.preview);
    const view = (await h.community(owner.token,'sharing.preview',{snapshot_id:snap.id,snapshot_version:snap.version,draft_version:2,
      selected_asset_ids:[p1,p2,p3],selected_recipient_ids:[aline.accountId,eric.accountId],
      excluded_pairs:[{asset_id:p1,recipient_id:eric.accountId}],operation_key:key('preview')})).preview;
    assert.deepEqual(view.totals,{photos:3,recipients:2,pairs:3});
    const subset = id => view.recipients.find(person => person.recipient_id===id).asset_ids;
    assert.deepEqual(new Set(subset(aline.accountId)),new Set([p1,p2])); assert.deepEqual(subset(eric.accountId),[p3]);
    const commitKey = key('commit');
    const payload = {preview_id:view.id,preview_version:view.version,draft_version:2,operation_key:commitKey};
    const [first,retry] = await Promise.all([0,1].map(() => h.community(owner.token,'sharing.commit',payload)));
    assert.deepEqual(first,retry); assert.equal(first.status,'pending_acceptance'); assert.equal(first.grants_created,0);
    assert.equal((await h.storage.exec('SELECT COUNT(*) n FROM sharing_requests'))[0].n,2);
    assert.equal((await h.storage.exec('SELECT COUNT(*) n FROM media_grants'))[0].n,0);
    await h.community(owner.token,'sharing.commit',{...payload,draft_version:3},409);
    await h.community(eric.token,'sharing.snapshot',{asset_ids:[p1],operation_key:key('forged')},403);
    const alineRequest = first.recipients.find(person => person.recipient_id===aline.accountId).request_id;
    const ericRequest = first.recipients.find(person => person.recipient_id===eric.accountId).request_id;
    const receipt = await h.community(aline.token,'receipt',{request_id:alineRequest});
    assert.equal(receipt.photo_count,2); assert.deepEqual(receipt.asset_ids,[]); assert.equal(receipt.available_count,0);
    const pending = await h.community(aline.token,'photos.validate',{asset_ids:[p1,p2,p3,p4]});
    assert.deepEqual(pending.authorized_ids,[]);
    await h.json(`/community/media/${p1}/preview`,{token:aline.token},403);
    await h.community(owner.token,'request.decide',{request_id:alineRequest,decision:'accept',operation_key:key('wrong-actor')},403);
    const acceptPayload = {request_id:alineRequest,decision:'accept',operation_key:key('accept')};
    const accepted = await Promise.all([0,1].map(() => h.community(aline.token,'request.decide',acceptPayload)));
    assert.deepEqual(accepted[0],accepted[1]); assert.equal(accepted[0].status,'accepted');
    const partial = await h.community(owner.token,'operation',{operation_key:commitKey});
    assert.equal(partial.status,'partial'); assert.equal(partial.grants_created,2);
    assert.deepEqual(new Set((await h.community(aline.token,'photos.validate',{asset_ids:photos})).authorized_ids),new Set([p1,p2]));
    await h.community(eric.token,'request.decide',{request_id:ericRequest,decision:'accept',operation_key:key('accept')});
    const reconciled = await h.community(owner.token,'operation',{operation_key:commitKey});
    assert.equal(reconciled.status,'access_available'); assert.equal(reconciled.grants_created,3);
    assert.equal((await h.storage.exec('SELECT COUNT(*) n FROM media_grants WHERE active=1'))[0].n,3);
    const consentBefore = (await h.storage.exec('SELECT consent_id FROM face_profiles WHERE account_id=?',aline.accountId))[0].consent_id;
    await preferences(h,owner); await preferences(h,aline);
    assert.equal((await h.storage.exec('SELECT consent_id FROM face_profiles WHERE account_id=?',aline.accountId))[0].consent_id,consentBefore);
    assert.equal((await h.storage.exec('SELECT COUNT(*) n FROM media_grants WHERE active=1'))[0].n,3);
    assert.equal((await h.community(owner.token,'operation',{operation_key:commitKey})).status,'access_available');
    assert.deepEqual(new Set((await h.json('/me/gallery',{token:aline.token})).gallery_items.map(item => item.media_asset_id)),new Set([p1,p2]));
    assert.deepEqual((await h.json('/me/gallery',{token:eric.token})).gallery_items.map(item => item.media_asset_id),[p3]);
    assert.deepEqual(new Set((await h.community(aline.token,'photos',{source:'received',limit:100})).items.map(item=>item.id)),new Set([p1,p2]));
    const bytes = await h.request(`/community/media/${p1}/preview`,{token:aline.token});
    assert.equal(bytes.status,200); assert.equal(bytes.headers.get('content-type'),'image/png');
    assert.deepEqual(new Uint8Array(await bytes.arrayBuffer()),fixturePng(p1));
    const ticket = await h.json('/previews/sign',{token:aline.token,body:{asset_id:p1}});
    assert.equal(ticket.version,(await h.storage.exec('SELECT version FROM assets WHERE id=?',p1))[0].version);
    assert(ticket.rendition_version); assert.equal((await h.request(new URL(ticket.preview_url).pathname)).status,200);
    await h.community(aline.token,'request.decide',{request_id:alineRequest,decision:'revoke',operation_key:key('revoke')});
    await h.json(new URL(ticket.preview_url).pathname,{},403);
    assert.equal((await h.json('/me/gallery',{token:aline.token})).gallery_items.length,0);
    const revoked = await h.community(owner.token,'operation',{operation_key:commitKey});
    assert.equal(revoked.status,'partial'); assert.equal(revoked.recipients.find(person=>person.recipient_id===aline.accountId).available_count,0);
    assert.deepEqual(new Set(revoked.recipients.find(person=>person.recipient_id===aline.accountId).asset_ids),new Set([p1,p2]));
  } finally { await h.close(); }
});

test('current candidate/model, block, source and consent drift require a new review and never grant a changed subset',async () => {
  const {h,plan,owner,aline} = await fixture();
  try {
    const photo = (await upload(h,owner,plan,[aline.accountId])).asset_id;
    let review = await reviewed(h,owner,[photo],[aline.accountId]);
    await h.storage.exec('UPDATE candidates SET version=? WHERE asset_id=?',crypto.randomUUID(),photo);
    const stalePreview = await h.community(owner.token,'sharing.preview',{...review.body,operation_key:key('stale-preview')});
    assert.equal(stalePreview.status,'changed'); assert.equal(stalePreview.requires_review,true);
    const staleCommit = await h.community(owner.token,'sharing.commit',{preview_id:review.preview.id,preview_version:review.preview.version,draft_version:1,operation_key:key('stale-commit')});
    assert.equal(staleCommit.status,'changed'); assert.equal(staleCommit.grants_created,0);
    review = await reviewed(h,owner,[photo],[aline.accountId]);
    const committed = await h.community(owner.token,'sharing.commit',{preview_id:review.preview.id,preview_version:review.preview.version,draft_version:1,operation_key:key('commit')});
    const requestId = committed.recipients[0].request_id;
    await h.storage.exec('UPDATE face_profiles SET model_id=? WHERE account_id=?','changed-matching-model',aline.accountId);
    const denied = await h.community(aline.token,'request.decide',{request_id:requestId,decision:'accept',operation_key:key('stale-accept')},409);
    assert.equal(denied.error.code,'eligibility_changed_review_required');
    assert.equal((await h.storage.exec('SELECT COUNT(*) n FROM media_grants'))[0].n,0);
    await h.storage.exec('UPDATE face_profiles SET model_id=? WHERE account_id=?','face-model-fixture-v1',aline.accountId);
    await h.storage.exec('INSERT INTO blocks(blocker_id,blocked_id,created_at) VALUES(?,?,?)',aline.accountId,owner.accountId,Date.now());
    await h.community(aline.token,'request.decide',{request_id:requestId,decision:'accept',operation_key:key('blocked')},409);
    await h.storage.exec('DELETE FROM blocks WHERE blocker_id=? AND blocked_id=?',aline.accountId,owner.accountId);
    await h.storage.exec('UPDATE assets SET version=? WHERE id=?',crypto.randomUUID(),photo);
    await h.community(aline.token,'request.decide',{request_id:requestId,decision:'accept',operation_key:key('source-changed')},409);
    assert.equal((await h.storage.exec('SELECT COUNT(*) n FROM media_grants'))[0].n,0);
  } finally { await h.close(); }
});

test('processing binds inference-time profile/source evidence and revocation during the private await prevents candidates',async () => {
  for (const mutation of ['profile','credential','source','processor-echo']) {
    let release; let observed;
    const held = new Promise(resolve=>{release=resolve;}); const entered = new Promise(resolve=>{observed=resolve;});
    const plan = new Map();
    const h = await startHarness({faceVerifier:faceVerifierFixture,photoProcessor:async envelope=>{
      observed(envelope); await held;
      const result = processorResult(envelope,plan.get(envelope.asset_id)??[]);
      return mutation==='processor-echo' ? {...result,source_version:crypto.randomUUID()} : result;
    }});
    try {
      const owner = await enroll(h),recipient = await enroll(h);
      await preferences(h,owner); await preferences(h,recipient);
      const photo = await upload(h,owner,plan,[recipient.accountId],{complete:false});
      await h.json(photo.complete_url,{token:owner.token,body:{operation_key:key('complete')}},202);
      await Promise.race([entered,sleep(10_000).then(()=>{throw new Error('processor was not called');})]);
      if (mutation==='profile') await h.storage.exec('UPDATE face_profiles SET template_digest=? WHERE account_id=?','a'.repeat(64),recipient.accountId);
      if (mutation==='credential') await h.json('/auth/logout',{token:owner.token,body:{}});
      if (mutation==='source') await h.storage.exec('UPDATE assets SET checksum_sha256=? WHERE id=?','b'.repeat(64),photo.asset_id);
      release();
      const state = await until(async()=> (await h.storage.exec('SELECT status,error_code FROM processing_attempts WHERE asset_id=?',photo.asset_id))[0],value=>value.status==='failed');
      assert(state.error_code); assert.equal((await h.storage.exec('SELECT COUNT(*) n FROM candidates WHERE asset_id=?',photo.asset_id))[0].n,0);
      assert.equal((await h.storage.exec('SELECT COUNT(*) n FROM media_grants'))[0].n,0);
    } finally { release(); await h.close(); }
  }
});

test('matching preference revocation is permanent for old proposals and accepted media; fresh consent does not restore grants',async () => {
  const {h,plan,owner,aline} = await fixture();
  try {
    const photo = (await upload(h,owner,plan,[aline.accountId])).asset_id;
    const {preview} = await reviewed(h,owner,[photo],[aline.accountId]);
    const outcome = await h.community(owner.token,'sharing.commit',{preview_id:preview.id,preview_version:preview.version,draft_version:1,operation_key:key('commit')});
    await h.community(aline.token,'request.decide',{request_id:outcome.recipients[0].request_id,decision:'accept',operation_key:key('accept')});
    assert.equal((await h.request(`/community/media/${photo}/preview`,{token:aline.token})).status,200);
    await preferences(h,aline,{receive_matches:false,photo_matching_consent:false});
    assert.equal((await h.json('/me/gallery',{token:aline.token})).gallery_items.length,0);
    await h.json(`/community/media/${photo}/preview`,{token:aline.token},403);
    await preferences(h,aline);
    assert.equal((await h.json('/me/gallery',{token:aline.token})).gallery_items.length,0);
    const snap = (await h.community(owner.token,'sharing.snapshot',{asset_ids:[photo],operation_key:key('new-snapshot')})).snapshot;
    assert.deepEqual(snap.pairs,[]);
    assert.equal((await h.storage.exec('SELECT COUNT(*) n FROM media_grants WHERE active=1'))[0].n,0);
  } finally { await h.close(); }
});

test('private media checks actual current source/private rendition metadata and signed tickets remain revocable',async () => {
  const {h,plan,owner,aline} = await fixture();
  try {
    const photo = (await upload(h,owner,plan,[aline.accountId])).asset_id;
    const {preview} = await reviewed(h,owner,[photo],[aline.accountId]);
    const receipt = await h.community(owner.token,'sharing.commit',{preview_id:preview.id,preview_version:preview.version,draft_version:1,operation_key:key('commit')});
    await h.community(aline.token,'request.decide',{request_id:receipt.recipients[0].request_id,decision:'accept',operation_key:key('accept')});
    const ticket = await h.json('/previews/sign',{token:aline.token,body:{asset_id:photo}});
    await h.json('/auth/logout',{token:aline.token,body:{}});
    await h.json(new URL(ticket.preview_url).pathname,{},403);
    const asset = (await h.storage.exec('SELECT * FROM assets WHERE id=?',photo))[0];
    const bucket = await h.mf.getR2Bucket('QUARANTINE');
    const stored = await bucket.get(asset.object_key);
    await bucket.put(asset.object_key,await stored.arrayBuffer(),{httpMetadata:{contentType:asset.content_type},
      customMetadata:{source_version:asset.version,source_checksum_sha256:'c'.repeat(64)}});
    const invalid = await h.json(`/community/media/${photo}/preview`,{token:owner.token},404);
    assert.equal(invalid.error.code,'source_unverified');
    await h.json(`/community/media/${photo}/original`,{token:owner.token},404);
    await h.json('/_internal/queue',{body:{category:'photo',payload:{attempt_id:crypto.randomUUID()}},headers:{'x-lovelies-internal':'queue'}},404);
  } finally { await h.close(); }
});

test('PostgreSQL review scope accepts 100 metadata rows and explicitly declares a larger batch',async () => {
  const plan = new Map();
  const h = await startHarness({faceVerifier:faceVerifierFixture,photoProcessor:envelope=>processorResult(envelope,[])});
  try {
    const owner = await enroll(h); await preferences(h,owner);
    const batch = crypto.randomUUID(); const original = await upload(h,owner,plan,[],{batch});
    const ids = [original.asset_id];
    // Native-SQL metadata boundary fixtures reuse a real processed rendition's
    // dimensions/checksum. This tests bounded selection, not 101 upload/provider runs.
    for (let index=0;index<100;index++) {
      const id = crypto.randomUUID(); const version = crypto.randomUUID(); ids.push(id);
      await h.storage.exec(`INSERT INTO assets(id,owner_id,source,batch_id,status,object_key,content_type,byte_size,checksum_sha256,version,title,created_at)
        SELECT ?,owner_id,source,batch_id,status,?,content_type,byte_size,checksum_sha256,?,title,created_at FROM assets WHERE id=?`,
        id,`fixture-boundary/source/${id}`,version,original.asset_id);
      await h.storage.exec(`INSERT INTO renditions(id,asset_id,object_key,content_type,byte_size,checksum_sha256,source_checksum_sha256,
        source_version,version,width,height,verified_at,status,model_version,kind,orientation)
        SELECT ?,?,?,content_type,byte_size,checksum_sha256,source_checksum_sha256,?,?,width,height,verified_at,status,model_version,kind,orientation
        FROM renditions WHERE asset_id=? AND status='ready'`,crypto.randomUUID(),id,`fixture-boundary/preview/${id}`,version,crypto.randomUUID(),original.asset_id);
    }
    const selected = ids.slice(0,100);
    const exact = (await h.community(owner.token,'sharing.snapshot',{asset_ids:selected,operation_key:key('100-assets')})).snapshot;
    assert.equal(exact.assets.length,100); assert.deepEqual(new Set(exact.assets.map(asset=>asset.id)),new Set(selected));
    const bounded = (await h.community(owner.token,'sharing.snapshot',{upload_batch_id:batch,operation_key:key('101-batch')})).snapshot;
    assert.equal(bounded.assets.length,100); assert.equal(bounded.scope.has_more,true); assert.equal(bounded.scope.selection_limited,true);
    const invalid = await h.community(owner.token,'sharing.snapshot',{asset_ids:ids,operation_key:key('101-exact')},400);
    assert.equal(invalid.error.code,'selection_limit');
  } finally { await h.close(); }
});

test('retired professional sources are rejected while ordinary upload and approved delivery still work',async () => {
  const {h,plan,owner,aline} = await fixture();
  try {
    await h.storage.exec('UPDATE accounts SET roles_json=? WHERE id=?',JSON.stringify(['user','photographer']),owner.accountId);
    const bytes=fixturePng('unsupported-source'),before=(await h.storage.exec('SELECT count(*) n FROM assets'))[0].n;
    const rejected=await h.json('/uploads/session',{token:owner.token,body:{source:'professional',content_type:'image/png',byte_size:bytes.byteLength,operation_key:key('retired-upload')}},400);
    assert.equal(rejected.error.code,'invalid_source');
    assert.equal((await h.storage.exec('SELECT count(*) n FROM assets'))[0].n,before);
    const denied=await h.community(owner.token,'sharing.snapshot',{source:'professional',upload_batch_id:crypto.randomUUID(),operation_key:key('retired-snapshot')},400);
    assert.equal(denied.error.code,'invalid_source');
    const batch=crypto.randomUUID(),photo=(await upload(h,owner,plan,[aline.accountId],{batch})).asset_id;
    const signed=await h.json('/previews/sign',{token:owner.token,body:{asset_id:photo}});
    assert.equal((await h.request(new URL(signed.preview_url).pathname)).status,200);
    const snap=(await h.community(owner.token,'sharing.snapshot',{asset_ids:[photo],upload_batch_id:batch,operation_key:key('snapshot')})).snapshot;
    assert.equal(snap.source,'personal');assert.equal(snap.upload_batch_id,batch);
    const view=(await h.community(owner.token,'sharing.preview',{snapshot_id:snap.id,snapshot_version:snap.version,draft_version:1,selected_asset_ids:[photo],selected_recipient_ids:[aline.accountId],excluded_pairs:[],operation_key:key('preview')})).preview;
    const pending=await h.community(owner.token,'sharing.commit',{preview_id:view.id,preview_version:view.version,draft_version:1,operation_key:key('commit')});
    assert.equal(pending.grants_created,0);assert.equal(pending.status,'pending_acceptance');
    const requestId=pending.recipients[0].request_id;
    await h.community(aline.token,'request.decide',{request_id:requestId,decision:'accept',operation_key:key('accept')});
    assert.deepEqual((await h.community(aline.token,'photos.validate',{asset_ids:[photo]})).authorized_ids,[photo]);
    assert.equal((await h.request(`/community/media/${photo}/preview`,{token:aline.token})).status,200);
    // Simulate a preserved retired-source record. Existing grants cannot turn
    // it into current source authority, even when its old owner role survives.
    await h.storage.exec("UPDATE assets SET source='professional' WHERE id=?",photo);
    await h.json(new URL(signed.preview_url).pathname,{},403);
    assert.deepEqual((await h.json('/me',{token:owner.token})).roles,['user']);
    assert.deepEqual((await h.community(aline.token,'photos.validate',{asset_ids:[photo]})).authorized_ids,[]);
    await h.json(`/community/media/${photo}/preview`,{token:aline.token},403);
    await h.json(`/community/media/${photo}/preview`,{token:owner.token},403);
    assert.equal((await h.storage.exec('SELECT source FROM assets WHERE id=?',photo))[0].source,'professional');
  } finally { await h.close(); }
});
