import { ApiError, jsonBody, ok, record, stable, uuid, type Actor, type AppContext } from './types';
import { executeOperation, prepareOperation } from './operations';
import { enqueueNotification } from './notifications';
import { assertMediaActor, assetMetadata, availableGrant, currentAsset, currentPair, eligibleBindings,
  galleryAction, idList, mediaSource, protectedRendition, sameBinding, sourceAllowed, type MatchBinding, type MediaSource, type Asset } from './gallery';

const PROTOCOL = 'reviewed-sharing-v1';
const sourceWire = (source: MediaSource) => ({ source });
const edgeKey = (pair: { asset_id: string; recipient_id: string }) => `${pair.asset_id}:${pair.recipient_id}`;
const publicPairs = (pairs: MatchBinding[]) => pairs.map(({ asset_id, recipient_id }) => ({ asset_id, recipient_id }));
type SnapshotRow = { id: string; owner_id: string; source: MediaSource; batch_id: string | null; version: string;
  graph_json: string; created_at: number; expires_at: number; privacy_redacted_at: number | null };
type PreviewRow = { id: string; owner_id: string; snapshot_id: string; source: MediaSource; version: string;
  draft_version: number; pairs_json: string; manifest_json: string; created_at: number; expires_at: number;
  committed_at: number | null; operation_key: string | null; privacy_redacted_at: number | null };
type RequestRow = { id: string; preview_id: string; sender_id: string; recipient_id: string; source: MediaSource;
  asset_ids_json: string; status: string; created_at: number; expires_at: number; updated_at: number };
type SnapshotGraph = { assets: Record<string, any>[]; recipients: { id: string; name: string }[];
  pairs: MatchBinding[]; scope: { asset_limit: number; recipient_limit: number; pair_limit: number; has_more: boolean; selection_limited: boolean } };

export function pairManifest(pairs: { asset_id: string; recipient_id: string }[]) {
  const recipients = new Map<string, string[]>();
  for (const pair of pairs) {
    const ids = recipients.get(pair.recipient_id) ?? [];
    if (!ids.includes(pair.asset_id)) ids.push(pair.asset_id);
    recipients.set(pair.recipient_id, ids);
  }
  return { totals: { photos: new Set(pairs.map(pair => pair.asset_id)).size, recipients: recipients.size, pairs: pairs.length },
    recipients: [...recipients].map(([recipient_id, asset_ids]) => ({ recipient_id, asset_ids, photo_count: asset_ids.length })) };
}
function changed(source: MediaSource, pairs: MatchBinding[], reason: string) {
  return { protocol: PROTOCOL, ...sourceWire(source), status: 'changed', requires_review: true, grants_created: 0,
    changed_pairs: publicPairs(pairs).map(pair => ({ ...pair, reason })) };
}
function drift(ctx: AppContext, ownerId: string, pairs: MatchBinding[]): MatchBinding[] {
  return pairs.filter(pair => !sameBinding(currentPair(ctx, ownerId, pair.asset_id, pair.recipient_id), pair));
}
function ownedSnapshot(ctx: AppContext, actor: Actor, id: string): SnapshotRow {
  const row = ctx.db.one<SnapshotRow>('SELECT * FROM sharing_snapshots WHERE id=? AND owner_id=?', id, actor.accountId);
  if (!row || row.privacy_redacted_at != null) throw new ApiError(404, 'snapshot_unavailable');
  return row;
}
function ownedPreview(ctx: AppContext, actor: Actor, id: string): PreviewRow {
  const row = ctx.db.one<PreviewRow>('SELECT * FROM sharing_previews WHERE id=? AND owner_id=?', id, actor.accountId);
  if (!row || row.privacy_redacted_at != null) throw new ApiError(404, 'preview_unavailable');
  return row;
}
function requestRow(ctx: AppContext, actor: Actor, id: string): RequestRow {
  const row = ctx.db.one<RequestRow>('SELECT * FROM sharing_requests WHERE id=? AND (sender_id=? OR recipient_id=?)', id, actor.accountId, actor.accountId);
  if (!row) throw new ApiError(404, 'request_unavailable');
  return row;
}
function effectiveRequestStatus(ctx: AppContext, row: RequestRow): string {
  return row.status === 'requested' && row.expires_at <= ctx.now() ? 'expired' : row.status;
}
function outcome(ctx: AppContext, actor: Actor, previewId: string, operationKey: string) {
  const preview = ctx.db.one<PreviewRow>('SELECT * FROM sharing_previews WHERE id=? AND owner_id=?', previewId, actor.accountId);
  if (!preview || preview.privacy_redacted_at != null) return { protocol: PROTOCOL, source: preview?.source ?? 'personal',
    status: 'unavailable', operation_key: operationKey };
  const pairs = JSON.parse(preview.pairs_json) as MatchBinding[];
  const manifest = pairManifest(pairs);
  const requests = ctx.db.all<RequestRow>('SELECT * FROM sharing_requests WHERE preview_id=? ORDER BY recipient_id', preview.id);
  const recipients = manifest.recipients.map(person => {
    const row = requests.find(request => request.recipient_id === person.recipient_id);
    if (!row) throw new ApiError(500, 'receipt_incomplete');
    const status = effectiveRequestStatus(ctx, row);
    const available = status === 'accepted' ? person.asset_ids.filter(id => availableGrant(ctx, person.recipient_id, id, row.id)).length : 0;
    return { ...person, request_id: row.id, status, available_count: available };
  });
  const count = recipients.reduce((sum, person) => sum+person.available_count, 0);
  const status = count === pairs.length && pairs.length > 0 ? 'access_available' : count > 0 ? 'partial'
    : recipients.some(person => person.status === 'requested') ? 'pending_acceptance' : 'unavailable';
  return { protocol: PROTOCOL, ...sourceWire(preview.source), status, operation_key: operationKey, preview_id: preview.id,
    ...manifest, recipients, grants_created: count };
}

