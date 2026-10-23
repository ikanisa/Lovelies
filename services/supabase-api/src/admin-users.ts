import { accountRoles, base64url, decodeBase64url } from './auth.ts';
import { cancelDeviceLifecycle } from './face-profile.ts';
import { executeOperation, prepareOperation } from './operations.ts';
import { requireOperator } from './operators.ts';
import { ApiError, jsonBody, ok, stable, uuid, type Actor, type AppContext } from './types.ts';
type Account = {
    id: string;
    name: string;
    roles_json: string;
    identity_state: 'anonymous' | 'registered_face';
    disabled_at: number | null;
    created_at: number;
    active_sessions: number;
    open_support: number;
    open_reports: number;
    pending_privacy: number;
    matching_status: 'active' | 'paused' | 'absent' | null;
};
type Filters = {
    q: string;
    status: string;
    limit: number;
};
type Cursor = Filters & {
    id: string;
    created_at: number;
};
const limits = { sessions: 50, cases_per_kind: 20, history: 30 } as const;
const accountFields = 'a.id,a.name,a.roles_json,a.identity_state,a.disabled_at,a.created_at';
// This is session-record validity, including refreshable sessions, rather than
// an assertion that a particular access token remains in the user's possession.
// Keep the profile/consent/device predicates aligned with assertEnrollmentActor.
const sessionAuthority = `a.disabled_at IS NULL AND s.revoked_at IS NULL
  AND s.refresh_consumed_at IS NULL AND s.auth_epoch=a.auth_epoch
  AND s.auth_method=a.identity_state AND (
    (s.auth_method='anonymous' AND json_array_length(a.roles_json)=1
      AND json_extract(a.roles_json,'$[0]')='user') OR
    (s.auth_method='registered_face' AND EXISTS(
      SELECT p.id FROM face_profiles p JOIN consents c ON c.id=p.auth_consent_id
      JOIN auth_devices d ON d.id=s.device_id AND d.account_id=p.account_id
      WHERE p.account_id=a.id AND p.status='active' AND p.auth_enabled=1
        AND p.revision=s.face_profile_revision AND p.auth_epoch=s.face_profile_epoch
        AND p.auth_consent_id=s.face_consent_id AND c.account_id=p.account_id
        AND c.purpose='face_authentication' AND c.status='granted' AND c.revoked_at IS NULL
        AND (c.expires_at IS NULL OR c.expires_at>clock.now)
        AND c.policy_version=clock.policy
        AND (c.profile_revision IS NULL OR c.profile_revision=p.revision)
        AND d.status='active' AND d.revision=s.device_revision)))`;
const summaryFields = `${accountFields},
  CASE WHEN a.disabled_at IS NOT NULL OR NOT EXISTS(
    SELECT 1 FROM face_profiles p WHERE p.account_id=a.id AND p.status='active') THEN 'absent'
    WHEN EXISTS(SELECT 1 FROM face_profile_states fs WHERE fs.account_id=a.id AND fs.matching_paused=1) THEN 'paused'
    WHEN EXISTS(SELECT 1 FROM face_profiles p JOIN consents c ON c.id=p.consent_id
      WHERE p.account_id=a.id AND p.status='active' AND c.account_id=a.id
        AND c.purpose='photo_matching' AND c.status='granted' AND c.revoked_at IS NULL
        AND c.policy_version=clock.photo_policy AND (c.expires_at IS NULL OR c.expires_at>clock.now)) THEN 'active'
    ELSE NULL END matching_status,
  (SELECT count(*) FROM sessions s WHERE s.account_id=a.id
    AND s.refresh_expires_at>clock.now AND ${sessionAuthority}) active_sessions,
  (SELECT count(*) FROM support_requests r WHERE r.account_id=a.id
    AND r.status IN('open','under_review')) open_support,
  (SELECT count(*) FROM safety_reports r WHERE (r.reporter_id=a.id OR r.subject_id=a.id)
    AND r.status IN('open','under_review')) open_reports,
  (SELECT count(*) FROM privacy_requests r WHERE r.subject_id=a.id
    AND r.status IN('pending_approval','approved','queued','processing','failed')
    AND (r.expires_at>clock.now OR r.metadata_erased_at IS NOT NULL)) pending_privacy`;
