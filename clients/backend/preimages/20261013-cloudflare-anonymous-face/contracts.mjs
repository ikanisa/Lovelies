/** Wire validation for the MEMORIES reviewed-sharing-v1 API. No UI or storage. */
export class LoveliesClientError extends Error {
  constructor(code, { status = 0, operationKey, ambiguous = false } = {}) {
    super(code);
    this.name = 'LoveliesClientError';
    this.code = code;
    this.status = status;
    this.operationKey = operationKey;
    this.ambiguous = ambiguous;
  }
}

export const fail = (code) => { throw new LoveliesClientError(code); };
export const object = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('response_invalid');
  return value;
};
export const text = (value, max = 256) => {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail('response_invalid');
  return value;
};
export const uuid = (value) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text(value, 36))) fail('invalid_id');
  return value.toLowerCase();
};
export const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('response_invalid');
  return value;
};
export const rows = (value, max) => {
  if (!Array.isArray(value) || value.length > max) fail('response_invalid');
  return value;
};
export const ids = (value, max = 100) => {
  const result = rows(value, max).map(uuid);
  if (new Set(result).size !== result.length) fail('duplicate_id');
  return result;
};
export const operationKey = (value) => {
  const key = text(value, 128);
  if (key.length < 16) fail('invalid_operation_key');
  return key;
};
export const source = (value) => {
  if (value !== 'personal' && value !== 'professional') fail('invalid_source');
  return value;
};
export function checkSource(value, expected) {
  source(expected);
  // Absence is the actual personal wire contract, not a professional fallback.
  if (expected === 'professional' ? value !== 'professional' : value != null) fail('source_mismatch');
}
export const expiry = (value, now) => {
  const time = Date.parse(text(value, 64));
  if (!Number.isFinite(time) || time <= now) fail('review_expired');
  return value;
};
export function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export const copy = (value) => JSON.parse(JSON.stringify(value));
export const pairKey = (pair) => JSON.stringify([pair.asset_id, pair.recipient_id]);
const pair = (value, version = false) => {
  object(value);
  const result = { asset_id: uuid(value.asset_id), recipient_id: uuid(value.recipient_id) };
  if (version) result.version = text(value.version);
  return result;
};
const pairs = (value, version = false) => {
  const result = rows(value, 1000).map((item) => pair(item, version));
  if (new Set(result.map(pairKey)).size !== result.length) fail('duplicate_pair');
  return result;
};
export function samePairs(left, right) {
  return JSON.stringify(left.map(pairKey).sort()) === JSON.stringify(right.map(pairKey).sort());
}
export function roles(value) {
  const result = rows(value, 3).map((item) => text(item, 16));
  if (!result.length || new Set(result).size !== result.length || result.some((item) => !['user', 'photographer', 'admin'].includes(item))) fail('auth_response_invalid');
  return result;
}
export function credentials(value, now) {
  object(value);
  const token = text(value.access_token, 8192);
  let claims;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) fail('auth_response_invalid');
    claims = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch { fail('auth_response_invalid'); }
  // The unsigned subject is only a local account fence. The server validates JWTs.
  const accountId = uuid(claims.sub);
  const seconds = integer(value.expires_in, 1, 900);
  const tokenExpiry = integer(claims.exp, 1) * 1000;
  if (tokenExpiry <= now) fail('auth_response_invalid');
  if (value.app_review != null && typeof value.app_review !== 'boolean') fail('auth_response_invalid');
  const refreshToken = value.refresh_token == null ? null : text(value.refresh_token, 512);
  return { token, refreshToken, accountId, roles: roles(value.roles), expiresAt: Math.min(now + seconds * 1000, tokenExpiry), appReview: value.app_review === true };
}

/** @typedef {'personal'|'professional'} ShareSource */
/** @typedef {{version:number,selectedAssetIds:string[],selectedRecipientIds:string[],excludedPairs?:{asset_id:string,recipient_id:string}[]}} ShareDraft */

