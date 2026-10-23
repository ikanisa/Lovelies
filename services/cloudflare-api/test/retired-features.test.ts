import { afterEach, describe, expect, it } from 'vitest';
import { schemaFixture } from './schema-fixture';
import { accountRoles, authenticate, base64url, insertPreparedSession, prepareSession, type SessionRow } from '../src/auth';
import { handleOperators, operatorPrivacyRows, eraseOperatorSubject } from '../src/operators';
import { handleSharing } from '../src/sharing';
import { initSchema } from '../src/schema';
import { collectPrivacyExport, createPrivacyRequest, reviewPrivacyRequest, processPrivacyRequest } from '../src/privacy';

const fixtures: ReturnType<typeof schemaFixture>[] = [];
const fixture = () => { const f = schemaFixture(); fixtures.push(f); return f; };
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
const key = () => `retired-${crypto.randomUUID()}`;
const sharing = (action: string, payload: Record<string, unknown>) => new Request('https://app.lovelies.test/community/action', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, payload }),
});

describe('retired feature compatibility without active authority', () => {
  it('projects durable historical roles into user/admin while rejecting retired credential roles', async () => {
    const f = fixture(), actor = f.actor();
    f.ctx.env.AUTH_SIGNING_SECRET = 'synthetic-test-secret-with-at-least-32-characters';
    f.db.run('UPDATE accounts SET roles_json=? WHERE id=?', '["user","photographer"]', actor.accountId);
    expect(accountRoles('["user","photographer","admin"]')).toEqual(['user','admin']);
    expect(() => accountRoles('["photographer"]')).toThrow('session_invalid');
    expect(() => accountRoles('["user","organizer"]')).toThrow('session_invalid');
    const prior = f.db.one<SessionRow>('SELECT * FROM sessions WHERE id=?', actor.sessionId)!;
    const spec = { accountId: actor.accountId, roles: ['user'], authEpoch: 1, authMethod: 'registered_face' as const,
      profileRevision: prior.face_profile_revision!, profileEpoch: prior.face_profile_epoch!,
      consentId: prior.face_consent_id!, deviceId: prior.device_id!, deviceRevision: prior.device_revision! };
    await expect(prepareSession({ ...spec, roles: ['user','photographer'] }, f.ctx)).rejects.toThrow('session_invalid');
    const prepared = await prepareSession(spec, f.ctx); insertPreparedSession(prepared, f.ctx);
    const request = (token: string) => new Request('https://app.lovelies.test/me', { headers: { authorization: `Bearer ${token}` } });
    expect((await authenticate(request(prepared.credentials.access_token), f.ctx)).roles).toEqual(['user']);

    // Sign an otherwise current token carrying the retired role. Signature
    // validity must not make that role acceptable to the active auth contract.
    const [header, encoded] = prepared.credentials.access_token.split('.');
    const claims = JSON.parse(atob(encoded.replace(/-/g,'+').replace(/_/g,'/')));
    claims.roles = ['user','photographer'];
    const body = base64url(new TextEncoder().encode(JSON.stringify(claims)));
    const signingKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(f.ctx.env.AUTH_SIGNING_SECRET), { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
    const signature = base64url(new Uint8Array(await crypto.subtle.sign('HMAC', signingKey, new TextEncoder().encode(`${header}.${body}`))));
    await expect(authenticate(request(`${header}.${body}.${signature}`), f.ctx)).rejects.toThrow('session_invalid');
    expect(f.db.one('SELECT roles_json FROM accounts WHERE id=?', actor.accountId)).toEqual({ roles_json:'["user","photographer"]' });
  });

  it('keeps retired subject rows exportable and erasable without changing the existing schema', () => {
    const f = fixture(), actor = f.actor(), id = crypto.randomUUID();
    f.db.run("INSERT INTO photographer_requests(id,account_id,display_name,status,created_at) VALUES(?,?,?,'approved',?)", id, actor.accountId, 'Historical subject record', f.ctx.now());
    initSchema(f.db);
    expect(operatorPrivacyRows(f.ctx, actor.accountId).photographer_requests).toEqual([
      { id, display_name:'Historical subject record', location:null, portfolio_url:null, status:'approved', created_at:f.ctx.now(), reviewed_at:null },
    ]);
    eraseOperatorSubject(f.db, actor.accountId, f.ctx.now());
    expect(f.db.one('SELECT count(*) n FROM photographer_requests WHERE account_id=?', actor.accountId)).toEqual({ n:0 });
    expect(f.db.one('SELECT roles_json FROM accounts WHERE id=?', actor.accountId)).toEqual({ roles_json:'["user"]' });
  });

  it('excludes retired and deleted uploads from admin metadata while preserving subject export and erasure', async () => {
    const f = fixture(), owner = f.actor(), recipient = f.actor(), admin = f.actor(['user','admin']);
    const now = f.ctx.now(), ids: string[] = [], objectKeys: string[] = [];
    for (const [source, deletedAt] of [['personal',null],['professional',null],['personal',now]] as const) {
      const asset = crypto.randomUUID(), snapshot = crypto.randomUUID(), preview = crypto.randomUUID(), request = crypto.randomUUID(), version = crypto.randomUUID();
      const objectKey = `historical-fixture/${asset}`;
      ids.push(asset); objectKeys.push(objectKey);
      f.quarantine.values.set(objectKey,new Uint8Array([1]));
      f.db.run("INSERT INTO assets(id,owner_id,source,status,object_key,content_type,byte_size,version,deleted_at,created_at) VALUES(?,?,?,'ready',?,'image/png',1,?,?,?)",asset,owner.accountId,source,objectKey,version,deletedAt,now);
      f.db.run('INSERT INTO sharing_snapshots(id,owner_id,source,version,graph_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)',snapshot,owner.accountId,source,version,'{"assets":[],"recipients":[],"pairs":[]}',now,now+600000);
      f.db.run("INSERT INTO sharing_previews(id,owner_id,snapshot_id,source,version,draft_version,pairs_json,manifest_json,created_at,expires_at) VALUES(?,?,?,?,?,1,?,'{}',?,?)",preview,owner.accountId,snapshot,source,version,JSON.stringify([{asset_id:asset,recipient_id:recipient.accountId}]),now,now+600000);
      f.db.run("INSERT INTO sharing_requests(id,preview_id,sender_id,recipient_id,source,asset_ids_json,status,created_at,expires_at,updated_at) VALUES(?,?,?,?,?,?,'accepted',?,?,?)",request,preview,owner.accountId,recipient.accountId,source,JSON.stringify([asset]),now,now+600000,now);
      // These are stored-active counts, not proof of effective media access.
      f.db.run('INSERT INTO media_grants(id,request_id,owner_id,recipient_id,asset_id,active,created_at) VALUES(?,?,?,?,?,1,?)',crypto.randomUUID(),request,owner.accountId,recipient.accountId,asset,now);
    }
    const historicalRequest = crypto.randomUUID();
    f.db.run("INSERT INTO photographer_requests(id,account_id,status,created_at) VALUES(?,?,'approved',?)",historicalRequest,owner.accountId,now);
    f.setActor(admin);
    const uploads = await handleOperators(new Request('https://app.lovelies.test/admin/uploads'),f.ctx);
    expect(await uploads!.json()).toMatchObject({uploads:[{id:ids[0],source:'personal'}]});
    const metrics = await handleOperators(new Request('https://app.lovelies.test/admin/metrics'),f.ctx);
    expect(await metrics!.json()).toMatchObject({uploads:1,active_grants:1});
    const tables = collectPrivacyExport(f.ctx,owner.accountId).tables as Record<string,Record<string,unknown>[]>;
    expect(tables.owned_assets.map(row=>row.id).sort()).toEqual([...ids].sort());
    expect(tables.photographer_requests).toHaveLength(1);

    const requested = await createPrivacyRequest(f.ctx,owner,'delete',{operation_key:key()});
    const id = (requested.privacy_request as {id:string}).id;
    await reviewPrivacyRequest(f.ctx,admin,id,'approve',{operation_key:key()});
    const result = await processPrivacyRequest(f.ctx,admin,id);
    expect(result).toMatchObject({privacy_request:{status:'completed'}});
    expect(f.db.one('SELECT count(*) n FROM assets WHERE owner_id=?',owner.accountId)).toEqual({n:0});
    expect(f.db.one('SELECT count(*) n FROM photographer_requests WHERE account_id=?',owner.accountId)).toEqual({n:0});
    expect(f.db.one('SELECT count(*) n FROM media_grants WHERE owner_id=?',owner.accountId)).toEqual({n:0});
    expect(f.db.one('SELECT count(*) n FROM sharing_requests WHERE sender_id=?',owner.accountId)).toEqual({n:0});
    expect(objectKeys.every(objectKey=>!f.quarantine.values.has(objectKey))).toBe(true);
    expect(f.db.all('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('keeps personal inbox requests available while rejecting retired reviews and acceptances but permitting decline', async () => {
    const f = fixture(), owner = f.actor(), recipient = f.actor();
    const snapshot = crypto.randomUUID(), preview = crypto.randomUUID(), request = crypto.randomUUID(), asset = crypto.randomUUID();
    const version = crypto.randomUUID(), now = f.ctx.now();
    f.db.run("INSERT INTO sharing_snapshots(id,owner_id,source,version,graph_json,created_at,expires_at) VALUES(?,?,'professional',?,?,?,?)", snapshot, owner.accountId, version, '{"assets":[],"recipients":[],"pairs":[]}', now, now+600000);
    f.db.run("INSERT INTO sharing_previews(id,owner_id,snapshot_id,source,version,draft_version,pairs_json,manifest_json,created_at,expires_at) VALUES(?,?,?,'professional',?,1,?,'{}',?,?)", preview, owner.accountId, snapshot, version, JSON.stringify([{asset_id:asset,recipient_id:recipient.accountId}]), now, now+600000);
    f.db.run("INSERT INTO sharing_requests(id,preview_id,sender_id,recipient_id,source,asset_ids_json,status,created_at,expires_at,updated_at) VALUES(?,?,?,?,'professional',?,'requested',?,?,?)", request, preview, owner.accountId, recipient.accountId, JSON.stringify([asset]), now, now+600000, now);
    const personalSnapshot = crypto.randomUUID(), personalPreview = crypto.randomUUID(), personalRequest = crypto.randomUUID();
    f.db.run("INSERT INTO sharing_snapshots(id,owner_id,source,version,graph_json,created_at,expires_at) VALUES(?,?,'personal',?,?,?,?)", personalSnapshot, owner.accountId, version, '{"assets":[],"recipients":[],"pairs":[]}', now, now+600000);
    f.db.run("INSERT INTO sharing_previews(id,owner_id,snapshot_id,source,version,draft_version,pairs_json,manifest_json,created_at,expires_at) VALUES(?,?,?,'personal',?,1,?,'{}',?,?)", personalPreview, owner.accountId, personalSnapshot, version, JSON.stringify([{asset_id:asset,recipient_id:recipient.accountId}]), now, now+600000);
    f.db.run("INSERT INTO sharing_requests(id,preview_id,sender_id,recipient_id,source,asset_ids_json,status,created_at,expires_at,updated_at) VALUES(?,?,?,?,'personal',?,'requested',?,?,?)", personalRequest, personalPreview, owner.accountId, recipient.accountId, JSON.stringify([asset]), now, now+600000, now);
    f.setActor(owner);
    await expect(handleSharing(sharing('sharing.preview', { snapshot_id:snapshot, snapshot_version:version, draft_version:1, selected_asset_ids:[], selected_recipient_ids:[], excluded_pairs:[], operation_key:key() }), f.ctx)).rejects.toThrow('invalid_source');
    await expect(handleSharing(sharing('sharing.commit', { preview_id:preview, preview_version:version, draft_version:1, operation_key:key() }), f.ctx)).rejects.toThrow('invalid_source');
    f.setActor(recipient);
    for (const action of ['inbox','requests']) {
      const response = await handleSharing(sharing(action, {}), f.ctx);
      const body = await response!.json() as {items:{id:string;source:string}[]};
      expect(body.items.map(row => ({id:row.id,source:row.source}))).toEqual([{id:personalRequest,source:'personal'}]);
    }
    const historicalReceipt = await handleSharing(sharing('receipt', {request_id:request}), f.ctx);
    expect(await historicalReceipt!.json()).toMatchObject({id:request,source:'professional'});
    await expect(handleSharing(sharing('request.decide', { request_id:request, decision:'accept', operation_key:key() }), f.ctx)).rejects.toThrow('invalid_source');
    const declined = await handleSharing(sharing('request.decide', { request_id:request, decision:'decline', operation_key:key() }), f.ctx);
    expect(await declined!.json()).toMatchObject({ request_id:request, status:'declined' });
    expect(f.db.one('SELECT count(*) n FROM sharing_approvals')).toEqual({ n:0 });
    expect(f.db.one('SELECT count(*) n FROM media_grants')).toEqual({ n:0 });
  });
});