const clockSql = 'WITH clock AS (SELECT ? AS now,? AS policy,? AS photo_policy)';
const clockValues = (ctx: AppContext): [
    number,
    string,
    string
] => [ctx.now(), ctx.env.FACE_AUTH_POLICY_VERSION ?? '', ctx.env.PHOTO_CONSENT_POLICY_VERSION ?? ctx.env.PHOTO_MODEL_VERSION ?? ''];
function summary(row: Account) {
    return {
        id: row.id, name: row.disabled_at === null ? row.name : '', identity_state: row.identity_state,
        status: row.disabled_at === null ? 'active' : 'deleted', roles: row.disabled_at === null ? accountRoles(row.roles_json) : [],
        matching_status: row.matching_status,
        created_at: row.created_at, active_sessions: row.active_sessions,
        open_support: row.open_support, open_reports: row.open_reports, pending_privacy: row.pending_privacy,
    };
}
function filters(params: URLSearchParams): Filters {
    const keys = [...params.keys()];
    if (new Set(keys).size !== keys.length || keys.some(key => !['q', 'status', 'limit', 'cursor'].includes(key)))
        throw new ApiError(400, 'invalid_input');
    const q = (params.get('q') ?? '').trim().normalize('NFC');
    const status = params.get('status') ?? 'all', rawLimit = params.get('limit') ?? '25';
    if (q.length > 100 || /[\u0000-\u001f\u007f]/.test(q) || !['all', 'registered', 'anonymous', 'deleted'].includes(status) ||
        !/^[1-9][0-9]{0,2}$/.test(rawLimit) || Number(rawLimit) > 100)
        throw new ApiError(400, 'invalid_input');
    return { q, status, limit: Number(rawLimit) };
}
function readCursor(value: string | null, filter: Filters): Cursor | null {
    if (value === null)
        return null;
    try {
        if (value.length > 2048)
            throw new Error();
        const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64url(value, 1536)));
        if (!parsed || Array.isArray(parsed) || Object.keys(parsed).sort().join(',') !== 'created_at,id,limit,q,status' ||
            parsed.q !== filter.q || parsed.status !== filter.status || parsed.limit !== filter.limit ||
            !Number.isSafeInteger(parsed.created_at) || parsed.created_at < 0)
            throw new Error();
        return { ...filter, id: uuid(parsed.id), created_at: parsed.created_at };
    }
    catch {
        throw new ApiError(400, 'invalid_cursor');
    }
}
async function audit(ctx: AppContext, actor: Actor, action: string, subject: string | null, entity: string | null, details: Record<string, unknown> = {}): Promise<void> {
    (await ctx.db.run('INSERT INTO audit_events(id,actor_id,subject_id,action,entity_id,details_json,created_at) VALUES(?,?,?,?,?,?,?)', crypto.randomUUID(), actor.accountId, subject, action, entity, stable(details), ctx.now()));
}
async function listUsers(params: URLSearchParams, ctx: AppContext, actor: Actor): Promise<Response> {
    const filter = filters(params), cursor = readCursor(params.get('cursor'), filter);
    return ok((await ctx.db.transaction(async () => {
        (await requireOperator(ctx, actor));
        const where: string[] = [], values: (string | number)[] = [];
        if (filter.status === 'deleted')
            where.push('a.disabled_at IS NOT NULL');
        if (filter.status === 'registered' || filter.status === 'anonymous') {
            where.push('a.disabled_at IS NULL AND a.identity_state=?');
            values.push(filter.status === 'registered' ? 'registered_face' : 'anonymous');
        }
        if (filter.q) {
            // Keep the existing case-insensitive literal substring contract.
            // PostgreSQL LIKE is case-sensitive; SQLite LIKE was not.
            const pattern = '%' + filter.q.replace(/[\\%_]/g, value => '\\' + value) + '%';
            where.push("(a.id ILIKE ? ESCAPE '\\' OR (a.disabled_at IS NULL AND a.name ILIKE ? ESCAPE '\\'))");
            values.push(pattern, pattern);
        }
        if (cursor) {
            where.push('(a.created_at<? OR (a.created_at=? AND a.id>?))');
            values.push(cursor.created_at, cursor.created_at, cursor.id);
        }
        const rows = (await ctx.db.all<Account>(`${clockSql} SELECT ${summaryFields} FROM accounts a CROSS JOIN clock
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.created_at DESC,a.id LIMIT ?`, ...clockValues(ctx), ...values, filter.limit + 1));
        const hasMore = rows.length > filter.limit, page = rows.slice(0, filter.limit), last = page.at(-1);
        const next = hasMore && last ? base64url(new TextEncoder().encode(stable({ ...filter, id: last.id, created_at: last.created_at }))) : null;
        // Search text may itself contain personal information; never put it in audit.
        (await audit(ctx, actor, 'admin.users.list', null, null, { returned: page.length }));
        return { users: page.map(summary), page: { limit: filter.limit, has_more: hasMore, next_cursor: next } };
    })));
}
async function userDetail(id: string, ctx: AppContext, actor: Actor): Promise<Response> {
    return ok((await ctx.db.transaction(async () => {
        (await requireOperator(ctx, actor));
        const account = (await ctx.db.one<Account>(`${clockSql} SELECT ${summaryFields} FROM accounts a CROSS JOIN clock WHERE a.id=?`, ...clockValues(ctx), id));
        if (!account)
            throw new ApiError(404, 'account_not_found');
        const sessions = (await ctx.db.all(`${clockSql} SELECT s.id,s.auth_method,s.created_at,s.expires_at,
      CASE WHEN s.revoked_at IS NOT NULL OR s.refresh_consumed_at IS NOT NULL THEN 'revoked'
        WHEN s.refresh_expires_at<=clock.now THEN 'expired'
        WHEN NOT (${sessionAuthority}) THEN 'revoked'
        WHEN s.expires_at>clock.now THEN 'active' ELSE 'refreshable' END status
      FROM sessions s JOIN accounts a ON a.id=s.account_id CROSS JOIN clock WHERE a.id=?
      ORDER BY s.created_at DESC,s.id LIMIT ?`, ...clockValues(ctx), id, limits.sessions + 1));
        const support = (await ctx.db.all(`SELECT id,subject,status,category,created_at,updated_at FROM support_requests
      WHERE account_id=? ORDER BY created_at DESC,id LIMIT ?`, id, limits.cases_per_kind + 1));
        const safety = (await ctx.db.all(`SELECT id,status,outcome,created_at,reviewed_at,
      CASE WHEN reporter_id=? AND subject_id=? THEN 'reporter_and_subject'
        WHEN reporter_id=? THEN 'reporter' ELSE 'subject' END relation
      FROM safety_reports WHERE reporter_id=? OR subject_id=? ORDER BY created_at DESC,id LIMIT ?`, id, id, id, id, id, limits.cases_per_kind + 1));
        const privacy = (await ctx.db.all(`SELECT id,request_type,status,created_at,reviewed_at,completed_at,failure_code
      FROM privacy_requests WHERE subject_id=? ORDER BY created_at DESC,id LIMIT ?`, id, limits.cases_per_kind + 1));
        const history = (await ctx.db.all(`SELECT id,action,created_at FROM audit_events
      WHERE actor_id=? OR subject_id=? OR entity_id IN (
        SELECT id FROM support_requests WHERE account_id=? UNION ALL
        SELECT id FROM safety_reports WHERE reporter_id=? OR subject_id=? UNION ALL
        SELECT id FROM privacy_requests WHERE subject_id=? UNION ALL
        SELECT id FROM sessions WHERE account_id=?) ORDER BY created_at DESC,id LIMIT ?`, id, id, id, id, id, id, id, limits.history + 1));
        (await audit(ctx, actor, 'admin.user.read', id, id));
        return { user: summary(account), sessions: sessions.slice(0, limits.sessions),
            cases: { support: support.slice(0, limits.cases_per_kind), safety: safety.slice(0, limits.cases_per_kind), privacy: privacy.slice(0, limits.cases_per_kind) },
            history: history.slice(0, limits.history), limits,
            has_more: { sessions: sessions.length > limits.sessions, support: support.length > limits.cases_per_kind,
                safety: safety.length > limits.cases_per_kind, privacy: privacy.length > limits.cases_per_kind, history: history.length > limits.history } };
    })));
}
async function requireFreshFace(ctx: AppContext, actor: Actor): Promise<void> {
    (await requireOperator(ctx, actor));
    // Refresh rotates created_at without comparing a face. Require a completed
    // login challenge overlapping this session's issuance and exact authority.
    // An older session cannot borrow another session's later face verification.
    const proof = (await ctx.db.one(`SELECT c.id FROM auth_challenges c JOIN sessions s ON s.id=?
    WHERE c.account_id=s.account_id AND c.device_id=s.device_id AND c.device_revision=s.device_revision
      AND c.profile_revision=s.face_profile_revision AND c.profile_auth_epoch=s.face_profile_epoch
      AND c.auth_epoch=s.auth_epoch AND c.consent_id=s.face_consent_id
      AND c.purpose='login' AND c.status='used' AND c.used_at>=? AND c.used_at<=?
      AND c.created_at<=s.created_at AND c.used_at>=s.created_at LIMIT 1`, actor.sessionId, ctx.now() - 300000, ctx.now()));
    if (!proof)
        throw new ApiError(403, 'fresh_face_authentication_required');
}
async function manageableAccount(ctx: AppContext, actor: Actor, id: string): Promise<void> {
    const target = (await ctx.db.one<{
        disabled_at: number | null;
        roles_json: string;
    }>('SELECT disabled_at,roles_json FROM accounts WHERE id=?', id));
    if (!target)
        throw new ApiError(404, 'account_not_found');
    if (target.disabled_at !== null)
        throw new ApiError(409, 'account_deleted');
    if (accountRoles(target.roles_json).includes('admin')) {
        const count = (await ctx.db.one<{
            n: number;
        }>(`SELECT count(*) n FROM accounts a WHERE a.disabled_at IS NULL
      AND a.identity_state='registered_face' AND EXISTS(SELECT 1 FROM json_each(a.roles_json) role WHERE role.value='admin')`))!.n;
        if (count <= 1)
            throw new ApiError(409, 'last_admin_protected');
    }
    if (id === actor.accountId)
        throw new ApiError(403, 'self_management_forbidden');
}
async function revokeSession(request: Request, id: string, ctx: AppContext, actor: Actor): Promise<Response> {
    (await requireFreshFace(ctx, actor));
    const body = await jsonBody(request, 4096);
    if (Object.keys(body).some(key => !['session_id', 'reason', 'operation_key'].includes(key)) ||
        typeof body.reason !== 'string' || body.reason.trim().length < 3 || body.reason.trim().length > 1000 ||
        /[\u0000-\u001f\u007f]/.test(body.reason))
        throw new ApiError(400, 'review_reason_required');
    const sessionId = uuid(body.session_id), reason = body.reason.trim();
    const intent = await prepareOperation('admin.user.session.revoke', { account_id: id, session_id: sessionId, reason, operation_key: body.operation_key }, 'admin_users');
    return ok((await ctx.db.transaction(async () => {
        // These guards also run for an idempotent replay, before executeOperation
        // can return its stored receipt. Deletion/demotion never restores authority.
        (await requireFreshFace(ctx, actor));
        (await manageableAccount(ctx, actor, id));
        return (await executeOperation(ctx, actor, intent, async () => {
            const session = (await ctx.db.one<{
                revoked_at: number | null;
                device_id: string | null;
            }>('SELECT revoked_at,device_id FROM sessions WHERE id=? AND account_id=?', sessionId, id));
            if (!session)
                throw new ApiError(404, 'session_not_found');
            const changed = session.revoked_at === null;
            if (changed) {
                (await cancelDeviceLifecycle(id, session.device_id, ctx));
                (await ctx.db.run('UPDATE sessions SET revoked_at=?,refresh_consumed_at=coalesce(refresh_consumed_at,?) WHERE id=? AND account_id=?', ctx.now(), ctx.now(), sessionId, id));
                (await ctx.db.run("UPDATE auth_challenges SET status='cancelled',used_at=coalesce(used_at,?) WHERE account_id=? AND session_id=? AND used_at IS NULL", ctx.now(), id, sessionId));
            }
            (await audit(ctx, actor, 'admin.user.session.revoke', id, sessionId, { reason, sessions_revoked: changed ? 1 : 0 }));
            return { account_id: id, session_id: sessionId, status: 'revoked', sessions_revoked: changed ? 1 : 0, account_disabled: false };
        }, [id]));
    })));
}
export async function handleAdminUsers(request: Request, ctx: AppContext): Promise<Response | null> {
    const url = new URL(request.url), path = url.pathname;
    if (path !== '/admin/users' && !path.startsWith('/admin/users/'))
        return null;
    const actor = await ctx.authenticate(request);
    (await requireOperator(ctx, actor));
    if (path === '/admin/users') {
        if (request.method !== 'GET')
            throw new ApiError(405, 'method_not_allowed');
        return (await listUsers(url.searchParams, ctx, actor));
    }
    const detail = /^\/admin\/users\/([0-9a-f-]{36})$/i.exec(path);
    const revoke = /^\/admin\/users\/([0-9a-f-]{36})\/sessions\/revoke$/i.exec(path);
    if (!detail && !revoke)
        throw new ApiError(404, 'route_not_found');
    if (url.search)
        throw new ApiError(400, 'invalid_input');
    if (detail) {
        if (request.method !== 'GET')
            throw new ApiError(405, 'method_not_allowed');
        return (await userDetail(uuid(detail[1]), ctx, actor));
    }
    if (request.method !== 'POST')
        throw new ApiError(405, 'method_not_allowed');
    return (await revokeSession(request, uuid(revoke![1]), ctx, actor));
}