export function snapshotResponse(result, requested, now) {
  object(result);
  if (result.protocol !== 'reviewed-sharing-v1' || result.status !== 'ready') fail('snapshot_response_invalid');
  const snap = object(result.snapshot);
  checkSource(snap.source, requested.source);
  uuid(snap.id); text(snap.version); expiry(snap.expires_at, now);
  const assets = rows(snap.assets, 100).map((item) => {
    object(item); uuid(item.id); text(item.version);
    if (requested.source === 'professional' ? item.media_source !== 'professional' : item.media_source === 'professional') fail('source_mismatch');
    for (const key of ['width', 'height']) if (item[key] != null) integer(item[key], 1, 100000);
    if (item.title != null && typeof item.title !== 'string') fail('response_invalid');
    return { ...copy(item), id: uuid(item.id) };
  });
  const assetIds = ids(assets.map((item) => item.id));
  const recipients = rows(snap.recipients, 100).map((item) => {
    object(item); uuid(item.id);
    if (typeof item.name !== 'string' || item.name.length > 1000) fail('response_invalid');
    return { id: uuid(item.id), name: item.name };
  });
  const recipientIds = ids(recipients.map((item) => item.id));
  const edges = pairs(snap.pairs, true);
  if (edges.some((item) => !assetIds.includes(item.asset_id) || !recipientIds.includes(item.recipient_id))) fail('snapshot_scope_invalid');
  if (requested.assetIds && (assetIds.length !== requested.assetIds.length || assetIds.some((id) => !requested.assetIds.includes(id)))) fail('snapshot_scope_invalid');
  // Personal snapshots do not echo upload_batch_id in the donor wire response.
  if (requested.source === 'professional' && requested.uploadBatchId && snap.upload_batch_id !== requested.uploadBatchId) fail('snapshot_scope_invalid');
  // This seam targets the current bounded-review backend; missing scope is refused.
  const scope = object(snap.scope);
  integer(scope.asset_limit, 1, 100); integer(scope.recipient_limit, 1, 100); integer(scope.pair_limit, 1, 1000);
  if (typeof scope.has_more !== 'boolean' || typeof scope.selection_limited !== 'boolean' || assets.length > scope.asset_limit || recipients.length > scope.recipient_limit || edges.length > scope.pair_limit) fail('snapshot_scope_invalid');
  return freeze({ ...copy(snap), assets, recipients, pairs: edges, scope: copy(scope) });
}

