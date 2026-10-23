import { afterEach, describe, expect, it } from 'vitest';
import { createPrivacyRequest, reviewPrivacyRequest, processPrivacyRequest, processPrivacyJob, collectPrivacyExport, handlePrivacy, flushPrivacyCleanup } from '../src/privacy';
import { beginMediaWrite, settleMediaWrite, prepareOperation, executeOperation, executeAccountDeletionOperation } from '../src/operations';
import { type Actor } from '../src/types';
import { schemaFixture } from './schema-fixture';

const fixtures:ReturnType<typeof schemaFixture>[]=[];
const fixture=()=>{const f=schemaFixture();fixtures.push(f);return f;};
afterEach(()=>{for(const f of fixtures.splice(0))f.close();});
const key=(name:string)=>name+'-'+crypto.randomUUID();
async function requested(f:ReturnType<typeof schemaFixture>,owner:Actor,kind:'export'|'delete') {
  const response=await createPrivacyRequest(f.ctx,owner,kind,{operation_key:key('privacy-request')});
  return (response.privacy_request as {id:string}).id;
}
async function approved(f:ReturnType<typeof schemaFixture>,owner:Actor,admin:Actor,kind:'export'|'delete') {
  const id=await requested(f,owner,kind);
  await reviewPrivacyRequest(f.ctx,admin,id,'approve',{operation_key:key('independent-review')});return id;
}

