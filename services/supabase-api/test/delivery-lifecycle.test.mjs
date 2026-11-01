import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startHarness,enroll,captureProofs,faceVerifierFixture,sha256} from './runtime-harness.mjs';
import {pruneRetainedMetadata} from '../src/retention.ts';
import {processPrivacyJob,collectPrivacyExport} from '../src/privacy.ts';
import {retiredOperationInput,retiredOperationResponse} from '../src/operations.ts';

const key=()=>crypto.randomUUID(),DAY=86400000;
async function delivered(h,owner){
    const request=key(),publication=key(),object='synthetic-lifecycle/'+request,bytes=new TextEncoder().encode('{"synthetic":"lifecycle"}'),hash=await sha256(bytes),now=h.app.now(),expires=now+DAY;
    await h.db.run("INSERT INTO privacy_requests(id,subject_id,requested_by,request_type,status,created_at,expires_at,completed_at,export_key,export_sha256,export_bytes,export_expires_at) VALUES(?,?,?,'export','completed',?,?,?,?,?,?,?)",request,owner.accountId,owner.accountId,now,expires,now,object,hash,bytes.length,expires);
    await h.db.run("INSERT INTO privacy_exports(id,request_id,subject_id,object_key,sha256,bytes,expires_at,status,created_at) VALUES(?,?,?,?,?,?,?,'published',?)",publication,request,owner.accountId,object,hash,bytes.length,expires,now);
    await h.env.PRIVACY_EXPORTS.put(object,bytes);
    const createKey=key(),delivery=await h.json(`/privacy-exports/${request}/deliveries`,{token:owner.token,body:{operation_key:createKey}});
    return {request,publication,object,hash,createKey,delivery};
}
async function batch(h,owner,profiles){
    const asset=key(),attempt=key(),now=h.app.now();
    await h.db.run("INSERT INTO assets(id,owner_id,source,status,object_key,content_type,byte_size,version,created_at) VALUES(?,?,'personal','processing',?,'image/png',1,'v1',?)",asset,owner.accountId,'synthetic-batch/'+asset,now);
    await h.db.run("INSERT INTO processing_attempts(id,asset_id,source_version,source_checksum_sha256,model_version,status,captured_at,expires_at,owner_id,profiles_json,profile_batch_count) VALUES(?,?,'v1',?,'synthetic','queued',?,?,?,'[]',1)",attempt,asset,'a'.repeat(64),now,now+60000,owner.accountId);
    await h.db.run("INSERT INTO processing_profile_batches(attempt_id,batch_index,profiles_json,status,matches_json) VALUES(?,0,?,'pending',?)",attempt,JSON.stringify(profiles),JSON.stringify(profiles));
    return {asset,attempt};
}
test('new delivery and profile-batch records obey retention and subject erasure',{timeout:45000},async t=>{
    const h=await startHarness({faceVerifier:faceVerifierFixture,consumeQueue:false});t.after(()=>h.close());
    await t.test('annual delivery retirement waits for exact object cleanup and preserves minimal operation tombstones',async()=>{
        const owner=await enroll(h),e=await delivered(h,owner),ackKey=key();
        await h.json(e.delivery.ack_path,{token:owner.token,body:{operation_key:ackKey,sha256:e.hash}});
        const clock=h.app.now,read=()=>h.db.one('SELECT * FROM privacy_export_deliveries WHERE id=?',e.delivery.delivery_id);
        h.app.now=()=>clock()+367*DAY;
        try{
            await pruneRetainedMetadata(h.app);assert(await read(),'unverified cleanup retains the delivery and operation bindings');
            assert.notEqual((await h.db.one('SELECT payload_json FROM operations WHERE operation_key=?',e.createKey)).payload_json,retiredOperationInput);
            await h.env.PRIVACY_EXPORTS.delete(e.object);
            await h.db.run("UPDATE cleanup_intents SET status='verified',verified_at=? WHERE request_id=?",h.app.now(),e.request);
            await h.db.run("UPDATE retention_settings SET legal_hold=1 WHERE id='default'");await pruneRetainedMetadata(h.app);assert(await read(),'global legal hold retains delivery facts');
            await h.db.run("UPDATE retention_settings SET legal_hold=0 WHERE id='default'");
            const held=await batch(h,owner,[]),hold=key();
            await h.db.run("INSERT INTO moderation_holds(id,asset_id,active,created_at,reason) VALUES(?,?,1,?,'Synthetic owned asset hold')",hold,held.asset,h.app.now());
            await pruneRetainedMetadata(h.app);assert(await read(),'an owned asset moderation hold retains export delivery evidence after cleanup');
            await h.db.run('UPDATE moderation_holds SET active=0,cleared_at=? WHERE id=?',h.app.now(),hold);
            await h.db.run('INSERT INTO asset_retention(asset_id,raw_expires_at,preview_expires_at,legal_hold,updated_at) VALUES(?,?,?,1,?)',held.asset,h.app.now()+DAY,h.app.now()+DAY,h.app.now());
            await pruneRetainedMetadata(h.app);assert(await read(),'an owned asset retention hold retains export delivery evidence after cleanup');
            await h.db.run('UPDATE asset_retention SET legal_hold=0 WHERE asset_id=?',held.asset);
            for(let pass=0;pass<5&&await read();pass++)await pruneRetainedMetadata(h.app);
            assert.equal(await read(),null);
            for(const operation of [e.createKey,ackKey])assert.deepEqual(await h.db.one('SELECT payload_json,response_json FROM operations WHERE operation_key=?',operation),{payload_json:retiredOperationInput,response_json:retiredOperationResponse});
            assert.equal((await h.db.one('SELECT status FROM privacy_requests WHERE id=?',e.request)).status,'completed');
        }finally{h.app.now=clock;}
    });
    await t.test('account erasure removes deliveries/owned batches and redacts only the subject in foreign batches',async()=>{
        const subject=await enroll(h),other=await enroll(h),reviewer=await enroll(h),e=await delivered(h,subject);
        await h.db.run('UPDATE accounts SET roles_json=? WHERE id=?','["user","admin"]',reviewer.accountId);
        const challenge=await h.json('/auth/face/challenge',{body:{face_handle:reviewer.faceHandle,device_id:reviewer.deviceId}},201);
        const admin=await h.json('/auth/face/complete',{body:await captureProofs(h,challenge,reviewer.keys.privateKey)});
        const owned=await batch(h,subject,[]),kept={account_id:other.accountId,profile_id:key()},foreign=await batch(h,other,[{account_id:subject.accountId,profile_id:key()},kept]);
        const exported=await collectPrivacyExport(h.app,subject.accountId);assert.equal(exported.tables.export_deliveries.length,1);
        assert.deepEqual(Object.keys(exported.tables.export_deliveries[0]).sort(),['acknowledged_at','created_at','expires_at','id','request_id']);
        const request=(await h.json('/privacy/account-deletion',{token:subject.token,body:{operation_key:key()}},201)).privacy_request;
        await h.json('/privacy-requests/'+request.id+'/approve',{token:admin.access_token,body:{operation_key:key()}});
        await processPrivacyJob({request_id:request.id},h.app);
        assert.equal((await h.db.one('SELECT status FROM privacy_requests WHERE id=?',request.id)).status,'completed');
        assert.equal(await h.db.one('SELECT id FROM privacy_export_deliveries WHERE id=?',e.delivery.delivery_id),null);
        assert.equal(await h.db.one('SELECT attempt_id FROM processing_profile_batches WHERE attempt_id=?',owned.attempt),null);
        const saved=await h.db.one('SELECT profiles_json,matches_json FROM processing_profile_batches WHERE attempt_id=?',foreign.attempt);
        assert.deepEqual(JSON.parse(saved.profiles_json),[kept]);assert.deepEqual(JSON.parse(saved.matches_json),[kept]);
        assert.equal(await h.env.PRIVACY_EXPORTS.head(e.object),null);
    });
});
