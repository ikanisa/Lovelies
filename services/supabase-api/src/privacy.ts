import { audiencePrivacyRows, eraseAudienceSubject, revokeAudienceAuthority } from './audience.ts';
import { ApiError, digest, jsonBody, ok, record, stable, uuid, type Actor, type AppContext } from './types.ts';
import { assertOperationReceiptAvailable, assertRegisteredActor, executeOperation, executeAccountDeletionOperation, executeRestrictedOperation, prepareOperation, settleMediaWrite } from './operations.ts';
import { assertPrivacyActor } from './auth.ts';
import { entitlementPrivacyRows, eraseEntitlementSubject } from './entitlements.ts';
import { operatorPrivacyRows, eraseOperatorSubject } from './operators.ts';
import { notificationPrivacyRows, eraseNotificationSubject } from './notifications.ts';
import { retentionPrivacyRows, retentionPrivateKeys, eraseRetentionSubject } from './retention.ts';
type PrivacyRequest = {
    id: string;
    subject_id: string;
    requested_by: string;
    request_type: 'export' | 'delete';
    status: string;
    reason: string | null;
    created_at: number;
    reviewed_by: string | null;
    reviewed_at: number | null;
    expires_at: number;
    completed_at: number | null;
    legal_hold: number;
    failure_code: string | null;
    export_key: string | null;
    export_sha256: string | null;
    export_bytes: number | null;
    export_expires_at: number | null;
    execution_token: string | null;
    lease_until: number | null;
    metadata_erased_at: number | null;
};
type JobAuthority = {
    kind: 'approved-job';
    requestId: string;
};
type ExecutionAuthority = Actor | JobAuthority;
function jobAuthority(value: ExecutionAuthority): value is JobAuthority { return 'kind' in value && value.kind === 'approved-job'; }
const requestTtl = 7 * 24 * 60 * 60 * 1000;
const deletionReceiptTtl = 30 * 24 * 60 * 60 * 1000;
const deletionProtocol = 'lovelies-account-deletion-v1';
type DeletionReceipt = {
    request_id: string;
    token_hash: string;
    operation_key: string;
    created_at: number;
    expires_at: number;
    revoked_at: number | null;
};
function deletionToken(value: unknown): string {
    if (typeof value !== 'string' || !/^lvd_[0-9a-f]{64}$/.test(value))
        throw new ApiError(400, 'deletion_status_token_invalid');
    return value;
}
function deletionStatus(row: PrivacyRequest, receipt: DeletionReceipt, now: number): Record<string, unknown> {
    return { protocol: deletionProtocol, source: 'privacy', operation_key: receipt.operation_key,
        privacy_request: { id: row.id, request_type: 'delete', status: row.status,
            created_at: new Date(row.created_at).toISOString(),
            reviewed_at: row.reviewed_at === null ? null : new Date(row.reviewed_at).toISOString(),
            completed_at: row.completed_at === null ? null : new Date(row.completed_at).toISOString(), failure_code: row.failure_code },
        deletion_status: { expires_at: new Date(receipt.expires_at).toISOString() }, deletion_completed: row.status === 'completed',
        request_expires_at: new Date(row.expires_at).toISOString(),
        request_expired: row.request_type !== 'delete' && row.expires_at <= now && row.metadata_erased_at === null && !['completed', 'rejected', 'cancelled'].includes(row.status) };
}
const exportTtl = 24 * 60 * 60 * 1000;
const exportBudget = 20 * 1024 * 1024;
const maximumExportRows = 25000;
async function currentRequest(ctx: AppContext, id: string): Promise<PrivacyRequest> {
    const row = (await ctx.db.one<PrivacyRequest>('SELECT * FROM privacy_requests WHERE id=?', id));
    if (!row)
        throw new ApiError(404, 'privacy_request_unavailable');
    return row;
}
async function audit(ctx: AppContext, actor: ExecutionAuthority, subject: string, action: string, id: string, details: Record<string, unknown> = {}): Promise<void> {
    (await ctx.db.run('INSERT INTO audit_events(id,actor_id,subject_id,action,entity_id,details_json,created_at) VALUES(?,?,?,?,?,?,?)', crypto.randomUUID(), jobAuthority(actor) ? (await currentRequest(ctx, actor.requestId)).reviewed_by : actor.accountId, subject, action, id, stable(details), ctx.now()));
}
async function requireAdmin(ctx: AppContext, actor: ExecutionAuthority): Promise<void> {
    if (jobAuthority(actor)) {
        const request = (await currentRequest(ctx, actor.requestId));
        const reviewer = request.reviewed_by && (await ctx.db.one<{
            roles_json: string;
            identity_state: string;
            disabled_at: number | null;
        }>('SELECT roles_json,identity_state,disabled_at FROM accounts WHERE id=?', request.reviewed_by));
        const continuingErasure = request.request_type === 'delete' && request.metadata_erased_at !== null && (await ctx.db.one('SELECT id FROM accounts WHERE id=? AND disabled_at IS NOT NULL', request.subject_id)) !== null;
        if (!request.reviewed_by || request.reviewed_by === request.subject_id || request.reviewed_at === null || !['queued', 'processing', 'failed'].includes(request.status) ||
            (!continuingErasure && (request.request_type !== 'delete' && request.expires_at <= ctx.now() || !reviewer || reviewer.identity_state !== 'registered_face' || reviewer.disabled_at !== null || !JSON.parse(reviewer.roles_json).includes('admin'))))
            throw new ApiError(403, 'privacy_approved_job_required');
        return;
    }
    (await assertRegisteredActor(ctx, actor));
    if (!actor.roles.includes('admin'))
        throw new ApiError(403, 'admin_required');
}
function summary(row: PrivacyRequest, now: number): Record<string, unknown> {
    return { id: row.id, request_type: row.request_type, status: row.status, created_at: new Date(row.created_at).toISOString(),
        reviewed_at: row.reviewed_at === null ? null : new Date(row.reviewed_at).toISOString(),
        completed_at: row.completed_at === null ? null : new Date(row.completed_at).toISOString(), reason: row.reason,
        download_state: row.status === 'completed' && row.request_type === 'export' && row.export_expires_at !== null && row.export_expires_at > now ? 'ready' : 'unavailable',
        failure_code: row.failure_code };
}
function reason(body: Record<string, unknown>, required = false): string | null {
    if (body.reason !== undefined && typeof body.reason !== 'string')
        throw new ApiError(400, 'privacy_request_reason_invalid');
    const value = typeof body.reason === 'string' ? body.reason.trim() : null;
    if (value && (value.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)))
        throw new ApiError(400, 'privacy_request_reason_invalid');
    if (required && !value)
        throw new ApiError(400, 'privacy_review_reason_required');
    return value || null;
}
function exact(body: Record<string, unknown>, allowed: readonly string[]): void {
    if (Object.keys(body).some(key => !allowed.includes(key)))
        throw new ApiError(400, 'privacy_input_invalid');
}
export async function createPrivacyRequest(ctx: AppContext, actor: Actor, kind: 'export' | 'delete', body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await assertPrivacyActor(actor, ctx);
    if (kind === 'export' && actor.authMethod !== 'registered_face') throw new ApiError(403, 'registered_face_required');
    exact(body, kind === 'delete' ? ['reason', 'operation_key', 'status_token'] : ['reason', 'operation_key']);
    const rationale = reason(body), normalized = { ...body };
    let tokenHash: string | null = null;
    if (kind === 'delete' && body.status_token !== undefined) {
        const token = deletionToken(body.status_token);
        // Other accepted fields are durable/echoed metadata. They may not carry
        // the receipt secret around the hash-only persistence boundary.
        if ([body.operation_key, body.reason].some(value => typeof value === 'string' && value.includes(token))) {
            throw new ApiError(400, 'privacy_input_invalid');
        }
        tokenHash = await digest(token);
        delete normalized.status_token;
        normalized.status_token_hash = tokenHash;
    }
    else if (kind === 'delete' && actor.authMethod === 'anonymous')
        throw new ApiError(400, 'deletion_status_token_required');
    const intent = await prepareOperation('privacy.request.' + kind, normalized, 'privacy');
    const execute = kind === 'delete' ? executeAccountDeletionOperation : executeRestrictedOperation;
    return execute(ctx, actor, intent, async () => {
        const id = crypto.randomUUID(), now = ctx.now();
        (await ctx.db.run('INSERT INTO privacy_requests(id,subject_id,requested_by,request_type,status,reason,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)', id, actor.accountId, actor.accountId, kind, 'pending_approval', rationale, now, now + (kind === 'delete' ? 30 * 86400000 : requestTtl)));
        if (kind === 'delete') {
            await revokeAudienceAuthority(ctx, actor.accountId, id);
            // Serialize guest deletion with the final enrollment transaction. Any
            // verifier/writer already awaited must fail its next authority recheck.
            (await ctx.db.run(`UPDATE auth_challenges SET status='cancelled',used_at=? WHERE account_id=?
        AND purpose='registration' AND used_at IS NULL`, now, actor.accountId));
        }
        (await audit(ctx, actor, actor.accountId, 'privacy.request.' + kind, id));
        if (tokenHash !== null) {
            // The pre-saved client token can reconcile even after operation/session
            // erasure. Only its hash enters durable server rows.
            if ((await ctx.db.one('SELECT request_id FROM privacy_deletion_status_receipts WHERE token_hash=?', tokenHash)))
                throw new ApiError(409, 'deletion_status_token_conflict');
            (await ctx.db.run('INSERT INTO privacy_deletion_status_receipts(request_id,token_hash,operation_key,created_at,expires_at) VALUES(?,?,?,?,?)', id, tokenHash, intent.key, now, now + deletionReceiptTtl));
            const receipt = (await ctx.db.one<DeletionReceipt>('SELECT * FROM privacy_deletion_status_receipts WHERE request_id=?', id))!;
            const row = (await currentRequest(ctx, id));
            const response = deletionStatus(row, receipt, now);
            return { ...response, privacy_request: { ...response.privacy_request as Record<string, unknown>,
                    subject_user_id: actor.accountId, requested_by: actor.accountId, reason: rationale } };
        }
        return { privacy_request: { id, request_type: kind, subject_user_id: actor.accountId, requested_by: actor.accountId, status: 'pending_approval', reason: rationale } };
    });
}
async function retrieveDeletionStatus(request: Request, ctx: AppContext): Promise<Response> {
    if (new URL(request.url).search)
        throw new ApiError(400, 'privacy_input_invalid');
    const body = await jsonBody(request, 1024);
    exact(body, ['status_token']);
    const tokenHash = await digest(deletionToken(body.status_token));
    return (await ctx.db.transaction(async () => {
        const receipt = (await ctx.db.one<DeletionReceipt>('SELECT * FROM privacy_deletion_status_receipts WHERE token_hash=?', tokenHash));
        const row = receipt && (await ctx.db.one<PrivacyRequest>('SELECT * FROM privacy_requests WHERE id=?', receipt.request_id));
        if (!receipt || !row || row.request_type !== 'delete' || receipt.revoked_at !== null || receipt.expires_at <= ctx.now() && ['completed','rejected','cancelled'].includes(row.status)) {
            throw new ApiError(404, 'deletion_status_unavailable');
        }
        const response = ok(deletionStatus(row, receipt, ctx.now()));
        response.headers.set('Cache-Control', 'no-store, private');
        return response;
    }));
}
export async function reviewPrivacyRequest(ctx: AppContext, actor: Actor, id: string, decision: 'approve' | 'reject', body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await assertPrivacyActor(actor, ctx);
    if ((await currentRequest(ctx,id)).subject_id === actor.accountId) throw new ApiError(403, 'independent_privacy_review_required');
    (await requireAdmin(ctx, actor));
    exact(body, ['reason', 'operation_key']);
    const rationale = reason(body, decision === 'reject');
    const intent = await prepareOperation('privacy.review.' + decision, { ...body, request_id: id }, 'privacy');
    return (await executeOperation(ctx, actor, intent, async () => {
        (await requireAdmin(ctx, actor));
        const request = (await currentRequest(ctx, id));
        if (request.status !== 'pending_approval' || request.request_type !== 'delete' && request.expires_at <= ctx.now())
            throw new ApiError(409, 'privacy_review_conflict');
        if (request.subject_id === actor.accountId)
            throw new ApiError(403, 'independent_privacy_review_required');
        const now = ctx.now(), status = decision === 'approve' ? 'queued' : 'rejected';
        (await ctx.db.run('UPDATE privacy_requests SET status=?,reviewed_by=?,reviewed_at=?,review_reason=? WHERE id=?', status, actor.accountId, now, rationale, id));
        // The terminal outcome and its read-only status window share one commit;
        // best-effort dispatch/maintenance cannot be required to preserve access.
        if (decision === 'reject' && request.request_type === 'delete')
            await ctx.db.run('UPDATE privacy_deletion_status_receipts SET expires_at=? WHERE request_id=? AND revoked_at IS NULL', now + deletionReceiptTtl, id);
        if (decision === 'approve')
            (await ctx.db.run('INSERT INTO outbox(id,account_id,category,entity_id,event_key,payload_json,created_at) VALUES(?,?,?,?,?,?,?)', crypto.randomUUID(), request.subject_id, 'privacy', id, 'privacy:' + id + ':approved', stable({ request_id: id }), now));
        (await audit(ctx, actor, request.subject_id, 'privacy.review.' + decision, id));
        return { privacy_request: { id, request_type: request.request_type, status, reviewed_by: actor.accountId, reviewed_at: new Date(now).toISOString() }, delivery_confirmed: false };
    }, [(await currentRequest(ctx, id)).subject_id]));
}
/** Explicit projections only: no device public-key material, templates, vectors,
 * storage paths, frozen counterpart names/graphs or replay/capability payloads. */
