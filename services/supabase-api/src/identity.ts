import { cancelDeviceLifecycle, unusedPendingConsents } from './face-profile.ts';
import { accountRoles, assertPrivacyActor, type AccountRow, type SessionRow } from './auth.ts';
import { ApiError, digest, jsonBody, ok, stable, uuid, type Actor, type AppContext } from './types.ts';
import { restoreAllocationID, restoreOperationID } from './restore-transaction.ts';
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

type RetiringDevice = { id: string; account_id: string; revision: string; status: string; created_at: number; public_jwk: string; face_handle: string | null };
type DeviceAccount = { auth_epoch: number; identity_state: string; disabled_at: number | null };
type DeviceRetirementFact = { kind: 'device-retired' | 'session-retired' | 'consent-withdrawn'; scope: Record<string, string> };
async function deviceRetirement(accountId: string, deviceId: string, ctx: AppContext) {
    const device = await ctx.db.one<RetiringDevice>('SELECT id,account_id,revision,status,created_at,public_jwk,face_handle FROM auth_devices WHERE id=? AND account_id=?', deviceId, accountId);
    if (!device) throw new ApiError(404, 'device_unavailable');
    // Already-revoked legacy devices are truthful no-ops. Do not churn their
    // stored revision, inspect/cancel later work or invent a historical receipt.
    if (device.status === 'revoked') return { device, account: null, rows: [], sessions: [], scope: null, pending: [], facts: [] as DeviceRetirementFact[] };
    const account = await ctx.db.one<DeviceAccount>('SELECT auth_epoch,identity_state,disabled_at FROM accounts WHERE id=?', accountId);
    if (!account || !Number.isSafeInteger(account.auth_epoch) || account.auth_epoch < 1 ||
        !['anonymous', 'registered_face'].includes(account.identity_state) || !['active', 'pending', 'disabled'].includes(device.status) ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(device.revision) || !Number.isSafeInteger(device.created_at) || device.created_at < 0)
        throw new ApiError(409, 'device_revoke_metadata_invalid');
    // Snapshot all rows, but change only the canonical known generation. A
    // same device ID never proves that an unknown/future session is ours to edit.
    const rows = await ctx.db.all<RetiringSession>('SELECT id,account_id,auth_method,device_id,device_revision,auth_epoch,created_at,revoked_at,refresh_consumed_at FROM sessions WHERE account_id=? AND device_id=? ORDER BY id', accountId, deviceId);
    const sessions = rows.filter(row => row.revoked_at === null && row.device_revision === device.revision &&
        row.auth_epoch === account.auth_epoch && row.auth_method === account.identity_state);
    if (sessions.some(row => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.id)))
        throw new ApiError(409, 'device_revoke_metadata_invalid');
    // Reuse the proven selector only for a real sole selected session. Multiple
    // sessions, shared references and unknown generations preserve lifecycle
    // metadata while the exact device retirement still disables its authority.
    const scope = sessions.length === 1 ? await sessionRetirementScope(ctx, sessions[0]) : null;
    const pending = scope?.cancelDeviceLifecycle ? await unusedPendingConsents(accountId, ctx, deviceId) : [];
    const facts: DeviceRetirementFact[] = [
        { kind: 'device-retired', scope: { account_id: accountId, device_id: deviceId, device_revision: device.revision } },
        ...sessions.map(row => ({ kind: 'session-retired' as const, scope: { account_id: accountId, session_id: row.id } })),
        ...pending.filter(row => row.status !== 'revoked').map(row => ({ kind: 'consent-withdrawn' as const,
            scope: { account_id: row.account_id, consent_id: row.id, purpose: row.purpose } })),
    ];
    return { device, account, rows, sessions, scope, pending: [...pending].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        facts: [...new Map(facts.map(fact => [stable(fact), fact])).entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, fact]) => fact) };
}
type DeviceActorAuthority = { account: Pick<AccountRow, 'id' | 'roles_json' | 'disabled_at' | 'auth_epoch' | 'identity_state'>; session: SessionRow };
async function deviceActorAuthority(actor: Actor, ctx: AppContext): Promise<DeviceActorAuthority> {
    const account = await ctx.db.one<DeviceActorAuthority['account']>('SELECT id,roles_json,disabled_at,auth_epoch,identity_state FROM accounts WHERE id=?', actor.accountId);
    const session = await ctx.db.one<SessionRow>('SELECT * FROM sessions WHERE id=? AND account_id=?', actor.sessionId, actor.accountId);
    if (!account || !session) throw new ApiError(401, 'session_invalid');
    return { account, session };
}
/** A normal privacy postguard must reject the session/device just retired by
 * this transaction. Permit only those exact expected changes, while preserving
 * the original caller's account/session authority and sampling expiry after all
 * final SQL reads. This does not revive the retired credential or permit a retry. */
