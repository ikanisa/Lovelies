import { ApiError, type AppContext } from './types.ts';

// Advancing a bounded cursor does not complete cleanup. Rows skipped by a
// crash or blocked by authority are revisited when the scan wraps.
type Cursor = { last_at: number | null; last_id: string | null };
type CleanupPosition = { id: string; created_at: number };
type ProofPosition = { challenge_id: string; capture_index: number; created_at: number };
const BATCH = 100;
const CLEANUP = 'cleanup-intent-scan-v1';
const PROOFS = 'face-proof-scan-v1';
const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const UUID_ID = new RegExp(UUID_PATTERN);
const CLEANUP_SUPPORTED = `(id ~ '${UUID_PATTERN}' AND created_at BETWEEN 0 AND 9007199254740991)`;
const PROOF_SUPPORTED = `(p.challenge_id ~ '${UUID_PATTERN}' AND p.created_at BETWEEN 0 AND 9007199254740991)`;

function validAt(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function validId(value: unknown): value is string {
    return typeof value === 'string' && value.length === 36 && UUID_ID.test(value);
}
function validStoredId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 4096;
}
function invalid(): never { throw new ApiError(503, 'cleanup_cursor_invalid'); }
function decode(value: string, keys: string[]): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).sort().join(',') !== [...keys].sort().join(',')) return invalid();
        return parsed as Record<string, unknown>;
    } catch (error) {
        if (error instanceof ApiError) throw error;
        return invalid();
    }
}

async function cursor(ctx: AppContext, entity: string): Promise<Cursor | null> {
    const value = await ctx.db.one<Cursor>("SELECT last_at,last_id FROM retention_scan_cursors WHERE scan='privacy' AND entity_id=?", entity);
    if (!value) return null;
    if ((value.last_at === null) !== (value.last_id === null) ||
        value.last_at !== null && (!validAt(value.last_at) || !validStoredId(value.last_id))) return invalid();
    return value;
}
async function save(ctx: AppContext, entity: string, position: Cursor | null, previous: Cursor | null): Promise<void> {
    if (!position && (!previous || previous.last_at === null)) return;
    await ctx.db.run("INSERT INTO retention_scan_cursors(scan,entity_id,last_at,last_id) VALUES('privacy',?,?,?) ON CONFLICT(scan,entity_id) DO UPDATE SET last_at=excluded.last_at,last_id=excluded.last_id",
        entity, position?.last_at ?? null, position?.last_id ?? null);
}

/** Report rows excluded from these scans; other authorized workflows are separate. */
export async function unsupportedCleanupScanCounts(ctx: AppContext): Promise<{ cleanup_intents: number; terminal_face_proofs: number }> {
    const counts = await ctx.db.one<{ cleanup_intents: number; terminal_face_proofs: number }>(`SELECT
        (SELECT count(*) FROM cleanup_intents WHERE status<>'verified' AND NOT ${CLEANUP_SUPPORTED}) AS cleanup_intents,
        (SELECT count(*) FROM auth_capture_proofs p JOIN auth_challenges c ON c.id=p.challenge_id
         WHERE (c.expires_at<=? OR c.used_at IS NOT NULL OR c.status IN('failed','cancelled','used')) AND NOT ${PROOF_SUPPORTED}) AS terminal_face_proofs`, ctx.now());
    if (!counts || !validAt(counts.cleanup_intents) || !validAt(counts.terminal_face_proofs)) return invalid();
    return counts;
}

/** Fairly revisit unverified intents, including held or unresolved writers. */
export async function nextCleanupIntents<T extends CleanupPosition>(ctx: AppContext): Promise<T[]> {
    return ctx.db.transaction(async () => {
        const before = await cursor(ctx, CLEANUP);
        let after: CleanupPosition | null = null, upper: CleanupPosition | null = null;
        if (before && before.last_at !== null) {
            const value = decode(before.last_id!, ['id', 'upper_at', 'upper_id']);
            if (!validId(value.id) || !validAt(value.upper_at) || !validId(value.upper_id) || before.last_at > value.upper_at) return invalid();
            if (before.last_at === value.upper_at && !(await ctx.db.one<{ordered: boolean}>('SELECT ?<=? AS ordered', value.id, value.upper_id))?.ordered) return invalid();
            after = { id: value.id, created_at: before.last_at };
            upper = { id: value.upper_id, created_at: value.upper_at };
        }
        const head = () => ctx.db.one<CleanupPosition>(`SELECT id,created_at FROM cleanup_intents WHERE status<>'verified' AND ${CLEANUP_SUPPORTED} ORDER BY created_at DESC,id DESC LIMIT 1`);
        const select = (position: CleanupPosition | null, limit: CleanupPosition) => ctx.db.all<T>(`SELECT id,request_id,subject_id,bucket,object_key,created_at FROM cleanup_intents
            WHERE status<>'verified' AND ${CLEANUP_SUPPORTED} AND (created_at<? OR (created_at=? AND id<=?))
            ${position ? 'AND (created_at>? OR (created_at=? AND id>?))' : ''}
            ORDER BY created_at,id LIMIT ${BATCH}`,
            limit.created_at, limit.created_at, limit.id,
            ...(position ? [position.created_at, position.created_at, position.id] : []));
        if (!upper) upper = await head();
        if (upper && (!validAt(upper.created_at) || !validId(upper.id))) return invalid();
        let rows = upper ? await select(after, upper) : [];
        if (!rows.length && after) {
            upper = await head();
            if (upper && (!validAt(upper.created_at) || !validId(upper.id))) return invalid();
            rows = upper ? await select(null, upper) : [];
        }
        const last = rows.at(-1);
        if (last && (!validAt(last.created_at) || !validId(last.id))) return invalid();
        await save(ctx, CLEANUP, last && upper ? { last_at: last.created_at, last_id: JSON.stringify({ id: last.id, upper_at: upper.created_at, upper_id: upper.id }) } : null, before);
        return rows;
    });
}

