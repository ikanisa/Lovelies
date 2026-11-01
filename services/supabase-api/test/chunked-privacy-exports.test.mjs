import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { startHarness,enroll,captureProofs,faceVerifierFixture } from './runtime-harness.mjs';
import { IncrementalSha256 } from '../src/incremental-sha256.ts';
import { processPrivacyJob,flushPrivacyCleanup } from '../src/privacy.ts';
import { EXPORT_CHUNK_BYTES,exportManifestSeed,exportManifestNext } from '../src/privacy-export-chunks.ts';
import { pruneRetainedMetadata } from '../src/retention.ts';

const id=()=>crypto.randomUUID(),hash=value=>createHash('sha256').update(value).digest('hex');
async function approved(h,owner,reviewer,kind='export'){
 const now=h.app.now(),request=id();
 await h.db.run("INSERT INTO privacy_requests(id,subject_id,requested_by,request_type,status,created_at,expires_at,reviewed_by,reviewed_at) VALUES(?,?,?,?,'queued',?,?,?,?)",request,owner.accountId,owner.accountId,kind,now,now+7*86400000,reviewer.accountId,now);
 return request;
}
async function finish(h,request,maximum=100){
 for(let count=0;count<maximum;count++){
  const row=await h.db.one('SELECT status FROM privacy_requests WHERE id=?',request);if(row.status==='completed')return;
  await processPrivacyJob({request_id:request},h.app);
 }
 assert.fail('synthetic export did not finish its bounded continuations');
}

test('incremental SHA256 has portable restart states, exact bytes and strict input validation',()=>{
 const vectors=[Buffer.alloc(0),Buffer.from('abc'),Buffer.alloc(55,97),Buffer.alloc(56,97),Buffer.alloc(63,97),Buffer.alloc(64,97),Buffer.alloc(65,97),Buffer.alloc(1000000,97)];
 for(const bytes of vectors){
  let streaming=new IncrementalSha256();
  for(let offset=0;offset<bytes.length;offset+=73){streaming.update(bytes.subarray(offset,offset+73));const state=JSON.parse(JSON.stringify(streaming.state()));streaming.clear();streaming=new IncrementalSha256(state);}
  assert.equal(streaming.hex(),hash(bytes));assert.equal(streaming.hex(),hash(bytes),'reading digest must not alter the live state');streaming.clear();
 }
 for(const corrupt of [{version:1,words:[],tail:[],bytes:0},{version:1,words:Array(8).fill(0),tail:[1],bytes:0},{version:1,words:Array(8).fill(-1),tail:[],bytes:0},{version:1,words:Array(8).fill(0),tail:[],bytes:Number.MAX_SAFE_INTEGER+1}])assert.throws(()=>new IncrementalSha256(corrupt),/sha256_state_invalid/);
});

test('export snapshots serialize complete rows when a projected column is named source',{timeout:60000},async t=>{
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});t.after(()=>h.close());
 const owner=await enroll(h),reviewer=await enroll(h),asset=id(),now=h.app.now();
 await h.db.run(`UPDATE accounts SET roles_json='["admin"]' WHERE id=?`,reviewer.accountId);
 await h.db.run("INSERT INTO assets(id,owner_id,source,status,object_key,content_type,byte_size,version,created_at) VALUES(?,?,'personal','quarantined',?,'image/png',1,?,?)",asset,owner.accountId,'private-source-key/'+asset,id(),now);
 const request=await approved(h,owner,reviewer);await finish(h,request);
 const delivery=await h.json(`/privacy-exports/${request}/deliveries`,{token:owner.token,body:{operation_key:id()}});
 const response=await h.request(delivery.retrieve_path,{token:owner.token});assert.equal(response.status,200);
 const bytes=await response.text(),exported=JSON.parse(bytes),row=exported.tables.owned_assets[0];
 assert.equal(exported.tables.owned_assets.length,1);assert.equal(row.id,asset);assert.equal(row.source,'personal');assert.equal(row.status,'quarantined');
 assert.equal(row._export_index,undefined);assert.equal(row.object_key,undefined);assert(!bytes.includes('private-source-key/'));
});

