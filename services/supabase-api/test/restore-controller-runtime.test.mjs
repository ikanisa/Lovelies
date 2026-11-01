import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {fixture,seedAccount,rawRows,privateRows,controlRow,databaseConnection,installMarker} from './restore-database-fixture.mjs';
import {RestoreRecoveryController} from '../src/restore-recovery.ts';
import {digest} from '../src/types.ts';
class RecoveryObjects{
 constructor(){this.objects=new Map();this.deletes=[];}
 async head(key){const v=this.objects.get(key);return v?{size:v.length,etag:'exact-'+await digest(v),customMetadata:{}}:null;}
 async get(key){const v=this.objects.get(key),head=await this.head(key);return v?{...head,body:new Response(v).body,arrayBuffer:async()=>v.slice().buffer}:null;}
 async put(key,value){this.objects.set(key,new Uint8Array(value).slice());}
 async delete(key){this.deletes.push(key);this.objects.delete(key);}
 async list(prefix,offset=0,limit=32){const entries=new Map();for(const key of this.objects.keys()){if(!key.startsWith(prefix))continue;const rest=key.slice(prefix.length),index=rest.indexOf('/');const name=index<0?rest:rest.slice(0,index);entries.set(name,{name,folder:index>=0});}return [...entries.values()].sort((a,b)=>a.name<b.name?-1:1).slice(offset,offset+limit);}
}
function controller(f,t,faults={}){const storage={PHOTOS:new RecoveryObjects(),QUARANTINE:new RecoveryObjects(),PRIVACY_EXPORTS:new RecoveryObjects()},connection=databaseConnection(f.h,[],faults);t.after(()=>connection.close());return {storage,controller:new RestoreRecoveryController(connection,f.journal,storage,()=>Date.now(),{testOnlyLegacy:true})};}
async function finish(c,id,maximum=100){for(let i=0;i<maximum;i++){const result=await c.step(id);if(result.phase==='completed')return result;}throw Error('synthetic_recovery_step_limit');}
async function currentMarker(f){return (await f.journal.control()).marker;}
test('failed SQL commit automatically replays every captured consent restriction and never its positive callback',async t=>{
 const f=await fixture(t),account=await seedAccount(f.h),consents=Array.from({length:45},()=>randomUUID()),positive=randomUUID();
 await f.db.transaction(async()=>{for(const id of consents)await f.db.run("INSERT INTO lovelies_private.consents(id,account_id,purpose,policy_version,status,created_at) VALUES(?,?,'photo_matching','synthetic','granted',1000)",id,account);});
 f.faults.beforeCommit=true;
 await assert.rejects(f.db.transaction(async()=>{await f.db.run("UPDATE lovelies_private.consents SET status='revoked',revoked_at=2000 WHERE account_id=?",account);await f.db.run("INSERT INTO lovelies_private.accounts(id,name,created_at) VALUES(?,'must not replay',2000)",positive);}));
 const pending=await f.journal.control(),operation=await f.journal.lookup(pending.pending_operation_id);assert.equal(operation.plan.version,2);assert.equal(operation.plan.event_manifest.count,45);
 assert.equal(Number((await privateRows(f.h,"SELECT count(*) n FROM lovelies_private.consents WHERE status='granted'"))[0].n),45);
 const repaired=await f.db.one("SELECT count(*) n FROM lovelies_private.consents WHERE status='revoked'");assert.equal(Number(repaired.n),45);assert.equal(await f.db.one('SELECT id FROM lovelies_private.accounts WHERE id=?',positive),null);
 assert.equal((await f.journal.lookup(operation.plan.operation_id)).status,'recovered');assert.equal((await f.journal.control()).state,'serving');
 assert.equal(Number((await f.db.one('SELECT count(*) n FROM lovelies_private.restore_transaction_facts')).n),0);
});
test('full controlled snapshot rollback replays restriction pages, retires old authority, then preserves a later new session on retry',async t=>{
 const f=await fixture(t),account=await seedAccount(f.h),consent=randomUUID(),session=randomUUID();const backup=await currentMarker(f);
 await f.db.transaction(async()=>{
  await f.db.run("INSERT INTO lovelies_private.consents(id,account_id,purpose,policy_version,status,created_at) VALUES(?,?,'photo_matching','synthetic','granted',1000)",consent,account);
  await f.db.run("INSERT INTO lovelies_private.sessions(id,account_id,refresh_hash,expires_at,refresh_expires_at,auth_epoch,auth_method,created_at) VALUES(?,?,?,9000000000000,9000000000000,1,'anonymous',1000)",session,account,'refresh-old-'+session);
 });
 await f.db.run("UPDATE lovelies_private.consents SET status='revoked',revoked_at=2000 WHERE id=?",consent);
 await privateRows(f.h,"UPDATE lovelies_private.consents SET status='granted',revoked_at=NULL WHERE id=$1",[consent]);await installMarker(f.h,backup);
 await assert.rejects(f.db.read(()=>f.db.one('SELECT id FROM lovelies_private.accounts WHERE id=?',account)));
 const {controller:c}=controller(f,t),id=randomUUID();await c.begin(id);const done=await finish(c,id);assert.equal(done.phase,'completed');assert.notEqual(done.recovery.control.marker.incarnation_id,backup.incarnation_id);
 const old=await f.db.one('SELECT revoked_at FROM lovelies_private.sessions WHERE id=?',session);assert.notEqual(old.revoked_at,null);assert.equal((await f.db.one('SELECT status FROM lovelies_private.consents WHERE id=?',consent)).status,'revoked');
 const fresh=randomUUID();await f.db.run("INSERT INTO lovelies_private.sessions(id,account_id,refresh_hash,expires_at,refresh_expires_at,auth_epoch,auth_method,created_at) VALUES(?,?,?,9000000000000,9000000000000,1,'anonymous',3000)",fresh,account,'refresh-new-'+fresh);
 await c.begin(id);await c.step(id);assert.equal((await f.db.one('SELECT revoked_at FROM lovelies_private.sessions WHERE id=?',fresh)).revoked_at,null);
});
test('lost independent begin reply and rolled back local run insertion both resume the same recovery generation',async t=>{
 const f=await fixture(t),faults={},bundle=controller(f,t,faults),id=randomUUID();
 f.faults.reply={path:'/v1/recovery/begin-v2',stage:'after'};await assert.rejects(bundle.controller.begin(id));
 assert.equal(Number((await privateRows(f.h,'SELECT count(*) n FROM lovelies_private.restore_recovery_runs'))[0].n),0);const generation=(await bundle.controller.read(id)).recovery.generation_hash;
 faults.beforeCommit=true;await assert.rejects(bundle.controller.begin(id));assert.equal(Number((await privateRows(f.h,'SELECT count(*) n FROM lovelies_private.restore_recovery_runs'))[0].n),0);
 await bundle.controller.begin(id);assert.equal(Number((await privateRows(f.h,'SELECT count(*) n FROM lovelies_private.restore_recovery_runs'))[0].n),1);assert.equal((await bundle.controller.read(id)).recovery.generation_hash,generation);
 assert.equal((await finish(bundle.controller,id)).phase,'completed');
});
test('independently recorded private write absent from restored SQL is cleaned only after exact bytes and fresh absence',async t=>{
 const f=await fixture(t),{controller:c,storage}=controller(f,t),bytes=new Uint8Array([2,4,6]),key='lost-backup/asset/version/object',effect=randomUUID(),marker=await currentMarker(f);
 await storage.PHOTOS.put(key,bytes);
 const registration=await f.rawJournal('/v1/effects/register',{version:1,project_id:'ltqfplqevxztlswlzexn',effect_id:effect,expected:marker,kind:'storage-put',target:{bucket:'PHOTOS',object_key:key,owner_id:randomUUID()},payload_hash:await digest(bytes),byte_size:3,metadata_hash:'b'.repeat(64)});
 assert.equal(registration.status,200);const record=(await registration.json()).effect;
 assert.equal((await f.rawJournal('/v1/effects/'+effect+'/dispatch',{version:1,project_id:'ltqfplqevxztlswlzexn',descriptor_hash:record.descriptor_hash,incarnation_id:marker.incarnation_id})).status,200);
 assert.equal((await f.rawJournal('/v1/effects/'+effect+'/observe',{version:1,project_id:'ltqfplqevxztlswlzexn',descriptor_hash:record.descriptor_hash,status:'succeeded',result:{http_status:200,sha256:null,byte_size:null,etag:null}})).status,200);
 const id=randomUUID();await c.begin(id);assert.equal((await finish(c,id)).phase,'completed');assert.equal(await storage.PHOTOS.head(key),null);assert.deepEqual(storage.PHOTOS.deletes,[key]);
 const proof=(await privateRows(f.h,'SELECT status,proof_json FROM lovelies_private.restore_cleanup_objects WHERE effect_id=$1',[effect]))[0];assert.equal(proof.status,'absent');assert.equal(JSON.parse(proof.proof_json).outcome,'absent');
});
test('unknown namespace objects are preserved and cannot clear recovery from an empty restored SQL queue',async t=>{
 const f=await fixture(t),{controller:c,storage}=controller(f,t);await storage.QUARANTINE.put('unknown/object',new Uint8Array([1]));const id=randomUUID();await c.begin(id);
 await assert.rejects(finish(c,id),error=>error.code==='restore_unknown_object_preserved');assert.equal((await f.journal.control()).state,'quarantined');assert.ok(await storage.QUARANTINE.head('unknown/object'));assert.equal(storage.QUARANTINE.deletes.length,0);
});
test('new protocol media intent with no dispatch registration retires safely; legacy unresolved writer remains a blocker',async t=>{
 const f=await fixture(t),account=await seedAccount(f.h),writer=randomUUID();
 await f.db.run("INSERT INTO lovelies_private.media_write_intents(id,account_id,bucket,object_key,status,created_at) VALUES(?,?,'PHOTOS','never/dispatched','pending',1000)",writer,account);
 const original=await f.db.one('SELECT restore_protocol_version,restore_incarnation_id FROM lovelies_private.media_write_intents WHERE id=?',writer);assert.equal(Number(original.restore_protocol_version),2);assert.equal(original.restore_incarnation_id,(await currentMarker(f)).incarnation_id);
 const {controller:c}=controller(f,t),id=randomUUID();await c.begin(id);assert.equal((await finish(c,id)).phase,'completed');assert.equal((await f.db.one('SELECT status FROM lovelies_private.media_write_intents WHERE id=?',writer)).status,'settled');
 const legacy=randomUUID();await privateRows(f.h,"INSERT INTO lovelies_private.media_write_intents(id,account_id,bucket,object_key,status,created_at) VALUES($1,$2,'PHOTOS','legacy/unknown','pending',1000)",[legacy,account]);
 const next=randomUUID();await c.begin(next);await assert.rejects(finish(c,next),error=>error.code==='restore_uninventoried_writer');assert.equal((await f.journal.control()).state,'quarantined');
});
test('full recovery revokes restored delegated capabilities and advances operator access revision',async t=>{
 const f=await fixture(t),account=await seedAccount(f.h),admin=await seedAccount(f.h),grant=randomUUID();
 await f.db.run("INSERT INTO lovelies_private.operator_capability_grants(id,account_id,capability,granted_by,operation_key,created_at,expires_at) VALUES(?,?,'privacy.review',?,'synthetic-capability-operation',1000,9000000000000)",grant,account,admin);
 await f.db.run('INSERT INTO lovelies_private.operator_access_versions(account_id,version) VALUES(?,1)',account);
 await f.db.run("UPDATE lovelies_private.accounts SET roles_json='[\"user\",\"admin\"]' WHERE id=?",admin);
 const {controller:c}=controller(f,t),id=randomUUID();await c.begin(id);await finish(c,id);
 assert.notEqual((await f.db.one('SELECT revoked_at FROM lovelies_private.operator_capability_grants WHERE id=?',grant)).revoked_at,null);assert.equal(Number((await f.db.one('SELECT version FROM lovelies_private.operator_access_versions WHERE account_id=?',account)).version),2);
 assert.deepEqual(JSON.parse((await f.db.one('SELECT roles_json FROM lovelies_private.accounts WHERE id=?',admin)).roles_json),['user']);
 assert.equal((await f.db.one('SELECT state FROM lovelies_private.restore_recovery_runs WHERE id=?',id)).state,'complete');
});
test('a late service observation after SQL clearance installation automatically refreshes and finishes the same generation',async t=>{
 const f=await fixture(t),{controller:c}=controller(f,t),marker=await currentMarker(f),ids=[randomUUID(),randomUUID()],effects=[];
 for(let index=0;index<2;index++){
  const response=await f.rawJournal('/v1/effects/register',{version:1,project_id:'ltqfplqevxztlswlzexn',effect_id:ids[index],expected:marker,
   kind:index?'service-request':'storage-put',target:index?{service:'push',method:'POST',path:'/v1/send'}:{bucket:'PHOTOS',object_key:'never/dispatched',owner_id:randomUUID()},payload_hash:'a'.repeat(64),byte_size:4,metadata_hash:'b'.repeat(64)});
  assert.equal(response.status,200);effects.push((await response.json()).effect);
 }
 const sent=await f.rawJournal('/v1/effects/'+ids[1]+'/dispatch',{version:1,project_id:'ltqfplqevxztlswlzexn',descriptor_hash:effects[1].descriptor_hash,incarnation_id:marker.incarnation_id});assert.equal(sent.status,200);
 const id=randomUUID();await c.begin(id);f.faults.reply={path:'/v1/recovery/'+id+'/complete',stage:'before'};await assert.rejects(finish(c,id));
 const prepared=await c.read(id);assert.equal(prepared.progress.phase,'prepared');const original=prepared.progress.clearance.clearance_hash;
 assert.equal((await privateRows(f.h,'SELECT state FROM lovelies_private.restore_recovery_runs WHERE id=$1',[id]))[0].state,'prepared');
 assert.equal((await f.rawJournal('/v1/effects/'+ids[1]+'/observe',{version:1,project_id:'ltqfplqevxztlswlzexn',descriptor_hash:effects[1].descriptor_hash,status:'succeeded',result:{http_status:200,sha256:null,byte_size:null,etag:null}})).status,200);
 const refreshed=await c.step(id);assert.equal(refreshed.phase,'effects-refreshed');assert.equal(refreshed.recovery.progress.retirement_hash,null);assert.equal(refreshed.recovery.progress.effect_sequence,0);
 const completed=await finish(c,id);assert.equal(completed.phase,'completed');assert.notEqual(completed.recovery.progress.clearance.clearance_hash,original);
 assert.equal((await privateRows(f.h,'SELECT state FROM lovelies_private.restore_recovery_runs WHERE id=$1',[id]))[0].state,'complete');
});
test('an independently held owner absent from restored SQL protects its exact private write from cleanup',async t=>{
 const f=await fixture(t),{controller:c,storage}=controller(f,t),owner=randomUUID(),hold=randomUUID(),bytes=new Uint8Array([1,3,5]),key='held/absent-owner/object',effect=randomUUID();
 await f.db.transaction(async scope=>{scope.operation({operation_id:randomUUID(),input_hash:'a'.repeat(64),allocations:{}});await scope.restrict('account-moderation-restricted',{account_id:owner,hold_id:hold});});
 const marker=await currentMarker(f);await storage.QUARANTINE.put(key,bytes);
 const response=await f.rawJournal('/v1/effects/register',{version:1,project_id:'ltqfplqevxztlswlzexn',effect_id:effect,expected:marker,kind:'storage-put',target:{bucket:'QUARANTINE',object_key:key,owner_id:owner},payload_hash:await digest(bytes),byte_size:3,metadata_hash:'b'.repeat(64)});assert.equal(response.status,200);const record=(await response.json()).effect;
 await f.rawJournal('/v1/effects/'+effect+'/dispatch',{version:1,project_id:'ltqfplqevxztlswlzexn',descriptor_hash:record.descriptor_hash,incarnation_id:marker.incarnation_id});
 await f.rawJournal('/v1/effects/'+effect+'/observe',{version:1,project_id:'ltqfplqevxztlswlzexn',descriptor_hash:record.descriptor_hash,status:'succeeded',result:{http_status:200,sha256:null,byte_size:null,etag:null}});
 const id=randomUUID();await c.begin(id);await assert.rejects(finish(c,id),error=>error.code==='restore_cleanup_held');
 assert.equal((await f.journal.control()).state,'quarantined');assert.ok(await storage.QUARANTINE.head(key));assert.equal(storage.QUARANTINE.deletes.length,0);
 assert.equal((await privateRows(f.h,'SELECT count(*) n FROM lovelies_private.accounts WHERE id=$1',[owner]))[0].n,0);
});
test('an independently completed erasure repeats metadata minimization and closes only after physical cleanup proof',async t=>{
 const f=await fixture(t),subject=await seedAccount(f.h),reviewer=await seedAccount(f.h),request=randomUUID();
 const {controller:c,storage}=controller(f,t),key='erasure/'+subject+'/private.bin',bytes=new Uint8Array([6,7,8]),writer=randomUUID(),effect=randomUUID();
 await f.db.run("INSERT INTO lovelies_private.media_write_intents(id,account_id,bucket,object_key,status,created_at) VALUES(?,?,'PHOTOS',?,'pending',1000)",writer,subject,key);
 const marker=await currentMarker(f),registration=await f.rawJournal('/v1/effects/register',{version:1,project_id:'ltqfplqevxztlswlzexn',effect_id:effect,expected:marker,kind:'storage-put',target:{bucket:'PHOTOS',object_key:key,owner_id:subject},payload_hash:await digest(bytes),byte_size:3,metadata_hash:'b'.repeat(64)});assert.equal(registration.status,200);const record=(await registration.json()).effect;
 assert.equal((await f.rawJournal('/v1/effects/'+effect+'/dispatch',{version:1,project_id:'ltqfplqevxztlswlzexn',descriptor_hash:record.descriptor_hash,incarnation_id:marker.incarnation_id})).status,200);
 await storage.PHOTOS.put(key,bytes);
 assert.equal((await f.rawJournal('/v1/effects/'+effect+'/observe',{version:1,project_id:'ltqfplqevxztlswlzexn',descriptor_hash:record.descriptor_hash,status:'succeeded',result:{http_status:200,sha256:null,byte_size:null,etag:null}})).status,200);
 await f.db.run("UPDATE lovelies_private.media_write_intents SET status='settled',settled_at=2000 WHERE id=?",writer);
 await f.db.transaction(async scope=>{scope.operation({operation_id:randomUUID(),input_hash:'c'.repeat(64),allocations:{}});
  await scope.restrict('account-deletion-requested',{account_id:subject,deletion_request_id:request});
  await scope.restrict('account-deletion-reviewed',{account_id:subject,deletion_request_id:request,reviewer_id:reviewer,decision:'approved'});
  await scope.restrict('account-erased',{account_id:subject,deletion_request_id:request});
 });
 const id=randomUUID();await c.begin(id);assert.equal((await finish(c,id)).phase,'completed');
 const row=await f.db.one('SELECT status,metadata_erased_at,completed_at,failure_code FROM lovelies_private.privacy_requests WHERE id=?',request);
 assert.equal(row.status,'completed');assert.ok(row.metadata_erased_at>0);assert.ok(row.completed_at>=row.metadata_erased_at);assert.equal(row.failure_code,null);
 const account=await f.db.one('SELECT name,disabled_at FROM lovelies_private.accounts WHERE id=?',subject);assert.notEqual(account.name,'Preserved synthetic account');assert.notEqual(account.disabled_at,null);
 assert.equal(await storage.PHOTOS.head(key),null);assert.deepEqual(storage.PHOTOS.deletes,[key]);
 const cleanup=await f.db.one('SELECT status,verified_at FROM lovelies_private.cleanup_intents WHERE request_id=? AND object_key=?',request,key);assert.equal(cleanup.status,'verified');assert.ok(cleanup.verified_at>=row.metadata_erased_at);
 assert.equal(await f.db.one('SELECT id FROM lovelies_private.media_write_intents WHERE id=?',writer),null);
 await c.step(id);assert.equal((await f.db.one('SELECT completed_at FROM lovelies_private.privacy_requests WHERE id=?',request)).completed_at,row.completed_at);
});
test('an independent hold with no restored SQL settings row blocks erasure before any subject metadata is minimized',async t=>{
 const f=await fixture(t),subject=await seedAccount(f.h),reviewer=await seedAccount(f.h),request=randomUUID(),hold=randomUUID();
 await f.db.transaction(async scope=>{scope.operation({operation_id:randomUUID(),input_hash:'d'.repeat(64),allocations:{}});
  await scope.restrict('account-deletion-requested',{account_id:subject,deletion_request_id:request});
  await scope.restrict('account-deletion-reviewed',{account_id:subject,deletion_request_id:request,reviewer_id:reviewer,decision:'approved'});
  await scope.restrict('account-erased',{account_id:subject,deletion_request_id:request});
  await scope.restrict('global-retention-hold-started',{hold_id:hold});
 });
 await privateRows(f.h,'DELETE FROM lovelies_private.retention_settings');
 const {controller:c}=controller(f,t),id=randomUUID();await c.begin(id);await assert.rejects(finish(c,id),error=>error.code==='restore_cleanup_held');
 assert.equal((await f.journal.control()).state,'quarantined');
 assert.equal((await privateRows(f.h,'SELECT name FROM lovelies_private.accounts WHERE id=$1',[subject]))[0].name,'Preserved synthetic account');
 assert.equal((await privateRows(f.h,'SELECT metadata_erased_at FROM lovelies_private.privacy_requests WHERE id=$1',[request]))[0].metadata_erased_at,null);
});
test('an unmaterialized independent hold cannot clear serving for a later ordinary janitor to create an unheld default',async t=>{
 const f=await fixture(t),hold=randomUUID();await f.db.transaction(async scope=>{scope.operation({operation_id:randomUUID(),input_hash:'e'.repeat(64),allocations:{}});await scope.restrict('global-retention-hold-started',{hold_id:hold});});
 await privateRows(f.h,'DELETE FROM lovelies_private.retention_settings');
 const {controller:c}=controller(f,t),id=randomUUID();await c.begin(id);await assert.rejects(finish(c,id),error=>error.code==='restore_hold_metadata_unresolved');
 assert.equal((await f.journal.control()).state,'quarantined');assert.equal((await privateRows(f.h,'SELECT count(*) n FROM lovelies_private.retention_settings'))[0].n,0);
});
