import { audienceContext } from './audience.ts';
import { currentPhotoPolicy } from './gallery.ts';
import { ApiError, digest, stable, type AppContext } from './types.ts';

// This bounds one Storage/model/SQL page, never the complete eligible population.
// At the maximum source and template sizes,128 references also fit the existing
// 40MiB private inference request limit without increasing it.
export const MATCH_PAGE_SIZE = 128;
export const MATCH_PLAN_PROTOCOL = 'lovelies-photo-candidate-plan-v1';
export const MATCH_RANK_PROTOCOL = 'lovelies-photo-ranking-page-v1';
export type CapturedProfile = {
    profile_id: string; account_id: string; revision: string; model_id: string;
    template_key: string; template_digest: string; matching_consent_id: string; audience_context: string;
};
export type MatchPlan = {
    protocol: typeof MATCH_PLAN_PROTOCOL; page_size: number; profile_count: number;
    initial_sha256: string; root_sha256: string;
};
export type MatchProgress = {
    plan_sha256: string; next_ordinal: number; chain_sha256: string;
    query_sha256: string | null; ranks_json: string;
};
export type RankedIdentity = {
    account_id: string; profile_id: string; profile_version: string; model_version: string; distance: number;
};
export type FaceRanking = { face_index: number; candidates: RankedIdentity[] };
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const invalid = (): never => { throw new ApiError(409, 'matching_plan_invalid'); };
const profileKeys = ['profile_id', 'account_id', 'revision', 'model_id', 'template_key', 'template_digest', 'matching_consent_id', 'audience_context'];
export function capturedProfile(value: unknown): CapturedProfile {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
    const p = value as Record<string, unknown>;
    if (Object.keys(p).length !== profileKeys.length || profileKeys.some(key => typeof p[key] !== 'string' || !(p[key] as string).length) ||
        !identifier(p.account_id) || !identifier(p.profile_id) || !hash(p.template_digest) ||
        (p.revision as string).length > 128 || (p.template_key as string).length > 2048 || (p.audience_context as string).length > 4096)
        return invalid();
    return p as CapturedProfile;
}
export function matchPlan(value: unknown): MatchPlan | null {
    if (Array.isArray(value)) return null; // Immutable legacy one-call snapshot.
    if (!value || typeof value !== 'object') return invalid();
    const p = value as Record<string, unknown>;
    if (Object.keys(p).sort().join(',') !== 'initial_sha256,page_size,profile_count,protocol,root_sha256' ||
        p.protocol !== MATCH_PLAN_PROTOCOL || p.page_size !== MATCH_PAGE_SIZE ||
        !Number.isSafeInteger(p.profile_count) || (p.profile_count as number) <= MATCH_PAGE_SIZE ||
        !hash(p.initial_sha256) || !hash(p.root_sha256)) return invalid();
    return p as MatchPlan;
}
export const nextProfileHash = (previous: string, profile: CapturedProfile) => digest(previous + '\n' + stable(profile));
export function planSeed(attempt: { id: string; source_version: string; source_checksum_sha256: string; model_version: string; engine_identity: string | null; processor_nonce: string }): Promise<string> {
    return digest(stable({ protocol: MATCH_PLAN_PROTOCOL, attempt_id: attempt.id, source_version: attempt.source_version,
        source_checksum_sha256: attempt.source_checksum_sha256, model_version: attempt.model_version,
        engine_identity: attempt.engine_identity, nonce: attempt.processor_nonce }));
}
const eligibleSelect = `SELECT fp.id profile_id,fp.account_id,fp.revision,fp.model_id,
    fp.template_key,fp.template_digest,fp.consent_id matching_consent_id FROM face_profiles fp
    JOIN accounts a ON a.id=fp.account_id AND a.disabled_at IS NULL AND a.identity_state='registered_face'
    JOIN account_preferences p ON p.account_id=fp.account_id AND p.receive_matches=1
    JOIN consents c ON c.id=fp.consent_id AND c.account_id=fp.account_id AND c.purpose='photo_matching'
      AND c.status='granted' AND c.policy_version=? AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>?)
    WHERE fp.status='active' AND NOT EXISTS(SELECT 1 FROM face_profile_states lifecycle WHERE lifecycle.account_id=fp.account_id AND lifecycle.matching_paused=1)
      AND fp.model_id=? AND fp.account_id<>?
      AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker_id=? AND b.blocked_id=fp.account_id)
        OR (b.blocker_id=fp.account_id AND b.blocked_id=?))`;