/** Rotate terminal proof candidates even when an earlier proof is held. */
export async function nextTerminalFaceProofs<T extends ProofPosition>(ctx: AppContext): Promise<T[]> {
    return ctx.db.transaction(async () => {
        const before = await cursor(ctx, PROOFS);
        let position: ProofPosition | null = null, upper: ProofPosition | null = null;
        if (before?.last_at !== null && before) {
            const value = decode(before.last_id!, ['challenge', 'index', 'upper_at', 'upper_challenge', 'upper_index']);
            if (!validId(value.challenge) || !Number.isInteger(value.index) || (value.index as number) < 0 || (value.index as number) > 2 ||
                !validAt(value.upper_at) || !validId(value.upper_challenge) || !Number.isInteger(value.upper_index) || (value.upper_index as number) < 0 || (value.upper_index as number) > 2 || before.last_at > value.upper_at) return invalid();
            if (before.last_at === value.upper_at && !(await ctx.db.one<{ordered: boolean}>('SELECT (?<? OR (?=? AND ?<=?)) AS ordered', value.challenge, value.upper_challenge, value.challenge, value.upper_challenge, value.index as number, value.upper_index as number))?.ordered) return invalid();
            position = { created_at: before.last_at, challenge_id: value.challenge, capture_index: value.index as number };
            upper = { created_at: value.upper_at, challenge_id: value.upper_challenge, capture_index: value.upper_index as number };
        }
        const now = ctx.now();
        const head = () => ctx.db.one<ProofPosition>(`SELECT p.created_at,p.challenge_id,p.capture_index FROM auth_capture_proofs p JOIN auth_challenges c ON c.id=p.challenge_id
            WHERE (c.expires_at<=? OR c.used_at IS NOT NULL OR c.status IN('failed','cancelled','used')) AND ${PROOF_SUPPORTED}
            ORDER BY p.created_at DESC,p.challenge_id DESC,p.capture_index DESC LIMIT 1`, now);
        const select = (after: ProofPosition | null, limit: ProofPosition) => ctx.db.all<T>(`SELECT p.* FROM auth_capture_proofs p JOIN auth_challenges c ON c.id=p.challenge_id
            WHERE (c.expires_at<=? OR c.used_at IS NOT NULL OR c.status IN('failed','cancelled','used')) AND ${PROOF_SUPPORTED}
            AND (p.created_at<? OR (p.created_at=? AND (p.challenge_id<? OR (p.challenge_id=? AND p.capture_index<=?))))
            ${after ? 'AND (p.created_at>? OR (p.created_at=? AND (p.challenge_id>? OR (p.challenge_id=? AND p.capture_index>?))))' : ''}
            ORDER BY p.created_at,p.challenge_id,p.capture_index LIMIT ${BATCH}`,
            now, limit.created_at, limit.created_at, limit.challenge_id, limit.challenge_id, limit.capture_index,
            ...(after ? [after.created_at, after.created_at, after.challenge_id, after.challenge_id, after.capture_index] : []));
        const validProof = (row: ProofPosition) => validAt(row.created_at) && validId(row.challenge_id) && Number.isInteger(row.capture_index) && row.capture_index >= 0 && row.capture_index <= 2;
        if (!upper) upper = await head();
        if (upper && !validProof(upper)) return invalid();
        let rows = upper ? await select(position, upper) : [];
        if (!rows.length && position) {
            upper = await head();
            if (upper && !validProof(upper)) return invalid();
            rows = upper ? await select(null, upper) : [];
        }
        const last = rows.at(-1);
        if (last && !validProof(last)) return invalid();
        await save(ctx, PROOFS, last && upper ? { last_at: last.created_at, last_id: JSON.stringify({ challenge: last.challenge_id, index: last.capture_index, upper_at: upper.created_at, upper_challenge: upper.challenge_id, upper_index: upper.capture_index }) } : null, before);
        return rows;
    });
}
