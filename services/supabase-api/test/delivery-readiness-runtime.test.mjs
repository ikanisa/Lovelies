import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startHarness,enroll,captureProofs,faceVerifierFixture,fixturePng,sha256} from './runtime-harness.mjs';
import {enqueueNotification,processNotificationJob,flushNotificationOutbox} from '../src/notifications.ts';
import {processPhotoJob,flushPhotoOutbox} from '../src/processing.ts';
import {PostgresJobQueue,drainJobs,jobDomainPending} from '../src/jobs.ts';
import {pushBinding} from './push-fixture.mjs';
import {uploadBudgetKeys} from '../src/upload-budgets.ts';
import {requireQueueAdmission} from '../src/queue-admission.ts';
import {MATCH_PAGE_SIZE,MATCH_PLAN_PROTOCOL,MATCH_RANK_PROTOCOL} from '../src/photo-matching.ts';

const key=()=>crypto.randomUUID(),deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function seedExport(h,owner){
    const id=key(),publication=key(),object='synthetic-export/'+id,bytes=new TextEncoder().encode('{"synthetic":"recoverable export"}'),hash=await sha256(bytes),now=h.app.now(),expires=now+86400000;
    await h.db.run("INSERT INTO privacy_requests(id,subject_id,requested_by,request_type,status,created_at,expires_at,completed_at,export_key,export_sha256,export_bytes,export_expires_at) VALUES(?,?,?,'export','completed',?,?,?,?,?,?,?)",id,owner.accountId,owner.accountId,now,expires,now,object,hash,bytes.length,expires);
    await h.db.run("INSERT INTO privacy_exports(id,request_id,subject_id,object_key,sha256,bytes,expires_at,status,created_at) VALUES(?,?,?,?,?,?,?,'published',?)",publication,id,owner.accountId,object,hash,bytes.length,expires,now);
    await h.env.PRIVACY_EXPORTS.put(object,bytes);return {id,object,bytes,hash};
}
async function queuedPhoto(h,owner){
    const bytes=fixturePng(key()),reservation=await h.json('/uploads/session',{token:owner.token,body:{source:'personal',content_type:'image/png',byte_size:bytes.length,operation_key:key()}},201);
    await h.json(reservation.upload_url,{token:owner.token,method:'PUT',raw:bytes,headers:{'content-type':'image/png'}});
    return {...reservation,...await h.json(reservation.complete_url,{token:owner.token,body:{operation_key:key()}},202)};
}

