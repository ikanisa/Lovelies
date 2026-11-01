import { ApiError, digest, jsonBody, ok, stable, type Actor, type AppContext } from './types.ts';
import { executeOperation, prepareOperation } from './operations.ts';
import { photoQueueRepairEvidence } from './processing.ts';
import { accountErasureHoldFingerprint } from './retention.ts';
import { notificationQueueRepairEvidence } from './notifications.ts';
import { adminSearch, readAdminPage, selectAdminPage, type AdminPageRow } from './child-pagination.ts';
import { bindQueueRepairAuthority } from './operator-authority.ts';

type Job = { id: string; category: string; payload_json: string; state: string; attempts: number;
    available_at: number; created_at: number; completed_at: number | null; error_code: string | null;
    lease_token: string | null; lease_until: number | null };
type Inspection = { job: Job; category: string; domainID: string | null; domainStatus: string | null;
    blocked: string | null; evidence: Record<string, unknown>; outboxID: string | null; subjectID: string | null; fingerprint: string };
type Authorize = (ctx: AppContext, actor: Actor, fresh?: boolean) => Promise<void>;
const hash = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const blocked = (code: string): never => { throw new ApiError(409, code); };

/** Discover stopped work without a provider read per row. Detail inspection is
 * always separate, current and authoritative; this projection conveys no retry
 * permission. Corrupt JSON remains visible as an unbound job instead of making
 * every unrelated queue row unreadable. */
export async function handleQueueRepairCollection(request: Request, ctx: AppContext, actor: Actor, authorize: Authorize): Promise<Response> {
    if (request.method !== 'GET') throw new ApiError(405, 'method_not_allowed');
    return ok(await ctx.db.read(async () => {
        await authorize(ctx, actor);
        const page = readAdminPage(new URL(request.url).searchParams, { scope: 'admin.queue-repairs',
            statuses: ['attention', 'all', 'failed', 'completed'], defaultStatus: 'attention', idFormat: 'sha256' });
        const search = adminSearch(page.q, ['id', 'category', 'domain_id', 'error_code']);
        const from = `(SELECT j.id,j.category,j.state queue_state,j.attempts,j.error_code,j.created_at,j.available_at,j.completed_at,
            CASE WHEN j.domain_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN j.domain_id ELSE NULL END domain_id,
            CASE j.category WHEN 'photo' THEN p.status WHEN 'privacy' THEN r.status WHEN 'notification' THEN n.status ELSE NULL END domain_status
            FROM (SELECT j.*,CASE j.category WHEN 'photo' THEN body->>'attempt_id' WHEN 'privacy' THEN body->>'request_id'
                WHEN 'notification' THEN body->>'notification_id' ELSE NULL END domain_id
                FROM (SELECT j.*,CASE WHEN json_valid(payload_json) THEN payload_json::jsonb ELSE '{}'::jsonb END body FROM job_queue j) j) j
            LEFT JOIN processing_attempts p ON j.category='photo' AND p.id=j.domain_id
            LEFT JOIN privacy_requests r ON j.category='privacy' AND r.id=j.domain_id
            LEFT JOIN notification_jobs n ON j.category='notification' AND n.notification_id=j.domain_id
            WHERE j.state IN('failed','completed')) queue`;
        const filters = page.status === 'attention'
            ? ["domain_status IS NULL OR (category='photo' AND domain_status NOT IN('completed','failed','cancelled')) OR (category='privacy' AND domain_status NOT IN('completed','rejected','cancelled')) OR (category='notification' AND domain_status NOT IN('accepted','cancelled','inbox_only'))"]
            : page.status === 'all' ? [] : ['queue_state=?'];
        type Row = AdminPageRow & { category: string; queue_state: string; attempts: number; error_code: string | null;
            available_at: number; completed_at: number | null; domain_id: string | null; domain_status: string | null };
        const result = await selectAdminPage<Row>(ctx, page, { select: '*', from,
            where: [...filters, search.clause], values: [...(page.status === 'failed' || page.status === 'completed' ? [page.status] : []), ...search.values] });
        await authorize(ctx, actor);
        return { queue_repairs: result.items.map(row => ({ id: row.id, job_id: row.id, category: row.category,
            queue_state: row.queue_state, attempts: row.attempts, error_code: row.error_code, created_at: row.created_at,
            available_at: row.available_at, completed_at: row.completed_at, domain_id: row.domain_id, domain_status: row.domain_status })), page: result.page };
    }));
}

