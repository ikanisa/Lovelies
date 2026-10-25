import { ApiError, digest, jsonBody, ok, stable, uuid, type Actor, type AppContext, type Database } from './types.ts';
import { assertRegisteredActor, executeOperation, prepareOperation } from './operations.ts';
import { currentAsset, currentPair, protectedRendition } from './gallery.ts';
import { enqueueNotification } from './notifications.ts';
// Retired photographer rows remain only for existing-schema compatibility and
// subject export/erasure. No route can create, approve or activate this role.
export const operatorsSchemaStatements: readonly string[] = [
    `CREATE TABLE IF NOT EXISTS support_requests(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),subject TEXT NOT NULL,details TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('open','under_review','resolved','closed')),category TEXT NOT NULL DEFAULT 'general_support',assigned_to TEXT REFERENCES accounts(id),sla_due_at INTEGER,review_outcome TEXT,review_notes TEXT,reviewed_by TEXT REFERENCES accounts(id),reviewed_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS safety_reports(id TEXT PRIMARY KEY,reporter_id TEXT NOT NULL REFERENCES accounts(id),subject_id TEXT REFERENCES accounts(id),asset_id TEXT REFERENCES assets(id),candidate_id TEXT REFERENCES candidates(id),reason TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('open','under_review','resolved','rejected')),outcome TEXT,reviewed_by TEXT REFERENCES accounts(id),reviewed_at INTEGER,review_notes TEXT,created_at INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS moderation_holds(id TEXT PRIMARY KEY,subject_id TEXT REFERENCES accounts(id),asset_id TEXT REFERENCES assets(id),report_id TEXT REFERENCES safety_reports(id),active INTEGER NOT NULL CHECK(active IN(0,1)),created_at INTEGER NOT NULL,cleared_at INTEGER,reason TEXT NOT NULL,CHECK(subject_id IS NOT NULL OR asset_id IS NOT NULL))`,
    `CREATE INDEX IF NOT EXISTS support_account ON support_requests(account_id,created_at)`,
    `CREATE INDEX IF NOT EXISTS safety_status ON safety_reports(status,created_at)`,
];
export async function initOperatorsSchema(db: Database): Promise<void> { for (const statement of operatorsSchemaStatements)
    (await db.run(statement)); }
export async function requireOperator(ctx: AppContext, actor: Actor, fresh = false): Promise<void> {
    (await assertRegisteredActor(ctx, actor));
    if (!actor.roles.includes('admin'))
        throw new ApiError(403, 'admin_required');
    if (fresh) {
        // Refresh changes session creation time without another face comparison.
        // Only an actual completed login bound to this exact session can satisfy
        // fresh operator review; another device's recent login cannot be borrowed.
        const proof = await ctx.db.one(`SELECT c.id FROM auth_challenges c JOIN sessions s ON s.id=?
          WHERE c.account_id=s.account_id AND c.device_id=s.device_id AND c.device_revision=s.device_revision
          AND c.profile_revision=s.face_profile_revision AND c.profile_auth_epoch=s.face_profile_epoch
          AND c.auth_epoch=s.auth_epoch AND c.consent_id=s.face_consent_id
          AND c.purpose='login' AND c.status='used' AND c.used_at>=? AND c.used_at<=?
          AND c.created_at<=s.created_at AND c.used_at>=s.created_at LIMIT 1`,actor.sessionId,ctx.now()-300000,ctx.now());
        if (!proof) throw new ApiError(403, 'fresh_face_authentication_required');
    }
}
function text(value: unknown, max: number, min = 0): string | null {
    if (value == null)
        return null;
    if (typeof value !== 'string' || value.trim().length > max || value.trim().length < min || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))
        throw new ApiError(400, 'invalid_input');
    return value.trim() || null;
}
function exact(body: Record<string, unknown>, keys: string[]): void { if (Object.keys(body).some(key => !keys.includes(key)))
    throw new ApiError(400, 'invalid_input'); }