test('large export capture, exact bounded continuation and authenticated chunk delivery',{timeout:240000},async t=>{
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});t.after(()=>h.close());
 const owner=await enroll(h),reviewer=await enroll(h),other=await enroll(h);
 await h.db.run(`UPDATE accounts SET roles_json='["admin"]' WHERE id=?`,reviewer.accountId);
 const now=h.app.now(),request=await approved(h,owner,reviewer);
 // More than the former 25,000-row and 20MiB limits. One SQL fixture operation,
 // no actual user content, external API or provider is used.
 await h.db.run(`INSERT INTO support_requests(id,account_id,subject,details,status,created_at,updated_at)
  SELECT '91000000-0000-4000-8000-'||lpad(i::text,12,'0'),?,'Synthetic export row',repeat('é',500)||i,'open',?+i,?+i FROM generate_series(1,25001) i`,owner.accountId,now,now);
 let publication;
 await t.test('capture is whole and immutable, a lost chunk PUT keeps the same key and intent',async()=>{
  const put=h.env.PRIVACY_EXPORTS.put.bind(h.env.PRIVACY_EXPORTS);let lost=false;
  h.env.PRIVACY_EXPORTS.put=async(...args)=>{await put(...args);if(!lost&&args[0].includes('/chunk-0-')){lost=true;throw Error('synthetic_chunk_put_reply_lost');}};
  try{await assert.rejects(processPrivacyJob({request_id:request},h.app),/synthetic_chunk_put_reply_lost/);assert(lost);}finally{h.env.PRIVACY_EXPORTS.put=put;}
  publication=(await h.db.one('SELECT id FROM privacy_exports WHERE request_id=?',request)).id;
  const snap=await h.db.one('SELECT * FROM privacy_export_snapshots WHERE id=?',publication);
  assert(snap.row_count>25000);assert(snap.total_bytes>20*1024*1024);assert.equal(snap.cursor_seq,0);assert.equal(snap.chunk_count,0);
  const pending=await h.db.one('SELECT * FROM privacy_export_chunks WHERE publication_id=? AND chunk_index=0',publication);
  assert.equal(pending.status,'pending');assert(await h.env.PRIVACY_EXPORTS.head(pending.object_key));
  await assert.rejects(h.db.run('UPDATE privacy_export_snapshot_rows SET payload_text=? WHERE snapshot_id=? AND sequence=0','changed',publication),/privacy_export_snapshot_row_immutable/);
  await assert.rejects(h.db.run('UPDATE privacy_export_chunks SET sha256=? WHERE publication_id=? AND chunk_index=0','0'.repeat(64),publication),/privacy_export_chunk_immutable/);
  await h.db.run("UPDATE support_requests SET details='MUTATED_AFTER_CAPTURE' WHERE account_id=?",owner.accountId);
  await h.db.run("INSERT INTO support_requests(id,account_id,subject,details,status,created_at,updated_at) VALUES(?,?,'NEW_AFTER_CAPTURE','must not enter old snapshot','open',?,?)",id(),owner.accountId,now+30000,now+30000);
  await processPrivacyJob({request_id:request},h.app);
  assert.equal((await h.db.one('SELECT write_intent_id FROM privacy_export_chunks WHERE publication_id=? AND chunk_index=0',publication)).write_intent_id,pending.write_intent_id);
  assert.equal((await h.db.one('SELECT count(*) n FROM media_write_intents WHERE object_key=?',pending.object_key)).n,1);
  assert.equal((await h.db.one('SELECT status FROM privacy_requests WHERE id=?',request)).status,'queued');
 });
 await t.test('continuations publish all captured rows; private source segments/hash tails are minimized',async()=>{
  const run=h.db.run.bind(h.db),transaction=h.db.transaction.bind(h.db);let marked=false,lost=false,depth=0;
  h.db.run=async(sql,...args)=>{const value=await run(sql,...args);if(sql.startsWith("UPDATE privacy_exports SET status='published'")&&args.includes(publication))marked=true;return value;};
  h.db.transaction=async(callback,...args)=>{depth++;let value;try{value=await transaction(callback,...args);}finally{depth--;}
   if(depth===0&&marked&&!lost){lost=true;throw Error('synthetic_export_publication_reply_lost');}return value;};
  try{await assert.rejects(finish(h,request),/synthetic_export_publication_reply_lost/);assert(lost);}finally{h.db.run=run;h.db.transaction=transaction;}
  const committedObjects=h.env.PRIVACY_EXPORTS.rows.size;
  await processPrivacyJob({request_id:request},h.app);await finish(h,request);
  assert.equal(h.env.PRIVACY_EXPORTS.rows.size,committedObjects,'completion recovery must not rewrite or retire the committed publication');
  const row=await h.db.one('SELECT * FROM privacy_exports WHERE id=?',publication),snap=await h.db.one('SELECT * FROM privacy_export_snapshots WHERE id=?',publication);
  assert.equal(row.content_format,'chunked');assert.equal(row.status,'published');assert(row.chunk_count>20);assert.equal(row.chunk_count,Math.ceil(row.bytes/EXPORT_CHUNK_BYTES));
  assert.equal(snap.status,'completed');assert.equal(snap.hash_state_json,'{}');
  assert.equal((await h.db.one('SELECT count(*) n FROM privacy_export_snapshot_rows WHERE snapshot_id=?',publication)).n,0);
  assert.equal((await h.db.one("SELECT count(*) n FROM privacy_export_chunks WHERE publication_id=? AND(status<>'verified' OR hash_state_json<>'{}' OR bytes>1048576)",publication)).n,0);
  const chunks=await h.db.all('SELECT * FROM privacy_export_chunks WHERE publication_id=? ORDER BY chunk_index',publication),parts=[];let root=await exportManifestSeed(publication);
  for(const chunk of chunks){const bytes=Buffer.from(await(await h.env.PRIVACY_EXPORTS.get(chunk.object_key)).arrayBuffer());assert.equal(hash(bytes),chunk.sha256);root=await exportManifestNext(root,chunk.chunk_index,chunk.bytes,chunk.sha256);assert.equal(root,chunk.root_sha256);parts.push(bytes);}
  // Deliberately assemble only in the test to inspect the complete >20MiB result.
  const all=Buffer.concat(parts);assert.equal(all.length,row.bytes);assert.equal(hash(all),row.sha256);assert.equal(root,row.manifest_sha256);
  const parsed=JSON.parse(all.toString('utf8'));assert.equal(parsed.tables.support_requests.length,25001);assert(parsed.tables.support_requests.every(row=>row.details.startsWith('é')));assert(!all.includes(Buffer.from('MUTATED_AFTER_CAPTURE')));assert(!all.includes(Buffer.from('NEW_AFTER_CAPTURE')));
  assert.equal(parsed.subject_user_id,owner.accountId);assert(!Object.keys(parsed.tables).includes('sessions'));assert(!Object.keys(parsed.tables).includes('media_write_intents'));
  for(const part of parts)part.fill(0);all.fill(0);
 });
 let delivery;
 await t.test('v3 creation/manifest are replayable, bounded and strictly account/session bound',async()=>{
  const key=id(),path=`/privacy-exports/${request}/deliveries`;
  delivery=await h.json(path,{token:owner.token,body:{operation_key:key}});
  assert.equal(delivery.protocol,'lovelies-privacy-export-delivery-v3');assert.equal(delivery.publication_id,publication);assert.equal(delivery.chunk_bytes,EXPORT_CHUNK_BYTES);
  assert.deepEqual(await h.json(path,{token:owner.token,body:{operation_key:key}}),delivery);
  const page=await h.json(delivery.retrieve_path,{token:owner.token});assert.equal(page.protocol,'lovelies-privacy-export-manifest-v1');assert.equal(page.total_bytes,delivery.bytes);assert.equal(page.next_offset,null);assert(page.chunks.length<=128);
  let root=await exportManifestSeed(publication);assert.equal(page.previous_root,root);
  for(const chunk of page.chunks){root=await exportManifestNext(root,chunk.index,chunk.bytes,chunk.sha256);assert.equal(root,chunk.root_sha256);}
  assert.equal(root,delivery.manifest_sha256);
  await h.json(delivery.retrieve_path,{token:other.token},404);
  await h.json(`/privacy-exports/deliveries/${delivery.delivery_id}/manifest?offset=1`,{token:owner.token},400);
  await h.json(delivery.retrieve_path+'&offset=0',{token:owner.token},400);
  await h.json(`/privacy-exports/deliveries/${delivery.delivery_id}/chunks/999999`,{token:owner.token},404);
  const challenge=await h.json('/auth/face/challenge',{body:{face_handle:owner.faceHandle,device_id:owner.deviceId}},201),second=await h.json('/auth/face/complete',{body:await captureProofs(h,challenge,owner.keys.privateKey)});
  await h.json(delivery.retrieve_path,{token:second.access_token},409);
  await h.json(`/privacy-exports/${request}/grant`,{token:owner.token,body:{operation_key:id()}},409);
 });
 await t.test('chunk read/response loss is repeatable; altered Storage bytes cannot acknowledge or consume',async()=>{
  const path=`/privacy-exports/deliveries/${delivery.delivery_id}/chunks/0`,chunk=await h.db.one('SELECT * FROM privacy_export_chunks WHERE publication_id=? AND chunk_index=0',publication);
  for(let i=0;i<2;i++){const response=await h.request(path,{token:owner.token});assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/octet-stream');assert.equal(hash(Buffer.from(await response.arrayBuffer())),chunk.sha256);}
  const duplicate=id();await h.db.run("INSERT INTO cleanup_intents(id,subject_id,bucket,object_key,status,created_at) VALUES(?,?,'PRIVACY_EXPORTS',?,'pending',?)",duplicate,owner.accountId,chunk.object_key,h.app.now());
  await flushPrivacyCleanup(h.app);
  assert.equal((await h.db.one('SELECT status FROM cleanup_intents WHERE id=?',duplicate)).status,'pending','an orphan duplicate must not bypass an active chunk publication');
  assert(await h.env.PRIVACY_EXPORTS.head(chunk.object_key));
  const object=h.env.PRIVACY_EXPORTS.rows.get(chunk.object_key),original=object.data;object.data=new Uint8Array(original.length);object.data.fill(5);
  try{await h.json(path,{token:owner.token},503);}finally{object.data=original;}
  assert.equal((await h.db.one('SELECT acknowledged_at FROM privacy_export_deliveries WHERE id=?',delivery.delivery_id)).acknowledged_at,null);
  await h.json(delivery.ack_path,{token:owner.token,body:{operation_key:id(),sha256:'0'.repeat(64)}},409);
  const get=h.env.PRIVACY_EXPORTS.get.bind(h.env.PRIVACY_EXPORTS),clock=h.app.now;
  h.env.PRIVACY_EXPORTS.get=async key=>{const value=await get(key);h.app.now=()=>Date.parse(delivery.expires_at)+1;return value;};
  try{const response=await h.request(path,{token:owner.token});assert(response.status>=400);assert.equal(response.headers.get('x-lovelies-export-chunk-index'),null);await response.body?.cancel();}finally{h.env.PRIVACY_EXPORTS.get=get;h.app.now=clock;}
 });
 await t.test('exact whole-file acknowledgement retires every chunk, and lost ACK replies recover',async()=>{
  const key=id(),result=await h.json(delivery.ack_path,{token:owner.token,body:{operation_key:key,sha256:delivery.sha256}});assert(result.acknowledged);
  assert.deepEqual(await h.json(delivery.ack_path,{token:owner.token,body:{operation_key:key,sha256:delivery.sha256}}),result);
  await h.json(delivery.retrieve_path,{token:owner.token},410);
  const n=(await h.db.one('SELECT count(*) n FROM cleanup_intents WHERE request_id=?',request)).n;assert.equal(n,delivery.chunk_count+1);
  // Acknowledging a private copy does not clear global or subject evidence
  // holds. Maintenance must revisit the same exact obligations after release.
  await h.db.run(`INSERT INTO retention_settings(id,version,raw_days,preview_days,face_crop_days,free_cache_days,audit_days,legal_hold,updated_at)
   VALUES('default',1,60,60,14,2,30,1,?) ON CONFLICT(id) DO UPDATE SET legal_hold=1,version=retention_settings.version+1`,h.app.now());
  await flushPrivacyCleanup(h.app);
  assert.equal((await h.db.one("SELECT count(*) n FROM cleanup_intents WHERE request_id=? AND status='verified'",request)).n,0);
  assert.equal([...h.env.PRIVACY_EXPORTS.rows.keys()].filter(key=>key.includes(publication)).length,n);
  await h.db.run("UPDATE retention_settings SET legal_hold=0,version=version+1 WHERE id='default'");
  const hold=id();await h.db.run("INSERT INTO moderation_holds(id,subject_id,active,created_at,reason) VALUES(?,?,1,?,'Synthetic export-copy hold')",hold,owner.accountId,h.app.now());
  await flushPrivacyCleanup(h.app);
  assert.equal((await h.db.one("SELECT count(*) n FROM cleanup_intents WHERE request_id=? AND status='verified'",request)).n,0);
  await h.db.run('UPDATE moderation_holds SET active=0,cleared_at=? WHERE id=?',h.app.now(),hold);
  await flushPrivacyCleanup(h.app);
  assert.equal((await h.db.one("SELECT count(*) n FROM cleanup_intents WHERE request_id=? AND status<>'verified'",request)).n,0);
  assert.equal((await h.db.one('SELECT status FROM privacy_export_snapshots WHERE id=?',publication)).status,'retired');
  for(const key of h.env.PRIVACY_EXPORTS.rows.keys())assert(!key.includes(publication));
 });
 await t.test('small exports retain flat v2 and a reviewed erasure removes unfinished captured bytes',async()=>{
  const small=await approved(h,other,reviewer);await finish(h,small);
  const flat=await h.json(`/privacy-exports/${small}/deliveries`,{token:other.token,body:{operation_key:id()}});assert.equal(flat.protocol,'lovelies-privacy-export-delivery-v2');
  const response=await h.request(flat.retrieve_path,{token:other.token});assert.equal(response.status,200);assert.equal((await response.json()).subject_user_id,other.accountId);
  // The owner's updated fixture is now small enough to materialize rapidly;
  // force one unknown write to leave an unfinished snapshot for real erasure.
  const pending=await approved(h,owner,reviewer),put=h.env.PRIVACY_EXPORTS.put.bind(h.env.PRIVACY_EXPORTS);let failed=false;
  h.env.PRIVACY_EXPORTS.put=async(...args)=>{if(!failed&&args[0].includes(pending)){failed=true;throw Error('synthetic_unstarted_write');}return put(...args);};
  try{await assert.rejects(processPrivacyJob({request_id:pending},h.app),/synthetic_unstarted_write/);}finally{h.env.PRIVACY_EXPORTS.put=put;}
  const pendingPub=(await h.db.one('SELECT id FROM privacy_export_snapshots WHERE request_id=?',pending)).id;
  assert((await h.db.one('SELECT count(*) n FROM privacy_export_snapshot_rows WHERE snapshot_id=?',pendingPub)).n>0);
  const activeGrant=id(),historicGrant=id();
  await h.db.run('INSERT INTO operator_access_versions(account_id,version) VALUES(?,4)',owner.accountId);
  await h.db.run(`INSERT INTO operator_capability_grants(id,account_id,capability,granted_by,operation_key,created_at,expires_at)
   VALUES(?,?,'privacy.read',?,?,?,?)`,activeGrant,owner.accountId,reviewer.accountId,id(),now-1000,now+86400000);
  await h.db.run(`INSERT INTO operator_capability_grants(id,account_id,capability,granted_by,operation_key,created_at,expires_at,revoked_at,revoked_by)
   VALUES(?,?,'support.read',?,?,?,?,?,?)`,historicGrant,owner.accountId,reviewer.accountId,id(),now-1000,now+86400000,now-1,reviewer.accountId);
  const deletion=await approved(h,owner,reviewer,'delete');
  // An unacknowledged Storage write remains ambiguous to production even when
  // this fixture deliberately threw before touching its in-memory bucket.
  // Metadata must be minimized, but physical completion must remain blocked.
  await assert.rejects(processPrivacyJob({request_id:deletion},h.app),e=>e.code==='privacy_writer_unresolved');
  assert.equal((await h.db.one('SELECT count(*) n FROM privacy_export_snapshot_rows WHERE snapshot_id=?',pendingPub)).n,0);
  assert.equal((await h.db.one('SELECT hash_state_json FROM privacy_export_snapshots WHERE id=?',pendingPub)).hash_state_json,'{}');
  assert.equal((await h.db.one("SELECT count(*) n FROM privacy_export_chunks WHERE publication_id=? AND hash_state_json<>'{}'",pendingPub)).n,0);
  assert.equal((await h.db.one('SELECT status FROM privacy_exports WHERE id=?',pendingPub)).status,'retired');
  assert.deepEqual(await h.db.one('SELECT status,failure_code FROM privacy_requests WHERE id=?',deletion),{status:'failed',failure_code:'privacy_writer_unresolved'});
  assert((await h.db.one("SELECT count(*) n FROM media_write_intents WHERE account_id=? AND status='pending'",owner.accountId)).n>0);
  assert.equal((await h.db.one('SELECT version FROM operator_access_versions WHERE account_id=?',owner.accountId)).version,5);
  const retired=await h.db.one('SELECT revoked_at,revoked_by FROM operator_capability_grants WHERE id=?',activeGrant);
  assert(retired.revoked_at>=now);assert.equal(retired.revoked_by,reviewer.accountId);
  assert.equal((await h.db.one('SELECT revoked_at FROM operator_capability_grants WHERE id=?',historicGrant)).revoked_at,now-1);
  assert.equal((await h.db.one("SELECT count(*) n FROM restore_transaction_facts WHERE kind='operator-capability-retired' AND json_extract(scope_json,'$.grant_id')=?",activeGrant)).n,0,'unbound fixtures do not accumulate capture rows; fenced retirement is covered by restore-database');
  await assert.rejects(processPrivacyJob({request_id:deletion},h.app),e=>e.code==='privacy_writer_unresolved');
  assert.equal((await h.db.one('SELECT version FROM operator_access_versions WHERE account_id=?',owner.accountId)).version,5,'a retry with no new grant retirement must preserve revision');
 });
});