/** Eligible means a current exact queued domain episode whose durable pre-effect
 * boundary is intact. Notification inspection additionally reads the pinned
 * independent complete roster; it never creates a plan or dispatches work.
 * Attempted/ambiguous effects and terminal domain states remain untouched. */
async function inspect(ctx: AppContext, id: string): Promise<Inspection> {
    const job = await ctx.db.one<Job>('SELECT id,category,payload_json,state,attempts,available_at,created_at,completed_at,error_code,lease_token,lease_until FROM job_queue WHERE id=?', id);
    if (!job) throw new ApiError(404, 'queue_job_not_found');
    const result: Inspection = { job, category: job.category, domainID: null, domainStatus: null, blocked: null,
        evidence: {}, outboxID: null, subjectID: null, fingerprint: '' };
    try {
        let payload: Record<string, unknown>;
        try { payload = JSON.parse(job.payload_json); } catch { return blocked('queue_binding_invalid'); }
        const field = ({ photo: 'attempt_id', privacy: 'request_id', notification: 'notification_id' } as Record<string, string>)[job.category];
        if (!field || !payload || Array.isArray(payload) || typeof payload !== 'object' || Object.keys(payload).join(',') !== field ||
            typeof payload[field] !== 'string' || !uuid.test(payload[field]) || stable(payload) !== job.payload_json ||
            await digest(stable({ category: job.category, payload })) !== id) return blocked('queue_binding_invalid');
        result.domainID = payload[field];
        if (!['failed', 'completed'].includes(job.state) || job.lease_token !== null || job.lease_until !== null)
            return blocked('queue_not_terminal_unleased');
        if (job.category === 'photo') {
            const domain = await ctx.db.one<{status:string;owner_id:string;asset_id:string}>('SELECT status,owner_id,asset_id FROM processing_attempts WHERE id=?', result.domainID);
            result.domainStatus = domain?.status ?? null; result.subjectID = domain?.owner_id ?? null;
            if (!domain) return blocked('queue_domain_missing');
            if (domain.status !== 'queued') return blocked('queue_photo_not_resumable');
            const snapshot = await photoQueueRepairEvidence(ctx, result.domainID);
            const attempt = snapshot.attempt as Record<string, any>, asset = snapshot.asset as Record<string, any>;
            const outbox = await ctx.db.one<Record<string, any>>('SELECT id,attempt_id,asset_id,status,created_at,dispatched_at FROM photo_job_outbox WHERE attempt_id=?', result.domainID);
            if (!outbox || outbox.asset_id !== attempt.asset_id || !['pending', 'dispatched'].includes(outbox.status)) return blocked('queue_outbox_changed');
            if (await ctx.db.one("SELECT id FROM media_write_intents WHERE account_id=? AND status='pending' LIMIT 1", attempt.owner_id) ||
                await ctx.db.one("SELECT id FROM cleanup_intents WHERE subject_id=? AND status<>'verified' LIMIT 1", attempt.owner_id))
                return blocked('queue_external_work_unresolved');
            if (await ctx.db.one('SELECT id FROM renditions WHERE asset_id=? AND source_version=? LIMIT 1', attempt.asset_id, attempt.source_version) ||
                await ctx.db.one("SELECT id FROM processing_attempts WHERE asset_id=? AND source_version=? AND id<>? AND status IN('queued','running') LIMIT 1", attempt.asset_id, attempt.source_version, attempt.id))
                return blocked('queue_photo_publication_or_competitor');
            result.evidence = { ...snapshot, outbox, asset_id: asset.id }; result.outboxID = outbox.id;
        } else if (job.category === 'privacy') {
            const request = await ctx.db.one<Record<string, any>>(`SELECT id,subject_id,requested_by,request_type,status,created_at,reviewed_by,reviewed_at,expires_at,
                completed_at,export_key,export_sha256,export_bytes,export_expires_at,legal_hold,execution_token,lease_until,metadata_erased_at,failure_code
                FROM privacy_requests WHERE id=?`, result.domainID);
            result.domainStatus = request?.status ?? null; result.subjectID = request?.subject_id ?? null;
            if (!request) return blocked('queue_domain_missing');
            if (request.status !== 'queued' || !['delete', 'export'].includes(request.request_type) || request.execution_token !== null || request.lease_until !== null ||
                request.metadata_erased_at !== null || request.failure_code !== null || request.completed_at !== null || request.export_key !== null || request.export_sha256 !== null ||
                request.export_bytes !== null || request.export_expires_at !== null || request.legal_hold !== 0 ||
                request.request_type === 'export' && request.expires_at <= ctx.now()) return blocked('queue_privacy_not_pristine');
            const reviewer = request.reviewed_by && await ctx.db.one<Record<string, any>>('SELECT id,roles_json,identity_state,disabled_at FROM accounts WHERE id=?', request.reviewed_by);
            const subject = await ctx.db.one<Record<string, any>>('SELECT id,identity_state,disabled_at,auth_epoch FROM accounts WHERE id=?', request.subject_id);
            if (!reviewer || reviewer.id === request.subject_id || request.reviewed_at === null || reviewer.disabled_at !== null || reviewer.identity_state !== 'registered_face' ||
                !JSON.parse(reviewer.roles_json).includes('admin') || !subject ||
                !(subject.identity_state === 'registered_face' || request.request_type === 'delete' && subject.identity_state === 'anonymous') ||
                request.request_type === 'export' && subject.disabled_at !== null) return blocked('queue_privacy_authority_changed');
            const outbox = await ctx.db.one<Record<string, any>>('SELECT id,account_id,category,entity_id,event_key,payload_json,created_at,delivered_at,cancelled_at FROM outbox WHERE event_key=?', 'privacy:' + request.id + ':approved');
            if (!outbox || outbox.account_id !== request.subject_id || outbox.category !== 'privacy' || outbox.entity_id !== request.id ||
                outbox.cancelled_at !== null || outbox.payload_json !== stable({ request_id: request.id })) return blocked('queue_outbox_changed');
            if (await ctx.db.one('SELECT id FROM cleanup_intents WHERE request_id=? LIMIT 1', request.id) ||
                await ctx.db.one('SELECT id FROM privacy_exports WHERE request_id=? LIMIT 1', request.id) ||
                await ctx.db.one('SELECT id FROM privacy_export_snapshots WHERE request_id=? LIMIT 1', request.id) ||
                await ctx.db.one("SELECT id FROM media_write_intents WHERE account_id=? AND status='pending' LIMIT 1", request.subject_id))
                return blocked('queue_external_work_unresolved');
            const holds = request.request_type === 'delete' ? await accountErasureHoldFingerprint(ctx, request.subject_id) : null;
            result.evidence = { request, reviewer, subject, outbox, holds }; result.outboxID = outbox.id;
        } else {
            const domain = await ctx.db.one<{status:string;account_id:string}>('SELECT status,account_id FROM notification_jobs WHERE notification_id=?', result.domainID);
            result.domainStatus = domain?.status ?? null; result.subjectID = domain?.account_id ?? null;
            if (!domain) return blocked('queue_domain_missing');
            const snapshot = await notificationQueueRepairEvidence(ctx, result.domainID);
            if (snapshot.account_id !== domain.account_id || snapshot.domain_status !== domain.status || snapshot.outbox_id !== result.domainID)
                return blocked('queue_outbox_changed');
            result.evidence = snapshot; result.outboxID = result.domainID;
        }
    } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        // Infrastructure/restore failures are not evidence for an operator
        // decision. Only known current-domain denials form a reviewable result.
        if (error.status >= 500) throw error;
        result.blocked = error.code;
    }
    result.fingerprint = await digest(stable({ protocol: 'lovelies-queue-repair-preview-v1', job, domain_id: result.domainID,
        domain_status: result.domainStatus, blocked_reason: result.blocked, evidence: result.evidence }));
    return result;
}
function projection(result: Inspection): Record<string, unknown> {
    return { job_id: result.job.id, category: result.category, queue_state: result.job.state,
        attempts: result.job.attempts, error_code: result.job.error_code, domain_id: result.domainID, domain_status: result.domainStatus,
        eligible: result.blocked === null, blocked_reason: result.blocked, fingerprint: result.fingerprint,
        action: result.blocked === null ? 'resume_exact_work' : null };
}