async function assertTerminalDeviceActor(actor: Actor, original: DeviceActorAuthority,
    device: RetiringDevice, revision: string, retiredAt: number, ctx: AppContext): Promise<void> {
    const current = await deviceActorAuthority(actor, ctx);
    const retired = await ctx.db.one<RetiringDevice>('SELECT id,account_id,revision,status,created_at,public_jwk,face_handle FROM auth_devices WHERE id=? AND account_id=?', device.id, actor.accountId);
    const now = ctx.now(), { account, session } = original;
    const rolesMatch = stable([...accountRoles(current.account.roles_json)].sort()) === stable([...actor.roles].sort());
    if (stable(current.account) !== stable(account) || account.id !== actor.accountId || account.disabled_at !== null ||
        session.id !== actor.sessionId || session.account_id !== actor.accountId || session.revoked_at !== null ||
        session.auth_epoch !== account.auth_epoch || actor.authEpoch !== account.auth_epoch || session.auth_method !== actor.authMethod ||
        session.expires_at !== actor.expiresAt || session.expires_at <= now || session.refresh_expires_at <= now || !rolesMatch ||
        account.identity_state !== actor.authMethod || session.device_id !== device.id || session.device_revision !== device.revision ||
        (actor.authMethod === 'registered_face' && device.status !== 'active') ||
        (actor.authMethod === 'anonymous' && stable([...actor.roles].sort()) !== stable(['user'])) ||
        stable(current.session) !== stable({ ...session, revoked_at: retiredAt, refresh_consumed_at: session.refresh_consumed_at ?? retiredAt }))
        throw new ApiError(401, 'session_invalid');
    if (!retired || stable(retired) !== stable({ ...device, status: 'revoked', revision, face_handle: null }))
        throw new ApiError(409, 'device_revoke_authority_changed');
}
async function revokeOwnDevice(actor: Actor, id: string, ctx: AppContext): Promise<Record<string, unknown>> {
    return ctx.db.transaction(async restore => {
        await assertPrivacyActor(actor, ctx);
        const originalActor = await deviceActorAuthority(actor, ctx);
        const currentDevice = originalActor.session.device_id;
        const selected = await deviceRetirement(actor.accountId, id, ctx);
        if (selected.device.status !== 'revoked') {
            if (currentDevice === id && !selected.sessions.some(row => row.id === actor.sessionId))
                throw new ApiError(409, 'device_revoke_metadata_invalid');
            if (selected.facts.length > 32) throw new ApiError(503, 'device_revoke_restriction_capacity');
            // Native callers omit operation_key; the optional former key remains
            // ignored. A bounded digest keys this exact original revision episode.
            const episode = await digest(stable({ device_id: id, device_revision: selected.device.revision }));
            const operationId = await restoreOperationID(actor.accountId, 'identity.device-revoke-v1', 'device.revoke:' + episode);
            const revision = await restoreAllocationID(operationId, 'id_0');
            if (revision === selected.device.revision) throw new ApiError(409, 'device_revoke_revision_conflict');
            restore.operation({ operation_id: operationId, input_hash: await digest(stable({ protocol: 'lovelies-own-device-revoke-v1',
                account_id: actor.accountId, device_id: id, device_revision: selected.device.revision, device_created_at: selected.device.created_at,
                auth_epoch: selected.account!.auth_epoch, identity_state: selected.account!.identity_state })), allocations: { id_0: revision } });
            for (const fact of selected.facts) await restore.restrict(fact.kind, fact.scope);
            await assertPrivacyActor(actor, ctx);
            if (stable(await deviceRetirement(actor.accountId, id, ctx)) !== stable(selected))
                throw new ApiError(409, 'device_revoke_authority_changed');
            if (selected.scope?.cancelDeviceLifecycle) await cancelDeviceLifecycle(actor.accountId, id, ctx);
            await ctx.db.run("UPDATE auth_devices SET status='revoked',face_handle=NULL,revision=? WHERE id=? AND account_id=? AND revision=?", revision, id, actor.accountId, selected.device.revision);
            const retiredAt = ctx.now();
            for (const session of selected.sessions)
                await ctx.db.run('UPDATE sessions SET revoked_at=COALESCE(revoked_at,?),refresh_consumed_at=COALESCE(refresh_consumed_at,?) WHERE id=? AND account_id=? AND device_id=? AND device_revision=? AND auth_epoch=?', retiredAt, retiredAt, session.id, actor.accountId, id, selected.device.revision, session.auth_epoch);
            if (selected.scope?.cancelSessionChallenges)
                for (const session of selected.sessions)
                    await ctx.db.run("UPDATE auth_challenges SET status='cancelled',used_at=? WHERE account_id=? AND session_id=? AND used_at IS NULL", ctx.now(), actor.accountId, session.id);
            const retired = await ctx.db.one<RetiringDevice>('SELECT id,account_id,revision,status,created_at,public_jwk,face_handle FROM auth_devices WHERE id=? AND account_id=?', id, actor.accountId);
            if (!retired || stable(retired) !== stable({ ...selected.device, status: 'revoked', revision, face_handle: null }))
                throw new ApiError(409, 'device_revoke_authority_changed');
            await ctx.db.run('INSERT INTO audit_events(id,actor_id,subject_id,action,entity_id,details_json,created_at) VALUES(?,?,?,?,?,?,?)', crypto.randomUUID(), actor.accountId, actor.accountId, 'device.revoke', id, '{}', ctx.now());
            // The original route did not clear push registrations. The revoked
            // canonical device fences their provider use; no broader cleanup added.
            if (currentDevice === id) await assertTerminalDeviceActor(actor, originalActor, selected.device, revision, retiredAt, ctx);
            else await assertPrivacyActor(actor, ctx);
        } else await assertPrivacyActor(actor, ctx);
        return { status: 'revoked', current_session_revoked: id === currentDevice, clear_device_identity: id === currentDevice };
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
    return ok(await revokeOwnDevice(actor, id, ctx));
}
