import { cancelDeviceLifecycle, unusedPendingConsents } from './face-profile.ts';
import { assertPrivacyActor } from './auth.ts';
import { ApiError, digest, jsonBody, ok, stable, uuid, type Actor, type AppContext } from './types.ts';
import { restoreOperationID } from './restore-transaction.ts';
import { sessionRetirementScope, type RetirementSession } from './session-retirement.ts';
type RetiringSession = RetirementSession & { created_at: number };
type SessionRetirementFact = { kind: 'session-retired' | 'consent-withdrawn'; scope: Record<string, string> };
async function sessionRetirement(account: string, id: string, ctx: AppContext): Promise<{
    session: RetiringSession; pending: Awaited<ReturnType<typeof unusedPendingConsents>>; facts: SessionRetirementFact[];
    scope: Awaited<ReturnType<typeof sessionRetirementScope>> | null;
}> {
    const session = await ctx.db.one<RetiringSession>('SELECT id,account_id,auth_method,device_id,device_revision,auth_epoch,created_at,revoked_at,refresh_consumed_at FROM sessions WHERE id=? AND account_id=?', id, account);
    if (!session) throw new ApiError(404, 'session_unavailable');
    // The shared read-only scope preserves newer or ambiguous lifecycle and
    // challenge generations while allowing exact retirement of this owned row.
    const scope = session.revoked_at !== null ? null : await sessionRetirementScope(ctx, session);
    const pending = scope?.cancelDeviceLifecycle ? await unusedPendingConsents(account, ctx, session.device_id!) : [];
    const facts: SessionRetirementFact[] = session.revoked_at !== null ? [] : [
        { kind: 'session-retired', scope: { account_id: account, session_id: session.id } },
        ...pending.filter(row => row.status !== 'revoked').map(row => ({ kind: 'consent-withdrawn' as const,
            scope: { account_id: row.account_id, consent_id: row.id, purpose: row.purpose } })),
    ];
    return { session, scope, pending: [...pending].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        facts: [...new Map(facts.map(fact => [stable(fact), fact])).entries()]
            .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, fact]) => fact) };
}
async function revokeOwnSession(actor: Actor, id: string, ctx: AppContext): Promise<Record<string, unknown>> {
    return ctx.db.transaction(async restore => {
        await assertPrivacyActor(actor, ctx);
        const selected = await sessionRetirement(actor.accountId, id, ctx);
        if (selected.session.revoked_at === null) {
            if (selected.facts.length > 32) throw new ApiError(503, 'session_revoke_restriction_capacity');
            // Both native clients omit operation_key; it was accepted but ignored.
            // The immutable target session UUID identifies this terminal episode.
            restore.operation({ operation_id: await restoreOperationID(actor.accountId, 'identity.session-revoke-v1', 'session.revoke:' + id),
                input_hash: await digest(stable({ protocol: 'lovelies-own-session-revoke-v1', account_id: actor.accountId,
                    session_id: id, auth_method: selected.session.auth_method, auth_epoch: selected.session.auth_epoch, created_at: selected.session.created_at, device_id: selected.session.device_id, device_revision: selected.session.device_revision })), allocations: {} });
            for (const fact of selected.facts) await restore.restrict(fact.kind, fact.scope);
            await assertPrivacyActor(actor, ctx);
            if (stable(await sessionRetirement(actor.accountId, id, ctx)) !== stable(selected))
                throw new ApiError(409, 'session_revoke_authority_changed');
            if (selected.scope?.cancelDeviceLifecycle) await cancelDeviceLifecycle(actor.accountId, selected.session.device_id, ctx);
            await ctx.db.run('UPDATE sessions SET revoked_at=COALESCE(revoked_at,?),refresh_consumed_at=COALESCE(refresh_consumed_at,?) WHERE id=? AND account_id=?', ctx.now(), ctx.now(), id, actor.accountId);
            if (selected.scope?.cancelSessionChallenges) await ctx.db.run("UPDATE auth_challenges SET status='cancelled',used_at=? WHERE account_id=? AND session_id=? AND used_at IS NULL", ctx.now(), actor.accountId, id);
            await ctx.db.run('INSERT INTO audit_events(id,actor_id,subject_id,action,entity_id,details_json,created_at) VALUES(?,?,?,?,?,?,?)', crypto.randomUUID(), actor.accountId, actor.accountId, 'session.revoke', id, '{}', ctx.now());
            // Self-retirement releases no new credential or private response.
            // A surviving caller still needs current authority before returning.
            if (id !== actor.sessionId) await assertPrivacyActor(actor, ctx);
        } else await assertPrivacyActor(actor, ctx);
        // The flag describes this fresh caller, never a cached former caller.
        return { status: 'revoked', current_session_revoked: id === actor.sessionId, clear_device_identity: false };
    });
}
/** Private account-security controls. Never return refresh hashes, public keys
 * or opaque face handles. Revocation can only remove existing authority. */