/** Calculate only real server candidate edges, never a Cartesian product. */
export function effectiveSelection(snapshot, draft) {
  object(draft);
  integer(draft.version, 1);
  const assets = ids(draft.selectedAssetIds);
  const recipients = ids(draft.selectedRecipientIds);
  const excluded = pairs(draft.excludedPairs ?? []);
  const graph = new Set(snapshot.pairs.map(pairKey));
  if (assets.some((id) => !snapshot.assets.some((item) => item.id === id)) || recipients.some((id) => !snapshot.recipients.some((item) => item.id === id)) || excluded.some((item) => !graph.has(pairKey(item)))) fail('selection_outside_snapshot');
  const blocked = new Set(excluded.map(pairKey));
  return freeze(snapshot.pairs.filter((item) => assets.includes(item.asset_id) && recipients.includes(item.recipient_id) && !blocked.has(pairKey(item))).map(({ asset_id, recipient_id }) => ({ asset_id, recipient_id })));
}
export function previewPayload(snapshot, draft) {
  effectiveSelection(snapshot, draft);
  return {
    snapshot_id: snapshot.id, snapshot_version: snapshot.version, draft_version: draft.version,
    selected_asset_ids: ids(draft.selectedAssetIds).sort(), selected_recipient_ids: ids(draft.selectedRecipientIds).sort(),
    excluded_pairs: pairs(draft.excludedPairs ?? []).sort((a, b) => pairKey(a).localeCompare(pairKey(b))),
  };
}
function manifest(value, edges) {
  const totals = object(value.totals);
  const people = rows(value.recipients, 100);
  const byRecipient = new Map();
  for (const edge of edges) {
    if (!byRecipient.has(edge.recipient_id)) byRecipient.set(edge.recipient_id, []);
    byRecipient.get(edge.recipient_id).push(edge.asset_id);
  }
  if (totals.photos !== new Set(edges.map((item) => item.asset_id)).size || totals.recipients !== byRecipient.size || totals.pairs !== edges.length || people.length !== byRecipient.size) fail('manifest_invalid');
  const seen = new Set();
  for (const item of people) {
    object(item); const id = uuid(item.recipient_id), photos = ids(item.asset_ids);
    const expected = byRecipient.get(id);
    if (seen.has(id) || !expected || photos.length !== expected.length || photos.some((photo) => !expected.includes(photo)) || item.photo_count !== photos.length) fail('manifest_invalid');
    seen.add(id);
  }
}
export function changedResponse(value, expectedSource) {
  if (value.protocol !== 'reviewed-sharing-v1' || value.status !== 'changed' || value.requires_review !== true) fail('changed_response_invalid');
  checkSource(value.source, expectedSource);
  if (value.grants_created != null && value.grants_created !== 0) fail('changed_response_invalid');
  rows(value.changed_pairs, 1000).forEach((item) => { pair(item); text(item.reason); });
  return freeze(copy(value));
}
export function previewResponse(value, snap, draft, now) {
  object(value);
  if (value.status === 'changed') return changedResponse(value, snap.source === 'professional' ? 'professional' : 'personal');
  const expected = effectiveSelection(snap, draft);
  if (value.protocol !== 'reviewed-sharing-v1') fail('preview_response_invalid');
  if (value.status === 'empty') {
    checkSource(value.source, snap.source === 'professional' ? 'professional' : 'personal');
    if (expected.length) fail('manifest_invalid');
    manifest(value, []);
    if (value.preview != null) fail('manifest_invalid');
    return freeze(copy(value));
  }
  if (value.status !== 'ready' || !expected.length) fail('preview_response_invalid');
  const view = object(value.preview);
  checkSource(view.source, snap.source === 'professional' ? 'professional' : 'personal');
  uuid(view.id); text(view.version); expiry(view.expires_at, now);
  if (view.draft_version !== draft.version || Date.parse(view.expires_at) > Date.parse(snap.expires_at)) fail('preview_scope_invalid');
  const edges = pairs(view.pairs);
  if (!samePairs(edges, expected)) fail('preview_scope_invalid');
  manifest(view, edges);
  return freeze({ ...copy(value), preview: { ...copy(view), pairs: edges } });
}
export function shareOutcome(value, expectedSource, key, approved = null) {
  object(value);
  // Unknown operation is the actual minimal lookup response, not success.
  if (value.status === 'unknown' && Object.keys(value).every((field) => field === 'status')) return freeze({ status: 'unknown' });
  if (value.status === 'changed') return changedResponse(value, expectedSource);
  if (value.protocol !== 'reviewed-sharing-v1' || !['pending_acceptance', 'access_available', 'partial', 'unavailable'].includes(value.status)) fail('outcome_response_invalid');
  checkSource(value.source, expectedSource);
  if (value.operation_key !== key) fail('operation_scope_invalid');
  // Deleted/unavailable preview has this deliberately minimal server receipt.
  if (value.status === 'unavailable' && value.recipients == null && value.totals == null) return freeze(copy(value));
  const people = rows(value.recipients, 100), edges = [];
  for (const item of people) {
    object(item); const id = uuid(item.recipient_id), photos = ids(item.asset_ids);
    uuid(item.request_id);
    if (!['requested', 'accepted', 'declined', 'withdrawn', 'revoked', 'expired', 'failed', 'unknown'].includes(item.status)) fail('outcome_response_invalid');
    integer(item.available_count, 0, photos.length);
    if (value.status === 'pending_acceptance' && item.status === 'requested' && item.available_count !== 0) fail('outcome_response_invalid');
    edges.push(...photos.map((asset_id) => ({ asset_id, recipient_id: id })));
  }
  manifest(value, edges);
  if (approved && (value.preview_id !== approved.id || !samePairs(edges, approved.pairs))) fail('outcome_scope_invalid');
  integer(value.grants_created, 0, edges.length);
  const available = people.reduce((total, item) => total + item.available_count, 0);
  if (value.status === 'pending_acceptance' && available !== 0 || value.status === 'access_available' && available !== edges.length || value.status === 'partial' && (available <= 0 || available >= edges.length) || value.status === 'unavailable' && available !== 0) fail('outcome_response_invalid');
  if (value.status === 'pending_acceptance' && value.grants_created !== 0) fail('outcome_response_invalid');
  return freeze(copy(value));
}
export function receiptResponse(value, requestId, expectedSource) {
  object(value); checkSource(value.source, expectedSource);
  if (uuid(value.id) !== requestId || typeof value.sender !== 'boolean') fail('receipt_scope_invalid');
  object(value.person); uuid(value.person.id);
  const photos = ids(value.asset_ids), count = integer(value.photo_count, 0, 100);
  integer(value.available_count, 0, count);
  if (photos.length > count || !['requested', 'accepted', 'declined', 'withdrawn', 'revoked', 'expired'].includes(value.status)) fail('receipt_response_invalid');
  if (!value.sender && value.status !== 'accepted' && photos.length) fail('receipt_response_invalid');
  if (!value.sender && value.status === 'accepted' && photos.length !== value.available_count) fail('receipt_response_invalid');
  return freeze(copy(value));
}
export function decisionResponse(value, requestId, decision, expectedSource) {
  object(value); checkSource(value.source, expectedSource);
  const expected = { accept: 'accepted', decline: 'declined', withdraw: 'withdrawn', revoke: 'revoked' }[decision];
  if (value.request_id !== requestId || value.status !== expected) fail('decision_response_invalid');
  return freeze(copy(value));
}