async function insertProfiles(ctx: AppContext, attemptId: string, first: number, profiles: CapturedProfile[]): Promise<void> {
    // The database boundary permits100 bindings per statement. Preserve that
    // boundary as well as the larger model-page limit.
    for (let start = 0; start < profiles.length; start += 25) {
        const page = profiles.slice(start, start + 25);
        const values = page.flatMap((profile, index) => [attemptId, first + start + index, profile.account_id, stable(profile)]);
        await ctx.db.run(`INSERT INTO processing_attempt_profiles(attempt_id,ordinal,account_id,profile_json) VALUES ${page.map(() => '(?,?,?,?)').join(',')}`, ...values);
    }
}
/** Called within upload completion's original serialized transaction. Every
 * eligible page is captured before the complete count/hash is sealed. A timeout
 * rolls the whole admission back; no partially captured plan becomes runnable. */
export async function captureProfilePlan(ctx: AppContext, owner: string, model: string, attempt: Parameters<typeof planSeed>[0]): Promise<CapturedProfile[] | MatchPlan> {
    const initial = await planSeed(attempt);
    let chain = initial, count = 0, after = '', large = false;
    const small: CapturedProfile[] = [];
    for (;;) {
        const page = await ctx.db.all<CapturedProfile>(eligibleSelect + ' AND fp.account_id>? ORDER BY fp.account_id LIMIT ?',
            currentPhotoPolicy(ctx), ctx.now(), model, owner, owner, owner, after, MATCH_PAGE_SIZE);
        if (!page.length) break;
        const pending: CapturedProfile[] = [];
        let first = count;
        for (const row of page) {
            if (row.account_id <= after) return invalid();
            after = row.account_id;
            const audience_context = await audienceContext(ctx, row.account_id, 'photo_matching');
            if (!audience_context) continue;
            const profile = capturedProfile({ ...row, audience_context });
            if (!large && small.length === MATCH_PAGE_SIZE) {
                await insertProfiles(ctx, attempt.id, 0, small);
                small.length = 0;
                large = true;
                first = count;
            }
            if (large) pending.push(profile); else small.push(profile);
            chain = await nextProfileHash(chain, profile);
            count++;
            if (!Number.isSafeInteger(count)) return invalid();
        }
        if (large) await insertProfiles(ctx, attempt.id, first, pending);
        if (page.length < MATCH_PAGE_SIZE) break;
    }
    if (!large) return small;
    const plan: MatchPlan = { protocol: MATCH_PLAN_PROTOCOL, page_size: MATCH_PAGE_SIZE, profile_count: count,
        initial_sha256: initial, root_sha256: chain };
    await ctx.db.run(`INSERT INTO processing_match_progress(attempt_id,plan_sha256,next_ordinal,chain_sha256,query_sha256,ranks_json,updated_at)
        VALUES(?,?,0,?,NULL,'[]',?)`, attempt.id, plan.root_sha256, initial, ctx.now());
    return plan;
}
/** Check only a captured identity. Growth in unrelated accounts cannot enlarge
 * an old admission, and a renewed consent/replaced profile never enters it. */