test('unique export PUT attempts survive an expired lease, successor ACK and delayed arrival',{timeout:150000},async t=>{
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});t.after(()=>h.close());
 const owner=await enroll(h),reviewer=await enroll(h);await h.db.run(`UPDATE accounts SET roles_json='["admin"]' WHERE id=?`,reviewer.accountId);
 const clock=h.app.now;let now=clock();h.app.now=()=>now;t.after(()=>{h.app.now=clock;});
 for(const stage of ['chunk','root'])await t.test(`${stage} attempt cannot settle or overwrite its successor`,async()=>{
  const request=await approved(h,owner,reviewer),put=h.env.PRIVACY_EXPORTS.put.bind(h.env.PRIVACY_EXPORTS);
  let release,entered,oldKey,blocked=false;
  const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});
  h.env.PRIVACY_EXPORTS.put=async(...args)=>{
   if(!blocked&&args[0].includes(request)&&args[0].includes(stage==='chunk'?'/chunk-0-':'/root-')){
    blocked=true;oldKey=args[0];entered();await gate;
   }
   return put(...args);
  };
  const first=processPrivacyJob({request_id:request},h.app).then(value=>({value}),error=>({error}));
  let timer;
  try{
   await Promise.race([ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('synthetic export PUT was not reached')),30000);})]);clearTimeout(timer);
   const publication=(await h.db.one('SELECT id FROM privacy_exports WHERE request_id=?',request)).id;
   const oldWriter=await h.db.one('SELECT id,status FROM media_write_intents WHERE object_key=?',oldKey);
   assert.equal(oldWriter.status,'pending');assert.equal(await h.env.PRIVACY_EXPORTS.head(oldKey),null);
   now+=300001;await finish(h,request);
   const winner=await h.db.one('SELECT object_key,sha256,status FROM privacy_exports WHERE id=?',publication);
   assert.equal(winner.status,'published');assert.notEqual(winner.object_key,oldKey);
   if(stage==='chunk')assert.notEqual((await h.db.one('SELECT object_key FROM privacy_export_chunks WHERE publication_id=? AND chunk_index=0',publication)).object_key,oldKey);
   else assert.notEqual((await h.db.one('SELECT root_write_id FROM privacy_export_snapshots WHERE id=?',publication)).root_write_id,oldWriter.id);
   assert.equal((await h.db.one('SELECT status FROM media_write_intents WHERE id=?',oldWriter.id)).status,'pending');
   const delivery=await h.json(`/privacy-exports/${request}/deliveries`,{token:owner.token,body:{operation_key:id()}});
   await h.json(delivery.ack_path,{token:owner.token,body:{operation_key:id(),sha256:delivery.sha256}});
   await flushPrivacyCleanup(h.app);await pruneRetainedMetadata(h.app);
   assert(await h.db.one('SELECT id FROM privacy_export_snapshots WHERE id=?',publication),'an unresolved prior writer must retain lifecycle metadata');
   assert.equal((await h.db.one('SELECT status FROM cleanup_intents WHERE request_id=? AND object_key=?',request,oldKey)).status,'pending');
   assert.equal(await h.env.PRIVACY_EXPORTS.head(oldKey),null);
   release();const late=await first;assert(late.error,'an obsolete producer must not report successful publication');
   assert(await h.env.PRIVACY_EXPORTS.head(oldKey),'the delayed distinct attempt must really materialize after ACK cleanup');
   assert.equal((await h.db.one('SELECT status FROM media_write_intents WHERE id=?',oldWriter.id)).status,'settled','only its own acknowledged completion may settle the delayed writer');
   assert.deepEqual(await h.db.one('SELECT object_key,sha256,status FROM privacy_exports WHERE id=?',publication),{...winner,status:'retired'});
   assert.equal((await h.db.one('SELECT status FROM privacy_requests WHERE id=?',request)).status,'completed');
   await flushPrivacyCleanup(h.app);
   assert.equal(await h.env.PRIVACY_EXPORTS.head(oldKey),null);
   assert.equal((await h.db.one("SELECT count(*) n FROM cleanup_intents WHERE request_id=? AND status<>'verified'",request)).n,0);
   // A verified cleanup row is insufficient if an independent exact-key
   // obligation remains pending. Retention must consider both rows.
   const duplicate=id();await h.db.run("INSERT INTO cleanup_intents(id,subject_id,bucket,object_key,status,created_at) VALUES(?,?,'PRIVACY_EXPORTS',?,'pending',?)",duplicate,owner.accountId,winner.object_key,now);
   await pruneRetainedMetadata(h.app);assert(await h.db.one('SELECT id FROM privacy_export_snapshots WHERE id=?',publication));
   await flushPrivacyCleanup(h.app);assert.equal((await h.db.one('SELECT status FROM cleanup_intents WHERE id=?',duplicate)).status,'verified');
   const heldAsset=id(),assetHold=id();
   await h.db.run("INSERT INTO assets(id,owner_id,source,status,object_key,content_type,byte_size,version,created_at) VALUES(?,?,'personal','quarantined',?,'image/png',1,?,?)",heldAsset,owner.accountId,'synthetic-retention/'+heldAsset,id(),now);
   await h.db.run("INSERT INTO moderation_holds(id,asset_id,active,created_at,reason) VALUES(?,?,1,?,'Synthetic retained export evidence')",assetHold,heldAsset,now);
   await pruneRetainedMetadata(h.app);assert(await h.db.one('SELECT id FROM privacy_export_snapshots WHERE id=?',publication),'an owned asset moderation hold retains the complete manifest evidence');
   await h.db.run('UPDATE moderation_holds SET active=0,cleared_at=? WHERE id=?',now,assetHold);
   await h.db.run('INSERT INTO asset_retention(asset_id,raw_expires_at,preview_expires_at,legal_hold,updated_at) VALUES(?,?,?,1,?)',heldAsset,now+86400000,now+86400000,now);
   await pruneRetainedMetadata(h.app);assert(await h.db.one('SELECT id FROM privacy_export_snapshots WHERE id=?',publication),'an owned asset retention hold retains manifest evidence');
   await h.db.run('UPDATE asset_retention SET legal_hold=0 WHERE asset_id=?',heldAsset);
   await pruneRetainedMetadata(h.app);assert.equal(await h.db.one('SELECT id FROM privacy_export_snapshots WHERE id=?',publication),null);
  }finally{clearTimeout(timer);release();await first;h.env.PRIVACY_EXPORTS.put=put;}
 });
 await t.test('a fully verified root with a lost PUT reply is adopted without a second dispatch',async()=>{
  const request=await approved(h,owner,reviewer),put=h.env.PRIVACY_EXPORTS.put.bind(h.env.PRIVACY_EXPORTS);let lost=false,rootWrites=0;
  h.env.PRIVACY_EXPORTS.put=async(...args)=>{await put(...args);if(args[0].includes(request)&&args[0].includes('/root-')){rootWrites++;if(!lost){lost=true;throw Error('synthetic_root_reply_lost');}}};
  try{
   await assert.rejects(processPrivacyJob({request_id:request},h.app),/synthetic_root_reply_lost/);
   const before=await h.db.one('SELECT id,root_write_id FROM privacy_export_snapshots WHERE request_id=?',request);
   await finish(h,request);assert.equal(rootWrites,1);
   assert.equal((await h.db.one('SELECT root_write_id FROM privacy_export_snapshots WHERE id=?',before.id)).root_write_id,before.root_write_id);
   assert.equal((await h.db.one('SELECT status FROM media_write_intents WHERE id=?',before.root_write_id)).status,'settled');
  }finally{h.env.PRIVACY_EXPORTS.put=put;}
 });
});

