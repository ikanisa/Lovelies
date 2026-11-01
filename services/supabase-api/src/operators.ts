import { handleQueueRepair, handleQueueRepairCollection } from './queue-repair.ts';
import { photoRecoveryDiagnostics } from './operator-recovery.ts';
import { ApiError, digest, jsonBody, ok, stable, uuid, type Actor, type AppContext, type Database } from './types.ts';
import { assertRegisteredActor, executeOperation, prepareOperation } from './operations.ts';
import { currentAsset, currentPair, protectedRendition } from './gallery.ts';
import { enqueueNotification } from './notifications.ts';
import { parseAdminPage, readAdminPage } from './admin-pagination.ts';
import { assertOperatorCapability, operatorCapabilities, type OperatorCapability } from './operator-capabilities.ts';
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
export async function requireOperator(ctx: AppContext, actor: Actor, fresh = false, capability?: OperatorCapability): Promise<void> {
    (await assertRegisteredActor(ctx, actor));
    if (capability) await assertOperatorCapability(ctx, actor, capability);
    else if (!actor.roles.includes('admin')) throw new ApiError(403, 'admin_required');
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
/** A read can outlive its grant while queries, audits or the transaction finish.
 * Recheck one current capability snapshot before releasing its private result.
 * The synchronous projection may only remove secondary sections. */
export async function readOperator<T>(ctx: AppContext, actor: Actor, capability: OperatorCapability,
    read: () => Promise<T>, project: (value: T, capabilities: readonly OperatorCapability[]) => T = value => value): Promise<T> {
    const release = async (value: T): Promise<T> => {
        await assertRegisteredActor(ctx, actor);
        const capabilities = await operatorCapabilities(ctx, actor.accountId);
        if (!capabilities.includes(capability)) throw new ApiError(403, 'operator_capability_required');
        if (actor.expiresAt <= ctx.now()) throw new ApiError(401, 'session_invalid');
        return project(value, capabilities);
    };
    const value = await ctx.db.transaction(async () => {
        await requireOperator(ctx, actor, false, capability);
        return release(await read());
    });
    return ctx.db.read(() => release(value));
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
const supportStatuses = ['open', 'under_review', 'resolved', 'closed'] as const;
async function supportList(request: Request, ctx: AppContext, accountId?: string) {
    const page = parseAdminPage(new URL(request.url), { scope: accountId ? 'support.own.' + accountId : 'support.admin', statuses: supportStatuses });
    const result = await readAdminPage(ctx.db, page, {
        select: accountId ? 'id,subject,status,category,review_outcome,review_notes,revision,created_at,updated_at' : '*',
        from: 'support_requests', where: accountId ? 'account_id=?' : '1=1', values: accountId ? [accountId] : [],
        priority: "CASE WHEN status IN('open','under_review') THEN 0 ELSE 1 END",
        statusColumn: 'status', searchColumns: accountId ? ['id', 'subject'] : ['id', 'account_id', 'subject'],
    });
    return { support_requests: result.items, page: result.page };
}

async function supportDetail(request: Request, ctx: AppContext, actor: Actor, id: string) {
    const supportRequest = await ctx.db.one<any>('SELECT * FROM support_requests WHERE id=?', id);
    if (!supportRequest) throw new ApiError(404, 'support_request_not_found');
    const page = parseAdminPage(new URL(request.url), { scope: 'support.history.' + id, statuses: [] });
    const result = await readAdminPage<any>(ctx.db, page, {
        select: 'o.actor_id,o.operation_key,o.action,o.payload_hash,o.payload_json,o.response_json,o.created_at',
        from: 'operations o',
        where: `o.source='support' AND ((o.action IN('support.start','support.approve','support.reject','support.close')
            AND json_extract(o.payload_json,'$.request_id')=?) OR (o.action='support.create' AND json_extract(o.response_json,'$.id')=?))`,
        values: [id, id], priority: '0', statusColumn: 'o.action', searchColumns: [],
        idColumn: "o.actor_id || ':' || o.operation_key",
        // Revisions provide case order even when several decisions share one
        // database-clock timestamp. Actual timestamps are still returned.
        createdAtColumn: "CAST(coalesce(CAST(o.response_json AS jsonb)->'support_request'->>'revision',CAST(o.response_json AS jsonb)->>'revision') AS BIGINT)",
    });
    const history = [];
    for (const receipt of result.items) {
        try {
            const input = JSON.parse(receipt.payload_json), output = JSON.parse(receipt.response_json);
            if (input.operation_key !== receipt.operation_key || receipt.payload_hash !== await digest(stable({ action: receipt.action, source: 'support', payload: input }))) throw new Error();
            const created = receipt.action === 'support.create';
            const row = created ? output : output.support_request;
            if (!row || row.id !== id || (!created && (row.account_id !== supportRequest.account_id || input.request_id !== id ||
                !Number.isSafeInteger(input.expected_revision) || row.revision !== input.expected_revision + 1)) ||
                (created && receipt.actor_id !== supportRequest.account_id) || !supportStatuses.includes(row.status) ||
                !Number.isSafeInteger(row.revision) || row.revision < 1 ||
                (row.review_notes != null && (typeof row.review_notes !== 'string' || row.review_notes.length > 4000))) throw new Error();
            history.push({ id: receipt.actor_id + ':' + receipt.operation_key, actor_id: receipt.actor_id,
                action: receipt.action, created_at: receipt.created_at, status: row.status,
                revision: row.revision, review_notes: row.review_notes ?? null, review_outcome: row.review_outcome ?? null });
        } catch { throw new ApiError(503, 'support_history_unavailable'); }
    }
    await audit(ctx, actor, 'support.admin_read', id, { returned_history: history.length });
    return { support_request: supportRequest, history, page: result.page,
        history_scope: 'retained_verified_operations', history_notice: 'History follows the existing operation retention and erasure policy. Retired receipts are not reconstructed.' };
}

async function support(request: Request, ctx: AppContext, actor: Actor, path: string): Promise<Response> {
    const own = /^\/support\/requests\/([0-9a-f-]{36})$/i.exec(path), admin = /^\/admin\/support-requests\/([0-9a-f-]{36})\/(start|approve|reject|close)$/i.exec(path);
    const adminRead = /^\/admin\/support-requests\/([0-9a-f-]{36})$/i.exec(path);
    if (request.method === 'GET') {
        if (own || path === '/support/requests') return ok((await ctx.db.transaction(async () => {
            (await assertRegisteredActor(ctx, actor));
            if (own) {
                const row = (await ctx.db.one('SELECT id,subject,status,category,review_outcome,review_notes,revision,created_at,updated_at FROM support_requests WHERE id=? AND account_id=?', uuid(own[1]), actor.accountId));
                if (!row)
                    throw new ApiError(404, 'support_request_not_found');
                return { support_request: row };
            }
            return await supportList(request, ctx, actor.accountId);
        })));
        return ok(await readOperator(ctx, actor, 'support.read', async () => {
            if (adminRead) return await supportDetail(request, ctx, actor, uuid(adminRead[1]));
            if (path !== '/admin/support-requests') throw new ApiError(404, 'route_not_found');
            (await audit(ctx, actor, 'support.admin_list', actor.accountId));
            return await supportList(request, ctx);
        }));
    }
    if (request.method !== 'POST')
        throw new ApiError(405, 'method_not_allowed');
    const body = await jsonBody(request, 16384);
    if (admin) {
        (await requireOperator(ctx, actor, false, 'support.review'));
        exact(body, ['review_notes', 'sla_due_at', 'expected_revision', 'operation_key']);
        const notes = text(body.review_notes, 4000), intent = await prepareOperation('support.' + admin[2], { ...body, request_id: uuid(admin[1]) }, 'support');
        return ok((await executeOperation(ctx, actor, intent, async () => {
            (await requireOperator(ctx, actor, false, 'support.review'));
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
    if (path !== '/support/requests') throw new ApiError(404, 'route_not_found');
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
    if (request.method === 'GET') {
        if (path === '/me/blocks') return ok((await ctx.db.transaction(async () => {
            (await assertRegisteredActor(ctx, actor));
            return { items: (await ctx.db.all('SELECT blocked_id,created_at FROM blocks WHERE blocker_id=? ORDER BY created_at DESC LIMIT 100', actor.accountId)) };
        })));
        return ok(await readOperator(ctx, actor, 'safety.read', async () => {
            if (detail) {
                const row = (await ctx.db.one('SELECT * FROM candidates WHERE id=?', uuid(detail[1])));
                if (!row)
                    throw new ApiError(404, 'match_not_found');
                return { match: row, reports: (await ctx.db.all('SELECT * FROM safety_reports WHERE candidate_id=? ORDER BY created_at DESC LIMIT 100', uuid(detail[1]))) };
            }
            if (path !== '/admin/safety/reports') throw new ApiError(404, 'route_not_found');
            const url = new URL(request.url), collection = url.searchParams.get('collection') ?? 'reports';
            if (!['reports', 'matches'].includes(collection)) throw new ApiError(400, 'invalid_input');
            const page = parseAdminPage(url, { scope: 'safety.' + collection, extraKeys: ['collection'], statuses: collection === 'reports'
                ? ['open', 'under_review', 'resolved', 'rejected'] : ['needs_review', 'rejected', 'blocked', 'not_me', 'deleted', 'expired'] });
            const result = await readAdminPage(ctx.db, page, collection === 'reports' ? {
                select: '*', from: 'safety_reports', priority: "CASE WHEN status IN('open','under_review') THEN 0 ELSE 1 END",
                statusColumn: 'status', searchColumns: ['id', 'reason', 'reporter_id', 'subject_id', 'asset_id'],
            } : {
                select: 'id,asset_id,owner_id,recipient_id,status,version,created_at', from: 'candidates', where: "status<>'eligible'",
                priority: "CASE WHEN status='needs_review' THEN 0 ELSE 1 END", statusColumn: 'status', searchColumns: ['id', 'asset_id', 'owner_id', 'recipient_id'],
            });
            return { reports: collection === 'reports' ? result.items : [], matches: collection === 'matches' ? result.items : [], collection, page: result.page };
        }));
    }
    if (!['POST', 'DELETE'].includes(request.method))
        throw new ApiError(405, 'method_not_allowed');
    const body = await jsonBody(request, 16384);
    if (reportReview) {
        if (request.method !== 'POST')
            throw new ApiError(405, 'method_not_allowed');
        (await requireOperator(ctx, actor, true, 'safety.review'));
        exact(body, ['action', 'expected_revision', 'reason', 'operation_key']);
        if (!['hold', 'release', 'resolve', 'reject'].includes(String(body.action)))
            throw new ApiError(400, 'invalid_report_action');
        const id = uuid(reportReview[1]), rationale = text(body.reason, 4000, 3);
        if (!rationale)
            throw new ApiError(400, 'review_reason_required');
        const intent = await prepareOperation('safety.review', { ...body, report_id: id }, 'moderation');
        return ok((await executeOperation(ctx, actor, intent, async () => {
            (await requireOperator(ctx, actor, true, 'safety.review'));
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
        (await requireOperator(ctx, actor, true, 'safety.review'));
        const id = uuid(review[1] ?? review[2]);
        exact(body, ['action', 'expected_revision', 'reason', 'operation_key']);
        if (!['approve', 'reject', 'escalate', 'delete', 'audit'].includes(String(body.action)))
            throw new ApiError(400, 'invalid_review_action');
        const rationale = text(body.reason, 4096), intent = await prepareOperation('match.review', { ...body, match_id: id }, 'moderation');
        return ok((await executeOperation(ctx, actor, intent, async () => {
            (await requireOperator(ctx, actor, true, 'safety.review'));
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
async function uploads(request: Request, ctx: AppContext, actor: Actor, id?: string) {
    if (id) {
        const asset = await ctx.db.one<any>("SELECT id,owner_id,source,batch_id,status,title,created_at,byte_size,content_type,width,height,version FROM assets WHERE id=? AND source='personal' AND deleted_at IS NULL", id);
        if (!asset) throw new ApiError(404, 'upload_not_found');
        const page = parseAdminPage(new URL(request.url), { scope: 'upload.attempts.' + id, statuses: [] });
        const result = await readAdminPage<any>(ctx.db, page, {
            select: 'p.id,p.status,p.source_version,p.model_version,p.captured_at,p.expires_at,p.completed_at,p.error_code,p.lease_until',
            from: 'processing_attempts p', where: 'p.asset_id=?', values: [id], priority: '0',
            statusColumn: 'p.status', searchColumns: [], idColumn: 'p.id', createdAtColumn: 'p.captured_at',
        });
        const attempts = [];
        for (const attempt of result.items) {
            const outbox = await ctx.db.one('SELECT id,status,created_at,dispatched_at FROM photo_job_outbox WHERE attempt_id=?', attempt.id);
            const jobId = await digest(stable({ category: 'photo', payload: { attempt_id: attempt.id } }));
            const job = await ctx.db.one('SELECT id,state,attempts,handoff_count,available_at,created_at,completed_at,error_code,lease_until FROM job_queue WHERE id=? AND category=?', jobId, 'photo');
            attempts.push({ ...attempt, outbox: outbox ?? null, job: job ?? null, recovery: await photoRecoveryDiagnostics(ctx,id,attempt.id) });
        }
        const activeHold = await mediaHeld(ctx, asset.owner_id, id);
        await audit(ctx, actor, 'upload.admin_read', id, { returned_attempts: attempts.length });
        return { upload: asset, attempts, page: result.page, diagnostics: { observed_at: ctx.now(), moderation_hold: activeHold,
            attempt_history_scope: 'retained_processing_attempts', retry_available: attempts.some(item => item.recovery.eligible), private_media_included: false } };
    }
    const page = parseAdminPage(new URL(request.url), { scope: 'uploads.admin', statuses: ['uploading', 'uploaded', 'processing', 'ready', 'failed', 'cancelled'] });
    const result = await readAdminPage(ctx.db, page, {
        select: 'id,owner_id,source,batch_id,status,title,created_at', from: 'assets', where: "source='personal' AND deleted_at IS NULL",
        priority: "CASE WHEN status='failed' THEN 0 WHEN status IN('uploading','uploaded','processing') THEN 1 ELSE 2 END",
        statusColumn: 'status', searchColumns: ['id', 'owner_id', 'batch_id', 'title'],
    });
    return { uploads: result.items, page: result.page };
}

export async function handleOperators(request: Request, ctx: AppContext): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    const queueRepair=/^\/admin\/queue-repairs\/([0-9a-f]{64})$/.exec(path);
    const queueCollection=path==='/admin/queue-repairs';
    const isSupport = path === '/support/requests' || /^\/(support\/requests|admin\/support-requests)(\/|$)/.test(path);
    const isSafety = path === '/safety/reports' || path === '/me/blocks' || /^\/me\/blocks\//.test(path) || /^\/matches\/[^/]+\/(not-me|review)$/.test(path) || /^\/admin\/matches\//.test(path) || /^\/admin\/safety\/reports(?:\/|$)/.test(path);
    const uploadDetail = /^\/admin\/uploads\/([0-9a-f-]{36})$/i.exec(path);
    const adminMetrics = path === '/admin/metrics' || path === '/admin/uploads' || !!uploadDetail;
    if (!isSupport && !isSafety && !adminMetrics && !queueRepair && !queueCollection)
        return null;
    const actor = await ctx.authenticate(request);
    (await assertRegisteredActor(ctx, actor));
    if(queueCollection){await requireOperator(ctx,actor);return handleQueueRepairCollection(request,ctx,actor,requireOperator);}
    if(queueRepair){await requireOperator(ctx,actor);return handleQueueRepair(request,ctx,actor,queueRepair[1],requireOperator);}
    if (adminMetrics) {
        (await requireOperator(ctx, actor, false, path === '/admin/metrics' ? 'overview.read' : 'uploads.read'));
        if (request.method !== 'GET')
            throw new ApiError(405, 'method_not_allowed');
        return ok(await readOperator(ctx, actor, path === '/admin/metrics' ? 'overview.read' : 'uploads.read', async () => {
            if (path === '/admin/uploads' || uploadDetail) return await uploads(request, ctx, actor, uploadDetail ? uuid(uploadDetail[1]) : undefined);
            return { accounts: (await ctx.db.one('SELECT count(*) n FROM accounts WHERE disabled_at IS NULL'))!.n,
                uploads: (await ctx.db.one("SELECT count(*) n FROM assets WHERE source='personal' AND deleted_at IS NULL"))!.n,
                active_grants: (await ctx.db.one("SELECT count(*) n FROM media_grants g JOIN assets a ON a.id=g.asset_id WHERE g.active=1 AND a.source='personal' AND a.deleted_at IS NULL"))!.n,
                open_support: (await ctx.db.one("SELECT count(*) n FROM support_requests WHERE status IN('open','under_review')"))!.n,
                open_reports: (await ctx.db.one("SELECT count(*) n FROM safety_reports WHERE status IN('open','under_review')"))!.n };
        }));
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
export async function eraseOperatorSubject(db: Database, subject: string, now: number, preserveHolds = false): Promise<void> {
    (await db.run('DELETE FROM support_requests WHERE account_id=?', subject));
    (await db.run("UPDATE safety_reports SET reason='Erased personal content',review_notes=NULL WHERE reporter_id=? OR subject_id=? OR asset_id IN(SELECT id FROM assets WHERE owner_id=?) OR candidate_id IN(SELECT id FROM candidates WHERE owner_id=? OR recipient_id=?)", subject, subject, subject, subject, subject));
    (await db.run('UPDATE safety_reports SET candidate_id=NULL WHERE candidate_id IN(SELECT id FROM candidates WHERE owner_id=? OR recipient_id=?)', subject, subject));
    (await db.run('UPDATE safety_reports SET asset_id=NULL WHERE asset_id IN(SELECT id FROM assets WHERE owner_id=?)', subject));
    // Reviewed account erasure keeps these facts and their asset mapping through
    // external cleanup. It never clears a hold on the authority of the deletion.
    if (!preserveHolds) {
        // Clearing just the asset column would violate the subject-or-asset CHECK.
        (await db.run('DELETE FROM moderation_holds WHERE asset_id IN(SELECT id FROM assets WHERE owner_id=?)', subject));
        (await db.run('UPDATE moderation_holds SET active=0,cleared_at=?,reason=? WHERE subject_id=?', now, 'Erased subject', subject));
    }
}