export async function handleIdentity(request: Request, ctx: AppContext): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    if (!['/me/sessions', '/me/devices', '/auth/session/revoke', '/auth/device/revoke'].includes(path))
        return null;
    const actor = await ctx.authenticate(request);
    (await assertPrivacyActor(actor, ctx));
    if (request.method === 'GET' && path === '/me/sessions')
        return ok((await ctx.db.transaction(async () => {
            (await assertPrivacyActor(actor, ctx));
            const sessions = (await ctx.db.all<{
                id: string;
                device_id: string;
                created_at: number;
                expires_at: number;
            }>('SELECT id,device_id,created_at,expires_at FROM sessions WHERE account_id=? AND revoked_at IS NULL AND refresh_expires_at>? ORDER BY created_at DESC,id LIMIT 100', actor.accountId, ctx.now()));
            return { items: sessions.map(s => ({ id: s.id, device_id: s.device_id, current: s.id === actor.sessionId, created_at: new Date(s.created_at).toISOString(), expires_at: new Date(s.expires_at).toISOString() })) };
        })));
    if (request.method === 'GET' && path === '/me/devices')
        return ok((await ctx.db.transaction(async () => {
            (await assertPrivacyActor(actor, ctx));
            const current = (await ctx.db.one<{
                device_id: string;
            }>('SELECT device_id FROM sessions WHERE id=?', actor.sessionId))?.device_id;
            const devices = (await ctx.db.all<{
                id: string;
                created_at: number;
                status: string;
            }>('SELECT id,created_at,status FROM auth_devices WHERE account_id=? ORDER BY created_at DESC,id LIMIT 100', actor.accountId));
            return { items: devices.map(d => ({ id: d.id, current: d.id === current, status: d.status, created_at: new Date(d.created_at).toISOString() })) };
        })));
    if (request.method !== 'POST')
        throw new ApiError(405, 'method_not_allowed');
    const input = await jsonBody(request, 2048);
    const device = path === '/auth/device/revoke', field = device ? 'device_id' : 'session_id';
    if (Object.keys(input).some(k => ![field, 'operation_key'].includes(k)))
        throw new ApiError(400, 'revocation_input_invalid');
    const id = uuid(input[field]);
    if (!device) return ok(await revokeOwnSession(actor, id, ctx));
    return ok((await ctx.db.transaction(async () => {
        (await assertPrivacyActor(actor, ctx));
        const currentDevice = (await ctx.db.one<{
            device_id: string;
        }>('SELECT device_id FROM sessions WHERE id=?', actor.sessionId))?.device_id;
        if (device) {
            (await cancelDeviceLifecycle(actor.accountId, id, ctx));
            if (!(await ctx.db.one('SELECT id FROM auth_devices WHERE id=? AND account_id=?', id, actor.accountId)))
                throw new ApiError(404, 'device_unavailable');
            (await ctx.db.run("UPDATE auth_devices SET status='revoked',face_handle=NULL,revision=? WHERE id=? AND account_id=?", crypto.randomUUID(), id, actor.accountId));
            (await ctx.db.run('UPDATE sessions SET revoked_at=COALESCE(revoked_at,?),refresh_consumed_at=COALESCE(refresh_consumed_at,?) WHERE account_id=? AND device_id=?', ctx.now(), ctx.now(), actor.accountId, id));
            (await ctx.db.run("UPDATE auth_challenges SET status='cancelled',used_at=? WHERE account_id=? AND device_id=? AND used_at IS NULL", ctx.now(), actor.accountId, id));
        }
        (await ctx.db.run('INSERT INTO audit_events(id,actor_id,subject_id,action,entity_id,details_json,created_at) VALUES(?,?,?,?,?,?,?)', crypto.randomUUID(), actor.accountId, actor.accountId, device ? 'device.revoke' : 'session.revoke', id, '{}', ctx.now()));
        // Terminal self-revocation deliberately finishes without re-authorizing the
        // now-revoked credential; no subsequent private effect is permitted.
        return { status: 'revoked', current_session_revoked: device ? id === currentDevice : id === actor.sessionId, clear_device_identity: device && id === currentDevice };
    })));
}
