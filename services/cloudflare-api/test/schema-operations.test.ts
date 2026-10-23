import { afterEach, describe, expect, it } from 'vitest';
import { SqlDatabase } from '../src/database';
import { initSchema } from '../src/schema';
import { executeOperation, prepareOperation, beginMediaWrite, beginEnrollmentMediaWrite, beginFaceChallengeMediaWrite, settleMediaWrite } from '../src/operations';
import { schemaFixture } from './schema-fixture';

const fixtures: ReturnType<typeof schemaFixture>[] = [];
const fixture = () => { const value=schemaFixture();fixtures.push(value);return value; };
afterEach(()=>{for(const f of fixtures.splice(0)) f.close();});

describe('SQLite authority and durable mutation identity',()=>{
  it('initializes idempotently with default anonymous and disabled matching preferences',()=>{
    const f=fixture();initSchema(f.db);const actor=f.actor(['user'],true);
    f.db.run('INSERT INTO account_preferences(account_id,updated_at) VALUES(?,?)',actor.accountId,f.ctx.now());
    expect(f.db.one('SELECT identity_state FROM accounts WHERE id=?',actor.accountId)).toEqual({identity_state:'anonymous'});
    expect(f.db.one('SELECT receive_matches,download_photos FROM account_preferences WHERE account_id=?',actor.accountId)).toEqual({receive_matches:0,download_photos:0});
    expect(f.db.one("SELECT name FROM sqlite_master WHERE name='otp_challenges'")).toBeNull();
    expect(f.db.one('SELECT count(*) n FROM schema_versions')).toEqual({n:7});
  });
  it('adds v3 deletion receipts to v2 without changing existing account or operation authority',async()=>{
    const f=fixture(),owner=f.actor(),intent=await prepareOperation('fixture.keep',{operation_key:'preserve-v2-'+crypto.randomUUID()});
    executeOperation(f.ctx,owner,intent,()=>({kept:true}));
    const session=f.db.one('SELECT * FROM sessions WHERE id=?',owner.sessionId);
    f.db.run('DROP INDEX privacy_deletion_receipt_expiry');
    f.db.run('DROP TABLE privacy_deletion_status_receipts');
    f.db.run('DELETE FROM schema_versions WHERE version>=3');
    initSchema(f.db);
    expect(f.db.one('SELECT * FROM sessions WHERE id=?',owner.sessionId)).toEqual(session);
    expect(executeOperation(f.ctx,owner,intent,()=>{throw new Error('replayed callback');})).toEqual({kept:true});
    expect(f.db.one('SELECT count(*) n FROM privacy_deletion_status_receipts')).toEqual({n:0});
    expect(f.db.one('SELECT max(version) version FROM schema_versions')).toEqual({version:7});
    expect(f.db.all('PRAGMA foreign_key_check')).toEqual([]);
  });
  it('refuses an existing weaker schema rather than silently marking its version ready',()=>{
    const f=fixture();
    f.db.run('DROP INDEX rendition_ready_preview');
    f.db.run("CREATE INDEX rendition_ready_preview ON renditions(asset_id,kind) WHERE status='ready'");
    expect(()=>initSchema(f.db)).toThrow('sqlite_schema_migration_required');
    // The historical differing object is preserved for a reviewed migration.
    expect(f.db.one<{sql:string}>("SELECT sql FROM sqlite_master WHERE name='rendition_ready_preview'")!.sql).not.toContain('UNIQUE');
  });
  it('adds v4 recovery metadata to v3 without changing issued sessions or approved operations',async()=>{
    const f=fixture(),owner=f.actor(),intent=await prepareOperation('fixture.keep',{operation_key:'preserve-v3-'+crypto.randomUUID()});
    executeOperation(f.ctx,owner,intent,()=>({kept:true}));
    const session=f.db.one('SELECT * FROM sessions WHERE id=?',owner.sessionId);
    f.db.run('DROP INDEX face_enrollment_expiry');f.db.run('DROP TABLE face_enrollment_intents');
    f.db.run('DELETE FROM schema_versions WHERE version>=4');initSchema(f.db);
    expect(f.db.one('SELECT * FROM sessions WHERE id=?',owner.sessionId)).toEqual(session);
    expect(executeOperation(f.ctx,owner,intent,()=>{throw new Error('replayed callback');})).toEqual({kept:true});
    expect(f.db.one('SELECT count(*) n FROM face_enrollment_intents')).toEqual({n:0});
    expect(f.db.one('SELECT max(version) version FROM schema_versions')).toEqual({version:7});
    expect(f.db.all('PRAGMA foreign_key_check')).toEqual([]);
  });
  it('rejects weaker v4 recovery bindings without marking the migration ready',()=>{
    const f=fixture();f.db.run('DROP INDEX face_enrollment_expiry');f.db.run('DROP TABLE face_enrollment_intents');
    f.db.run('DELETE FROM schema_versions WHERE version>=4');
    f.db.run('CREATE TABLE face_enrollment_intents(account_id TEXT,enrollment_key TEXT,expires_at INTEGER)');
    expect(()=>initSchema(f.db)).toThrow('sqlite_schema_migration_required');
    expect(f.db.one('SELECT max(version) version FROM schema_versions')).toEqual({version:3});
  });
  it('refuses weaker deletion receipt definitions without falsely advancing v2',()=>{
    const f=fixture();f.db.run('DROP INDEX privacy_deletion_receipt_expiry');f.db.run('DROP TABLE privacy_deletion_status_receipts');
    f.db.run('DELETE FROM schema_versions WHERE version>=3');
    f.db.run('CREATE TABLE privacy_deletion_status_receipts(request_id TEXT PRIMARY KEY,token_hash TEXT,operation_key TEXT,created_at INTEGER,expires_at INTEGER,revoked_at INTEGER)');
    expect(()=>initSchema(f.db)).toThrow('sqlite_schema_migration_required');
    expect(f.db.one('SELECT max(version) version FROM schema_versions')).toEqual({version:2});
  });
  it('adds v5 account recovery without changing v4 sessions, references, consents or approved subsets',()=>{
    const f=fixture(),owner=f.actor(),peer=f.actor(),snapshot=crypto.randomUUID(),preview=crypto.randomUUID();
    f.db.run('INSERT INTO sharing_snapshots(id,owner_id,source,version,graph_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)',snapshot,owner.accountId,'personal','same-version','{}',f.ctx.now(),f.ctx.now()+100000);
    f.db.run('INSERT INTO sharing_previews(id,owner_id,snapshot_id,source,version,draft_version,pairs_json,manifest_json,created_at,expires_at) VALUES(?,?,?,?,?,1,?,?,?,?)',preview,owner.accountId,snapshot,'personal','same-version',JSON.stringify([{asset_id:crypto.randomUUID(),recipient_id:peer.accountId}]),'{}',f.ctx.now(),f.ctx.now()+100000);
    const tables=['accounts','sessions','face_profiles','consents','auth_devices','sharing_snapshots','sharing_previews'];
    const before=Object.fromEntries(tables.map(name=>[name,f.db.all('SELECT * FROM '+name)]));
    f.db.run('DROP INDEX face_recovery_intent_expiry');f.db.run('DROP TABLE face_recovery_intents');
    f.db.run('DROP INDEX face_recovery_key_account');f.db.run('DROP TABLE face_recovery_keys');
    f.db.run('DELETE FROM schema_versions WHERE version>=5');initSchema(f.db);
    expect(Object.fromEntries(tables.map(name=>[name,f.db.all('SELECT * FROM '+name)]))).toEqual(before);
    expect(f.db.one('SELECT count(*) n FROM face_recovery_keys')).toEqual({n:0});
    expect(f.db.one('SELECT count(*) n FROM face_recovery_intents')).toEqual({n:0});
    expect(f.db.one('SELECT max(version) version FROM schema_versions')).toEqual({version:7});
    expect(f.db.all('PRAGMA foreign_key_check')).toEqual([]);
  });
  it('rejects weaker v5 capability definitions and preserves the v4 migration version',()=>{
    const f=fixture();f.db.run('DROP INDEX face_recovery_intent_expiry');f.db.run('DROP TABLE face_recovery_intents');
    f.db.run('DROP INDEX face_recovery_key_account');f.db.run('DROP TABLE face_recovery_keys');
    f.db.run('DELETE FROM schema_versions WHERE version>=5');
    f.db.run('CREATE TABLE face_recovery_keys(id TEXT PRIMARY KEY,account_id TEXT,token_hash TEXT,revoked_at INTEGER,consumed_at INTEGER)');
    expect(()=>initSchema(f.db)).toThrow('sqlite_schema_migration_required');
    expect(f.db.one('SELECT max(version) version FROM schema_versions')).toEqual({version:4});
    expect(f.db.one("SELECT name FROM sqlite_master WHERE name='face_recovery_intents'")).toBeNull();
  });
  it('rejects OTP sessions and out-of-range capture indices using actual SQLite constraints',()=>{
    const f=fixture(),actor=f.actor(['user'],true);
    expect(()=>f.db.run("UPDATE sessions SET auth_method='otp' WHERE id=?",actor.sessionId)).toThrow();
    const id=crypto.randomUUID();
    f.db.run('INSERT INTO auth_challenges(id,account_id,purpose,nonce,policy_version,created_at,expires_at,required_captures) VALUES(?,?,?,?,?,?,?,3)',id,actor.accountId,'registration',crypto.randomUUID(),'fixture',f.ctx.now(),f.ctx.now()+10000);
    expect(()=>f.db.run('INSERT INTO auth_capture_proofs(challenge_id,capture_index,object_key,sha256,mime,byte_size,created_at) VALUES(?,3,?,?,?,?,?)',id,'private/proof','b'.repeat(64),'image/png',10,f.ctx.now())).toThrow();
  });
  it('consumes cursors synchronously, bounds SQL parameters and rejects asynchronous transactions',()=>{
    const f=fixture(),before=f.consumed();
    f.db.all('SELECT 1 n'); expect(f.consumed()).toBe(before+1);
    expect(()=>f.db.all('SELECT 1',...Array(101).fill(null))).toThrow('sql_binding_limit');
    expect(()=>f.db.transaction((async()=>{}) as unknown as ()=>void)).toThrow('async_transaction_forbidden');
    expect(()=>f.db.transaction(()=>{f.db.run('INSERT INTO request_limits(key,hits,expires_at) VALUES(?,?,?)','rollback',1,100);return Promise.resolve();})).toThrow('async_transaction_forbidden');
    expect(f.db.one('SELECT key FROM request_limits WHERE key=?','rollback')).toBeNull();
    const adapter=new SqlDatabase(f.storage);
    expect(()=>adapter.one('SELECT 1 n UNION ALL SELECT 2 n')).toThrow('non_unique_database_row');
  });
  it('keeps snapshots, preview subsets and committed operation identity immutable in SQLite',()=>{
    const f=fixture(),owner=f.actor(),recipient=f.actor(),snapshot=crypto.randomUUID(),preview=crypto.randomUUID();
    const pairs=JSON.stringify([{asset_id:crypto.randomUUID(),recipient_id:recipient.accountId}]);
    f.db.run('INSERT INTO sharing_snapshots(id,owner_id,source,version,graph_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)',snapshot,owner.accountId,'personal','snapshot-v1','{}',f.ctx.now(),f.ctx.now()+100000);
    f.db.run('INSERT INTO sharing_previews(id,owner_id,snapshot_id,source,version,draft_version,pairs_json,manifest_json,created_at,expires_at) VALUES(?,?,?,?,?,1,?,?,?,?)',preview,owner.accountId,snapshot,'personal','preview-v1',pairs,'{}',f.ctx.now(),f.ctx.now()+100000);
    expect(()=>f.db.run('UPDATE sharing_snapshots SET graph_json=? WHERE id=?','{"new":true}',snapshot)).toThrow('sharing_snapshot_immutable');
    expect(()=>f.db.run('UPDATE sharing_previews SET pairs_json=? WHERE id=?',JSON.stringify([{asset_id:'changed',recipient_id:recipient.accountId}]),preview)).toThrow('sharing_preview_immutable');
    f.db.run('UPDATE sharing_previews SET committed_at=?,operation_key=? WHERE id=?',f.ctx.now(),'approved-original-key',preview);
    expect(()=>f.db.run('UPDATE sharing_previews SET operation_key=? WHERE id=?','replacement-key',preview)).toThrow('sharing_preview_immutable');
    expect(()=>f.db.run('UPDATE sharing_previews SET committed_at=NULL,operation_key=NULL WHERE id=?',preview)).toThrow('sharing_preview_immutable');
  });
  it('permits only one ready rendition per asset/kind and positive abuse counters',()=>{
    const f=fixture(),owner=f.actor(),asset=crypto.randomUUID();
    f.db.run("INSERT INTO assets(id,owner_id,source,status,object_key,content_type,byte_size,version) VALUES(?,?,'personal','ready','source/fixture','image/png',10,'source-v1')",asset,owner.accountId);
    const insert=(id:string)=>f.db.run("INSERT INTO renditions(id,asset_id,object_key,content_type,byte_size,checksum_sha256,source_checksum_sha256,version,status) VALUES(?,?,?,'image/png',10,?,?,'rendition-v1','ready')",id,asset,'preview/'+id,'b'.repeat(64),'a'.repeat(64));
    insert(crypto.randomUUID());expect(()=>insert(crypto.randomUUID())).toThrow();
    expect(()=>f.db.run('INSERT INTO request_limits(key,hits,expires_at) VALUES(?,0,?)','counter',f.ctx.now())).toThrow();
  });
  it('replays the same canonical key once; changed action/payload conflicts and account/source scopes remain separate',async()=>{
    const f=fixture(),owner=f.actor(),other=f.actor();let calls=0;
    const body={operation_key:'durable-operation-key-1',selected_recipient_ids:[other.accountId]};
    const intent=await prepareOperation('sharing.fixture',body,'personal');
    const first=executeOperation(f.ctx,owner,intent,()=>({count:++calls,recipients:[{recipient_id:other.accountId}]}));
    expect(executeOperation(f.ctx,owner,intent,()=>({count:++calls}))).toEqual(first);expect(calls).toBe(1);
    const different=await prepareOperation('sharing.fixture',{...body,selected_recipient_ids:[]},'personal');
    expect(()=>executeOperation(f.ctx,owner,different,()=>({}))).toThrow('operation_key_conflict');
    const source=await prepareOperation('sharing.fixture',body,'professional');executeOperation(f.ctx,owner,source,()=>({count:++calls}));
    executeOperation(f.ctx,other,intent,()=>({count:++calls}));expect(calls).toBe(3);
    expect(f.db.one('SELECT count(*) n FROM operations')).toEqual({n:3});
    expect(f.db.one('SELECT count(*) n FROM operation_subjects WHERE subject_id=?',other.accountId)!.n).toBeGreaterThan(0);
  });
  it('rolls back callback writes and durable receipt if the current session is revoked before completion',async()=>{
    const f=fixture(),owner=f.actor(),intent=await prepareOperation('fixture.mutate',{operation_key:'rollback-session-key'});
    expect(()=>executeOperation(f.ctx,owner,intent,()=>{
      f.db.run('INSERT INTO request_limits(key,hits,expires_at) VALUES(?,?,?)','partial',1,100);
      f.db.run('UPDATE sessions SET revoked_at=? WHERE id=?',f.ctx.now(),owner.sessionId);
      return {status:'ok'};
    })).toThrow('session_invalid');
    expect(f.db.one('SELECT key FROM request_limits WHERE key=?','partial')).toBeNull();
    expect(f.db.one('SELECT operation_key FROM operations WHERE actor_id=?',owner.accountId)).toBeNull();
  });
  it('fences disabled/anonymous accounts even for saved receipt replay',async()=>{
    const f=fixture(),owner=f.actor(),anonymous=f.actor(['user'],true);
    const intent=await prepareOperation('fixture.mutate',{operation_key:'current-authority-key'});
    executeOperation(f.ctx,owner,intent,()=>({status:'ok'}));
    f.db.run('UPDATE accounts SET disabled_at=? WHERE id=?',f.ctx.now(),owner.accountId);
    expect(()=>executeOperation(f.ctx,owner,intent,()=>({}))).toThrow('session_invalid');
    expect(()=>executeOperation(f.ctx,anonymous,intent,()=>({}))).toThrow('registered_face_required');
  });
  it('keeps private writer intent pending until the actual promise settles; only enrollment admission permits anonymous proof writes',()=>{
    const f=fixture(),owner=f.actor(),anonymous=f.actor(['user'],true);
    const write=beginMediaWrite(f.ctx,owner,'PHOTOS','private/current');
    expect(f.db.one('SELECT status FROM media_write_intents WHERE id=?',write)).toEqual({status:'pending'});
    f.db.run('UPDATE sessions SET revoked_at=? WHERE id=?',f.ctx.now(),owner.sessionId);
    settleMediaWrite(f.ctx,write);expect(f.db.one('SELECT status FROM media_write_intents WHERE id=?',write)).toEqual({status:'settled'});
    expect(()=>beginMediaWrite(f.ctx,anonymous,'QUARANTINE','proof/denied')).toThrow('registered_face_required');
    expect(beginEnrollmentMediaWrite(f.ctx,anonymous,'QUARANTINE','proof/enrollment')).toBeTruthy();
  });
  it('challenge-only writers require live epoch and a synchronous exact guard',()=>{
    const f=fixture(),owner=f.actor(),challenge=crypto.randomUUID();
    f.db.run('INSERT INTO auth_challenges(id,account_id,purpose,nonce,policy_version,created_at,expires_at,auth_epoch) VALUES(?,?,?,?,?,?,?,1)',challenge,owner.accountId,'login',crypto.randomUUID(),'fixture',f.ctx.now(),f.ctx.now()+10000);
    expect(()=>beginFaceChallengeMediaWrite(f.ctx,challenge,'QUARANTINE','proof/no-device',()=>{throw new Error('device changed');})).toThrow('device changed');
    expect(f.db.one('SELECT count(*) n FROM media_write_intents')).toEqual({n:0});
    expect(()=>beginFaceChallengeMediaWrite(f.ctx,challenge,'PHOTOS','template/async',(async()=>{}) as unknown as ()=>void)).toThrow('async_operation_forbidden');
    f.db.run('UPDATE accounts SET auth_epoch=2 WHERE id=?',owner.accountId);
    expect(()=>beginFaceChallengeMediaWrite(f.ctx,challenge,'PHOTOS','template/stale')).toThrow('face_challenge_unavailable');
  });
});