describe('privacy request, authority, export and erasure boundaries',()=>{
  it('binds export to its registered owner and rejects foreign subjects and anonymous export',async()=>{
    const f=fixture(),owner=f.actor(),anonymous=f.actor(['user'],true),body={reason:'Please export',operation_key:key('same-request')};
    const first=await createPrivacyRequest(f.ctx,owner,'export',body);
    expect(await createPrivacyRequest(f.ctx,owner,'export',body)).toEqual(first);
    expect((first.privacy_request as {subject_user_id:string}).subject_user_id).toBe(owner.accountId);
    await expect(createPrivacyRequest(f.ctx,owner,'export',{...body,subject_user_id:anonymous.accountId})).rejects.toThrow('privacy_input_invalid');
    await expect(createPrivacyRequest(f.ctx,anonymous,'export',body)).rejects.toThrow('registered_face_required');
    expect(f.db.one('SELECT count(*) n FROM privacy_requests')).toEqual({n:1});
  });
  it('requires independent current admin approval and preserves legal holds',async()=>{
    const f=fixture(),owner=f.actor(['user','admin']),admin=f.actor(['user','admin']);
    const id=await requested(f,owner,'delete');
    await expect(reviewPrivacyRequest(f.ctx,owner,id,'approve',{operation_key:key('self-review')})).rejects.toThrow('independent_privacy_review_required');
    await expect(processPrivacyRequest(f.ctx,admin,id)).rejects.toThrow('privacy_execution_unavailable');
    await reviewPrivacyRequest(f.ctx,admin,id,'approve',{operation_key:key('approved')});
    f.db.run('UPDATE privacy_requests SET legal_hold=1 WHERE id=?',id);
    await expect(processPrivacyRequest(f.ctx,admin,id)).rejects.toThrow('privacy_legal_hold');
    expect(f.db.one('SELECT disabled_at FROM accounts WHERE id=?',owner.accountId)).toEqual({disabled_at:null});
    expect(f.db.one('SELECT count(*) n FROM outbox WHERE category=?','privacy')).toEqual({n:1});
  });
  it('never treats an arbitrary trusted-queue body as approval or subject authority',async()=>{
    const f=fixture(),owner=f.actor(),id=await requested(f,owner,'export');
    await expect(processPrivacyJob({request_id:id},f.ctx)).rejects.toThrow('privacy_approved_job_required');
    await expect(processPrivacyJob({request_id:id,subject_id:owner.accountId},f.ctx)).rejects.toThrow('privacy_input_invalid');
    expect(f.exports.values.size).toBe(0);
  });
  it('expires unexecuted approval without disabling its owner or exporting data',async()=>{
    const f=fixture(),owner=f.actor(),admin=f.actor(['user','admin']),id=await approved(f,owner,admin,'delete');
    f.db.run('UPDATE privacy_requests SET expires_at=? WHERE id=?',f.ctx.now()-1,id);
    await expect(processPrivacyJob({request_id:id},f.ctx)).rejects.toThrow('privacy_approved_job_required');
    await flushPrivacyCleanup(f.ctx);
    expect(f.db.one('SELECT status FROM privacy_requests WHERE id=?',id)).toEqual({status:'cancelled'});
    expect(f.db.one('SELECT disabled_at FROM accounts WHERE id=?',owner.accountId)).toEqual({disabled_at:null});
  });
  it('exports explicit own fields and excludes private keys, peer graphs, credentials and arbitrary financial JSON',()=>{
    const f=fixture(),owner=f.actor(),peer=f.actor();
    f.db.run('INSERT INTO financial_records(id,account_id,record_type,data_json,created_at) VALUES(?,?,?,?,?)',crypto.randomUUID(),owner.accountId,'invoice',JSON.stringify({amount:125,currency:'USD',status:'paid',counterparty_name:'PRIVATE PEER',storage_key:'SECRET KEY',refresh_token:'SECRET TOKEN'}),f.ctx.now());
    const snapshot=crypto.randomUUID();
    f.db.run('INSERT INTO sharing_snapshots(id,owner_id,source,version,graph_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)',snapshot,owner.accountId,'personal','v1',JSON.stringify({recipients:[{id:peer.accountId,name:'PRIVATE PEER'}],pairs:[]}),f.ctx.now(),f.ctx.now()+10000);
    const exported=collectPrivacyExport(f.ctx,owner.accountId),text=JSON.stringify(exported);
    for(const secret of ['PRIVATE PEER','SECRET KEY','SECRET TOKEN','private/template/','refresh_hash','public_jwk','template_digest','graph_json']) expect(text).not.toContain(secret);
    expect(text).toContain('125');expect(text).toContain('USD');
    const financial=(exported.tables as Record<string,Record<string,unknown>[]>).financial_records[0];
    expect(financial.data).toEqual({amount:125,currency:'USD',status:'paid'});
  });
  it('atomically redacts subject graph/provenance/replays and preserves unrelated recipient bindings and retained financial records',async()=>{
    const f=fixture(),subject=f.actor(),owner=f.actor(),peer=f.actor(),admin=f.actor(['user','admin']);
    f.db.run('UPDATE accounts SET name=? WHERE id=?','Aline',subject.accountId);f.db.run('UPDATE accounts SET name=? WHERE id=?','Eric',peer.accountId);
    const asset=crypto.randomUUID(),snapshot=crypto.randomUUID(),preview=crypto.randomUUID(),attempt=crypto.randomUUID();
    f.db.run("INSERT INTO assets(id,owner_id,source,status,object_key,content_type,byte_size,version) VALUES(?,?,'personal','ready',?,'image/png',10,'source-v1')",asset,owner.accountId,'source/owner');
    const kept={asset_id:asset,recipient_id:peer.accountId,version:'pair-eric-v1',profile_id:'unchanged-profile',profile_digest:'c'.repeat(64)};
    const pairs=[{asset_id:asset,recipient_id:subject.accountId,version:'pair-aline-v1'},kept];
    f.db.run('INSERT INTO sharing_snapshots(id,owner_id,source,version,graph_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)',snapshot,owner.accountId,'personal','snapshot-v1',JSON.stringify({assets:[{id:asset}],recipients:[{id:subject.accountId,name:'Aline'},{id:peer.accountId,name:'Eric'}],pairs}),f.ctx.now(),f.ctx.now()+100000);
    f.db.run('INSERT INTO sharing_previews(id,owner_id,snapshot_id,source,version,draft_version,pairs_json,manifest_json,created_at,expires_at) VALUES(?,?,?,?,?,1,?,?,?,?)',preview,owner.accountId,snapshot,'personal','preview-v1',JSON.stringify(pairs),JSON.stringify({recipients:[{recipient_id:subject.accountId,name:'Aline'},{recipient_id:peer.accountId,name:'Eric'}]}),f.ctx.now(),f.ctx.now()+100000);
    f.db.run('INSERT INTO processing_attempts(id,asset_id,source_version,source_checksum_sha256,model_version,status,captured_at,expires_at,owner_id,profiles_json,matches_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)',attempt,asset,'source-v1','a'.repeat(64),'fixture-model-v1','completed',f.ctx.now(),f.ctx.now()+100000,owner.accountId,JSON.stringify([{account_id:subject.accountId,template_key:'private/aline'},{account_id:peer.accountId,template_key:'private/eric'}]),JSON.stringify([{recipient_id:subject.accountId},{recipient_id:peer.accountId}]));
    const operation=await prepareOperation('fixture.graph',{operation_key:key('graph'),excluded_pairs:[{recipient_id:subject.accountId.toUpperCase(),asset_id:asset}]});
    executeOperation(f.ctx,owner,operation,()=>({recipients:[{id:subject.accountId,name:'Aline'}]}));
    f.db.run('INSERT INTO financial_records(id,account_id,record_type,data_json,created_at) VALUES(?,?,?,?,?)',crypto.randomUUID(),subject.accountId,'invoice','{"amount":10}',f.ctx.now());
    const id=await approved(f,subject,admin,'delete');await processPrivacyRequest(f.ctx,admin,id);
    const graph=JSON.parse(f.db.one<{graph_json:string}>('SELECT graph_json FROM sharing_snapshots WHERE id=?',snapshot)!.graph_json);
    expect(graph.recipients).toEqual([{id:peer.accountId,name:'Eric'}]);expect(graph.pairs).toEqual([kept]);
    expect(JSON.parse(f.db.one<{pairs_json:string}>('SELECT pairs_json FROM sharing_previews WHERE id=?',preview)!.pairs_json)).toEqual([kept]);
    const provenance=f.db.one<{profiles_json:string;matches_json:string}>('SELECT profiles_json,matches_json FROM processing_attempts WHERE id=?',attempt)!;
    expect(JSON.parse(provenance.profiles_json)).toEqual([{account_id:peer.accountId,template_key:'private/eric'}]);expect(JSON.parse(provenance.matches_json)).toEqual([{recipient_id:peer.accountId}]);
    expect(f.db.one('SELECT operation_key FROM operations WHERE actor_id=? AND operation_key=?',owner.accountId,operation.key)).toBeNull();
    expect(f.db.one('SELECT count(*) n FROM financial_records WHERE account_id=?',subject.accountId)).toEqual({n:1});
    expect(()=>f.ctx.assertActor(subject)).toThrow('session_invalid');
  });
  it('does not complete erasure while a private write remains unresolved; retry verifies a late settled object',async()=>{
    const f=fixture(),owner=f.actor(),admin=f.actor(['user','admin']);
    const writer=beginMediaWrite(f.ctx,owner,'PHOTOS','private/in-flight'),id=await approved(f,owner,admin,'delete');
    await expect(processPrivacyRequest(f.ctx,admin,id)).rejects.toThrow('privacy_writer_unresolved');
    expect(f.db.one('SELECT status FROM privacy_requests WHERE id=?',id)).toEqual({status:'failed'});
    f.photos.values.set('private/in-flight',new Uint8Array([1,2,3]));settleMediaWrite(f.ctx,writer);
    await processPrivacyRequest(f.ctx,admin,id);
    expect(f.photos.values.has('private/in-flight')).toBe(false);expect(f.db.one('SELECT status FROM privacy_requests WHERE id=?',id)).toEqual({status:'completed'});
    expect(f.db.one('SELECT auth_epoch FROM accounts WHERE id=?',owner.accountId)).toEqual({auth_epoch:2});
  });
  it('records unconfirmed DELETE/HEAD and retries cleanup without redoing or claiming metadata erasure',async()=>{
    const f=fixture(),owner=f.actor(),admin=f.actor(['user','admin']),id=await approved(f,owner,admin,'delete');
    f.photos.refuseDelete=true;await expect(processPrivacyRequest(f.ctx,admin,id)).rejects.toThrow('privacy_cleanup_unconfirmed');
    expect(f.db.one('SELECT status FROM privacy_requests WHERE id=?',id)).toEqual({status:'failed'});
    expect(f.db.one("SELECT count(*) n FROM cleanup_intents WHERE request_id=? AND status='failed'",id)).toEqual({n:1});
    f.photos.refuseDelete=false;await processPrivacyRequest(f.ctx,admin,id);
    expect(f.db.one('SELECT status FROM privacy_requests WHERE id=?',id)).toEqual({status:'completed'});
    expect(f.db.one('SELECT auth_epoch FROM accounts WHERE id=?',owner.accountId)).toEqual({auth_epoch:2});
  });
  it('cannot publish an export when the subject is disabled during its R2 write and retains durable cleanup',async()=>{
    const f=fixture(),owner=f.actor(),admin=f.actor(['user','admin']),id=await approved(f,owner,admin,'export');
    f.exports.onPut=()=>{f.db.run('UPDATE accounts SET disabled_at=? WHERE id=?',f.ctx.now(),owner.accountId);};
    await expect(processPrivacyRequest(f.ctx,admin,id)).rejects.toThrow('privacy_subject_disabled');
    expect(f.db.one("SELECT count(*) n FROM privacy_exports WHERE status='published'")).toEqual({n:0});
    expect(f.db.one("SELECT count(*) n FROM cleanup_intents WHERE bucket='PRIVACY_EXPORTS'")).toEqual({n:1});
    expect(f.db.one("SELECT count(*) n FROM media_write_intents WHERE status='pending'")).toEqual({n:0});
    await flushPrivacyCleanup(f.ctx);expect(f.exports.values.size).toBe(0);
  });
  it('binds one-time export grants to account and current session and verifies bytes before release',async()=>{
    const f=fixture(),owner=f.actor(),other=f.actor(),admin=f.actor(['user','admin']),id=await approved(f,owner,admin,'export');
    await processPrivacyRequest(f.ctx,admin,id);f.setActor(owner);
    const response=await handlePrivacy(new Request('https://fixture/privacy-exports/'+id+'/grant',{method:'POST'}),f.ctx);
    const grant=await response!.json() as {grant_path:string};
    f.setActor(other);await expect(handlePrivacy(new Request('https://fixture'+grant.grant_path),f.ctx)).rejects.toThrow('privacy_export_grant_invalid');
    f.setActor(owner);const download=await handlePrivacy(new Request('https://fixture'+grant.grant_path),f.ctx);
    expect(download!.status).toBe(200);expect((await download!.json() as {subject_user_id:string}).subject_user_id).toBe(owner.accountId);
    expect(download!.headers.get('cache-control')).toBe('no-store, private');expect(f.exports.values.size).toBe(0);
    await expect(handlePrivacy(new Request('https://fixture'+grant.grant_path),f.ctx)).rejects.toThrow('privacy_export_grant_invalid');
  });
  it('does not extend current receipt/review scope through duplicate job delivery',async()=>{
    const f=fixture(),owner=f.actor(),admin=f.actor(['user','admin']),id=await approved(f,owner,admin,'export');
    await processPrivacyJob({request_id:id},f.ctx);const count=f.exports.values.size;
    await processPrivacyJob({request_id:id},f.ctx);expect(f.exports.values.size).toBe(count);
    expect(f.db.one('SELECT count(*) n FROM privacy_exports WHERE request_id=?',id)).toEqual({n:1});
  });
});