export async function handleQueueRepair(request: Request, ctx: AppContext, actor: Actor, id: string, authorize: Authorize): Promise<Response> {
    if (!hash.test(id) || new URL(request.url).search) throw new ApiError(400, 'queue_repair_input_invalid');
    if (request.method === 'GET') return ok(await ctx.db.read(async () => {
        await authorize(ctx, actor); const result = await inspect(ctx, id); await authorize(ctx, actor);
        return { queue_repair: projection(result) };
    }));
    if (request.method !== 'POST') throw new ApiError(405, 'method_not_allowed');
    await authorize(ctx, actor, true);
    const body = await jsonBody(request, 8192);
    if (Object.keys(body).some(key => !['operation_key', 'expected_fingerprint', 'reason'].includes(key)) ||
        typeof body.expected_fingerprint !== 'string' || !hash.test(body.expected_fingerprint) ||
        typeof body.reason !== 'string' || !body.reason.trim() || body.reason.trim().length > 1000 || /[\u0000-\u001f]/.test(body.reason))
        throw new ApiError(400, 'queue_repair_input_invalid');
    const intent = await prepareOperation('admin.queue.repair', { job_id: id, operation_key: body.operation_key,
        expected_fingerprint: body.expected_fingerprint, reason: body.reason.trim() }, 'queue_repair');
    bindQueueRepairAuthority(ctx, actor);
    const subjects: string[] = [];
    return ok(await executeOperation(ctx, actor, intent, async () => {
        await authorize(ctx, actor, true);
        const result = await inspect(ctx, id);
        if (result.fingerprint !== body.expected_fingerprint) throw new ApiError(409, 'queue_repair_snapshot_changed');
        if (result.blocked || !result.outboxID || !result.subjectID) throw new ApiError(409, 'queue_repair_blocked');
        subjects.push(result.subjectID);
        const now = ctx.now();
        const changed = await ctx.db.one<{id:string}>(`UPDATE job_queue SET state='pending',available_at=?,completed_at=NULL
            WHERE id=? AND state=? AND attempts=? AND lease_token IS NULL AND lease_until IS NULL RETURNING id`,
            now, id, result.job.state, result.job.attempts);
        if (!changed) throw new ApiError(409, 'queue_repair_snapshot_changed');
        if (result.category === 'photo') await ctx.db.run("UPDATE photo_job_outbox SET status='dispatched',dispatched_at=? WHERE id=? AND attempt_id=? AND status IN('pending','dispatched')", now, result.outboxID, result.domainID);
        else if (result.category === 'notification') await ctx.db.run("UPDATE notification_jobs SET status='dispatched',dispatched_at=? WHERE notification_id=? AND status IN('queued','dispatched','ambiguous')", now, result.domainID);
        else await ctx.db.run('UPDATE outbox SET delivered_at=? WHERE id=? AND entity_id=? AND cancelled_at IS NULL', now, result.outboxID, result.domainID);
        await ctx.db.run('INSERT INTO audit_events(id,actor_id,subject_id,action,entity_id,details_json,created_at) VALUES(?,?,?,?,?,?,?)',
            crypto.randomUUID(), actor.accountId, result.subjectID, 'admin.queue.repair', id,
            stable({ category: result.category, domain_id: result.domainID, fingerprint: result.fingerprint, reason: body.reason.trim(),
                previous_state: result.job.state, previous_domain_status: result.domainStatus, previous_attempts: result.job.attempts, previous_error_code: result.job.error_code,
                previous_completed_at: result.job.completed_at, previous_available_at: result.job.available_at }), now);
        await authorize(ctx, actor, true);
        return { queue_repair: { job_id: id, category: result.category, domain_id: result.domainID,
            action: 'resume_exact_work', status: 'admitted', repaired_at: now } };
    }, subjects));
}
