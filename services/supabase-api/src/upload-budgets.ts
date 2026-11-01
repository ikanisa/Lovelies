import { ApiError, type AppContext, type SupabaseEnv } from './types.ts';

export const uploadBudgetKeys = ['UPLOAD_MAX_INFLIGHT', 'UPLOAD_MAX_RESERVED_SOURCE_BYTES', 'UPLOAD_MAX_DAILY_SOURCE_BYTES',
    'UPLOAD_MAX_DAILY_RESERVATIONS', 'PHOTO_MAX_DAILY_ATTEMPTS'] as const;
type Limits = Record<typeof uploadBudgetKeys[number], number>;
/** Deployment supplies engineering capacity budgets. No product tier or
 * commercial allowance is inferred and no permissive production default exists. */
export function uploadBudgetConfiguration(env: SupabaseEnv): { limits: Limits; missing: string[] } {
    const limits = {} as Limits, missing: string[] = [];
    for (const name of uploadBudgetKeys) {
        const raw = env[name], value = typeof raw === 'string' && /^[1-9][0-9]{0,15}$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isSafeInteger(value) || value < 1) missing.push(name); else limits[name] = value;
    }
    return { limits, missing };
}
function configured(ctx: AppContext): Limits {
    const value = uploadBudgetConfiguration(ctx.env);
    if (value.missing.length) throw new ApiError(503, 'upload_budget_configuration_required');
    return value.limits;
}
function count(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ApiError(503, 'upload_budget_unverified');
    return value;
}
/** Call inside the same serialized reservation transaction as INSERT assets.
 * All reservations count against rolling 24h budgets, including failures and
 * cancellations. In-flight slots release at terminal status; source bytes
 * release after terminal cancellation/expiry and confirmed cleanup/writers.
 * Any unsettled subject cleanup conservatively retains all its terminal bytes. */
export async function assertUploadBudget(ctx: AppContext, account: string, bytes: number): Promise<void> {
    const limits = configured(ctx);
    const unresolved = !!await ctx.db.one(`SELECT id FROM accounts WHERE id=? AND (
        EXISTS(SELECT 1 FROM media_write_intents w WHERE w.account_id=accounts.id AND w.status='pending')
        OR EXISTS(SELECT 1 FROM cleanup_intents c WHERE c.subject_id=accounts.id AND c.status<>'verified')
        OR EXISTS(SELECT 1 FROM retention_jobs j WHERE j.subject_id=accounts.id AND j.status<>'verified'))`, account);
    const row = await ctx.db.one<{ inflight: number; reserved: number; daily_bytes: number; daily_count: number }>(`SELECT
        count(*) FILTER(WHERE status IN('uploading','uploaded','processing')) inflight,
        coalesce(sum(byte_size) FILTER(WHERE status NOT IN('cancelled','expired','privacy_erasure') OR ?=1),0)::bigint reserved,
        coalesce(sum(byte_size) FILTER(WHERE created_at>=?),0)::bigint daily_bytes,
        count(*) FILTER(WHERE created_at>=?) daily_count FROM assets WHERE owner_id=?`, unresolved ? 1 : 0, ctx.now()-86400000, ctx.now()-86400000, account);
    if (!row) throw new ApiError(503, 'upload_budget_unverified');
    if (count(row.inflight) >= limits.UPLOAD_MAX_INFLIGHT) throw new ApiError(429, 'upload_inflight_budget_exceeded');
    if (count(row.reserved) > limits.UPLOAD_MAX_RESERVED_SOURCE_BYTES - bytes) throw new ApiError(429, 'upload_source_budget_exceeded');
    if (count(row.daily_bytes) > limits.UPLOAD_MAX_DAILY_SOURCE_BYTES - bytes) throw new ApiError(429, 'upload_daily_bytes_budget_exceeded');
    if (count(row.daily_count) >= limits.UPLOAD_MAX_DAILY_RESERVATIONS) throw new ApiError(429, 'upload_daily_reservation_budget_exceeded');
}
export async function assertPhotoAttemptBudget(ctx: AppContext, account: string): Promise<void> {
    const limits = configured(ctx), row = await ctx.db.one<{ n: number }>('SELECT count(*) n FROM processing_attempts WHERE owner_id=? AND captured_at>=?', account, ctx.now()-86400000);
    if (!row || count(row.n) >= limits.PHOTO_MAX_DAILY_ATTEMPTS) throw new ApiError(429, 'photo_daily_attempt_budget_exceeded');
}