async function audit(ctx: AppContext, actor: Actor, action: string, id: string, details: Record<string, unknown> = {}): Promise<void> {
    (await ctx.db.run('INSERT INTO audit_events(id,actor_id,action,entity_id,details_json,created_at) VALUES(?,?,?,?,?,?)', crypto.randomUUID(), actor.accountId, action, id, stable(details), ctx.now()));
}
async function revokePair(ctx: AppContext, owner: string, recipient: string, asset?: string): Promise<void> {
    (await ctx.db.run('UPDATE media_grants SET active=0,revoked_at=coalesce(revoked_at,?) WHERE owner_id=? AND recipient_id=?' + (asset ? ' AND asset_id=?' : ''), ctx.now(), owner, recipient, ...(asset ? [asset] : [])));
    // The immutable multi-photo request remains valid for its unaffected approvals.
    // Pair eligibility and its grant are revoked separately; never rewrite a manifest.
    (await ctx.db.run("UPDATE sharing_requests SET status='revoked',updated_at=? WHERE sender_id=? AND recipient_id=? AND status IN('requested','accepted')" + (asset ? ' AND json_array_length(asset_ids_json)=1 AND EXISTS(SELECT 1 FROM json_each(asset_ids_json) x WHERE x.value=?)' : ''), ctx.now(), owner, recipient, ...(asset ? [asset] : [])));
}
export async function mediaHeld(ctx: AppContext, accountId: string, assetId: string): Promise<boolean> {
    return !!(await ctx.db.one('SELECT id FROM moderation_holds WHERE active=1 AND (subject_id=? OR asset_id=?) LIMIT 1', accountId, assetId));
}
async function support(request: Request, ctx: AppContext, actor: Actor, path: string): Promise<Response> {
    const own = /^\/support\/requests\/([0-9a-f-]{36})$/i.exec(path), admin = /^\/admin\/support-requests\/([0-9a-f-]{36})\/(start|approve|reject|close)$/i.exec(path);
    if (request.method === 'GET')
        return ok((await ctx.db.transaction(async () => {
            (await assertRegisteredActor(ctx, actor));
            if (own) {
                const row = (await ctx.db.one('SELECT id,subject,status,category,review_outcome,review_notes,revision,created_at,updated_at FROM support_requests WHERE id=? AND account_id=?', uuid(own[1]), actor.accountId));
                if (!row)
                    throw new ApiError(404, 'support_request_not_found');
                return { support_request: row };
            }
            if (path === '/support/requests')
                return { support_requests: (await ctx.db.all('SELECT id,subject,status,category,review_outcome,review_notes,revision,created_at,updated_at FROM support_requests WHERE account_id=? ORDER BY created_at DESC,id LIMIT 100', actor.accountId)) };
            (await requireOperator(ctx, actor));
            (await audit(ctx, actor, 'support.admin_list', actor.accountId));
            return { support_requests: (await ctx.db.all('SELECT * FROM support_requests ORDER BY created_at DESC,id LIMIT 100')) };
        })));
    if (request.method !== 'POST')
        throw new ApiError(405, 'method_not_allowed');
    const body = await jsonBody(request, 16384);
    if (admin) {
        (await requireOperator(ctx, actor));
        exact(body, ['review_notes', 'sla_due_at', 'expected_revision', 'operation_key']);
        const notes = text(body.review_notes, 4000), intent = await prepareOperation('support.' + admin[2], { ...body, request_id: uuid(admin[1]) }, 'support');
        return ok((await executeOperation(ctx, actor, intent, async () => {
            (await requireOperator(ctx, actor));
            const row = (await ctx.db.one<any>('SELECT * FROM support_requests WHERE id=?', uuid(admin[1])));
            if (!row)
                throw new ApiError(404, 'support_request_not_found');
            if (body.expected_revision !== row.revision)
                throw new ApiError(409, 'support_revision_changed');
            if (['resolved', 'closed'].includes(row.status))
                throw new ApiError(409, 'support_already_reviewed');
            const start = admin[2] === 'start', due = body.sla_due_at == null ? ctx.now() + 172800000 : Date.parse(body.sla_due_at);
            if (!Number.isFinite(due) || due < ctx.now())
                throw new ApiError(400, 'invalid_sla');
            (await ctx.db.run('UPDATE support_requests SET status=?,assigned_to=?,sla_due_at=?,review_outcome=?,review_notes=?,reviewed_by=?,reviewed_at=?,updated_at=?,revision=revision+1 WHERE id=?', start ? 'under_review' : admin[2] === 'close' ? 'closed' : 'resolved', actor.accountId, due, start ? null : admin[2] === 'approve' ? 'approved' : admin[2] === 'reject' ? 'rejected' : null, notes, start ? null : actor.accountId, start ? null : ctx.now(), ctx.now(), row.id));
            (await audit(ctx, actor, 'support.' + admin[2], row.id));
            if (!start)
                (await enqueueNotification(ctx, row.account_id, 'support', row.id, 'Your support request was reviewed'));
            return { support_request: (await ctx.db.one('SELECT * FROM support_requests WHERE id=?', row.id)) };
        }, [String((await ctx.db.one<any>('SELECT account_id FROM support_requests WHERE id=?', uuid(admin[1])))?.account_id ?? actor.accountId)])));
    }
    exact(body, ['subject', 'details', 'operation_key']);
    const subject = text(body.subject, 160, 3), details = text(body.details, 4000, 5);
    if (!subject || !details)
        throw new ApiError(400, 'invalid_support_request');
    const intent = await prepareOperation('support.create', body, 'support');
    return ok((await executeOperation(ctx, actor, intent, async () => { const id = crypto.randomUUID(); (await ctx.db.run("INSERT INTO support_requests(id,account_id,subject,details,status,created_at,updated_at) VALUES(?,?,?,?,'open',?,?)", id, actor.accountId, subject, details, ctx.now(), ctx.now())); (await audit(ctx, actor, 'support.create', id)); return { id, status: 'open', revision: 1 }; })), 201);
}
async function safety(request: Request, ctx: AppContext, actor: Actor, path: string): Promise<Response> {
    const notMe = /^\/matches\/([0-9a-f-]{36})\/not-me$/i.exec(path);
    const block = /^\/me\/blocks\/([0-9a-f-]{36})$/i.exec(path);
    const detail = /^\/admin\/matches\/([0-9a-f-]{36})$/i.exec(path);
    const review = /^\/(?:admin\/matches\/([0-9a-f-]{36})\/resolve|matches\/([0-9a-f-]{36})\/review)$/i.exec(path);
    const reportReview = /^\/admin\/safety\/reports\/([0-9a-f-]{36})\/resolve$/i.exec(path);
    if (request.method === 'GET')
        return ok((await ctx.db.transaction(async () => {
            (await assertRegisteredActor(ctx, actor));
            if (path === '/me/blocks')
                return { items: (await ctx.db.all('SELECT blocked_id,created_at FROM blocks WHERE blocker_id=? ORDER BY created_at DESC LIMIT 100', actor.accountId)) };
            (await requireOperator(ctx, actor));
            if (detail) {
                const row = (await ctx.db.one('SELECT * FROM candidates WHERE id=?', uuid(detail[1])));
                if (!row)
                    throw new ApiError(404, 'match_not_found');
                return { match: row, reports: (await ctx.db.all('SELECT * FROM safety_reports WHERE candidate_id=? ORDER BY created_at DESC LIMIT 100', uuid(detail[1]))) };
            }
            return { reports: (await ctx.db.all('SELECT * FROM safety_reports ORDER BY created_at DESC,id LIMIT 100')), matches: (await ctx.db.all("SELECT id,asset_id,owner_id,recipient_id,status,version FROM candidates WHERE status<>'eligible' ORDER BY created_at DESC,id LIMIT 100")) };
        })));
    if (!['POST', 'DELETE'].includes(request.method))
        throw new ApiError(405, 'method_not_allowed');
    const body = await jsonBody(request, 16384);
    if (reportReview) {
        if (request.method !== 'POST')
            throw new ApiError(405, 'method_not_allowed');
        (await requireOperator(ctx, actor, true));
        exact(body, ['action', 'expected_revision', 'reason', 'operation_key']);
        if (!['hold', 'release', 'resolve', 'reject'].includes(String(body.action)))
            throw new ApiError(400, 'invalid_report_action');
        const id = uuid(reportReview[1]), rationale = text(body.reason, 4000, 3);
        if (!rationale)
            throw new ApiError(400, 'review_reason_required');
        const intent = await prepareOperation('safety.review', { ...body, report_id: id }, 'moderation');
        return ok((await executeOperation(ctx, actor, intent, async () => {
            (await requireOperator(ctx, actor, true));
            const row = (await ctx.db.one<any>('SELECT * FROM safety_reports WHERE id=?', id));
            if (!row)
                throw new ApiError(404, 'report_not_found');
            if (row.reporter_id === actor.accountId)
                throw new ApiError(403, 'independent_review_required');
            if (body.expected_revision !== row.revision)
                throw new ApiError(409, 'report_revision_changed');
            if (body.action === 'hold') {
                if (!row.asset_id && !row.subject_id)
                    throw new ApiError(409, 'report_subject_erased');
                if ((await ctx.db.one("SELECT id FROM retention_jobs WHERE status='processing' AND lease_until>? AND (asset_id=? OR subject_id=?) LIMIT 1", ctx.now(), row.asset_id, row.subject_id)))
                    throw new ApiError(409, 'retention_cleanup_in_progress');
                if (row.asset_id) {
                    if (!(await currentAsset(ctx, row.asset_id)))
                        throw new ApiError(409, 'report_subject_erased');
                    (await ctx.db.run('UPDATE media_grants SET active=0,revoked_at=coalesce(revoked_at,?) WHERE asset_id=?', ctx.now(), row.asset_id));
                    (await ctx.db.run("UPDATE candidates SET status='needs_review',version=? WHERE asset_id=? AND status='eligible'", crypto.randomUUID(), row.asset_id));
                }
                else {
                    (await ctx.db.run('UPDATE media_grants SET active=0,revoked_at=coalesce(revoked_at,?) WHERE owner_id=? OR recipient_id=?', ctx.now(), row.subject_id, row.subject_id));
                    (await ctx.db.run("UPDATE candidates SET status='needs_review',version=? WHERE (owner_id=? OR recipient_id=?) AND status='eligible'", crypto.randomUUID(), row.subject_id, row.subject_id));
                }
                // Asset reports hold the specific asset; a subject-only report holds that account.
                (await ctx.db.run('INSERT INTO moderation_holds(id,subject_id,asset_id,report_id,active,created_at,reason) VALUES(?,?,?,?,1,?,?)', crypto.randomUUID(), row.asset_id ? null : row.subject_id, row.asset_id, id, ctx.now(), rationale));
            }
            else if (body.action === 'release')
                (await ctx.db.run('UPDATE moderation_holds SET active=0,cleared_at=? WHERE report_id=? AND active=1', ctx.now(), id));
            const status = body.action === 'hold' ? 'under_review' : body.action === 'reject' ? 'rejected' : 'resolved';
            (await ctx.db.run('UPDATE safety_reports SET status=?,outcome=?,reviewed_by=?,reviewed_at=?,review_notes=?,revision=revision+1 WHERE id=?', status, body.action, actor.accountId, ctx.now(), rationale, id));
            (await audit(ctx, actor, 'safety.review.' + body.action, id, { reason: rationale }));
            return { report_id: id, status, revision: row.revision + 1, access_restored: false, grants_created: 0 };
        })));
    }
    if (block) {
        exact(body, ['operation_key']);
        const target = uuid(block[1]);
        if (target === actor.accountId)
            throw new ApiError(400, 'self_block_invalid');
        const intent = await prepareOperation('safety.block.' + request.method, { ...body, subject_id: target }, 'safety');
        return ok((await executeOperation(ctx, actor, intent, async () => {
            if (!(await ctx.db.one('SELECT id FROM accounts WHERE id=? AND disabled_at IS NULL', target)))
                throw new ApiError(404, 'subject_not_found');
            if (request.method === 'DELETE')
                (await ctx.db.run('DELETE FROM blocks WHERE blocker_id=? AND blocked_id=?', actor.accountId, target));
            else {
                (await ctx.db.run('INSERT OR IGNORE INTO blocks(blocker_id,blocked_id,created_at) VALUES(?,?,?)', actor.accountId, target, ctx.now()));
                (await revokePair(ctx, actor.accountId, target));
                (await revokePair(ctx, target, actor.accountId));
                (await ctx.db.run("UPDATE candidates SET status='blocked' WHERE (owner_id=? AND recipient_id=?) OR (owner_id=? AND recipient_id=?)", actor.accountId, target, target, actor.accountId));
            }
            (await audit(ctx, actor, 'safety.block.' + request.method, target));
            return { blocked: request.method !== 'DELETE', subject_id: target, access_restored: false };
        }, [target])));
    }
    if (review) {
        (await requireOperator(ctx, actor, true));
        const id = uuid(review[1] ?? review[2]);
        exact(body, ['action', 'expected_revision', 'reason', 'operation_key']);
        if (!['approve', 'reject', 'escalate', 'delete', 'audit'].includes(String(body.action)))
            throw new ApiError(400, 'invalid_review_action');
        const rationale = text(body.reason, 4096), intent = await prepareOperation('match.review', { ...body, match_id: id }, 'moderation');
        return ok((await executeOperation(ctx, actor, intent, async () => {
            (await requireOperator(ctx, actor, true));
            const row = (await ctx.db.one<any>('SELECT * FROM candidates WHERE id=?', id));
            if (!row)
                throw new ApiError(404, 'match_not_found');
            if (body.expected_revision !== row.version)
                throw new ApiError(409, 'match_revision_changed');
            // Operator approval does not create a recipient grant or invent a model
            // tuple. A fresh processing run is required after a rejected proposal.
            if (body.action === 'approve') {
                if (!['eligible', 'needs_review'].includes(row.status))
                    throw new ApiError(409, 'fresh_verified_origin_required');
                // Temporary eligibility is evaluated inside this transaction against the
                // complete immutable origin chain; failure rolls this update back.
                (await ctx.db.run("UPDATE candidates SET status='eligible' WHERE id=?", id));
                if (!(await currentPair(ctx, row.owner_id, row.asset_id, row.recipient_id)))
                    throw new ApiError(409, 'fresh_verified_origin_required');
            }
            const status = body.action === 'audit' ? row.status : body.action === 'approve' ? 'eligible' : body.action === 'reject' ? 'rejected' : body.action === 'escalate' ? 'needs_review' : 'deleted';
            if (body.action !== 'audit') {
                (await ctx.db.run('UPDATE candidates SET status=?,version=? WHERE id=?', status, crypto.randomUUID(), id));
                if (status !== 'eligible')
                    (await revokePair(ctx, row.owner_id, row.recipient_id, row.asset_id));
            }
            (await audit(ctx, actor, 'match.review.' + body.action, id, { reason: rationale }));
            return { protocol: 'match-review-v1', outcome: 'applied', match_id: id, action: body.action, status, reviewed_by: actor.accountId, reviewed_at: new Date(ctx.now()).toISOString(), expected_revision: body.expected_revision, grants_created: 0 };
        })));
    }
    exact(body, ['subject_id', 'asset_id', 'reason', 'operation_key']);
    const candidate = notMe ? (await ctx.db.one<any>('SELECT * FROM candidates WHERE id=?', uuid(notMe[1]))) : null;
    if (notMe && (!candidate || candidate.recipient_id !== actor.accountId))
        throw new ApiError(403, 'match_not_owned');
    const asset = notMe ? candidate.asset_id : body.asset_id == null ? null : uuid(body.asset_id), target = notMe ? candidate.owner_id : body.subject_id == null ? null : uuid(body.subject_id), rationale = text(body.reason, 4000, 3);
    if (!rationale)
        throw new ApiError(400, 'report_reason_required');
    const intent = await prepareOperation(notMe ? 'safety.not_me' : 'safety.report', { ...body, ...(notMe ? { match_id: candidate.id } : {}) }, 'safety');
    return ok((await executeOperation(ctx, actor, intent, async () => {
        if (asset)
            (await protectedRendition(ctx, actor, asset));
        if (target && !(await ctx.db.one('SELECT id FROM accounts WHERE id=? AND disabled_at IS NULL', target)))
            throw new ApiError(404, 'subject_not_found');
        if (notMe) {
            (await ctx.db.run("UPDATE candidates SET status='not_me',version=? WHERE id=? AND recipient_id=?", crypto.randomUUID(), candidate.id, actor.accountId));
            (await revokePair(ctx, candidate.owner_id, actor.accountId, candidate.asset_id));
        }
        const id = crypto.randomUUID();
        (await ctx.db.run("INSERT INTO safety_reports(id,reporter_id,subject_id,asset_id,candidate_id,reason,status,created_at) VALUES(?,?,?,?,?,?,'open',?)", id, actor.accountId, target, asset, candidate?.id ?? null, rationale, ctx.now()));
        (await audit(ctx, actor, notMe ? 'safety.not_me' : 'safety.report', id));
        return { id, status: 'open', ...(notMe ? { match_id: candidate.id, removed_photo_count: 1, related_photo_count: 0, cluster_cleanup: false } : {}), grants_created: 0 };
    }, target ? [target] : [])), 201);
}
export async function handleOperators(request: Request, ctx: AppContext): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    const isSupport = path === '/support/requests' || /^\/(support\/requests|admin\/support-requests)(\/|$)/.test(path);
    const isSafety = path === '/safety/reports' || path === '/me/blocks' || /^\/me\/blocks\//.test(path) || /^\/matches\/[^/]+\/(not-me|review)$/.test(path) || /^\/admin\/matches\//.test(path) || /^\/admin\/safety\/reports(?:\/|$)/.test(path);
    const adminMetrics = path === '/admin/metrics' || path === '/admin/uploads';
    if (!isSupport && !isSafety && !adminMetrics)
        return null;
    const actor = await ctx.authenticate(request);
    (await assertRegisteredActor(ctx, actor));
    if (adminMetrics) {
        (await requireOperator(ctx, actor));
        if (request.method !== 'GET')
            throw new ApiError(405, 'method_not_allowed');
        return ok((await ctx.db.transaction(async () => { (await requireOperator(ctx, actor)); return path === '/admin/uploads' ? { uploads: (await ctx.db.all("SELECT id,owner_id,source,batch_id,status,title,created_at FROM assets WHERE source='personal' AND deleted_at IS NULL ORDER BY created_at DESC,id LIMIT 100")) } : { accounts: (await ctx.db.one('SELECT count(*) n FROM accounts WHERE disabled_at IS NULL'))!.n, uploads: (await ctx.db.one("SELECT count(*) n FROM assets WHERE source='personal' AND deleted_at IS NULL"))!.n, active_grants: (await ctx.db.one("SELECT count(*) n FROM media_grants g JOIN assets a ON a.id=g.asset_id WHERE g.active=1 AND a.source='personal' AND a.deleted_at IS NULL"))!.n, open_support: (await ctx.db.one("SELECT count(*) n FROM support_requests WHERE status IN('open','under_review')"))!.n, open_reports: (await ctx.db.one("SELECT count(*) n FROM safety_reports WHERE status IN('open','under_review')"))!.n }; })));
    }
    if (isSupport)
        return (await support(request, ctx, actor, path));
    if (isSafety)
        return (await safety(request, ctx, actor, path));
    return null;
}
// Historical request data is still included until subject erasure; it is not
// a supported feature and cannot restore role or media authority.
export async function operatorPrivacyRows(ctx: AppContext, subject: string): Promise<Record<string, unknown>> {
    const rows = { support_requests: (await ctx.db.all('SELECT id,subject,details,status,created_at,updated_at,review_outcome,review_notes FROM support_requests WHERE account_id=? ORDER BY created_at,id LIMIT 25001', subject)), own_reports: (await ctx.db.all('SELECT id,reason,status,outcome,created_at,reviewed_at FROM safety_reports WHERE reporter_id=? ORDER BY created_at,id LIMIT 25001', subject)) };
    if (Object.values(rows).some(items => items.length > 25000))
        throw new ApiError(413, 'privacy_export_too_large');
    return rows;
}
export async function eraseOperatorSubject(db: Database, subject: string, now: number): Promise<void> {
    (await db.run('DELETE FROM support_requests WHERE account_id=?', subject));
    (await db.run("UPDATE safety_reports SET reason='Erased personal content',review_notes=NULL WHERE reporter_id=? OR subject_id=? OR asset_id IN(SELECT id FROM assets WHERE owner_id=?) OR candidate_id IN(SELECT id FROM candidates WHERE owner_id=? OR recipient_id=?)", subject, subject, subject, subject, subject));
    (await db.run('UPDATE safety_reports SET candidate_id=NULL WHERE candidate_id IN(SELECT id FROM candidates WHERE owner_id=? OR recipient_id=?)', subject, subject));
    (await db.run('UPDATE safety_reports SET asset_id=NULL WHERE asset_id IN(SELECT id FROM assets WHERE owner_id=?)', subject));
    // Delete asset holds before deleting assets. Clearing just the asset column
    // would violate a subject-or-asset CHECK for specific-asset holds.
    (await db.run('DELETE FROM moderation_holds WHERE asset_id IN(SELECT id FROM assets WHERE owner_id=?)', subject));
    (await db.run('UPDATE moderation_holds SET active=0,cleared_at=?,reason=? WHERE subject_id=?', now, 'Erased subject', subject));
}