// One embedded PostgreSQL instance, sequential subtests. No provider/network or
// hosted readiness claims; real application routes and database constraints run.
test('recoverable deliveries, durable handoff, and bounded matching',{timeout:180000},async t=>{
    const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});t.after(()=>h.close());
    const owner=await enroll(h),other=await enroll(h);let matchingOwner;
    await t.test('export retry retains exact bytes until acknowledged; acknowledgement replay is durable',async()=>{
        const e=await seedExport(h,owner),operation=key(),path=`/privacy-exports/${e.id}/deliveries`;
        const first=await h.json(path,{token:owner.token,body:{operation_key:operation}});
        assert.equal(first.protocol,'lovelies-privacy-export-delivery-v2');assert.equal(first.account_id,owner.accountId);
        assert.equal(first.session_id,JSON.parse(Buffer.from(owner.token.split('.')[1],'base64url')).jti);
        assert.equal(first.sha256,e.hash);assert.equal(first.bytes,e.bytes.length);
        assert.deepEqual(await h.json(path,{token:owner.token,body:{operation_key:operation}}),first);
        assert.equal((await h.db.one('SELECT count(*) n FROM privacy_export_deliveries WHERE request_id=?',e.id)).n,1);
        for(let repeat=0;repeat<2;repeat++){
            const response=await h.request(first.retrieve_path,{token:owner.token});assert.equal(response.status,200);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),e.bytes);
        }
        assert(await h.env.PRIVACY_EXPORTS.head(e.object));
        await h.json(first.retrieve_path,{token:other.token},404);
        await h.json(first.ack_path,{token:owner.token,body:{operation_key:key(),sha256:'0'.repeat(64)}},409);
        const ackKey=key(),ack=await h.json(first.ack_path,{token:owner.token,body:{operation_key:ackKey,sha256:e.hash}});
        assert.equal(ack.acknowledged,true);assert.deepEqual(await h.json(first.ack_path,{token:owner.token,body:{operation_key:ackKey,sha256:e.hash}}),ack);
        assert.equal((await h.json(path,{token:owner.token,body:{operation_key:operation}})).state,'acknowledged');
        await h.json(first.retrieve_path,{token:owner.token},410);
        assert.equal((await h.db.one('SELECT status FROM privacy_exports WHERE request_id=?',e.id)).status,'retired');
        assert.equal((await h.db.one('SELECT count(*) n FROM cleanup_intents WHERE request_id=?',e.id)).n,1);
        await assert.rejects(h.db.run('UPDATE privacy_export_deliveries SET sha256=? WHERE id=?','0'.repeat(64),first.delivery_id),/privacy_delivery_binding_immutable/);
    });
    await t.test('export rejects another live session and a deadline crossing after Storage read',async()=>{
        const e=await seedExport(h,owner),delivery=await h.json(`/privacy-exports/${e.id}/deliveries`,{token:owner.token,body:{operation_key:key()}});
        const challenge=await h.json('/auth/face/challenge',{body:{face_handle:owner.faceHandle,device_id:owner.deviceId}},201);
        const session=await h.json('/auth/face/complete',{body:await captureProofs(h,challenge,owner.keys.privateKey)});
        await h.json(delivery.retrieve_path,{token:session.access_token},409);
        const clock=h.app.now,get=h.env.PRIVACY_EXPORTS.get.bind(h.env.PRIVACY_EXPORTS);
        h.env.PRIVACY_EXPORTS.get=async object=>{const value=await get(object);h.app.now=()=>Date.parse(delivery.expires_at)+1;return value;};
        try{const response=await h.request(delivery.retrieve_path,{token:owner.token});assert(response.status>=400);assert.equal(response.headers.get('x-lovelies-privacy-export'),null);await response.body?.cancel();}
        finally{h.app.now=clock;h.env.PRIVACY_EXPORTS.get=get;}
        assert(await h.env.PRIVACY_EXPORTS.head(e.object),'read/transport failure must not consume export');
    });
    await t.test('export Storage metadata cannot authorize an oversized body or consume a failed read',async()=>{
        const e=await seedExport(h,owner),delivery=await h.json(`/privacy-exports/${e.id}/deliveries`,{token:owner.token,body:{operation_key:key()}});
        const get=h.env.PRIVACY_EXPORTS.get.bind(h.env.PRIVACY_EXPORTS);let cancelled=0;
        h.env.PRIVACY_EXPORTS.get=async object=>object===e.object?{size:e.bytes.length,body:new ReadableStream({start(c){c.enqueue(new Uint8Array(e.bytes.length+1));},cancel(){cancelled++;}})}:get(object);
        try{const failure=await h.json(delivery.retrieve_path,{token:owner.token},503);assert.equal(failure.error.code,'private_object_unverified');assert.equal(cancelled,1);}
        finally{h.env.PRIVACY_EXPORTS.get=get;}
        const retry=await h.request(delivery.retrieve_path,{token:owner.token});assert.equal(retry.status,200);assert.deepEqual(new Uint8Array(await retry.arrayBuffer()),e.bytes);
    });
    await t.test('notification pages cross 100 rows and stable ID is account authorized',async()=>{
        await h.db.transaction(async()=>{for(let i=0;i<107;i++)await h.db.run("INSERT INTO notifications(id,account_id,kind,entity_id,title,created_at) VALUES(?,?,'support',?,'Synthetic page',?)",key(),owner.accountId,key(),1700000000000+i);});
        const seen=new Set();let cursor,first;
        do{const page=await h.json('/me/notifications?limit=23'+(cursor?'&cursor='+cursor:''),{token:owner.token});first??=page;assert.deepEqual(page.items,page.notifications);
            for(const item of page.items){assert(!seen.has(item.id));seen.add(item.id);}cursor=page.page.next_cursor;
        }while(cursor);
        assert.equal(seen.size,107);assert.equal(first.page.total,107);
        const oldest=await h.db.one('SELECT id FROM notifications WHERE account_id=? ORDER BY created_at,id LIMIT 1',owner.accountId);
        assert.equal((await h.json('/me/notifications/'+oldest.id,{token:owner.token})).notification.id,oldest.id);
        await h.json('/me/notifications/'+oldest.id,{token:other.token},404);
        await h.json('/me/notifications?limit=23&cursor='+first.page.next_cursor,{token:other.token},400);
    });
    await t.test('late push acceptance survives opt-out and retired token; no replacement send',async()=>{
        const device=await h.json('/me/push-devices',{token:owner.token,body:{platform:'android',push_token:'synthetic-push-token-'+key(),operation_key:key()}});
        const note=await h.db.transaction(()=>enqueueNotification(h.app,owner.accountId,'support',key(),'Your support request was reviewed'));
        const entered=deferred(),release=deferred();let sends=0;
        h.env.PUSH_SERVICE={fetch:async(_url,init)=>{assert.equal(init.method,'POST');sends++;const input=JSON.parse(init.body);entered.resolve();await release.promise;return Response.json({...pushBinding(input),operation_key:input.operation_key,status:'accepted',provider_message_id:'synthetic-late-receipt'});}};
        const pending=processNotificationJob({notification_id:note},h.app);void pending.catch(()=>{});
        await entered.promise;
        await h.json('/me/notification-settings',{token:owner.token,method:'PATCH',body:{support_alerts:false,operation_key:key()}});
        await h.json('/me/push-devices/'+device.id,{token:owner.token,method:'DELETE',body:{operation_key:key()}});
        release.resolve();await pending;
        assert.deepEqual(await h.db.one('SELECT status,provider_receipt FROM notification_deliveries WHERE notification_id=?',note),{status:'accepted',provider_receipt:'synthetic-late-receipt'});
        await flushNotificationOutbox(h.app);assert.equal((await h.db.one('SELECT status FROM notification_jobs WHERE notification_id=?',note)).status,'accepted');
        assert.equal(sends,1);
        await assert.rejects(h.db.run("UPDATE notification_deliveries SET status='cancelled' WHERE notification_id=?",note),/notification_delivery_binding_immutable/);
    });
    await t.test('queue conflict preserves stopped history and requires explicit repair without stealing an active lease',async()=>{
        await h.json('/me/notification-settings',{token:owner.token,method:'PATCH',body:{support_alerts:true,operation_key:key()}});
        const note=await h.db.transaction(()=>enqueueNotification(h.app,owner.accountId,'support',key(),'Your support request was reviewed')),queue=new PostgresJobQueue(h.db,h.app.now),message={category:'notification',payload:{notification_id:note}};
        await queue.send(message);let row=await h.db.one('SELECT * FROM job_queue WHERE payload_json=?',JSON.stringify({notification_id:note}));
        for(const state of ['completed','failed']){
            await h.db.run('UPDATE job_queue SET state=?,attempts=20,available_at=?,completed_at=? WHERE id=?',state,h.app.now(),h.app.now(),row.id);
            const before=await h.db.one('SELECT * FROM job_queue WHERE id=?',row.id),receipt=await queue.send(message);
            assert.equal(receipt.admission,'terminal');assert.equal(receipt.domain_terminal,false);
            assert.throws(()=>requireQueueAdmission(receipt),{code:'job_queue_reconciliation_required'});
            row=await h.db.one('SELECT * FROM job_queue WHERE id=?',row.id);assert.deepEqual(row,before);
        }
        assert.equal(row.handoff_count,0);
        const lease=key();await h.db.run("UPDATE job_queue SET state='processing',lease_token=?,lease_until=? WHERE id=?",lease,h.app.now()+60000,row.id);
        requireQueueAdmission(await queue.send(message));assert.equal((await h.db.one('SELECT lease_token FROM job_queue WHERE id=?',row.id)).lease_token,lease);
        await h.db.run("UPDATE notification_jobs SET status='cancelled' WHERE notification_id=?",note);
        await h.db.run("UPDATE job_queue SET state='completed',lease_token=NULL,lease_until=NULL WHERE id=?",row.id);
        const settled=await queue.send(message);assert.equal(settled.domain_terminal,true);requireQueueAdmission(settled);
        assert.equal((await h.db.one('SELECT state FROM job_queue WHERE id=?',row.id)).state,'completed');
        const damaged=new Proxy(h.db,{get(target,property){
            if(property==='one')return async(sql,...args)=>{const value=await target.one(sql,...args);return sql.startsWith('SELECT category,payload_json,state FROM job_queue')?{...value,state:'unknown'}:value;};
            const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
        }});
        await assert.rejects(new PostgresJobQueue(damaged,h.app.now).send(message),error=>error.code==='job_queue_binding_invalid');
    });
    await t.test('1001 captured profiles finish bounded global-ranking pages and exact queue repair before one publication',async()=>{
        const now=h.app.now();
        await h.db.transaction(async()=>{
            await h.db.run("INSERT INTO accounts(id,identity_state,created_at) SELECT '00000000-0000-4000-8000-'||lpad(i::text,12,'0'),'registered_face',? FROM generate_series(1,1001) i",now);
            await h.db.run("INSERT INTO account_audience(account_id,age_band,status,version,declared_at,policy_version) SELECT id,'18_plus','eligible',1,?,'audience-2026-10-24-v1' FROM accounts WHERE id LIKE '00000000-0000-4000-8000-%'",now);
            await h.db.run("INSERT INTO account_preferences(account_id,receive_matches,updated_at) SELECT id,1,? FROM accounts WHERE id LIKE '00000000-0000-4000-8000-%'",now);
            await h.db.run("INSERT INTO consents(id,account_id,purpose,policy_version,status,created_at) SELECT replace(id,'00000000-','00000001-'),id,'photo_matching',?,'granted',? FROM accounts WHERE id LIKE '00000000-0000-4000-8000-%'",h.env.PHOTO_CONSENT_POLICY_VERSION,now);
            await h.db.run("INSERT INTO face_profiles(account_id,id,revision,model_id,template_key,template_digest,status,consent_id,auth_epoch) SELECT id,replace(id,'00000000-','00000002-'),'snapshot-v1',?,'registered-face/'||id||'/synthetic',?,'active',replace(id,'00000000-','00000001-'),1 FROM accounts WHERE id LIKE '00000000-0000-4000-8000-%'",h.env.PHOTO_MODEL_VERSION,'a'.repeat(64));
        });
        matchingOwner=await enroll(h);
        await h.json('/me/photo-preferences',{token:matchingOwner.token,body:{processing_consent:true,policy_version:h.env.PHOTO_CONSENT_POLICY_VERSION,operation_key:key()}});
        const calls=[],preview=fixturePng('same-preview'),first='00000000-0000-4000-8000-000000000001';
        h.env.PHOTO_PROCESSOR={fetch:async request=>{
            const input=await request.json();calls.push(structuredClone(input));assert(input.profiles.length<=MATCH_PAGE_SIZE);assert.equal(input.ranking_protocol,MATCH_RANK_PROTOCOL);
            const candidates=input.profiles.map(p=>({account_id:p.account_id,profile_id:p.profile_id,profile_version:p.revision,model_version:p.model_id,distance:p.account_id===first?0.1:0.8}))
                .sort((a,b)=>a.distance-b.distance||a.account_id.localeCompare(b.account_id)).slice(0,2);
            return Response.json({...input,ranking:{protocol:MATCH_RANK_PROTOCOL,query_sha256:'c'.repeat(64),threshold:.42,review_margin:.05,faces:[{face_index:0,candidates}]},
                ...(input.include_preview?{preview:{bytes_base64:Buffer.from(preview).toString('base64'),content_type:'image/png',width:1,height:1}}:{})});
        }};
        const photo=await queuedPhoto(h,matchingOwner),attempt=await h.db.one('SELECT profiles_json,profile_batch_count FROM processing_attempts WHERE id=?',photo.attempt_id);
        assert.equal(attempt.profile_batch_count,0);assert.equal(JSON.parse(attempt.profiles_json).protocol,MATCH_PLAN_PROTOCOL);assert.equal(JSON.parse(attempt.profiles_json).profile_count,1001);
        assert.equal((await h.db.one('SELECT count(*) n FROM processing_attempt_profiles WHERE attempt_id=?',photo.attempt_id)).n,1001);
        assert.deepEqual(await processPhotoJob({attempt_id:photo.attempt_id},h.app),{pending:true});
        assert.equal((await h.db.one('SELECT status FROM assets WHERE id=?',photo.asset_id)).status,'processing');
        assert.equal((await h.db.one('SELECT count(*) n FROM candidates WHERE asset_id=?',photo.asset_id)).n,0);
        const queue=await h.db.one("SELECT id FROM job_queue WHERE category='photo' AND json_extract(payload_json,'$.attempt_id')=?",photo.attempt_id);
        await h.db.run("UPDATE job_queue SET state='completed',attempts=20,error_code='synthetic_lost_page_ack',completed_at=? WHERE id=?",h.app.now(),queue.id);
        const stopped=await h.db.one('SELECT * FROM job_queue WHERE id=?',queue.id);
        await h.db.run("UPDATE photo_job_outbox SET status='pending',dispatched_at=NULL,last_examined_at=NULL WHERE attempt_id=?",photo.attempt_id);
        await assert.rejects(flushPhotoOutbox(h.app),{code:'job_queue_reconciliation_required'});assert.deepEqual(await h.db.one('SELECT * FROM job_queue WHERE id=?',queue.id),stopped);
        const operator=await enroll(h);await h.db.run('UPDATE accounts SET roles_json=? WHERE id=?','["user","admin"]',operator.accountId);
        const challenge=await h.json('/auth/face/challenge',{body:{face_handle:operator.faceHandle,device_id:operator.deviceId}},201);
        const admin=await h.json('/auth/face/complete',{body:await captureProofs(h,challenge,operator.keys.privateKey)}),path='/admin/queue-repairs/'+queue.id;
        const repair=(await h.json(path,{token:admin.access_token})).queue_repair;assert.equal(repair.eligible,true);
        await h.json(path,{token:admin.access_token,body:{operation_key:key(),expected_fingerprint:repair.fingerprint,reason:'Resume the exact committed matching checkpoint after a stopped queue acknowledgement.'}});
        assert.deepEqual(await h.db.one('SELECT state,attempts,error_code FROM job_queue WHERE id=?',queue.id),{state:'pending',attempts:20,error_code:'synthetic_lost_page_ack'});
        for(let page=1;page<Math.ceil(1001/MATCH_PAGE_SIZE);page++){
            const progress=await processPhotoJob({attempt_id:photo.attempt_id},h.app);
            if(page<Math.ceil(1001/MATCH_PAGE_SIZE)-1){assert.deepEqual(progress,{pending:true});assert.equal((await h.db.one('SELECT count(*) n FROM renditions WHERE asset_id=?',photo.asset_id)).n,0);}
        }
        assert.deepEqual(calls.map(input=>input.profiles.length),[128,128,128,128,128,128,128,105]);
        assert.equal(new Set(calls.flatMap(input=>input.profiles.map(p=>p.account_id))).size,1001);
        assert(calls.slice(0,-1).every(input=>input.include_preview===false));assert.equal(calls.at(-1).include_preview,true);
        assert.equal((await h.db.one('SELECT status FROM assets WHERE id=?',photo.asset_id)).status,'ready');
        assert.deepEqual(await h.db.all('SELECT recipient_id FROM candidates WHERE asset_id=?',photo.asset_id),[{recipient_id:first}]);
        assert.equal((await h.db.one('SELECT count(*) n FROM renditions WHERE asset_id=?',photo.asset_id)).n,1);
        assert.deepEqual(await drainJobs(h.app,1),{processed:1,failed:0});assert.equal((await h.db.one('SELECT state FROM job_queue WHERE id=?',queue.id)).state,'completed');
        assert.equal((await h.db.one('SELECT count(*) n FROM media_grants WHERE asset_id=?',photo.asset_id)).n,0,'matching never creates recipient access');
        const lookup=await h.community(matchingOwner.token,'photos.lookup',{asset_ids:[photo.asset_id,key()],source:'all'});assert.equal(lookup.items[0].id,photo.asset_id);assert.equal(lookup.unavailable_ids.length,1);
        const hidden=await h.community(other.token,'photos.lookup',{asset_ids:[photo.asset_id],source:'all'});assert.equal(hidden.items.length,0);
        // Subsequent race fixtures need two 128-reference pages; this case
        // proves the complete 1001-profile capture and publication path.
        await h.db.run("UPDATE accounts SET disabled_at=? WHERE id LIKE '00000000-0000-4000-8000-%' AND id>?",h.app.now(),'00000000-0000-4000-8000-000000000129');
    });
    for(const withdrawal of ['consent','profile','audience'])await t.test(`final publication rejects ${withdrawal} change to a retained global winner after its page`,async()=>{
        const photo=await queuedPhoto(h,matchingOwner);assert.deepEqual(await processPhotoJob({attempt_id:photo.attempt_id},h.app),{pending:true});
        const first='00000000-0000-4000-8000-000000000001',now=h.app.now();
        if(withdrawal==='consent')await h.db.run("UPDATE consents SET status='revoked',revoked_at=? WHERE account_id=? AND purpose='photo_matching'",now,first);
        if(withdrawal==='profile')await h.db.run("UPDATE face_profiles SET revision='changed-profile' WHERE account_id=?",first);
        if(withdrawal==='audience')await h.db.run("UPDATE account_audience SET status='suspended',version=version+1 WHERE account_id=?",first);
        try{
            await assert.rejects(processPhotoJob({attempt_id:photo.attempt_id},h.app),error=>error.code==='matching_profile_changed');
            for(const table of ['candidates','match_origins','renditions','media_grants'])assert.equal((await h.db.one(`SELECT count(*) n FROM ${table} WHERE asset_id=?`,photo.asset_id)).n,0);
            assert.equal((await h.db.one('SELECT status FROM assets WHERE id=?',photo.asset_id)).status,'failed');
        }finally{
            if(withdrawal==='consent')await h.db.run("UPDATE consents SET status='granted',revoked_at=NULL WHERE account_id=? AND purpose='photo_matching'",first);
            if(withdrawal==='profile')await h.db.run("UPDATE face_profiles SET revision='snapshot-v1' WHERE account_id=?",first);
            if(withdrawal==='audience')await h.db.run("UPDATE account_audience SET status='eligible',version=version-1 WHERE account_id=?",first);
        }
    });
    await t.test('a lost page commit acknowledgement resumes the next captured ordinal exactly once',async()=>{
        const photo=await queuedPhoto(h,matchingOwner),transaction=h.db.transaction;let mark=false,lost=false,depth=0;
        const one=h.db.one;
        h.db.one=async function(sql,...args){const value=await one.call(this,sql,...args);if(sql.startsWith('UPDATE processing_match_progress')&&args.includes(photo.attempt_id))mark=true;return value;};
        h.db.transaction=async function(callback,...args){depth++;let value;try{value=await transaction.call(this,callback,...args);}finally{depth--;}
            if(depth===0&&mark&&!lost){lost=true;throw Error('synthetic_page_commit_reply_lost');}return value;};
        try{await assert.rejects(processPhotoJob({attempt_id:photo.attempt_id},h.app),/synthetic_page_commit_reply_lost/);assert(lost);}
        finally{h.db.one=one;h.db.transaction=transaction;}
        assert.equal((await h.db.one('SELECT status FROM processing_attempts WHERE id=?',photo.attempt_id)).status,'queued');
        assert.equal((await h.db.one('SELECT next_ordinal FROM processing_match_progress WHERE attempt_id=?',photo.attempt_id)).next_ordinal,128);
        assert.equal((await h.db.one('SELECT count(*) n FROM renditions WHERE asset_id=?',photo.asset_id)).n,0);
        // A newly eligible registered profile cannot be added during recovery.
        await h.json('/me/photo-preferences',{token:other.token,body:{photo_matching_consent:true,receive_matches:true,policy_version:h.env.PHOTO_CONSENT_POLICY_VERSION,operation_key:key()}});
        const processor=h.env.PHOTO_PROCESSOR,calls=[];
        h.env.PHOTO_PROCESSOR={fetch:async(...args)=>{calls.push((await args[0].clone().json()).profiles.map(p=>p.account_id));return processor.fetch(...args);}};
        try{await processPhotoJob({attempt_id:photo.attempt_id},h.app);await processPhotoJob({attempt_id:photo.attempt_id},h.app);assert.deepEqual(calls,[['00000000-0000-4000-8000-000000000129']]);}
        finally{h.env.PHOTO_PROCESSOR=processor;}
        assert.deepEqual(await h.db.all('SELECT recipient_id FROM candidates WHERE asset_id=?',photo.asset_id),[{recipient_id:'00000000-0000-4000-8000-000000000001'}]);
        assert.equal((await h.db.one('SELECT count(*) n FROM renditions WHERE asset_id=?',photo.asset_id)).n,1);
        await h.json('/me/photo-preferences',{token:other.token,body:{photo_matching_consent:false,receive_matches:false,policy_version:h.env.PHOTO_CONSENT_POLICY_VERSION,operation_key:key()}});
    });
    await t.test('premature preview, changed query and unknown batch/domain state cannot publish or complete',async()=>{
        const early=await queuedPhoto(h,matchingOwner);
        const processor=h.env.PHOTO_PROCESSOR;
        h.env.PHOTO_PROCESSOR={fetch:async(...args)=>{const response=await processor.fetch(...args),value=await response.json();
            value.preview={bytes_base64:Buffer.from(fixturePng('premature-preview')).toString('base64'),content_type:'image/png',width:1,height:1};return Response.json(value);}};
        try{await assert.rejects(processPhotoJob({attempt_id:early.attempt_id},h.app),error=>error.code==='matching_query_changed');}
        finally{h.env.PHOTO_PROCESSOR=processor;}
        const photo=await queuedPhoto(h,matchingOwner);assert.deepEqual(await processPhotoJob({attempt_id:photo.attempt_id},h.app),{pending:true});
        h.env.PHOTO_PROCESSOR={fetch:async(...args)=>{const response=await processor.fetch(...args),value=await response.json();value.ranking.query_sha256='d'.repeat(64);
            value.preview.bytes_base64=Buffer.from(fixturePng('changed-preview')).toString('base64');return Response.json(value);}};
        try{await assert.rejects(processPhotoJob({attempt_id:photo.attempt_id},h.app),error=>error.code==='matching_query_changed');}
        finally{h.env.PHOTO_PROCESSOR=processor;}
        for(const item of [early,photo])for(const table of ['candidates','match_origins','renditions','media_grants'])
            assert.equal((await h.db.one(`SELECT count(*) n FROM ${table} WHERE asset_id=?`,item.asset_id)).n,0);
        await assert.rejects(h.db.run("INSERT INTO processing_profile_batches(attempt_id,batch_index,profiles_json,status) VALUES(?,0,'[]','unknown')",photo.attempt_id),/check constraint/);
        await h.db.run("UPDATE processing_attempts SET status='unknown' WHERE id=?",photo.attempt_id);
        const queue=await h.db.one("SELECT id FROM job_queue WHERE category='photo' AND json_extract(payload_json,'$.attempt_id')=?",photo.attempt_id);
        await h.db.run("UPDATE job_queue SET state='completed' WHERE id=?",queue.id);
        const receipt=await new PostgresJobQueue(h.db,h.app.now).send({category:'photo',payload:{attempt_id:photo.attempt_id}});
        assert.equal(receipt.domain_terminal,false);assert.throws(()=>requireQueueAdmission(receipt),{code:'job_queue_reconciliation_required'});
        await assert.rejects(jobDomainPending(h.db,'photo',{attempt_id:photo.attempt_id}),{code:'job_domain_state_unverified'});
        assert.equal((await h.db.one('SELECT state FROM job_queue WHERE id=?',queue.id)).state,'completed');
        await h.db.run("UPDATE processing_attempts SET status='failed' WHERE id=?",photo.attempt_id);
    });
    await t.test('configured reservation budgets are atomic and cancellation does not refund daily work',async()=>{
        const saved=Object.fromEntries(uploadBudgetKeys.map(name=>[name,h.env[name]])),person=await enroll(h);
        await h.json('/me/photo-preferences',{token:person.token,body:{processing_consent:true,policy_version:h.env.PHOTO_CONSENT_POLICY_VERSION,operation_key:key()}});
        const reserve=bytes=>h.request('/uploads/session',{token:person.token,body:{source:'personal',content_type:'image/png',byte_size:bytes,operation_key:key()}});
        try{
            h.env.UPLOAD_MAX_INFLIGHT='1';h.env.UPLOAD_MAX_RESERVED_SOURCE_BYTES='100';h.env.UPLOAD_MAX_DAILY_SOURCE_BYTES='100';h.env.UPLOAD_MAX_DAILY_RESERVATIONS='10';
            const raced=await Promise.all([reserve(60),reserve(60)]),statuses=raced.map(r=>r.status).sort();assert.deepEqual(statuses,[201,429]);
            const values=await Promise.all(raced.map(r=>r.json())),first=values.find(v=>v.asset_id);assert(values.some(v=>v.error?.code==='upload_inflight_budget_exceeded'));
            await h.db.run("UPDATE assets SET status='failed' WHERE id=?",first.asset_id);h.env.UPLOAD_MAX_INFLIGHT='10';
            const secondResponse=await reserve(40);assert.equal(secondResponse.status,201);const second=await secondResponse.json();
            assert.equal((await (await reserve(1)).json()).error.code,'upload_source_budget_exceeded');
            await h.db.run("UPDATE assets SET status='cancelled' WHERE id=?",second.asset_id);
            const asset=await h.db.one('SELECT object_key FROM assets WHERE id=?',second.asset_id),cleanup=key();
            await h.db.run("INSERT INTO cleanup_intents(id,subject_id,bucket,object_key,status,created_at) VALUES(?,?,'QUARANTINE',?,'pending',?)",cleanup,person.accountId,asset.object_key,h.app.now());
            assert.equal((await (await reserve(1)).json()).error.code,'upload_source_budget_exceeded');
            await h.db.run("UPDATE cleanup_intents SET status='verified',verified_at=? WHERE id=?",h.app.now(),cleanup);
            assert.equal((await (await reserve(1)).json()).error.code,'upload_daily_bytes_budget_exceeded');
            h.env.UPLOAD_MAX_DAILY_SOURCE_BYTES='1000';h.env.UPLOAD_MAX_DAILY_RESERVATIONS='2';
            assert.equal((await (await reserve(1)).json()).error.code,'upload_daily_reservation_budget_exceeded');
            h.env.UPLOAD_MAX_DAILY_RESERVATIONS='3';const released=await reserve(40);assert.equal(released.status,201);await released.body?.cancel();
            delete h.env.UPLOAD_MAX_INFLIGHT;
            const ready=await h.json('/ready',{},503);assert(ready.missing.includes('UPLOAD_MAX_INFLIGHT'));
            assert.equal((await (await reserve(1)).json()).error.code,'upload_budget_configuration_required');
        }finally{Object.assign(h.env,saved);}
    });
    await t.test('processing-attempt daily budget denies a new inference operation before capture/queue',async()=>{
        const saved=h.env.PHOTO_MAX_DAILY_ATTEMPTS,count=(await h.db.one('SELECT count(*) n FROM processing_attempts WHERE owner_id=?',matchingOwner.accountId)).n;
        const bytes=fixturePng('attempt-budget'),reservation=await h.json('/uploads/session',{token:matchingOwner.token,body:{source:'personal',content_type:'image/png',byte_size:bytes.length,operation_key:key()}},201);
        await h.json(reservation.upload_url,{token:matchingOwner.token,method:'PUT',raw:bytes,headers:{'content-type':'image/png'}});
        h.env.PHOTO_MAX_DAILY_ATTEMPTS=String(count);
        try{const response=await h.json(reservation.complete_url,{token:matchingOwner.token,body:{operation_key:key()}},429);assert.equal(response.error.code,'photo_daily_attempt_budget_exceeded');}
        finally{h.env.PHOTO_MAX_DAILY_ATTEMPTS=saved;}
        assert.equal((await h.db.one('SELECT count(*) n FROM processing_attempts WHERE asset_id=?',reservation.asset_id)).n,0);
    });
});