async function snapshot(payload: Record<string, any>, ctx: AppContext, actor: Actor): Promise<unknown> {
  const source = mediaSource(payload.source);
  const ids = payload.asset_ids == null ? null : idList(payload.asset_ids);
  const batch = payload.upload_batch_id == null ? null : uuid(payload.upload_batch_id);
  const intent = await prepareOperation('sharing.snapshot', payload, source);
  return executeOperation(ctx, actor, intent, () => {
    assertMediaActor(ctx, actor);
    if (batch && !ctx.db.one(`SELECT id FROM assets WHERE owner_id=? AND source=? AND batch_id=? AND deleted_at IS NULL LIMIT 1`,
      actor.accountId,source,batch)) throw new ApiError(403,'owned_batch_required');
    let assets: Asset[];
    let hasMore = false;
    if (ids) {
      assets = ids.map(id => currentAsset(ctx, id)).filter((asset): asset is Asset => !!asset);
      if (assets.length !== ids.length) throw new ApiError(403, 'owned_assets_required');
    } else {
      assets = ctx.db.all<Asset>(`SELECT * FROM assets WHERE owner_id=? AND source=? AND status='ready' AND deleted_at IS NULL
        AND (? IS NULL OR batch_id=?) ORDER BY created_at DESC,id LIMIT 101`, actor.accountId, source, batch, batch);
      hasMore = assets.length > 100; assets = assets.slice(0,100);
    }
    if (assets.some(asset => asset.owner_id !== actor.accountId || asset.source !== source || asset.status !== 'ready'
      || !sourceAllowed(actor, asset) || (batch && asset.batch_id !== batch))) throw new ApiError(403, 'owned_assets_required');
    const bindings = eligibleBindings(ctx, actor.accountId, assets.map(asset => asset.id));
    // Overlarge eligible graphs are explicit failures, never silent audience truncation.
    if (bindings.length > 1000 || new Set(bindings.map(pair => pair.recipient_id)).size > 100) throw new ApiError(409, 'review_scope_too_large');
    const recipients = [...new Set(bindings.map(pair => pair.recipient_id))].map(id => ({ id,
      name: ctx.db.one<{ name: string }>('SELECT name FROM accounts WHERE id=? AND disabled_at IS NULL', id)?.name ?? '' }));
    const graph: SnapshotGraph = { assets: assets.map(asset => assetMetadata(asset, protectedRendition(ctx, actor, asset.id).rendition)), recipients, pairs: bindings,
      scope: { asset_limit: 100, recipient_limit: 100, pair_limit: 1000, has_more: hasMore, selection_limited: hasMore } };
    const id = crypto.randomUUID(), version = crypto.randomUUID(), expires = ctx.now()+15*60_000;
    ctx.db.run(`INSERT INTO sharing_snapshots(id,owner_id,source,batch_id,version,graph_json,created_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?)`, id, actor.accountId, source, batch, version, stable(graph), ctx.now(), expires);
    return { protocol: PROTOCOL, status: 'ready', snapshot: { id, version, ...sourceWire(source),
      ...(batch ? { upload_batch_id: batch } : {}), expires_at: new Date(expires).toISOString(),
      ...graph, pairs: bindings.map(({ asset_id,recipient_id,version: pairVersion }) => ({ asset_id,recipient_id,version: pairVersion })) } };
  });
}

