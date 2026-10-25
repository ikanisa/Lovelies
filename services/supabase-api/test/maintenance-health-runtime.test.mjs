import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {startHarness,closeHarnesses} from './runtime-harness.mjs';
import {createApp,createHandler} from '../src/index.ts';

after(closeHarnesses);
const DAY=86400000,key=()=>crypto.randomUUID();
async function maintenance(h,now,{authorization='Bearer '+h.env.INTERNAL_MAINTENANCE_SECRET,db=h.db,method='POST'}={}) {
  const handler=createHandler(createApp(db,h.env,()=>now));
  const response=await handler(new Request('http://localhost/_internal/maintenance',{method,headers:authorization?{authorization}:{}}));
  return {status:response.status,body:await response.json()};
}
async function asset(h,owner,now,{createdAt=now,objectKey='private-source-'+key()}={}) {
  const id=key();
  await h.db.run(`INSERT INTO assets(id,owner_id,source,status,object_key,content_type,byte_size,checksum_sha256,version,title,created_at)
    VALUES(?,?,'personal','uploaded',?,'image/png',3,?,?,?,?)`,id,owner.account_id,objectKey,'a'.repeat(64),key(),'PRIVATE_TITLE_'+key(),createdAt);
  await h.env.QUARANTINE.put(objectKey,new Uint8Array([1,2,3]));
  return {id,objectKey};
}
function aggregateOnly(body,forbidden=[]) {
  const serialized=JSON.stringify(body);
  for(const value of forbidden)assert(!serialized.includes(value),'Maintenance must return only aggregate operational metadata');
  assert.deepEqual(body.privacy_health.backups,{qualification:'UNVERIFIED',target_seconds:14*DAY/1000,provider_measurement_configured:false});
  assert.equal(body.privacy_health.protocol,'lovelies-maintenance-health-v1');
  for(const field of ['processed','failed','maintenance_errors'])assert(Number.isSafeInteger(body[field]));
}

test('internal maintenance authentication protects counts; an actual returned retention failure makes the endpoint unavailable until verified retry',async()=>{
  const h=await startHarness({consumeQueue:false});try{
    const now=Date.now(),owner=await h.anonymous(),photo=await asset(h,owner,now,{createdAt:now-61*DAY});
    for(const authorization of [null,'Bearer wrong-maintenance-secret','Bearer '+owner.access_token]){
      const denied=await maintenance(h,now,{authorization});assert.equal(denied.status,404);assert.deepEqual(denied.body,{error:{code:'route_not_found'}});
    }
    assert.equal((await maintenance(h,now,{method:'GET'})).status,404);
    assert.equal((await h.db.one('SELECT count(*) n FROM retention_jobs')).n,0);
    assert.equal((await h.db.one('SELECT deleted_at FROM assets WHERE id=?',photo.id)).deleted_at,null);
    const remove=h.env.QUARANTINE.delete.bind(h.env.QUARANTINE);let deletes=0;
    h.env.QUARANTINE.delete=async objectKey=>{deletes++;assert.equal(objectKey,photo.objectKey);throw Error('PRIVATE_STORAGE_FAULT_'+photo.objectKey);};
    const failed=await maintenance(h,now);assert.equal(failed.status,503);assert(failed.body.maintenance_errors>0);
    assert.deepEqual(failed.body.retention,{status:'observed',verified:0,pending:1,failed:1});
    assert.equal(failed.body.failed,0);assert.equal(deletes,1);
    assert.equal(failed.body.privacy_health.cleanup.unverified,1);assert.equal(failed.body.privacy_health.cleanup.failed_unheld,1);
    const durable=await h.db.one('SELECT status,verified_at FROM retention_jobs WHERE asset_id=?',photo.id);
    assert.equal(durable.status,'failed');assert.equal(durable.verified_at,null);
    assert.equal((await h.db.one('SELECT status,verified_at FROM retention_objects')).verified_at,null);
    assert(await h.env.QUARANTINE.head(photo.objectKey));
    aggregateOnly(failed.body,[owner.account_id,photo.id,photo.objectKey,owner.access_token,h.env.INTERNAL_MAINTENANCE_SECRET,'PRIVATE_STORAGE_FAULT']);
    h.env.QUARANTINE.delete=remove;
    const retried=await maintenance(h,now+1);assert.equal(retried.status,200);assert.equal(retried.body.maintenance_errors,0);
    assert.deepEqual(retried.body.retention,{status:'observed',verified:1,pending:0,failed:0});
    assert.equal(retried.body.privacy_health.cleanup.unverified,0);assert.equal(await h.env.QUARANTINE.head(photo.objectKey),null);
    assert.equal((await h.db.one('SELECT status FROM retention_jobs WHERE asset_id=?',photo.id)).status,'verified');
  }finally{await h.close();}
});

