import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes,randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { enroll } from './runtime-harness.mjs';
import { sha256 } from './runtime-harness.mjs';
import { downloadFixture,downloadRequest,fencedHttp } from './download-v2-fixture.mjs';
import { controlRow,installMarker,databaseConnection,privateRows } from './restore-database-fixture.mjs';
import { PostgresDatabase } from '../src/database.ts';
import { RestoreDatabaseFence } from '../src/restore-database.ts';
import { readDownloadBytes } from '../src/download-v2.ts';
import { verifyDownloadSeal } from '../src/download-v2-contract.ts';
import { eraseEntitlementSubject } from '../src/entitlements.ts';
import { pruneRetainedMetadata } from '../src/retention.ts';

const code=(v,c)=>assert.equal(v.error.code,c);
const gateBound=async(promise,label)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),10000);})]);}finally{clearTimeout(timer);}};
const count=async(f,table)=>Number((await f.h.storage.exec('SELECT count(*) n FROM '+table))[0].n);
test('typed issuance/status never release a ticket or secret, replay dates are immutable and repeatable content records access once',async t=>{
  const f=await downloadFixture(t),first=await f.call('sign');
  assert.deepEqual(Object.keys(first).sort(),['protocol','status','account_id','operation_key','original_session_id','asset_id','source_version','created_at','expires_at'].sort());
  assert.equal(first.status,'recorded');assert(first.expires_at>first.created_at&&first.expires_at-first.created_at<=120000);
  assert.deepEqual(await f.call('status'),first);assert.deepEqual(await f.call('sign'),first);
  for(let i=0;i<2;i++){
    const r=await f.h.request('/downloads/v2/content',f.intent);assert.equal(r.status,200);
    assert.equal(r.headers.get('X-Lovelies-Source-Version'),f.version);assert.equal(r.headers.get('X-Lovelies-Content-SHA256'),f.checksum);
    assert.equal(Number(r.headers.get('Content-Length')),f.bytes.length);assert.deepEqual(new Uint8Array(await r.arrayBuffer()),f.bytes);
  }
  assert.equal(await count(f,'download_records'),1);assert.equal(await count(f,'download_v2_tickets'),1);
  assert(!JSON.stringify(first).includes(f.intent.headers['X-Lovelies-Download-Capability']));
  const control=await controlRow(f.h);assert(control.checkpoint_revision>=1);
});
test('a verified existing GIF original retains its bytes, MIME, hash and extension through typed content delivery',async t=>{
  const f=await downloadFixture(t),bytes=new Uint8Array(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64'));
  const checksum=await sha256(bytes),version=randomUUID();
  await f.h.storage.exec('UPDATE assets SET content_type=?,byte_size=?,checksum_sha256=?,version=? WHERE id=?','image/gif',bytes.length,checksum,version,f.asset);
  await f.h.storage.exec('UPDATE renditions SET source_version=?,source_checksum_sha256=? WHERE asset_id=?',version,checksum,f.asset);
  await f.h.env.QUARANTINE.put(f.objectKey,bytes,{httpMetadata:{contentType:'image/gif'},customMetadata:{source_version:version,source_checksum_sha256:checksum}});
  const intent=downloadRequest(f.person,f.asset,version);assert.equal((await f.call('sign',intent)).status,'recorded');
  const response=await f.h.request('/downloads/v2/content',intent);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/gif');
  assert.equal(response.headers.get('X-Lovelies-Content-SHA256'),checksum);assert(response.headers.get('content-disposition').endsWith('.gif"'));
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()),bytes);
});
test('an unsupported HEIC historical row cannot gain a v2 issuance proof or ticket',async t=>{
  const f=await downloadFixture(t);await f.h.storage.exec("UPDATE assets SET content_type='image/heic' WHERE id=?",f.asset);
  code(await f.call('sign',f.intent,503),'download_operation_outcome_unresolved');assert.equal(await count(f,'download_v2_tickets'),0);
  assert.equal(await count(f,'download_v2_operations'),0);assert.equal((await f.journal.control()).state,'serving');
});
test('every historical request binding is exact; malformed input cannot substitute another identity or capability',async t=>{
  const f=await downloadFixture(t);await f.call('sign');
  for(const [name,value]of [['operation_key',randomUUID()],['original_session_id',randomUUID()],['asset_id',randomUUID()],['source_version',randomUUID()]]){
    const altered={...f.intent,body:{...f.intent.body,[name]:value}};
    code(await f.call('status',altered,503),'download_operation_outcome_unresolved');
  }
  code(await f.call('status',{...f.intent,headers:{'X-Lovelies-Download-Capability':'lvd_v2_'+randomBytes(32).toString('base64url')}},503),'download_operation_outcome_unresolved');
  for(const headers of [{},{'X-Lovelies-Download-Capability':'lvd_v2_AA'},{'X-Lovelies-Download-Capability':f.intent.headers['X-Lovelies-Download-Capability']+'='}])
    code(await f.call('status',{...f.intent,headers},400),'invalid_download_input');
  code(await f.call('sign',{...f.intent,body:{...f.intent.body,extra:true}},400),'invalid_download_input');
  const peer=await enroll(f.h);code(await f.call('status',{...f.intent,token:peer.token},503),'download_operation_outcome_unresolved');
  assert.equal(await count(f,'download_v2_tickets'),1);
});
for(const stage of ['before','after'])test(`SQL issued / lost typed acknowledgement ${stage} is reconciled as issued without re-signing`,async t=>{
  const f=await downloadFixture(t);f.faults.reply={path:'/v1/download-operations/'+await operationID(f)+'/settle',stage};
  code(await f.call('sign',f.intent,503),'download_operation_outcome_unresolved');
  const status=await f.call('status');assert.equal(status.status,'recorded');assert.equal(await count(f,'download_v2_tickets'),1);
  assert.deepEqual(await f.call('sign'),status);assert.equal((await f.journal.control()).state,'serving');
});
async function operationID(f){const {restoreOperationID}=await import('../src/restore-transaction.ts');return restoreOperationID(f.person.accountId,'media.download.sign.v2',f.intent.body.operation_key);}
test('actual issued SQL COMMIT with lost result retains one ticket and is independently reconciled before status',async t=>{
  const f=await downloadFixture(t);
  f.faults.beforeActualCommit=async tx=>{const row=await tx.query('SELECT last_disposition FROM restore_control WHERE singleton=1',[]);
    if(row[0]?.last_disposition==='issued'){delete f.faults.beforeActualCommit;f.faults.commitReply=true;}};
  code(await f.call('sign',f.intent,503),'download_operation_outcome_unresolved');
  assert.equal(await count(f,'download_v2_tickets'),1);assert.equal((await f.journal.control()).state,'pending');
  const recovered=await f.call('status');assert.equal(recovered.status,'recorded');assert.deepEqual(await f.call('sign'),recovered);
  assert.equal(await count(f,'download_v2_tickets'),1);assert.equal((await f.journal.lookup(await operationID(f))).disposition,'issued');
});
for(const failure of ['lost-prepare','sql-rollback'])test(`${failure}: exact pending predecessor becomes independently committed not_issued, never a reconstructed ticket`,async t=>{
  const f=await downloadFixture(t);
  if(failure==='lost-prepare')f.faults.reply={path:'/v1/download-operations/prepare',stage:'after'};else f.faults.controlUpdate=true;
  code(await f.call('sign',f.intent,503),'download_operation_outcome_unresolved');
  assert.equal((await f.journal.control()).state,'pending');assert.equal(await count(f,'download_v2_tickets'),0);
  const status=await f.call('status');assert.equal(status.status,'not_issued');assert(!('created_at'in status));assert(!('expires_at'in status));
  assert.deepEqual(await f.call('sign'),status);code(await f.call('content',f.intent,403),'download_not_issued');
  const op=await f.journal.lookup(await operationID(f));assert.equal(op.disposition,'not_issued');
  const row=(await f.h.storage.exec('SELECT * FROM download_v2_operations'))[0],seal=JSON.parse(row.receipt_json);
  assert.equal((await verifyDownloadSeal(f.h.env,seal)).recorded_at,row.recorded_at);
  const generic=await f.rawJournal('/v1/operations/'+op.plan.operation_id+'/acknowledge',{version:1,project_id:'ltqfplqevxztlswlzexn',plan_hash:op.plan_hash,marker:op.plan.next});
  assert.equal(generic.status,409);assert.equal((await generic.json()).error,'typed_acknowledgement_required');
});
test('interrupted no-issuance SQL update and lost SQL commit result recover only their exact bound tombstone',async t=>{
  const f=await downloadFixture(t);f.faults.reply={path:'/v1/download-operations/prepare',stage:'after'};await f.call('sign',f.intent,503);
  f.faults.controlUpdate=true;await f.call('status',f.intent,503);assert.equal(await count(f,'download_v2_operations'),0);
  f.faults.commitReply=true;await f.call('status',f.intent,503);assert.equal(await count(f,'download_v2_operations'),1);
  assert.equal((await f.call('status')).status,'not_issued');assert.equal((await f.journal.control()).state,'serving');
});
for(const stage of ['before','after'])test(`no-issuance SQL commit plus lost typed settle reply ${stage} recovers its original tombstone`,async t=>{
  const f=await downloadFixture(t);f.faults.reply={path:'/v1/download-operations/prepare',stage:'after'};await f.call('sign',f.intent,503);
  f.faults.reply={path:'/v1/download-operations/'+await operationID(f)+'/settle',stage};
  code(await f.call('status',f.intent,503),'download_operation_outcome_unresolved');
  const original=(await f.h.storage.exec('SELECT * FROM download_v2_operations'))[0];assert.equal(original.disposition,'not_issued');
  assert.equal((await f.journal.control()).state,stage==='before'?'pending':'serving');
  const recovered=await f.call('status');assert.equal(recovered.status,'not_issued');
  assert.deepEqual((await f.h.storage.exec('SELECT * FROM download_v2_operations'))[0],original);assert.equal(await count(f,'download_v2_tickets'),0);
});
test('independently committed issuance followed by same-schema SQL rollback quarantines instead of aborting',async t=>{
  const f=await downloadFixture(t);await f.call('sign');
  await f.h.storage.exec('DELETE FROM download_v2_tickets');await f.h.storage.exec('DELETE FROM download_v2_operations');
  await f.h.storage.exec("DELETE FROM operations WHERE source='media.download.sign.v2'");await installMarker(f.h,f.marker);
  await f.call('status',f.intent,503);assert.equal((await f.journal.control()).state,'quarantined');assert.equal(await count(f,'download_v2_operations'),0);
});
test('unknown/conflicting SQL evidence is retained and never classified as no issuance',async t=>{
  const f=await downloadFixture(t);f.faults.reply={path:'/v1/download-operations/prepare',stage:'after'};await f.call('sign',f.intent,503);
  await f.h.storage.exec("INSERT INTO operations(actor_id,source,operation_key,action,payload_hash,payload_json,response_json,created_at) VALUES(?,'unknown-fixture',?,'unknown-fixture',?,'{}','{}',?)",
    f.person.accountId,f.intent.body.operation_key,'a'.repeat(64),Date.now());
  await f.call('status',f.intent,503);assert.equal((await f.journal.control()).state,'pending');assert.equal(await count(f,'download_v2_operations'),0);
  assert.equal((await f.h.storage.exec("SELECT count(*) n FROM operations WHERE source='unknown-fixture'"))[0].n,1);
});
test('exact ticket expiry keeps historical issuance immutable and denies content at its original deadline',async t=>{
  const f=await downloadFixture(t),issued=await f.call('sign');
  f.context.now=()=>issued.expires_at;
  assert.deepEqual(await f.call('status'),issued);code(await f.call('content',f.intent,403),'download_expired');
});
test('a renewed own session may inspect history but cannot redeem the original session capability',async t=>{
  const f=await downloadFixture(t),issued=await f.call('sign');
  const next=await f.h.json('/auth/session/refresh',{body:{refresh_token:f.person.refresh_token}});
  const renewed={...f.intent,token:next.access_token};assert.deepEqual(await f.call('status',renewed),issued);
  code(await f.call('content',renewed,403),'download_session_changed');
});
test('Storage get await rechecks production subscription revocation before content or an access record escapes',async t=>{
  const f=await downloadFixture(t);await f.call('sign');const original=f.h.env.QUARANTINE.get;
  f.h.env.QUARANTINE.get=async key=>{const object=await original.call(f.h.env.QUARANTINE,key);await f.h.storage.exec('UPDATE store_subscriptions SET active=0,version=version+1 WHERE id=?',f.subscription);return object;};
  code(await f.call('content',f.intent,403),'missing_entitlement');assert.equal(await count(f,'download_records'),0);
});
test('MAC key rotation preserves configured history; dropped/wrong historical keys stay unresolved',async t=>{
  const f=await downloadFixture(t);f.h.env.DOWNLOAD_RECEIPT_KEY_ID='first';f.h.env.DOWNLOAD_RECEIPT_KEYS_JSON=JSON.stringify({first:randomBytes(32).toString('base64url')});
  const issued=await f.call('sign'),first=JSON.parse(f.h.env.DOWNLOAD_RECEIPT_KEYS_JSON).first;
  f.h.env.DOWNLOAD_RECEIPT_KEY_ID='next';f.h.env.DOWNLOAD_RECEIPT_KEYS_JSON=JSON.stringify({first,next:randomBytes(32).toString('base64url')});
  assert.deepEqual(await f.call('status'),issued);
  const next=JSON.parse(f.h.env.DOWNLOAD_RECEIPT_KEYS_JSON).next;
  f.h.env.DOWNLOAD_RECEIPT_KEYS_JSON=JSON.stringify({first:randomBytes(32).toString('base64url'),next});
  code(await f.call('status',f.intent,503),'download_operation_outcome_unresolved');
  f.h.env.DOWNLOAD_RECEIPT_KEYS_JSON=JSON.stringify({first,next});assert.deepEqual(await f.call('status'),issued);
  f.h.env.DOWNLOAD_RECEIPT_KEYS_JSON=JSON.stringify({next});code(await f.call('status',f.intent,503),'download_operation_outcome_unresolved');
  f.h.env.DOWNLOAD_RECEIPT_KEYS_JSON=JSON.stringify({first,next});assert.deepEqual(await f.call('status'),issued);assert.equal(await count(f,'download_v2_tickets'),1);
});
test('v1 ingress and generic/mixed-key lookup never export an old or typed download response',async t=>{
  const f=await downloadFixture(t);code(await f.h.json('/downloads/sign',{token:f.person.token,body:{}},410),'download_protocol_retired');
  code(await f.h.json('/downloads/'+randomUUID(),{},410),'download_protocol_retired');await f.call('sign');
  await f.h.storage.exec("INSERT INTO operations(actor_id,source,operation_key,action,payload_hash,payload_json,response_json,created_at) VALUES(?,'unrelated-fixture',?,'unrelated-fixture',?,'{}',?,?)",
    f.person.accountId,f.intent.body.operation_key,'b'.repeat(64),JSON.stringify({private_unrelated:'must not escape'}),Date.now());
  code(await f.h.community(f.person.token,'operation',{operation_key:f.intent.body.operation_key},503),'download_operation_outcome_unresolved');
});
test('erasure resolves a prepared rollback first and retires authority material without foreign-key deletion holds',async t=>{
  const f=await downloadFixture(t);f.faults.reply={path:'/v1/download-operations/prepare',stage:'after'};await f.call('sign',f.intent,503);
  await f.db.transaction(()=>eraseEntitlementSubject(f.db,f.person.accountId,f.context));
  const row=(await f.h.storage.exec('SELECT * FROM download_v2_operations'))[0];assert.equal(row.disposition,'not_issued');assert.equal(row.receipt_json,null);
  assert.equal(await count(f,'download_v2_tickets'),0);assert.equal((await f.journal.control()).state,'serving');
});
test('corrupt issuance evidence survives both erasure and timed minimization until its binding can be verified',async t=>{
  const f=await downloadFixture(t),issued=await f.call('sign'),row=(await f.h.storage.exec('SELECT * FROM download_v2_operations'))[0];
  const corrupt=JSON.parse(row.receipt_json);corrupt.mac_sha256='0'.repeat(64);
  await f.h.storage.exec('UPDATE download_v2_operations SET receipt_json=? WHERE operation_id=?',JSON.stringify(corrupt),row.operation_id);
  const before=await f.h.storage.exec('SELECT * FROM download_v2_operations');
  await assert.rejects(()=>f.db.transaction(()=>eraseEntitlementSubject(f.db,f.person.accountId,f.context)),e=>e.code==='download_operation_outcome_unresolved');
  assert.deepEqual(await f.h.storage.exec('SELECT * FROM download_v2_operations'),before);assert.equal(await count(f,'download_v2_tickets'),1);
  f.context.now=()=>issued.created_at+31*86400000;await pruneRetainedMetadata(f.context);
  assert.deepEqual(await f.h.storage.exec('SELECT * FROM download_v2_operations'),before);assert.equal(await count(f,'download_v2_tickets'),1);
});
test('timed minimization uses original MAC-bound age, preserves scoped holds and later prunes exact minimal disposition',async t=>{
  const f=await downloadFixture(t),issued=await f.call('sign'),hold=randomUUID();
  f.context.now=()=>issued.created_at+31*86400000;
  await f.h.storage.exec("INSERT INTO moderation_holds(id,subject_id,active,created_at,reason) VALUES(?,?,1,?,'synthetic hold')",hold,f.person.accountId,issued.created_at);
  await pruneRetainedMetadata(f.context);assert.notEqual((await f.h.storage.exec('SELECT receipt_json FROM download_v2_operations'))[0].receipt_json,null);
  await f.h.storage.exec('UPDATE moderation_holds SET active=0 WHERE id=?',hold);await pruneRetainedMetadata(f.context);await pruneRetainedMetadata(f.context);
  assert.equal((await f.h.storage.exec('SELECT receipt_json FROM download_v2_operations'))[0].receipt_json,null);assert.equal(await count(f,'download_v2_tickets'),0);
  f.context.now=()=>issued.created_at+366*86400000;await pruneRetainedMetadata(f.context);await pruneRetainedMetadata(f.context);
  assert.equal(await count(f,'download_v2_operations'),0);assert.equal((await f.journal.lookup(await operationID(f))).disposition,'issued');
});
test('bounded content reader rejects stream overflow, fragmented stalls and cancellation without waiting for producer cancellation',async()=>{
  const overflow=new ReadableStream({start(c){c.enqueue(new Uint8Array(20*1024*1024+1));},cancel(){return new Promise(()=>{});}});
  await assert.rejects(()=>readDownloadBytes(overflow),e=>e.status===503);
  const controller=new AbortController(),stalled=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){return new Promise(()=>{});}});
  controller.abort();await assert.rejects(()=>readDownloadBytes(stalled,controller.signal),e=>e.status===503);
  const fragments=new ReadableStream({start(c){for(let i=0;i<17;i++)c.enqueue(new Uint8Array(0));c.close();}});
  await assert.rejects(()=>readDownloadBytes(fragments),e=>e.status===503);
});
async function waitForWriterWait(observer){
  const key=704536419730718193n,hi=Number(key>>32n),lo=Number(key&0xffffffffn),deadline=Date.now()+10000;
  for(;;){const locks=await observer.unsafe(`SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND classid=$1::oid AND objid=$2::oid
    AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND NOT granted`,[hi,lo]);
    if(locks[0].n>0)return;if(Date.now()>=deadline)throw Error('competing connection did not wait on the actual writer lock');await new Promise(r=>setTimeout(r,10));}
}
test('native PG lock serializes an original commit against a competing system reconciliation',async t=>{
  const f=await downloadFixture(t);if(!f.h.databaseUrl){t.skip('native multi-pool PostgreSQL advisory-lock lane required');return;}
  let entered,release;const waiting=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  f.faults.beforeActualCommit=async active=>{const row=await active.query('SELECT last_disposition FROM restore_control WHERE singleton=1',[]);if(row[0]?.last_disposition==='issued'){delete f.faults.beforeActualCommit;entered();await gate;}};
  const other=new PostgresDatabase(databaseConnection(f.h,[],{}),new RestoreDatabaseFence(f.journal,f.h.env));
  const observer=postgres(f.h.databaseUrl,{prepare:false,max:1,ssl:false,onnotice:()=>{}});let sign,status;
  try{
    const http=fencedHttp(f.h,{...f.context,db:other});sign=f.call('sign');await gateBound(waiting,'original issuance did not reach its commit gate');
    status=http.json('/downloads/v2/status',f.intent);await waitForWriterWait(observer);release();const [issued,recovered]=await Promise.all([sign,status]);
    assert.equal(issued.status,'recorded');assert.deepEqual(recovered,issued);assert.equal(await count(f,'download_v2_tickets'),1);
  }finally{release();await Promise.allSettled([sign,status]);await other.close();await observer.end({timeout:5});}
});
test('actual same-key concurrent signs across two PG pools issue once after both observed absence and a measured lock wait',async t=>{
  const f=await downloadFixture(t);if(!f.h.databaseUrl){t.skip('native multi-pool PostgreSQL advisory-lock lane required');return;}
  let enteredRead,releaseRead,enteredCommit,releaseCommit;
  const readPaused=new Promise(r=>enteredRead=r),readGate=new Promise(r=>releaseRead=r),commitPaused=new Promise(r=>enteredCommit=r),commitGate=new Promise(r=>releaseCommit=r);
  const read=f.db.read.bind(f.db);let stopped=false;
  f.db.read=async callback=>{const value=await read(callback);if(value===null&&!stopped){stopped=true;enteredRead();await readGate;}return value;};
  const otherTrace=[],otherFaults={beforeActualCommit:async tx=>{const rows=await tx.query('SELECT last_disposition FROM restore_control WHERE singleton=1',[]);
    if(rows[0]?.last_disposition==='issued'){delete otherFaults.beforeActualCommit;enteredCommit();await commitGate;}}};
  const other=new PostgresDatabase(databaseConnection(f.h,otherTrace,otherFaults),new RestoreDatabaseFence(f.journal,f.h.env));
  const observer=postgres(f.h.databaseUrl,{prepare:false,max:1,ssl:false,onnotice:()=>{}});let first,second;
  try{
    first=f.call('sign');await gateBound(readPaused,'first sign did not complete its actual absence read');
    second=fencedHttp(f.h,{...f.context,db:other}).json('/downloads/v2/sign',f.intent);await gateBound(commitPaused,'second sign did not reach its actual SQL commit gate');
    releaseRead();await waitForWriterWait(observer);releaseCommit();const [a,b]=await Promise.all([first,second]);assert.deepEqual(a,b);
    assert.equal(await count(f,'download_v2_tickets'),1);assert.equal(await count(f,'download_v2_operations'),1);
    const writes=[...f.trace,...otherTrace].filter(e=>e.kind==='sql'&&e.sql.startsWith('INSERT INTO download_v2_operations'));
    assert.equal(writes.length,1,'only one actual SQL issuance callback may persist a ticket/evidence preimage');
    assert.equal(f.trace.filter(e=>e.kind==='journal'&&e.path==='/v1/download-operations/prepare').length,1);
  }finally{releaseRead();releaseCommit();await Promise.allSettled([first,second]);f.db.read=read;await other.close();await observer.end({timeout:5});}
});