export async function collectPrivacyExport(ctx: AppContext, subject: string): Promise<Record<string, unknown>> {
    const datasets: Record<string, Record<string, unknown>[]> = {};
    let rows = 0;
    const add = async (name: string, sql: string, ...bindings: (string | number | null)[]) => {
        const data = (await ctx.db.all<Record<string, unknown>>(sql + ` LIMIT ${maximumExportRows + 1}`, ...bindings));
        rows += data.length;
        if (rows > maximumExportRows)
            throw new ApiError(413, 'privacy_export_scope_too_large');
        datasets[name] = data;
    };
    (await add('account', 'SELECT id,name,identity_state,created_at,disabled_at FROM accounts WHERE id=?', subject));
    (await add('consents', 'SELECT id,purpose,policy_version,status,created_at,expires_at,revoked_at FROM consents WHERE account_id=? ORDER BY created_at,id', subject));
    (await add('preferences', 'SELECT receive_matches,download_photos,updated_at FROM account_preferences WHERE account_id=?', subject));
    (await add('face_profile', 'SELECT id,revision,model_id,status,auth_enabled FROM face_profiles WHERE account_id=?', subject));
    (await add('owned_assets', 'SELECT id,source,batch_id,status,version,width,height,title,captured_at,created_at,deleted_at FROM assets WHERE owner_id=? ORDER BY created_at,id', subject));
    (await add('photo_transfers', `SELECT t.asset_id,t.bytes_received,t.state,t.created_at,t.expires_at,t.error_code
    FROM upload_transfers t JOIN assets a ON a.id=t.asset_id WHERE a.owner_id=? ORDER BY t.created_at,t.asset_id`, subject));
    (await add('owned_snapshots', 'SELECT id,source,created_at,expires_at,privacy_redacted_at FROM sharing_snapshots WHERE owner_id=? ORDER BY created_at,id', subject));
    (await add('owned_previews', 'SELECT id,source,draft_version,created_at,expires_at,committed_at,privacy_redacted_at FROM sharing_previews WHERE owner_id=? ORDER BY created_at,id', subject));
    // Own request lifecycle is exported without exposing frozen recipient subsets.
    (await add('requests', 'SELECT id,source,status,created_at,expires_at,updated_at FROM sharing_requests WHERE sender_id=? OR recipient_id=? ORDER BY created_at,id', subject, subject));
    (await add('grants', 'SELECT id,asset_id,active,created_at,revoked_at FROM media_grants WHERE recipient_id=? ORDER BY created_at,id', subject));
    (await add('privacy_requests', 'SELECT id,request_type,status,reason,created_at,reviewed_at,completed_at FROM privacy_requests WHERE subject_id=? ORDER BY created_at,id', subject));
    (await add('financial_records', 'SELECT id,record_type,data_json,created_at FROM financial_records WHERE account_id=? ORDER BY created_at,id', subject));
    datasets.financial_records = datasets.financial_records.map(({ data_json, ...row }) => {
        const parsed = JSON.parse(String(data_json));
        const data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? record(parsed) : {}, financial: Record<string, unknown> = {};
        for (const key of ['amount', 'tax', 'total'])
            if (typeof data[key] === 'number' && Number.isFinite(data[key]))
                financial[key] = data[key];
        if (typeof data.currency === 'string' && /^[A-Z]{3}$/.test(data.currency))
            financial.currency = data.currency;
        if (typeof data.status === 'string' && ['paid', 'pending', 'settled', 'refunded', 'cancelled', 'failed'].includes(data.status))
            financial.status = data.status;
        return { ...row, data: financial };
    });
    for (const hook of [entitlementPrivacyRows, operatorPrivacyRows, notificationPrivacyRows, retentionPrivacyRows, audiencePrivacyRows]) {
        const additional = await hook(ctx, subject);
        for (const [name, value] of Object.entries(additional)) {
            const data = Array.isArray(value) ? value : [value];
            rows += data.length;
            if (rows > maximumExportRows)
                throw new ApiError(413, 'privacy_export_scope_too_large');
            datasets[name] = data as Record<string, unknown>[];
        }
    }
    return { schema_version: 2, inventory_version: 'supabase-personal-data-v2', subject_user_id: subject, generated_at: new Date(ctx.now()).toISOString(), tables: datasets };
}
async function authorizedProcess(ctx: AppContext, actor: ExecutionAuthority, id: string, kind: 'export' | 'delete'): Promise<PrivacyRequest> {
    (await requireAdmin(ctx, actor));
    if (jobAuthority(actor) && actor.requestId !== id)
        throw new ApiError(403, 'privacy_job_scope_invalid');
    const request = (await currentRequest(ctx, id));
    if (request.request_type !== kind || !request.reviewed_by || request.reviewed_at === null || request.reviewed_by === request.subject_id ||
        !['queued', 'processing', 'failed'].includes(request.status) || kind !== 'delete' && request.expires_at <= ctx.now())
        throw new ApiError(409, 'privacy_execution_unavailable');
    if (kind === 'delete' && request.legal_hold)
        throw new ApiError(409, 'privacy_legal_hold');
    const subject = (await ctx.db.one<{
        identity_state: string;
        disabled_at: number | null;
    }>('SELECT identity_state,disabled_at FROM accounts WHERE id=?', request.subject_id));
    if (!subject || (subject.identity_state !== 'registered_face' && !(kind === 'delete' && subject.identity_state === 'anonymous')))
        throw new ApiError(409, 'privacy_subject_unavailable');
    if (kind === 'export' && subject.disabled_at !== null)
        throw new ApiError(409, 'privacy_subject_disabled');
    return request;
}
async function cleanup(ctx: AppContext, request: PrivacyRequest, bucket: 'PHOTOS' | 'QUARANTINE' | 'PRIVACY_EXPORTS', key: string, reset = false): Promise<void> {
    if(request.request_type==='delete'&&request.reviewed_by&&request.reviewed_by!==request.subject_id&&request.reviewed_at!==null){
        // Adopt the existing exact-key obligation before creating a duplicate.
        // Preserve its ID/attempt history and retirement references, but require
        // a new DELETE + absent HEAD under this reviewed erasure authority.
        const target=await ctx.db.one('SELECT id FROM cleanup_intents WHERE request_id=? AND bucket=? AND object_key=?',request.id,bucket,key);
        if(!target){
            const orphan=await ctx.db.one<{id:string}>('SELECT c.id FROM cleanup_intents c WHERE c.request_id IS NULL AND c.subject_id=? AND c.bucket=? AND c.object_key=? ORDER BY CASE WHEN EXISTS(SELECT 1 FROM face_profile_retirements r WHERE r.cleanup_id=c.id) THEN 0 ELSE 1 END,c.created_at,c.id LIMIT 1',request.subject_id,bucket,key);
            if(orphan)await ctx.db.run("UPDATE cleanup_intents SET request_id=?,status='pending',verified_at=NULL WHERE id=? AND request_id IS NULL",request.id,orphan.id);
        }
    }
    (await ctx.db.run('INSERT OR IGNORE INTO cleanup_intents(id,request_id,subject_id,bucket,object_key,status,attempts,created_at) VALUES(?,?,?,?,?,?,?,?)', crypto.randomUUID(), request.id, request.subject_id, bucket, key, 'pending', 0, ctx.now()));
    if (reset)
        (await ctx.db.run("UPDATE cleanup_intents SET status='pending',verified_at=NULL WHERE request_id=? AND bucket=? AND object_key=?", request.id, bucket, key));
}
function exactManifest(pairs: Record<string, unknown>[], source: string): Record<string, unknown> {
    const recipients = new Map<string, Set<string>>(), assets = new Set<string>();
    for (const pair of pairs) {
        const recipient = String(pair.recipient_id), asset = String(pair.asset_id);
        (recipients.get(recipient) ?? recipients.set(recipient, new Set()).get(recipient)!).add(asset);
        assets.add(asset);
    }
    return { ...(source === 'professional' ? { source } : {}), pairs: pairs.map(pair => ({ asset_id: pair.asset_id, recipient_id: pair.recipient_id })),
        recipients: [...recipients].sort(([a], [b]) => a.localeCompare(b)).map(([recipient_id, ids]) => ({ recipient_id, asset_ids: [...ids].sort(), photo_count: ids.size })),
        totals: { photos: assets.size, recipients: recipients.size, pairs: pairs.length } };
}
function mentions(value: unknown, subject: string): boolean {
    if (typeof value === 'string')
        return value.toLowerCase() === subject;
    if (Array.isArray(value))
        return value.some(item => mentions(item, subject));
    if (value && typeof value === 'object')
        return Object.values(value).some(item => mentions(item, subject));
    return false;
}
/** Metadata erasure is one synchronous transaction. External object deletions
 * remain durable cleanup intents and must be verified before completion. */