test('deletion backlog uses original receipt age despite recent review and reports held targets plus failed cleanup and live writers without publishing completion',async()=>{
  const h=await startHarness({consumeQueue:false});try{
    const now=Date.now(),owner=await h.anonymous(),reviewer=await h.anonymous(),ids=[key(),key(),key(),key(),key()],narrative='PRIVATE_DELETION_NOTE_'+key();
    for(const [index,days,status,held]of [[0,31,'approved',0],[1,8,'pending_approval',1],[2,1,'pending_approval',0],[3,2,'failed',0],[4,100,'completed',0]])
      await h.db.run(`INSERT INTO privacy_requests(id,subject_id,requested_by,request_type,status,reason,created_at,expires_at,reviewed_by,reviewed_at,completed_at,legal_hold)
        VALUES(?,?,?,'delete',?,?,?,?,?,?,?,?)`,ids[index],owner.account_id,owner.account_id,status,narrative,now-days*DAY,now+DAY,
        status==='approved'?reviewer.account_id:null,status==='approved'?now-1000:null,status==='completed'?now-DAY:null,held);
    const cleanupKey='private-unfinished-object-'+key(),cleanup=key(),writer=key(),createdAt=now-DAY-3600000;
    await h.env.PHOTOS.put(cleanupKey,new Uint8Array([7,8,9]));
    // Controlled existing-failure fixture: a hold must preserve this durable
    // failure, not manufacture a new failure from a merely pending obligation.
    await h.db.run("INSERT INTO cleanup_intents(id,subject_id,bucket,object_key,status,attempts,created_at) VALUES(?,?,'PHOTOS',?,'failed',1,?)",cleanup,owner.account_id,cleanupKey,createdAt);
    await h.db.run("INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at) VALUES(?,?,'PHOTOS',?,'pending',?)",writer,owner.account_id,cleanupKey,createdAt);
    assert.equal((await h.db.one('SELECT status FROM cleanup_intents WHERE id=?',cleanup)).status,'failed');
    const result=await maintenance(h,now);assert.equal(result.status,503);assert(result.body.maintenance_errors>0);
    const health=result.body.privacy_health,deletions=health.deletion_requests;
    assert.equal(health.status,'observed');assert.equal(deletions.unfinished,4);assert.equal(deletions.failed,1);assert.equal(deletions.oldest_age_seconds,31*DAY/1000);
    assert.equal(deletions.target_overdue,2);assert.equal(deletions.target_overdue_held,1);assert.equal(deletions.target_overdue_unheld,1);
    assert.equal(deletions.ordinary_overdue,1);assert.equal(deletions.ordinary_overdue_held,0);assert.equal(deletions.ordinary_overdue_unheld,1);
    // The one request hold covers this subject's object obligations, but does
    // not reset their age or mark the pending writer/failed cleanup complete.
    assert.equal(health.cleanup.unverified,1);assert.equal(health.cleanup.failed,1);assert.equal(health.cleanup.target_overdue_held,1);
    assert.equal(health.writers.unsettled,1);assert.equal(health.writers.target_overdue_held,1);
    assert.equal(health.cleanup.oldest_age_seconds,(DAY+3600000)/1000);assert.equal(health.writers.oldest_age_seconds,(DAY+3600000)/1000);
    assert.equal(health.holds.active_request_holds,1);
    const retainedFailure=await h.db.one('SELECT status,verified_at FROM cleanup_intents WHERE id=?',cleanup);
    assert.equal(retainedFailure.status,'failed');assert.equal(retainedFailure.verified_at,null);
    assert.equal((await h.db.one('SELECT status FROM media_write_intents WHERE id=?',writer)).status,'pending');
    assert(await h.env.PHOTOS.head(cleanupKey));assert.equal((await h.db.one('SELECT disabled_at FROM accounts WHERE id=?',owner.account_id)).disabled_at,null);
    assert.equal((await h.db.one('SELECT status FROM privacy_requests WHERE id=?',ids[0])).status,'approved');
    aggregateOnly(result.body,[owner.account_id,reviewer.account_id,...ids,narrative,cleanupKey,cleanup,writer]);
  }finally{await h.close();}
});

