import { assertRegisteredActor } from './operations.ts';
import { assertStoreAuthorityFresh, storeAuthorityDeadlines, type StoreAuthorityDeadlines } from './store-authority.ts';
import { ApiError, type Actor, type AppContext } from './types.ts';

async function faceReviewDeadline(ctx: AppContext, actor: Actor): Promise<number> {
    // Refresh changes session creation time without another face comparison.
    // This exact session must have its own completed login; another device's
    // proof cannot be borrowed. Choose the latest matching proof deterministically.
    const now = ctx.now();
    const proof = await ctx.db.one<{ used_at: number }>(`SELECT c.used_at FROM auth_challenges c JOIN sessions s ON s.id=?
      WHERE c.account_id=s.account_id AND c.device_id=s.device_id AND c.device_revision=s.device_revision
      AND c.profile_revision=s.face_profile_revision AND c.profile_auth_epoch=s.face_profile_epoch
      AND c.auth_epoch=s.auth_epoch AND c.consent_id=s.face_consent_id
      AND c.purpose='login' AND c.status='used' AND c.used_at>? AND c.used_at<=?
      AND c.created_at<=s.created_at AND c.used_at>=s.created_at ORDER BY c.used_at DESC,c.id LIMIT 1`,
      actor.sessionId, now - 300000, now);
    if (!proof || !Number.isSafeInteger(proof.used_at) || proof.used_at + 300000 <= ctx.now())
        throw new ApiError(403, 'fresh_face_authentication_required');
    return proof.used_at + 300000;
}

export async function requireOperator(ctx: AppContext, actor: Actor, fresh = false): Promise<void> {
    await assertRegisteredActor(ctx, actor);
    if (!actor.roles.includes('admin')) throw new ApiError(403, 'admin_required');
    if (fresh) await faceReviewDeadline(ctx, actor);
}

/** Reuse the complete registered session/consent/audience deadline collector.
 * The route additionally retains its exact face-login review deadline, and the
 * database repeats these checks after journal prepare and immediately before
 * COMMIT/response release. A possibly committed result retains its original key. */
export function bindQueueRepairAuthority(ctx: AppContext, actor: Actor): void {
    const bound = { ...actor, roles: [...actor.roles] };
    let captured: StoreAuthorityDeadlines | undefined, reviewDeadline: number | undefined;
    ctx.db.bindInvocationAuthority(async () => {
        await requireOperator(ctx, bound);
        captured = await storeAuthorityDeadlines(ctx, bound);
        reviewDeadline = await faceReviewDeadline(ctx, bound);
    }, () => {
        if (!captured || reviewDeadline === undefined) throw new ApiError(503, 'queue_repair_authority_unavailable');
        assertStoreAuthorityFresh(captured, ctx.now());
        if (reviewDeadline <= ctx.now()) throw new ApiError(403, 'fresh_face_authentication_required');
    }, 'queue_repair_outcome_unresolved');
}
