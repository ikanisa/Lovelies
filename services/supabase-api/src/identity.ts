import { cancelDeviceLifecycle } from './face-profile.ts';
import { assertPrivacyActor } from './auth.ts';
import { ApiError, jsonBody, ok, uuid, type AppContext } from './types.ts';
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
        else {
            if (!(await ctx.db.one('SELECT id FROM sessions WHERE id=? AND account_id=?', id, actor.accountId)))
                throw new ApiError(404, 'session_unavailable');
            const sessionDevice = (await ctx.db.one<{
                device_id: string | null;
            }>('SELECT device_id FROM sessions WHERE id=? AND account_id=?', id, actor.accountId))?.device_id ?? null;
            (await cancelDeviceLifecycle(actor.accountId, sessionDevice, ctx));
            (await ctx.db.run('UPDATE sessions SET revoked_at=COALESCE(revoked_at,?),refresh_consumed_at=COALESCE(refresh_consumed_at,?) WHERE id=? AND account_id=?', ctx.now(), ctx.now(), id, actor.accountId));
            (await ctx.db.run("UPDATE auth_challenges SET status='cancelled',used_at=? WHERE account_id=? AND session_id=? AND used_at IS NULL", ctx.now(), actor.accountId, id));
        }
        (await ctx.db.run('INSERT INTO audit_events(id,actor_id,subject_id,action,entity_id,details_json,created_at) VALUES(?,?,?,?,?,?,?)', crypto.randomUUID(), actor.accountId, actor.accountId, device ? 'device.revoke' : 'session.revoke', id, '{}', ctx.now()));
        // Terminal self-revocation deliberately finishes without re-authorizing the
        // now-revoked credential; no subsequent private effect is permitted.
        return { status: 'revoked', current_session_revoked: device ? id === currentDevice : id === actor.sessionId, clear_device_identity: device && id === currentDevice };
    })));
}
