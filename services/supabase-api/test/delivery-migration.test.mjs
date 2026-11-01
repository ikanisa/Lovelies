import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const folder=new URL('../../../supabase/migrations/',import.meta.url),name='20261029120000_delivery_reliability.sql';
const migration=fs.readFileSync(new URL(name,folder),'utf8');
const rows=async(engine,sql,values=[])=>(await engine.query(sql,values)).rows;
const backend=async(engine,callback)=>{await engine.exec('SET ROLE lovelies_api');try{return await callback();}finally{await engine.exec('RESET ROLE');}};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function snapshot(engine){
    const names=(await rows(engine,"SELECT tablename FROM pg_tables WHERE schemaname='lovelies_private' ORDER BY tablename")).map(row=>row.tablename),result={};
    await backend(engine,async()=>{for(const table of names){
        assert(/^[a-z_]+$/.test(table));let projected='to_jsonb(t)';
        if(table==='notification_deliveries')projected+="-'request_sha256'-'platform'-'provider_outcome'";
        if(table==='job_queue')projected+="-'handoff_count'";
        if(table==='processing_attempts')projected+="-'profile_batch_count'";
        result[table]=hash(await rows(engine,`SELECT ${projected} row FROM lovelies_private.${table} t ORDER BY (${projected})::text`));
    }});return result;
}
test('v14 preserves populated v13, rejects unsafe admission, and keeps private bindings immutable',{timeout:45000},async t=>{
    assert.equal(process.env.TEST_DATABASE_URL,undefined,'this fixture is embedded PostgreSQL only');
    const engine=await PGlite.create();t.after(()=>engine.close());await engine.exec('CREATE ROLE anon; CREATE ROLE authenticated;');
    for(const file of fs.readdirSync(folder).filter(file=>file.endsWith('.sql')&&file<name).sort())await engine.exec(fs.readFileSync(new URL(file,folder),'utf8'));
    const id=()=>randomUUID(),account=id(),session=id(),device=id(),push=id(),note=id(),delivery=id(),asset=id(),attempt=id(),request=id(),publication=id();
    await backend(engine,async()=>{
        await engine.query("INSERT INTO lovelies_private.accounts(id,name,created_at) VALUES($1,'Synthetic populated baseline',1)",[account]);
        await engine.query("INSERT INTO lovelies_private.sessions(id,account_id,refresh_hash,expires_at,refresh_expires_at,auth_epoch,auth_method,created_at) VALUES($1,$2,$3,10000,20000,1,'anonymous',1)",[session,account,id()]);
        await engine.query("INSERT INTO lovelies_private.auth_devices(id,account_id,public_jwk,revision,status,created_at) VALUES($1,$2,'{}','v1','active',1)",[device,account]);
        await engine.query("INSERT INTO lovelies_private.push_devices(id,account_id,auth_device_id,platform,token_hash,token_value,active,created_at,updated_at) VALUES($1,$2,$3,'android',$4,'synthetic-token',1,1,1)",[push,account,device,'a'.repeat(64)]);
        await engine.query("INSERT INTO lovelies_private.notifications(id,account_id,kind,entity_id,title,created_at) VALUES($1,$2,'support',$3,'Synthetic notice',1)",[note,account,id()]);
        await engine.query("INSERT INTO lovelies_private.notification_deliveries(id,notification_id,device_id,operation_key,status,token_hash,provider_receipt,attempts,created_at,updated_at) VALUES($1,$2,$3,$4,'accepted',$5,'legacy-accepted-receipt',1,1,1)",[delivery,note,push,'notification:'+note+':'+push,'a'.repeat(64)]);
        await engine.query("INSERT INTO lovelies_private.assets(id,owner_id,source,status,object_key,content_type,byte_size,version,created_at) VALUES($1,$2,'personal','processing',$3,'image/jpeg',10,'v1',1)",[asset,account,'source/'+asset]);
        await engine.query("INSERT INTO lovelies_private.processing_attempts(id,asset_id,source_version,source_checksum_sha256,model_version,status,captured_at,expires_at,owner_id,profiles_json) VALUES($1,$2,'v1',$3,'synthetic','queued',1,10000,$4,'[]')",[attempt,asset,'b'.repeat(64),account]);
        await engine.query("INSERT INTO lovelies_private.job_queue(id,category,payload_json,state,available_at,created_at,attempts,lease_token,lease_until) VALUES($1,'photo',$2,'processing',1,1,7,$3,10000)",['c'.repeat(64),JSON.stringify({attempt_id:attempt}),id()]);
        await engine.query("INSERT INTO lovelies_private.privacy_requests(id,subject_id,requested_by,request_type,status,created_at,expires_at,completed_at) VALUES($1,$2,$2,'export','completed',1,10000,2)",[request,account]);
        await engine.query("INSERT INTO lovelies_private.privacy_exports(id,request_id,subject_id,object_key,sha256,bytes,expires_at,status,created_at) VALUES($1,$2,$3,$4,$5,10,10000,'published',1)",[publication,request,account,'export/'+request,'d'.repeat(64)]);
        await engine.query("INSERT INTO lovelies_private.restore_control(singleton,project_id,database_id,incarnation_id,checkpoint_revision,checkpoint_hash,journal_sequence,journal_hash) VALUES(1,'ltqfplqevxztlswlzexn',$1,$2,0,$3,0,$4)",[id(),id(),'e'.repeat(64),'0'.repeat(64)]);
    });
    const before=await snapshot(engine);assert.equal(Object.keys(before).length,69);
    await t.test('wrong baseline and elevated backend role are rejected before DDL',async()=>{
        for(const change of ['DELETE FROM lovelies_private.schema_versions WHERE version=13','ALTER ROLE lovelies_api BYPASSRLS']){
            await engine.exec('BEGIN');
            try{await engine.exec(change);await assert.rejects(engine.exec(migration),/delivery_reliability_requires_schema_v13|unexpected_lovelies_api_role/);}
            finally{await engine.exec('ROLLBACK');}
            assert.deepEqual(await snapshot(engine),before);
        }
    });
    await t.test('a late guard collision rolls back all v14 DDL without an enclosing transaction',async()=>{
        // Run only the outer DO as one statement, with the surrounding SET and
        // RESET submitted separately. A multi-statement driver transaction must
        // not be the reason the version marker and guards commit atomically.
        const atomic=migration.slice(migration.indexOf('DO $delivery_reliability$'),migration.indexOf('RESET search_path;')).trim();
        assert(atomic.endsWith('END $delivery_reliability$;'));
        await engine.exec('SET search_path TO lovelies_private,pg_catalog');
        await engine.exec('CREATE FUNCTION lovelies_private.guard_notification_delivery_binding() RETURNS trigger LANGUAGE plpgsql AS $collision$ BEGIN RETURN NEW; END $collision$');
        try{
            await assert.rejects(engine.exec(atomic),/function.*guard_notification_delivery_binding.*already exists/);
            assert.deepEqual(await snapshot(engine),before,'old rows, table inventory and schema version are unchanged');
            assert.equal((await rows(engine,"SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='lovelies_private' AND ((table_name='notification_deliveries' AND column_name IN('request_sha256','platform','provider_outcome')) OR (table_name='job_queue' AND column_name='handoff_count') OR (table_name='processing_attempts' AND column_name='profile_batch_count'))"))[0].n,0);
            assert.equal((await rows(engine,"SELECT to_regprocedure('lovelies_private.guard_privacy_delivery_binding()') present"))[0].present,null,'earlier guard creation rolls back too');
        }finally{
            await engine.exec('DROP FUNCTION lovelies_private.guard_notification_delivery_binding()');
            await engine.exec('RESET search_path');
        }
    });
    await engine.exec(migration);
    await t.test('legacy rows/restore marker are preserved, with conservative nullable/default additions',async()=>{
        const after=await snapshot(engine);assert.equal(Object.keys(after).length,71);
        for(const table of Object.keys(before))if(table!=='schema_versions')assert.equal(after[table],before[table],table);
        await backend(engine,async()=>{
            const row=(await rows(engine,'SELECT request_sha256,platform,provider_outcome FROM lovelies_private.notification_deliveries WHERE id=$1',[delivery]))[0];
            assert.deepEqual({...row},{request_sha256:null,platform:null,provider_outcome:null});
            assert.equal(Number((await rows(engine,'SELECT handoff_count FROM lovelies_private.job_queue'))[0].handoff_count),0);
            assert.equal(Number((await rows(engine,'SELECT profile_batch_count FROM lovelies_private.processing_attempts'))[0].profile_batch_count),0);
            assert.deepEqual((await rows(engine,'SELECT version FROM lovelies_private.schema_versions ORDER BY version')).map(row=>Number(row.version)),[7,8,9,10,11,12,13,14]);
        });
    });
    await t.test('new tables are forced-RLS private and accepted push/request bindings cannot be rewritten',async()=>{
        const tables=await rows(engine,"SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='lovelies_private' AND c.relname IN('privacy_export_deliveries','processing_profile_batches')");
        assert.equal(tables.length,2);assert(tables.every(row=>row.relrowsecurity&&row.relforcerowsecurity));
        for(const role of ['anon','authenticated'])for(const table of tables)assert.equal((await rows(engine,'SELECT has_table_privilege($1,$2,$3) allowed',[role,'lovelies_private.'+table.relname,'SELECT,INSERT,UPDATE,DELETE']))[0].allowed,false);
        await backend(engine,async()=>{
            await assert.rejects(engine.query("UPDATE lovelies_private.notification_deliveries SET status='cancelled' WHERE id=$1",[delivery]),/notification_delivery_binding_immutable/);
            const exportDelivery=id();await engine.query("INSERT INTO lovelies_private.privacy_export_deliveries(id,request_id,subject_id,session_id,publication_id,operation_key,sha256,bytes,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,10,1000,1)",[exportDelivery,request,account,session,publication,id(),'d'.repeat(64)]);
            await assert.rejects(engine.query('UPDATE lovelies_private.privacy_export_deliveries SET session_id=$1 WHERE id=$2',[id(),exportDelivery]),/privacy_delivery_binding_immutable/);
            await engine.query('UPDATE lovelies_private.privacy_export_deliveries SET acknowledged_at=2 WHERE id=$1',[exportDelivery]);
            await assert.rejects(engine.query('UPDATE lovelies_private.privacy_export_deliveries SET acknowledged_at=NULL WHERE id=$1',[exportDelivery]),/privacy_delivery_binding_immutable/);
            await engine.query("INSERT INTO lovelies_private.processing_profile_batches(attempt_id,batch_index,profiles_json,status) VALUES($1,0,'[]','pending')",[attempt]);
            await assert.rejects(engine.query("UPDATE lovelies_private.processing_profile_batches SET status='unknown' WHERE attempt_id=$1",[attempt]));
        });
    });
    const after=await snapshot(engine);await assert.rejects(engine.exec(migration),/delivery_reliability_requires_schema_v13/);assert.deepEqual(await snapshot(engine),after);
});