test('paged chunk manifests have a complete ordered commitment beyond one page',{timeout:60000},async t=>{
 const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});t.after(()=>h.close());const owner=await enroll(h),request=id(),publication=id(),now=h.app.now(),count=130,total=(count-1)*EXPORT_CHUNK_BYTES+3;
 let root=await exportManifestSeed(publication);const chunks=[];
 for(let index=0;index<count;index++){const bytes=index===count-1?3:EXPORT_CHUNK_BYTES,sha256=hash(`synthetic metadata only ${index}`);root=await exportManifestNext(root,index,bytes,sha256);chunks.push({index,bytes,sha256,root});}
 await h.db.transaction(async()=>{
  await h.db.run("INSERT INTO privacy_requests(id,subject_id,requested_by,request_type,status,created_at,expires_at,completed_at,export_key,export_sha256,export_bytes,export_expires_at) VALUES(?,?,?,'export','completed',?,?,?,?,?,?,?)",request,owner.accountId,owner.accountId,now,now+86400000,now,'synthetic-manifest/'+publication,'a'.repeat(64),total,now+86400000);
  await h.db.run(`INSERT INTO privacy_exports(id,request_id,subject_id,object_key,sha256,bytes,expires_at,status,created_at,content_format,chunk_count,manifest_sha256,manifest_object_sha256,manifest_object_bytes)
   VALUES(?,?,?,?,?,?,?,'published',?,'chunked',?,?,?,1)`,publication,request,owner.accountId,'synthetic-manifest/'+publication,'a'.repeat(64),total,now+86400000,now,count,root,'b'.repeat(64));
  for(const c of chunks)await h.db.run(`INSERT INTO privacy_export_chunks(publication_id,chunk_index,bytes,sha256,root_sha256,object_key,write_intent_id,status,start_seq,start_offset,end_seq,end_offset,hash_state_json,created_at)
   VALUES(?,?,?,?,?,?,?,'verified',?,0,?,0,'{}',?)`,publication,c.index,c.bytes,c.sha256,c.root,'synthetic-chunk/'+publication+'/'+c.index,id(),c.index,c.index+1,now);
 });
 const delivery=await h.json(`/privacy-exports/${request}/deliveries`,{token:owner.token,body:{operation_key:id()}}),first=await h.json(delivery.retrieve_path,{token:owner.token});
 assert.equal(first.chunks.length,128);assert.equal(first.next_offset,128);
 const last=await h.json(`/privacy-exports/deliveries/${delivery.delivery_id}/manifest?offset=128`,{token:owner.token});
 assert.equal(last.chunks.length,2);assert.equal(last.next_offset,null);assert.equal(last.previous_root,first.chunks.at(-1).root_sha256);assert.equal(last.chunks.at(-1).root_sha256,delivery.manifest_sha256);
 await h.json(`/privacy-exports/deliveries/${delivery.delivery_id}/manifest?offset=256`,{token:owner.token},400);
});