async function preview(payload: Record<string, any>, ctx: AppContext, actor: Actor): Promise<unknown> {
  const snapshotId = uuid(payload.snapshot_id); const assetIds = idList(payload.selected_asset_ids);
  const recipientIds = idList(payload.selected_recipient_ids);
  const draft = payload.draft_version;
  if (!Number.isSafeInteger(draft) || draft < 1) throw new ApiError(400, 'invalid_draft_version');
  if (!Array.isArray(payload.excluded_pairs) || payload.excluded_pairs.length > 1000) throw new ApiError(400, 'selection_limit');
  const excluded = payload.excluded_pairs.map((value: unknown) => {
    const item = record(value); return { asset_id: uuid(item.asset_id), recipient_id: uuid(item.recipient_id) };
  });
  if (new Set(excluded.map(edgeKey)).size !== excluded.length) throw new ApiError(400, 'duplicate_pair');
  const initial = ctx.db.transaction(() => { assertMediaActor(ctx, actor); return ownedSnapshot(ctx, actor, snapshotId); });
  mediaSource(initial.source); // A stored retired snapshot cannot create a new review.
  const intent = await prepareOperation('sharing.preview', payload, initial.source);
  return executeOperation(ctx, actor, intent, () => {
    assertMediaActor(ctx, actor); const row = ownedSnapshot(ctx, actor, snapshotId);
    const graph = JSON.parse(row.graph_json) as SnapshotGraph;
    if (row.version !== payload.snapshot_version || row.expires_at <= ctx.now()) return changed(row.source, graph.pairs, 'snapshot_expired_or_changed');
    const graphKeys = new Set(graph.pairs.map(edgeKey));
    if (assetIds.some(id => !graph.assets.some(asset => asset.id === id)) || recipientIds.some(id => !graph.recipients.some(person => person.id === id))
      || excluded.some(pair => !graphKeys.has(edgeKey(pair)))) throw new ApiError(400, 'selection_outside_snapshot');
    const excludedKeys = new Set(excluded.map(edgeKey));
    const selected = graph.pairs.filter(pair => assetIds.includes(pair.asset_id) && recipientIds.includes(pair.recipient_id) && !excludedKeys.has(edgeKey(pair)));
    const changedPairs = drift(ctx, actor.accountId, selected);
    if (changedPairs.length) return changed(row.source, changedPairs, 'eligibility_changed');
    const manifest = pairManifest(selected);
    if (!selected.length) return { protocol: PROTOCOL, ...sourceWire(row.source), status: 'empty', ...manifest };
    const id = crypto.randomUUID(), version = crypto.randomUUID();
    ctx.db.run(`INSERT INTO sharing_previews(id,owner_id,snapshot_id,source,version,draft_version,pairs_json,manifest_json,created_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, id, actor.accountId, row.id, row.source, version, draft, stable(selected), stable(manifest), ctx.now(), row.expires_at);
    return { protocol: PROTOCOL, status: 'ready', preview: { id, version, ...sourceWire(row.source), draft_version: draft,
      expires_at: new Date(row.expires_at).toISOString(), pairs: publicPairs(selected), ...manifest } };
  });
}

async function commit(payload: Record<string, any>, ctx: AppContext, actor: Actor): Promise<unknown> {
  const previewId = uuid(payload.preview_id);
  const initial = ctx.db.transaction(() => { assertMediaActor(ctx, actor); return ownedPreview(ctx, actor, previewId); });
  mediaSource(initial.source); // Historical previews cannot create new approvals.
  const intent = await prepareOperation('sharing.commit', payload, initial.source);
  const result = executeOperation(ctx, actor, intent, () => {
    assertMediaActor(ctx, actor); const row = ownedPreview(ctx, actor, previewId);
    const pairs = JSON.parse(row.pairs_json) as MatchBinding[];
    if (row.version !== payload.preview_version || row.draft_version !== payload.draft_version || row.expires_at <= ctx.now()) return changed(row.source, pairs, 'review_expired_or_changed');
    if (row.committed_at != null) throw new ApiError(409, 'preview_already_committed');
    const changedPairs = drift(ctx, actor.accountId, pairs);
    if (changedPairs.length) return changed(row.source, changedPairs, 'eligibility_changed');
    const manifest = pairManifest(pairs);
    for (const person of manifest.recipients) {
      const requestId = crypto.randomUUID();
      ctx.db.run(`INSERT INTO sharing_requests(id,preview_id,sender_id,recipient_id,source,asset_ids_json,status,created_at,expires_at,updated_at)
        VALUES(?,?,?,?,?,?,'requested',?,?,?)`, requestId, row.id, actor.accountId, person.recipient_id, row.source,
        stable(person.asset_ids), ctx.now(), ctx.now()+7*24*60*60_000, ctx.now());
      enqueueNotification(ctx,person.recipient_id,'match',requestId,'A photo sharing request is waiting');
      for (const pair of pairs.filter(item => item.recipient_id === person.recipient_id)) {
        ctx.db.run(`INSERT INTO sharing_approvals(id,request_id,preview_id,owner_id,recipient_id,asset_id,candidate_id,origin_id,pair_version,approved_at)
          VALUES(?,?,?,?,?,?,?,?,?,?)`, crypto.randomUUID(), requestId, row.id, actor.accountId, pair.recipient_id,
          pair.asset_id, pair.candidate_id, pair.origin_id, pair.version, ctx.now());
      }
    }
    ctx.db.run('UPDATE sharing_previews SET committed_at=?,operation_key=? WHERE id=? AND committed_at IS NULL', ctx.now(), intent.key, row.id);
    return outcome(ctx, actor, row.id, intent.key);
  });
  if ((result as any).status === 'changed') return result;
  return ctx.db.transaction(() => { assertMediaActor(ctx, actor); const current = outcome(ctx, actor, previewId, intent.key); assertMediaActor(ctx, actor); return current; });
}

function receipt(ctx: AppContext, actor: Actor, id: string): unknown {
  const row = requestRow(ctx, actor, id); const sender = row.sender_id === actor.accountId;
  const status = effectiveRequestStatus(ctx, row); const ids = JSON.parse(row.asset_ids_json) as string[];
  const available = status === 'accepted' ? ids.filter(id => availableGrant(ctx, row.recipient_id, id, row.id)) : [];
  const counterpart = sender ? row.recipient_id : row.sender_id;
  const person = ctx.db.one<{ name: string }>('SELECT name FROM accounts WHERE id=? AND disabled_at IS NULL', counterpart);
  return { id: row.id, ...sourceWire(row.source), sender, person: { id: counterpart, name: person?.name ?? '' },
    asset_ids: sender ? ids : available, photo_count: ids.length, available_count: available.length, status,
    created_at: new Date(row.created_at).toISOString(), expires_at: new Date(row.expires_at).toISOString() };
}

async function decide(payload: Record<string, any>, ctx: AppContext, actor: Actor): Promise<unknown> {
  const id = uuid(payload.request_id); const decision = payload.decision;
  if (!['accept','decline','withdraw','revoke'].includes(decision)) throw new ApiError(400, 'invalid_decision');
  const initial = ctx.db.transaction(() => { assertMediaActor(ctx, actor); return requestRow(ctx, actor, id); });
  if (decision === 'accept') mediaSource(initial.source);
  const intent = await prepareOperation('request.decide', payload, initial.source);
  return executeOperation(ctx, actor, intent, () => {
    assertMediaActor(ctx, actor); const row = requestRow(ctx, actor, id); const status = effectiveRequestStatus(ctx, row);
    const sender = row.sender_id === actor.accountId;
    if ((decision === 'accept' || decision === 'decline') && sender || decision === 'withdraw' && !sender)
      throw new ApiError(403, 'request_forbidden');
    const wanted = ({ accept: 'accepted', decline: 'declined', withdraw: 'withdrawn', revoke: 'revoked' } as Record<string,string>)[decision];
    if (status === wanted) return { ...sourceWire(row.source), request_id: row.id, status: wanted };
    if (decision === 'revoke' ? status !== 'accepted' : status !== 'requested') throw new ApiError(409, 'request_not_pending');
    if (decision === 'accept') {
      // Counterpart erasure may redact other recipients from this preview.
      // This recipient's pre-existing exact approval remains independently bound.
      const preview = ctx.db.one<PreviewRow>('SELECT * FROM sharing_previews WHERE id=? AND owner_id=?', row.preview_id, row.sender_id);
      if (!preview) throw new ApiError(409, 'eligibility_changed_review_required');
      const pairs = (JSON.parse(preview.pairs_json) as MatchBinding[]).filter(pair => pair.recipient_id === row.recipient_id);
      const ids = JSON.parse(row.asset_ids_json) as string[];
      if (!pairs.length || pairs.length !== ids.length || pairs.some(pair => !ids.includes(pair.asset_id)) || drift(ctx, row.sender_id, pairs).length)
        throw new ApiError(409, 'eligibility_changed_review_required');
      for (const pair of pairs) {
        const approval = ctx.db.one<{ id: string }>(`SELECT id FROM sharing_approvals WHERE request_id=? AND asset_id=? AND recipient_id=?
          AND candidate_id=? AND origin_id=? AND pair_version=?`, row.id, pair.asset_id, actor.accountId, pair.candidate_id, pair.origin_id, pair.version);
        if (!approval) throw new ApiError(409, 'eligibility_changed_review_required');
        ctx.db.run(`INSERT INTO media_grants(id,request_id,approval_id,owner_id,recipient_id,asset_id,active,review_managed,created_at)
          VALUES(?,?,?,?,?,?,1,1,?)`, crypto.randomUUID(), row.id, approval.id, row.sender_id, actor.accountId, pair.asset_id, ctx.now());
      }
    } else if (decision === 'revoke') ctx.db.run('UPDATE media_grants SET active=0,revoked_at=? WHERE request_id=?', ctx.now(), row.id);
    ctx.db.run('UPDATE sharing_requests SET status=?,updated_at=? WHERE id=?', wanted, ctx.now(), row.id);
    assertMediaActor(ctx, actor);
    return { ...sourceWire(row.source), request_id: row.id, status: wanted,
      available_count: wanted === 'accepted' ? (JSON.parse(row.asset_ids_json) as string[]).length : 0 };
  });
}

export async function handleSharing(request: Request, ctx: AppContext): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/community/action' || request.method !== 'POST') return null;
  const actor = await ctx.authenticate(request); const body = await jsonBody(request);
  const payload = record(body.payload ?? {}); const action = body.action;
  assertMediaActor(ctx, actor);
  const photo = galleryAction(action, payload, ctx, actor);
  if (photo != null) return ok(photo);
  if (action === 'sharing.snapshot') return ok(await snapshot(payload, ctx, actor));
  if (action === 'sharing.preview') return ok(await preview(payload, ctx, actor));
  if (action === 'sharing.commit') return ok(await commit(payload, ctx, actor));
  if (action === 'request.decide') return ok(await decide(payload, ctx, actor));
  if (action === 'receipt' || action === 'request.detail') return ok(ctx.db.transaction(() => {
    assertMediaActor(ctx, actor); const result = receipt(ctx, actor, uuid(payload.request_id)); assertMediaActor(ctx, actor); return result;
  }));
  if (action === 'operation') return ok(ctx.db.transaction(() => {
    assertMediaActor(ctx, actor);
    if (typeof payload.operation_key !== 'string' || payload.operation_key.length < 8 || payload.operation_key.length > 200) throw new ApiError(400, 'invalid_operation_key');
    const rows = ctx.db.all<{ action: string; response_json: string; source: MediaSource }>('SELECT action,response_json,source FROM operations WHERE actor_id=? AND operation_key=?', actor.accountId, payload.operation_key);
    if (rows.length > 1) throw new ApiError(409, 'operation_source_ambiguous');
    if (!rows.length) return { status: 'unknown' };
    const stored = JSON.parse(rows[0].response_json);
    const result = rows[0].action === 'sharing.commit' && stored.status !== 'changed' && stored.preview_id
      ? outcome(ctx, actor, stored.preview_id, payload.operation_key) : stored;
    assertMediaActor(ctx, actor); return result;
  }));
  if (action === 'inbox' || action === 'requests') return ok(ctx.db.transaction(() => {
    assertMediaActor(ctx, actor);
    const rows = ctx.db.all<{ id: string }>("SELECT id FROM sharing_requests WHERE recipient_id=? AND source='personal' ORDER BY created_at DESC,id LIMIT 100", actor.accountId);
    const result = { items: rows.map(row => receipt(ctx, actor, row.id)) }; assertMediaActor(ctx, actor); return result;
  }));
  // There is no compatibility route that can turn an unreviewed candidate into a grant.
  throw new ApiError(400, 'unsupported_action');
}
