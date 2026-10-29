import { audienceContext, audiencePurposes, type AudiencePurpose } from './audience.ts';
import { asyncFilter, asyncMap } from './async-collections.ts';
import { accountRoles } from './auth.ts';
import { ApiError, jsonBody, ok, record, stable, uuid, type Actor, type AppContext } from './types.ts';
import { entitlementSummary } from './entitlements.ts';
// The retired source remains typed only to read and erase historical records.
// New requests accept personal sources exclusively.
export type MediaSource = 'personal' | 'professional';
export type Asset = {
    id: string;
    owner_id: string;
    source: MediaSource;
    batch_id: string | null;
    status: string;
    object_key: string;
    content_type: string;
    byte_size: number;
    checksum_sha256: string | null;
    version: string;
    width: number | null;
    height: number | null;
    title: string | null;
    captured_at: number | null;
    created_at: number;
    deleted_at: number | null;
};
export type MatchBinding = {
    asset_id: string;
    recipient_id: string;
    version: string;
    candidate_id: string;
    origin_id: string;
    source_version: string;
    source_checksum_sha256: string;
    profile_id: string;
    profile_version: string;
    model_version: string;
    matching_consent_id: string;
    profile_digest: string;
};
export async function assertMediaActor(ctx: AppContext, actor: Actor): Promise<void> {
    if (actor.authMethod !== 'registered_face')
        throw new ApiError(403, 'registered_face_required');
    (await ctx.assertActor(actor));
    const account = (await ctx.db.one<{
        identity_state: string;
    }>('SELECT identity_state FROM accounts WHERE id=? AND disabled_at IS NULL', actor.accountId));
    if (account?.identity_state !== 'registered_face')
        throw new ApiError(403, 'registered_face_required');
}
type Rendition = {
    id: string;
    asset_id: string;
    object_key: string;
    content_type: string;
    byte_size: number;
    checksum_sha256: string;
    source_checksum_sha256: string;
    source_version: string;
    version: string;
    width: number;
    height: number;
    orientation: number | null;
    verified_at: number | null;
    status: string;
    kind: string;
};
export function mediaSource(value: unknown): MediaSource {
    if (value == null || value === 'personal')
        return 'personal';
    throw new ApiError(400, 'invalid_source');
}
export function idList(value: unknown, maximum = 100): string[] {
    if (!Array.isArray(value) || value.length > maximum)
        throw new ApiError(400, 'selection_limit');
    const ids = value.map(uuid);
    if (new Set(ids).size !== ids.length)
        throw new ApiError(400, 'duplicate_id');
    return ids;
}
export async function currentAsset(ctx: AppContext, id: string): Promise<Asset | null> {
    return (await ctx.db.one<Asset>('SELECT * FROM assets WHERE id=? AND deleted_at IS NULL', id));
}
export function sourceAllowed(_actor: Actor, asset: Asset): boolean {
    return asset.source === 'personal';
}
export function currentPhotoPolicy(ctx: AppContext): string {
    const value = ctx.env.PHOTO_CONSENT_POLICY_VERSION ?? ctx.env.PHOTO_MODEL_VERSION;
    if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(value))
        throw new ApiError(503, 'photo_policy_unavailable');
    return value;
}
export async function hasConsent(ctx: AppContext, accountId: string, purpose: string): Promise<boolean> {
    if (audiencePurposes.includes(purpose as AudiencePurpose) && !await audienceContext(ctx, accountId, purpose as AudiencePurpose)) return false;
    const required = purpose === 'face_authentication' ? ctx.env.FACE_AUTH_POLICY_VERSION :
        ['photo_matching', 'photo_processing'].includes(purpose) ? currentPhotoPolicy(ctx) : null;
    return !!(await ctx.db.one(`SELECT id FROM consents WHERE account_id=? AND purpose=? AND status='granted'
    AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?) AND (? IS NULL OR policy_version=?) ORDER BY created_at DESC,id LIMIT 1`, accountId, purpose, ctx.now(), required ?? null, required ?? null));
}
// This predicate is used both for bounded snapshots and individual grant/media rechecks.
// No candidate, match score or registered identity itself grants media access.
const ELIGIBLE = `FROM candidates c
 JOIN assets a ON a.id=c.asset_id AND a.owner_id=c.owner_id
 JOIN match_origins o ON o.id=c.origin_id AND o.asset_id=a.id AND o.recipient_id=c.recipient_id
 JOIN processing_attempts t ON t.id=o.attempt_id AND t.asset_id=a.id AND t.status='completed'
 JOIN accounts sender ON sender.id=a.owner_id AND sender.disabled_at IS NULL
 JOIN accounts recipient ON recipient.id=c.recipient_id AND recipient.disabled_at IS NULL
 JOIN face_profiles fp ON fp.account_id=c.recipient_id AND fp.id=o.profile_id AND fp.status='active'
 JOIN consents consent ON consent.id=fp.consent_id AND consent.account_id=c.recipient_id
 JOIN account_preferences pref ON pref.account_id=c.recipient_id AND pref.receive_matches=1
 WHERE c.status='eligible' AND a.status='ready' AND a.deleted_at IS NULL
 AND a.owner_id<>c.recipient_id AND o.profile_version=fp.revision AND o.model_version=fp.model_id
 AND o.matching_consent_id=fp.consent_id AND o.profile_digest=fp.template_digest
 AND sender.identity_state='registered_face' AND recipient.identity_state='registered_face'
 AND a.source='personal'
 AND o.source_version=a.version AND o.source_checksum_sha256=a.checksum_sha256
 AND t.source_version=o.source_version AND t.source_checksum_sha256=o.source_checksum_sha256
 AND t.model_version=o.model_version AND consent.purpose='photo_matching' AND consent.status='granted'
 AND EXISTS(SELECT 1 FROM json_each(t.profiles_json) captured WHERE json_extract(captured.value,'$.account_id')=o.recipient_id
   AND json_extract(captured.value,'$.profile_id')=o.profile_id AND json_extract(captured.value,'$.revision')=o.profile_version
   AND json_extract(captured.value,'$.model_id')=o.model_version AND json_extract(captured.value,'$.template_digest')=o.profile_digest
   AND json_extract(captured.value,'$.matching_consent_id')=o.matching_consent_id)
 AND EXISTS(SELECT 1 FROM json_each(t.matches_json) matched WHERE json_extract(matched.value,'$.account_id')=o.recipient_id
   AND json_extract(matched.value,'$.profile_id')=o.profile_id AND json_extract(matched.value,'$.revision')=o.profile_version
   AND json_extract(matched.value,'$.model_id')=o.model_version)
 AND consent.policy_version=? AND consent.revoked_at IS NULL AND (consent.expires_at IS NULL OR consent.expires_at>?)
 AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker_id=a.owner_id AND b.blocked_id=c.recipient_id)
   OR (b.blocker_id=c.recipient_id AND b.blocked_id=a.owner_id))
 AND EXISTS(SELECT 1 FROM consents processing_consent WHERE processing_consent.account_id=a.owner_id
   AND processing_consent.purpose='photo_processing' AND processing_consent.status='granted'
   AND processing_consent.policy_version=? AND processing_consent.revoked_at IS NULL AND (processing_consent.expires_at IS NULL OR processing_consent.expires_at>?))
 AND NOT EXISTS(SELECT 1 FROM moderation_holds h WHERE h.active=1
   AND (h.subject_id=a.owner_id OR h.subject_id=c.recipient_id OR h.asset_id=a.id))`;