const statusToken=()=> 'lvd_'+crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
function statusRequest(token:string,extra:Record<string,unknown>={}) { return new Request('https://local.test/privacy/account-deletion/status',
  {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({status_token:token,...extra})}); }
async function statusReply(f:ReturnType<typeof schemaFixture>,token:string) {
  return (await handlePrivacy(statusRequest(token),f.ctx))!.json() as Promise<Record<string,any>>;
}
describe('own guest deletion without enrollment',()=>{
  it('rejects raw status proof embedded in durable operation keys or reasons before any write',async()=>{
    const f=fixture(),guest=f.actor(['user'],true),token=statusToken();
    const bodies=[
      {operation_key:token,status_token:token},
      {operation_key:'delete:'+token,status_token:token},
      {operation_key:key('secret-reason'),status_token:token,reason:token},
      {operation_key:key('embedded-secret-reason'),status_token:token,reason:'Please erase '+token+' now'},
    ];
    for(const body of bodies) {
      await expect(createPrivacyRequest(f.ctx,guest,'delete',body)).rejects.toThrow('privacy_input_invalid');
      for(const table of ['privacy_requests','privacy_deletion_status_receipts','operations','audit_events']) {
        expect(f.db.one('SELECT count(*) n FROM '+table)).toEqual({n:0});
      }
    }
  });
  it('creates and replays only deletion with hashed status proof and current guest authority',async()=>{
    const f=fixture(),guest=f.actor(['user'],true),token=statusToken(),body={operation_key:key('guest-delete'),status_token:token};
    const first=await createPrivacyRequest(f.ctx,guest,'delete',body);
    expect(first.protocol).toBe('lovelies-account-deletion-v1');expect(first.source).toBe('privacy');
    expect(await createPrivacyRequest(f.ctx,guest,'delete',body)).toEqual(first);
    expect((first.privacy_request as any).subject_user_id).toBe(guest.accountId);
    await expect(createPrivacyRequest(f.ctx,guest,'delete',{...body,status_token:statusToken()})).rejects.toThrow('operation_key_conflict');
    await expect(createPrivacyRequest(f.ctx,guest,'delete',{...body,subject_user_id:crypto.randomUUID()})).rejects.toThrow('privacy_input_invalid');
    await expect(createPrivacyRequest(f.ctx,guest,'export', {operation_key:key('guest-export')})).rejects.toThrow('registered_face_required');
    await expect(createPrivacyRequest(f.ctx,guest,'delete',{operation_key:key('missing-proof')})).rejects.toThrow('deletion_status_token_required');
    const operations=f.db.all('SELECT * FROM operations'),receipts=f.db.all('SELECT * FROM privacy_deletion_status_receipts');
    expect(JSON.stringify([operations,receipts])).not.toContain(token);
    expect(operations).toHaveLength(1);expect(receipts).toHaveLength(1);
    f.db.run('UPDATE sessions SET revoked_at=? WHERE id=?',f.ctx.now(),guest.sessionId);
    await expect(createPrivacyRequest(f.ctx,guest,'delete',body)).rejects.toThrow('session_invalid');
    expect((await statusReply(f,token)).privacy_request.status).toBe('pending_approval');
  });
  it('rejects token reuse atomically and does not turn a receipt into export/admin/media authority',async()=>{
    const f=fixture(),first=f.actor(['user'],true),second=f.actor(['user'],true),token=statusToken();
    const response=await createPrivacyRequest(f.ctx,first,'delete',{operation_key:key('first-delete'),status_token:token});
    const id=(response.privacy_request as any).id;
    await expect(createPrivacyRequest(f.ctx,second,'delete',{operation_key:key('second-delete'),status_token:token})).rejects.toThrow('deletion_status_token_conflict');
    expect(f.db.one('SELECT count(*) n FROM privacy_requests')).toEqual({n:1});
    expect(f.db.one('SELECT count(*) n FROM operations')).toEqual({n:1});
    f.setActor(second);
    await expect(handlePrivacy(new Request('https://local.test/privacy-requests/'+id),f.ctx)).rejects.toThrow('privacy_request_unavailable');
    await expect(reviewPrivacyRequest(f.ctx,first,id,'approve',{operation_key:key('guest-admin')})).rejects.toThrow('registered_face_required');
    const protectedIntent=await prepareOperation('gallery.favorite',{operation_key:key('guest-media')});
    expect(()=>executeOperation(f.ctx,first,protectedIntent,()=>({ok:true}))).toThrow('registered_face_required');
    await expect(handlePrivacy(statusRequest(token,{request_id:id}),f.ctx)).rejects.toThrow('privacy_input_invalid');
    await expect(statusReply(f,statusToken())).rejects.toThrow('deletion_status_unavailable');
  });
  it('survives session/operation erasure and reports completion only after verified cleanup',async()=>{
    const f=fixture(),guest=f.actor(['user'],true),admin=f.actor(['user','admin']),token=statusToken(),operation=key('persisted-delete');
    const response=await createPrivacyRequest(f.ctx,guest,'delete',{operation_key:operation,status_token:token,reason:'Erase my guest'});
    const id=(response.privacy_request as any).id;
    const challenge=crypto.randomUUID(),proof='guest-capture/'+challenge;
    f.db.run('INSERT INTO auth_challenges(id,account_id,purpose,nonce,policy_version,created_at,expires_at,auth_epoch,proof_key) VALUES(?,?,?,?,?,?,?,1,?)',challenge,guest.accountId,'registration',crypto.randomUUID(),'fixture-policy-v1',f.ctx.now(),f.ctx.now()+100000,proof);
    f.quarantine.values.set(proof,new Uint8Array([1,2,3]));
    await reviewPrivacyRequest(f.ctx,admin,id,'approve',{operation_key:key('approve-guest')});
    expect((await statusReply(f,token)).deletion_completed).toBe(false);
    await processPrivacyRequest(f.ctx,admin,id);
    const done=await statusReply(f,token);
    expect(done.privacy_request.status).toBe('completed');expect(done.deletion_completed).toBe(true);
    expect(done.operation_key).toBe(operation);expect(done.source).toBe('privacy');
    expect(f.quarantine.values.has(proof)).toBe(false);
    expect(f.db.one('SELECT count(*) n FROM sessions WHERE account_id=?',guest.accountId)).toEqual({n:0});
    expect(f.db.one('SELECT count(*) n FROM operations WHERE actor_id=?',guest.accountId)).toEqual({n:0});
    expect(f.db.all('PRAGMA foreign_key_check')).toEqual([]);
    const text=JSON.stringify(done);for(const forbidden of [token,guest.accountId,admin.accountId,'Erase my guest',proof,'requested_by','reason'])expect(text).not.toContain(forbidden);
  });
  it('rejects other operation scopes and rolls back guest mutation if current authority changes',async()=>{
    const f=fixture(),guest=f.actor(['user'],true);
    const protectedIntent=await prepareOperation('privacy.request.export',{operation_key:key('forged-delete-lane')},'privacy');
    expect(()=>executeAccountDeletionOperation(f.ctx,guest,protectedIntent,()=>({ok:true}))).toThrow('operation_scope_invalid');
    const intent=await prepareOperation('privacy.request.delete',{operation_key:key('epoch-changed')},'privacy');
    expect(()=>executeAccountDeletionOperation(f.ctx,guest,intent,()=>{
      f.db.run('UPDATE accounts SET auth_epoch=2 WHERE id=?',guest.accountId);return {ok:true};
    })).toThrow('session_invalid');
    expect(f.db.one('SELECT auth_epoch FROM accounts WHERE id=?',guest.accountId)).toEqual({auth_epoch:1});
    expect(f.db.one('SELECT count(*) n FROM operations')).toEqual({n:0});
    const body={operation_key:key('upgrade-guest'),status_token:statusToken()};
    await createPrivacyRequest(f.ctx,guest,'delete',body);
    f.db.run("UPDATE accounts SET identity_state='registered_face' WHERE id=?",guest.accountId);
    await expect(createPrivacyRequest(f.ctx,guest,'delete',body)).rejects.toThrow('session_invalid');
  });
  it('distinguishes expired request from pending review and expires receipt without exposing data',async()=>{
    const f=fixture(),guest=f.actor(['user'],true),token=statusToken();
    await createPrivacyRequest(f.ctx,guest,'delete',{operation_key:key('expire-guest'),status_token:token});
    f.advance(8*24*60*60*1000);
    const expired=await statusReply(f,token);expect(expired.request_expired).toBe(true);expect(expired.deletion_completed).toBe(false);
    f.advance(23*24*60*60*1000);
    await expect(statusReply(f,token)).rejects.toThrow('deletion_status_unavailable');
  });
});