export async function beginAccountErasure(ctx: AppContext, actor: ExecutionAuthority, id: string): Promise<{
    subjectId: string;
    cleanupIds: string[];
}> {
    return (await ctx.db.transaction(async () => {
        const request = (await authorizedProcess(ctx, actor, id, 'delete')), subject = request.subject_id, now = ctx.now();
        (await ctx.db.run('UPDATE privacy_requests SET status=?,failure_code=NULL WHERE id=?', 'processing', id));
        if (request.metadata_erased_at !== null)
            return { subjectId: subject, cleanupIds: (await ctx.db.all<{
                    id: string;
                }>("SELECT id FROM cleanup_intents WHERE request_id=? AND status<>'verified'", id)).map(row => row.id) };
        (await ctx.db.run('UPDATE accounts SET disabled_at=coalesce(disabled_at,?),auth_epoch=auth_epoch+1 WHERE id=?', now, subject));
        (await ctx.db.run('UPDATE sessions SET revoked_at=coalesce(revoked_at,?) WHERE account_id=?', now, subject));
        // Retire encrypted credential delivery immediately, even if an external
        // private writer postpones the later metadata/session deletion phase.
        (await ctx.db.run("UPDATE refresh_delivery_receipts SET state='cancelled',ciphertext=NULL,iv=NULL WHERE account_id=?", subject));
        (await ctx.db.run("UPDATE consents SET status='revoked',revoked_at=coalesce(revoked_at,?) WHERE account_id=?", now, subject));
        (await ctx.db.run("UPDATE auth_devices SET status='revoked' WHERE account_id=?", subject));
        (await ctx.db.run("UPDATE auth_challenges SET status='cancelled' WHERE account_id=?", subject));
        for (const profile of (await ctx.db.all<{
            template_key: string;
        }>('SELECT template_key FROM face_profiles WHERE account_id=?', subject)))
            (await cleanup(ctx, request, 'PHOTOS', profile.template_key));
        for (const retired of (await ctx.db.all<{
            template_key: string;
        }>('SELECT template_key FROM face_profile_retirements WHERE account_id=?', subject)))
            (await cleanup(ctx, request, 'PHOTOS', retired.template_key));
        for (const row of (await ctx.db.all<{
            object_key: string;
        }>('SELECT p.object_key FROM auth_capture_proofs p JOIN auth_challenges c ON c.id=p.challenge_id WHERE c.account_id=?', subject)))
            (await cleanup(ctx, request, 'QUARANTINE', row.object_key));
        for (const proof of (await ctx.db.all<{
            proof_key: string;
        }>('SELECT proof_key FROM auth_challenges WHERE account_id=? AND proof_key IS NOT NULL', subject)))
            (await cleanup(ctx, request, 'QUARANTINE', proof.proof_key));
        for (const row of (await ctx.db.all<{
            object_key: string;
        }>('SELECT object_key FROM assets WHERE owner_id=?', subject)))
            (await cleanup(ctx, request, 'QUARANTINE', row.object_key));
        for (const row of (await ctx.db.all<{
            object_key: string;
        }>('SELECT r.object_key FROM renditions r JOIN assets a ON a.id=r.asset_id WHERE a.owner_id=?', subject)))
            (await cleanup(ctx, request, 'PHOTOS', row.object_key));
        for (const row of (await ctx.db.all<{
            rendition_key: string;
        }>('SELECT rendition_key FROM processing_attempts WHERE owner_id=? AND rendition_key IS NOT NULL', subject)))
            (await cleanup(ctx, request, 'PHOTOS', row.rendition_key));
        for (const row of (await ctx.db.all<{
            object_key: string;
        }>('SELECT object_key FROM privacy_exports WHERE subject_id=?', subject)))
            (await cleanup(ctx, request, 'PRIVACY_EXPORTS', row.object_key));
        for (const row of (await ctx.db.all<{
            bucket: 'PHOTOS' | 'QUARANTINE' | 'PRIVACY_EXPORTS';
            object_key: string;
        }>('SELECT bucket,object_key FROM media_write_intents WHERE account_id=?', subject)))
            (await cleanup(ctx, request, row.bucket, row.object_key));
        const affectedEntities = new Set<string>([subject, id]);
        for (const row of (await ctx.db.all<{
            id: string;
        }>('SELECT id FROM sharing_requests WHERE sender_id=? OR recipient_id=?', subject, subject)))
            affectedEntities.add(row.id);
        for (const row of (await ctx.db.all<{
            id: string;
        }>('SELECT id FROM sharing_previews WHERE owner_id=?', subject)))
            affectedEntities.add(row.id);
        for (const object of (await retentionPrivateKeys(ctx.db, subject)))
            (await cleanup(ctx, request, object.bucket, object.object_key));
        (await eraseRetentionSubject(ctx.db, subject));
        (await eraseNotificationSubject(ctx.db, subject));
        (await eraseOperatorSubject(ctx.db, subject, now));
        (await eraseEntitlementSubject(ctx.db, subject));
        (await ctx.db.run('DELETE FROM media_tickets WHERE account_id=? OR asset_id IN(SELECT id FROM assets WHERE owner_id=?)', subject, subject));
        // Retire grants, preserving their managed marker; do not grant legacy access.
        (await ctx.db.run('UPDATE media_grants SET active=0,revoked_at=coalesce(revoked_at,?) WHERE owner_id=? OR recipient_id=?', now, subject, subject));
        (await ctx.db.run('DELETE FROM media_grants WHERE owner_id=? OR recipient_id=?', subject, subject));
        await eraseAudienceSubject(ctx, subject);
        (await ctx.db.run('DELETE FROM sharing_approvals WHERE owner_id=? OR recipient_id=?', subject, subject));
        (await ctx.db.run('DELETE FROM sharing_requests WHERE sender_id=? OR recipient_id=?', subject, subject));
        (await ctx.db.run('DELETE FROM candidates WHERE owner_id=? OR recipient_id=?', subject, subject));
        (await ctx.db.run('DELETE FROM match_origins WHERE recipient_id=? OR asset_id IN(SELECT id FROM assets WHERE owner_id=?)', subject, subject));
        (await ctx.db.run('INSERT INTO privacy_redaction_context(request_id,subject_id) VALUES(?,?)', id, subject));
        for (const row of (await ctx.db.all<{
            id: string;
            source: string;
            pairs_json: string;
        }>('SELECT id,source,pairs_json FROM sharing_previews WHERE owner_id<>?', subject))) {
            const pairs = (JSON.parse(row.pairs_json) as Record<string, unknown>[]).filter(pair => pair.recipient_id !== subject);
            const before = JSON.parse(row.pairs_json) as Record<string, unknown>[];
            if (pairs.length === before.length)
                continue;
            affectedEntities.add(row.id);
            if (pairs.length === 0) {
                // Any unaffected immutable approval must remain attached to its preview.
                if ((await ctx.db.one('SELECT id FROM sharing_approvals WHERE preview_id=? LIMIT 1', row.id)))
                    throw new ApiError(500, 'privacy_redaction_inconsistent');
                (await ctx.db.run('DELETE FROM sharing_previews WHERE id=?', row.id));
            }
            else
                (await ctx.db.run('UPDATE sharing_previews SET pairs_json=?,manifest_json=?,privacy_redacted_at=coalesce(privacy_redacted_at,?) WHERE id=?', stable(pairs), stable(exactManifest(pairs, row.source)), now, row.id));
        }
        for (const row of (await ctx.db.all<{
            id: string;
            graph_json: string;
        }>('SELECT id,graph_json FROM sharing_snapshots WHERE owner_id<>?', subject))) {
            const graph = record(JSON.parse(row.graph_json));
            const recipients = Array.isArray(graph.recipients) ? graph.recipients : [];
            const pairs = Array.isArray(graph.pairs) ? graph.pairs : [];
            if (!recipients.some(person => person.id === subject) && !pairs.some(pair => pair.recipient_id === subject))
                continue;
            affectedEntities.add(row.id);
            graph.recipients = recipients.filter(person => person.id !== subject);
            graph.pairs = pairs.filter(pair => pair.recipient_id !== subject);
            (await ctx.db.run('UPDATE sharing_snapshots SET graph_json=?,privacy_redacted_at=coalesce(privacy_redacted_at,?) WHERE id=?', stable(graph), now, row.id));
        }
        (await ctx.db.run('DELETE FROM sharing_previews WHERE owner_id=?', subject));
        (await ctx.db.run('DELETE FROM sharing_snapshots WHERE owner_id=?', subject));
        (await ctx.db.run('DELETE FROM privacy_redaction_context WHERE request_id=?', id));
        for (const row of (await ctx.db.all<{
            id: string;
            profiles_json: string | null;
            matches_json: string | null;
        }>('SELECT id,profiles_json,matches_json FROM processing_attempts WHERE owner_id<>?', subject))) {
            for (const column of ['profiles_json', 'matches_json'] as const) {
                if (!row[column])
                    continue;
                const profiles = JSON.parse(row[column]!);
                if (!Array.isArray(profiles))
                    throw new ApiError(500, 'processing_provenance_invalid');
                const kept = profiles.filter(profile => profile.account_id !== subject && profile.recipient_id !== subject);
                if (kept.length !== profiles.length)
                    (await ctx.db.run(`UPDATE processing_attempts SET ${column}=? WHERE id=?`, stable(kept), row.id));
            }
        }
        (await ctx.db.run('DELETE FROM operations WHERE actor_id=? OR EXISTS(SELECT 1 FROM operation_subjects s WHERE s.actor_id=operations.actor_id AND s.source=operations.source AND s.operation_key=operations.operation_key AND s.subject_id=?)', subject, subject));
        for (const row of (await ctx.db.all<{
            id: string;
            account_id: string | null;
            category: string;
            entity_id: string | null;
            payload_json: string;
        }>('SELECT id,account_id,category,entity_id,payload_json FROM outbox WHERE cancelled_at IS NULL'))) {
            if (row.category === 'privacy' && row.entity_id === id)
                continue;
            if (row.account_id === subject || row.entity_id && affectedEntities.has(row.entity_id) || mentions(JSON.parse(row.payload_json), subject))
                (await ctx.db.run("UPDATE outbox SET cancelled_at=?,payload_json='{}' WHERE id=?", now, row.id));
        }
        (await ctx.db.run('DELETE FROM privacy_export_grants WHERE subject_id=?', subject));
        (await ctx.db.run("UPDATE privacy_exports SET status='retired' WHERE subject_id=?", subject));
        (await ctx.db.run('DELETE FROM photo_job_outbox WHERE asset_id IN(SELECT id FROM assets WHERE owner_id=?)', subject));
        (await ctx.db.run('DELETE FROM renditions WHERE asset_id IN(SELECT id FROM assets WHERE owner_id=?)', subject));
        (await ctx.db.run('DELETE FROM processing_attempts WHERE asset_id IN(SELECT id FROM assets WHERE owner_id=?)', subject));
        (await ctx.db.run('DELETE FROM assets WHERE owner_id=?', subject));
        (await ctx.db.run('DELETE FROM auth_capture_proofs WHERE challenge_id IN(SELECT id FROM auth_challenges WHERE account_id=?)', subject));
        (await ctx.db.run('DELETE FROM face_profile_retirements WHERE account_id=?', subject));
        (await ctx.db.run('DELETE FROM face_profile_operations WHERE account_id=?', subject));
        (await ctx.db.run('DELETE FROM face_profile_controls WHERE account_id=?', subject));
        (await ctx.db.run('DELETE FROM face_profile_states WHERE account_id=?', subject));
        (await ctx.db.run('DELETE FROM face_enrollment_intents WHERE account_id=?', subject));
        (await ctx.db.run('DELETE FROM face_recovery_intents WHERE account_id=?', subject));
        (await ctx.db.run('DELETE FROM face_recovery_keys WHERE account_id=?', subject));
        (await ctx.db.run('DELETE FROM auth_challenges WHERE account_id=?', subject));
        (await ctx.db.run('DELETE FROM sessions WHERE account_id=?', subject));
        (await ctx.db.run('DELETE FROM auth_devices WHERE account_id=?', subject));
        (await ctx.db.run('DELETE FROM face_profiles WHERE account_id=?', subject));
        (await ctx.db.run('DELETE FROM consents WHERE account_id=?', subject));
        (await ctx.db.run('DELETE FROM account_preferences WHERE account_id=?', subject));
        (await ctx.db.run('DELETE FROM blocks WHERE blocker_id=? OR blocked_id=?', subject, subject));
        (await ctx.db.run("UPDATE audit_events SET details_json='{}' WHERE actor_id=? OR subject_id=?", subject, subject));
        (await ctx.db.run("UPDATE accounts SET name='Deleted user',roles_json='[]' WHERE id=?", subject));
        (await ctx.db.run('UPDATE privacy_requests SET reason=NULL,review_reason=NULL WHERE subject_id=?', subject));
        (await ctx.db.run('UPDATE privacy_requests SET metadata_erased_at=? WHERE id=?', now, id));
        (await audit(ctx, actor, subject, 'privacy.erasure.metadata', id, { inventory_version: 'cloudflare-account-erasure-v1', retained: ['financial_records', 'minimal_audit', 'cleanup_intents', 'disabled_account_tombstone'] }));
        (await requireAdmin(ctx, actor));
        return { subjectId: subject, cleanupIds: (await ctx.db.all<{
                id: string;
            }>('SELECT id FROM cleanup_intents WHERE request_id=? AND status<>? ORDER BY id', id, 'verified')).map(row => row.id) };
    }));
}
type CleanupRow = {
    id: string;
    request_id: string | null;
    subject_id: string;
    bucket: 'PHOTOS' | 'QUARANTINE' | 'PRIVACY_EXPORTS';
    object_key: string;
};
async function cleanupAuthority(ctx: AppContext, row: CleanupRow, actor?: ExecutionAuthority): Promise<void> {
    const current=await ctx.db.one<CleanupRow>('SELECT id,request_id,subject_id,bucket,object_key FROM cleanup_intents WHERE id=?',row.id);
    if(!current||current.subject_id!==row.subject_id||current.bucket!==row.bucket||current.object_key!==row.object_key)throw new ApiError(409,'cleanup_authority_changed');
    row=current;
    // Historical duplicate NULL-request rows keep their own IDs/history. Their
    // exact subject/bucket/key can inherit only a durable matching, independently
    // reviewed erasure inventory entry; unrelated unknown intents remain denied.
    if(!row.request_id){
        const linked=await ctx.db.one<{request_id:string}>(`SELECT c.request_id FROM cleanup_intents c JOIN privacy_requests r ON r.id=c.request_id
          WHERE c.subject_id=? AND c.bucket=? AND c.object_key=? AND r.subject_id=c.subject_id AND r.request_type='delete'
          AND r.reviewed_by IS NOT NULL AND r.reviewed_by<>r.subject_id AND r.reviewed_at IS NOT NULL AND r.metadata_erased_at IS NOT NULL
          ORDER BY r.created_at DESC,r.id LIMIT 1`,row.subject_id,row.bucket,row.object_key);
        if(linked)row={...row,request_id:linked.request_id};
    }
    if (actor && !jobAuthority(actor))
        (await requireAdmin(ctx, actor));
    if (actor && jobAuthority(actor) && actor.requestId !== row.request_id)
        throw new ApiError(403, 'privacy_job_scope_invalid');
    if (row.request_id) {
        const request = (await currentRequest(ctx, row.request_id));
        if (request.subject_id !== row.subject_id || !request.reviewed_by || request.reviewed_by === request.subject_id || request.reviewed_at === null)
            throw new ApiError(403, 'cleanup_authority_invalid');
        if (request.request_type === 'delete' && (request.legal_hold || request.metadata_erased_at === null))
            throw new ApiError(409, 'privacy_cleanup_unavailable');
    }
    else {
        // Auth/processing orphan cleanup also uses this table. It is admissible only
        // for a persisted writer's key that has no currently live media reference.
        const retirement = row.bucket === 'PHOTOS' && (await ctx.db.one('SELECT cleanup_id FROM face_profile_retirements WHERE cleanup_id=? AND account_id=? AND template_key=?', row.id, row.subject_id, row.object_key));
        if (!retirement && !(await ctx.db.one("SELECT id FROM media_write_intents WHERE account_id=? AND bucket=? AND object_key=? LIMIT 1", row.subject_id, row.bucket, row.object_key)))
            throw new ApiError(403, 'cleanup_authority_invalid');
        if (retirement && ((await ctx.db.one("SELECT id FROM retention_settings WHERE id='default' AND legal_hold=1")) || (await ctx.db.one('SELECT id FROM moderation_holds WHERE active=1 AND subject_id=? LIMIT 1', row.subject_id))))
            throw new ApiError(409, 'face_profile_cleanup_blocked');
        // Transfer cancellation revokes publication immediately, but cannot erase
        // evidence protected by an existing retention or moderation hold. Include
        // uncommitted writers by the canonical asset/version prefix, not only the
        // winning chunk row. Cleanup remains durably pending until holds release.
        const transferAsset = row.bucket === 'QUARANTINE' && (await ctx.db.one<{
            id: string;
        }>(`SELECT a.id FROM assets a JOIN upload_transfers t ON t.asset_id=a.id
      WHERE a.owner_id=? AND (instr(?, 'upload-chunk/'||a.owner_id||'/'||a.id||'/')=1
        OR instr(?, 'source/'||a.owner_id||'/'||a.id||'/'||a.version||'/')=1) LIMIT 1`, row.subject_id, row.object_key, row.object_key));
        if (transferAsset && ((await ctx.db.one("SELECT id FROM retention_settings WHERE id='default' AND legal_hold=1")) || (await ctx.db.one('SELECT asset_id FROM asset_retention WHERE asset_id=? AND legal_hold=1', transferAsset.id)) || (await ctx.db.one('SELECT id FROM moderation_holds WHERE active=1 AND (subject_id=? OR asset_id=?) LIMIT 1', row.subject_id, transferAsset.id))))
            throw new ApiError(409, 'upload_cleanup_blocked');
        if ((await ctx.db.one(`SELECT id FROM assets WHERE owner_id=? AND object_key=? AND deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM upload_transfers t WHERE t.asset_id=assets.id AND t.state IN('cancelled','failed')) LIMIT 1`, row.subject_id, row.object_key)) || (await ctx.db.one(`SELECT c.asset_id FROM upload_chunks c JOIN upload_transfers t ON t.asset_id=c.asset_id
          JOIN assets a ON a.id=c.asset_id WHERE a.owner_id=? AND c.object_key=? AND t.state='uploading' AND a.deleted_at IS NULL LIMIT 1`, row.subject_id, row.object_key)) || (await ctx.db.one("SELECT r.id FROM renditions r JOIN assets a ON a.id=r.asset_id WHERE a.owner_id=? AND r.object_key=? AND r.status='ready' LIMIT 1", row.subject_id, row.object_key)) || (await ctx.db.one("SELECT id FROM face_profiles WHERE account_id=? AND template_key=? AND status='active' LIMIT 1", row.subject_id, row.object_key)) || (await ctx.db.one("SELECT p.challenge_id FROM auth_capture_proofs p JOIN auth_challenges c ON c.id=p.challenge_id JOIN accounts a ON a.id=c.account_id WHERE c.account_id=? AND p.object_key=? AND c.status IN('pending','verifying') AND c.used_at IS NULL AND c.expires_at>? AND a.disabled_at IS NULL AND c.auth_epoch=a.auth_epoch LIMIT 1", row.subject_id, row.object_key, ctx.now())))
            throw new ApiError(409, 'cleanup_live_reference');
    }
    if ((await ctx.db.one("SELECT id FROM media_write_intents WHERE account_id=? AND bucket=? AND object_key=? AND status='pending' LIMIT 1", row.subject_id, row.bucket, row.object_key)))
        throw new ApiError(503, 'privacy_writer_unresolved');
}
async function cleanObject(ctx: AppContext, row: CleanupRow, actor?: ExecutionAuthority): Promise<void> {
    (await ctx.db.transaction(async () => (await cleanupAuthority(ctx, row, actor))));
    try {
        await ctx.env[row.bucket].delete(row.object_key);
        (await ctx.db.transaction(async () => (await cleanupAuthority(ctx, row, actor))));
        if (await ctx.env[row.bucket].head(row.object_key))
            throw new ApiError(503, 'privacy_cleanup_unconfirmed');
        (await ctx.db.transaction(async () => {
            (await cleanupAuthority(ctx, row, actor));
            (await ctx.db.run("UPDATE cleanup_intents SET status='verified',attempts=attempts+1,verified_at=? WHERE id=?", ctx.now(), row.id));
        }));
    }
    catch (error) {
        // Failure evidence must survive a revoked executor; this grants no access.
        (await ctx.db.transaction(async () => (await ctx.db.run("UPDATE cleanup_intents SET status='failed',attempts=attempts+1 WHERE id=?", row.id))));
        throw error;
    }
}
async function drainCleanup(ctx: AppContext, actor: ExecutionAuthority, id: string): Promise<void> {
    const rows = (await ctx.db.all<CleanupRow>("SELECT id,request_id,subject_id,bucket,object_key FROM cleanup_intents WHERE request_id=? AND status<>'verified' ORDER BY created_at,id LIMIT 100", id));
    for (const row of rows)
        await cleanObject(ctx, row, actor);
}
async function executionLease(ctx: AppContext, actor: ExecutionAuthority, id: string, token: string): Promise<PrivacyRequest> {
    const request = (await authorizedProcess(ctx, actor, id, (await currentRequest(ctx, id)).request_type));
    if (request.status !== 'processing' || request.execution_token !== token || (request.lease_until ?? 0) <= ctx.now())
        throw new ApiError(409, 'privacy_execution_changed');
    return request;
}
async function failLease(ctx: AppContext, id: string, token: string, code: string): Promise<void> {
    (await ctx.db.run("UPDATE privacy_requests SET status='failed',failure_code=?,execution_token=NULL,lease_until=NULL WHERE id=? AND execution_token=? AND status='processing'", code, id, token));
}
export async function processPrivacyRequest(ctx: AppContext, actor: ExecutionAuthority, id: string): Promise<Record<string, unknown>> {
    if (!jobAuthority(actor)) {
        (await requireAdmin(ctx, actor));
        const previous = (await currentRequest(ctx, id));
        if (previous.status === 'completed')
            return { privacy_request: summary(previous, ctx.now()) };
    }
    const token = crypto.randomUUID();
    const request = (await ctx.db.transaction(async () => {
        const row = (await authorizedProcess(ctx, actor, id, (await currentRequest(ctx, id)).request_type));
        if (row.execution_token && (row.lease_until ?? 0) > ctx.now())
            throw new ApiError(503, 'privacy_execution_in_progress');
        (await ctx.db.run("UPDATE privacy_requests SET status='processing',execution_token=?,lease_until=?,failure_code=NULL WHERE id=?", token, ctx.now() + 300000, id));
        return row;
    }));
    try {
        if (request.request_type === 'delete') {
            (await beginAccountErasure(ctx, actor, id));
            await drainCleanup(ctx, actor, id);
            return (await ctx.db.transaction(async () => {
                const current = (await executionLease(ctx, actor, id, token));
                const remaining = (await ctx.db.one<{
                    n: number;
                }>("SELECT count(*) n FROM cleanup_intents WHERE request_id=? AND status<>'verified'", id))!.n;
                const writers = (await ctx.db.one<{
                    n: number;
                }>("SELECT count(*) n FROM media_write_intents WHERE account_id=? AND status='pending'", current.subject_id))!.n;
                if (remaining || writers) {
                    (await failLease(ctx, id, token, writers ? 'privacy_writer_unresolved' : 'privacy_cleanup_remaining'));
                    return { privacy_request: summary((await currentRequest(ctx, id)), ctx.now()), cleanup_remaining: remaining, writers_remaining: writers };
                }
                const completedAt = ctx.now();
                (await ctx.db.run("UPDATE privacy_requests SET status='completed',completed_at=?,failure_code=NULL,execution_token=NULL,lease_until=NULL WHERE id=?", completedAt, id));
                await ctx.db.run('UPDATE privacy_deletion_status_receipts SET expires_at=? WHERE request_id=? AND revoked_at IS NULL', completedAt + deletionReceiptTtl, id);
                (await ctx.db.run("DELETE FROM media_write_intents WHERE account_id=? AND status='settled'", current.subject_id));
                (await audit(ctx, actor, current.subject_id, 'privacy.erasure.completed', id));
                return { privacy_request: summary((await currentRequest(ctx, id)), ctx.now()), inventory_version: 'cloudflare-account-erasure-v1' };
            }));
        }
        return await createVerifiedExport(ctx, actor, request, token);
    }
    catch (error) {
        (await ctx.db.transaction(async () => (await failLease(ctx, id, token, error instanceof ApiError ? error.code : 'privacy_execution_unconfirmed'))));
        throw error;
    }
}
async function createVerifiedExport(ctx: AppContext, actor: ExecutionAuthority, request: PrivacyRequest, token: string): Promise<Record<string, unknown>> {
    const body = (await ctx.db.transaction(async () => {
        (await executionLease(ctx, actor, request.id, token));
        return (await collectPrivacyExport(ctx, request.subject_id));
    }));
    const bytes = new TextEncoder().encode(stable(body));
    if (bytes.byteLength > exportBudget) {
        bytes.fill(0);
        throw new ApiError(413, 'privacy_export_too_large');
    }
    const exportId = crypto.randomUUID(), writeId = crypto.randomUUID();
    const key = 'privacy/' + request.subject_id + '/' + request.id + '/' + exportId + '.json';
    let registered = false;
    try {
        const sha256 = await digest(bytes);
        (await ctx.db.transaction(async () => {
            (await executionLease(ctx, actor, request.id, token));
            (await ctx.db.run('INSERT INTO media_write_intents(id,account_id,bucket,object_key,status,created_at) VALUES(?,?,?,?,?,?)', writeId, request.subject_id, 'PRIVACY_EXPORTS', key, 'pending', ctx.now()));
            (await ctx.db.run('INSERT INTO privacy_exports(id,request_id,subject_id,object_key,sha256,bytes,expires_at,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)', exportId, request.id, request.subject_id, key, sha256, bytes.byteLength, ctx.now() + exportTtl, 'pending', ctx.now()));
            registered = true;
        }));
        try {
            await ctx.env.PRIVACY_EXPORTS.put(key, bytes.buffer as ArrayBuffer, { httpMetadata: { contentType: 'application/json' } });
        }
        finally {
            (await settleMediaWrite(ctx, writeId));
        }
        (await ctx.db.transaction(async () => (await executionLease(ctx, actor, request.id, token))));
        const written = await ctx.env.PRIVACY_EXPORTS.get(key);
        (await ctx.db.transaction(async () => (await executionLease(ctx, actor, request.id, token))));
        if (!written || written.size !== bytes.byteLength || written.size > exportBudget)
            throw new ApiError(503, 'privacy_export_unverified');
        const persisted = new Uint8Array(await written.arrayBuffer());
        try {
            if (persisted.byteLength !== bytes.byteLength || await digest(persisted) !== sha256)
                throw new ApiError(503, 'privacy_export_unverified');
        }
        finally {
            persisted.fill(0);
        }
        return (await ctx.db.transaction(async () => {
            const current = (await executionLease(ctx, actor, request.id, token)), expires = ctx.now() + exportTtl;
            const publication = (await ctx.db.one<{
                status: string;
            }>('SELECT status FROM privacy_exports WHERE id=?', exportId));
            if (publication?.status !== 'pending')
                throw new ApiError(409, 'privacy_publication_changed');
            (await ctx.db.run("UPDATE privacy_exports SET status='published',expires_at=? WHERE id=?", expires, exportId));
            (await ctx.db.run("UPDATE privacy_requests SET status='completed',completed_at=?,export_key=?,export_sha256=?,export_bytes=?,export_expires_at=?,failure_code=NULL,execution_token=NULL,lease_until=NULL WHERE id=?", ctx.now(), key, sha256, bytes.byteLength, expires, request.id));
            (await audit(ctx, actor, current.subject_id, 'privacy.export.completed', request.id));
            return { privacy_request: summary((await currentRequest(ctx, request.id)), ctx.now()) };
        }));
    }
    catch (error) {
        if (registered)
            (await ctx.db.transaction(async () => {
                (await cleanup(ctx, request, 'PRIVACY_EXPORTS', key, true));
                (await ctx.db.run("UPDATE privacy_exports SET status='retired' WHERE id=?", exportId));
            }));
        throw error;
    }
    finally {
        bytes.fill(0);
    }
}
async function exportGrant(ctx: AppContext, actor: Actor, id: string): Promise<Record<string, unknown>> {
    (await assertPrivacyActor(actor, ctx));
    const token = crypto.randomUUID() + crypto.randomUUID(), tokenHash = await digest(token);
    return (await ctx.db.transaction(async () => {
        (await assertPrivacyActor(actor, ctx));
        const request = (await currentRequest(ctx, id));
        if (request.subject_id !== actor.accountId || request.request_type !== 'export' || request.status !== 'completed' || !request.export_key || !request.export_expires_at || request.export_expires_at <= ctx.now())
            throw new ApiError(404, 'privacy_export_unavailable');
        const grantId = crypto.randomUUID(), expires = Math.min(ctx.now() + 300000, request.export_expires_at);
        (await ctx.db.run('DELETE FROM privacy_export_grants WHERE subject_id=? AND (expires_at<=? OR consumed_at IS NOT NULL)', actor.accountId, ctx.now()));
        const open = (await ctx.db.one<{
            n: number;
        }>('SELECT count(*) n FROM privacy_export_grants WHERE subject_id=?', actor.accountId))!.n;
        if (open >= 10)
            throw new ApiError(429, 'privacy_export_grant_limit');
        (await ctx.db.run('INSERT INTO privacy_export_grants(id,request_id,subject_id,session_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?,?,?)', grantId, id, actor.accountId, actor.sessionId, tokenHash, expires, ctx.now()));
        const path = `/privacy-exports/retrieve?grant=${encodeURIComponent(token)}`;
        return { request_id: id, grant_path: path, expires_at: new Date(expires).toISOString() };
    }));
}
/** Called only by the durable PostgreSQL job consumer. The payload cannot create an
 * approval or choose its subject, role, storage key or result. */