const BINDING_SELECT = `SELECT a.id asset_id,c.recipient_id,c.version,c.id candidate_id,o.id origin_id,
 o.source_version,o.source_checksum_sha256,o.profile_id,o.profile_version,o.model_version,o.matching_consent_id,o.profile_digest `;
export async function eligibleBindings(ctx: AppContext, ownerId: string, assetIds: string[], limit = 1001): Promise<MatchBinding[]> {
    if (!assetIds.length)
        return [];
    if (!await audienceContext(ctx, ownerId, 'photo_processing')) return [];
    const rows = (await ctx.db.all<MatchBinding>(`${BINDING_SELECT}${ELIGIBLE} AND a.owner_id=? AND a.id IN (SELECT value FROM json_each(?))
    AND o.expires_at>? ORDER BY c.recipient_id,a.id LIMIT ?`, currentPhotoPolicy(ctx), ctx.now(), currentPhotoPolicy(ctx), ctx.now(), ownerId, JSON.stringify(assetIds), ctx.now(), limit));
    return asyncFilter(rows, async binding => !!await audienceContext(ctx, binding.recipient_id, 'photo_matching'));
}
export async function currentPair(ctx: AppContext, ownerId: string, assetId: string, recipientId: string, requireFresh = true): Promise<MatchBinding | null> {
    if (!await audienceContext(ctx, ownerId, 'photo_processing') || !await audienceContext(ctx, recipientId, 'photo_matching')) return null;
    return (await ctx.db.one<MatchBinding>(`${BINDING_SELECT}${ELIGIBLE} AND a.owner_id=? AND a.id=? AND c.recipient_id=?
    ${requireFresh ? 'AND o.expires_at>?' : ''}`, currentPhotoPolicy(ctx), ctx.now(), currentPhotoPolicy(ctx), ctx.now(), ownerId, assetId, recipientId, ...(requireFresh ? [ctx.now()] : [])));
}
export function sameBinding(left: MatchBinding | null, right: MatchBinding): boolean {
    return !!left && ['asset_id', 'recipient_id', 'version', 'candidate_id', 'origin_id', 'source_version',
        'source_checksum_sha256', 'profile_id', 'profile_version', 'model_version', 'matching_consent_id', 'profile_digest'].every(key => left[key as keyof MatchBinding] === right[key as keyof MatchBinding]);
}
/** Private authority snapshot. A different later approval never substitutes for
 * the reviewed grant that admitted a ticket or an in-flight byte read. */