export async function profileIsCurrent(ctx: AppContext, owner: string, profile: CapturedProfile): Promise<boolean> {
    const actual = await ctx.db.one<CapturedProfile>(eligibleSelect + ' AND fp.account_id=?',
        currentPhotoPolicy(ctx), ctx.now(), profile.model_id, owner, owner, owner, profile.account_id);
    if (!actual) return false;
    const audience_context = await audienceContext(ctx, profile.account_id, 'photo_matching');
    return audience_context !== null && stable({ ...actual, audience_context }) === stable(profile);
}
export async function loadProfilePage(ctx: AppContext, attemptId: string, plan: MatchPlan, progress: MatchProgress): Promise<{ profiles: CapturedProfile[]; chain: string; next: number }> {
    if (progress.plan_sha256 !== plan.root_sha256 || !Number.isSafeInteger(progress.next_ordinal) || progress.next_ordinal < 0 ||
        progress.next_ordinal >= plan.profile_count || !hash(progress.chain_sha256) ||
        progress.next_ordinal === 0 && (progress.chain_sha256 !== plan.initial_sha256 || progress.query_sha256 !== null || progress.ranks_json !== '[]') ||
        progress.next_ordinal > 0 && !hash(progress.query_sha256)) return invalid();
    const count = Math.min(MATCH_PAGE_SIZE, plan.profile_count - progress.next_ordinal);
    const rows = await ctx.db.all<{ ordinal: number; account_id: string; profile_json: string }>(
        'SELECT ordinal,account_id,profile_json FROM processing_attempt_profiles WHERE attempt_id=? AND ordinal>=? ORDER BY ordinal LIMIT ?',
        attemptId, progress.next_ordinal, count);
    if (rows.length !== count) return invalid();
    let chain = progress.chain_sha256;
    const profiles: CapturedProfile[] = [];
    for (const [index, row] of rows.entries()) {
        if (row.ordinal !== progress.next_ordinal + index) return invalid();
        let value: unknown;
        try { value = JSON.parse(row.profile_json); } catch { return invalid(); }
        const profile = capturedProfile(value);
        if (profile.account_id !== row.account_id || stable(profile) !== row.profile_json) return invalid();
        profiles.push(profile);
        chain = await nextProfileHash(chain, profile);
    }
    const next = progress.next_ordinal + count;
    if (next === plan.profile_count && chain !== plan.root_sha256) return invalid();
    return { profiles, chain, next };
}
function compareRank(a: RankedIdentity, b: RankedIdentity): number {
    return a.distance - b.distance || (a.account_id < b.account_id ? -1 : a.account_id > b.account_id ? 1 : 0) ||
        (a.profile_id < b.profile_id ? -1 : a.profile_id > b.profile_id ? 1 : 0);
}
export function parseRanks(value: unknown, admitted?: Map<string, CapturedProfile>): FaceRanking[] {
    if (!Array.isArray(value) || value.length > 100) return invalid();
    return value.map((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).sort().join(',') !== 'candidates,face_index' ||
            entry.face_index !== index || !Array.isArray(entry.candidates) || entry.candidates.length > 2) return invalid();
        const candidates = entry.candidates.map((rank: unknown): RankedIdentity => {
            if (!rank || typeof rank !== 'object' || Array.isArray(rank)) return invalid();
            const r = rank as RankedIdentity;
            if (Object.keys(r).sort().join(',') !== 'account_id,distance,model_version,profile_id,profile_version' ||
                !identifier(r.account_id) || !identifier(r.profile_id) || typeof r.profile_version !== 'string' || !r.profile_version || r.profile_version.length > 128 ||
                typeof r.model_version !== 'string' || !r.model_version || typeof r.distance !== 'number' || !Number.isFinite(r.distance) || r.distance < 0 || r.distance > 2)
                return invalid();
            if (admitted) {
                const p = admitted.get(r.account_id);
                if (!p || p.profile_id !== r.profile_id || p.revision !== r.profile_version || p.model_id !== r.model_version) return invalid();
            }
            return { ...r };
        });
        if (candidates.length === 2 && (candidates[0].account_id === candidates[1].account_id || compareRank(candidates[0], candidates[1]) > 0)) return invalid();
        if (admitted && candidates.length !== Math.min(2, admitted.size)) return invalid();
        return { face_index: index, candidates };
    });
}
export function mergeRanks(previous: FaceRanking[], incoming: FaceRanking[]): FaceRanking[] {
    if (previous.length !== incoming.length) return invalid();
    return incoming.map((face, index) => {
        const combined = [...previous[index].candidates, ...face.candidates];
        // A sealed capture gives each account one ordinal. Seeing it in two
        // successful pages is a replay/overlap, never additional evidence.
        if (new Set(combined.map(row => row.account_id)).size !== combined.length) return invalid();
        return { face_index: index, candidates: combined.sort(compareRank).slice(0, 2) };
    });
}
export function matchedIdentities(ranks: FaceRanking[]): RankedIdentity[] {
    const selected = new Map<string, RankedIdentity>();
    for (const face of ranks) {
        const best = face.candidates[0];
        if (!best) continue;
        const margin = Math.max(0, (face.candidates[1]?.distance ?? 1) - best.distance);
        // The exact existing model policy; never accept on page-local margins.
        if (best.distance <= 0.42 && margin > 0 && margin >= 0.05) selected.set(best.account_id, best);
    }
    return [...selected.values()];
}