test('global and exact scoped holds stay visible without hiding an unrelated overdue object or resetting any writer clock',async()=>{
  const h=await startHarness({consumeQueue:false});try{
    const now=Date.now(),owner=await h.anonymous(),held=await asset(h,owner,now),unheld=await asset(h,owner,now),createdAt=now-DAY-1000;
    await h.db.run("INSERT INTO retention_settings(id,version,raw_days,preview_days,face_crop_days,free_cache_days,audit_days,legal_hold,updated_at) VALUES('default',1,60,60,14,2,30,1,?)",now);
    await h.db.run('INSERT INTO asset_retention(asset_id,raw_expires_at,preview_expires_at,legal_hold,updated_at) VALUES(?,?,?,1,?)',held.id,now+DAY,now+DAY,now);
    for(const photo of [held,unheld]){
      await h.db.run("INSERT INTO cleanup_intents(id,subject_id,bucket,object_key,status,created_at) VALUES(?,?,'QUARANTINE',?,'pending',?)",key(),owner.account_id,photo.objectKey,createdAt);
      await h.db.run("INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at) VALUES(?,?,'QUARANTINE',?,'pending',?)",key(),owner.account_id,photo.objectKey,createdAt);
    }
    const global=await maintenance(h,now);assert.equal(global.status,200);assert.equal(global.body.privacy_health.holds.global_retention_active,true);
    assert.equal(global.body.privacy_health.cleanup.target_overdue_held,2);assert.equal(global.body.privacy_health.writers.target_overdue_unheld,0);
    await h.db.run("UPDATE retention_settings SET legal_hold=0 WHERE id='default'");
    const scoped=await maintenance(h,now);assert.equal(scoped.status,503);const health=scoped.body.privacy_health;
    assert.equal(health.holds.global_retention_active,false);assert.equal(health.holds.active_asset_holds,1);
    for(const cohort of [health.cleanup,health.writers]){
      assert.equal(cohort.held,1);assert.equal(cohort.unheld,1);assert.equal(cohort.target_overdue_held,1);assert.equal(cohort.target_overdue_unheld,1);assert.equal(cohort.oldest_age_seconds,(DAY+1000)/1000);
    }
    const moderation=key();await h.db.run("INSERT INTO moderation_holds(id,subject_id,active,created_at,reason) VALUES(?,?,1,?,'PRIVATE_HOLD_NOTE')",moderation,owner.account_id,now);
    const subject=await maintenance(h,now);assert.equal(subject.body.privacy_health.holds.active_moderation_holds,1);assert.equal(subject.body.privacy_health.writers.held,2);
    assert.equal(subject.body.privacy_health.writers.oldest_age_seconds,(DAY+1000)/1000);
    for(const photo of [held,unheld]){assert(await h.env.QUARANTINE.head(photo.objectKey));assert.equal((await h.db.one('SELECT deleted_at FROM assets WHERE id=?',photo.id)).deleted_at,null);}
    assert.equal((await h.db.one("SELECT count(*) n FROM cleanup_intents WHERE status='verified'")).n,0);
    assert.equal((await h.db.one("SELECT count(*) n FROM media_write_intents WHERE status='settled'")).n,0);
    aggregateOnly(subject.body,[owner.account_id,held.id,unheld.id,held.objectKey,unheld.objectKey,moderation,'PRIVATE_HOLD_NOTE']);
  }finally{await h.close();}
});

test('a backlog query failure returns unavailable null metrics and cannot publish a healthy maintenance response or storage completion',async()=>{
  const h=await startHarness({consumeQueue:false});try{
    const now=Date.now(),owner=await h.anonymous(),photo=await asset(h,owner,now),fault='PRIVATE_DATABASE_FAILURE_'+key();let reads=0;
    const db=new Proxy(h.db,{get(target,name){
      if(name==='one')return async(sql,...bindings)=>{if(sql.includes('WITH deletion_backlog AS')){reads++;throw Error(fault);}return target.one(sql,...bindings);};
      const value=Reflect.get(target,name);return typeof value==='function'?value.bind(target):value;
    }});
    const denied=await maintenance(h,now,{db,authorization:null});assert.equal(denied.status,404);assert.equal(reads,0);
    const result=await maintenance(h,now,{db});assert.equal(result.status,503);assert.equal(reads,1);assert(result.body.maintenance_errors>0);
    assert.equal(result.body.processed,0);assert.equal(result.body.failed,0);assert.equal(result.body.retention.status,'observed');
    const health=result.body.privacy_health;assert.equal(health.status,'unavailable');
    for(const field of ['holds','deletion_requests','cleanup','writers'])assert.equal(health[field],null);
    assert.equal((await h.db.one('SELECT status,deleted_at FROM assets WHERE id=?',photo.id)).status,'uploaded');assert(await h.env.QUARANTINE.head(photo.objectKey));
    assert.equal((await h.db.one('SELECT count(*) n FROM retention_jobs')).n,0);assert.equal((await h.db.one('SELECT count(*) n FROM cleanup_intents')).n,0);
    aggregateOnly(result.body,[owner.account_id,photo.id,photo.objectKey,fault]);
  }finally{await h.close();}
});