export type MediaAuthority = {
    protocol: 'lovelies-media-authority-v1';
    origin: 'owner';
    owner_id: string;
    asset_id: string;
    processing_consent_id: string;
    processing_consent_policy_version: string;
    processing_consent_created_at: number;
    processing_consent_expires_at: number | null;
} | {
    protocol: 'lovelies-media-authority-v1';
    origin: 'reviewed_grant';
    grant_id: string;
    request_id: string;
    approval_id: string;
    owner_id: string;
    recipient_id: string;
    asset_id: string;
    processing_consent_id: string;
    processing_consent_policy_version: string;
    processing_consent_created_at: number;
    processing_consent_expires_at: number | null;
};
const processingConsentKeys = ['processing_consent_id', 'processing_consent_policy_version',
    'processing_consent_created_at', 'processing_consent_expires_at'] as const;
type ProcessingConsentBinding = Pick<MediaAuthority, typeof processingConsentKeys[number]>;
type ReviewedGrantAuthority = Extract<MediaAuthority, { origin: 'reviewed_grant' }>;
// Metadata admission supplies the selected grant tuple; tickets and held reads
// additionally supply the exact processing episode that first admitted them.
type ReviewedGrantSelection = Pick<ReviewedGrantAuthority, 'grant_id' | 'request_id' | 'approval_id' | 'owner_id'>
    & Partial<ProcessingConsentBinding>;
const authorityUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
async function processingConsentEpisode(ctx: AppContext, ownerId: string,
    expected?: Partial<ProcessingConsentBinding>): Promise<ProcessingConsentBinding | null> {
    if (!await audienceContext(ctx, ownerId, 'photo_processing')) return null;
    const row = await ctx.db.one<{ id: string; policy_version: string; created_at: number; expires_at: number | null }>(
      `SELECT id,policy_version,created_at,expires_at FROM consents WHERE account_id=? AND purpose='photo_processing'
      AND status='granted' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?) AND policy_version=?
      AND (? IS NULL OR id=?) ORDER BY created_at DESC,id LIMIT 1`, ownerId, ctx.now(), currentPhotoPolicy(ctx),
      expected?.processing_consent_id ?? null, expected?.processing_consent_id ?? null);
    if (!row || !authorityUUID.test(row.id) || !Number.isSafeInteger(row.created_at) || row.created_at < 0
        || (row.expires_at !== null && (!Number.isSafeInteger(row.expires_at) || row.expires_at < 0))) return null;
    const binding: ProcessingConsentBinding = { processing_consent_id: row.id, processing_consent_policy_version: row.policy_version,
        processing_consent_created_at: row.created_at, processing_consent_expires_at: row.expires_at };
    // A later independent consent does not invalidate a still-current C1. C2 or
    // a changed C1 row may not substitute for the originally admitted episode.
    if (expected?.processing_consent_id && processingConsentKeys.some(key => binding[key] !== expected[key])) return null;
    return binding;
}
function isMediaAuthority(value: unknown): value is MediaAuthority {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    if (row.protocol !== 'lovelies-media-authority-v1' || (row.origin !== 'owner' && row.origin !== 'reviewed_grant')) return false;
    const ids = row.origin === 'owner' ? ['owner_id', 'asset_id', 'processing_consent_id']
        : ['grant_id', 'request_id', 'approval_id', 'owner_id', 'recipient_id', 'asset_id', 'processing_consent_id'];
    const keys = ['protocol', 'origin', ...ids, 'processing_consent_policy_version', 'processing_consent_created_at', 'processing_consent_expires_at'];
    return Object.keys(row).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(row, key))
        && ids.every(key => typeof row[key] === 'string' && authorityUUID.test(row[key] as string))
        && typeof row.processing_consent_policy_version === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(row.processing_consent_policy_version)
        && Number.isSafeInteger(row.processing_consent_created_at) && (row.processing_consent_created_at as number) >= 0
        && (row.processing_consent_expires_at === null || Number.isSafeInteger(row.processing_consent_expires_at)
            && (row.processing_consent_expires_at as number) >= 0)
        && (row.origin !== 'reviewed_grant' || row.owner_id !== row.recipient_id);
}
export function parseMediaAuthority(raw: unknown): MediaAuthority {
    // Historical NULL/unknown bindings remain stored; none may adopt the current
    // owner or a newly accepted grant when an old ticket is consumed.
    if (typeof raw === 'string' && raw.length <= 1536) {
        try { const value: unknown = JSON.parse(raw); if (isMediaAuthority(value)) return value; } catch { /* fail closed */ }
    }
    throw new ApiError(403, 'photo_authority_changed');
}
async function reviewedGrant(ctx: AppContext, accountId: string, assetId: string, requestId?: string,
    expected?: ReviewedGrantSelection): Promise<ReviewedGrantAuthority | null> {
    const grants = (await ctx.db.all<{
        grant_id: string; request_id: string; approval_id: string;
        owner_id: string; recipient_id: string; asset_id: string;
        pair_json: string; origin_id: string; candidate_id: string; pair_version: string; asset_ids_json: string;
    }>(`SELECT g.id grant_id,g.request_id,g.approval_id,g.owner_id,g.recipient_id,g.asset_id,
    p.pairs_json pair_json,ap.origin_id,ap.candidate_id,ap.pair_version,r.asset_ids_json FROM media_grants g
    JOIN sharing_approvals ap ON ap.id=g.approval_id AND ap.asset_id=g.asset_id
      AND ap.recipient_id=g.recipient_id AND ap.request_id=g.request_id AND ap.owner_id=g.owner_id
    JOIN sharing_requests r ON r.id=g.request_id AND r.status='accepted' AND r.sender_id=g.owner_id
      AND r.recipient_id=g.recipient_id AND ap.preview_id=r.preview_id
    JOIN sharing_previews p ON p.id=r.preview_id
      AND p.owner_id=g.owner_id AND p.source=r.source
    WHERE g.active=1 AND g.revoked_at IS NULL AND g.review_managed=1 AND g.recipient_id=? AND g.asset_id=?
    ${requestId ? 'AND g.request_id=?' : ''}
    ${expected ? 'AND g.id=? AND g.request_id=? AND g.approval_id=? AND g.owner_id=?' : ''}
    ORDER BY g.created_at DESC,g.id`, accountId, assetId, ...(requestId ? [requestId] : []),
        ...(expected ? [expected.grant_id, expected.request_id, expected.approval_id, expected.owner_id] : [])));
    for (const grant of grants) {
        let bindings: unknown, requested: unknown;
        try { bindings = JSON.parse(grant.pair_json); requested = JSON.parse(grant.asset_ids_json); }
        catch { continue; }
        if (!Array.isArray(bindings) || !Array.isArray(requested) || !requested.length
            || !requested.every(id => typeof id === 'string' && authorityUUID.test(id))
            || new Set(requested).size !== requested.length || !requested.includes(assetId)) continue;
        const approved = bindings.find(pair => pair && typeof pair === 'object' && pair.asset_id === assetId
            && pair.recipient_id === accountId && pair.origin_id === grant.origin_id
            && pair.candidate_id === grant.candidate_id && pair.version === grant.pair_version) as MatchBinding | undefined;
        if (!approved || !sameBinding((await currentPair(ctx, grant.owner_id, assetId, accountId, false)), approved)) continue;
        const consent = await processingConsentEpisode(ctx, grant.owner_id, expected);
        if (!consent) continue;
        const authority: ReviewedGrantAuthority = { protocol: 'lovelies-media-authority-v1', origin: 'reviewed_grant',
            grant_id: grant.grant_id, request_id: grant.request_id, approval_id: grant.approval_id,
            owner_id: grant.owner_id, recipient_id: grant.recipient_id, asset_id: grant.asset_id,
            ...consent };
        // Review expiry limits new approvals. Accepted access requires the exact
        // current source/profile/matching consent and the retained processing episode.
        if (isMediaAuthority(authority)) return authority;
    }
    return null;
}
export async function availableGrant(ctx: AppContext, accountId: string, assetId: string, requestId?: string): Promise<boolean> {
    return !!(await reviewedGrant(ctx, accountId, assetId, requestId));
}
export function assetMetadata(asset: Asset, rendition?: Rendition | null): Record<string, unknown> {
    return { id: asset.id, version: asset.version, media_source: asset.source,
        width: rendition?.width ?? asset.width, height: rendition?.height ?? asset.height,
        // Published preview bytes are orientation-normalized by the processing contract.
        orientation: rendition ? 1 : null, title: asset.title,
        captured_at: asset.captured_at == null ? null : new Date(asset.captured_at).toISOString(),
        created_at: new Date(asset.created_at).toISOString(), rendition_version: rendition?.version ?? null };
}
export async function protectedRendition(ctx: AppContext, actor: Actor, assetId: string, expected?: MediaAuthority): Promise<{
    asset: Asset;
    rendition: Rendition;
    authority: MediaAuthority;
}> {
    (await assertMediaActor(ctx, actor));
    const asset = (await currentAsset(ctx, assetId));
    if (!asset || asset.status !== 'ready')
        throw new ApiError(404, 'photo_unavailable');
    if ((await ctx.db.one(`SELECT id FROM moderation_holds WHERE active=1
    AND (subject_id=? OR subject_id=? OR asset_id=?) LIMIT 1`, actor.accountId, asset.owner_id, asset.id)))
        throw new ApiError(403, 'photo_under_review');
    if (expected && (!isMediaAuthority(expected) || expected.asset_id !== assetId
        || (expected.origin === 'owner' ? expected.owner_id : expected.recipient_id) !== actor.accountId))
        throw new ApiError(403, 'photo_authority_changed');
    let authority: MediaAuthority;
    if (asset.owner_id === actor.accountId) {
        const consent = await processingConsentEpisode(ctx, asset.owner_id, expected);
        if (!consent) throw new ApiError(403, 'photo_forbidden');
        authority = { protocol: 'lovelies-media-authority-v1', origin: 'owner', owner_id: asset.owner_id, asset_id: asset.id,
            ...consent };
        if (!isMediaAuthority(authority) || (expected && stable(expected) !== stable(authority)))
            throw new ApiError(403, 'photo_authority_changed');
        if (!sourceAllowed(actor, asset))
            throw new ApiError(403, 'photo_forbidden');
    }
    else {
        if (expected?.origin === 'owner') throw new ApiError(403, 'photo_authority_changed');
        const grant = await reviewedGrant(ctx, actor.accountId, assetId, undefined, expected);
        if (!grant) throw new ApiError(403, 'photo_forbidden');
        authority = grant;
    }
    const rendition = (await ctx.db.one<Rendition>(`SELECT * FROM renditions WHERE asset_id=? AND kind='preview'
    AND status='ready' AND verified_at IS NOT NULL AND source_version=? AND source_checksum_sha256=?`, asset.id, asset.version, asset.checksum_sha256));
    if (!rendition || rendition.byte_size <= 0 || rendition.byte_size > 4 * 1024 * 1024
        || !/^image\/(jpeg|png|webp|gif)$/.test(rendition.content_type))
        throw new ApiError(404, 'preview_unavailable');
    return { asset, rendition, authority };
}
export async function galleryAction(action: string, payload: Record<string, any>, ctx: AppContext, actor: Actor): Promise<unknown | null> {
    if (['people', 'person', 'person.photos', 'photo.people'].includes(action))
        return (await ctx.db.transaction(async () => {
            (await assertMediaActor(ctx, actor));
            const personId = action === 'person' || action === 'person.photos' ? uuid(payload.person_id) : null;
            const assetId = action === 'photo.people' ? uuid(payload.asset_id) : null;
            const owned = (await ctx.db.all<Asset>(`SELECT * FROM assets WHERE owner_id=? AND status='ready'
      AND deleted_at IS NULL AND (? IS NULL OR id=?) ORDER BY created_at DESC,id DESC LIMIT 100`, actor.accountId, assetId, assetId)).filter(asset => sourceAllowed(actor, asset));
            const bindings = (await eligibleBindings(ctx, actor.accountId, owned.map(asset => asset.id)));
            const subsets = new Map<string, Set<string>>();
            const add = (person: string, asset: string) => { (subsets.get(person) ?? subsets.set(person, new Set()).get(person)!).add(asset); };
            for (const pair of bindings)
                add(pair.recipient_id, pair.asset_id);
            // Incoming media reveals its contributor only; another recipient's match
            // graph is never visible to the recipient of a reviewed subset.
            const incoming = (await ctx.db.all<{
                asset_id: string;
                owner_id: string;
            }>(`SELECT DISTINCT asset_id,owner_id
      FROM media_grants WHERE recipient_id=? AND active=1 AND revoked_at IS NULL
      AND (? IS NULL OR asset_id=?) LIMIT 100`, actor.accountId, assetId, assetId));
            for (const row of incoming)
                if ((await availableGrant(ctx, actor.accountId, row.asset_id)))
                    add(row.owner_id, row.asset_id);
            const items: Record<string, unknown>[] = [];
            for (const [id, assets] of subsets) {
                if (personId && id !== personId)
                    continue;
                const person = (await ctx.db.one<{
                    name: string;
                }>('SELECT name FROM accounts WHERE id=? AND disabled_at IS NULL', id));
                if (!person)
                    continue;
                const visible = (await asyncFilter([...assets], async (id) => { try {
                    (await protectedRendition(ctx, actor, id));
                    return true;
                }
                catch (error) {
                    if (error instanceof ApiError && [403, 404].includes(error.status))
                        return false;
                    throw error;
                } }));
                if (visible.length)
                    items.push({ id, name: person.name, photo_count: visible.length, asset_ids: visible });
            }
            if (assetId && !items.length) {
                (await protectedRendition(ctx, actor, assetId));
                return { items: [] };
            }
            if (personId) {
                const person = items[0];
                if (!person)
                    throw new ApiError(404, 'person_unavailable');
                if (action === 'person')
                    return { person };
                const photos = (await asyncMap((person.asset_ids as string[]), async (id) => { const { asset, rendition } = (await protectedRendition(ctx, actor, id)); return { ...assetMetadata(asset, rendition), source: asset.owner_id === actor.accountId ? 'contributions' : 'received' }; }));
                return { person, items: photos, next_cursor: null };
            }
            (await assertMediaActor(ctx, actor));
            return { items };
        }));
    if (!['photos', 'photos.validate', 'sharing.photos.validate'].includes(action))
        return null;
    return (await ctx.db.transaction(async () => {
        (await assertMediaActor(ctx, actor));
        if (action !== 'photos') {
            const ids = idList(payload.asset_ids);
            const source = mediaSource(payload.source);
            const authorized = (await asyncFilter(ids, async (id) => {
                const asset = (await currentAsset(ctx, id));
                if (!asset || asset.source !== source)
                    return false;
                try {
                    (await protectedRendition(ctx, actor, id));
                    return true;
                }
                catch (error) {
                    if (error instanceof ApiError && [403, 404].includes(error.status))
                        return false;
                    throw error;
                }
            }));
            (await assertMediaActor(ctx, actor));
            return { authorized_ids: authorized };
        }
        const source = payload.source ?? 'received';
        if (!['received', 'contributions', 'all'].includes(source))
            throw new ApiError(400, 'invalid_source');
        const limit = payload.limit ?? 30;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
            throw new ApiError(400, 'selection_limit');
        if (payload.query != null && (typeof payload.query !== 'string' || payload.query.length > 500))
            throw new ApiError(400, 'invalid_query');
        const category = payload.category ?? 'all';
        if (!['all','portraits','landscapes'].includes(category)) throw new ApiError(400,'invalid_category');
        const cursor = payload.before_at == null ? null : Date.parse(payload.before_at);
        if (cursor != null && (!Number.isFinite(cursor) || payload.before_id == null))
            throw new ApiError(400, 'invalid_cursor');
        const beforeId = cursor == null ? null : uuid(payload.before_id);
        // Fetch only account-owned or accepted-grant assets; current authorization is checked on each item.
        const visible: Record<string, unknown>[] = [];
        let scanTime = cursor, scanId = beforeId;
        let exhausted = false;
        // Consume bounded SQL pages without a cursor surviving the transaction.
        // Ineligible old rows do not silently hide eligible rows farther down.
        for (let page = 0; page < 10 && visible.length <= limit; page++) {
            const rows = (await ctx.db.all<Asset>(`SELECT DISTINCT a.* FROM assets a
        LEFT JOIN media_grants g ON g.asset_id=a.id AND g.recipient_id=? AND g.active=1
        WHERE a.status='ready' AND a.deleted_at IS NULL
        AND ((? IN ('contributions','all') AND a.owner_id=?) OR (? IN ('received','all') AND g.id IS NOT NULL))
        AND (? IS NULL OR a.created_at<? OR (a.created_at=? AND a.id<?))
        AND (? IS NULL OR instr(lower(COALESCE(a.title,'')),lower(?))>0)
        AND (?='all' OR EXISTS(SELECT 1 FROM renditions filter_r WHERE filter_r.asset_id=a.id
          AND filter_r.status='ready' AND filter_r.kind='preview' AND filter_r.source_version=a.version
          AND ((?='portraits' AND filter_r.height>filter_r.width) OR (?='landscapes' AND filter_r.width>filter_r.height))))
        ORDER BY a.created_at DESC,a.id DESC LIMIT 101`, actor.accountId, source, actor.accountId, source, scanTime, scanTime, scanTime, scanId, payload.query?.trim() || null, payload.query?.trim() || null, category, category, category));
            for (const asset of rows) {
                scanTime = asset.created_at;
                scanId = asset.id;
                try {
                    const access = (await protectedRendition(ctx, actor, asset.id));
                    visible.push({ ...assetMetadata(asset, access.rendition), source: asset.owner_id === actor.accountId ? 'contributions' : 'received' });
                    if (visible.length > limit)
                        break;
                }
                catch (error) {
                    if (!(error instanceof ApiError) || ![403, 404].includes(error.status))
                        throw error;
                }
            }
            if (rows.length < 101) {
                exhausted = true;
                break;
            }
        }
        const hasMore = visible.length > limit;
        const items = visible.slice(0, limit);
        const last = items.at(-1);
        (await assertMediaActor(ctx, actor));
        return { items, next_cursor: hasMore && last ? { before_at: last.created_at, before_id: last.id }
                : !exhausted && scanTime != null && scanId ? { before_at: new Date(scanTime).toISOString(), before_id: scanId } : null };
    }));
}
async function previewBytes(ctx: AppContext, actor: Actor, assetId: string, expected?: {
    asset_version: string;
    rendition_id: string;
    rendition_version: string;
    expires_at: number;
    authority_json: unknown;
}): Promise<Response> {
    const expectedAuthority = expected ? parseMediaAuthority(expected.authority_json) : undefined;
    const initial = (await ctx.db.transaction(async () => {
        const access = (await protectedRendition(ctx, actor, assetId, expectedAuthority));
        if (expected && (expected.expires_at <= ctx.now() || access.asset.version !== expected.asset_version
            || access.rendition.id !== expected.rendition_id || access.rendition.version !== expected.rendition_version))
            throw new ApiError(403, 'preview_changed');
        return access;
    }));
    const check = async () => {
        const current = await protectedRendition(ctx, actor, assetId, initial.authority);
        if ((expected && expected.expires_at <= ctx.now()) || current.asset.version !== initial.asset.version
            || current.rendition.id !== initial.rendition.id || current.rendition.version !== initial.rendition.version)
            throw new ApiError(403, 'preview_changed');
        await assertMediaActor(ctx, actor);
        return current;
    };
    let sourceHead: Awaited<ReturnType<AppContext['env']['QUARANTINE']['head']>>;
    try {
        sourceHead = await ctx.env.QUARANTINE.head(initial.asset.object_key,{metadataBody:'preview-read'});
    } catch (error) {
        // An upstream failure can arrive after the original session, consent or
        // ticket has retired. Current authority takes precedence in that case.
        await ctx.db.transaction(check);
        throw error;
    }
    await ctx.db.transaction(check);
    if (!sourceHead || sourceHead.size !== initial.asset.byte_size || sourceHead.customMetadata?.source_version !== initial.asset.version
        || sourceHead.customMetadata?.source_checksum_sha256 !== initial.asset.checksum_sha256)
        throw new ApiError(404, 'source_unverified');
    const object = await ctx.env.PHOTOS.get(initial.rendition.object_key);
    let bytes: Uint8Array<ArrayBuffer> | undefined;
    try {
        await ctx.db.transaction(check);
        if (!object || object.size !== initial.rendition.byte_size || object.httpMetadata?.contentType !== initial.rendition.content_type
            || object.customMetadata?.source_checksum_sha256 !== initial.asset.checksum_sha256
            || object.customMetadata?.rendition_version !== initial.rendition.version)
            throw new ApiError(404, 'preview_unverified');
        bytes = new Uint8Array(await object.arrayBuffer());
        const heldBytes = bytes;
        await ctx.db.transaction(check);
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', heldBytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
        await ctx.db.transaction(check);
        const head = await ctx.env.PHOTOS.head(initial.rendition.object_key);
        await ctx.db.transaction(check);
        const finalSource = await ctx.env.QUARANTINE.head(initial.asset.object_key);
        (await ctx.db.transaction(async () => {
            const current = await check();
            if (current.rendition.checksum_sha256 !== hash || heldBytes.byteLength !== current.rendition.byte_size
                || !head || head.etag !== object.etag || head.customMetadata?.rendition_version !== current.rendition.version
                || head.customMetadata?.source_checksum_sha256 !== current.asset.checksum_sha256
                || !finalSource || finalSource.etag !== sourceHead.etag
                || finalSource.customMetadata?.source_checksum_sha256 !== current.asset.checksum_sha256
                || finalSource.customMetadata?.source_version !== current.asset.version)
                throw new ApiError(403, 'preview_changed');
            (await assertMediaActor(ctx, actor));
        }));
        return new Response(heldBytes.slice().buffer, { headers: { 'Content-Type': initial.rendition.content_type,
                'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': String(heldBytes.byteLength) } });
    }
    finally {
        bytes?.fill(0);
        if (object?.body && !object.body.locked) void object.body.cancel().catch(() => { });
    }
}
export async function handleGallery(request: Request, ctx: AppContext): Promise<Response | null> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/me/gallery') {
        const actor = await ctx.authenticate(request);
        return ok((await ctx.db.transaction(async () => {
            (await assertMediaActor(ctx, actor));
            const rows = (await ctx.db.all<{
                grant_id: string;
                candidate_id: string;
                asset_id: string;
                request_id: string;
                approval_id: string;
                owner_id: string;
                recipient_id: string;
            }>(`SELECT g.id grant_id,
        ap.candidate_id,g.asset_id,g.request_id,g.approval_id,g.owner_id,g.recipient_id FROM media_grants g JOIN sharing_approvals ap ON ap.id=g.approval_id
        WHERE g.recipient_id=? AND g.active=1 AND g.revoked_at IS NULL ORDER BY g.created_at DESC,g.id`, actor.accountId));
            const seen = new Set<string>();
            const gallery: unknown[] = [];
            for (const row of rows) {
                if (seen.has(row.asset_id))
                    continue;
                try {
                    const selected = await reviewedGrant(ctx, actor.accountId, row.asset_id, undefined, {
                        grant_id: row.grant_id, request_id: row.request_id, approval_id: row.approval_id, owner_id: row.owner_id });
                    if (!selected) throw new ApiError(403, 'photo_forbidden');
                    const { asset, rendition } = (await protectedRendition(ctx, actor, row.asset_id, selected));
                    gallery.push({ ...assetMetadata(asset, rendition), id: row.grant_id, media_asset_id: asset.id,
                        match_id: row.candidate_id, visibility: 'visible' });
                    seen.add(row.asset_id);
                    if (gallery.length === 100)
                        break;
                }
                catch (error) {
                    if (!(error instanceof ApiError) || ![403, 404].includes(error.status))
                        throw error;
                }
            }
            const entitlements = (await entitlementSummary(ctx, actor));
            (await assertMediaActor(ctx, actor));
            const canView = (await hasConsent(ctx, actor.accountId, 'photo_matching')) && (await ctx.db.one<{
                receive_matches: number;
            }>('SELECT receive_matches FROM account_preferences WHERE account_id=?', actor.accountId))?.receive_matches === 1;
            return { capabilities: { view_matched_photos: canView, download_photos: entitlements.download_photos === true }, gallery_items: gallery };
        })));
    }
    const media = /^\/community\/media\/([0-9a-f-]+)\/preview$/i.exec(url.pathname);
    if (request.method === 'GET' && media)
        return (await previewBytes(ctx, await ctx.authenticate(request), uuid(media[1])));
    if (request.method === 'POST' && url.pathname === '/previews/sign') {
        const actor = await ctx.authenticate(request);
        const payload = await jsonBody(request);
        const assetId = uuid(payload.asset_id);
        return ok((await ctx.db.transaction(async () => {
            const { asset, rendition, authority } = (await protectedRendition(ctx, actor, assetId));
            const id = crypto.randomUUID();
            const expires = Math.min(ctx.now() + 60000, actor.expiresAt);
            (await ctx.db.run(`INSERT INTO media_tickets(id,account_id,session_id,asset_id,rendition_id,asset_version,rendition_version,expires_at,authority_json)
        VALUES(?,?,?,?,?,?,?,?,?)`, id, actor.accountId, actor.sessionId, asset.id, rendition.id, asset.version, rendition.version, expires, stable(authority)));
            (await ctx.assertActor(actor));
            return { preview_url: `${ctx.env.PUBLIC_API_BASE_URL ?? url.origin}/previews/${id}`, expires_in: Math.max(1, Math.floor((expires - ctx.now()) / 1000)),
                version: asset.version, rendition_version: rendition.version };
        })));
    }
    const ticketMatch = /^\/previews\/([0-9a-f-]+)$/i.exec(url.pathname);
    if (request.method === 'GET' && ticketMatch) {
        const ticket = (await ctx.db.one<any>(`SELECT t.*,s.auth_epoch,s.expires_at session_expires_at,s.auth_method,a.roles_json
      FROM media_tickets t JOIN sessions s ON s.id=t.session_id AND s.account_id=t.account_id
      JOIN accounts a ON a.id=t.account_id WHERE t.id=? AND t.expires_at>? AND s.revoked_at IS NULL AND a.disabled_at IS NULL`, uuid(ticketMatch[1]), ctx.now()));
        if (!ticket)
            throw new ApiError(403, 'preview_expired');
        const actor: Actor = { accountId: ticket.account_id, sessionId: ticket.session_id, roles: accountRoles(ticket.roles_json),
            expiresAt: ticket.session_expires_at, authEpoch: ticket.auth_epoch, authMethod: ticket.auth_method };
        return (await previewBytes(ctx, actor, ticket.asset_id, ticket));
    }
    return null;
}