export async function processPrivacyJob(payload: unknown, ctx: AppContext): Promise<void> {
    const body = record(payload);
    exact(body, ['request_id']);
    const id = uuid(body.request_id);
    const request = (await currentRequest(ctx, id));
    if (['completed', 'rejected', 'cancelled'].includes(request.status))
        return;
    await processPrivacyRequest(ctx, { kind: 'approved-job', requestId: id }, id);
}
/** Durable at-least-once dispatch. Original request identity is reused. */
export async function flushPrivacyCleanup(ctx: AppContext): Promise<void> {
    await ctx.db.run("UPDATE privacy_deletion_status_receipts SET expires_at=(SELECT coalesce(r.completed_at,r.reviewed_at)+? FROM privacy_requests r WHERE r.id=request_id) WHERE request_id IN(SELECT id FROM privacy_requests WHERE request_type='delete' AND status IN('completed','rejected','cancelled') AND coalesce(completed_at,reviewed_at) IS NOT NULL)", deletionReceiptTtl);
    (await ctx.db.transaction(async () => (await ctx.db.run("DELETE FROM privacy_deletion_status_receipts WHERE request_id IN(SELECT d.request_id FROM privacy_deletion_status_receipts d JOIN privacy_requests r ON r.id=d.request_id WHERE (d.expires_at<=? AND r.status IN('completed','rejected','cancelled')) OR d.revoked_at IS NOT NULL LIMIT 100)", ctx.now()))));
    (await ctx.db.transaction(async () => (await ctx.db.run("UPDATE privacy_requests SET status='cancelled',failure_code='privacy_request_expired' WHERE request_type<>'delete' AND expires_at<=? AND status IN('pending_approval','approved','queued') AND metadata_erased_at IS NULL", ctx.now()))));
    for (const row of (await ctx.db.all<{
        id: string;
        entity_id: string;
        payload_json: string;
    }>("SELECT id,entity_id,payload_json FROM outbox WHERE category='privacy' AND delivered_at IS NULL AND cancelled_at IS NULL ORDER BY created_at,id LIMIT 25"))) {
        const request = (await currentRequest(ctx, row.entity_id));
        if (!['queued', 'processing', 'failed'].includes(request.status) || request.request_type !== 'delete' && request.expires_at <= ctx.now()) {
            (await ctx.db.run("UPDATE outbox SET cancelled_at=?,payload_json='{}' WHERE id=?", ctx.now(), row.id));
            continue;
        }
        const payload = record(JSON.parse(row.payload_json));
        exact(payload, ['request_id']);
        if (uuid(payload.request_id) !== request.id)
            throw new ApiError(500, 'privacy_outbox_invalid');
        await ctx.env.PHOTO_JOBS.send({ category: 'privacy', payload: { request_id: request.id } });
        (await ctx.db.transaction(async () => (await ctx.db.run('UPDATE outbox SET delivered_at=? WHERE id=? AND cancelled_at IS NULL', ctx.now(), row.id))));
    }
    (await ctx.db.transaction(async () => {
        for (const row of (await ctx.db.all<{
            id: string;
            request_id: string;
            object_key: string;
        }>("SELECT id,request_id,object_key FROM privacy_exports WHERE status<>'retired' AND expires_at<=? LIMIT 100", ctx.now()))) {
            (await cleanup(ctx, (await currentRequest(ctx, row.request_id)), 'PRIVACY_EXPORTS', row.object_key));
            (await ctx.db.run("UPDATE privacy_exports SET status='retired' WHERE id=?", row.id));
            (await ctx.db.run('UPDATE privacy_requests SET export_expires_at=? WHERE id=?', ctx.now(), row.request_id));
        }
    }));
    for (const row of (await ctx.db.all<CleanupRow>("SELECT id,request_id,subject_id,bucket,object_key FROM cleanup_intents WHERE status<>'verified' ORDER BY created_at,id LIMIT 100"))) {
        try {
            await cleanObject(ctx, row);
        }
        catch { /* Durable intent survives for the next alarm. */ }
    }
    for (const row of (await ctx.db.all<{
        id: string;
    }>("SELECT id FROM privacy_requests WHERE status IN('processing','failed') AND (lease_until IS NULL OR lease_until<=?) AND (expires_at>? OR request_type='delete') ORDER BY created_at,id LIMIT 10", ctx.now(), ctx.now()))) {
        try {
            await processPrivacyJob({ request_id: row.id }, ctx);
        }
        catch { /* Preserve the recorded failure. */ }
    }
}
async function retrieveExport(request: Request, ctx: AppContext): Promise<Response> {
    // A capability is additionally account/session bound; it never substitutes for
    // current account authority or becomes a public Storage URL.
    const actor = await ctx.authenticate(request), token = new URL(request.url).searchParams.get('grant');
    (await assertPrivacyActor(actor, ctx));
    if (!token || token.length > 200)
        throw new ApiError(401, 'privacy_export_grant_invalid');
    const tokenHash = await digest(token);
    const publication = (await ctx.db.transaction(async () => {
        (await assertPrivacyActor(actor, ctx));
        const grant = (await ctx.db.one<{
            id: string;
            request_id: string;
            subject_id: string;
            session_id: string;
            expires_at: number;
            consumed_at: number | null;
        }>('SELECT * FROM privacy_export_grants WHERE token_hash=?', tokenHash));
        if (!grant || grant.subject_id !== actor.accountId || grant.session_id !== actor.sessionId || grant.expires_at <= ctx.now() || grant.consumed_at !== null)
            throw new ApiError(401, 'privacy_export_grant_invalid');
        const row = (await currentRequest(ctx, grant.request_id));
        if (row.status !== 'completed' || !row.export_key || !row.export_sha256 || !row.export_bytes || !row.export_expires_at || row.export_expires_at <= ctx.now())
            throw new ApiError(404, 'privacy_export_unavailable');
        (await ctx.db.run('UPDATE privacy_export_grants SET consumed_at=? WHERE id=?', ctx.now(), grant.id));
        return { ...row, grant_id: grant.id };
    }));
    let bytes: Uint8Array | undefined;
    try {
        const object = await ctx.env.PRIVACY_EXPORTS.get(publication.export_key!);
        (await assertPrivacyActor(actor, ctx));
        if (!object || object.size !== publication.export_bytes || object.size > exportBudget)
            throw new ApiError(503, 'privacy_export_unverified');
        bytes = new Uint8Array(await object.arrayBuffer());
        if (bytes.byteLength !== publication.export_bytes || await digest(bytes) !== publication.export_sha256)
            throw new ApiError(503, 'privacy_export_unverified');
        (await assertPrivacyActor(actor, ctx));
        if (ctx.now() >= publication.export_expires_at!)
            throw new ApiError(410, 'privacy_export_expired');
        await ctx.env.PRIVACY_EXPORTS.delete(publication.export_key!);
        (await assertPrivacyActor(actor, ctx));
        if (await ctx.env.PRIVACY_EXPORTS.head(publication.export_key!))
            throw new ApiError(503, 'privacy_cleanup_unconfirmed');
        (await ctx.db.transaction(async () => {
            (await assertPrivacyActor(actor, ctx));
            const row = (await currentRequest(ctx, publication.id));
            if (row.status !== 'completed' || row.export_key !== publication.export_key || row.export_sha256 !== publication.export_sha256 || !row.export_expires_at || row.export_expires_at <= ctx.now())
                throw new ApiError(409, 'privacy_publication_changed');
            (await ctx.db.run('UPDATE privacy_requests SET export_expires_at=? WHERE id=?', ctx.now(), row.id));
            (await ctx.db.run("UPDATE privacy_exports SET status='retired' WHERE request_id=? AND object_key=?", row.id, publication.export_key));
            (await cleanup(ctx, row, 'PRIVACY_EXPORTS', publication.export_key!));
            (await ctx.db.run("UPDATE cleanup_intents SET status='verified',verified_at=? WHERE request_id=? AND bucket='PRIVACY_EXPORTS' AND object_key=?", ctx.now(), row.id, publication.export_key));
        }));
        return new Response(bytes.slice().buffer, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff', 'X-Lovelies-Privacy-Export': 'one-time' } });
    }
    catch (error) {
        (await ctx.db.transaction(async () => {
            (await cleanup(ctx, publication, 'PRIVACY_EXPORTS', publication.export_key!, true));
            (await ctx.db.run('UPDATE privacy_requests SET export_expires_at=? WHERE id=? AND export_key=?', ctx.now(), publication.id, publication.export_key));
            (await ctx.db.run("UPDATE privacy_exports SET status='retired' WHERE request_id=? AND object_key=?", publication.id, publication.export_key));
        }));
        throw error;
    }
    finally {
        bytes?.fill(0);
    }
}
export async function handlePrivacy(request: Request, ctx: AppContext): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    const operationReceipt = /^\/privacy\/operations\/([A-Za-z0-9._:-]{16,128})$/.exec(path);
    if (operationReceipt) {
        if (request.method !== 'GET') throw new ApiError(405,'method_not_allowed');
        const actor = await ctx.authenticate(request);
        return ctx.db.transaction(async()=>{
            await assertPrivacyActor(actor,ctx);
            const receipt = await ctx.db.one<{payload_json:string;response_json:string}>("SELECT payload_json,response_json FROM operations WHERE actor_id=? AND source='privacy' AND operation_key=? AND action IN('privacy.request.export','privacy.request.delete')",actor.accountId,operationReceipt[1]);
            if (receipt) assertOperationReceiptAvailable(receipt);
            return ok(receipt ? JSON.parse(receipt.response_json) : {status:'unknown'});
        });
    }
    if (path === '/privacy/account-deletion/status') {
        if (request.method !== 'POST')
            throw new ApiError(405, 'method_not_allowed');
        return (await retrieveDeletionStatus(request, ctx));
    }
    const createKind = ['/privacy/export', '/gdpr/export'].includes(path) ? 'export' : ['/privacy/account-deletion', '/gdpr/delete'].includes(path) ? 'delete' : null;
    const review = /^\/privacy-requests\/([0-9a-f-]{36})\/(approve|reject|process)$/.exec(path);
    const status = /^\/privacy-requests\/([0-9a-f-]{36})$/.exec(path);
    const grant = /^\/privacy-exports\/([0-9a-f-]{36})\/grant$/.exec(path);
    if (path === '/privacy-exports/retrieve') {
        if (request.method !== 'GET')
            throw new ApiError(405, 'method_not_allowed');
        return (await retrieveExport(request, ctx));
    }
    if (!createKind && !review && !status && !grant && !['/privacy/center', '/admin/privacy-requests'].includes(path))
        return null;
    const actor = await ctx.authenticate(request);
    if (createKind || review || grant) {
        if (request.method !== 'POST')
            throw new ApiError(405, 'method_not_allowed');
        if (grant)
            return ok(await exportGrant(ctx, actor, uuid(grant[1])));
        if (review?.[2] === 'process')
            return ok(await processPrivacyRequest(ctx, actor, uuid(review[1])));
        const body = await jsonBody(request, 16384);
        if (createKind)
            return ok(await createPrivacyRequest(ctx, actor, createKind, body), 201);
        const result = await reviewPrivacyRequest(ctx, actor, uuid(review![1]), review![2] as 'approve' | 'reject', body);
        // Dispatch ambiguity leaves a durable outbox; approval is already saved.
        try {
            await flushPrivacyCleanup(ctx);
        }
        catch { /* Alarm retries the outbox. */ }
        (await requireAdmin(ctx, actor));
        return ok(result);
    }
    if (request.method !== 'GET')
        throw new ApiError(405, 'method_not_allowed');
    return (await ctx.db.transaction(async () => {
        if (path === '/privacy/center' || status)
            (await assertPrivacyActor(actor, ctx));
        else
            (await assertPrivacyActor(actor, ctx));
        if (status) {
            const row = (await currentRequest(ctx, uuid(status[1])));
            if (row.subject_id !== actor.accountId && !actor.roles.includes('admin') || actor.authMethod === 'anonymous' && row.request_type !== 'delete')
                throw new ApiError(404, 'privacy_request_unavailable');
            return ok({ privacy_request: summary(row, ctx.now()) });
        }
        if (path === '/admin/privacy-requests') {
            (await requireAdmin(ctx, actor));
            const rows = (await ctx.db.all<PrivacyRequest>('SELECT * FROM privacy_requests ORDER BY created_at DESC,id LIMIT 100'));
            return ok({ privacy_requests: rows.map(row => ({ ...summary(row, ctx.now()), subject_user_id: row.subject_id })), page: { limit: 100 } });
        }
        const rows = (await ctx.db.all<PrivacyRequest>('SELECT * FROM privacy_requests WHERE subject_id=? ORDER BY created_at DESC,id LIMIT 100', actor.accountId));
        const consents = (await ctx.db.all<{
            status: string;
            revoked_at: number | null;
            expires_at: number | null;
        }>('SELECT id,purpose,policy_version,status,expires_at,revoked_at FROM consents WHERE account_id=?', actor.accountId));
        const profile = (await ctx.db.one('SELECT id,revision,model_id,status,auth_enabled FROM face_profiles WHERE account_id=?', actor.accountId));
        return ok({ consents, consent_granted: consents.some(row => row.status === 'granted' && row.revoked_at === null && (row.expires_at === null || row.expires_at > ctx.now())),
            active_face_profile: profile, requests: rows.map(row => summary(row, ctx.now())), privacy_requests: rows.map(row => summary(row, ctx.now())) });
    }));
}
